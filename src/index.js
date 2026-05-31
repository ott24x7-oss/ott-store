'use strict';
const express = require('express');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const cfg = require('./config');
const { getDb, getSetting, all, get } = require('./db');
const { apiLimiter } = require('./security');

const app = express();

// Cloudflare in front of Railway in front of the app = 2 trusted hops. Setting
// to `true` lets Express use the leftmost X-Forwarded-For value (the real
// client). Without this, req.ip resolves to the Cloudflare proxy IP and the
// per-IP rate limiters never trip (every request looks like the same client).
app.set('trust proxy', true);
app.use(compression());

// Baseline security headers on every response. CSP is intentionally omitted —
// the storefront depends on inline scripts/handlers a strict policy would break;
// add a report-only CSP separately if you want to tighten further. HSTS is set
// only in production (the public edge is HTTPS via Cloudflare); no
// includeSubDomains/preload, to avoid affecting any non-HTTPS subdomain.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser(cfg.sessionSecret));
const { ensureCsrfToken } = require('./security');
app.use(ensureCsrfToken);
app.use(apiLimiter);

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
app.use('/data/uploads', express.static(path.join(__dirname, '..', 'data', 'uploads')));

// ─── CORS preflight for cross-origin import endpoint ─────────────────────────
app.options('/admin/api/wa-offers-batch-import', (req, res) => {
  res.set('Access-Control-Allow-Origin', 'https://store.watshop.in');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Import-Token');
  res.set('Access-Control-Allow-Methods', 'POST');
  res.status(204).end();
});

// ─── API routes ───────────────────────────────────────────────────────────────
app.use('/user/api', require('./user-api'));
app.use('/admin/api', require('./admin-api'));

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
app.get('/sw.js', async (req, res) => {
  const vapidKey = await getSetting('vapid_public_key').catch(() => '');
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(`
const CACHE='ott-v6';
const STATIC=['/','index.html'];
self.addEventListener('install',e=>{self.skipWaiting()});
self.addEventListener('activate',e=>{clients.claim()});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET'||e.request.url.includes('/api/'))return;
  e.respondWith(fetch(e.request).catch(()=>caches.match(e.request)));
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
app.get('/robots.txt', async (req, res) => {
  try {
    const base = ((await getSetting('base_url')) || cfg.baseUrl).replace(/\/$/, '');
    let txt = await getSetting('robots_txt') || 'User-agent: *\nAllow: /';
    if (!/^\s*sitemap:/im.test(txt)) txt += `\nSitemap: ${base}/sitemap.xml`;
    res.type('text/plain').send(txt);
  } catch { res.type('text/plain').send('User-agent: *\nAllow: /'); }
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
    const products = all(db, `SELECT slug, created_at FROM plans WHERE active=1 AND slug IS NOT NULL AND slug != ''`);
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
    const [siteName, seoDesc, baseUrl, logos, storeTheme] = await Promise.all([
      getSetting('site_name'), getSetting('seo_blog_desc'), getSetting('base_url'), getLogoUrls(), getActiveTheme(),
    ]);
    res.send(buildBlogIndexPage(posts, siteName || 'OTT Store', seoDesc || '', baseUrl || cfg.baseUrl, logos, storeTheme));
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
    let html = fs.readFileSync(path.join(__dirname, '..', 'public', 'store', 'my.html'), 'utf8');
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

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html')));

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

// ─── /plans — product listing page (server-rendered so theme is correct on first paint) ──
app.get('/plans', async (req, res) => {
  try {
    const storeTheme = await getActiveTheme();
    const base = ((await getSetting('base_url')) || cfg.baseUrl).replace(/\/$/, '');
    const db = await getDb();
    const siteName = (await getSetting('site_name')) || 'OTT Store';
    const products = all(db, `SELECT slug, platform, name FROM plans WHERE active=1 AND slug IS NOT NULL AND slug != '' ORDER BY sort_order ASC, id ASC`);
    let html = fs.readFileSync(path.join(__dirname, '..', 'public', 'store', 'plans.html'), 'utf8');
    html = html.replace(/data-store-theme="[^"]*"/, `data-store-theme="${storeTheme}"`);
    const headInject = `<link rel="canonical" href="${esc(base)}/plans">\n${buildPlansListJsonLd(products, base, siteName)}`;
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
    let html = fs.readFileSync(path.join(__dirname, '..', 'public', 'store', 'plans.html'), 'utf8');
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
    const titleText = `${platPrefix}${plan.name} | ${siteName}`;
    const descText = `Buy ${platPrefix}${plan.name} at ${siteName} — ₹${Number(plan.price_inr).toLocaleString('en-IN')}. ${plan.delivery_type === 'instant' ? 'Instant digital delivery.' : 'Fast digital delivery.'}`;
    const ogImg = plan.image_url || (await getSetting('seo_og_image')) || '';

    // Per-product <title> + <meta description> (C1/H3)
    html = html
      .replace(/<title>[^<]*<\/title>/, `<title>${esc(titleText)}</title>`)
      .replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${esc(descText)}">`);
    // Canonical + Open Graph + Product/Breadcrumb JSON-LD + deep-link globals (C2/C4/H1)
    const headInject = [
      `<link rel="canonical" href="${esc(url)}">`,
      `<meta property="og:title" content="${esc(plan.name)}">`,
      `<meta property="og:type" content="product">`,
      `<meta property="og:url" content="${esc(url)}">`,
      ogImg ? `<meta property="og:image" content="${esc(ogImg)}">` : '',
      `<meta property="product:price:amount" content="${Number(plan.price_inr)}">`,
      `<meta property="product:price:currency" content="INR">`,
      buildProductJsonLd(plan, base, siteName),
      `<script>window.__PLAN_SLUG__="${esc(plan.slug)}";window.__PLAN_ID__=${plan.id};window.__HAS_PRODUCT_HERO__=1;</script>`,
    ].filter(Boolean).join('\n');
    html = html.replace('</head>', headInject + '\n</head>');
    // Inject the server-rendered product hero above the catalog and demote the
    // catalog's "Browse All Subscriptions" heading to H2 so the product name is
    // the page's single H1 (C1).
    html = html
      .replace('<h1>Browse All <span>Subscriptions</span></h1>', '<h2>Browse All <span>Subscriptions</span></h2>')
      .replace('<!-- Page Header -->', `${buildProductHero(plan)}\n<!-- Page Header -->`);
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
    // MovieVerse gets its own bespoke home file (heavy cinema markup).
    // All other themes share index.html with a data-store-theme attr swap so
    // the same CSS palette cascade we use on /plans + /my applies to /, too.
    const homeFile = storeTheme === 'movieverse' ? 'movieverse-home.html' : 'index.html';
    let html = fs.readFileSync(path.join(__dirname, '..', 'public', 'store', homeFile), 'utf8');
    // For the default index.html, swap the hardcoded data-store-theme attribute
    // to the current setting so the 22 non-MovieVerse themes also render.
    if (homeFile === 'index.html') {
      html = html.replace(/data-store-theme="[^"]*"/, `data-store-theme="${storeTheme}"`);
    }
    html = html
      .replace(/<title id="page-title">[^<]*<\/title>/, `<title id="page-title">${esc(seoTitle || name + ' — Buy Premium Subscriptions Online')}</title>`)
      .replace(/(<meta name="description" id="meta-desc" content=")[^"]*"/, `$1${esc(seoDesc || 'Get Netflix, Amazon Prime, Disney+ and more at lowest prices. Instant delivery.')}"`)
      .replace(/(<meta id="meta-kw" name="keywords" content=")[^"]*"/, `$1${esc(seoKw || 'ott subscription, netflix, amazon prime, disney plus')}"`)
      .replace(/(<meta id="og-title" property="og:title" content=")[^"]*"/, `$1${esc(name)}"`)
      .replace(/(<meta id="og-img" property="og:image" content=")[^"]*"/, `$1${esc(ogImg || '')}"`)
      .replace(/(<meta name="twitter:card" content=")[^"]*"/, `$1${esc(twitterCard || 'summary_large_image')}"`)
      .replace(/<script id="ld-org"[^>]*>[^<]*<\/script>/,
        `<script id="ld-org" type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Store', name, url: base })}</script>`);
    const inject = [
      `<link rel="canonical" href="${esc(base)}/">`,
      gscCode ? `<meta name="google-site-verification" content="${esc(gscCode)}">` : '',
      bingCode ? `<meta name="msvalidate.01" content="${esc(bingCode)}">` : '',
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

function spNav(siteName, logoLight, logoDark) {
  const logoSrc = logoDark || logoLight;
  const logoHtml = logoSrc
    ? `<img src="${esc(logoSrc)}" alt="${esc(siteName)}" style="max-height:40px;max-width:180px;object-fit:contain">`
    : esc(siteName);
  return `<nav class="sp-nav"><div class="sp-nav-inner">
<a href="/" class="sp-logo" id="sp-nav-logo">${logoHtml}</a>
<div class="sp-links">
  <a href="/">Home</a><a href="/plans">Plans</a><a href="/blog">Blog</a>
  <a href="/my" class="sp-cta">My Account</a>
</div>
</div></nav>`;
}

function spFooter(siteName) {
  const yr = new Date().getFullYear();
  return `<footer class="sp-footer"><div class="sp-footer-inner">
<div class="sp-footer-top">
  <div><div class="sp-footer-brand">${esc(siteName)}</div><div class="sp-footer-tagline">Premium OTT Subscriptions · Instant Delivery</div></div>
  <div class="sp-footer-links">
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
    if (sub) html = html.replace(/(<p id="mv-hero-sub">)[\s\S]*?(<\/p>)/, `$1${esc(sub)}$2`);

    // Stats
    html = html.replace(/(<strong id="mv-stat-products">)[^<]*(<\/strong>)/, `$1${plans.length}+$2`);
    html = html.replace(/(<strong id="mv-stat-categories">)[^<]*(<\/strong>)/, `$1${esc(statCategories)}$2`);

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

    const top2 = plans.filter(p => p.stock !== 0).slice(0, 2);
    const heroPlansHtml = top2.map(p =>
      `<div class="plan-card">${thumb(p, 'plan-card-thumb')}<div style="flex:1;min-width:0"><strong>${esc(p.platform || '')} ${esc(p.name || '')}</strong><small>${esc(durOf(p))} · Fast activation</small></div><span class="price-pill">${fmtInr(p.price_inr)}</span></div>`).join('');
    html = html.replace('<div id="mv-hero-plans"></div>', `<div id="mv-hero-plans">${heroPlansHtml}</div>`);

    const top4 = plans.slice(0, 4);
    const productListHtml = top4.map(p =>
      `<a class="product-row" data-buy-id="${p.id}" href="/my?buy=${p.id}">${thumb(p, 'product-thumb')}<div style="flex:1;min-width:0"><strong>${esc(p.platform || '')} ${esc(p.name || '')}</strong><small>${esc(durOf(p))} · Instant delivery</small></div><span class="price-pill">${fmtInr(p.price_inr)}</span></a>`).join('');
    html = html.replace('<div class="product-row"><div><strong>Loading plans…</strong><small>Fetching from catalog</small></div></div>', productListHtml);

    return html;
  } catch {
    return html;
  }
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
function buildProductHero(p) {
  let features = [];
  try { features = JSON.parse(p.features || '[]'); } catch {}
  if (!Array.isArray(features)) features = [];
  const dur = productDur(p);
  const price = Number(p.price_inr).toLocaleString('en-IN');
  const hasOrig = p.original_price_inr && p.original_price_inr > p.price_inr;
  const off = hasOrig ? Math.round((1 - p.price_inr / p.original_price_inr) * 100) : 0;
  const oos = p.stock === 0;
  const platLabel = (p.platform && p.platform.toLowerCase() !== 'other') ? esc(p.platform) : 'Digital Product';
  const img = p.image_url
    ? `<img src="${esc(p.image_url)}" alt="${esc((p.platform ? p.platform + ' ' : '') + p.name)}" style="max-width:170px;max-height:120px;object-fit:contain">`
    : `<div style="font-size:3rem">📦</div>`;
  return `
<section id="product-hero" style="max-width:980px;margin:0 auto;padding:1.5rem 1.5rem 0">
  <nav aria-label="Breadcrumb" style="font-size:.8rem;color:var(--st-muted);margin-bottom:1rem">
    <a href="/" style="color:var(--st-muted);text-decoration:none">Home</a> ›
    <a href="/plans" style="color:var(--st-muted);text-decoration:none">Plans</a> ›
    <span style="color:var(--st-text)">${esc(p.name)}</span>
  </nav>
  <div style="display:flex;gap:1.5rem;flex-wrap:wrap;align-items:center;background:var(--st-card-solid);border:1.5px solid var(--st-border);border-radius:18px;padding:1.5rem">
    <div style="flex:0 0 auto;width:190px;height:130px;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.2);border-radius:12px">${img}</div>
    <div style="flex:1;min-width:240px">
      <div style="font-size:.74rem;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--st-accent)">${platLabel}</div>
      <h1 style="font-size:1.55rem;font-weight:900;margin:.2rem 0 .45rem;line-height:1.2">${esc(p.name)}</h1>
      <div style="font-size:.82rem;color:var(--st-muted);margin-bottom:.6rem">⏱ ${dur} validity${p.delivery_type === 'instant' ? ' · ⚡ Instant delivery' : ''} · <strong style="color:${oos ? '#ef4444' : '#10b981'}">${oos ? 'Out of stock' : 'In stock'}</strong></div>
      <div style="display:flex;align-items:baseline;gap:.55rem;margin-bottom:.9rem">
        <span style="font-size:1.85rem;font-weight:900;color:var(--st-accent)">₹${price}</span>
        ${hasOrig ? `<span style="text-decoration:line-through;color:var(--st-muted);font-size:.95rem">₹${Number(p.original_price_inr).toLocaleString('en-IN')}</span><span style="background:rgba(16,185,129,.15);color:#10b981;border-radius:6px;padding:.12rem .5rem;font-size:.72rem;font-weight:800">${off}% OFF</span>` : ''}
      </div>
      <div style="display:flex;gap:.6rem;flex-wrap:wrap">
        <a class="splan-btn" id="ph-login" href="/my?buy=${p.id}" onclick="try{localStorage.setItem('pendingBuyPlanId','${p.id}')}catch(e){}" style="width:auto;padding:.7rem 1.25rem;text-decoration:none;display:inline-block">🔐 Login to Checkout</a>
        <button class="splan-btn" id="ph-guest" ${oos ? 'disabled' : ''} style="width:auto;padding:.7rem 1.25rem;background:linear-gradient(135deg,#7c3aed,#6d28d9)">📧 Guest Checkout</button>
      </div>
    </div>
  </div>
  ${p.description ? `<p style="color:var(--st-muted);font-size:.92rem;line-height:1.6;margin:1.1rem 0 0">${esc(p.description)}</p>` : ''}
  ${features.length ? `<ul style="margin:1rem 0 0;padding-left:1.25rem;color:var(--st-text);font-size:.9rem;line-height:1.75">${features.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
  <p style="margin:1.25rem 0 0;font-size:.85rem"><a href="/plans" style="color:var(--st-accent);text-decoration:none">↓ Browse all plans</a></p>
</section>`;
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
function buildBlogPostPage(post, siteName, ogImage, baseUrl, logos = {}, storeTheme = 'midnight-purple') {
  const bodyHtml = post.body
    .replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>');
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
<div class="blog-body"><p>${bodyHtml}</p></div>
<p style="margin-top:2rem"><a href="/blog" style="color:var(--sp-muted);font-size:.875rem">← Back to Blog</a></p>
</div>
</main>
${spFooter(siteName)}
</body></html>`;
}

function buildBlogIndexPage(posts, siteName, seoDesc, baseUrl, logos = {}, storeTheme = 'midnight-purple') {
  const items = posts.map(p => {
    const d = (p.created_at || '').replace(' ', 'T').split('T')[0];
    return `<article class="blog-card">
<div class="bc-meta">${d}</div>
<h2><a href="/blog/${esc(p.slug)}">${esc(p.title)}</a></h2>
<div class="bc-desc">${esc(p.meta_desc || '')}</div>
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
<div class="blog-grid">${items || emptyHtml}</div>
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

async function start() {
  await getDb(); // init DB before accepting requests

  // Start background workers
  try { require('./delivery-worker').startDeliveryWorker(); } catch (e) { console.error('delivery-worker error:', e.message); }
  try { require('./renewal-worker').startRenewalWorker(); } catch (e) { console.error('renewal-worker error:', e.message); }
  try { require('./autopost-worker').startAutopostWorker(); } catch (e) { console.error('autopost-worker error:', e.message); }
  try { require('./fulfillment-worker').startFulfillmentWorker(); } catch (e) { console.error('fulfillment-worker error:', e.message); }
  try { require('./imap-verify').startImapWorker(); } catch (e) { console.error('imap-verify error:', e.message); }

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
      let html = fs.readFileSync(path.join(__dirname, '..', 'public', 'store', '404.html'), 'utf8');
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
