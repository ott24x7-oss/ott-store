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

// ─── API routes ───────────────────────────────────────────────────────────────
app.use('/user/api', require('./user-api'));
app.use('/admin/api', require('./admin-api'));

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
    const [siteName, ogImage, baseUrl] = await Promise.all([
      getSetting('site_name'), getSetting('seo_og_image'), getSetting('base_url'),
    ]);
    res.send(buildBlogPostPage(post, siteName || 'OTT Store', post.og_image || ogImage || '', baseUrl || cfg.baseUrl));
  } catch (e) { res.status(500).send('Server error'); }
});

app.get('/blog', async (req, res) => {
  try {
    const db = await getDb();
    const posts = all(db, `SELECT id,slug,title,meta_desc,created_at FROM blog_posts WHERE published=1 ORDER BY created_at DESC`);
    const [siteName, seoDesc, baseUrl] = await Promise.all([
      getSetting('site_name'), getSetting('seo_blog_desc'), getSetting('base_url'),
    ]);
    res.send(buildBlogIndexPage(posts, siteName || 'OTT Store', seoDesc || '', baseUrl || cfg.baseUrl));
  } catch (e) { res.status(500).send('Server error'); }
});

// SPA routes → serve their HTML files
app.get('/my', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'store', 'my.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html')));

// Public static pages
const staticRoutes = { '/about': 'about', '/contact': 'contact', '/privacy': 'privacy', '/terms': 'terms', '/refund': 'refund' };
for (const [route, name] of Object.entries(staticRoutes)) {
  app.get(route, async (req, res) => {
    const filePath = path.join(__dirname, '..', 'public', 'store', `${name}.html`);
    if (fs.existsSync(filePath)) return res.sendFile(filePath);
    const siteName = await getSetting('site_name') || 'OTT Store';
    res.send(buildSimplePage(name, siteName));
  });
}

// Storefront root — server-render meta tags for SEO crawlers
app.get(['/plans', '/'], async (req, res) => {
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

// ─── Helpers: simple server-rendered pages ────────────────────────────────────
function buildBlogPostPage(post, siteName, ogImage, baseUrl) {
  const bodyHtml = post.body
    .replace(/\n/g, '<br>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>');
  const canonical = `${baseUrl}/blog/${post.slug}`;
  const pubDate = (post.created_at || '').replace(' ', 'T').split('T')[0];
  return `<!DOCTYPE html><html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(post.title)} — ${esc(siteName)}</title>
<meta name="description" content="${esc(post.meta_desc || '')}">
<meta property="og:title" content="${esc(post.title)}">
<meta property="og:type" content="article">
${ogImage ? `<meta property="og:image" content="${esc(ogImage)}">` : ''}
<link rel="canonical" href="${esc(canonical)}">
<link rel="stylesheet" href="/style.css">
<script type="application/ld+json">${JSON.stringify({ "@context":"https://schema.org","@type":"Article","headline":post.title,"datePublished":pubDate,"description":post.meta_desc||"","url":canonical })}</script>
</head>
<body>
<header class="site-header"><div class="container"><a href="/" class="logo-link">${esc(siteName)}</a><nav><a href="/plans">Plans</a><a href="/blog">Blog</a><a href="/my">My Account</a></nav></div></header>
<main class="blog-post-page container">
<article>
<h1>${esc(post.title)}</h1>
<time datetime="${pubDate}">${pubDate}</time>
<div class="blog-body">${bodyHtml}</div>
</article>
<p><a href="/blog">← Back to Blog</a></p>
</main>
<footer class="site-footer"><div class="container"><p>© ${new Date().getFullYear()} ${esc(siteName)}</p></div></footer>
</body></html>`;
}

function buildBlogIndexPage(posts, siteName, seoDesc, baseUrl) {
  const items = posts.map(p => {
    const d = (p.created_at || '').replace(' ', 'T').split('T')[0];
    return `<article class="blog-card"><h2><a href="/blog/${esc(p.slug)}">${esc(p.title)}</a></h2>
     <p class="muted">${d}</p>
     <p>${esc(p.meta_desc || '')}</p></article>`;
  }).join('');
  const desc = seoDesc || `Read the latest articles and guides from ${siteName}.`;
  return `<!DOCTYPE html><html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Blog — ${esc(siteName)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(baseUrl)}/blog">
<link rel="stylesheet" href="/style.css"></head>
<body>
<header class="site-header"><div class="container"><a href="/" class="logo-link">${esc(siteName)}</a><nav><a href="/plans">Plans</a><a href="/blog">Blog</a><a href="/my">My Account</a></nav></div></header>
<main class="container"><h1>Blog</h1><div class="blog-grid">${items || '<p>No posts yet.</p>'}</div></main>
<footer class="site-footer"><div class="container"><p>© ${new Date().getFullYear()} ${esc(siteName)}</p></div></footer>
</body></html>`;
}

function buildSimplePage(name, siteName) {
  const titles = { about: 'About Us', contact: 'Contact', privacy: 'Privacy Policy', terms: 'Terms of Service', refund: 'Refund Policy' };
  const title = titles[name] || name;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — ${esc(siteName)}</title><link rel="stylesheet" href="/style.css"></head>
<body><header class="site-header"><div class="container"><a href="/" class="logo-link">${esc(siteName)}</a></div></header>
<main class="container"><h1>${title}</h1><p>Content coming soon.</p></main>
<footer class="site-footer"><div class="container"><p>© ${new Date().getFullYear()} ${esc(siteName)}</p></div></footer>
</body></html>`;
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  await getDb(); // init DB before accepting requests
  app.listen(cfg.port, () => {
    console.log(`OTT Store running on http://localhost:${cfg.port}`);
    console.log(`  Store:  http://localhost:${cfg.port}/`);
    console.log(`  Portal: http://localhost:${cfg.port}/my`);
    console.log(`  Admin:  http://localhost:${cfg.port}/admin`);
  });
}

start().catch(e => { console.error('Startup error:', e); process.exit(1); });
