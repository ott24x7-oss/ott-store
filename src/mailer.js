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
    // Bound every SMTP phase so a hung/slow server can't make an OTP/magic
    // request wait the full default (≈10 min). With timeouts the request
    // surfaces a 502 within ~8s and the customer can pick another method.
    connectionTimeout: 5000,
    greetingTimeout:   5000,
    socketTimeout:     8000,
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

async function sendOtpEmail(email, otp, siteName) {
  const n = siteName || 'OTT Store';
  await sendMail({
    to: email,
    subject: `${otp} — Your ${n} Login Code`,
    html: `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f0f5;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#f0f0f5"><tr><td align="center" style="padding:28px 12px">
<table width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%">
<tr><td style="background:linear-gradient(135deg,#7c3aed,#a855f7);padding:22px 28px;border-radius:12px 12px 0 0;text-align:center">
  <strong style="color:#fff;font-size:22px;font-weight:800;letter-spacing:-0.5px">${n}</strong>
</td></tr>
<tr><td style="background:#fff;padding:36px 28px;border-radius:0 0 12px 12px;text-align:center">
  <div style="font-size:15px;color:#6b7280;margin-bottom:8px">Your one-time login code</div>
  <div style="background:#f5f3ff;border:2px solid #ede9fe;border-radius:12px;padding:20px 32px;display:inline-block;margin:16px 0 24px">
    <span style="font-size:40px;font-weight:900;letter-spacing:10px;color:#7c3aed;font-family:'Courier New',monospace">${otp}</span>
  </div>
  <p style="color:#6b7280;font-size:14px;margin:0 0 8px">Valid for <strong>10 minutes</strong>. Do not share with anyone.</p>
  <hr style="border:0;border-top:1px solid #f0f0f0;margin:20px 0">
  <p style="color:#9ca3af;font-size:12px;margin:0">If you didn't request this, you can safely ignore this email.</p>
</td></tr>
</table>
</td></tr></table>
</body></html>`,
  });
}

async function sendMagicLinkEmail(email, name, magicUrl, siteName) {
  const n = siteName || 'OTT Store';
  await sendMail({
    to: email,
    subject: `Login to ${n} — Your magic link`,
    html: `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f0f5;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#f0f0f5"><tr><td align="center" style="padding:28px 12px">
<table width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%">
<tr><td style="background:linear-gradient(135deg,#7c3aed,#a855f7);padding:22px 28px;border-radius:12px 12px 0 0;text-align:center">
  <strong style="color:#fff;font-size:22px;font-weight:800;letter-spacing:-0.5px">${n}</strong>
</td></tr>
<tr><td style="background:#fff;padding:36px 28px;border-radius:0 0 12px 12px;text-align:center">
  <h2 style="color:#111827;font-size:20px;margin:0 0 8px">Hi${name ? ' ' + name : ''}! 👋</h2>
  <p style="color:#6b7280;font-size:14px;margin:0 0 24px">Click the button below to log in to <strong>${n}</strong>. This link works once and expires in 15 minutes.</p>
  <a href="${magicUrl}" style="display:inline-block;background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;padding:14px 36px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none;margin:0 0 24px;box-shadow:0 4px 14px rgba(124,58,237,.4)">Login to ${n} →</a>
  <p style="color:#9ca3af;font-size:12px;margin:0">Or copy this link: <br><span style="color:#7c3aed;word-break:break-all;font-size:11px">${magicUrl}</span></p>
  <hr style="border:0;border-top:1px solid #f0f0f0;margin:20px 0">
  <p style="color:#9ca3af;font-size:12px;margin:0">If you didn't request this, ignore this email.</p>
</td></tr>
</table>
</td></tr></table>
</body></html>`,
  });
}

module.exports = { sendMail, sendPasswordReset, sendOrderDelivery, sendOtpEmail, sendMagicLinkEmail };
