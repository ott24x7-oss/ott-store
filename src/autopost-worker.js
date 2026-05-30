'use strict';
const nodemailer = require('nodemailer');
const { getDb, getSetting, all, get, run } = require('./db');

// Use email_accounts table (same as Email Marketing panel); fall back to mailer.js
async function getSmtpTransport(db) {
  const acc = get(db, `SELECT * FROM email_accounts WHERE active=1 ORDER BY id ASC LIMIT 1`);
  if (acc) {
    const t = nodemailer.createTransport({
      host: acc.host || 'smtp.gmail.com',
      port: acc.port || 587,
      secure: acc.secure === 1,
      auth: { user: acc.user, pass: acc.app_password },
      tls: { rejectUnauthorized: false },
    });
    return { transport: t, from: `"${acc.from_name || 'OTT Store'}" <${acc.user}>` };
  }
  // Fall back to config-based mailer if no account in DB
  const cfg = require('./config');
  if (!cfg.smtp?.host) return null;
  const { sendMail } = require('./mailer');
  return { sendMail }; // legacy path
}

async function sendViaBestAccount(db, { to, subject, html }) {
  const smtp = await getSmtpTransport(db);
  if (!smtp) return; // no SMTP configured anywhere — skip silently
  if (smtp.transport) {
    await smtp.transport.sendMail({ from: smtp.from, to, subject, html });
  } else {
    await smtp.sendMail({ to, subject, html });
  }
}

function istHour() {
  const d = new Date();
  return (d.getUTCHours() * 60 + d.getUTCMinutes() + 330) % 1440 / 60 | 0;
}

// Concurrency guard: if a tick is still running when the interval fires again
// (e.g. a slow Baileys send drags 6+ minutes), skip the new tick instead of
// piling up. Without this, the same campaign could re-send to thousands of
// customers because two ticks both pass the interval check before either
// updates last_sent_at.
let _autopostRunning = false;
async function runAutopostTick() {
  if (_autopostRunning) return;
  _autopostRunning = true;
  try {
    const enabled = await getSetting('autopost_enabled');
    if (enabled !== '1') return;

    const db = await getDb();
    const now = new Date();
    const hour = istHour();

    const campaigns = all(db, `SELECT * FROM autopost_campaigns WHERE schedule_enabled=1 AND active=1`);
    for (const c of campaigns) {
      // Check hours from settings (default 9–22 IST)
      const startH = parseInt(await getSetting('autopost_start_hour') || '9');
      const endH   = parseInt(await getSetting('autopost_end_hour')   || '22');
      if (hour < startH || hour > endH) continue;

      // Check interval. Guard against NTP clock-skew: if the wall clock jumps
      // backwards (after `last_sent_at` was written), delta would be negative
      // and < intervalMs, causing the campaign to re-send. We require BOTH a
      // non-negative delta AND a delta past the interval before firing.
      if (c.last_sent_at) {
        const lastMs = new Date(c.last_sent_at).getTime();
        const delta = now.getTime() - lastMs;
        const intervalMs = (c.interval_hours || 24) * 3600 * 1000;
        if (delta < 0 || delta < intervalMs) continue;
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

      const siteUrl = await getSetting('base_url') || '';
      for (const cust of customers) {
        try {
          await sendViaBestAccount(db, {
            to: cust.email,
            subject: subject.replace(/\{\{name\}\}/g, cust.name || 'Customer').replace(/\{\{site_name\}\}/g, siteName),
            html: buildEmailHtml(c, cust, siteName, siteUrl),
          });
          run(db, `INSERT INTO autopost_log (campaign_id,recipient,success) VALUES (?,?,1)`, [c.id, cust.email]);
          sent++;
        } catch (e) {
          run(db, `INSERT INTO autopost_log (campaign_id,recipient,success,error) VALUES (?,?,0,?)`, [c.id, cust.email, e.message]);
          failed++;
        }
        await new Promise(r => setTimeout(r, 200));
      }

      run(db, `UPDATE autopost_campaigns SET last_sent_at=datetime('now'), times_sent=times_sent+1 WHERE id=?`, [c.id]);
      run(db, `INSERT INTO audit_log (actor_kind,actor_label,action,target_kind,target_id,after_json) VALUES (?,?,?,?,?,?)`,
        ['system', 'autopost', 'campaign_sent', 'campaign', String(c.id), JSON.stringify({ sent, failed })]);
    }
  } catch {} finally { _autopostRunning = false; }
}

async function sendCampaignNow(campaignId) {
  const db = await getDb();
  const c = get(db, `SELECT * FROM autopost_campaigns WHERE id=?`, [campaignId]);
  if (!c) throw new Error('Campaign not found');

  const customers = all(db, `SELECT email, name FROM customers WHERE email IS NOT NULL AND email NOT LIKE '%@wa.local' AND email NOT LIKE '%@imported.local' AND blocked=0`);
  const siteName = await getSetting('site_name') || 'OTT Store';
  const siteUrl = await getSetting('base_url') || '';
  const subject = c.subject || c.title;
  let sent = 0, failed = 0;

  for (const cust of customers) {
    try {
      await sendViaBestAccount(db, {
        to: cust.email,
        subject: subject.replace(/\{\{name\}\}/g, cust.name || 'Customer').replace(/\{\{site_name\}\}/g, siteName),
        html: buildEmailHtml(c, cust, siteName, siteUrl),
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
  const siteUrl = await getSetting('base_url') || '';
  let sent = 0, failed = 0;

  for (const cust of customers) {
    try {
      const html = buildEmailHtml(
        { message, image_url: imageUrl },
        cust, siteName, siteUrl
      );
      await sendViaBestAccount(db, {
        to: cust.email,
        subject: subject.replace(/\{\{name\}\}/g, cust.name || 'Customer').replace(/\{\{site_name\}\}/g, siteName),
        html,
      });
      sent++;
    } catch { failed++; }
    await new Promise(r => setTimeout(r, 200));
  }
  return { sent, failed, total: customers.length };
}

// ─── Shared HTML builder ──────────────────────────────────────────────────────
function buildEmailHtml(c, cust, siteName, siteUrl) {
  const name = cust.name || 'Customer';
  const body = (c.message || '').replace(/\{\{name\}\}/g, name).replace(/\{\{site_name\}\}/g, siteName).replace(/\n/g, '<br>');
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:24px 0">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">
      <tr><td style="background:linear-gradient(135deg,#7c3aed,#4f46e5);padding:24px 32px">
        <h1 style="margin:0;color:#fff;font-size:22px">${siteName}</h1>
      </td></tr>
      ${c.image_url ? `<tr><td style="padding:0"><img src="${c.image_url}" alt="" style="width:100%;display:block"></td></tr>` : ''}
      <tr><td style="padding:28px 32px;color:#333;font-size:15px;line-height:1.7">
        <p style="margin:0 0 12px">Hi <strong>${name}</strong>,</p>
        <div>${body}</div>
        ${siteUrl ? `<p style="margin:20px 0 0"><a href="${siteUrl}" style="background:#7c3aed;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Shop Now →</a></p>` : ''}
      </td></tr>
      <tr><td style="background:#f9f9f9;padding:16px 32px;font-size:12px;color:#999;border-top:1px solid #eee">
        © ${new Date().getFullYear()} ${siteName}. You received this because you have an account with us.
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function startAutopostWorker() {
  setInterval(runAutopostTick, 5 * 60 * 1000); // check every 5 min
}

module.exports = { startAutopostWorker, sendCampaignNow, sendBroadcast };
