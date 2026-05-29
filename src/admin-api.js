'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const cfg = require('./config');
const { getDb, getSetting, setSetting, all, get, run } = require('./db');
const { loginLimiter, checkCredentialThrottle, recordFailedLogin, clearFailedLogin } = require('./security');
const { audit } = require('./audit');
const { submitUrls, pingSitemap } = require('./google-index');
const { sendOrderDelivery } = require('./mailer');

const router = express.Router();

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
    const { platform, name, duration_days, price_inr, original_price_inr, description, features, badge, stock, active, sort_order } = req.body;
    if (!platform || !name) return res.status(400).json({ error: 'Platform and name required' });
    const db = await getDb();
    const r = run(db,
      `INSERT INTO plans (platform,name,duration_days,price_inr,original_price_inr,description,features,badge,stock,active,sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [platform, name, duration_days || null, price_inr || 0, original_price_inr || null,
       description || null, JSON.stringify(features || []), badge || null,
       stock ?? -1, active ?? 1, sort_order || 0]);
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: 'create_plan', targetKind: 'plan', targetId: r.lastInsertRowid, after: req.body, ip: req.ip });
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/plans/:id', requireAdmin, async (req, res) => {
  try {
    const { platform, name, duration_days, price_inr, original_price_inr, description, features, badge, stock, active, sort_order } = req.body;
    const db = await getDb();
    run(db,
      `UPDATE plans SET platform=?,name=?,duration_days=?,price_inr=?,original_price_inr=?,
       description=?,features=?,badge=?,stock=?,active=?,sort_order=? WHERE id=?`,
      [platform, name, duration_days || null, price_inr || 0, original_price_inr || null,
       description || null, JSON.stringify(features || []), badge || null,
       stock ?? -1, active ?? 1, sort_order || 0, req.params.id]);
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
      run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`, [k, String(v)]);
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

module.exports = router;
