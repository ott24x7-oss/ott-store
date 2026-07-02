'use strict';
// ── Licence client — phones home to the Rent Control panel ────────────────────
// Licensing is OFF unless BOTH LICENCE_SERVER and LICENCE_KEY are set, so the
// flagship deploy (ott24x7 — no key) is never affected. It ALWAYS fails open:
// if the panel is unreachable we fall back to the last cached status, and if we
// have never reached it we stay unlocked. Only a signed "locked/expired" reply
// from the panel ever locks the admin — never a network error on our side.
const crypto = require('crypto');
const { getSettingSync, setSettingSync } = require('./db');

const SERVER = (process.env.LICENCE_SERVER || '').replace(/\/+$/, '');
const KEY = (process.env.LICENCE_KEY || '').trim();
const SECRET = process.env.LICENCE_SECRET || '';
const ENABLED = !!(SERVER && KEY);

let mem = null; // last known status (also mirrored to the _licence_cache setting)

function loadCache() {
  if (mem) return mem;
  try { const c = getSettingSync('_licence_cache'); if (c) mem = JSON.parse(c); } catch { /* ignore */ }
  return mem;
}

// Fetch fresh status from the panel, verify its HMAC signature, cache it.
async function refresh() {
  if (!ENABLED) return { enabled: false, locked: false, status: 'disabled' };
  try {
    const res = await fetch(`${SERVER}/api/licence/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: KEY, domain: getSettingSync('base_url') || '' }),
      signal: AbortSignal.timeout(8000),
    });
    const j = await res.json();
    const expect = crypto.createHmac('sha256', SECRET).update(JSON.stringify(j.data)).digest('hex');
    if (!j || !j.data || expect !== j.sig) throw new Error('bad signature');
    mem = { ...j.data, enabled: true, fetched_at: Date.now() };
    try { setSettingSync('_licence_cache', JSON.stringify(mem)); } catch { /* ignore */ }
    return mem;
  } catch (e) {
    // FAIL OPEN — never lock because our own call failed.
    const cached = loadCache();
    if (cached) return { ...cached, stale: true };
    return { enabled: true, locked: false, status: 'unknown', fail_open: true, message: 'Licence server unreachable.' };
  }
}

function status() {
  if (!ENABLED) return { enabled: false, locked: false, status: 'disabled' };
  return loadCache() || { enabled: true, locked: false, status: 'unknown', fail_open: true };
}
function isLocked() { const s = status(); return !!(s.enabled && s.locked); }

function start() {
  if (!ENABLED) { console.log('Licence client: disabled (no LICENCE_KEY set).'); return; }
  console.log('Licence client: enabled →', SERVER);
  refresh().catch(() => {});
  setInterval(() => refresh().catch(() => {}), 6 * 60 * 60 * 1000).unref();
}

module.exports = { ENABLED, refresh, status, isLocked, start };
