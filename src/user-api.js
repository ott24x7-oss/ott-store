'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cfg = require('./config');
const { getDb, getSetting, all, get, run } = require('./db');
const { loginLimiter, registerLimiter, checkCredentialThrottle, recordFailedLogin, clearFailedLogin } = require('./security');
const { audit } = require('./audit');
const { sendPasswordReset, sendOrderDelivery } = require('./mailer');

const router = express.Router();

// multer for UPI screenshot uploads
fs.mkdirSync(cfg.uploadDir, { recursive: true });
const upload = multer({
  dest: cfg.uploadDir,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images allowed'));
  },
});

// --- Auth middleware ---
function requireCustomer(req, res, next) {
  const token = req.cookies?.customerToken;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.customer = jwt.verify(token, cfg.sessionSecret);
    next();
  } catch { res.status(401).json({ error: 'Session expired' }); }
}

function setCustomerCookie(res, payload) {
  const token = jwt.sign(payload, cfg.sessionSecret, { expiresIn: cfg.jwtExpiry });
  res.cookie('customerToken', token, { ...cfg.cookieOptions, maxAge: 7 * 24 * 60 * 60 * 1000 });
  return token;
}

// --- helpers ---
async function getCustomer(jid) {
  const db = await getDb();
  return get(db, 'SELECT * FROM customers WHERE jid=?', [jid]);
}

function toJid(email) {
  return email.toLowerCase().trim().replace('@', '_at_') + '@email.local';
}

function creditWallet(db, jid, amount, type, label, refId) {
  run(db, `UPDATE customers SET wallet_inr = wallet_inr + ? WHERE jid=?`, [amount, jid]);
  run(db, `INSERT INTO wallet_txns (customer_jid,amount_inr,type,label,ref_id) VALUES (?,?,?,?,?)`,
    [jid, amount, type, label, refId || null]);
}

function debitWallet(db, jid, amount, type, label, refId) {
  run(db, `UPDATE customers SET wallet_inr = wallet_inr - ? WHERE jid=?`, [amount, jid]);
  run(db, `INSERT INTO wallet_txns (customer_jid,amount_inr,type,label,ref_id) VALUES (?,?,?,?,?)`,
    [jid, -amount, type, label, refId || null]);
}

// ─── Store info (public, no auth) ────────────────────────────────────────────
router.get('/store', async (req, res) => {
  try {
    const db = await getDb();
    const rows = all(db, `SELECT key, value FROM settings WHERE key IN
      ('site_name','site_tagline','logo_url','announcement','upi_id','upi_name',
       'razorpay_enabled','upi_manual_enabled','support_whatsapp','support_email')`, []);
    const s = {};
    rows.forEach(r => s[r.key] = r.value);
    s.razorpay_key = s.razorpay_enabled === '1' ? cfg.razorpay.keyId : '';
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Public plans ─────────────────────────────────────────────────────────────
router.get('/plans', async (req, res) => {
  try {
    const db = await getDb();
    let sql = `SELECT * FROM plans WHERE active=1`;
    const params = [];
    if (req.query.platform) { sql += ` AND platform=?`; params.push(req.query.platform); }
    sql += ` ORDER BY sort_order ASC, id ASC`;
    const plans = all(db, sql, params);
    plans.forEach(p => { try { p.features = JSON.parse(p.features || '[]'); } catch { p.features = []; } });
    res.json(plans);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Register ─────────────────────────────────────────────────────────────────
router.post('/register', registerLimiter, async (req, res) => {
  try {
    const { name, email, password, phone, referral_code } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const jid = toJid(email);
    const db = await getDb();
    const existing = get(db, 'SELECT jid FROM customers WHERE jid=?', [jid]);
    if (existing) return res.status(409).json({ error: 'Email already registered' });
    const hash = await bcrypt.hash(password, cfg.bcryptRounds);
    const refCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    let referredBy = null;
    if (referral_code) {
      const ref = get(db, 'SELECT jid FROM customers WHERE referral_code=?', [referral_code.trim().toUpperCase()]);
      if (ref) referredBy = ref.jid;
    }
    run(db, `INSERT INTO customers (jid,name,email,phone,password_hash,referral_code,referred_by) VALUES (?,?,?,?,?,?,?)`,
      [jid, name.trim(), email.toLowerCase().trim(), phone || null, hash, refCode, referredBy]);
    setCustomerCookie(res, { jid, email: email.toLowerCase().trim(), name: name.trim() });
    await audit({ actorKind: 'customer', actorLabel: email, action: 'register', targetKind: 'customer', targetId: jid, ip: req.ip });
    res.json({ ok: true, name: name.trim(), email: email.toLowerCase().trim() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Login ────────────────────────────────────────────────────────────────────
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const throttleMsg = checkCredentialThrottle(email.toLowerCase());
    if (throttleMsg) return res.status(429).json({ error: throttleMsg });
    const jid = toJid(email);
    const db = await getDb();
    const customer = get(db, 'SELECT * FROM customers WHERE jid=?', [jid]);
    if (!customer || !customer.password_hash) {
      recordFailedLogin(email.toLowerCase());
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (customer.blocked) return res.status(403).json({ error: 'Account blocked. Contact support.' });
    const ok = await bcrypt.compare(password, customer.password_hash);
    if (!ok) {
      recordFailedLogin(email.toLowerCase());
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    clearFailedLogin(email.toLowerCase());
    run(db, `UPDATE customers SET last_login_at=datetime('now') WHERE jid=?`, [jid]);
    setCustomerCookie(res, { jid, email: customer.email, name: customer.name });
    await audit({ actorKind: 'customer', actorLabel: customer.email, action: 'login', targetKind: 'customer', targetId: jid, ip: req.ip });
    res.json({ ok: true, name: customer.name, email: customer.email });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Logout ───────────────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie('customerToken', { path: '/' });
  res.json({ ok: true });
});

// ─── Me ───────────────────────────────────────────────────────────────────────
router.get('/me', requireCustomer, async (req, res) => {
  try {
    const c = await getCustomer(req.customer.jid);
    if (!c) return res.status(404).json({ error: 'Customer not found' });
    const { password_hash, ...safe } = c;
    res.json(safe);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/me', requireCustomer, async (req, res) => {
  try {
    const { name, email, phone, password, current_password } = req.body;
    const db = await getDb();
    const c = get(db, 'SELECT * FROM customers WHERE jid=?', [req.customer.jid]);
    if (!c) return res.status(404).json({ error: 'Not found' });
    let newHash = c.password_hash;
    if (password) {
      if (!current_password) return res.status(400).json({ error: 'Current password required' });
      const ok = await bcrypt.compare(current_password, c.password_hash);
      if (!ok) return res.status(400).json({ error: 'Current password incorrect' });
      if (password.length < 6) return res.status(400).json({ error: 'New password too short' });
      newHash = await bcrypt.hash(password, cfg.bcryptRounds);
    }
    run(db, `UPDATE customers SET name=?,email=?,phone=?,password_hash=? WHERE jid=?`,
      [name || c.name, email || c.email, phone || c.phone, newHash, c.jid]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Forgot/Reset password ────────────────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const jid = toJid(email);
    const db = await getDb();
    const c = get(db, 'SELECT * FROM customers WHERE jid=?', [jid]);
    if (!c) return res.json({ ok: true }); // don't reveal existence
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    run(db, `INSERT OR REPLACE INTO pw_resets (token,customer_jid,expires_at,used) VALUES (?,?,?,0)`, [token, jid, expires]);
    const baseUrl = await getSetting('base_url') || cfg.baseUrl;
    const resetUrl = `${baseUrl}/my#reset-password?token=${token}`;
    await sendPasswordReset(c.email, c.name, resetUrl).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password too short' });
    const db = await getDb();
    const r = get(db, `SELECT * FROM pw_resets WHERE token=? AND used=0 AND expires_at > datetime('now')`, [token]);
    if (!r) return res.status(400).json({ error: 'Invalid or expired reset link' });
    const hash = await bcrypt.hash(password, cfg.bcryptRounds);
    run(db, `UPDATE customers SET password_hash=? WHERE jid=?`, [hash, r.customer_jid]);
    run(db, `UPDATE pw_resets SET used=1 WHERE token=?`, [token]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Orders ───────────────────────────────────────────────────────────────────
router.post('/orders', requireCustomer, async (req, res) => {
  try {
    const { plan_id } = req.body;
    if (!plan_id) return res.status(400).json({ error: 'plan_id required' });
    const db = await getDb();
    const plan = get(db, 'SELECT * FROM plans WHERE id=? AND active=1', [plan_id]);
    if (!plan) return res.status(404).json({ error: 'Plan not found or unavailable' });
    if (plan.stock === 0) return res.status(400).json({ error: 'Out of stock' });
    const c = get(db, 'SELECT * FROM customers WHERE jid=?', [req.customer.jid]);
    if (!c) return res.status(404).json({ error: 'Customer not found' });
    const price = c.discount_percent > 0
      ? plan.price_inr * (1 - c.discount_percent / 100)
      : plan.price_inr;
    if (c.wallet_inr < price) return res.status(400).json({ error: 'Insufficient wallet balance' });
    debitWallet(db, c.jid, price, 'order', `${plan.platform} - ${plan.name}`, null);
    const expiresAt = plan.duration_days
      ? new Date(Date.now() + plan.duration_days * 86400000).toISOString()
      : null;
    const result = run(db, `INSERT INTO orders (customer_jid,plan_id,amount_inr,status,expires_at) VALUES (?,?,?,?,?)`,
      [c.jid, plan_id, price, 'pending', expiresAt]);
    if (plan.stock > 0) run(db, `UPDATE plans SET stock=stock-1 WHERE id=?`, [plan_id]);
    await audit({ actorKind: 'customer', actorLabel: c.email, action: 'place_order', targetKind: 'order', targetId: result.lastInsertRowid, ip: req.ip });
    res.json({ ok: true, order_id: result.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/orders', requireCustomer, async (req, res) => {
  try {
    const db = await getDb();
    const orders = all(db,
      `SELECT o.*, p.name as plan_name, p.platform, p.duration_days
       FROM orders o LEFT JOIN plans p ON o.plan_id=p.id
       WHERE o.customer_jid=? ORDER BY o.created_at DESC`,
      [req.customer.jid]);
    orders.forEach(o => {
      if (o.credentials && o.status !== 'delivered') delete o.credentials;
    });
    res.json(orders);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/orders/:id', requireCustomer, async (req, res) => {
  try {
    const db = await getDb();
    const order = get(db,
      `SELECT o.*, p.name as plan_name, p.platform, p.duration_days
       FROM orders o LEFT JOIN plans p ON o.plan_id=p.id
       WHERE o.id=? AND o.customer_jid=?`,
      [req.params.id, req.customer.jid]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.credentials && order.status === 'delivered') {
      try { order.credentials = JSON.parse(order.credentials); } catch {}
    } else {
      delete order.credentials;
    }
    res.json(order);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Topups ───────────────────────────────────────────────────────────────────
router.post('/topup/razorpay', requireCustomer, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount < 1) return res.status(400).json({ error: 'Invalid amount' });
    const Razorpay = require('razorpay');
    const rz = new Razorpay({ key_id: cfg.razorpay.keyId, key_secret: cfg.razorpay.keySecret });
    const order = await rz.orders.create({
      amount: Math.round(amount * 100),
      currency: 'INR',
      receipt: `topup_${req.customer.jid}_${Date.now()}`,
    });
    const db = await getDb();
    run(db, `INSERT INTO topups (customer_jid,amount_inr,method,reference,status) VALUES (?,?,?,?,?)`,
      [req.customer.jid, amount, 'razorpay', order.id, 'pending']);
    res.json({ ok: true, order_id: order.id, key: cfg.razorpay.keyId, amount: order.amount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/topup/razorpay/verify', requireCustomer, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const crypto = require('crypto');
    const expected = crypto.createHmac('sha256', cfg.razorpay.keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
    if (expected !== razorpay_signature) return res.status(400).json({ error: 'Invalid signature' });
    const db = await getDb();
    const topup = get(db, `SELECT * FROM topups WHERE reference=? AND customer_jid=? AND status='pending'`,
      [razorpay_order_id, req.customer.jid]);
    if (!topup) return res.status(404).json({ error: 'Topup not found' });
    run(db, `UPDATE topups SET status='approved', reference=? WHERE id=?`,
      [razorpay_payment_id, topup.id]);
    creditWallet(db, req.customer.jid, topup.amount_inr, 'topup', 'Razorpay', razorpay_payment_id);
    await audit({ actorKind: 'customer', actorLabel: req.customer.email, action: 'topup_razorpay', targetKind: 'topup', targetId: topup.id, ip: req.ip });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/topup/upi', requireCustomer, upload.single('screenshot'), async (req, res) => {
  try {
    const { amount, reference } = req.body;
    if (!amount || amount < 1) return res.status(400).json({ error: 'Invalid amount' });
    const screenshotUrl = req.file ? `/data/uploads/${req.file.filename}` : null;
    const db = await getDb();
    run(db, `INSERT INTO topups (customer_jid,amount_inr,method,reference,status,screenshot_url) VALUES (?,?,?,?,?,?)`,
      [req.customer.jid, amount, 'upi_manual', reference || null, 'pending', screenshotUrl]);
    res.json({ ok: true, message: 'Topup request submitted. Pending admin approval.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/wallet/transactions', requireCustomer, async (req, res) => {
  try {
    const db = await getDb();
    const txns = all(db, `SELECT * FROM wallet_txns WHERE customer_jid=? ORDER BY created_at DESC LIMIT 100`,
      [req.customer.jid]);
    res.json(txns);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Tickets ──────────────────────────────────────────────────────────────────
router.post('/tickets', requireCustomer, async (req, res) => {
  try {
    const { subject, body } = req.body;
    if (!subject || !body) return res.status(400).json({ error: 'Subject and body required' });
    const db = await getDb();
    const r = run(db, `INSERT INTO tickets (customer_jid,subject,body,status) VALUES (?,?,?,?)`,
      [req.customer.jid, subject.trim(), body.trim(), 'open']);
    res.json({ ok: true, ticket_id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/tickets', requireCustomer, async (req, res) => {
  try {
    const db = await getDb();
    const tickets = all(db, `SELECT * FROM tickets WHERE customer_jid=? ORDER BY created_at DESC`, [req.customer.jid]);
    res.json(tickets);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/tickets/:id', requireCustomer, async (req, res) => {
  try {
    const db = await getDb();
    const ticket = get(db, `SELECT * FROM tickets WHERE id=? AND customer_jid=?`, [req.params.id, req.customer.jid]);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const replies = all(db, `SELECT * FROM ticket_replies WHERE ticket_id=? ORDER BY created_at ASC`, [req.params.id]);
    res.json({ ...ticket, replies });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/tickets/:id/reply', requireCustomer, async (req, res) => {
  try {
    const { body } = req.body;
    if (!body) return res.status(400).json({ error: 'Body required' });
    const db = await getDb();
    const ticket = get(db, `SELECT * FROM tickets WHERE id=? AND customer_jid=?`, [req.params.id, req.customer.jid]);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    run(db, `INSERT INTO ticket_replies (ticket_id,sender,body) VALUES (?,?,?)`, [req.params.id, 'customer', body.trim()]);
    run(db, `UPDATE tickets SET status='open' WHERE id=?`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
