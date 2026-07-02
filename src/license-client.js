// ─── License client — gates this rented deployment against the Landlord Console ──
//
// Phones home to LICENSE_API_URL (the console's /api/license.php) with LICENSE_KEY,
// caches the verdict to a file, and LOCKS ONLY THE ADMIN (/admin*) when the console
// says the subscription is locked (overdue past grace / suspended / cancelled /
// invalid key). The customer-facing store ALWAYS keeps running so a tenant's
// billing lapse never takes down their business — only their admin is gated.
//
// Fail-OPEN: a console outage / network blip must never brick a paying tenant; we
// keep using the last cached verdict, and with no cache at all we stay UNLOCKED.
//
// Config (env vars on the tenant's Railway):
//   LICENSE_KEY          RP-XXXX-XXXX-XXXX-XXXX
//   LICENSE_API_URL      https://rentalsmmpanel.com/api/license.php
//   LICENSE_VENDOR_MODE  1 → skip the check entirely (the operator's own deploys)
// Unset LICENSE_API_URL → STANDALONE mode (unlocked); gating only applies once
// the operator points it at their console.

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { URL } = require('url');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'license-cache.json');
const TIMEOUT_MS = 12_000;
const BEAT_OK_MS     = 12 * 3600 * 1000;   // healthy → occasional re-check
const BEAT_LOCKED_MS = 20 * 60 * 1000;     // locked/grace → re-check often so a renewal auto-unlocks

function vendorMode() { return String(process.env.LICENSE_VENDOR_MODE || '').trim() === '1'; }
function licenseKey() { return String(process.env.LICENSE_KEY || '').trim().toUpperCase(); }
function server()     { return String(process.env.LICENSE_API_URL || process.env.LICENSE_SERVER || '').trim().replace(/\/+$/, ''); }
function configured() { return !vendorMode() && !!server() && !!licenseKey(); }

function readCache() { try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (_) { return null; } }
function writeCache(o) { try { fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(o)); } catch (_) {} }

function httpGetJson(u) {
  return new Promise((resolve, reject) => {
    const lib = u.startsWith('https') ? https : http;
    const rq = lib.get(u, { timeout: TIMEOUT_MS, headers: { accept: 'application/json' } }, (r) => {
      let d = ''; r.on('data', (c) => { d += c; if (d.length > 65536) rq.destroy(new Error('too large')); });
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    rq.on('timeout', () => rq.destroy(new Error('timeout')));
    rq.on('error', reject);
  });
}

// Phone home once. Returns the raw console JSON, or null on any failure (cache kept).
async function verify(host) {
  if (!configured()) return null;
  const base = server();
  const u = base + (base.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(licenseKey()) + '&domain=' + encodeURIComponent(host || '');
  try {
    const j = await httpGetJson(u);
    if (!j || typeof j.locked === 'undefined') return null;
    writeCache({
      locked: !!j.locked, status: j.status || (j.locked ? 'locked' : 'active'), message: j.message || '',
      renew_url: j.renew_url || '', support: j.support || '', business: j.business || '', product: j.product || '',
      next_due: j.next_due || null, days_to_due: (typeof j.days_to_due === 'number') ? j.days_to_due : null,
      checked_at: new Date().toISOString(),
    });
    return j;
  } catch (_) { return null; }   // fail-open: keep the last cached verdict
}

function status() {
  if (vendorMode())        return { locked: false, state: 'vendor' };
  if (!server() || !licenseKey()) return { locked: false, state: 'standalone' };
  const c = readCache();
  if (!c) return { locked: false, state: 'pending' };   // never checked → unlocked
  return Object.assign({ state: c.status || 'ok' }, c, { locked: !!c.locked });
}
function isLocked() { return !!status().locked; }

function lockPage(c) {
  const renew = String(c.renew_url || '');
  const support = String(c.support || '').replace(/[<>]/g, '');
  const msg = String(c.message || 'This deployment’s subscription has lapsed. Please renew to restore the admin.').replace(/[<>]/g, '');
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Subscription paused</title>'
    + '<style>body{margin:0;font-family:Inter,system-ui,Segoe UI,Roboto,sans-serif;background:#0a0f1c;color:#e8eefc;display:grid;place-items:center;min-height:100vh;padding:24px}'
    + '.b{max-width:440px;text-align:center;background:#111a2e;border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:34px 28px}'
    + '.i{font-size:46px}.b h1{font-size:20px;margin:12px 0 8px}.b p{color:#9fb0cc;font-size:14px;line-height:1.6;margin:0}'
    + 'a.btn{display:inline-block;margin-top:18px;background:linear-gradient(135deg,#ffbf3f,#ff8a1f);color:#241500;font-weight:800;padding:12px 24px;border-radius:11px;text-decoration:none}'
    + '.s{margin-top:14px;font-size:12.5px;color:#6b7a96}</style>'
    + '<div class="b"><div class="i">🔒</div><h1>Admin temporarily locked</h1><p>' + msg + '</p>'
    + (renew ? '<a class="btn" href="' + renew.replace(/"/g, '&quot;') + '" target="_blank" rel="noopener">Renew now →</a>' : '')
    + '<div class="s">' + (support ? ('Need help? ' + support) : 'Your customer-facing store keeps running — only the admin is locked until you renew.') + '</div></div>';
}

// Express middleware: mount at app.use('/admin', makeAdminGate()). No-op unless a
// console is configured; otherwise renders the lock page when the console says locked.
function makeAdminGate() {
  return function adminLicenseGate(req, res, next) {
    if (!configured()) return next();
    if (!readCache()) { const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0]; verify(host).catch(() => {}); }
    const s = status();
    if (!s.locked) return next();
    const c = readCache() || {};
    const wantsJson = (req.path || '').startsWith('/api') || String(req.headers.accept || '').includes('application/json');
    if (wantsJson) return res.status(402).json({ error: 'subscription_locked', message: c.message || 'Subscription lapsed — renew to restore admin.', renew_url: c.renew_url || '' });
    return res.status(402).type('html').send(lockPage(c));
  };
}

let _timer = null;
function startHeartbeat() {
  if (!configured() || _timer) return;
  const tick = async () => {
    let host = ''; try { host = new URL(server()).host; } catch (_) {}
    await verify(host).catch(() => {});
    _timer = setTimeout(tick, isLocked() ? BEAT_LOCKED_MS : BEAT_OK_MS);
    if (_timer.unref) _timer.unref();
  };
  _timer = setTimeout(tick, 60 * 1000);   // first check ~60s after boot; never blocks startup
  if (_timer.unref) _timer.unref();
}

module.exports = { verify, status, isLocked, makeAdminGate, startHeartbeat, configured, licenseKey, server, vendorMode };
