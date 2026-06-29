'use strict';
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const cfg = require('./config');

// ─── CSRF (double-submit cookie pattern) ──────────────────────────────────────
// On every request we make sure the visitor has a csrfToken cookie. The cookie
// is intentionally NOT HttpOnly so the admin SPA's JS can read it and echo the
// value back in a custom X-CSRF-Token header. requireCsrf then enforces that
// the cookie and header match — a cross-site attacker has no way to read the
// cookie (SameSite=strict) so they can't forge the header.
function ensureCsrfToken(req, res, next) {
  if (!req.cookies?.csrfToken) {
    const token = crypto.randomBytes(32).toString('hex');
    res.cookie('csrfToken', token, {
      path: '/',
      sameSite: 'strict',
      secure: !!cfg.cookieOptions?.secure,
      maxAge: 12 * 60 * 60 * 1000,
      // NOT httpOnly — the admin SPA must read it
    });
    // Mirror onto the request so the very first response can use it too.
    if (!req.cookies) req.cookies = {};
    req.cookies.csrfToken = token;
  }
  next();
}

// State-changing requests must echo the csrf cookie back as a header. Skipped
// for safe methods (GET/HEAD/OPTIONS) which don't change state.
function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const cookie = req.cookies?.csrfToken;
  const header = req.headers['x-csrf-token'];
  if (!cookie || !header || cookie !== header) {
    return res.status(403).json({ error: 'CSRF token invalid. Reload the admin panel and try again.' });
  }
  next();
}

// Per-IP rate limits
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  message: { error: 'Too many login attempts. Try again in a minute.' },
  standardHeaders: true, legacyHeaders: false,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many requests. Try again later.' },
  standardHeaders: true, legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Rate limit exceeded.' },
  standardHeaders: true, legacyHeaders: false,
});

// Per-email credential throttle
const _failMap = new Map(); // email -> { count, lockedUntil }
const FAIL_LIMIT = 7;
const LOCK_MS = 15 * 60 * 1000;

function checkCredentialThrottle(email) {
  const now = Date.now();
  const entry = _failMap.get(email);
  if (!entry) return null;
  if (entry.lockedUntil && now < entry.lockedUntil) {
    const remaining = Math.ceil((entry.lockedUntil - now) / 60000);
    return `Account locked. Try again in ${remaining} minute(s).`;
  }
  return null;
}

function recordFailedLogin(email) {
  const now = Date.now();
  const entry = _failMap.get(email) || { count: 0, lockedUntil: null };
  entry.count++;
  if (entry.count >= FAIL_LIMIT) {
    entry.lockedUntil = now + LOCK_MS;
    entry.count = 0;
  }
  _failMap.set(email, entry);
}

function clearFailedLogin(email) {
  _failMap.delete(email);
}

// Sends an OTP / magic link / WhatsApp tap-to-login link — these endpoints
// fire an email or WhatsApp message, so abuse means the customer's bot inbox
// (or our IMAP-monitored inbox) gets flooded. Strict per-IP cap of 5/min.
const sendLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many requests. Wait a minute, then try again.' },
  standardHeaders: true, legacyHeaders: false,
});

module.exports = {
  loginLimiter,
  registerLimiter,
  apiLimiter,
  sendLimiter,
  ensureCsrfToken,
  requireCsrf,
  checkCredentialThrottle,
  recordFailedLogin,
  clearFailedLogin,
};
