'use strict';
const { getDb, getSetting, all, get, run } = require('./db');
const { sendMail } = require('./mailer');

function istHour() {
  const d = new Date();
  return (d.getUTCHours() * 60 + d.getUTCMinutes() + 330) % 1440 / 60 | 0;
}

async function runAutopostTick() {
  try {
    const enabled = await getSetting('autopost_enabled');
    if (enabled !== '1') return;

    const db = await getDb();
    const now = new Date();
    const hour = istHour();

    const campaigns = all(db, `SELECT * FROM autopost_campaigns WHERE schedule_enabled=1 AND active=1`);
    for (const c of campaigns) {
      // Check hours (default 9–23)
      const start = 9, end = 23;
      if (hour < start || hour > end) continue;

      // Check interval
      if (c.last_sent_at) {
        const lastMs = new Date(c.last_sent_at).getTime();
        const intervalMs = (c.interval_hours || 24) * 3600 * 1000;
        if (now.getTime() - lastMs < intervalMs) continue;
      }

      // Get recipients
      let customers;
      if (c.target === 'active') {
        customers = all(db, `SELECT email, name FROM customers WHERE email IS NOT NULL AND email NOT LIKE '%@wa.local' AND email NOT LIKE '%@imported.local' AND blocked=0 AND id IN (SELECT DISTINCT customer_jid FROM orders WHERE created_at >= datetime('now','-30 days'))`);
      } else {
        customers = all(db, `SELECT email, name FROM customers WHERE email IS NOT NULL AND email NOT LIKE '%@wa.local' AND email NOT LIKE '%@imported.local' AND blocked=0`);
      }

      if (!customers.length) continue;

      const siteName = await getSetting('site_name') || 'OTT Store';
      const subject = c.subject || c.title;
      let sent = 0, failed = 0;

      for (const cust of customers) {
        try {
          await sendMail({
            to: cust.email,
            subject,
            html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
${c.image_url ? `<img src="${c.image_url}" style="width:100%;border-radius:8px;margin-bottom:16px">` : ''}
<p>Hi ${cust.name || 'there'},</p>
${c.message.replace(/\n/g, '<br>')}
<hr style="margin:16px 0;border:none;border-top:1px solid #eee">
<p style="color:#888;font-size:12px">You're receiving this from ${siteName}. <a href="#">Unsubscribe</a></p>
</div>`,
          });
          run(db, `INSERT INTO autopost_log (campaign_id,recipient,success) VALUES (?,?,1)`, [c.id, cust.email]);
          sent++;
        } catch (e) {
          run(db, `INSERT INTO autopost_log (campaign_id,recipient,success,error) VALUES (?,?,0,?)`, [c.id, cust.email, e.message]);
          failed++;
        }
        // Small delay to avoid SMTP rate limits
        await new Promise(r => setTimeout(r, 100));
      }

      run(db, `UPDATE autopost_campaigns SET last_sent_at=datetime('now'), times_sent=times_sent+1 WHERE id=?`, [c.id]);
      run(db, `INSERT INTO audit_log (actor_kind,actor_label,action,target_kind,target_id,after_json) VALUES (?,?,?,?,?,?)`,
        ['system', 'autopost', 'campaign_sent', 'campaign', String(c.id), JSON.stringify({ sent, failed })]);
    }
  } catch {}
}

async function sendCampaignNow(campaignId) {
  const db = await getDb();
  const c = get(db, `SELECT * FROM autopost_campaigns WHERE id=?`, [campaignId]);
  if (!c) throw new Error('Campaign not found');

  const customers = all(db, `SELECT email, name FROM customers WHERE email IS NOT NULL AND email NOT LIKE '%@wa.local' AND email NOT LIKE '%@imported.local' AND blocked=0`);
  const siteName = await getSetting('site_name') || 'OTT Store';
  const subject = c.subject || c.title;
  let sent = 0, failed = 0;

  for (const cust of customers) {
    try {
      await sendMail({
        to: cust.email,
        subject,
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
${c.image_url ? `<img src="${c.image_url}" style="width:100%;border-radius:8px;margin-bottom:16px">` : ''}
<p>Hi ${cust.name || 'there'},</p>
${c.message.replace(/\n/g, '<br>')}
<hr style="margin:16px 0;border:none;border-top:1px solid #eee">
<p style="color:#888;font-size:12px">You're receiving this from ${siteName}.</p>
</div>`,
      });
      run(db, `INSERT INTO autopost_log (campaign_id,recipient,success) VALUES (?,?,1)`, [c.id, cust.email]);
      sent++;
    } catch (e) {
      run(db, `INSERT INTO autopost_log (campaign_id,recipient,success,error) VALUES (?,?,0,?)`, [c.id, cust.email, e.message]);
      failed++;
    }
    await new Promise(r => setTimeout(r, 100));
  }

  run(db, `UPDATE autopost_campaigns SET last_sent_at=datetime('now'), times_sent=times_sent+1 WHERE id=?`, [c.id]);
  return { sent, failed, total: customers.length };
}

async function sendBroadcast({ subject, message, imageUrl, target = 'all' }) {
  const db = await getDb();
  let customers;
  if (target === 'active') {
    customers = all(db, `SELECT email, name FROM customers WHERE email IS NOT NULL AND email NOT LIKE '%@wa.local' AND blocked=0 AND jid IN (SELECT DISTINCT customer_jid FROM orders WHERE created_at >= datetime('now','-30 days'))`);
  } else {
    customers = all(db, `SELECT email, name FROM customers WHERE email IS NOT NULL AND email NOT LIKE '%@wa.local' AND blocked=0`);
  }
  const siteName = await getSetting('site_name') || 'OTT Store';
  let sent = 0, failed = 0;

  for (const cust of customers) {
    try {
      await sendMail({
        to: cust.email,
        subject,
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
${imageUrl ? `<img src="${imageUrl}" style="width:100%;border-radius:8px;margin-bottom:16px">` : ''}
<p>Hi ${cust.name || 'there'},</p>
${message.replace(/\n/g, '<br>')}
<hr style="margin:16px 0;border:none;border-top:1px solid #eee">
<p style="color:#888;font-size:12px">${siteName}</p>
</div>`,
      });
      sent++;
    } catch { failed++; }
    await new Promise(r => setTimeout(r, 100));
  }
  return { sent, failed, total: customers.length };
}

function startAutopostWorker() {
  setInterval(runAutopostTick, 5 * 60 * 1000); // every 5 min
}

module.exports = { startAutopostWorker, sendCampaignNow, sendBroadcast };
