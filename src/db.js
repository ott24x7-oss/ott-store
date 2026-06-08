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
  // Secure WhatsApp session: mirror of the Baileys auth files so the linked
  // device survives Railway redeploys / filesystem resets (see wa-session-store.js).
  db.run(`CREATE TABLE IF NOT EXISTS wa_session_files (
    filename TEXT PRIMARY KEY,
    content TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  // Point-in-time encrypted session snapshots (payload is a .enc file on the
  // volume; this table holds only metadata). See wa-session-store.js.
  db.run(`CREATE TABLE IF NOT EXISTS wa_session_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT,
    file_count INTEGER,
    size_bytes INTEGER,
    filename TEXT,
    created_at TEXT DEFAULT (datetime('now'))
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

  db.run(`CREATE TABLE IF NOT EXISTS auth_tokens (
    token TEXT PRIMARY KEY,
    customer_jid TEXT,
    purpose TEXT NOT NULL DEFAULT 'otp',
    code TEXT,
    email TEXT,
    phone TEXT,
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
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

  // ── Email Marketing tables ─────────────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS email_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    host TEXT DEFAULT 'smtp.gmail.com',
    port INTEGER DEFAULT 587,
    secure INTEGER DEFAULT 0,
    user TEXT NOT NULL,
    app_password TEXT NOT NULL,
    from_name TEXT,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS email_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT DEFAULT 'general',
    subject TEXT NOT NULL,
    html TEXT NOT NULL,
    is_system INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS email_campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    subject TEXT NOT NULL,
    html TEXT NOT NULL,
    account_id INTEGER,
    target TEXT DEFAULT 'all',
    custom_emails TEXT,
    status TEXT DEFAULT 'draft',
    scheduled_at TEXT,
    sent_at TEXT,
    total_recipients INTEGER DEFAULT 0,
    sent_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // ── PWA / Push Notification tables ────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT UNIQUE NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS push_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT,
    icon TEXT,
    url TEXT,
    total INTEGER DEFAULT 0,
    success_count INTEGER DEFAULT 0,
    sent_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS fulfillment_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER UNIQUE NOT NULL,
    plan_id INTEGER NOT NULL,
    customer_jid TEXT,
    provider_api TEXT NOT NULL DEFAULT 'resellkeys',
    provider_product_id TEXT,
    provider_order_id TEXT,
    status TEXT DEFAULT 'pending',
    attempt_count INTEGER DEFAULT 0,
    last_attempt_at TEXT,
    error_msg TEXT,
    raw_response TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    delivered_at TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS api_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    type TEXT DEFAULT 'newapi_channel_conn',
    url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    model TEXT DEFAULT 'gpt-4o-mini',
    active INTEGER DEFAULT 1,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // Alter existing tables to add new columns (safe — ignored if column exists)
  try { db.run(`ALTER TABLE topups ADD COLUMN unique_amount REAL`); } catch {}
  try { db.run(`ALTER TABLE topups ADD COLUMN payment_method_id INTEGER`); } catch {}
  try { db.run(`ALTER TABLE topups ADD COLUMN purpose TEXT DEFAULT 'wallet'`); } catch {}
  try { db.run(`ALTER TABLE topups ADD COLUMN plan_id INTEGER`); } catch {}
  try { db.run(`ALTER TABLE topups ADD COLUMN order_id INTEGER`); } catch {}
  // USDT direct-checkout extension to topups
  try { db.run(`ALTER TABLE topups ADD COLUMN currency TEXT DEFAULT 'INR'`); } catch {}
  try { db.run(`ALTER TABLE topups ADD COLUMN amount_usdt REAL`); } catch {}
  try { db.run(`ALTER TABLE topups ADD COLUMN unique_amount_usdt REAL`); } catch {}
  try { db.run(`ALTER TABLE topups ADD COLUMN expires_at TEXT`); } catch {}
  // Admin-only customer note (visible in the Edit Customer modal)
  try { db.run(`ALTER TABLE customers ADD COLUMN admin_notes TEXT DEFAULT ''`); } catch {}
  try { db.run(`ALTER TABLE customers ADD COLUMN guest INTEGER DEFAULT 0`); } catch {}
  try { db.run(`ALTER TABLE orders ADD COLUMN stock_credential_id INTEGER`); } catch {}
  try { db.run(`ALTER TABLE orders ADD COLUMN renewal_reminded_at TEXT`); } catch {}
  // Plans: catalog enhancements
  try { db.run(`ALTER TABLE plans ADD COLUMN category TEXT DEFAULT ''`); } catch {}
  try { db.run(`ALTER TABLE plans ADD COLUMN image_url TEXT DEFAULT ''`); } catch {}
  try { db.run(`ALTER TABLE plans ADD COLUMN provider_api TEXT DEFAULT ''`); } catch {}
  try { db.run(`ALTER TABLE plans ADD COLUMN provider_product_id TEXT DEFAULT ''`); } catch {}
  try { db.run(`ALTER TABLE plans ADD COLUMN delivery_type TEXT DEFAULT 'manual'`); } catch {}
  try { db.run(`ALTER TABLE plans ADD COLUMN delivery_time_est TEXT DEFAULT ''`); } catch {}
  try { db.run(`ALTER TABLE plans ADD COLUMN price_usd REAL DEFAULT 0`); } catch {}
  // SEO: mark thin / near-duplicate variant pages so they are excluded from the
  // sitemap and get <meta robots noindex> — the lever for pruning index bloat.
  try { db.run(`ALTER TABLE plans ADD COLUMN noindex INTEGER DEFAULT 0`); } catch {}
  // SEO-friendly slugs for product pages (/plans/:slug)
  try { db.run(`ALTER TABLE plans ADD COLUMN slug TEXT`); } catch {}
  try { db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_slug ON plans(slug) WHERE slug IS NOT NULL`); } catch {}
  // Backfill slugs for existing plans that don't have one yet.
  // Runs on every startup but is a no-op when all slugs are present.
  try {
    const plansMissing = db.exec(`SELECT id, platform, name FROM plans WHERE slug IS NULL OR slug = ''`);
    if (plansMissing?.[0]?.values?.length) {
      const rows = plansMissing[0].values; // [[id, platform, name], ...]
      const existing = new Set(
        (db.exec(`SELECT slug FROM plans WHERE slug IS NOT NULL`)?.[0]?.values || []).map(r => r[0])
      );
      for (const [id, platform, name] of rows) {
        const slug = makePlanSlug(`${platform || ''} ${name || ''}`, existing);
        if (slug) {
          db.run(`UPDATE plans SET slug=? WHERE id=?`, [slug, id]);
          existing.add(slug);
        }
      }
    }
  } catch {}

  seedDefaults(db);
  seedLegalPages(db);
  seedEmailTemplates(db);
  seedAutopostCampaigns(db);
  seedOtt24x7Products(db);
  seedPlatformImages(db);
  seedWaOffers(db);

  // One-time data fix: strip trailing slash from stored base_url so we never
  // build URLs like https://site.com//user/api/auth/magic (broke magic links).
  try { db.run(`UPDATE settings SET value = rtrim(value, '/') WHERE key='base_url' AND value LIKE '%/'`); } catch {}

  // ── 2026-05 refactor: drop Razorpay + manual UPI; USDT direct checkout ──
  // NOTE: the customer wallet was RE-ENABLED 2026-06 (order refunds + pay-with-wallet),
  // so we no longer zero wallet_inr here — that line wiped every balance on each boot.
  // Remove dead Razorpay / manual-UPI settings so nothing reads stale values.
  try { db.run(`DELETE FROM settings WHERE key IN ('razorpay_enabled','razorpay_key_id','razorpay_key_secret','upi_manual_enabled')`); } catch {}
  // Cancel any in-flight wallet topups still pending — the route is gone.
  try { db.run(`UPDATE topups SET status='cancelled' WHERE status='pending' AND COALESCE(purpose,'wallet')='wallet'`); } catch {}

  // ── Indexes for hot-path queries ──────────────────────────────────────────
  // Customer-facing endpoints repeatedly filter orders/topups/audit_log by jid
  // and by status. Without these indexes sql.js would table-scan every time —
  // fine at 100 customers, painful at 10k+.
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_orders_customer_jid ON orders(customer_jid)`); } catch {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`); } catch {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_topups_customer_jid ON topups(customer_jid)`); } catch {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_topups_status_purpose ON topups(status, purpose)`); } catch {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_topups_order_id ON topups(order_id)`); } catch {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_kind, target_id, action)`); } catch {}
  // Guest checkout — random token so unauthenticated poll can verify ownership
  try { db.run(`ALTER TABLE topups ADD COLUMN guest_token TEXT`); } catch {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires ON auth_tokens(expires_at)`); } catch {}

  // ── auth_tokens housekeeping ─────────────────────────────────────────────
  // Magic-link / OTP / wa_magic rows accumulate forever otherwise. Wipe used
  // tokens after 1 day and unused-but-expired tokens after the same window.
  // Cheap; runs on every boot.
  try { db.run(`DELETE FROM auth_tokens WHERE used=1 AND created_at < datetime('now', '-1 day')`); } catch {}
  try { db.run(`DELETE FROM auth_tokens WHERE expires_at < datetime('now', '-1 day')`); } catch {}

  // ── topups housekeeping ──────────────────────────────────────────────────
  // Expired / cancelled / rejected payment attempts older than 30 days are
  // safe to drop — they're already shown in the customer's payment history
  // for 30 days and the IMAP matcher only looks at status='pending'.
  try { db.run(`DELETE FROM topups WHERE status IN ('expired','cancelled','rejected') AND created_at < datetime('now', '-30 days')`); } catch {}

  // ── orphaned stock detector ──────────────────────────────────────────────
  // refund_needed topups (a paid topup that couldn't be honored because the
  // plan sold out under us, see imap-verify.js stock-race fix) get logged as
  // a system audit row at startup so the admin sees them on Audit Log without
  // hunting through topups. Reissued only once per topup id.
  try {
    const refundNeeded = db.exec(`SELECT t.id, t.customer_jid, t.amount_inr, t.plan_id, c.email
      FROM topups t LEFT JOIN customers c ON t.customer_jid=c.jid
      WHERE t.status='refund_needed'
        AND NOT EXISTS (SELECT 1 FROM audit_log WHERE actor_label='boot-orphan-check' AND target_id=CAST(t.id AS TEXT))`);
    const rows = refundNeeded[0]?.values || [];
    rows.forEach(([tid, jid, amt, pid, email]) => {
      try {
        db.run(`INSERT INTO audit_log (actor_kind,actor_label,action,target_kind,target_id,after_json) VALUES (?,?,?,?,?,?)`,
          ['system', 'boot-orphan-check', 'refund_needed_topup', 'topup', String(tid),
           JSON.stringify({ customer_jid: jid, email, amount_inr: amt, plan_id: pid, note: 'Customer paid but plan was sold out — manual refund required' })]);
      } catch {}
    });
  } catch {}
}

function seedPlansData(db) {
  const existing = db.exec('SELECT COUNT(*) as c FROM plans');
  if ((existing[0]?.values[0][0] || 0) > 0) return;

  const plans = [
    // Netflix
    { platform:'Netflix', name:'Premium 4K UHD — 1 Month', duration_days:30,  price_inr:199,  original_price_inr:649,  badge:'🔥 Best Seller', features:JSON.stringify(['4K UHD + HDR','4 Screens Simultaneously','Downloads Supported','Watch on All Devices']), delivery_type:'manual', image_url:'', active:1, sort_order:1 },
    { platform:'Netflix', name:'Premium 4K UHD — 3 Month', duration_days:90,  price_inr:499,  original_price_inr:1799, badge:'💎 Best Value', features:JSON.stringify(['4K UHD + HDR','4 Screens Simultaneously','Downloads Supported','Watch on All Devices']), delivery_type:'manual', image_url:'', active:1, sort_order:2 },
    { platform:'Netflix', name:'Premium 4K UHD — 1 Year',  duration_days:365, price_inr:1499, original_price_inr:6499, badge:'🎯 1 Year Deal',features:JSON.stringify(['4K UHD + HDR','4 Screens Simultaneously','Downloads Supported','Watch on All Devices']), delivery_type:'manual', image_url:'', active:1, sort_order:3 },
    // Amazon Prime
    { platform:'Amazon Prime', name:'1 Month',  duration_days:30,  price_inr:89,  original_price_inr:299,  badge:'', features:JSON.stringify(['Prime Video + Music','Prime Delivery','Gaming with Prime','All Devices']), delivery_type:'manual', image_url:'', active:1, sort_order:4 },
    { platform:'Amazon Prime', name:'3 Month',  duration_days:90,  price_inr:229, original_price_inr:799,  badge:'Popular', features:JSON.stringify(['Prime Video + Music','Prime Delivery','Gaming with Prime','All Devices']), delivery_type:'manual', image_url:'', active:1, sort_order:5 },
    { platform:'Amazon Prime', name:'1 Year',   duration_days:365, price_inr:799, original_price_inr:2999, badge:'', features:JSON.stringify(['Prime Video + Music','Prime Delivery','Gaming with Prime','All Devices']), delivery_type:'manual', image_url:'', active:1, sort_order:6 },
    // Disney+ Hotstar
    { platform:'Disney+ Hotstar', name:'Super — 1 Month',  duration_days:30,  price_inr:79,  original_price_inr:299,  badge:'', features:JSON.stringify(['Disney+','Hotstar Exclusive','Live Sports','4 Screens']), delivery_type:'manual', image_url:'', active:1, sort_order:7 },
    { platform:'Disney+ Hotstar', name:'Premium — 3 Month',duration_days:90,  price_inr:199, original_price_inr:799,  badge:'IPL Ready', features:JSON.stringify(['Disney+ Premium','4K Streaming','Live Cricket','4 Screens']), delivery_type:'manual', image_url:'', active:1, sort_order:8 },
    { platform:'Disney+ Hotstar', name:'Premium — 1 Year', duration_days:365, price_inr:699, original_price_inr:2999, badge:'', features:JSON.stringify(['Disney+ Premium','4K Streaming','Live Cricket','4 Screens']), delivery_type:'manual', image_url:'', active:1, sort_order:9 },
    // Spotify
    { platform:'Spotify', name:'Premium — 1 Month',  duration_days:30,  price_inr:39,  original_price_inr:119,  badge:'🎵 Music', features:JSON.stringify(['Ad-Free Music','Offline Downloads','Unlimited Skips','High Quality Audio']), delivery_type:'manual', image_url:'', active:1, sort_order:10 },
    { platform:'Spotify', name:'Premium — 3 Month',  duration_days:90,  price_inr:99,  original_price_inr:339,  badge:'', features:JSON.stringify(['Ad-Free Music','Offline Downloads','Unlimited Skips','High Quality Audio']), delivery_type:'manual', image_url:'', active:1, sort_order:11 },
    { platform:'Spotify', name:'Premium — 1 Year',   duration_days:365, price_inr:349, original_price_inr:1189, badge:'Best Value', features:JSON.stringify(['Ad-Free Music','Offline Downloads','Unlimited Skips','High Quality Audio']), delivery_type:'manual', image_url:'', active:1, sort_order:12 },
    // YouTube Premium
    { platform:'YouTube Premium', name:'Individual — 1 Month', duration_days:30,  price_inr:59,  original_price_inr:189, badge:'', features:JSON.stringify(['No Ads','Background Play','YouTube Music','Offline Videos']), delivery_type:'manual', image_url:'', active:1, sort_order:13 },
    { platform:'YouTube Premium', name:'Individual — 3 Month', duration_days:90,  price_inr:149, original_price_inr:539, badge:'', features:JSON.stringify(['No Ads','Background Play','YouTube Music','Offline Videos']), delivery_type:'manual', image_url:'', active:1, sort_order:14 },
    // Sony LIV
    { platform:'Sony LIV', name:'Premium — 1 Month', duration_days:30,  price_inr:49,  original_price_inr:299, badge:'', features:JSON.stringify(['Sony Originals','Live Sports','4K Content','Multi-Screen']), delivery_type:'manual', image_url:'', active:1, sort_order:15 },
    { platform:'Sony LIV', name:'Premium — 1 Year',  duration_days:365, price_inr:299, original_price_inr:999, badge:'', features:JSON.stringify(['Sony Originals','Live Sports','4K Content','Multi-Screen']), delivery_type:'manual', image_url:'', active:1, sort_order:16 },
    // ZEE5
    { platform:'ZEE5', name:'Annual Pack', duration_days:365, price_inr:199, original_price_inr:999, badge:'', features:JSON.stringify(['ZEE Originals','Live TV','Movies & Shows','Multi-Device']), delivery_type:'manual', image_url:'', active:1, sort_order:17 },
    // JioCinema
    { platform:'JioCinema', name:'Premium — 1 Month', duration_days:30,  price_inr:29, original_price_inr:99, badge:'', features:JSON.stringify(['Sports','Movies','Web Series','4K UHD']), delivery_type:'manual', image_url:'', active:1, sort_order:18 },
    // Apple TV+
    { platform:'Apple TV+', name:'1 Month', duration_days:30,  price_inr:99, original_price_inr:299, badge:'', features:JSON.stringify(['Apple Originals','4K HDR','Dolby Vision','All Devices']), delivery_type:'manual', image_url:'', active:1, sort_order:19 },
    // MEGA Bundle
    { platform:'Bundle', name:'Netflix + Prime + Hotstar — 1 Month', duration_days:30, price_inr:349, original_price_inr:1199, badge:'🔥 MEGA BUNDLE', features:JSON.stringify(['Netflix Premium 4K','Amazon Prime 1 Month','Disney+ Hotstar Premium','Save ₹850!']), delivery_type:'manual', image_url:'', active:1, sort_order:20 },
  ];

  const stmt = 'INSERT INTO plans (platform,name,duration_days,price_inr,original_price_inr,badge,features,delivery_type,image_url,active,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?)';
  for (const p of plans) {
    try {
      db.run(stmt, [p.platform,p.name,p.duration_days,p.price_inr,p.original_price_inr||null,p.badge||'',p.features,p.delivery_type,p.image_url,p.active,p.sort_order]);
    } catch {}
  }
}

function seedOtt24x7Products(db) {
  const existing = db.exec('SELECT COUNT(*) as c FROM plans');
  if ((existing[0]?.values[0][0] || 0) > 0) return;

  function dur(s) {
    if (!s || s.toLowerCase() === 'lifetime') return null;
    const m = s.match(/^(\d+)\s*(month|year|months|years)/i);
    if (!m) return null;
    const n = parseInt(m[1]);
    return m[2].toLowerCase().startsWith('year') ? n * 365 : n * 30;
  }

  function img(domain) {
    return `https://logo.clearbit.com/${domain}`;
  }

  const CAT = {
    access:       'MS Access',
    ai_writing:   'AI Tools',
    cloud:        'Cloud Services',
    design:       'Design',
    devtech:      'Development & Tech',
    learning:     'Learning',
    ms365:        'Microsoft 365',
    music:        'Music',
    office:       'MS Office',
    other:        'Security',
    professional: 'Professional Tools',
    project:      'MS Project',
    server:       'Windows Server',
    streaming:    'Streaming',
    visio:        'MS Visio',
    visual_studio:'Visual Studio',
    windows:      'Windows',
  };

  // name, cat, price, duration_str, domain
  const raw = [
    // access
    ['Access 2021 2PC [Retail Online]',                   'access',       81.48,   'Lifetime',  'microsoft.com'],
    ['Access 2024 1PC [BIND]',                            'access',     1425.90,   'Lifetime',  'microsoft.com'],
    ['MS Access',                                         'access',      999.00,   'Lifetime',  'microsoft.com'],
    // ai_writing
    ['Quillbot 1M Key',                                   'ai_writing',  150.00,   '1 Month',   'quillbot.com'],
    ['iAsk AI Pro 1Y',                                    'ai_writing',  299.00,   '1 Year',    'iask.ai'],
    ['Beautiful AI 1Y',                                   'ai_writing',  299.00,   '1 Year',    'beautiful.ai'],
    ['InVideo Studio 1Y',                                 'ai_writing', 1250.00,   '1 Year',    'invideo.io'],
    ['NoteGPT 1M Edu Pro',                                'ai_writing',   99.00,   '1 Month',   'notegpt.io'],
    // cloud
    ['Google One 100GB 6M',                               'cloud',       299.00,   '6 Months',  'one.google.com'],
    ['GG AI Pro 5TB G-Drive 18M',                         'cloud',      2200.00,   '18 Months', 'one.google.com'],
    ['Outlook',                                           'cloud',       999.00,   'Lifetime',  'outlook.com'],
    ['LinkedIn Career Premium 3M',                        'cloud',       499.00,   '3 Months',  'linkedin.com'],
    ['Nord VPN 3 Month Key',                              'cloud',       450.00,   '3 Months',  'nordvpn.com'],
    // design
    ['Picsart Pro 1 Year Key',                            'design',      550.00,   '1 Year',    'picsart.com'],
    ['Canva Pro Edu Student Lifetime',                    'design',      299.00,   'Lifetime',  'canva.com'],
    ['Canva Pro Staff Access All Features',               'design',      499.00,   'Lifetime',  'canva.com'],
    ['Adobe Express Premium 1Y Code',                     'design',      199.00,   '1 Year',    'adobe.com'],
    ['CorelDraw Graphic Suite 2024 Lifetime',             'design',     1499.00,   'Lifetime',  'coreldraw.com'],
    ['CorelDraw Technical/Graphic Suite 2025',            'design',     1999.00,   'Lifetime',  'coreldraw.com'],
    ['Autodesk All Apps Bundle 1Y',                       'design',     1499.00,   '1 Year',    'autodesk.com'],
    // devtech
    ['Outlook 2021 5PC [Retail Online]',                  'devtech',     230.86,   'Lifetime',  'outlook.com'],
    ['Outlook 2019 5PC [Retail Online]',                  'devtech',     149.38,   'Lifetime',  'outlook.com'],
    ['Outlook 2024 1PC [BIND]',                           'devtech',    1425.90,   'Lifetime',  'outlook.com'],
    ['Word 2024 1PC [BIND]',                              'devtech',    1371.58,   'Lifetime',  'microsoft.com'],
    ['Excel 2024 1PC [BIND]',                             'devtech',    1425.90,   'Lifetime',  'microsoft.com'],
    ['PowerPoint 2024 1PC [BIND]',                        'devtech',    1643.18,   'Lifetime',  'microsoft.com'],
    ['Notion Business 3M with AI',                        'devtech',     250.00,   '3 Months',  'notion.so'],
    // learning
    ['Coursera Plus 1Y',                                  'learning',   2400.00,   '1 Year',    'coursera.org'],
    ['EDX Courses 1Y',                                    'learning',    350.00,   '1 Year',    'edx.org'],
    // ms365
    ['Office 365 A3 Account 1Y',                          'ms365',       299.00,   '1 Year',    'microsoft.com'],
    // music
    ['Apple Music+ 6M',                                   'music',       299.00,   '6 Months',  'music.apple.com'],
    ['YouTube Premium 6M',                                'music',       550.00,   '6 Months',  'youtube.com'],
    // office
    ['Office 2010 Pro Plus 5PC [Retail Online]',          'office',      746.90,   'Lifetime',  'office.com'],
    ['Office 2013 Pro Plus 5PC [Retail Online]',          'office',      746.90,   'Lifetime',  'office.com'],
    ['Office 2016 Home & Business for 1 MAC [BIND]',      'office',     1127.14,   'Lifetime',  'office.com'],
    ['Office 2016 Home & Student 1PC [Retail Online]',    'office',      420.98,   'Lifetime',  'office.com'],
    ['Office 2016 Pro Plus 5PC [Retail Online]',          'office',     1195.04,   'Lifetime',  'office.com'],
    ['Office 2016 Pro Plus 1PC [Activate by Phone]',      'office',       54.32,   'Lifetime',  'office.com'],
    ['Office 2016 Pro Plus 1PC [BIND]',                   'office',     1276.52,   'Lifetime',  'office.com'],
    ['Office 2019 Home & Business for 1 MAC [BIND]',      'office',     1167.88,   'Lifetime',  'office.com'],
    ['Office 2019 Home & Business 1PC [Activate by Phone]','office',     230.86,   'Lifetime',  'office.com'],
    ['Office 2019 Home & Student 1PC [Activate by Phone]','office',      230.86,   'Lifetime',  'office.com'],
    ['Office 2019 Pro Plus 5PC [Retail Online]',          'office',     1004.92,   'Lifetime',  'office.com'],
    ['Office 2019 Pro Plus 1PC [BIND]',                   'office',     1195.04,   'Lifetime',  'office.com'],
    ['Office 2019 Pro Plus 1PC [Activate by Phone]',      'office',       81.48,   'Lifetime',  'office.com'],
    ['Office 2019 Pro Plus',                              'office',      599.00,   'Lifetime',  'office.com'],
    ['Office 2021 Home & Business 1 MAC [BIND]',          'office',     1086.40,   'Lifetime',  'office.com'],
    ['Office 2021 Pro Plus',                              'office',     2499.00,   'Lifetime',  'office.com'],
    ['Office 2021 Pro Plus 1PC [BIND]',                   'office',     2240.70,   'Lifetime',  'office.com'],
    ['Office 2021 Pro Plus 5PC [Retail Online]',          'office',     1004.92,   'Lifetime',  'office.com'],
    ['Office 2021 Pro Plus 1PC [Activate by Phone]',      'office',       95.06,   'Lifetime',  'office.com'],
    ['Office 2024 Home & Business 1 PC/MAC [BIND]',       'office',     5350.52,   'Lifetime',  'office.com'],
    ['Office 2024 Pro Plus LTSC 1PC [Activate by Phone]', 'office',      149.38,   'Lifetime',  'office.com'],
    ['Office 2024',                                       'office',     5600.00,   'Lifetime',  'office.com'],
    // other / security
    ['McAfee Total Protection 5Y Warranty',               'other',       999.00,   '5 Years',   'mcafee.com'],
    // professional
    ['Notion Edu Account',                                'professional',499.00,   'Lifetime',  'notion.so'],
    ['Miro 100 License Lifetime',                         'professional',1999.00,  'Lifetime',  'miro.com'],
    ['Google Gemini 500GB On Mail Invite',                'professional',499.00,   '1 Year',    'google.com'],
    // project
    ['Project 2019 Professional 2PC [Retail Online]',    'project',      81.48,   'Lifetime',  'microsoft.com'],
    ['Project 2021 Professional 2PC [Retail Online]',    'project',     122.22,   'Lifetime',  'microsoft.com'],
    ['Project 2019 Professional 1PC [BIND]',             'project',     380.24,   'Lifetime',  'microsoft.com'],
    ['Project 2019 Standard 5PC [Retail Online]',        'project',     122.22,   'Lifetime',  'microsoft.com'],
    ['Project 2024 Professional 1PC [BIND]',             'project',    1425.90,   'Lifetime',  'microsoft.com'],
    ['Project 2024 Standard 1PC [BIND]',                 'project',    1425.90,   'Lifetime',  'microsoft.com'],
    ['MS Project',                                       'project',     999.00,   'Lifetime',  'microsoft.com'],
    // server
    ['SQL Server 2019 Standard 1PC [Retail Online]',     'server',      448.14,   'Lifetime',  'microsoft.com'],
    ['SQL Server 2017 Standard 1PC [Retail Online]',     'server',      448.14,   'Lifetime',  'microsoft.com'],
    ['Windows Server 2022 Standard 2PC',                 'server',       95.06,   'Lifetime',  'microsoft.com'],
    ['Windows Server 2022 Standard 5PC',                 'server',      597.52,   'Lifetime',  'microsoft.com'],
    ['Windows Server 2022 Datacenter 2PC',               'server',       81.48,   'Lifetime',  'microsoft.com'],
    ['Windows Server 2022 Datacenter 5PC',               'server',      230.86,   'Lifetime',  'microsoft.com'],
    ['Windows Server 2022 Datacenter 1000PC [MAK:Volume]','server',     597.52,   'Lifetime',  'microsoft.com'],
    ['Windows Server 2022 RDS User CAL (50)',             'server',     1276.52,   'Lifetime',  'microsoft.com'],
    ['Windows Server 2022 RDS Device CAL (50)',           'server',      380.24,   'Lifetime',  'microsoft.com'],
    ['Windows Server 2025 Datacenter 1000PC [MAK:Volume]','server',     597.52,   'Lifetime',  'microsoft.com'],
    ['Windows Server 2025 Datacenter 5PC',               'server',      230.86,   'Lifetime',  'microsoft.com'],
    ['Windows Server 2025 Standard 100PC [MAK:Volume]',  'server',     1195.04,   'Lifetime',  'microsoft.com'],
    ['Windows Server 2025 Standard 5PC',                 'server',      597.52,   'Lifetime',  'microsoft.com'],
    // streaming
    ['Apple TV+ 12M',                                    'streaming',   550.00,   '12 Months', 'apple.com'],
    ['ZEE5 Premium HD 1Y',                               'streaming',   399.00,   '1 Year',    'zee5.com'],
    ['SonyLiv Premium 6M Code',                          'streaming',   199.00,   '6 Months',  'sonyliv.com'],
    // visio
    ['Visio 2021 Professional 2PC [Retail Online]',      'visio',        81.48,   'Lifetime',  'microsoft.com'],
    ['Visio 2021 Professional 5PC [Retail Online]',      'visio',       298.76,   'Lifetime',  'microsoft.com'],
    ['Visio 2019 Standard 5PC [Retail Online]',          'visio',       122.22,   'Lifetime',  'microsoft.com'],
    ['Visio 2024 Professional 1PC [BIND]',               'visio',      1425.90,   'Lifetime',  'microsoft.com'],
    ['Visio 2024 Standard 1PC [BIND]',                   'visio',      1425.90,   'Lifetime',  'microsoft.com'],
    // visual_studio
    ['Visual Studio 2022 Professional 5PC [Retail Online]', 'visual_studio', 746.90, 'Lifetime', 'microsoft.com'],
    ['Visual Studio 2019 Professional 5PC [Retail Online]', 'visual_studio', 230.86, 'Lifetime', 'microsoft.com'],
    ['Visual Studio 2022 Enterprise 2PC [Retail Online]',   'visual_studio', 122.22, 'Lifetime', 'microsoft.com'],
    ['Visual Studio 2026 Enterprise 5PC [Retail Online]',   'visual_studio', 380.24, 'Lifetime', 'microsoft.com'],
    // windows
    ['Windows 10 / 11 Pro 1PC [Activate by Phone]',      'windows',      54.32,   'Lifetime',  'microsoft.com'],
    ['Windows 10 / 11 Home 1PC [Activate by Phone]',     'windows',      54.32,   'Lifetime',  'microsoft.com'],
    ['Windows 8 5PC [Retail Online]',                    'windows',      81.48,   'Lifetime',  'microsoft.com'],
    ['Windows 8 Pro 5PC [Retail Online]',                'windows',      81.48,   'Lifetime',  'microsoft.com'],
    ['Windows 10 / 11 Home 1PC [OEM]',                   'windows',     122.22,   'Lifetime',  'microsoft.com'],
    ['Windows 8.1 Pro N 5PC [Retail Online]',            'windows',     122.22,   'Lifetime',  'microsoft.com'],
    ['Windows 10 / 11 Pro 1PC [OEM]',                    'windows',     149.38,   'Lifetime',  'microsoft.com'],
    ['Windows 10 / 11 Enterprise 1PC [MAK:Volume]',      'windows',     230.86,   'Lifetime',  'microsoft.com'],
    ['Windows 10 / 11 Pro N 5PC [Retail Online]',        'windows',     298.76,   'Lifetime',  'microsoft.com'],
    ['Windows 10 / 11 Pro 5PC [Retail Online]',          'windows',    1018.50,   'Lifetime',  'microsoft.com'],
    ['Windows 10 / 11 Pro 20PC [MAK:Volume]',            'windows',    1167.88,   'Lifetime',  'microsoft.com'],
    ['Windows 10 / 11 Home 5PC [Retail Online]',         'windows',    1344.42,   'Lifetime',  'microsoft.com'],
    ['Windows 10 / 11 Enterprise 20PC [MAK:Volume]',     'windows',    1385.16,   'Lifetime',  'microsoft.com'],
  ];

  const stmt = 'INSERT INTO plans (platform,name,duration_days,price_inr,original_price_inr,badge,features,delivery_type,image_url,active,sort_order,category) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)';
  raw.forEach(([name, cat, price, durStr, domain], i) => {
    try {
      db.run(stmt, [CAT[cat], name, dur(durStr), price, null, '', '[]', 'manual', img(domain), 1, i + 1, cat]);
    } catch {}
  });
}

function seedPlatformImages(db) {
  // Update image_url for plans that have empty image_url, matched by platform name
  const images = {
    'Netflix':          'https://images.justwatch.com/icon/207360008/s100/netflix.webp',
    'Amazon Prime':     'https://images.justwatch.com/icon/52449539/s100/amazon-prime-video.webp',
    'Prime Video':      'https://images.justwatch.com/icon/52449539/s100/amazon-prime-video.webp',
    'Disney+ Hotstar':  'https://images.justwatch.com/icon/246301700/s100/disney-hotstar.webp',
    'Disney+':          'https://images.justwatch.com/icon/147638351/s100/disney-plus.webp',
    'Hotstar':          'https://images.justwatch.com/icon/246301700/s100/disney-hotstar.webp',
    'Sony LIV':         'https://images.justwatch.com/icon/232695239/s100/sony-liv.webp',
    'ZEE5':             'https://images.justwatch.com/icon/169478387/s100/zee5.webp',
    'Zee5':             'https://images.justwatch.com/icon/169478387/s100/zee5.webp',
    'JioCinema':        'https://images.justwatch.com/icon/305458112/s100/jiocinema.webp',
    'MX Player':        'https://images.justwatch.com/icon/154652170/s100/mx-player.webp',
    'Voot':             'https://images.justwatch.com/icon/154652162/s100/voot.webp',
    'Apple TV+':        'https://images.justwatch.com/icon/190848813/s100/apple-tv-plus.webp',
    'Spotify':          'https://images.justwatch.com/icon/112687516/s100/spotify.webp',
    'YouTube Premium':  'https://images.justwatch.com/icon/59562423/s100/youtube-premium.webp',
    'YouTube':          'https://images.justwatch.com/icon/59562423/s100/youtube-premium.webp',
    'Crunchyroll':      'https://images.justwatch.com/icon/122261067/s100/crunchyroll.webp',
    'Mubi':             'https://images.justwatch.com/icon/118714177/s100/mubi.webp',
  };
  for (const [platform, url] of Object.entries(images)) {
    try {
      db.run(`UPDATE plans SET image_url=? WHERE platform=? AND (image_url IS NULL OR image_url='')`, [url, platform]);
    } catch {}
  }
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
    site_tagline: 'Premium digital products & software',
    hero_title: 'Premium digital products.',
    hero_title2: 'Delivered cinematic fast.',
    hero_subtext: 'Buy OTT, AI tools, cloud storage, software keys and productivity products with fast WhatsApp support, secure payments and clean account delivery.',
    support_email: '',
    support_whatsapp: '',
    support_telegram: '',
    telegram_bot_url: 'https://t.me/ott24x7_bot',
    announcement: '',
    timezone: 'Asia/Kolkata',
    logo_url: '',
    favicon_url: '',
    robots_txt: 'User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /admin/api\nDisallow: /user/api\nDisallow: /api\nDisallow: /checkout\nDisallow: /cart\nDisallow: /account\nDisallow: /my\nDisallow: /*.json$',
    upi_id: '',
    upi_name: '',
    upi_unique_max_delta: '6', // unique payment amount = price ± 1..N whole rupees (collision-aware)
    upi_unique_direction: 'both', // 'both' = ±; 'up' = never charge below the price
    // USDT direct checkout (replaces wallet/Razorpay/manual UPI)
    usdt_inr_rate: '99',
    usdt_fee_pct: '1.5',
    usdt_payment_window_minutes: '20',
    usdt_binance_enabled: '0',
    usdt_binance_uid: '',
    usdt_binance_qr_url: '',
    usdt_bep20_enabled: '0',
    usdt_bep20_address: '',
    usdt_bep20_qr_url: '',
    usdt_trc20_enabled: '0',
    usdt_trc20_address: '',
    usdt_trc20_qr_url: '',
    'seo_home_title': 'Digital Products & Software — OTT, AI & Keys',
    'seo_home_desc': 'Genuine OTT, AI & software subscriptions in India. Instant activation, full-validity replacement warranty, UPI & crypto checkout, 24×7 support.',
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
    wa_ai_reply_enabled: '1',
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
    // Auto Fulfillment
    fulfillment_enabled: '0',
    resellkeys_api_key: '',
    resellkeys_api_url: 'https://www.resellkeys.com',
    resellkeys_email: '',
    resellkeys_password: '',
    fulfillment_poll_interval: '10',
    autopost_start_hour: '9',
    autopost_end_hour: '22',
    // Chat Bot Widget
    bot_enabled: '1',
    bot_name: 'Store AI',
    bot_tagline: 'Online · Replies instantly',
    bot_avatar: '',
    bot_accent: '#7c3aed',
    bot_greeting: "👋 Hi! I'm your *{site_name}* AI.\nWhat would you like to do?",
    bot_system_prompt: '',
    // Store Appearance
    store_theme: 'midnight-purple',
    // PWA / App Manager
    pwa_name: '',
    pwa_short_name: '',
    pwa_description: 'Buy OTT Subscriptions at Best Prices',
    pwa_theme_color: '#7c3aed',
    pwa_bg_color: '#0d1117',
    pwa_icon_b64: '',
    pwa_force_prompt: '0',
    vapid_public_key: '',
    vapid_private_key: '',
    vapid_subject: 'mailto:admin@example.com',
  };
  for (const [k, v] of Object.entries(defaults)) {
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`, [k, v]);
  }
}

function seedEmailTemplates(db) {
  const existing = db.exec('SELECT COUNT(*) as c FROM email_templates WHERE is_system=1');
  const count = existing[0]?.values[0][0] || 0;
  if (count > 0) return;

  function tpl(name, category, subject, headline, bodyHtml, ctaText, accent) {
    const ac = accent || '#7c3aed';
    const cta = ctaText ? `<div style="text-align:center;margin:24px 0"><a href="{{site_url}}" style="background:${ac};color:#fff;padding:13px 30px;border-radius:8px;font-weight:700;font-size:15px;text-decoration:none;display:inline-block">${ctaText}</a></div>` : '';
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title></head><body style="margin:0;padding:0;background:#f0f0f5;font-family:Arial,Helvetica,sans-serif"><table width="100%" cellpadding="0" cellspacing="0" bgcolor="#f0f0f5"><tr><td align="center" style="padding:24px 12px"><table width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%"><tr><td style="background:${ac};padding:22px 28px;border-radius:12px 12px 0 0;text-align:center"><strong style="color:#fff;font-size:24px;font-weight:800;letter-spacing:-0.5px">{{site_name}}</strong></td></tr><tr><td style="background:#fff;padding:32px 28px;border-radius:0 0 12px 12px"><h2 style="color:#111827;font-size:22px;margin:0 0 14px;font-weight:700">${headline}</h2><p style="color:#555;font-size:15px;margin:0 0 16px;line-height:1.7">Hi {{name}},</p>${bodyHtml}${cta}<hr style="border:0;border-top:1px solid #eee;margin:24px 0"><p style="color:#aaa;font-size:12px;margin:0;line-height:1.6">You received this email because you have an account with <strong>{{site_name}}</strong>. If this was sent in error, please ignore.</p></td></tr></table></td></tr></table></body></html>`;
    return { name, category, subject, html };
  }

  const T = [
    // ── Welcome ─────────────────────────────────────────────────────────────
    tpl('Welcome Email', 'welcome', 'Welcome to {{site_name}}! 🎉', 'Welcome to {{site_name}}!',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Thank you for creating an account! We offer premium OTT subscriptions — Netflix, Spotify, Amazon Prime, Disney+ and more — at the <strong>best prices with instant delivery</strong>.</p><p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Browse our plans and start streaming today.</p>`,
      'Browse Plans', '#7c3aed'),

    tpl('Email Verified', 'welcome', 'Your email is verified ✅', 'Email Verified Successfully',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Your email address has been verified. You now have full access to all features including order tracking, wallet top-up, and exclusive member offers.</p>`,
      'Visit Store', '#059669'),

    // ── Order ────────────────────────────────────────────────────────────────
    tpl('Order Placed', 'order', 'Your order is confirmed! 🛒', 'Order Placed Successfully',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Your order has been placed and is being processed. You'll receive your credentials shortly.</p><table style="background:#f9fafb;border-radius:8px;padding:14px 18px;width:100%;margin:12px 0" cellpadding="0" cellspacing="0"><tr><td style="color:#555;font-size:14px;padding:4px 0"><strong>Order ID:</strong> #{{order_id}}</td></tr><tr><td style="color:#555;font-size:14px;padding:4px 0"><strong>Plan:</strong> {{product_name}}</td></tr><tr><td style="color:#555;font-size:14px;padding:4px 0"><strong>Amount:</strong> ₹{{amount}}</td></tr></table>`,
      'Track Order', '#7c3aed'),

    tpl('Order Delivered', 'order', '✅ Your order is ready! Credentials inside', 'Your Subscription is Ready!',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Your <strong>{{product_name}}</strong> subscription is now active. Here are your credentials:</p><table style="background:#0d1117;border-radius:8px;padding:16px 20px;width:100%;margin:12px 0" cellpadding="0" cellspacing="0"><tr><td style="color:#d1d5db;font-size:14px;font-family:monospace;line-height:1.8">{{credentials}}</td></tr></table><p style="color:#ef4444;font-size:13px;margin:8px 0 0">⚠️ Keep these credentials safe. Do not share with anyone.</p>`,
      'My Account', '#059669'),

    tpl('Netflix Delivered', 'order', '🎬 Your Netflix is Ready!', 'Netflix Credentials Delivered',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Your <strong>Netflix</strong> account is ready! Log in at <a href="https://netflix.com" style="color:#E50914">netflix.com</a></p><table style="background:#141414;border-radius:8px;padding:16px 20px;width:100%;margin:12px 0" cellpadding="0" cellspacing="0"><tr><td style="color:#fff;font-size:14px;font-family:monospace;line-height:1.8">{{credentials}}</td></tr></table><p style="color:#aaa;font-size:13px;margin:8px 0">Use the profile assigned to you. Do not change the main account password.</p>`,
      'Open Netflix', '#E50914'),

    tpl('Amazon Prime Delivered', 'order', '📽️ Your Amazon Prime is Ready!', 'Amazon Prime Credentials Delivered',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Your <strong>Amazon Prime Video</strong> account is ready! Log in at <a href="https://primevideo.com" style="color:#00A8E1">primevideo.com</a></p><table style="background:#131921;border-radius:8px;padding:16px 20px;width:100%;margin:12px 0" cellpadding="0" cellspacing="0"><tr><td style="color:#fff;font-size:14px;font-family:monospace;line-height:1.8">{{credentials}}</td></tr></table>`,
      'Open Prime Video', '#00A8E1'),

    tpl('Disney+ Hotstar Delivered', 'order', '⭐ Your Disney+ Hotstar is Ready!', 'Disney+ Hotstar is Ready',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Your <strong>Disney+ Hotstar</strong> is now active! Log in at <a href="https://www.hotstar.com" style="color:#1B6FCC">hotstar.com</a></p><table style="background:#03101B;border-radius:8px;padding:16px 20px;width:100%;margin:12px 0" cellpadding="0" cellspacing="0"><tr><td style="color:#fff;font-size:14px;font-family:monospace;line-height:1.8">{{credentials}}</td></tr></table>`,
      'Open Hotstar', '#1B6FCC'),

    tpl('Spotify Delivered', 'order', '🎵 Your Spotify Premium is Ready!', 'Spotify Premium Credentials Delivered',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Your <strong>Spotify Premium</strong> is ready! Log in at <a href="https://spotify.com" style="color:#1DB954">spotify.com</a></p><table style="background:#121212;border-radius:8px;padding:16px 20px;width:100%;margin:12px 0" cellpadding="0" cellspacing="0"><tr><td style="color:#fff;font-size:14px;font-family:monospace;line-height:1.8">{{credentials}}</td></tr></table>`,
      'Open Spotify', '#1DB954'),

    tpl('YouTube Premium Delivered', 'order', '📺 Your YouTube Premium is Ready!', 'YouTube Premium Activated',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Your <strong>YouTube Premium</strong> is now active! No ads, offline downloads, and YouTube Music included.</p><table style="background:#0f0f0f;border-radius:8px;padding:16px 20px;width:100%;margin:12px 0" cellpadding="0" cellspacing="0"><tr><td style="color:#fff;font-size:14px;font-family:monospace;line-height:1.8">{{credentials}}</td></tr></table>`,
      'Open YouTube', '#FF0000'),

    tpl('Order Cancelled', 'order', 'Your order has been cancelled', 'Order Cancelled',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Your order <strong>#{{order_id}}</strong> has been cancelled. If you paid for this order, a refund will be processed within 24–48 hours.</p><p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Contact our support if you have any questions.</p>`,
      'Contact Support', '#ef4444'),

    tpl('Refund Processed', 'order', 'Refund of ₹{{amount}} processed ✅', 'Refund Processed',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Your refund of <strong>₹{{amount}}</strong> has been processed and added to your wallet. You can use it for future purchases.</p>`,
      'Shop Again', '#059669'),

    // ── Flash Sales / Offers ──────────────────────────────────────────────────
    tpl('Flash Sale 50% Off', 'offer', '⚡ FLASH SALE: 50% Off — Today Only!', '⚡ Flash Sale — 50% Off Everything!',
      `<div style="background:linear-gradient(135deg,#7c3aed,#ec4899);padding:20px;border-radius:10px;text-align:center;margin:0 0 20px"><p style="color:#fff;font-size:28px;font-weight:900;margin:0">50% OFF</p><p style="color:rgba(255,255,255,0.9);font-size:14px;margin:4px 0 0">Today only • Midnight deadline</p></div><p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Don't miss our biggest flash sale ever! All OTT subscriptions — Netflix, Spotify, Amazon Prime and more — are <strong>50% off for the next 24 hours only</strong>.</p>`,
      'Grab the Deal', '#7c3aed'),

    tpl('Weekend Special Deal', 'offer', '🎉 Weekend Deal: 20% Extra Off!', 'Weekend Special — Extra 20% Off',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">It's the weekend and we're celebrating with an <strong>extra 20% discount</strong> on all subscription plans! Valid Saturday & Sunday only.</p><p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Use code <strong style="background:#f3f4f6;padding:3px 8px;border-radius:4px;font-family:monospace">WEEKEND20</strong> at checkout.</p>`,
      'Shop Now', '#f59e0b'),

    tpl('New Year 2025 Offer', 'offer', '🎊 Happy New Year! Best Deals of 2025', 'Start 2025 with Amazing Deals!',
      `<div style="text-align:center;padding:16px 0;margin:0 0 20px"><span style="font-size:48px">🎊</span></div><p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Happy New Year from {{site_name}}! Start 2025 right with our <strong>best subscription deals of the year</strong>. Up to 40% off on Netflix, Spotify, Prime and more!</p>`,
      'Start the Year', '#7c3aed'),

    tpl('Diwali Mega Sale', 'offer', '🪔 Diwali Mega Sale — Up to 40% Off!', '🪔 Happy Diwali — Mega Sale is Live!',
      `<div style="text-align:center;padding:16px 0;margin:0 0 20px"><span style="font-size:48px">🪔✨</span></div><p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">This Diwali, light up your entertainment with our biggest sale! Up to <strong>40% off</strong> on premium OTT subscriptions. Festival season calls for binge-watching! 🎉</p>`,
      'Celebrate & Save', '#f59e0b'),

    tpl('Holi Sale', 'offer', '🌈 Holi Sale — Colorful Savings Inside!', '🌈 Happy Holi — 30% Off!',
      `<div style="background:linear-gradient(135deg,#ec4899,#f59e0b,#10b981);padding:16px;border-radius:10px;text-align:center;margin:0 0 20px"><strong style="color:#fff;font-size:22px">Happy Holi!</strong></div><p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Color your life with entertainment! Enjoy <strong>30% off</strong> on all subscriptions this Holi. Celebrate with family and stream together!</p>`,
      'Shop Holi Deals', '#ec4899'),

    tpl('Independence Day Sale', 'offer', '🇮🇳 Independence Day Sale — 25% Off!', '🇮🇳 Happy Independence Day!',
      `<div style="background:linear-gradient(135deg,#FF9933,#fff,#138808);padding:16px;border-radius:10px;text-align:center;margin:0 0 20px"><strong style="color:#000;font-size:20px">Azaadi Sale — 25% Off!</strong></div><p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Celebrate 77 years of freedom with <strong>25% off</strong> on all OTT subscriptions! Stream the best of Indian and global entertainment.</p>`,
      'Celebrate & Stream', '#138808'),

    tpl('Limited Time Offer', 'offer', '⏰ Hurry! This offer expires soon', '⏰ Limited Time Offer — Ending Soon!',
      `<div style="background:#fef2f2;border:2px solid #fca5a5;padding:14px 18px;border-radius:8px;margin:0 0 20px;text-align:center"><strong style="color:#ef4444;font-size:16px">⏰ This offer expires in 24 hours!</strong></div><p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">We have an exclusive offer available for a very limited time. Don't let it slip away — these prices won't last!</p>`,
      'Claim Before It Expires', '#ef4444'),

    tpl('Buy 1 Get 1 Free', 'offer', '🎁 Buy 1 Get 1 FREE — Today Only!', 'Buy 1 Get 1 FREE on All Plans!',
      `<div style="background:linear-gradient(135deg,#059669,#10b981);padding:20px;border-radius:10px;text-align:center;margin:0 0 20px"><strong style="color:#fff;font-size:24px">BUY 1 GET 1 FREE 🎁</strong></div><p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Purchase any subscription plan and get a second plan <strong>absolutely FREE</strong>! Perfect for sharing with a friend or family member.</p>`,
      'Get the Deal', '#059669'),

    tpl('Exclusive Member Offer', 'offer', '🌟 Exclusive offer just for you!', '🌟 An Exclusive Offer for You',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">As one of our valued customers, we have a <strong>special exclusive offer</strong> just for you! This offer is not available to everyone — only selected members like you.</p>`,
      'Claim Your Offer', '#7c3aed'),

    tpl('OTT Combo Pack', 'offer', '📦 OTT Combo Pack — Save More!', 'Get the Ultimate OTT Combo Pack!',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Why pay separately? Get our <strong>Ultimate OTT Combo Pack</strong> — Netflix + Spotify + Amazon Prime — all in one bundle at a massive discount!</p><table style="width:100%;margin:12px 0" cellpadding="8" cellspacing="0"><tr style="background:#f9fafb"><td style="font-size:14px;color:#333;border-radius:6px">🎬 Netflix Premium</td><td align="right" style="font-size:14px;color:#7c3aed;font-weight:700">Included</td></tr><tr><td style="font-size:14px;color:#333">🎵 Spotify Premium</td><td align="right" style="font-size:14px;color:#7c3aed;font-weight:700">Included</td></tr><tr style="background:#f9fafb"><td style="font-size:14px;color:#333;border-radius:6px">📽️ Amazon Prime</td><td align="right" style="font-size:14px;color:#7c3aed;font-weight:700">Included</td></tr></table>`,
      'Get Combo Pack', '#7c3aed'),

    tpl('Cashback Offer', 'offer', '💰 Earn Cashback on Your Next Order!', 'Earn Cashback on Every Purchase',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">We're rewarding our customers! Earn <strong>cashback on every order</strong> you place. The cashback is added directly to your wallet for use on future purchases.</p>`,
      'Shop & Earn', '#f59e0b'),

    tpl('Anniversary Sale', 'offer', '🎂 Anniversary Sale — 35% Off!', '🎂 We\'re Celebrating — 35% Off!',
      `<div style="text-align:center;padding:16px 0;margin:0 0 20px"><span style="font-size:48px">🎂🎉</span></div><p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">We're celebrating our anniversary and we want you to celebrate with us! Enjoy <strong>35% off on all plans</strong> for 48 hours only!</p>`,
      'Celebrate & Save', '#ec4899'),

    tpl('Student Discount', 'offer', '🎓 Special Student Pricing Inside!', '🎓 Student Discount — 20% Extra Off',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">We support students! Enjoy an <strong>extra 20% off</strong> on all subscriptions. Perfect for studying and entertainment during your academic journey.</p>`,
      'Claim Student Discount', '#3b82f6'),

    tpl('Refer & Earn', 'offer', '🤝 Refer Friends — Earn ₹{{referral_amount}} Each!', 'Earn Money by Referring Friends!',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Share {{site_name}} with your friends and earn <strong>₹{{referral_amount}} for every friend</strong> who signs up and makes their first purchase!</p><p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Your referral code: <strong style="background:#f3f4f6;padding:4px 10px;border-radius:4px;font-family:monospace;color:#7c3aed">{{referral_code}}</strong></p>`,
      'Share & Earn', '#7c3aed'),

    tpl('Loyalty Reward', 'offer', '🏆 You\'ve Earned a Loyalty Reward!', '🏆 Thank You for Being Loyal!',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">You've been with us for a while and we want to say <strong>thank you</strong>! As a loyal customer, we're rewarding you with a special discount on your next purchase.</p>`,
      'Claim Reward', '#f59e0b'),

    // ── Product Highlights ────────────────────────────────────────────────────
    tpl('Netflix Plans', 'product', '🎬 Netflix Premium Plans — Best Prices!', 'Get Netflix at the Best Price!',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Watch unlimited movies, TV shows, and originals on Netflix. We offer <strong>Netflix Premium (4K UHD)</strong> at unbeatable prices!</p><ul style="color:#555;font-size:15px;line-height:1.7;margin:0 0 16px;padding-left:20px"><li>4K Ultra HD streaming</li><li>Up to 4 screens simultaneously</li><li>Instant delivery after payment</li><li>1 month, 3 months, yearly plans</li></ul>`,
      'Buy Netflix Plan', '#E50914'),

    tpl('Amazon Prime Plans', 'product', '📽️ Amazon Prime — Best Deals!', 'Amazon Prime at Amazing Prices!',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Stream 5000+ movies and TV shows on Amazon Prime Video. Plus Prime Music, Prime Reading, and free delivery benefits!</p><ul style="color:#555;font-size:15px;line-height:1.7;margin:0 0 16px;padding-left:20px"><li>Unlimited video streaming</li><li>Prime Music included</li><li>Download for offline viewing</li><li>Exclusive Prime Originals</li></ul>`,
      'Buy Prime Plan', '#00A8E1'),

    tpl('Disney+ Hotstar Plans', 'product', '⭐ Disney+ Hotstar — All Plans Available!', 'Disney+ Hotstar — Watch Everything!',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Stream Disney, Marvel, Star Wars, Pixar + live sports + Indian content on Hotstar!</p><ul style="color:#555;font-size:15px;line-height:1.7;margin:0 0 16px;padding-left:20px"><li>Disney, Marvel, Star Wars content</li><li>Live cricket & sports streaming</li><li>Bollywood & regional content</li><li>4K streaming available</li></ul>`,
      'Buy Hotstar Plan', '#1B6FCC'),

    tpl('Spotify Premium Plans', 'product', '🎵 Spotify Premium — Best Prices!', 'Spotify Premium — Stream Ad-Free!',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">100 million+ songs, podcasts, and audiobooks — all ad-free with Spotify Premium!</p><ul style="color:#555;font-size:15px;line-height:1.7;margin:0 0 16px;padding-left:20px"><li>No ads, no interruptions</li><li>Download for offline listening</li><li>Unlimited skips</li><li>High quality audio</li></ul>`,
      'Buy Spotify Plan', '#1DB954'),

    tpl('YouTube Premium Plans', 'product', '📺 YouTube Premium — No More Ads!', 'YouTube Premium — Ad-Free Streaming!',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">YouTube Premium gives you ad-free videos, background play, YouTube Music, and YouTube Originals!</p><ul style="color:#555;font-size:15px;line-height:1.7;margin:0 0 16px;padding-left:20px"><li>Ad-free on all devices</li><li>Background play while using other apps</li><li>YouTube Music Premium included</li><li>Download videos offline</li></ul>`,
      'Buy YouTube Plan', '#FF0000'),

    tpl('ChatGPT Plus Plans', 'product', '🤖 ChatGPT Plus — AI Power Unlocked!', 'Get ChatGPT Plus Access!',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Unlock the full power of GPT-4o, DALL·E image generation, browsing, code execution, and more with ChatGPT Plus!</p><ul style="color:#555;font-size:15px;line-height:1.7;margin:0 0 16px;padding-left:20px"><li>GPT-4o access (latest model)</li><li>DALL·E 3 image generation</li><li>Advanced data analysis</li><li>Priority access & faster responses</li></ul>`,
      'Get ChatGPT Plus', '#10a37f'),

    tpl('Canva Pro Plans', 'product', '🎨 Canva Pro — Design Like a Pro!', 'Canva Pro at Unbeatable Prices!',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Unlock all of Canva's premium features for stunning designs, presentations, videos, and social media content!</p><ul style="color:#555;font-size:15px;line-height:1.7;margin:0 0 16px;padding-left:20px"><li>100+ million premium stock photos</li><li>Background remover tool</li><li>Brand Kit & Magic Resize</li><li>Schedule social media posts</li></ul>`,
      'Get Canva Pro', '#00c4cc'),

    tpl('Microsoft 365 Plans', 'product', '📘 Microsoft 365 — All Apps Included!', 'Microsoft 365 — Work Smarter!',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Get Word, Excel, PowerPoint, Teams, Outlook, and 1TB OneDrive storage with Microsoft 365!</p><ul style="color:#555;font-size:15px;line-height:1.7;margin:0 0 16px;padding-left:20px"><li>Word, Excel, PowerPoint</li><li>Microsoft Teams for collaboration</li><li>1TB OneDrive cloud storage</li><li>Works on 5 devices</li></ul>`,
      'Get Microsoft 365', '#0078d4'),

    tpl('VPN Service Plans', 'product', '🔐 VPN — Browse Safely & Freely!', 'Secure Your Internet with VPN!',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Stay private and secure online. Access geo-blocked content from anywhere in the world!</p><ul style="color:#555;font-size:15px;line-height:1.7;margin:0 0 16px;padding-left:20px"><li>Military-grade encryption</li><li>Servers in 90+ countries</li><li>No logs policy</li><li>Connect 6 devices simultaneously</li></ul>`,
      'Get VPN Plan', '#059669'),

    tpl('OTT Bundle Deal', 'product', '📦 Ultimate OTT Bundle — All in One!', 'Get the Ultimate OTT Bundle!',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Why pay full price for each service? Get our <strong>Ultimate Bundle</strong> with all major OTT platforms at one amazing price!</p><p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Includes Netflix, Prime Video, Hotstar, Spotify, YouTube Premium and more — all at a fraction of the original cost.</p>`,
      'Get the Bundle', '#7c3aed'),

    // ── Customer Retention ────────────────────────────────────────────────────
    tpl('We Miss You', 'retention', '💔 We Miss You — Come Back with 15% Off!', 'We Miss You, {{name}}!',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">It's been a while since your last purchase. We miss having you as a customer!</p><p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">We'd love to welcome you back with an <strong>exclusive 15% discount</strong> on your next order. No strings attached!</p>`,
      'Come Back & Save', '#7c3aed'),

    tpl('Subscription Expiry Warning', 'retention', '⚠️ Your subscription expires in 3 days!', '⏰ Your Subscription is Expiring Soon!',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Your <strong>{{product_name}}</strong> subscription is expiring in <strong>3 days</strong>. Renew now to avoid any interruption to your streaming!</p><p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Renewal takes less than a minute and your new credentials will be delivered instantly.</p>`,
      'Renew Now', '#f59e0b'),

    tpl('Subscription Expired', 'retention', '📺 Your subscription has expired — Renew Now', 'Your Subscription Has Expired',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Your <strong>{{product_name}}</strong> subscription has expired. Don't miss your favourite shows and music!</p><p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Renew today and get back to streaming instantly. We offer the best renewal prices!</p>`,
      'Renew Subscription', '#ef4444'),

    tpl('Low Wallet Balance', 'retention', '💳 Your wallet balance is low', 'Top Up Your Wallet',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Your wallet balance is running low. Add money now to make sure your next subscription renewal goes smoothly without interruption.</p>`,
      'Add Money to Wallet', '#f59e0b'),

    tpl('VIP Upgrade', 'retention', '🌟 You\'ve been upgraded to VIP!', '🌟 Welcome to VIP Status!',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Congratulations! Based on your loyalty, you've been <strong>upgraded to VIP status</strong>. Enjoy exclusive benefits including priority support, early access to deals, and special VIP-only prices!</p>`,
      'Explore VIP Benefits', '#f59e0b'),

    tpl('Thank You for Purchase', 'retention', '🙏 Thank you for your purchase!', 'Thank You, {{name}}!',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Thank you for choosing {{site_name}}! Your purchase means a lot to us. We hope you enjoy your subscription.</p><p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">If you have any questions or need help, our support team is always here for you.</p>`,
      'Browse More Plans', '#059669'),

    tpl('Feedback Request', 'retention', '⭐ How was your experience with us?', 'We\'d Love Your Feedback!',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Hi {{name}}, how was your experience with {{site_name}}? Your feedback helps us improve!</p><p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Take 30 seconds to share your thoughts — it means the world to us.</p>`,
      'Share Feedback', '#7c3aed'),

    tpl('Restock Notification', 'retention', '🎉 {{product_name}} is back in stock!', '{{product_name}} is Back in Stock!',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Great news! <strong>{{product_name}}</strong> is back in stock and ready for purchase. These spots fill up fast, so don't wait too long!</p>`,
      'Buy Now', '#059669'),

    tpl('Price Drop Alert', 'retention', '📉 Price Drop: {{product_name}} is cheaper now!', 'Price Drop Alert!',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Good news! <strong>{{product_name}}</strong> has just dropped in price. Now available at <strong>₹{{amount}}</strong> — the lowest we've ever offered!</p>`,
      'Buy at New Price', '#059669'),

    tpl('Win-Back Campaign', 'retention', '🎯 Special offer to win you back!', 'We Have a Special Offer for You!',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">We noticed you haven't purchased recently and we want to make it up to you! Here's an <strong>exclusive 25% discount</strong> valid only for the next 48 hours.</p>`,
      'Claim 25% Off', '#7c3aed'),

    tpl('Abandoned Cart Reminder', 'retention', '🛒 You left something in your cart!', 'Complete Your Purchase',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">You were so close! You had a subscription plan in mind but didn't complete your purchase. Come back and finish what you started!</p>`,
      'Complete Purchase', '#f59e0b'),

    // ── Newsletter ────────────────────────────────────────────────────────────
    tpl('Monthly Newsletter', 'newsletter', '📬 {{site_name}} Monthly Update', 'What\'s New at {{site_name}} This Month',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Here's what happened at {{site_name}} this month — new plans, offers, and updates just for you!</p><p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Check out our latest additions and grab the best deals before they're gone.</p>`,
      'See This Month\'s Deals', '#7c3aed'),

    tpl('Top Deals This Week', 'newsletter', '🔥 Top 5 Deals You Can\'t Miss!', '🔥 Top Deals This Week',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Here are this week's top 5 deals — carefully picked just for you:</p><ol style="color:#555;font-size:15px;line-height:1.7;margin:0 0 16px;padding-left:20px"><li>Netflix Premium — Best Price</li><li>Spotify + YouTube Bundle</li><li>Amazon Prime Annual</li><li>ChatGPT Plus Monthly</li><li>Canva Pro 1 Year</li></ol>`,
      'View All Deals', '#7c3aed'),

    tpl('Weekend Picks', 'newsletter', '🍿 Weekend Entertainment Picks!', '🍿 Your Weekend Entertainment Guide',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">The weekend is here! Make the most of it with these streaming picks. We've curated the best subscriptions for an amazing weekend binge!</p>`,
      'Get Your Weekend Plans', '#7c3aed'),

    tpl('Best Sellers', 'newsletter', '⭐ Our Best-Selling Plans This Month', '⭐ Best-Selling Subscriptions',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">These are our most popular subscriptions this month — loved by thousands of happy customers!</p>`,
      'Shop Best Sellers', '#f59e0b'),

    tpl('New Arrivals', 'newsletter', '🆕 New Plans Just Added to Our Catalog!', '🆕 New Arrivals — Just In!',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">We've added exciting new plans to our catalog! Check out the latest additions and be among the first to grab them.</p>`,
      'Explore New Plans', '#7c3aed'),

    tpl('Streaming Tips', 'newsletter', '💡 Tips to Get More from Your Subscriptions', '💡 Streaming Tips & Tricks',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Get the most out of your subscriptions with these tips:</p><ul style="color:#555;font-size:15px;line-height:1.7;margin:0 0 16px;padding-left:20px"><li>Download content for offline viewing</li><li>Enable HD/4K in video quality settings</li><li>Use multiple profiles for personalization</li><li>Enable data saver mode on mobile</li></ul>`,
      'Explore Plans', '#7c3aed'),

    tpl('Subscription Guide', 'newsletter', '📖 Complete Guide to OTT Subscriptions', '📖 Your OTT Subscription Guide',
      `<p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 12px">Not sure which subscription is right for you? We've put together a comprehensive guide to help you choose the perfect plan for your entertainment needs and budget.</p>`,
      'Read the Guide', '#7c3aed'),
  ];

  for (const t of T) {
    db.run(
      `INSERT INTO email_templates (name, category, subject, html, is_system) VALUES (?,?,?,?,?)`,
      [t.name, t.category, t.subject, t.html, 1]
    );
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

// ─── Seed autopost campaigns ──────────────────────────────────────────────────
function seedAutopostCampaigns(db) {
  const existing = db.exec('SELECT COUNT(*) as c FROM autopost_campaigns');
  const count = existing[0]?.values[0][0] || 0;
  if (count > 0) return; // only seed on a fresh install

  const campaigns = [
    // ── Welcome / Engagement ────────────────────────────────────────────────
    {
      title: '🎉 Welcome to {{site_name}}',
      subject: 'Welcome to {{site_name}} — Your OTT Subscription Store!',
      message: `Hi {{name}},

Welcome to *{{site_name}}*! 🎉

We offer premium OTT subscriptions — Netflix, Amazon Prime, Disney+ Hotstar, Spotify, YouTube Premium and more — at the *best prices* with instant delivery.

💳 Easy UPI / WhatsApp payment
🚀 Instant auto-delivery
🔒 100% safe & trusted

Browse our plans and start streaming today!

👉 {{site_url}}`,
      interval_hours: 0,
      schedule_enabled: 0,
      target: 'all',
    },

    // ── Netflix ─────────────────────────────────────────────────────────────
    {
      title: '🎬 Netflix Premium — Best Price in India',
      subject: '🎬 Netflix Premium 4K at ₹149/mo — Limited Stock!',
      message: `Hi {{name}},

*Netflix Premium* (4K UHD) is now available at the *lowest price* — only from {{site_name}}! 🎬

✅ 4K Ultra HD + HDR
✅ 4 screens simultaneously
✅ All original content unlocked
✅ Instant delivery after payment

🔥 Price: Starting ₹149/month
⚡ Stock is limited — grab yours before it's gone!

Order now → {{site_url}}`,
      interval_hours: 72,
      schedule_enabled: 1,
      target: 'all',
    },

    // ── Amazon Prime ────────────────────────────────────────────────────────
    {
      title: '📦 Amazon Prime — Streaming + Free Delivery',
      subject: '📦 Amazon Prime at Just ₹89/mo — Prime Video + Free Delivery!',
      message: `Hi {{name}},

Get *Amazon Prime* at a fraction of the official price! 💥

🎬 Prime Video — movies, web series, Amazon Originals
🚀 Free & fast delivery on Amazon shopping
🎵 Prime Music — millions of songs ad-free
📖 Prime Reading — thousands of e-books

✅ Instant delivery | ✅ 1 month / 3 month / 1 year plans

💸 Starting just ₹89/month only at {{site_name}}

Order here → {{site_url}}`,
      interval_hours: 72,
      schedule_enabled: 1,
      target: 'all',
    },

    // ── Disney+ Hotstar ─────────────────────────────────────────────────────
    {
      title: '⭐ Disney+ Hotstar Super — IPL + Movies',
      subject: '⭐ Disney+ Hotstar at ₹59/mo — Watch IPL Live + Disney Shows!',
      message: `Hi {{name}},

🏏 IPL season is here — don't miss a single ball!

Get *Disney+ Hotstar Super* at unbeatable prices:

🏏 Live Cricket — IPL, ICC, T20 World Cup
🎬 Marvel, Star Wars, Pixar movies
📺 Star & FX TV shows + Hotstar Specials
🌐 Available on TV, mobile, tablet & web

⚡ Starting ₹59/month | Instant activation

Grab it now → {{site_url}}`,
      interval_hours: 96,
      schedule_enabled: 1,
      target: 'all',
    },

    // ── Spotify ─────────────────────────────────────────────────────────────
    {
      title: '🎵 Spotify Premium — Music Without Limits',
      subject: '🎵 Spotify Premium — Ad-free Music at ₹39/mo!',
      message: `Hi {{name}},

Tired of ads interrupting your music? 🎵

Get *Spotify Premium* at the best price:

🎵 80 million+ songs & podcasts ad-free
📥 Download for offline listening
🔊 High-quality audio streaming
🔀 Unlimited skips

💸 Only ₹39/month at {{site_name}} — 70% cheaper than official!

Listen without limits → {{site_url}}`,
      interval_hours: 96,
      schedule_enabled: 1,
      target: 'all',
    },

    // ── YouTube Premium ──────────────────────────────────────────────────────
    {
      title: '📺 YouTube Premium — No Ads + YouTube Music',
      subject: '📺 YouTube Premium — Watch ad-free at ₹59/mo!',
      message: `Hi {{name}},

Say goodbye to YouTube ads forever! 🚫📢

*YouTube Premium* includes:
📺 Ad-free YouTube on all devices
📥 Download videos for offline viewing
🎵 YouTube Music Premium included FREE
📱 Picture-in-picture on mobile
🎮 Background play while using other apps

💸 Starting just ₹59/month at {{site_name}}!

Order today → {{site_url}}`,
      interval_hours: 96,
      schedule_enabled: 1,
      target: 'all',
    },

    // ── Combo Bundle ────────────────────────────────────────────────────────
    {
      title: '🔥 MEGA BUNDLE — Netflix + Prime + Hotstar',
      subject: '🔥 MEGA BUNDLE: Netflix + Prime + Hotstar = Save ₹300+!',
      message: `Hi {{name}},

Why pay full price for one when you can get *three* for less? 💥

🎬 *MEGA OTT BUNDLE* — Our Best Deal Ever:
✅ Netflix Premium (4K)
✅ Amazon Prime Video
✅ Disney+ Hotstar Super

💸 Bundle price: Starting ₹299/month
🔥 You save ₹300+ vs buying individually!

Limited slots available every month — these go fast!

Grab the bundle → {{site_url}}`,
      interval_hours: 48,
      schedule_enabled: 1,
      target: 'all',
    },

    // ── Flash Sale ──────────────────────────────────────────────────────────
    {
      title: '⚡ FLASH SALE — 30% Off All Plans',
      subject: '⚡ FLASH SALE: 30% Off TODAY ONLY — OTT Subscriptions!',
      message: `Hi {{name}},

⚡ *FLASH SALE* — 30% Off all plans for 24 hours only!

This is the biggest discount we've ever offered:

🎬 Netflix Premium — 30% off
📦 Amazon Prime — 30% off
⭐ Disney+ Hotstar — 30% off
🎵 Spotify — 30% off
📺 YouTube Premium — 30% off
🔥 All bundle plans — 30% off

⏰ *ENDS MIDNIGHT TONIGHT*

Don't miss this → {{site_url}}`,
      interval_hours: 168,
      schedule_enabled: 0,
      target: 'all',
    },

    // ── Weekend Offer ───────────────────────────────────────────────────────
    {
      title: '🎉 Weekend Special — Extra 20% Off',
      subject: '🎉 Weekend Only: Extra 20% Off OTT Plans!',
      message: `Hi {{name}},

Happy weekend! 🎉 Enjoy *20% extra off* all OTT subscriptions this Saturday & Sunday only!

🎬 Netflix | 📦 Amazon Prime | ⭐ Hotstar
🎵 Spotify | 📺 YouTube | 🎭 Zee5 | ☁️ SonyLIV

Weekend discounts are applied automatically at checkout — no coupon needed!

Shop the weekend deals → {{site_url}}`,
      interval_hours: 168,
      schedule_enabled: 1,
      target: 'all',
    },

    // ── Renewal Reminder ────────────────────────────────────────────────────
    {
      title: '🔔 Renewal Reminder — Your Subscription Ending Soon',
      subject: '🔔 Renewal Reminder: Don\'t Let Your Subscription Expire!',
      message: `Hi {{name}},

Just a friendly reminder — your OTT subscription may be expiring soon! 🔔

Renew early and enjoy:
✅ No interruption to your streaming
✅ Same low price guaranteed
✅ Instant reactivation

We're offering *10% off renewals* this week as a loyalty bonus for existing customers!

Renew here → {{site_url}}`,
      interval_hours: 120,
      schedule_enabled: 1,
      target: 'active',
    },

    // ── Re-engagement ────────────────────────────────────────────────────────
    {
      title: '💌 We Miss You — Come Back Offer',
      subject: '💌 We miss you! Here\'s a special offer just for you',
      message: `Hi {{name}},

It's been a while since we heard from you — and we miss you! 😊

We've been busy adding amazing new plans and lowering our prices. Here's what's new:

🆕 New 3-month & 6-month bundle plans
💸 Prices reduced on all plans by 10-15%
⚡ Faster auto-delivery system
🎁 Refer a friend — earn ₹50 wallet credit

Come back and use code *COMEBACK10* for an extra 10% off your next order!

See what's new → {{site_url}}`,
      interval_hours: 240,
      schedule_enabled: 1,
      target: 'all',
    },

    // ── Referral ─────────────────────────────────────────────────────────────
    {
      title: '🤝 Refer & Earn ₹100 — Share with Friends',
      subject: '🤝 Earn ₹100 for every friend you refer to {{site_name}}!',
      message: `Hi {{name}},

Did you know you can *earn money* just by telling your friends about us? 💰

*{{site_name}} Referral Program:*
💸 You earn ₹100 wallet credit per referral
💸 Your friend gets ₹50 off their first order
🔄 No limit — refer as many as you want!

Share your referral link from the *My Account* section and start earning today.

Your referrals pay for your next subscription! 🎉

Start earning → {{site_url}}`,
      interval_hours: 168,
      schedule_enabled: 1,
      target: 'all',
    },

    // ── Seasonal / Republic Day ──────────────────────────────────────────────
    {
      title: '🇮🇳 Republic Day Sale — 26% Off!',
      subject: '🇮🇳 Happy Republic Day! 26% Off All Plans — Today Only!',
      message: `Hi {{name}},

🇮🇳 *Happy Republic Day!* Celebrating with our biggest offer of the month:

*26% OFF* all OTT subscriptions — because 26th January! 🎉

🎬 Netflix | 📦 Prime | ⭐ Hotstar | 🎵 Spotify

Discount applied automatically — no code needed.
Valid 26th January only.

Celebrate with entertainment → {{site_url}}`,
      interval_hours: 0,
      schedule_enabled: 0,
      target: 'all',
    },

    // ── New Plans / Stock Alert ──────────────────────────────────────────────
    {
      title: '🆕 New Plans Added — Check Them Out!',
      subject: '🆕 New OTT Plans Just Added at {{site_name}}!',
      message: `Hi {{name}},

We've just added exciting new plans to our catalog! 🆕

🔥 *What's new:*
✅ 6-month plans now available (save more!)
✅ Zee5 Premium just added
✅ Apple TV+ plans now in stock
✅ New budget combo plans starting ₹199

These new plans are already selling fast — check them out before stock runs out!

See new plans → {{site_url}}`,
      interval_hours: 168,
      schedule_enabled: 0,
      target: 'all',
    },
  ];

  for (const c of campaigns) {
    try {
      db.run(`INSERT OR IGNORE INTO autopost_campaigns (title,subject,message,target,schedule_enabled,interval_hours,active) VALUES (?,?,?,?,?,?,1)`,
        [c.title, c.subject, c.message, c.target, c.schedule_enabled ? 1 : 0, c.interval_hours]);
    } catch {}
  }
}

function seedWaOffers(db) {
  const existing = db.exec('SELECT COUNT(*) FROM wa_offers');
  if ((existing[0]?.values[0][0] || 0) > 0) return;

  const offers = [
`🛒 *AMAZON PRIME MEMBERSHIP – 1 MONTH*

🔐 *Private Account (ID + Password)*
Perfect for *Amazon Shopping* — enjoy Summer Sale benefits 🔥

😅 *MRP:* ₹299/month
➡️ *OFFER PRICE:* ₹70/month

━━━━━━━━━━━━━━━

🔥 *BENEFITS:*
💠 FREE 1-Day Delivery 🚚
💠 Prime Early Access ⏳
💠 Prime Exclusive Deals 💸
💠 Prime Video 🎬
💠 Prime Music 🎵
💠 Prime Reading 📚

━━━━━━━━━━━━━━━

⚡ *Limited Offer – Grab Fast!*
📩 *DM to Order Now*

*Buy Other Products : ott24x7.com (Costumer)*
*Create Your Store : store.watshop.in (Seller)*

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
*Create Your SMM Panel : smm.watshop.in (Seller)*`,

`🎨 *Adobe Creative Cloud – 3 Months*

🔐 Official License | Personal Plan
📧 Account with Mail Access (Outlook)

✨ *Includes:*
* 20+ Adobe Apps (Photoshop, Premiere Pro, Illustrator & more)
* 🚀 Firefly AI + 10,000 AI Credits/month
* ☁️ 85GB Cloud Storage
* 📱💻 Works on 2 Devices (All Platforms)
* 🏢 Commercial Use Supported

❌ *Retail:* ₹5,999
✅ *Offer Price:* ₹999

⏰ *Limited-Time Deal*
📩 *DM to Order*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`📺 *ZEE5 Premium HD – 1 Year*

🔥 *Limited-Time Offer*

💰 *Only ₹399*
❌ MRP ~₹999~

✨ *Includes:*
• HD 1080p Streaming
• 12 Months Access
• 2 Devices (With Ads)
• Activation on Your Own Number

🎬 Movies, Web Series & Originals
⚡ Instant Activation

📩 *DM to Activate Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`✨ *PRIME VIDEO – ADS FREE (6 MONTHS)*

💎 *Only ₹249*
🚫 Enjoy *Ad-Free Streaming*

━━━━━━━━━━━━━━━

📺 *Account Details:*
✅ Private Account (ID + Password)
✅ Mail Access Provided
✅ Use on 3 Devices (1 TV + 2 Others)

━━━━━━━━━━━━━━━

🎬 *What You Get:*
• No Ads Experience
• HD & 4K Quality
• Unlimited Movies & Series
• Smooth Multi-Device Access

━━━━━━━━━━━━━━━

📌 *Important:*
• Only for *Prime Video Watching*
• ❌ No Shopping or Other Prime Benefits

━━━━━━━━━━━━━━━

⚡ Instant Delivery
🔥 Limited Offer

📩 *DM to Order Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`✨ *QuillBot Premium – 6 Months*

🔐 Shared Account (1 Device)
💰 *Price:* ₹399

━━━━━━━━━━━━━━━

📧 Login Details Provided (Email + Password)

✨ *Features:*
• Unlimited Paraphrasing
• Grammar Checker
• Summarizer & Rewriter
• Faster & Advanced Modes

━━━━━━━━━━━━━━━

⚡ Easy Access | Limited Stock

📩 *DM to Buy Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🎬 *SONYLIV Premium HD Plan*

❌ *MRP:* ₹1499/year

━━━━━━━━━━━━━━━

💥 *Best Offer Prices:*
✅ 6 Months – ₹250
✅ 12 Months – ₹450
✅ 24 Months – ₹750

━━━━━━━━━━━━━━━

📱 2 Devices | 5 Profiles
🎟️ Redeem Code
📞 Activation on Your Mobile Number

✨ *Features:*
• Full HD 1080p Streaming
• Live Sports & Tournaments
• Movies, Originals & Regional Content
• Works on All Devices
• Offline Download Support

━━━━━━━━━━━━━━━

⚡ Instant Activation
🔥 Limited Slots

📩 *DM to Activate Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🎨 *PicsArt Pro – 1 Year*

💰 *Offer Price:* ₹550
🎟️ Redeem Code | Activate on Your Own Account

━━━━━━━━━━━━━━━

✨ *Features:*
• Unlimited Premium Templates
• AI Tools (BG Remover, Enhance, etc.)
• Pro Stickers & Fonts
• Advanced Photo & Video Editing
• No Watermark

📱 Works on Android, iOS & Web

━━━━━━━━━━━━━━━

⚡ Instant Delivery | Limited Offer

📩 *DM to Activate Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`💼 *LinkedIn Premium – Career Plan*

⏳ *3 Months Trial Offer*
💰 *Only ₹299*

🔗 Activated via Redeem Link
👤 Works on Your Existing LinkedIn Account

━━━━━━━━━━━━━━━

🚀 *Features:*
• See Who Viewed Your Profile
• InMail Credits (Message Recruiters)
• Unlimited Profile Views
• Job Insights & Salary Data
• Applicant Comparison
• LinkedIn Learning Access

━━━━━━━━━━━━━━━

⚡ *Activation Steps:*

1. Open the redeem link
2. Login to your LinkedIn account
3. Click *Activate Offer*
4. Proceed to checkout

━━━━━━━━━━━━━━━

💳 *Important:*
• Add Card or UPI for activation
• ₹1080 mandate may show (for verification)
• Only ₹2 will be charged now

⚠️ *Note:*
• Cancel auto-pay before trial ends to avoid full charge

━━━━━━━━━━━━━━━

⚡ Instant Activation | Limited Slots

📩 *DM to Activate Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🎨 *Beautiful.ai Pro EDU – 1 Year*

💰 *Price:* ₹499

🔐 Login Details Provided (ID + Password)
🎓 EDU Plan (Student Version)

━━━━━━━━━━━━━━━

✨ *EDU Features:*
• AI-Powered Presentation Maker
• Smart Templates & Auto Design
• Professional Slides in Minutes
• Charts, Animations & Visual Tools
• Easy Editing & Export Options

━━━━━━━━━━━━━━━

📌 *Note:*
• EDU Plan (Not Official Professional Plan)
• 1 Year Warranty Included

━━━━━━━━━━━━━━━

⚡ Instant Delivery | Limited Offer

📩 *DM to Order Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🎨 *NoteGPT Pro EDU – 1 Month*

💰 *Price:* ₹49

🔐 Login Details Provided (ID + Password)
🎓 EDU Plan (Student Version)

━━━━━━━━━━━━━━━

✨ *Features:*
• AI Notes & Summarization
• Smart Study & Research Tools
• Content Writing Assistance
• Fast & Easy Note Generation

━━━━━━━━━━━━━━━

📌 *Note:*
• EDU Plan (Student Version)
• Best for Learning & Productivity

━━━━━━━━━━━━━━━

⚡ Instant Delivery | Limited Offer

📩 *DM to Order Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🎨 *iAsk AI Pro EDU – 1 Year*

💰 *Price:* ₹499

🔐 Login Details Provided (ID + Password)
🎓 EDU Plan (Student Version)

━━━━━━━━━━━━━━━

✨ *Features:*
• AI-Powered Answers & Research
• Fast Search with Accurate Results
• Study & Homework Assistance
• Smart Writing & Explanation Tools

━━━━━━━━━━━━━━━

📌 *Note:*
• EDU Plan (Student Version)
• Best for Students & Daily Use

━━━━━━━━━━━━━━━

⚡ Instant Delivery | Limited Offer

📩 *DM to Order Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🌟 *InVideo Unlimited Studio Plan – 1 Year*

🚫 *Not AI Plan* (Studio Plan Only)

💰 *Price:* ₹1299

🔐 Private Account on Your Email

━━━━━━━━━━━━━━━

✨ *Plan Details:*
• Unlimited Video Editing Access
• Premium Features (Non-AI)
• Works on Your Own Account
• Renewable Next Year

━━━━━━━━━━━━━━━

✅ *Why Choose This:*
• Low Cost
• 100% Private Account
• Genuine Access
• Same Price Renewal

━━━━━━━━━━━━━━━

🚫 *Not AI Plan* (Studio Plan Only)

🚫 *Important Rules:*
• Don't connect social media accounts
• Don't change team settings/presets
• Don't upload logo in team presets
• iStock clips not included

⚠️ Rule violation = access removal without warning

━━━━━━━━━━━━━━━

🛒 *DM to Order Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🚀 *Google Drive 100GB – 6 Months*

💰 *Price:* ₹299

🎟️ Activated via Voucher Code
🔓 Works on Existing Google Accounts

━━━━━━━━━━━━━━━

✨ *Features:*
• 100GB Cloud Storage
• Works with Drive, Gmail & Photos
• Store Photos, Videos & Files
• Secure & Reliable Storage
• Easy Redemption

━━━━━━━━━━━━━━━

⚡ Instant Delivery | Limited Stock

📩 *DM to Buy Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🔐 *NordVPN Voucher Plan*

🌍 Secure & Private Internet Access

🎟️ Redeem Code Activation
📧 Use on Your Own Email
📱 Works on up to 10 Devices

━━━━━━━━━━━━━━━

⏳ *Plans & Pricing:*
👉 3 Months – ₹499
👉 6 Months – ₹899

━━━━━━━━━━━━━━━

🚀 *Features:*
• High-Speed Global Servers
• No-Logs Policy (Privacy Protected)
• Works on Wi-Fi, Mobile & PC
• Hide IP Address
• Bypass Geo Restrictions
• Supports Android, iOS, Windows & Mac

━━━━━━━━━━━━━━━

⚡ Instant Delivery | Easy Setup

📩 *DM to Activate Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🎨 *CANVA EDU PRO – SPECIAL OFFER*

Upgrade your design game with *Canva Education Pro* 🚀
Perfect for creators, marketers, students & resellers

━━━━━━━━━━━━━━━

👨‍🎓 *Canva Edu Pro (Student Access)*
📩 Invite on Your Email
⏳ Long-Term Access

💰 *Price:* ₹199

✔️ Access to most Canva Pro features
✔️ Best for personal design use
❌ Brand Kit not included
🛡️ 1 Year Warranty

━━━━━━━━━━━━━━━

🏫 *Canva Edu Pro (Staff Access)*
📩 Invite on Your Email
👥 Add up to 10 Team Members

💰 *Price:* ₹499

✔️ Access to most Canva Pro features
✔️ Brand Kit available
🛡️ 1 Year Warranty

━━━━━━━━━━━━━━━

🎁 *BONUS:*
📂 80,000+ Premium Canva Templates
🔗 Google Drive Download Included

Perfect for:
• Instagram Posts & Reels Covers
• Business & Marketing Designs

━━━━━━━━━━━━━━━

⚡ Instant Activation
🛡️ Trusted Supplier

📩 *DM to Order Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🎧 *Apple Music Plus – 6 Months*

💰 *Only ₹299*

🎟️ Redeem Code Activation
👤 Works on Your Apple ID

━━━━━━━━━━━━━━━

🚀 *Features:*
• Ad-Free Music
• Unlimited Downloads
• Lossless & High-Quality Audio
• Offline Listening
• Millions of Songs & Playlists

📱 Works on iPhone, iPad, Mac, Android & Web

━━━━━━━━━━━━━━━

⚡ Instant Activation | Limited Offer

📩 *DM to Activate Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🎬 *Apple TV+ Subscription Voucher*

💰 *Special Discount Offer*

━━━━━━━━━━━━━━━

📦 *Plans & Pricing:*
• 6 Months – ₹399
• 1 Year – ₹550

🔥 *Flat 70% OFF – Limited Time*

━━━━━━━━━━━━━━━

📺 *Features:*
• Watch Apple Original Movies & Shows
• 100% Ad-Free Streaming
• Access Anytime, Anywhere

📱 Works on iPhone, iPad, Mac & Apple TV

━━━━━━━━━━━━━━━

🌎 *Availability:*
🇮🇳 Works on Indian Apple IDs

━━━━━━━━━━━━━━━

⚡ Instant Activation

📩 *DM to Order Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🎓 *Coursera Org Plan – Premium Learning Access* 🚀

📧 Activated on Your Own Email
🏅 Certificates on Your Name
📚 Access to Almost All Courses

━━━━━━━━━━━━━━━

💰 *Plans & Pricing:*
✅ 3 Months – ₹700
✅ 6 Months – ₹1500
✅ 1 Year – ₹2400

━━━━━━━━━━━━━━━

💼 *Best For:*
Students | Job Seekers | Professionals | Skill Upgrade

━━━━━━━━━━━━━━━

⚠️ *Important Note:*
This is a *3rd-Party Sponsored Coursera Plus Organizational Plan* — not an official individual Coursera Plus subscription.

Validity may not show fixed expiry and access may continue longer depending on organization access.

━━━━━━━━━━━━━━━

⚡ Instant Activation

📩 *DM to Activate Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🌐 *Office 2024 Offers*

Get genuine Office activation for your PC/Mac with warranty included ✅

━━━━━━━━━━━━━━━

💼 *Office 2024 Pro Plus LTSC*
🖥️ *For:* 1 PC
🔑 *Type:* PH Key
💰 *Offer Cost:* $12 / ₹999
✅ Warranty Included

📌 *Features:*
• Word, Excel, PowerPoint, Outlook
• One-time activation
• Best for Windows PC
• Suitable for office, business & personal work

━━━━━━━━━━━━━━━

💼 *Office 2024 Home & Business*
🖥️ *For:* 1 PC / Mac
🔗 *Type:* BIND License
💰 *Offer Cost:* $59.80 / ₹5499
✅ Warranty Included

📌 *Features:*
• Word, Excel, PowerPoint, Outlook
• Binds with account/device as per activation process
• Supports PC & Mac
• Best for business, professional & daily use

━━━━━━━━━━━━━━━

⚡ Limited Stock Available
📩 *DM / WhatsApp to Order Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🌐 *MS Office 2021 License Offers*

Premium Office activation available for PC & Mac ✅

━━━━━━━━━━━━━━━

💼 *Office 2021 Home & Business*
🍎 *For:* 1 Mac
🔗 *Type:* BIND License
💰 *Price:* $14.50 / Rs.1399

📌 *Features:*
✅ Word, Excel, PowerPoint
✅ Outlook Included
✅ Best for Mac users
✅ One-time activation

━━━━━━━━━━━━━━━

💼 *Office 2021 Pro Plus*
🖥️ *For:* 1 PC
🔗 *Type:* BIND License
💰 *Price:* $25.50 / Rs.2499

📌 *Features:*
✅ Word, Excel, PowerPoint
✅ Outlook, Access & Publisher
✅ Best for business & office work
✅ One-time activation

━━━━━━━━━━━━━━━

💼 *Office 2021 Pro Plus*
🖥️ *For:* 5 PC
🌐 *Type:* Retail Online
💰 *Price:* $15.40/ Rs.1499

📌 *Features:*
✅ Activate on up to 5 PCs
✅ Word, Excel, PowerPoint
✅ Outlook, Access & Publisher
✅ Online retail activation

━━━━━━━━━━━━━━━

💼 *Office 2021 Pro Plus*
🖥️ *For:* 1 PC
📞 *Type:* Activate by Phone
💰 *Price:* $2.70/ Rs.299

📌 *Features:*
✅ Budget Office activation
✅ Word, Excel, PowerPoint
✅ Outlook, Access & Publisher
✅ Phone activation process

━━━━━━━━━━━━━━━

💼 *Office 2021 Home & Student*
🖥️ *For:* 1 PC
🔗 *Type:* BIND License
💰 *Price:* $15.50 / Rs.1499

📌 *Features:*
✅ Word, Excel, PowerPoint
✅ Best for students & personal use
✅ Simple one-time activation
❌ Outlook not included

━━━━━━━━━━━━━━━

⚡ Limited Stock Available
📩 *DM / WhatsApp to Order Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🔥 GEMINI AI PRO VEO3 +  1TB    STORAGE 🔥
🅰️
Get powerful AI tools with huge cloud storage in one plan 🚀

💰OFFER Price - 700 rs With Warranty

✅ 12 Month Invite From Fam
✅ Instant Activation
✅ 1000 AI Credits Every Month
✅ 1TB Cloud Storage Included
✅ Family Sharing 1 Invite

🎯 Best for:
* Creators
* Developers
* Students
* Professionals

💰OFFER Price - 700 rs With Warranty

⚡️ Instant Setup
🔐 Secure Access
📩 DM Now for Price

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`*🎬 CAPCUT PRO PLAN 🎬*

*✨ 6 Months Premium Access*
*💰 Offer Price – ₹1800* (limited time)

*📧 Activated on Your New Email ID*
🎟️ Direct Premium Access

*🚀 Pro Features Included:*
✅ All Pro Templates & Effects
✅ No Watermark on Videos
✅ Premium Transitions, Filters & Fonts
✅ 4K / HD Export Support
✅ Advanced Video Editing Tools
*✅ Works on Mobile & PC*

*⚡ Instant Activation | Limited-Time Offer*

📩 DM / WhatsApp to Buy Now

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🔥 *GEMINI AI PRO VEO3 +   5TB    STORAGE* 🔥
🅰️
Get powerful AI tools with huge cloud storage in one plan 🚀

💰OFFER Price - 2200 rs With Warranty

✅ 18 Month Voucher
✅ Redeem Key Activation
✅ 1000 AI Credits Every Month
✅ 5TB Cloud Storage Included
✅ Family Sharing Supported

🎯 Best for:
* Creators
* Developers
* Students
* Professionals

💰OFFER Price - *2200 rs With Warranty*

⚡️ *Instant Setup*
🔐 Secure Access

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`*Notion Plus 1 Year Plan for Education* 📚

* *Unlimited Pages and Blocks*: 📝 Students can upload unlimited blocks and files to their workspace.

*~😅 MRP - ₹12,000~*

*➡️ MY PRICE -  ₹499/1 year- ✅*

🔹 *Validity:* 1 Year Full
🔹 *Working Worldwide*✅

*🛄Payment Mode 🛄*

*UPI , Paytm , PhonePe, Gpay (All Indian UPI)*

*✅Crypto - USDT on Chain or Binance*

*✅Credit Card Debit Card (2.5% Extra)*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🎨 *Adobe Acrobat Pro DC 2022 – Lifetime License (PC)* 🔥

💻 Get *Adobe Acrobat Pro DC 2022* with
✅ Serial Key
✅ Download Link
✅ Instant Delivery ⚡

💰 *Price: ₹1499 Only*

━━━━━━━━━━━━━━━

📌 *Features Included:*

✔️ Create, Edit & Convert PDF Files
✔️ PDF to Word / Excel / PowerPoint
✔️ Add Signatures & Password Protection 🔐
✔️ Merge, Organize & Manage Pages
✔️ Create & Edit Fillable Forms

━━━━━━━━━━━━━━━

📦 *What You Will Receive:*

✅ Serial Number
✅ Download Link
✅ Lifetime Access (One-Time Payment)
✅ Works Worldwide 🌍
✅ Windows PC Supported Only

⚠️ *Note:*
This is an older version and *cannot be redeemed on Adobe's official website.*

📩 Instant Delivery After Payment

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com(Costumer)*
Create Your SMM Panel : smm.watshop.in (Seller)`,

`🎞️ *SHEMAROOME YEARLY PLAN* 🎞️

🔥 *Only ₹299*
✅ Activated on Your Account
✅ 1 Year Premium Access
✅ Bollywood, Bhakti & Regional Content
❌ No Sharing / No Redeem Hassle

⚡ Direct Activation
📩 DM TO ORDER NOW`,

`*🔥 MEGA 26 OTT COMBO — 1 YEAR 🔥*
26 OTT Apps in 1 Single Pack! 🎬

✅ 26 Premium OTT Platforms
✅ Hotstar + ZEE5 + SonyLIV + Prime
✅ Aha + Hoichoi + Discovery+ & More
✅ Movies, Web Series, Sports, Kids
✅ All Languages — Hindi, English, Regional

*🎁 1 FULL YEAR Validity*
💰 Save up to 70% vs MRP
📱 Watch on Mobile, TV, Laptop
🛡 100% Official Plans
⚡ Activated in 5–15 minutes

*💸 Special Combo Price: ₹[View Link]*
(All 26 Apps in One Payment!)

*🛒 BUY NOW 👇*

*📞 WhatsApp Support 24x7*

*⚠️ IMPORTANT NOTE:*

Some of Platforms in  combo plans are accessed via the
📱 Play Box TV app

*Some Can Be Access through Direct Official App*

After delivery → Login in PlayBox with same number
*→ Go to "Plans" → Tap "Claim"*`,

`🚨 LITE 23 COMBO — STEAL DEAL 🚨

🎬 23 OTT APPS in 1 Pack!
🎁 1 Year Full Validity
💰 Just ₹299
⚡ Instant Activation

✅ Movies, Sports, Web Series
✅ All Languages Covered
✅ 100% Official Plans

🛒 Order Here 👇

━━━━━━━━━━━━━━━━━━

⚠️ IMPORTANT NOTE:
Some of Platforms in combo plans are accessed via the
📱 Play Box TV app
Popular Plans Access through Direct Official App

After delivery → Login in PlayBox with same number
→ Go to "Plans" → Tap "Claim"`,
  ];

  for (const text of offers) {
    try {
      db.run('INSERT INTO wa_offers (text, active) VALUES (?, ?)', [text, 0]);
    } catch {}
  }
}

// Slug generator shared by db.js backfill + admin-api.js create/update.
// Converts "Amazon Prime — 6M Ads Free" → "amazon-prime-6m-ads-free".
// Pass the `existingSet` (Set of known slugs) to get a unique suffix appended.
function makePlanSlug(text, existingSet) {
  let base = String(text || '')
    .toLowerCase()
    .replace(/[—–]/g, '-')           // em-dash / en-dash
    .replace(/[^\w\s-]/g, '')        // strip special chars (keep letters, digits, hyphens)
    .replace(/[\s_]+/g, '-')         // spaces/underscores → hyphens
    .replace(/-+/g, '-')             // collapse multiple hyphens
    .replace(/^-|-$/g, '')           // trim leading/trailing hyphens
    .slice(0, 90);
  if (!base) return '';
  if (!existingSet || !existingSet.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!existingSet.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

module.exports = { getDb, getSetting, setSetting, getSettingSync, setSettingSync, all, get, run, makePlanSlug };
