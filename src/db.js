'use strict';
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'store.db');
const DATA_DIR = path.dirname(DB_PATH);
fs.mkdirSync(DATA_DIR, { recursive: true });

const initSqlJs = require('sql.js');

let _db = null;
let _dirty = false;

async function getDb() {
  if (_db) return _db;
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    _db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    _db = new SQL.Database();
  }
  const origRun = _db.run.bind(_db);
  _db.run = (sql, params) => { _dirty = true; return origRun(sql, params); };
  setInterval(() => {
    if (_dirty && _db) {
      fs.writeFileSync(DB_PATH, Buffer.from(_db.export()));
      _dirty = false;
    }
  }, 5000);
  migrate(_db);
  return _db;
}

function migrate(db) {
  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS customers (
    jid TEXT PRIMARY KEY,
    name TEXT, email TEXT, phone TEXT,
    password_hash TEXT,
    wallet_inr REAL DEFAULT 0,
    blocked INTEGER DEFAULT 0,
    is_reseller INTEGER DEFAULT 0,
    discount_percent REAL DEFAULT 0,
    referral_code TEXT UNIQUE,
    referred_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    last_login_at TEXT,
    needs_email INTEGER DEFAULT 0,
    needs_phone INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    name TEXT NOT NULL,
    duration_days INTEGER,
    price_inr REAL,
    original_price_inr REAL,
    description TEXT,
    features TEXT,
    badge TEXT,
    stock INTEGER DEFAULT -1,
    active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_jid TEXT,
    plan_id INTEGER,
    amount_inr REAL,
    status TEXT DEFAULT 'pending',
    credentials TEXT,
    delivery_note TEXT,
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    delivered_at TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS topups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_jid TEXT,
    amount_inr REAL,
    method TEXT,
    reference TEXT,
    status TEXT DEFAULT 'pending',
    screenshot_url TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_jid TEXT,
    subject TEXT, body TEXT,
    status TEXT DEFAULT 'open',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS ticket_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER,
    sender TEXT,
    body TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS blog_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE,
    title TEXT, body TEXT,
    meta_desc TEXT, og_image TEXT,
    published INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_kind TEXT, actor_label TEXT,
    action TEXT, target_kind TEXT, target_id TEXT,
    before_json TEXT, after_json TEXT,
    ip TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS wallet_txns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_jid TEXT,
    amount_inr REAL,
    type TEXT,
    label TEXT,
    ref_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS pw_resets (
    token TEXT PRIMARY KEY,
    customer_jid TEXT,
    expires_at TEXT,
    used INTEGER DEFAULT 0
  )`);

  // ── New tables ─────────────────────────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS payment_methods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    address TEXT,
    instructions TEXT,
    qr_url TEXT,
    enabled INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS stock_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL,
    cred_type TEXT DEFAULT 'credential',
    line1 TEXT NOT NULL,
    line2 TEXT,
    extra TEXT,
    status TEXT DEFAULT 'available',
    sold_order_id INTEGER,
    sold_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS resellers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_jid TEXT UNIQUE NOT NULL,
    discount_percent REAL DEFAULT 0,
    status TEXT DEFAULT 'pending',
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS reseller_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reseller_id INTEGER NOT NULL,
    plan_id INTEGER NOT NULL,
    price_inr REAL NOT NULL,
    UNIQUE(reseller_id, plan_id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS referral_rewards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_jid TEXT NOT NULL,
    referred_jid TEXT NOT NULL UNIQUE,
    reward_inr REAL DEFAULT 20,
    status TEXT DEFAULT 'pending',
    order_id INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS autopost_campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    subject TEXT,
    message TEXT NOT NULL,
    image_url TEXT,
    target TEXT DEFAULT 'all',
    schedule_enabled INTEGER DEFAULT 0,
    interval_hours INTEGER DEFAULT 24,
    last_sent_at TEXT,
    times_sent INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS autopost_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    recipient TEXT NOT NULL,
    success INTEGER DEFAULT 0,
    error TEXT,
    sent_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS legal_pages (
    slug TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  // ── WhatsApp tables ────────────────────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS wa_offers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    image_b64 TEXT,
    active INTEGER DEFAULT 1,
    last_posted_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS wa_offer_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    offer_id INTEGER NOT NULL,
    group_id TEXT NOT NULL,
    group_name TEXT,
    success INTEGER DEFAULT 0,
    error TEXT,
    sent_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    product_ids TEXT DEFAULT '[]',
    active INTEGER DEFAULT 1,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // Alter existing tables to add new columns (safe — ignored if column exists)
  try { db.run(`ALTER TABLE topups ADD COLUMN unique_amount REAL`); } catch {}
  try { db.run(`ALTER TABLE topups ADD COLUMN payment_method_id INTEGER`); } catch {}
  try { db.run(`ALTER TABLE orders ADD COLUMN stock_credential_id INTEGER`); } catch {}
  try { db.run(`ALTER TABLE orders ADD COLUMN renewal_reminded_at TEXT`); } catch {}

  seedDefaults(db);
  seedLegalPages(db);
}

function seedLegalPages(db) {
  const pages = [
    { slug: 'about',   title: 'About Us',       body: '<p>Welcome to our OTT subscription store. We provide premium streaming subscriptions at the best prices.</p>' },
    { slug: 'contact', title: 'Contact Us',      body: '<p>Email: support@example.com<br>WhatsApp: Available in header</p>' },
    { slug: 'privacy', title: 'Privacy Policy',  body: '<p>We respect your privacy. Your personal data is never shared with third parties.</p>' },
    { slug: 'terms',   title: 'Terms of Service',body: '<p>By purchasing from us you agree to our terms. All sales are final once credentials are delivered.</p>' },
    { slug: 'refund',  title: 'Refund Policy',   body: '<p>Refunds are processed within 24 hours for undelivered orders. No refunds after credentials are delivered.</p>' },
  ];
  for (const p of pages) {
    db.run(`INSERT OR IGNORE INTO legal_pages (slug,title,body) VALUES (?,?,?)`, [p.slug, p.title, p.body]);
  }
}

function seedDefaults(db) {
  const defaults = {
    site_name: 'OTT Store',
    site_tagline: 'Premium OTT Subscriptions at Best Prices',
    support_email: '',
    support_whatsapp: '',
    announcement: '',
    timezone: 'Asia/Kolkata',
    logo_url: '',
    favicon_url: '',
    robots_txt: 'User-agent: *\nAllow: /',
    upi_id: '',
    upi_name: '',
    razorpay_enabled: '0',
    upi_manual_enabled: '1',
    'seo_home_title': 'Buy OTT Subscriptions Online',
    'seo_home_desc': 'Get Netflix, Amazon Prime, Disney+ and more at lowest prices.',
    'seo_home_keywords': 'ott subscription, netflix, amazon prime, disney plus',
    'seo_og_image': '',
    'seo_twitter_card': 'summary_large_image',
    'seo_gsc_verification': '',
    'seo_bing_verification': '',
    admin_2fa_enabled: '0',
    admin_2fa_secret: '',
    google_index_credentials: '',
    imap_enabled: '0',
    imap_host: 'imap.gmail.com',
    imap_port: '993',
    imap_email: '',
    imap_password: '',
    imap_folder: 'INBOX',
    referral_reward_inr: '20',
    referral_min_redeem: '20',
    stock_alert_threshold: '5',
    stock_alert_email: '',
    renewal_reminder_days: '3',
    autopost_enabled: '0',
    // WhatsApp Bot
    wa_enabled: '0',
    wa_transport: 'baileys',
    wa_meta_phone_number_id: '',
    wa_meta_access_token: '',
    wa_meta_waba_id: '',
    wa_meta_app_secret: '',
    wa_meta_webhook_verify_token: '',
    wa_owner_number: '',
    wa_owner_lid: '',
    wa_autoreply_enabled: '1',
    wa_autopost_enabled: '0',
    wa_autopost_groups: '[]',
    wa_autopost_interval: '45',
    wa_autopost_start: '9',
    wa_autopost_end: '23',
    wa_daily_summary: '1',
    // AI Agent
    ai_enabled: '0',
    ai_provider: 'gemini',
    ai_api_key: '',
    ai_model: '',
    ai_persona: '',
    ai_daily_cap: '500',
    ai_fallback_message: '',
  };
  for (const [k, v] of Object.entries(defaults)) {
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`, [k, v]);
  }
}

// --- query helpers ---
function all(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function get(db, sql, params = []) {
  return all(db, sql, params)[0] || null;
}

function run(db, sql, params = []) {
  db.run(sql, params);
  const r = db.exec('SELECT last_insert_rowid() as id');
  return { lastInsertRowid: r[0]?.values[0][0] ?? null };
}

async function getSetting(key) {
  const db = await getDb();
  const row = get(db, 'SELECT value FROM settings WHERE key=?', [key]);
  return row ? row.value : null;
}

async function setSetting(key, value) {
  const db = await getDb();
  run(db, `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, [key, String(value)]);
}

// Synchronous variants — safe to use after DB is initialized (after first getDb() call)
function getSettingSync(key) {
  if (!_db) return null;
  const row = get(_db, 'SELECT value FROM settings WHERE key=?', [key]);
  return row ? row.value : null;
}

function setSettingSync(key, value) {
  if (!_db) return;
  run(_db, 'INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)', [key, String(value ?? '')]);
}

module.exports = { getDb, getSetting, setSetting, getSettingSync, setSettingSync, all, get, run };
