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
  seedDefaults(db);
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

module.exports = { getDb, getSetting, setSetting, all, get, run };
