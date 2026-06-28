'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cfg = require('./config');
const { getDb, getSetting, setSetting, restoreDb, all, get, run, makePlanSlug } = require('./db');
const { durationDaysFromName, logoForName } = require('./plans-util');
const { loginLimiter, requireCsrf, checkCredentialThrottle, recordFailedLogin, clearFailedLogin } = require('./security');
const { audit } = require('./audit');
const { submitUrls, pingSitemap } = require('./google-index');
const { sendOrderDelivery, sendMail } = require('./mailer');
const { buildXlsx, parseXlsx } = require('./xlsx');
const totp = require('./totp');
const crypto = require('crypto');
const design = require('./design');

const router = express.Router();

// CSRF guard for all admin write requests. ensureCsrfToken (global) sets a
// csrfToken cookie on every visitor; the admin SPA reads it and sends it back
// as X-CSRF-Token on POST/PUT/DELETE. A cross-site attacker can never read the
// cookie (SameSite=strict) so they can't forge a matching header. Safe methods
// (GET/HEAD/OPTIONS) skip the check inside requireCsrf itself.
router.use(requireCsrf);

const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
// Separate uploader for database restore — the .db can be larger than the 2 MB
// image cap, so allow up to 100 MB (still well under Telegram's 50 MB send cap).
const dbUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
// Custom Android APK (sideload build) — can be larger than the DB cap.
const apkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

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
      // No hash configured: only accept a non-empty ADMIN_PASSWORD env value.
      // (Empty passwords are already rejected above, so an unset password = login disabled.)
      ok = (cfg.adminPassword !== '' && password === cfg.adminPassword);
    }
    if (!ok) {
      recordFailedLogin('admin');
      return res.status(401).json({ error: 'Invalid password' });
    }
    // Second factor (TOTP). Off by default; once enabled, a valid 6-digit code or a
    // one-time backup code is required. DISABLE_2FA=1 env is an emergency escape.
    if ((await getSetting('admin_2fa_enabled')) === '1' && process.env.DISABLE_2FA !== '1') {
      const otp = req.body.token;
      if (!otp) return res.status(401).json({ error: '2FA code required', twofa: true });
      const secret = await getSetting('admin_2fa_secret');
      const okOtp = totp.verify(otp, secret, 1) || await consumeBackupCode(otp);
      if (!okOtp) { recordFailedLogin('admin'); return res.status(401).json({ error: 'Invalid 2FA code', twofa: true }); }
    }
    clearFailedLogin('admin');
    setAdminCookie(res);
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: 'login', ip: req.ip });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Admin two-factor auth (TOTP — Google Authenticator / Authy) ──────────────
function hashBackupCode(code) { return crypto.createHash('sha256').update(String(code)).digest('hex'); }
async function consumeBackupCode(code) {
  const raw = await getSetting('admin_2fa_backup');
  if (!raw) return false;
  let arr; try { arr = JSON.parse(raw); } catch { return false; }
  const h = hashBackupCode(String(code || '').replace(/\s/g, '').toLowerCase());
  const idx = arr.indexOf(h);
  if (idx === -1) return false;
  arr.splice(idx, 1);                                  // one-time use
  await setSetting('admin_2fa_backup', JSON.stringify(arr));
  return true;
}

router.get('/2fa/status', requireAdmin, async (req, res) => {
  try {
    const enabled = (await getSetting('admin_2fa_enabled')) === '1';
    let backupLeft = 0;
    if (enabled) { try { backupLeft = JSON.parse((await getSetting('admin_2fa_backup')) || '[]').length; } catch {} }
    res.json({ enabled, backupLeft });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Begin enrollment: mint a fresh (pending) secret and return a QR to scan.
router.post('/2fa/setup', requireAdmin, async (req, res) => {
  try {
    if ((await getSetting('admin_2fa_enabled')) === '1') return res.status(400).json({ error: '2FA is already on. Turn it off first to re-enroll.' });
    const secret = totp.generateSecret();
    const siteName = (await getSetting('site_name')) || 'OTT24x7';
    const uri = totp.keyuri(secret, 'admin', `${siteName} Admin`);
    const qr = await require('qrcode').toDataURL(uri, { width: 240, margin: 1 });
    await setSetting('admin_2fa_secret', secret);      // pending until /2fa/enable confirms a code
    res.json({ secret, otpauth: uri, qr });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Confirm a code → activate 2FA, return one-time backup codes (shown once).
router.post('/2fa/enable', requireAdmin, async (req, res) => {
  try {
    const secret = await getSetting('admin_2fa_secret');
    if (!secret) return res.status(400).json({ error: 'Start setup first.' });
    if (!totp.verify(req.body.token, secret, 1)) return res.status(400).json({ error: 'Invalid code — check your phone clock and enter the current 6-digit code.' });
    const codes = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString('hex'));
    await setSetting('admin_2fa_backup', JSON.stringify(codes.map(c => hashBackupCode(c))));
    await setSetting('admin_2fa_enabled', '1');
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: '2fa_enabled', ip: req.ip });
    res.json({ ok: true, backupCodes: codes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Turn off 2FA — requires a current code or a backup code.
router.post('/2fa/disable', requireAdmin, async (req, res) => {
  try {
    if ((await getSetting('admin_2fa_enabled')) !== '1') { await setSetting('admin_2fa_secret', ''); return res.json({ ok: true }); }
    const secret = await getSetting('admin_2fa_secret');
    const ok = totp.verify(req.body.token, secret, 1) || await consumeBackupCode(req.body.token);
    if (!ok) return res.status(400).json({ error: 'Enter a current 6-digit code (or a backup code) to turn off 2FA.' });
    await setSetting('admin_2fa_enabled', '0');
    await setSetting('admin_2fa_secret', '');
    await setSetting('admin_2fa_backup', '');
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: '2fa_disabled', ip: req.ip });
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


function cleanupUploadedFile(url, keepFilename = '') {
  try {
    if (!url || !String(url).startsWith('/data/uploads/')) return;
    const filename = path.basename(url);
    if (!filename || filename === keepFilename) return;
    const filepath = path.join(UPLOADS_DIR, filename);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  } catch {}
}

// ─── Plan image upload ────────────────────────────────────────────────────────
router.post('/plans/:id/upload-image', requireAdmin, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
    const filename = `plan_${req.params.id}_${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), req.file.buffer);
    const url = `/data/uploads/${filename}`;
    const db = await getDb();
    const old = get(db, `SELECT image_url FROM plans WHERE id=?`, [req.params.id]);
    run(db, `UPDATE plans SET image_url=? WHERE id=?`, [url, req.params.id]);
    cleanupUploadedFile(old?.image_url, filename);
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
    const type = ['dark', 'app'].includes(req.params.type) ? req.params.type : 'light';
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const ext = (req.file.originalname.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
    const filename = `logo_${type}_${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), req.file.buffer);
    const url = `/data/uploads/${filename}`;
    const db = await getDb();
    const old = get(db, `SELECT value FROM settings WHERE key=?`, [`logo_${type}_url`]);
    run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`, [`logo_${type}_url`, url]);
    cleanupUploadedFile(old?.value, filename);
    res.json({ ok: true, url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/upload-logo/:type', requireAdmin, async (req, res) => {
  try {
    const type = ['dark', 'app'].includes(req.params.type) ? req.params.type : 'light';
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

// ─── Android APK (custom sideload build) ──────────────────────────────────────
// Admin uploads the APK they built in Android Studio → hosted under /data/uploads
// and offered for download on /get-app. Or set an external URL (Drive, GitHub).
router.post('/upload-apk', requireAdmin, apkUpload.single('apk'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!/\.apk$/i.test(req.file.originalname || '')) return res.status(400).json({ error: 'File must be a .apk' });
    fs.writeFileSync(path.join(UPLOADS_DIR, 'ott24x7.apk'), req.file.buffer);
    const url = '/data/uploads/ott24x7.apk';
    const version = String(req.body.version || '').trim().slice(0, 40);
    const db = await getDb();
    run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES ('apk_url',?)`, [url]);
    run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES ('apk_version',?)`, [version]);
    run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES ('apk_size',?)`, [String(req.file.size)]);
    res.json({ ok: true, url, version, size: req.file.size });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Set/clear an external APK URL (when hosting the file elsewhere).
router.post('/apk-url', requireAdmin, async (req, res) => {
  try {
    const url = String(req.body.url || '').trim();
    if (url && !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Enter a full https:// URL' });
    const db = await getDb();
    if (url) {
      run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES ('apk_url',?)`, [url]);
      run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES ('apk_version',?)`, [String(req.body.version || '').trim().slice(0, 40)]);
      run(db, `DELETE FROM settings WHERE key='apk_size'`);
    } else {
      run(db, `DELETE FROM settings WHERE key IN ('apk_url','apk_version','apk_size')`);
    }
    res.json({ ok: true, url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/upload-apk', requireAdmin, async (req, res) => {
  try {
    const fp = path.join(UPLOADS_DIR, 'ott24x7.apk');
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    const db = await getDb();
    run(db, `DELETE FROM settings WHERE key IN ('apk_url','apk_version','apk_size')`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── WhatsApp community feed config ───────────────────────────────────────────
router.get('/wa-groups', requireAdmin, async (req, res) => {
  try { const groups = await require('./wa-bot').getGroups(); res.json({ ok: true, groups: groups || [] }); }
  catch (e) { res.json({ ok: true, groups: [], error: e.message }); }
});
router.post('/community-config', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const b = req.body || {};
    const set = (k, v) => run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`, [k, String(v == null ? '' : v)]);
    if (b.enabled != null) set('community_enabled', b.enabled ? '1' : '0');
    if (b.jid != null) set('community_jid', String(b.jid).trim());
    if (b.name != null) set('community_name', String(b.name).slice(0, 80));
    if (b.subtitle != null) set('community_subtitle', String(b.subtitle).slice(0, 160));
    if (b.invite_url != null) set('community_invite_url', String(b.invite_url).trim().slice(0, 300));
    const count = (get(db, `SELECT COUNT(*) AS n FROM community_posts`) || {}).n || 0;
    res.json({ ok: true, posts: count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/community-posts', requireAdmin, async (req, res) => {
  try { const db = await getDb(); run(db, `DELETE FROM community_posts`); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
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

// Export the entire product catalog to a real .xlsx workbook. GET is exempt from
// the CSRF guard; the adminToken cookie authenticates the download. The whole
// file is built in memory and streamed — it is never written to disk.
router.get('/plans/export.xlsx', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const plans = all(db, `SELECT * FROM plans ORDER BY sort_order ASC, id ASC`);

    const num = v => (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) ? '' : Number(v);
    const featuresText = v => {
      try { const f = JSON.parse(v || '[]'); return Array.isArray(f) ? f.join(' | ') : String(v || ''); }
      catch { return String(v || ''); }
    };

    // [Header label, value extractor]. Numbers stay numeric in the sheet; the
    // rest become text. Keeps the export self-describing and re-importable.
    const columns = [
      ['ID',                  p => num(p.id)],
      ['Platform',            p => p.platform || ''],
      ['Name',                p => p.name || ''],
      ['Category',            p => p.category || ''],
      ['Price (INR)',         p => num(p.price_inr)],
      ['Price (USD)',         p => num(p.price_usd)],
      ['Original Price (INR)',p => num(p.original_price_inr)],
      ['Duration (days)',     p => num(p.duration_days)],
      ['Stock',               p => (p.stock === -1 || p.stock === null || p.stock === undefined) ? 'Unlimited' : num(p.stock)],
      ['Active',              p => (p.active ? 'Yes' : 'No')],
      ['Delivery Type',       p => p.delivery_type || ''],
      ['Delivery Est',        p => p.delivery_time_est || ''],
      ['Badge',               p => p.badge || ''],
      ['Sort Order',          p => num(p.sort_order)],
      ['Features',            p => featuresText(p.features)],
      ['Description',         p => p.description || ''],
      ['Image URL',           p => p.image_url || ''],
      ['Provider API',        p => p.provider_api || ''],
      ['Provider Product ID', p => p.provider_product_id || ''],
      ['Slug',                p => p.slug || ''],
      ['No Index',            p => (Number(p.noindex) === 1 ? 'Yes' : 'No')],
      ['Created At',          p => p.created_at || ''],
    ];

    const header = columns.map(c => c[0]);
    const rows = plans.map(p => columns.map(c => c[1](p)));
    const buf = buildXlsx('Products', header, rows);

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="products-${stamp}.xlsx"`);
    res.send(buf);
    audit({ actorKind: 'admin', actorLabel: 'admin', action: 'export_plans_xlsx', after: { count: plans.length }, ip: req.ip }).catch(() => {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Import products from an .xlsx in the export format. A row whose Name exactly
// matches an existing product REPLACES it (only the columns present in the file
// are written, so partial sheets don't wipe other fields); a new Name is added.
// The ID and Created At columns are informational and ignored on import.
router.post('/plans/import', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'No file uploaded' });
    let rows;
    try { rows = parseXlsx(req.file.buffer); }
    catch (e) { return res.status(400).json({ error: 'Could not read spreadsheet — make sure it is a .xlsx file. (' + e.message + ')' }); }
    if (!rows.length) return res.status(400).json({ error: 'The spreadsheet has no rows.' });

    // Resolve columns from the header row (case-insensitive, trimmed).
    const header = rows[0].map(h => String(h || '').trim().toLowerCase());
    const idx = label => header.indexOf(label.toLowerCase());
    const col = {
      platform: idx('Platform'), name: idx('Name'), category: idx('Category'),
      price_inr: idx('Price (INR)'), price_usd: idx('Price (USD)'), original_price_inr: idx('Original Price (INR)'),
      duration_days: idx('Duration (days)'), stock: idx('Stock'), active: idx('Active'),
      delivery_type: idx('Delivery Type'), delivery_time_est: idx('Delivery Est'),
      badge: idx('Badge'), sort_order: idx('Sort Order'), features: idx('Features'),
      description: idx('Description'), image_url: idx('Image URL'),
      provider_api: idx('Provider API'), provider_product_id: idx('Provider Product ID'), slug: idx('Slug'),
      noindex: idx('No Index'),
    };
    if (col.name < 0) return res.status(400).json({ error: 'Missing required "Name" column.' });

    const db = await getDb();
    const cell = (row, f) => col[f] >= 0 ? String(row[col[f]] ?? '').trim() : '';
    const numOr = (s, dflt) => { const n = parseFloat(String(s).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : dflt; };
    const parsers = {
      platform: s => s || 'Other',
      category: s => s,
      price_inr: s => numOr(s, 0),
      price_usd: s => numOr(s, 0),
      original_price_inr: s => s === '' ? null : numOr(s, null),
      duration_days: s => s === '' ? null : Math.round(numOr(s, 0)),
      stock: s => (/^unlimited$/i.test(s) || s === '') ? -1 : Math.round(numOr(s, -1)),
      active: s => ['no', '0', 'false', 'inactive', 'n', ''].includes(s.toLowerCase()) ? (s === '' ? 1 : 0) : 1,
      delivery_type: s => s || 'manual',
      delivery_time_est: s => s,
      badge: s => s || null,
      sort_order: s => Math.round(numOr(s, 0)),
      features: s => JSON.stringify(s ? s.split('|').map(x => x.trim()).filter(Boolean) : []),
      description: s => s || null,
      image_url: s => s,
      provider_api: s => s,
      provider_product_id: s => s,
      noindex: s => /^(yes|1|true|y)$/i.test(s) ? 1 : 0,
    };
    const FIELDS = Object.keys(parsers);
    const INSERT_DEFAULTS = {
      platform: 'Other', category: '', price_inr: 0, price_usd: 0, original_price_inr: null,
      duration_days: null, stock: -1, active: 1, delivery_type: 'manual', delivery_time_est: '',
      badge: null, sort_order: 0, features: '[]', description: null, image_url: '',
      provider_api: '', provider_product_id: '', noindex: 0,
    };

    // Load slugs once; keep it current as we insert so generated slugs stay unique.
    const slugSet = new Set(all(db, 'SELECT slug FROM plans WHERE slug IS NOT NULL').map(p => p.slug));

    let inserted = 0, updated = 0, skipped = 0;
    const errors = [];

    for (let i = 1; i < rows.length; i++) {
      try {
        const row = rows[i];
        const name = cell(row, 'name');
        if (!name) { skipped++; continue; }

        // Only the fields whose column exists in the file get written.
        const fields = {};
        for (const f of FIELDS) if (col[f] >= 0) fields[f] = parsers[f](cell(row, f));

        const existing = get(db, 'SELECT id FROM plans WHERE name=? ORDER BY id ASC LIMIT 1', [name]);
        if (existing) {
          const keys = Object.keys(fields);
          if (keys.length) {
            run(db, `UPDATE plans SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`,
              [...keys.map(k => fields[k]), existing.id]);
          }
          updated++;
        } else {
          const v = { ...INSERT_DEFAULTS, ...fields };
          const slug = makePlanSlug((col.slug >= 0 ? cell(row, 'slug') : '') || `${v.platform} ${name}`, slugSet);
          slugSet.add(slug);
          run(db,
            `INSERT INTO plans (platform,name,duration_days,price_inr,original_price_inr,price_usd,
              description,features,badge,stock,active,sort_order,
              category,image_url,provider_api,provider_product_id,delivery_type,delivery_time_est,slug,noindex)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [v.platform, name, (v.duration_days || durationDaysFromName(name)), v.price_inr, v.original_price_inr, v.price_usd,
             v.description, v.features, v.badge, v.stock, v.active, v.sort_order,
             v.category, (v.image_url || logoForName(name, v.platform)), v.provider_api, v.provider_product_id, v.delivery_type, v.delivery_time_est, slug, v.noindex]);
          inserted++;
        }
      } catch (rowErr) {
        skipped++;
        if (errors.length < 20) errors.push(`Row ${i + 1}: ${rowErr.message}`);
      }
    }

    await audit({ actorKind: 'admin', actorLabel: 'admin', action: 'import_plans_xlsx', after: { inserted, updated, skipped }, ip: req.ip });
    res.json({ ok: true, inserted, updated, skipped, total: rows.length - 1, errors });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/plans', requireAdmin, async (req, res) => {
  try {
    const { platform, name, duration_days, price_inr, original_price_inr, price_usd,
            description, features, badge, stock, active, sort_order,
            category, image_url, provider_api, provider_product_id, delivery_type, delivery_time_est,
            slug: slugOverride } = req.body;
    if (!platform || !name) return res.status(400).json({ error: 'Platform and name required' });
    const db = await getDb();
    // Auto-generate slug from "platform name" unless admin provided one
    const existingSlugs = new Set(all(db,'SELECT slug FROM plans WHERE slug IS NOT NULL').map(p=>p.slug));
    const slug = makePlanSlug(slugOverride || `${platform} ${name}`, existingSlugs);
    const r = run(db,
      `INSERT INTO plans (platform,name,duration_days,price_inr,original_price_inr,price_usd,
        description,features,badge,stock,active,sort_order,
        category,image_url,provider_api,provider_product_id,delivery_type,delivery_time_est,slug)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [platform, name, (duration_days || durationDaysFromName(name) || null), price_inr||0, original_price_inr||null, price_usd||0,
       description||null, JSON.stringify(features||[]), badge||null,
       stock??-1, active??1, sort_order||0,
       category||'', (image_url || logoForName(name, platform) || ''), provider_api||'', provider_product_id||'',
       delivery_type||'manual', delivery_time_est||'', slug]);
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: 'create_plan', targetKind: 'plan', targetId: r.lastInsertRowid, after: req.body, ip: req.ip });
    res.json({ ok: true, id: r.lastInsertRowid, slug });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/plans/:id', requireAdmin, async (req, res) => {
  try {
    const { platform, name, duration_days, price_inr, original_price_inr, price_usd,
            description, features, badge, stock, active, sort_order,
            category, image_url, provider_api, provider_product_id, delivery_type, delivery_time_est,
            slug: slugOverride } = req.body;
    const db = await getDb();
    const existing = get(db, 'SELECT slug FROM plans WHERE id=?', [req.params.id]);
    // Re-generate slug only when name changes or admin supplied a new one.
    // Never let an UPDATE steal another plan's slug — exclude self from the unique check.
    const otherSlugs = new Set(all(db,'SELECT slug FROM plans WHERE slug IS NOT NULL AND id!=?',[req.params.id]).map(p=>p.slug));
    let slug = existing?.slug || null;
    if (slugOverride && slugOverride !== slug) {
      slug = makePlanSlug(slugOverride, otherSlugs);
    } else if (!slug) {
      slug = makePlanSlug(`${platform||''} ${name||''}`, otherSlugs);
    }
    run(db,
      `UPDATE plans SET platform=?,name=?,duration_days=?,price_inr=?,original_price_inr=?,price_usd=?,
       description=?,features=?,badge=?,stock=?,active=?,sort_order=?,
       category=?,image_url=?,provider_api=?,provider_product_id=?,delivery_type=?,delivery_time_est=?,slug=?
       WHERE id=?`,
      [platform, name, duration_days||null, price_inr||0, original_price_inr||null, price_usd||0,
       description||null, JSON.stringify(features||[]), badge||null,
       stock??-1, active??1, sort_order||0,
       category||'', image_url||'', provider_api||'', provider_product_id||'',
       delivery_type||'manual', delivery_time_est||'', slug, req.params.id]);
    res.json({ ok: true, slug });
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

// ─── Bot supplier (OTT24x7 reseller API) ───────────────────────────────────────
// Connection + import status for the admin UI.
router.get('/bot/status', requireAdmin, async (req, res) => {
  try {
    const botSupplier = require('./bot-supplier');
    const db = await getDb();
    const c = botSupplier.botConfig(db);
    const imported = get(db, `SELECT COUNT(*) AS n FROM plans WHERE provider_api='bot'`)?.n || 0;
    if (!botSupplier.isConfigured(c)) return res.json({ ok: true, configured: false, imported });
    const bal = await botSupplier.fetchBalance(db);
    const prods = await botSupplier.fetchProducts(db);
    res.json({
      ok: true, configured: true, url: c.url,
      connected: !!(bal.ok || prods.ok),
      balance: bal.ok ? bal.balance : null,
      balance_formatted: bal.ok ? (bal.formatted || null) : null,
      provider_products: prods.ok ? prods.products.length : null,
      imported,
      error: (bal.ok || prods.ok) ? null : (bal.error || prods.error),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Pull the bot catalog into Plans now (provider_api='bot'). Price is set once on
// import; re-syncs refresh name/stock/active only and never overwrite your price.
router.post('/bot/sync', requireAdmin, async (req, res) => {
  try {
    const botSupplier = require('./bot-supplier');
    const db = await getDb();
    const r = await botSupplier.syncCatalog(db);
    if (!r.ok) {
      return res.status(400).json({ error: r.error === 'not_configured'
        ? 'Bot API not configured — set BOT_API_URL and BOT_API_TOKEN.' : r.error });
    }
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: 'bot_sync', after: r, ip: req.ip });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// All bot products, annotated with whether each is imported here + your selling
// price / active state. Powers the Bot Catalog management page.
router.get('/bot/products', requireAdmin, async (req, res) => {
  try {
    const botSupplier = require('./bot-supplier');
    const db = await getDb();
    if (!botSupplier.isConfigured(botSupplier.botConfig(db))) return res.json({ ok: false, configured: false, products: [] });
    const r = await botSupplier.fetchProducts(db);
    if (!r.ok) return res.status(400).json({ error: r.error === 'not_configured' ? 'Bot API not configured.' : r.error });
    const mine = {};
    all(db, `SELECT id, provider_product_id, price_inr, active, stock FROM plans WHERE provider_api='bot'`)
      .forEach(p => { mine[String(p.provider_product_id)] = p; });
    const products = r.products.map(p => {
      const m = mine[String(p.id)];
      return {
        id: String(p.id), name: p.name || 'Plan', category: p.category || '',
        delivery_type: p.delivery_type === 'auto' ? 'auto' : 'manual',
        in_stock: p.in_stock !== false, stock: p.stock,
        bot_price: Math.ceil(Number(p.retail_price) || Number(p.price) || 0),
        imported: !!m, plan_id: m ? m.id : null,
        your_price: m ? m.price_inr : null, active: m ? m.active : null,
      };
    });
    res.json({ ok: true, configured: true, auto_import: (await getSetting('bot_auto_import')) === '1', products });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Import selected bot products with an optional markup over the bot's retail price.
router.post('/bot/import', requireAdmin, async (req, res) => {
  try {
    const botSupplier = require('./bot-supplier');
    const db = await getDb();
    const ids = Array.isArray(req.body.product_ids) ? req.body.product_ids : [];
    if (!ids.length) return res.status(400).json({ error: 'Select at least one product to add.' });
    const markup = Math.max(0, Number(req.body.markup_percent) || 0);
    const r = await botSupplier.importProducts(db, ids, markup);
    if (!r.ok) return res.status(400).json({ error: r.error });
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: 'bot_import', targetKind: 'bot', targetId: String(r.imported), ip: req.ip });
    res.json({ ok: true, imported: r.imported });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Toggle a bot plan active/inactive.
router.post('/bot/plans/:id/toggle', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const p = get(db, `SELECT id, active FROM plans WHERE id=? AND provider_api='bot'`, [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Bot product not found' });
    const next = p.active ? 0 : 1;
    run(db, `UPDATE plans SET active=? WHERE id=?`, [next, p.id]);
    res.json({ ok: true, active: next });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Set a bot plan's selling price.
router.post('/bot/plans/:id/price', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const price = Math.max(0, Math.round((Number(req.body.price_inr) || 0) * 100) / 100);
    if (!price) return res.status(400).json({ error: 'Enter a valid price' });
    const p = get(db, `SELECT id FROM plans WHERE id=? AND provider_api='bot'`, [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Bot product not found' });
    run(db, `UPDATE plans SET price_inr=? WHERE id=?`, [price, p.id]);
    res.json({ ok: true, price_inr: price });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Remove a bot product from the store — hard-delete if it has no orders, else just
// deactivate it (so order history + slugs stay intact).
router.delete('/bot/plans/:id', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const p = get(db, `SELECT id FROM plans WHERE id=? AND provider_api='bot'`, [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Bot product not found' });
    // Keep (deactivate) if the plan has ANY order OR a live payment — a customer may
    // have a paid-but-not-yet-matched checkout for it. Hard-delete only when there's
    // no activity, so a mid-checkout payment can never be orphaned.
    const hasActivity = get(db, `SELECT 1 FROM orders WHERE plan_id=?
      UNION ALL SELECT 1 FROM topups WHERE plan_id=? AND status IN ('pending','approved','refund_needed') LIMIT 1`, [p.id, p.id]);
    if (hasActivity) run(db, `UPDATE plans SET active=0 WHERE id=?`, [p.id]);
    else run(db, `DELETE FROM plans WHERE id=?`, [p.id]);
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: 'bot_remove', targetKind: 'plan', targetId: String(p.id), ip: req.ip });
    res.json({ ok: true, deleted: !hasActivity, deactivated: !!hasActivity });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Toggle whether NEW bot products auto-import on sync (off = manual select-and-add).
router.post('/bot/auto-import', requireAdmin, async (req, res) => {
  try {
    await setSetting('bot_auto_import', req.body.enabled ? '1' : '0');
    res.json({ ok: true, enabled: !!req.body.enabled });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// The bot's own admin-panel URL for the "Bot Panel ↗" sidebar link. Defaults to
// BOT_API_URL (the same app serves both the admin UI and the /reseller API).
router.get('/bot/admin-url', requireAdmin, async (req, res) => {
  try {
    const cfg = require('./config');
    res.json({ url: (await getSetting('bot_admin_url')) || cfg.bot.apiUrl || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/bot/admin-url', requireAdmin, async (req, res) => {
  try {
    await setSetting('bot_admin_url', String(req.body.url || '').trim());
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Orders ───────────────────────────────────────────────────────────────────
router.get('/orders', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    let sql = `SELECT o.*, p.name as plan_name, p.platform, p.provider_api, p.delivery_type, c.email as customer_email, c.name as customer_name
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
    // Compute the new delivered_at as a real value (not a SQL fragment) — the
    // previous code interpolated `order.delivered_at` straight into the SQL
    // string, opening a SQL-injection path if any caller ever poisoned that
    // column. We now bind it as a parameter.
    const deliveredAt = status === 'delivered' && order.status !== 'delivered'
      ? new Date().toISOString()
      : (order.delivered_at || null);
    run(db, `UPDATE orders SET status=?, credentials=?, delivery_note=?, expires_at=?, delivered_at=? WHERE id=?`,
      [status || order.status, credsJson, delivery_note ?? order.delivery_note, expires_at ?? order.expires_at, deliveredAt, req.params.id]);
    if (status === 'delivered' && order.status !== 'delivered' && order.email) {
      const creds = credentials || (order.credentials ? JSON.parse(order.credentials) : {});
      sendOrderDelivery(order.email, order.cname, order, creds).catch(() => {});
    }
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: `order_${status}`, targetKind: 'order', targetId: req.params.id, ip: req.ip });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Bulk + single delete ─────────────────────────────────────────────────────
// Deleting an order has side effects on three other tables: stock_credentials
// (sold key goes back to available), topups (unlink so payment history isn't
// orphaned), referral_rewards (cancel any reward earned through this order),
// fulfillment_jobs (the per-order job is no longer relevant). This helper
// applies that cleanup, used by both the single + bulk endpoints.
function deleteOrderInternal(db, orderId) {
  const o = get(db, 'SELECT id FROM orders WHERE id=?', [orderId]);
  if (!o) return false;
  // Release any stock credentials sold for this order back to the pool.
  run(db, `UPDATE stock_credentials SET status='available', sold_order_id=NULL, sold_at=NULL WHERE sold_order_id=?`, [orderId]);
  // Keep the topup row (payment history), just unlink it from the gone order.
  run(db, `UPDATE topups SET order_id=NULL WHERE order_id=?`, [orderId]);
  // Drop any referral reward tied to this order. Credited rewards stay tied
  // (the payout already happened); only pending ones are scrubbed.
  run(db, `DELETE FROM referral_rewards WHERE order_id=? AND status='pending'`, [orderId]);
  run(db, `UPDATE referral_rewards SET order_id=NULL WHERE order_id=?`, [orderId]);
  // Per-order fulfillment job (UNIQUE on order_id) — safe to drop.
  try { run(db, `DELETE FROM fulfillment_jobs WHERE order_id=?`, [orderId]); } catch {}
  run(db, `DELETE FROM orders WHERE id=?`, [orderId]);
  return true;
}

router.delete('/orders/:id', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const ok = deleteOrderInternal(db, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Order not found' });
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: 'order_deleted', targetKind: 'order', targetId: req.params.id, ip: req.ip });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const BULK_ALLOWED_STATUSES = new Set(['pending', 'processing', 'delivered', 'expired', 'cancelled']);

// Bulk delete — POST not DELETE because we need a body, and most HTTP clients
// won't send one with DELETE. Accepts up to 500 ids in a single request.
router.post('/orders/bulk-delete', requireAdmin, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(n => Number.isInteger(n) && n > 0) : [];
    if (!ids.length) return res.status(400).json({ error: 'No order ids provided' });
    if (ids.length > 500) return res.status(400).json({ error: 'Too many orders (max 500 per request)' });
    const db = await getDb();
    let deleted = 0;
    for (const id of ids) if (deleteOrderInternal(db, id)) deleted++;
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: 'orders_bulk_deleted', targetKind: 'order', targetId: ids.join(','), ip: req.ip });
    res.json({ ok: true, deleted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk status change — updates many orders at once with the same status.
// Mirrors the side effect of the single PUT: marking delivered stamps
// delivered_at. We do NOT send delivery emails here — that's a one-by-one
// action; bulk is for cleanup/admin work.
router.post('/orders/bulk-status', requireAdmin, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(n => Number.isInteger(n) && n > 0) : [];
    const status = String(req.body?.status || '').trim();
    if (!ids.length) return res.status(400).json({ error: 'No order ids provided' });
    if (ids.length > 500) return res.status(400).json({ error: 'Too many orders (max 500 per request)' });
    if (!BULK_ALLOWED_STATUSES.has(status)) return res.status(400).json({ error: 'Invalid status' });
    const db = await getDb();
    let updated = 0;
    const nowIso = new Date().toISOString();
    for (const id of ids) {
      const cur = get(db, 'SELECT status, delivered_at FROM orders WHERE id=?', [id]);
      if (!cur) continue;
      const deliveredAt = status === 'delivered' && cur.status !== 'delivered' ? nowIso : (cur.delivered_at || null);
      run(db, 'UPDATE orders SET status=?, delivered_at=? WHERE id=?', [status, deliveredAt, id]);
      updated++;
    }
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: `orders_bulk_${status}`, targetKind: 'order', targetId: ids.join(','), ip: req.ip });
    res.json({ ok: true, updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// One-click "Buy from bot & deliver" — for a bot-product order, buy the key live from
// the bot and deliver it. If the bot returns a key the customer is delivered + emailed
// immediately; if the bot fulfils it manually (no key yet) or is out of stock, the
// admin is told what to do (we do NOT auto-refund a manual product the bot will fill).
router.post('/orders/:id/buy-from-bot', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const order = get(db, `SELECT o.*, c.email, c.name AS cname FROM orders o LEFT JOIN customers c ON c.jid=o.customer_jid WHERE o.id=?`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'delivered') return res.status(400).json({ error: 'Order is already delivered' });
    if (order.status === 'cancelled') return res.status(400).json({ error: 'Order is cancelled' });
    const plan = get(db, `SELECT * FROM plans WHERE id=?`, [order.plan_id]);
    if (!plan || plan.provider_api !== 'bot') return res.status(400).json({ error: 'Not a bot product — deliver from Stock or paste the key manually.' });
    const botSupplier = require('./bot-supplier');
    if (!botSupplier.isConfigured(botSupplier.botConfig(db))) return res.status(400).json({ error: 'Bot API not configured.' });

    const r = await botSupplier.purchase(plan.provider_product_id, 1, { order_id: order.id, source: 'ott-store-admin', email: order.email || '' }, db);
    if (r.ok && r.keys && r.keys.length > 0) {
      const { deliverWithCredentials, credentialsFromKeys } = require('./delivery-worker');
      const delivered = await deliverWithCredentials(db, order, credentialsFromKeys(r.keys),
        { via: 'bot', actorKind: 'admin', actorLabel: 'admin', note: 'Bought from bot by admin' });
      await audit({ actorKind: 'admin', actorLabel: 'admin', action: 'bot_buy_manual', targetKind: 'order', targetId: String(order.id), ip: req.ip });
      return res.json({ ok: true, delivered: !!delivered, message: 'Bought from the bot and delivered to the customer. ✅' });
    }
    if (r.outOfStock) {
      return res.json({ ok: true, delivered: false, out_of_stock: true,
        message: 'The bot is out of stock for this product. Use "Cancel & Refund" to refund the customer.' });
    }
    return res.json({ ok: true, delivered: false, message: r.ok
      ? 'The bot accepted the order but has not returned a key yet — it likely fulfils this product manually. Check your bot, then paste the key here and Deliver.'
      : `Bot purchase failed: ${r.error || 'unknown'}. Buy it on your bot, then paste the key here and Deliver.` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cancel a paid order and refund its amount to the customer's store wallet.
router.post('/orders/:id/refund-wallet', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const order = get(db, `SELECT o.*, c.name AS cname, c.email, c.phone FROM orders o LEFT JOIN customers c ON o.customer_jid=c.jid WHERE o.id=?`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'cancelled') return res.status(400).json({ error: 'Order is already cancelled' });
    const amount = Math.round((parseFloat(order.amount_inr) || 0) * 100) / 100;
    if (amount <= 0) return res.status(400).json({ error: 'Order amount is ₹0 — nothing to refund' });
    if (!order.customer_jid) return res.status(400).json({ error: 'Order has no customer to refund' });
    const dup = get(db, `SELECT id FROM wallet_txns WHERE type='refund' AND ref_id=? LIMIT 1`, [String(order.id)]);
    if (dup) return res.status(400).json({ error: 'This order was already refunded' });

    const { creditWallet } = require('./wallet');
    const newBal = creditWallet(db, order.customer_jid, amount, { type: 'refund', label: `Refund — order #${order.id}`, ref_id: order.id });
    run(db, `UPDATE orders SET status='cancelled' WHERE id=?`, [order.id]);
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: 'order_refund_wallet', targetKind: 'order', targetId: String(order.id), ip: req.ip });

    try {
      if (order.email) {
        sendMail({ to: order.email, subject: `Refund — order #${order.id}`,
          html: `<p>Hi ${order.cname || ''},</p><p>Your order <b>#${order.id}</b> was cancelled and <b>₹${amount.toFixed(2)}</b> has been added to your store wallet.</p><p>Wallet balance: <b>₹${newBal.toFixed(2)}</b> — use it on your next purchase at checkout.</p>` }).catch(() => {});
      }
      const phone = String(order.phone || '').replace(/\D/g, '');
      if (phone.length >= 10) { const { sendToPhone } = require('./wa-bot'); sendToPhone(phone, `💰 *Refund processed*\nOrder #${order.id} cancelled — *₹${amount.toFixed(2)}* added to your wallet.\nBalance: *₹${newBal.toFixed(2)}*. Use it at checkout on your next order.`).catch(() => {}); }
    } catch {}
    res.json({ ok: true, refunded: amount, new_balance: newBal });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manually add/deduct a customer's wallet credit (signed amount: +credit / −debit).
router.post('/customers/:jid/wallet-adjust', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const jid = req.params.jid;
    const amount = parseFloat(req.body.amount);
    const note = String(req.body.note || '').slice(0, 120);
    if (!amount || isNaN(amount)) return res.status(400).json({ error: 'Enter a non-zero amount (+credit / −debit)' });
    if (!get(db, `SELECT jid FROM customers WHERE jid=?`, [jid])) return res.status(404).json({ error: 'Customer not found' });
    const { adjustWallet } = require('./wallet');
    let newBal;
    try { newBal = adjustWallet(db, jid, amount, note || (amount > 0 ? 'Admin credit' : 'Admin debit')); }
    catch (e) { if (e.code === 'INSUFFICIENT_FUNDS') return res.status(400).json({ error: `Insufficient balance (₹${e.balance.toFixed(2)})` }); throw e; }
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: 'wallet_adjust', targetKind: 'customer', targetId: jid, ip: req.ip });
    res.json({ ok: true, new_balance: newBal });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Wallet management (store-wide) ─────────────────────────────────────────────
// Overview for the admin Wallet page: total liability, holders, balances, activity.
router.get('/wallet/overview', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const q = String(req.query.q || '').trim().toLowerCase();
    const totals = get(db, `SELECT COALESCE(SUM(wallet_inr),0) AS liability,
        SUM(CASE WHEN COALESCE(wallet_inr,0) <> 0 THEN 1 ELSE 0 END) AS holders FROM customers`);
    let sql = `SELECT jid, name, email, phone, COALESCE(wallet_inr,0) AS wallet_inr
      FROM customers WHERE COALESCE(wallet_inr,0) <> 0`;
    const params = [];
    if (q) { sql += ` AND (LOWER(name) LIKE ? OR LOWER(email) LIKE ? OR phone LIKE ?)`; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    sql += ` ORDER BY wallet_inr DESC LIMIT 300`;
    const customers = all(db, sql, params);
    const recent = all(db, `SELECT w.amount_inr, w.type, w.label, w.created_at, c.name, c.email
      FROM wallet_txns w LEFT JOIN customers c ON c.jid = w.customer_jid
      ORDER BY w.id DESC LIMIT 60`);
    res.json({ liability: totals.liability || 0, holders: totals.holders || 0, customers, recent });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// One customer's wallet transaction history (Wallet page drill-down).
router.get('/customers/:jid/wallet-txns', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const { getTxns, getBalance } = require('./wallet');
    res.json({ balance: getBalance(db, req.params.jid), txns: getTxns(db, req.params.jid, 100) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Duplicate-account merge ────────────────────────────────────────────────────
// Merge `fromJid` INTO `intoJid`: re-point every customer reference (orders, topups,
// wallet txns, referrals, tickets, …) to the survivor, add the wallets together, fill
// any missing email/phone/name onto the survivor, then delete the duplicate. Reads
// the live schema so it covers EVERY table with a customer_jid / referrer_jid /
// referred_jid column — current and future — and can't orphan data.
function mergeCustomers(db, fromJid, intoJid) {
  if (!fromJid || !intoJid || fromJid === intoJid) return;
  const tables = all(db, `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).map(r => r.name);
  for (const tbl of tables) {
    if (tbl === 'customers') continue;
    let cols; try { cols = all(db, `PRAGMA table_info("${tbl}")`).map(c => c.name); } catch { continue; }
    for (const col of ['customer_jid', 'referrer_jid', 'referred_jid']) {
      if (cols.includes(col)) { try { run(db, `UPDATE "${tbl}" SET "${col}"=? WHERE "${col}"=?`, [intoJid, fromJid]); } catch {} }
    }
  }
  // Drop anything that couldn't move (e.g. a UNIQUE referred_jid collision) so the
  // deleted account leaves nothing dangling.
  try { run(db, `DELETE FROM referral_rewards WHERE referrer_jid=? OR referred_jid=?`, [fromJid, fromJid]); } catch {}
  // resellers.customer_jid is UNIQUE — if BOTH accounts were resellers the reassign
  // above collided and left the dupe's reseller row pointing at the soon-deleted jid.
  // Drop the leftover (and its custom prices) so nothing dangles. (No-op if it moved.)
  try {
    run(db, `DELETE FROM reseller_prices WHERE reseller_id IN (SELECT id FROM resellers WHERE customer_jid=?)`, [fromJid]);
    run(db, `DELETE FROM resellers WHERE customer_jid=?`, [fromJid]);
  } catch {}
  const from = get(db, `SELECT email, phone, name, wallet_inr FROM customers WHERE jid=?`, [fromJid]) || {};
  run(db, `UPDATE customers SET wallet_inr = COALESCE(wallet_inr,0) + ? WHERE jid=?`, [from.wallet_inr || 0, intoJid]);
  run(db, `UPDATE customers SET email=COALESCE(NULLIF(email,''),?), phone=COALESCE(NULLIF(phone,''),?), name=COALESCE(NULLIF(name,''),?) WHERE jid=?`,
    [from.email || '', from.phone || '', from.name || '', intoJid]);
  try { run(db, `UPDATE customers SET referred_by=? WHERE referred_by=?`, [intoJid, fromJid]); } catch {}
  run(db, `DELETE FROM customers WHERE jid=?`, [fromJid]);
}

// Find groups of duplicate accounts that share an email OR a WhatsApp number
// (transitively — A↔B by email, B↔C by phone groups all three).
router.get('/customers/duplicates', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const custs = all(db, `SELECT c.jid, c.name, c.email, c.phone, COALESCE(c.wallet_inr,0) AS wallet_inr, c.created_at,
        (SELECT COUNT(*) FROM orders WHERE customer_jid=c.jid) AS order_count
      FROM customers c`);
    const parent = {};
    const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (a, b) => { parent[find(a)] = find(b); };
    custs.forEach(c => { parent[c.jid] = c.jid; });
    const eMap = {}, pMap = {};
    const normE = s => String(s || '').trim().toLowerCase();
    const normP = s => String(s || '').replace(/\D/g, '');
    custs.forEach(c => {
      const e = normE(c.email), p = normP(c.phone);
      if (e) { if (eMap[e]) union(c.jid, eMap[e]); else eMap[e] = c.jid; }
      if (p && p.length >= 8) { if (pMap[p]) union(c.jid, pMap[p]); else pMap[p] = c.jid; }
    });
    const comps = {};
    custs.forEach(c => { const r = find(c.jid); (comps[r] = comps[r] || []).push(c); });
    const groups = Object.values(comps).filter(g => g.length > 1).map(g => {
      // Suggested survivor: most orders, then oldest.
      const primary = g.slice().sort((a, b) => (b.order_count - a.order_count) || (String(a.created_at) < String(b.created_at) ? -1 : 1))[0];
      return { primary_jid: primary.jid, members: g };
    });
    res.json({ groups });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Merge one or more duplicate accounts into a chosen primary.
router.post('/customers/merge', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const primary = String(req.body.primary || '');
    const dupes = (Array.isArray(req.body.duplicates) ? req.body.duplicates : []).map(String).filter(j => j && j !== primary);
    if (!primary || !dupes.length) return res.status(400).json({ error: 'Pick a primary account and at least one duplicate to merge.' });
    if (!get(db, `SELECT jid FROM customers WHERE jid=?`, [primary])) return res.status(404).json({ error: 'Primary account not found' });
    let merged = 0;
    for (const from of dupes) {
      if (!get(db, `SELECT jid FROM customers WHERE jid=?`, [from])) continue;
      mergeCustomers(db, from, primary);
      merged++;
    }
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: 'customers_merge', targetKind: 'customer', targetId: primary, ip: req.ip });
    res.json({ ok: true, merged });
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

// Manually verify a pending payment when the IMAP auto-match didn't fire. Creates
// the order + notifies + delivers (same path as auto-verification).
router.post('/topups/:id/verify', requireAdmin, async (req, res) => {
  try {
    const { manualVerifyTopup } = require('./imap-verify');
    const result = await manualVerifyTopup(parseInt(req.params.id, 10));
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true, order_id: result.orderId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cancel an unpaid in-flight payment (customer abandoned / never paid). No money moves.
router.post('/topups/:id/cancel', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const t = get(db, `SELECT * FROM topups WHERE id=?`, [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Payment not found' });
    if (t.order_id) return res.status(400).json({ error: 'This payment already created an order — cancel it from the Orders page.' });
    if (t.status !== 'pending') return res.status(400).json({ error: `Can't cancel a "${t.status}" payment` });
    run(db, `UPDATE topups SET status='cancelled' WHERE id=?`, [t.id]);
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: 'topup_cancel', targetKind: 'topup', targetId: String(t.id), ip: req.ip });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Refund a paid-but-undelivered payment. to_wallet=true (default) credits the
// customer's store wallet + notifies them; to_wallet=false just records it as
// refunded (admin already paid back outside the app). Either way → status 'refunded'.
router.post('/topups/:id/refund', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const t = get(db, `SELECT t.*, c.name AS cname, c.email, c.phone FROM topups t LEFT JOIN customers c ON c.jid=t.customer_jid WHERE t.id=?`, [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Payment not found' });
    if (['refunded', 'cancelled'].includes(t.status)) return res.status(400).json({ error: `Payment is already ${t.status}` });
    if (t.order_id) return res.status(400).json({ error: 'This payment has an order — cancel & refund it from the Orders page instead.' });
    if (t.status === 'pending') return res.status(400).json({ error: 'Still in-flight — use Cancel (if unpaid) or Verify (if the money arrived) instead.' });
    const toWallet = req.body.to_wallet !== false;
    const amount = Math.round((parseFloat(t.amount_inr) || 0) * 100) / 100;
    let newBal = null;
    if (toWallet) {
      if (amount <= 0) return res.status(400).json({ error: 'Nothing to refund (₹0)' });
      if (!t.customer_jid) return res.status(400).json({ error: 'No customer to refund' });
      const ref = 'topup:' + t.id;
      const { creditWallet, getBalance } = require('./wallet');
      const dup = get(db, `SELECT id FROM wallet_txns WHERE type='refund' AND ref_id=? LIMIT 1`, [ref]);
      newBal = dup ? getBalance(db, t.customer_jid) : creditWallet(db, t.customer_jid, amount, { type: 'refund', label: `Refund — payment #${t.id}`, ref_id: ref });
    }
    run(db, `UPDATE topups SET status='refunded' WHERE id=?`, [t.id]);
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: toWallet ? 'topup_refund_wallet' : 'topup_refund_external', targetKind: 'topup', targetId: String(t.id), ip: req.ip });
    if (toWallet) {
      try {
        if (t.email) sendMail({ to: t.email, subject: `Refund — payment #${t.id}`,
          html: `<p>Hi ${t.cname || ''},</p><p>We've refunded <b>₹${amount.toFixed(2)}</b> to your store wallet.</p><p>Wallet balance: <b>₹${newBal.toFixed(2)}</b> — use it on your next purchase at checkout.</p>` }).catch(() => {});
        const phone = String(t.phone || '').replace(/\D/g, '');
        if (phone.length >= 10) { const { sendToPhone } = require('./wa-bot'); sendToPhone(phone, `💰 *Refund processed*\n*₹${amount.toFixed(2)}* added to your wallet.\nBalance: *₹${newBal.toFixed(2)}*. Use it at checkout.`).catch(() => {}); }
      } catch {}
    }
    res.json({ ok: true, refunded: toWallet ? amount : 0, new_balance: newBal });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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

// Single-customer detail endpoint. The list view's GET /customers?q=… only
// searches by email/name/phone (LIKE), so re-fetching by JID from there
// returned nothing and the Edit button failed silently with "Customer not
// found". This is the canonical place to fetch one customer + their stats.
router.get('/customers/:jid', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const c = get(db, `SELECT c.*,
      (SELECT COUNT(*) FROM orders WHERE customer_jid=c.jid) as order_count,
      (SELECT COALESCE(SUM(amount_inr),0) FROM orders WHERE customer_jid=c.jid AND status NOT IN ('cancelled','failed')) as total_spent_inr
      FROM customers c WHERE c.jid=?`, [req.params.jid]);
    if (!c) return res.status(404).json({ error: 'Customer not found' });
    const recentOrders = all(db, `SELECT o.id, o.amount_inr, o.status, o.created_at, o.expires_at, p.platform, p.name as plan_name
      FROM orders o LEFT JOIN plans p ON o.plan_id=p.id
      WHERE o.customer_jid=? ORDER BY o.created_at DESC LIMIT 10`, [c.jid]);
    res.json({ ...c, recent_orders: recentOrders });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/customers/:jid', requireAdmin, async (req, res) => {
  try {
    const { name, email, phone, blocked, discount_percent, is_reseller, admin_notes } = req.body;
    const db = await getDb();
    const c = get(db, `SELECT * FROM customers WHERE jid=?`, [req.params.jid]);
    if (!c) return res.status(404).json({ error: 'Customer not found' });
    run(db, `UPDATE customers SET name=?,email=?,phone=?,blocked=?,discount_percent=?,is_reseller=?,admin_notes=? WHERE jid=?`,
      [name ?? c.name, email ?? c.email, phone ?? c.phone,
       blocked ?? c.blocked,
       discount_percent ?? c.discount_percent, is_reseller ?? c.is_reseller,
       admin_notes ?? c.admin_notes,
       req.params.jid]);
    // Keep the `resellers` table — which the Resellers admin page AND reseller
    // pricing (user-api computePlanPrice) both read — in sync with the customer's
    // reseller flag. Previously is_reseller was written to `customers` but never
    // reflected in `resellers`, so toggling "Reseller" did nothing visible.
    // Checking it now creates/approves a reseller record; unchecking removes it
    // (and any custom per-plan prices), same as Delete on the Resellers page.
    const wantReseller = Number(is_reseller ?? c.is_reseller) === 1;
    const effDiscount = Number(discount_percent ?? c.discount_percent) || 0;
    const existingReseller = get(db, `SELECT id, status FROM resellers WHERE customer_jid=?`, [req.params.jid]);
    if (wantReseller) {
      if (existingReseller) {
        run(db, `UPDATE resellers SET status='approved', discount_percent=? WHERE customer_jid=?`, [effDiscount, req.params.jid]);
      } else {
        run(db, `INSERT INTO resellers (customer_jid, discount_percent, status, notes) VALUES (?,?,?,?)`,
          [req.params.jid, effDiscount, 'approved', 'Added by admin']);
      }
    } else if (existingReseller && existingReseller.status === 'approved') {
      // Unchecking revokes an APPROVED reseller. A still-pending self-application
      // is left untouched, so editing an unrelated field never deletes it — reject
      // those from the Resellers page instead.
      run(db, `DELETE FROM resellers WHERE customer_jid=?`, [req.params.jid]);
      run(db, `DELETE FROM reseller_prices WHERE reseller_id=?`, [existingReseller.id]);
    }
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

// Inline image upload for the blog editor. Stores under data/uploads (served
// statically at /data/uploads, volume-backed so images persist) and returns a
// real URL to embed in the post body — no base64 bloat.
router.post('/blog/upload-image', requireAdmin, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    const m = (req.file.originalname || '').match(/\.(jpe?g|png|gif|webp|avif)$/i);
    const ext = m ? m[0].toLowerCase() : '.jpg';
    const filename = `blog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), req.file.buffer);
    res.json({ ok: true, url: `/data/uploads/${filename}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Re-import blog posts WITH their images/full HTML from a WordPress site's REST
// API. The prior migration kept only text and dropped in-content images; the WP
// `content.rendered` field is the rich HTML (images, headings, lists, links).
// Matches existing posts by slug / normalised title so it UPDATES rather than
// duplicating, and our public renderer renders the HTML as-is.
router.post('/blog/import-wordpress', requireAdmin, async (req, res) => {
  try {
    let url = String(req.body?.url || '').trim();
    if (!url) return res.status(400).json({ error: 'WordPress site URL required' });
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    // Use just the site ORIGIN (protocol + host) so a full post URL still works —
    // /wp-json must hang off the site root, not a post path.
    let base;
    try { const u = new URL(url); base = `${u.protocol}//${u.host}`; }
    catch { return res.status(400).json({ error: 'Invalid URL — use your site domain, e.g. https://yoursite.com' }); }
    const apiUrl = `${base}/wp-json/wp/v2/posts?per_page=100&_fields=slug,title,content,excerpt,date`;

    let posts;
    try {
      const r = await fetch(apiUrl, { headers: { 'User-Agent': 'OTTStore/1.0', 'Accept': 'application/json' } });
      const text = await r.text();
      if (text.trim().startsWith('<')) {
        return res.status(400).json({ error: `${base} didn't return the WordPress API (got an HTML page, HTTP ${r.status}). Enter just the site domain (https://yoursite.com) and ensure the WordPress REST API is enabled.` });
      }
      posts = JSON.parse(text);
    } catch (e) { return res.status(400).json({ error: `Could not read ${base}/wp-json/wp/v2/posts — ${e.message}` }); }
    if (!Array.isArray(posts)) return res.status(400).json({ error: `That site did not return a posts list (got ${typeof posts}). Is it a WordPress site with the REST API enabled?` });
    if (!posts.length) return res.status(400).json({ error: `Connected to ${base} but it has 0 published posts.` });

    const decode = (s) => String(s || '')
      .replace(/&amp;/g, '&').replace(/&#0?38;/g, '&')
      .replace(/&#8217;|&#039;|&#39;/g, "'").replace(/&#8216;/g, "'")
      .replace(/&#8220;|&#8221;|&quot;/g, '"').replace(/&#8211;|&#8212;/g, '–')
      .replace(/&hellip;/g, '…').replace(/&nbsp;/g, ' ');
    const stripTags = (s) => decode(String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    const norm = (t) => String(t || '').toLowerCase().replace(/\(with image\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

    // Download each in-content image onto our own server (/data/uploads, volume-
    // backed) and rewrite the src, so the cloned blog is fully self-hosted and
    // won't break if the WordPress site goes away.
    const selfHostImages = async (html) => {
      const urls = new Set();
      let m; const re = /<img[^>]+src=["']([^"']+)["']/gi;
      while ((m = re.exec(html))) { if (/^https?:\/\//i.test(m[1])) urls.add(m[1]); }
      let out = html.replace(/\s+srcset=["'][^"']*["']/gi, ''); // strip srcset (still points to WP)
      for (const u of urls) {
        try {
          const ir = await fetch(u, { headers: { 'User-Agent': 'OTTStore/1.0' } });
          if (!ir.ok) continue;
          const buf = Buffer.from(await ir.arrayBuffer());
          if (!buf.length || buf.length > 6 * 1024 * 1024) continue;
          const em = u.split('?')[0].match(/\.(jpe?g|png|gif|webp|avif|svg)$/i);
          const ext = em ? '.' + em[1].toLowerCase() : '.jpg';
          const fn = `blog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
          fs.writeFileSync(path.join(UPLOADS_DIR, fn), buf);
          out = out.split(u).join(`/data/uploads/${fn}`);
          imagesSaved++;
        } catch {}
      }
      return out;
    };

    const db = await getDb();
    const existingPosts = all(db, `SELECT id, slug, title FROM blog_posts`);
    let imported = 0, updated = 0, imagesSaved = 0;

    for (const p of posts) {
      const wpSlug = String(p.slug || '').trim();
      if (!wpSlug) continue;
      const title = decode(p.title?.rendered || wpSlug);
      const body = await selfHostImages(String(p.content?.rendered || '').replace(/<script[\s\S]*?<\/script>/gi, ''));
      const meta = stripTags(p.excerpt?.rendered || '').slice(0, 300);
      const tNorm = norm(title);

      const match = existingPosts.find(e => e.slug === wpSlug)
        || existingPosts.find(e => norm(e.title) === tNorm)
        || existingPosts.find(e => e.slug && (e.slug.startsWith(wpSlug) || wpSlug.startsWith(e.slug)));

      if (match) {
        run(db, `UPDATE blog_posts SET title=?, body=?, meta_desc=COALESCE(NULLIF(meta_desc,''),?), published=1 WHERE id=?`,
          [title, body, meta, match.id]);
        updated++;
      } else {
        run(db, `INSERT INTO blog_posts (slug,title,body,meta_desc,published) VALUES (?,?,?,?,1)`,
          [wpSlug, title, body, meta]);
        imported++;
      }
    }
    try { await audit({ actorKind: 'admin', actorLabel: 'admin', action: 'blog_import_wordpress', targetKind: 'blog', targetId: base, ip: req.ip }); } catch {}
    res.json({ ok: true, imported, updated, total: posts.length, images: imagesSaved, source: base });
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

// Send a one-off "Backup now" to the configured Telegram chat/channel.
router.post('/backup/telegram-now', requireAdmin, async (req, res) => {
  try {
    const { backupNow } = require('./backup-worker');
    const r = await backupNow('Manual backup');
    res.json({ ok: true, size: r.size });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Verify Telegram credentials by sending a test message (no DB attached).
router.post('/backup/test-telegram', requireAdmin, async (req, res) => {
  try {
    const token = (await getSetting('telegram_bot_token') || '').trim();
    const chatId = (await getSetting('telegram_backup_chat_id') || '').trim();
    if (!token || !chatId) return res.status(400).json({ error: 'Enter and save the bot token and chat/channel ID first.' });
    const siteName = (await getSetting('site_name')) || 'Virtual Market';
    await require('./telegram').sendMessage(token, chatId, `✅ <b>${siteName}</b> — Telegram backup is connected. Daily database backups will be delivered here.`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Restore the store from an uploaded .db backup. Destructive — replaces ALL
// current data. db.restoreDb validates the file before swapping, so a bad upload
// is rejected without touching the live DB.
router.post('/backup/restore', requireAdmin, dbUpload.single('file'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer || !req.file.buffer.length) return res.status(400).json({ error: 'No backup file uploaded.' });
    await restoreDb(req.file.buffer);
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: 'restore_db', targetKind: 'database', targetId: 'store.db', ip: req.ip });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
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

// payment_methods.type is read by the storefront/IMAP matcher to decide which
// auto-verify pipeline runs, so we hard-allowlist the values an admin can pick.
const ALLOWED_PM_TYPES = new Set(['upi_imap','upi_manual','usdt_binance','usdt_bep20','usdt_trc20','crypto','bank']);
// QR URLs end up in <img src=…> on the customer storefront. Block anything that
// isn't http(s) or an already-uploaded relative /data path so a malicious admin
// can't slip a javascript: or data:text/html payload that runs in the customer
// session.
function validateQrUrl(qr) {
  if (!qr) return null;
  const s = String(qr).trim();
  if (!s) return null;
  if (!/^(https?:\/\/|\/data\/)/i.test(s)) {
    const err = new Error('QR URL must start with http://, https:// or /data/');
    err.userFacing = true;
    throw err;
  }
  return s;
}

router.post('/payment-methods', requireAdmin, async (req, res) => {
  try {
    const { name, type, address, instructions, qr_url, enabled, sort_order } = req.body;
    if (!name || !type) return res.status(400).json({ error: 'name and type required' });
    if (!ALLOWED_PM_TYPES.has(type)) return res.status(400).json({ error: 'Unknown payment type. Allowed: ' + [...ALLOWED_PM_TYPES].join(', ') });
    let safeQr;
    try { safeQr = validateQrUrl(qr_url); } catch (e) { if (e.userFacing) return res.status(400).json({ error: e.message }); throw e; }
    const db = await getDb();
    const r = run(db, `INSERT INTO payment_methods (name,type,address,instructions,qr_url,enabled,sort_order) VALUES (?,?,?,?,?,?,?)`,
      [name, type, address || null, instructions || null, safeQr, enabled ?? 1, sort_order || 0]);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/payment-methods/:id', requireAdmin, async (req, res) => {
  try {
    const { name, type, address, instructions, qr_url, enabled, sort_order } = req.body;
    if (type && !ALLOWED_PM_TYPES.has(type)) return res.status(400).json({ error: 'Unknown payment type. Allowed: ' + [...ALLOWED_PM_TYPES].join(', ') });
    let safeQr;
    try { safeQr = validateQrUrl(qr_url); } catch (e) { if (e.userFacing) return res.status(400).json({ error: e.message }); throw e; }
    const db = await getDb();
    run(db, `UPDATE payment_methods SET name=?,type=?,address=?,instructions=?,qr_url=?,enabled=?,sort_order=? WHERE id=?`,
      [name, type, address || null, instructions || null, safeQr, enabled ?? 1, sort_order || 0, req.params.id]);
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

// ─── Test ResellKeys (supplier) website login connection ───────────────────────
// Tests the currently-saved credentials. The admin panel persists the latest
// field values (via POST /fulfillment-settings) right before calling this, so
// "Test Connection" always reflects what's on screen.
router.post('/resellkeys/test', requireAdmin, async (req, res) => {
  try {
    const { testResellKeysLogin } = require('./fulfillment-worker');
    const result = await testResellKeysLogin();
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: 'resellkeys_test', targetKind: 'supplier', targetId: 'resellkeys', ip: req.ip });
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
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
    // Sync the customer record so the customer-edit "Reseller" checkbox and
    // reseller pricing stay consistent with the application's status.
    const r = get(db, 'SELECT customer_jid FROM resellers WHERE id=?', [req.params.id]);
    if (r && status === 'approved') {
      run(db, `UPDATE customers SET discount_percent=?, is_reseller=1 WHERE jid=?`, [discount_percent || 0, r.customer_jid]);
    } else if (r && status === 'rejected') {
      run(db, `UPDATE customers SET discount_percent=0, is_reseller=0 WHERE jid=?`, [r.customer_jid]);
    } else if (r) {
      run(db, `UPDATE customers SET is_reseller=0 WHERE jid=?`, [r.customer_jid]); // back to pending
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/resellers/:id', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const r = get(db, 'SELECT customer_jid FROM resellers WHERE id=?', [req.params.id]);
    if (r) run(db, `UPDATE customers SET discount_percent=0, is_reseller=0 WHERE jid=?`, [r.customer_jid]);
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
    // Wallet is gone — admin marks the reward credited (payout is handled
    // off-platform, e.g. paying out via UPI to the referrer or stacking a
    // discount on their next order). The status flip is the audit trail.
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

// ─── Secure Session: encryption + snapshots + offsite bundle ───────────────────
let _keySuggestion = null; // generated once per process; never persisted to the DB
router.get('/whatsapp/secure-session', requireAdmin, async (req, res) => {
  try {
    const waSession = require('./wa-session-store');
    const waCrypto  = require('./wa-crypto');
    const status = await waSession.getStatus();
    if (!status.encryptionOn) {
      if (!_keySuggestion) _keySuggestion = waCrypto.generateKey();
      status.suggestedKey = _keySuggestion; // copy into Railway env to enable encryption
    }
    res.json(status);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/whatsapp/secure-session/snapshot', requireAdmin, async (req, res) => {
  try {
    const waSession = require('./wa-session-store');
    const snap = await waSession.createSnapshot('manual');
    if (!snap) return res.status(400).json({ error: 'Nothing to snapshot — the bot is not linked yet.' });
    res.json({ ok: true, snapshot: snap });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/whatsapp/secure-session/snapshot/:id/restore', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const waSession = require('./wa-session-store');
    const waBot = require('./wa-bot');
    await waBot.disconnect();
    const n = await waSession.restoreSnapshotToDisk(id);
    setTimeout(() => { try { waBot.connect(); } catch {} }, 300); // restart on the restored keys
    res.json({ ok: true, restored: n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/whatsapp/secure-session/snapshot/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const waSession = require('./wa-session-store');
    const ok = await waSession.deleteSnapshot(id);
    res.json({ ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Download one sealed blob (live session + all snapshots) for offsite storage.
router.get('/whatsapp/secure-session/bundle', requireAdmin, async (req, res) => {
  try {
    const waSession = require('./wa-session-store');
    const blob = await waSession.exportBundle();
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="ott24x7-wa-session-${stamp}.enc"`);
    res.send(blob);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Restore from an uploaded bundle. Raw text body (can be many MB) with a high limit.
router.post('/whatsapp/secure-session/bundle', requireAdmin, express.text({ limit: '128mb', type: () => true }), async (req, res) => {
  try {
    const blob = String(req.body || '').trim();
    if (!blob) return res.status(400).json({ error: 'Empty bundle' });
    const merge = req.query.merge === '1';
    const waSession = require('./wa-session-store');
    const waBot = require('./wa-bot');
    await waBot.disconnect();
    const n = await waSession.importBundle(blob, { merge });
    setTimeout(() => { try { waBot.connect(); } catch {} }, 300);
    res.json({ ok: true, restored: n });
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

// Build a marketing-style WhatsApp offer from a product — emoji header, price +
// discount, validity, and the live Buy link. WhatsApp markup: *bold* _italic_ ~strike~.
function marketingMessageForPlan(p, siteUrl) {
  const name = `${p.platform || ''} ${p.name || ''}`.replace(/\s+/g, ' ').trim();
  const lc = (name + ' ' + (p.category || '')).toLowerCase();
  const emoji = (() => {
    const m = [['netflix', '🎬'], ['prime', '📦'], ['hotstar', '📺'], ['disney', '🏰'], ['spotify', '🎵'], ['music', '🎵'], ['youtube', '▶️'], ['canva', '🎨'], ['office', '📄'], ['windows', '🪟'], ['chatgpt', '🤖'], ['gemini', '🤖'], [' ai', '🤖'], ['vpn', '🔐'], ['tv', '📺'], ['game', '🎮'], ['storage', '☁️'], ['educat', '🎓'], ['course', '🎓'], ['crunchyroll', '🍙'], ['telegram', '✈️']];
    for (const [k, e] of m) if (lc.includes(k)) return e;
    return '🔥';
  })();
  const dur = (p.duration_days == null) ? null
    : !p.duration_days ? 'Lifetime'
      : p.duration_days >= 365 ? `${Math.round(p.duration_days / 365)} Year`
        : p.duration_days >= 30 ? `${Math.round(p.duration_days / 30)} Month`
          : `${p.duration_days} Days`;
  const hasDisc = Number(p.original_price_inr) > Number(p.price_inr);
  const save = hasDisc ? Math.round(p.original_price_inr - p.price_inr) : 0;
  const url = (p.slug && siteUrl) ? `${siteUrl}/plans/${p.slug}` : (siteUrl ? `${siteUrl}/plans` : '');
  const L = [`${emoji} *${name}* ${emoji}`, ''];
  L.push(`💰 *Only ₹${p.price_inr}*${hasDisc ? `   ~₹${p.original_price_inr}~  _(Save ₹${save}!)_` : ''}`);
  if (dur) L.push(`⏳ Validity: *${dur}*`);
  if (p.description) L.push(`✨ ${String(p.description).replace(/\s+/g, ' ').slice(0, 130)}`);
  L.push('⚡ Instant delivery — Email + WhatsApp');
  L.push('✅ 100% Genuine · Warranty Included');
  if (url) L.push('', '🛒 *Order Now 👇*', url);
  L.push('', "💬 _Limited stock — grab yours before it's gone!_");
  return L.join('\n');
}

// Active products for the "Add from Products" picker on WA Offers.
router.get('/wa-offers/products', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const products = all(db, `SELECT id, platform, name, price_inr, original_price_inr, slug, category, provider_api
      FROM plans WHERE active=1 ORDER BY platform, price_inr ASC`);
    res.json({ products });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create WA offers from selected products — auto-generates a marketing message + Buy
// link for each, attaching the product image if it has one. Added active (in rotation).
router.post('/wa-offers/from-products', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const ids = (Array.isArray(req.body.plan_ids) ? req.body.plan_ids : []).map(Number).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'Select at least one product.' });
    const siteUrl = ((await getSetting('base_url')) || '').replace(/\/$/, '');
    const active = req.body.active === false ? 0 : 1;
    let added = 0;
    for (const id of ids) {
      const p = get(db, `SELECT * FROM plans WHERE id=?`, [id]);
      if (!p) continue;
      let image_b64 = null;
      if (p.image_url) { try { image_b64 = await fetchImageBase64(p.image_url); } catch {} }
      run(db, `INSERT INTO wa_offers (text, image_b64, active) VALUES (?,?,?)`, [marketingMessageForPlan(p, siteUrl), image_b64, active]);
      added++;
    }
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: 'wa_offers_from_products', targetKind: 'wa_offers', targetId: String(added), ip: req.ip });
    res.json({ ok: true, added });
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

// TEMP HARD KILL (June 2026): hard-disable WA group posting while tracing a blank-message source.
const WA_GROUP_POSTING_DISABLED = true;
router.post('/wa-offers/:id/post-now', requireAdmin, async (req, res) => {
  try {
    if (WA_GROUP_POSTING_DISABLED) return res.status(403).json({ error: 'WhatsApp group posting is temporarily disabled.' });
    const db = await getDb();
    const offer = get(db, `SELECT * FROM wa_offers WHERE id=?`, [req.params.id]);
    if (!offer) return res.status(404).json({ error: 'Offer not found' });
    if (!offer.image_b64 && !String(offer.text || '').trim()) return res.status(400).json({ error: 'This offer has no text or image to post.' });
    const waBot = require('./wa-bot');
    const sock = waBot.getActiveSock();
    if (!sock) return res.status(400).json({ error: 'WhatsApp not connected' });
    const groups = [...new Set(JSON.parse(get(db, `SELECT value FROM settings WHERE key='wa_autopost_groups'`)?.value || '[]'))]; // dedupe groups
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
    const keys = ['ai_enabled','ai_provider','ai_model','ai_persona','ai_daily_cap','ai_fallback_message','ai_base_url','ai_order_playbook'];
    const rows = all(db, `SELECT key, value FROM settings WHERE key IN (${keys.map(()=>'?').join(',')})`, keys);
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    const ak = get(db, `SELECT value FROM settings WHERE key='ai_api_key'`);
    out.ai_api_key = ak?.value ? '••••••••' + String(ak.value).slice(-4) : '';
    // Surface whether an active AI channel actually exists (i.e. the AI will work).
    const activeCh = get(db, `SELECT label, url, model FROM api_channels WHERE active=1 ORDER BY id ASC LIMIT 1`);
    out._active_channel = activeCh ? { label: activeCh.label, url: activeCh.url, model: activeCh.model } : null;
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/ai-settings', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const allowed = ['ai_enabled','ai_provider','ai_model','ai_persona','ai_daily_cap','ai_fallback_message','ai_base_url','ai_order_playbook'];
    for (const k of allowed) {
      if (k in req.body) run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`, [k, String(req.body[k] ?? '')]);
    }
    if (req.body.ai_api_key && !String(req.body.ai_api_key).startsWith('••••••••')) {
      run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`, ['ai_api_key', req.body.ai_api_key]);
    }

    // ── Bridge: make the AI Agent page actually drive the live AI ──────────────
    // ai.js chat() uses the ACTIVE row in api_channels (OpenAI-compatible
    // /v1/chat/completions). Previously the AI Agent page only wrote ai_*
    // settings that nothing consumed, so the bot never replied. Here we mirror
    // the page's provider/key/model into one auto-managed channel and activate
    // it — so saving this page is all that's needed to turn the AI on.
    try {
      const sval = (k) => get(db, `SELECT value FROM settings WHERE key=?`, [k])?.value || '';
      const provider = String((req.body.ai_provider ?? sval('ai_provider')) || '').toLowerCase().trim();
      const realKey  = sval('ai_api_key');
      const model    = String((req.body.ai_model ?? sval('ai_model')) || '').trim();
      const customBase = String((req.body.ai_base_url ?? sval('ai_base_url')) || '').trim().replace(/\/+$/, '');
      const baseMap = {
        tokenclub: 'https://s1.tokenclub.top',
        'token club': 'https://s1.tokenclub.top',
        openrouter: 'https://openrouter.ai/api',
        openai: 'https://api.openai.com',
      };
      const base = customBase || baseMap[provider] || '';
      if (base && realKey) {
        const defModel = model || 'gpt-4o-mini';
        const existing = get(db, `SELECT id FROM api_channels WHERE label='AI Agent'`);
        if (existing) {
          run(db, `UPDATE api_channels SET type='newapi_channel_conn', url=?, api_key=?, model=?, active=1, notes='Auto-managed by the AI Agent page' WHERE id=?`,
            [base, realKey, defModel, existing.id]);
        } else {
          run(db, `INSERT INTO api_channels (label,type,url,api_key,model,active,notes) VALUES ('AI Agent','newapi_channel_conn',?,?,?,1,'Auto-managed by the AI Agent page')`,
            [base, realKey, defModel]);
        }
        // Exactly one active channel.
        run(db, `UPDATE api_channels SET active=0 WHERE label<>'AI Agent'`);
        // Align the WhatsApp AI gate with the page's enable toggle.
        const enabled = String(req.body.ai_enabled ?? sval('ai_enabled')) === '0' ? '0' : '1';
        run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES ('wa_ai_reply_enabled', ?)`, [enabled]);
      }
    } catch (bridgeErr) {
      console.error('[ai-settings] channel bridge failed:', bridgeErr.message);
      // never fail the save because of bridging
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Test the currently-active AI channel (the one the AI Agent page just wired up)
// with a tiny live completion, so the admin gets instant confirmation.
router.post('/ai-settings/test', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const ch = get(db, `SELECT id, url, model FROM api_channels WHERE active=1 ORDER BY id ASC LIMIT 1`);
    if (!ch) return res.json({ ok: false, error: 'No active AI channel yet. Pick a provider, paste your API key, and click Save first.' });
    const { testChannel } = require('./ai');
    const r = await testChannel(ch.id);
    res.json({ ok: true, model: r.model, reply: r.reply, url: ch.url });
  } catch (e) { res.json({ ok: false, error: e.message }); }
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

// Deliver from LOCAL STOCK — picks an available stock credential, marks it sold
// (stock decremented), marks the order delivered, and notifies the customer by
// email + WhatsApp. Mirrors store.watshop.in's "Deliver" button.
router.post('/orders/:id/deliver-stock', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const order = get(db, `SELECT * FROM orders WHERE id=?`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'delivered') return res.status(400).json({ error: 'Order is already delivered.' });
    const { autoDeliverOrder } = require('./delivery-worker');
    const ok = await autoDeliverOrder(order, db);
    if (!ok) return res.status(400).json({ error: 'No stock available for this plan — use Manual Deliver to enter credentials.' });
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: 'order_deliver_stock', targetKind: 'order', targetId: String(order.id), ip: req.ip });
    res.json({ ok: true, message: 'Delivered from stock — customer notified by email + WhatsApp.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manual delivery with admin-entered credentials → marks delivered, saves creds,
// and sends to the customer by WhatsApp AND email at the same time.
router.post('/orders/:id/manual-deliver', requireAdmin, async (req, res) => {
  try {
    const { credentials, note } = req.body;
    if (!credentials || typeof credentials !== 'object' || !Object.keys(credentials).length) {
      return res.status(400).json({ error: 'Enter at least one credential field first.' });
    }
    const db = await getDb();
    const order = get(db, `SELECT * FROM orders WHERE id=?`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const { deliverWithCredentials } = require('./delivery-worker');
    const ok = await deliverWithCredentials(db, order, credentials, { note: note || 'Delivered by admin', via: 'admin_manual', actorLabel: 'admin' });
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: 'order_manual_deliver', targetKind: 'order', targetId: String(order.id), ip: req.ip });
    res.json({ ok: true, redelivered: !ok, message: ok ? 'Delivered — sent via WhatsApp + email.' : 'Order was already delivered (no re-send).' });
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

// Allowlist mirrors public/store/themes.css definitions + the admin picker.
// Mirrored from the same set in src/index.js so an unknown theme value can
// never leak into the settings table and silently fall back at render time.
const ALLOWED_THEMES = new Set([
  'midnight-purple','neon-dark','ocean-deep','cosmic','sunset-glow','forest-dark',
  'royal-gold','rose-noir','arctic-light','sakura','slate-minimal','cyberpunk',
  'aurora-teal','volcano','lavender-mist','navy-classic','emerald-city',
  'crystal-clean','obsidian-gold','electric-blue','crimson-tide','teal-ocean',
  'movieverse',
  // 10 premium template themes (volt…ember) — see src/index.js + themes.css.
  'volt','sunset','aqua','plasma','gold','ice','mint','rose','cyber','ember',
]);
router.post('/store-theme', requireAdmin, async (req, res) => {
  try {
    const { theme } = req.body;
    if (!theme || typeof theme !== 'string') return res.status(400).json({ error: 'theme required' });
    if (!ALLOWED_THEMES.has(theme)) return res.status(400).json({ error: 'Unknown theme. Allowed: ' + [...ALLOWED_THEMES].join(', ') });
    const db = await getDb();
    run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES ('store_theme',?)`, [theme]);
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: 'set_store_theme', targetKind: 'setting', targetId: 'store_theme', after_json: JSON.stringify({ theme }), ip: req.ip });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Design / Appearance — the site-wide Design Engine ───────────────────────
// GET returns the saved design_* settings (merged with defaults), the resolved
// preview values, the curated font list and the palette presets. POST validates
// + saves. One source of truth for colours, fonts, light/dark, contrast, density
// across storefront + portal + admin (consumed by src/design.js → every page).
router.get('/design-settings', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const saved = {};
    all(db, "SELECT key,value FROM settings WHERE key LIKE 'design_%'").forEach(r => saved[r.key] = r.value);
    const stRow = get(db, `SELECT value FROM settings WHERE key='store_theme'`);
    const storeTheme = (stRow && stRow.value) || 'movieverse';
    res.json({
      settings: { ...design.DEFAULTS, ...saved },
      resolved: design.resolve(saved, storeTheme),
      fonts: Object.keys(design.FONTS),
      palettes: design.PALETTE_MAP,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/design-settings', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const isHex = v => v === '' || /^#?[0-9a-fA-F]{6}$/.test(v);
    const norm = h => (h && h[0] !== '#') ? '#' + h : h;
    const allow = {
      design_brand:          v => isHex(v) ? norm(v) : null,
      design_accent:         v => isHex(v) ? norm(v) : null,
      design_mode:           v => ['light', 'dark'].includes(v) ? v : null,
      design_contrast:       v => ['normal', 'high'].includes(v) ? v : null,
      design_density:        v => ['compact', 'comfortable', 'spacious'].includes(v) ? v : null,
      design_radius:         v => { const n = parseInt(v, 10); return (Number.isFinite(n) && n >= 0 && n <= 28) ? String(n) : null; },
      design_font_heading:   v => design.FONTS[v] ? v : null,
      design_font_body:      v => design.FONTS[v] ? v : null,
      design_visitor_toggle: v => ['0', '1'].includes(String(v)) ? String(v) : null,
      design_enabled:        v => ['0', '1'].includes(String(v)) ? String(v) : null,
    };
    const db = await getDb();
    const applied = {};
    for (const [k, fn] of Object.entries(allow)) {
      if (body[k] === undefined) continue;
      const val = fn(String(body[k]));
      if (val === null) return res.status(400).json({ error: `Invalid value for ${k}: ${body[k]}` });
      run(db, `INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`, [k, val]);
      applied[k] = val;
    }
    await audit({ actorKind: 'admin', actorLabel: 'admin', action: 'set_design', targetKind: 'setting', targetId: 'design', after_json: JSON.stringify(applied), ip: req.ip });
    res.json({ ok: true, applied });
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
    const { action, ids, category, profit_pct, usd_to_inr_rate, updates } = req.body;
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
    } else if (action === 'adjust-price') {
      // Bump the INR selling price (price_inr) up or down by a percentage.
      const pct = parseFloat(req.body.pct);
      const dir = req.body.direction === 'decrease' ? -1 : 1;
      if (!isFinite(pct) || pct <= 0) return res.status(400).json({ error: 'Enter a percentage greater than 0' });
      const factor = 1 + dir * (pct / 100);
      if (factor <= 0) return res.status(400).json({ error: 'That decrease would drop prices to zero or below' });
      const adj = all(db, `SELECT id, price_inr FROM plans WHERE id IN (${ph})`, ids);
      for (const p of adj) {
        const next = Math.max(1, Math.round((p.price_inr || 0) * factor));
        db.run('UPDATE plans SET price_inr=? WHERE id=?', [next, p.id]);
        affected++;
      }
    } else if (action === 'set-image-url') {
      const { image_url } = req.body;
      if (!image_url) return res.status(400).json({ error: 'image_url required' });
      db.run(`UPDATE plans SET image_url=? WHERE id IN (${ph})`, [image_url, ...ids]);
      affected = ids.length;
    } else if (action === 'bulk-update-details') {
      if (!Array.isArray(updates) || !updates.length) return res.status(400).json({ error: 'updates required' });
      const allowed = new Set(ids.map(id => Number(id)));
      for (const item of updates) {
        const id = Number(item?.id);
        if (!allowed.has(id)) continue;
        const name = String(item.name || '').trim();
        if (!name) return res.status(400).json({ error: `Product #${id} needs a title` });
        const description = String(item.description || '').trim();
        const features = Array.isArray(item.features)
          ? item.features.map(f => String(f || '').trim()).filter(Boolean)
          : [];
        db.run('UPDATE plans SET name=?, description=?, features=? WHERE id=?',
          [name, description || null, JSON.stringify(features), id]);
        affected++;
      }
    } else if (action === 'auto-logo') {
      const plans = all(db, `SELECT id, platform, name FROM plans WHERE id IN (${ph})`, ids);
      for (const p of plans) {
        const term = (p.platform || p.name || '').toLowerCase().replace(/\s+/g, '');
        const url = `https://logo.clearbit.com/${term}.com`;
        db.run('UPDATE plans SET image_url=? WHERE id=?', [url, p.id]);
        affected++;
      }
    } else if (action === 'set-sort-order') {
      // ids is an ordered array; each plan gets sort_order = its index * 10
      // so there's room to insert between any two later without renumbering.
      for (let i = 0; i < ids.length; i++) {
        db.run('UPDATE plans SET sort_order=? WHERE id=?', [(i + 1) * 10, ids[i]]);
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
    const { query, categoryFilter, pages, inStockOnly } = req.body || {};
    const db = await getDb();
    const { scrapeResellKeysProducts } = require('./fulfillment-worker');
    const r = await scrapeResellKeysProducts(db, {
      query: query || '',
      categoryFilter: categoryFilter || '11',
      pages: pages || 15,
      inStockOnly: inStockOnly !== false,
    });
    // r = { products, pages, profit_pct, usd_to_inr }
    res.json({ ...r, count: r.products.length });
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
    const keys = ['bot_enabled','bot_name','bot_tagline','bot_avatar','bot_accent','bot_greeting','bot_system_prompt','support_whatsapp','support_telegram','support_instagram','support_wa_community','support_telegram_channel','support_custom_links'];
    const rows = all(db, `SELECT key,value FROM settings WHERE key IN (${keys.map(()=>'?').join(',')})`, keys);
    const s = {};
    rows.forEach(r => s[r.key] = r.value);
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/bot-settings', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const allowed = ['bot_enabled','bot_name','bot_tagline','bot_avatar','bot_accent','bot_greeting','bot_system_prompt','support_whatsapp','support_telegram','support_instagram','support_wa_community','support_telegram_channel','support_custom_links'];
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

// ─── Cross-origin WA offer batch import (token auth) ────────────────────────
// Token comes from the WA_IMPORT_TOKEN env var only — no hardcoded fallback.
// When unset, the endpoint is disabled (rejects all requests).
const WA_IMPORT_TOKEN = cfg.waImportToken;

router.options('/wa-offers-batch-import', (req, res) => {
  res.set('Access-Control-Allow-Origin', 'https://store.watshop.in');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Import-Token');
  res.set('Access-Control-Allow-Methods', 'POST');
  res.status(204).end();
});

router.post('/wa-offers-batch-import', async (req, res) => {
  res.set('Access-Control-Allow-Origin', 'https://store.watshop.in');
  if (!WA_IMPORT_TOKEN || req.headers['x-import-token'] !== WA_IMPORT_TOKEN) {
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
