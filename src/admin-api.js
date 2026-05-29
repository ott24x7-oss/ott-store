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
const { sendOrderDelivery, sendMail } = require('./mailer');

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

// ─── Check auth status ────────────────────────────────────────────────────────
router.get('/me', requireAdmin, (req, res) => res.json({ ok: true, role: 'admin' }));

module.exports = router;
