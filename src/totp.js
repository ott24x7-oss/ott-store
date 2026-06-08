'use strict';
// RFC 6238 TOTP (Time-based One-Time Password) + RFC 4648 base32.
// Used for admin two-factor auth. Compatible with Google Authenticator, Authy,
// Microsoft Authenticator, etc. (SHA1, 6 digits, 30s period).
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i]; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  str = String(str).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0, value = 0; const out = [];
  for (let i = 0; i < str.length; i++) {
    const idx = B32.indexOf(str[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

// 32-char base32 secret (20 random bytes) — the authenticator app's shared key.
function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

function hotp(secretBuf, counter) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', secretBuf).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return (bin % 1000000).toString().padStart(6, '0');
}

// Current 6-digit code for a base32 secret.
function token(secretB32, time = Date.now(), step = 30) {
  return hotp(base32Decode(secretB32), Math.floor((time / 1000) / step));
}

// Verify a code, allowing ±`window` steps for clock skew (default ±30s).
function verify(tok, secretB32, window = 1, time = Date.now(), step = 30) {
  tok = String(tok || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(tok)) return false;
  const secretBuf = base32Decode(secretB32);
  if (!secretBuf.length) return false;
  const counter = Math.floor((time / 1000) / step);
  const tokBuf = Buffer.from(tok);
  for (let i = -window; i <= window; i++) {
    const cand = Buffer.from(hotp(secretBuf, counter + i));
    if (cand.length === tokBuf.length && crypto.timingSafeEqual(cand, tokBuf)) return true;
  }
  return false;
}

// otpauth:// URI that the QR code encodes for the authenticator app.
function keyuri(secretB32, account, issuer) {
  const label = encodeURIComponent(issuer) + ':' + encodeURIComponent(account);
  const params = new URLSearchParams({ secret: secretB32, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}

module.exports = { generateSecret, token, verify, keyuri, base32Encode, base32Decode };
