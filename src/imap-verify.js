'use strict';
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const { getDb, getSetting, all, get, run } = require('./db');
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

function fetchMessages(imap, since) {
  return new Promise((resolve, reject) => {
    imap.search(['UNSEEN', ['SINCE', since]], (err, uids) => {
      if (err) return reject(err);
      if (!uids || !uids.length) return resolve([]);

      const fetch = imap.fetch(uids, { bodies: '' });
      const messages = [];

      fetch.on('message', msg => {
        let raw = '';
        msg.on('body', stream => {
          stream.on('data', chunk => { raw += chunk.toString(); });
        });
        msg.once('end', () => messages.push(raw));
      });
      fetch.once('error', reject);
      fetch.once('end', () => resolve(messages));
    });
  });
}

async function parseAndMatch(rawMessages) {
  const db = await getDb();
  // Fetch pending topups with unique_amount set
  const pending = all(db, `SELECT * FROM topups WHERE status='pending' AND unique_amount IS NOT NULL AND method='upi_imap'`);
  if (!pending.length) return 0;

  let matched = 0;
  for (const raw of rawMessages) {
    let parsed;
    try { parsed = await simpleParser(raw); } catch { continue; }

    const text = ((parsed.text || '') + ' ' + (parsed.html || '')).toLowerCase();
    const amounts = extractAmounts(text);

    for (const amt of amounts) {
      const topup = pending.find(t => Math.abs(t.unique_amount - amt) < 0.001);
      if (!topup) continue;

      // Auto-approve
      run(db, `UPDATE topups SET status='approved' WHERE id=?`, [topup.id]);
      run(db, `INSERT INTO audit_log (actor_kind,actor_label,action,target_kind,target_id,after_json) VALUES (?,?,?,?,?,?)`,
        ['system', 'imap-verify', 'topup_auto_approve', 'topup', String(topup.id),
         JSON.stringify({ amount: topup.amount_inr, unique_amount: topup.unique_amount, purpose: topup.purpose })]);
      matched++;

      const cust = get(db, 'SELECT * FROM customers WHERE jid=?', [topup.customer_jid]);

      if (topup.purpose === 'order' && topup.plan_id) {
        // Direct checkout: create the order immediately, no wallet credit
        await handleDirectCheckout(db, topup, cust).catch(() => {});
      } else {
        // Standard wallet topup
        run(db, `UPDATE customers SET wallet_inr = wallet_inr + ? WHERE jid=?`, [topup.amount_inr, topup.customer_jid]);
        run(db, `INSERT INTO wallet_txns (customer_jid,amount_inr,type,label,ref_id) VALUES (?,?,?,?,?)`,
          [topup.customer_jid, topup.amount_inr, 'topup', 'UPI Auto-Verified', String(topup.id)]);

        if (cust?.email) {
          sendMail({
            to: cust.email,
            subject: 'Wallet Topped Up ✓',
            html: `<p>Hi ${cust.name},</p><p>Your wallet has been topped up with <strong>₹${topup.amount_inr}</strong> via UPI (auto-verified).</p><p>Current balance updated in your account.</p>`,
          }).catch(() => {});
        }

        // Trigger auto-delivery for any pending orders
        triggerDelivery(topup.customer_jid).catch(() => {});
      }
    }
  }
  return matched;
}

async function handleDirectCheckout(db, topup, cust) {
  const plan = get(db, 'SELECT * FROM plans WHERE id=? AND active=1', [topup.plan_id]);
  if (!plan) return;
  if (plan.stock === 0) return;

  const expiresAt = plan.duration_days
    ? new Date(Date.now() + plan.duration_days * 86400000).toISOString()
    : null;

  const result = run(db, `INSERT INTO orders (customer_jid,plan_id,amount_inr,status,expires_at) VALUES (?,?,?,?,?)`,
    [topup.customer_jid, topup.plan_id, topup.amount_inr, 'pending', expiresAt]);
  const orderId = result.lastInsertRowid;

  if (plan.stock > 0) run(db, `UPDATE plans SET stock=stock-1 WHERE id=?`, [topup.plan_id]);

  // Link order back to topup for polling
  run(db, `UPDATE topups SET order_id=? WHERE id=?`, [orderId, topup.id]);

  // Credit referral reward on first order
  if (cust?.referred_by) {
    const alreadyRewarded = get(db, `SELECT id FROM referral_rewards WHERE referred_jid=?`, [topup.customer_jid]);
    if (!alreadyRewarded) {
      const rewardInr = parseFloat(await getSetting('referral_reward_inr') || '20');
      run(db, `INSERT OR IGNORE INTO referral_rewards (referrer_jid,referred_jid,reward_inr,order_id) VALUES (?,?,?,?)`,
        [cust.referred_by, topup.customer_jid, rewardInr, orderId]);
      run(db, `UPDATE customers SET wallet_inr = wallet_inr + ? WHERE jid=?`, [rewardInr, cust.referred_by]);
      run(db, `INSERT INTO wallet_txns (customer_jid,amount_inr,type,label) VALUES (?,?,?,?)`,
        [cust.referred_by, rewardInr, 'referral', 'Referral bonus']);
      run(db, `UPDATE referral_rewards SET status='credited' WHERE referred_jid=?`, [topup.customer_jid]);
    }
  }

  run(db, `INSERT INTO audit_log (actor_kind,actor_label,action,target_kind,target_id,after_json) VALUES (?,?,?,?,?,?)`,
    ['system', 'imap-verify', 'direct_checkout_order', 'order', String(orderId),
     JSON.stringify({ topup_id: topup.id, plan_id: topup.plan_id, amount: topup.amount_inr })]);

  // Notify customer via email
  if (cust?.email) {
    sendMail({
      to: cust.email,
      subject: `Order Placed — ${plan.platform} ${plan.name}`,
      html: `<p>Hi ${cust.name},</p><p>Your payment of <strong>₹${topup.amount_inr}</strong> was received and your order for <strong>${plan.platform} — ${plan.name}</strong> has been placed.</p><p>Your credentials will be delivered shortly.</p>`,
    }).catch(() => {});
  }

  // Notify owner via WhatsApp
  notifyOwner(db, `🛍️ *New Order (UPI Direct)*\nCustomer: ${cust?.name || topup.customer_jid}\nPlan: ${plan.platform} — ${plan.name}\nAmount: ₹${topup.amount_inr}\nOrder ID: #${orderId}`).catch(() => {});

  // Trigger auto-delivery
  triggerDelivery(topup.customer_jid).catch(() => {});
}

async function notifyOwner(db, message) {
  try {
    const supportPhone = get(db, `SELECT value FROM settings WHERE key='support_whatsapp'`)?.value || '';
    if (!supportPhone) return;
    const phone = String(supportPhone).replace(/\D/g, '');
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

    const since = new Date(_lastCheck);
    _lastCheck = new Date();

    await new Promise((resolve, reject) => {
      const imap = new Imap({ user, password, host, port, tls: true, tlsOptions: { rejectUnauthorized: false } });

      imap.once('error', err => { reject(err); });
      imap.once('ready', () => {
        imap.openBox(folder, true, async (err) => {
          if (err) { imap.end(); return reject(err); }
          try {
            const raws = await fetchMessages(imap, since);
            const matched = await parseAndMatch(raws);
            if (matched > 0) _status.matched += matched;
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
function generateUniqueAmount(baseAmount) {
  const paise = Math.floor(Math.random() * 98) + 1; // 1–98
  return Math.round((parseFloat(baseAmount) * 100 + paise)) / 100;
}

module.exports = { startImapWorker, getImapStatus, testImapConnection, generateUniqueAmount, triggerDelivery };
