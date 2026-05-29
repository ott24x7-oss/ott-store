'use strict';
const nodemailer = require('nodemailer');
const { getDb, getSetting, all, get, run } = require('./db');

async function getTransporter(db, accountId) {
  const account = accountId
    ? get(db, 'SELECT * FROM email_accounts WHERE id=? AND active=1', [accountId])
    : get(db, 'SELECT * FROM email_accounts WHERE active=1 ORDER BY id ASC LIMIT 1');
  if (!account) return null;
  const transport = nodemailer.createTransport({
    host: account.host || 'smtp.gmail.com',
    port: account.port || 587,
    secure: account.secure === 1,
    auth: { user: account.user, pass: account.app_password },
    tls: { rejectUnauthorized: false },
  });
  return { transport, fromName: account.from_name || 'OTT Store', fromEmail: account.user };
}

async function testAccount(accountId) {
  const db = await getDb();
  const t = await getTransporter(db, accountId);
  if (!t) throw new Error('Account not found');
  await t.transport.verify();
  return { ok: true, email: t.fromEmail };
}

async function sendCampaignEmail(campaignId) {
  const db = await getDb();
  const campaign = get(db, 'SELECT * FROM email_campaigns WHERE id=?', [campaignId]);
  if (!campaign) throw new Error('Campaign not found');

  let recipients = [];
  if (campaign.target === 'all') {
    recipients = all(db, `SELECT DISTINCT email, name FROM customers WHERE email IS NOT NULL AND email LIKE '%@%' AND email != ''`);
  } else if (campaign.target === 'recent7') {
    recipients = all(db, `SELECT DISTINCT c.email, c.name FROM customers c INNER JOIN orders o ON o.customer_jid=c.jid WHERE c.email IS NOT NULL AND c.email LIKE '%@%' AND o.created_at >= datetime('now','-7 days')`);
  } else if (campaign.target === 'recent30') {
    recipients = all(db, `SELECT DISTINCT c.email, c.name FROM customers c INNER JOIN orders o ON o.customer_jid=c.jid WHERE c.email IS NOT NULL AND c.email LIKE '%@%' AND o.created_at >= datetime('now','-30 days')`);
  } else if (campaign.target === 'custom') {
    const lines = (campaign.custom_emails || '').split(/[\n,;]+/).map(e => e.trim()).filter(e => e.includes('@'));
    recipients = lines.map(email => ({ email, name: '' }));
  }

  if (!recipients.length) throw new Error('No valid recipients found');

  run(db, `UPDATE email_campaigns SET status='sending', total_recipients=?, sent_count=0, failed_count=0 WHERE id=?`,
    [recipients.length, campaignId]);

  const t = await getTransporter(db, campaign.account_id);
  if (!t) throw new Error('No active email account configured — add one in Email Marketing → Accounts');

  const siteName = (await getSetting('site_name')) || 'OTT Store';
  const siteUrl = (await getSetting('base_url')) || '';
  let sent = 0, failed = 0;

  for (const r of recipients) {
    try {
      const html = (campaign.html || '')
        .replace(/\{\{name\}\}/g, r.name || 'Customer')
        .replace(/\{\{email\}\}/g, r.email || '')
        .replace(/\{\{site_name\}\}/g, siteName)
        .replace(/\{\{site_url\}\}/g, siteUrl);

      await t.transport.sendMail({
        from: `"${t.fromName}" <${t.fromEmail}>`,
        to: r.email,
        subject: (campaign.subject || '').replace(/\{\{name\}\}/g, r.name || 'Customer').replace(/\{\{site_name\}\}/g, siteName),
        html,
      });
      sent++;
      run(db, 'UPDATE email_campaigns SET sent_count=? WHERE id=?', [sent, campaignId]);
      await new Promise(res => setTimeout(res, 300));
    } catch {
      failed++;
      run(db, 'UPDATE email_campaigns SET failed_count=? WHERE id=?', [failed, campaignId]);
    }
  }

  run(db, `UPDATE email_campaigns SET status='sent', sent_at=datetime('now') WHERE id=?`, [campaignId]);
  return { sent, failed, total: recipients.length };
}

module.exports = { testAccount, sendCampaignEmail };
