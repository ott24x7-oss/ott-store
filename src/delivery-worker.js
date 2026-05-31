'use strict';
const { getDb, getSetting, all, get, run } = require('./db');
const { sendMail } = require('./mailer');

// Auto-deliver pending orders from local stock credentials
async function autoDeliverOrder(order, db) {
  if (!order.plan_id) return false;

  // Find an available stock credential for this plan
  const cred = get(db, `SELECT * FROM stock_credentials WHERE plan_id=? AND status='available' ORDER BY id ASC LIMIT 1`, [order.plan_id]);
  if (!cred) return false; // no stock — stays pending for admin

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

  return true;
}

async function checkStockAlert(planId, db) {
  const threshold = parseInt(await getSetting('stock_alert_threshold') || '5');
  const alertEmail = await getSetting('stock_alert_email') || await getSetting('support_email') || '';
  if (!alertEmail) return;

  const row = get(db, `SELECT COUNT(*) as cnt FROM stock_credentials WHERE plan_id=? AND status='available'`, [planId]);
  const remaining = row?.cnt || 0;
  if (remaining <= threshold) {
    const plan = get(db, 'SELECT name, platform FROM plans WHERE id=?', [planId]);
    sendMail({
      to: alertEmail,
      subject: `⚠️ Low Stock Alert: ${plan?.name || 'Plan #' + planId}`,
      html: `<p>Stock for <strong>${plan?.platform} – ${plan?.name}</strong> is low.</p>
<p>Remaining: <strong>${remaining}</strong> credentials</p>
<p>Please add more stock in Admin → Stock.</p>`,
    }).catch(() => {});
  }
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

module.exports = { startDeliveryWorker, autoDeliverForCustomer, autoDeliverOrder, deliverWithCredentials };
