'use strict';
/**
 * WhatsApp Admin Commands — owner-only `.commands` handled inside the bot DM.
 *
 * Mirrors the reference store.whatsapp-Bot flow but adapted to ott-store's
 * schema: orders.id is an INTEGER, status is a string ('pending'|'processing'|
 * 'delivered'|'cancelled'), and credentials are stored as JSON.
 *
 * The owner is recognised by matching the sender's phone (last 10 digits)
 * against either `wa_owner_number` or `support_whatsapp` in settings, so it
 * works regardless of which field the admin filled in.
 *
 * Wired from wa-bot.js → processIncomingWA: if the sender is the owner and the
 * message starts with '.', we dispatch here and suppress the AI reply.
 */
const { getDb, getSettingSync, all, get, run } = require('./db');

// ─── Owner identification ─────────────────────────────────────────────────────
function last10(s) { return String(s || '').replace(/\D/g, '').slice(-10); }

function ownerNumbers() {
  const out = new Set();
  for (const key of ['wa_owner_number', 'support_whatsapp']) {
    const v = getSettingSync(key);
    const d = last10(v);
    if (d.length === 10) out.add(d);
  }
  return [...out];
}

function isOwnerJid(jid) {
  const p = last10(String(jid || '').split('@')[0]);
  if (!p) return false;
  return ownerNumbers().includes(p);
}

// ─── Reply helper ─────────────────────────────────────────────────────────────
async function send(jid, text) {
  const { getActiveSock } = require('./wa-bot');
  const s = getActiveSock();
  if (!s) return false;
  try { await s.sendMessage(jid, { text: String(text) }); return true; }
  catch (e) { console.error('[wa-admin] send error:', e.message); return false; }
}

// ─── Credential parsing for inline `.deliver` ─────────────────────────────────
// Accepts:  user@x.com:pass   |   user@x.com pass   |   KEY-1234-ABCD
//           or multi-line (line1 / line2 / extra).
// Produces an object that renders the same way auto-delivery does (line1/line2
// for the customer order page, plus email/password/key aliases when detected).
function parseInlineCreds(raw) {
  const lines = String(raw || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const creds = {};
  if (lines.length >= 2) {
    creds.line1 = lines[0];
    creds.line2 = lines[1];
    if (lines[2]) creds.extra = lines.slice(2).join('\n');
    if (/@/.test(lines[0])) { creds.email = lines[0]; creds.password = lines[1]; }
  } else {
    const one = lines[0] || String(raw || '').trim();
    const cm = one.match(/^(\S+@\S+)\s*[:|\s]\s*(.+)$/);
    if (cm) { creds.email = cm[1]; creds.password = cm[2]; creds.line1 = cm[1]; creds.line2 = cm[2]; }
    else { creds.line1 = one; creds.key = one; }
  }
  return creds;
}

function statusEmoji(s) {
  return s === 'delivered' ? '✅' : s === 'processing' ? '⚙️' : s === 'cancelled' ? '❌' : '⏳';
}

// ─── Command dispatch ─────────────────────────────────────────────────────────
async function handleAdminCommand(jid, text) {
  const parts = String(text || '').trim().split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase();
  const args = parts.slice(1).join(' ').trim();
  const db = await getDb();

  switch (cmd) {

    case '.help':
    case '.commands': {
      return send(jid, `🔧 *Admin Commands*

📋 *Orders*
• \`.orders\` — Last 10 orders
• \`.pending\` — Orders awaiting delivery
• \`.order ID\` — Order details
• \`.deliver ID\` — Deliver from stock
• \`.deliver ID <creds>\` — Deliver typed credentials
• \`.verify ID\` — Mark paid & deliver from stock

📦 *Stock & Revenue*
• \`.stock\` — Stock count per plan
• \`.revenue\` — Today + this month

• \`.help\` — This menu`);
    }

    // ── .orders ──────────────────────────────────────────
    case '.orders': {
      const orders = all(db, `
        SELECT o.id, o.amount_inr, o.status, o.created_at,
               p.platform, p.name AS plan_name, c.name AS cname
        FROM orders o
        LEFT JOIN plans p ON o.plan_id=p.id
        LEFT JOIN customers c ON o.customer_jid=c.jid
        ORDER BY o.created_at DESC LIMIT 10`);
      if (!orders.length) return send(jid, '📋 No orders yet.');
      const lines = ['📋 *Last 10 Orders*'];
      for (const o of orders) {
        lines.push(`${statusEmoji(o.status)} \`#${o.id}\` — ${o.platform || ''} ${o.plan_name || ''}\n   ₹${o.amount_inr} · ${o.status} · ${o.cname || o.customer_jid || ''}`);
      }
      return send(jid, lines.join('\n\n'));
    }

    // ── .pending ─────────────────────────────────────────
    case '.pending': {
      const orders = all(db, `
        SELECT o.id, o.amount_inr, o.status,
               p.platform, p.name AS plan_name, c.name AS cname
        FROM orders o
        LEFT JOIN plans p ON o.plan_id=p.id
        LEFT JOIN customers c ON o.customer_jid=c.jid
        WHERE o.status IN ('pending','processing')
        ORDER BY o.created_at ASC LIMIT 15`);
      if (!orders.length) return send(jid, '✅ No orders awaiting delivery.');
      const lines = [`⏳ *${orders.length} Order(s) Awaiting Delivery*`];
      for (const o of orders) {
        lines.push(`\`#${o.id}\` ${o.platform || ''} ${o.plan_name || ''} — ₹${o.amount_inr} · ${o.cname || ''}\n   → \`.deliver ${o.id}\``);
      }
      return send(jid, lines.join('\n\n'));
    }

    // ── .order ID ────────────────────────────────────────
    case '.order': {
      const idMatch = args.match(/\d+/);
      if (!idMatch) return send(jid, '❌ Usage: `.order ID`  (e.g. `.order 42`)');
      const id = parseInt(idMatch[0], 10);
      const o = get(db, `
        SELECT o.*, p.platform, p.name AS plan_name, c.name AS cname, c.email, c.phone
        FROM orders o
        LEFT JOIN plans p ON o.plan_id=p.id
        LEFT JOIN customers c ON o.customer_jid=c.jid
        WHERE o.id=?`, [id]);
      if (!o) return send(jid, `❌ Order \`#${id}\` not found.`);
      let credText = '';
      if (o.credentials && o.status === 'delivered') {
        try {
          const c = JSON.parse(o.credentials);
          credText = '\n\n🔐 *Credentials:*\n' + Object.entries(c)
            .filter(([k]) => !['line1', 'line2'].includes(k))
            .map(([k, v]) => `  ${k}: ${v}`).join('\n');
        } catch {}
      }
      return send(jid, `📦 *Order #${o.id}*
🛍️ ${o.platform || ''} — ${o.plan_name || ''}
👤 ${o.cname || ''} (${o.phone || (o.customer_jid || '').split('@')[0]})
✉️ ${o.email || 'N/A'}
💰 ₹${o.amount_inr}
📊 ${statusEmoji(o.status)} ${o.status}
📅 ${o.created_at}${o.delivered_at ? `\n📬 Delivered: ${o.delivered_at}` : ''}${credText}

${o.status === 'delivered' ? '' : `→ \`.deliver ${o.id}\` to deliver`}`);
    }

    // ── .deliver ID [inline creds] ───────────────────────
    case '.deliver': {
      const m = args.match(/^#?(\d+)\b([\s\S]*)$/);
      if (!m) return send(jid, '❌ Usage:\n• `.deliver ID` — from stock\n• `.deliver ID user@x.com:pass` — typed credentials');
      const id = parseInt(m[1], 10);
      const inline = (m[2] || '').trim();

      const order = get(db, `SELECT * FROM orders WHERE id=?`, [id]);
      if (!order) return send(jid, `❌ Order \`#${id}\` not found.`);
      if (order.status === 'delivered') return send(jid, `✅ Order \`#${id}\` already delivered.`);

      // Path A: typed credentials → manual delivery (no stock touched)
      if (inline) {
        const { deliverWithCredentials } = require('./delivery-worker');
        const creds = parseInlineCreds(inline);
        const ok = await deliverWithCredentials(db, order, creds, { note: 'Delivered by admin via WhatsApp', via: 'whatsapp_inline' });
        return send(jid, ok
          ? `✅ *Delivered* \`#${id}\` — credentials sent to the customer (WhatsApp + email).`
          : `⚠️ Order \`#${id}\` was already delivered.`);
      }

      // Path B: deliver from local stock
      await send(jid, `⏳ Delivering \`#${id}\` from stock…`);
      const { autoDeliverOrder } = require('./delivery-worker');
      const ok = await autoDeliverOrder(order, db, { silent: true });
      return send(jid, ok
        ? `✅ Order \`#${id}\` delivered from stock — customer notified.`
        : `❌ No stock for this plan.\n\nDeliver manually:\n\`.deliver ${id} <paste credentials>\``);
    }

    // ── .verify ID — mark paid & deliver from stock ──────
    // ott-store auto-verifies payment via IMAP, so `.verify` simply forces a
    // stock delivery for an order the admin has confirmed is paid.
    case '.verify': {
      const idMatch = args.match(/\d+/);
      if (!idMatch) return send(jid, '❌ Usage: `.verify ID`');
      const id = parseInt(idMatch[0], 10);
      const order = get(db, `SELECT * FROM orders WHERE id=?`, [id]);
      if (!order) return send(jid, `❌ Order \`#${id}\` not found.`);
      if (order.status === 'delivered') return send(jid, `✅ Order \`#${id}\` already delivered.`);
      if (order.status === 'cancelled') run(db, `UPDATE orders SET status='pending' WHERE id=?`, [id]);
      const { autoDeliverOrder } = require('./delivery-worker');
      const ok = await autoDeliverOrder(order, db, { silent: true });
      return send(jid, ok
        ? `✅ Verified & delivered \`#${id}\` from stock.`
        : `⚠️ Verified \`#${id}\` but no stock available.\nDeliver manually: \`.deliver ${id} <credentials>\``);
    }

    // ── .stock ───────────────────────────────────────────
    case '.stock': {
      const rows = all(db, `
        SELECT p.platform, p.name,
               SUM(CASE WHEN sc.status='available' THEN 1 ELSE 0 END) AS avail
        FROM plans p
        LEFT JOIN stock_credentials sc ON sc.plan_id=p.id
        WHERE p.active=1
        GROUP BY p.id
        HAVING avail IS NOT NULL
        ORDER BY avail ASC, p.platform ASC LIMIT 30`);
      if (!rows.length) return send(jid, '📦 No stock-backed plans found.');
      const lines = ['📦 *Stock Report*'];
      for (const r of rows) {
        const n = r.avail || 0;
        const e = n === 0 ? '🔴' : n <= 3 ? '🟡' : '🟢';
        lines.push(`${e} ${r.platform || ''} ${r.name || ''}: *${n}*`);
      }
      return send(jid, lines.join('\n'));
    }

    // ── .revenue ─────────────────────────────────────────
    case '.revenue': {
      const today = get(db, `SELECT COUNT(*) AS orders, COALESCE(SUM(amount_inr),0) AS inr
        FROM orders WHERE status='delivered' AND date(created_at)=date('now')`);
      const month = get(db, `SELECT COUNT(*) AS orders, COALESCE(SUM(amount_inr),0) AS inr
        FROM orders WHERE status='delivered' AND strftime('%Y-%m',created_at)=strftime('%Y-%m','now')`);
      return send(jid, `💰 *Revenue*

📅 *Today:*  ${today.orders} orders · ₹${(today.inr || 0).toFixed(2)}
📆 *This Month:*  ${month.orders} orders · ₹${(month.inr || 0).toFixed(2)}`);
    }

    default:
      return send(jid, `❓ Unknown command \`${cmd}\`. Send \`.help\` for the list.`);
  }
}

module.exports = { isOwnerJid, ownerNumbers, handleAdminCommand };
