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

  seedDefaults(db);
  seedLegalPages(db);
  seedEmailTemplates(db);
  seedAutopostCampaigns(db);
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

module.exports = { getDb, getSetting, setSetting, getSettingSync, setSettingSync, all, get, run };
