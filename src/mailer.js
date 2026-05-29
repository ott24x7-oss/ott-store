'use strict';
const nodemailer = require('nodemailer');
const cfg = require('./config');

let _transport = null;
function getTransport() {
  if (_transport) return _transport;
  if (!cfg.smtp.host) return null;
  _transport = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.port === 465,
    auth: { user: cfg.smtp.user, pass: cfg.smtp.pass },
  });
  return _transport;
}

async function sendMail({ to, subject, html }) {
  const t = getTransport();
  if (!t) return;
  await t.sendMail({ from: cfg.smtp.from, to, subject, html });
}

async function sendPasswordReset(email, name, resetUrl) {
  await sendMail({
    to: email,
    subject: 'Reset your OTT Store password',
    html: `<p>Hi ${name},</p>
<p>Click below to reset your password (link expires in 30 minutes):</p>
<p><a href="${resetUrl}">${resetUrl}</a></p>
<p>If you did not request this, ignore this email.</p>`,
  });
}

async function sendOrderDelivery(email, name, order, credentials) {
  await sendMail({
    to: email,
    subject: `Your ${order.platform} subscription is ready!`,
    html: `<p>Hi ${name},</p>
<p>Your <strong>${order.plan_name}</strong> subscription credentials are below:</p>
<pre style="background:#f5f5f5;padding:12px;border-radius:6px;">${JSON.stringify(credentials, null, 2)}</pre>
<p>Expires: ${order.expires_at || 'N/A'}</p>
<p>Thank you for shopping with us!</p>`,
  });
}

module.exports = { sendMail, sendPasswordReset, sendOrderDelivery };
