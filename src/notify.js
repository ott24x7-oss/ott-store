'use strict';
/**
 * Shared admin/owner notifier.
 *
 * Every important event (new order, sale delivered, out-of-stock, low stock)
 * goes through notifyAdmin() so the store owner is reached on BOTH channels:
 *
 *   1. WhatsApp  → wa_owner_number (falls back to support_whatsapp)  — best-effort.
 *   2. Email     → order_notify_email → stock_alert_email → support_email — reliable.
 *
 * The WhatsApp bot is best-effort: if it is not linked (no session) the send is
 * silently skipped — exactly why an admin can "miss" an order. The email leg is
 * the safety net so a paid order is NEVER missed even with the bot offline.
 *
 * `message` is WhatsApp-formatted (uses *bold*). For the email we strip the WA
 * markdown and wrap it in a <pre> unless an explicit html is supplied.
 */
const { getDb, get } = require('./db');

function ownerPhone(db) {
  const v = get(db, `SELECT value FROM settings WHERE key='wa_owner_number'`)?.value
    || get(db, `SELECT value FROM settings WHERE key='support_whatsapp'`)?.value || '';
  return String(v).replace(/\D/g, '');
}

function ownerEmail(db) {
  const v = get(db, `SELECT value FROM settings WHERE key='order_notify_email'`)?.value
    || get(db, `SELECT value FROM settings WHERE key='stock_alert_email'`)?.value
    || get(db, `SELECT value FROM settings WHERE key='support_email'`)?.value || '';
  return String(v).trim();
}

// Strip WhatsApp markdown for the plain-email rendering.
function stripWa(s) {
  return String(s || '').replace(/[*_`~]/g, '');
}

/**
 * Notify the store owner via WhatsApp + email.
 * @param {string} message  WhatsApp-formatted text.
 * @param {object} [opts]   { db, subject, html, whatsapp, email }
 *                          whatsapp/email default true; set false to skip a leg.
 */
async function notifyAdmin(message, opts = {}) {
  const db = opts.db || await getDb();

  // ── WhatsApp (best-effort — skipped when the bot is not linked) ──
  if (opts.whatsapp !== false) {
    try {
      const phone = ownerPhone(db);
      if (phone) {
        const { sendToPhone } = require('./wa-bot');
        await sendToPhone(phone, message).catch(() => {});
      }
    } catch { /* bot offline / not linked — email still goes out below */ }
  }

  // ── Email (reliable safety net) ──
  if (opts.email !== false) {
    try {
      const to = ownerEmail(db);
      if (to) {
        const { sendMail } = require('./mailer');
        const subject = opts.subject || stripWa(message).split('\n').filter(Boolean)[0]?.slice(0, 90) || 'Store notification';
        const html = opts.html
          || `<pre style="font-family:inherit;font-size:14px;line-height:1.5;white-space:pre-wrap;margin:0">${stripWa(message).replace(/[<>]/g, '')}</pre>`;
        sendMail({ to, subject, html }).catch(() => {});
      }
    } catch { /* mailer not configured */ }
  }
}

module.exports = { notifyAdmin, ownerPhone, ownerEmail };
