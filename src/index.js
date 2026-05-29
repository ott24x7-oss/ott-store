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

app.set('trust proxy', 1);
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser(cfg.sessionSecret));
app.use(apiLimiter);

// Static files
app.use(express.static(path.join(__dirname, '..', 'public')));
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
    const txt = await getSetting('robots_txt') || 'User-agent: *\nAllow: /';
    res.type('text/plain').send(txt);
  } catch { res.type('text/plain').send('User-agent: *\nAllow: /'); }
});

// ─── SEO: sitemap.xml ─────────────────────────────────────────────────────────
app.get('/sitemap.xml', async (req, res) => {
  try {
    const db = await getDb();
    const baseUrl = await getSetting('base_url') || cfg.baseUrl;
    const posts = all(db, `SELECT slug, created_at FROM blog_posts WHERE published=1`);
    const staticPages = ['/', '/plans', '/blog', '/about', '/contact', '/privacy', '/terms', '/refund'];
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;
    for (const p of staticPages) {
      xml += `\n  <url><loc>${baseUrl}${p}</loc><changefreq>weekly</changefreq></url>`;
    }
    for (const post of posts) {
      const lastmod = (post.created_at || '').replace(' ', 'T').split('T')[0];
      xml += `\n  <url><loc>${baseUrl}/blog/${post.slug}</loc><lastmod>${lastmod}</lastmod><changefreq>monthly</changefreq></url>`;
    }
    xml += '\n</urlset>';
    res.type('application/xml').send(xml);
  } catch (e) { res.status(500).send('Error generating sitemap'); }
});

// ─── Public storefront pages ──────────────────────────────────────────────────
app.get('/blog/:slug', async (req, res) => {
  try {
    const db = await getDb();
    const post = get(db, `SELECT * FROM blog_posts WHERE slug=? AND published=1`, [req.params.slug]);
    if (!post) return res.status(404).sendFile(path.join(__dirname, '..', 'public', '404.html'));
    const [siteName, ogImage, baseUrl, logos] = await Promise.all([
      getSetting('site_name'), getSetting('seo_og_image'), getSetting('base_url'), getLogoUrls(),
    ]);
    res.send(buildBlogPostPage(post, siteName || 'OTT Store', post.og_image || ogImage || '', baseUrl || cfg.baseUrl, logos));
  } catch (e) { res.status(500).send('Server error'); }
});

app.get('/blog', async (req, res) => {
  try {
    const db = await getDb();
    const posts = all(db, `SELECT id,slug,title,meta_desc,created_at FROM blog_posts WHERE published=1 ORDER BY created_at DESC`);
    const [siteName, seoDesc, baseUrl, logos] = await Promise.all([
      getSetting('site_name'), getSetting('seo_blog_desc'), getSetting('base_url'), getLogoUrls(),
    ]);
    res.send(buildBlogIndexPage(posts, siteName || 'OTT Store', seoDesc || '', baseUrl || cfg.baseUrl, logos));
  } catch (e) { res.status(500).send('Server error'); }
});

// SPA routes → serve their HTML files
app.get('/my', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'store', 'my.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html')));

// Public static pages — served from DB legal_pages table
const staticRoutes = { '/about': 'about', '/contact': 'contact', '/privacy': 'privacy', '/terms': 'terms', '/refund': 'refund' };
for (const [route, slug] of Object.entries(staticRoutes)) {
  app.get(route, async (req, res) => {
    try {
      const db = await getDb();
      const page = db ? (() => { const { get: dbGet } = require('./db'); return dbGet(db, `SELECT * FROM legal_pages WHERE slug=?`, [slug]); })() : null;
      const [siteName, logos] = await Promise.all([getSetting('site_name'), getLogoUrls()]);
      const name = siteName || 'OTT Store';
      if (page) return res.send(buildLegalPage(page, name, logos));
      const filePath = path.join(__dirname, '..', 'public', 'store', `${slug}.html`);
      if (fs.existsSync(filePath)) return res.sendFile(filePath);
      res.send(buildSimplePage(slug, name, logos));
    } catch {
      res.send(buildSimplePage(slug, 'OTT Store', { light: '', dark: '' }));
    }
  });
}

// ─── /plans — separate product listing page ──────────────────────────────────
app.get('/plans', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'store', 'plans.html'));
});

// Storefront root — server-render meta tags for SEO crawlers
app.get('/', async (req, res) => {
  try {
    const [siteName, seoTitle, seoDesc, seoKw, ogImg, gscCode, bingCode, twitterCard, baseUrl] = await Promise.all([
      getSetting('site_name'), getSetting('seo_home_title'), getSetting('seo_home_desc'),
      getSetting('seo_home_keywords'), getSetting('seo_og_image'), getSetting('seo_gsc_verification'),
      getSetting('seo_bing_verification'), getSetting('seo_twitter_card'), getSetting('base_url'),
    ]);
    const name = siteName || 'OTT Store';
    const base = baseUrl || cfg.baseUrl;
    let html = fs.readFileSync(path.join(__dirname, '..', 'public', 'store', 'index.html'), 'utf8');
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
  var t=localStorage.getItem('theme')||(window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');
  document.documentElement.setAttribute('data-theme',t);
  document.documentElement.setAttribute('data-store-theme','midnight-purple');
})();</script>
<link rel="stylesheet" href="/store/themes.css">
<style>
:root{
  --sp-bg:#080b14;--sp-card:rgba(255,255,255,.04);--sp-border:rgba(255,255,255,.09);
  --sp-text:#f1f5f9;--sp-muted:#94a3b8;--sp-nav:rgba(8,11,20,.88);
  --sp-accent:#7c3aed;--sp-accent2:#4f46e5;
  --sp-btn:linear-gradient(135deg,#7c3aed,#4f46e5);
}
*{box-sizing:border-box;margin:0;padding:0}
html{background:var(--sp-bg)}
body{font-family:'Inter',system-ui,-apple-system,sans-serif;background:var(--sp-bg);color:var(--sp-text);min-height:100vh;overflow-x:hidden}
body::before{content:'';position:fixed;inset:0;z-index:-1;
  background:radial-gradient(ellipse 80% 50% at 20% -10%,rgba(124,58,237,.18) 0%,transparent 60%),
             radial-gradient(ellipse 60% 40% at 80% 110%,rgba(79,70,229,.12) 0%,transparent 60%);
  pointer-events:none}
a{color:#a78bfa;text-decoration:none}
a:hover{color:#c4b5fd;text-decoration:underline}
/* Cinematic nav */
.sp-nav{position:sticky;top:0;z-index:100;background:var(--sp-nav);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-bottom:1px solid var(--sp-border);padding:.8rem 1.5rem}
.sp-nav-inner{max-width:1200px;margin:0 auto;display:flex;align-items:center;gap:1.5rem}
.sp-logo{font-size:1.35rem;font-weight:900;background:var(--sp-btn);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;text-decoration:none;white-space:nowrap;display:flex;align-items:center}
.sp-logo img{max-height:40px;max-width:180px;object-fit:contain;display:block;-webkit-text-fill-color:initial;background:none}
.sp-logo:hover{opacity:.85;text-decoration:none}
.sp-links{display:flex;gap:.25rem;margin-left:auto;align-items:center}
.sp-links a{color:var(--sp-muted);font-size:.875rem;font-weight:500;padding:.4rem .85rem;border-radius:8px;transition:all .15s;text-decoration:none}
.sp-links a:hover{color:var(--sp-text);background:rgba(124,58,237,.1);text-decoration:none}
.sp-links .sp-cta{background:var(--sp-btn);color:#fff;padding:.45rem 1.1rem;border-radius:50px;font-weight:700;font-size:.85rem}
.sp-links .sp-cta:hover{opacity:.85;text-decoration:none;color:#fff}
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
.blog-card:hover{border-color:var(--sp-accent);transform:translateY(-3px);box-shadow:0 8px 32px rgba(124,58,237,.18)}
.blog-card h2{font-size:1.05rem;font-weight:700;line-height:1.4;margin-bottom:.5rem}
.blog-card h2 a{color:var(--sp-text);text-decoration:none}
.blog-card h2 a:hover{color:#a78bfa}
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
@media(max-width:600px){.sp-footer-top{grid-template-columns:1fr}.blog-grid{grid-template-columns:1fr}.blog-post-page h1{font-size:1.5rem}.sp-links a:not(.sp-cta){display:none}}
</style>`;

function spNav(siteName, logoLight, logoDark) {
  const logoHtml = (logoLight || logoDark)
    ? `<img src="${esc(logoLight||logoDark)}" class="sp-logo-light" alt="${esc(siteName)}" style="max-height:40px;max-width:180px;object-fit:contain"><img src="${esc(logoDark||logoLight)}" class="sp-logo-dark" alt="${esc(siteName)}" style="max-height:40px;max-width:180px;object-fit:contain;display:none">`
    : esc(siteName);
  return `<nav class="sp-nav"><div class="sp-nav-inner">
<a href="/" class="sp-logo" id="sp-nav-logo">${logoHtml}</a>
<div class="sp-links">
  <a href="/">Home</a><a href="/plans">Plans</a><a href="/blog">Blog</a>
  <a href="/my" class="sp-cta">My Account</a>
</div>
<button class="sp-theme-btn" id="sp-theme-btn" title="Toggle theme">🌙</button>
</div></nav>
<script>
(function(){
  var btn=document.getElementById('sp-theme-btn');
  function applyTheme(t){
    document.documentElement.setAttribute('data-theme',t);
    localStorage.setItem('theme',t);
    if(btn)btn.textContent=t==='dark'?'🌙':'☀️';
    var ll=document.querySelectorAll('.sp-logo-light'), ld=document.querySelectorAll('.sp-logo-dark');
    ll.forEach(function(el){el.style.display=t==='dark'?'none':'block'});
    ld.forEach(function(el){el.style.display=t==='dark'?'block':'none'});
  }
  applyTheme(localStorage.getItem('theme')||'dark');
  if(btn)btn.addEventListener('click',function(){applyTheme(document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark');});
})();
</script>`;
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
</div></footer>`;
}

async function getLogoUrls() {
  try {
    const db = await getDb();
    const light = (get(db, `SELECT value FROM settings WHERE key='logo_light_url'`) || {}).value || '';
    const dark  = (get(db, `SELECT value FROM settings WHERE key='logo_dark_url'`)  || {}).value || '';
    return { light, dark };
  } catch { return { light: '', dark: '' }; }
}

// ─── Helpers: simple server-rendered pages ────────────────────────────────────
function buildBlogPostPage(post, siteName, ogImage, baseUrl, logos = {}) {
  const bodyHtml = post.body
    .replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>');
  const canonical = `${baseUrl}/blog/${post.slug}`;
  const pubDate = (post.created_at || '').replace(' ', 'T').split('T')[0];
  const ldjson = JSON.stringify({ '@context':'https://schema.org','@type':'Article','headline':post.title,'datePublished':pubDate,'description':post.meta_desc||'','url':canonical });
  return `<!DOCTYPE html><html lang="en" data-theme="dark" data-store-theme="midnight-purple">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(post.title)} — ${esc(siteName)}</title>
<meta name="description" content="${esc(post.meta_desc || '')}">
<meta property="og:title" content="${esc(post.title)}">
<meta property="og:type" content="article">
${ogImage ? `<meta property="og:image" content="${esc(ogImage)}">` : ''}
<link rel="canonical" href="${esc(canonical)}">
<link rel="stylesheet" href="/style.css">
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

function buildBlogIndexPage(posts, siteName, seoDesc, baseUrl, logos = {}) {
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
  return `<!DOCTYPE html><html lang="en" data-theme="dark" data-store-theme="midnight-purple">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Blog — ${esc(siteName)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(baseUrl)}/blog">
<link rel="stylesheet" href="/style.css">
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

function buildSimplePage(name, siteName, logos = {}) {
  const titles = { about:'About Us', contact:'Contact', privacy:'Privacy Policy', terms:'Terms of Service', refund:'Refund Policy' };
  const title = titles[name] || name;
  return `<!DOCTYPE html><html lang="en" data-theme="dark" data-store-theme="midnight-purple"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — ${esc(siteName)}</title>
<link rel="stylesheet" href="/style.css">
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
function buildLegalPage(page, siteName, logos = {}) {
  const baseUrl = cfg.baseUrl;
  return `<!DOCTYPE html><html lang="en" data-theme="dark" data-store-theme="midnight-purple"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(page.title)} — ${esc(siteName)}</title>
<meta name="description" content="${esc(page.title)} for ${esc(siteName)}">
<link rel="canonical" href="${esc(baseUrl)}/${page.slug}">
<link rel="stylesheet" href="/style.css">
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

  app.listen(cfg.port, () => {
    console.log(`OTT Store running on http://localhost:${cfg.port}`);
    console.log(`  Store:  http://localhost:${cfg.port}/`);
    console.log(`  Portal: http://localhost:${cfg.port}/my`);
    console.log(`  Admin:  http://localhost:${cfg.port}/admin`);
  });
}

start().catch(e => { console.error('Startup error:', e); process.exit(1); });
