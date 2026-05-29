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
async function scrapeResellKeysProducts(db, searchQuery) {
  const cfg = await getResellKeysConfig(db);
  // Try API first
  const apiRes = await httpReq(`${cfg.apiUrl}/api/v2/products?search=${encodeURIComponent(searchQuery || '')}&limit=100`, {
    method: 'GET',
    headers: {
      'Authorization': cfg.apiKey ? `Bearer ${cfg.apiKey}` : undefined,
      'Accept': 'application/json',
      'User-Agent': 'OTTStore/1.0',
    },
  });
  if (apiRes.status === 200 && Array.isArray(apiRes.body?.data || apiRes.body)) {
    const items = apiRes.body?.data || apiRes.body;
    return items.map(p => ({
      name: p.name || p.title || '',
      category: p.category || p.type || '',
      price_usd: parseFloat(p.price || p.price_usd || 0),
      provider_product_id: String(p.id || p.product_id || ''),
      image_url: p.image || p.icon || '',
      delivery_type: p.instant_delivery ? 'instant' : 'auto',
      description: p.description || '',
    }));
  }
  return [];
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
          run(db, `UPDATE orders SET status='delivered', credentials=?, delivered_at=datetime('now') WHERE id=?`,
            [JSON.stringify(creds), job.order_id]);
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

function startFulfillmentWorker() {
  setInterval(runFulfillmentTick, 2 * 60 * 1000); // every 2 min
  runFulfillmentTick(); // run immediately on startup
}

module.exports = { startFulfillmentWorker, runFulfillmentTick, scrapeResellKeysProducts };
