'use strict';
/**
 * At-rest encryption for the WhatsApp session — AES-256-GCM (Node native crypto).
 *
 * The Baileys auth files ARE the WhatsApp identity: anyone with them can
 * impersonate the number. We store the session mirror + snapshots, so if the DB
 * or volume leaked, those files would be exposed in plaintext. With WA_SESSION_KEY
 * set, every stored blob is sealed with authenticated encryption; the key lives
 * ONLY in the Railway env var (never in the DB), so a DB/volume leak alone is
 * useless to an attacker.
 *
 * Format of a sealed blob:  "enc:v1:" + base64( [12B IV][ciphertext][16B tag] )
 * Anything WITHOUT the "enc:v1:" prefix is treated as raw plaintext — so legacy
 * (pre-encryption) rows and key-not-set deployments keep working unchanged.
 *
 * WA_SESSION_KEY: 64 hex chars (openssl rand -hex 32) preferred; a base64-32 or
 * any ≥16-char string is also accepted (SHA-256-derived) for convenience.
 *
 * Mirrors store.whatsapp-Bot/src/crypto.js, generalised to seal arbitrary blobs.
 */
const crypto = require('crypto');

const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const PREFIX = 'enc:v1:';

let _cachedKey = null;
let _cachedFrom = null;

function rawKey() {
  return process.env.WA_SESSION_KEY || '';
}

function getKey() {
  const raw = rawKey();
  if (!raw) return null;
  if (_cachedKey && _cachedFrom === raw) return _cachedKey;
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else if (/^[A-Za-z0-9+/]{43}=?$/.test(raw)) {
    const buf = Buffer.from(raw, 'base64');
    key = buf.length === KEY_LEN ? buf : crypto.createHash('sha256').update(raw).digest();
  } else {
    key = crypto.createHash('sha256').update(raw).digest();
  }
  if (key.length !== KEY_LEN) key = crypto.createHash('sha256').update(raw).digest();
  _cachedKey = key; _cachedFrom = raw;
  return key;
}

function isConfigured() { return !!rawKey(); }

// Seal a string. If no key configured, returns the raw string unchanged.
function seal(plaintext) {
  const key = getKey();
  if (key == null) return String(plaintext); // plaintext passthrough
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, ct, tag]).toString('base64');
}

// Unseal a stored value. Auto-detects: "enc:v1:" → decrypt; anything else → raw.
function unseal(stored) {
  const s = String(stored == null ? '' : stored);
  if (!s.startsWith(PREFIX)) return s; // legacy / plaintext
  const key = getKey();
  if (key == null) throw new Error('WA_SESSION_KEY is required to decrypt this session but is not set');
  const buf = Buffer.from(s.slice(PREFIX.length), 'base64');
  if (buf.length < IV_LEN + TAG_LEN) throw new Error('sealed blob too short');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const decipher = crypto.createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

function isSealed(stored) { return String(stored || '').startsWith(PREFIX); }

// Fresh 32-byte key in hex — shown to the admin to copy into Railway env.
function generateKey() { return crypto.randomBytes(KEY_LEN).toString('hex'); }

// Short non-reversible fingerprint of the active key — lets the UI confirm
// "encryption on" + which key, without ever revealing the key.
function keyFingerprint() {
  const key = getKey();
  if (!key) return null;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}

module.exports = { seal, unseal, isSealed, isConfigured, generateKey, keyFingerprint };
