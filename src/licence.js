'use strict';
// ── Licence client — phones home to the Landlord Console (rentalsmmpanel.com) ──
// Licensing is OFF unless a licence key + server are set, so the flagship deploy
// (no key) is never affected. It ALWAYS fails open: if the console is unreachable
// we fall back to the last cached status, and with no cache at all we stay
// unlocked. Only a "locked" reply from the console ever locks the admin.
//
// Config (env vars on the tenant's Railway):
//   LICENSE_KEY        RP-XXXX-XXXX-XXXX-XXXX
//   LICENSE_API_URL    https://rentalsmmpanel.com/api/license.php
//   (LICENCE_SERVER + LICENCE_KEY are also accepted for back-compat — if
//    LICENCE_SERVER is a bare origin we append /api/license.php.)
const { getSettingSync, setSettingSync } = require('./db');

function apiUrl() {
  const direct = (process.env.LICENSE_API_URL || process.env.LICENCE_API_URL || '').trim().replace(/\/+$/, '');
  if (direct) return direct;
  const origin = (process.env.LICENCE_SERVER || process.env.LICENSE_SERVER || '').trim().replace(/\/+$/, '');
  if (!origin) return '';
  return /\/api\/licen[cs]e/i.test(origin) ? origin : origin + '/api/license.php';
}
const KEY = (process.env.LICENSE_KEY || process.env.LICENCE_KEY || '').trim().toUpperCase();
const SERVER = apiUrl();
const ENABLED = !!(SERVER && KEY);

let mem = null; // last known status (also mirrored to the _licence_cache setting)

function loadCache() {
  if (mem) return mem;
  try { const c = getSettingSync('_licence_cache'); if (c) mem = JSON.parse(c); } catch { /* ignore */ }
  return mem;
}

// Map the console's /api/license.php JSON → the shape the Subscription page + lock
// screen already expect (pay_url, next_renewal, days_left, contact, name…).
function mapStatus(j) {
  return {
    enabled: true,
    locked: !!j.locked,
    status: j.status || (j.locked ? 'locked' : 'active'),
    message: j.message || '',
    plan: j.plan || '',
    product: j.product || '',
    next_renewal: j.next_due || '',
    days_left: (typeof j.days_to_due === 'number') ? j.days_to_due : null,
    grace_until: '',
    name: j.business || '',
    pay_url: j.renew_url || '',
    contact: j.support || '',
    fetched_at: Date.now(),
  };
}

async function refresh() {
  if (!ENABLED) return { enabled: false, locked: false, status: 'disabled' };
  try {
    const base = SERVER;
    const url = base + (base.includes('?') ? '&' : '?')
      + 'key=' + encodeURIComponent(KEY)
      + '&domain=' + encodeURIComponent(getSettingSync('base_url') || '');
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    const j = await res.json();
    if (!j || typeof j.locked === 'undefined') throw new Error('bad response');
    mem = mapStatus(j);
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
  if (!ENABLED) { console.log('Licence client: disabled (no LICENSE_KEY set).'); return; }
  console.log('Licence client: enabled →', SERVER);
  refresh().catch(() => {});
  setInterval(() => refresh().catch(() => {}), 6 * 60 * 60 * 1000).unref();
}

module.exports = { ENABLED, refresh, status, isLocked, start };
