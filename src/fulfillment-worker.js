'use strict';
const https = require('https');
const http = require('http');
const { getDb, getSetting, all, get, run } = require('./db');

// ─── HTTP helper ─────────────────────────────────────────────────────────────
function httpReq(url, opts = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const options = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', ...opts.headers },
    };
    const req = lib.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// Raw-HTML fetcher (no JSON parsing) for the storefront scraper. Sets a real
// browser User-Agent so resellkeys.com doesn't 403 or serve a bot challenge.
function httpReqRaw(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const options = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...opts.headers,
      },
    };
    const req = lib.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// ─── IST hour helper ─────────────────────────────────────────────────────────
function istHour() {
  const d = new Date();
  return (d.getUTCHours() * 60 + d.getUTCMinutes() + 330) % 1440 / 60 | 0;
}

// ─── ResellKeys API client ────────────────────────────────────────────────────
async function getResellKeysConfig(db) {
  const cfg = require('./config');
  const apiUrl = get(db, `SELECT value FROM settings WHERE key='resellkeys_api_url'`)?.value || cfg.resellkeys.apiUrl;
  const apiKey = get(db, `SELECT value FROM settings WHERE key='resellkeys_api_key'`)?.value || cfg.resellkeys.apiKey;
  const email  = get(db, `SELECT value FROM settings WHERE key='resellkeys_email'`)?.value  || cfg.resellkeys.email;
  const pass   = get(db, `SELECT value FROM settings WHERE key='resellkeys_password'`)?.value || cfg.resellkeys.password;
  return { apiUrl: apiUrl.replace(/\/$/, ''), apiKey, email, password: pass };
}

async function rkRequest(db, method, path, body = null) {
  const cfg = await getResellKeysConfig(db);
  const headers = { 'User-Agent': 'OTTStore/1.0' };
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
  if (cfg.email)  headers['X-Auth-Email'] = cfg.email;
  return httpReq(`${cfg.apiUrl}${path}`, { method, headers }, body);
}

// ─── Scrape/search ResellKeys product catalog ─────────────────────────────────
//
// resellkeys.com doesn't expose a JSON API — it's an OpenCart storefront where
// the catalog lives at index.php?route=product/catalog&fq=<categoryId>&page=N.
// Each page is HTML with up to 24 .product-layout cards. We fetch N pages,
// parse each card with regex, mark in-stock vs out-of-stock from the
// product-layout class, and compute price_inr = ceil($ × rate × (1+profit%)).
//
// Options:
//   query           — if set, uses /product/search?search=… instead of catalog
//   categoryFilter  — `fq` value (default '11' = software keys; user's URL)
//   pages           — max pages to fetch (default 15; resellkeys shows 15)
//   inStockOnly     — drop out-of-stock cards (default true)
async function scrapeResellKeysProducts(db, optsOrQuery = {}) {
  // Back-compat: old call signature was a plain string (search query).
  const opts = typeof optsOrQuery === 'string' ? { query: optsOrQuery } : (optsOrQuery || {});

  const baseUrl = (await getSetting('resellkeys_base_url'))
               || (await getSetting('resellkeys_api_url'))
               || 'https://resellkeys.com';
  const profitPct = parseFloat((await getSetting('profit_pct')) || '30') || 30;
  const usdToInr  = parseFloat((await getSetting('usd_to_inr_rate')) || '84') || 84;

  const q              = String(opts.query || '').trim();
  const categoryFilter = String(opts.categoryFilter || '11');
  const maxPages       = Math.max(1, Math.min(50, parseInt(opts.pages || '15', 10) || 15));
  const inStockOnly    = opts.inStockOnly !== false;

  const root = baseUrl.replace(/\/$/, '').replace(/\/index\.php.*$/, ''); // strip trailing /index.php?... if pasted

  const allProducts = [];
  const seenIds = new Set();
  let pagesFetched = 0;

  for (let page = 1; page <= maxPages; page++) {
    const url = q
      ? `${root}/index.php?route=product/search&search=${encodeURIComponent(q)}&page=${page}`
      : `${root}/index.php?route=product/catalog&fq=${encodeURIComponent(categoryFilter)}&page=${page}`;
    let res;
    try {
      res = await httpReqRaw(url);
    } catch (e) {
      // Network/timeout — stop early rather than retry forever.
      break;
    }
    pagesFetched++;
    if (res.status !== 200 || typeof res.body !== 'string' || !res.body.includes('product-layout')) break;

    const products = parseResellKeysCatalogHtml(res.body);
    if (!products.length) break;

    let newOnPage = 0;
    for (const p of products) {
      if (inStockOnly && !p.in_stock) continue;
      if (!p.provider_product_id || seenIds.has(p.provider_product_id)) continue;
      seenIds.add(p.provider_product_id);
      const priceInr = p.price_usd > 0
        ? Math.ceil(p.price_usd * usdToInr * (1 + profitPct / 100))
        : 0;
      allProducts.push({ ...p, price_inr: priceInr });
      newOnPage++;
    }
    // If a page returns zero new items, the catalog has wrapped — stop.
    if (newOnPage === 0) break;

    // Be polite to the upstream.
    await new Promise(r => setTimeout(r, 350));
  }

  return { products: allProducts, pages: pagesFetched, profit_pct: profitPct, usd_to_inr: usdToInr };
}

// Pure HTML→array parser, no network. Exported for unit testing if needed.
function parseResellKeysCatalogHtml(html) {
  // Split on every product-layout card boundary. The first chunk before the
  // first match is page chrome — drop it.
  const cards = html.split(/<div\s+class="product-layout\b/i).slice(1);
  const out = [];
  for (const raw of cards) {
    // Look only at the next ~7KB of HTML after the boundary — keeps the
    // greedy regexes from spilling into the next card.
    const card = raw.slice(0, 7000);
    const outOfStock = /^[^>]*\bout-of-stock\b/i.test(card);

    // Image — data-src holds the lazy-loaded real URL; src is a base64 placeholder
    const imgMatch = card.match(/data-src="([^"]+)"/);
    let imageUrl = imgMatch ? imgMatch[1] : '';
    // Prefer the 500x500 over the 250x250 thumbnail when both exist
    if (imageUrl) imageUrl = imageUrl.replace(/-250x250\./, '-500x500.');

    // Product name + URL (slug-based, e.g. /windows-10-11-pro-1pc-retail-online)
    const nameMatch = card.match(/class="name"[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const productUrl = nameMatch?.[1] || '';
    const name = nameMatch
      ? nameMatch[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/\s+/g, ' ').trim()
      : '';

    // Numeric product_id from the hidden cart input
    const idMatch = card.match(/name="product_id"\s+value="(\d+)"/);
    const productId = idMatch?.[1] || '';

    // Price — handles "$0.90", "$1,425.00", "$26.50" formats
    const priceMatch = card.match(/class="price-normal">\s*\$?([\d,]+\.?\d*)/);
    const priceUsd = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : 0;

    // Short description (strip tags + clamp). resellkeys truncates with "..".
    const descMatch = card.match(/class="description"[^>]*>([\s\S]*?)<\/div>/i);
    const description = descMatch
      ? descMatch[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 280)
      : '';

    if (!name || !productId) continue;

    out.push({
      name,
      provider_product_id: productId,
      product_url: productUrl,
      price_usd: priceUsd,
      image_url: imageUrl,
      description,
      in_stock: !outOfStock,
      delivery_type: 'auto',
      category: '',
    });
  }
  return out;
}

// ─── Place order on ResellKeys ────────────────────────────────────────────────
async function placeResellKeysOrder(db, job) {
  const res = await rkRequest(db, 'POST', '/api/v2/orders', {
    product_id: job.provider_product_id,
    quantity: 1,
    ref: `ott-order-${job.order_id}`,
  });
  if (res.status === 200 || res.status === 201) {
    const id = res.body?.id || res.body?.order_id || res.body?.data?.id;
    if (id) return { provider_order_id: String(id), raw: JSON.stringify(res.body) };
  }
  throw new Error(`Place order failed: HTTP ${res.status} — ${JSON.stringify(res.body)}`);
}

// ─── Poll ResellKeys order for delivery ──────────────────────────────────────
async function pollResellKeysOrder(db, providerOrderId) {
  const res = await rkRequest(db, 'GET', `/api/v2/orders/${providerOrderId}`);
  if (res.status !== 200) throw new Error(`Poll failed: HTTP ${res.status}`);
  const d = res.body?.data || res.body;
  const status = (d?.status || '').toLowerCase();
  const key = d?.key || d?.serial || d?.license || d?.credentials || d?.delivery_key;
  return { status, key, raw: JSON.stringify(res.body) };
}

// ─── Main fulfillment tick ────────────────────────────────────────────────────
async function runFulfillmentTick() {
  try {
    const db = await getDb();
    const enabled = get(db, `SELECT value FROM settings WHERE key='fulfillment_enabled'`)?.value;
    if (enabled !== '1') return;

    const hour = istHour();
    // Operating hours: 5 AM – 11 PM IST (ResellKeys supplier hours)
    if (hour < 5 || hour > 23) return;

    // 1. Pick up new orders that need fulfillment (plan has provider_api set)
    const newOrders = all(db, `
      SELECT o.id, o.plan_id, o.customer_jid, p.provider_api, p.provider_product_id
      FROM orders o
      JOIN plans p ON o.plan_id = p.id
      WHERE o.status = 'pending'
        AND p.provider_api IS NOT NULL AND p.provider_api != ''
        AND NOT EXISTS (SELECT 1 FROM fulfillment_jobs fj WHERE fj.order_id = o.id)
    `);
    for (const order of newOrders) {
      run(db, `INSERT OR IGNORE INTO fulfillment_jobs
        (order_id, plan_id, customer_jid, provider_api, provider_product_id, status)
        VALUES (?,?,?,?,?,'pending')`,
        [order.id, order.plan_id, order.customer_jid, order.provider_api, order.provider_product_id]);
    }

    // 2. Process pending jobs → place on provider
    const pendingJobs = all(db, `SELECT * FROM fulfillment_jobs WHERE status='pending' AND attempt_count < 5`);
    for (const job of pendingJobs) {
      run(db, `UPDATE fulfillment_jobs SET status='placing', last_attempt_at=datetime('now'), attempt_count=attempt_count+1 WHERE id=?`, [job.id]);
      run(db, `UPDATE orders SET status='processing' WHERE id=?`, [job.order_id]);
      try {
        const result = await placeResellKeysOrder(db, job);
        run(db, `UPDATE fulfillment_jobs SET status='polling', provider_order_id=?, raw_response=? WHERE id=?`,
          [result.provider_order_id, result.raw, job.id]);
      } catch (e) {
        const nextStatus = job.attempt_count >= 4 ? 'manual_review' : 'pending';
        run(db, `UPDATE fulfillment_jobs SET status=?, error_msg=? WHERE id=?`, [nextStatus, e.message, job.id]);
      }
      await new Promise(r => setTimeout(r, 500));
    }

    // 3. Poll in-flight orders
    const pollingJobs = all(db, `SELECT * FROM fulfillment_jobs WHERE status='polling' AND attempt_count < 50`);
    for (const job of pollingJobs) {
      if (!job.provider_order_id) { run(db, `UPDATE fulfillment_jobs SET status='manual_review' WHERE id=?`, [job.id]); continue; }
      run(db, `UPDATE fulfillment_jobs SET last_attempt_at=datetime('now'), attempt_count=attempt_count+1 WHERE id=?`, [job.id]);
      try {
        const poll = await pollResellKeysOrder(db, job.provider_order_id);
        if (poll.status === 'completed' || poll.status === 'delivered' || poll.key) {
          const creds = { key: poll.key, provider_order: job.provider_order_id };
          // Guard: only mark delivered if the order hasn't been delivered already.
          // Prevents overwriting credentials if the worker ticks twice for the
          // same order (concurrent polls, retry after a soft failure, etc.).
          const upd = run(db, `UPDATE orders SET status='delivered', credentials=?, delivered_at=datetime('now') WHERE id=? AND status<>'delivered'`,
            [JSON.stringify(creds), job.order_id]);
          if (!upd.changes) {
            run(db, `UPDATE fulfillment_jobs SET status='delivered' WHERE id=?`, [job.id]);
            continue;
          }
          run(db, `UPDATE fulfillment_jobs SET status='delivered', delivered_at=datetime('now'), raw_response=? WHERE id=?`,
            [poll.raw, job.id]);
          // Send delivery email/WA
          try {
            const order = get(db, `SELECT o.*, c.email, c.name, c.phone, p.name as plan_name, p.platform FROM orders o JOIN customers c ON o.customer_jid=c.jid JOIN plans p ON o.plan_id=p.id WHERE o.id=?`, [job.order_id]);
            if (order) {
              const { sendOrderDelivery } = require('./mailer');
              if (order.email) await sendOrderDelivery(order.email, order.name, order, creds).catch(() => {});
            }
          } catch {}
        } else if (poll.status === 'failed' || poll.status === 'cancelled' || poll.status === 'refunded') {
          run(db, `UPDATE fulfillment_jobs SET status='failed', error_msg=? WHERE id=?`, [poll.status, job.id]);
          run(db, `UPDATE orders SET status='cancelled' WHERE id=?`, [job.order_id]);
        }
        // else still pending — keep polling
      } catch (e) {
        if (job.attempt_count >= 49) run(db, `UPDATE fulfillment_jobs SET status='manual_review', error_msg=? WHERE id=?`, [e.message, job.id]);
      }
      await new Promise(r => setTimeout(r, 300));
    }
  } catch (e) {
    // silent — don't crash the worker
  }
}

// ─── Test ResellKeys (supplier) login connection ─────────────────────────────
//
// resellkeys.com is an OpenCart storefront. We test the *real* login the same
// way the Phase-2 browser automation will: GET the login page to grab the
// session cookie, then POST the stored email/password to route=account/login
// and inspect the response. A 302 to route=account/account ⇒ valid creds; a
// bounce back to route=account/login (or the "No match" warning) ⇒ bad creds.
//
// Cloudflare / bot-challenge pages are reported honestly so the admin knows the
// HTTP test can't confirm it (the headless-browser path in Phase 2 can).
const RK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function rkRawHttp(url, { method = 'GET', headers = {}, body = null, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      timeout,
      headers: { 'User-Agent': RK_UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', ...headers },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Public entry used by the admin "Test Connection" button. Prefers the REAL
// browser login (validates the whole Playwright/Chromium stack on Railway); if
// Playwright/Chromium isn't available in this environment, falls back to the
// lightweight HTTP login check below.
async function testResellKeysLogin() {
  try {
    const provider = require('./providers/resellkeys');
    return await provider.testLogin();
  } catch (e) {
    if (e && e.code === 'NO_BROWSER') {
      const r = await testResellKeysLoginHttp();
      r.message = '⚠️ Browser engine not available here — ran the lightweight HTTP check instead.\n' + r.message;
      r.via = 'http_fallback';
      return r;
    }
    return { ok: false, stage: 'browser', message: `Browser login error: ${e.message}` };
  }
}

async function testResellKeysLoginHttp() {
  const db = await getDb();
  const cfg = await getResellKeysConfig(db);
  const root = String(cfg.apiUrl || 'https://resellkeys.com')
    .replace(/\/index\.php.*$/i, '').replace(/\/+$/, '') || 'https://resellkeys.com';

  if (!cfg.email || !cfg.password) {
    return { ok: false, stage: 'config', message: 'ResellKeys email and/or password are not set. Add them in Settings first.' };
  }

  const loginUrl = `${root}/index.php?route=account/login`;

  // 1. GET login page → capture session cookie
  let g;
  try { g = await rkRawHttp(loginUrl); }
  catch (e) { return { ok: false, stage: 'reach', message: `Could not reach ${root} — ${e.message}` }; }

  if (g.status === 403 || g.status === 503 || /cf-browser-verification|Just a moment|challenge-platform/i.test(g.body || '')) {
    return { ok: false, stage: 'challenge', message: `${root} is behind a bot-challenge (Cloudflare). The HTTP test can't log in — the Phase-2 browser automation will. Credentials were NOT verified.` };
  }
  if (g.status >= 400) return { ok: false, stage: 'reach', message: `Login page returned HTTP ${g.status}.` };

  const cookie = (g.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

  // 2. POST credentials (form-urlencoded), do NOT auto-follow the redirect
  const form = `email=${encodeURIComponent(cfg.email)}&password=${encodeURIComponent(cfg.password)}`;
  let p;
  try {
    p = await rkRawHttp(loginUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(form),
        'Cookie': cookie,
        'Referer': loginUrl,
        'Origin': root,
      },
      body: form,
    });
  } catch (e) { return { ok: false, stage: 'login', message: `Login request failed — ${e.message}` }; }

  const loc = String(p.headers.location || '');
  const body = String(p.body || '');

  if (/route=account\/(account|wishlist|dashboard)/i.test(loc)) {
    return { ok: true, stage: 'ok', message: `Connected ✓ Logged in to ${root} as ${cfg.email}.`, account: cfg.email };
  }
  if (/route=account\/login/i.test(loc) || /No match for (the )?E-?Mail/i.test(body) || /Warning:[^<]*password/i.test(body)) {
    return { ok: false, stage: 'auth', message: 'Login rejected — wrong ResellKeys email or password.' };
  }
  if (p.status === 302 && loc) {
    // Redirect somewhere other than login — most OpenCart themes only redirect
    // away from the login route on success. Confirm by loading the account page.
    try {
      const acct = await rkRawHttp(`${root}/index.php?route=account/account`, { headers: { Cookie: cookie } });
      if (acct.status === 200 && /route=account\/logout|Edit your account|My Account/i.test(acct.body || '')) {
        return { ok: true, stage: 'ok', message: `Connected ✓ Logged in to ${root} as ${cfg.email}.`, account: cfg.email };
      }
    } catch {}
  }
  return { ok: false, stage: 'unknown', message: `Could not confirm login (HTTP ${p.status}). The site may have changed its login form.` };
}

function startFulfillmentWorker() {
  setInterval(runFulfillmentTick, 2 * 60 * 1000); // every 2 min
  runFulfillmentTick(); // run immediately on startup
}

module.exports = { startFulfillmentWorker, runFulfillmentTick, scrapeResellKeysProducts, parseResellKeysCatalogHtml, testResellKeysLogin };
