'use strict';
require('dotenv').config();
const crypto = require('crypto');

// SESSION_SECRET signs every admin + customer JWT, so it MUST be a unique,
// persistent, 32+ char value set in the environment. If it is missing/weak we
// generate a RANDOM per-boot secret instead of falling back to a public hardcoded
// string — this prevents anyone from forging admin/customer sessions. Trade-off:
// a random per-boot secret invalidates existing logins on every restart, so set a
// stable SESSION_SECRET env var in production.
let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret || sessionSecret.length < 32 || sessionSecret === 'change-me-32-char-hex-secret-key') {
  sessionSecret = crypto.randomBytes(48).toString('hex');
  console.warn('[security] SESSION_SECRET is not set or too weak — using a random per-boot secret. Set a persistent SESSION_SECRET (>=32 chars) so sessions survive restarts.');
}

// Cookies are HOST-ONLY (set without a domain), so ott24x7.com and
// app.ott24x7.com each keep their own session — the apex flow is identical to
// before the subdomain split. `cookieDomain` below is computed ONLY so logout
// can also clear any leftover .ott24x7.com shared cookie from the brief window
// that domain-scoped cookies were enabled; it is NOT used when setting cookies.
let cookieDomain;
try {
  const h = new URL(process.env.BASE_URL || 'http://localhost:3000').hostname;
  if (h && h !== 'localhost' && h.includes('.') && !/\.railway\.app$/i.test(h) && !/^\d+(\.\d+){3}$/.test(h)) {
    cookieDomain = '.' + h.replace(/^www\./, '');
  }
} catch { /* leave host-only */ }

module.exports = {
  port: parseInt(process.env.PORT) || 3000,
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  sessionSecret,
  cookieDomain,
  // No insecure default. Admin login refuses unless ADMIN_PASSWORD is set or an
  // admin password hash has been configured in Settings.
  adminPassword: process.env.ADMIN_PASSWORD || '',
  jwtExpiry: '7d',
  adminJwtExpiry: '12h',
  bcryptRounds: 12,
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
  },
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'noreply@store.local',
  },
  cookieOptions: {
    httpOnly: true,
    sameSite: 'strict',
    // Secure cookies by default; only disabled for explicit local dev over http.
    secure: process.env.NODE_ENV !== 'development',
    path: '/',
  },
  uploadDir: require('path').join(__dirname, '..', 'data', 'uploads'),
  resellkeys: {
    apiUrl: process.env.RESELLKEYS_API_URL || 'https://www.resellkeys.com',
    apiKey: process.env.RESELLKEYS_API_KEY || '',
    email: process.env.RESELLKEYS_EMAIL || '',
    password: process.env.RESELLKEYS_PASSWORD || '',
  },
  // OTT24x7 Telegram-bot reseller API. When apiUrl + apiToken are set, the store
  // imports the bot's catalog (provider_api='bot') and auto-delivers those plans by
  // buying live from the bot at checkout. No hardcoded fallback — disabled if unset.
  bot: {
    apiUrl: (process.env.BOT_API_URL || '').replace(/\/+$/, ''),
    apiToken: process.env.BOT_API_TOKEN || '',
  },
  // Cross-origin WA-offer import token. No hardcoded fallback: the import endpoint
  // is disabled unless this env var is set to a secret value.
  waImportToken: process.env.WA_IMPORT_TOKEN || '',
};
