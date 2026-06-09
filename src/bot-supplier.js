'use strict';
/**
 * bot-supplier.js — connect the store to the OTT24x7 Telegram bot's reseller API.
 *
 * The bot (railway_final / web_admin.py) exposes /reseller/* endpoints secured by an
 * `X-Reseller-Token` header. This module:
 *   • syncCatalog(db)  — pull GET /reseller/products into the `plans` table
 *                        (provider_api='bot', provider_product_id=<id>). The price is
 *                        set ONCE on first import; re-syncs refresh name/stock/active
 *                        only, so the admin's per-product price in Admin → Plans is
 *                        never overwritten.
 *   • purchase(...)    — POST /reseller/purchase; returns the delivered key(s).
 *   • fetchBalance()   — GET /reseller/balance (connection check).
 *   • startBotSync()   — sync shortly after boot + every SYNC_MINUTES (only if set).
 *
 * Delivering the keys to the customer lives in delivery-worker.js (deliverFromBot),
 * which calls purchase() here and relays the keys through the store's normal
 * email/WhatsApp delivery path. This module only requires ./db + ./config, so there
 * is no circular dependency with the delivery worker.
 */
const https = require('https');
const http = require('http');
const { getDb, get, all, run, getSetting } = require('./db');
const cfg = require('./config');

const SYNC_MINUTES = 10;

// ── config (env first, optional settings-table override so it can change without a
// redeploy). Returns { url, token }. ────────────────────────────────────────────
function botConfig(db) {
  let url = cfg.bot.apiUrl || '';
  let token = cfg.bot.apiToken || '';
  try {
    if (db) {
      url = (get(db, `SELECT value FROM settings WHERE key='bot_api_url'`)?.value || url || '');
      token = get(db, `SELECT value FROM settings WHERE key='bot_api_token'`)?.value || token || '';
    }
  } catch { /* settings table may not exist yet */ }
  return { url: String(url).replace(/\/+$/, ''), token: String(token || '') };
}

function isConfigured(c) { return !!(c && c.url && c.token); }

// ── JSON HTTP to the bot reseller API ────────────────────────────────────────────
function botHttp(urlStr, { method = 'GET', token = '', body = null, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      Accept: 'application/json',
      'X-Reseller-Token': token,
      'User-Agent': 'ott-store/1.0 (+bot-supplier)',
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      timeout,
      headers,
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON body */ }
        resolve({ status: res.statusCode || 0, json, body: data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── API calls ─────────────────────────────────────────────────────────────────
async function fetchProducts(db) {
  const c = botConfig(db);
  if (!isConfigured(c)) return { ok: false, error: 'not_configured', products: [] };
  try {
    const r = await botHttp(`${c.url}/reseller/products`, { token: c.token });
    if (r.status === 200 && r.json && r.json.ok) return { ok: true, products: r.json.products || [] };
    return { ok: false, error: (r.json && r.json.error) || `http_${r.status}`, products: [] };
  } catch (e) { return { ok: false, error: e.message, products: [] }; }
}

async function fetchBalance(db) {
  const c = botConfig(db);
  if (!isConfigured(c)) return { ok: false, error: 'not_configured' };
  try {
    const r = await botHttp(`${c.url}/reseller/balance`, { token: c.token });
    if (r.status === 200 && r.json && r.json.ok) return { ok: true, balance: r.json.balance, formatted: r.json.formatted_balance };
    return { ok: false, error: (r.json && r.json.error) || `http_${r.status}` };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Buy `qty` of a bot product. Returns a normalized result the delivery worker acts on:
//   { ok:true, status, delivered, keys:[...], raw }                         → deliver
//   { ok:false, outOfStock:true, ... }                                       → refund
//   { ok:false, retryable:true, ... } (network / 5xx)                        → retry later
//   { ok:false, retryable:false, error } (402/403/404 config/availability)   → alert admin
async function purchase(productId, qty, buyerInfo, db) {
  const c = botConfig(db);
  if (!isConfigured(c)) return { ok: false, retryable: false, error: 'not_configured', keys: [] };
  try {
    const r = await botHttp(`${c.url}/reseller/purchase`, {
      method: 'POST',
      token: c.token,
      body: { product_id: productId, quantity: qty || 1, buyer_info: buyerInfo || {} },
      timeout: 20000,
    });
    const j = r.json || {};
    if (r.status === 200 && j.ok) {
      const keys = Array.isArray(j.delivery_payload)
        ? j.delivery_payload.map(String)
        : (j.delivery_payload ? String(j.delivery_payload).split('\n').filter(Boolean) : []);
      return { ok: true, status: j.status, delivered: j.delivered_qty || keys.length, keys, raw: j };
    }
    const error = j.error || `http_${r.status}`;
    const outOfStock = r.status === 409 || error === 'out_of_stock';
    const retryable = !outOfStock && (r.status >= 500 || r.status === 0); // 5xx / network
    return { ok: false, outOfStock, retryable, error, httpStatus: r.status, raw: j, keys: [] };
  } catch (e) {
    return { ok: false, outOfStock: false, retryable: true, error: e.message, keys: [] };
  }
}

// ── catalog sync ────────────────────────────────────────────────────────────────
function makeSlug(base, taken) {
  const root = String(base || 'plan')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'plan';
  let slug = root, i = 2;
  while (taken && taken.has(slug)) slug = `${root}-${i++}`;
  if (taken) taken.add(slug);
  return slug;
}

function platformFor(p) {
  const cat = String(p.category || '').trim();
  if (cat && cat.toLowerCase() !== 'other') return cat.charAt(0).toUpperCase() + cat.slice(1);
  return 'OTT';
}

// Insert ONE bot product into `plans` (shared by sync auto-import + manual import).
// markupPercent (0 = the bot's retail price) sets the STARTING selling price; after
// that the admin owns it and re-syncs never overwrite it.
function importOneBotPlan(db, p, slugSet, markupPercent = 0) {
  const pid = String(p.id);
  const name = (p.name || 'Plan').toString().slice(0, 200);
  const deliveryType = p.delivery_type === 'auto' ? 'auto' : 'manual';
  const stock = deliveryType === 'auto'
    ? (Number.isFinite(p.stock) ? p.stock : (p.in_stock === false ? 0 : -1))
    : -1;
  const active = p.in_stock === false ? 0 : 1;
  const platform = platformFor(p);
  const base = Number(p.retail_price) || Number(p.price) || 0;
  const priceInr = Math.ceil(base * (1 + Math.max(0, Number(markupPercent) || 0) / 100));
  const slug = makeSlug(`${platform} ${name}`, slugSet);
  run(db,
    `INSERT INTO plans (platform,name,duration_days,price_inr,original_price_inr,price_usd,
       description,features,badge,stock,active,sort_order,
       category,image_url,provider_api,provider_product_id,delivery_type,delivery_time_est,slug)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [platform, name, null, priceInr, null, 0,
     (p.description || ''), '[]', null, stock, active, 0,
     (p.category || ''), '', 'bot', pid, deliveryType, '', slug]);
}

// Manual "Add selected" — import only the chosen bot products (by id), each with the
// given markup over the bot's retail price. Skips ones already imported.
async function importProducts(db, ids, markupPercent = 0) {
  db = db || await getDb();
  const res = await fetchProducts(db);
  if (!res.ok) return { ok: false, error: res.error, imported: 0 };
  const wanted = new Set((ids || []).map(String));
  const slugSet = new Set(all(db, 'SELECT slug FROM plans WHERE slug IS NOT NULL').map(x => x.slug));
  let imported = 0;
  for (const p of res.products) {
    const pid = String(p.id);
    if (!wanted.has(pid)) continue;
    if (get(db, `SELECT id FROM plans WHERE provider_api='bot' AND provider_product_id=?`, [pid])) continue;
    importOneBotPlan(db, p, slugSet, markupPercent);
    imported++;
  }
  return { ok: true, imported };
}

// Refresh imported bot plans from the bot. NEW products are auto-imported only when
// the `bot_auto_import` setting is on; otherwise they wait under "Available to add".
async function syncCatalog(db) {
  db = db || await getDb();
  const res = await fetchProducts(db);
  if (!res.ok) return { ok: false, error: res.error, inserted: 0, updated: 0, delisted: 0, total: 0 };

  let inserted = 0, updated = 0;
  const autoImport = (await getSetting('bot_auto_import')) === '1';
  const seen = new Set();
  const slugSet = new Set(all(db, 'SELECT slug FROM plans WHERE slug IS NOT NULL').map(x => x.slug));

  for (const p of res.products) {
    const pid = String(p.id);
    if (!pid || pid === 'undefined') continue;
    seen.add(pid);

    const deliveryType = p.delivery_type === 'auto' ? 'auto' : 'manual';
    const stock = deliveryType === 'auto'
      ? (Number.isFinite(p.stock) ? p.stock : (p.in_stock === false ? 0 : -1))
      : -1; // manual products: shown as available, delivered by hand
    const active = p.in_stock === false ? 0 : 1;
    const name = (p.name || 'Plan').toString().slice(0, 200);

    const existing = get(db, `SELECT id FROM plans WHERE provider_api='bot' AND provider_product_id=?`, [pid]);
    if (existing) {
      // Refresh volatile fields only — never touch price_inr (admin owns the price).
      run(db,
        `UPDATE plans SET name=?, stock=?, active=?, delivery_type=?,
           description=CASE WHEN description IS NULL OR description='' THEN ? ELSE description END
         WHERE id=?`,
        [name, stock, active, deliveryType, (p.description || ''), existing.id]);
      updated++;
    } else if (autoImport) {
      importOneBotPlan(db, p, slugSet);
      inserted++;
    }
    // else: a NEW bot product the admin hasn't chosen — it appears under
    // "Available to add" on the Bot Catalog page for manual selection.
  }

  // Delist bot plans the provider no longer returns — hide (don't delete, so order
  // history + slugs stay intact). ONLY when we actually got a catalog back: a transient
  // empty-but-ok response must never deactivate every product at once.
  let delisted = 0;
  if (res.products.length > 0) {
    for (const row of all(db, `SELECT id, provider_product_id FROM plans WHERE provider_api='bot' AND active=1`)) {
      if (!seen.has(String(row.provider_product_id))) {
        run(db, `UPDATE plans SET active=0, stock=0 WHERE id=?`, [row.id]);
        delisted++;
      }
    }
  }

  return { ok: true, inserted, updated, delisted, total: res.products.length };
}

// ── background sync ───────────────────────────────────────────────────────────
let _syncing = false;
async function syncTick() {
  if (_syncing) return;
  _syncing = true;
  try {
    const db = await getDb();
    if (!isConfigured(botConfig(db))) return; // not connected — nothing to do
    const r = await syncCatalog(db);
    if (r.ok) console.log(`[bot-supplier] catalog sync: +${r.inserted} new, ${r.updated} updated, ${r.delisted} delisted`);
    else console.warn('[bot-supplier] catalog sync failed:', r.error);
  } catch (e) {
    console.warn('[bot-supplier] sync error:', e.message);
  } finally {
    _syncing = false;
  }
}

function startBotSync() {
  setTimeout(() => { syncTick().catch(() => {}); }, 8000);
  setInterval(() => { syncTick().catch(() => {}); }, SYNC_MINUTES * 60 * 1000);
}

module.exports = {
  botConfig, isConfigured, fetchProducts, fetchBalance, purchase, syncCatalog, importProducts, startBotSync,
};
