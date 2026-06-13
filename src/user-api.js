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
const { loginLimiter, registerLimiter, sendLimiter, checkCredentialThrottle, recordFailedLogin, clearFailedLogin } = require('./security');
const { audit } = require('./audit');
const { sendPasswordReset, sendOrderDelivery, sendOtpEmail, sendMagicLinkEmail } = require('./mailer');

const router = express.Router();

// Strip trailing slash(es) so we never build URLs like https://site.com//path
const stripSlash = (u) => (u || '').replace(/\/+$/, '');

// Resolve the UPI address customers should pay to. Prefer the upi_id setting,
// but fall back to the first enabled UPI-type payment method — admins often
// configure UPI there (Payment Methods table) and leave the setting blank,
// which otherwise leaves checkout/top-up with an empty UPI ID.
async function getEffectiveUpi(db) {
  let id   = (await getSetting('upi_id')     || '').trim();
  let name = (await getSetting('upi_name')   || '').trim();
  let qr   = (await getSetting('upi_qr_url') || '').trim();
  if (!id) {
    const pm = get(db, `SELECT name,address,qr_url FROM payment_methods
      WHERE enabled=1 AND type LIKE 'upi%' AND address IS NOT NULL AND address != ''
      ORDER BY sort_order ASC, id ASC LIMIT 1`);
    if (pm) {
      id = (pm.address || '').trim();
      if (!name) name = (pm.name || '').trim();
      if (!qr)   qr   = (pm.qr_url || '').trim();
    }
  }
  return { upi_id: id, upi_name: name, qr_url: qr };
}

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

// ─── Pricing helper: computes the effective per-customer price for a plan ─────
function computePlanPrice(db, plan, customer, planId) {
  const reseller = get(db, `SELECT r.id, r.discount_percent FROM resellers r WHERE r.customer_jid=? AND r.status='approved'`, [customer.jid]);
  if (reseller) {
    const rp = get(db, `SELECT price_inr FROM reseller_prices WHERE reseller_id=? AND plan_id=?`, [reseller.id, planId]);
    if (rp) return rp.price_inr;
    if (reseller.discount_percent > 0) return plan.price_inr * (1 - reseller.discount_percent / 100);
  } else if (customer.discount_percent > 0) {
    return plan.price_inr * (1 - customer.discount_percent / 100);
  }
  return plan.price_inr;
}

// Disable HTTP-level caching for endpoints that mirror admin-editable data —
// settings, plan list, and the active theme. Without this Express returns an
// ETag with no Cache-Control, which lets browsers heuristic-cache the response;
// an admin change to a plan image_url / price / stock would then only show up
// on the landing pages after a manual refresh. With no-cache the browser must
// revalidate every request, so admin edits land within a normal page load.
function noStoreCache(_req, res, next) {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  next();
}

// ─── Store info (public, no auth) ────────────────────────────────────────────
router.get('/store', noStoreCache, async (req, res) => {
  try {
    const db = await getDb();
    const rows = all(db, `SELECT key, value FROM settings WHERE key LIKE 'home_%' OR key IN
      ('site_name','site_tagline','hero_title','hero_title2','hero_subtext','hero_cta_label','hero_cta_url','logo_url','logo_light_url','logo_dark_url','announcement','upi_id','upi_name',
       'support_whatsapp','support_email','wa_bot_number','telegram_bot_url',
       'pwa_force_prompt','vapid_public_key','store_theme','wa_enabled','imap_enabled',
       'header_menu_items',
       'usdt_inr_rate','usdt_fee_pct','usdt_payment_window_minutes',
       'usdt_binance_enabled','usdt_binance_uid','usdt_binance_qr_url',
       'usdt_bep20_enabled','usdt_bep20_address','usdt_bep20_qr_url',
       'usdt_trc20_enabled','usdt_trc20_address','usdt_trc20_qr_url')`, []);
    const s = {};
    rows.forEach(r => s[r.key] = r.value);
    // Prefer the bot's live connected number (Baileys) so 1-tap WhatsApp login
    // works the moment the bot is online, even before the persisted setting is
    // written. Falls back to the stored wa_bot_number, then support_whatsapp.
    try {
      const waStatus = require('./wa-bot').getStatus();
      if (waStatus && waStatus.mode === 'baileys' && /^\d{6,}$/.test(String(waStatus.number || ''))) {
        s.wa_bot_number = String(waStatus.number);
      }
    } catch {}
    s.payment_methods = all(db, `SELECT id, name, type, address, instructions, qr_url FROM payment_methods WHERE enabled=1 ORDER BY sort_order ASC, id ASC`);
    // Resolve effective UPI (setting, else configured UPI payment method) so the
    // storefront shows a real UPI ID/QR even when the upi_id setting is blank.
    const eupi = await getEffectiveUpi(db);
    s.upi_id = eupi.upi_id;
    s.upi_name = eupi.upi_name;
    s.upi_qr_url = eupi.qr_url;
    s.upi_available = eupi.upi_id ? '1' : '0';
    // Real stats for the homepage
    const custCount  = (get(db, `SELECT COUNT(*) as c FROM customers`)?.c || 0);
    const orderCount = (get(db, `SELECT COUNT(*) as c FROM orders WHERE status NOT IN ('cancelled','failed')`)?.c || 0);
    const platCount  = (get(db, `SELECT COUNT(DISTINCT platform) as c FROM plans WHERE active=1`)?.c || 0);
    const fmt = (n, base) => n >= base ? (Math.ceil(n / base) * base).toLocaleString('en-IN') + '+' : base.toLocaleString('en-IN') + '+';
    s.stat_customers = custCount  >= 100  ? fmt(custCount, 100)   : '1,000+';
    s.stat_orders    = orderCount >= 100  ? fmt(orderCount, 100)  : '5,000+';
    s.stat_platforms = platCount  >= 10   ? platCount + '+'       : '50+';
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Public plans ─────────────────────────────────────────────────────────────
router.get('/plans', noStoreCache, async (req, res) => {
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
    // Phone is OPTIONAL at signup so registration never blocks; if provided it must be
    // valid. (Guest checkout still requires a phone for delivery, and the merge tool
    // dedupes — so "one account = email + WhatsApp" holds without breaking signup.)
    const waPhone = phone ? normalizeWaPhone(phone) : null;
    if (phone && !waPhone) return res.status(400).json({ error: 'Enter a valid WhatsApp number.' });
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
      [jid, name.trim(), email.toLowerCase().trim(), waPhone, hash, refCode, referredBy]);
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

// ─── Phase 3: customer history ───────────────────────────────────────────────
// Read-only endpoints feeding the Profile page's Activity / Payments / Stats
// sections. All scoped to the authenticated customer; never expose another
// customer's rows.

// Recent login + register events from audit_log.
router.get('/me/logins', requireCustomer, async (req, res) => {
  try {
    const db = await getDb();
    const rows = all(db, `SELECT id, action, ip, created_at
      FROM audit_log
      WHERE actor_kind='customer' AND target_kind='customer' AND target_id=?
        AND (action LIKE 'login%' OR action LIKE 'register%')
      ORDER BY created_at DESC LIMIT 25`,
      [req.customer.jid]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// All payment / topup rows for this customer.
router.get('/me/payments', requireCustomer, async (req, res) => {
  try {
    const db = await getDb();
    const rows = all(db, `SELECT id, method, currency, amount_inr, amount_usdt,
        unique_amount, unique_amount_usdt, status, order_id, created_at, expires_at
      FROM topups WHERE customer_jid=?
      ORDER BY created_at DESC LIMIT 100`,
      [req.customer.jid]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Recoverable pending payments (abandoned UPI checkouts < 24h old) — drives the
// "Finish your payment" recovery card on the dashboard. Returns the same unique
// amount + UPI details so the customer resumes paying the exact figure.
router.get('/me/pending-payments', requireCustomer, async (req, res) => {
  try {
    const db = await getDb();
    const rows = all(db, `SELECT t.id, t.unique_amount, t.amount_inr, t.currency, t.method,
        t.created_at, t.expires_at, t.plan_id, p.name AS plan_name, p.platform
      FROM topups t LEFT JOIN plans p ON p.id=t.plan_id
      WHERE t.customer_jid=? AND t.purpose='order' AND t.status='pending'
        AND t.method='upi_imap' AND t.created_at > datetime('now','-24 hours')
      ORDER BY t.created_at DESC`, [req.customer.jid]);
    const eupi = await getEffectiveUpi(db);
    res.json({ pending: rows.map(r => ({ ...r, upi_id: eupi.upi_id, upi_name: eupi.upi_name, qr_url: eupi.qr_url })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Aggregate stats for the Profile dashboard card.
router.get('/me/stats', requireCustomer, async (req, res) => {
  try {
    const db = await getDb();
    const s = get(db, `SELECT
        COUNT(*) as total_orders,
        COALESCE(SUM(CASE WHEN status NOT IN ('cancelled','failed') THEN amount_inr ELSE 0 END),0) as total_spent_inr,
        SUM(CASE WHEN status='delivered' AND expires_at IS NOT NULL AND datetime(expires_at) > datetime('now') THEN 1 ELSE 0 END) as active_subs_count
      FROM orders WHERE customer_jid=?`, [req.customer.jid]);
    const fav = get(db, `SELECT p.platform, COUNT(*) as n
      FROM orders o LEFT JOIN plans p ON o.plan_id=p.id
      WHERE o.customer_jid=? AND p.platform IS NOT NULL AND p.platform<>''
      GROUP BY p.platform ORDER BY n DESC LIMIT 1`, [req.customer.jid]);
    const c = get(db, `SELECT created_at FROM customers WHERE jid=?`, [req.customer.jid]);
    res.json({
      total_orders:      s?.total_orders || 0,
      total_spent_inr:   s?.total_spent_inr || 0,
      active_subs_count: s?.active_subs_count || 0,
      favorite_platform: fav?.platform || null,
      favorite_count:    fav?.n || 0,
      member_since:      c?.created_at || null,
    });
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
    const phoneProvided = Object.prototype.hasOwnProperty.call(req.body, 'phone');
    const nextPhone = phoneProvided ? normalizeWaPhone(phone) : normalizeWaPhone(c.phone);
    if (phoneProvided && phone && !nextPhone) return res.status(400).json({ error: 'Enter a valid WhatsApp number.' });
    if (!nextPhone) return res.status(400).json({ error: 'WhatsApp number is required.' });
    run(db, `UPDATE customers SET name=?,email=?,phone=?,password_hash=? WHERE jid=?`,
      [name || c.name, email || c.email, nextPhone, newHash, c.jid]);
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
    const baseUrl = stripSlash(await getSetting('base_url')) || stripSlash(cfg.baseUrl);
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

// ─── OTP Login ────────────────────────────────────────────────────────────────
router.post('/send-otp', sendLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Valid email required' });
    const db = await getDb();
    const jid = toJid(email);
    const existing = get(db, 'SELECT jid,blocked FROM customers WHERE jid=?', [jid]);
    if (existing?.blocked) return res.status(403).json({ error: 'Account blocked. Contact support.' });
    // Clean expired tokens for this email
    run(db, `DELETE FROM auth_tokens WHERE purpose='otp' AND email=? AND expires_at < datetime('now')`, [email.toLowerCase().trim()]);
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const token = crypto.randomBytes(16).toString('hex');
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    run(db, `INSERT INTO auth_tokens (token,purpose,code,email,expires_at) VALUES (?,?,?,?,?)`,
      [token, 'otp', otp, email.toLowerCase().trim(), expires]);
    const siteName = await getSetting('site_name') || 'OTT Store';
    // Await the send so a mailer failure surfaces as a real error instead of
    // silently telling the customer ok:true while they wait for an OTP that
    // never arrives. The token is already in auth_tokens; if delivery fails
    // it stays unused and harmlessly expires in 10 min.
    try {
      await sendOtpEmail(email, otp, siteName);
    } catch (sendErr) {
      try { await audit({ actorKind: 'system', actorLabel: 'mailer', action: 'send_otp_failed', targetKind: 'customer', targetId: jid, after_json: JSON.stringify({ error: sendErr.message }), ip: req.ip }); } catch {}
      return res.status(502).json({ error: 'We couldn’t send the OTP email. Try a different method.' });
    }
    res.json({ ok: true, is_new: !existing });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: 'Email and OTP required' });
    const db = await getDb();
    const emailNorm = email.toLowerCase().trim();
    const record = get(db,
      `SELECT * FROM auth_tokens WHERE purpose='otp' AND email=? AND code=? AND used=0 AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1`,
      [emailNorm, String(otp).trim()]);
    if (!record) return res.status(400).json({ error: 'Invalid or expired OTP. Please request a new one.' });
    run(db, `UPDATE auth_tokens SET used=1 WHERE token=?`, [record.token]);
    const jid = toJid(emailNorm);
    let customer = get(db, 'SELECT * FROM customers WHERE jid=?', [jid]);
    const isNew = !customer;
    if (!customer) {
      const username = emailNorm.split('@')[0].replace(/[._+\-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim() || 'User';
      const refCode = crypto.randomBytes(4).toString('hex').toUpperCase();
      run(db, `INSERT INTO customers (jid,name,email,referral_code,needs_email) VALUES (?,?,?,?,0)`,
        [jid, username, emailNorm, refCode]);
      customer = get(db, 'SELECT * FROM customers WHERE jid=?', [jid]);
    }
    run(db, `UPDATE customers SET last_login_at=datetime('now') WHERE jid=?`, [jid]);
    setCustomerCookie(res, { jid, email: customer.email, name: customer.name });
    await audit({ actorKind:'customer', actorLabel:customer.email, action:isNew?'register_otp':'login_otp', targetKind:'customer', targetId:jid, ip:req.ip });
    res.json({ ok:true, name:customer.name, email:customer.email, is_new:isNew, needs_phone:customer.needs_phone||0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Magic Link ────────────────────────────────────────────────────────────────
router.post('/send-magic-link', sendLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Valid email required' });
    const db = await getDb();
    const emailNorm = email.toLowerCase().trim();
    const jid = toJid(emailNorm);
    const customer = get(db, 'SELECT jid,name,blocked FROM customers WHERE jid=?', [jid]);
    if (customer?.blocked) return res.status(403).json({ error: 'Account blocked.' });
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    run(db, `INSERT INTO auth_tokens (token,purpose,email,expires_at) VALUES (?,?,?,?)`,
      [token, 'magic_link', emailNorm, expires]);
    const baseUrl = stripSlash(await getSetting('base_url')) || stripSlash(cfg.baseUrl);
    const siteName = await getSetting('site_name') || 'OTT Store';
    const magicUrl = `${baseUrl}/user/api/auth/magic?token=${token}`;
    try {
      await sendMagicLinkEmail(emailNorm, customer?.name || '', magicUrl, siteName);
    } catch (sendErr) {
      try { await audit({ actorKind: 'system', actorLabel: 'mailer', action: 'send_magic_failed', targetKind: 'customer', targetId: jid, after_json: JSON.stringify({ error: sendErr.message }), ip: req.ip }); } catch {}
      return res.status(502).json({ error: 'We couldn’t send the login email. Try a different method.' });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/auth/magic', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.redirect('/my?auth_error=invalid_link');
    const db = await getDb();
    const record = get(db,
      `SELECT * FROM auth_tokens WHERE token=? AND purpose='magic_link' AND used=0 AND expires_at > datetime('now')`,
      [token]);
    if (!record) return res.redirect('/my?auth_error=expired_link');
    run(db, `UPDATE auth_tokens SET used=1 WHERE token=?`, [token]);
    const emailNorm = record.email;
    const jid = toJid(emailNorm);
    let customer = get(db, 'SELECT * FROM customers WHERE jid=?', [jid]);
    const isNew = !customer;
    if (!customer) {
      const username = emailNorm.split('@')[0].replace(/[._+\-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim() || 'User';
      const refCode = crypto.randomBytes(4).toString('hex').toUpperCase();
      run(db, `INSERT INTO customers (jid,name,email,referral_code) VALUES (?,?,?,?)`,
        [jid, username, emailNorm, refCode]);
      customer = get(db, 'SELECT * FROM customers WHERE jid=?', [jid]);
    }
    run(db, `UPDATE customers SET last_login_at=datetime('now') WHERE jid=?`, [jid]);
    setCustomerCookie(res, { jid, email: customer.email, name: customer.name });
    await audit({ actorKind:'customer', actorLabel:customer.email, action:isNew?'register_magic':'login_magic', targetKind:'customer', targetId:jid, ip:req.ip });
    res.redirect('/my?auth_success=1');
  } catch (e) { res.redirect('/my?auth_error=server_error'); }
});

// ─── WhatsApp OTP Login ────────────────────────────────────────────────────────
router.post('/send-wa-otp', sendLimiter, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number required' });
    const db = await getDb();
    const waEnabled = await getSetting('wa_enabled');
    if (waEnabled !== '1') return res.status(400).json({ error: 'WhatsApp login not available right now.' });
    const phoneClean = phone.replace(/\D/g, '');
    if (phoneClean.length < 10) return res.status(400).json({ error: 'Invalid phone number' });
    const phoneCC = phoneClean.length >= 12 ? phoneClean : '91' + phoneClean.slice(-10);
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const token = crypto.randomBytes(16).toString('hex');
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    run(db, `INSERT INTO auth_tokens (token,purpose,code,phone,expires_at) VALUES (?,?,?,?,?)`,
      [token, 'wa_otp', otp, phoneCC, expires]);
    const siteName = await getSetting('site_name') || 'OTT Store';
    let sent = false;
    try {
      const { sendToPhone } = require('./wa-bot');
      sent = await sendToPhone(phoneCC, `🔐 *${siteName} Login Code*\n\nYour OTP: *${otp}*\n\nValid for 10 minutes. Do not share with anyone.`);
    } catch (e) {
      try { await audit({ actorKind: 'system', actorLabel: 'wa-bot', action: 'send_wa_otp_failed', targetKind: 'customer', targetId: phoneCC + '@s.whatsapp.net', after_json: JSON.stringify({ error: e.message }), ip: req.ip }); } catch {}
    }
    if (!sent) return res.status(502).json({ error: 'We couldn’t send the OTP on WhatsApp. The bot may be offline — try Email OTP or Magic Link.' });
    res.json({ ok: true, masked: '****' + phoneCC.slice(-4) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/verify-wa-otp', async (req, res) => {
  try {
    const { phone, otp, name: reqName } = req.body;
    if (!phone || !otp) return res.status(400).json({ error: 'Phone and OTP required' });
    const db = await getDb();
    const phoneClean = phone.replace(/\D/g, '');
    const phoneCC = phoneClean.length >= 12 ? phoneClean : '91' + phoneClean.slice(-10);
    const record = get(db,
      `SELECT * FROM auth_tokens WHERE purpose='wa_otp' AND phone=? AND code=? AND used=0 AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1`,
      [phoneCC, String(otp).trim()]);
    if (!record) return res.status(400).json({ error: 'Invalid or expired OTP. Please request a new one.' });
    run(db, `UPDATE auth_tokens SET used=1 WHERE token=?`, [record.token]);
    const waJid = phoneCC + '@s.whatsapp.net';
    let customer = get(db, 'SELECT * FROM customers WHERE jid=? OR phone=?', [waJid, phoneCC]);
    const isNew = !customer;
    if (!customer) {
      const nm = reqName?.trim() || ('User ' + phoneCC.slice(-4));
      const refCode = crypto.randomBytes(4).toString('hex').toUpperCase();
      run(db, `INSERT INTO customers (jid,name,phone,referral_code,needs_email) VALUES (?,?,?,?,1)`,
        [waJid, nm, phoneCC, refCode]);
      customer = get(db, 'SELECT * FROM customers WHERE jid=?', [waJid]);
    }
    run(db, `UPDATE customers SET last_login_at=datetime('now') WHERE jid=?`, [customer.jid]);
    setCustomerCookie(res, { jid:customer.jid, email:customer.email||'', name:customer.name });
    await audit({ actorKind:'customer', actorLabel:customer.phone, action:isNew?'register_wa':'login_wa', targetKind:'customer', targetId:customer.jid, ip:req.ip });
    res.json({ ok:true, name:customer.name, is_new:isNew, needs_email:customer.needs_email||0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── WhatsApp Magic Link (1-tap login, mirrors email magic-link) ──────────────
router.post('/send-wa-magic', sendLimiter, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number required' });
    const db = await getDb();
    const waEnabled = await getSetting('wa_enabled');
    if (waEnabled !== '1') return res.status(400).json({ error: 'WhatsApp login not available right now.' });
    const phoneClean = phone.replace(/\D/g, '');
    if (phoneClean.length < 10) return res.status(400).json({ error: 'Invalid phone number' });
    const phoneCC = phoneClean.length >= 12 ? phoneClean : '91' + phoneClean.slice(-10);
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    run(db, `INSERT INTO auth_tokens (token,purpose,phone,expires_at) VALUES (?,?,?,?)`,
      [token, 'wa_magic', phoneCC, expires]);
    const baseUrl = stripSlash(await getSetting('base_url')) || stripSlash(cfg.baseUrl);
    const siteName = await getSetting('site_name') || 'OTT Store';
    const magicUrl = `${baseUrl}/user/api/auth/wa-magic?token=${token}`;
    let sent = false;
    try {
      const { sendToPhone } = require('./wa-bot');
      sent = await sendToPhone(phoneCC,
        `🔐 *${siteName} — Tap to Login*\n\nTap this link to sign in instantly:\n${magicUrl}\n\nLink expires in 15 minutes. Do not share with anyone.`);
    } catch (e) {
      try { await audit({ actorKind: 'system', actorLabel: 'wa-bot', action: 'send_wa_magic_failed', targetKind: 'customer', targetId: phoneCC + '@s.whatsapp.net', after_json: JSON.stringify({ error: e.message }), ip: req.ip }); } catch {}
    }
    if (!sent) return res.status(502).json({ error: 'We couldn’t send the login link on WhatsApp. The bot may be offline — try Email OTP or Magic Link.' });
    res.json({ ok: true, masked: '****' + phoneCC.slice(-4) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/auth/wa-magic', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.redirect('/my?auth_error=invalid_link');
    const db = await getDb();
    const record = get(db,
      `SELECT * FROM auth_tokens WHERE token=? AND purpose='wa_magic' AND used=0 AND expires_at > datetime('now')`,
      [token]);
    if (!record) return res.redirect('/my?auth_error=expired_link');
    run(db, `UPDATE auth_tokens SET used=1 WHERE token=?`, [token]);
    const phoneCC = record.phone;
    const waJid = phoneCC + '@s.whatsapp.net';
    let customer = get(db, 'SELECT * FROM customers WHERE jid=? OR phone=?', [waJid, phoneCC]);
    const isNew = !customer;
    if (!customer) {
      const nm = 'User ' + phoneCC.slice(-4);
      const refCode = crypto.randomBytes(4).toString('hex').toUpperCase();
      run(db, `INSERT INTO customers (jid,name,phone,referral_code,needs_email) VALUES (?,?,?,?,1)`,
        [waJid, nm, phoneCC, refCode]);
      customer = get(db, 'SELECT * FROM customers WHERE jid=?', [waJid]);
    }
    run(db, `UPDATE customers SET last_login_at=datetime('now') WHERE jid=?`, [customer.jid]);
    setCustomerCookie(res, { jid: customer.jid, email: customer.email || '', name: customer.name });
    await audit({ actorKind:'customer', actorLabel:customer.phone, action:isNew?'register_wa_magic':'login_wa_magic', targetKind:'customer', targetId:customer.jid, ip:req.ip });
    res.redirect('/my?auth_success=1');
  } catch (e) { res.redirect('/my?auth_error=server_error'); }
});

// ─── Complete Profile ─────────────────────────────────────────────────────────
router.put('/complete-profile', requireCustomer, async (req, res) => {
  try {
    const { email, phone, name } = req.body;
    const db = await getDb();
    const c = get(db, 'SELECT * FROM customers WHERE jid=?', [req.customer.jid]);
    if (!c) return res.status(404).json({ error: 'Not found' });
    const sets = []; const vals = [];
    if (email && !c.email) {
      const en = email.toLowerCase().trim();
      const dup = get(db, 'SELECT jid FROM customers WHERE email=? AND jid!=?', [en, c.jid]);
      if (dup) return res.status(409).json({ error: 'Email already registered' });
      sets.push('email=?', 'needs_email=0'); vals.push(en);
    }
    if (phone) {
      const waPhone = normalizeWaPhone(phone);
      if (!waPhone) return res.status(400).json({ error: 'Enter a valid WhatsApp number.' });
      sets.push('phone=?', 'needs_phone=0'); vals.push(waPhone);
    }
    if (name?.trim()) { sets.push('name=?'); vals.push(name.trim()); }
    if (sets.length) {
      run(db, `UPDATE customers SET ${sets.join(',')} WHERE jid=?`, [...vals, c.jid]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Orders ───────────────────────────────────────────────────────────────────
// Wallet pay-from-balance is removed. All purchases go through /checkout/*-direct
// (UPI IMAP or USDT IMAP). Order rows are inserted by imap-verify on payment match.
router.post('/orders', requireCustomer, async (req, res) => {
  return res.status(410).json({
    error: 'Direct order placement is no longer supported. Use /checkout/upi-direct or /checkout/usdt-direct.',
  });
});

router.get('/orders', requireCustomer, async (req, res) => {
  try {
    const db = await getDb();
    const orders = all(db,
      `SELECT o.*, p.name as plan_name, p.platform, p.duration_days, p.image_url as plan_image
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
      `SELECT o.*, p.name as plan_name, p.platform, p.duration_days, p.features as plan_features, p.image_url as plan_image, p.delivery_time_est
       FROM orders o LEFT JOIN plans p ON o.plan_id=p.id
       WHERE o.id=? AND o.customer_jid=?`,
      [req.params.id, req.customer.jid]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.credentials && order.status === 'delivered') {
      try { order.credentials = JSON.parse(order.credentials); } catch {}
    } else {
      delete order.credentials;
    }
    try { order.plan_features = JSON.parse(order.plan_features || '[]'); } catch { order.plan_features = []; }
    // Attach the payment row (method + paid_at + tx ref) for the timeline.
    const topup = get(db,
      `SELECT id, method, currency, amount_inr, amount_usdt, unique_amount, unique_amount_usdt, created_at as paid_at, status as payment_status
       FROM topups WHERE order_id=? AND customer_jid=? ORDER BY created_at DESC LIMIT 1`,
      [order.id, req.customer.jid]);
    if (topup) order.payment = topup;
    res.json(order);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Direct Checkout (IMAP UPI) ───────────────────────────────────────────────
// Creates a pending topup linked to a plan; IMAP will auto-create the order on match
router.post('/checkout/upi-direct', requireCustomer, async (req, res) => {
  try {
    const { plan_id } = req.body;
    if (!plan_id) return res.status(400).json({ error: 'plan_id required' });
    const db = await getDb();

    const imapEnabled = await getSetting('imap_enabled');
    if (imapEnabled !== '1') return res.status(400).json({ error: 'UPI auto-verify not enabled' });

    const plan = get(db, 'SELECT * FROM plans WHERE id=? AND active=1', [plan_id]);
    if (!plan) return res.status(404).json({ error: 'Plan not found or unavailable' });
    if (plan.stock === 0) return res.status(400).json({ error: 'Out of stock' });

    const c = get(db, 'SELECT * FROM customers WHERE jid=?', [req.customer.jid]);
    if (!c) return res.status(404).json({ error: 'Customer not found' });
    const waPhone = normalizeWaPhone(req.body.phone) || normalizeWaPhone(c.phone);
    if (!waPhone) return res.status(400).json({ error: 'Please add your WhatsApp number for delivery.', need_phone: true });
    if (waPhone !== c.phone) run(db, `UPDATE customers SET phone=?, needs_phone=0 WHERE jid=?`, [waPhone, c.jid]);

    const price = computePlanPrice(db, plan, c, plan_id);

    // Expire any existing pending direct-checkout for same customer+plan
    run(db, `UPDATE topups SET status='expired' WHERE customer_jid=? AND plan_id=? AND purpose='order' AND status='pending'`,
      [c.jid, plan_id]);

    const { generateUniqueAmount } = require('./imap-verify');
    const usedUniques = all(db, `SELECT unique_amount FROM topups WHERE status='pending' AND purpose='order' AND method='upi_imap' AND unique_amount IS NOT NULL`).map(r => r.unique_amount);
    const uniqueMaxDelta = parseInt(await getSetting('upi_unique_max_delta') || '6', 10);
    const uniqueDir = await getSetting('upi_unique_direction') || 'both';
    const uniqueAmount = generateUniqueAmount(price, usedUniques, uniqueMaxDelta, uniqueDir);
    const eupi = await getEffectiveUpi(db);
    const upiId = eupi.upi_id;
    const upiName = (eupi.upi_name || '').replace(/[^a-zA-Z0-9 ]/g, '');
    const windowMin = parseInt(await getSetting('upi_payment_window_minutes') || '1440', 10); // 24h: customer can finish (or be reminded to finish) the payment within a day
    const expiresAt = new Date(Date.now() + windowMin * 60 * 1000).toISOString();

    const r = run(db, `INSERT INTO topups (customer_jid,amount_inr,unique_amount,method,status,purpose,plan_id,currency,expires_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      [c.jid, price, uniqueAmount, 'upi_imap', 'pending', 'order', plan_id, 'INR', expiresAt]);

    // Pre-fill the EXACT amount in a UPI deep link + QR so the customer can't pay
    // the rounded figure they remember (₹200 instead of ₹200.50). On mobile the
    // link opens the UPI app with the amount LOCKED; the QR encodes the same, so
    // scanning fills it too. Falls back to the static UPI ID/QR if upi_id is unset.
    let upiLink = '', upiQr = '';
    if (upiId) {
      const tn = String(plan.name || 'Order').replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 30) || 'Order';
      if (eupi.qr_url) {
        // Static-QR mode: the admin uploaded their own UPI QR, so show that and DON'T
        // bake the amount into the deep link or generate a dynamic QR — amount-embedded
        // UPI requests get flagged by some banks. The customer pays the exact unique
        // amount shown; IMAP matches it. (upiQr stays empty → frontend renders qr_url.)
        upiLink = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(upiName || 'Store')}&cu=INR&tn=${encodeURIComponent(tn)}`;
      } else {
        upiLink = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(upiName || 'Store')}&am=${uniqueAmount.toFixed(2)}&cu=INR&tn=${encodeURIComponent(tn)}`;
        try { upiQr = await require('qrcode').toDataURL(upiLink, { width: 240, margin: 1 }); } catch {}
      }
    }

    res.json({
      ok: true,
      topup_id: r.lastInsertRowid,
      unique_amount: uniqueAmount,
      upi_id: upiId,
      upi_name: upiName,
      upi_link: upiLink,
      upi_qr: upiQr,
      qr_url: eupi.qr_url || '',
      plan_name: plan.name,
      plan_price: price,
      expires_at: expiresAt,
      window_minutes: windowMin,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Store wallet ─────────────────────────────────────────────────────────────
router.get('/wallet', requireCustomer, async (req, res) => {
  try {
    const db = await getDb();
    const { getBalance, getTxns } = require('./wallet');
    res.json({ balance: getBalance(db, req.customer.jid), txns: getTxns(db, req.customer.jid, 50) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Pay for a plan entirely from the wallet (instant — no UPI step). Requires the
// balance to cover the full price.
router.post('/checkout/wallet', requireCustomer, async (req, res) => {
  try {
    const { plan_id } = req.body;
    if (!plan_id) return res.status(400).json({ error: 'plan_id required' });
    const db = await getDb();
    const plan = get(db, 'SELECT * FROM plans WHERE id=? AND active=1', [plan_id]);
    if (!plan) return res.status(404).json({ error: 'Plan not found or unavailable' });
    if (plan.stock === 0) return res.status(400).json({ error: 'Out of stock' });
    const c = get(db, 'SELECT * FROM customers WHERE jid=?', [req.customer.jid]);
    if (!c) return res.status(404).json({ error: 'Customer not found' });
    const waPhone = normalizeWaPhone(req.body.phone) || normalizeWaPhone(c.phone);
    if (!waPhone) return res.status(400).json({ error: 'Please add your WhatsApp number for delivery.', need_phone: true });
    if (waPhone !== c.phone) run(db, `UPDATE customers SET phone=?, needs_phone=0 WHERE jid=?`, [waPhone, c.jid]);
    const price = computePlanPrice(db, plan, c, plan_id);

    const { getBalance, debitWallet, creditWallet } = require('./wallet');
    const bal = getBalance(db, c.jid);
    if (bal + 0.001 < price) return res.status(400).json({ error: `Insufficient wallet balance — you have ₹${bal.toFixed(2)}, need ₹${price.toFixed(2)}.` });

    // Debit, then run the SAME order-creation path as a paid checkout (stock
    // decrement → order insert → admin alert → auto-deliver → customer email).
    debitWallet(db, c.jid, price, { type: 'purchase', label: `${plan.platform || ''} ${plan.name}`.trim() });
    const r = run(db, `INSERT INTO topups (customer_jid,amount_inr,unique_amount,method,status,purpose,plan_id,currency) VALUES (?,?,?,?,?,?,?,?)`,
      [c.jid, price, price, 'wallet', 'approved', 'order', plan_id, 'INR']);
    const topup = get(db, `SELECT * FROM topups WHERE id=?`, [r.lastInsertRowid]);
    const { handleDirectCheckout } = require('./imap-verify');
    await handleDirectCheckout(db, topup, c);

    const fresh = get(db, `SELECT order_id FROM topups WHERE id=?`, [topup.id]);
    if (!fresh || !fresh.order_id) {
      // Couldn't create the order (e.g. sold out under us). Refund the wallet ONCE
      // (idempotent via ref_id) and mark the topup refunded so it can't be refunded
      // a second time from the admin Payment Log.
      const ref = 'topup:' + topup.id;
      if (!get(db, `SELECT 1 FROM wallet_txns WHERE type='refund' AND ref_id=? LIMIT 1`, [ref]))
        creditWallet(db, c.jid, price, { type: 'refund', label: `Refund — ${plan.name} (could not fulfill)`, ref_id: ref });
      run(db, `UPDATE topups SET status='refunded' WHERE id=?`, [topup.id]);
      return res.status(400).json({ error: 'Could not place the order (out of stock). Your wallet has been refunded.' });
    }
    res.json({ ok: true, order_id: fresh.order_id, new_balance: getBalance(db, c.jid) });
  } catch (e) {
    if (e.code === 'INSUFFICIENT_FUNDS') return res.status(400).json({ error: `Insufficient wallet balance (₹${e.balance.toFixed(2)})` });
    res.status(500).json({ error: e.message });
  }
});

// ─── Direct Checkout (USDT — Binance / BEP20 / TRC20, IMAP-verified) ──────────
// Customer pays USDT to one of the configured addresses; provider emails
// (Binance / BscScan / Tronscan) trigger IMAP match against the unique USDT
// amount we store on the pending topup. Order is created on match.
router.post('/checkout/usdt-direct', requireCustomer, async (req, res) => {
  try {
    const { plan_id, network } = req.body;
    if (!plan_id) return res.status(400).json({ error: 'plan_id required' });
    const net = String(network || '').toLowerCase();
    if (!['binance', 'bep20', 'trc20'].includes(net)) {
      return res.status(400).json({ error: 'Invalid network. Use binance / bep20 / trc20.' });
    }
    const db = await getDb();

    const imapEnabled = await getSetting('imap_enabled');
    if (imapEnabled !== '1') return res.status(400).json({ error: 'Payment auto-verify not enabled' });

    const enabled = await getSetting(`usdt_${net}_enabled`);
    if (enabled !== '1') return res.status(400).json({ error: `USDT ${net.toUpperCase()} is not enabled` });

    const addressKey = net === 'binance' ? 'usdt_binance_uid' : `usdt_${net}_address`;
    const address = (await getSetting(addressKey) || '').trim();
    if (!address) return res.status(400).json({ error: `USDT ${net.toUpperCase()} receiver not configured` });

    const plan = get(db, 'SELECT * FROM plans WHERE id=? AND active=1', [plan_id]);
    if (!plan) return res.status(404).json({ error: 'Plan not found or unavailable' });
    if (plan.stock === 0) return res.status(400).json({ error: 'Out of stock' });

    const c = get(db, 'SELECT * FROM customers WHERE jid=?', [req.customer.jid]);
    if (!c) return res.status(404).json({ error: 'Customer not found' });
    const waPhone = normalizeWaPhone(req.body.phone) || normalizeWaPhone(c.phone);
    if (!waPhone) return res.status(400).json({ error: 'Please add your WhatsApp number for delivery.', need_phone: true });
    if (waPhone !== c.phone) run(db, `UPDATE customers SET phone=?, needs_phone=0 WHERE jid=?`, [waPhone, c.jid]);

    const priceInr = computePlanPrice(db, plan, c, plan_id);

    const rate = parseFloat(await getSetting('usdt_inr_rate') || '99');
    const feePct = parseFloat(await getSetting('usdt_fee_pct') || '1.5');
    if (!(rate > 0)) return res.status(500).json({ error: 'USDT rate not configured' });

    const subUsdt = priceInr / rate;
    const feeUsdt = subUsdt * (feePct / 100);
    const baseUsdt = subUsdt + feeUsdt;

    const { generateUniqueUsdtAmount } = require('./imap-verify');
    const uniqueUsdt = generateUniqueUsdtAmount(baseUsdt);

    // Expire any existing pending USDT checkout for same customer+plan+network
    run(db, `UPDATE topups SET status='expired' WHERE customer_jid=? AND plan_id=? AND purpose='order' AND method=? AND status='pending'`,
      [c.jid, plan_id, `usdt_${net}`]);

    const windowMin = parseInt(await getSetting('usdt_payment_window_minutes') || '20', 10);
    const expiresAt = new Date(Date.now() + windowMin * 60 * 1000).toISOString();
    const qrUrl = (await getSetting(`usdt_${net}_qr_url`) || '').trim();

    const r = run(db, `INSERT INTO topups (customer_jid,amount_inr,amount_usdt,unique_amount_usdt,method,status,purpose,plan_id,currency,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [c.jid, priceInr, baseUsdt, uniqueUsdt, `usdt_${net}`, 'pending', 'order', plan_id, 'USDT', expiresAt]);

    res.json({
      ok: true,
      topup_id: r.lastInsertRowid,
      network: net,
      address,
      qr_url: qrUrl,
      plan_name: plan.name,
      plan_price_inr: priceInr,
      rate_inr_per_usd: rate,
      fee_pct: feePct,
      sub_usdt: Number(subUsdt.toFixed(4)),
      fee_usdt: Number(feeUsdt.toFixed(4)),
      base_usdt: Number(baseUsdt.toFixed(4)),
      unique_usdt: uniqueUsdt,
      expires_at: expiresAt,
      window_minutes: windowMin,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Poll checkout status — returns topup status + order info if created
router.get('/checkout/poll/:topupId', requireCustomer, async (req, res) => {
  try {
    const db = await getDb();
    const topup = get(db, `SELECT * FROM topups WHERE id=? AND customer_jid=? AND purpose='order'`,
      [req.params.topupId, req.customer.jid]);
    if (!topup) return res.status(404).json({ error: 'Not found' });

    if (topup.status === 'approved' && topup.order_id) {
      const order = get(db, `SELECT o.id, o.status, p.name as plan_name, p.platform FROM orders o LEFT JOIN plans p ON o.plan_id=p.id WHERE o.id=?`,
        [topup.order_id]);
      return res.json({ status: 'paid', order });
    }
    if (topup.status === 'approved') {
      return res.json({ status: 'paid', order: null });
    }
    if (topup.status === 'expired' || topup.status === 'rejected') {
      return res.json({ status: topup.status });
    }
    res.json({ status: 'pending' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Guest Checkout ───────────────────────────────────────────────────────────
// Allows purchasing without creating an account. Guest provides name + email;
// we create (or reuse) a synthetic customer record with jid = guest_<hash>@guest.local,
// create the topup with a random guest_token for poll ownership verification,
// and deliver credentials to the guest's email after IMAP payment confirmation.

function guestJid(email) {
  return 'guest_' + crypto.createHash('sha1').update(email.toLowerCase().trim()).digest('hex').slice(0, 16) + '@guest.local';
}

// Normalize + validate a WhatsApp number for delivery. Returns CC-prefixed
// digits (e.g. "919876543210") or null. Lenient: 10-15 digits; a bare 10-digit
// number defaults to +91 (India). Gates every checkout path below.
function normalizeWaPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length < 10 || d.length > 15) return null;
  return d.length === 10 ? '91' + d : d;
}

async function ensureGuestCustomer(db, email, name, phone) {
  email = String(email || '').toLowerCase().trim();
  phone = normalizeWaPhone(phone) || null;
  // Reuse an existing customer for this person so guest checkout never creates a
  // duplicate of one who already exists (a prior order, WhatsApp, registration,
  // OTP login, etc.). Match by email first (across ANY jid / signup path), then by
  // phone. This is what stops "two rows, same email/phone" duplicates.
  let cust = email ? get(db, 'SELECT * FROM customers WHERE LOWER(email)=? ORDER BY created_at ASC LIMIT 1', [email]) : null;
  if (!cust && phone) cust = get(db, 'SELECT * FROM customers WHERE phone=? ORDER BY created_at ASC LIMIT 1', [phone]);
  if (cust) {
    // Fill in details that were missing; never overwrite an existing email/phone.
    run(db, `UPDATE customers SET
        name  = COALESCE(NULLIF(?, ''), name),
        email = COALESCE(NULLIF(email, ''), NULLIF(?, '')),
        phone = COALESCE(phone, ?)
      WHERE jid=?`,
      [name || '', email, phone, cust.jid]);
    return get(db, 'SELECT * FROM customers WHERE jid=?', [cust.jid]);
  }
  // New person → create a guest record keyed on the deterministic email jid.
  const jid = guestJid(email);
  run(db, `INSERT INTO customers (jid, email, name, phone, guest) VALUES (?,?,?,?,1)`,
    [jid, email, name || 'Guest', phone || null]);
  return get(db, 'SELECT * FROM customers WHERE jid=?', [jid]);
}

const guestLimiter = require('express-rate-limit').rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many guest checkout attempts. Try again in 15 minutes.' },
});

router.post('/guest-checkout/upi', guestLimiter, async (req, res) => {
  try {
    const { plan_id, email, name, phone } = req.body;
    if (!plan_id) return res.status(400).json({ error: 'plan_id required' });
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Valid email required for guest checkout' });
    if (!normalizeWaPhone(phone)) return res.status(400).json({ error: 'A valid WhatsApp number is required for delivery.' });

    const db = await getDb();
    const imapEnabled = await getSetting('imap_enabled');
    if (imapEnabled !== '1') return res.status(400).json({ error: 'UPI auto-verify not enabled by store' });

    const plan = get(db, 'SELECT * FROM plans WHERE id=? AND active=1', [plan_id]);
    if (!plan) return res.status(404).json({ error: 'Plan not found or unavailable' });
    if (plan.stock === 0) return res.status(400).json({ error: 'Out of stock' });

    const cust = await ensureGuestCustomer(db, email, name, phone);
    const price = computePlanPrice(db, plan, cust, plan_id);

    // Expire any pending guest topup for same plan+email
    run(db, `UPDATE topups SET status='expired' WHERE customer_jid=? AND plan_id=? AND purpose='order' AND status='pending'`,
      [cust.jid, plan_id]);

    const { generateUniqueAmount } = require('./imap-verify');
    const usedUniques = all(db, `SELECT unique_amount FROM topups WHERE status='pending' AND purpose='order' AND method='upi_imap' AND unique_amount IS NOT NULL`).map(r => r.unique_amount);
    const uniqueMaxDelta = parseInt(await getSetting('upi_unique_max_delta') || '6', 10);
    const uniqueDir = await getSetting('upi_unique_direction') || 'both';
    const uniqueAmount = generateUniqueAmount(price, usedUniques, uniqueMaxDelta, uniqueDir);
    const eupi = await getEffectiveUpi(db);
    const windowMin = parseInt(await getSetting('upi_payment_window_minutes') || '1440', 10); // 24h: customer can finish (or be reminded to finish) the payment within a day
    const expiresAt = new Date(Date.now() + windowMin * 60 * 1000).toISOString();
    const guestToken = crypto.randomBytes(20).toString('hex');

    const r = run(db, `INSERT INTO topups (customer_jid,amount_inr,unique_amount,method,status,purpose,plan_id,currency,expires_at,guest_token) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [cust.jid, price, uniqueAmount, 'upi_imap', 'pending', 'order', plan_id, 'INR', expiresAt, guestToken]);

    const gUpiName = (eupi.upi_name || '').replace(/[^a-zA-Z0-9 ]/g, '');
    let gUpiLink = '', gUpiQr = '';
    if (eupi.upi_id) {
      const tn = String(plan.name || 'Order').replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 30) || 'Order';
      if (eupi.qr_url) {
        // Static-QR mode (see the logged-in checkout above): show the admin's uploaded
        // QR, no amount in the link, no dynamic QR. Customer pays the exact amount; IMAP matches.
        gUpiLink = `upi://pay?pa=${encodeURIComponent(eupi.upi_id)}&pn=${encodeURIComponent(gUpiName || 'Store')}&cu=INR&tn=${encodeURIComponent(tn)}`;
      } else {
        gUpiLink = `upi://pay?pa=${encodeURIComponent(eupi.upi_id)}&pn=${encodeURIComponent(gUpiName || 'Store')}&am=${uniqueAmount.toFixed(2)}&cu=INR&tn=${encodeURIComponent(tn)}`;
        try { gUpiQr = await require('qrcode').toDataURL(gUpiLink, { width: 240, margin: 1 }); } catch {}
      }
    }
    res.json({
      ok: true, guest: true,
      topup_id: r.lastInsertRowid,
      guest_token: guestToken,
      unique_amount: uniqueAmount,
      upi_id: eupi.upi_id, upi_name: gUpiName,
      upi_link: gUpiLink, upi_qr: gUpiQr,
      qr_url: eupi.qr_url || '',
      plan_name: plan.name, plan_price: price,
      expires_at: expiresAt, window_minutes: windowMin,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/guest-checkout/usdt', guestLimiter, async (req, res) => {
  try {
    const { plan_id, email, name, phone, network } = req.body;
    if (!plan_id) return res.status(400).json({ error: 'plan_id required' });
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Valid email required for guest checkout' });
    if (!normalizeWaPhone(phone)) return res.status(400).json({ error: 'A valid WhatsApp number is required for delivery.' });
    const net = String(network || '').toLowerCase();
    if (!['binance','bep20','trc20'].includes(net))
      return res.status(400).json({ error: 'Invalid network' });

    const db = await getDb();
    const imapEnabled = await getSetting('imap_enabled');
    if (imapEnabled !== '1') return res.status(400).json({ error: 'Payment auto-verify not enabled' });

    const plan = get(db, 'SELECT * FROM plans WHERE id=? AND active=1', [plan_id]);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    if (plan.stock === 0) return res.status(400).json({ error: 'Out of stock' });

    const cust = await ensureGuestCustomer(db, email, name, phone);
    const price = computePlanPrice(db, plan, cust, plan_id);

    const rateInr = parseFloat(await getSetting('usdt_inr_rate') || '84') || 84;
    const feePct  = parseFloat(await getSetting('usdt_fee_pct')  || '2')  || 2;
    const subUsdt = price / rateInr;
    const feeUsdt = subUsdt * feePct / 100;
    const totalUsdt = subUsdt + feeUsdt;
    const { generateUniqueUsdtAmount } = require('./imap-verify');
    const uniqueUsdt = generateUniqueUsdtAmount(totalUsdt);

    const addrKey = { binance:'usdt_binance_uid', bep20:'usdt_bep20_address', trc20:'usdt_trc20_address' }[net];
    const qrKey   = { binance:'usdt_binance_qr_url', bep20:'usdt_bep20_qr_url', trc20:'usdt_trc20_qr_url' }[net];
    const address = await getSetting(addrKey);
    if (!address) return res.status(400).json({ error: `USDT ${net} address not configured` });

    run(db, `UPDATE topups SET status='expired' WHERE customer_jid=? AND plan_id=? AND purpose='order' AND status='pending'`,
      [cust.jid, plan_id]);

    const windowMin = parseInt(await getSetting('usdt_payment_window_minutes') || '20', 10);
    const expiresAt = new Date(Date.now() + windowMin * 60 * 1000).toISOString();
    const guestToken = crypto.randomBytes(20).toString('hex');

    const r = run(db, `INSERT INTO topups (customer_jid,amount_inr,amount_usdt,unique_amount_usdt,method,status,purpose,plan_id,currency,expires_at,guest_token) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [cust.jid, price, totalUsdt, uniqueUsdt, `usdt_${net}`, 'pending', 'order', plan_id, 'USDT', expiresAt, guestToken]);

    res.json({
      ok: true, guest: true,
      topup_id: r.lastInsertRowid,
      guest_token: guestToken,
      network: net,
      address, qr_url: (await getSetting(qrKey)) || '',
      unique_usdt: uniqueUsdt,
      plan_price_inr: price, rate_inr_per_usd: rateInr,
      sub_usdt: subUsdt, fee_usdt: feeUsdt, fee_pct: feePct,
      plan_name: plan.name,
      expires_at: expiresAt, window_minutes: windowMin,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Guest poll — no auth cookie required; ownership proven by guest_token query param.
router.get('/guest-checkout/poll/:topupId', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'token required' });
    const db = await getDb();
    const topup = get(db, `SELECT * FROM topups WHERE id=? AND guest_token=? AND purpose='order'`,
      [req.params.topupId, token]);
    if (!topup) return res.status(404).json({ error: 'Not found' });
    if (topup.status === 'approved' && topup.order_id) {
      const order = get(db, `SELECT o.id, o.status, p.name as plan_name, p.platform FROM orders o LEFT JOIN plans p ON o.plan_id=p.id WHERE o.id=?`, [topup.order_id]);
      return res.json({ status: 'paid', order });
    }
    if (topup.status === 'approved') return res.json({ status: 'paid', order: null });
    if (['expired','rejected'].includes(topup.status)) return res.json({ status: topup.status });
    res.json({ status: 'pending' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Referral ─────────────────────────────────────────────────────────────────
router.get('/referral', requireCustomer, async (req, res) => {
  try {
    const db = await getDb();
    const c = get(db, 'SELECT referral_code, referred_by FROM customers WHERE jid=?', [req.customer.jid]);
    const rewards = all(db, `SELECT rr.*, c2.name as referred_name
      FROM referral_rewards rr LEFT JOIN customers c2 ON rr.referred_jid=c2.jid
      WHERE rr.referrer_jid=? ORDER BY rr.created_at DESC`, [req.customer.jid]);
    const totalEarned = rewards.filter(r => r.status === 'credited').reduce((s, r) => s + r.reward_inr, 0);
    const rewardAmount = parseFloat(await getSetting('referral_reward_inr') || '20');
    const baseUrl = stripSlash(await getSetting('base_url')) || stripSlash(cfg.baseUrl);
    res.json({
      referral_code: c?.referral_code,
      share_url: `${baseUrl}/my#register?ref=${c?.referral_code}`,
      rewards,
      total_earned: totalEarned,
      reward_per_referral: rewardAmount,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Reseller apply ───────────────────────────────────────────────────────────
router.post('/reseller/apply', requireCustomer, async (req, res) => {
  try {
    const db = await getDb();
    const existing = get(db, `SELECT id, status FROM resellers WHERE customer_jid=?`, [req.customer.jid]);
    if (existing) return res.json({ ok: true, status: existing.status, message: `Application ${existing.status}` });
    run(db, `INSERT INTO resellers (customer_jid) VALUES (?)`, [req.customer.jid]);
    res.json({ ok: true, status: 'pending', message: 'Reseller application submitted. Admin will review shortly.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/reseller/status', requireCustomer, async (req, res) => {
  try {
    const db = await getDb();
    const r = get(db, `SELECT status, discount_percent FROM resellers WHERE customer_jid=?`, [req.customer.jid]);
    res.json(r || { status: null });
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

// ─── Chat Bot config (public) ─────────────────────────────────────────────────
router.get('/bot-config', async (req, res) => {
  try {
    const db = await getDb();
    const keys = ['bot_enabled','bot_name','bot_tagline','bot_avatar','bot_accent','bot_greeting','site_name','support_whatsapp','support_telegram','support_instagram','support_wa_community','support_telegram_channel','support_custom_links'];
    const rows = all(db, `SELECT key, value FROM settings WHERE key IN (${keys.map(()=>'?').join(',')})`, keys);
    const s = {};
    rows.forEach(r => s[r.key] = r.value);
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── AI Chat (public — powers store chat widget) ──────────────────────────────
const _chatLog = new Map(); // simple IP rate-limiter: ip → {count, ts}
router.post('/ai-chat', async (req, res) => {
  try {
    // rate limit: 20 messages per minute per IP
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const entry = _chatLog.get(ip) || { count: 0, ts: now };
    if (now - entry.ts > 60000) { entry.count = 0; entry.ts = now; }
    entry.count++;
    _chatLog.set(ip, entry);
    if (entry.count > 20) return res.status(429).json({ error: 'Too many messages. Please wait a moment.' });

    const { messages } = req.body;
    if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages required' });

    const db = await getDb();

    const { buildStoreSystemPrompt } = require('./ai');
    const systemPrompt = await buildStoreSystemPrompt(db);

    const { chat } = require('./ai');
    const fullMessages = [{ role: 'system', content: systemPrompt }, ...messages.slice(-10)];
    const rawReply = await chat(fullMessages.slice(1), { model: undefined, max_tokens: 400, _systemOverride: systemPrompt });

    // Strip legacy quick-reply metadata; the chat widget now stays text-only.
    const text = rawReply.replace(/\[BUTTONS:[^\]]*\]/i, '').trim();

    res.json({ text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
