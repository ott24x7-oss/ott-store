'use strict';
const nodemailer = require('nodemailer');
const cfg = require('./config');
const { getSetting } = require('./db');

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

async function siteName() {
  try { return (await getSetting('site_name')) || 'OTT24x7'; } catch { return 'OTT24x7'; }
}

// Branded email shell — navy/blue→violet header (matches the storefront) + white
// body card. `inner` is the body HTML; the brand name appears in the header + footer.
function brandWrap(name, inner) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f0f5;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#f0f0f5"><tr><td align="center" style="padding:28px 12px">
<table width="500" cellpadding="0" cellspacing="0" style="max-width:500px;width:100%">
<tr><td style="background:linear-gradient(135deg,#2b6fff,#8d5cff);padding:22px 28px;border-radius:12px 12px 0 0;text-align:center">
  <strong style="color:#fff;font-size:22px;font-weight:800;letter-spacing:-0.5px">${name}</strong>
</td></tr>
<tr><td style="background:#fff;padding:30px 28px;border-radius:0 0 12px 12px;color:#374151;font-size:15px;line-height:1.6">
${inner}
<hr style="border:0;border-top:1px solid #eee;margin:22px 0 14px">
<p style="color:#9ca3af;font-size:12px;margin:0">${name} · This is an automated message.</p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

// Render a credentials object as a clean table (used by the delivery email).
function credsTable(credentials) {
  return `<table style="border-collapse:collapse;width:100%;background:#f6f8ff;border:1px solid #e3e9ff;border-radius:8px;margin:8px 0">
${Object.entries(credentials || {}).map(([k, v]) =>
    `<tr><td style="padding:8px 12px;font-weight:700;text-transform:capitalize;color:#475569;border-bottom:1px solid #eef2ff">${k}</td><td style="padding:8px 12px;font-family:'Courier New',monospace;color:#111827;border-bottom:1px solid #eef2ff;word-break:break-all">${v}</td></tr>`).join('')}
</table>`;
}

async function sendPasswordReset(email, name, resetUrl) {
  const n = await siteName();
  await sendMail({
    to: email,
    subject: `Reset your ${n} password`,
    html: brandWrap(n, `<h2 style="color:#111827;font-size:19px;margin:0 0 8px">Reset your password</h2>
<p style="margin:0 0 18px">Hi ${name || 'there'}, click below to set a new password. This link expires in <strong>30 minutes</strong>.</p>
<p style="text-align:center;margin:0 0 18px"><a href="${resetUrl}" style="display:inline-block;background:linear-gradient(135deg,#2b6fff,#8d5cff);color:#fff;padding:13px 34px;border-radius:10px;font-weight:700;text-decoration:none">Reset password →</a></p>
<p style="color:#9ca3af;font-size:12px;margin:0">If you didn't request this, you can safely ignore this email.</p>`),
  });
}

async function sendOrderDelivery(email, name, order, credentials) {
  const n = await siteName();
  await sendMail({
    to: email,
    subject: `Your ${order.platform || ''} ${order.plan_name || 'order'} is ready! — ${n}`,
    html: brandWrap(n, `<h2 style="color:#111827;font-size:19px;margin:0 0 8px">✅ Your order is ready!</h2>
<p style="margin:0 0 6px">Hi ${name || 'there'}, your <strong>${order.platform || ''} ${order.plan_name || ''}</strong> details are below:</p>
${credsTable(credentials)}
${order.expires_at ? `<p style="margin:6px 0 0;color:#475569;font-size:14px">Valid until: <strong>${new Date(order.expires_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</strong></p>` : ''}
<p style="color:#9ca3af;font-size:12px;margin:14px 0 0">Keep these safe and do not share them. Thank you for your order!</p>`),
  });
}

async function sendOtpEmail(email, otp, name) {
  const n = name || await siteName();
  await sendMail({
    to: email,
    subject: `${otp} — Your ${n} Login Code`,
    html: brandWrap(n, `<div style="text-align:center">
  <div style="font-size:15px;color:#6b7280;margin-bottom:8px">Your one-time login code</div>
  <div style="background:#eef3ff;border:2px solid #dbe6ff;border-radius:12px;padding:18px 30px;display:inline-block;margin:12px 0 20px">
    <span style="font-size:38px;font-weight:900;letter-spacing:10px;color:#2b6fff;font-family:'Courier New',monospace">${otp}</span>
  </div>
  <p style="color:#6b7280;font-size:14px;margin:0">Valid for <strong>10 minutes</strong>. Do not share with anyone.</p>
</div>`),
  });
}

async function sendMagicLinkEmail(email, name, magicUrl, site) {
  const n = site || await siteName();
  await sendMail({
    to: email,
    subject: `Login to ${n} — Your magic link`,
    html: brandWrap(n, `<div style="text-align:center">
  <h2 style="color:#111827;font-size:20px;margin:0 0 8px">Hi${name ? ' ' + name : ''}! 👋</h2>
  <p style="color:#6b7280;font-size:14px;margin:0 0 22px">Click below to log in to <strong>${n}</strong>. This link works once and expires in 15 minutes.</p>
  <a href="${magicUrl}" style="display:inline-block;background:linear-gradient(135deg,#2b6fff,#8d5cff);color:#fff;padding:14px 36px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none;margin:0 0 22px">Login to ${n} →</a>
  <p style="color:#9ca3af;font-size:12px;margin:0">Or copy this link:<br><span style="color:#2b6fff;word-break:break-all;font-size:11px">${magicUrl}</span></p>
</div>`),
  });
}

module.exports = { sendMail, sendPasswordReset, sendOrderDelivery, sendOtpEmail, sendMagicLinkEmail, brandWrap };
