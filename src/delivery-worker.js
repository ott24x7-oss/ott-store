'use strict';
const { getDb, getSetting, all, get, run } = require('./db');
const { sendMail } = require('./mailer');

// Auto-deliver pending orders from local stock credentials.
// opts.silent → suppress the admin push alerts (used by explicit .deliver/.verify
// commands which already reply to the admin inline).
async function autoDeliverOrder(order, db, opts = {}) {
  if (!order.plan_id) return false;

  // Bot-backed auto products are fulfilled live via the OTT24x7 reseller API.
  const plan = get(db, `SELECT * FROM plans WHERE id=?`, [order.plan_id]);
  if (plan && plan.provider_api === 'bot' && plan.delivery_type === 'auto') {
    return deliverFromBot(order, plan, db, opts);
  }

  // Find an available stock credential for this plan
  const cred = get(db, `SELECT * FROM stock_credentials WHERE plan_id=? AND status='available' ORDER BY id ASC LIMIT 1`, [order.plan_id]);
  if (!cred) {
    // No stock — the paid order stays pending. Alert the admin ONCE (deduped via
    // audit_log) so a paid order is never silently stuck.
    if (!opts.silent) maybeAlertOutOfStock(db, order).catch(() => {});
    return false;
  }

  // Mark credential as sold
  run(db, `UPDATE stock_credentials SET status='sold', sold_order_id=?, sold_at=datetime('now') WHERE id=?`, [order.id, cred.id]);

  // Build credentials object
  const credentials = { line1: cred.line1 };
  if (cred.line2) credentials.line2 = cred.line2;
  if (cred.extra) credentials.extra = cred.extra;
  if (cred.cred_type === 'credential') {
    credentials.email = cred.line1;
    credentials.password = cred.line2 || '';
  } else if (cred.cred_type === 'key') {
    credentials.key = cred.line1;
  }

  // Update order
  run(db, `UPDATE orders SET status='delivered', credentials=?, stock_credential_id=?, delivered_at=datetime('now') WHERE id=?`,
    [JSON.stringify(credentials), cred.id, order.id]);

  run(db, `INSERT INTO audit_log (actor_kind,actor_label,action,target_kind,target_id,after_json) VALUES (?,?,?,?,?,?)`,
    ['system', 'delivery-worker', 'auto_deliver', 'order', String(order.id), JSON.stringify({ credential_id: cred.id })]);

  // Email customer (plan was loaded at the top of this function)
  const cust = get(db, 'SELECT email, name, phone FROM customers WHERE jid=?', [order.customer_jid]);
  if (cust?.email && plan) {
    const credsHtml = Object.entries(credentials)
      .map(([k, v]) => `<tr><td style="padding:4px 8px;font-weight:600;text-transform:capitalize">${k}</td><td style="padding:4px 8px;font-family:monospace">${v}</td></tr>`)
      .join('');
    sendMail({
      to: cust.email,
      subject: `Your ${plan.platform} – ${plan.name} is ready!`,
      html: `<p>Hi ${cust.name},</p>
<p>Your <strong>${plan.name}</strong> subscription credentials are ready:</p>
<table style="border-collapse:collapse;background:#f5f5f5;border-radius:6px;padding:8px;width:100%">
${credsHtml}
</table>
<p style="color:#666;font-size:12px">Keep these credentials safe. Do not share with anyone.</p>
<p>Thank you for your order!</p>`,
    }).catch(() => {});
  }

  // WhatsApp delivery notification (best-effort)
  const phone = cust?.phone || (order.customer_jid && !order.customer_jid.includes('@') ? order.customer_jid : null)
    || (order.customer_jid ? order.customer_jid.split('@')[0] : null);
  if (phone && /^\d{7,}$/.test(phone.replace(/\D/g, ''))) {
    try {
      const { sendToPhone } = require('./wa-bot');
      const credsLines = Object.entries(credentials)
        .filter(([k]) => !['line1','line2'].includes(k))
        .map(([k, v]) => `  *${k.charAt(0).toUpperCase() + k.slice(1)}:* ${v}`)
        .join('\n');
      const waMsg =
        `✅ *Order Delivered!*\n\n` +
        `📦 *${plan?.platform || ''} – ${plan?.name || ''}*\n\n` +
        `🔑 *Your Credentials:*\n${credsLines || Object.values(credentials).join(' / ')}\n\n` +
        `_Keep safe. Do not share._`;
      sendToPhone(phone, waMsg).catch(() => {});
    } catch {}
  }

  // Check low-stock alert
  checkStockAlert(order.plan_id, db).catch(() => {});

  // Tell the admin a sale was auto-delivered (with the creds for their record),
  // unless this came from an explicit admin command that already replied inline.
  if (!opts.silent) notifyOwnerSale(db, order, credentials, 'auto').catch(() => {});

  return true;
}

// Plan IDs we've already low-stock-alerted for (cleared when stock is refilled).
const _lowStockAlerted = new Set();

async function checkStockAlert(planId, db) {
  const threshold = parseInt(await getSetting('stock_alert_threshold') || '5');
  const row = get(db, `SELECT COUNT(*) as cnt FROM stock_credentials WHERE plan_id=? AND status='available'`, [planId]);
  const remaining = row?.cnt || 0;

  if (remaining > threshold) { _lowStockAlerted.delete(planId); return; }
  if (_lowStockAlerted.has(planId)) return; // already alerted — wait for a refill
  _lowStockAlerted.add(planId);

  const plan = get(db, 'SELECT name, platform FROM plans WHERE id=?', [planId]);
  const tag = remaining === 0 ? '🔴 *OUT OF STOCK*' : `🟡 *LOW STOCK* — only ${remaining} left`;
  const { notifyAdmin } = require('./notify');
  await notifyAdmin(
    `${tag}\n\n📦 ${plan?.platform || ''} ${plan?.name || ''}\n📉 Remaining: *${remaining}*\n\nAdd more in Admin → Stock.`,
    { db, subject: `⚠️ Low stock: ${plan?.platform || ''} ${plan?.name || 'Plan #' + planId} (${remaining} left)` }
  ).catch(() => {});
}

// Deliver all pending orders for a specific customer (called after wallet topup)
async function autoDeliverForCustomer(customerJid) {
  const db = await getDb();
  const orders = all(db, `SELECT * FROM orders WHERE customer_jid=? AND status='pending'`, [customerJid]);
  for (const o of orders) {
    await autoDeliverOrder(o, db).catch(() => {});
  }
}

// Deliver an order with explicitly-supplied credentials (manual / WhatsApp
// `.deliver` command / admin panel) — does NOT touch stock_credentials. Marks
// the order delivered, then emails + WhatsApps the customer using the SAME
// notification path as auto-delivery. Returns false if the order was already
// delivered (guards against double-send when a tick + an admin command race).
async function deliverWithCredentials(db, order, credentials, opts = {}) {
  const note = opts.note || order.delivery_note || 'Delivered by admin';
  const upd = run(db,
    `UPDATE orders SET status='delivered', credentials=?, delivery_note=?, delivered_at=datetime('now')
     WHERE id=? AND status<>'delivered'`,
    [JSON.stringify(credentials), note, order.id]);
  if (!upd.changes) return false; // already delivered — don't re-notify

  run(db, `INSERT INTO audit_log (actor_kind,actor_label,action,target_kind,target_id,after_json) VALUES (?,?,?,?,?,?)`,
    [opts.actorKind || 'admin', opts.actorLabel || 'wa-admin', 'manual_deliver', 'order', String(order.id),
     JSON.stringify({ via: opts.via || 'whatsapp' })]);

  // Email customer
  const cust = get(db, 'SELECT email, name, phone FROM customers WHERE jid=?', [order.customer_jid]);
  const plan = get(db, 'SELECT name, platform FROM plans WHERE id=?', [order.plan_id]);
  if (cust?.email && plan) {
    const credsHtml = Object.entries(credentials)
      .map(([k, v]) => `<tr><td style="padding:4px 8px;font-weight:600;text-transform:capitalize">${k}</td><td style="padding:4px 8px;font-family:monospace">${v}</td></tr>`)
      .join('');
    sendMail({
      to: cust.email,
      subject: `Your ${plan.platform} – ${plan.name} is ready!`,
      html: `<p>Hi ${cust.name},</p>
<p>Your <strong>${plan.name}</strong> subscription credentials are ready:</p>
<table style="border-collapse:collapse;background:#f5f5f5;border-radius:6px;padding:8px;width:100%">
${credsHtml}
</table>
<p style="color:#666;font-size:12px">Keep these credentials safe. Do not share with anyone.</p>
<p>Thank you for your order!</p>`,
    }).catch(() => {});
  }

  // WhatsApp delivery notification (best-effort)
  const phone = cust?.phone || (order.customer_jid && !order.customer_jid.includes('@') ? order.customer_jid : null)
    || (order.customer_jid ? order.customer_jid.split('@')[0] : null);
  if (phone && /^\d{7,}$/.test(String(phone).replace(/\D/g, ''))) {
    try {
      const { sendToPhone } = require('./wa-bot');
      const credsLines = Object.entries(credentials)
        .filter(([k]) => !['line1', 'line2'].includes(k))
        .map(([k, v]) => `  *${k.charAt(0).toUpperCase() + k.slice(1)}:* ${v}`)
        .join('\n');
      const waMsg =
        `✅ *Order Delivered!*\n\n` +
        `📦 *${plan?.platform || ''} – ${plan?.name || ''}*\n\n` +
        `🔑 *Your Credentials:*\n${credsLines || Object.values(credentials).join(' / ')}\n\n` +
        `_Keep safe. Do not share._`;
      sendToPhone(phone, waMsg).catch(() => {});
    } catch {}
  }

  return true;
}

// Main worker tick — process all pending orders that have stock available
async function deliveryTick() {
  try {
    const db = await getDb();
    const pending = all(db, `SELECT * FROM orders WHERE status='pending' AND plan_id IS NOT NULL ORDER BY created_at ASC LIMIT 50`);
    for (const o of pending) {
      await autoDeliverOrder(o, db).catch(() => {});
    }
  } catch {}
}

function startDeliveryWorker() {
  setInterval(deliveryTick, 15 * 1000); // every 15s
  deliveryTick();
}

// ─── Admin alert helpers ──────────────────────────────────────────────────────
function credLines(credentials) {
  return Object.entries(credentials)
    .filter(([k]) => !['line1', 'line2'].includes(k))
    .map(([k, v]) => `  *${k.charAt(0).toUpperCase() + k.slice(1)}:* ${v}`)
    .join('\n') || Object.values(credentials).join(' / ');
}

// "NEW SALE — DELIVERED" — fired on automatic delivery so the owner has a record
// (incl. credentials) of every sale even when they didn't trigger it themselves.
async function notifyOwnerSale(db, order, credentials, mode) {
  const plan = get(db, 'SELECT name, platform FROM plans WHERE id=?', [order.plan_id]);
  const cust = get(db, 'SELECT name, email FROM customers WHERE jid=?', [order.customer_jid]);
  const { notifyAdmin } = require('./notify');
  await notifyAdmin(
    `💰 *NEW SALE — DELIVERED ✅*\n\n` +
    `📦 *${plan?.platform || ''} — ${plan?.name || ''}*\n` +
    `💵 ₹${order.amount_inr}\n` +
    `👤 ${cust?.name || order.customer_jid}${cust?.email ? ` · ${cust.email}` : ''}\n` +
    `🆔 Order: #${order.id}\n` +
    `${mode === 'auto' ? '🤖 Delivered from stock (auto)' : '🧑‍💼 Delivered manually'}\n\n` +
    `🔑 *Credentials sent to customer:*\n${credLines(credentials)}\n\n` +
    `_Saved in Admin → Orders._`,
    { db, subject: `💰 Sale delivered — Order #${order.id} (${plan?.platform || ''} ${plan?.name || ''})` }
  );
}

// "PAID — OUT OF STOCK" — fired once per order (deduped via audit_log) when a paid
// order cannot be auto-delivered, so it never sits unnoticed like order #20 did.
async function maybeAlertOutOfStock(db, order) {
  const dup = get(db, `SELECT id FROM audit_log WHERE action='oos_alert' AND target_kind='order' AND target_id=? LIMIT 1`, [String(order.id)]);
  if (dup) return;
  run(db, `INSERT INTO audit_log (actor_kind,actor_label,action,target_kind,target_id) VALUES ('system','delivery-worker','oos_alert','order',?)`, [String(order.id)]);
  const plan = get(db, 'SELECT name, platform FROM plans WHERE id=?', [order.plan_id]);
  const cust = get(db, 'SELECT name, email FROM customers WHERE jid=?', [order.customer_jid]);
  const { notifyAdmin } = require('./notify');
  await notifyAdmin(
    `⚠️ *PAID — OUT OF STOCK*\n\n` +
    `📦 ${plan?.platform || ''} ${plan?.name || ''}\n` +
    `💵 ₹${order.amount_inr}\n` +
    `👤 ${cust?.name || order.customer_jid}${cust?.email ? ` · ${cust.email}` : ''}\n` +
    `🆔 Order: #${order.id}\n\n` +
    `No stock to auto-deliver. Deliver manually:\n` +
    `\`.deliver ${order.id} <credentials>\`\n` +
    `…or add stock in Admin → Stock, then \`.deliver ${order.id}\`.`,
    { db, subject: `⚠️ Order #${order.id} PAID but OUT OF STOCK — needs manual delivery` }
  );
}

// ─── Bot-supplier fulfillment (provider_api='bot') ──────────────────────────────
// Auto products imported from the OTT24x7 bot are delivered by buying live from the
// bot at delivery time and relaying the returned key(s) to the customer.
const _botInFlight = new Set();   // order ids being fulfilled right now (in-process lock)
const _botAttempts = new Map();   // order id -> transient-failure count (resets on restart)

// Turn the bot's delivered key string(s) into a credentials object for display/email.
function credentialsFromKeys(keys) {
  const list = (keys || []).map(k => String(k).trim()).filter(Boolean);
  if (list.length === 1) {
    const v = list[0];
    const m = v.match(/^([^\s:]+@[^\s:]+):(.+)$/); // email:password → nicer display
    if (m) return { email: m[1], password: m[2] };
    return { key: v };
  }
  return { keys: list.join('\n') };
}

// Record/refresh the order's fulfillment job (order_id is UNIQUE → one row per order).
function recordBotJob(db, order, plan, status, extra = {}) {
  const existing = get(db, `SELECT id FROM fulfillment_jobs WHERE order_id=?`, [order.id]);
  const raw = extra.raw ? JSON.stringify(extra.raw).slice(0, 4000) : null;
  const deliveredAt = status === 'delivered' ? new Date().toISOString() : null;
  if (existing) {
    run(db, `UPDATE fulfillment_jobs SET status=?, attempt_count=attempt_count+1, last_attempt_at=datetime('now'),
               error_msg=?, raw_response=?, provider_order_id=COALESCE(?,provider_order_id),
               delivered_at=COALESCE(?,delivered_at) WHERE order_id=?`,
      [status, extra.error || null, raw, extra.providerOrderId || null, deliveredAt, order.id]);
  } else {
    run(db, `INSERT INTO fulfillment_jobs (order_id,plan_id,customer_jid,provider_api,provider_product_id,
               provider_order_id,status,attempt_count,last_attempt_at,error_msg,raw_response,delivered_at)
             VALUES (?,?,?,?,?,?,?,1,datetime('now'),?,?,?)`,
      [order.id, plan.id, order.customer_jid, 'bot', plan.provider_product_id,
       extra.providerOrderId || null, status, extra.error || null, raw, deliveredAt]);
  }
}

async function deliverFromBot(order, plan, db, opts = {}) {
  const botSupplier = require('./bot-supplier');

  if (order.status === 'delivered' || order.status === 'cancelled') return false;
  if (_botInFlight.has(order.id)) return false;

  // Idempotency across restarts: a job in a terminal state means we already delivered
  // or refunded it — never buy from the bot twice for the same order.
  const job = get(db, `SELECT status FROM fulfillment_jobs WHERE order_id=?`, [order.id]);
  if (job && ['delivered', 'failed'].includes(job.status)) return false;

  const c = botSupplier.botConfig(db);
  if (!botSupplier.isConfigured(c)) {
    if (!opts.silent) maybeAlertOutOfStock(db, order).catch(() => {}); // can't fulfill — flag it
    return false;
  }

  _botInFlight.add(order.id);
  try {
    const cust = get(db, 'SELECT email, name FROM customers WHERE jid=?', [order.customer_jid]);
    const res = await botSupplier.purchase(plan.provider_product_id, 1,
      { order_id: order.id, source: 'ott-store', email: cust?.email || '' }, db);

    if (res.ok && res.keys && res.keys.length > 0) {
      const credentials = credentialsFromKeys(res.keys);
      const delivered = await deliverWithCredentials(db, order, credentials,
        { via: 'bot', actorKind: 'system', actorLabel: 'bot-supplier', note: 'Auto-delivered via OTT24x7 bot' });
      recordBotJob(db, order, plan, 'delivered', { providerOrderId: res.raw && res.raw.order_id, raw: res.raw });
      _botAttempts.delete(order.id);
      if (delivered && !opts.silent) notifyOwnerSale(db, order, credentials, 'auto').catch(() => {});
      return delivered;
    }

    if (res.outOfStock) {
      recordBotJob(db, order, plan, 'failed', { error: res.error, raw: res.raw });
      _botAttempts.delete(order.id);
      await refundBotOrder(db, order, plan).catch(() => {});
      return false;
    }

    // Transient (network/5xx) → retry next tick. Config/availability (402/403/404) →
    // leave pending for the admin. Alert once after a few failed attempts either way.
    recordBotJob(db, order, plan, res.retryable ? 'pending' : 'error', { error: res.error, raw: res.raw });
    const n = (_botAttempts.get(order.id) || 0) + 1;
    _botAttempts.set(order.id, n);
    if (n === 3 && !opts.silent) {
      const { notifyAdmin } = require('./notify');
      notifyAdmin(
        `⚠️ *Bot fulfillment failing*\n📦 ${plan.platform || ''} ${plan.name || ''}\n🆔 Order #${order.id}\n` +
        `Error: ${res.error}\n\nThe store keeps retrying transient errors. Check the bot API URL/token and the provider's stock/balance.`,
        { db, subject: `⚠️ Bot fulfillment error — order #${order.id}` }
      ).catch(() => {});
    }
    return false;
  } catch (e) {
    return false;
  } finally {
    _botInFlight.delete(order.id);
  }
}

// Out-of-stock at the bot → refund the customer's store wallet, cancel the order, and
// notify customer + admin. Mirrors POST /admin/api/orders/:id/refund-wallet.
async function refundBotOrder(db, order, plan) {
  const amount = Math.round((parseFloat(order.amount_inr) || 0) * 100) / 100;
  let newBal = null;
  const dup = get(db, `SELECT id FROM wallet_txns WHERE type='refund' AND ref_id=? LIMIT 1`, [String(order.id)]);
  if (!dup && amount > 0 && order.customer_jid) {
    const { creditWallet } = require('./wallet');
    newBal = creditWallet(db, order.customer_jid, amount,
      { type: 'refund', label: `Refund — out of stock (order #${order.id})`, ref_id: order.id });
  }
  run(db, `UPDATE orders SET status='cancelled' WHERE id=? AND status<>'delivered'`, [order.id]);
  run(db, `INSERT INTO audit_log (actor_kind,actor_label,action,target_kind,target_id) VALUES ('system','bot-supplier','bot_oos_refund','order',?)`, [String(order.id)]);

  const cust = get(db, 'SELECT email, name, phone FROM customers WHERE jid=?', [order.customer_jid]);
  if (cust?.email) {
    sendMail({
      to: cust.email,
      subject: `Refund — order #${order.id}`,
      html: `<p>Hi ${cust.name || ''},</p>
<p>Sorry — <strong>${plan.platform || ''} ${plan.name || ''}</strong> sold out before we could deliver order <strong>#${order.id}</strong>.</p>
<p>We've refunded <strong>₹${amount.toFixed(2)}</strong> to your store wallet${newBal != null ? ` (balance: ₹${newBal.toFixed(2)})` : ''}. Use it at checkout any time.</p>`,
    }).catch(() => {});
  }
  const phone = String(cust?.phone || '').replace(/\D/g, '');
  if (phone.length >= 10) {
    try {
      const { sendToPhone } = require('./wa-bot');
      sendToPhone(phone, `💰 *Refund processed*\nOrder #${order.id} (${plan.platform || ''} ${plan.name || ''}) sold out — *₹${amount.toFixed(2)}* added to your wallet. Use it at checkout.`).catch(() => {});
    } catch {}
  }
  const { notifyAdmin } = require('./notify');
  notifyAdmin(
    `⚠️ *BOT OUT OF STOCK — auto-refunded*\n📦 ${plan.platform || ''} ${plan.name || ''}\n🆔 Order #${order.id}\n💵 ₹${amount.toFixed(2)} refunded to wallet.\n\nThe provider had no stock at purchase time.`,
    { db, subject: `⚠️ Order #${order.id} refunded — bot out of stock` }
  ).catch(() => {});
}

module.exports = { startDeliveryWorker, autoDeliverForCustomer, autoDeliverOrder, deliverWithCredentials, deliverFromBot };
