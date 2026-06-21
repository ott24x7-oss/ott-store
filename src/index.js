'use strict';
const express = require('express');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const cfg = require('./config');
const { getDb, getSetting, getSettingSync, all, get } = require('./db');
const { apiLimiter } = require('./security');

// ── Crash guards ─────────────────────────────────────────────────────────────
// Keep the process (and the WhatsApp bot's in-progress QR pairing) alive through
// stray async errors. Without these, a single unhandled rejection — e.g. an
// express-rate-limit validation throwing under a misconfigured 'trust proxy' —
// exits Node, Railway restarts the container, and any WhatsApp pairing handshake
// is interrupted. That crash-restart loop is exactly what kept the bot from ever
// completing a link. Log loudly; never exit.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal-guard] unhandledRejection:', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal-guard] uncaughtException:', err && err.stack ? err.stack : err);
});

// Graceful shutdown — Railway sends SIGTERM to the OLD container when a new deploy
// goes live. Close the WhatsApp socket cleanly (WITHOUT logging out) and flush a
// final session backup, so the old instance stops fighting the new one for the
// WhatsApp connection — the connection-replaced churn that was logging the bot out
// on every deploy. Then exit.
let _shuttingDown = false;
function gracefulShutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[shutdown] ${signal} — closing WhatsApp socket cleanly (session preserved)`);
  try { const wa = require('./wa-bot'); if (wa.shutdownBot) wa.shutdownBot(); } catch (e) { console.warn('[shutdown] wa-bot:', e.message); }
  try { const db = require('./db'); if (db.flushDb) db.flushDb(); } catch (e) { console.warn('[shutdown] db flush:', e.message); }
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

const app = express();

// Cloudflare in front of Railway in front of the app = 2 trusted hops. We set
// the COUNT (2) rather than `true`: express-rate-limit v7 rejects a permissive
// `true` with a ValidationError (which was surfacing as an unhandled rejection
// and crash-looping the container). A fixed hop count resolves the real client
// IP for the per-IP limiters without tripping that validation.
app.set('trust proxy', 2);
// SEO: consolidate on the apex host — 301 redirect www.* -> non-www so indexing
// and link equity don't split across two hostnames (only touches www.* hosts;
// the apex and *.railway.app pass straight through).
app.use((req, res, next) => {
  const host = (req.headers.host || '').toLowerCase();
  if (host.startsWith('www.')) return res.redirect(301, `${req.protocol}://${host.slice(4)}${req.originalUrl}`);
  next();
});
app.use(compression());
// GA4: inject the gtag snippet into every server-rendered store page when a
// Measurement ID is configured (Admin -> SEO -> Google Analytics). Read live via
// getSettingSync, so saving the ID takes effect on the next request (no redeploy).
app.use((req, res, next) => {
  if (req.path.startsWith('/admin') || req.path.startsWith('/user/api')) return next();
  const _send = res.send.bind(res);
  res.send = (body) => {
    try {
      if (typeof body === 'string' && /text\/html/i.test(res.get('Content-Type') || '') && body.includes('</head>') && !body.includes('googletagmanager.com/gtag')) {
        const gaId = (getSettingSync('seo_ga_measurement_id') || '').trim();
        if (/^G-[A-Z0-9]{6,}$/i.test(gaId)) {
          body = body.replace('</head>', `<script async src="https://www.googletagmanager.com/gtag/js?id=${gaId}"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${gaId}');</script></head>`);
        }
      }
    } catch {}
    return _send(body);
  };
  next();
});

// Baseline security headers on every response. CSP is intentionally omitted —
// the storefront depends on inline scripts/handlers a strict policy would break;
// add a report-only CSP separately if you want to tighten further. HSTS is set
// only in production (the public edge is HTTPS via Cloudflare); no
// includeSubDomains/preload, to avoid affecting any non-HTTPS subdomain.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  // HSTS only on HTTPS requests. req.secure is true behind the Cloudflare/Railway
  // proxy (trust proxy is set), so this is keyed off the real protocol — not
  // NODE_ENV — and needs no environment variable to work.
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  next();
});
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));
app.use(cookieParser(cfg.sessionSecret));
const { ensureCsrfToken } = require('./security');
app.use(ensureCsrfToken);

// Static files. Admin + store HTML/JS/CSS must always reflect the latest deploy,
// so we send no-cache for them — otherwise admins see a stale UI for up to 4h
// after each push. Versioned assets (anything under /static/) can still be
// long-cached if added later.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, filePath) => {
    if (/[\\\/](admin|store)[\\\/].+\.(html|js|css)$/i.test(filePath) ||
        /[\\\/]public[\\\/][^\\\/]+\.html$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  },
}));
const uploadStaticOptions = {
  maxAge: '7d',
  immutable: true,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  },
};
app.use('/data/uploads', express.static(path.join(__dirname, '..', 'data', 'uploads'), uploadStaticOptions));
// Backward-compatible public route for older plan image URLs. New uploads use
// /data/uploads directly, but existing plan image_url values may still point at
// /admin/api/plan-image/*. Serve them before the API limiter so product images
// never consume API quota or get throttled during catalog page loads.
app.use('/admin/api/plan-image', express.static(path.join(__dirname, '..', 'data', 'uploads'), uploadStaticOptions));

// ─── CORS preflight for cross-origin import endpoint ─────────────────────────
app.options('/admin/api/wa-offers-batch-import', (req, res) => {
  res.set('Access-Control-Allow-Origin', 'https://store.watshop.in');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Import-Token');
  res.set('Access-Control-Allow-Methods', 'POST');
  res.status(204).end();
});

// ─── Guest payment recovery page (from the "complete your payment" email) ─────
// A guest opens /pay/<guest_token> to resume an abandoned UPI checkout: same
// unique amount, same static QR. The page polls the guest-poll endpoint so it
// auto-confirms the moment the IMAP worker matches the bank email.
app.get('/pay/:token', async (req, res) => {
  try {
    const db = await getDb();
    const token = String(req.params.token || '');
    const t = token ? get(db, `SELECT t.*, p.name AS plan_name, p.platform FROM topups t
      LEFT JOIN plans p ON p.id = t.plan_id
      WHERE t.guest_token=? AND t.purpose='order' AND t.method='upi_imap' LIMIT 1`, [token]) : null;
    const siteName = (await getSetting('site_name')) || 'OTT24x7';
    const page = (inner) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Complete your payment — ${esc(siteName)}</title><style>body{margin:0;background:#04060f;color:#f4f7ff;font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:1rem}.card{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:20px;max-width:380px;width:100%;padding:1.6rem;text-align:center}.amt{font-size:2.6rem;font-weight:900;color:#2b6fff;margin:.15rem 0;letter-spacing:-1px}.btn{display:block;background:linear-gradient(135deg,#2b6fff,#8d5cff);color:#fff;text-decoration:none;border-radius:12px;padding:.85rem;font-weight:800;margin:.7rem 0}.muted{color:#aab4cf;font-size:.83rem}code{background:rgba(255,255,255,.08);padding:.5rem;border-radius:8px;display:block;word-break:break-all;margin:.35rem 0;font-size:.82rem}</style></head><body><div class="card">${inner}</div></body></html>`;
    if (!t) return res.status(404).type('html').send(page(`<div style="font-size:2.2rem">🔗</div><h2 style="margin:.3rem 0">Link not found</h2><p class="muted">This payment link is invalid.</p><a class="btn" href="/plans">Browse plans</a>`));
    if (t.status !== 'pending') {
      const done = t.status === 'approved' || t.order_id;
      return res.type('html').send(page(`<div style="font-size:2.6rem">${done ? '✅' : '⌛'}</div><h2 style="margin:.3rem 0">${done ? 'Payment already received' : 'This link has expired'}</h2><p class="muted">${done ? 'Your order is on its way to your email.' : 'Please place a new order.'}</p><a class="btn" href="/plans">${done ? 'Order again' : 'Browse plans'}</a>`));
    }
    const upiId = ((await getSetting('upi_id')) || '').trim();
    const upiName = ((await getSetting('upi_name')) || siteName).replace(/[^a-zA-Z0-9 ]/g, '');
    const qrUrl = ((await getSetting('upi_qr_url')) || '').trim();
    const amt = t.unique_amount;
    const link = qrUrl
      ? `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(upiName || 'Store')}&cu=INR`
      : `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(upiName || 'Store')}&am=${Number(amt).toFixed(2)}&cu=INR`;
    res.type('html').send(page(`
<div style="font-weight:800;font-size:1.05rem">💳 Complete your payment</div>
<div class="muted" style="margin:.2rem 0 .7rem">${esc(t.platform || '')} ${esc(t.plan_name || '')}</div>
<div class="muted">Pay exactly</div>
<div class="amt">₹${amt}</div>
<div class="muted" style="margin-bottom:.6rem">(unique amount — do not round off)</div>
${qrUrl ? `<img src="${esc(qrUrl)}" alt="UPI QR" style="width:180px;height:180px;border-radius:12px;background:#fff;padding:6px;object-fit:contain" onerror="this.style.display='none'">` : ''}
<div class="muted" style="margin:.55rem 0 .1rem">UPI ID</div>
<code>${esc(upiId)}</code>
<a class="btn" href="${esc(link)}">📱 Open UPI App</a>
<div id="st" class="muted">⌛ Waiting for payment confirmation…</div>
<script>
(function(){var done=false;function poll(){if(done)return;fetch('/user/api/guest-checkout/poll/${t.id}?token=${encodeURIComponent(token)}').then(function(r){return r.json()}).then(function(j){if(!j)return;if(j.status==='paid'){done=true;document.getElementById('st').innerHTML='✅ Payment confirmed! Your credentials are being emailed to you.';}else if(j.status==='expired'||j.status==='rejected'){done=true;document.getElementById('st').innerHTML='⌛ This payment expired — please place a new order.';}}).catch(function(){})}setInterval(poll,5000);poll();})();
</script>`));
  } catch (e) { res.status(500).type('text/plain').send('error'); }
});

// ─── API routes ───────────────────────────────────────────────────────────────
app.use('/user/api', apiLimiter, require('./user-api'));
app.use('/admin/api', apiLimiter, require('./admin-api'));

// ─── PWA: dynamic manifest ────────────────────────────────────────────────────
app.get('/manifest.json', async (req, res) => {
  try {
    const [name, shortName, desc, themeColor, bgColor, vapidKey] = await Promise.all([
      getSetting('pwa_name'), getSetting('pwa_short_name'), getSetting('pwa_description'),
      getSetting('pwa_theme_color'), getSetting('pwa_bg_color'), getSetting('vapid_public_key'),
    ]);
    const siteName = await getSetting('site_name') || 'OTT Store';
    res.json({
      name: name || siteName,
      short_name: shortName || (name || siteName).slice(0, 12),
      description: desc || 'Buy OTT Subscriptions at Best Prices',
      start_url: '/',
      display: 'standalone',
      background_color: bgColor || '#0d1117',
      theme_color: themeColor || '#7c3aed',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ],
      ...(vapidKey ? { gcm_sender_id: undefined } : {}),
    });
  } catch { res.json({ name: 'OTT Store', start_url: '/', display: 'standalone' }); }
});

// ─── PWA: app icons (served from DB or placeholder) ──────────────────────────
const FALLBACK_ICON_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjE+ibYAAAAASUVORK5CYII=';
async function serveIcon(req, res) {
  try {
    const b64 = await getSetting('pwa_icon_b64');
    const buf = Buffer.from(b64 && b64.length > 100 ? b64 : FALLBACK_ICON_B64, 'base64');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(buf);
  } catch { res.status(404).end(); }
}
app.get('/icon-192.png', serveIcon);
app.get('/icon-512.png', serveIcon);

// ─── PWA: service worker ──────────────────────────────────────────────────────
// Cache the raw store HTML templates in memory — they're read on every page load
// but only change on deploy (a fresh container = fresh cache), so the per-request
// synchronous disk read is wasted work on the single-vCPU host. The cached string
// is still run through the per-request dynamic replacements by each route.
const _htmlCache = new Map();
function readStoreHtml(file) {
  let h = _htmlCache.get(file);
  if (h === undefined) { h = fs.readFileSync(path.join(__dirname, '..', 'public', 'store', file), 'utf8'); _htmlCache.set(file, h); }
  return h;
}

app.get('/sw.js', async (req, res) => {
  const vapidKey = await getSetting('vapid_public_key').catch(() => '');
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(`
const CACHE='ott-v7';
self.addEventListener('install',e=>{self.skipWaiting()});
self.addEventListener('activate',e=>{
  e.waitUntil((async()=>{
    const names=await caches.keys();
    await Promise.all(names.filter(n=>n!==CACHE).map(n=>caches.delete(n)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET')return;
  let url; try{url=new URL(req.url)}catch{return}
  // Same-origin pages/assets only — never intercept APIs, the admin, or the SW itself.
  if(url.origin!==self.location.origin)return;
  if(url.pathname.startsWith('/user/api')||url.pathname.startsWith('/admin')||url.pathname.includes('/api/')||url.pathname==='/sw.js')return;
  if(/\.(?:css|js|png|jpg|jpeg|gif|svg|webp|ico|woff2?)$/i.test(url.pathname)){
    // Static assets: stale-while-revalidate — serve instantly from cache, refresh in the background.
    e.respondWith((async()=>{
      const cache=await caches.open(CACHE);
      const cached=await cache.match(req);
      const network=fetch(req).then(res=>{if(res&&res.ok)cache.put(req,res.clone());return res}).catch(()=>null);
      return cached||(await network)||fetch(req).catch(()=>new Response('',{status:504}));
    })());
  }else{
    // Navigations/HTML: network-first with a 4s timeout, then fall back to the last cached
    // copy. The old no-timeout version was the "stuck loading until hard refresh" bug — a slow
    // cold-start would hang the page forever; now it times out and serves cache instead.
    e.respondWith((async()=>{
      const cache=await caches.open(CACHE);
      try{
        const res=await Promise.race([
          fetch(req),
          new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),4000))
        ]);
        if(res&&res.ok)cache.put(req,res.clone());
        return res;
      }catch(err){
        const cached=await cache.match(req);
        return cached||new Response('<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><body style="background:#05050b;color:#fff;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><p>Taking longer than usual…</p><button onclick="location.reload()" style="padding:.6rem 1.2rem;border-radius:10px;border:0;background:#2563eb;color:#fff;font-weight:700;cursor:pointer">Reload</button></div>',{status:503,headers:{'Content-Type':'text/html'}});
      }
    })());
  }
});
self.addEventListener('push',e=>{
  if(!e.data)return;
  let d={title:'OTT Store',body:'',icon:'/icon-192.png',url:'/'};
  try{d={...d,...e.data.json()}}catch{}
  e.waitUntil(self.registration.showNotification(d.title,{body:d.body,icon:d.icon,data:{url:d.url}}));
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const url=e.notification.data?.url||'/';
  e.waitUntil(clients.matchAll({type:'window'}).then(cs=>{
    const c=cs.find(x=>x.url===url&&'focus' in x);
    if(c)return c.focus();
    if(clients.openWindow)return clients.openWindow(url);
  }));
});
`);
});

// ─── SEO: robots.txt ─────────────────────────────────────────────────────────
// Hardened default — keeps crawl budget on real pages by blocking admin, the
// APIs, cart/checkout/account and raw JSON. Used when no custom robots_txt is
// set, and it also auto-upgrades the legacy wide-open value so existing installs
// benefit without an admin edit. A genuinely custom robots_txt is left untouched.
// Note: /my is NOT disallowed — it carries a noindex meta, and Google must be
// allowed to crawl it to see that tag and drop it from the index. Admin + APIs
// stay blocked (they have no crawl value).
const DEFAULT_ROBOTS = 'User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /admin/api\nDisallow: /user/api\nDisallow: /api\nDisallow: /checkout\nDisallow: /cart\nDisallow: /account\nDisallow: /*.json$';
app.get('/robots.txt', async (req, res) => {
  try {
    const base = ((await getSetting('base_url')) || cfg.baseUrl).replace(/\/$/, '');
    let txt = ((await getSetting('robots_txt')) || '').trim();
    if (!txt || /^user-agent:\s*\*\s+allow:\s*\/$/i.test(txt.replace(/\s+/g, ' ').trim())) {
      txt = DEFAULT_ROBOTS; // empty or the legacy fully-open value
    }
    if (!/^\s*sitemap:/im.test(txt)) txt += `\nSitemap: ${base}/sitemap.xml`;
    res.type('text/plain').send(txt);
  } catch { res.type('text/plain').send(DEFAULT_ROBOTS); }
});

// ─── GEO: llms.txt — a Markdown map of the store for AI crawlers ──────────────
// Note: this only helps AI engines that are actually allowed to crawl. If
// Cloudflare's managed robots.txt is blocking GPTBot/ClaudeBot/etc., unblock
// them in the Cloudflare dashboard for this to have any effect.
app.get('/llms.txt', async (req, res) => {
  try {
    const db = await getDb();
    const base = ((await getSetting('base_url')) || cfg.baseUrl).replace(/\/$/, '');
    const siteName = await getSetting('site_name') || 'OTT Store';
    const tagline = await getSetting('site_tagline') || '';
    const products = all(db, `SELECT slug, platform, name, price_inr FROM plans WHERE active=1 AND slug IS NOT NULL AND slug != '' ORDER BY platform ASC, price_inr ASC`).slice(0, 300);
    let txt = `# ${siteName}\n`;
    if (tagline) txt += `\n> ${tagline}\n`;
    txt += `\n${siteName} sells digital subscriptions and software (OTT/streaming, music, AI tools, cloud storage, productivity & software keys) with instant digital delivery and UPI/USDT checkout.\n`;
    txt += `\n## Key pages\n- [All plans](${base}/plans)\n- [Blog](${base}/blog)\n- [Contact / Support](${base}/contact)\n- [Refund policy](${base}/refund)\n`;
    txt += `\n## Products\n`;
    for (const p of products) {
      const plat = (p.platform && p.platform.toLowerCase() !== 'other') ? `${p.platform} — ` : '';
      txt += `- [${plat}${p.name} (₹${p.price_inr})](${base}/plans/${p.slug})\n`;
    }
    res.type('text/plain').send(txt);
  } catch { res.type('text/plain').send(''); }
});

// ─── SEO: sitemap.xml ─────────────────────────────────────────────────────────
app.get('/sitemap.xml', async (req, res) => {
  try {
    const db = await getDb();
    const baseUrl = (await getSetting('base_url') || cfg.baseUrl).replace(/\/$/, '');
    const posts = all(db, `SELECT slug, created_at FROM blog_posts WHERE published=1`);
    // Only "strong" pages go in the sitemap: skip products flagged noindex and
    // those with no unique description (thin content driving index bloat).
    const products = all(db, `SELECT slug, created_at FROM plans WHERE active=1 AND slug IS NOT NULL AND slug != '' AND COALESCE(noindex,0)=0 AND description IS NOT NULL AND TRIM(description) != ''`);
    const staticPages = ['/', '/plans', '/blog', '/about', '/contact', '/privacy', '/terms', '/refund'];
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;
    for (const p of staticPages) {
      xml += `\n  <url><loc>${baseUrl}${p}</loc><changefreq>weekly</changefreq></url>`;
    }
    // Product pages — the bulk of the catalog. Without these, Google can only
    // find products via JS-rendered links on /plans.
    for (const pr of products) {
      const lastmod = (pr.created_at || '').replace(' ', 'T').split('T')[0];
      xml += `\n  <url><loc>${baseUrl}/plans/${pr.slug}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}<changefreq>weekly</changefreq></url>`;
    }
    for (const post of posts) {
      const lastmod = (post.created_at || '').replace(' ', 'T').split('T')[0];
      xml += `\n  <url><loc>${baseUrl}/blog/${post.slug}</loc><lastmod>${lastmod}</lastmod><changefreq>monthly</changefreq></url>`;
    }
    xml += '\n</urlset>';
    res.type('application/xml').send(xml);
  } catch (e) { res.status(500).send('Error generating sitemap'); }
});

// ─── Active theme helper ─────────────────────────────────────────────────────
// Allowed list mirrors the 23 themes defined in public/store/themes.css and the
// admin Store Themes picker. Anything not in this list falls back to default
// so a malformed setting can never put pages into an undefined state.
const ALLOWED_THEMES = new Set([
  'midnight-purple','neon-dark','ocean-deep','cosmic','sunset-glow','forest-dark',
  'royal-gold','rose-noir','arctic-light','sakura','slate-minimal','cyberpunk',
  'aurora-teal','volcano','lavender-mist','navy-classic','emerald-city',
  'crystal-clean','obsidian-gold','electric-blue','crimson-tide','teal-ocean',
  'movieverse',
]);
async function getActiveTheme() {
  try {
    const t = await getSetting('store_theme');
    return (t && ALLOWED_THEMES.has(t)) ? t : 'midnight-purple';
  } catch { return 'midnight-purple'; }
}

// ─── Public storefront pages ──────────────────────────────────────────────────
app.get('/blog/:slug', async (req, res) => {
  try {
    const db = await getDb();
    const post = get(db, `SELECT * FROM blog_posts WHERE slug=? AND published=1`, [req.params.slug]);
    if (!post) return res.status(404).sendFile(path.join(__dirname, '..', 'public', 'store', '404.html'));
    const [siteName, ogImage, baseUrl, logos, storeTheme] = await Promise.all([
      getSetting('site_name'), getSetting('seo_og_image'), getSetting('base_url'), getLogoUrls(), getActiveTheme(),
    ]);
    res.send(buildBlogPostPage(post, siteName || 'OTT Store', post.og_image || ogImage || '', baseUrl || cfg.baseUrl, logos, storeTheme));
  } catch (e) { res.status(500).send('Server error'); }
});

app.get('/blog', async (req, res) => {
  try {
    const db = await getDb();
    const posts = all(db, `SELECT id,slug,title,meta_desc,created_at FROM blog_posts WHERE published=1 ORDER BY created_at DESC`);
    const [siteName, seoDesc, baseUrl, logos, storeTheme, seoTop, seoBottom] = await Promise.all([
      getSetting('site_name'), getSetting('seo_blog_desc'), getSetting('base_url'), getLogoUrls(), getActiveTheme(),
      getSetting('seo_blog_top'), getSetting('seo_blog_bottom'),
    ]);
    const stripScripts = (s) => String(s || '').replace(/<script[\s\S]*?<\/script>/gi, '');
    res.send(buildBlogIndexPage(posts, siteName || 'OTT Store', seoDesc || '', baseUrl || cfg.baseUrl, logos, storeTheme, stripScripts(seoTop), stripScripts(seoBottom)));
  } catch (e) { res.status(500).send('Server error'); }
});

// SPA routes → serve my.html for /my and every tab subpath. The page is still
// a single SPA, but each tab gets its own URL (so the address bar reads like
// "separate pages" — /my/orders, /my/plans, etc. — and back/forward navigation
// works). The server injects two things into the HTML: the active theme (for
// correct first-paint colors) and the requested tab name (so the SPA boots
// into the right view without a flash of the dashboard).
const MY_TABS = ['dashboard', 'plans', 'orders', 'referral', 'support', 'profile'];
async function serveMyHtml(req, res, tab) {
  try {
    const storeTheme = await getActiveTheme();
    let html = readStoreHtml('my.html');
    html = html.replace(
      /<html lang="en" data-theme="dark">/,
      `<html lang="en" data-theme="dark" data-store-theme="${storeTheme}" data-initial-tab="${tab}">`,
    );
    res.type('text/html').send(html);
  } catch {
    res.sendFile(path.join(__dirname, '..', 'public', 'store', 'my.html'));
  }
}
app.get('/my', (req, res) => serveMyHtml(req, res, 'dashboard'));
for (const t of MY_TABS) app.get(`/my/${t}`, (req, res) => serveMyHtml(req, res, t));

app.get('/admin', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html'));
});

// Public static pages — served from DB legal_pages table
const staticRoutes = { '/about': 'about', '/contact': 'contact', '/privacy': 'privacy', '/terms': 'terms', '/refund': 'refund' };
for (const [route, slug] of Object.entries(staticRoutes)) {
  app.get(route, async (req, res) => {
    try {
      const db = await getDb();
      const page = db ? (() => { const { get: dbGet } = require('./db'); return dbGet(db, `SELECT * FROM legal_pages WHERE slug=?`, [slug]); })() : null;
      const [siteName, logos, storeTheme] = await Promise.all([getSetting('site_name'), getLogoUrls(), getActiveTheme()]);
      const name = siteName || 'OTT Store';
      if (page) return res.send(buildLegalPage(page, name, logos, storeTheme));
      const filePath = path.join(__dirname, '..', 'public', 'store', `${slug}.html`);
      if (fs.existsSync(filePath)) return res.sendFile(filePath);
      res.send(buildSimplePage(slug, name, logos, storeTheme));
    } catch {
      res.send(buildSimplePage(slug, 'OTT Store', { light: '', dark: '' }, 'midnight-purple'));
    }
  });
}

// ─── /reseller — public "Become a Reseller" apply page ───────────────────────
app.get('/reseller', async (req, res) => {
  try {
    const [siteName, logos, storeTheme] = await Promise.all([getSetting('site_name'), getLogoUrls(), getActiveTheme()]);
    res.type('text/html').send(buildResellerPage(siteName || 'Virtual Market', logos, storeTheme));
  } catch { res.status(500).send('Server error'); }
});

// ─── /plans — product listing page (server-rendered so theme is correct on first paint) ──
// Trim to <=n chars on a word boundary, stripping trailing separators — keeps
// titles/descriptions from being cut mid-word in search results.
function clampLen(s, n) { s = String(s || '').trim(); if (s.length <= n) return s; const c = s.slice(0, n), i = c.lastIndexOf(' '); return (i > n * 0.6 ? c.slice(0, i) : c).replace(/[\s|&,–—.\-]+$/, '').trim(); }

app.get('/plans', async (req, res) => {
  try {
    const storeTheme = await getActiveTheme();
    const base = ((await getSetting('base_url')) || cfg.baseUrl).replace(/\/$/, '');
    const db = await getDb();
    const siteName = (await getSetting('site_name')) || 'OTT Store';
    const ogImg = (await getSetting('seo_og_image')) || `${base}/og-default.jpg`;
    const products = all(db, `SELECT slug, platform, name FROM plans WHERE active=1 AND slug IS NOT NULL AND slug != '' ORDER BY sort_order ASC, id ASC`);
    let html = readStoreHtml('plans.html');
    html = html.replace(/data-store-theme="[^"]*"/, `data-store-theme="${storeTheme}"`);
    const plansTitle = clampLen(`All Plans — ${siteName}`, 60);
    const plansDesc = clampLen(`Browse all ${siteName} subscription plans — OTT, AI tools, cloud & software. Instant digital delivery, UPI & crypto checkout, 24×7 support.`, 155);
    html = html
      .replace(/<title>[^<]*<\/title>/, `<title>${esc(plansTitle)}</title>`)
      .replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${esc(plansDesc)}">`);
    const headInject = [
      `<link rel="canonical" href="${esc(base)}/plans">`,
      `<meta property="og:title" content="${esc(plansTitle)}">`,
      `<meta property="og:description" content="${esc(plansDesc)}">`,
      `<meta property="og:type" content="website">`,
      `<meta property="og:url" content="${esc(base)}/plans">`,
      `<meta property="og:site_name" content="${esc(siteName)}">`,
      `<meta property="og:image" content="${esc(ogImg)}">`,
      `<meta name="twitter:card" content="summary_large_image">`,
      `<meta name="twitter:title" content="${esc(plansTitle)}">`,
      `<meta name="twitter:description" content="${esc(plansDesc)}">`,
      `<meta name="twitter:image" content="${esc(ogImg)}">`,
      buildPlansListJsonLd(products, base, siteName),
    ].join('\n');
    html = html.replace('</head>', headInject + '\n</head>');
    res.type('text/html').send(html);
  } catch {
    res.sendFile(path.join(__dirname, '..', 'public', 'store', 'plans.html'));
  }
});

// Product slug route — /plans/amazon-prime-6m-ads-free
// Looks up the plan by slug and renders the plans page pre-focused on that
// product. Uses a meta-refresh + hash so the SPA can scroll to the card.
app.get('/plans/:slug', async (req, res) => {
  try {
    const { getDb, get: dbGet } = require('./db');
    const db = await getDb();
    const slug = req.params.slug.toLowerCase().replace(/[^a-z0-9-]/g, '');
    const plan = dbGet(db, `SELECT * FROM plans WHERE slug=? AND active=1`, [slug]);
    const base = ((await getSetting('base_url')) || cfg.baseUrl).replace(/\/$/, '');
    const storeTheme = await getActiveTheme();
    let html = readStoreHtml('plans.html');
    html = html.replace(/data-store-theme="[^"]*"/, `data-store-theme="${storeTheme}"`);

    if (!plan) {
      // Slug not found — show the catalog, canonical to /plans so the dead URL
      // doesn't compete for indexing.
      html = html.replace('</head>', `<link rel="canonical" href="${esc(base)}/plans">\n</head>`);
      return res.status(404).type('text/html').send(html);
    }

    const siteName = (await getSetting('site_name')) || 'OTT Store';
    const url = `${base}/plans/${plan.slug}`;
    const platPrefix = (plan.platform && plan.platform.toLowerCase() !== 'other') ? `${plan.platform} — ` : '';
    const titleText = clampLen(`${platPrefix}${plan.name} | ${siteName}`, 60);
    const descText = clampLen(`Buy ${platPrefix}${plan.name} at ${siteName} — ₹${Number(plan.price_inr).toLocaleString('en-IN')}. ${plan.delivery_type === 'instant' ? 'Instant digital delivery.' : 'Fast digital delivery.'}`, 155);
    const ogImg = plan.image_url || (await getSetting('seo_og_image')) || `${base}/og-default.jpg`;
    const tgUrl = (await getSetting('telegram_bot_url')) || '';
    // Thin / flagged variant pages get noindex,follow so clusters of near-duplicate
    // keys don't dilute the domain. They're also excluded from the sitemap.
    const noindex = Number(plan.noindex) === 1 || !plan.description || plan.description.trim() === '';

    // Per-product <title> + <meta description> (C1/H3)
    html = html
      .replace(/<title>[^<]*<\/title>/, `<title>${esc(titleText)}</title>`)
      .replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${esc(descText)}">`);
    // Canonical + Open Graph + Product/Breadcrumb JSON-LD + deep-link globals (C2/C4/H1)
    const headInject = [
      noindex ? `<meta name="robots" content="noindex,follow">` : '',
      `<link rel="canonical" href="${esc(url)}">`,
      `<meta property="og:title" content="${esc(plan.name)}">`,
      `<meta property="og:type" content="product">`,
      `<meta property="og:url" content="${esc(url)}">`,
      ogImg ? `<meta property="og:image" content="${esc(ogImg)}">` : '',
      `<meta property="product:price:amount" content="${Number(plan.price_inr)}">`,
      `<meta property="product:price:currency" content="INR">`,
      buildProductJsonLd(plan, base, siteName),
      noindex ? '' : buildProductFaqJsonLd(plan, siteName, tgUrl),
      `<script>window.__PLAN_SLUG__="${esc(plan.slug)}";window.__PLAN_ID__=${plan.id};window.__HAS_PRODUCT_HERO__=1;</script>`,
    ].filter(Boolean).join('\n');
    html = html.replace('</head>', headInject + '\n</head>');
    // Inject the server-rendered product hero above the catalog and demote the
    // catalog's "Browse All Subscriptions" heading to H2 so the product name is
    // the page's single H1 (C1).
    html = html
      .replace('<h1>Browse All <span>Subscriptions</span></h1>', '<h2>Browse All <span>Subscriptions</span></h2>')
      .replace('<!-- Page Header -->', `${buildProductHero(plan, tgUrl, siteName)}\n<!-- Page Header -->`);
    res.type('text/html').send(html);
  } catch (e) {
    res.sendFile(path.join(__dirname, '..', 'public', 'store', 'plans.html'));
  }
});

// Storefront root — server-render meta tags for SEO crawlers.
// When store_theme === 'movieverse', serve the MovieVerse home variant instead
// of the default index.html so the cinematic skin renders globally.
app.get('/', async (req, res) => {
  try {
    const [siteName, seoTitle, seoDesc, seoKw, ogImg, gscCode, bingCode, twitterCard, baseUrl, storeTheme] = await Promise.all([
      getSetting('site_name'), getSetting('seo_home_title'), getSetting('seo_home_desc'),
      getSetting('seo_home_keywords'), getSetting('seo_og_image'), getSetting('seo_gsc_verification'),
      getSetting('seo_bing_verification'), getSetting('seo_twitter_card'), getSetting('base_url'),
      getActiveTheme(),
    ]);
    const name = siteName || 'OTT Store';
    const base = baseUrl || cfg.baseUrl;
    const ogImgFinal = ogImg || `${base}/og-default.jpg`;
    // MovieVerse gets its own bespoke home file (heavy cinema markup).
    // All other themes share index.html with a data-store-theme attr swap so
    // the same CSS palette cascade we use on /plans + /my applies to /, too.
    const homeFile = storeTheme === 'movieverse' ? 'movieverse-home.html' : 'index.html';
    let html = readStoreHtml(homeFile);
    // For the default index.html, swap the hardcoded data-store-theme attribute
    // to the current setting so the 22 non-MovieVerse themes also render.
    if (homeFile === 'index.html') {
      html = html.replace(/data-store-theme="[^"]*"/, `data-store-theme="${storeTheme}"`);
    }
    // SEO guardrail: keep the title <=60 and meta description <=155 chars, trimmed
    // on a word boundary (trailing separators stripped) so neither is truncated in
    // search results, whatever the admin SEO settings hold.
    const clampLen = (s, n) => { s = String(s || '').trim(); if (s.length <= n) return s; const c = s.slice(0, n), i = c.lastIndexOf(' '); return (i > n * 0.6 ? c.slice(0, i) : c).replace(/[\s|&,–—.\-]+$/, '').trim(); };
    // Guarantee the brand is in the title (recognition + CTR) even when the
    // admin's seo_home_title omits it — append " | <brand>" and keep it <=60.
    const titleBase = (seoTitle || 'Digital Products & Software — OTT, AI & Keys').trim();
    const brandSuffix = ` | ${name}`;
    const seoTitleFinal = (name && brandSuffix.length < 30 && !titleBase.toLowerCase().includes(name.toLowerCase()))
      ? clampLen(titleBase, 60 - brandSuffix.length) + brandSuffix
      : clampLen(titleBase, 60);
    // Lead with legitimate USPs; avoid grey "unlimited access / lowest price" claims.
    const seoDescFinal = clampLen(seoDesc || 'Genuine OTT, AI & software subscriptions in India. Instant activation, full-validity replacement warranty, UPI & crypto checkout, 24×7 support.', 155);
    html = html
      .replace(/<title id="page-title">[^<]*<\/title>/, `<title id="page-title">${esc(seoTitleFinal)}</title>`)
      .replace(/(<meta name="description" id="meta-desc" content=")[^"]*"/, `$1${esc(seoDescFinal)}"`)
      .replace(/(<meta id="meta-kw" name="keywords" content=")[^"]*"/, `$1${esc(seoKw || 'ott subscription, netflix, amazon prime, disney plus')}"`)
      .replace(/(<meta id="og-title" property="og:title" content=")[^"]*"/, `$1${esc(name)}"`)
      .replace(/(<meta id="og-img" property="og:image" content=")[^"]*"/, `$1${esc(ogImgFinal)}"`)
      .replace(/(<meta id="og-desc" property="og:description" content=")[^"]*"/, `$1${esc(seoDescFinal)}"`)
      .replace(/(<meta name="twitter:card" content=")[^"]*"/, `$1${esc(twitterCard || 'summary_large_image')}"`)
      .replace(/<script id="ld-org"[^>]*>[^<]*<\/script>/,
        `<script id="ld-org" type="application/ld+json">${JSON.stringify({
          '@context': 'https://schema.org',
          '@graph': [
            { '@type': 'Organization', '@id': base + '/#org', name, url: base, logo: ogImgFinal },
            { '@type': 'WebSite', '@id': base + '/#website', url: base, name, inLanguage: 'en', publisher: { '@id': base + '/#org' } },
            { '@type': 'OnlineStore', '@id': base + '/#store', name, url: base, parentOrganization: { '@id': base + '/#org' }, currenciesAccepted: 'INR', paymentAccepted: 'UPI, USDT' },
          ],
        })}</script>`);
    const inject = [
      `<link rel="canonical" href="${esc(base)}/">`,
      `<meta property="og:type" content="website">`,
      `<meta property="og:url" content="${esc(base)}/">`,
      `<meta property="og:site_name" content="${esc(name)}">`,
      `<meta name="twitter:title" content="${esc(seoTitleFinal)}">`,
      `<meta name="twitter:description" content="${esc(seoDescFinal)}">`,
      `<meta name="twitter:image" content="${esc(ogImgFinal)}">`,
      gscCode ? `<meta name="google-site-verification" content="${esc(metaToken(gscCode))}">` : '',
      bingCode ? `<meta name="msvalidate.01" content="${esc(metaToken(bingCode))}">` : '',
    ].filter(Boolean).join('\n');
    html = html.replace('</head>', inject + '\n</head>');
    // Server-render the home's dynamic bits so there's no flash of template
    // placeholders before the client /user/api/store fetch resolves.
    html = homeFile === 'movieverse-home.html'
      ? await injectMovieverseDynamic(html, name)
      : await injectDefaultHomeDynamic(html, name);
    res.type('text/html').send(html);
  } catch {
    res.sendFile(path.join(__dirname, '..', 'public', 'store', 'index.html'));
  }
});

// ─── Shared premium page shell ────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Normalize a site-verification value the admin may paste in any form — a bare
// token, "google-site-verification=TOKEN", or a full <meta ... content="TOKEN">
// tag — down to just the token, so the rendered <meta> is always valid. This is
// what makes pasting the wrong format from Search Console / Bing not silently
// break verification.
function metaToken(v) {
  v = String(v || '').trim();
  const tag = v.match(/content\s*=\s*["']([^"']+)["']/i);
  if (tag) return tag[1].trim();
  return v.replace(/^google-site-verification\s*=\s*/i, '').trim();
}

const SHARED_STYLES = `
<script>(function(){
  document.documentElement.setAttribute('data-theme','dark');
  try{localStorage.setItem('theme','dark');}catch(e){}
})();</script>
<style>
:root{
  --sp-bg:#05050b;--sp-card:rgba(255,255,255,.06);--sp-card2:rgba(255,255,255,.09);--sp-border:rgba(255,255,255,.12);
  --sp-text:#f7f7ff;--sp-muted:rgba(255,255,255,.55);--sp-nav:rgba(5,5,11,.88);
  --sp-red:#ff2b4f;--sp-orange:#ff8a00;--sp-cyan:#42e8ff;--sp-purple:#9b5cff;
  --sp-accent:#ff2b4f;--sp-accent2:#ff8a00;
  --sp-btn:linear-gradient(135deg,#ff2b4f,#ff8a00);
}
*{box-sizing:border-box;margin:0;padding:0}
html{background:var(--sp-bg);scroll-behavior:smooth;overflow-x:hidden}
body{font-family:'Inter',system-ui,-apple-system,sans-serif;background:var(--sp-bg);color:var(--sp-text);min-height:100vh;overflow-x:hidden}
body::before{content:'';position:fixed;inset:0;z-index:-1;pointer-events:none;
  background:radial-gradient(circle at top left,rgba(255,43,79,.22),transparent 28%),
             radial-gradient(circle at 70% 20%,rgba(66,232,255,.16),transparent 30%),
             radial-gradient(circle at bottom right,rgba(155,92,255,.24),transparent 32%)}
a{color:var(--sp-cyan);text-decoration:none}
a:hover{color:#8af1ff;text-decoration:underline}
/* Cinematic nav */
.sp-nav{position:sticky;top:0;z-index:100;background:var(--sp-nav);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-bottom:1px solid var(--sp-border);padding:.8rem 1.5rem}
.sp-nav-inner{max-width:1200px;margin:0 auto;display:flex;align-items:center;gap:1.5rem}
.sp-logo{font-size:1.35rem;font-weight:900;background:var(--sp-btn);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;text-decoration:none;white-space:nowrap;display:flex;align-items:center}
.sp-logo img{max-height:40px;max-width:180px;object-fit:contain;display:block;-webkit-text-fill-color:initial;background:none}
.sp-logo:hover{opacity:.85;text-decoration:none}
.sp-links{display:flex;gap:.25rem;margin-left:auto;align-items:center}
.sp-links a{color:var(--sp-muted);font-size:.875rem;font-weight:500;padding:.4rem .85rem;border-radius:8px;transition:all .15s;text-decoration:none}
.sp-links a:hover{color:var(--sp-text);background:rgba(255,43,79,.12);text-decoration:none}
.sp-links .sp-cta{background:var(--sp-btn);color:#fff;padding:.45rem 1.1rem;border-radius:50px;font-weight:700;font-size:.85rem;box-shadow:0 8px 24px rgba(255,43,79,.3)}
.sp-links .sp-cta:hover{filter:brightness(1.1);text-decoration:none;color:#fff}
/* Theme toggle */
.sp-theme-btn{background:var(--sp-card);border:1px solid var(--sp-border);color:var(--sp-text);border-radius:50%;width:34px;height:34px;cursor:pointer;font-size:1rem;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-left:.5rem}
/* Page footer */
.sp-footer{border-top:1px solid var(--sp-border);padding:2.5rem 1.5rem;margin-top:5rem;background:rgba(255,255,255,.02)}
.sp-footer-inner{max-width:1200px;margin:0 auto}
.sp-footer-top{display:grid;grid-template-columns:1fr auto;gap:2rem;align-items:start;margin-bottom:1.5rem}
.sp-footer-brand{font-weight:900;font-size:1.15rem;background:var(--sp-btn);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:.5rem}
.sp-footer-tagline{font-size:.82rem;color:var(--sp-muted)}
.sp-footer-links{display:flex;flex-wrap:wrap;gap:1.25rem}
.sp-footer-links a{color:var(--sp-muted);font-size:.82rem;font-weight:600;transition:color .15s}
.sp-footer-links a:hover{color:var(--sp-text);text-decoration:none}
.sp-footer-bottom{font-size:.8rem;color:var(--sp-muted);border-top:1px solid var(--sp-border);padding-top:1.25rem;display:flex;flex-wrap:wrap;gap:.75rem;justify-content:space-between;align-items:center}
/* Blog styles */
.sp-main{max-width:900px;margin:0 auto;padding:2.5rem 1.5rem 5rem}
.blog-page-header{text-align:center;padding:3rem 0 2rem}
.blog-page-header h1{font-size:2.5rem;font-weight:900;margin-bottom:.5rem}
.blog-page-header p{color:var(--sp-muted)}
.blog-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:1.25rem;margin-top:1.5rem}
.blog-card{background:var(--sp-card);border:1px solid var(--sp-border);border-radius:16px;padding:1.5rem;transition:all .2s}
.blog-card:hover{border-color:var(--sp-accent);transform:translateY(-3px);box-shadow:0 8px 32px rgba(255,43,79,.18)}
.blog-card h2{font-size:1.05rem;font-weight:700;line-height:1.4;margin-bottom:.5rem}
.blog-card h2 a{color:var(--sp-text);text-decoration:none}
.blog-card h2 a:hover{color:var(--sp-cyan)}
.blog-card .bc-meta{font-size:.78rem;color:var(--sp-muted);margin-bottom:.4rem}
.blog-card .bc-desc{font-size:.875rem;color:var(--sp-muted);line-height:1.5}
.blog-empty{text-align:center;padding:5rem 1rem;color:var(--sp-muted)}
.blog-empty-icon{font-size:3rem;margin-bottom:1rem;opacity:.4}
.blog-post-page{max-width:760px}
.blog-post-page h1{font-size:2rem;font-weight:800;line-height:1.25;margin-bottom:.75rem;color:var(--sp-text)}
.blog-post-page time{font-size:.82rem;color:var(--sp-muted);display:block;margin-bottom:2rem;padding-bottom:1rem;border-bottom:1px solid var(--sp-border)}
.blog-body{line-height:1.8;font-size:.975rem;color:var(--sp-text)}
.blog-body h2,.blog-body h3{font-weight:700;margin:1.5rem 0 .75rem;color:var(--sp-text)}
.blog-body p{margin-bottom:1rem;color:var(--sp-muted)}
.blog-body img{max-width:100%;height:auto;border-radius:12px;margin:1.25rem 0;display:block}
.blog-body ul,.blog-body ol{margin:0 0 1rem 1.5rem;color:var(--sp-muted)}
.blog-body li{margin-bottom:.4rem}
.blog-body a{color:var(--sp-accent,#7c3aed);text-decoration:underline}
.blog-body blockquote{border-left:3px solid var(--sp-accent,#7c3aed);padding-left:1rem;margin:1rem 0;color:var(--sp-muted)}
.blog-body a.blog-btn{display:inline-block;background:var(--sp-accent,#7c3aed);color:#fff;padding:.7rem 1.4rem;border-radius:9px;text-decoration:none;font-weight:600;margin:.5rem .5rem .5rem 0}
.bc-readmore{display:inline-block;margin-top:.85rem;color:var(--sp-accent,#7c3aed);font-weight:600;font-size:.875rem;text-decoration:none}
.bc-readmore:hover{text-decoration:underline}
.blog-seo-section{max-width:840px;margin:1.5rem auto 2rem;padding:1.25rem 1.5rem;background:rgba(255,255,255,.03);border:1px solid var(--sp-border,rgba(255,255,255,.08));border-radius:14px;line-height:1.75;color:var(--sp-muted)}
.blog-seo-section h2,.blog-seo-section h3{color:var(--sp-text);font-weight:700;margin:.5rem 0 .6rem}
.blog-seo-section a{color:var(--sp-accent,#7c3aed)}
.blog-seo-section img{max-width:100%;border-radius:10px}
/* Legal styles */
.legal-page h1{font-size:1.8rem;font-weight:800;margin-bottom:.75rem;color:var(--sp-text)}
.legal-page .legal-updated{font-size:.82rem;color:var(--sp-muted);margin-bottom:2rem}
.legal-page .legal-body{line-height:1.85;font-size:.925rem;color:var(--sp-text)}
.legal-page .legal-body h2,.legal-page .legal-body h3{font-weight:700;margin:1.75rem 0 .75rem;color:var(--sp-text)}
.legal-page .legal-body p{margin-bottom:1rem;color:var(--sp-muted)}
.legal-page .legal-body ul,.legal-page .legal-body ol{padding-left:1.5rem;margin-bottom:1rem}
.legal-page .legal-body li{margin-bottom:.35rem;color:var(--sp-muted)}
/* DB-stored tables (contact/legal pages) — force dark-theme-friendly colors, overriding any inline light backgrounds pasted into page content */
.legal-page .legal-body table{width:100%;border-collapse:collapse;margin:1.25rem 0;border:1px solid var(--sp-border);border-radius:12px;overflow:hidden;font-size:.9rem}
.legal-page .legal-body tr{background:transparent!important}
.legal-page .legal-body tr:nth-child(even){background:var(--sp-card)!important}
.legal-page .legal-body th,.legal-page .legal-body td{padding:.7rem .9rem!important;border:1px solid var(--sp-border);color:var(--sp-text)!important;text-align:left;vertical-align:top}
.legal-page .legal-body th{font-weight:700}
/* Mobile bottom nav (matches store pages) */
.sp-bnav{display:none;position:fixed;bottom:0;left:0;right:0;height:58px;z-index:500;background:rgba(5,5,11,.96);border-top:1px solid var(--sp-border);grid-template-columns:repeat(4,1fr);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.sp-bnav-btn{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;color:var(--sp-muted);font-size:.65rem;font-weight:600;text-decoration:none;transition:color .15s;padding:.3rem .5rem}
.sp-bnav-btn span{font-size:1.15rem;line-height:1}
.sp-bnav-btn.active,.sp-bnav-btn:hover{color:var(--sp-accent);text-decoration:none}
@media(max-width:600px){.sp-footer-top{grid-template-columns:1fr}.blog-grid{grid-template-columns:1fr}.blog-post-page h1{font-size:1.5rem}.sp-links a:not(.sp-cta){display:none}}
@media(max-width:760px){
  /* Match home/plans/my fixed-header pattern across all server-rendered
     pages (contact, privacy, terms, refund, blog, blog post). */
  /* padding-top handled by store-theme.css CSS variable --mobile-header-h */
  body{padding-bottom:58px}
  .sp-nav{position:fixed;left:0;right:0;top:0;width:100%;padding:.55rem 1rem}
  .sp-nav-inner{gap:.75rem}
  .sp-logo img{max-height:30px;max-width:130px}
  .sp-bnav{display:grid}
  .sp-footer{margin-bottom:58px;padding:1.75rem 1rem}
  .sp-main{padding:.5rem 1rem 3rem}
  .blog-page-header{padding:.75rem 0 1.25rem}
  .blog-page-header h1{font-size:1.7rem}
}
</style>`;

// Default menu — what every store sees until they customize it in the admin.
// `cta:true` means the item is rendered as the highlighted pill button.
const DEFAULT_MENU_ITEMS = [
  { label: 'Home',       href: '/',         icon: '🏠', desktop: true, mobile: true },
  { label: 'Plans',      href: '/plans',    icon: '🎬', desktop: true, mobile: true },
  { label: 'Blog',       href: '/blog',     icon: '✍️', desktop: true, mobile: true },
  { label: 'Support',    href: '/contact',  icon: '💬', desktop: true, mobile: true },
  { label: 'My Account', href: '/my',       icon: '👤', desktop: true, mobile: true, cta: true },
];

// Parse + sanitize the admin-saved menu, falling back to defaults if unset or
// malformed. Used by both server-side renders (spNav) and the /user/api/store
// payload (so the client-side hydrator on index.html / movieverse-home.html
// gets the same list). Throws nothing; bad data just falls back.
function getMenuItems(raw) {
  if (raw == null || String(raw).trim() === '') return DEFAULT_MENU_ITEMS;
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return DEFAULT_MENU_ITEMS;
    const items = v
      .filter(x => x && typeof x.label === 'string' && typeof x.href === 'string' && x.label.trim() && x.href.trim())
      .map(x => ({
        label: String(x.label).trim(),
        href: String(x.href).trim(),
        icon: typeof x.icon === 'string' ? x.icon.trim() : '',
        desktop: x.desktop !== false && x.desktop !== 0 && x.desktop !== '0',
        mobile:  x.mobile  !== false && x.mobile  !== 0 && x.mobile  !== '0',
        cta: x.cta === true || x.cta === 1 || x.cta === '1',
      }));
    return items.length ? items : DEFAULT_MENU_ITEMS;
  } catch { return DEFAULT_MENU_ITEMS; }
}

function spNav(siteName, logoLight, logoDark, menuItems) {
  const logoSrc = logoDark || logoLight;
  const logoHtml = logoSrc
    ? `<img src="${esc(logoSrc)}" alt="${esc(siteName)}" style="max-height:40px;max-width:180px;object-fit:contain">`
    : esc(siteName);
  // Resolve from the admin-saved setting when no list was threaded through.
  // getSettingSync is free (in-memory cache) so this has no per-request cost.
  const resolved = Array.isArray(menuItems) && menuItems.length
    ? menuItems
    : getMenuItems(getSettingSync('header_menu_items'));
  const items = resolved.filter(it => it.desktop);
  const linksHtml = items.map(it =>
    it.cta
      ? `<a href="${esc(it.href)}" class="sp-cta">${esc(it.label)}</a>`
      : `<a href="${esc(it.href)}">${esc(it.label)}</a>`
  ).join('');
  return `<nav class="sp-nav"><div class="sp-nav-inner">
<a href="/" class="sp-logo" id="sp-nav-logo">${logoHtml}</a>
<div class="sp-links">${linksHtml}</div>
</div></nav>`;
}

function spFooter(siteName) {
  const yr = new Date().getFullYear();
  return `<footer class="sp-footer"><div class="sp-footer-inner">
<div class="sp-footer-top">
  <div><div class="sp-footer-brand">${esc(siteName)}</div><div class="sp-footer-tagline">Premium OTT Subscriptions · Instant Delivery</div></div>
  <div class="sp-footer-links">
    <a href="/reseller">Become a Reseller</a>
    <a href="/privacy">Privacy Policy</a>
    <a href="/terms">Terms of Service</a>
    <a href="/refund">Refund Policy</a>
    <a href="/about">About Us</a>
    <a href="/contact">Contact</a>
    <a href="/blog">Blog</a>
  </div>
</div>
<div class="sp-footer-bottom">
  <span>© ${yr} ${esc(siteName)}. All rights reserved.</span>
  <span>Made with ❤️ for streaming fans</span>
</div>
</div></footer>
<nav class="sp-bnav">
  <a class="sp-bnav-btn" href="/"><span>🏠</span>Home</a>
  <a class="sp-bnav-btn" href="/plans"><span>📦</span>Plans</a>
  <a class="sp-bnav-btn" href="/my"><span>👤</span>Account</a>
  <a class="sp-bnav-btn" href="/contact"><span>🎧</span>Support</a>
</nav>
<script>(function(){var p=location.pathname;document.querySelectorAll('.sp-bnav-btn').forEach(function(a){if(a.getAttribute('href')===p)a.classList.add('active');});})();</script>
<script src="/store/chat-widget.js"></script>`;
}

async function getLogoUrls() {
  try {
    const db = await getDb();
    const light = (get(db, `SELECT value FROM settings WHERE key='logo_light_url'`) || {}).value || '';
    const dark  = (get(db, `SELECT value FROM settings WHERE key='logo_dark_url'`)  || {}).value || '';
    return { light, dark };
  } catch { return { light: '', dark: '' }; }
}

// ─── MovieVerse home: server-render the dynamic content ───────────────────────
// movieverse-home.html ships with template placeholders (brand, hero copy,
// stats, plan cards) that it fills CLIENT-side after fetching /user/api/store +
// /user/api/plans. On a slow connection that shows the template values for a few
// seconds before the real ones swap in — the "flash of other content" users see
// on refresh. We pre-render the real values here so the first paint is already
// correct; the client's later re-render then produces identical DOM (no flash).
// Mirrors the client formatting in movieverse-home.html exactly. Never throws —
// any failure just leaves the placeholders for the client to fill as before.
// Replace the inner text of any element carrying data-tk="<key>" with its token
// value — used to server-render the MovieVerse home's editable copy so it's
// correct on first paint (the client re-applies the same values). `tokens` maps
// data-tk keys (e.g. mv_eyebrow) to values; blank values keep the built-in
// default. Safe for our text-only data-tk elements (no nested same-tag markup).
function applyHomeTokens(html, tokens) {
  for (const [key, val] of Object.entries(tokens)) {
    if (val == null || String(val).trim() === '') continue;
    const safeKey = String(key).replace(/[^a-zA-Z0-9_]/g, '');
    if (!safeKey) continue;
    const re = new RegExp(`(<([a-zA-Z0-9]+)[^>]*\\bdata-tk="${safeKey}"[^>]*>)[\\s\\S]*?(</\\2>)`);
    html = html.replace(re, `$1${esc(val)}$3`);
  }
  return html;
}

// MovieVerse section order + visibility — same marker approach as renderHomeSections,
// for the cinematic home (movieverse-home.html). Driven by the home_mv_sections JSON
// setting; only rewrites the container when a config is actually saved.
const MV_SECTION_IDS = ['ribbon', 'categories', 'featured', 'howitworks', 'cta', 'faq'];
function renderMvSections(html, raw) {
  try {
    if (!raw || !String(raw).trim()) return html;
    let cfg; try { cfg = JSON.parse(raw); } catch { return html; }
    if (!Array.isArray(cfg)) return html;
    const order = [];
    const on = {};
    for (const item of cfg) {
      const id = item && item.id;
      if (MV_SECTION_IDS.includes(id) && !order.includes(id)) {
        order.push(id);
        on[id] = !(item.on === false || item.on === 0 || item.on === '0');
      }
    }
    for (const id of MV_SECTION_IDS) if (!order.includes(id)) { order.push(id); on[id] = true; }
    const inner = {};
    for (const id of MV_SECTION_IDS) {
      const m = html.match(new RegExp(`<!--MVSEC:${id}-->([\\s\\S]*?)<!--/MVSEC:${id}-->`));
      inner[id] = m ? m[1] : '';
    }
    const rebuilt = order.filter(id => on[id]).map(id => `<!--MVSEC:${id}-->${inner[id]}<!--/MVSEC:${id}-->`).join('\n');
    return html.replace(/<div id="mv-sections">[\s\S]*?<\/div><!--\/mv-sections-->/, `<div id="mv-sections">\n${rebuilt}\n</div><!--/mv-sections-->`);
  } catch { return html; }
}

async function injectMovieverseDynamic(html, siteName) {
  try {
    const db = await getDb();
    const [heroTitle, heroTitle2, heroSub, tagline] = await Promise.all([
      getSetting('hero_title'), getSetting('hero_title2'), getSetting('hero_subtext'), getSetting('site_tagline'),
    ]);
    const logos = await getLogoUrls();
    const plans = all(db, `SELECT id,platform,name,duration_days,price_inr,image_url,stock FROM plans WHERE active=1 ORDER BY sort_order ASC, id ASC`);
    const platCount = new Set(plans.map(p => p.platform)).size;
    const statCategories = platCount >= 10 ? `${platCount}+` : '50+'; // mirror /user/api/store stat_platforms

    // Brand — logo if configured, else the store name
    const logo = logos.dark || logos.light;
    if (logo) {
      html = html.replace(/<a class="brand" href="\/" id="mv-brand">[\s\S]*?<\/a>/,
        `<a class="brand" href="/" id="mv-brand"><img src="${esc(logo)}" alt="${esc(siteName)}" style="max-height:40px;max-width:170px;object-fit:contain"></a>`);
    } else {
      html = html.replace(/(<span id="mv-brand-name">)[^<]*(<\/span>)/, `$1${esc(siteName)}$2`);
    }

    // Hero copy — only override the template when the store has configured it
    if (heroTitle)  html = html.replace(/(<span class="gradient-text" id="mv-hero-title">)[^<]*(<\/span>)/, `$1${esc(heroTitle)}$2`);
    if (heroTitle2) html = html.replace(/(<span id="mv-hero-title2">)[^<]*(<\/span>)/, `$1${esc(heroTitle2)}$2`);
    const sub = heroSub || tagline;
    if (sub) html = html.replace(/(<p[^>]*id="mv-hero-sub"[^>]*>)[\s\S]*?(<\/p>)/, `$1${esc(sub)}$2`);

    // Stats
    html = html.replace(/(<[a-z0-9]+[^>]*id="mv-stat-products"[^>]*>)[^<]*(<\/[a-z0-9]+>)/i, `$1${plans.length}+$2`);
    html = html.replace(/(<[a-z0-9]+[^>]*id="mv-stat-categories"[^>]*>)[^<]*(<\/[a-z0-9]+>)/i, `$1${esc(statCategories)}$2`);

    // Plan cards — mirror the client markup so its re-render is a visual no-op
    const fmtInr = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
    const durOf = p => !p.duration_days ? 'Lifetime'
      : p.duration_days >= 365 ? Math.round(p.duration_days / 365) + ' yr'
      : p.duration_days >= 30 ? Math.round(p.duration_days / 30) + ' months'
      : p.duration_days + ' days';
    const initials = p => (p.platform || p.name || '?').trim().charAt(0).toUpperCase();
    const thumb = (p, cls) => p.image_url
      ? `<div class="${cls}"><img src="${esc(p.image_url)}" alt="${esc(p.platform || p.name || '')}" loading="lazy" onerror="this.parentNode.textContent='${esc(initials(p))}'"></div>`
      : `<div class="${cls}">${esc(initials(p))}</div>`;

    const top2 = plans.filter(p => p.stock !== 0).slice(0, 3);
    const heroPlansHtml = top2.map(p =>
      `<div class="plan-card">${thumb(p, 'plan-card-thumb')}<div style="flex:1;min-width:0"><strong>${esc(p.platform || '')} ${esc(p.name || '')}</strong><small>${esc(durOf(p))} · Fast activation</small></div><span class="price-pill">${fmtInr(p.price_inr)}</span></div>`).join('');
    html = html.replace('<div id="mv-hero-plans" class="sf-plans"></div>', `<div id="mv-hero-plans" class="sf-plans">${heroPlansHtml}</div>`);

    const top4 = plans.slice(0, 4);
    const productListHtml = top4.map(p =>
      `<a class="product-row" data-buy-id="${p.id}" href="/my?buy=${p.id}">${thumb(p, 'product-thumb')}<div style="flex:1;min-width:0"><strong>${esc(p.platform || '')} ${esc(p.name || '')}</strong><small>${esc(durOf(p))} · Instant delivery</small></div><span class="price-pill">${fmtInr(p.price_inr)}</span></a>`).join('');
    html = html.replace('<div class="product-row"><div><strong>Loading plans…</strong><small>Fetching from catalog</small></div></div>', productListHtml);

    // Editable text tokens (eyebrow, buttons, section headings, CTA, FAQ…) — render
    // any element carrying data-tk server-side so the cinematic theme shows the
    // admin's copy on first paint. Managed in Admin → Homepage Content.
    const tokenRows = all(db, `SELECT key, value FROM settings WHERE key LIKE 'home_mv_%'`);
    if (tokenRows.length) {
      const tokens = {};
      tokenRows.forEach(r => { tokens[r.key.slice(5)] = r.value; });
      html = applyHomeTokens(html, tokens);
    }
    // Section order & visibility — Admin → Homepage Content → Sections.
    html = renderMvSections(html, await getSetting('home_mv_sections'));

    return html;
  } catch {
    return html;
  }
}

// ─── Editable home sections: reviews / ticker / badges + order & visibility ───
// All four are managed in Admin → Homepage Text and persisted as JSON strings in
// settings (home_reviews / home_ticker / home_badges / home_sections). We render
// them into index.html server-side — via the HTML comment markers added to that
// file — so the first paint is final and crawlable; the client never re-renders
// these blocks. Each step is defensive: blank/malformed JSON falls back to the
// built-in defaults, so a bad setting can never blank out the homepage.
const HOME_DEFAULT_REVIEWS = [
  { stars: 5, quote: 'Ordered Office 2021 at midnight and got the genuine key in two minutes. Activated first try — exactly as described.', name: '— Rahul M., Pune' },
  { stars: 5, quote: 'Netflix and Spotify both delivered instantly over WhatsApp. When one needed a reset they replaced it within the hour.', name: '— Sneha R., Bengaluru' },
  { stars: 5, quote: 'Paid with USDT, zero hassle. Fair prices and support actually replies 24×7. My go-to for software keys now.', name: '— Arjun K., Delhi' },
];
const HOME_DEFAULT_TICKER = ['⚡ Instant Delivery', '✅ Verified Products', '💬 WhatsApp Support', '🔐 Secure Checkout', '🎬 OTT Plans', '🤖 AI Tools', '☁️ Cloud Storage', '🖥️ Software Keys', '🎵 Music Streaming', '🛡️ VPN & Security'];
const HOME_DEFAULT_BADGES = ['🔐 Secure checkout', '⚡ Instant digital delivery', '🛡️ Replacement warranty', '💳 UPI & Crypto (USDT)', '💬 24×7 WhatsApp support'];
const HOME_SECTION_IDS = ['ticker', 'categories', 'trust', 'cta'];

// Effective array for an editable list: a blank/unset setting → defaults; a set
// value (even an empty array) is respected, so deleting every item really empties
// the block instead of silently restoring the seed content.
function homeArr(raw, fallback) {
  if (raw == null || String(raw).trim() === '') return fallback;
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : fallback; } catch { return fallback; }
}

function renderHomeSections(html, raw) {
  try {
    // Reviews — replace everything between the <!--reviews--> markers.
    const reviews = homeArr(raw.reviews, HOME_DEFAULT_REVIEWS).filter(r => r && (r.quote || r.name));
    const figs = reviews.map(r => {
      const n = Math.max(0, Math.min(5, parseInt(r.stars, 10) || 0));
      const stars = '★'.repeat(n) + '☆'.repeat(5 - n);
      return `<figure class="review">
      <div class="stars" aria-label="Rated ${n} out of 5">${stars}</div>
      <blockquote>${esc(r.quote || '')}</blockquote>
      <figcaption>${esc(r.name || '')}</figcaption>
    </figure>`;
    }).join('\n    ');
    html = html.replace(/<!--reviews-->[\s\S]*?<!--\/reviews-->/, `<!--reviews-->${figs ? `\n    ${figs}\n  ` : ''}<!--/reviews-->`);

    // Ticker — emitted twice for the seamless CSS marquee.
    const ticker = homeArr(raw.ticker, HOME_DEFAULT_TICKER).map(t => String(t).trim()).filter(Boolean);
    const tspans = ticker.map(t => `<span>${esc(t)}</span>`).join('\n    ');
    html = html.replace(/<!--ticker-->[\s\S]*?<!--\/ticker-->/, `<!--ticker-->${tspans ? `\n    ${tspans}\n    ${tspans}\n  ` : ''}<!--/ticker-->`);

    // Badges
    const badges = homeArr(raw.badges, HOME_DEFAULT_BADGES).map(b => String(b).trim()).filter(Boolean);
    const bspans = badges.map(b => `<span>${esc(b)}</span>`).join('\n    ');
    html = html.replace(/<!--badges-->[\s\S]*?<!--\/badges-->/, `<!--badges-->${bspans ? `\n    ${bspans}\n  ` : ''}<!--/badges-->`);

    // Section order + visibility. Only rewrite the container when a config is
    // actually saved; otherwise the file's natural order/visibility is untouched.
    const secCfg = homeArr(raw.sections, null);
    if (Array.isArray(secCfg)) {
      const order = [];
      const on = {};
      for (const item of secCfg) {
        const id = item && item.id;
        if (HOME_SECTION_IDS.includes(id) && !order.includes(id)) {
          order.push(id);
          on[id] = !(item.on === false || item.on === 0 || item.on === '0');
        }
      }
      // Any known section missing from the saved config keeps showing, so adding
      // a section in a later release won't make it vanish for older saves.
      for (const id of HOME_SECTION_IDS) if (!order.includes(id)) { order.push(id); on[id] = true; }

      const inner = {};
      for (const id of HOME_SECTION_IDS) {
        const m = html.match(new RegExp(`<!--SEC:${id}-->([\\s\\S]*?)<!--/SEC:${id}-->`));
        inner[id] = m ? m[1] : '';
      }
      const rebuilt = order.filter(id => on[id]).map(id => `<!--SEC:${id}-->${inner[id]}<!--/SEC:${id}-->`).join('\n');
      html = html.replace(/<div id="home-sections">[\s\S]*?<\/div><!--\/home-sections-->/, `<div id="home-sections">\n${rebuilt}\n</div><!--/home-sections-->`);
    }
    return html;
  } catch { return html; }
}

// ─── Default home (index.html): server-render the dynamic content ─────────────
// Same idea as injectMovieverseDynamic, for the non-MovieVerse home. index.html
// fills the brand, phone mock, CTA title, footer copy and hero copy client-side
// after fetching /user/api/store; on a slow connection those show their template
// defaults first (incl. a stale "© 2025" and "…access?" vs "…access on {store}?")
// then swap. Pre-render them so the first paint is final. Mirrors the client
// formatting; never throws.
async function injectDefaultHomeDynamic(html, siteName) {
  try {
    const [heroTitle, heroTitle2, heroSub, tagline] = await Promise.all([
      getSetting('hero_title'), getSetting('hero_title2'), getSetting('hero_subtext'), getSetting('site_tagline'),
    ]);
    const logos = await getLogoUrls();
    const year = new Date().getFullYear();

    // Brand (header + footer) — logo images if configured, else the store name
    if (logos.light || logos.dark) {
      const light = logos.light || logos.dark;
      const dark = logos.dark || logos.light;
      const imgs = (h, w) => `<img src="${esc(light)}" class="logo-light" alt="${esc(siteName)}" style="max-height:${h}px;max-width:${w}px;object-fit:contain"><img src="${esc(dark)}" class="logo-dark" alt="${esc(siteName)}" style="max-height:${h}px;max-width:${w}px;object-fit:contain">`;
      html = html.replace(/(<span class="brand-name" id="nav-logo">)[^<]*(<\/span>)/, `$1${imgs(36, 150)}$2`);
      html = html.replace(/(<a class="footer-logo" href="\/" id="footer-name">)[^<]*(<\/a>)/, `$1${imgs(28, 120)}$2`);
    } else {
      html = html.replace(/(<span class="brand-name" id="nav-logo">)[^<]*(<\/span>)/, `$1${esc(siteName)}$2`);
      html = html.replace(/(<a class="footer-logo" href="\/" id="footer-name">)[^<]*(<\/a>)/, `$1${esc(siteName)}$2`);
    }

    // Phone mock name, CTA title, footer copyright (mirror the client)
    html = html.replace(/(<h3 id="phone-name">)[^<]*(<\/h3>)/, `$1${esc(siteName)}$2`);
    html = html.replace(/(<h2 id="cta-title">)[^<]*(<\/h2>)/, `$1Ready to upgrade your digital access on ${esc(siteName)}?$2`);
    html = html.replace(/(<span class="footer-copy" id="footer-copy">)[^<]*(<\/span>)/, `$1© ${year} ${esc(siteName)}. All rights reserved.$2`);

    // Hero copy — only override the template when the store has configured it
    if (heroTitle)  html = html.replace(/(<span class="gradient" id="hero-title">)[^<]*(<\/span>)/, `$1${esc(heroTitle)}$2`);
    if (heroTitle2) html = html.replace(/(<span id="hero-title2">)[^<]*(<\/span>)/, `$1${esc(heroTitle2)}$2`);
    const sub = heroSub || tagline;
    if (sub) html = html.replace(/(<p id="hero-sub">)[\s\S]*?(<\/p>)/, `$1${esc(sub)}$2`);

    // Editable reviews / ticker / badges + section order & visibility.
    const [reviewsRaw, tickerRaw, badgesRaw, sectionsRaw] = await Promise.all([
      getSetting('home_reviews'), getSetting('home_ticker'), getSetting('home_badges'), getSetting('home_sections'),
    ]);
    html = renderHomeSections(html, { reviews: reviewsRaw, ticker: tickerRaw, badges: badgesRaw, sections: sectionsRaw });

    // Hero 3D phone preview — remove it (and make the hero single-column) when
    // the admin turns it off in Homepage Content → Sections.
    if ((await getSetting('home_show_phone')) === '0') {
      html = html.replace('<main class="hero">', '<main class="hero" style="grid-template-columns:1fr">')
                 .replace('<section class="stage"', '<section class="stage" style="display:none"');
    }

    return html;
  } catch {
    return html;
  }
}

// ─── Product page (/plans/:slug) ──────────────────────────────────────────────
// Escape JSON-LD so a value can't break out of the <script> tag.
function ldjson(obj) { return JSON.stringify(obj).replace(/</g, '\\u003c'); }

function productDur(p) {
  return !p.duration_days ? 'Lifetime'
    : p.duration_days >= 365 ? `${Math.round(p.duration_days / 365)} Year${p.duration_days >= 730 ? 's' : ''}`
    : p.duration_days >= 30 ? `${Math.round(p.duration_days / 30)} Month${p.duration_days >= 60 ? 's' : ''}`
    : `${p.duration_days} Days`;
}

// Server-rendered, crawlable product hero: unique H1 (product name), key facts,
// description, features, breadcrumb, and Login/Guest checkout CTAs. This is what
// makes each /plans/:slug a real, indexable product page instead of a duplicate
// of the catalog.
// Lucide-style inline SVG icons (no emoji as structural icons).
function ppIcon(name) {
  const d = {
    bolt: '<path d="M13 2 4 14h6l-1 8 11-13h-7l1-7Z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
    shield: '<path d="M12 3 5 6v5.5c0 4.3 3 6.6 7 8 4-1.4 7-3.7 7-8V6l-7-3Z"/><path d="m9.2 12 2 2 3.6-3.8"/>',
    check: '<path d="m5 12.5 4 4L19 7"/>',
    headset: '<path d="M5 13v-1a7 7 0 0 1 14 0v1"/><rect x="3" y="13" width="4" height="6" rx="1.5"/><rect x="17" y="13" width="4" height="6" rx="1.5"/><path d="M19 19a3 3 0 0 1-3 3h-3"/>',
    card: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3 10h18"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
    mail: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="m4 8 8 5.5L20 8"/>',
    tg: '<path d="m21.5 4.3-18 7c-1 .4-1 .9.2 1.3L8 14l1.8 5.6c.2.6.6.6 1 .2l2.5-2.4 4.7 3.5c.7.4 1.4.2 1.6-.7l3-15.4c.2-1-.4-1.4-1.1-1Z"/>',
    box: '<path d="m3.5 7.5 8.5-4 8.5 4-8.5 4-8.5-4Z"/><path d="M3.5 7.5v9l8.5 4 8.5-4v-9"/><path d="M12 11.5v9"/>',
  }[name] || '';
  return `<svg class="pp-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${d}</svg>`;
}

// Per-product FAQs — rendered on the page AND emitted as FAQPage structured data,
// so the content is identical in both (Google requires the visible Q&A to match).
function productFaqs(p, siteName, tgUrl) {
  const dur = productDur(p);
  const plat = (p.platform && p.platform.toLowerCase() !== 'other') ? p.platform : 'this product';
  const inst = p.delivery_type === 'instant';
  return [
    { q: `How will I receive my ${p.name}?`,
      a: `As soon as your payment is confirmed, your access details are delivered automatically to your email and WhatsApp${inst ? ' — usually within seconds' : ''}, so there is no manual wait.` },
    { q: `How long is ${p.name} valid?`,
      a: dur === 'Lifetime' ? `It is a one-time purchase with lifetime validity — no recurring charges.` : `Your ${p.name} stays valid for ${dur} from activation.` },
    { q: `Is ${p.name} genuine and safe?`,
      a: `Yes — you get genuine ${plat} access from ${siteName}, backed by responsive support if you ever need help.` },
    { q: `Which payment methods can I use?`,
      a: `You can pay by UPI, USDT, or your ${siteName} wallet balance.${tgUrl ? ' You can also order instantly on our Telegram bot with automatic delivery.' : ''}` },
    { q: `What if I have a problem after buying?`,
      a: `Just message our support team and we will sort it out quickly so you can keep enjoying ${p.name}.` },
  ];
}

// Server-rendered, crawlable product page: unique H1, key facts, price + savings,
// CTAs, trust badges, an SEO content body (About / What-you-get / How-it-works /
// FAQ) and a mobile sticky buy-bar. Liquid-Glass styling, on-brand via --st-* tokens.
function buildProductHero(p, tgUrl, siteName) {
  let features = [];
  try { features = JSON.parse(p.features || '[]'); } catch {}
  if (!Array.isArray(features)) features = [];
  const dur = productDur(p);
  const price = Number(p.price_inr).toLocaleString('en-IN');
  const hasOrig = p.original_price_inr && p.original_price_inr > p.price_inr;
  const off = hasOrig ? Math.round((1 - p.price_inr / p.original_price_inr) * 100) : 0;
  const save = hasOrig ? Number(p.original_price_inr - p.price_inr).toLocaleString('en-IN') : 0;
  const oos = p.stock === 0;
  const inst = p.delivery_type === 'instant';
  const platLabel = (p.platform && p.platform.toLowerCase() !== 'other') ? esc(p.platform) : 'Digital Product';
  const nm = esc(p.name);
  const site = esc(siteName || 'our store');
  const img = p.image_url
    ? `<img src="${esc(p.image_url)}" alt="${esc((p.platform ? p.platform + ' ' : '') + p.name)} — buy at ${site}" loading="eager">`
    : `<span style="display:inline-block;width:3.4rem;height:3.4rem;color:var(--st-accent)">${ppIcon('box')}</span>`;
  const faqs = productFaqs(p, siteName || 'our store', tgUrl);
  return `
<style id="pp-css">
.pp-wrap{max-width:1040px;margin:0 auto;padding:1.25rem 1.1rem 0}
.pp-crumb{font-size:.8rem;color:var(--st-muted);margin-bottom:1rem;display:flex;gap:.4rem;flex-wrap:wrap;align-items:center}
.pp-crumb a{color:var(--st-muted);text-decoration:none}.pp-crumb a:hover{color:var(--st-accent)}
.pp-i{width:1.05em;height:1.05em;flex:0 0 auto;vertical-align:-2px}
.pp-hero{display:grid;grid-template-columns:230px 1fr;gap:1.5rem;align-items:center;background:linear-gradient(135deg,var(--st-card-solid,rgba(255,255,255,.05)),rgba(255,255,255,.01));border:1px solid var(--st-border);border-radius:18px;padding:1.4rem;box-shadow:0 14px 44px rgba(0,0,0,.18);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
.pp-media{display:flex;align-items:center;justify-content:center;background:radial-gradient(circle at 50% 35%,rgba(141,92,255,.2),rgba(0,0,0,.22));border:1px solid var(--st-border);border-radius:14px;padding:1rem;min-height:172px}
.pp-media img{max-width:160px;max-height:132px;object-fit:contain;filter:drop-shadow(0 6px 16px rgba(0,0,0,.35))}
.pp-badge{display:inline-block;font-size:.7rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--st-accent);background:rgba(141,92,255,.14);border:1px solid var(--st-border);padding:.22rem .6rem;border-radius:999px}
.pp-h1{font-size:clamp(1.4rem,3.6vw,1.95rem);font-weight:900;line-height:1.18;margin:.55rem 0}
.pp-facts{display:flex;flex-wrap:wrap;gap:.45rem;margin:0 0 .9rem}
.pp-chip{display:inline-flex;align-items:center;gap:.34rem;font-size:.78rem;font-weight:600;color:var(--st-text);background:var(--st-card-solid,rgba(255,255,255,.05));border:1px solid var(--st-border);border-radius:999px;padding:.32rem .62rem}
.pp-chip.ok{color:#10b981}.pp-chip.no{color:#ef4444}
.pp-price{display:flex;align-items:baseline;gap:.55rem;flex-wrap:wrap;margin:.1rem 0 1rem}
.pp-price b{font-size:clamp(1.7rem,5vw,2.15rem);font-weight:900;color:var(--st-accent);line-height:1}
.pp-orig{text-decoration:line-through;color:var(--st-muted);font-size:1rem}
.pp-off{background:linear-gradient(135deg,#16a34a,#15803d);color:#fff;border-radius:7px;padding:.16rem .5rem;font-size:.72rem;font-weight:800}
.pp-save{font-size:.78rem;color:#10b981;font-weight:700;width:100%}
.pp-cta{display:flex;gap:.6rem;flex-wrap:wrap}
.pp-btn{display:inline-flex;align-items:center;justify-content:center;gap:.45rem;font-weight:800;font-size:.92rem;border-radius:12px;padding:.78rem 1.3rem;cursor:pointer;border:0;text-decoration:none;transition:transform .15s ease,box-shadow .15s ease,filter .15s ease;min-height:46px}
.pp-btn:active{transform:scale(.97)}
.pp-btn-primary{background:linear-gradient(135deg,var(--st-accent,#2b6fff),#8d5cff);color:#fff;box-shadow:0 8px 22px rgba(141,92,255,.32)}
.pp-btn-primary:hover{filter:brightness(1.07)}
.pp-btn-ghost{background:var(--st-card-solid,rgba(255,255,255,.05));color:var(--st-text);border:1px solid var(--st-border)}
.pp-btn-ghost:hover{border-color:var(--st-accent)}
.pp-btn[disabled]{opacity:.5;cursor:not-allowed;filter:grayscale(.4)}
.pp-tg{display:inline-flex;align-items:center;gap:.45rem;margin-top:.8rem;font-size:.84rem;font-weight:700;color:#2aa3e0;text-decoration:none}
.pp-tg:hover{text-decoration:underline}
.pp-trust{display:grid;grid-template-columns:repeat(4,1fr);gap:.7rem;margin:1.2rem 0 0}
.pp-trust .t{display:flex;flex-direction:column;align-items:center;text-align:center;gap:.4rem;font-size:.74rem;font-weight:600;color:var(--st-muted);background:var(--st-card-solid,rgba(255,255,255,.04));border:1px solid var(--st-border);border-radius:12px;padding:.85rem .5rem;line-height:1.3}
.pp-trust .t .pp-i{width:1.45rem;height:1.45rem;color:var(--st-accent)}
.pp-sec{max-width:1040px;margin:2.2rem auto 0;padding:0 1.1rem}
.pp-sec h2{font-size:1.18rem;font-weight:800;margin:0 0 .9rem}
.pp-prose{color:var(--st-muted);font-size:.96rem;line-height:1.75;max-width:72ch}
.pp-feats{display:grid;grid-template-columns:repeat(auto-fill,minmax(235px,1fr));gap:.7rem}
.pp-feat{display:flex;gap:.6rem;align-items:flex-start;background:var(--st-card-solid,rgba(255,255,255,.04));border:1px solid var(--st-border);border-radius:12px;padding:.8rem .9rem;font-size:.88rem;color:var(--st-text)}
.pp-feat .pp-i{color:#10b981;width:1.2rem;height:1.2rem;margin-top:.1rem}
.pp-steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:.85rem;counter-reset:s}
.pp-step{position:relative;background:var(--st-card-solid,rgba(255,255,255,.04));border:1px solid var(--st-border);border-radius:14px;padding:1.15rem .95rem .9rem}
.pp-step::before{counter-increment:s;content:counter(s);position:absolute;top:-.7rem;left:.9rem;width:1.7rem;height:1.7rem;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:.85rem;color:#fff;background:linear-gradient(135deg,var(--st-accent,#2b6fff),#8d5cff);border-radius:50%}
.pp-step b{display:block;font-size:.92rem;margin:.15rem 0 .25rem}
.pp-step span{font-size:.82rem;color:var(--st-muted);line-height:1.55}
.pp-faq details{background:var(--st-card-solid,rgba(255,255,255,.04));border:1px solid var(--st-border);border-radius:12px;margin-bottom:.6rem;overflow:hidden}
.pp-faq summary{cursor:pointer;list-style:none;padding:.92rem 1rem;font-weight:700;font-size:.92rem;display:flex;justify-content:space-between;gap:1rem;align-items:center}
.pp-faq summary::-webkit-details-marker{display:none}
.pp-faq summary::after{content:"+";font-size:1.35rem;line-height:1;color:var(--st-accent);transition:transform .2s}
.pp-faq details[open] summary::after{transform:rotate(45deg)}
.pp-faq p{margin:0;padding:0 1rem 1rem;color:var(--st-muted);font-size:.88rem;line-height:1.65}
.pp-more{display:inline-flex;align-items:center;gap:.45rem;margin-top:.4rem;color:var(--st-accent);font-weight:700;font-size:.92rem;text-decoration:none}.pp-more:hover{text-decoration:underline}
.pp-sticky{position:sticky;bottom:0;z-index:40;display:none;gap:.8rem;align-items:center;justify-content:space-between;background:var(--st-card-solid,#12121c);border-top:1px solid var(--st-border);padding:.7rem 1rem;margin-top:1.5rem;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
@media(max-width:720px){.pp-hero{grid-template-columns:1fr;text-align:center}.pp-media{min-height:150px}.pp-facts,.pp-price,.pp-cta{justify-content:center}.pp-trust{grid-template-columns:repeat(2,1fr)}.pp-cta .pp-btn{flex:1 1 auto}.pp-sticky{display:flex}}
@media(prefers-reduced-motion:reduce){.pp-btn,.pp-faq summary::after{transition:none}.pp-btn:active{transform:none}}
</style>
<section id="product-hero">
  <div class="pp-wrap">
    <nav class="pp-crumb" aria-label="Breadcrumb"><a href="/">Home</a><span aria-hidden="true">›</span><a href="/plans">Plans</a><span aria-hidden="true">›</span><span style="color:var(--st-text)">${nm}</span></nav>
    <div class="pp-hero">
      <div class="pp-media">${img}</div>
      <div>
        <span class="pp-badge">${platLabel}</span>
        <h1 class="pp-h1">${nm}</h1>
        <div class="pp-facts">
          <span class="pp-chip">${ppIcon('clock')} ${dur} validity</span>
          ${inst ? `<span class="pp-chip">${ppIcon('bolt')} Instant delivery</span>` : ''}
          <span class="pp-chip ${oos ? 'no' : 'ok'}">${ppIcon(oos ? 'box' : 'check')} ${oos ? 'Out of stock' : 'In stock'}</span>
        </div>
        <div class="pp-price"><b>₹${price}</b>${hasOrig ? `<span class="pp-orig">₹${Number(p.original_price_inr).toLocaleString('en-IN')}</span><span class="pp-off">${off}% OFF</span><span class="pp-save">You save ₹${save}</span>` : ''}</div>
        <div class="pp-cta">
          <button class="pp-btn pp-btn-primary" id="ph-guest" ${oos ? 'disabled' : ''}>${ppIcon('mail')} Buy Now</button>
          <a class="pp-btn pp-btn-ghost" id="ph-login" href="/my?buy=${p.id}" onclick="try{localStorage.setItem('pendingBuyPlanId','${p.id}')}catch(e){}">${ppIcon('lock')} Login &amp; Buy</a>
        </div>
        ${tgUrl ? `<a class="pp-tg" href="${esc(tgUrl)}" target="_blank" rel="noopener">${ppIcon('tg')} Prefer chat? Buy on our Telegram bot — instant auto-delivery (UPI &amp; USDT)</a>` : ''}
      </div>
    </div>
    <div class="pp-trust">
      <div class="t">${ppIcon('bolt')}<span>Instant delivery</span></div>
      <div class="t">${ppIcon('shield')}<span>100% genuine</span></div>
      <div class="t">${ppIcon('card')}<span>Secure payment</span></div>
      <div class="t">${ppIcon('headset')}<span>Friendly support</span></div>
    </div>
  </div>
  ${p.description ? `<div class="pp-sec"><h2>About ${nm}</h2><p class="pp-prose">${esc(p.description)}</p></div>` : ''}
  ${features.length ? `<div class="pp-sec"><h2>What you get</h2><div class="pp-feats">${features.map(f => `<div class="pp-feat">${ppIcon('check')}<span>${esc(f)}</span></div>`).join('')}</div></div>` : ''}
  <div class="pp-sec"><h2>How to get ${nm}</h2><div class="pp-steps">
    <div class="pp-step"><b>Choose &amp; pay</b><span>Tap Buy Now and pay securely via UPI, USDT or wallet balance.</span></div>
    <div class="pp-step"><b>Instant delivery</b><span>Your access details arrive on email &amp; WhatsApp${inst ? ' within seconds' : ' fast'}.</span></div>
    <div class="pp-step"><b>Start enjoying</b><span>Sign in and use ${nm} for its full ${dur} validity.</span></div>
  </div></div>
  <div class="pp-sec pp-faq"><h2>Frequently asked questions</h2>${faqs.map(f => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}</div>
  <div class="pp-sec"><a class="pp-more" href="/plans">${ppIcon('box')} Browse all ${site} plans</a></div>
</section>
<div class="pp-sticky">
  <div><div style="font-size:.7rem;color:var(--st-muted);line-height:1.1">${nm}</div><div style="font-weight:900;color:var(--st-accent);font-size:1.1rem">₹${price}${hasOrig ? ` <span style="font-size:.68rem;color:#10b981;font-weight:700">${off}% off</span>` : ''}</div></div>
  ${oos ? `<span class="pp-btn pp-btn-ghost" style="opacity:.55">Out of stock</span>` : `<a class="pp-btn pp-btn-primary" href="/my?buy=${p.id}" onclick="try{localStorage.setItem('pendingBuyPlanId','${p.id}')}catch(e){}">Buy Now ₹${price}</a>`}
</div>`;
}

// FAQPage structured data — uses the SAME Q&A shown on the page (Google policy).
function buildProductFaqJsonLd(p, siteName, tgUrl) {
  const faqs = productFaqs(p, siteName || 'our store', tgUrl);
  return `<script type="application/ld+json">${ldjson({
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: faqs.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  })}</script>`;
}

function buildProductJsonLd(p, base, siteName) {
  const url = `${base}/plans/${p.slug}`;
  const product = {
    '@context': 'https://schema.org', '@type': 'Product',
    name: p.name,
    ...(p.image_url ? { image: p.image_url } : {}),
    description: p.description || `Buy ${p.name} at ${siteName}. Instant digital delivery.`,
    ...(p.platform && p.platform.toLowerCase() !== 'other' ? { brand: { '@type': 'Brand', name: p.platform } } : {}),
    offers: {
      '@type': 'Offer',
      price: Number(p.price_inr),
      priceCurrency: 'INR',
      availability: p.stock === 0 ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock',
      url,
    },
  };
  const breadcrumb = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${base}/` },
      { '@type': 'ListItem', position: 2, name: 'Plans', item: `${base}/plans` },
      { '@type': 'ListItem', position: 3, name: p.name, item: url },
    ],
  };
  return `<script type="application/ld+json">${ldjson(product)}</script>\n<script type="application/ld+json">${ldjson(breadcrumb)}</script>`;
}

// /plans listing: CollectionPage + ItemList (helps Google understand the catalog
// and is eligible for list rich results) + a Home › Plans BreadcrumbList. The
// ItemList is capped to keep the HTML reasonable; the sitemap covers full
// discovery.
function buildPlansListJsonLd(products, base, siteName) {
  const collection = {
    '@context': 'https://schema.org', '@type': 'CollectionPage',
    name: `All Plans — ${siteName}`,
    url: `${base}/plans`,
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: products.length,
      itemListElement: products.slice(0, 100).map((p, i) => ({
        '@type': 'ListItem', position: i + 1,
        url: `${base}/plans/${p.slug}`,
        name: ((p.platform && p.platform.toLowerCase() !== 'other') ? `${p.platform} — ` : '') + p.name,
      })),
    },
  };
  const breadcrumb = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${base}/` },
      { '@type': 'ListItem', position: 2, name: 'Plans', item: `${base}/plans` },
    ],
  };
  return `<script type="application/ld+json">${ldjson(collection)}</script>\n<script type="application/ld+json">${ldjson(breadcrumb)}</script>`;
}

// ─── Helpers: simple server-rendered pages ────────────────────────────────────
// `storeTheme` is the currently-active theme slug (validated against
// ALLOWED_THEMES upstream). It is injected into the <html data-store-theme="…">
// attribute so themes.css overrides apply globally to blog / about / contact /
// privacy / terms / refund pages, the same way they do for the main storefront.
// Lightweight Markdown -> HTML for legacy/imported posts: headings, bullet & numbered
// lists, links, images, bold/italic/code, and paragraphs.
function mdToHtml(md) {
  const inline = (t) => String(t)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, '<img src="$2" alt="$1" loading="lazy">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const out = []; let para = [], list = null;
  const flushP = () => { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
  const flushL = () => { if (list) { out.push('</' + list + '>'); list = null; } };
  for (const line of lines) {
    const t = line.trim();
    if (!t) { flushP(); flushL(); continue; }
    let m;
    if ((m = t.match(/^(#{1,6})\s+(.+)$/))) { flushP(); flushL(); const h = m[1].length <= 2 ? 'h2' : (m[1].length === 3 ? 'h3' : 'h4'); out.push(`<${h}>${inline(m[2])}</${h}>`); }
    else if ((m = t.match(/^[-*+]\s+(.+)$/))) { flushP(); if (list !== 'ul') { flushL(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = t.match(/^\d+[.)]\s+(.+)$/))) { flushP(); if (list !== 'ol') { flushL(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
    else { flushL(); para.push(t); }
  }
  flushP(); flushL();
  return out.join('\n');
}

function buildBlogPostPage(post, siteName, ogImage, baseUrl, logos = {}, storeTheme = 'midnight-purple') {
  // Body may be rich HTML (visual editor / WordPress import) or legacy Markdown.
  const rawBody = String(post.body || '').replace(/<script[\s\S]*?<\/script>/gi, '');
  const looksHtml = /<(p|div|h[1-6]|img|ul|ol|li|a|br|strong|em|blockquote|figure|table)\b/i.test(rawBody);
  const bodyHtml = looksHtml ? rawBody : mdToHtml(rawBody);
  const canonical = `${baseUrl}/blog/${post.slug}`;
  const pubDate = (post.created_at || '').replace(' ', 'T').split('T')[0];
  const ldjson = JSON.stringify({ '@context':'https://schema.org','@type':'Article','headline':post.title,'datePublished':pubDate,'description':post.meta_desc||'','url':canonical });
  return `<!DOCTYPE html><html lang="en" data-theme="dark" data-store-theme="${esc(storeTheme)}">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(post.title)} — ${esc(siteName)}</title>
<meta name="description" content="${esc(post.meta_desc || '')}">
<meta property="og:title" content="${esc(post.title)}">
<meta property="og:type" content="article">
${ogImage ? `<meta property="og:image" content="${esc(ogImage)}">` : ''}
<link rel="canonical" href="${esc(canonical)}">
<link rel="stylesheet" href="/style.css">
<link rel="stylesheet" href="/store/themes.css">
${SHARED_STYLES}
<script type="application/ld+json">${ldjson}</script>
</head>
<body>
${spNav(siteName, logos.light, logos.dark)}
<main class="sp-main">
<div class="blog-post-page">
<h1>${esc(post.title)}</h1>
<time datetime="${pubDate}">${pubDate}</time>
<div class="blog-body">${bodyHtml}</div>
<p style="margin-top:2rem"><a href="/blog" style="color:var(--sp-muted);font-size:.875rem">← Back to Blog</a></p>
</div>
</main>
${spFooter(siteName)}
</body></html>`;
}

function buildBlogIndexPage(posts, siteName, seoDesc, baseUrl, logos = {}, storeTheme = 'midnight-purple', seoTop = '', seoBottom = '') {
  const items = posts.map(p => {
    const d = (p.created_at || '').replace(' ', 'T').split('T')[0];
    return `<article class="blog-card">
<div class="bc-meta">${d}</div>
<h2><a href="/blog/${esc(p.slug)}">${esc(p.title)}</a></h2>
<div class="bc-desc">${esc(p.meta_desc || '')}</div>
<a class="bc-readmore" href="/blog/${esc(p.slug)}">Read More →</a>
</article>`;
  }).join('');
  const desc = seoDesc || `Read the latest articles and guides from ${siteName}.`;
  const emptyHtml = `<div class="blog-empty"><div class="blog-empty-icon">✍️</div><p>No posts yet. Check back soon!</p></div>`;
  return `<!DOCTYPE html><html lang="en" data-theme="dark" data-store-theme="${esc(storeTheme)}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Blog — ${esc(siteName)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(baseUrl)}/blog">
<link rel="stylesheet" href="/style.css">
<link rel="stylesheet" href="/store/themes.css">
${SHARED_STYLES}
</head>
<body>
${spNav(siteName, logos.light, logos.dark)}
<main class="sp-main">
<div class="blog-page-header">
  <h1>Blog</h1>
  <p>${esc(desc)}</p>
</div>
${seoTop ? `<section class="blog-seo-section">${seoTop}</section>` : ''}
<div class="blog-grid">${items || emptyHtml}</div>
${seoBottom ? `<section class="blog-seo-section">${seoBottom}</section>` : ''}
</main>
${spFooter(siteName)}
</body></html>`;
}

function buildSimplePage(name, siteName, logos = {}, storeTheme = 'midnight-purple') {
  const titles = { about:'About Us', contact:'Contact', privacy:'Privacy Policy', terms:'Terms of Service', refund:'Refund Policy' };
  const title = titles[name] || name;
  return `<!DOCTYPE html><html lang="en" data-theme="dark" data-store-theme="${esc(storeTheme)}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — ${esc(siteName)}</title>
<link rel="stylesheet" href="/style.css">
<link rel="stylesheet" href="/store/themes.css">
${SHARED_STYLES}
</head>
<body>
${spNav(siteName, logos.light, logos.dark)}
<main class="sp-main">
<div class="legal-page">
<h1>${esc(title)}</h1>
<div class="legal-body"><p>Content coming soon. Please check back later.</p></div>
</div>
</main>
${spFooter(siteName)}
</body></html>`;
}

// ─── Start ────────────────────────────────────────────────────────────────────
function buildLegalPage(page, siteName, logos = {}, storeTheme = 'midnight-purple') {
  const baseUrl = cfg.baseUrl;
  return `<!DOCTYPE html><html lang="en" data-theme="dark" data-store-theme="${esc(storeTheme)}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(page.title)} — ${esc(siteName)}</title>
<meta name="description" content="${esc(page.title)} for ${esc(siteName)}">
<link rel="canonical" href="${esc(baseUrl)}/${page.slug}">
<link rel="stylesheet" href="/style.css">
<link rel="stylesheet" href="/store/themes.css">
${SHARED_STYLES}
</head>
<body>
${spNav(siteName, logos.light, logos.dark)}
<main class="sp-main">
<div class="legal-page">
<h1>${esc(page.title)}</h1>
<div class="legal-updated">Last updated: ${(page.updated_at||'').split(' ')[0] || 'N/A'}</div>
<div class="legal-body">${page.body || '<p>Content coming soon.</p>'}</div>
</div>
</main>
${spFooter(siteName)}
</body></html>`;
}

// ─── Public "Become a Reseller" page ─────────────────────────────────────────
// Server-rendered apply page linked from the footer. The reseller apply/status
// endpoints (user-api) require a logged-in customer, so the page branches:
// signed-out → prompt to sign in; signed-in → Apply button or current status.
function buildResellerPage(siteName, logos = {}, storeTheme = 'midnight-purple') {
  const baseUrl = cfg.baseUrl;
  const btn = 'display:inline-block;background:var(--sp-btn);color:#fff;padding:.7rem 1.35rem;border-radius:50px;font-weight:700;text-decoration:none;border:0;cursor:pointer;font-size:.95rem';
  return `<!DOCTYPE html><html lang="en" data-theme="dark" data-store-theme="${esc(storeTheme)}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Become a Reseller — ${esc(siteName)}</title>
<meta name="description" content="Apply to become a reseller at ${esc(siteName)} — wholesale pricing on digital subscriptions, AI tools and software, with priority support.">
<link rel="canonical" href="${esc(baseUrl)}/reseller">
<link rel="stylesheet" href="/style.css">
<link rel="stylesheet" href="/store/themes.css">
${SHARED_STYLES}
</head>
<body>
${spNav(siteName, logos.light, logos.dark)}
<main class="sp-main">
<div class="legal-page">
<h1>Become a Reseller</h1>
<div class="legal-body">
<p>Run your own business on top of ${esc(siteName)}. Approved resellers get <strong>wholesale pricing</strong>, optional <strong>custom per-product rates</strong>, and priority support — ideal for agencies, shops and bulk buyers.</p>
<ul>
  <li>💸 Wholesale / discounted pricing applied automatically at checkout</li>
  <li>🏷️ Optional custom per-product prices set by our team</li>
  <li>⚡ Same instant digital delivery &amp; replacement warranty</li>
  <li>💬 Priority WhatsApp support</li>
</ul>
</div>
<div id="reseller-box" style="margin-top:1.75rem"><p style="color:var(--sp-muted)">Loading…</p></div>
</div>
</main>
${spFooter(siteName)}
<script>(function(){
  var box=document.getElementById('reseller-box');
  var BTN=${JSON.stringify(btn)};
  function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function card(h){box.innerHTML='<div style="background:var(--sp-card);border:1px solid var(--sp-border);border-radius:16px;padding:1.5rem">'+h+'</div>';}
  fetch('/user/api/me',{credentials:'include'}).then(function(r){
    if(!r.ok){ card('<h3 style="margin:0 0 .5rem">Sign in to apply</h3><p style="color:var(--sp-muted);margin:0 0 1.1rem">You need a free account to apply as a reseller.</p><a href="/my" style="'+BTN+'">Sign in / Create account →</a>'); return null; }
    return fetch('/user/api/reseller/status',{credentials:'include'}).then(function(r){return r.json();});
  }).then(function(s){
    if(!s) return;
    if(!s.status){
      card('<h3 style="margin:0 0 .5rem">Ready to apply?</h3><p style="color:var(--sp-muted);margin:0 0 1.1rem">Submit your application and our team will review it shortly.</p><button id="rs-apply" style="'+BTN+'">Apply as Reseller</button><div id="rs-msg" style="margin-top:.9rem"></div>');
      document.getElementById('rs-apply').onclick=function(){
        var b=this; b.disabled=true; b.textContent='Submitting…';
        fetch('/user/api/reseller/apply',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:'{}'}).then(function(r){return r.json();}).then(function(d){
          card('<h3 style="margin:0 0 .5rem">✅ Application submitted</h3><p style="color:var(--sp-muted);margin:0">'+esc(d.message||'We will review your application shortly.')+'</p>');
        }).catch(function(){ var m=document.getElementById('rs-msg'); if(m){m.innerHTML='<span style="color:#ff6b6b">Something went wrong — please try again.</span>';} b.disabled=false; b.textContent='Apply as Reseller'; });
      };
    } else if(s.status==='approved'){
      card('<h3 style="margin:0 0 .5rem">🎉 You are an approved reseller</h3><p style="color:var(--sp-muted);margin:0 0 1.1rem">Reseller discount: <strong>'+(s.discount_percent||0)+'%</strong> — applied automatically at checkout.</p><a href="/plans" style="'+BTN+'">Browse catalog →</a>');
    } else if(s.status==='pending'){
      card('<h3 style="margin:0 0 .5rem">⏳ Application under review</h3><p style="color:var(--sp-muted);margin:0">Your reseller application is pending approval. We will be in touch soon.</p>');
    } else {
      card('<h3 style="margin:0 0 .5rem">Application '+esc(s.status)+'</h3><p style="color:var(--sp-muted);margin:0">Please contact support if you have any questions.</p>');
    }
  }).catch(function(){ card('<p style="color:var(--sp-muted)">Could not load reseller status. Please refresh.</p>'); });
})();</script>
</body></html>`;
}

async function start() {
  await getDb(); // init DB before accepting requests

  // Start background workers
  try { require('./delivery-worker').startDeliveryWorker(); } catch (e) { console.error('delivery-worker error:', e.message); }
  try { require('./bot-supplier').startBotSync(); } catch (e) { console.error('bot-supplier error:', e.message); }
  try { require('./renewal-worker').startRenewalWorker(); } catch (e) { console.error('renewal-worker error:', e.message); }
  try { require('./recovery-worker').startRecoveryWorker(); } catch (e) { console.error('recovery-worker error:', e.message); }
  try { require('./autopost-worker').startAutopostWorker(); } catch (e) { console.error('autopost-worker error:', e.message); }
  // ResellKeys auto-fulfillment worker removed — scrape-only integration now.
  try { require('./imap-verify').startImapWorker(); } catch (e) { console.error('imap-verify error:', e.message); }
  try { require('./backup-worker').startBackupWorker(); } catch (e) { console.error('backup-worker error:', e.message); }

  // WhatsApp Bot + WA worker
  try {
    const waBot = require('./wa-bot');
    waBot.startWatchdog();
    const { getSettingSync } = require('./db');
    if (getSettingSync('wa_enabled') === '1') {
      waBot.connect().catch(e => console.error('WA connect error:', e.message));
    }
  } catch (e) { console.error('wa-bot error:', e.message); }
  try { require('./wa-worker').startWaWorker(); } catch (e) { console.error('wa-worker error:', e.message); }

  // Catch-all 404 — last route before listen. Injects the active theme into the
  // 404.html so the cinematic skin renders correctly even on unknown URLs.
  app.use(async (req, res) => {
    try {
      const storeTheme = await getActiveTheme();
      let html = readStoreHtml('404.html');
      html = html.replace(/data-store-theme="[^"]*"/, `data-store-theme="${storeTheme}"`);
      res.status(404).type('text/html').send(html);
    } catch {
      res.status(404).type('text/plain').send('Not found');
    }
  });

  app.listen(cfg.port, () => {
    console.log(`OTT Store running on http://localhost:${cfg.port}`);
    console.log(`  Store:  http://localhost:${cfg.port}/`);
    console.log(`  Portal: http://localhost:${cfg.port}/my`);
    console.log(`  Admin:  http://localhost:${cfg.port}/admin`);
  });
}

start().catch(e => { console.error('Startup error:', e); process.exit(1); });
