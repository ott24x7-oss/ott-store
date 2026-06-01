'use strict';
/**
 * AI Order Management — WhatsApp concierge for customers + natural-language order
 * ops for the admin. Built on the existing api_channels AI engine (ai.chat).
 *
 * Design: CONTEXT-INJECTION + ACTION TAGS. We feed the model the REAL order rows
 * (so it never invents status/credentials) plus an admin-editable "Order Playbook",
 * and it answers in the customer's language (English / Hindi / Hinglish). When it
 * wants to act, it emits a tag on its own line which the code parses and executes,
 * then strips before sending:
 *
 *   Customer:  [DELIVER:<id>]  [RESEND:<id>]  [ESCALATE:<id>:<reason>]
 *   Admin:     [DELIVER:<id>]  [ORDER:<id>]
 *
 * SECURITY: a customer can only ever act on an order whose customer_jid matches
 * the sender — enforced in code, not trusted from the model.
 */
const { getDb, getSetting, get, all, run } = require('./db');

function jidPhone(jid) { return String(jid || '').split('@')[0].replace(/\D/g, ''); }

// ─── Customer order context ───────────────────────────────────────────────────
function getCustomerOrders(db, jid) {
  return all(db, `
    SELECT o.id, o.status, o.amount_inr, o.created_at, o.delivered_at, o.credentials, o.delivery_note,
           p.platform, p.name AS plan_name, p.delivery_time_est,
           (SELECT COUNT(*) FROM stock_credentials sc WHERE sc.plan_id=o.plan_id AND sc.status='available') AS stock_avail
    FROM orders o LEFT JOIN plans p ON o.plan_id=p.id
    WHERE o.customer_jid=? ORDER BY o.created_at DESC LIMIT 8`, [jid]);
}

function formatOrdersForPrompt(orders) {
  if (!orders.length) return '(no orders on this number yet)';
  return orders.map(o => {
    let s = `• Order #${o.id}: ${o.platform || ''} ${o.plan_name || ''} — ₹${o.amount_inr} — status: ${o.status}`;
    if (o.status === 'delivered') s += ' (DELIVERED; credentials on file — can RESEND)';
    else if (o.status === 'cancelled') s += ' (cancelled/refunded)';
    else if (o.stock_avail > 0) s += ' (IN STOCK — you can DELIVER it now)';
    else s += ' (no stock — must ESCALATE to admin)';
    if (o.delivery_time_est) s += ` [promised ETA: ${o.delivery_time_est}]`;
    return s;
  }).join('\n');
}

function customerInstructions(playbook) {
  return `
─────────────── ORDER CONCIERGE MODE ───────────────
Besides answering about plans/prices, you are this customer's ORDER & DELIVERY assistant.
Use ONLY the order facts listed below in "THIS CUSTOMER'S ORDERS". NEVER invent an order,
status, or credential. If they ask about an order not listed, say you can't find it on this
number and offer to escalate.

LANGUAGE: detect the customer's language from their message. If they write in Hindi or
Hinglish (Roman Hindi like "mera order kab aayega"), reply in natural friendly Hinglish.
If they write English, reply in English. Mirror their tone. Keep replies short (2–4 lines).

ACTIONS — put the tag on its OWN line; it is removed before sending and triggers the action:
• Pending order marked "IN STOCK — you can DELIVER it now"  → emit  [DELIVER:<id>]   then tell them it's being sent now.
• Customer wants a DELIVERED order's credentials again        → emit  [RESEND:<id>]    then say you've re-sent them.
• A problem you can't fix (no stock, broken/expired creds, wrong account, refund, complaint, account ban)
                                                              → emit  [ESCALATE:<id>:<short reason>]  then say the team has been notified and will sort it fast.
Only ONE primary action per reply. Never claim something was delivered unless you emitted the tag.
${playbook ? `\nSTORE ORDER POLICY (follow strictly):\n${playbook}` : ''}`;
}

// ─── Admin order context ──────────────────────────────────────────────────────
function getAdminPending(db) {
  return all(db, `
    SELECT o.id, o.amount_inr, o.status, p.platform, p.name AS plan_name, c.name AS cname,
           (SELECT COUNT(*) FROM stock_credentials sc WHERE sc.plan_id=o.plan_id AND sc.status='available') AS stock
    FROM orders o LEFT JOIN plans p ON o.plan_id=p.id LEFT JOIN customers c ON o.customer_jid=c.jid
    WHERE o.status IN ('pending','processing') ORDER BY o.created_at ASC LIMIT 25`);
}

function formatPendingForAdmin(rows) {
  if (!rows.length) return '(no pending orders right now)';
  return rows.map(o => `• #${o.id} ${o.platform || ''} ${o.plan_name || ''} — ₹${o.amount_inr} — ${o.cname || ''} — stock:${o.stock}`).join('\n');
}

function adminInstructions(playbook) {
  return `You are the store OWNER's order-operations assistant on WhatsApp. Help them manage
order deliveries quickly. Reply in the owner's language (English / Hinglish), short and direct.

The owner's CURRENT PENDING ORDERS are listed below. You can:
• Deliver a pending order from stock  → emit  [DELIVER:<id>]   (the owner's request is the confirmation)
• Show one order's full details        → emit  [ORDER:<id>]
For anything else (revenue, stock counts, customers) tell them the matching dot-command: .stock .revenue .orders .pending .order ID.
${playbook ? `\nSTORE ORDER POLICY:\n${playbook}` : ''}`;
}

// ─── Notifications ────────────────────────────────────────────────────────────
async function notifyAdmin(db, message) {
  try {
    const owner = get(db, `SELECT value FROM settings WHERE key='wa_owner_number'`)?.value
      || get(db, `SELECT value FROM settings WHERE key='support_whatsapp'`)?.value || '';
    const phone = String(owner).replace(/\D/g, '');
    if (phone) { const { sendToPhone } = require('./wa-bot'); await sendToPhone(phone, message); }
  } catch {}
  try {
    const email = (await getSetting('order_notify_email')) || (await getSetting('stock_alert_email')) || (await getSetting('support_email'));
    if (email) {
      const { sendMail } = require('./mailer');
      sendMail({ to: email, subject: '🆘 Customer order issue (AI escalation)', html: `<pre style="font-family:inherit">${String(message).replace(/[<>]/g, '')}</pre>` }).catch(() => {});
    }
  } catch {}
}

async function resendCredsToCustomer(db, order, jid) {
  let creds = {};
  try { creds = order.credentials ? (typeof order.credentials === 'string' ? JSON.parse(order.credentials) : order.credentials) : {}; } catch {}
  const lines = Object.entries(creds).filter(([k]) => !['line1', 'line2'].includes(k))
    .map(([k, v]) => `  *${k.charAt(0).toUpperCase() + k.slice(1)}:* ${v}`).join('\n')
    || Object.values(creds).join(' / ');
  const plan = get(db, `SELECT platform, name FROM plans WHERE id=?`, [order.plan_id]);
  const msg = `✅ *Your Credentials — Order #${order.id}*\n📦 ${plan?.platform || ''} ${plan?.name || ''}\n\n🔑\n${lines || '(none on file)'}\n\n_Keep safe. Do not share._`;
  const { sendToPhone } = require('./wa-bot');
  await sendToPhone(jidPhone(jid), msg).catch(() => {});
}

// ─── Action parsing/execution ─────────────────────────────────────────────────
function stripTags(s) { return String(s || '').replace(/\[(DELIVER|RESEND|ESCALATE|ORDER):[^\]]*\]/gi, '').replace(/\n{3,}/g, '\n\n').trim(); }

async function processCustomerActions(db, jid, raw) {
  const acts = [];
  for (const m of raw.matchAll(/\[DELIVER:#?(\d+)\]/gi)) acts.push({ t: 'deliver', id: +m[1] });
  for (const m of raw.matchAll(/\[RESEND:#?(\d+)\]/gi)) acts.push({ t: 'resend', id: +m[1] });
  for (const m of raw.matchAll(/\[ESCALATE:#?(\d+):?([^\]]*)\]/gi)) acts.push({ t: 'escalate', id: +m[1], reason: (m[2] || '').trim() });

  for (const a of acts) {
    // SECURITY: only this customer's order.
    const order = get(db, `SELECT * FROM orders WHERE id=? AND customer_jid=?`, [a.id, jid]);
    if (!order) continue;
    if (a.t === 'deliver' && order.status !== 'delivered') {
      const { autoDeliverOrder } = require('./delivery-worker');
      const ok = await autoDeliverOrder(order, db).catch(() => false);
      if (!ok) await notifyAdmin(db, `🆘 *Order #${order.id}* — customer asked to deliver but NO STOCK. Customer: ${jidPhone(jid)}. Deliver manually: .deliver ${order.id} <creds>`);
    } else if (a.t === 'resend' && order.status === 'delivered') {
      await resendCredsToCustomer(db, order, jid);
    } else if (a.t === 'escalate') {
      await notifyAdmin(db, `🆘 *Customer Order Issue*\nOrder: #${order.id}\nCustomer: ${jidPhone(jid)}\nReason: ${a.reason || 'unspecified'}\n\nReply: .order ${order.id} · .deliver ${order.id} <creds>`);
    }
  }
  return stripTags(raw);
}

async function processAdminActions(db, jid, raw) {
  let extra = '';
  for (const m of raw.matchAll(/\[DELIVER:#?(\d+)\]/gi)) {
    const order = get(db, `SELECT * FROM orders WHERE id=?`, [+m[1]]);
    if (!order) { extra += `\n❌ Order #${m[1]} not found.`; continue; }
    if (order.status === 'delivered') { extra += `\n✅ #${order.id} already delivered.`; continue; }
    const { autoDeliverOrder } = require('./delivery-worker');
    const ok = await autoDeliverOrder(order, db).catch(() => false);
    extra += ok ? `\n✅ Delivered #${order.id} from stock — customer notified.` : `\n❌ No stock for #${order.id}. Use: .deliver ${order.id} <creds>`;
  }
  for (const m of raw.matchAll(/\[ORDER:#?(\d+)\]/gi)) {
    const o = get(db, `SELECT o.*, p.platform, p.name AS plan_name, c.name AS cname, c.email, c.phone
      FROM orders o LEFT JOIN plans p ON o.plan_id=p.id LEFT JOIN customers c ON o.customer_jid=c.jid WHERE o.id=?`, [+m[1]]);
    extra += o ? `\n📦 #${o.id} ${o.platform || ''} ${o.plan_name || ''} · ₹${o.amount_inr} · ${o.status} · ${o.cname || ''} ${o.phone || ''}` : `\n❌ Order #${m[1]} not found.`;
  }
  return (stripTags(raw) + extra).trim();
}

// ─── Public turn handlers (called from wa-bot) ────────────────────────────────
async function runCustomerTurn(db, jid, messages) {
  const { chat, buildStoreSystemPrompt } = require('./ai');
  const base = await buildStoreSystemPrompt(db);
  const playbook = get(db, `SELECT value FROM settings WHERE key='ai_order_playbook'`)?.value || '';
  const orders = getCustomerOrders(db, jid);
  let sys = base + '\n' + customerInstructions(playbook) + `\n\nTHIS CUSTOMER'S ORDERS:\n${formatOrdersForPrompt(orders)}`;
  sys = sys.replace(/- Add action buttons at end.*\[BUTTONS.*\]\(max 4\)/, '- Do NOT use [BUTTONS:] — this is WhatsApp.');
  const raw = await chat(messages, { max_tokens: 350, _systemOverride: sys });
  const reply = await processCustomerActions(db, jid, raw.replace(/\[BUTTONS:[^\]]*\]/gi, ''));
  return reply || 'Got it 👍';
}

async function runAdminTurn(db, jid, messages) {
  const { chat } = require('./ai');
  const playbook = get(db, `SELECT value FROM settings WHERE key='ai_order_playbook'`)?.value || '';
  const sys = adminInstructions(playbook) + `\n\nCURRENT PENDING ORDERS:\n${formatPendingForAdmin(getAdminPending(db))}`;
  const raw = await chat(messages, { max_tokens: 350, _systemOverride: sys });
  const reply = await processAdminActions(db, jid, raw);
  return reply || 'Done 👍';
}

module.exports = { runCustomerTurn, runAdminTurn, getCustomerOrders };
