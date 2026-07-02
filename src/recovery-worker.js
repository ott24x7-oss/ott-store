'use strict';
// Abandoned-payment recovery: ~45 min after an unpaid UPI checkout, email the
// customer ONCE with a link to finish paying the SAME unique amount. Works for
// guests (tokenised /pay/<token> page) and logged-in customers (/my dashboard).
// The link is valid for 24h (after which the top-up is auto-expired).
const { getDb, getSetting, all, run, get } = require('./db');
const { sendMail } = require('./mailer');

async function runRecoveryTick() {
  try {
    const db = await getDb();
    if ((await getSetting('imap_enabled')) !== '1') return; // only when UPI auto-verify is on
    const siteName = (await getSetting('site_name')) || 'OTT Store';
    const base = ((await getSetting('base_url')) || 'http://localhost:3000').replace(/\/$/, '');

    // Unpaid UPI order top-ups: abandoned for 45+ min, still inside the 24h window,
    // not yet reminded, customer reachable by a real email.
    const rows = all(db, `SELECT t.id, t.unique_amount, t.guest_token, t.plan_id,
        p.name AS plan_name, p.platform, c.email, c.name AS cust_name
      FROM topups t
      LEFT JOIN plans p ON p.id = t.plan_id
      LEFT JOIN customers c ON c.jid = t.customer_jid
      WHERE t.purpose='order' AND t.status='pending' AND t.method='upi_imap'
        AND t.recovery_reminded_at IS NULL
        AND t.created_at <= datetime('now','-45 minutes')
        AND t.created_at >  datetime('now','-24 hours')
        AND c.email IS NOT NULL AND TRIM(c.email) != ''
        AND c.email NOT LIKE '%@wa.local' AND c.email NOT LIKE '%@imported.local'`);

    for (const t of rows) {
      try {
        // Re-check live status — the IMAP worker may have matched (paid) this since
        // the SELECT; never dun a customer who already paid. Claim it (stamp) BEFORE
        // sending so a failing SMTP can't re-email it every tick.
        const fresh = get(db, `SELECT status, order_id, recovery_reminded_at FROM topups WHERE id=?`, [t.id]);
        if (!fresh || fresh.status !== 'pending' || fresh.order_id || fresh.recovery_reminded_at) continue;
        run(db, `UPDATE topups SET recovery_reminded_at = datetime('now') WHERE id=?`, [t.id]);
        const amt = t.unique_amount;
        const link = t.guest_token ? `${base}/pay/${t.guest_token}` : `${base}/my`;
        await sendMail({
          to: t.email,
          subject: `Finish your ${siteName} order — pay ₹${amt}`,
          html: `<p>Hi ${t.cust_name || 'there'},</p>
<p>Your order for <strong>${(t.platform || '')} ${(t.plan_name || '')}</strong> is waiting — it just needs payment.</p>
<p style="font-size:18px">Pay exactly <strong>₹${amt}</strong> <span style="color:#888">(this exact amount — please don't round it off)</span></p>
<p><a href="${link}" style="background:linear-gradient(135deg,#2b6fff,#8d5cff);color:#fff;padding:11px 22px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:700">Complete payment →</a></p>
<p style="color:#888;font-size:12px">This link is valid for 24 hours. Your subscription is delivered to this email automatically the moment payment is confirmed.</p>
<p style="color:#888;font-size:12px">${siteName}</p>`,
        });
      } catch {}
    }
  } catch {}
}

function startRecoveryWorker() {
  setInterval(runRecoveryTick, 10 * 60 * 1000); // every 10 min
  setTimeout(runRecoveryTick, 30 * 1000);        // first sweep shortly after boot
}

module.exports = { startRecoveryWorker, runRecoveryTick };
