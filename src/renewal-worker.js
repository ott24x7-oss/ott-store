'use strict';
const { getDb, getSetting, all, run, get } = require('./db');
const { sendMail } = require('./mailer');

async function runRenewalTick() {
  try {
    const db = await getDb();
    const days = parseInt(await getSetting('renewal_reminder_days') || '3');
    const siteName = await getSetting('site_name') || 'OTT Store';
    const baseUrl = await getSetting('base_url') || 'http://localhost:3000';

    // Find delivered orders expiring within `days` days that haven't been reminded yet
    const expiring = all(db, `
      SELECT o.*, p.name as plan_name, p.platform, c.email, c.name as cust_name
      FROM orders o
      LEFT JOIN plans p ON o.plan_id = p.id
      LEFT JOIN customers c ON o.customer_jid = c.jid
      WHERE o.status = 'delivered'
        AND o.expires_at IS NOT NULL
        AND o.expires_at > datetime('now')
        AND o.expires_at <= datetime('now', '+' || ? || ' days')
        AND (o.renewal_reminded_at IS NULL)
        AND c.email IS NOT NULL
        AND c.email NOT LIKE '%@wa.local'
        AND c.email NOT LIKE '%@imported.local'
    `, [days]);

    for (const o of expiring) {
      try {
        const expiresDate = new Date(o.expires_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
        await sendMail({
          to: o.email,
          subject: `Your ${o.platform} subscription expires soon!`,
          html: `<p>Hi ${o.cust_name},</p>
<p>Your <strong>${o.plan_name}</strong> subscription expires on <strong>${expiresDate}</strong>.</p>
<p>Renew now to avoid interruption:</p>
<p><a href="${baseUrl}/my" style="background:#6366f1;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block">Renew Now →</a></p>
<p style="color:#888;font-size:12px">${siteName}</p>`,
        });
        run(db, `UPDATE orders SET renewal_reminded_at=datetime('now') WHERE id=?`, [o.id]);
      } catch {}
    }
  } catch {}
}

function startRenewalWorker() {
  setInterval(runRenewalTick, 60 * 60 * 1000); // every hour
  runRenewalTick();
}

module.exports = { startRenewalWorker };
