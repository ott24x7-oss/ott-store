'use strict';
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const { getDb, getSetting, setSetting, all, get, run } = require('./db');
const { sendMail } = require('./mailer');

let _lastCheck = new Date(Date.now() - 10 * 60 * 1000); // start 10 min ago
let _running = false;
let _status = { ok: false, lastRun: null, lastError: null, matched: 0 };

// Extract all INR amounts from email text, e.g. "Rs. 499.37" "₹500.37" "INR 200.00"
function extractAmounts(text) {
  const amounts = new Set();
  const re = /(?:rs\.?|₹|inr)\s*(\d{1,6}(?:\.\d{1,2})?)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const v = parseFloat(m[1]);
    if (!isNaN(v) && v > 0) amounts.add(v);
  }
  return [...amounts];
}

// Extract all USDT amounts from email text. Binance / BscScan / Tronscan
// notifications include patterns like "20.547 USDT", "$20.547", "USDT 20.547",
// "Amount: 20.547". We use up to 3 decimal places (our unique amounts go to 3dp).
function extractUsdtAmounts(text) {
  const amounts = new Set();
  const patterns = [
    /(\d{1,8}(?:\.\d{1,3})?)\s*usdt/gi,
    /usdt\s*[: ]?\s*(\d{1,8}(?:\.\d{1,3})?)/gi,
    /\$\s*(\d{1,8}(?:\.\d{1,3})?)/g,
    /amount\s*[: ]\s*(\d{1,8}(?:\.\d{1,3})?)/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const v = parseFloat(m[1]);
      if (!isNaN(v) && v > 0) amounts.add(v);
    }
  }
  return [...amounts];
}

// Fetch all emails with UID > lastUid (regardless of SEEN flag, so a user
// opening the email on their phone doesn't hide it from us). Falls back to
// SINCE if lastUid is 0 — i.e. very first poll after a config change.
function fetchMessages(imap, lastUid, since) {
  return new Promise((resolve, reject) => {
    const criteria = lastUid > 0
      ? [['UID', `${lastUid + 1}:*`]]
      : [['SINCE', since]];
    imap.search(criteria, (err, uids) => {
      if (err) return reject(err);
      if (!uids || !uids.length) return resolve({ messages: [], maxUid: lastUid });

      const fetch = imap.fetch(uids, { bodies: '' });
      const messages = [];
      let maxUid = lastUid;

      fetch.on('message', (msg) => {
        let raw = '';
        msg.on('body', stream => {
          stream.on('data', chunk => { raw += chunk.toString(); });
        });
        msg.on('attributes', attrs => {
          if (attrs?.uid && attrs.uid > maxUid) maxUid = attrs.uid;
        });
        msg.once('end', () => messages.push(raw));
      });
      fetch.once('error', reject);
      fetch.once('end', () => resolve({ messages, maxUid }));
    });
  });
}

async function parseAndMatch(rawMessages) {
  const db = await getDb();
  // Fetch pending direct-checkout topups (INR via UPI IMAP, or USDT via 3 networks)
  // Auto-expire any pending payment past its window before matching. A 5-minute
  // grace period protects the customer from losing an order when the bank /
  // exchange notification email arrives a few minutes after the strict window
  // (e.g. delayed Gmail delivery, IMAP poll interval): a real payment whose
  // email lands within 5 min of expiry still gets matched.
  // Keep matching well past the on-screen countdown: a real payment whose bank / UPI
  // confirmation email is delayed (slow push, Gmail delivery lag) must still
  // auto-credit. The customer sees a short window, but the topup stays matchable for
  // `payment_match_grace_minutes` (default 3h) before we give up on it.
  let graceMin = 180;
  try { graceMin = Math.max(15, parseInt(await getSetting('payment_match_grace_minutes') || '180', 10) || 180); } catch {}
  try { run(db, `UPDATE topups SET status='expired' WHERE status='pending' AND expires_at IS NOT NULL AND datetime(expires_at) < datetime('now', ?)`, [`-${graceMin} minutes`]); } catch {}
  // Only AUTO-verify RECENT payments: the topup must have been created within the
  // last N minutes (default 10). Older pending payments are NOT auto-matched — the
  // admin verifies those manually in Payment Log. This stops a late or unrelated
  // bank email from auto-crediting a stale order.
  let windowMin = 10;
  try { windowMin = Math.max(1, parseInt(await getSetting('payment_match_window_minutes') || '10', 10) || 10); } catch {}
  const pending = all(db, `SELECT * FROM topups
    WHERE status='pending' AND purpose='order'
      AND created_at >= datetime('now', ?)
      AND (
        (method='upi_imap'   AND unique_amount      IS NOT NULL) OR
        (method LIKE 'usdt_%' AND unique_amount_usdt IS NOT NULL)
      )`, [`-${windowMin} minutes`]);
  if (!pending.length) return 0;

  const pendingInr  = pending.filter(t => t.method === 'upi_imap');
  const pendingUsdt = pending.filter(t => String(t.method || '').startsWith('usdt_'));

  let matched = 0;
  for (const raw of rawMessages) {
    let parsed;
    try { parsed = await simpleParser(raw); } catch { continue; }

    const text = ((parsed.text || '') + ' ' + (parsed.html || '')).toLowerCase();
    const inrAmounts  = pendingInr.length  ? extractAmounts(text)     : [];
    const usdtAmounts = pendingUsdt.length ? extractUsdtAmounts(text) : [];

    // Match INR (UPI) — exact unique-amount match first.
    const inrUnmatched = [];
    for (const amt of inrAmounts) {
      const topup = pendingInr.find(t => Math.abs(t.unique_amount - amt) < 0.001 && t.status === 'pending');
      if (!topup) { inrUnmatched.push(amt); continue; }
      topup.status = 'approved'; // mark in-memory so we don't double-match within this batch
      run(db, `UPDATE topups SET status='approved' WHERE id=?`, [topup.id]);
      run(db, `INSERT INTO audit_log (actor_kind,actor_label,action,target_kind,target_id,after_json) VALUES (?,?,?,?,?,?)`,
        ['system', 'imap-verify', 'checkout_upi_auto_approve', 'topup', String(topup.id),
         JSON.stringify({ amount_inr: topup.amount_inr, unique_amount: topup.unique_amount })]);
      matched++;
      const cust = get(db, 'SELECT * FROM customers WHERE jid=?', [topup.customer_jid]);
      await handleDirectCheckout(db, topup, cust).catch(() => {});
    }

    // NO ROUND-AMOUNT AUTO-VERIFY: only the EXACT unique amount auto-approves (above).
    // If a paid amount didn't match a unique amount but is plausibly for a pending
    // order (it equals the base price, or is within ₹10 of the unique amount), alert
    // the admin to verify it MANUALLY in Payment Log — we never auto-create the order.
    // Far-off amounts match nothing and are ignored as unrelated.
    for (const amt of inrUnmatched) {
      const related = pendingInr.filter(t => t.status === 'pending'
        && (Math.round(t.amount_inr) === Math.round(amt) || Math.abs(t.unique_amount - amt) <= 10));
      if (!related.length) continue;
      try {
        const { notifyAdmin } = require('./notify');
        const list = related.map(t => `#${t.id} (expected ₹${t.unique_amount})`).join(', ');
        await notifyAdmin(`⚠️ *Payment needs manual verify*\nReceived *₹${amt}* — it does NOT match any order's exact (unique) amount, so it was not auto-verified. Possible order(s): ${list}.\nIf you confirmed the money arrived, open Admin → Payment Log and tap *✓ Verify* the right one.`, { db });
      } catch {}
    }

    // Match USDT (Binance / BEP20 / TRC20)
    for (const amt of usdtAmounts) {
      const topup = pendingUsdt.find(t => Math.abs(t.unique_amount_usdt - amt) < 0.0005 && t.status === 'pending');
      if (!topup) continue;
      topup.status = 'approved';
      run(db, `UPDATE topups SET status='approved' WHERE id=?`, [topup.id]);
      run(db, `INSERT INTO audit_log (actor_kind,actor_label,action,target_kind,target_id,after_json) VALUES (?,?,?,?,?,?)`,
        ['system', 'imap-verify', 'checkout_usdt_auto_approve', 'topup', String(topup.id),
         JSON.stringify({ method: topup.method, amount_usdt: topup.amount_usdt, unique_usdt: topup.unique_amount_usdt, amount_inr: topup.amount_inr })]);
      matched++;
      const cust = get(db, 'SELECT * FROM customers WHERE jid=?', [topup.customer_jid]);
      await handleDirectCheckout(db, topup, cust).catch(() => {});
    }
  }
  return matched;
}

async function handleDirectCheckout(db, topup, cust) {
  // Re-read the topup FRESH from the DB — the `topup` argument is a snapshot
  // captured in parseAndMatch's SELECT, so if two parseAndMatch runs both
  // matched the same row, they'd both pass the stale `order_id IS NULL` check
  // and double-create the order. Reading fresh narrows the race to a single
  // SQL statement window.
  const freshTopup = get(db, `SELECT id, customer_jid, plan_id, amount_inr, amount_usdt,
    unique_amount, unique_amount_usdt, method, currency, order_id, status FROM topups WHERE id=?`,
    [topup.id]);
  if (!freshTopup) return;
  if (freshTopup.order_id) return; // already produced an order
  topup = freshTopup; // use the fresh row from here on

  const plan = get(db, 'SELECT * FROM plans WHERE id=? AND active=1', [topup.plan_id]);
  if (!plan) return;
  // Bot-supplied auto plans (provider_api='bot') are fulfilled on demand by the
  // OTT24x7 bot, NOT from local stock — so they must not be gated or decremented on
  // plan.stock here. Otherwise a deliverable bot order whose (stale/finite) local
  // count reached 0 gets flagged refund_needed BEFORE the order is created, so
  // deliverFromBot never runs. The delivery worker already auto-refunds to the
  // customer's wallet if the bot is genuinely out of stock.
  const botSupplied = plan.provider_api === 'bot' && plan.delivery_type === 'auto';
  if (!botSupplied && plan.stock === 0) return;

  const existing = get(db, `SELECT id FROM orders o WHERE EXISTS (SELECT 1 FROM topups WHERE order_id=o.id AND id=?)`, [topup.id]);
  if (existing) return;

  // Atomic stock decrement for finite-stock plans. We deduct first; if the
  // affected-rows count is zero the plan is sold out under us — abort BEFORE
  // creating the order. This prevents the "two customers, last unit" race.
  // (Bot-supplied plans skip this — see above.)
  if (!botSupplied && plan.stock > 0) {
    const dec = run(db, `UPDATE plans SET stock=stock-1 WHERE id=? AND stock > 0`, [topup.plan_id]);
    if (!dec.changes) {
      run(db, `UPDATE topups SET status='refund_needed' WHERE id=?`, [topup.id]);
      run(db, `INSERT INTO audit_log (actor_kind,actor_label,action,target_kind,target_id,after_json) VALUES (?,?,?,?,?,?)`,
        ['system', 'imap-verify', 'out_of_stock_after_payment', 'topup', String(topup.id),
         JSON.stringify({ plan_id: topup.plan_id, amount: topup.amount_inr, note: 'Paid topup needs manual refund — plan sold out' })]);
      return;
    }
  }

  const expiresAt = plan.duration_days
    ? new Date(Date.now() + plan.duration_days * 86400000).toISOString()
    : null;

  const result = run(db, `INSERT INTO orders (customer_jid,plan_id,amount_inr,status,expires_at) VALUES (?,?,?,?,?)`,
    [topup.customer_jid, topup.plan_id, topup.amount_inr, 'pending', expiresAt]);
  const orderId = result.lastInsertRowid;

  // Link order back to topup IMMEDIATELY so any retry of this function sees
  // topup.order_id set and short-circuits the duplicate-create guard above.
  run(db, `UPDATE topups SET order_id=? WHERE id=?`, [orderId, topup.id]);

  // Record referral reward on first order (no wallet — admin reviews pending rewards).
  // Filter by both referrer + referred so a re-referred customer isn't double-counted.
  if (cust?.referred_by) {
    const alreadyRewarded = get(db, `SELECT id FROM referral_rewards WHERE referrer_jid=? AND referred_jid=?`, [cust.referred_by, topup.customer_jid]);
    if (!alreadyRewarded) {
      const rewardInr = parseFloat(await getSetting('referral_reward_inr') || '20');
      run(db, `INSERT OR IGNORE INTO referral_rewards (referrer_jid,referred_jid,reward_inr,order_id) VALUES (?,?,?,?)`,
        [cust.referred_by, topup.customer_jid, rewardInr, orderId]);
    }
  }

  const isUsdt = String(topup.method || '').startsWith('usdt_');
  const paidDesc = isUsdt
    ? `${(topup.unique_amount_usdt ?? topup.amount_usdt ?? 0).toFixed(3)} USDT (${topup.method.replace('usdt_','').toUpperCase()})`
    : `₹${topup.amount_inr}`;

  run(db, `INSERT INTO audit_log (actor_kind,actor_label,action,target_kind,target_id,after_json) VALUES (?,?,?,?,?,?)`,
    ['system', 'imap-verify', 'direct_checkout_order', 'order', String(orderId),
     JSON.stringify({ topup_id: topup.id, plan_id: topup.plan_id, method: topup.method, amount_inr: topup.amount_inr, amount_usdt: topup.amount_usdt })]);

  // Notify customer via email
  if (cust?.email) {
    sendMail({
      to: cust.email,
      subject: `Order Placed — ${plan.platform} ${plan.name}`,
      html: `<p>Hi ${cust.name},</p><p>Your payment of <strong>${paidDesc}</strong> was received and your order for <strong>${plan.platform} — ${plan.name}</strong> has been placed.</p><p>Your credentials will be delivered shortly.</p>`,
    }).catch(() => {});
  }

  // Notify owner via WhatsApp
  const payTag = topup.method === 'wallet' ? 'Wallet' : isUsdt ? `USDT ${topup.method.replace('usdt_','').toUpperCase()}` : 'UPI Direct';
  notifyOwner(db, `🛍️ *New Order (${payTag})*\nCustomer: ${cust?.name || topup.customer_jid}\nPlan: ${plan.platform} — ${plan.name}\nAmount: ${paidDesc}\nOrder ID: #${orderId}\n\n🚀 Reply *.deliver ${orderId}* to deliver from stock\n   or *.deliver ${orderId} <credentials>* to send typed creds\nℹ️ *.order ${orderId}* for details`).catch(() => {});

  // Also email the admin — works even when the WhatsApp bot is offline, so new
  // orders are never missed. Goes to order_notify_email, else stock-alert/support.
  try {
    const adminEmail = (await getSetting('order_notify_email')) || (await getSetting('stock_alert_email')) || (await getSetting('support_email'));
    if (adminEmail) {
      sendMail({
        to: adminEmail,
        subject: `🛍️ New Order #${orderId} — ${plan.platform} ${plan.name} (${paidDesc})`,
        html: `<p style="font-size:15px"><strong>New order received</strong></p>
<table style="border-collapse:collapse;font-size:14px">
<tr><td style="padding:3px 10px;font-weight:600">Order</td><td style="padding:3px 10px">#${orderId}</td></tr>
<tr><td style="padding:3px 10px;font-weight:600">Plan</td><td style="padding:3px 10px">${plan.platform} — ${plan.name}</td></tr>
<tr><td style="padding:3px 10px;font-weight:600">Amount</td><td style="padding:3px 10px">${paidDesc} (${payTag})</td></tr>
<tr><td style="padding:3px 10px;font-weight:600">Customer</td><td style="padding:3px 10px">${cust?.name || ''} ${cust?.email || ''} ${cust?.phone || ''}</td></tr>
</table>
<p style="color:#666;font-size:12px;margin-top:10px">Deliver it from Admin → Orders → Manage.</p>`,
      }).catch(() => {});
    }
  } catch {}

  // Trigger auto-delivery
  triggerDelivery(topup.customer_jid).catch(() => {});
}

async function notifyOwner(db, message) {
  try {
    // Prefer the dedicated owner number; fall back to the public support line.
    const ownerPhone = get(db, `SELECT value FROM settings WHERE key='wa_owner_number'`)?.value
      || get(db, `SELECT value FROM settings WHERE key='support_whatsapp'`)?.value || '';
    const phone = String(ownerPhone).replace(/\D/g, '');
    if (!phone) return;
    const { sendToPhone } = require('./wa-bot');
    await sendToPhone(phone, message);
  } catch {}
}

// Called after wallet is credited — attempt auto-delivery of pending orders
async function triggerDelivery(customerJid) {
  const { autoDeliverForCustomer } = require('./delivery-worker');
  await autoDeliverForCustomer(customerJid).catch(() => {});
}

async function runImapCheck() {
  if (_running) return;
  _running = true;
  try {
    const enabled = await getSetting('imap_enabled');
    if (enabled !== '1') { _running = false; return; }

    const host = await getSetting('imap_host') || 'imap.gmail.com';
    const port = parseInt(await getSetting('imap_port') || '993');
    const user = await getSetting('imap_email') || '';
    const password = await getSetting('imap_password') || '';
    const folder = await getSetting('imap_folder') || 'INBOX';

    if (!user || !password) { _running = false; return; }

    // Cost saver: skip connecting to the inbox when there's nothing to match — i.e.
    // no pending order payment is awaiting a bank email. A payment only arrives AFTER a
    // checkout has created a pending topup, so a zero count means no email is expected.
    // This avoids a Gmail TLS round-trip every 30s while the store is idle (most of the
    // time), which is the single biggest recurring network cost.
    try {
      const db = await getDb();
      const pendingN = get(db, `SELECT COUNT(*) AS n FROM topups WHERE status='pending' AND purpose='order'`)?.n || 0;
      if (!pendingN) { _running = false; return; }
    } catch {}

    // UID-based polling instead of UNSEEN: any client reading the email won't
    // hide it from us. lastUid is persisted so we resume from where we left
    // off after a restart. On first ever run, lastUid=0 → falls back to SINCE.
    // If admin reconnects to a DIFFERENT inbox the old UID is meaningless and
    // would silently skip every new message; detect the inbox change and
    // reset lastUid to 0 in that case.
    const lastEmail = await getSetting('imap_last_email') || '';
    if (lastEmail !== user) {
      try { await setSetting('imap_last_uid', '0'); } catch {}
      try { await setSetting('imap_last_email', user); } catch {}
    }
    const lastUid = parseInt(await getSetting('imap_last_uid') || '0', 10) || 0;
    const since = new Date(_lastCheck);
    _lastCheck = new Date();

    await new Promise((resolve, reject) => {
      const imap = new Imap({ user, password, host, port, tls: true, tlsOptions: { rejectUnauthorized: false } });

      imap.once('error', err => { reject(err); });
      imap.once('ready', () => {
        imap.openBox(folder, true, async (err) => {
          if (err) { imap.end(); return reject(err); }
          try {
            const { messages: raws, maxUid } = await fetchMessages(imap, lastUid, since);
            const matched = await parseAndMatch(raws);
            if (matched > 0) _status.matched += matched;
            // Persist the highest UID seen so we don't re-fetch on next tick
            // (even if a single message in this batch failed to parse).
            if (maxUid > lastUid) { try { await setSetting('imap_last_uid', String(maxUid)); } catch {} }
            imap.end();
            resolve();
          } catch (e) { imap.end(); reject(e); }
        });
      });
      imap.connect();
    });

    _status = { ok: true, lastRun: new Date().toISOString(), lastError: null, matched: _status.matched };
  } catch (e) {
    _status = { ok: false, lastRun: new Date().toISOString(), lastError: e.message, matched: _status.matched };
  } finally {
    _running = false;
  }
}

async function testImapConnection({ host, port, user, password, folder = 'INBOX' }) {
  return new Promise((resolve) => {
    const imap = new Imap({ user, password, host: host || 'imap.gmail.com', port: port || 993, tls: true, tlsOptions: { rejectUnauthorized: false }, connTimeout: 10000 });
    imap.once('error', e => resolve({ ok: false, error: e.message }));
    imap.once('ready', () => {
      imap.openBox(folder, true, (err) => {
        imap.end();
        if (err) resolve({ ok: false, error: err.message });
        else resolve({ ok: true });
      });
    });
    imap.connect();
  });
}

function startImapWorker() {
  // Check every 30 seconds
  setInterval(runImapCheck, 30 * 1000);
  runImapCheck(); // immediate first run
}

function getImapStatus() { return _status; }

// Generate a unique paise suffix for a UPI payment amount
// Unique payment amount = base price ± a small WHOLE-RUPEE delta (default ±1..±6).
// A clean round number (₹203) is far less likely to be "rounded off" than the old
// +paise figure (₹200.50 → people paid ₹200). Collision-aware: never returns an
// amount already used by another pending order (which would make matching
// ambiguous); if every whole-rupee slot in the range is taken, falls back to a
// free paise amount so two orders never share an amount.
function generateUniqueAmount(baseAmount, usedUniques = [], maxDelta = 6, direction = 'both') {
  const base = Math.round(parseFloat(baseAmount) || 0);
  const used = new Set((usedUniques || []).map(u => Math.round(parseFloat(u) * 100) / 100));
  const max  = Math.max(1, Math.min(50, parseInt(maxDelta, 10) || 6));
  const upOnly = String(direction) === 'up'; // 'up' → never charge below the price
  const deltas = [];
  for (let d = 1; d <= max; d++) { deltas.push(d); if (!upOnly) deltas.push(-d); } // +1..+max (and -1..-max unless up-only)
  for (let i = deltas.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deltas[i], deltas[j]] = [deltas[j], deltas[i]]; }
  for (const d of deltas) {
    const cand = base + d;
    if (cand >= 1 && !used.has(cand)) return cand; // clean whole rupee, not in use
  }
  // Whole-rupee slots exhausted (many concurrent same-price orders) — use paise.
  for (let p = 1; p <= 98; p++) {
    const cand = Math.round(base * 100 + p) / 100;
    if (!used.has(cand)) return cand;
  }
  return base + (Math.floor(Math.random() * max) + 1); // last resort
}

// Generate a unique milli-USDT suffix for a USDT payment amount (3 decimal places).
// Adds 0.001 .. 0.099 USDT so each pending order has a distinguishable amount.
function generateUniqueUsdtAmount(baseAmount) {
  const milli = Math.floor(Math.random() * 99) + 1; // 1–99 milli-USDT
  return Math.round(parseFloat(baseAmount) * 1000 + milli) / 1000;
}

// Manually verify a pending payment — the admin clicks "Verify" in the Payment Log
// when the IMAP auto-match never fired (bank email delayed/never arrived, amount
// mismatch, etc.). Runs the EXACT same path as auto-verification:
//   handleDirectCheckout → create order → notify owner (WA+email) → auto-deliver,
// then mark the topup approved. Idempotent (handleDirectCheckout guards on order_id).
// SAFETY: the admin must have actually confirmed the money was received — this
// creates AND delivers the order.
async function manualVerifyTopup(topupId) {
  const db = await getDb();
  const topup = get(db, `SELECT * FROM topups WHERE id=?`, [topupId]);
  if (!topup) return { ok: false, error: 'Payment not found' };
  if (topup.order_id) return { ok: false, error: `Already verified — order #${topup.order_id} exists` };
  if (topup.purpose && topup.purpose !== 'order') return { ok: false, error: 'Not an order payment' };
  const plan = get(db, `SELECT id, platform, name, stock, provider_api, delivery_type FROM plans WHERE id=? AND active=1`, [topup.plan_id]);
  if (!plan) return { ok: false, error: 'Plan not found or inactive' };
  // Bot-supplied auto plans aren't gated on local stock — the OTT24x7 bot fulfils
  // them on demand (handleDirectCheckout + the delivery worker handle availability
  // and auto-refund to wallet). Only block manual verify for finite-stock plans.
  const botSupplied = plan.provider_api === 'bot' && plan.delivery_type === 'auto';
  if (!botSupplied && plan.stock === 0) return { ok: false, error: 'Plan is sold out (stock 0) — cannot create order; refund the customer.' };

  const cust = get(db, `SELECT * FROM customers WHERE jid=?`, [topup.customer_jid]);
  try { await handleDirectCheckout(db, topup, cust); }
  catch (e) { return { ok: false, error: 'Order creation failed: ' + e.message }; }

  const fresh = get(db, `SELECT order_id, status FROM topups WHERE id=?`, [topup.id]);
  if (!fresh?.order_id) {
    return { ok: false, error: fresh?.status === 'refund_needed'
      ? 'Plan sold out after payment — refund needed.'
      : 'Could not create an order (check the plan/stock).' };
  }
  run(db, `UPDATE topups SET status='approved' WHERE id=?`, [topup.id]);
  return { ok: true, orderId: fresh.order_id };
}

module.exports = { startImapWorker, getImapStatus, testImapConnection, generateUniqueAmount, generateUniqueUsdtAmount, triggerDelivery, manualVerifyTopup, handleDirectCheckout };
