'use strict';
const rateLimit = require('express-rate-limit');

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

module.exports = {
  loginLimiter,
  registerLimiter,
  apiLimiter,
  checkCredentialThrottle,
  recordFailedLogin,
  clearFailedLogin,
};
