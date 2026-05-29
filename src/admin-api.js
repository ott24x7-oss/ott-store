'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cfg = require('./config');
const { getDb, getSetting, setSetting, all, get, run } = require('./db');
const { loginLimiter, checkCredentialThrottle, recordFailedLogin, clearFailedLogin } = require('./security');
const { audit } = require('./audit');
const { submitUrls, pingSitemap } = require('./google-index');
const { sendOrderDelivery, sendMail } = require('./mailer');

const router = express.Router();

const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// ─── Admin auth middleware ────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const token = req.cookies?.adminToken;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.admin = jwt.verify(token, cfg.sessionSecret + ':admin');
    next();
  } catch { res.status(401).json({ error: 'Session expired' }); }
}

function setAdminCookie(res) {
  const token = jwt.sign({ role: 'admin' }, cfg.sessionSecret + ':admin', { expiresIn: cfg.adminJwtExpiry });
  res.cookie('adminToken', token, { ...cfg.cookieOptions, maxAge: 12 * 60 * 60 * 1000 });
  return token;
}

// ─── Login / Logout ───────────────────────────────────────────────────────────
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required' });
    const throttleMsg = checkCredentialThrottle('admin');
    if (throttleMsg) return res.status(429).json({ error: throttleMsg });
    const storedHash = await getSetting('admin_password_hash');
    let ok;
    if (storedHash) {
      ok = await bcrypt.compare(password, storedHash);
    } else {
      ok = (password === cfg.adminPassword);
    }
    if (!ok) {
      recordFailedLogin('admin');
      return res.status(401).json({ error: 'Invalid password' });
    }
    clearFailedLogin('admin');
    setAdminCookie(res);
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: 'login', ip: req.ip });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/logout', (req, res) => {
  res.clearCookie('adminToken', { path: '/' });
  res.json({ ok: true });
});

// ─── Platform management ──────────────────────────────────────────────────────
const DEFAULT_PLATFORMS = [
  'Netflix','Amazon Prime','Disney+','Sony LIV','Zee5','Hotstar','JioCinema',
  'MX Player','Apple TV+','Voot','YouTube Premium','Spotify','Apple Music',
  'Canva','Adobe','Microsoft 365','Google One','NordVPN','ExpressVPN',
  'Coursera','LinkedIn Premium','ChatGPT Plus','Gemini','Other',
];

router.get('/plans/platforms', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const row = get(db, `SELECT value FROM settings WHERE key='custom_platforms'`);
    const custom = row ? JSON.parse(row.value || '[]') : [];
    const all_platforms = [...new Set([...DEFAULT_PLATFORMS, ...custom])].sort();
    res.json({ platforms: all_platforms, custom });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/plans/platforms', requireAdmin, async (req, res) => {
  try {
    const { custom } = req.body;
    if (!Array.isArray(custom)) return res.status(400).json({ error: 'custom array required' });
    const db = await getDb();
    run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`, ['custom_platforms', JSON.stringify(custom)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Plan image upload ────────────────────────────────────────────────────────
router.post('/plans/:id/upload-image', requireAdmin, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
    const filename = `plan_${req.params.id}_${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), req.file.buffer);
    const url = `/admin/api/plan-image/${filename}`;
    const db = await getDb();
    run(db, `UPDATE plans SET image_url=? WHERE id=?`, [url, req.params.id]);
    res.json({ ok: true, url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/plan-image/:filename', async (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const filepath = path.join(UPLOADS_DIR, filename);
    if (!fs.existsSync(filepath)) return res.status(404).end();
    res.sendFile(filepath);
  } catch { res.status(404).end(); }
});

// ─── Site logo upload ─────────────────────────────────────────────────────────
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(png|jpeg|jpg|svg\+xml|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed (PNG, JPG, SVG, WebP)'));
  },
});

router.post('/upload-logo/:type', requireAdmin, logoUpload.single('logo'), async (req, res) => {
  try {
    const type = req.params.type === 'dark' ? 'dark' : 'light';
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const ext = (req.file.originalname.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
    const filename = `logo_${type}.${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), req.file.buffer);
    const url = `/data/uploads/${filename}`;
    const db = await getDb();
    run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`, [`logo_${type}_url`, url]);
    res.json({ ok: true, url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/upload-logo/:type', requireAdmin, async (req, res) => {
  try {
    const type = req.params.type === 'dark' ? 'dark' : 'light';
    const db = await getDb();
    const row = get(db, `SELECT value FROM settings WHERE key=?`, [`logo_${type}_url`]);
    if (row?.value) {
      const filename = path.basename(row.value);
      const filepath = path.join(UPLOADS_DIR, filename);
      if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    }
    run(db, `DELETE FROM settings WHERE key=?`, [`logo_${type}_url`]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Plans ────────────────────────────────────────────────────────────────────
router.get('/plans', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const plans = all(db, `SELECT * FROM plans ORDER BY sort_order ASC, id ASC`);
    plans.forEach(p => { try { p.features = JSON.parse(p.features || '[]'); } catch { p.features = []; } });
    res.json(plans);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/plans', requireAdmin, async (req, res) => {
  try {
    const { platform, name, duration_days, price_inr, original_price_inr, price_usd,
            description, features, badge, stock, active, sort_order,
            category, image_url, provider_api, provider_product_id, delivery_type, delivery_time_est } = req.body;
    if (!platform || !name) return res.status(400).json({ error: 'Platform and name required' });
    const db = await getDb();
    const r = run(db,
      `INSERT INTO plans (platform,name,duration_days,price_inr,original_price_inr,price_usd,
        description,features,badge,stock,active,sort_order,
        category,image_url,provider_api,provider_product_id,delivery_type,delivery_time_est)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [platform, name, duration_days||null, price_inr||0, original_price_inr||null, price_usd||0,
       description||null, JSON.stringify(features||[]), badge||null,
       stock??-1, active??1, sort_order||0,
       category||'', image_url||'', provider_api||'', provider_product_id||'',
       delivery_type||'manual', delivery_time_est||'']);
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: 'create_plan', targetKind: 'plan', targetId: r.lastInsertRowid, after: req.body, ip: req.ip });
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/plans/:id', requireAdmin, async (req, res) => {
  try {
    const { platform, name, duration_days, price_inr, original_price_inr, price_usd,
            description, features, badge, stock, active, sort_order,
            category, image_url, provider_api, provider_product_id, delivery_type, delivery_time_est } = req.body;
    const db = await getDb();
    run(db,
      `UPDATE plans SET platform=?,name=?,duration_days=?,price_inr=?,original_price_inr=?,price_usd=?,
       description=?,features=?,badge=?,stock=?,active=?,sort_order=?,
       category=?,image_url=?,provider_api=?,provider_product_id=?,delivery_type=?,delivery_time_est=?
       WHERE id=?`,
      [platform, name, duration_days||null, price_inr||0, original_price_inr||null, price_usd||0,
       description||null, JSON.stringify(features||[]), badge||null,
       stock??-1, active??1, sort_order||0,
       category||'', image_url||'', provider_api||'', provider_product_id||'',
       delivery_type||'manual', delivery_time_est||'', req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/plans/:id', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    run(db, `DELETE FROM plans WHERE id=?`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/plans/:id/toggle', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    run(db, `UPDATE plans SET active = CASE WHEN active=1 THEN 0 ELSE 1 END WHERE id=?`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Orders ───────────────────────────────────────────────────────────────────
router.get('/orders', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    let sql = `SELECT o.*, p.name as plan_name, p.platform, c.email as customer_email, c.name as customer_name
               FROM orders o
               LEFT JOIN plans p ON o.plan_id=p.id
               LEFT JOIN customers c ON o.customer_jid=c.jid
               WHERE 1=1`;
    const params = [];
    if (req.query.status) { sql += ` AND o.status=?`; params.push(req.query.status); }
    if (req.query.platform) { sql += ` AND p.platform=?`; params.push(req.query.platform); }
    if (req.query.q) {
      sql += ` AND (c.email LIKE ? OR c.name LIKE ?)`;
      params.push(`%${req.query.q}%`, `%${req.query.q}%`);
    }
    sql += ` ORDER BY o.created_at DESC LIMIT 200`;
    const orders = all(db, sql, params);
    orders.forEach(o => { if (o.credentials) { try { o.credentials = JSON.parse(o.credentials); } catch {} } });
    res.json(orders);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/orders/:id', requireAdmin, async (req, res) => {
  try {
    const { status, credentials, delivery_note, expires_at } = req.body;
    const db = await getDb();
    const order = get(db, `SELECT o.*, p.name as plan_name, p.platform, c.email, c.name as cname
                           FROM orders o LEFT JOIN plans p ON o.plan_id=p.id LEFT JOIN customers c ON o.customer_jid=c.jid
                           WHERE o.id=?`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const credsJson = credentials ? JSON.stringify(credentials) : order.credentials;
    const deliveredAt = status === 'delivered' && order.status !== 'delivered' ? `datetime('now')` : `'${order.delivered_at}'`;
    run(db, `UPDATE orders SET status=?, credentials=?, delivery_note=?, expires_at=?, delivered_at=${deliveredAt} WHERE id=?`,
      [status || order.status, credsJson, delivery_note ?? order.delivery_note, expires_at ?? order.expires_at, req.params.id]);
    if (status === 'delivered' && order.status !== 'delivered' && order.email) {
      const creds = credentials || (order.credentials ? JSON.parse(order.credentials) : {});
      sendOrderDelivery(order.email, order.cname, order, creds).catch(() => {});
    }
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: `order_${status}`, targetKind: 'order', targetId: req.params.id, ip: req.ip });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Topups ───────────────────────────────────────────────────────────────────
router.get('/topups', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const status = req.query.status || null;
    let sql = `SELECT t.*, c.email, c.name as customer_name FROM topups t LEFT JOIN customers c ON t.customer_jid=c.jid WHERE 1=1`;
    const params = [];
    if (status) { sql += ` AND t.status=?`; params.push(status); }
    sql += ` ORDER BY t.created_at DESC LIMIT 200`;
    res.json(all(db, sql, params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/topups/:id', requireAdmin, async (req, res) => {
  try {
    const { action } = req.body; // 'approve' | 'reject'
    if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
    const db = await getDb();
    const topup = get(db, `SELECT * FROM topups WHERE id=? AND status='pending'`, [req.params.id]);
    if (!topup) return res.status(404).json({ error: 'Topup not found or already processed' });
    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    run(db, `UPDATE topups SET status=? WHERE id=?`, [newStatus, req.params.id]);
    if (action === 'approve') {
      const { creditWallet } = _walletHelper(db);
      creditWallet(topup.customer_jid, topup.amount_inr, 'topup', `Manual UPI`, topup.reference);
    }
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: `topup_${action}`, targetKind: 'topup', targetId: req.params.id, ip: req.ip });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/topups/manual-credit', requireAdmin, async (req, res) => {
  try {
    const { customer_jid, amount, label } = req.body;
    if (!customer_jid || !amount) return res.status(400).json({ error: 'customer_jid and amount required' });
    const db = await getDb();
    const c = get(db, `SELECT jid FROM customers WHERE jid=?`, [customer_jid]);
    if (!c) return res.status(404).json({ error: 'Customer not found' });
    run(db, `UPDATE customers SET wallet_inr = wallet_inr + ? WHERE jid=?`, [amount, customer_jid]);
    run(db, `INSERT INTO wallet_txns (customer_jid,amount_inr,type,label) VALUES (?,?,?,?)`,
      [customer_jid, amount, 'admin_credit', label || 'Admin Credit']);
    run(db, `INSERT INTO topups (customer_jid,amount_inr,method,reference,status) VALUES (?,?,'admin','manual-credit','approved')`,
      [customer_jid, amount]);
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: 'manual_credit', targetKind: 'customer', targetId: customer_jid, after: { amount, label }, ip: req.ip });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function _walletHelper(db) {
  return {
    creditWallet(jid, amount, type, label, refId) {
      run(db, `UPDATE customers SET wallet_inr = wallet_inr + ? WHERE jid=?`, [amount, jid]);
      run(db, `INSERT INTO wallet_txns (customer_jid,amount_inr,type,label,ref_id) VALUES (?,?,?,?,?)`,
        [jid, amount, type, label, refId || null]);
    }
  };
}

// ─── Customers ────────────────────────────────────────────────────────────────
router.get('/customers', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    let sql = `SELECT c.jid,c.name,c.email,c.phone,c.wallet_inr,c.blocked,c.is_reseller,
               c.discount_percent,c.referral_code,c.created_at,c.last_login_at,
               (SELECT COUNT(*) FROM orders WHERE customer_jid=c.jid) as order_count
               FROM customers c WHERE 1=1`;
    const params = [];
    if (req.query.q) {
      sql += ` AND (c.email LIKE ? OR c.name LIKE ? OR c.phone LIKE ?)`;
      params.push(`%${req.query.q}%`, `%${req.query.q}%`, `%${req.query.q}%`);
    }
    sql += ` ORDER BY c.created_at DESC LIMIT 200`;
    res.json(all(db, sql, params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/customers/:jid', requireAdmin, async (req, res) => {
  try {
    const { name, email, phone, wallet_inr, blocked, discount_percent, is_reseller } = req.body;
    const db = await getDb();
    const c = get(db, `SELECT * FROM customers WHERE jid=?`, [req.params.jid]);
    if (!c) return res.status(404).json({ error: 'Customer not found' });
    run(db, `UPDATE customers SET name=?,email=?,phone=?,wallet_inr=?,blocked=?,discount_percent=?,is_reseller=? WHERE jid=?`,
      [name ?? c.name, email ?? c.email, phone ?? c.phone,
       wallet_inr ?? c.wallet_inr, blocked ?? c.blocked,
       discount_percent ?? c.discount_percent, is_reseller ?? c.is_reseller,
       req.params.jid]);
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: 'edit_customer', targetKind: 'customer', targetId: req.params.jid, ip: req.ip });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/customers/:jid/password', requireAdmin, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: 'Password too short' });
    const db = await getDb();
    const hash = await bcrypt.hash(password, cfg.bcryptRounds);
    run(db, `UPDATE customers SET password_hash=? WHERE jid=?`, [hash, req.params.jid]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/customers/:jid/login-as', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const c = get(db, `SELECT * FROM customers WHERE jid=?`, [req.params.jid]);
    if (!c) return res.status(404).json({ error: 'Customer not found' });
    const token = jwt.sign({ jid: c.jid, email: c.email, name: c.name, impersonated: true },
      cfg.sessionSecret, { expiresIn: '5m' });
    res.json({ ok: true, token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Settings ─────────────────────────────────────────────────────────────────
router.get('/settings', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const rows = all(db, `SELECT key, value FROM settings`);
    const s = {};
    rows.forEach(r => { if (r.key !== 'google_index_credentials') s[r.key] = r.value; });
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/settings', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    for (const [k, v] of Object.entries(req.body)) {
      if (k === 'admin_password') {
        if (v && v.length >= 6) {
          const hash = await bcrypt.hash(v, cfg.bcryptRounds);
          run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`, ['admin_password_hash', hash]);
        }
        continue;
      }
      let val = String(v);
      if (k === 'base_url') val = val.trim().replace(/\/+$/, '');
      run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`, [k, val]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SEO settings ─────────────────────────────────────────────────────────────
router.get('/seo-settings', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const rows = all(db, `SELECT key, value FROM settings WHERE key LIKE 'seo_%' OR key='robots_txt'`);
    const s = {};
    rows.forEach(r => s[r.key] = r.value);
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/seo-settings', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    for (const [k, v] of Object.entries(req.body)) {
      run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`, [k, String(v)]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Google Indexing ──────────────────────────────────────────────────────────
router.get('/google-index/config', requireAdmin, async (req, res) => {
  try {
    const raw = await getSetting('google_index_credentials');
    if (!raw) return res.json({ configured: false });
    const sa = JSON.parse(raw);
    res.json({ configured: true, client_email: sa.client_email });
  } catch { res.json({ configured: false }); }
});

router.post('/google-index/credentials', requireAdmin, async (req, res) => {
  try {
    const { credentials } = req.body;
    if (!credentials) return res.status(400).json({ error: 'credentials required' });
    JSON.parse(credentials); // validate JSON
    await setSetting('google_index_credentials', credentials);
    const sa = JSON.parse(credentials);
    res.json({ ok: true, client_email: sa.client_email });
  } catch (e) { res.status(400).json({ error: 'Invalid JSON: ' + e.message }); }
});

router.post('/google-index/submit', requireAdmin, async (req, res) => {
  try {
    const { urls } = req.body;
    if (!Array.isArray(urls) || !urls.length) return res.status(400).json({ error: 'urls array required' });
    const results = await submitUrls(urls.slice(0, 200));
    res.json({ ok: true, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/google-index/ping-sitemap', requireAdmin, async (req, res) => {
  try {
    const baseUrl = await getSetting('base_url') || cfg.baseUrl;
    const result = await pingSitemap(`${baseUrl}/sitemap.xml`);
    res.json({ ok: true, status: result.status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/google-index/history', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const rows = all(db, `SELECT * FROM audit_log WHERE actor_label='google-index' ORDER BY created_at DESC LIMIT 100`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Blog ─────────────────────────────────────────────────────────────────────
router.get('/blog', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    res.json(all(db, `SELECT * FROM blog_posts ORDER BY created_at DESC`));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/blog', requireAdmin, async (req, res) => {
  try {
    const { title, slug, body, meta_desc, og_image, published } = req.body;
    if (!title) return res.status(400).json({ error: 'Title required' });
    const autoSlug = slug || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const db = await getDb();
    const r = run(db, `INSERT INTO blog_posts (slug,title,body,meta_desc,og_image,published) VALUES (?,?,?,?,?,?)`,
      [autoSlug, title, body || '', meta_desc || '', og_image || '', published ? 1 : 0]);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/blog/:id', requireAdmin, async (req, res) => {
  try {
    const { title, slug, body, meta_desc, og_image, published } = req.body;
    const db = await getDb();
    run(db, `UPDATE blog_posts SET title=?,slug=?,body=?,meta_desc=?,og_image=?,published=? WHERE id=?`,
      [title, slug, body || '', meta_desc || '', og_image || '', published ? 1 : 0, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/blog/:id', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    run(db, `DELETE FROM blog_posts WHERE id=?`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Audit log ────────────────────────────────────────────────────────────────
router.get('/audit-log', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    res.json(all(db, `SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 500`));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Tickets (admin side) ──────────────────────────────────────────────────────
router.get('/tickets', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const status = req.query.status;
    let sql = `SELECT t.*, c.email, c.name as customer_name FROM tickets t LEFT JOIN customers c ON t.customer_jid=c.jid WHERE 1=1`;
    const params = [];
    if (status) { sql += ` AND t.status=?`; params.push(status); }
    sql += ` ORDER BY t.created_at DESC LIMIT 200`;
    res.json(all(db, sql, params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/tickets/:id', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const ticket = get(db, `SELECT t.*, c.email, c.name as customer_name FROM tickets t LEFT JOIN customers c ON t.customer_jid=c.jid WHERE t.id=?`, [req.params.id]);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const replies = all(db, `SELECT * FROM ticket_replies WHERE ticket_id=? ORDER BY created_at ASC`, [req.params.id]);
    res.json({ ...ticket, replies });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/tickets/:id/reply', requireAdmin, async (req, res) => {
  try {
    const { body, status } = req.body;
    if (!body) return res.status(400).json({ error: 'Body required' });
    const db = await getDb();
    run(db, `INSERT INTO ticket_replies (ticket_id,sender,body) VALUES (?,?,?)`, [req.params.id, 'admin', body.trim()]);
    if (status) run(db, `UPDATE tickets SET status=? WHERE id=?`, [status, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DB Backup ────────────────────────────────────────────────────────────────
router.get('/backup/download', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const data = Buffer.from(db.export());
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="store_${Date.now()}.db"`);
    res.send(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Dashboard stats ──────────────────────────────────────────────────────────
router.get('/dashboard', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const today = get(db, `SELECT COALESCE(SUM(amount_inr),0) as revenue FROM orders WHERE status NOT IN ('cancelled') AND date(created_at)=date('now')`);
    const week = get(db, `SELECT COALESCE(SUM(amount_inr),0) as revenue FROM orders WHERE status NOT IN ('cancelled') AND created_at >= datetime('now','-7 days')`);
    const month = get(db, `SELECT COALESCE(SUM(amount_inr),0) as revenue FROM orders WHERE status NOT IN ('cancelled') AND created_at >= datetime('now','-30 days')`);
    const pending_orders = get(db, `SELECT COUNT(*) as c FROM orders WHERE status='pending'`);
    const pending_topups = get(db, `SELECT COUNT(*) as c FROM topups WHERE status='pending'`);
    const total_customers = get(db, `SELECT COUNT(*) as c FROM customers`);
    const recent_orders = all(db,
      `SELECT o.id,o.status,o.amount_inr,o.created_at,p.name as plan_name,p.platform,c.email
       FROM orders o LEFT JOIN plans p ON o.plan_id=p.id LEFT JOIN customers c ON o.customer_jid=c.jid
       ORDER BY o.created_at DESC LIMIT 10`);
    res.json({
      revenue_today: today?.revenue || 0,
      revenue_week: week?.revenue || 0,
      revenue_month: month?.revenue || 0,
      pending_orders: pending_orders?.c || 0,
      pending_topups: pending_topups?.c || 0,
      total_customers: total_customers?.c || 0,
      recent_orders,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Bulk import (one-time migration) ────────────────────────────────────────
router.post('/import', requireAdmin, async (req, res) => {
  try {
    const { customers: custs = [], orders: ords = [], settings: settingsData = {} } = req.body;
    const db = await getDb();
    const imported = { customers: 0, orders: 0, settings: 0 };

    for (const [k, v] of Object.entries(settingsData)) {
      run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`, [k, String(v)]);
      imported.settings++;
    }

    for (const c of custs) {
      const existing = get(db, `SELECT jid FROM customers WHERE jid=?`, [c.jid]);
      if (existing) continue;
      run(db, `INSERT INTO customers (jid,name,email,phone,wallet_inr,created_at) VALUES (?,?,?,?,?,?)`,
        [c.jid, c.name || null, c.email || null, c.phone || null, c.wallet_inr || 0, c.created_at || null]);
      imported.customers++;
    }

    for (const o of ords) {
      run(db, `INSERT INTO orders (customer_jid,plan_id,amount_inr,status,delivery_note,created_at,delivered_at) VALUES (?,?,?,?,?,?,?)`,
        [o.customer_jid, o.plan_id || null, o.amount_inr || 0, o.status || 'delivered', o.delivery_note || null, o.created_at || null, o.delivered_at || null]);
      imported.orders++;
    }

    await audit({ actorKind: 'admin', actorLabel: 'admin', action: 'bulk_import', after: imported, ip: req.ip });
    res.json({ ok: true, imported });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Check auth status ────────────────────────────────────────────────────────
router.get('/me', requireAdmin, (req, res) => res.json({ ok: true, role: 'admin' }));

// ─── Analytics ────────────────────────────────────────────────────────────────
router.get('/analytics', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const days = parseInt(req.query.days || '30');

    const revenue = all(db, `SELECT date(created_at) as d, SUM(amount_inr) as rev, COUNT(*) as cnt
      FROM orders WHERE status NOT IN ('cancelled') AND created_at >= datetime('now','-${days} days')
      GROUP BY date(created_at) ORDER BY d ASC`);

    const topPlans = all(db, `SELECT p.name, p.platform, COUNT(*) as orders, SUM(o.amount_inr) as revenue
      FROM orders o LEFT JOIN plans p ON o.plan_id=p.id
      WHERE o.created_at >= datetime('now','-${days} days')
      GROUP BY o.plan_id ORDER BY orders DESC LIMIT 10`);

    const topCustomers = all(db, `SELECT c.name, c.email, COUNT(*) as orders, SUM(o.amount_inr) as spent
      FROM orders o LEFT JOIN customers c ON o.customer_jid=c.jid
      WHERE o.created_at >= datetime('now','-${days} days')
      GROUP BY o.customer_jid ORDER BY spent DESC LIMIT 10`);

    const platforms = all(db, `SELECT p.platform, COUNT(*) as orders, SUM(o.amount_inr) as revenue
      FROM orders o LEFT JOIN plans p ON o.plan_id=p.id
      WHERE o.created_at >= datetime('now','-${days} days')
      GROUP BY p.platform ORDER BY revenue DESC`);

    const totals = get(db, `SELECT COALESCE(SUM(amount_inr),0) as revenue, COUNT(*) as orders
      FROM orders WHERE status NOT IN ('cancelled') AND created_at >= datetime('now','-${days} days')`);

    const newCustomers = get(db, `SELECT COUNT(*) as cnt FROM customers WHERE created_at >= datetime('now','-${days} days')`);

    res.json({ revenue, topPlans, topCustomers, platforms, totals, newCustomers: newCustomers?.cnt || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Stock management ─────────────────────────────────────────────────────────
router.get('/stock', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const plans = all(db, `SELECT p.id, p.platform, p.name,
      (SELECT COUNT(*) FROM stock_credentials WHERE plan_id=p.id AND status='available') as available,
      (SELECT COUNT(*) FROM stock_credentials WHERE plan_id=p.id AND status='sold') as sold
      FROM plans p ORDER BY p.sort_order ASC, p.id ASC`);
    res.json(plans);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/stock/:planId', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const creds = all(db, `SELECT * FROM stock_credentials WHERE plan_id=? ORDER BY status ASC, id ASC`, [req.params.planId]);
    res.json(creds);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/stock/:planId', requireAdmin, async (req, res) => {
  try {
    const { line1, line2, extra, cred_type } = req.body;
    if (!line1) return res.status(400).json({ error: 'line1 required' });
    const db = await getDb();
    const r = run(db, `INSERT INTO stock_credentials (plan_id,cred_type,line1,line2,extra) VALUES (?,?,?,?,?)`,
      [req.params.planId, cred_type || 'credential', line1.trim(), line2 || null, extra || null]);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/stock/:planId/bulk', requireAdmin, async (req, res) => {
  try {
    const { text, cred_type } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });
    const db = await getDb();
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    let added = 0;
    for (const line of lines) {
      const parts = line.split(/[:|,\t]/).map(p => p.trim());
      const line1 = parts[0];
      const line2 = parts[1] || null;
      const extra = parts[2] || null;
      if (!line1) continue;
      run(db, `INSERT INTO stock_credentials (plan_id,cred_type,line1,line2,extra) VALUES (?,?,?,?,?)`,
        [req.params.planId, cred_type || 'credential', line1, line2, extra]);
      added++;
    }
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: 'stock_bulk_add', targetKind: 'plan', targetId: req.params.planId, after: { added }, ip: req.ip });
    res.json({ ok: true, added });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/stock/:credId', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    run(db, `DELETE FROM stock_credentials WHERE id=? AND status='available'`, [req.params.credId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Payment Methods ──────────────────────────────────────────────────────────
router.get('/payment-methods', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    res.json(all(db, `SELECT * FROM payment_methods ORDER BY sort_order ASC, id ASC`));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/payment-methods', requireAdmin, async (req, res) => {
  try {
    const { name, type, address, instructions, qr_url, enabled, sort_order } = req.body;
    if (!name || !type) return res.status(400).json({ error: 'name and type required' });
    const db = await getDb();
    const r = run(db, `INSERT INTO payment_methods (name,type,address,instructions,qr_url,enabled,sort_order) VALUES (?,?,?,?,?,?,?)`,
      [name, type, address || null, instructions || null, qr_url || null, enabled ?? 1, sort_order || 0]);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/payment-methods/:id', requireAdmin, async (req, res) => {
  try {
    const { name, type, address, instructions, qr_url, enabled, sort_order } = req.body;
    const db = await getDb();
    run(db, `UPDATE payment_methods SET name=?,type=?,address=?,instructions=?,qr_url=?,enabled=?,sort_order=? WHERE id=?`,
      [name, type, address || null, instructions || null, qr_url || null, enabled ?? 1, sort_order || 0, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/payment-methods/:id', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    run(db, `DELETE FROM payment_methods WHERE id=?`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── IMAP ─────────────────────────────────────────────────────────────────────
router.post('/imap/test', requireAdmin, async (req, res) => {
  try {
    const { testImapConnection } = require('./imap-verify');
    const { host, port, email, password, folder } = req.body;
    const result = await testImapConnection({ host, port: parseInt(port) || 993, user: email, password, folder });
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/imap/status', requireAdmin, async (req, res) => {
  try {
    const { getImapStatus } = require('./imap-verify');
    res.json(getImapStatus());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Resellers ────────────────────────────────────────────────────────────────
router.get('/resellers', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const resellers = all(db, `SELECT r.*, c.name, c.email, c.phone
      FROM resellers r LEFT JOIN customers c ON r.customer_jid=c.jid
      ORDER BY r.created_at DESC`);
    res.json(resellers);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/resellers/:id', requireAdmin, async (req, res) => {
  try {
    const { status, discount_percent, notes } = req.body;
    const db = await getDb();
    run(db, `UPDATE resellers SET status=?,discount_percent=?,notes=? WHERE id=?`,
      [status, discount_percent || 0, notes || null, req.params.id]);
    // Sync discount to customer record
    const r = get(db, 'SELECT customer_jid FROM resellers WHERE id=?', [req.params.id]);
    if (r && status === 'approved') {
      run(db, `UPDATE customers SET discount_percent=? WHERE jid=?`, [discount_percent || 0, r.customer_jid]);
    } else if (r && status === 'rejected') {
      run(db, `UPDATE customers SET discount_percent=0 WHERE jid=?`, [r.customer_jid]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/resellers/:id', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const r = get(db, 'SELECT customer_jid FROM resellers WHERE id=?', [req.params.id]);
    if (r) run(db, `UPDATE customers SET discount_percent=0 WHERE jid=?`, [r.customer_jid]);
    run(db, `DELETE FROM resellers WHERE id=?`, [req.params.id]);
    run(db, `DELETE FROM reseller_prices WHERE reseller_id=?`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/resellers/:id/prices', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const prices = all(db, `SELECT rp.*, p.name, p.platform FROM reseller_prices rp LEFT JOIN plans p ON rp.plan_id=p.id WHERE rp.reseller_id=?`, [req.params.id]);
    res.json(prices);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/resellers/:id/prices', requireAdmin, async (req, res) => {
  try {
    const { prices } = req.body; // [{plan_id, price_inr}]
    if (!Array.isArray(prices)) return res.status(400).json({ error: 'prices array required' });
    const db = await getDb();
    for (const p of prices) {
      if (p.price_inr === null || p.price_inr === '') {
        run(db, `DELETE FROM reseller_prices WHERE reseller_id=? AND plan_id=?`, [req.params.id, p.plan_id]);
      } else {
        run(db, `INSERT OR REPLACE INTO reseller_prices (reseller_id,plan_id,price_inr) VALUES (?,?,?)`,
          [req.params.id, p.plan_id, p.price_inr]);
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Referrals ────────────────────────────────────────────────────────────────
router.get('/referrals', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const referrals = all(db, `SELECT rr.*,
      c1.name as referrer_name, c1.email as referrer_email,
      c2.name as referred_name, c2.email as referred_email
      FROM referral_rewards rr
      LEFT JOIN customers c1 ON rr.referrer_jid=c1.jid
      LEFT JOIN customers c2 ON rr.referred_jid=c2.jid
      ORDER BY rr.created_at DESC LIMIT 200`);
    res.json(referrals);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/referrals/:id/credit', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const rr = get(db, `SELECT * FROM referral_rewards WHERE id=? AND status='pending'`, [req.params.id]);
    if (!rr) return res.status(404).json({ error: 'Not found or already credited' });
    run(db, `UPDATE customers SET wallet_inr = wallet_inr + ? WHERE jid=?`, [rr.reward_inr, rr.referrer_jid]);
    run(db, `INSERT INTO wallet_txns (customer_jid,amount_inr,type,label) VALUES (?,?,?,?)`,
      [rr.referrer_jid, rr.reward_inr, 'referral', 'Referral bonus']);
    run(db, `UPDATE referral_rewards SET status='credited' WHERE id=?`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Broadcast ────────────────────────────────────────────────────────────────
router.post('/broadcast', requireAdmin, async (req, res) => {
  try {
    const { subject, message, imageUrl, target } = req.body;
    if (!subject || !message) return res.status(400).json({ error: 'subject and message required' });
    const { sendBroadcast } = require('./autopost-worker');
    const result = await sendBroadcast({ subject, message, imageUrl, target });
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: 'broadcast', after: result, ip: req.ip });
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Auto-post campaigns ──────────────────────────────────────────────────────
router.get('/autopost', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    res.json(all(db, `SELECT * FROM autopost_campaigns ORDER BY created_at DESC`));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/autopost', requireAdmin, async (req, res) => {
  try {
    const { title, subject, message, image_url, target, schedule_enabled, interval_hours, active } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'title and message required' });
    const db = await getDb();
    const r = run(db, `INSERT INTO autopost_campaigns (title,subject,message,image_url,target,schedule_enabled,interval_hours,active) VALUES (?,?,?,?,?,?,?,?)`,
      [title, subject || title, message, image_url || null, target || 'all', schedule_enabled ? 1 : 0, interval_hours || 24, active ?? 1]);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/autopost/:id', requireAdmin, async (req, res) => {
  try {
    const { title, subject, message, image_url, target, schedule_enabled, interval_hours, active } = req.body;
    const db = await getDb();
    run(db, `UPDATE autopost_campaigns SET title=?,subject=?,message=?,image_url=?,target=?,schedule_enabled=?,interval_hours=?,active=? WHERE id=?`,
      [title, subject || title, message, image_url || null, target || 'all', schedule_enabled ? 1 : 0, interval_hours || 24, active ?? 1, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/autopost/:id', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    run(db, `DELETE FROM autopost_campaigns WHERE id=?`, [req.params.id]);
    run(db, `DELETE FROM autopost_log WHERE campaign_id=?`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/autopost/:id/clone', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const c = get(db, `SELECT * FROM autopost_campaigns WHERE id=?`, [req.params.id]);
    if (!c) return res.status(404).json({ error: 'Campaign not found' });
    const r = run(db, `INSERT INTO autopost_campaigns (title,subject,message,image_url,target,schedule_enabled,interval_hours,active) VALUES (?,?,?,?,?,?,?,0)`,
      [c.title + ' (copy)', c.subject, c.message, c.image_url, c.target, c.schedule_enabled, c.interval_hours]);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/autopost/:id/send-now', requireAdmin, async (req, res) => {
  try {
    const { sendCampaignNow } = require('./autopost-worker');
    const result = await sendCampaignNow(parseInt(req.params.id));
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/autopost/:id/logs', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    res.json(all(db, `SELECT * FROM autopost_log WHERE campaign_id=? ORDER BY sent_at DESC LIMIT 500`, [req.params.id]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Legal pages ──────────────────────────────────────────────────────────────
router.get('/legal', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    res.json(all(db, `SELECT slug, title, updated_at FROM legal_pages ORDER BY slug ASC`));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/legal/:slug', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const page = get(db, `SELECT * FROM legal_pages WHERE slug=?`, [req.params.slug]);
    if (!page) return res.status(404).json({ error: 'Page not found' });
    res.json(page);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/legal/:slug', requireAdmin, async (req, res) => {
  try {
    const { title, body } = req.body;
    const db = await getDb();
    run(db, `INSERT OR REPLACE INTO legal_pages (slug,title,body,updated_at) VALUES (?,?,?,datetime('now'))`,
      [req.params.slug, title, body || '']);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── WhatsApp Bot ─────────────────────────────────────────────────────────────
router.get('/whatsapp/status', requireAdmin, async (req, res) => {
  try {
    const waBot = require('./wa-bot');
    const status = waBot.getStatus();
    const qrDataUrl = status.hasQR ? await waBot.getQRBase64() : null;
    res.json({ ...status, qrDataUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/whatsapp/qr', requireAdmin, async (req, res) => {
  try {
    const waBot = require('./wa-bot');
    const qr = waBot.getQR();
    if (!qr) return res.json({ hasQR: false });
    const qrDataUrl = await waBot.getQRBase64();
    res.json({ hasQR: true, qrDataUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/whatsapp/connect', requireAdmin, async (req, res) => {
  try {
    const waBot = require('./wa-bot');
    const db = await getDb();
    run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES ('wa_enabled','1')`);
    await waBot.connect();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/whatsapp/disconnect', requireAdmin, async (req, res) => {
  try {
    const waBot = require('./wa-bot');
    await waBot.disconnect();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/whatsapp/reconnect', requireAdmin, async (req, res) => {
  try {
    const waBot = require('./wa-bot');
    await waBot.reconnect();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/whatsapp/clear-session', requireAdmin, async (req, res) => {
  try {
    const waBot = require('./wa-bot');
    await waBot.clearSession();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Proper WA logout — sends logout packet to WhatsApp then clears session files
router.post('/whatsapp/logout', requireAdmin, async (req, res) => {
  try {
    const waBot = require('./wa-bot');
    await waBot.logout();
    await waBot.clearSession();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Session file info (for the dedicated session page)
router.get('/whatsapp/session-info', requireAdmin, async (req, res) => {
  try {
    const waBot = require('./wa-bot');
    res.json(waBot.getSessionInfo());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/whatsapp/pairing-code', requireAdmin, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const waBot = require('./wa-bot');
    const code = await waBot.requestPairingCode(phone);
    res.json({ ok: true, code });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/whatsapp/groups', requireAdmin, async (req, res) => {
  try {
    const waBot = require('./wa-bot');
    const groups = await waBot.getGroups();
    res.json(groups);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/whatsapp/test-meta', requireAdmin, async (req, res) => {
  try {
    const { phoneNumberId, accessToken } = req.body;
    if (!phoneNumberId || !accessToken) return res.status(400).json({ error: 'phoneNumberId and accessToken required' });
    const waBot = require('./wa-bot');
    const result = await waBot.testMetaCreds({ phoneNumberId, accessToken });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/whatsapp/broadcast', requireAdmin, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    const db = await getDb();
    const customers = all(db, `SELECT phone, jid FROM customers WHERE blocked=0 AND phone IS NOT NULL AND phone NOT LIKE '%@wa.local' AND phone NOT LIKE '%@imported.local'`);
    const waBot = require('./wa-bot');
    let sent = 0, failed = 0;
    for (const c of customers) {
      const phone = c.phone || c.jid?.split('@')[0];
      if (!phone || !/^\d{7,}$/.test(phone.replace(/\D/g, ''))) { failed++; continue; }
      const ok = await waBot.sendToPhone(phone, message);
      ok ? sent++ : failed++;
      await new Promise(r => setTimeout(r, 200));
    }
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: 'wa_broadcast', after: { sent, failed }, ip: req.ip });
    res.json({ ok: true, sent, failed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/whatsapp/settings', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const keys = ['wa_enabled','wa_transport','wa_meta_phone_number_id','wa_meta_waba_id',
      'wa_meta_app_secret','wa_meta_webhook_verify_token','wa_owner_number','wa_owner_lid',
      'wa_autoreply_enabled','wa_ai_reply_enabled','wa_autopost_enabled','wa_autopost_groups','wa_autopost_interval',
      'wa_autopost_start','wa_autopost_end','wa_daily_summary'];
    const rows = all(db, `SELECT key, value FROM settings WHERE key IN (${keys.map(()=>'?').join(',')})`, keys);
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    // Never return access_token in settings
    const at = get(db, `SELECT value FROM settings WHERE key='wa_meta_access_token'`);
    out.wa_meta_access_token = at?.value ? '••••••••' + String(at.value).slice(-4) : '';
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/whatsapp/settings', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const allowed = ['wa_enabled','wa_transport','wa_meta_phone_number_id','wa_meta_waba_id',
      'wa_meta_app_secret','wa_meta_webhook_verify_token','wa_owner_number','wa_owner_lid',
      'wa_autoreply_enabled','wa_ai_reply_enabled','wa_autopost_enabled','wa_autopost_groups','wa_autopost_interval',
      'wa_autopost_start','wa_autopost_end','wa_daily_summary'];
    for (const k of allowed) {
      if (!(k in req.body)) continue;
      let v = req.body[k];
      // Don't overwrite access_token with masked placeholder
      if (k === 'wa_meta_access_token') {
        if (String(v).startsWith('••••••••')) continue;
        run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`, [k, String(v)]);
        continue;
      }
      run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`, [k, String(v ?? '')]);
    }
    // Access token separate
    if (req.body.wa_meta_access_token && !String(req.body.wa_meta_access_token).startsWith('••••••••')) {
      run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`, ['wa_meta_access_token', req.body.wa_meta_access_token]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/whatsapp/diagnostics', requireAdmin, (req, res) => {
  try {
    const waBot = require('./wa-bot');
    const waWorker = require('./wa-worker');
    res.json({ bot: waBot.getDiagnostics(), worker: waWorker.getDiagnostics() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── WA Offers (group autopost) ───────────────────────────────────────────────
function fetchImageBase64(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? require('https') : require('http');
    lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
    }).on('error', reject);
  });
}

router.get('/wa-offers', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    res.json(all(db, `SELECT id, text, active, last_posted_at, created_at,
      CASE WHEN image_b64 IS NOT NULL THEN 1 ELSE 0 END as has_image,
      (SELECT COUNT(*) FROM wa_offer_log WHERE offer_id=wa_offers.id AND success=1) as times_sent
      FROM wa_offers ORDER BY created_at DESC`));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/wa-offers/:id/image', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const o = get(db, `SELECT image_b64 FROM wa_offers WHERE id=?`, [req.params.id]);
    if (!o?.image_b64) return res.status(404).end();
    const buf = Buffer.from(o.image_b64, 'base64');
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/wa-offers/from-autopost/:campaignId', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const c = get(db, `SELECT * FROM autopost_campaigns WHERE id=?`, [req.params.campaignId]);
    if (!c) return res.status(404).json({ error: 'Campaign not found' });
    let image_b64 = null;
    if (c.image_url) {
      try { image_b64 = await fetchImageBase64(c.image_url); } catch {}
    }
    const r = run(db, `INSERT INTO wa_offers (text, image_b64, active) VALUES (?,?,0)`,
      [c.message, image_b64]);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/wa-offers/:id', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const o = get(db, `SELECT * FROM wa_offers WHERE id=?`, [req.params.id]);
    if (!o) return res.status(404).json({ error: 'Not found' });
    res.json(o);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/wa-offers', requireAdmin, async (req, res) => {
  try {
    const { text, image_b64, active } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });
    const db = await getDb();
    const r = run(db, `INSERT INTO wa_offers (text, image_b64, active) VALUES (?,?,?)`,
      [text, image_b64 || null, active ?? 1]);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/wa-offers/:id', requireAdmin, async (req, res) => {
  try {
    const { text, image_b64, active } = req.body;
    const db = await getDb();
    const existing = get(db, 'SELECT image_b64 FROM wa_offers WHERE id=?', [req.params.id]);
    const img = image_b64 !== undefined ? (image_b64 || null) : existing?.image_b64;
    run(db, `UPDATE wa_offers SET text=?, image_b64=?, active=? WHERE id=?`,
      [text, img, active ?? 1, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/wa-offers/:id', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    run(db, `DELETE FROM wa_offers WHERE id=?`, [req.params.id]);
    run(db, `DELETE FROM wa_offer_log WHERE offer_id=?`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/wa-offers/:id/post-now', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const offer = get(db, `SELECT * FROM wa_offers WHERE id=?`, [req.params.id]);
    if (!offer) return res.status(404).json({ error: 'Offer not found' });
    const waBot = require('./wa-bot');
    const sock = waBot.getActiveSock();
    if (!sock) return res.status(400).json({ error: 'WhatsApp not connected' });
    const groups = JSON.parse(get(db, `SELECT value FROM settings WHERE key='wa_autopost_groups'`)?.value || '[]');
    if (!groups.length) return res.status(400).json({ error: 'No groups selected in WA settings' });
    let sent = 0;
    for (const gid of groups) {
      try {
        if (offer.image_b64) {
          await sock.sendMessage(gid, { image: Buffer.from(offer.image_b64, 'base64'), caption: offer.text });
        } else {
          await sock.sendMessage(gid, { text: offer.text });
        }
        db.run(`INSERT INTO wa_offer_log (offer_id, group_id, success) VALUES (?,?,1)`, [offer.id, gid]);
        sent++;
        await new Promise(r => setTimeout(r, 1500));
      } catch (e2) {
        db.run(`INSERT INTO wa_offer_log (offer_id, group_id, success, error) VALUES (?,?,0,?)`, [offer.id, gid, e2.message]);
      }
    }
    db.run(`UPDATE wa_offers SET last_posted_at=datetime('now') WHERE id=?`, [offer.id]);
    res.json({ ok: true, sent, total: groups.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/wa-offers/:id/logs', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    res.json(all(db, `SELECT * FROM wa_offer_log WHERE offer_id=? ORDER BY sent_at DESC LIMIT 200`, [req.params.id]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Suppliers ────────────────────────────────────────────────────────────────
router.get('/suppliers', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    res.json(all(db, `SELECT * FROM suppliers ORDER BY name ASC`));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/suppliers', requireAdmin, async (req, res) => {
  try {
    const { name, phone, product_ids, active, notes } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'name and phone required' });
    const db = await getDb();
    const r = run(db, `INSERT INTO suppliers (name,phone,product_ids,active,notes) VALUES (?,?,?,?,?)`,
      [name, phone, JSON.stringify(product_ids || []), active ?? 1, notes || null]);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/suppliers/:id', requireAdmin, async (req, res) => {
  try {
    const { name, phone, product_ids, active, notes } = req.body;
    const db = await getDb();
    run(db, `UPDATE suppliers SET name=?,phone=?,product_ids=?,active=?,notes=? WHERE id=?`,
      [name, phone, JSON.stringify(product_ids || []), active ?? 1, notes || null, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/suppliers/:id', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    run(db, `DELETE FROM suppliers WHERE id=?`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/suppliers/:id/notify', requireAdmin, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    const db = await getDb();
    const sup = get(db, `SELECT * FROM suppliers WHERE id=?`, [req.params.id]);
    if (!sup) return res.status(404).json({ error: 'Supplier not found' });
    const waBot = require('./wa-bot');
    const ok = await waBot.sendToPhone(sup.phone, message);
    res.json({ ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── AI Agent Settings ────────────────────────────────────────────────────────
router.get('/ai-settings', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const keys = ['ai_enabled','ai_provider','ai_model','ai_persona','ai_daily_cap','ai_fallback_message'];
    const rows = all(db, `SELECT key, value FROM settings WHERE key IN (${keys.map(()=>'?').join(',')})`, keys);
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    const ak = get(db, `SELECT value FROM settings WHERE key='ai_api_key'`);
    out.ai_api_key = ak?.value ? '••••••••' + String(ak.value).slice(-4) : '';
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/ai-settings', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const allowed = ['ai_enabled','ai_provider','ai_model','ai_persona','ai_daily_cap','ai_fallback_message'];
    for (const k of allowed) {
      if (k in req.body) run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`, [k, String(req.body[k] ?? '')]);
    }
    if (req.body.ai_api_key && !String(req.body.ai_api_key).startsWith('••••••••')) {
      run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`, ['ai_api_key', req.body.ai_api_key]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Order enhancements ───────────────────────────────────────────────────────
router.post('/orders/:id/resend-email', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const order = get(db, `SELECT o.*, p.name as plan_name, p.platform, c.email, c.name as cname
                           FROM orders o LEFT JOIN plans p ON o.plan_id=p.id LEFT JOIN customers c ON o.customer_jid=c.jid
                           WHERE o.id=?`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!order.email) return res.status(400).json({ error: 'Customer has no email address' });
    const creds = order.credentials ? (typeof order.credentials === 'string' ? JSON.parse(order.credentials) : order.credentials) : {};
    await sendOrderDelivery(order.email, order.cname, order, creds);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/orders/:id/wa-deliver', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const order = get(db, `SELECT o.*, c.phone, c.name as cname FROM orders o LEFT JOIN customers c ON o.customer_jid=c.jid WHERE o.id=?`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const phone = order.phone || order.customer_jid?.split('@')[0];
    if (!phone || !/^\d{7,}$/.test(phone.replace(/\D/g, ''))) return res.status(400).json({ error: 'No valid phone number for this customer' });
    const creds = order.credentials ? (typeof order.credentials === 'string' ? JSON.parse(order.credentials) : order.credentials) : {};
    const credsText = Object.entries(creds).filter(([k]) => !['line1','line2'].includes(k))
      .map(([k,v]) => `  *${k.charAt(0).toUpperCase()+k.slice(1)}:* ${v}`).join('\n') || Object.values(creds).join(' / ') || '(no credentials)';
    const waBot = require('./wa-bot');
    const msg = `✅ *Order Delivered!*\n\n📦 *${order.plan_name||'Subscription'}*\n🆔 Order: #${order.id}\n\n🔑 *Credentials:*\n${credsText}\n\n_Keep safe. Do not share._`;
    const ok = await waBot.sendToPhone(phone, msg);
    if (!ok) throw new Error('WhatsApp send failed — check connection');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── WA Offer clone ───────────────────────────────────────────────────────────
router.post('/wa-offers/:id/clone', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const o = get(db, 'SELECT * FROM wa_offers WHERE id=?', [req.params.id]);
    if (!o) return res.status(404).json({ error: 'Offer not found' });
    const r = run(db, `INSERT INTO wa_offers (text, image_b64, active) VALUES (?,?,0)`, [o.text + ' (copy)', o.image_b64 || null]);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Email Accounts ───────────────────────────────────────────────────────────
router.get('/email-accounts', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const accounts = all(db, 'SELECT id,label,host,port,user,from_name,active,created_at FROM email_accounts ORDER BY id ASC');
    res.json(accounts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/email-accounts', requireAdmin, async (req, res) => {
  try {
    const { label, host, port, secure, user, app_password, from_name, active } = req.body;
    if (!label || !user || !app_password) return res.status(400).json({ error: 'label, user and app_password required' });
    const db = await getDb();
    const r = run(db, `INSERT INTO email_accounts (label,host,port,secure,user,app_password,from_name,active) VALUES (?,?,?,?,?,?,?,?)`,
      [label, host || 'smtp.gmail.com', port || 587, secure ? 1 : 0, user, app_password, from_name || '', active !== false ? 1 : 0]);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/email-accounts/:id', requireAdmin, async (req, res) => {
  try {
    const { label, host, port, secure, user, app_password, from_name, active } = req.body;
    const db = await getDb();
    const ex = get(db, 'SELECT * FROM email_accounts WHERE id=?', [req.params.id]);
    if (!ex) return res.status(404).json({ error: 'Account not found' });
    const pw = app_password && !String(app_password).startsWith('••••') ? app_password : ex.app_password;
    run(db, `UPDATE email_accounts SET label=?,host=?,port=?,secure=?,user=?,app_password=?,from_name=?,active=? WHERE id=?`,
      [label ?? ex.label, host ?? ex.host, port ?? ex.port, secure !== undefined ? (secure ? 1 : 0) : ex.secure,
       user ?? ex.user, pw, from_name ?? ex.from_name, active !== undefined ? (active ? 1 : 0) : ex.active, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/email-accounts/:id', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    run(db, 'DELETE FROM email_accounts WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/email-accounts/:id/test', requireAdmin, async (req, res) => {
  try {
    const { testAccount } = require('./email-marketing');
    const result = await testAccount(parseInt(req.params.id));
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Email Templates ──────────────────────────────────────────────────────────
router.get('/email-templates', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const cat = req.query.category;
    const sql = cat
      ? `SELECT id,name,category,subject,is_system,created_at FROM email_templates WHERE category=? ORDER BY is_system DESC, name ASC`
      : `SELECT id,name,category,subject,is_system,created_at FROM email_templates ORDER BY is_system DESC, category ASC, name ASC`;
    res.json(cat ? all(db, sql, [cat]) : all(db, sql));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/email-templates/:id', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const t = get(db, 'SELECT * FROM email_templates WHERE id=?', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Template not found' });
    res.json(t);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/email-templates', requireAdmin, async (req, res) => {
  try {
    const { name, category, subject, html } = req.body;
    if (!name || !subject || !html) return res.status(400).json({ error: 'name, subject and html required' });
    const db = await getDb();
    const r = run(db, `INSERT INTO email_templates (name,category,subject,html,is_system) VALUES (?,?,?,?,0)`,
      [name, category || 'general', subject, html]);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/email-templates/:id', requireAdmin, async (req, res) => {
  try {
    const { name, category, subject, html } = req.body;
    const db = await getDb();
    run(db, `UPDATE email_templates SET name=?,category=?,subject=?,html=? WHERE id=?`,
      [name, category || 'general', subject, html, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/email-templates/:id', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    run(db, 'DELETE FROM email_templates WHERE id=? AND is_system=0', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Email Campaigns ──────────────────────────────────────────────────────────
router.get('/email-campaigns', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const camps = all(db, `SELECT ec.*, ea.label as account_label, ea.user as account_email FROM email_campaigns ec LEFT JOIN email_accounts ea ON ec.account_id=ea.id ORDER BY ec.created_at DESC LIMIT 100`);
    res.json(camps);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/email-campaigns', requireAdmin, async (req, res) => {
  try {
    const { name, subject, html, account_id, target, custom_emails } = req.body;
    if (!name || !subject || !html) return res.status(400).json({ error: 'name, subject and html required' });
    const db = await getDb();
    const r = run(db, `INSERT INTO email_campaigns (name,subject,html,account_id,target,custom_emails) VALUES (?,?,?,?,?,?)`,
      [name, subject, html, account_id || null, target || 'all', custom_emails || null]);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/email-campaigns/:id', requireAdmin, async (req, res) => {
  try {
    const { name, subject, html, account_id, target, custom_emails } = req.body;
    const db = await getDb();
    run(db, `UPDATE email_campaigns SET name=?,subject=?,html=?,account_id=?,target=?,custom_emails=? WHERE id=? AND status IN ('draft','sent','failed')`,
      [name, subject, html, account_id || null, target || 'all', custom_emails || null, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/email-campaigns/:id', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    run(db, `DELETE FROM email_campaigns WHERE id=? AND status != 'sending'`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/email-campaigns/:id/send', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const camp = get(db, 'SELECT status FROM email_campaigns WHERE id=?', [req.params.id]);
    if (!camp) return res.status(404).json({ error: 'Campaign not found' });
    if (camp.status === 'sending') return res.status(400).json({ error: 'Campaign is already sending' });
    const { sendCampaignEmail } = require('./email-marketing');
    // Run async, respond immediately
    sendCampaignEmail(parseInt(req.params.id)).catch(e => {
      const db2 = require('./db').getDb ? null : null;
      getDb().then(db2 => run(db2, `UPDATE email_campaigns SET status='failed' WHERE id=?`, [req.params.id])).catch(() => {});
    });
    res.json({ ok: true, message: 'Campaign started — check progress in campaigns list' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/email-campaigns/:id/duplicate', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const c = get(db, 'SELECT * FROM email_campaigns WHERE id=?', [req.params.id]);
    if (!c) return res.status(404).json({ error: 'Campaign not found' });
    const r = run(db, `INSERT INTO email_campaigns (name,subject,html,account_id,target,custom_emails) VALUES (?,?,?,?,?,?)`,
      [c.name + ' (copy)', c.subject, c.html, c.account_id, c.target, c.custom_emails]);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PWA Settings ─────────────────────────────────────────────────────────────
router.get('/pwa-settings', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const keys = ['pwa_name','pwa_short_name','pwa_description','pwa_theme_color','pwa_bg_color','pwa_icon_b64','pwa_force_prompt','vapid_public_key'];
    const rows = all(db, `SELECT key, value FROM settings WHERE key IN (${keys.map(()=>'?').join(',')})`, keys);
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    // subscription count
    const subCount = get(db, 'SELECT COUNT(*) as c FROM push_subscriptions');
    out.subscription_count = subCount?.c || 0;
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/pwa-settings', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const allowed = ['pwa_name','pwa_short_name','pwa_description','pwa_theme_color','pwa_bg_color','pwa_icon_b64','pwa_force_prompt'];
    for (const k of allowed) {
      if (k in req.body) run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`, [k, String(req.body[k] ?? '')]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/pwa-settings/generate-vapid', requireAdmin, async (req, res) => {
  try {
    const webpush = require('web-push');
    const keys = webpush.generateVAPIDKeys();
    const db = await getDb();
    run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES ('vapid_public_key',?)`, [keys.publicKey]);
    run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES ('vapid_private_key',?)`, [keys.privateKey]);
    const sub = req.body.subject || await getSetting('vapid_subject') || 'mailto:admin@example.com';
    run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES ('vapid_subject',?)`, [sub]);
    res.json({ ok: true, publicKey: keys.publicKey });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Store Theme ──────────────────────────────────────────────────────────────
router.get('/store-theme', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const row = get(db, `SELECT value FROM settings WHERE key='store_theme'`, []);
    res.json({ theme: row ? row.value : 'midnight-purple' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/store-theme', requireAdmin, async (req, res) => {
  try {
    const { theme } = req.body;
    if (!theme || typeof theme !== 'string') return res.status(400).json({ error: 'theme required' });
    const db = await getDb();
    run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES ('store_theme',?)`, [theme]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Push Subscriptions (public endpoint called by SW) ───────────────────────
router.post('/push-subscribe', async (req, res) => {
  try {
    const { endpoint, p256dh, auth } = req.body;
    if (!endpoint || !p256dh || !auth) return res.status(400).json({ error: 'endpoint, p256dh and auth required' });
    const db = await getDb();
    run(db, `INSERT OR REPLACE INTO push_subscriptions (endpoint,p256dh,auth,user_agent) VALUES (?,?,?,?)`,
      [endpoint, p256dh, auth, req.headers['user-agent']?.slice(0,200) || '']);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/push-subscriptions', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    res.json(all(db, 'SELECT id,endpoint,user_agent,created_at FROM push_subscriptions ORDER BY created_at DESC LIMIT 500'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/push-subscriptions/:id', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    run(db, 'DELETE FROM push_subscriptions WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/push-notifications/send', requireAdmin, async (req, res) => {
  try {
    const { title, body, icon, url } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const db = await getDb();
    const pubKey = await getSetting('vapid_public_key');
    const privKey = await getSetting('vapid_private_key');
    const subject = await getSetting('vapid_subject') || 'mailto:admin@example.com';
    if (!pubKey || !privKey) return res.status(400).json({ error: 'VAPID keys not configured — generate them in PWA settings first' });
    const webpush = require('web-push');
    webpush.setVapidDetails(subject, pubKey, privKey);
    const subs = all(db, 'SELECT * FROM push_subscriptions');
    const payload = JSON.stringify({ title, body: body || '', icon: icon || '/icon-192.png', url: url || '/' });
    const siteName = await getSetting('site_name') || 'OTT Store';
    let success = 0, failed = 0;
    for (const sub of subs) {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
        success++;
      } catch (e2) {
        failed++;
        if (e2.statusCode === 410) run(db, 'DELETE FROM push_subscriptions WHERE id=?', [sub.id]);
      }
    }
    run(db, `INSERT INTO push_notifications (title,body,icon,url,total,success_count) VALUES (?,?,?,?,?,?)`,
      [title, body || '', icon || '', url || '', subs.length, success]);
    res.json({ ok: true, total: subs.length, success, failed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/push-notifications', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    res.json(all(db, 'SELECT * FROM push_notifications ORDER BY sent_at DESC LIMIT 100'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API Channels ─────────────────────────────────────────────────────────────
router.get('/api-channels', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const rows = all(db, `SELECT id, label, type, url, model, active, notes, created_at FROM api_channels ORDER BY id ASC`);
    // mask key: show only last 8 chars
    const full = all(db, `SELECT id, api_key FROM api_channels`);
    const keyMap = {};
    full.forEach(r => { keyMap[r.id] = r.api_key ? '••••••••' + String(r.api_key).slice(-8) : ''; });
    rows.forEach(r => { r.api_key = keyMap[r.id] || ''; });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api-channels', requireAdmin, async (req, res) => {
  try {
    const { label, type, url, api_key, model, active, notes } = req.body;
    if (!label || !url || !api_key) return res.status(400).json({ error: 'label, url and api_key required' });
    const db = await getDb();
    run(db, `INSERT INTO api_channels (label,type,url,api_key,model,active,notes) VALUES (?,?,?,?,?,?,?)`,
      [label, type||'newapi_channel_conn', url, api_key, model||'gpt-4o-mini', active??1, notes||'']);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/api-channels/:id', requireAdmin, async (req, res) => {
  try {
    const { label, type, url, api_key, model, active, notes } = req.body;
    const db = await getDb();
    const existing = get(db, `SELECT api_key FROM api_channels WHERE id=?`, [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const finalKey = (api_key && !String(api_key).startsWith('••••••••')) ? api_key : existing.api_key;
    run(db, `UPDATE api_channels SET label=?,type=?,url=?,api_key=?,model=?,active=?,notes=? WHERE id=?`,
      [label, type||'newapi_channel_conn', url, finalKey, model||'gpt-4o-mini', active??1, notes||'', req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/api-channels/:id', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    run(db, `DELETE FROM api_channels WHERE id=?`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api-channels/:id/test', requireAdmin, async (req, res) => {
  try {
    const { testChannel } = require('./ai');
    const result = await testChannel(+req.params.id);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api-channels/:id/set-active', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    run(db, `UPDATE api_channels SET active=0`);
    run(db, `UPDATE api_channels SET active=1 WHERE id=?`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── AI Chat (admin test — includes full store context) ──────────────────────
router.post('/ai/chat', requireAdmin, async (req, res) => {
  try {
    const { messages, model, max_tokens } = req.body;
    if (!messages?.length) return res.status(400).json({ error: 'messages required' });
    const db = await getDb();
    const { chat, buildStoreSystemPrompt } = require('./ai');
    const systemPrompt = await buildStoreSystemPrompt(db);
    const reply = await chat(messages, { model, max_tokens, _systemOverride: systemPrompt });
    res.json({ reply });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Fulfillment ──────────────────────────────────────────────────────────────
router.get('/fulfillment', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const { status } = req.query;
    const where = status && status !== 'all' ? `WHERE fj.status=?` : '';
    const params = status && status !== 'all' ? [status] : [];
    const jobs = all(db, `
      SELECT fj.*, o.amount_inr, o.created_at as order_created,
             c.name as customer_name, c.email as customer_email,
             p.name as plan_name, p.platform, p.provider_product_id as plan_pid
      FROM fulfillment_jobs fj
      LEFT JOIN orders o ON fj.order_id = o.id
      LEFT JOIN customers c ON fj.customer_jid = c.jid
      LEFT JOIN plans p ON fj.plan_id = p.id
      ${where}
      ORDER BY fj.created_at DESC LIMIT 200`, params);
    res.json(jobs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/fulfillment/stats', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const rows = all(db, `SELECT status, COUNT(*) as count FROM fulfillment_jobs GROUP BY status`);
    const stats = {};
    rows.forEach(r => { stats[r.status] = r.count; });
    stats.total = rows.reduce((s, r) => s + r.count, 0);
    res.json(stats);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/fulfillment/:id/status', requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const allowed = ['pending', 'manual_review', 'cancelled'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const db = await getDb();
    run(db, `UPDATE fulfillment_jobs SET status=? WHERE id=?`, [status, req.params.id]);
    if (status === 'cancelled') {
      const job = get(db, `SELECT order_id FROM fulfillment_jobs WHERE id=?`, [req.params.id]);
      if (job) run(db, `UPDATE orders SET status='cancelled' WHERE id=?`, [job.order_id]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/fulfillment/retry/:id', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    run(db, `UPDATE fulfillment_jobs SET status='pending', attempt_count=0, error_msg=NULL WHERE id=?`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ResellKeys settings ──────────────────────────────────────────────────────
router.get('/fulfillment-settings', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const keys = ['fulfillment_enabled','resellkeys_api_url','resellkeys_api_key','resellkeys_email','resellkeys_password','fulfillment_poll_interval','profit_pct','usd_to_inr_rate'];
    const rows = all(db, `SELECT key,value FROM settings WHERE key IN (${keys.map(()=>'?').join(',')})`, keys);
    const s = {};
    rows.forEach(r => s[r.key] = r.value);
    if (s.resellkeys_api_key) s.resellkeys_api_key = '••••••••' + String(s.resellkeys_api_key).slice(-8);
    if (s.resellkeys_password) s.resellkeys_password = '••••••••';
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/fulfillment-settings', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const plain = ['fulfillment_enabled','resellkeys_api_url','resellkeys_email','fulfillment_poll_interval','profit_pct','usd_to_inr_rate'];
    for (const k of plain) {
      if (k in req.body) run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`, [k, String(req.body[k]??'')]);
    }
    if (req.body.resellkeys_api_key && !String(req.body.resellkeys_api_key).startsWith('••••')) {
      run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`, ['resellkeys_api_key', req.body.resellkeys_api_key]);
    }
    if (req.body.resellkeys_password && req.body.resellkeys_password !== '••••••••') {
      run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`, ['resellkeys_password', req.body.resellkeys_password]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Bulk plan actions ────────────────────────────────────────────────────────
router.post('/plans/bulk-action', requireAdmin, async (req, res) => {
  try {
    const { action, ids, category, profit_pct, usd_to_inr_rate } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });
    const db = await getDb();
    const ph = ids.map(() => '?').join(',');
    let affected = 0;
    if (action === 'activate') {
      db.run(`UPDATE plans SET active=1 WHERE id IN (${ph})`, ids);
      affected = ids.length;
    } else if (action === 'deactivate') {
      db.run(`UPDATE plans SET active=0 WHERE id IN (${ph})`, ids);
      affected = ids.length;
    } else if (action === 'delete') {
      db.run(`DELETE FROM plans WHERE id IN (${ph})`, ids);
      affected = ids.length;
    } else if (action === 'set-category') {
      if (!category) return res.status(400).json({ error: 'category required' });
      db.run(`UPDATE plans SET category=? WHERE id IN (${ph})`, [category, ...ids]);
      affected = ids.length;
    } else if (action === 'apply-markup') {
      const rate = parseFloat(usd_to_inr_rate) || 84;
      const pct = parseFloat(profit_pct) || 0;
      const plans = all(db, `SELECT id, price_usd FROM plans WHERE id IN (${ph}) AND price_usd > 0`, ids);
      for (const p of plans) {
        const inr = Math.ceil(p.price_usd * rate * (1 + pct / 100));
        db.run('UPDATE plans SET price_inr=? WHERE id=?', [inr, p.id]);
        affected++;
      }
    } else if (action === 'set-image-url') {
      const { image_url } = req.body;
      if (!image_url) return res.status(400).json({ error: 'image_url required' });
      db.run(`UPDATE plans SET image_url=? WHERE id IN (${ph})`, [image_url, ...ids]);
      affected = ids.length;
    } else if (action === 'auto-logo') {
      const plans = all(db, `SELECT id, platform, name FROM plans WHERE id IN (${ph})`, ids);
      for (const p of plans) {
        const term = (p.platform || p.name || '').toLowerCase().replace(/\s+/g, '');
        const url = `https://logo.clearbit.com/${term}.com`;
        db.run('UPDATE plans SET image_url=? WHERE id=?', [url, p.id]);
        affected++;
      }
    } else {
      return res.status(400).json({ error: 'Unknown action' });
    }
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: `bulk_${action}`, after: { affected, ids }, ip: req.ip });
    res.json({ ok: true, affected });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Sync ResellKeys prices ───────────────────────────────────────────────────
router.post('/plans/sync-resellkeys-prices', requireAdmin, async (req, res) => {
  try {
    const { profit_pct, usd_to_inr_rate } = req.body;
    const rate = parseFloat(usd_to_inr_rate) || 84;
    const pct = parseFloat(profit_pct) || 0;
    const db = await getDb();
    const { scrapeResellKeysProducts } = require('./fulfillment-worker');
    const products = await scrapeResellKeysProducts(db, '');
    if (!products.length) return res.status(400).json({ error: 'No products returned from ResellKeys. Check credentials.' });
    const byId = {};
    for (const p of products) { if (p.provider_product_id) byId[p.provider_product_id] = p; }
    const plans = all(db, `SELECT id, provider_product_id, price_usd FROM plans WHERE provider_api='resellkeys' AND provider_product_id != ''`);
    let updated = 0;
    for (const plan of plans) {
      const rk = byId[plan.provider_product_id];
      const usd = rk ? parseFloat(rk.price_usd || 0) : parseFloat(plan.price_usd || 0);
      if (!usd) continue;
      const inr = Math.ceil(usd * rate * (1 + pct / 100));
      db.run('UPDATE plans SET price_inr=?, price_usd=? WHERE id=?', [inr, usd, plan.id]);
      updated++;
    }
    res.json({ ok: true, updated, total: plans.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Scrape ResellKeys products ───────────────────────────────────────────────
router.post('/plans/scrape-resellkeys', requireAdmin, async (req, res) => {
  try {
    const { query } = req.body;
    const db = await getDb();
    const { scrapeResellKeysProducts } = require('./fulfillment-worker');
    const products = await scrapeResellKeysProducts(db, query || '');
    res.json({ products, count: products.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/plans/import-scraped', requireAdmin, async (req, res) => {
  try {
    const { products } = req.body;
    if (!Array.isArray(products)) return res.status(400).json({ error: 'products array required' });
    const db = await getDb();
    let imported = 0;
    for (const p of products) {
      if (!p.name) continue;
      run(db, `INSERT INTO plans (platform,name,duration_days,price_inr,price_usd,description,category,image_url,provider_api,provider_product_id,delivery_type,active,stock)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,1,-1)`,
        [p.platform||p.category||'Other', p.name,
         p.duration_days||null, p.price_inr||Math.round((p.price_usd||0)*83),
         p.price_usd||0, p.description||'',
         p.category||'', p.image_url||'',
         'resellkeys', p.provider_product_id||'',
         p.delivery_type||'auto']);
      imported++;
    }
    res.json({ ok: true, imported });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Autopost settings (hours) ────────────────────────────────────────────────
router.get('/autopost-settings', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const keys = ['autopost_enabled','autopost_start_hour','autopost_end_hour'];
    const rows = all(db, `SELECT key,value FROM settings WHERE key IN (${keys.map(()=>'?').join(',')})`, keys);
    const s = {};
    rows.forEach(r => s[r.key] = r.value);
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/autopost-settings', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const allowed = ['autopost_enabled','autopost_start_hour','autopost_end_hour'];
    for (const k of allowed) {
      if (k in req.body) run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`, [k, String(req.body[k]??'')]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Chat Bot Settings ────────────────────────────────────────────────────────
router.get('/bot-settings', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const keys = ['bot_enabled','bot_name','bot_tagline','bot_avatar','bot_accent','bot_greeting','bot_system_prompt'];
    const rows = all(db, `SELECT key,value FROM settings WHERE key IN (${keys.map(()=>'?').join(',')})`, keys);
    const s = {};
    rows.forEach(r => s[r.key] = r.value);
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/bot-settings', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const allowed = ['bot_enabled','bot_name','bot_tagline','bot_avatar','bot_accent','bot_greeting','bot_system_prompt'];
    for (const k of allowed) {
      if (k in req.body) run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`, [k, String(req.body[k] ?? '')]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ─── Support Team Contacts ────────────────────────────────────────────────────
router.get('/contact-team', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const row = get(db, `SELECT value FROM settings WHERE key='contact_team'`);
    let team = [];
    try { team = JSON.parse(row?.value || '[]'); } catch {}
    if (!Array.isArray(team)) team = [];
    res.json({ team });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/contact-team', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    let team = req.body.team;
    if (!Array.isArray(team)) return res.status(400).json({ error: 'team must be array' });
    team = team.map(c => ({
      name:  String(c.name  || '').trim().slice(0, 80),
      role:  String(c.role  || 'Support').trim().slice(0, 40),
      phone: String(c.phone || '').replace(/[^0-9]/g, '').slice(0, 15),
    })).filter(c => c.phone.length >= 7);
    run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES ('contact_team',?)`, [JSON.stringify(team)]);
    res.json({ ok: true, team });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Check auth status ────────────────────────────────────────────────────────
router.get('/me', requireAdmin, (req, res) => res.json({ ok: true, role: 'admin' }));

// ─── Cross-origin WA offer batch import (one-time use, token auth) ───────────
const WA_IMPORT_TOKEN = 'ott24x7-wa-import-2025';

router.options('/wa-offers-batch-import', (req, res) => {
  res.set('Access-Control-Allow-Origin', 'https://store.watshop.in');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Import-Token');
  res.set('Access-Control-Allow-Methods', 'POST');
  res.status(204).end();
});

router.post('/wa-offers-batch-import', async (req, res) => {
  res.set('Access-Control-Allow-Origin', 'https://store.watshop.in');
  if (req.headers['x-import-token'] !== WA_IMPORT_TOKEN) {
    return res.status(401).json({ error: 'Invalid import token' });
  }
  const { offers } = req.body;
  if (!Array.isArray(offers) || !offers.length) {
    return res.status(400).json({ error: 'offers[] required' });
  }
  try {
    const db = await getDb();
    let created = 0;
    for (const o of offers) {
      if (!o.text) continue;
      try {
        run(db, `INSERT INTO wa_offers (text, image_b64, active) VALUES (?,?,0)`,
          [o.text, o.image_b64 || null]);
        created++;
      } catch {}
    }
    res.json({ ok: true, created });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
