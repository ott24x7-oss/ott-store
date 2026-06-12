'use strict';
// ─── OTT Store Admin SPA ──────────────────────────────────────────────────────

// ── State ─────────────────────────────────────────────────────────────────────
let ACTIVE_VIEW = 'dashboard';
let PENDING_TOPUPS = 0, PENDING_ORDERS = 0;

const MENU = [
  { group: 'OVERVIEW' },
  { id: 'dashboard',      label: 'Dashboard',     icon: '📊' },
  { id: 'analytics',      label: 'Analytics',     icon: '📈' },
  { group: 'CATALOG' },
  { id: 'plans',          label: 'Plans',         icon: '🎬' },
  { id: 'stock',          label: 'Stock',         icon: '📦' },
  { id: 'botcatalog',     label: 'Bot Catalog',   icon: '📡' },
  { id: 'bot-panel',      label: 'Bot Panel ↗',   icon: '🤖' },
  { group: 'SALES' },
  { id: 'orders',         label: 'Orders',        icon: '🛒' },
  { id: 'fulfillment',   label: 'Fulfillment',   icon: '🤖' },
  { id: 'topups',         label: 'Payment Log',   icon: '💳' },
  { id: 'customers',      label: 'Customers',     icon: '👥' },
  { id: 'resellers',      label: 'Resellers',     icon: '🤝' },
  { id: 'referrals',      label: 'Referrals',     icon: '🔗' },
  { id: 'wallet',         label: 'Wallet',        icon: '👛' },
  { group: 'WHATSAPP' },
  { id: 'wa-session',     label: 'WA Session',    icon: '📱' },
  { id: 'secure-session', label: 'Secure Session', icon: '🔒' },
  { id: 'whatsapp',       label: 'WA Bot',        icon: '💬' },
  { id: 'wa-offers',      label: 'WA Offers',     icon: '📋' },
  { id: 'contact-team',   label: 'Support Team',  icon: '👥' },
  { id: 'suppliers',      label: 'Suppliers',     icon: '🏭' },
  { group: 'MARKETING' },
  { id: 'broadcast',      label: 'Broadcast',     icon: '📢' },
  { id: 'autopost',       label: 'Email Auto-Post', icon: '🤖' },
  { id: 'ai-agent',       label: 'AI Agent',      icon: '🧠' },
  { id: 'api-channels',  label: 'API Channels',  icon: '🔌' },
  { id: 'chat-bot',      label: 'Chat Bot',      icon: '💬' },
  { group: 'EMAIL & APP' },
  { id: 'email-marketing', label: 'Email Marketing', icon: '📧' },
  { id: 'pwa-manager',   label: 'App Manager',   icon: '📱' },
  { group: 'STOREFRONT' },
  { id: 'mystore',        label: 'My Store',      icon: '🏪' },
  { id: 'hometext',       label: 'Homepage Content', icon: '📝' },
  { id: 'store-theme',    label: 'Store Themes',  icon: '🎨' },
  { id: 'payments',       label: 'Payments',      icon: '💰' },
  { id: 'legal',          label: 'Legal Pages',   icon: '📄' },
  { id: 'tickets',        label: 'Support',       icon: '🎧' },
  { id: 'blog',           label: 'Blog CMS',      icon: '✍️' },
  { id: 'seo',            label: 'SEO',           icon: '🔍' },
  { id: 'googleindex',    label: 'Google Index',  icon: '🌐' },
  { group: 'ACCOUNT' },
  { id: 'settings',       label: 'Settings',      icon: '⚙️' },
  { id: 'auditlog',       label: 'Audit Log',     icon: '📋' },
  { id: 'backup',         label: 'DB Backup',     icon: '💾' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmt(n) { return '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
const fmtInr = fmt; // global money formatter alias (used by the Wallet page + others)
function fmtDate(s) { if (!s) return '—'; try { return new Date(s).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return s; } }
function fmtDateShort(s) { if (!s) return '—'; try { return new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return s; } }

function statusBadge(s) {
  const map = { pending:'badge-yellow', processing:'badge-blue', delivered:'badge-green', expired:'badge-grey', cancelled:'badge-red', open:'badge-blue', closed:'badge-grey', approved:'badge-green', rejected:'badge-red' };
  return `<span class="badge ${map[s] || 'badge-grey'}">${esc(s)}</span>`;
}

// Read the csrfToken cookie (set globally by the server) and echo it back as
// an X-CSRF-Token header. The server's requireCsrf middleware enforces that
// the header matches the cookie on every POST/PUT/DELETE.
function getCsrfToken() {
  const m = document.cookie.match(/(?:^|;\s*)csrfToken=([^;]+)/);
  return m ? m[1] : '';
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const method = (opts.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const tok = getCsrfToken();
    if (tok) headers['X-CSRF-Token'] = tok;
  }
  const { timeoutMs = 20000, headers: _customHeaders, ...fetchOpts } = opts;
  const controller = new AbortController();
  const timer = fetchOpts.signal || !timeoutMs ? null : setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('/admin/api' + path, {
      credentials: 'include',
      ...fetchOpts,
      headers,
      signal: fetchOpts.signal || controller.signal,
    });
    if (res.status === 401) { renderLogin(); throw new Error('Unauthorized'); }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    return j;
  } catch (ex) {
    if (ex.name === 'AbortError') throw new Error('Request timed out. Please refresh or try again.');
    throw ex;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function showToast(msg, type = 'success') {
  const t = document.createElement('div');
  t.className = `alert alert-${type}`;
  Object.assign(t.style, { position:'fixed', top:'1rem', right:'1rem', zIndex:9999, maxWidth:'340px', boxShadow:'var(--shadow-lg)' });
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

function openModal(html) {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal">${html}</div>`;
  ov.querySelector('.modal').addEventListener('click', e => e.stopPropagation());
  ov.addEventListener('click', () => ov.remove());
  document.body.appendChild(ov);
  ov.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => ov.remove()));
  return ov;
}

function setMain(html) { document.getElementById('admin-main').innerHTML = html; }

function renderAdminLoadError(ex) {
  document.getElementById('admin-wrap').style.display = '';
  setMain(`
    <div class="card" style="max-width:520px;margin:4rem auto;text-align:center">
      <h2 style="font-size:1.2rem;font-weight:800;margin-bottom:.5rem">Admin could not load</h2>
      <p class="muted" style="margin-bottom:1rem">${esc(ex?.message || 'Please refresh or try again.')}</p>
      <button class="btn btn-primary" onclick="location.reload()">Refresh</button>
    </div>
  `);
}

// ── Theme ──────────────────────────────────────────────────────────────────────
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = t === 'dark' ? '☀️' : '🌙';
}
document.getElementById('theme-toggle')?.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next); applyTheme(next);
});
applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');

// ── Sidebar ────────────────────────────────────────────────────────────────────
let sidebarCollapsed = false;
document.getElementById('collapse-btn')?.addEventListener('click', () => {
  sidebarCollapsed = !sidebarCollapsed;
  document.getElementById('sidebar').classList.toggle('collapsed', sidebarCollapsed);
  document.getElementById('collapse-btn').textContent = sidebarCollapsed ? '▶' : '◀';
});

const mobileMenuBtn = document.getElementById('mobile-menu-btn');
const sidebarOverlay = document.getElementById('sidebar-overlay');
if (window.innerWidth <= 900) { mobileMenuBtn.style.display = ''; }
mobileMenuBtn?.addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('mobile-open');
  sidebarOverlay.style.display = 'block';
});
sidebarOverlay?.addEventListener('click', () => {
  document.getElementById('sidebar').classList.remove('mobile-open');
  sidebarOverlay.style.display = 'none';
});

function buildSidebar() {
  let html = '';
  for (const item of MENU) {
    if (item.group) { html += `<div class="menu-group-title">${item.group}</div>`; continue; }
    let badge = '';
    if (item.id === 'topups' && PENDING_TOPUPS > 0) badge = `<span class="pending-dot">${PENDING_TOPUPS}</span>`;
    if (item.id === 'orders' && PENDING_ORDERS > 0) badge = `<span class="pending-dot">${PENDING_ORDERS}</span>`;
    html += `<div class="menu-item${ACTIVE_VIEW === item.id ? ' active' : ''}" data-view="${item.id}">
      <span class="menu-icon">${item.icon}</span>
      <span class="menu-label">${item.label}${badge}</span>
    </div>`;
  }
  const nav = document.getElementById('sidebar-nav');
  nav.innerHTML = html;
  nav.querySelectorAll('.menu-item').forEach(el => {
    el.addEventListener('click', () => {
      document.getElementById('sidebar').classList.remove('mobile-open');
      sidebarOverlay.style.display = 'none';
      goView(el.dataset.view);
    });
  });
}

function goView(id) {
  ACTIVE_VIEW = id;
  // Update URL hash so refresh restores the current page
  if (location.hash !== '#' + id) history.pushState(null, '', '#' + id);
  document.getElementById('topbar-title').textContent = MENU.find(m => m.id === id)?.label || id;
  buildSidebar();
  const fn = views[id];
  if (fn) fn(); else setMain(`<p class="muted">View "${id}" not implemented yet.</p>`);
}

// ── Logout ────────────────────────────────────────────────────────────────────
document.getElementById('admin-logout-btn')?.addEventListener('click', async () => {
  await fetch('/admin/api/logout', { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': getCsrfToken() } });
  renderLogin();
});

// ── Login ─────────────────────────────────────────────────────────────────────
function renderLogin() {
  document.getElementById('admin-wrap').style.display = 'none';
  let loginEl = document.getElementById('admin-login');
  if (!loginEl) {
    loginEl = document.createElement('div');
    loginEl.id = 'admin-login';
    loginEl.style.cssText = 'min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem';
    document.body.appendChild(loginEl);
  }
  loginEl.style.display = 'flex';
  loginEl.innerHTML = `
<div class="card" style="width:100%;max-width:380px">
  <div style="text-align:center;margin-bottom:1.5rem">
    <div style="font-size:2.5rem;margin-bottom:.5rem">⚙️</div>
    <h2 style="font-size:1.3rem;font-weight:800">Admin Login</h2>
    <p class="muted">OTT Store Control Panel</p>
  </div>
  <form id="admin-login-form" style="display:flex;flex-direction:column;gap:.9rem">
    <div id="login-err"></div>
    <div class="form-group"><label class="form-label">Password</label>
      <input class="form-input" id="admin-pass" type="password" placeholder="Admin password" autofocus required>
    </div>
    <div class="form-group" id="admin-2fa-row" style="display:none"><label class="form-label">2FA Code</label>
      <input class="form-input" id="admin-2fa" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code (or backup code)">
    </div>
    <button type="submit" class="btn btn-primary btn-block">Login</button>
  </form>
</div>`;
  // Uses fetch directly (not api()) because api() force-renders the login screen on
  // any 401 — which would wipe the 2FA field mid-flow.
  document.getElementById('admin-login-form').onsubmit = async e => {
    e.preventDefault();
    const err = document.getElementById('login-err');
    const body = { password: document.getElementById('admin-pass').value };
    const otpEl = document.getElementById('admin-2fa');
    if (otpEl && otpEl.value.trim()) body.token = otpEl.value.trim();
    try {
      const headers = { 'Content-Type': 'application/json' };
      const ctok = getCsrfToken();
      if (ctok) headers['X-CSRF-Token'] = ctok;
      const res = await fetch('/admin/api/login', { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({}));
      if (res.ok) {
        loginEl.style.display = 'none';
        document.getElementById('admin-wrap').style.display = '';
        initAdmin();
        return;
      }
      if (j.twofa) {
        document.getElementById('admin-2fa-row').style.display = '';
        if (otpEl) otpEl.focus();
        err.innerHTML = `<div class="alert alert-info">${esc(j.error || 'Enter the 6-digit code from your authenticator app.')}</div>`;
      } else {
        err.innerHTML = `<div class="alert alert-error">${esc(j.error || 'Login failed')}</div>`;
      }
    } catch (ex) { err.innerHTML = `<div class="alert alert-error">${esc(ex.message || 'Network error')}</div>`; }
  };
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function initAdmin() {
  try {
    await api('/me', { timeoutMs: 12000 });
    buildSidebar();
    // Restore view from URL hash, fallback to dashboard
    const hashView = location.hash.replace('#', '').trim();
    const validViews = MENU.filter(m => m.id).map(m => m.id);
    goView(validViews.includes(hashView) ? hashView : 'dashboard');
    api('/dashboard', { timeoutMs: 10000 }).then(d => {
      PENDING_TOPUPS = d.pending_topups || 0;
      PENDING_ORDERS = d.pending_orders || 0;
      buildSidebar();
    }).catch(() => {});
  } catch (ex) {
    if (ex.message !== 'Unauthorized') renderAdminLoadError(ex);
  }
}

// ─── Views ────────────────────────────────────────────────────────────────────
const views = {};

// ── views['bot-panel'] — one-click into the bot's separate admin app ───────────
views['bot-panel'] = async function () {
  setMain('<div class="spinner"></div>');
  let url = '';
  try { const d = await api('/bot/admin-url'); url = (d && d.url) || ''; } catch {}
  if (url) { try { window.open(url, '_blank', 'noopener'); } catch {} } // best-effort one-click
  setMain(`
    <div class="card" style="max-width:640px">
      <h2 style="font-size:1.15rem;font-weight:800;margin-bottom:.4rem">🤖 Bot Admin Panel</h2>
      <p class="muted" style="margin-bottom:1rem">Your bot runs as a separate app. Day-to-day order tasks are already in your store admin — <b>Bot Catalog</b>, <b>Buy from bot</b> on each order, <b>Fulfillment</b>, and the <b>Bot Balance</b>. Open the bot panel mainly to <b>top up your reseller balance</b> or change the bot's own settings.</p>
      ${url
        ? `<a class="btn btn-primary" href="${esc(url)}" target="_blank" rel="noopener" style="display:inline-block;font-size:1rem">🤖 Open Bot Panel ↗</a>
           <p class="muted" style="margin-top:.6rem;font-size:.8rem">Opens <code>${esc(url)}</code> in a new tab (it should have opened automatically).</p>`
        : `<div class="alert alert-error">No bot URL set yet — add it below.</div>`}
      <div style="margin-top:1.25rem;border-top:1px solid var(--border,#334155);padding-top:1rem">
        <label class="form-label" style="font-size:.82rem">Bot admin URL <span class="muted">(change only if your panel is on a sub-path / different domain)</span></label>
        <div style="display:flex;gap:.5rem;margin-top:.35rem;flex-wrap:wrap">
          <input class="form-input" id="bp-url" style="flex:1;min-width:220px" value="${esc(url)}" placeholder="https://ottbot.ott24x7.com">
          <button class="btn btn-secondary" id="bp-save">Save URL</button>
        </div>
      </div>
    </div>`);
  document.getElementById('bp-save')?.addEventListener('click', async () => {
    const v = document.getElementById('bp-url').value.trim();
    try { await api('/bot/admin-url', { method: 'POST', body: JSON.stringify({ url: v }) }); showToast('Saved'); views['bot-panel'](); }
    catch (e) { showToast(e.message, 'error'); }
  });
};

// ── views.botcatalog (OTT24x7 bot reseller integration) ─────────────────────────
views.botcatalog = async function () {
  setMain('<div class="spinner"></div>');
  let s;
  try { s = await api('/bot/status'); }
  catch (ex) { setMain(`<div class="card"><p class="muted">Could not load bot status: ${esc(ex.message)}</p></div>`); return; }

  if (!s.configured) {
    setMain(`
      <div class="card" style="max-width:640px">
        <h2 style="font-size:1.15rem;font-weight:800;margin-bottom:.5rem">📡 Bot Catalog</h2>
        <p class="muted" style="margin-bottom:1rem">Not connected yet. Set <code>BOT_API_URL</code> and <code>BOT_API_TOKEN</code>
        in your server environment, then restart the store. Imported products appear in <b>Plans</b> and auto-deliver on purchase.</p>
        <p class="muted">Products imported so far: <b>${s.imported ?? 0}</b></p>
      </div>`);
    return;
  }

  let pd; try { pd = await api('/bot/products'); } catch (ex) { pd = { ok: false, products: [] }; }
  const products = (pd && pd.products) || [];
  window._BOT_PRODUCTS = products;
  const imported = products.filter(p => p.imported);
  const available = products.filter(p => !p.imported);
  const autoImport = !!(pd && pd.auto_import);
  const marginCell = (your, bot) => {
    const m = (your || 0) - (bot || 0), pct = bot ? Math.round((m / bot) * 100) : 0;
    return `<span style="color:${m >= 0 ? '#16a34a' : '#dc2626'}">${m >= 0 ? '+' : ''}${fmt(m)}${bot ? ` · ${pct}%` : ''}</span>`;
  };
  const availRows = available.map(p => `
    <tr data-name="${esc((p.name + ' ' + p.category).toLowerCase())}">
      <td><input type="checkbox" class="bot-cb" value="${esc(p.id)}"></td>
      <td style="font-weight:600">${esc(p.name)}</td>
      <td class="muted" style="font-size:.78rem">${esc(p.category || '—')}</td>
      <td><span class="badge ${p.delivery_type === 'auto' ? 'badge-blue' : 'badge-grey'}" style="font-size:.64rem">${p.delivery_type === 'auto' ? '🤖 Auto' : '✋ Manual'}</span></td>
      <td>${p.in_stock ? '<span class="badge badge-green" style="font-size:.64rem">In stock</span>' : '<span class="badge badge-red" style="font-size:.64rem">Out</span>'}</td>
      <td style="text-align:right;font-weight:700">${fmt(p.bot_price)}</td>
      <td style="text-align:right"><button class="btn btn-primary btn-sm" onclick="botAddOne('${esc(p.id)}')">+ Add</button></td>
    </tr>`).join('');
  const impRows = imported.map(p => `
    <tr data-name="${esc((p.name + ' ' + p.category).toLowerCase())}">
      <td style="font-weight:600">${esc(p.name)}</td>
      <td class="muted" style="font-size:.78rem">${esc(p.category || '—')}</td>
      <td style="text-align:right;font-weight:700">${fmt(p.your_price)}</td>
      <td style="text-align:right" class="muted">${fmt(p.bot_price)}</td>
      <td style="text-align:right;font-size:.82rem">${marginCell(p.your_price, p.bot_price)}</td>
      <td style="text-align:center">${p.active ? '<span class="badge badge-green" style="font-size:.64rem">Active</span>' : '<span class="badge badge-grey" style="font-size:.64rem">Hidden</span>'}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-secondary btn-sm" onclick="botSetPrice(${p.plan_id},${p.your_price || 0})" title="Set selling price">₹</button>
        <button class="btn btn-secondary btn-sm" onclick="botToggle(${p.plan_id})">${p.active ? 'Hide' : 'Show'}</button>
        <button class="btn btn-sm" style="background:#dc2626;border-color:#dc2626;color:#fff" onclick="botRemove(${p.plan_id})">Remove</button>
      </td>
    </tr>`).join('');
  setMain(`
    <div class="stat-row">
      <div class="card stat-box"><div class="stat-box-label">Connection</div><div class="stat-box-value">${s.connected ? '🟢 Connected' : '🔴 Error'}</div><div class="stat-box-sub">${esc(s.url || '')}</div></div>
      <div class="card stat-box"><div class="stat-box-label">💰 Bot Balance</div><div class="stat-box-value">${s.balance_formatted || (s.balance != null ? '₹' + s.balance : '—')}</div><div class="stat-box-sub muted" style="font-size:.72rem">reseller funds — top up on the bot panel</div></div>
      <div class="card stat-box"><div class="stat-box-label">Products on bot</div><div class="stat-box-value">${s.provider_products ?? '—'}</div></div>
      <div class="card stat-box"><div class="stat-box-label">In your store</div><div class="stat-box-value">${imported.length}</div></div>
      <div class="card stat-box"><div class="stat-box-label">Available to add</div><div class="stat-box-value">${available.length}</div></div>
    </div>
    <div class="card" style="margin-bottom:1.25rem">
      <div style="display:flex;gap:.6rem;flex-wrap:wrap;align-items:center">
        <button class="btn btn-primary" id="bot-sync-btn">🔄 Sync now</button>
        <button class="btn btn-secondary" onclick="goView('plans')">🎬 Open in Plans</button>
        <span style="flex:1"></span>
        <label class="muted" style="font-size:.82rem;display:flex;align-items:center;gap:.4rem;cursor:pointer"><input type="checkbox" id="bot-auto" ${autoImport ? 'checked' : ''} onchange="botAutoImport(this.checked)"> Auto-import new products on sync</label>
      </div>
      ${s.error ? `<p class="alert alert-error" style="margin-top:.75rem">⚠️ ${esc(s.error)}</p>` : ''}
      <div id="bot-sync-result" style="margin-top:.75rem"></div>
      <p class="muted" style="margin-top:.6rem;font-size:.78rem">Prices are set once on import (bot retail × markup) and never overwritten on re-sync. Auto products deliver instantly; out-of-stock auto-refunds to the customer's wallet.</p>
    </div>
    <div style="display:flex;align-items:center;gap:.6rem;margin-bottom:.5rem;flex-wrap:wrap">
      <h3 style="font-weight:800;margin:0">🆕 Available to add (${available.length})</h3>
      <span style="flex:1"></span>
      <input class="form-input" id="bot-search" style="width:200px" placeholder="Filter products..." oninput="botFilter(this.value)">
    </div>
    <div class="card" style="margin-bottom:1.5rem">
      <div style="display:flex;gap:.5rem;align-items:center;margin-bottom:.6rem;flex-wrap:wrap">
        <button class="btn btn-secondary btn-sm" onclick="botSelectAll(true)">Select all</button>
        <button class="btn btn-secondary btn-sm" onclick="botSelectAll(false)">Clear</button>
        <span style="flex:1"></span>
        <label class="muted" style="font-size:.8rem;display:flex;align-items:center;gap:.35rem">Markup <input class="form-input" id="bot-markup" type="number" value="0" min="0" style="width:62px;text-align:right">%</label>
        <button class="btn btn-primary btn-sm" onclick="botAddSelected()">+ Add selected</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th style="width:28px"></th><th>Product</th><th>Category</th><th>Type</th><th>Stock</th><th style="text-align:right">Bot price</th><th></th></tr></thead>
        <tbody id="bot-avail-body">${availRows || '<tr><td colspan="7" class="muted" style="text-align:center;padding:1.5rem">All bot products are already imported 🎉</td></tr>'}</tbody>
      </table></div>
    </div>
    <h3 style="font-weight:800;margin:0 0 .5rem">🏪 In your store (${imported.length})</h3>
    <div class="card">
      <div class="table-wrap"><table>
        <thead><tr><th>Product</th><th>Category</th><th style="text-align:right">Your price</th><th style="text-align:right">Bot cost</th><th style="text-align:right">Margin</th><th style="text-align:center">Status</th><th style="text-align:right">Manage</th></tr></thead>
        <tbody id="bot-imp-body">${impRows || '<tr><td colspan="7" class="muted" style="text-align:center;padding:1.5rem">No bot products imported yet — add some above ⬆️</td></tr>'}</tbody>
      </table></div>
    </div>`);
  document.getElementById('bot-sync-btn')?.addEventListener('click', botSync);
};

async function botSync() {
  const btn = document.getElementById('bot-sync-btn'); if (btn) { btn.disabled = true; btn.textContent = '⏳ Syncing…'; }
  try {
    const r = await api('/bot/sync', { method: 'POST' });
    const el = document.getElementById('bot-sync-result');
    if (el) el.innerHTML = `<p class="alert alert-success">✅ Synced: <b>${r.inserted}</b> new, <b>${r.updated}</b> refreshed, <b>${r.delisted}</b> delisted (of ${r.total}).</p>`;
    showToast('Synced from bot'); views.botcatalog();
  } catch (ex) {
    const el = document.getElementById('bot-sync-result'); if (el) el.innerHTML = `<p class="alert alert-error">⚠️ ${esc(ex.message)}</p>`;
    if (btn) { btn.disabled = false; btn.textContent = '🔄 Sync now'; }
  }
}
window.botSync = botSync;
window.botAutoImport = async (enabled) => { try { await api('/bot/auto-import', { method: 'POST', body: JSON.stringify({ enabled }) }); showToast(enabled ? 'New products will auto-import on sync' : 'New products are manual now'); } catch (e) { showToast(e.message, 'error'); } };
window.botFilter = (q) => { q = (q || '').toLowerCase(); ['bot-avail-body', 'bot-imp-body'].forEach(id => document.querySelectorAll('#' + id + ' tr[data-name]').forEach(tr => { tr.style.display = tr.dataset.name.includes(q) ? '' : 'none'; })); };
window.botSelectAll = (on) => document.querySelectorAll('.bot-cb').forEach(cb => { if (cb.closest('tr').style.display !== 'none') cb.checked = on; });
const _botMarkup = () => Math.max(0, Number(document.getElementById('bot-markup')?.value) || 0);
async function _botImport(ids) {
  try { const r = await api('/bot/import', { method: 'POST', body: JSON.stringify({ product_ids: ids, markup_percent: _botMarkup() }) }); showToast(`Added ${r.imported} product(s) ✅`); views.botcatalog(); }
  catch (e) { showToast(e.message, 'error'); }
}
window.botAddOne = (id) => _botImport([id]);
window.botAddSelected = () => {
  const ids = Array.from(document.querySelectorAll('.bot-cb:checked')).map(cb => cb.value);
  if (!ids.length) { showToast('Select products first', 'error'); return; }
  _botImport(ids);
};
window.botSetPrice = async (planId, current) => {
  const v = prompt('Selling price (₹):', current || ''); if (v === null) return;
  const price = Number(v); if (!price || isNaN(price)) { showToast('Enter a valid price', 'error'); return; }
  try { await api('/bot/plans/' + planId + '/price', { method: 'POST', body: JSON.stringify({ price_inr: price }) }); showToast('Price updated'); views.botcatalog(); }
  catch (e) { showToast(e.message, 'error'); }
};
window.botToggle = async (planId) => { try { const r = await api('/bot/plans/' + planId + '/toggle', { method: 'POST' }); showToast(r.active ? 'Now visible in store' : 'Hidden from store'); views.botcatalog(); } catch (e) { showToast(e.message, 'error'); } };
window.botRemove = async (planId) => {
  if (!confirm('Remove this product from your store?\n\nIf it has past orders it is hidden (kept for history); otherwise it is deleted. You can re-add it from the bot anytime.')) return;
  try { const r = await api('/bot/plans/' + planId, { method: 'DELETE' }); showToast(r.deleted ? 'Removed' : 'Hidden (has order history)'); views.botcatalog(); } catch (e) { showToast(e.message, 'error'); }
};

// ── views.dashboard ───────────────────────────────────────────────────────────
views.dashboard = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const d = await api('/dashboard');
    PENDING_TOPUPS = d.pending_topups || 0;
    PENDING_ORDERS = d.pending_orders || 0;
    buildSidebar();
    const recentRows = (d.recent_orders || []).map(o => `
<tr>
  <td>#${o.id}</td>
  <td>${esc(o.email || '—')}</td>
  <td>${esc(o.platform || '')} — ${esc(o.plan_name || '')}</td>
  <td>${fmt(o.amount_inr)}</td>
  <td>${statusBadge(o.status)}</td>
  <td>${fmtDateShort(o.created_at)}</td>
</tr>`).join('');

    setMain(`
<div class="stat-row">
  <div class="card stat-box"><div class="stat-box-label">Today Revenue</div><div class="stat-box-value grad-text">${fmt(d.revenue_today)}</div></div>
  <div class="card stat-box"><div class="stat-box-label">7-Day Revenue</div><div class="stat-box-value grad-text">${fmt(d.revenue_week)}</div></div>
  <div class="card stat-box"><div class="stat-box-label">30-Day Revenue</div><div class="stat-box-value grad-text">${fmt(d.revenue_month)}</div></div>
  <div class="card stat-box"><div class="stat-box-label">Total Customers</div><div class="stat-box-value">${d.total_customers}</div></div>
  <div class="card stat-box"><div class="stat-box-label">Pending Orders</div><div class="stat-box-value" style="color:var(--yellow)">${d.pending_orders}</div>
    ${d.pending_orders > 0 ? `<div class="stat-box-sub"><span style="cursor:pointer;color:var(--blue)" onclick="goView('orders')">View →</span></div>` : ''}</div>
  <div class="card stat-box"><div class="stat-box-label">Pending Topups</div><div class="stat-box-value" style="color:var(--yellow)">${d.pending_topups}</div>
    ${d.pending_topups > 0 ? `<div class="stat-box-sub"><span style="cursor:pointer;color:var(--blue)" onclick="goView('topups')">View →</span></div>` : ''}</div>
</div>
<div class="card">
  <div style="font-weight:700;margin-bottom:.9rem">Recent Orders</div>
  <div class="table-wrap"><table>
    <thead><tr><th>ID</th><th>Customer</th><th>Plan</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead>
    <tbody>${recentRows || '<tr><td colspan="6" class="muted" style="text-align:center;padding:1.5rem">No orders yet</td></tr>'}</tbody>
  </table></div>
</div>`);
  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

// ── views.plans ───────────────────────────────────────────────────────────────
views.plans = async function (catFilter) {
  catFilter = catFilter || '';
  setMain('<div class="spinner"></div>');
  try {
    const plans = await api('/plans');
    renderPlansTable(plans, catFilter);
  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

function deliveryBadge(p) {
  if (p.delivery_type === 'instant') return `<span class="badge badge-green" style="font-size:.72rem">⚡ Instant</span>`;
  if (p.provider_api) return `<span class="badge badge-blue" style="font-size:.72rem">🤖 Auto${p.delivery_time_est?' · '+esc(p.delivery_time_est):''}</span>`;
  return `<span class="badge badge-yellow" style="font-size:.72rem">⚠ Manual${p.delivery_time_est?' · '+esc(p.delivery_time_est):''}</span>`;
}

function renderPlansTable(plans, catFilter) {
  const cats = [...new Set(plans.map(p=>p.category||'').filter(Boolean))];
  const filtered = catFilter ? plans.filter(p=>(p.category||'')=== catFilter) : plans;

  const catBar = `<button class="btn btn-sm ${!catFilter?'btn-primary':'btn-secondary'}" onclick="views.plans('')">All (${plans.length})</button>` +
    cats.map(c=>`<button class="btn btn-sm ${catFilter===c?'btn-primary':'btn-secondary'}" onclick="views.plans('${esc(c)}')">${esc(c)} (${plans.filter(p=>p.category===c).length})</button>`).join('');

  const rows = filtered.map(p => `
<tr data-pid="${p.id}">
  <td style="width:32px;padding:4px 6px"><input type="checkbox" class="plan-cb" data-id="${p.id}" style="width:15px;height:15px;cursor:pointer"></td>
  <td style="width:36px" onclick="quickSetImage(${p.id},'${esc(p.image_url||'')}')" title="Click to change image" style="cursor:pointer">${p.image_url ? `<img src="${esc(p.image_url)}" style="width:32px;height:32px;border-radius:6px;object-fit:cover;cursor:pointer">` : '<div style="width:32px;height:32px;background:var(--input-bg);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:1rem;cursor:pointer" title="Set image">+🖼</div>'}</td>
  <td style="font-weight:600;max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.name)}</td>
  <td style="font-size:.8rem;color:var(--muted)">${esc(p.category||p.platform||'—')}</td>
  <td>${fmt(p.price_inr)}${p.price_usd>0?`<br><span class="muted" style="font-size:.75rem">$${Number(p.price_usd).toFixed(2)}</span>`:''}</td>
  <td style="font-size:.82rem">${p.duration_days ? (p.duration_days>=365?Math.round(p.duration_days/365)+'Y':p.duration_days>=30?Math.round(p.duration_days/30)+'M':p.duration_days+'d') : 'Lifetime'}</td>
  <td>${deliveryBadge(p)}</td>
  <td>
    <label class="toggle-switch"><input type="checkbox" ${p.active?'checked':''} onchange="togglePlan(${p.id})"><span class="toggle-slider"></span></label>
  </td>
  <td style="white-space:nowrap">
    <button class="btn btn-secondary btn-sm" onclick="editPlan(${p.id})">Edit</button>
    <button class="btn btn-red btn-sm" onclick="deletePlan(${p.id})">Del</button>
  </td>
</tr>`).join('');

  setMain(`
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem;flex-wrap:wrap;gap:.5rem">
  <h2 style="font-weight:800;margin:0">Product Catalog</h2>
  <div style="display:flex;gap:.4rem;flex-wrap:wrap">
    <button class="btn btn-sm btn-secondary" onclick="managePlatforms()">🏷 Platforms</button>
    <button class="btn btn-sm btn-secondary" onclick="openResellKeysPanel()">⚙ ResellKeys</button>
    <button class="btn btn-sm btn-secondary" onclick="scrapeResellKeys()">🔍 Scrape</button>
    <button class="btn btn-sm btn-secondary" onclick="exportPlansExcel()">📥 Export Excel</button>
    <button class="btn btn-sm btn-secondary" onclick="importPlansExcel()">📤 Import Excel</button>
    <button class="btn btn-sm btn-primary" onclick="openPlanModal()">+ Add Product</button>
  </div>
</div>
<div style="display:flex;gap:.35rem;flex-wrap:wrap;margin-bottom:.75rem">${catBar}</div>
<div id="bulk-bar" style="display:none;align-items:center;gap:.5rem;padding:.5rem .75rem;background:var(--card-bg);border:1px solid var(--border);border-radius:8px;margin-bottom:.5rem;flex-wrap:wrap">
  <span id="bulk-count" style="font-size:.85rem;font-weight:600;color:var(--primary)">0 selected</span>
  <button class="btn btn-sm btn-primary" onclick="bulkEditDetails()">Edit Details</button>
  <button class="btn btn-sm btn-secondary" onclick="bulkAction('activate')">✓ Activate</button>
  <button class="btn btn-sm btn-secondary" onclick="bulkAction('deactivate')">✕ Deactivate</button>
  <button class="btn btn-sm btn-secondary" onclick="bulkSetCategory()">📁 Set Category</button>
  <button class="btn btn-sm btn-secondary" onclick="bulkApplyMarkup()">💹 Apply Markup</button>
  <button class="btn btn-sm btn-secondary" onclick="bulkAdjustPrice()">📊 Adjust Price %</button>
  <button class="btn btn-sm btn-secondary" onclick="bulkSetImage()">🖼 Set Image</button>
  <button class="btn btn-sm btn-secondary" onclick="bulkUploadImages()">📤 Bulk Upload</button>
  <button class="btn btn-sm btn-secondary" onclick="bulkAction('auto-logo')">🤖 Auto Logo</button>
  <button class="btn btn-sm btn-secondary" onclick="bulkSortOrder()">🔢 Sort Order</button>
  <button class="btn btn-red btn-sm" onclick="bulkAction('delete')">🗑 Delete</button>
  <button class="btn btn-sm btn-secondary" style="margin-left:auto" onclick="clearBulkSelect()">✕ Clear</button>
</div>
<div class="table-wrap"><table>
  <thead><tr>
    <th style="width:32px"><input type="checkbox" id="plan-select-all" style="width:15px;height:15px;cursor:pointer" title="Select all"></th>
    <th>IMG</th><th>NAME</th><th>CATEGORY</th><th>PRICE</th><th>DURATION</th><th>DELIVERY</th><th>ACTIVE</th><th>ACTIONS</th>
  </tr></thead>
  <tbody>${rows||'<tr><td colspan="9" class="muted" style="text-align:center;padding:2rem">No products yet.</td></tr>'}</tbody>
</table></div>`);

  // ── Bulk select logic ──────────────────────────────────────────────────────
  function getSelectedIds() { return [...document.querySelectorAll('.plan-cb:checked')].map(cb => +cb.dataset.id); }
  function updateBulkBar() {
    const ids = getSelectedIds();
    const bar = document.getElementById('bulk-bar');
    const cnt = document.getElementById('bulk-count');
    bar.style.display = ids.length ? 'flex' : 'none';
    if (cnt) cnt.textContent = `${ids.length} selected`;
  }
  document.getElementById('plan-select-all').addEventListener('change', function() {
    document.querySelectorAll('.plan-cb').forEach(cb => { cb.checked = this.checked; });
    updateBulkBar();
  });
  document.querySelectorAll('.plan-cb').forEach(cb => cb.addEventListener('change', updateBulkBar));

  window.clearBulkSelect = () => {
    document.querySelectorAll('.plan-cb').forEach(cb => cb.checked = false);
    document.getElementById('plan-select-all').checked = false;
    updateBulkBar();
  };

  window.bulkAction = async (action) => {
    const ids = getSelectedIds();
    if (!ids.length) return showToast('Select at least one product', 'error');
    if (action === 'delete' && !confirm(`Delete ${ids.length} product(s)? This cannot be undone.`)) return;
    try {
      const r = await api('/plans/bulk-action', { method:'POST', body: JSON.stringify({ action, ids }) });
      showToast(`${r.affected} product(s) updated`); views.plans(catFilter);
    } catch(e) { showToast(e.message, 'error'); }
  };

  window.bulkSetCategory = () => {
    const ids = getSelectedIds();
    if (!ids.length) return showToast('Select at least one product', 'error');
    const ov = openModal(`
<div class="modal-header"><h3>📁 Set Category</h3><button class="btn-icon" data-close>✕</button></div>
<div class="modal-body">
  <p style="font-size:.85rem;color:var(--muted);margin-bottom:.75rem">Set category for <strong>${ids.length} selected product(s)</strong></p>
  <div class="form-group"><label class="form-label">Category</label>
    <input class="form-input" id="bulk-cat-input" placeholder="streaming, ms365, ai_writing…" list="bulk-cat-list">
    <datalist id="bulk-cat-list">${cats.map(c=>`<option value="${esc(c)}">`).join('')}</datalist>
  </div>
</div>
<div class="modal-footer">
  <button class="btn btn-secondary" data-close>Cancel</button>
  <button class="btn btn-primary" id="bulk-cat-save">Apply</button>
</div>`);
    document.getElementById('bulk-cat-save').onclick = async () => {
      const category = document.getElementById('bulk-cat-input').value.trim();
      if (!category) return showToast('Enter a category', 'error');
      try {
        const r = await api('/plans/bulk-action', { method:'POST', body: JSON.stringify({ action:'set-category', ids, category }) });
        ov.remove(); showToast(`Category set for ${r.affected} product(s)`); views.plans(catFilter);
      } catch(e) { showToast(e.message, 'error'); }
    };
  };

  window.bulkApplyMarkup = async () => {
    const ids = getSelectedIds();
    if (!ids.length) return showToast('Select at least one product', 'error');
    let fs = {};
    try { fs = await api('/fulfillment-settings'); } catch {}
    const ov = openModal(`
<div class="modal-header"><h3>💹 Apply Price Markup</h3><button class="btn-icon" data-close>✕</button></div>
<div class="modal-body">
  <p style="font-size:.85rem;color:var(--muted);margin-bottom:.75rem">Recalculate INR price from USD price for <strong>${ids.length} selected product(s)</strong></p>
  <div class="form-row">
    <div class="form-group"><label class="form-label">USD → INR Rate</label>
      <input class="form-input" id="markup-rate" type="number" step="0.01" value="${esc(fs.usd_to_inr_rate||'84')}" placeholder="84"></div>
    <div class="form-group"><label class="form-label">Profit %</label>
      <input class="form-input" id="markup-pct" type="number" step="1" value="${esc(fs.profit_pct||'30')}" placeholder="30"></div>
  </div>
  <p style="font-size:.8rem;color:var(--muted)">Formula: <code>INR = ceil(USD × rate × (1 + profit%))</code></p>
  <div id="markup-msg"></div>
</div>
<div class="modal-footer">
  <button class="btn btn-secondary" data-close>Cancel</button>
  <button class="btn btn-primary" id="markup-save">Apply to Selected</button>
</div>`);
    document.getElementById('markup-save').onclick = async () => {
      const profit_pct = parseFloat(document.getElementById('markup-pct').value) || 0;
      const usd_to_inr_rate = parseFloat(document.getElementById('markup-rate').value) || 84;
      try {
        const r = await api('/plans/bulk-action', { method:'POST', body: JSON.stringify({ action:'apply-markup', ids, profit_pct, usd_to_inr_rate }) });
        ov.remove(); showToast(`Markup applied to ${r.affected} product(s)`); views.plans(catFilter);
      } catch(e) { document.getElementById('markup-msg').innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
    };
  };

  // Increase/decrease the ₹ selling price of the selected products by a percentage.
  window.bulkAdjustPrice = async () => {
    const ids = getSelectedIds();
    if (!ids.length) return showToast('Select at least one product', 'error');
    let dir = 'increase';
    const ov = openModal(`
<div class="modal-header"><h3>📊 Adjust Price by %</h3><button class="btn-icon" data-close>✕</button></div>
<div class="modal-body">
  <p style="font-size:.85rem;color:var(--muted);margin-bottom:.75rem">Increase or decrease the ₹ selling price of <strong>${ids.length} selected product(s)</strong> by a percentage.</p>
  <div style="display:flex;gap:.5rem;margin-bottom:.75rem">
    <button type="button" class="btn btn-sm" id="adj-inc" style="flex:1">▲ Increase</button>
    <button type="button" class="btn btn-sm btn-secondary" id="adj-dec" style="flex:1">▼ Decrease</button>
  </div>
  <div class="form-group"><label class="form-label">Percentage (%)</label>
    <input class="form-input" id="adj-pct" type="number" min="0" step="0.5" placeholder="e.g. 10"></div>
  <p style="font-size:.8rem;color:var(--muted)">New price = current price × (1 <span id="adj-sign">+</span> %/100), rounded to the nearest ₹.</p>
  <div id="adj-msg"></div>
</div>
<div class="modal-footer">
  <button class="btn btn-secondary" data-close>Cancel</button>
  <button class="btn btn-primary" id="adj-save">Apply to Selected</button>
</div>`);
    const incBtn = document.getElementById('adj-inc'), decBtn = document.getElementById('adj-dec'), sign = document.getElementById('adj-sign');
    const setDir = (d) => { dir = d;
      incBtn.className = 'btn btn-sm' + (d === 'increase' ? '' : ' btn-secondary');
      decBtn.className = 'btn btn-sm' + (d === 'decrease' ? '' : ' btn-secondary');
      sign.textContent = d === 'decrease' ? '−' : '+';
    };
    incBtn.onclick = () => setDir('increase');
    decBtn.onclick = () => setDir('decrease');
    document.getElementById('adj-save').onclick = async () => {
      const pct = parseFloat(document.getElementById('adj-pct').value);
      const msg = document.getElementById('adj-msg');
      if (!isFinite(pct) || pct <= 0) { msg.innerHTML = `<div class="alert alert-error">Enter a percentage greater than 0</div>`; return; }
      try {
        const r = await api('/plans/bulk-action', { method:'POST', body: JSON.stringify({ action:'adjust-price', ids, pct, direction: dir }) });
        ov.remove(); showToast(`Price ${dir === 'decrease' ? 'decreased' : 'increased'} ${pct}% on ${r.affected} product(s)`); views.plans(catFilter);
      } catch(e) { msg.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`; }
    };
  };

  window.bulkSetImage = () => {
    const ids = getSelectedIds();
    if (!ids.length) return showToast('Select at least one product', 'error');
    const ov = openModal(`
<div class="modal-header"><h3>🖼 Set Product Image</h3><button class="btn-icon" data-close>✕</button></div>
<div class="modal-body">
  <p style="font-size:.85rem;color:var(--muted);margin-bottom:.75rem">Apply same image to <strong>${ids.length} selected product(s)</strong></p>
  <div class="form-group">
    <label class="form-label">Image URL</label>
    <input class="form-input" id="bulk-img-url" placeholder="https://logo.clearbit.com/netflix.com" oninput="bulkImgPreviewUpdate()">
  </div>
  <div id="bulk-img-preview-wrap" style="margin-top:.5rem;display:none">
    <img id="bulk-img-preview" style="height:60px;border-radius:8px;object-fit:contain;background:var(--input-bg);padding:4px">
  </div>
  <div style="font-size:.82rem;color:var(--muted);margin-top:.75rem">
    💡 Tip: Use <code>https://logo.clearbit.com/DOMAIN.com</code> for auto brand logos, or paste any direct image URL.
  </div>
  <div id="bulk-img-msg"></div>
</div>
<div class="modal-footer">
  <button class="btn btn-secondary" data-close>Cancel</button>
  <button class="btn btn-primary" id="bulk-img-save">Apply Image</button>
</div>`);
    window.bulkImgPreviewUpdate = () => {
      const url = document.getElementById('bulk-img-url').value.trim();
      const wrap = document.getElementById('bulk-img-preview-wrap');
      const img = document.getElementById('bulk-img-preview');
      if (url) { img.src = url; wrap.style.display = ''; } else { wrap.style.display = 'none'; }
    };
    document.getElementById('bulk-img-save').onclick = async () => {
      const image_url = document.getElementById('bulk-img-url').value.trim();
      if (!image_url) return showToast('Enter an image URL', 'error');
      try {
        const r = await api('/plans/bulk-action', { method:'POST', body: JSON.stringify({ action:'set-image-url', ids, image_url }) });
        ov.remove(); showToast(`Image set for ${r.affected} product(s)`); views.plans(catFilter);
      } catch(e) { document.getElementById('bulk-img-msg').innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
    };
  };

  // ── Bulk sort-order editor ────────────────────────────────────────────────
  // Drag-to-reorder the selected products; save writes sort_order back via
  // the 'set-sort-order' bulk-action (ids in display order → order * 10).
  window.bulkEditDetails = () => {
    const ids = getSelectedIds();
    if (!ids.length) return showToast('Select at least one product', 'error');
    const selected = ids
      .map(id => plans.find(p => Number(p.id) === Number(id)))
      .filter(Boolean);
    if (!selected.length) return showToast('Selected products were not found', 'error');

    const rows = selected.map((p, i) => {
      const features = Array.isArray(p.features) ? p.features.join('\n') : '';
      return `<div class="bulk-detail-row" data-id="${p.id}" style="display:grid;grid-template-columns:44px minmax(180px,1fr) minmax(220px,1.25fr) minmax(220px,1fr);gap:.65rem;align-items:start;padding:.7rem;border:1px solid var(--border);border-radius:8px;background:var(--input-bg)">
        <div style="font-size:.78rem;color:var(--muted);font-weight:700;padding-top:.65rem">#${i + 1}</div>
        <div class="form-group">
          <label class="form-label">Title</label>
          <input class="form-input bulk-detail-name" value="${esc(p.name || '')}" placeholder="Product title">
        </div>
        <div class="form-group">
          <label class="form-label">Description</label>
          <textarea class="form-input bulk-detail-description" rows="3" placeholder="Short product description">${esc(p.description || '')}</textarea>
        </div>
        <div class="form-group">
          <label class="form-label">Features</label>
          <textarea class="form-input bulk-detail-features" rows="3" placeholder="One feature per line">${esc(features)}</textarea>
        </div>
      </div>`;
    }).join('');

    const ov = openModal(`
<div class="modal-header"><h3>Bulk Edit Product Details</h3><button class="btn-icon" data-close>x</button></div>
<div class="modal-body" style="max-height:75vh;overflow-y:auto">
  <p style="font-size:.85rem;color:var(--muted);margin-bottom:.75rem">Edit title, description, and features for <strong>${selected.length} selected product(s)</strong>. Put each feature on a new line.</p>
  <div style="display:grid;gap:.55rem;min-width:860px">${rows}</div>
  <div id="bulk-details-msg" style="margin-top:.75rem"></div>
</div>
<div class="modal-footer">
  <button class="btn btn-secondary" data-close>Cancel</button>
  <button class="btn btn-primary" id="bulk-details-save">Save Details</button>
</div>`);
    const modal = ov.querySelector('.modal');
    if (modal) modal.style.maxWidth = '1100px';

    document.getElementById('bulk-details-save').onclick = async () => {
      const msg = document.getElementById('bulk-details-msg');
      const updates = [...ov.querySelectorAll('.bulk-detail-row')].map(row => ({
        id: Number(row.dataset.id),
        name: row.querySelector('.bulk-detail-name').value.trim(),
        description: row.querySelector('.bulk-detail-description').value.trim(),
        features: row.querySelector('.bulk-detail-features').value
          .split(/\r?\n/)
          .map(s => s.trim())
          .filter(Boolean),
      }));
      if (updates.some(u => !u.name)) {
        msg.innerHTML = `<div class="alert alert-error">Every product needs a title before saving.</div>`;
        return;
      }
      const btn = document.getElementById('bulk-details-save');
      btn.disabled = true;
      btn.textContent = 'Saving...';
      try {
        const r = await api('/plans/bulk-action', { method:'POST', body: JSON.stringify({ action:'bulk-update-details', ids, updates }) });
        ov.remove();
        showToast(`Details updated for ${r.affected} product(s)`);
        views.plans(catFilter);
      } catch(e) {
        msg.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
        btn.disabled = false;
        btn.textContent = 'Save Details';
      }
    };
  };

  window.bulkSortOrder = () => {
    const ids = getSelectedIds();
    if (!ids.length) return showToast('Select at least one product', 'error');
    // Build item list from visible table rows (preserves current filtered order)
    const items = ids.map(id => {
      const tr = document.querySelector(`tr[data-pid="${id}"]`)
               || document.querySelector(`input.plan-cb[data-id="${id}"]`)?.closest('tr');
      const name = tr?.querySelector('td:nth-child(3)')?.textContent?.trim() || `#${id}`;
      const img  = tr?.querySelector('td:nth-child(2) img')?.src || '';
      const sortVal = tr?.querySelector('td:nth-child(3)')?.closest('tr')?.dataset?.sortOrder || '';
      return { id: Number(id), name, img };
    });

    const ov = openModal(`
<div class="modal-header"><h3>🔢 Set Sort Order</h3><button class="btn-icon" data-close>✕</button></div>
<div class="modal-body">
  <p style="font-size:.83rem;color:var(--muted);margin-bottom:.75rem">
    Drag rows to reorder. Products will appear on the store in this order.<br>
    <span style="opacity:.7">Sort values are saved as multiples of 10 so you can insert products between them later.</span>
  </p>
  <div id="sort-list" style="display:flex;flex-direction:column;gap:.3rem;max-height:400px;overflow-y:auto"></div>
  <div id="sort-msg" style="margin-top:.5rem"></div>
</div>
<div class="modal-footer">
  <button class="btn btn-secondary" data-close>Cancel</button>
  <button class="btn btn-primary" id="sort-save-btn">💾 Save Order</button>
</div>`);

    // Render draggable rows
    const list = document.getElementById('sort-list');
    let orderedIds = items.map(p => p.id);

    function renderSortList() {
      list.innerHTML = orderedIds.map((id, i) => {
        const p = items.find(x => x.id === id);
        return `<div class="sort-row" draggable="true" data-id="${id}" style="display:flex;align-items:center;gap:.6rem;padding:.5rem .65rem;background:var(--card-bg);border:1px solid var(--border);border-radius:8px;cursor:grab;user-select:none">
          <span style="color:var(--muted);font-size:.85rem;width:20px;text-align:right;flex-shrink:0">${i+1}</span>
          <span style="cursor:grab;color:var(--muted);font-size:1.1rem;flex-shrink:0">⠿</span>
          ${p.img?`<img src="${esc(p.img)}" style="width:28px;height:28px;border-radius:4px;object-fit:cover;flex-shrink:0">`:'<div style="width:28px;height:28px;background:var(--input-bg);border-radius:4px;flex-shrink:0"></div>'}
          <span style="flex:1;font-size:.88rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(p.name)}">${esc(p.name)}</span>
          <span style="font-size:.72rem;color:var(--muted);flex-shrink:0">sort: ${(i+1)*10}</span>
        </div>`;
      }).join('');

      // Native HTML5 drag-and-drop sort
      let dragging = null;
      list.querySelectorAll('.sort-row').forEach(row => {
        row.addEventListener('dragstart', e => { dragging = row; row.style.opacity = '.4'; });
        row.addEventListener('dragend',   e => { dragging = null; row.style.opacity = ''; });
        row.addEventListener('dragover',  e => { e.preventDefault(); });
        row.addEventListener('drop', e => {
          e.preventDefault();
          if (!dragging || dragging === row) return;
          const kids = [...list.children];
          const fromI = kids.indexOf(dragging);
          const toI   = kids.indexOf(row);
          orderedIds = orderedIds.filter((_,i)=>i!==fromI);
          orderedIds.splice(toI, 0, items.find(x=>x.id===Number(dragging.dataset.id)).id);
          renderSortList();
        });
      });
    }
    renderSortList();

    document.getElementById('sort-save-btn').onclick = async () => {
      const btn = document.getElementById('sort-save-btn');
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        const r = await api('/plans/bulk-action', { method:'POST', body: JSON.stringify({ action:'set-sort-order', ids: orderedIds }) });
        ov.remove(); showToast(`Sort order saved for ${r.affected} products`); views.plans(catFilter);
      } catch(e) {
        document.getElementById('sort-msg').innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
        btn.disabled = false; btn.textContent = '💾 Save Order';
      }
    };
  };

  // ── Bulk image FILE upload (one image per product) ────────────────────────
  // Companion to bulkSetImage (single URL → all). This one:
  //  1. Admin drops/picks N image files
  //  2. We auto-pair each file with a selected product by filename↔name
  //     token overlap (Jaccard). Confident match = green; weak match = grey.
  //  3. Admin can manually re-pair via dropdown
  //  4. Click Upload — each file POSTs to /plans/:id/upload-image with a
  //     live progress bar; failures show inline so a single bad file doesn't
  //     abort the rest.
  window.bulkUploadImages = () => {
    const ids = getSelectedIds();
    if (!ids.length) return showToast('Select at least one product', 'error');
    // Build a lightweight view-model from the rendered table — we already
    // have name + current image in the DOM so no extra API roundtrip needed.
    const products = ids.map(id => {
      const tr = document.querySelector(`tr[data-pid="${id}"]`)
              || document.querySelector(`input.plan-cb[data-id="${id}"]`)?.closest('tr');
      const name = tr?.querySelector('td:nth-child(3)')?.textContent?.trim() || `#${id}`;
      const img  = tr?.querySelector('td:nth-child(2) img')?.src || '';
      return { id: Number(id), name, img };
    });
    let queue = []; // [{file, productId, matchScore, status, error}]

    const ov = openModal(`
<div class="modal-header"><h3>📤 Bulk Upload Product Images</h3><button class="btn-icon" data-close>✕</button></div>
<div class="modal-body" style="max-height:75vh;overflow-y:auto">
  <p style="font-size:.85rem;color:var(--muted);margin-bottom:.75rem">
    Upload one unique image per product. <strong>${ids.length} product(s) selected.</strong>
    Drop multiple files at once — we'll auto-match each file to the closest product by filename.
  </p>

  <!-- AI auto-fill section -->
  <div style="background:var(--input-bg);border-radius:8px;padding:.7rem .85rem;margin-bottom:.75rem;border:1px solid var(--border)">
    <div style="font-weight:700;font-size:.85rem;margin-bottom:.35rem">🤖 AI Auto-fill Images from Internet</div>
    <p style="font-size:.78rem;color:var(--muted);margin:0 0 .5rem">
      Searches Clearbit Logo API for each selected product. Instant, no API key needed.
      Results are set as the image URL — no file upload required.
    </p>
    <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
      <button class="btn btn-sm btn-secondary" id="bui-ai-btn">🤖 Auto-fill ${ids.length} Products</button>
      <span id="bui-ai-status" style="font-size:.78rem;color:var(--muted)"></span>
    </div>
  </div>

  <label id="bui-drop" style="display:block;border:2px dashed var(--border);border-radius:10px;padding:1.5rem;text-align:center;cursor:pointer;transition:all .15s">
    <div style="font-size:2rem;margin-bottom:.35rem">📁</div>
    <div style="font-weight:700">Or drop / pick image files below</div>
    <div style="font-size:.78rem;color:var(--muted);margin-top:.25rem">JPG / PNG / WebP · 2 MB each · select many at once</div>
    <input type="file" id="bui-input" accept="image/*" multiple style="display:none">
  </label>

  <div id="bui-summary" style="margin-top:.85rem;font-size:.85rem;color:var(--muted)"></div>
  <div id="bui-msg"></div>
  <div id="bui-list" style="margin-top:.5rem"></div>
  <div id="bui-progress" style="display:none;margin-top:.85rem">
    <div style="height:6px;background:var(--input-bg);border-radius:3px;overflow:hidden">
      <div id="bui-bar" style="height:100%;width:0;background:var(--primary);transition:width .15s"></div>
    </div>
    <div id="bui-progress-text" style="font-size:.78rem;color:var(--muted);margin-top:.35rem;text-align:center"></div>
  </div>
</div>
<div class="modal-footer">
  <button class="btn btn-secondary" data-close id="bui-cancel">Close</button>
  <button class="btn btn-primary" id="bui-upload" disabled>Upload 0 Images</button>
</div>`);

    const drop = document.getElementById('bui-drop');
    const input = document.getElementById('bui-input');
    const list = document.getElementById('bui-list');
    const summary = document.getElementById('bui-summary');
    const uploadBtn = document.getElementById('bui-upload');
    const msg = document.getElementById('bui-msg');

    // Token overlap (Jaccard) — strip extension, lowercase, split on non-alnum.
    // Score 0..1. Same tokens "outlook 2024" vs "Outlook 2024 1PC [BIND]" → ~0.5.
    const tokens = s => new Set(String(s||'').toLowerCase().replace(/\.[a-z0-9]+$/,'').split(/[^a-z0-9]+/).filter(t => t && t.length > 1));
    const matchScore = (a, b) => {
      const ta = tokens(a), tb = tokens(b);
      if (!ta.size || !tb.size) return 0;
      let inter = 0;
      ta.forEach(t => { if (tb.has(t)) inter++; });
      return inter / new Set([...ta, ...tb]).size;
    };

    function autoPair(files) {
      // Greedy assignment: for each file, pick the highest-scoring product
      // that isn't already paired with a stronger file.
      const usedIds = new Set(queue.map(q => q.productId));
      files.forEach(file => {
        let best = { score: 0, id: null };
        products.forEach(p => {
          if (usedIds.has(p.id)) return;
          const s = matchScore(file.name, p.name);
          if (s > best.score) best = { score: s, id: p.id };
        });
        const pid = best.id || products.find(p => !usedIds.has(p.id))?.id || products[0].id;
        usedIds.add(pid);
        queue.push({ file, productId: pid, matchScore: best.score, status: 'pending', error: '' });
      });
    }

    function renderList() {
      summary.textContent = queue.length
        ? `${queue.length} file(s) queued · ${queue.filter(q => q.matchScore >= .15).length} auto-matched`
        : '';
      uploadBtn.textContent = `Upload ${queue.length} Image${queue.length===1?'':'s'}`;
      uploadBtn.disabled = !queue.length;
      if (!queue.length) { list.innerHTML = ''; return; }
      list.innerHTML = queue.map((q, i) => {
        const prod = products.find(p => p.id === q.productId);
        const previewUrl = URL.createObjectURL(q.file);
        const matchColor = q.matchScore >= .4 ? 'var(--green,#22c55e)'
                         : q.matchScore >= .15 ? '#f59e0b'
                         : 'var(--muted)';
        const matchLabel = q.matchScore >= .4 ? 'Strong match'
                         : q.matchScore >= .15 ? 'Weak match'
                         : 'No match — verify';
        const opts = products.map(p =>
          `<option value="${p.id}" ${p.id===q.productId?'selected':''}>${esc(p.name)}</option>`
        ).join('');
        const statusIcon = q.status === 'done' ? '✅'
                         : q.status === 'error' ? '⚠️'
                         : q.status === 'uploading' ? '⏳' : '';
        return `<div class="bui-row" data-idx="${i}" style="display:flex;align-items:center;gap:.6rem;padding:.5rem;border-bottom:1px solid var(--border)">
          <img src="${previewUrl}" style="width:40px;height:40px;border-radius:6px;object-fit:cover;flex-shrink:0">
          <div style="flex:1;min-width:0">
            <div style="font-size:.78rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(q.file.name)}">${esc(q.file.name)} · ${(q.file.size/1024).toFixed(0)} KB</div>
            <div style="display:flex;align-items:center;gap:.4rem;margin-top:.15rem">
              <span style="font-size:.7rem;color:${matchColor};font-weight:600;flex-shrink:0">${matchLabel}</span>
              <span style="font-size:.7rem;color:var(--muted)">→</span>
              <select class="form-input bui-pair" data-idx="${i}" style="flex:1;font-size:.78rem;padding:.25rem .45rem;min-width:0">${opts}</select>
            </div>
            ${q.error ? `<div style="font-size:.7rem;color:#ef4444;margin-top:.15rem">${esc(q.error)}</div>` : ''}
          </div>
          <div style="font-size:1rem;width:22px;text-align:center">${statusIcon}</div>
          <button class="btn-icon bui-remove" data-idx="${i}" title="Remove" ${q.status==='uploading'?'disabled':''}>✕</button>
        </div>`;
      }).join('');
      list.querySelectorAll('.bui-pair').forEach(sel => sel.onchange = e => {
        const i = Number(e.target.dataset.idx);
        const newId = Number(e.target.value);
        // Free the product that was previously paired with file `i` (no-op).
        queue[i].productId = newId;
        queue[i].matchScore = matchScore(queue[i].file.name, products.find(p=>p.id===newId)?.name || '');
        renderList();
      });
      list.querySelectorAll('.bui-remove').forEach(btn => btn.onclick = e => {
        const i = Number(e.currentTarget.dataset.idx);
        queue.splice(i, 1);
        renderList();
      });
    }

    function addFiles(fileList) {
      const fresh = Array.from(fileList || []).filter(f => f.type.startsWith('image/'));
      if (!fresh.length) return;
      if (queue.length + fresh.length > products.length) {
        msg.innerHTML = `<div class="alert alert-error">You picked more files than selected products (${products.length}). Only the first ${products.length - queue.length} will be queued.</div>`;
        fresh.splice(products.length - queue.length);
      } else {
        msg.innerHTML = '';
      }
      autoPair(fresh);
      renderList();
    }

    drop.addEventListener('click', () => input.click());
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.style.borderColor = 'var(--primary)'; drop.style.background = 'var(--input-bg)'; });
    drop.addEventListener('dragleave', () => { drop.style.borderColor = 'var(--border)'; drop.style.background = ''; });
    drop.addEventListener('drop', e => {
      e.preventDefault();
      drop.style.borderColor = 'var(--border)';
      drop.style.background = '';
      addFiles(e.dataTransfer.files);
    });
    input.addEventListener('change', e => addFiles(e.target.files));

    uploadBtn.onclick = async () => {
      if (!queue.length) return;
      uploadBtn.disabled = true;
      document.getElementById('bui-cancel').textContent = 'Done';
      document.getElementById('bui-progress').style.display = '';
      const bar = document.getElementById('bui-bar');
      const ptxt = document.getElementById('bui-progress-text');
      let done = 0, fails = 0;
      for (let i = 0; i < queue.length; i++) {
        const q = queue[i];
        if (q.status === 'done') { done++; continue; }
        q.status = 'uploading'; q.error = '';
        renderList();
        try {
          const fd = new FormData();
          fd.append('image', q.file);
          const res = await fetch(`/admin/api/plans/${q.productId}/upload-image`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'X-CSRF-Token': getCsrfToken() },
            body: fd,
          });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
          q.status = 'done';
          done++;
        } catch (ex) {
          q.status = 'error';
          q.error = ex.message || 'Upload failed';
          fails++;
        }
        const pct = Math.round(((i + 1) / queue.length) * 100);
        bar.style.width = pct + '%';
        ptxt.textContent = `Uploading ${i + 1}/${queue.length}… ${done} done · ${fails} failed`;
        renderList();
      }
      ptxt.textContent = `Finished · ${done} uploaded · ${fails} failed`;
      showToast(`${done} image(s) uploaded${fails ? `, ${fails} failed` : ''}`, fails ? 'error' : 'success');
      // Refresh table in background so new images show; keep modal open so
      // the admin can read the per-row results.
      views.plans(catFilter);
    };

    renderList();

    // ── AI Auto-fill: Clearbit logo + Google favicon fallback ──────────────
    document.getElementById('bui-ai-btn').onclick = async () => {
      const aiBtn   = document.getElementById('bui-ai-btn');
      const aiStatus = document.getElementById('bui-ai-status');
      aiBtn.disabled = true;
      aiStatus.textContent = 'Looking up images…';

      // Try to derive a domain from platform/name for Clearbit.
      // Clearbit Logo API is free and returns a PNG for known brands.
      const domainGuess = name => {
        const n = String(name||'').toLowerCase();
        const MAP = {
          'netflix':'netflix.com','amazon prime':'amazon.com','prime video':'amazon.com',
          'disney+':'disneyplus.com','hotstar':'hotstar.com','disney+ hotstar':'hotstar.com',
          'sony liv':'sonyliv.com','zee5':'zee5.com','jiocinema':'jiocinema.com',
          'spotify':'spotify.com','youtube':'youtube.com','youtube premium':'youtube.com',
          'apple tv':'apple.com','apple music':'apple.com',
          'canva':'canva.com','adobe':'adobe.com','microsoft 365':'microsoft.com',
          'office 365':'microsoft.com','microsoft office':'microsoft.com',
          'word':'microsoft.com','excel':'microsoft.com','powerpoint':'microsoft.com',
          'outlook':'microsoft.com','access':'microsoft.com',
          'google one':'google.com','nordvpn':'nordvpn.com','expressvpn':'expressvpn.com',
          'chatgpt':'openai.com','openai':'openai.com','linkedin':'linkedin.com',
          'mx player':'mxplayer.in','voot':'voot.com','fancode':'fancode.com',
          'primevideo':'amazon.com','amazon':'amazon.com',
        };
        for (const [k,v] of Object.entries(MAP)) { if (n.includes(k)) return v; }
        // Fall back: strip common suffixes and use as domain
        const clean = n.replace(/\b(premium|pro|plus|max|ultra|free|trial|plan|subscription|1pc|5pc|bind|retail|online|month|year|days|lifetime)\b/g,'').trim().replace(/\s+/g,'').replace(/[^a-z0-9]/g,'');
        return clean ? clean+'.com' : null;
      };

      let done=0, skipped=0;
      for (const p of products) {
        const domain = domainGuess(p.name) || domainGuess(p.platform||'');
        if (!domain) { skipped++; continue; }
        const url = `https://logo.clearbit.com/${domain}`;
        try {
          const r = await api('/plans/bulk-action', { method:'POST', body: JSON.stringify({
            action: 'set-image-url', ids: [p.id], image_url: url
          })});
          if (r.affected) done++;
        } catch { skipped++; }
        aiStatus.textContent = `${done} done, ${skipped} skipped…`;
      }
      aiBtn.disabled = false;
      aiStatus.textContent = `✅ Done — ${done} images set, ${skipped} skipped`;
      showToast(`AI filled ${done} product images`);
      views.plans(catFilter);
    };
  };

  // Download the whole product catalog as a real .xlsx workbook. This is a
  // same-origin GET, so the browser sends the adminToken cookie automatically —
  // no auth header needed — and the server's Content-Disposition makes it save
  // instead of navigating. Exports ALL products, regardless of the active
  // category tab or row selection.
  window.exportPlansExcel = () => {
    const a = document.createElement('a');
    a.href = '/admin/api/plans/export.xlsx';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (typeof showToast === 'function') showToast('Preparing Excel export…');
  };

  // Import products from an .xlsx (same format as Export). A row whose Name
  // exactly matches an existing product replaces it; new names are added. Sends
  // the CSRF token like the other admin uploads; refreshes the table afterwards.
  window.importPlansExcel = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      if (!confirm(`Import "${file.name}"?\n\nProducts whose Name exactly matches an existing one will be REPLACED. New names are added. (The ID and Created At columns are ignored.)`)) return;
      const fd = new FormData();
      fd.append('file', file);
      try {
        showToast('Importing…');
        const res = await fetch('/admin/api/plans/import', {
          method: 'POST', credentials: 'include',
          headers: { 'X-CSRF-Token': getCsrfToken() }, body: fd,
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        let msg = `Imported: ${j.updated} replaced, ${j.inserted} added`;
        if (j.skipped) msg += `, ${j.skipped} skipped`;
        showToast(msg);
        if (j.errors && j.errors.length) console.warn('Import row errors:', j.errors);
        views.plans();
      } catch (ex) {
        showToast('Import failed: ' + (ex.message || ex), 'error');
      }
    };
    input.click();
  };

  // ── ResellKeys panel ──────────────────────────────────────────────────────
  window.openResellKeysPanel = async () => {
    let fs = {};
    try { fs = await api('/fulfillment-settings'); } catch {}
    const ov = openModal(`
<div class="modal-header"><h3>⚙ ResellKeys Config & Price Sync</h3><button class="btn-icon" data-close>✕</button></div>
<div class="modal-body" style="max-height:70vh;overflow-y:auto">
  <div id="rk-msg"></div>
  <p style="font-size:.82rem;color:var(--muted);margin-bottom:1rem">Configure credentials to scrape products and sync prices from ResellKeys.</p>

  <div style="font-weight:700;font-size:.85rem;margin-bottom:.5rem;color:var(--primary)">🔑 Credentials</div>
  <div class="form-group"><label class="form-label">ResellKeys Base URL</label>
    <input class="form-input" id="rk-url" value="${esc(fs.resellkeys_api_url||'https://www.resellkeys.com')}"></div>
  <div class="form-row">
    <div class="form-group"><label class="form-label">API Key</label>
      <input class="form-input" id="rk-key" type="password" value="${esc(fs.resellkeys_api_key||'')}" placeholder="Leave blank to keep current"></div>
    <div class="form-group"><label class="form-label">Login Email</label>
      <input class="form-input" id="rk-email" value="${esc(fs.resellkeys_email||'')}" type="email" placeholder="your@email.com"></div>
  </div>
  <div class="form-group"><label class="form-label">Password</label>
    <input class="form-input" id="rk-pass" type="password" value="${esc(fs.resellkeys_password||'')}" placeholder="Leave blank to keep current"></div>

  <div style="font-weight:700;font-size:.85rem;margin:.75rem 0 .5rem;color:var(--primary)">💹 Price Sync Settings</div>
  <div class="form-row">
    <div class="form-group"><label class="form-label">USD → INR Rate</label>
      <input class="form-input" id="rk-rate" type="number" step="0.1" value="${esc(fs.usd_to_inr_rate||'84')}" placeholder="84"></div>
    <div class="form-group"><label class="form-label">Profit % (markup)</label>
      <input class="form-input" id="rk-pct" type="number" step="1" value="${esc(fs.profit_pct||'30')}" placeholder="30"></div>
  </div>
  <p style="font-size:.8rem;color:var(--muted)">Formula: <code>₹ = ceil($ × rate × (1 + profit%))</code> — e.g. $2 × 84 × 1.30 = ₹219</p>

  <div style="font-weight:700;font-size:.85rem;margin:.75rem 0 .5rem;color:var(--primary)">🔄 Sync All Prices</div>
  <p style="font-size:.82rem;color:var(--muted);margin-bottom:.5rem">Fetches current USD prices from ResellKeys for all plans linked to a ResellKeys product ID, then recalculates INR with the profit % above.</p>
  <div id="sync-result"></div>
</div>
<div class="modal-footer" style="gap:.5rem;flex-wrap:wrap">
  <button class="btn btn-secondary" data-close>Cancel</button>
  <button class="btn btn-secondary" id="rk-test-btn">🔌 Test Connection</button>
  <button class="btn btn-secondary" id="rk-sync-btn">🔄 Sync All Prices Now</button>
  <button class="btn btn-primary" id="rk-save-btn">💾 Save Settings</button>
</div>`);

    document.getElementById('rk-test-btn').onclick = async () => {
      const msg = document.getElementById('rk-msg');
      const btn = document.getElementById('rk-test-btn');
      const old = btn.textContent;
      btn.disabled = true; btn.textContent = '⏳ Testing…';
      msg.innerHTML = '<div class="alert">Connecting to ResellKeys and signing in…</div>';
      try {
        // Persist the current field values first so we test exactly what's shown.
        await api('/fulfillment-settings', { method:'POST', body: JSON.stringify({
          resellkeys_api_url: document.getElementById('rk-url').value.trim(),
          resellkeys_email: document.getElementById('rk-email').value.trim(),
          resellkeys_password: document.getElementById('rk-pass').value,
        })});
        const r = await api('/resellkeys/test', { method:'POST', body: JSON.stringify({}) });
        msg.innerHTML = r.ok
          ? `<div class="alert alert-success">✅ ${esc(r.message)}</div>`
          : `<div class="alert alert-error">❌ ${esc(r.message)}</div>`;
      } catch(e) {
        msg.innerHTML = `<div class="alert alert-error">❌ ${esc(e.message)}</div>`;
      } finally { btn.disabled = false; btn.textContent = old; }
    };

    document.getElementById('rk-save-btn').onclick = async () => {
      const msg = document.getElementById('rk-msg');
      try {
        await api('/fulfillment-settings', { method:'POST', body: JSON.stringify({
          resellkeys_api_url: document.getElementById('rk-url').value.trim(),
          resellkeys_api_key: document.getElementById('rk-key').value,
          resellkeys_email: document.getElementById('rk-email').value.trim(),
          resellkeys_password: document.getElementById('rk-pass').value,
          usd_to_inr_rate: document.getElementById('rk-rate').value,
          profit_pct: document.getElementById('rk-pct').value,
        })});
        msg.innerHTML='<div class="alert alert-success">Settings saved!</div>';
      } catch(e) { msg.innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
    };

    document.getElementById('rk-sync-btn').onclick = async () => {
      const sr = document.getElementById('sync-result');
      const msg = document.getElementById('rk-msg');
      sr.innerHTML = '<div class="spinner"></div>';
      try {
        await api('/fulfillment-settings', { method:'POST', body: JSON.stringify({
          resellkeys_api_url: document.getElementById('rk-url').value.trim(),
          resellkeys_api_key: document.getElementById('rk-key').value,
          resellkeys_email: document.getElementById('rk-email').value.trim(),
          resellkeys_password: document.getElementById('rk-pass').value,
          usd_to_inr_rate: document.getElementById('rk-rate').value,
          profit_pct: document.getElementById('rk-pct').value,
        })});
        const r = await api('/plans/sync-resellkeys-prices', { method:'POST', body: JSON.stringify({
          profit_pct: parseFloat(document.getElementById('rk-pct').value) || 0,
          usd_to_inr_rate: parseFloat(document.getElementById('rk-rate').value) || 84,
        })});
        sr.innerHTML = `<div class="alert alert-success">✓ Updated ${r.updated} of ${r.total} linked products</div>`;
        views.plans(catFilter);
      } catch(e) { sr.innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
    };
  };

  window.scrapeResellKeys = () => {
    const ov = openModal(`
<div class="modal-header"><h3>🔍 Scrape ResellKeys Catalog</h3><button class="btn-icon" data-close>✕</button></div>
<div class="modal-body" style="max-height:75vh;overflow-y:auto">
  <div id="scrape-msg"></div>
  <p style="font-size:.82rem;color:var(--muted);margin-bottom:.75rem">
    Fetches HTML pages from <code>resellkeys.com/index.php?route=product/catalog&amp;fq=…&amp;page=N</code>,
    parses every product card, applies your <strong>Profit % + USD→INR rate</strong> from
    ⚙ ResellKeys settings, and shows a preview to import.
  </p>

  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:.6rem;margin-bottom:.65rem">
    <div class="form-group" style="margin:0">
      <label class="form-label" style="font-size:.75rem">Search (optional)</label>
      <input class="form-input" id="scrape-q" placeholder="e.g. netflix, office">
    </div>
    <div class="form-group" style="margin:0">
      <label class="form-label" style="font-size:.75rem">Category (fq=)</label>
      <input class="form-input" id="scrape-fq" value="11" placeholder="11">
    </div>
    <div class="form-group" style="margin:0">
      <label class="form-label" style="font-size:.75rem">Max pages</label>
      <input class="form-input" id="scrape-pages" type="number" min="1" max="50" value="15">
    </div>
  </div>
  <label style="display:flex;align-items:center;gap:.5rem;font-size:.85rem;margin-bottom:.5rem">
    <input type="checkbox" id="scrape-instock" checked>
    Only in-stock products (drops “Out Of Stock” cards)
  </label>

  <div style="display:flex;gap:.5rem;align-items:center;margin-top:.25rem;margin-bottom:.75rem">
    <button class="btn btn-secondary" id="scrape-search-btn">🔍 Fetch Catalog</button>
    <span id="scrape-progress" style="font-size:.78rem;color:var(--muted)"></span>
  </div>

  <div id="scrape-results"></div>
</div>
<div class="modal-footer">
  <button class="btn btn-secondary" data-close>Cancel</button>
  <button class="btn btn-secondary" id="scrape-toggle-all" style="display:none">Toggle all</button>
  <button class="btn btn-primary" id="scrape-import-btn" style="display:none">Import Selected (0)</button>
</div>`);

    let _scraped = [];

    function updateImportBtn() {
      const n = document.querySelectorAll('.scrape-cb:checked').length;
      const btn = document.getElementById('scrape-import-btn');
      btn.textContent = `Import Selected (${n})`;
      btn.disabled = !n;
    }

    function renderResults(r) {
      const res = document.getElementById('scrape-results');
      _scraped = r.products || [];
      if (!_scraped.length) {
        res.innerHTML = '<p class="muted" style="padding:.75rem 0">No products found. If you see this even on a known-good category, the markup may have changed — check Base URL in ⚙ ResellKeys settings.</p>';
        document.getElementById('scrape-import-btn').style.display = 'none';
        document.getElementById('scrape-toggle-all').style.display = 'none';
        return;
      }
      const inStockN = _scraped.filter(p => p.in_stock).length;
      const head = `<div style="font-size:.82rem;margin-bottom:.5rem;color:var(--muted);display:flex;justify-content:space-between;flex-wrap:wrap;gap:.5rem;align-items:center">
        <span><strong>${_scraped.length}</strong> products scanned across ${r.pages} page(s)
          · <span style="color:var(--green,#22c55e)">${inStockN} in stock</span>
          · Markup: ${r.profit_pct}% · Rate: $1 = ₹${r.usd_to_inr}</span>
      </div>`;
      const rows = _scraped.map((p,i)=>`<label style="display:flex;align-items:center;gap:.5rem;padding:.45rem .25rem;border-bottom:1px solid var(--border);${p.in_stock?'':'opacity:.55'}">
        <input type="checkbox" class="scrape-cb" data-i="${i}" ${p.in_stock?'checked':''}>
        ${p.image_url?`<img src="${esc(p.image_url)}" style="width:34px;height:34px;border-radius:6px;object-fit:cover;flex-shrink:0;background:#0a0a14" onerror="this.style.display='none'">`:'<div style="width:34px;height:34px;background:var(--input-bg);border-radius:6px;flex-shrink:0"></div>'}
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:.86rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(p.name)}">${esc(p.name)}</div>
          <div style="font-size:.7rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">ID ${esc(p.provider_product_id)} · ${esc(p.product_url||'').replace(/^https?:\/\/[^/]+/,'')||'—'}</div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div style="font-weight:700;font-size:.85rem">₹${Number(p.price_inr||0).toLocaleString('en-IN')}</div>
          <div style="font-size:.7rem;color:var(--muted)">$${Number(p.price_usd||0).toFixed(2)}</div>
        </div>
        <span style="font-size:.65rem;font-weight:700;padding:.15rem .4rem;border-radius:4px;flex-shrink:0;${p.in_stock?'background:rgba(34,197,94,.18);color:#22c55e':'background:rgba(239,68,68,.18);color:#ef4444'}">${p.in_stock?'IN STOCK':'OUT'}</span>
      </label>`).join('');
      res.innerHTML = head + rows;
      document.getElementById('scrape-toggle-all').style.display = '';
      document.getElementById('scrape-import-btn').style.display = '';
      res.querySelectorAll('.scrape-cb').forEach(cb => cb.addEventListener('change', updateImportBtn));
      updateImportBtn();
    }

    document.getElementById('scrape-search-btn').onclick = async () => {
      const msg = document.getElementById('scrape-msg');
      const res = document.getElementById('scrape-results');
      const prog = document.getElementById('scrape-progress');
      const btn = document.getElementById('scrape-search-btn');
      res.innerHTML = '<div class="spinner"></div>';
      msg.innerHTML = '';
      prog.textContent = 'Fetching… this can take 30–60 seconds for 15 pages';
      btn.disabled = true;
      try {
        const r = await api('/plans/scrape-resellkeys', { method:'POST', body: JSON.stringify({
          query:          document.getElementById('scrape-q').value.trim(),
          categoryFilter: document.getElementById('scrape-fq').value.trim() || '11',
          pages:          parseInt(document.getElementById('scrape-pages').value, 10) || 15,
          inStockOnly:    document.getElementById('scrape-instock').checked,
        })});
        prog.textContent = '';
        renderResults(r);
      } catch(e) {
        res.innerHTML = '';
        prog.textContent = '';
        msg.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
      } finally { btn.disabled = false; }
    };

    document.getElementById('scrape-toggle-all').onclick = () => {
      const cbs = [...document.querySelectorAll('.scrape-cb')];
      const allChecked = cbs.every(cb => cb.checked);
      cbs.forEach(cb => cb.checked = !allChecked);
      updateImportBtn();
    };

    document.getElementById('scrape-import-btn').onclick = async () => {
      const selected = [...document.querySelectorAll('.scrape-cb:checked')].map(cb => _scraped[+cb.dataset.i]);
      if (!selected.length) { showToast('Select at least one product', 'error'); return; }
      const btn = document.getElementById('scrape-import-btn');
      btn.disabled = true;
      btn.textContent = `Importing ${selected.length}…`;
      try {
        const r = await api('/plans/import-scraped', { method:'POST', body: JSON.stringify({ products: selected }) });
        ov.remove(); showToast(`Imported ${r.imported} products`); views.plans();
      } catch(e) {
        btn.disabled = false; updateImportBtn();
        showToast(e.message, 'error');
      }
    };
  };
}

let _allPlatforms = ['Netflix','Amazon Prime','Disney+','Sony LIV','Zee5','Hotstar','JioCinema','MX Player','Apple TV+','Voot','YouTube Premium','Spotify','Apple Music','Canva','Adobe','Microsoft 365','Google One','NordVPN','Other'];

async function loadPlatforms() {
  try { const r = await api('/plans/platforms'); _allPlatforms = r.platforms || _allPlatforms; } catch {}
}

window.managePlatforms = async () => {
  await loadPlatforms();
  let customList = [];
  try { const r = await api('/plans/platforms'); customList = r.custom || []; } catch {}
  const ov = openModal(`
<div class="modal-header"><h3>⚙ Manage Platforms</h3><button class="btn-icon" data-close>✕</button></div>
<div class="modal-body">
  <p style="font-size:.82rem;color:var(--muted);margin-bottom:.75rem">Default platforms are built-in. Add custom ones below — they appear in the Platform dropdown across all products.</p>
  <div id="plat-msg"></div>
  <div id="plat-list" style="max-height:220px;overflow-y:auto;margin-bottom:.75rem;border:1px solid var(--border);border-radius:8px;padding:.5rem">
    ${customList.length ? customList.map((p,i)=>`<div style="display:flex;align-items:center;justify-content:space-between;padding:.3rem .5rem;border-radius:6px" id="plat-row-${i}">
      <span style="font-size:.88rem">${esc(p)}</span>
      <button class="btn btn-sm btn-red" style="padding:2px 8px" onclick="removePlatform(${i})">✕</button>
    </div>`).join('') : '<p class="muted" style="text-align:center;padding:.5rem;font-size:.83rem">No custom platforms yet</p>'}
  </div>
  <div style="display:flex;gap:.5rem">
    <input class="form-input" id="new-plat-input" placeholder="e.g. Crunchyroll, Canva Pro, WinZip…" style="flex:1">
    <button class="btn btn-primary btn-sm" onclick="addPlatformEntry()">+ Add</button>
  </div>
</div>
<div class="modal-footer">
  <button class="btn btn-secondary" data-close>Cancel</button>
  <button class="btn btn-primary" id="save-plats-btn">Save Platforms</button>
</div>`);

  let _custom = [...customList];
  window.removePlatform = (i) => {
    _custom.splice(i, 1);
    const row = document.getElementById(`plat-row-${i}`);
    if (row) row.remove();
  };
  window.addPlatformEntry = () => {
    const inp = document.getElementById('new-plat-input');
    const val = inp.value.trim();
    if (!val) return;
    if (_custom.includes(val)) { showToast('Already exists', 'error'); return; }
    _custom.push(val);
    const list = document.getElementById('plat-list');
    const i = _custom.length - 1;
    list.insertAdjacentHTML('beforeend', `<div style="display:flex;align-items:center;justify-content:space-between;padding:.3rem .5rem;border-radius:6px" id="plat-row-${i}">
      <span style="font-size:.88rem">${esc(val)}</span>
      <button class="btn btn-sm btn-red" style="padding:2px 8px" onclick="removePlatform(${i})">✕</button>
    </div>`);
    inp.value = '';
  };
  document.getElementById('new-plat-input').addEventListener('keydown', e => { if (e.key === 'Enter') window.addPlatformEntry(); });
  document.getElementById('save-plats-btn').onclick = async () => {
    try {
      await api('/plans/platforms', { method:'POST', body: JSON.stringify({ custom: _custom }) });
      await loadPlatforms();
      ov.remove(); showToast('Platforms saved');
    } catch(e) { document.getElementById('plat-msg').innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
  };
};

window.openPlanModal = async function (plan = null) {
  await loadPlatforms();
  const f = plan || {};
  const features = Array.isArray(f.features) ? f.features : [];
  const isEdit = !!plan;

  const ov = openModal(`
<div class="modal-header"><h3>${isEdit ? 'Edit' : 'New'} Plan</h3><button class="btn-icon" data-close>✕</button></div>
<div class="modal-body" style="max-height:70vh;overflow-y:auto">
  <div id="plan-err"></div>
  <div class="form-row">
    <div class="form-group">
      <label class="form-label" style="display:flex;justify-content:space-between">Platform * <button type="button" class="btn btn-sm btn-secondary" style="padding:1px 8px;font-size:.75rem" onclick="managePlatforms()">⚙ Manage</button></label>
      <input class="form-input" id="pf-platform" list="pf-platform-list" value="${esc(f.platform||'')}" placeholder="Select or type platform…">
      <datalist id="pf-platform-list">${_allPlatforms.map(p=>`<option value="${esc(p)}">`).join('')}</datalist>
    </div>
    <div class="form-group">
      <label class="form-label">Badge</label>
      <select class="form-input" id="pf-badge">
        <option value="" ${!f.badge ? 'selected' : ''}>None</option>
        ${['POPULAR','BEST VALUE','NEW','HOT'].map(b => `<option ${f.badge === b ? 'selected' : ''}>${b}</option>`).join('')}
      </select>
    </div>
  </div>
  <div class="form-group"><label class="form-label">Plan Name *</label><input class="form-input" id="pf-name" value="${esc(f.name || '')}" placeholder="e.g. Netflix 4K — 1 Month" oninput="autoFillSlug()"></div>
  <div class="form-group">
    <label class="form-label" style="display:flex;justify-content:space-between;align-items:center">
      URL Slug
      <span style="font-size:.72rem;font-weight:400;color:var(--muted)">e.g. netflix-4k-1-month → /plans/netflix-4k-1-month</span>
    </label>
    <input class="form-input" id="pf-slug" value="${esc(f.slug||'')}" placeholder="auto-generated from name">
  </div>
  <div class="form-row">
    <div class="form-group"><label class="form-label">Duration (days)</label><input class="form-input" id="pf-duration" type="number" min="1" value="${f.duration_days || ''}" placeholder="30"></div>
    <div class="form-group"><label class="form-label">Stock (-1 = unlimited)</label><input class="form-input" id="pf-stock" type="number" min="-1" value="${f.stock ?? -1}"></div>
  </div>
  <div class="form-row">
    <div class="form-group"><label class="form-label">Price (₹) *</label><input class="form-input" id="pf-price" type="number" step="0.01" value="${f.price_inr || ''}" placeholder="149"></div>
    <div class="form-group"><label class="form-label">Original Price (₹)</label><input class="form-input" id="pf-orig" type="number" step="0.01" value="${f.original_price_inr || ''}" placeholder="299 (for strike-through)"></div>
  </div>
  <div class="form-group"><label class="form-label">Description</label><textarea class="form-input" id="pf-desc" rows="2">${esc(f.description || '')}</textarea></div>
  <div class="form-group">
    <label class="form-label">Features (bullet points)</label>
    <div class="feature-tags" id="feat-tags">
      ${features.map((ft, i) => featureTag(ft, i)).join('')}
    </div>
    <div style="display:flex;gap:.5rem">
      <input class="form-input" id="feat-input" placeholder="Add feature..." style="flex:1">
      <button type="button" class="btn btn-secondary btn-sm" onclick="addFeature()">Add</button>
    </div>
  </div>
  <div class="form-row">
    <div class="form-group"><label class="form-label">Sort Order</label><input class="form-input" id="pf-sort" type="number" value="${f.sort_order || 0}"></div>
    <div class="form-group"><label class="form-label">Category</label><input class="form-input" id="pf-cat" value="${esc(f.category||'')}" placeholder="netflix, ai_writing, etc."></div>
  </div>
  <div class="form-row">
    <div class="form-group"><label class="form-label">Price USD ($)</label><input class="form-input" id="pf-usd" type="number" step="0.01" value="${f.price_usd||''}" placeholder="0.00"></div>
    <div class="form-group">
      <label class="form-label">Image</label>
      <div style="display:flex;gap:.4rem;align-items:center">
        ${f.image_url?`<img id="pf-img-preview" src="${esc(f.image_url)}" style="width:36px;height:36px;border-radius:6px;object-fit:cover;flex-shrink:0">`:`<div id="pf-img-preview" style="width:36px;height:36px;background:var(--input-bg);border-radius:6px;flex-shrink:0"></div>`}
        <input class="form-input" id="pf-img" value="${esc(f.image_url||'')}" placeholder="https://logo.clearbit.com/netflix.com" style="flex:1" oninput="updateImgPreview()">
        ${isEdit?`<label class="btn btn-sm btn-secondary" style="cursor:pointer;white-space:nowrap" title="Upload image file">📁 Upload<input type="file" accept="image/*" id="pf-img-file" style="display:none" onchange="uploadPlanImage(${f.id})"></label>`:''}
      </div>
    </div>
  </div>
  <div style="font-weight:600;margin:.5rem 0 .25rem;font-size:.85rem">Auto Fulfillment (ResellKeys)</div>
  <div class="form-row">
    <div class="form-group"><label class="form-label">Provider</label>
      <select class="form-input" id="pf-provider">
        <option value="" ${!f.provider_api?'selected':''}>None (manual)</option>
        <option value="resellkeys" ${f.provider_api==='resellkeys'?'selected':''}>ResellKeys</option>
      </select></div>
    <div class="form-group"><label class="form-label">Provider Product ID</label><input class="form-input" id="pf-pid" value="${esc(f.provider_product_id||'')}" placeholder="ResellKeys product ID"></div>
  </div>
  <div class="form-row">
    <div class="form-group"><label class="form-label">Delivery Type</label>
      <select class="form-input" id="pf-deltype">
        <option value="manual" ${(f.delivery_type||'manual')==='manual'?'selected':''}>Manual</option>
        <option value="instant" ${f.delivery_type==='instant'?'selected':''}>Instant (from stock)</option>
        <option value="auto" ${f.delivery_type==='auto'?'selected':''}>Auto (via provider)</option>
      </select></div>
    <div class="form-group"><label class="form-label">Delivery Time Est.</label><input class="form-input" id="pf-deltime" value="${esc(f.delivery_time_est||'')}" placeholder="10 min, 1 hr, 24 hr"></div>
  </div>
  <div class="form-group" style="display:flex;align-items:center;gap:.75rem;padding-top:.25rem">
    <label class="form-label" style="margin:0">Active</label>
    <label class="toggle-switch"><input type="checkbox" id="pf-active" ${f.active !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
  </div>
</div>
<div class="modal-footer">
  <button class="btn btn-secondary" data-close>Cancel</button>
  <button class="btn btn-primary" id="save-plan-btn">${isEdit ? 'Update' : 'Create'} Plan</button>
</div>`);

  document.getElementById('feat-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addFeature(); } });

  // Auto-fill slug from plan name only when slug hasn't been manually edited
  window.autoFillSlug = () => {
    const slugEl = document.getElementById('pf-slug');
    if (!slugEl || slugEl.dataset.manualEdit === '1') return;
    const name = document.getElementById('pf-name')?.value || '';
    const platform = document.getElementById('pf-platform')?.value || '';
    const raw = `${platform} ${name}`.toLowerCase()
      .replace(/[—–]/g, '-').replace(/[^\w\s-]/g, '').replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 90);
    slugEl.value = raw;
  };
  // Mark as manually edited when admin types in the slug box
  const slugInput = document.getElementById('pf-slug');
  if (slugInput) slugInput.addEventListener('input', () => { slugInput.dataset.manualEdit = '1'; });

  document.getElementById('save-plan-btn').addEventListener('click', async () => {
    const body = {
      platform: document.getElementById('pf-platform').value,
      name: document.getElementById('pf-name').value.trim(),
      duration_days: parseInt(document.getElementById('pf-duration').value) || null,
      price_inr: parseFloat(document.getElementById('pf-price').value) || 0,
      original_price_inr: parseFloat(document.getElementById('pf-orig').value) || null,
      price_usd: parseFloat(document.getElementById('pf-usd').value) || 0,
      description: document.getElementById('pf-desc').value.trim(),
      features: getFeatures(),
      badge: document.getElementById('pf-badge').value || null,
      stock: parseInt(document.getElementById('pf-stock').value) ?? -1,
      active: document.getElementById('pf-active').checked ? 1 : 0,
      sort_order: parseInt(document.getElementById('pf-sort').value) || 0,
      category: document.getElementById('pf-cat').value.trim(),
      image_url: document.getElementById('pf-img').value.trim(),
      provider_api: document.getElementById('pf-provider').value,
      provider_product_id: document.getElementById('pf-pid').value.trim(),
      delivery_type: document.getElementById('pf-deltype').value,
      delivery_time_est: document.getElementById('pf-deltime').value.trim(),
      slug: document.getElementById('pf-slug')?.value.trim() || undefined,
    };
    if (!body.name) return showToast('Name required', 'error');
    try {
      if (isEdit) await api(`/plans/${f.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/plans', { method: 'POST', body: JSON.stringify(body) });
      ov.remove(); showToast(isEdit ? 'Plan updated' : 'Plan created'); views.plans();
    } catch (ex) { document.getElementById('plan-err').innerHTML = `<div class="alert alert-error">${esc(ex.message)}</div>`; }
  });
};

function featureTag(text, idx) {
  return `<span class="feature-tag" data-idx="${idx}">${esc(text)}<button onclick="removeFeature(${idx})">×</button></span>`;
}

window.addFeature = function () {
  const inp = document.getElementById('feat-input');
  const val = inp.value.trim(); if (!val) return;
  const tags = document.getElementById('feat-tags');
  const idx = tags.children.length;
  tags.insertAdjacentHTML('beforeend', featureTag(val, idx));
  inp.value = '';
};

window.removeFeature = function (idx) {
  document.querySelector(`.feature-tag[data-idx="${idx}"]`)?.remove();
  // Re-index
  document.querySelectorAll('.feature-tag').forEach((el, i) => el.dataset.idx = i);
};

function getFeatures() {
  return [...document.querySelectorAll('.feature-tag')].map(el => el.textContent.replace('×', '').trim());
}

window.quickSetImage = function(planId, currentUrl) {
  const ov = openModal(`
<div class="modal-header"><h3>🖼 Set Product Image</h3><button class="btn-icon" data-close>✕</button></div>
<div class="modal-body">
  <div class="form-group">
    <label class="form-label">Image URL</label>
    <input class="form-input" id="qi-url" value="${esc(currentUrl)}" placeholder="https://logo.clearbit.com/netflix.com">
  </div>
  <div style="display:flex;gap:.5rem;margin-top:.35rem;flex-wrap:wrap">
    <label class="btn btn-sm btn-secondary" style="cursor:pointer">📁 Upload File
      <input type="file" accept="image/*" id="qi-file" style="display:none" onchange="qiUpload(${planId})">
    </label>
  </div>
  <div id="qi-preview" style="margin-top:.5rem">${currentUrl?`<img src="${esc(currentUrl)}" style="height:60px;border-radius:8px;object-fit:contain">`:''}
  </div>
  <div id="qi-msg"></div>
</div>
<div class="modal-footer">
  <button class="btn btn-secondary" data-close>Cancel</button>
  <button class="btn btn-primary" id="qi-save">Save</button>
</div>`);
  document.getElementById('qi-url').addEventListener('input', function() {
    const p = document.getElementById('qi-preview');
    p.innerHTML = this.value ? `<img src="${esc(this.value)}" style="height:60px;border-radius:8px;object-fit:contain" onerror="this.style.display='none'">` : '';
  });
  window.qiUpload = async (id) => {
    const file = document.getElementById('qi-file')?.files[0];
    if (!file) return;
    const fd = new FormData(); fd.append('image', file);
    try {
      const res = await fetch(`/admin/api/plans/${id}/upload-image`, { method:'POST', credentials:'include', headers: { 'X-CSRF-Token': getCsrfToken() }, body: fd });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error);
      document.getElementById('qi-url').value = j.url;
      document.getElementById('qi-preview').innerHTML = `<img src="${esc(j.url)}" style="height:60px;border-radius:8px;object-fit:contain">`;
      showToast('Uploaded');
    } catch(e) { document.getElementById('qi-msg').innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
  };
  document.getElementById('qi-save').onclick = async () => {
    const image_url = document.getElementById('qi-url').value.trim();
    try {
      await api(`/plans/bulk-action`, { method:'POST', body: JSON.stringify({ action:'set-image-url', ids:[planId], image_url }) });
      ov.remove(); showToast('Image updated'); views.plans();
    } catch(e) { document.getElementById('qi-msg').innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
  };
};

window.updateImgPreview = function() {
  const url = document.getElementById('pf-img')?.value;
  const prev = document.getElementById('pf-img-preview');
  if (!prev) return;
  if (url) { prev.outerHTML = `<img id="pf-img-preview" src="${esc(url)}" style="width:36px;height:36px;border-radius:6px;object-fit:cover;flex-shrink:0" onerror="this.style.display='none'">`; }
};

window.uploadPlanImage = async function(planId) {
  const file = document.getElementById('pf-img-file')?.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('image', file);
  try {
    const res = await fetch(`/admin/api/plans/${planId}/upload-image`, { method:'POST', credentials:'include', headers: { 'X-CSRF-Token': getCsrfToken() }, body: fd });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error);
    const inp = document.getElementById('pf-img');
    if (inp) { inp.value = j.url; window.updateImgPreview(); }
    showToast('Image uploaded');
  } catch(e) { showToast(e.message, 'error'); }
};

window.editPlan = async function (id) {
  try {
    const plans = await api('/plans');
    const p = plans.find(x => x.id === id);
    if (p) openPlanModal(p);
  } catch (e) { showToast(e.message, 'error'); }
};

window.deletePlan = async function (id) {
  if (!confirm('Delete this plan? This cannot be undone.')) return;
  try { await api(`/plans/${id}`, { method: 'DELETE' }); showToast('Plan deleted'); views.plans(); }
  catch (e) { showToast(e.message, 'error'); }
};

window.togglePlan = async function (id) {
  try { await api(`/plans/${id}/toggle`, { method: 'PUT', body: '{}' }); }
  catch (e) { showToast(e.message, 'error'); views.plans(); }
};

// ── views.orders ──────────────────────────────────────────────────────────────
views.orders = async function (filters = {}) {
  setMain('<div class="spinner"></div>');
  try {
    const qs = new URLSearchParams(filters).toString();
    const orders = await api('/orders' + (qs ? '?' + qs : ''));
    PENDING_ORDERS = orders.filter(o => o.status === 'pending').length;
    window._ordersCache = {}; orders.forEach(o => { window._ordersCache[o.id] = o; });
    buildSidebar();
    const rows = orders.map(o => `
<tr>
  <td>#${o.id}</td>
  <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(o.customer_email || '—')}</td>
  <td>${esc(o.platform || '')} — ${esc(o.plan_name || '')}</td>
  <td>${fmt(o.amount_inr)}</td>
  <td>${statusBadge(o.status)}</td>
  <td>${fmtDateShort(o.expires_at)}</td>
  <td>${fmtDateShort(o.created_at)}</td>
  <td>
    <button class="btn btn-secondary btn-sm" onclick="openOrderModal(${o.id})">Manage</button>
  </td>
</tr>`).join('');

    setMain(`
<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.75rem;margin-bottom:1rem">
  <h2 style="font-weight:800">Orders</h2>
  <div style="display:flex;gap:.6rem;flex-wrap:wrap">
    <select class="form-input" id="f-status" style="width:130px" onchange="filterOrders()">
      <option value="">All Status</option>
      ${['pending','processing','delivered','expired','cancelled'].map(s=>`<option value="${s}">${s}</option>`).join('')}
    </select>
    <input class="form-input" id="f-q" style="width:180px" placeholder="Search customer..." oninput="filterOrders()">
  </div>
</div>
<div class="table-wrap"><table>
  <thead><tr><th>ID</th><th>Customer</th><th>Plan</th><th>Amount</th><th>Status</th><th>Expires</th><th>Date</th><th>Actions</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="8" class="muted" style="text-align:center;padding:2rem">No orders found</td></tr>'}</tbody>
</table></div>`);
  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

window.filterOrders = function () {
  const status = document.getElementById('f-status')?.value;
  const q = document.getElementById('f-q')?.value;
  views.orders({ ...(status && { status }), ...(q && { q }) });
};

window.openOrderModal = function (id) {
  const o = (window._ordersCache && window._ordersCache[id]) || { id };
  const creds = (o.credentials && typeof o.credentials === 'object') ? o.credentials : {};
  const credKeys = ['email', 'password', 'key', 'link', 'pin', 'notes'];
  const credFields = credKeys.map(k => `
<div class="form-group" style="margin-bottom:.5rem"><label class="form-label" style="text-transform:capitalize">${k}</label>
<input class="form-input" id="oc-${k}" value="${esc(creds[k] || '')}" placeholder="${k}"></div>`).join('');
  const delivered = o.status === 'delivered';

  const ov = openModal(`
<div class="modal-header"><h3>Order #${o.id} — Manage &amp; Deliver</h3><button class="btn-icon" data-close>✕</button></div>
<div class="modal-body" style="max-height:78vh;overflow-y:auto">
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem;background:var(--input-bg);border-radius:var(--radius-sm);padding:.9rem;margin-bottom:.6rem">
    <div><div class="muted" style="font-size:.73rem">CUSTOMER</div><div style="font-weight:600">${esc(o.customer_email||o.customer_name||'—')}</div></div>
    <div><div class="muted" style="font-size:.73rem">PLAN</div><div style="font-weight:600">${esc(o.platform||'')} — ${esc(o.plan_name||'')}</div></div>
    <div><div class="muted" style="font-size:.73rem">AMOUNT</div><div style="font-weight:600">${fmt(o.amount_inr)}</div></div>
    <div><div class="muted" style="font-size:.73rem">STATUS</div><div>${statusBadge(o.status)}</div></div>
  </div>

  ${!delivered ? `<div style="background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.3);border-radius:10px;padding:.75rem;margin-bottom:.75rem">
    ${o.provider_api === 'bot' ? `<button class="btn btn-sm" id="buy-bot-btn" style="background:linear-gradient(135deg,#2b6fff,#8d5cff);border:none;color:#fff;margin-right:.4rem">🤖 Buy from bot &amp; deliver</button>` : ''}
    <button class="btn btn-sm" id="deliver-stock-btn" style="background:#16a34a;border-color:#16a34a;color:#fff">🚀 Deliver from Stock</button>
    <div class="muted" style="font-size:.76rem;margin-top:.45rem">${o.provider_api === 'bot' ? 'Buy from bot buys the key live and delivers it — best for ✋ manual bot products. ' : ''}Deliver from Stock pulls the next available credential. Both notify the customer by email + WhatsApp.</div>
  </div>` : ''}

  <div style="font-weight:700;margin:.4rem 0 .35rem">Credentials ${delivered ? '<span class="muted" style="font-weight:400;font-size:.78rem">(already delivered)</span>' : '<span class="muted" style="font-weight:400;font-size:.78rem">(enter to deliver manually)</span>'}</div>
  ${credFields}
  <div class="form-group"><label class="form-label">Delivery Note (shown to customer)</label>
    <textarea class="form-input" id="oc-note" rows="2">${esc(o.delivery_note||'')}</textarea></div>

  <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin:.5rem 0 .9rem">
    <button class="btn btn-primary" id="manual-deliver-btn">📤 Deliver — WhatsApp + Email</button>
    <button class="btn btn-secondary" id="copy-creds-btn">📋 Copy</button>
    <button class="btn btn-secondary" id="resend-email-btn">📧 Resend Email</button>
    <button class="btn btn-secondary" id="wa-deliver-btn">💬 Resend WhatsApp</button>
  </div>

  <div class="form-group"><label class="form-label">Status</label>
    <select class="form-input" id="oc-status">${['pending','processing','delivered','expired','cancelled'].map(s=>`<option ${o.status===s?'selected':''}>${s}</option>`).join('')}</select></div>
  <div class="form-group"><label class="form-label">Expires At</label>
    <input class="form-input" id="oc-expires" type="datetime-local" value="${o.expires_at ? o.expires_at.replace(' ','T').slice(0,16) : ''}"></div>
</div>
<div class="modal-footer">
  ${o.status !== 'cancelled' && Number(o.amount_inr) > 0 ? `<button class="btn" id="refund-wallet-btn" style="background:#dc2626;border-color:#dc2626;color:#fff;margin-right:auto">↩ Cancel &amp; Refund ${fmt(o.amount_inr)} to Wallet</button>` : ''}
  <button class="btn btn-secondary" data-close>Close</button>
  <button class="btn btn-primary" id="save-order-btn">💾 Save Changes</button>
</div>`);

  const readCreds = () => {
    const c = {};
    credKeys.forEach(k => { const v = document.getElementById(`oc-${k}`)?.value.trim(); if (v) c[k] = v; });
    return c;
  };

  const stockBtn = document.getElementById('deliver-stock-btn');
  if (stockBtn) stockBtn.addEventListener('click', async () => {
    if (!confirm('Deliver this order from stock? Customer will be notified by email + WhatsApp.')) return;
    stockBtn.disabled = true;
    try { const r = await api(`/orders/${o.id}/deliver-stock`, { method: 'POST' }); ov.remove(); showToast(r.message || 'Delivered from stock'); views.orders(); }
    catch (ex) { stockBtn.disabled = false; showToast(ex.message, 'error'); }
  });

  const buyBotBtn = document.getElementById('buy-bot-btn');
  if (buyBotBtn) buyBotBtn.addEventListener('click', async () => {
    if (!confirm('Buy this product from your bot and deliver it to the customer?')) return;
    buyBotBtn.disabled = true; buyBotBtn.textContent = '⏳ Buying…';
    try {
      const r = await api(`/orders/${o.id}/buy-from-bot`, { method: 'POST' });
      if (r.delivered) { ov.remove(); showToast('Bought from bot & delivered ✅'); views.orders(); }
      else { alert(r.message); buyBotBtn.disabled = false; buyBotBtn.innerHTML = '🤖 Buy from bot &amp; deliver'; }
    } catch (ex) { alert(ex.message); buyBotBtn.disabled = false; buyBotBtn.innerHTML = '🤖 Buy from bot &amp; deliver'; }
  });

  document.getElementById('manual-deliver-btn').addEventListener('click', async () => {
    const credentials = readCreds();
    if (!Object.keys(credentials).length) return showToast('Enter at least one credential field first', 'error');
    if (!confirm('Send these credentials to the customer now via WhatsApp + Email?')) return;
    const btn = document.getElementById('manual-deliver-btn'); btn.disabled = true;
    try {
      const r = await api(`/orders/${o.id}/manual-deliver`, { method: 'POST', body: JSON.stringify({ credentials, note: document.getElementById('oc-note').value.trim() }) });
      ov.remove(); showToast(r.message || 'Delivered'); views.orders();
    } catch (ex) { btn.disabled = false; showToast(ex.message, 'error'); }
  });

  document.getElementById('copy-creds-btn').addEventListener('click', () => {
    const lines = credKeys.map(k => { const v = document.getElementById(`oc-${k}`)?.value.trim(); return v ? `${k}: ${v}` : null; }).filter(Boolean);
    if (!lines.length) return showToast('No credentials to copy', 'error');
    navigator.clipboard.writeText(lines.join('\n')).then(() => showToast('Credentials copied!'));
  });

  document.getElementById('resend-email-btn').addEventListener('click', async () => {
    if (!confirm('Re-send the delivery email to the customer?')) return;
    try { await api(`/orders/${o.id}/resend-email`, { method: 'POST' }); showToast('Email sent!'); }
    catch (ex) { showToast(ex.message, 'error'); }
  });

  document.getElementById('wa-deliver-btn').addEventListener('click', async () => {
    if (!confirm('Re-send the saved credentials via WhatsApp?')) return;
    try { await api(`/orders/${o.id}/wa-deliver`, { method: 'POST' }); showToast('Sent via WhatsApp!'); }
    catch (ex) { showToast(ex.message, 'error'); }
  });

  const refundBtn = document.getElementById('refund-wallet-btn');
  if (refundBtn) refundBtn.addEventListener('click', async () => {
    if (!confirm(`Cancel order #${o.id} and refund ${fmt(o.amount_inr)} to the customer's wallet?\n\nThe order is marked cancelled and the customer is notified by email + WhatsApp.`)) return;
    refundBtn.disabled = true;
    try {
      const r = await api(`/orders/${o.id}/refund-wallet`, { method: 'POST' });
      ov.remove(); showToast(`Refunded ${fmt(r.refunded)} → wallet balance ${fmt(r.new_balance)}`); views.orders();
    } catch (ex) { refundBtn.disabled = false; showToast(ex.message, 'error'); }
  });

  document.getElementById('save-order-btn').addEventListener('click', async () => {
    const credentials = readCreds();
    try {
      await api(`/orders/${o.id}`, { method: 'PUT', body: JSON.stringify({
        status: document.getElementById('oc-status').value,
        credentials: Object.keys(credentials).length ? credentials : undefined,
        delivery_note: document.getElementById('oc-note').value.trim(),
        expires_at: document.getElementById('oc-expires').value || undefined,
      }) });
      ov.remove(); showToast('Order updated'); views.orders();
    } catch (ex) { showToast(ex.message, 'error'); }
  });
};

// ── views.topups ──────────────────────────────────────────────────────────────
// Direct-checkout payment log (UPI IMAP + USDT IMAP). Read-only — payments
// are auto-verified by the IMAP worker. No manual approval, no wallet credit.
views.topups = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const all = await api('/topups');
    const pending = all.filter(t => t.status === 'pending');
    PENDING_TOPUPS = pending.length; buildSidebar();
    const methodLabel = m => ({
      upi_imap: 'UPI · IMAP',
      usdt_binance: 'USDT · Binance',
      usdt_bep20: 'USDT · BEP20',
      usdt_trc20: 'USDT · TRC20',
    })[m] || m || '—';
    const amtCell = t => (t.currency === 'USDT')
      ? `${Number(t.unique_amount_usdt || t.amount_usdt || 0).toFixed(3)} USDT`
      : `${fmt(t.unique_amount || t.amount_inr)}`;
    const actionsOf = t => {
      if (t.status === 'pending') return `<button class="btn btn-green btn-sm" onclick="verifyTopup(${t.id})">✓ Verify</button> <button class="btn btn-secondary btn-sm" onclick="cancelTopup(${t.id})">✕ Cancel</button>`;
      if (t.status === 'refund_needed') return `<button class="btn btn-green btn-sm" onclick="verifyTopup(${t.id})" title="Create &amp; deliver the order">✓ Deliver</button> <button class="btn btn-sm" style="background:#dc2626;border-color:#dc2626;color:#fff" onclick="refundTopup(${t.id})">↩ Refund</button>`;
      return '—';
    };
    const rowOf = t => `
<tr>
  <td>#${t.id}</td>
  <td>${esc(t.email||'—')}</td>
  <td style="font-weight:700;font-variant-numeric:tabular-nums">${amtCell(t)}</td>
  <td><span class="badge badge-blue">${esc(methodLabel(t.method))}</span></td>
  <td>${statusBadge(t.status)}</td>
  <td>${t.order_id?`<a href="#orders" onclick="views.orders()">#${t.order_id}</a>`:'—'}</td>
  <td style="font-size:.8rem">${fmtDateShort(t.created_at)}</td>
  <td style="text-align:right;white-space:nowrap">${actionsOf(t)}</td>
</tr>`;
    window.TOPUPS = all; // lets the refund modal read amount/customer without re-fetching
    const pendingRows = pending.map(t => rowOf(t)).join('');
    const histRows = all.filter(t => t.status !== 'pending').slice(0, 50).map(t => rowOf(t)).join('');

    setMain(`
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem">
  <h2 style="font-weight:800">Payment Log</h2>
  <button class="btn btn-secondary btn-sm" onclick="views.topups()">↻ Refresh</button>
</div>
<p class="muted" style="margin-bottom:1rem">Every direct-checkout UPI/USDT payment lands here and is auto-verified by the IMAP worker. <b>In-flight</b> = waiting for the bank email: <b>✓ Verify</b> (only after confirming the money arrived) creates &amp; delivers the order, or <b>✕ Cancel</b> if the customer never paid. <b>History</b> shows the outcome — <b>Approved</b> (delivered), <b>Expired</b> (window passed unpaid), <b>Refund needed</b> (paid but couldn't deliver). On a <b>Refund needed</b> row you can <b>✓ Deliver</b> it now, or <b>↩ Refund</b> the customer (to their store wallet, or mark as paid-back).</p>
<div class="card" style="margin-bottom:1.5rem">
  <div style="font-weight:700;margin-bottom:.75rem">In-flight ${pending.length?`<span class="pending-dot">${pending.length}</span>`:''}</div>
  <div class="table-wrap"><table>
    <thead><tr><th>ID</th><th>Customer</th><th>Amount</th><th>Method</th><th>Status</th><th>Order</th><th>Created</th><th style="text-align:right">Actions</th></tr></thead>
    <tbody>${pendingRows||'<tr><td colspan="8" class="muted" style="text-align:center;padding:1.5rem">No in-flight payments</td></tr>'}</tbody>
  </table></div>
</div>
<div class="card">
  <div style="font-weight:700;margin-bottom:.75rem">History (last 50)</div>
  <div class="table-wrap"><table>
    <thead><tr><th>ID</th><th>Customer</th><th>Amount</th><th>Method</th><th>Status</th><th>Order</th><th>Created</th><th style="text-align:right">Actions</th></tr></thead>
    <tbody>${histRows||'<tr><td colspan="8" class="muted" style="text-align:center;padding:1rem">No history</td></tr>'}</tbody>
  </table></div>
</div>`);

    window.verifyTopup = async (id) => {
      if (!confirm('Manually verify payment #'+id+'?\n\nOnly do this if you have CONFIRMED the money was received — it creates the order and delivers it to the customer immediately.')) return;
      try {
        const r = await api('/topups/'+id+'/verify', { method:'POST' });
        showToast('Verified — order #'+r.order_id+' created & delivering');
        views.topups();
      } catch(e){ showToast(e.message, 'error'); }
    };
    window.cancelTopup = async (id) => {
      if (!confirm('Cancel payment #'+id+'?\n\nUse this for an in-flight payment the customer never actually paid. It just clears the entry — no money is moved.')) return;
      try { await api('/topups/'+id+'/cancel', { method:'POST' }); showToast('Payment cancelled'); views.topups(); }
      catch(e){ showToast(e.message, 'error'); }
    };
    window.refundTopup = (id) => {
      const t = (window.TOPUPS||[]).find(x => x.id === id) || {};
      const amt = Number(t.amount_inr || t.unique_amount || 0);
      const who = t.email || 'the customer';
      openModal(`<div class="modal-header"><h3 style="font-weight:800">↩ Refund payment #${id}</h3></div>
<div class="modal-body">
  <p style="margin:0 0 .8rem">Refund <strong>${fmt(amt)}</strong> for <strong>${esc(who)}</strong>. Choose how:</p>
  <div style="display:flex;flex-direction:column;gap:.6rem">
    <button class="btn btn-primary" id="rf-wallet" style="text-align:left">↩ Refund ${fmt(amt)} to store wallet<br><span style="font-weight:400;opacity:.85;font-size:.82rem">Instant credit — they reuse it at checkout. Emails + WhatsApps them.</span></button>
    <button class="btn btn-secondary" id="rf-ext" style="text-align:left">✓ Just mark as refunded<br><span style="font-weight:400;opacity:.8;font-size:.82rem">Use if you already paid them back outside the app (UPI/bank).</span></button>
  </div>
</div>
<div class="modal-footer"><button class="btn btn-secondary" data-close>Cancel</button></div>`);
      const doRefund = async (toWallet) => {
        try {
          const r = await api('/topups/'+id+'/refund', { method:'POST', body: JSON.stringify({ to_wallet: toWallet }) });
          document.querySelector('.modal-overlay')?.remove();
          showToast(toWallet ? `Refunded ${fmt(r.refunded)} → wallet` : 'Marked as refunded');
          views.topups();
        } catch(e){ showToast(e.message, 'error'); }
      };
      document.getElementById('rf-wallet').onclick = () => doRefund(true);
      document.getElementById('rf-ext').onclick = () => doRefund(false);
    };
  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

// ── views.wallet ──────────────────────────────────────────────────────────────
views.wallet = async function (q = '') {
  setMain('<div class="spinner"></div>');
  try {
    const d = await api('/wallet/overview' + (q ? `?q=${encodeURIComponent(q)}` : ''));
    const esc1 = s => esc(String(s || '').replace(/'/g, ''));
    const rows = (d.customers || []).map(c => `
<tr>
  <td style="font-weight:600">${esc(c.name || '—')}</td>
  <td style="font-size:.8rem">${esc(c.email || '—')}</td>
  <td>${esc(c.phone || '—')}</td>
  <td style="font-weight:800;color:${c.wallet_inr >= 0 ? '#16a34a' : '#dc2626'}">${fmtInr(c.wallet_inr)}</td>
  <td><div style="display:flex;gap:.35rem;justify-content:flex-end;flex-wrap:wrap">
    <button class="btn btn-green btn-sm" onclick="walletAdjust('${esc1(c.jid)}','${esc1(c.name)}',1)">+ Add</button>
    <button class="btn btn-secondary btn-sm" onclick="walletAdjust('${esc1(c.jid)}','${esc1(c.name)}',-1)">− Deduct</button>
    <button class="btn btn-secondary btn-sm" onclick="walletHistory('${esc1(c.jid)}','${esc1(c.name)}')">History</button>
  </div></td>
</tr>`).join('');
    const txns = (d.recent || []).map(t => `
<tr>
  <td style="font-size:.78rem">${fmtDateShort(t.created_at)}</td>
  <td style="font-size:.82rem">${esc(t.name || t.email || '—')}</td>
  <td><span class="badge ${t.amount_inr >= 0 ? 'badge-green' : 'badge-red'}">${esc(t.type || '')}</span></td>
  <td style="font-size:.8rem">${esc(t.label || '')}</td>
  <td style="text-align:right;font-weight:700;color:${t.amount_inr >= 0 ? '#16a34a' : '#dc2626'}">${t.amount_inr >= 0 ? '+' : ''}${fmtInr(t.amount_inr)}</td>
</tr>`).join('');
    setMain(`
<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.75rem;margin-bottom:1rem">
  <h2 style="font-weight:800">👛 Wallet Management</h2>
</div>
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem;margin-bottom:1.25rem">
  <div class="card stat-box"><div class="stat-box-label">Total Wallet Liability</div><div class="stat-box-value">${fmtInr(d.liability)}</div><div class="muted" style="font-size:.72rem">balance owed to customers</div></div>
  <div class="card stat-box"><div class="stat-box-label">Wallet Holders</div><div class="stat-box-value">${d.holders || 0}</div><div class="muted" style="font-size:.72rem">customers with a balance</div></div>
</div>
<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.6rem;margin-bottom:.6rem">
  <h3 style="font-weight:700;margin:0">Balances</h3>
  <input class="form-input" id="wallet-search" style="width:220px" placeholder="Search name/email/phone..." value="${esc(q)}" oninput="searchWallet(this.value)">
</div>
<div class="table-wrap"><table>
  <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Balance</th><th style="text-align:right">Actions</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="5" class="muted" style="text-align:center;padding:2rem">No customers have a wallet balance yet</td></tr>'}</tbody>
</table></div>
<h3 style="font-weight:700;margin:1.5rem 0 .6rem">Recent wallet activity</h3>
<div class="table-wrap"><table>
  <thead><tr><th>Date</th><th>Customer</th><th>Type</th><th>Note</th><th style="text-align:right">Amount</th></tr></thead>
  <tbody>${txns || '<tr><td colspan="5" class="muted" style="text-align:center;padding:2rem">No wallet activity yet</td></tr>'}</tbody>
</table></div>`);
  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

let _walletSearchTimer;
window.searchWallet = function (q) {
  clearTimeout(_walletSearchTimer);
  _walletSearchTimer = setTimeout(() => views.wallet(q), 350);
};

// Credit / debit a customer's wallet from the Wallet page (sign: +1 add, −1 deduct).
window.walletAdjust = async function (jid, name, sign) {
  const raw = prompt(`${sign > 0 ? 'Add credit to' : 'Deduct from'} ${name || 'this customer'}'s wallet.\nAmount in ₹:`);
  if (raw === null) return;
  const val = Math.abs(parseFloat(raw));
  if (!val || isNaN(val)) { showToast('Enter a valid amount', 'error'); return; }
  const note = prompt('Note (optional — shown in the customer\'s wallet history):') || '';
  try {
    const r = await api(`/customers/${encodeURIComponent(jid)}/wallet-adjust`, { method: 'POST', body: JSON.stringify({ amount: sign > 0 ? val : -val, note }) });
    showToast(`Wallet updated → ${fmtInr(r.new_balance)}`);
    views.wallet(document.getElementById('wallet-search')?.value || '');
  } catch (e) { showToast(e.message, 'error'); }
};

// Drill into one customer's wallet transaction history.
window.walletHistory = async function (jid, name) {
  try {
    const d = await api(`/customers/${encodeURIComponent(jid)}/wallet-txns`);
    const rows = (d.txns || []).map(t => `<tr>
      <td style="font-size:.78rem">${fmtDateShort(t.created_at)}</td>
      <td><span class="badge ${t.amount_inr >= 0 ? 'badge-green' : 'badge-red'}">${esc(t.type || '')}</span></td>
      <td style="font-size:.8rem">${esc(t.label || '')}</td>
      <td style="text-align:right;font-weight:700;color:${t.amount_inr >= 0 ? '#16a34a' : '#dc2626'}">${t.amount_inr >= 0 ? '+' : ''}${fmtInr(t.amount_inr)}</td>
    </tr>`).join('');
    openModal(`<div class="modal-header"><h3 style="font-weight:800">👛 ${esc(name || 'Customer')} — wallet history</h3></div>
<div class="modal-body"><div style="margin-bottom:.6rem">Current balance: <strong>${fmtInr(d.balance)}</strong></div>
<div class="table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Note</th><th style="text-align:right">Amount</th></tr></thead>
<tbody>${rows || '<tr><td colspan="4" class="muted" style="text-align:center;padding:1.5rem">No transactions yet</td></tr>'}</tbody></table></div></div>
<div class="modal-footer"><button class="btn btn-secondary" data-close>Close</button></div>`);
  } catch (e) { showToast(e.message, 'error'); }
};

// ── views.customers ───────────────────────────────────────────────────────────
views.customers = async function (q = '') {
  setMain('<div class="spinner"></div>');
  try {
    const url = '/customers' + (q ? `?q=${encodeURIComponent(q)}` : '');
    const customers = await api(url);
    const rows = customers.map(c => `
<tr>
  <td style="font-weight:600">${esc(c.name||'—')}</td>
  <td style="font-size:.8rem">${esc(c.email||'—')}</td>
  <td>${esc(c.phone||'—')}</td>
  <td>${c.order_count}</td>
  <td>${c.blocked ? '<span class="badge badge-red">Blocked</span>' : '<span class="badge badge-green">Active</span>'}</td>
  <td>${fmtDateShort(c.created_at)}</td>
  <td>
    <div style="display:flex;gap:.35rem;justify-content:flex-end;flex-wrap:wrap">
      <button class="btn btn-secondary btn-sm" onclick="openCustomerModal('${esc(c.jid)}')">Edit</button>
      <button class="btn btn-green btn-sm" onclick="loginAsCustomer('${esc(c.jid)}')" title="Open /my as this customer">Login As</button>
    </div>
  </td>
</tr>`).join('');

    setMain(`
<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.75rem;margin-bottom:1rem">
  <h2 style="font-weight:800">Customers</h2>
  <div style="display:flex;gap:.6rem;flex-wrap:wrap">
    <button class="btn btn-secondary btn-sm" onclick="findDuplicates()" title="Find &amp; merge accounts that share an email or WhatsApp number">🔀 Merge duplicates</button>
    <input class="form-input" id="cust-search" style="width:220px" placeholder="Search name/email/phone..." value="${esc(q)}" oninput="searchCustomers(this.value)">
  </div>
</div>
<div class="table-wrap"><table>
  <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Orders</th><th>Status</th><th>Joined</th><th>Actions</th></tr></thead>
  <tbody>${rows||'<tr><td colspan="7" class="muted" style="text-align:center;padding:2rem">No customers found</td></tr>'}</tbody>
</table></div>`);
  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

let _custSearchTimer;
window.searchCustomers = function (q) {
  clearTimeout(_custSearchTimer);
  _custSearchTimer = setTimeout(() => views.customers(q), 350);
};

// Find accounts that share an email or WhatsApp number, and merge them into one.
window.findDuplicates = async function () {
  try {
    const d = await api('/customers/duplicates');
    const groups = d.groups || [];
    if (!groups.length) { showToast('No duplicate accounts found 🎉'); return; }
    window._DUP_GROUPS = groups;
    const groupHtml = groups.map((g, gi) => {
      const rows = g.members.map(m => `
        <label style="display:flex;align-items:center;gap:.55rem;padding:.5rem .6rem;border:1px solid var(--border,rgba(255,255,255,.12));border-radius:8px;margin-bottom:.35rem;cursor:pointer">
          <input type="radio" name="primary-${gi}" value="${esc(m.jid)}" ${m.jid === g.primary_jid ? 'checked' : ''}>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600">${esc(m.name || '—')} ${m.order_count ? `<span class="badge badge-green" style="font-size:.66rem">${m.order_count} orders</span>` : ''} ${Number(m.wallet_inr) ? `<span class="badge badge-blue" style="font-size:.66rem">${fmt(m.wallet_inr)} wallet</span>` : ''}</div>
            <div class="muted" style="font-size:.77rem">${esc(m.email || 'no email')} · ${esc(m.phone || 'no phone')}</div>
          </div>
        </label>`).join('');
      return `<div class="card" style="margin-bottom:.75rem;padding:.7rem">
        <div style="font-size:.78rem;color:var(--muted);margin-bottom:.4rem">${g.members.length} accounts share an email/number — pick the one to <b>keep</b>:</div>
        ${rows}
        <button class="btn btn-primary btn-sm" style="margin-top:.35rem" onclick="mergeGroup(${gi})">🔀 Merge into selected</button>
      </div>`;
    }).join('');
    openModal(`<div class="modal-header"><h3 style="font-weight:800">🔀 Merge duplicate accounts</h3></div>
<div class="modal-body"><p class="muted" style="margin:0 0 .75rem">These accounts share an email or WhatsApp number. Merging keeps the selected account and moves all its orders, payments, wallet balance and referrals onto it — the duplicates are deleted.</p>${groupHtml}</div>
<div class="modal-footer"><button class="btn btn-secondary" data-close>Done</button></div>`);
  } catch (e) { showToast(e.message, 'error'); }
};

window.mergeGroup = async function (gi) {
  const g = (window._DUP_GROUPS || [])[gi]; if (!g) return;
  const sel = document.querySelector(`input[name="primary-${gi}"]:checked`);
  const primary = sel ? sel.value : g.primary_jid;
  const duplicates = g.members.map(m => m.jid).filter(j => j !== primary);
  if (!duplicates.length) return;
  if (!confirm(`Merge ${duplicates.length} duplicate account(s) into the selected one?\n\nAll their orders, payments, wallet balance and referrals move onto the kept account, and the duplicates are deleted. This can't be undone.`)) return;
  try {
    const r = await api('/customers/merge', { method: 'POST', body: JSON.stringify({ primary, duplicates }) });
    showToast(`Merged ${r.merged} account(s) ✅`);
    document.querySelector('.modal-overlay')?.remove();
    views.customers(document.getElementById('cust-search')?.value || '');
  } catch (e) { showToast(e.message, 'error'); }
};

window.openCustomerModal = async function (jid) {
  try {
    // Single-customer fetch (the old search-by-q lookup failed for JIDs).
    const c = await api(`/customers/${encodeURIComponent(jid)}`);
    const recent = Array.isArray(c.recent_orders) ? c.recent_orders : [];
    const phoneClean = String(c.phone || '').replace(/\D/g, '');
    const waUrl = phoneClean ? `https://wa.me/${phoneClean}` : '';
    const mailUrl = c.email ? `mailto:${c.email}` : '';
    const fmtInr = fmt;
    const fmtDt = s => { if (!s) return '—'; try { return new Date(s).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return s; } };
    const statBadge = s => {
      const map = { delivered: 'badge-green', pending: 'badge-yellow', processing: 'badge-blue', cancelled: 'badge-red', failed: 'badge-red', expired: 'badge-grey' };
      return `<span class="badge ${map[s] || 'badge-grey'}">${esc(s || '')}</span>`;
    };
    const orderRows = recent.length ? recent.map(o => `
<tr>
  <td>#${o.id}</td>
  <td style="font-size:.85rem">${esc(o.platform || '—')} ${esc(o.plan_name || '')}</td>
  <td style="font-weight:700">${fmtInr(o.amount_inr)}</td>
  <td>${statBadge(o.status)}</td>
  <td style="font-size:.78rem;color:var(--muted)">${fmtDt(o.created_at)}</td>
</tr>`).join('') : `<tr><td colspan="5" class="muted" style="text-align:center;padding:1rem">No orders yet</td></tr>`;

    const ov = openModal(`
<div class="modal-header"><h3>Edit Customer · ${esc(c.name || 'Unknown')}</h3><button class="btn-icon" data-close>✕</button></div>
<div class="modal-body" style="max-height:80vh;overflow-y:auto">
  <div id="cust-err"></div>

  <!-- Quick actions row -->
  <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:1rem">
    <button class="btn btn-green btn-sm" id="cm-login-as">👤 Login As Customer</button>
    ${waUrl ? `<a class="btn btn-secondary btn-sm" href="${waUrl}" target="_blank" rel="noopener" style="text-decoration:none">💬 WhatsApp</a>` : ''}
    ${mailUrl ? `<a class="btn btn-secondary btn-sm" href="${mailUrl}" target="_blank" rel="noopener" style="text-decoration:none">✉️ Email</a>` : ''}
    <button class="btn btn-secondary btn-sm" id="cm-copy-jid">📋 Copy JID</button>
  </div>

  <!-- Stats row -->
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.5rem;margin-bottom:1.25rem">
    <div style="background:var(--input-bg);border-radius:8px;padding:.6rem .75rem">
      <div style="font-size:.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Joined</div>
      <div style="font-weight:700;font-size:.88rem;margin-top:2px">${fmtDateShort(c.created_at)}</div>
    </div>
    <div style="background:var(--input-bg);border-radius:8px;padding:.6rem .75rem">
      <div style="font-size:.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Last login</div>
      <div style="font-weight:700;font-size:.88rem;margin-top:2px">${c.last_login_at ? fmtDt(c.last_login_at) : 'Never'}</div>
    </div>
    <div style="background:var(--input-bg);border-radius:8px;padding:.6rem .75rem">
      <div style="font-size:.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Orders</div>
      <div style="font-weight:800;font-size:1rem;margin-top:2px">${c.order_count || 0}</div>
    </div>
    <div style="background:var(--input-bg);border-radius:8px;padding:.6rem .75rem">
      <div style="font-size:.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Total spent</div>
      <div style="font-weight:800;font-size:1rem;margin-top:2px">${fmtInr(c.total_spent_inr)}</div>
    </div>
  </div>

  <!-- Wallet -->
  <div style="background:linear-gradient(135deg,rgba(34,197,94,.1),rgba(16,185,129,.06));border:1px solid rgba(34,197,94,.3);border-radius:10px;padding:.85rem;margin-bottom:1.25rem">
    <div style="font-size:.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">💰 Wallet balance</div>
    <div style="font-weight:900;font-size:1.5rem;color:#16a34a" id="cm-wallet-bal">${fmtInr(c.wallet_inr)}</div>
    <div id="cm-wallet-msg"></div>
    <div style="display:grid;grid-template-columns:110px 1fr auto;gap:.5rem;align-items:end;margin-top:.5rem">
      <div class="form-group" style="margin:0"><label class="form-label" style="font-size:.72rem">Amount (±)</label><input class="form-input" id="cm-wallet-amt" type="number" step="0.01" placeholder="+100 / -50"></div>
      <div class="form-group" style="margin:0"><label class="form-label" style="font-size:.72rem">Note</label><input class="form-input" id="cm-wallet-note" placeholder="reason (optional)"></div>
      <button class="btn btn-sm btn-primary" id="cm-wallet-apply">Apply</button>
    </div>
    <div class="muted" style="font-size:.72rem;margin-top:.35rem">+ adds credit, − deducts. Order refunds land here automatically.</div>
  </div>

  <!-- Profile fields -->
  <div style="font-weight:700;margin-bottom:.5rem">Profile</div>
  <div class="form-row">
    <div class="form-group"><label class="form-label">Name</label><input class="form-input" id="cm-name" value="${esc(c.name||'')}"></div>
    <div class="form-group"><label class="form-label">Email</label><input class="form-input" id="cm-email" value="${esc(c.email||'')}"></div>
  </div>
  <div class="form-row">
    <div class="form-group"><label class="form-label">Phone</label><input class="form-input" id="cm-phone" value="${esc(c.phone||'')}"></div>
    <div class="form-group"><label class="form-label">Discount %</label><input class="form-input" id="cm-disc" type="number" min="0" max="100" value="${c.discount_percent||0}"></div>
  </div>
  <div style="display:flex;gap:1.25rem;align-items:center;margin:.5rem 0 1rem">
    <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer">
      <input type="checkbox" id="cm-reseller" ${c.is_reseller?'checked':''}> <span style="font-size:.88rem">Reseller</span>
    </label>
    <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer">
      <input type="checkbox" id="cm-blocked" ${c.blocked?'checked':''}> <span style="font-size:.88rem;color:${c.blocked?'var(--red)':'inherit'}">Blocked</span>
    </label>
  </div>

  <hr style="border-color:var(--border);margin:.5rem 0 1rem">

  <!-- Internal notes -->
  <div style="font-weight:700;margin-bottom:.5rem">Internal notes <span style="font-weight:400;color:var(--muted);font-size:.78rem">(visible only to admins)</span></div>
  <textarea class="form-input" id="cm-notes" rows="3" placeholder="e.g. paid via WhatsApp, prefers Hotstar, VIP customer..." style="resize:vertical">${esc(c.admin_notes||'')}</textarea>

  <hr style="border-color:var(--border);margin:1rem 0">

  <!-- Recent orders -->
  <div style="font-weight:700;margin-bottom:.5rem">Recent orders <span style="font-weight:400;color:var(--muted);font-size:.78rem">(last 10)</span></div>
  <div class="table-wrap" style="margin-bottom:1rem"><table style="font-size:.85rem">
    <thead><tr><th>ID</th><th>Plan</th><th>Amount</th><th>Status</th><th>Created</th></tr></thead>
    <tbody>${orderRows}</tbody>
  </table></div>

  <hr style="border-color:var(--border);margin:.5rem 0 1rem">

  <!-- Password reset -->
  <div style="font-weight:700;margin-bottom:.5rem">Reset password</div>
  <div style="display:flex;gap:.5rem;margin-bottom:1rem">
    <input class="form-input" id="cm-newpass" type="password" placeholder="New password (leave blank to skip)" autocomplete="new-password">
    <button class="btn btn-secondary btn-sm" id="cm-resetpass">Set password</button>
  </div>

  <p style="font-size:.72rem;color:var(--muted);margin:0">JID: <code>${esc(c.jid)}</code> · Referral code: <code>${esc(c.referral_code||'—')}</code></p>
</div>
<div class="modal-footer">
  <button class="btn btn-secondary" data-close>Cancel</button>
  <button class="btn btn-primary" id="save-cust-btn">💾 Save changes</button>
</div>`);

    // Wire up actions
    document.getElementById('cm-login-as').addEventListener('click', () => window.loginAsCustomer(c.jid));
    document.getElementById('cm-copy-jid').addEventListener('click', () => {
      try { navigator.clipboard.writeText(c.jid); showToast('JID copied'); } catch { showToast('Copy failed', 'error'); }
    });
    document.getElementById('cm-resetpass').addEventListener('click', () => window.resetCustPass(c.jid));
    document.getElementById('cm-wallet-apply').addEventListener('click', async () => {
      const amt = parseFloat(document.getElementById('cm-wallet-amt').value);
      const note = document.getElementById('cm-wallet-note').value.trim();
      const msg = document.getElementById('cm-wallet-msg');
      if (!amt) { msg.innerHTML = '<div class="alert alert-error">Enter a non-zero amount (+ credit / − debit)</div>'; return; }
      if (!confirm(`${amt > 0 ? 'Add' : 'Deduct'} ${fmtInr(Math.abs(amt))} ${amt > 0 ? 'to' : 'from'} ${c.name || 'this customer'}'s wallet?`)) return;
      try {
        const r = await api(`/customers/${encodeURIComponent(c.jid)}/wallet-adjust`, { method: 'POST', body: JSON.stringify({ amount: amt, note }) });
        document.getElementById('cm-wallet-bal').textContent = fmtInr(r.new_balance);
        document.getElementById('cm-wallet-amt').value = ''; document.getElementById('cm-wallet-note').value = '';
        msg.innerHTML = '<div class="alert alert-success">Wallet updated</div>'; setTimeout(() => msg.innerHTML = '', 2500);
      } catch (ex) { msg.innerHTML = `<div class="alert alert-error">${esc(ex.message)}</div>`; }
    });
    document.getElementById('save-cust-btn').addEventListener('click', async () => {
      try {
        await api(`/customers/${encodeURIComponent(c.jid)}`, { method: 'PUT', body: JSON.stringify({
          name: document.getElementById('cm-name').value,
          email: document.getElementById('cm-email').value,
          phone: document.getElementById('cm-phone').value,
          discount_percent: parseFloat(document.getElementById('cm-disc').value) || 0,
          is_reseller: document.getElementById('cm-reseller').checked ? 1 : 0,
          blocked: document.getElementById('cm-blocked').checked ? 1 : 0,
          admin_notes: document.getElementById('cm-notes').value,
        }) });
        ov.remove(); showToast('Customer updated'); views.customers();
      } catch (ex) { document.getElementById('cust-err').innerHTML = `<div class="alert alert-error">${esc(ex.message)}</div>`; }
    });
  } catch (e) { showToast(e.message, 'error'); }
};

window.resetCustPass = async function (jid) {
  const pw = document.getElementById('cm-newpass')?.value;
  if (!pw || pw.length < 6) return showToast('Password must be at least 6 chars', 'error');
  try {
    await api(`/customers/${encodeURIComponent(jid)}/password`, { method: 'PUT', body: JSON.stringify({ password: pw }) });
    showToast('Password reset!');
  } catch (e) { showToast(e.message, 'error'); }
};

window.loginAsCustomer = async function (jid) {
  try {
    const r = await api(`/customers/${encodeURIComponent(jid)}/login-as`, { method: 'POST', body: '{}' });
    // Set impersonation token as customerToken cookie (5-min)
    document.cookie = `customerToken=${r.token}; path=/; max-age=300; samesite=strict`;
    window.open('/my', '_blank');
  } catch (e) { showToast(e.message, 'error'); }
};

// ── views.mystore ─────────────────────────────────────────────────────────────
views.mystore = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const s = await api('/settings');
    setMain(`
<h2 style="font-weight:800;margin-bottom:1.5rem">My Store</h2>
<div class="card" style="max-width:640px">
<form id="store-form" style="display:flex;flex-direction:column;gap:.9rem">
  <div id="store-msg"></div>
  <div class="form-group"><label class="form-label">Store Name</label><input class="form-input" name="site_name" value="${esc(s.site_name||'')}"></div>
  <div class="form-group"><label class="form-label">Tagline</label><input class="form-input" name="site_tagline" value="${esc(s.site_tagline||'')}"></div>
  <div class="form-group"><label class="form-label">Telegram Bot URL <span class="muted">(shown as a CTA under every product Buy button — leave blank to hide)</span></label><input class="form-input" name="telegram_bot_url" value="${esc(s.telegram_bot_url||'')}" placeholder="https://t.me/your_bot"></div>
  <div class="card" style="padding:1rem;border:1px dashed var(--border);display:flex;flex-direction:column;gap:.8rem">
    <div style="font-weight:700;display:flex;align-items:center;gap:.4rem">🎬 Homepage Hero Text</div>
    <div style="font-size:.72rem;color:var(--muted);margin-top:-.4rem">The big headline shown on your storefront home page.</div>
    <div class="form-group"><label class="form-label">Heading — Line 1 <span class="muted">(highlighted / gradient)</span></label><input class="form-input" name="hero_title" value="${esc(s.hero_title||'')}" placeholder="Premium digital products."></div>
    <div class="form-group"><label class="form-label">Heading — Line 2</label><input class="form-input" name="hero_title2" value="${esc(s.hero_title2||'')}" placeholder="Delivered cinematic fast."></div>
    <div class="form-group"><label class="form-label">Subtext</label><textarea class="form-input" name="hero_subtext" rows="2" placeholder="Leave blank to use the Tagline above">${esc(s.hero_subtext||'')}</textarea></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Custom Button — Label <span class="muted">(extra hero button; leave blank to hide)</span></label><input class="form-input" name="hero_cta_label" value="${esc(s.hero_cta_label||'')}" placeholder="e.g. Join Telegram"></div>
      <div class="form-group"><label class="form-label">Custom Button — Link</label><input class="form-input" name="hero_cta_url" value="${esc(s.hero_cta_url||'')}" placeholder="https://t.me/your_channel"></div>
    </div>
  </div>
  <div class="form-group">
    <label class="form-label" style="margin-bottom:.6rem">Site Logo</label>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
      <div class="card" style="padding:1rem;border:2px dashed var(--border)">
        <div style="font-size:.8rem;font-weight:700;margin-bottom:.5rem;display:flex;align-items:center;gap:.4rem">☀️ Light Mode Logo</div>
        <div style="font-size:.72rem;color:var(--muted);margin-bottom:.75rem">Recommended: 280×100px · Max 2MB · PNG/SVG/WebP</div>
        <div id="logo-light-preview" style="height:56px;display:flex;align-items:center;justify-content:center;background:var(--card);border-radius:8px;margin-bottom:.75rem;overflow:hidden;border:1px solid var(--border)">
          ${s.logo_light_url ? `<img src="${esc(s.logo_light_url)}" style="max-height:48px;max-width:100%;object-fit:contain">` : '<span style="font-size:.75rem;color:var(--muted)">No logo</span>'}
        </div>
        <div style="display:flex;gap:.5rem">
          <label style="flex:1;cursor:pointer">
            <input type="file" accept="image/*" style="display:none" onchange="uploadLogo('light',this)">
            <span class="btn btn-secondary btn-sm" style="width:100%;display:block;text-align:center">Upload</span>
          </label>
          ${s.logo_light_url ? `<button type="button" class="btn btn-red btn-sm" onclick="deleteLogo('light')">Remove</button>` : ''}
        </div>
      </div>
      <div class="card" style="padding:1rem;border:2px dashed var(--border)">
        <div style="font-size:.8rem;font-weight:700;margin-bottom:.5rem;display:flex;align-items:center;gap:.4rem">🌙 Dark Mode Logo</div>
        <div style="font-size:.72rem;color:var(--muted);margin-bottom:.75rem">Recommended: 280×100px · Max 2MB · PNG/SVG/WebP</div>
        <div id="logo-dark-preview" style="height:56px;display:flex;align-items:center;justify-content:center;background:#111;border-radius:8px;margin-bottom:.75rem;overflow:hidden;border:1px solid var(--border)">
          ${s.logo_dark_url ? `<img src="${esc(s.logo_dark_url)}" style="max-height:48px;max-width:100%;object-fit:contain">` : '<span style="font-size:.75rem;color:var(--muted)">No logo</span>'}
        </div>
        <div style="display:flex;gap:.5rem">
          <label style="flex:1;cursor:pointer">
            <input type="file" accept="image/*" style="display:none" onchange="uploadLogo('dark',this)">
            <span class="btn btn-secondary btn-sm" style="width:100%;display:block;text-align:center">Upload</span>
          </label>
          ${s.logo_dark_url ? `<button type="button" class="btn btn-red btn-sm" onclick="deleteLogo('dark')">Remove</button>` : ''}
        </div>
      </div>
    </div>
  </div>
  <div class="form-row">
    <div class="form-group"><label class="form-label">Support Email</label><input class="form-input" name="support_email" type="email" value="${esc(s.support_email||'')}"></div>
    <div class="form-group"><label class="form-label">WhatsApp Support</label><input class="form-input" name="support_whatsapp" value="${esc(s.support_whatsapp||'')}" placeholder="+91... (green WhatsApp button in chat widget)"></div>
    <div class="form-group"><label class="form-label">Telegram Support</label><input class="form-input" name="support_telegram" value="${esc(s.support_telegram||'')}" placeholder="@username or https://t.me/... (Telegram button in widget)"></div>
  </div>
  <div class="form-group"><label class="form-label">Announcement Banner</label><textarea class="form-input" name="announcement" rows="2" placeholder="Shown in customer dashboard">${esc(s.announcement||'')}</textarea></div>
  <div class="form-group"><label class="form-label">Timezone</label>
    <select class="form-input" name="timezone">
      ${['Asia/Kolkata','Asia/Dubai','Asia/Singapore','America/New_York','Europe/London'].map(tz=>`<option ${s.timezone===tz?'selected':''}>${tz}</option>`).join('')}
    </select>
  </div>
  <div class="form-group"><label class="form-label">Base URL</label><input class="form-input" name="base_url" value="${esc(s.base_url||'')}" placeholder="https://store.watshop.in"><p class="muted" style="font-size:.78rem;margin-top:.3rem">Your live domain, with <code>https://</code> and no trailing slash. Used to build canonical links, the sitemap, email links, share links &amp; SEO tags — set this to your real domain in production.</p></div>
  <button type="submit" class="btn btn-primary">Save Store Settings</button>
</form></div>`);
    document.getElementById('store-form').onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = {}; fd.forEach((v, k) => body[k] = v);
      try {
        await api('/settings', { method: 'POST', body: JSON.stringify(body) });
        document.getElementById('store-msg').innerHTML = '<div class="alert alert-success">Saved!</div>';
        setTimeout(() => document.getElementById('store-msg').innerHTML = '', 2500);
      } catch (ex) { document.getElementById('store-msg').innerHTML = `<div class="alert alert-error">${esc(ex.message)}</div>`; }
    };
  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

// ── views.tickets ─────────────────────────────────────────────────────────────
views.tickets = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const tickets = await api('/tickets');
    const rows = tickets.map(t => `
<tr style="cursor:pointer" onclick="openTicketDetail(${t.id})">
  <td>#${t.id}</td>
  <td style="font-weight:600">${esc(t.subject)}</td>
  <td>${esc(t.email||'—')}</td>
  <td>${statusBadge(t.status)}</td>
  <td>${fmtDateShort(t.created_at)}</td>
</tr>`).join('');
    setMain(`
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem">
  <h2 style="font-weight:800">Support Tickets</h2>
  <div style="display:flex;gap:.5rem">
    <button class="btn btn-secondary btn-sm" onclick="views.tickets()">All</button>
    <button class="btn btn-secondary btn-sm" onclick="filterTickets('open')">Open</button>
    <button class="btn btn-secondary btn-sm" onclick="filterTickets('closed')">Closed</button>
  </div>
</div>
<div class="table-wrap"><table>
  <thead><tr><th>ID</th><th>Subject</th><th>Customer</th><th>Status</th><th>Date</th></tr></thead>
  <tbody>${rows||'<tr><td colspan="5" class="muted" style="text-align:center;padding:2rem">No tickets</td></tr>'}</tbody>
</table></div>`);
  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

window.filterTickets = async function (status) {
  setMain('<div class="spinner"></div>');
  try {
    const tickets = await api(`/tickets?status=${status}`);
    const rows = tickets.map(t => `
<tr style="cursor:pointer" onclick="openTicketDetail(${t.id})">
  <td>#${t.id}</td><td style="font-weight:600">${esc(t.subject)}</td>
  <td>${esc(t.email||'—')}</td><td>${statusBadge(t.status)}</td><td>${fmtDateShort(t.created_at)}</td>
</tr>`).join('');
    document.querySelector('#admin-main tbody').innerHTML = rows || '<tr><td colspan="5" class="muted" style="text-align:center;padding:2rem">No tickets</td></tr>';
  } catch (e) { showToast(e.message, 'error'); }
};

window.openTicketDetail = async function (id) {
  try {
    const t = await api(`/tickets/${id}`);
    const thread = `
<div class="thread-msg customer"><div class="msg-sender" style="font-size:.73rem;color:var(--muted);margin-bottom:.2rem">Customer · ${fmtDateShort(t.created_at)}</div>${esc(t.body)}</div>
${(t.replies||[]).map(r=>`<div class="thread-msg ${r.sender}"><div class="msg-sender" style="font-size:.73rem;color:var(--muted);margin-bottom:.2rem">${r.sender==='admin'?'Admin':'Customer'} · ${fmtDateShort(r.created_at)}</div>${esc(r.body)}</div>`).join('')}`;

    const ov = openModal(`
<div class="modal-header"><h3>#${t.id} — ${esc(t.subject)}</h3><button class="btn-icon" data-close>✕</button></div>
<div class="modal-body" style="max-height:65vh;overflow-y:auto">
  <div style="display:flex;flex-direction:column;gap:.75rem;margin-bottom:1rem">${thread}</div>
  <div class="form-group"><textarea class="form-input" id="admin-reply" rows="3" placeholder="Write reply..."></textarea></div>
  <div style="display:flex;gap:.5rem;align-items:center;margin-top:.5rem">
    <select class="form-input" id="ticket-status-sel" style="width:140px">
      <option value="open" ${t.status==='open'?'selected':''}>Open</option>
      <option value="closed" ${t.status==='closed'?'selected':''}>Closed</option>
    </select>
  </div>
</div>
<div class="modal-footer">
  <button class="btn btn-secondary" data-close>Cancel</button>
  <button class="btn btn-primary" id="send-reply-btn">Send Reply</button>
</div>`);
    document.getElementById('send-reply-btn').addEventListener('click', async () => {
      const body = document.getElementById('admin-reply').value.trim();
      const status = document.getElementById('ticket-status-sel').value;
      if (!body) return showToast('Reply cannot be empty', 'error');
      try {
        await api(`/tickets/${id}/reply`, { method: 'POST', body: JSON.stringify({ body, status }) });
        ov.remove(); showToast('Reply sent'); views.tickets();
      } catch (ex) { showToast(ex.message, 'error'); }
    });
  } catch (e) { showToast(e.message, 'error'); }
};

// ── views.blog ────────────────────────────────────────────────────────────────
views.blog = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const posts = await api('/blog');
    const rows = posts.map(p => `
<tr>
  <td style="font-weight:600">${esc(p.title)}</td>
  <td><code style="font-size:.78rem">${esc(p.slug)}</code></td>
  <td>${p.published ? '<span class="badge badge-green">Published</span>' : '<span class="badge badge-grey">Draft</span>'}</td>
  <td>${fmtDateShort(p.created_at)}</td>
  <td>
    <button class="btn btn-secondary btn-sm" onclick="openBlogModal(${p.id})">Edit</button>
    <button class="btn btn-red btn-sm" onclick="deleteBlog(${p.id})">Del</button>
  </td>
</tr>`).join('');
    setMain(`
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;gap:.5rem;flex-wrap:wrap">
  <h2 style="font-weight:800">Blog CMS</h2>
  <div style="display:flex;gap:.5rem;flex-wrap:wrap">
    <button class="btn btn-secondary" onclick="importWpBlog()" title="Re-import posts with images from a WordPress site">⬇ Import from WordPress</button>
    <button class="btn btn-primary" onclick="openBlogModal()">+ New Post</button>
  </div>
</div>
<div class="table-wrap"><table>
  <thead><tr><th>Title</th><th>Slug</th><th>Status</th><th>Date</th><th>Actions</th></tr></thead>
  <tbody>${rows||'<tr><td colspan="5" class="muted" style="text-align:center;padding:2rem">No posts yet</td></tr>'}</tbody>
</table></div>`);
  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

window.openBlogModal = async function (id = null) {
  let p = {};
  if (id) { try { const posts = await api('/blog'); p = posts.find(x => x.id === id) || {}; } catch {} }

  const ov = openModal(`
<div class="modal-header"><h3>${id ? 'Edit' : 'New'} Post</h3><button class="btn-icon" data-close>✕</button></div>
<div class="modal-body" style="max-height:80vh;overflow-y:auto">
  <div id="blog-err"></div>
  <div class="form-group"><label class="form-label">Title *</label><input class="form-input" id="bl-title" value="${esc(p.title||'')}" oninput="autoSlug()"></div>
  <div class="form-group"><label class="form-label">Slug</label><input class="form-input" id="bl-slug" value="${esc(p.slug||'')}" placeholder="auto-generated"></div>
  <div class="form-group">
    <label class="form-label">Body</label>
    <div style="display:flex;flex-wrap:wrap;gap:.3rem;margin-bottom:.4rem">
      <button type="button" class="btn btn-sm btn-secondary" onmousedown="event.preventDefault()" onclick="blExec('bold')" title="Bold"><b>B</b></button>
      <button type="button" class="btn btn-sm btn-secondary" onmousedown="event.preventDefault()" onclick="blExec('italic')" title="Italic"><i>I</i></button>
      <button type="button" class="btn btn-sm btn-secondary" onmousedown="event.preventDefault()" onclick="blBlock('h2')" title="Heading">H2</button>
      <button type="button" class="btn btn-sm btn-secondary" onmousedown="event.preventDefault()" onclick="blBlock('h3')" title="Subheading">H3</button>
      <button type="button" class="btn btn-sm btn-secondary" onmousedown="event.preventDefault()" onclick="blBlock('p')" title="Normal text">¶</button>
      <button type="button" class="btn btn-sm btn-secondary" onmousedown="event.preventDefault()" onclick="blExec('insertUnorderedList')" title="Bullet list">• List</button>
      <button type="button" class="btn btn-sm btn-secondary" onmousedown="event.preventDefault()" onclick="blLink()" title="Insert link">🔗</button>
      <button type="button" class="btn btn-sm btn-secondary" onmousedown="event.preventDefault()" onclick="blImage()" title="Insert image">🖼 Image</button>
      <button type="button" class="btn btn-sm btn-secondary" onmousedown="event.preventDefault()" onclick="blButton()" title="Insert button">🔘 Button</button>
      <button type="button" class="btn btn-sm btn-secondary" onmousedown="event.preventDefault()" onclick="blExec('removeFormat')" title="Clear formatting">✖</button>
      <button type="button" class="btn btn-sm btn-secondary" id="bl-html-btn" onclick="blToggleHtml()" title="Edit raw HTML">&lt;/&gt;</button>
    </div>
    <div id="bl-body-rich" contenteditable="true" class="form-input" style="min-height:260px;max-height:50vh;overflow-y:auto;line-height:1.7;padding:.75rem"></div>
    <textarea id="bl-body" class="form-input" rows="14" style="display:none;font-family:monospace"></textarea>
    <input type="file" id="bl-img-file" accept="image/*" style="display:none">
    <p class="muted" style="font-size:.78rem;margin-top:.35rem">Type or paste content directly · use the toolbar for headings, images &amp; buttons.</p>
  </div>
  <div class="form-group"><label class="form-label">Meta Description</label><textarea class="form-input" id="bl-meta" rows="2">${esc(p.meta_desc||'')}</textarea></div>
  <div class="form-group"><label class="form-label">OG Image URL</label><input class="form-input" id="bl-og" value="${esc(p.og_image||'')}"></div>
  <div style="display:flex;align-items:center;gap:.75rem;margin-top:.25rem">
    <label class="toggle-switch"><input type="checkbox" id="bl-pub" ${p.published?'checked':''}><span class="toggle-slider"></span></label>
    <label class="form-label">Published</label>
  </div>
</div>
<div class="modal-footer">
  <button class="btn btn-secondary" data-close>Cancel</button>
  <button class="btn btn-primary" id="save-blog-btn">${id ? 'Update' : 'Create'}</button>
</div>`);

  window.autoSlug = function () {
    const t = document.getElementById('bl-title')?.value || '';
    document.getElementById('bl-slug').value = t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  };

  // ── Visual body editor ──────────────────────────────────────────────────────
  const _rich = document.getElementById('bl-body-rich');
  const _ta = document.getElementById('bl-body');
  _rich.innerHTML = p.body || '';
  _ta.value = p.body || '';
  const blGetBody = () => (_ta.style.display === 'none') ? _rich.innerHTML : _ta.value;

  window.blExec  = (cmd) => { _rich.focus(); document.execCommand(cmd, false, null); };
  window.blBlock = (tag) => { _rich.focus(); document.execCommand('formatBlock', false, tag); };
  window.blLink  = () => { const u = prompt('Link URL:', 'https://'); if (u) { _rich.focus(); document.execCommand('createLink', false, u); } };
  window.blButton = () => {
    const label = prompt('Button text:', 'Buy Now'); if (!label) return;
    const url = prompt('Button link (URL):', 'https://'); if (!url) return;
    _rich.focus();
    document.execCommand('insertHTML', false, `<a class="blog-btn" href="${esc(url)}" style="display:inline-block;background:#7c3aed;color:#fff;padding:.6rem 1.3rem;border-radius:9px;text-decoration:none;font-weight:600;margin:.4rem .4rem .4rem 0">${esc(label)}</a>&nbsp;`);
  };
  window.blImage = () => document.getElementById('bl-img-file').click();
  document.getElementById('bl-img-file').onchange = function () {
    const file = this.files[0]; this.value = ''; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const MAX = 1600; let w = img.width, h = img.height;
        if (Math.max(w, h) > MAX) { const sc = MAX / Math.max(w, h); w = Math.round(w * sc); h = Math.round(h * sc); }
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        cv.toBlob(async (blob) => {
          const fd = new FormData(); fd.append('image', blob, 'blog.jpg');
          try {
            const r = await fetch('/admin/api/blog/upload-image', { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': getCsrfToken() }, body: fd });
            const j = await r.json();
            if (j.url) { _rich.focus(); document.execCommand('insertHTML', false, `<img src="${j.url}" alt="" style="max-width:100%;border-radius:12px;margin:1rem 0">`); }
            else showToast(j.error || 'Upload failed', 'error');
          } catch (ex) { showToast(ex.message, 'error'); }
        }, 'image/jpeg', 0.85);
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  };
  window.blToggleHtml = () => {
    const btn = document.getElementById('bl-html-btn');
    if (_ta.style.display === 'none') { _ta.value = _rich.innerHTML; _ta.style.display = ''; _rich.style.display = 'none'; btn.classList.add('btn-primary'); }
    else { _rich.innerHTML = _ta.value; _ta.style.display = 'none'; _rich.style.display = ''; btn.classList.remove('btn-primary'); }
  };

  document.getElementById('save-blog-btn').addEventListener('click', async () => {
    const body = {
      title: document.getElementById('bl-title').value.trim(),
      slug: document.getElementById('bl-slug').value.trim(),
      body: blGetBody(),
      meta_desc: document.getElementById('bl-meta').value,
      og_image: document.getElementById('bl-og').value,
      published: document.getElementById('bl-pub').checked ? 1 : 0,
    };
    if (!body.title) return showToast('Title required', 'error');
    try {
      if (id) await api(`/blog/${id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/blog', { method: 'POST', body: JSON.stringify(body) });
      ov.remove(); showToast('Post saved'); views.blog();
    } catch (ex) { document.getElementById('blog-err').innerHTML = `<div class="alert alert-error">${esc(ex.message)}</div>`; }
  });
};

window.deleteBlog = async function (id) {
  if (!confirm('Delete this post?')) return;
  try { await api(`/blog/${id}`, { method: 'DELETE' }); showToast('Post deleted'); views.blog(); }
  catch (e) { showToast(e.message, 'error'); }
};

window.importWpBlog = async function () {
  const url = prompt('Your WordPress SITE domain (NOT a post URL) — e.g. https://yoursite.com:', 'https://greenyellow-zebra-929829.hostingersite.com');
  if (!url) return;
  showToast('Importing from WordPress…');
  try {
    const r = await api('/blog/import-wordpress', { method: 'POST', body: JSON.stringify({ url }) });
    showToast(`✓ Cloned ${r.total} posts (${r.updated} updated, ${r.imported} new) · ${r.images} images self-hosted`);
    views.blog();
  } catch (e) { showToast(e.message, 'error'); }
};

// ── views.seo ─────────────────────────────────────────────────────────────────
views.seo = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const s = await api('/seo-settings');
    const pages = ['home','plans','blog','about','contact','privacy','terms','refund'];
    const pageFields = pages.map(pg => `
<div style="background:var(--input-bg);border-radius:var(--radius-sm);padding:1rem;margin-bottom:.75rem">
<div style="font-weight:700;margin-bottom:.75rem;text-transform:capitalize">${pg}</div>
<div class="form-group"><label class="form-label">Meta Title</label><input class="form-input" name="seo_${pg}_title" value="${esc(s['seo_'+pg+'_title']||'')}"></div>
<div class="form-group"><label class="form-label">Meta Description</label><textarea class="form-input" name="seo_${pg}_desc" rows="2">${esc(s['seo_'+pg+'_desc']||'')}</textarea></div>
<div class="form-group"><label class="form-label">Keywords</label><input class="form-input" name="seo_${pg}_keywords" value="${esc(s['seo_'+pg+'_keywords']||'')}"></div>
</div>`).join('');

    setMain(`
<h2 style="font-weight:800;margin-bottom:1.5rem">SEO Settings</h2>
<div style="max-width:720px">
<form id="seo-form" style="display:flex;flex-direction:column;gap:.9rem">
<div id="seo-msg"></div>
<details class="card" style="padding:1rem 1.1rem">
  <summary style="cursor:pointer;font-weight:700">📖 Setup guide — Google Analytics (GA4), Search Console &amp; Bing</summary>
  <div style="margin-top:.85rem">
    <div style="font-weight:700;font-size:.9rem;margin-bottom:.3rem">📊 Google Analytics (GA4) — see your visitors</div>
    <ol class="muted" style="font-size:.83rem;line-height:1.85;padding-left:1.25rem;margin:0 0 1rem">
      <li>Open <a href="https://analytics.google.com/" target="_blank" rel="noopener">analytics.google.com</a> → <strong>Admin</strong> (gear, bottom-left) → <strong>Create → Property</strong>. Set name, currency &amp; timezone.</li>
      <li>In the property → <strong>Data Streams</strong> → <strong>Add stream → Web</strong> → enter your site URL.</li>
      <li>Copy the <strong>Measurement ID</strong> (<code>G-XXXXXXXXXX</code>) shown at the top of the stream.</li>
      <li>Paste it into <strong>GA4 Measurement ID</strong> below → <strong>Save</strong> → <strong>Test Connection</strong>. The tag is added to every storefront page automatically (no redeploy needed).</li>
    </ol>
    <div style="font-weight:700;font-size:.9rem;margin-bottom:.3rem">🔍 Google Search Console — get found on Google</div>
    <ol class="muted" style="font-size:.83rem;line-height:1.85;padding-left:1.25rem;margin:0 0 1rem">
      <li>Open <a href="https://search.google.com/search-console" target="_blank" rel="noopener">Search Console</a> → <strong>Add property</strong> → <strong>URL prefix</strong> → your site URL.</li>
      <li>Pick the <strong>HTML tag</strong> method and copy the code (or paste the whole <code>&lt;meta&gt;</code> tag — both work).</li>
      <li>Paste into <strong>GSC Verification Code</strong> below → Save → back in Search Console click <strong>Verify</strong>.</li>
      <li>Finally, submit your sitemap in Search Console: <code>${esc(location.origin)}/sitemap.xml</code> (generated for you automatically).</li>
    </ol>
    <div style="font-weight:700;font-size:.9rem;margin-bottom:.3rem">🅱️ Bing Webmaster Tools</div>
    <ol class="muted" style="font-size:.83rem;line-height:1.85;padding-left:1.25rem;margin:0">
      <li>Open <a href="https://www.bing.com/webmasters" target="_blank" rel="noopener">Bing Webmaster Tools</a> → add your site (you can <strong>import from Search Console</strong> in one click).</li>
      <li>For the meta-tag method, copy the <code>content</code> value into <strong>Bing Verification</strong> below → Save.</li>
    </ol>
  </div>
</details>
<div class="card" style="padding:1.1rem">
  <div style="font-weight:700;margin-bottom:.75rem">Global</div>
  <div class="form-row">
    <div class="form-group"><label class="form-label">Default OG Image URL</label><input class="form-input" name="seo_og_image" value="${esc(s.seo_og_image||'')}"></div>
    <div class="form-group"><label class="form-label">Twitter Card Type</label>
      <select class="form-input" name="seo_twitter_card">
        <option ${s.seo_twitter_card==='summary'?'selected':''}>summary</option>
        <option ${s.seo_twitter_card!=='summary'?'selected':''}>summary_large_image</option>
      </select>
    </div>
  </div>
  <div class="form-row">
    <div class="form-group"><label class="form-label">GSC Verification Code</label><input class="form-input" name="seo_gsc_verification" value="${esc(s.seo_gsc_verification||'')}" placeholder="Paste the code or full meta tag from Search Console"></div>
    <div class="form-group"><label class="form-label">Bing Verification</label><input class="form-input" name="seo_bing_verification" value="${esc(s.seo_bing_verification||'')}"></div>
  </div>
</div>
<div class="card" style="padding:1.1rem">
  <div style="font-weight:700;margin-bottom:.4rem">Google Analytics (GA4)</div>
  <p class="muted" style="font-size:.8rem;margin-bottom:.75rem">Paste your Measurement ID (looks like <code>G-XXXXXXXXXX</code>) from Google Analytics → Admin → Data Streams. Save, then Test.</p>
  <div class="form-group"><label class="form-label">GA4 Measurement ID</label><input class="form-input" name="seo_ga_measurement_id" id="ga-id" value="${esc(s.seo_ga_measurement_id||'')}" placeholder="G-XXXXXXXXXX"></div>
  <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
    <button type="button" class="btn btn-sm btn-secondary" id="ga-test">🔌 Test Connection</button>
    <a class="btn btn-sm btn-secondary" href="https://analytics.google.com/" target="_blank" rel="noopener">📊 Open Google Analytics ↗</a>
    <span id="ga-test-res" style="font-size:.83rem"></span>
  </div>
</div>
<div class="card" style="padding:1.1rem">
  <div style="font-weight:700;margin-bottom:.75rem">robots.txt</div>
  <div class="form-group"><textarea class="form-input" name="robots_txt" rows="5" style="font-family:monospace">${esc(s.robots_txt||'User-agent: *\nAllow: /')}</textarea></div>
</div>
<div class="card" style="padding:1.1rem">
  <div style="font-weight:700;margin-bottom:.75rem">Per-Page Meta</div>
  ${pageFields}
</div>
<div class="card" style="padding:1.1rem">
  <div style="font-weight:700;margin-bottom:.4rem">Blog Page — SEO Sections</div>
  <p class="muted" style="font-size:.8rem;margin-bottom:.75rem">Optional HTML shown at the top and bottom of the <code>/blog</code> page — great for SEO keywords + internal links. Headings, links and images are supported.</p>
  <div class="form-group"><label class="form-label">Top Section (above the posts)</label><textarea class="form-input" name="seo_blog_top" rows="4" placeholder="&lt;h2&gt;Guides &amp; Tutorials&lt;/h2&gt;&lt;p&gt;Helpful articles about ...&lt;/p&gt;">${esc(s.seo_blog_top||'')}</textarea></div>
  <div class="form-group"><label class="form-label">Bottom Section (below the posts)</label><textarea class="form-input" name="seo_blog_bottom" rows="4" placeholder="&lt;h2&gt;Why choose us&lt;/h2&gt;&lt;p&gt;...&lt;/p&gt;">${esc(s.seo_blog_bottom||'')}</textarea></div>
</div>
<button type="submit" class="btn btn-primary" style="width:200px">Save SEO Settings</button>
</form></div>`);

    document.getElementById('seo-form').onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(e.target); const body = {};
      fd.forEach((v, k) => body[k] = v);
      try {
        await api('/seo-settings', { method: 'POST', body: JSON.stringify(body) });
        document.getElementById('seo-msg').innerHTML = '<div class="alert alert-success">Saved!</div>';
        setTimeout(() => document.getElementById('seo-msg').innerHTML = '', 2500);
      } catch (ex) { document.getElementById('seo-msg').innerHTML = `<div class="alert alert-error">${esc(ex.message)}</div>`; }
    };

    const gaTestBtn = document.getElementById('ga-test');
    if (gaTestBtn) gaTestBtn.onclick = async () => {
      const id = (document.getElementById('ga-id').value || '').trim();
      const out = document.getElementById('ga-test-res');
      if (!/^G-[A-Z0-9]{6,}$/i.test(id)) { out.innerHTML = '<span style="color:#ef4444">✗ Invalid ID — must look like G-XXXXXXXXXX</span>'; return; }
      out.textContent = 'Checking…';
      try {
        const html = await fetch('/?_ga_test=' + Date.now(), { cache: 'no-store' }).then(r => r.text());
        out.innerHTML = html.includes('gtag/js?id=' + id)
          ? '<span style="color:#22c55e">✓ Live — GA tag ' + esc(id) + ' is firing on your homepage</span>'
          : '<span style="color:#f59e0b">⚠ Not detected — click "Save SEO Settings" first, then Test again</span>';
      } catch (e) { out.innerHTML = '<span style="color:#ef4444">✗ ' + esc(e.message) + '</span>'; }
    };
  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

// ── views.googleindex ─────────────────────────────────────────────────────────
views.googleindex = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const cfg = await api('/google-index/config');
    const siteName = (await api('/settings')).site_name || 'OTT Store';
    const baseUrl = (await api('/settings')).base_url || window.location.origin;

    const urlList = ['/', '/plans', '/blog', '/about', '/contact', '/privacy', '/terms', '/refund'].map(u =>
      `<label style="display:flex;align-items:center;gap:.5rem;font-size:.875rem">
        <input type="checkbox" class="gi-url-chk" value="${baseUrl}${u}"> ${baseUrl}${u}
      </label>`).join('');

    setMain(`
<h2 style="font-weight:800;margin-bottom:1.5rem">Google Indexing API</h2>
<div style="max-width:680px;display:flex;flex-direction:column;gap:1.25rem">

<div class="card">
  <div style="font-weight:700;margin-bottom:.75rem">Service Account</div>
  ${cfg.configured
    ? `<div class="alert alert-success">✓ Connected: ${esc(cfg.client_email)}</div>`
    : '<div class="alert alert-warn">⚠️ Not configured. Paste your Google Service Account JSON below.</div>'}
  <div id="gi-cred-msg"></div>
  <div class="form-group" style="margin-top:.75rem"><label class="form-label">Service Account JSON</label>
    <textarea class="form-input" id="gi-creds" rows="5" style="font-family:monospace;font-size:.78rem" placeholder='{"type":"service_account","client_email":"...","private_key":"..."}'></textarea>
  </div>
  <button class="btn btn-primary btn-sm" onclick="saveGiCreds()">Save Credentials</button>
</div>

<div class="card">
  <div style="font-weight:700;margin-bottom:.75rem">Submit URLs to Google (up to 200/day)</div>
  <div style="display:flex;flex-direction:column;gap:.4rem;margin-bottom:.75rem">${urlList}</div>
  <div class="form-group"><label class="form-label">Custom URLs (one per line)</label>
    <textarea class="form-input" id="gi-custom" rows="3" placeholder="${baseUrl}/blog/my-post"></textarea>
  </div>
  <div id="gi-submit-msg"></div>
  <div style="display:flex;gap:.75rem;margin-top:.5rem">
    <button class="btn btn-primary" onclick="submitGiUrls()" ${!cfg.configured?'disabled':''}>Submit to Google</button>
    <button class="btn btn-secondary" onclick="pingSitemap()">📡 Ping Sitemap</button>
  </div>
</div>

<div class="card">
  <div style="font-weight:700;margin-bottom:.75rem">Submission History</div>
  <div id="gi-history"><div class="spinner"></div></div>
</div>
</div>`);

    loadGiHistory();
  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

async function loadGiHistory() {
  try {
    const hist = await api('/google-index/history');
    const el = document.getElementById('gi-history');
    if (!el) return;
    if (!hist.length) { el.innerHTML = '<p class="muted">No submissions yet.</p>'; return; }
    el.innerHTML = `<div class="table-wrap"><table>
<thead><tr><th>URL</th><th>Result</th><th>Date</th></tr></thead>
<tbody>${hist.map(h=>{
  let after={}; try{after=JSON.parse(h.after_json||'{}')}catch{}
  return `<tr><td style="font-size:.8rem;max-width:260px;overflow:hidden;text-overflow:ellipsis">${esc(h.target_id)}</td>
  <td>${after.status===200?'<span class="badge badge-green">OK</span>':`<span class="badge badge-red">${after.status||'err'}</span>`}</td>
  <td>${fmtDateShort(h.created_at)}</td></tr>`;
}).join('')}</tbody></table></div>`;
  } catch {}
}

window.saveGiCreds = async function () {
  const creds = document.getElementById('gi-creds').value.trim();
  const msg = document.getElementById('gi-cred-msg');
  if (!creds) return;
  try {
    const r = await api('/google-index/credentials', { method: 'POST', body: JSON.stringify({ credentials: creds }) });
    msg.innerHTML = `<div class="alert alert-success">Connected: ${esc(r.client_email)}</div>`;
  } catch (e) { msg.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`; }
};

window.submitGiUrls = async function () {
  const checked = [...document.querySelectorAll('.gi-url-chk:checked')].map(c => c.value);
  const custom = (document.getElementById('gi-custom')?.value || '').split('\n').map(u => u.trim()).filter(Boolean);
  const urls = [...new Set([...checked, ...custom])];
  const msg = document.getElementById('gi-submit-msg');
  if (!urls.length) { msg.innerHTML = '<div class="alert alert-warn">Select at least one URL.</div>'; return; }
  msg.innerHTML = '<div class="alert alert-info">Submitting...</div>';
  try {
    const r = await api('/google-index/submit', { method: 'POST', body: JSON.stringify({ urls }) });
    const ok = r.results.filter(x => x.ok).length;
    const fail = r.results.length - ok;
    msg.innerHTML = `<div class="alert alert-success">✓ ${ok} submitted successfully. ${fail ? `${fail} failed.` : ''}</div>`;
    loadGiHistory();
  } catch (e) { msg.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`; }
};

window.pingSitemap = async function () {
  const msg = document.getElementById('gi-submit-msg');
  msg.innerHTML = '<div class="alert alert-info">Pinging Google...</div>';
  try {
    const r = await api('/google-index/ping-sitemap', { method: 'POST', body: '{}' });
    msg.innerHTML = `<div class="alert alert-success">Sitemap pinged! Status: ${r.status}</div>`;
  } catch (e) { msg.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`; }
};

// ── views.hometext ────────────────────────────────────────────────────────────
// Full content editor for the landing page (public/store/index.html):
//   • Text fields  → data-tk keys; the storefront swaps the element when the
//                    matching home_<key> setting is set, else keeps the default.
//   • Reviews / ticker / badges → JSON lists (home_reviews / home_ticker /
//                    home_badges) server-rendered into the page.
//   • Sections     → home_sections JSON drives show/hide + order of the four
//                    optional sections (ticker, categories, trust, cta).
// Mirrors the defaults in src/index.js so the editor shows what's actually live.
views.hometext = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const s = await api('/settings');

    // ── MovieVerse theme: its own text editor (the cinematic home is a separate
    // file with a different layout, so it gets a dedicated set of fields). ──
    if ((s.store_theme || '') === 'movieverse') {
      const MV_SECTIONS = [
        { title: 'Hero', slots: [
          ['mv_eyebrow', 'Eyebrow badge', 'MovieVerse · Premium OTT Store'],
          ['mv_btn_explore', 'Button 1 — Explore', 'Explore Subscriptions →'],
          ['mv_btn_account', 'Button 2 — Account', 'My Account'],
          ['mv_btn_wa', 'Button 3 — WhatsApp', 'WhatsApp Order'],
          ['mv_nav_shop', 'Header "Shop Now" button', 'Shop Now'],
          ['mv_stat1_label', 'Stat 1 — label', 'Products'],
          ['mv_stat2_label', 'Stat 2 — label', 'Categories'],
          ['mv_stat3_num', 'Stat 3 — number', '1–24 hr'], ['mv_stat3_label', 'Stat 3 — label', 'Activation'],
          ['mv_stat4_num', 'Stat 4 — number', 'UPI'], ['mv_stat4_label', 'Stat 4 — label', 'Cards / Crypto'],
        ] },
        { title: 'Hero — poster card', slots: [
          ['mv_poster_title', 'Card title', 'Premium Plans Activated On Your Account'],
          ['mv_poster_sub', 'Card subtitle', 'Instant Delivery · WhatsApp Confirmation'],
          ['mv_poster_c1', 'Tile 1', 'Movies'], ['mv_poster_c2', 'Tile 2', 'Sports'], ['mv_poster_c3', 'Tile 3', 'Music'],
        ] },
        { title: 'Categories section', slots: [
          ['mv_cat_kicker', 'Kicker', 'Featured Storefront'],
          ['mv_cat_heading', 'Heading', 'OTT plans displayed like movie posters.'],
          ['mv_cat_sub', 'Subheading', 'Stream, watch, share — premium subscription tiles with price, validity, activation time and one-tap buying.'],
          ['mv_cat_viewall', '"View all" button', 'View All Products'],
          ['mv_cat1_title', 'Card 1 — title', 'Streaming & Entertainment'], ['mv_cat1_desc', 'Card 1 — text', 'Prime Video, Apple TV+, Sony LIV, ZEE5, Hotstar and more subscription products.'],
          ['mv_cat2_title', 'Card 2 — title', 'Sports & Live Match Plans'], ['mv_cat2_desc', 'Card 2 — text', 'Cricket, football and live sports packs with quick confirmation and support.'],
          ['mv_cat3_title', 'Card 3 — title', 'Music & Audio'], ['mv_cat3_desc', 'Card 3 — text', 'YouTube Premium, Apple Music and audio entertainment subscriptions.'],
          ['mv_cat4_title', 'Card 4 — title', 'AI & Premium Tools'], ['mv_cat4_desc', 'Card 4 — text', 'AI writing, design, cloud, productivity and business subscriptions.'],
        ] },
        { title: 'Featured plans section', slots: [
          ['mv_feat_kicker', 'Kicker', 'Dynamic Product Skin'],
          ['mv_feat_heading', 'Heading', 'Real plans, MovieVerse styling.'],
          ['mv_feat_sub', 'Subheading', 'These are live products from your catalog — same plans, same prices, same checkout, just dressed for the big screen.'],
          ['mv_feat_btn', 'Button', 'Open Shop'],
        ] },
        { title: 'How it works', slots: [
          ['mv_how_kicker', 'Kicker', 'How It Works'],
          ['mv_how_heading', 'Heading', 'Simple checkout for premium subscriptions.'],
          ['mv_step1_title', 'Step 1 — title', 'Choose Plan'], ['mv_step1_desc', 'Step 1 — text', 'Select OTT, music, AI or premium subscription from the store.'],
          ['mv_step2_title', 'Step 2 — title', 'Pay Securely'], ['mv_step2_desc', 'Step 2 — text', 'UPI auto-verify or USDT (Binance / BEP20 / TRC20) — auto-confirmed by email.'],
          ['mv_step3_title', 'Step 3 — title', 'Share Details'], ['mv_step3_desc', 'Step 3 — text', 'Submit mobile number/email if required for activation.'],
          ['mv_step4_title', 'Step 4 — title', 'Get Delivery'], ['mv_step4_desc', 'Step 4 — text', 'Receive confirmation via WhatsApp/email after activation.'],
        ] },
        { title: 'Call-to-action', slots: [
          ['mv_cta_title', 'Heading', 'Ready to upgrade your digital access?'],
          ['mv_cta_sub', 'Subheading', 'Join thousands of customers. Register free and get your first product today.'],
          ['mv_cta_btn', 'Button 1 — Shop', 'Shop Now'],
          ['mv_cta_wa', 'Button 2 — WhatsApp', 'Order on WhatsApp'],
        ] },
        { title: 'FAQ', slots: [
          ['mv_faq_heading', 'Heading', 'Frequently asked questions'],
          ['mv_faq_sub', 'Subheading', 'Quick answers about buying OTT subscriptions and software keys at OTT24x7.'],
        ] },
      ];
      const mvCard = sec => `<div class="card" style="padding:1.1rem;margin-bottom:1rem"><div style="font-weight:700;margin-bottom:.75rem">${esc(sec.title)}</div>${sec.slots.map(([k, label, def]) => `<div class="form-group"><label class="form-label">${esc(label)}</label><input class="form-input" name="home_${k}" value="${esc(s['home_' + k] || '')}" placeholder="${esc(def)}"></div>`).join('')}</div>`;
      setMain(`
<div style="display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-bottom:.4rem">
  <h2 style="font-weight:800;margin:0">Homepage Content <span class="muted" style="font-size:.8rem;font-weight:600">· 🎬 MovieVerse theme</span></h2>
  <a class="btn btn-sm" href="/" target="_blank" rel="noopener">Open storefront ↗</a>
</div>
<p class="muted" style="font-size:.85rem;margin-bottom:1rem;max-width:760px">Your active theme is <strong>MovieVerse</strong> — edit its text below. Leave a field blank to keep the grey-placeholder default. The big hero <strong>heading &amp; subtext</strong> are under <strong>My Store → Homepage Hero Text</strong>. Changes apply on the storefront's next load.</p>
<form id="hometext-form" style="max-width:760px">
  <div id="hometext-msg"></div>
  ${MV_SECTIONS.map(mvCard).join('')}
  <button type="submit" class="btn btn-primary" style="width:240px">Save Homepage Content</button>
</form>`);
      document.getElementById('hometext-form').onsubmit = async e => {
        e.preventDefault();
        const body = {};
        document.querySelectorAll('#hometext-form [name^="home_"]').forEach(el => { body[el.name] = el.value; });
        try {
          await api('/settings', { method: 'POST', body: JSON.stringify(body) });
          document.getElementById('hometext-msg').innerHTML = '<div class="alert alert-success">Saved! Reload the storefront to see the changes.</div>';
          window.scrollTo({ top: 0, behavior: 'smooth' });
          setTimeout(() => { const m = document.getElementById('hometext-msg'); if (m) m.innerHTML = ''; }, 3500);
        } catch (ex) { document.getElementById('hometext-msg').innerHTML = `<div class="alert alert-error">${esc(ex.message)}</div>`; }
      };
      return;
    }

    // Defaults — keep in sync with HOME_DEFAULT_* in src/index.js.
    const DEF_REVIEWS = [
      { stars: 5, quote: 'Ordered Office 2021 at midnight and got the genuine key in two minutes. Activated first try — exactly as described.', name: '— Rahul M., Pune' },
      { stars: 5, quote: 'Netflix and Spotify both delivered instantly over WhatsApp. When one needed a reset they replaced it within the hour.', name: '— Sneha R., Bengaluru' },
      { stars: 5, quote: 'Paid with USDT, zero hassle. Fair prices and support actually replies 24×7. My go-to for software keys now.', name: '— Arjun K., Delhi' },
    ];
    const DEF_TICKER = ['⚡ Instant Delivery', '✅ Verified Products', '💬 WhatsApp Support', '🔐 Secure Checkout', '🎬 OTT Plans', '🤖 AI Tools', '☁️ Cloud Storage', '🖥️ Software Keys', '🎵 Music Streaming', '🛡️ VPN & Security'];
    const DEF_BADGES = ['🔐 Secure checkout', '⚡ Instant digital delivery', '🛡️ Replacement warranty', '💳 UPI & Crypto (USDT)', '💬 24×7 WhatsApp support'];
    const SECTION_META = [['ticker', 'Ticker (scrolling badges)'], ['categories', 'Categories grid'], ['trust', 'Trust / reviews band'], ['cta', 'Final CTA banner']];
    const SECTION_IDS = SECTION_META.map(m => m[0]);

    // A set value (even []) is respected; only a truly unset key falls to defaults.
    const parseArr = (raw, def) => { if (raw == null) return def; try { const v = JSON.parse(raw); return Array.isArray(v) ? v : def; } catch { return def; } };
    const reviews = parseArr(s.home_reviews, DEF_REVIEWS);
    const ticker  = parseArr(s.home_ticker, DEF_TICKER);
    const badges  = parseArr(s.home_badges, DEF_BADGES);

    // Section order + visibility (saved order first, any missing ids appended on).
    let secCfg = []; try { const v = JSON.parse(s.home_sections); if (Array.isArray(v)) secCfg = v; } catch {}
    const order = []; const onMap = {};
    secCfg.forEach(x => { if (x && SECTION_IDS.includes(x.id) && !order.includes(x.id)) { order.push(x.id); onMap[x.id] = !(x.on === false || x.on === 0 || x.on === '0'); } });
    SECTION_IDS.forEach(id => { if (!order.includes(id)) { order.push(id); onMap[id] = true; } });
    const labelOf = id => (SECTION_META.find(m => m[0] === id) || [id, id])[1];

    const TEXT_SECTIONS = [
      { title: 'Hero', slots: [
        ['hero_eyebrow', 'Eyebrow badge', 'Live store · Instant digital delivery'],
        ['btn_browse', 'Primary button', '🎬 Browse Products →'],
        ['btn_whatsapp', 'WhatsApp button', '💬 Chat on WhatsApp'],
        ['stat1_num', 'Stat 1 — number', '120+'], ['stat1_label', 'Stat 1 — label', 'Products'],
        ['stat2_num', 'Stat 2 — number', '17'], ['stat2_label', 'Stat 2 — label', 'Categories'],
        ['stat3_num', 'Stat 3 — number', '24×7'], ['stat3_label', 'Stat 3 — label', 'Support'],
        ['stat4_num', 'Stat 4 — number', 'UPI'], ['stat4_label', 'Stat 4 — label', 'Cards / Crypto'],
      ] },
      { title: 'Hero — phone preview card', slots: [
        ['phone_badge', 'Card badge', '⚡ Hot Picks'],
        ['phone_sub', 'Card subtitle', 'Premium digital access in minutes. Choose product, pay, receive delivery.'],
        ['phone_c1_title', 'Row 1 — title', 'Streaming Plans'], ['phone_c1_sub', 'Row 1 — text', 'OTT subscriptions'],
        ['phone_c2_title', 'Row 2 — title', 'AI & Writing Tools'], ['phone_c2_sub', 'Row 2 — text', 'Premium accounts'],
        ['phone_c3_title', 'Row 3 — title', 'Cloud & Software'], ['phone_c3_sub', 'Row 3 — text', 'Productivity suite'],
      ] },
      { title: 'Categories section', slots: [
        ['cat_heading', 'Heading', 'Explore premium categories'],
        ['cat_sub', 'Subheading', 'Cinematic delivery for every digital need — OTT, AI, Cloud, Software & more.'],
        ['cat_viewall', '"View all" link', 'View all →'],
        ['cat1_title', 'Card 1 — title', 'Streaming & OTT'], ['cat1_desc', 'Card 1 — text', 'Netflix, Prime, Hotstar, Zee5, SonyLiv, Apple TV and more.'],
        ['cat2_title', 'Card 2 — title', 'AI & Writing Tools'], ['cat2_desc', 'Card 2 — text', 'ChatGPT Plus, Midjourney, Grammarly, Jasper and more.'],
        ['cat3_title', 'Card 3 — title', 'Cloud & Productivity'], ['cat3_desc', 'Card 3 — text', 'Google Drive, OneDrive, Dropbox, iCloud and pCloud.'],
        ['cat4_title', 'Card 4 — title', 'Software Licenses'], ['cat4_desc', 'Card 4 — text', 'MS 365, Office 2021, Windows, Teams, Visio, Project keys.'],
      ] },
      { title: 'Trust band', slots: [
        ['trust_heading', 'Heading', 'Trusted by thousands of buyers'],
        ['trust_sub', 'Subheading', 'Real orders, instant digital delivery, and a full-validity replacement warranty on every purchase.'],
        ['ts_orders_label', 'Stat 1 — label (count is live)', 'Orders delivered'],
        ['ts_customers_label', 'Stat 2 — label (count is live)', 'Happy customers'],
        ['ts_rating_num', 'Stat 3 — number', '4.8★'], ['ts_rating_label', 'Stat 3 — label', 'Average rating'],
        ['ts_delivery_num', 'Stat 4 — number', '<5 min'], ['ts_delivery_label', 'Stat 4 — label', 'Avg delivery time'],
      ] },
      { title: 'Call-to-action', slots: [
        ['cta_title', 'Heading', 'Ready to upgrade your digital access?'],
        ['cta_sub', 'Subheading', 'Join thousands of customers. Register free and get your first product today.'],
        ['cta_btn', 'Button', 'Start Ordering →'],
      ] },
    ];

    const textCard = sec => `<div class="card" style="padding:1.1rem;margin-bottom:1rem"><div style="font-weight:700;margin-bottom:.75rem">${esc(sec.title)}</div>${sec.slots.map(([k, label, def]) => `<div class="form-group"><label class="form-label">${esc(label)}</label><input class="form-input" name="home_${k}" value="${esc(s['home_' + k] || '')}" placeholder="${esc(def)}"></div>`).join('')}</div>`;
    const ROW_BORDER = 'border:1px solid rgba(128,128,128,.25);border-radius:10px';
    const secRow = id => `<div class="ht-secrow" data-id="${id}" style="display:flex;align-items:center;gap:.6rem;${ROW_BORDER};padding:.55rem .75rem;margin-bottom:.5rem;opacity:${onMap[id] ? '1' : '.5'}">
      <label style="display:flex;align-items:center;gap:.5rem;flex:1;cursor:pointer;margin:0"><input type="checkbox" class="sec-on" ${onMap[id] ? 'checked' : ''}> <strong>${esc(labelOf(id))}</strong></label>
      <span class="muted ht-sectag" style="font-size:.72rem">${onMap[id] ? '' : 'Hidden'}</span>
      <button type="button" class="btn btn-sm sec-up" title="Move up">↑</button>
      <button type="button" class="btn btn-sm sec-down" title="Move down">↓</button>
    </div>`;
    const revRow = (r = {}) => `<div class="ht-rev" style="${ROW_BORDER};padding:.7rem;margin-bottom:.6rem">
      <div style="display:flex;gap:.5rem;align-items:center;margin-bottom:.5rem">
        <select class="form-input rev-stars" style="width:96px;flex:0 0 auto">${[5, 4, 3, 2, 1].map(n => `<option value="${n}" ${(parseInt(r.stars, 10) || 5) === n ? 'selected' : ''}>${'★'.repeat(n)}</option>`).join('')}</select>
        <input class="form-input rev-name" value="${esc(r.name || '')}" placeholder="— Name, City" style="flex:1">
        <button type="button" class="btn btn-sm btn-red" data-del title="Remove">✕</button>
      </div>
      <textarea class="form-input rev-quote" rows="2" placeholder="What the customer said…">${esc(r.quote || '')}</textarea>
    </div>`;
    const lineRow = (cls, val = '') => `<div class="ht-line" style="display:flex;gap:.5rem;align-items:center;margin-bottom:.45rem">
      <input class="form-input ${cls}" value="${esc(val)}" style="flex:1">
      <button type="button" class="btn btn-sm btn-red" data-del title="Remove">✕</button>
    </div>`;

    setMain(`
<div style="display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-bottom:.4rem">
  <h2 style="font-weight:800;margin:0">Homepage Content</h2>
  <a class="btn btn-sm" href="/" target="_blank" rel="noopener">Open storefront ↗</a>
</div>
<p class="muted" style="font-size:.85rem;margin-bottom:1.25rem;max-width:760px">Edit everything on the landing page — text, reviews, the ticker and trust badges — and show, hide or reorder sections. Blank text fields keep the grey-placeholder default. Changes apply on the storefront's next load.</p>
<form id="hometext-form" style="max-width:760px">
  <div id="hometext-msg"></div>

  <div class="card" style="padding:1.1rem;margin-bottom:1rem">
    <div style="font-weight:700;margin-bottom:.25rem">🧩 Sections — show / hide / reorder</div>
    <p class="muted" style="font-size:.78rem;margin:0 0 .75rem">Untick to remove a section from the storefront (reversible — re-tick anytime). Use ↑ ↓ to reorder. The hero and footer are always shown.</p>
    <div id="sec-list">${order.map(secRow).join('')}</div>
  </div>

  ${TEXT_SECTIONS.map(textCard).join('')}

  <div class="card" style="padding:1.1rem;margin-bottom:1rem">
    <div style="font-weight:700;margin-bottom:.25rem">⭐ Customer reviews</div>
    <p class="muted" style="font-size:.78rem;margin:0 0 .75rem">Shown in the Trust band. Remove all to show no reviews (or hide the whole band above).</p>
    <div id="rev-list">${reviews.map(revRow).join('')}</div>
    <button type="button" class="btn btn-sm" id="rev-add">+ Add review</button>
  </div>

  <div class="card" style="padding:1.1rem;margin-bottom:1rem">
    <div style="font-weight:700;margin-bottom:.25rem">🏷️ Ticker items</div>
    <p class="muted" style="font-size:.78rem;margin:0 0 .75rem">The scrolling strip just under the hero.</p>
    <div id="tick-list">${ticker.map(t => lineRow('tick-val', t)).join('')}</div>
    <button type="button" class="btn btn-sm" id="tick-add">+ Add item</button>
  </div>

  <div class="card" style="padding:1.1rem;margin-bottom:1rem">
    <div style="font-weight:700;margin-bottom:.25rem">🛡️ Trust badges</div>
    <p class="muted" style="font-size:.78rem;margin:0 0 .75rem">The pill row at the bottom of the Trust band.</p>
    <div id="badge-list">${badges.map(b => lineRow('badge-val', b)).join('')}</div>
    <button type="button" class="btn btn-sm" id="badge-add">+ Add badge</button>
  </div>

  <button type="submit" class="btn btn-primary" style="width:240px">Save Homepage Content</button>
</form>`);

    const $ = id => document.getElementById(id);
    $('rev-add').onclick = () => $('rev-list').insertAdjacentHTML('beforeend', revRow({ stars: 5 }));
    $('tick-add').onclick = () => $('tick-list').insertAdjacentHTML('beforeend', lineRow('tick-val', ''));
    $('badge-add').onclick = () => $('badge-list').insertAdjacentHTML('beforeend', lineRow('badge-val', ''));
    ['rev-list', 'tick-list', 'badge-list'].forEach(id => $(id).addEventListener('click', e => {
      const b = e.target.closest('[data-del]'); if (!b) return;
      const row = b.closest('.ht-rev, .ht-line'); if (row) row.remove();
    }));
    const secList = $('sec-list');
    secList.addEventListener('click', e => {
      const row = e.target.closest('.ht-secrow'); if (!row) return;
      if (e.target.classList.contains('sec-up') && row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling);
      else if (e.target.classList.contains('sec-down') && row.nextElementSibling) row.parentNode.insertBefore(row.nextElementSibling, row);
    });
    secList.addEventListener('change', e => {
      if (!e.target.classList.contains('sec-on')) return;
      const row = e.target.closest('.ht-secrow');
      row.style.opacity = e.target.checked ? '1' : '.5';
      const tag = row.querySelector('.ht-sectag'); if (tag) tag.textContent = e.target.checked ? '' : 'Hidden';
    });

    $('hometext-form').onsubmit = async e => {
      e.preventDefault();
      const body = {};
      document.querySelectorAll('#hometext-form [name^="home_"]').forEach(el => { body[el.name] = el.value; });
      body.home_reviews = JSON.stringify([...document.querySelectorAll('.ht-rev')].map(r => ({
        stars: parseInt(r.querySelector('.rev-stars').value, 10) || 5,
        quote: r.querySelector('.rev-quote').value.trim(),
        name: r.querySelector('.rev-name').value.trim(),
      })).filter(r => r.quote || r.name));
      body.home_ticker = JSON.stringify([...document.querySelectorAll('.tick-val')].map(i => i.value.trim()).filter(Boolean));
      body.home_badges = JSON.stringify([...document.querySelectorAll('.badge-val')].map(i => i.value.trim()).filter(Boolean));
      body.home_sections = JSON.stringify([...document.querySelectorAll('.ht-secrow')].map(r => ({ id: r.dataset.id, on: r.querySelector('.sec-on').checked })));
      try {
        await api('/settings', { method: 'POST', body: JSON.stringify(body) });
        $('hometext-msg').innerHTML = '<div class="alert alert-success">Saved! Reload the storefront to see the changes.</div>';
        window.scrollTo({ top: 0, behavior: 'smooth' });
        setTimeout(() => { const m = $('hometext-msg'); if (m) m.innerHTML = ''; }, 3500);
      } catch (ex) { $('hometext-msg').innerHTML = `<div class="alert alert-error">${esc(ex.message)}</div>`; }
    };
  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

// ── views.settings ────────────────────────────────────────────────────────────
views.settings = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const s = await api('/settings');
    setMain(`
<h2 style="font-weight:800;margin-bottom:1.5rem">Settings</h2>
<div style="max-width:540px;display:flex;flex-direction:column;gap:1.25rem">
<div class="card">
  <div style="font-weight:700;margin-bottom:.75rem">Change Admin Password</div>
  <form id="pass-form" style="display:flex;flex-direction:column;gap:.75rem">
  <div id="pass-msg"></div>
  <div class="form-group"><label class="form-label">New Password</label><input class="form-input" id="new-pass" type="password" placeholder="Min. 6 characters"></div>
  <div class="form-group"><label class="form-label">Confirm Password</label><input class="form-input" id="conf-pass" type="password"></div>
  <button type="submit" class="btn btn-primary btn-sm" style="width:160px">Update Password</button>
  </form>
</div>
<div class="card">
  <div style="font-weight:700;margin-bottom:.25rem">Two-Factor Authentication (2FA)</div>
  <p class="muted" style="font-size:.83rem;margin:0 0 .75rem">Require a 6-digit code from Google Authenticator / Authy at admin login — strongly recommended.</p>
  <div id="twofa-box"><div class="spinner" style="width:22px;height:22px"></div></div>
</div>
<div class="card">
  <div style="font-weight:700;margin-bottom:.5rem">SMTP Email</div>
  <p class="muted" style="font-size:.8rem;margin:0 0 .6rem">Sends order delivery emails &amp; password resets. Gmail is easiest — but it needs an <strong>App Password</strong>, not your normal password.</p>
  <details style="margin-bottom:.85rem">
    <summary style="cursor:pointer;font-weight:600;font-size:.84rem;color:var(--muted)">📖 How to set up Gmail SMTP (2 min)</summary>
    <ol class="muted" style="font-size:.82rem;line-height:1.85;padding-left:1.25rem;margin:.5rem 0 0">
      <li>Enable <strong>2-Step Verification</strong> on your Google account: <a href="https://myaccount.google.com/security" target="_blank" rel="noopener">myaccount.google.com/security</a>.</li>
      <li>Create an App Password: <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">myaccount.google.com/apppasswords</a> → name it "Store" → copy the <strong>16-character</strong> code.</li>
      <li>Fill in below — <strong>Host</strong> <code>smtp.gmail.com</code>, <strong>Port</strong> <code>587</code>, <strong>User</strong> your full Gmail address, <strong>Password</strong> the 16-char App Password (no spaces), <strong>From</strong> your Gmail address — then Save.</li>
      <li>Tip: for bulk marketing emails, use the dedicated <strong>Email Auto-Post</strong> section instead.</li>
    </ol>
  </details>
  <form id="smtp-form" style="display:flex;flex-direction:column;gap:.75rem">
  <div id="smtp-msg"></div>
  <div class="form-row">
    <div class="form-group"><label class="form-label">Host</label><input class="form-input" name="smtp_host" value="${esc(s.smtp_host||'')}" placeholder="smtp.gmail.com"></div>
    <div class="form-group"><label class="form-label">Port</label><input class="form-input" name="smtp_port" type="number" value="${esc(s.smtp_port||'587')}"></div>
  </div>
  <div class="form-row">
    <div class="form-group"><label class="form-label">User</label><input class="form-input" name="smtp_user" value="${esc(s.smtp_user||'')}"></div>
    <div class="form-group"><label class="form-label">Password</label><input class="form-input" name="smtp_pass" type="password" value="${esc(s.smtp_pass||'')}"></div>
  </div>
  <div class="form-group"><label class="form-label">From Address</label><input class="form-input" name="smtp_from" value="${esc(s.smtp_from||'')}"></div>
  <button type="submit" class="btn btn-primary btn-sm" style="width:160px">Save SMTP</button>
  </form>
</div>
</div>`);

    document.getElementById('pass-form').onsubmit = async e => {
      e.preventDefault();
      const np = document.getElementById('new-pass').value;
      const cp = document.getElementById('conf-pass').value;
      const msg = document.getElementById('pass-msg');
      if (np.length < 6) return msg.innerHTML = '<div class="alert alert-error">Min 6 characters.</div>';
      if (np !== cp) return msg.innerHTML = '<div class="alert alert-error">Passwords do not match.</div>';
      try {
        await api('/settings', { method: 'POST', body: JSON.stringify({ admin_password: np }) });
        msg.innerHTML = '<div class="alert alert-success">Password updated!</div>';
        setTimeout(() => msg.innerHTML = '', 2500);
      } catch (ex) { msg.innerHTML = `<div class="alert alert-error">${esc(ex.message)}</div>`; }
    };

    document.getElementById('smtp-form').onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(e.target); const body = {};
      fd.forEach((v, k) => body[k] = v);
      const msg = document.getElementById('smtp-msg');
      try {
        await api('/settings', { method: 'POST', body: JSON.stringify(body) });
        msg.innerHTML = '<div class="alert alert-success">Saved!</div>';
        setTimeout(() => msg.innerHTML = '', 2500);
      } catch (ex) { msg.innerHTML = `<div class="alert alert-error">${esc(ex.message)}</div>`; }
    };

    // ── Two-Factor Authentication card ──
    const GLASS = 'rgba(125,135,170,.14)';
    async function render2fa() {
      const box = document.getElementById('twofa-box');
      if (!box) return;
      let st; try { st = await api('/2fa/status'); } catch (e) { box.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`; return; }
      if (st.enabled) {
        box.innerHTML = `
<div class="alert alert-success" style="margin-bottom:.75rem">✓ 2FA is ON — admin login now requires a code. Backup codes left: <b>${st.backupLeft}</b></div>
<div class="form-group"><label class="form-label">Turn off (enter a current code or a backup code)</label>
  <input class="form-input" id="twofa-disable-code" inputmode="numeric" autocomplete="off" placeholder="6-digit or backup code" style="max-width:260px"></div>
<button class="btn btn-secondary btn-sm" id="twofa-disable-btn">Disable 2FA</button>
<div id="twofa-msg" style="margin-top:.5rem"></div>`;
        document.getElementById('twofa-disable-btn').onclick = async () => {
          const code = document.getElementById('twofa-disable-code').value.trim();
          const m = document.getElementById('twofa-msg');
          try { await api('/2fa/disable', { method: 'POST', body: JSON.stringify({ token: code }) }); render2fa(); }
          catch (e) { m.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`; }
        };
      } else {
        box.innerHTML = `<button class="btn btn-primary btn-sm" id="twofa-setup-btn">Enable 2FA</button><div id="twofa-setup-box" style="margin-top:.75rem"></div>`;
        document.getElementById('twofa-setup-btn').onclick = async () => {
          const wrap = document.getElementById('twofa-setup-box');
          wrap.innerHTML = '<div class="spinner" style="width:20px;height:20px"></div>';
          let r; try { r = await api('/2fa/setup', { method: 'POST' }); } catch (e) { wrap.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`; return; }
          wrap.innerHTML = `
<div style="display:flex;gap:1.1rem;flex-wrap:wrap;align-items:flex-start">
  <img src="${r.qr}" alt="2FA QR code" style="width:170px;height:170px;border-radius:10px;background:#fff;padding:6px">
  <div style="flex:1;min-width:210px">
    <p style="font-size:.83rem;margin:0 0 .4rem"><b>1.</b> Scan the QR in <b>Google Authenticator</b> / <b>Authy</b>, or type this key:</p>
    <code style="display:block;word-break:break-all;background:${GLASS};padding:.5rem;border-radius:6px;font-size:.78rem;margin-bottom:.75rem">${esc(r.secret)}</code>
    <p style="font-size:.83rem;margin:0 0 .4rem"><b>2.</b> Enter the 6-digit code it shows:</p>
    <div style="display:flex;gap:.5rem;flex-wrap:wrap">
      <input class="form-input" id="twofa-confirm" inputmode="numeric" autocomplete="one-time-code" placeholder="000000" style="max-width:150px">
      <button class="btn btn-primary btn-sm" id="twofa-confirm-btn">Verify &amp; Enable</button>
    </div>
  </div>
</div>
<div id="twofa-confirm-msg" style="margin-top:.5rem"></div>`;
          document.getElementById('twofa-confirm-btn').onclick = async () => {
            const code = document.getElementById('twofa-confirm').value.trim();
            const cm = document.getElementById('twofa-confirm-msg');
            let res; try { res = await api('/2fa/enable', { method: 'POST', body: JSON.stringify({ token: code }) }); }
            catch (e) { cm.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`; return; }
            wrap.innerHTML = `
<div class="alert alert-success">✓ 2FA enabled! Save these <b>backup codes</b> — each works once if you lose your phone:</div>
<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:.4rem;font-family:monospace;font-size:.95rem;background:${GLASS};padding:.75rem;border-radius:8px;margin:.5rem 0">${res.backupCodes.map(c => `<div>${esc(c)}</div>`).join('')}</div>
<button class="btn btn-secondary btn-sm" id="twofa-done-btn">I've saved them — Done</button>`;
            document.getElementById('twofa-done-btn').onclick = () => render2fa();
          };
        };
      }
    }
    render2fa();
  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

// ── views.auditlog ────────────────────────────────────────────────────────────
views.auditlog = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const logs = await api('/audit-log');
    const rows = logs.map(l => `
<tr>
  <td>#${l.id}</td>
  <td><span class="badge ${l.actor_kind==='admin'?'badge-purple':'badge-blue'}">${esc(l.actor_kind)}</span></td>
  <td>${esc(l.actor_label)}</td>
  <td style="font-weight:600">${esc(l.action)}</td>
  <td>${esc(l.target_kind)} ${l.target_id?`#${esc(l.target_id)}`:''}</td>
  <td>${esc(l.ip||'—')}</td>
  <td>${fmtDate(l.created_at)}</td>
</tr>`).join('');
    setMain(`
<h2 style="font-weight:800;margin-bottom:1rem">Audit Log</h2>
<div class="table-wrap"><table>
<thead><tr><th>ID</th><th>Actor</th><th>Label</th><th>Action</th><th>Target</th><th>IP</th><th>Date</th></tr></thead>
<tbody>${rows||'<tr><td colspan="7" class="muted" style="text-align:center;padding:2rem">No audit logs</td></tr>'}</tbody>
</table></div>`);
  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

// ── views.backup ──────────────────────────────────────────────────────────────
views.backup = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const s = await api('/settings');
    const lastAt = s.backup_last_at ? new Date(s.backup_last_at).toLocaleString() : 'never';
    const lastSize = s.backup_last_size ? (Math.round(Number(s.backup_last_size) / 1024).toLocaleString() + ' KB') : '';
    const enabled = s.backup_telegram_enabled === '1';
    setMain(`
<h2 style="font-weight:800;margin-bottom:.4rem">Database Backup</h2>
<p class="muted" style="font-size:.85rem;margin-bottom:1.25rem;max-width:760px">Your whole store — customers, orders, settings and catalog — lives in one SQLite file. Download it, restore from a copy, or have it auto-delivered to a private Telegram channel on a schedule.</p>
<div id="backup-msg"></div>

<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:1rem;max-width:1000px">

  <div class="card" style="padding:1.25rem">
    <div style="font-weight:700;margin-bottom:.5rem">⬇️ Download &amp; Restore</div>
    <p class="muted" style="font-size:.8rem;margin:0 0 1rem">Download a full copy now, or restore the store from a previously downloaded <code>.db</code> file.</p>
    <a href="/admin/api/backup/download" class="btn btn-primary" download>⬇️ Download backup</a>
    <hr style="border:none;border-top:1px solid rgba(128,128,128,.25);margin:1.1rem 0">
    <div style="font-weight:700;margin-bottom:.35rem;color:#ef4444">⚠️ Restore — replaces ALL data</div>
    <input type="file" id="restore-file" accept=".db,.sqlite,application/octet-stream" class="form-input" style="margin-bottom:.6rem">
    <button class="btn btn-red btn-sm" id="restore-btn">Restore from file</button>
  </div>

  <div class="card" style="padding:1.25rem">
    <div style="font-weight:700;margin-bottom:.5rem">📲 Daily Telegram backup</div>
    <label style="display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem"><input type="checkbox" id="bk-enabled" ${enabled ? 'checked' : ''}> Send automatic backups on a schedule</label>
    <div class="form-group"><label class="form-label">Bot token <span class="muted">(from @BotFather)</span></label><input class="form-input" id="bk-token" value="${esc(s.telegram_bot_token || '')}" placeholder="123456:ABC-DEF…"></div>
    <div class="form-group"><label class="form-label">Chat / Channel ID</label><input class="form-input" id="bk-chat" value="${esc(s.telegram_backup_chat_id || '')}" placeholder="-1001234567890"></div>
    <div class="form-group"><label class="form-label">Every (hours)</label><input class="form-input" id="bk-interval" type="number" min="1" value="${esc(s.backup_interval_hours || '24')}" style="width:140px"></div>
    <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.25rem">
      <button class="btn btn-primary btn-sm" id="bk-save">Save</button>
      <button class="btn btn-secondary btn-sm" id="bk-test">Send test message</button>
      <button class="btn btn-secondary btn-sm" id="bk-now">Backup now</button>
    </div>
    <p class="muted" style="font-size:.78rem;margin:.8rem 0 0">Last backup: <strong>${esc(lastAt)}</strong>${lastSize ? ` · ${esc(lastSize)}` : ''}</p>
  </div>
</div>

<details class="card" style="max-width:1000px;margin-top:1.25rem;padding:1rem 1.25rem">
  <summary style="cursor:pointer;font-weight:700">📖 How to set up the Telegram backup (2 min)</summary>
  <ol class="muted" style="font-size:.84rem;line-height:1.9;margin:.6rem 0 0;padding-left:1.25rem">
    <li>In Telegram, open <strong>@BotFather</strong> → send <code>/newbot</code> → copy the <strong>bot token</strong>.</li>
    <li>Create a <strong>private channel</strong> (or group) for backups and add your bot to it as an <strong>admin</strong>.</li>
    <li>Get the channel ID — forward any channel message to <strong>@userinfobot</strong>, or use <strong>@getidsbot</strong>. Channel IDs look like <code>-100…</code>.</li>
    <li>Paste the token + channel ID above, click <strong>Save</strong>, then <strong>Send test message</strong> to confirm it arrives.</li>
    <li>Tick <strong>Send automatic backups</strong>, set the interval, Save. Backups now arrive on their own.</li>
  </ol>
</details>`);

    const $ = id => document.getElementById(id);
    const msg = h => { $('backup-msg').innerHTML = h; window.scrollTo({ top: 0, behavior: 'smooth' }); };
    const saveCfg = () => api('/settings', { method: 'POST', body: JSON.stringify({
      backup_telegram_enabled: $('bk-enabled').checked ? '1' : '0',
      telegram_bot_token: $('bk-token').value.trim(),
      telegram_backup_chat_id: $('bk-chat').value.trim(),
      backup_interval_hours: String(parseFloat($('bk-interval').value) || 24),
    }) });
    $('bk-save').onclick = async () => { try { await saveCfg(); msg('<div class="alert alert-success">Settings saved.</div>'); } catch (e) { msg(`<div class="alert alert-error">${esc(e.message)}</div>`); } };
    $('bk-test').onclick = async () => { try { await saveCfg(); await api('/backup/test-telegram', { method: 'POST', body: '{}' }); msg('<div class="alert alert-success">Test message sent — check your Telegram channel.</div>'); } catch (e) { msg(`<div class="alert alert-error">${esc(e.message)}</div>`); } };
    $('bk-now').onclick = async () => { try { await saveCfg(); const r = await api('/backup/telegram-now', { method: 'POST', body: '{}' }); msg(`<div class="alert alert-success">Backup sent to Telegram (${Math.round((r.size || 0) / 1024)} KB).</div>`); views.backup(); } catch (e) { msg(`<div class="alert alert-error">${esc(e.message)}</div>`); } };
    $('restore-btn').onclick = async () => {
      const f = $('restore-file').files[0];
      if (!f) { msg('<div class="alert alert-error">Choose a .db backup file first.</div>'); return; }
      if (!confirm('Restore will REPLACE all current data with the uploaded backup. This cannot be undone. Continue?')) return;
      try {
        const fd = new FormData(); fd.append('file', f);
        const res = await fetch('/admin/api/backup/restore', { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': getCsrfToken() }, body: fd });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        msg('<div class="alert alert-success">✅ Database restored. Reloading…</div>');
        setTimeout(() => location.reload(), 1500);
      } catch (e) { msg(`<div class="alert alert-error">${esc(e.message)}</div>`); }
    };
  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

// ── views.analytics ───────────────────────────────────────────────────────────
views.analytics = async function () {
  setMain('<div class="spinner"></div>');
  try {
    let days = 30;
    const render = async () => {
      const d = await api(`/analytics?days=${days}`);
      const revenueRows = d.revenue.map(r =>
        `<tr><td>${r.d}</td><td>${fmt(r.rev)}</td><td>${r.cnt}</td></tr>`).join('');
      const topPlanRows = (d.topPlans||[]).map(p =>
        `<tr><td>${esc(p.platform||'')}</td><td>${esc(p.name||'')}</td><td>${p.orders}</td><td>${fmt(p.revenue)}</td></tr>`).join('');
      const topCustRows = (d.topCustomers||[]).map(c =>
        `<tr><td>${esc(c.name||'')}</td><td>${esc(c.email||'')}</td><td>${c.orders}</td><td>${fmt(c.spent)}</td></tr>`).join('');
      const platformRows = (d.platforms||[]).map(p =>
        `<tr><td>${esc(p.platform||'Other')}</td><td>${p.orders}</td><td>${fmt(p.revenue)}</td></tr>`).join('');
      setMain(`
<div style="display:flex;align-items:center;gap:1rem;margin-bottom:1.5rem;flex-wrap:wrap">
  <h2 style="font-weight:800;flex:1">Analytics</h2>
  <select id="days-sel" class="form-input" style="width:150px">
    <option value="7" ${days===7?'selected':''}>Last 7 days</option>
    <option value="30" ${days===30?'selected':''}>Last 30 days</option>
    <option value="90" ${days===90?'selected':''}>Last 90 days</option>
  </select>
</div>
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem;margin-bottom:1.5rem">
  <div class="card text-center"><div style="font-size:1.6rem;font-weight:800;color:var(--green)">${fmt(d.totals?.revenue||0)}</div><div class="muted">Revenue (${days}d)</div></div>
  <div class="card text-center"><div style="font-size:1.6rem;font-weight:800">${d.totals?.orders||0}</div><div class="muted">Orders (${days}d)</div></div>
  <div class="card text-center"><div style="font-size:1.6rem;font-weight:800">${d.newCustomers||0}</div><div class="muted">New Customers</div></div>
</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;margin-bottom:1.5rem">
  <div class="card"><div style="font-weight:700;margin-bottom:.75rem">Daily Revenue</div>
  <div class="table-wrap"><table><thead><tr><th>Date</th><th>Revenue</th><th>Orders</th></tr></thead>
  <tbody>${revenueRows||'<tr><td colspan=3 class="muted">No data</td></tr>'}</tbody></table></div></div>
  <div class="card"><div style="font-weight:700;margin-bottom:.75rem">By Platform</div>
  <div class="table-wrap"><table><thead><tr><th>Platform</th><th>Orders</th><th>Revenue</th></tr></thead>
  <tbody>${platformRows||'<tr><td colspan=3 class="muted">No data</td></tr>'}</tbody></table></div></div>
</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:1.25rem">
  <div class="card"><div style="font-weight:700;margin-bottom:.75rem">Top Plans</div>
  <div class="table-wrap"><table><thead><tr><th>Platform</th><th>Plan</th><th>Orders</th><th>Revenue</th></tr></thead>
  <tbody>${topPlanRows||'<tr><td colspan=4 class="muted">No data</td></tr>'}</tbody></table></div></div>
  <div class="card"><div style="font-weight:700;margin-bottom:.75rem">Top Customers</div>
  <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Orders</th><th>Spent</th></tr></thead>
  <tbody>${topCustRows||'<tr><td colspan=4 class="muted">No data</td></tr>'}</tbody></table></div></div>
</div>`);
      document.getElementById('days-sel').onchange = e => { days = parseInt(e.target.value); render(); };
    };
    await render();
  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

// ── views.stock ────────────────────────────────────────────────────────────────
views.stock = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const plans = await api('/stock');
    let activePlan = null;
    const renderList = () => {
      setMain(`
<div style="display:flex;align-items:center;gap:1rem;margin-bottom:1.5rem">
  <h2 style="font-weight:800;flex:1">Stock Management</h2>
</div>
<div class="table-wrap"><table>
<thead><tr><th>Platform</th><th>Plan</th><th>Available</th><th>Sold</th><th>Action</th></tr></thead>
<tbody>${plans.map(p => `<tr>
  <td><span class="badge badge-blue">${esc(p.platform)}</span></td>
  <td>${esc(p.name)}</td>
  <td><span class="badge ${p.available > 5 ? 'badge-green' : p.available > 0 ? 'badge-yellow' : 'badge-red'}">${p.available}</span></td>
  <td class="muted">${p.sold}</td>
  <td><button class="btn btn-sm btn-primary" onclick="manageStock(${p.id},'${esc(p.name)}')">Manage</button></td>
</tr>`).join('')}</tbody></table></div>`);
    };
    renderList();

    window.manageStock = async function(planId, planName) {
      const creds = await api(`/stock/${planId}`);
      const avail = creds.filter(c => c.status === 'available');
      const sold = creds.filter(c => c.status === 'sold');
      const ov = openModal(`
<div class="modal-header"><h3>Stock: ${esc(planName)}</h3><button class="btn-icon" onclick="this.closest('.modal-overlay').remove()">✕</button></div>
<div class="modal-body">
  <div class="alert alert-info">${avail.length} available · ${sold.length} sold</div>
  <div class="form-group"><label class="form-label">Add Single Credential</label>
    <input class="form-input" id="sk-line1" placeholder="Email / Key / Link">
    <input class="form-input mt-2" id="sk-line2" placeholder="Password (optional)">
    <select class="form-input mt-2" id="sk-type"><option value="credential">Email:Password</option><option value="key">License Key</option><option value="link">Link</option><option value="text">Text</option></select>
    <button class="btn btn-primary btn-sm mt-2" onclick="addSingle(${planId})">Add</button>
  </div>
  <div class="form-group"><label class="form-label">Bulk Import (one per line: email:password or email|password)</label>
    <textarea class="form-input" id="sk-bulk" rows="6" placeholder="user1@gmail.com:pass1&#10;user2@gmail.com:pass2"></textarea>
    <button class="btn btn-green btn-sm mt-2" onclick="bulkImport(${planId})">Import Bulk</button>
  </div>
  <div id="sk-msg"></div>
  <div style="font-weight:600;margin-top:.75rem">Available (${avail.length})</div>
  <div style="max-height:200px;overflow-y:auto;font-size:.8rem">
    ${avail.map(c => `<div style="display:flex;justify-content:space-between;padding:.25rem 0;border-bottom:1px solid var(--border)">
      <span style="font-family:monospace">${esc(c.line1)}${c.line2 ? ':'+esc(c.line2) : ''}</span>
      <button class="btn btn-red btn-sm" onclick="deleteCred(${c.id},${planId},'${esc(planName)}')">×</button>
    </div>`).join('') || '<p class="muted">No stock</p>'}
  </div>
</div>`);

      window.addSingle = async function(pid) {
        const line1 = document.getElementById('sk-line1').value.trim();
        const line2 = document.getElementById('sk-line2').value.trim();
        const cred_type = document.getElementById('sk-type').value;
        const msg = document.getElementById('sk-msg');
        if (!line1) { msg.innerHTML='<div class="alert alert-error">Line1 required</div>'; return; }
        try {
          await api(`/stock/${pid}`, { method:'POST', body: JSON.stringify({ line1, line2, cred_type }) });
          msg.innerHTML='<div class="alert alert-success">Added!</div>';
          document.getElementById('sk-line1').value = '';
          document.getElementById('sk-line2').value = '';
          setTimeout(() => { ov.remove(); manageStock(pid, planName); }, 800);
        } catch(e) { msg.innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
      };
      window.bulkImport = async function(pid) {
        const text = document.getElementById('sk-bulk').value.trim();
        const msg = document.getElementById('sk-msg');
        if (!text) return;
        try {
          const r = await api(`/stock/${pid}/bulk`, { method:'POST', body: JSON.stringify({ text }) });
          msg.innerHTML=`<div class="alert alert-success">Imported ${r.added} credentials!</div>`;
          setTimeout(() => { ov.remove(); const pl = plans.find(p=>p.id===pid); if(pl){ pl.available += r.added; } renderList(); manageStock(pid, planName); }, 800);
        } catch(e) { msg.innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
      };
      window.deleteCred = async function(cid, pid, pname) {
        if (!confirm('Delete this credential?')) return;
        await api(`/stock/${cid}`, { method:'DELETE' });
        ov.remove(); manageStock(pid, pname);
      };
    };
  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

// ── views.resellers ────────────────────────────────────────────────────────────
views.resellers = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const resellers = await api('/resellers');
    setMain(`
<h2 style="font-weight:800;margin-bottom:1.5rem">Resellers</h2>
<div class="table-wrap"><table>
<thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Discount</th><th>Applied</th><th>Actions</th></tr></thead>
<tbody>${resellers.length ? resellers.map(r => `<tr>
  <td>${esc(r.name||'—')}</td>
  <td>${esc(r.email||'—')}</td>
  <td>${statusBadge(r.status)}</td>
  <td>${r.discount_percent||0}%</td>
  <td>${fmtDateShort(r.created_at)}</td>
  <td style="display:flex;gap:.4rem">
    <button class="btn btn-sm btn-green" onclick="editReseller(${r.id},'${esc(r.status)}',${r.discount_percent||0},'${esc(r.notes||'')}')">Edit</button>
    <button class="btn btn-sm btn-red" onclick="deleteReseller(${r.id})">Delete</button>
  </td>
</tr>`).join('') : '<tr><td colspan=6 class="muted" style="text-align:center;padding:2rem">No reseller applications</td></tr>'}</tbody></table></div>`);

    window.editReseller = function(id, status, discount, notes) {
      const ov = openModal(`
<div class="modal-header"><h3>Edit Reseller</h3><button class="btn-icon" onclick="this.closest('.modal-overlay').remove()">✕</button></div>
<div class="modal-body">
  <div id="rs-msg"></div>
  <div class="form-group"><label class="form-label">Status</label>
    <select class="form-input" id="rs-status">
      <option value="pending" ${status==='pending'?'selected':''}>Pending</option>
      <option value="approved" ${status==='approved'?'selected':''}>Approved</option>
      <option value="rejected" ${status==='rejected'?'selected':''}>Rejected</option>
    </select>
  </div>
  <div class="form-group"><label class="form-label">Discount %</label><input class="form-input" id="rs-disc" type="number" min="0" max="99" value="${discount}"></div>
  <div class="form-group"><label class="form-label">Notes</label><input class="form-input" id="rs-notes" value="${esc(notes)}"></div>
</div>
<div class="modal-footer"><button class="btn btn-primary" onclick="saveReseller(${id})">Save</button></div>`);

      window.saveReseller = async function(rid) {
        const msg = document.getElementById('rs-msg');
        try {
          await api(`/resellers/${rid}`, { method:'PUT', body: JSON.stringify({
            status: document.getElementById('rs-status').value,
            discount_percent: parseFloat(document.getElementById('rs-disc').value)||0,
            notes: document.getElementById('rs-notes').value,
          })});
          ov.remove(); views.resellers();
        } catch(e) { msg.innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
      };
    };
    window.deleteReseller = async function(id) {
      if (!confirm('Remove this reseller?')) return;
      await api(`/resellers/${id}`, { method:'DELETE' });
      views.resellers();
    };
  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

// ── views.referrals ────────────────────────────────────────────────────────────
views.referrals = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const [refs, s] = await Promise.all([api('/referrals'), api('/settings')]);
    const reward = s.referral_reward_inr || '20';
    const pending = refs.filter(r => r.status === 'pending').length;
    const credited = refs.filter(r => r.status === 'credited');
    const creditedTotal = credited.reduce((a, r) => a + (Number(r.reward_inr) || 0), 0);
    const statCard = (label, val, color) => `<div class="card" style="padding:.85rem 1.1rem"><div class="muted" style="font-size:.7rem;text-transform:uppercase;letter-spacing:.04em">${label}</div><div style="font-size:1.3rem;font-weight:800${color ? `;color:${color}` : ''}">${val}</div></div>`;
    setMain(`
<h2 style="font-weight:800;margin-bottom:.4rem">Referrals</h2>
<p class="muted" style="font-size:.85rem;margin-bottom:1.25rem;max-width:760px">Customers earn a reward when someone they referred places their <strong>first order</strong>. The reward is tracked here as <em>pending</em> — mark it <strong>Paid</strong> once you've paid the referrer out (UPI, discount on next order, etc.). Payouts are handled off-platform.</p>

<div class="card" style="padding:1.1rem;margin-bottom:1rem;max-width:760px">
  <div style="font-weight:700;margin-bottom:.6rem">⚙️ Reward settings</div>
  <div style="display:flex;gap:.6rem;align-items:flex-end;flex-wrap:wrap">
    <div class="form-group" style="margin:0"><label class="form-label">Reward per referral (₹)</label><input class="form-input" id="ref-reward" type="number" min="0" step="1" value="${esc(reward)}" style="width:180px"></div>
    <button class="btn btn-primary btn-sm" id="ref-reward-save">Save</button>
    <span id="ref-reward-msg" class="muted" style="font-size:.8rem"></span>
  </div>
  <p class="muted" style="font-size:.76rem;margin:.6rem 0 0">Applies to new referral rewards. Customers see this amount on their Referral tab.</p>
</div>

<div style="display:flex;gap:.75rem;flex-wrap:wrap;margin-bottom:1.1rem">
  ${statCard('Total', refs.length)}
  ${statCard('Pending', pending, '#f59e0b')}
  ${statCard('Paid', credited.length, '#10b981')}
  ${statCard('Paid out', '₹' + creditedTotal.toLocaleString('en-IN'))}
</div>

<div class="table-wrap"><table>
<thead><tr><th>Referrer</th><th>Referred</th><th>Reward</th><th>Order</th><th>Status</th><th>Date</th><th></th></tr></thead>
<tbody>${refs.length ? refs.map(r => `<tr>
  <td>${esc(r.referrer_name||r.referrer_jid||'—')}<br><span class="muted">${esc(r.referrer_email||'')}</span></td>
  <td>${esc(r.referred_name||r.referred_jid||'—')}<br><span class="muted">${esc(r.referred_email||'')}</span></td>
  <td>₹${r.reward_inr}</td>
  <td>${r.order_id ? ('#' + r.order_id) : '—'}</td>
  <td>${statusBadge(r.status)}</td>
  <td>${fmtDateShort(r.created_at)}</td>
  <td>${r.status==='pending' ? `<button class="btn btn-sm btn-green" onclick="creditRef(${r.id})">Mark paid</button>` : ''}</td>
</tr>`).join('') : '<tr><td colspan=7 class="muted" style="text-align:center;padding:2rem">No referrals yet. Rewards appear here once a referred customer places their first order.</td></tr>'}</tbody></table></div>`);

    document.getElementById('ref-reward-save').onclick = async () => {
      const msg = document.getElementById('ref-reward-msg');
      try {
        await api('/settings', { method: 'POST', body: JSON.stringify({ referral_reward_inr: String(parseFloat(document.getElementById('ref-reward').value) || 0) }) });
        msg.textContent = 'Saved ✓'; setTimeout(() => { if (msg) msg.textContent = ''; }, 2500);
      } catch (e) { msg.textContent = e.message; }
    };
    window.creditRef = async function(id) {
      if (!confirm('Mark this referral reward as paid? Do this only after you have paid the referrer.')) return;
      await api(`/referrals/${id}/credit`, { method:'POST', body:'{}' });
      views.referrals();
    };
  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

// ── views.broadcast ────────────────────────────────────────────────────────────
views.broadcast = async function () {
  setMain(`
<h2 style="font-weight:800;margin-bottom:1.5rem">Broadcast Email</h2>
<div style="max-width:680px">
  <div class="card">
    <div id="bc-msg"></div>
    <form id="bc-form" style="display:flex;flex-direction:column;gap:.9rem">
      <div class="form-group"><label class="form-label">Subject</label><input class="form-input" name="subject" placeholder="🎉 Special offer just for you!"></div>
      <div class="form-group"><label class="form-label">Message</label><textarea class="form-input" name="message" rows="6" placeholder="Hi there,\n\nWe have an exciting offer..."></textarea></div>
      <div class="form-group"><label class="form-label">Image URL (optional)</label><input class="form-input" name="imageUrl" placeholder="https://..."></div>
      <div class="form-group"><label class="form-label">Target</label>
        <select class="form-input" name="target">
          <option value="all">All customers</option>
          <option value="active">Active (ordered in last 30 days)</option>
        </select>
      </div>
      <button type="submit" class="btn btn-primary" style="width:200px">📢 Send Broadcast</button>
    </form>
  </div>
</div>`);
  document.getElementById('bc-form').onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target); const b = {};
    fd.forEach((v,k) => b[k] = v);
    const msg = document.getElementById('bc-msg');
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const r = await api('/broadcast', { method:'POST', body: JSON.stringify(b) });
      msg.innerHTML = `<div class="alert alert-success">✓ Sent to ${r.sent} customers. ${r.failed ? r.failed + ' failed.' : ''}</div>`;
    } catch(ex) { msg.innerHTML = `<div class="alert alert-error">${esc(ex.message)}</div>`; }
    finally { btn.disabled = false; btn.textContent = '📢 Send Broadcast'; }
  };
};

// ── views.autopost ─────────────────────────────────────────────────────────────
views.autopost = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const [campaigns, settings] = await Promise.all([api('/autopost'), api('/autopost-settings')]);
    const renderMain = () => setMain(`
<div style="display:flex;align-items:center;gap:1rem;margin-bottom:1rem">
  <h2 style="font-weight:800;flex:1">Email Auto-Post Campaigns</h2>
  <button class="btn btn-secondary" onclick="openAutopostSettings()">⚙️ Schedule Settings</button>
  <button class="btn btn-primary" onclick="newCampaign()">+ New Campaign</button>
</div>
<div class="card" style="padding:1rem;margin-bottom:1.5rem;display:flex;align-items:center;gap:1.5rem;flex-wrap:wrap">
  <span style="font-weight:600">Auto-Scheduler:</span>
  <span class="badge ${settings.autopost_enabled==='1'?'badge-green':'badge-grey'}">${settings.autopost_enabled==='1'?'Enabled':'Disabled'}</span>
  <span class="muted" style="font-size:.85rem">Runs: <strong>${settings.autopost_start_hour||'9'}:00</strong> – <strong>${settings.autopost_end_hour||'22'}:00</strong> IST</span>
  <button class="btn btn-sm ${settings.autopost_enabled==='1'?'btn-red':'btn-primary'}" onclick="toggleAutopost('${settings.autopost_enabled==='1'?'0':'1'}')">${settings.autopost_enabled==='1'?'Disable':'Enable'} Scheduler</button>
</div>
<div class="table-wrap"><table>
<thead><tr><th>Title</th><th>Schedule</th><th>Times Sent</th><th>Last Sent</th><th>Status</th><th>Actions</th></tr></thead>
<tbody>${campaigns.length ? campaigns.map(c => `<tr>
  <td><strong>${esc(c.title)}</strong></td>
  <td>${c.schedule_enabled ? 'Every '+c.interval_hours+'h' : 'Manual'}</td>
  <td>${c.times_sent}</td>
  <td>${c.last_sent_at ? fmtDateShort(c.last_sent_at) : '—'}</td>
  <td>${c.active ? '<span class="badge badge-green">Active</span>' : '<span class="badge badge-grey">Paused</span>'}</td>
  <td style="display:flex;gap:.4rem;flex-wrap:wrap">
    <button class="btn btn-sm btn-secondary" onclick="editCampaign(${c.id})">Edit</button>
    <button class="btn btn-sm btn-secondary" onclick="cloneCampaign(${c.id})">Clone</button>
    <button class="btn btn-sm btn-primary" onclick="sendNow(${c.id})">Send Now</button>
    <button class="btn btn-sm btn-red" onclick="deleteCamp(${c.id})">Delete</button>
  </td>
</tr>`).join('') : '<tr><td colspan=6 class="muted" style="text-align:center;padding:2rem">No campaigns yet</td></tr>'}</tbody></table></div>`);
    renderMain();

    function campaignModal(camp) {
      const isNew = !camp.id;
      const ov = openModal(`
<div class="modal-header"><h3>${isNew ? 'New Campaign' : 'Edit Campaign'}</h3><button class="btn-icon" onclick="this.closest('.modal-overlay').remove()">✕</button></div>
<div class="modal-body">
  <div id="cp-msg"></div>
  <div class="form-group"><label class="form-label">Title</label><input class="form-input" id="cp-title" value="${esc(camp.title||'')}"></div>
  <div class="form-group"><label class="form-label">Email Subject</label><input class="form-input" id="cp-subject" value="${esc(camp.subject||'')}"></div>
  <div class="form-group"><label class="form-label">Message (HTML allowed)</label><textarea class="form-input" id="cp-msg-body" rows="5">${esc(camp.message||'')}</textarea></div>
  <div class="form-group"><label class="form-label">Image URL</label><input class="form-input" id="cp-img" value="${esc(camp.image_url||'')}"></div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
    <div class="form-group"><label class="form-label">Target</label>
      <select class="form-input" id="cp-target"><option value="all" ${camp.target==='all'?'selected':''}>All</option><option value="active" ${camp.target==='active'?'selected':''}>Active only</option></select>
    </div>
    <div class="form-group"><label class="form-label">Schedule</label>
      <select class="form-input" id="cp-sched"><option value="0" ${!camp.schedule_enabled?'selected':''}>Manual only</option><option value="1" ${camp.schedule_enabled?'selected':''}>Auto-schedule</option></select>
    </div>
  </div>
  <div class="form-group"><label class="form-label">Interval (hours)</label><input class="form-input" id="cp-interval" type="number" value="${camp.interval_hours||24}"></div>
</div>
<div class="modal-footer"><button class="btn btn-primary" onclick="saveCampaign(${camp.id||'null'})">Save</button></div>`);

      window.saveCampaign = async function(id) {
        const msg = document.getElementById('cp-msg');
        const body = {
          title: document.getElementById('cp-title').value,
          subject: document.getElementById('cp-subject').value,
          message: document.getElementById('cp-msg-body').value,
          image_url: document.getElementById('cp-img').value,
          target: document.getElementById('cp-target').value,
          schedule_enabled: document.getElementById('cp-sched').value === '1' ? 1 : 0,
          interval_hours: parseInt(document.getElementById('cp-interval').value)||24,
          active: 1,
        };
        try {
          if (id) await api(`/autopost/${id}`, { method:'PUT', body: JSON.stringify(body) });
          else await api('/autopost', { method:'POST', body: JSON.stringify(body) });
          ov.remove(); views.autopost();
        } catch(e) { msg.innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
      };
    }

    window.toggleAutopost = async (val) => {
      try {
        await api('/autopost-settings', { method:'POST', body: JSON.stringify({ autopost_enabled: val }) });
        views.autopost();
      } catch(e) { showToast(e.message,'error'); }
    };

    window.openAutopostSettings = async () => {
      const s = await api('/autopost-settings');
      const ov = openModal(`
<div class="modal-header"><h3>⚙️ Auto-Post Schedule Settings</h3><button class="btn-icon" onclick="this.closest('.modal-overlay').remove()">✕</button></div>
<div class="modal-body">
  <div id="ap-set-msg"></div>
  <div class="form-group"><label class="form-label">Scheduler</label>
    <select class="form-input" id="ap-enabled">
      <option value="1" ${s.autopost_enabled==='1'?'selected':''}>Enabled</option>
      <option value="0" ${s.autopost_enabled!=='1'?'selected':''}>Disabled</option>
    </select>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
    <div class="form-group"><label class="form-label">Start Hour (IST, 0–23)</label>
      <input class="form-input" id="ap-start" type="number" min="0" max="23" value="${s.autopost_start_hour||'9'}">
    </div>
    <div class="form-group"><label class="form-label">End Hour (IST, 0–23)</label>
      <input class="form-input" id="ap-end" type="number" min="0" max="23" value="${s.autopost_end_hour||'22'}">
    </div>
  </div>
  <p class="muted" style="font-size:.82rem;margin-top:.25rem">Campaigns will only auto-send between these IST hours. Default: 9 AM – 10 PM.</p>
</div>
<div class="modal-footer"><button class="btn btn-primary" onclick="saveAutopostSettings()">Save</button></div>`);
      window.saveAutopostSettings = async () => {
        const msg = document.getElementById('ap-set-msg');
        try {
          await api('/autopost-settings', { method:'POST', body: JSON.stringify({
            autopost_enabled: document.getElementById('ap-enabled').value,
            autopost_start_hour: document.getElementById('ap-start').value,
            autopost_end_hour: document.getElementById('ap-end').value,
          })});
          ov.remove(); views.autopost();
        } catch(e) { msg.innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
      };
    };

    window.newCampaign = () => campaignModal({});
    window.editCampaign = async (id) => {
      const cs = await api('/autopost');
      const c = cs.find(x => x.id === id);
      if (c) campaignModal(c);
    };
    window.sendNow = async (id) => {
      const btn = event.target; btn.disabled=true; btn.textContent='Sending…';
      try {
        const r = await api(`/autopost/${id}/send-now`, { method:'POST', body:'{}' });
        showToast(`Sent to ${r.sent} customers`);
      } catch(e) { showToast(e.message,'error'); }
      finally { btn.disabled=false; btn.textContent='Send Now'; }
    };
    window.cloneCampaign = async (id) => {
      try {
        await api(`/autopost/${id}/clone`, { method:'POST' });
        showToast('Campaign cloned (inactive draft)');
        views.autopost();
      } catch(e) { showToast(e.message, 'error'); }
    };
    window.deleteCamp = async (id) => {
      if (!confirm('Delete this campaign?')) return;
      await api(`/autopost/${id}`, { method:'DELETE' });
      views.autopost();
    };
  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

// ── views.legal ────────────────────────────────────────────────────────────────
views.legal = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const pages = await api('/legal');
    let activeSlug = pages[0]?.slug || 'about';

    const renderEditor = async (slug) => {
      activeSlug = slug;
      const page = await api(`/legal/${slug}`);
      document.getElementById('legal-body').innerHTML = `
<div id="lp-msg"></div>
<div class="form-group"><label class="form-label">Title</label><input class="form-input" id="lp-title" value="${esc(page.title)}"></div>
<div class="form-group"><label class="form-label">Content (HTML)</label><textarea class="form-input" id="lp-body" rows="14" style="font-family:monospace">${esc(page.body||'')}</textarea></div>
<div style="display:flex;gap:.75rem;margin-top:.5rem">
  <button class="btn btn-primary" onclick="saveLegal('${slug}')">Save</button>
  <a href="/${slug}" target="_blank" class="btn btn-secondary">Preview →</a>
</div>`;
    };

    setMain(`
<h2 style="font-weight:800;margin-bottom:1.5rem">Legal Pages</h2>
<div style="display:grid;grid-template-columns:180px 1fr;gap:1.25rem;align-items:start">
  <div class="card" style="padding:.5rem">
    ${pages.map(p => `<button class="btn btn-secondary btn-block" id="lp-tab-${p.slug}" style="text-align:left;margin-bottom:.25rem" onclick="switchLegal('${p.slug}')">${esc(p.title)}</button>`).join('')}
  </div>
  <div class="card" id="legal-body"><div class="spinner"></div></div>
</div>`);

    window.switchLegal = async (slug) => {
      pages.forEach(p => { const el = document.getElementById('lp-tab-'+p.slug); if(el) el.style.background = p.slug===slug ? 'var(--border)' : ''; });
      await renderEditor(slug);
    };
    window.saveLegal = async (slug) => {
      const msg = document.getElementById('lp-msg');
      try {
        await api(`/legal/${slug}`, { method:'PUT', body: JSON.stringify({
          title: document.getElementById('lp-title').value,
          body: document.getElementById('lp-body').value,
        })});
        msg.innerHTML='<div class="alert alert-success">Saved!</div>';
        setTimeout(()=>msg.innerHTML='', 2000);
      } catch(e) { msg.innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
    };

    await renderEditor(activeSlug);
    const activeBtn = document.getElementById('lp-tab-'+activeSlug);
    if (activeBtn) activeBtn.style.background = 'var(--border)';
  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

// ── views.payments (UPI IMAP + USDT direct checkout) ──────────────────────────
views.payments = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const s = await api('/settings');
    const methods = await api('/payment-methods');
    const imapStatus = await api('/imap/status').catch(() => ({}));

    setMain(`
<h2 style="font-weight:800;margin-bottom:1.5rem">Payments & IMAP</h2>
<div style="max-width:760px;display:flex;flex-direction:column;gap:1.25rem">

<div class="card">
  <div style="font-weight:700;margin-bottom:.75rem">UPI Settings</div>
  <div id="upi-msg"></div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
    <div class="form-group"><label class="form-label">UPI ID</label><input class="form-input" id="upi-id" value="${esc(s.upi_id||'')}"></div>
    <div class="form-group"><label class="form-label">UPI Name</label><input class="form-input" id="upi-name" value="${esc(s.upi_name||'')}"></div>
  </div>
  <div class="form-group mt-2"><label class="form-label">UPI QR Image URL</label><input class="form-input" id="upi-qr" value="${esc(s.upi_qr_url||'')}"></div>
  <p class="muted" style="font-size:.8rem;margin-top:.5rem">UPI direct-checkout payments are auto-verified by reading the bank notification email via IMAP (configure below).</p>
  <div style="border-top:1px solid var(--border);margin:.85rem 0 .6rem;padding-top:.7rem;font-weight:700;font-size:.9rem">Unique payment amount</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
    <div class="form-group"><label class="form-label">Range (± whole ₹)</label><input class="form-input" id="upi-delta" type="number" min="1" max="50" value="${esc(s.upi_unique_max_delta||'6')}"></div>
    <div class="form-group"><label class="form-label">Direction</label>
      <select class="form-input" id="upi-dir">
        <option value="both" ${(s.upi_unique_direction||'both')==='both'?'selected':''}>Both ± (may pay slightly less)</option>
        <option value="up" ${s.upi_unique_direction==='up'?'selected':''}>Up only (never below price)</option>
      </select></div>
  </div>
  <p class="muted" style="font-size:.78rem;margin-top:.35rem">Each order gets a clean whole-rupee amount near the price (e.g. ₹200 → ₹197 or ₹203) so customers don't round it off. <b>Up only</b> never charges below the price.</p>
  <button class="btn btn-primary btn-sm mt-3" onclick="saveUpi()">Save UPI</button>
</div>

<div class="card">
  <div style="font-weight:700;margin-bottom:.5rem">IMAP Auto-Verify <span class="badge ${imapStatus.ok ? 'badge-green' : 'badge-grey'}">${imapStatus.ok ? 'Connected' : imapStatus.lastError ? 'Error' : 'Not tested'}</span></div>
  <p class="muted" style="font-size:.85rem;margin-bottom:.75rem">Configure Gmail IMAP to auto-verify UPI payments. Your bank sends payment confirmation emails — IMAP polls for them and auto-credits the customer's wallet.</p>
  <div id="imap-msg"></div>
  <label style="display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem"><input type="checkbox" id="imap-en" ${s.imap_enabled==='1'?'checked':''}> Enable IMAP Auto-Verify</label>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
    <div class="form-group"><label class="form-label">IMAP Email (Gmail)</label><input class="form-input" id="imap-email" value="${esc(s.imap_email||'')}"></div>
    <div class="form-group"><label class="form-label">App Password</label><input class="form-input" type="password" id="imap-pass" value="${esc(s.imap_password||'')}"></div>
    <div class="form-group"><label class="form-label">IMAP Host</label><input class="form-input" id="imap-host" value="${esc(s.imap_host||'imap.gmail.com')}"></div>
    <div class="form-group"><label class="form-label">Port</label><input class="form-input" id="imap-port" value="${esc(s.imap_port||'993')}"></div>
  </div>
  <div style="display:flex;gap:.75rem;margin-top:.75rem">
    <button class="btn btn-primary btn-sm" onclick="saveImap()">Save IMAP</button>
    <button class="btn btn-secondary btn-sm" onclick="testImap()">Test Connection</button>
  </div>
  ${imapStatus.lastRun ? `<p class="muted mt-2" style="font-size:.8rem">Last run: ${fmtDate(imapStatus.lastRun)} · Matched: ${imapStatus.matched||0}</p>` : ''}
  ${imapStatus.lastError ? `<p style="color:var(--red);font-size:.8rem;margin-top:.25rem">Error: ${esc(imapStatus.lastError)}</p>` : ''}
</div>

<div class="card">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem">
    <div style="font-weight:700">Payment Methods</div>
    <button class="btn btn-sm btn-primary" onclick="addPaymentMethod()">+ Add Method</button>
  </div>
  <div id="pm-list">
    ${methods.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Name</th><th>Type</th><th>Address</th><th>Status</th><th></th></tr></thead>
    <tbody>${methods.map(m=>`<tr>
      <td>${esc(m.name)}</td><td><span class="badge badge-blue">${esc(m.type)}</span></td>
      <td style="font-family:monospace;font-size:.8rem">${esc(m.address||'—')}</td>
      <td>${m.enabled ? '<span class="badge badge-green">On</span>' : '<span class="badge badge-grey">Off</span>'}</td>
      <td><button class="btn btn-sm btn-secondary" onclick="editPm(${m.id})">Edit</button> <button class="btn btn-sm btn-red" onclick="delPm(${m.id})">Del</button></td>
    </tr>`).join('')}</tbody></table></div>` : '<p class="muted">No custom payment methods yet.</p>'}
  </div>
</div>

<div class="card">
  <div style="font-weight:700;margin-bottom:.75rem">USDT — Conversion &amp; Fee</div>
  <div id="usdt-rate-msg"></div>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:.75rem">
    <div class="form-group"><label class="form-label">USDT → INR rate (₹ per $1)</label><input class="form-input" id="usdt-rate" type="number" step="0.01" min="1" value="${esc(s.usdt_inr_rate||'99')}"></div>
    <div class="form-group"><label class="form-label">USDT fee % (on top)</label><input class="form-input" id="usdt-fee" type="number" step="0.01" min="0" value="${esc(s.usdt_fee_pct||'1.5')}"></div>
    <div class="form-group"><label class="form-label">Payment window (min)</label><input class="form-input" id="usdt-window" type="number" min="5" max="120" value="${esc(s.usdt_payment_window_minutes||'20')}"></div>
  </div>
  <button class="btn btn-primary btn-sm mt-3" onclick="saveUsdtRate()">Save Rate &amp; Fee</button>
</div>

<div class="card">
  <div style="font-weight:700;margin-bottom:.75rem">USDT — Binance (Pay ID / UID)</div>
  <div id="usdt-binance-msg"></div>
  <label style="display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem"><input type="checkbox" id="ub-en" ${s.usdt_binance_enabled==='1'?'checked':''}> Enable Binance USDT</label>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
    <div class="form-group"><label class="form-label">Binance Pay ID / UID</label><input class="form-input" id="ub-uid" value="${esc(s.usdt_binance_uid||'')}" placeholder="123456789"></div>
    <div class="form-group"><label class="form-label">QR image URL (optional)</label><input class="form-input" id="ub-qr" value="${esc(s.usdt_binance_qr_url||'')}" placeholder="https://..."></div>
  </div>
  <p class="muted" style="font-size:.8rem;margin-top:.5rem">Auto-verified via the deposit-notification email from Binance (IMAP must be enabled).</p>
  <button class="btn btn-primary btn-sm mt-3" onclick="saveUsdtBinance()">Save Binance</button>
</div>

<div class="card">
  <div style="font-weight:700;margin-bottom:.75rem">USDT — BEP20 (BNB Smart Chain)</div>
  <div id="usdt-bep20-msg"></div>
  <label style="display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem"><input type="checkbox" id="ubep-en" ${s.usdt_bep20_enabled==='1'?'checked':''}> Enable USDT BEP20</label>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
    <div class="form-group"><label class="form-label">BEP20 wallet address</label><input class="form-input" id="ubep-addr" value="${esc(s.usdt_bep20_address||'')}" placeholder="0x..."></div>
    <div class="form-group"><label class="form-label">QR image URL (optional)</label><input class="form-input" id="ubep-qr" value="${esc(s.usdt_bep20_qr_url||'')}" placeholder="https://..."></div>
  </div>
  <button class="btn btn-primary btn-sm mt-3" onclick="saveUsdtBep20()">Save BEP20</button>
</div>

<div class="card">
  <div style="font-weight:700;margin-bottom:.75rem">USDT — TRC20 (Tron)</div>
  <div id="usdt-trc20-msg"></div>
  <label style="display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem"><input type="checkbox" id="utrc-en" ${s.usdt_trc20_enabled==='1'?'checked':''}> Enable USDT TRC20</label>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
    <div class="form-group"><label class="form-label">TRC20 wallet address</label><input class="form-input" id="utrc-addr" value="${esc(s.usdt_trc20_address||'')}" placeholder="T..."></div>
    <div class="form-group"><label class="form-label">QR image URL (optional)</label><input class="form-input" id="utrc-qr" value="${esc(s.usdt_trc20_qr_url||'')}" placeholder="https://..."></div>
  </div>
  <button class="btn btn-primary btn-sm mt-3" onclick="saveUsdtTrc20()">Save TRC20</button>
</div>

<div class="card">
  <div style="font-weight:700;margin-bottom:.75rem">Delivery Settings</div>
  <div class="form-group"><label class="form-label">Low Stock Alert Email</label><input class="form-input" id="stock-alert-email" value="${esc(s.stock_alert_email||'')}"></div>
  <div class="form-group mt-2"><label class="form-label">Alert when stock ≤</label><input class="form-input" id="stock-threshold" type="number" value="${s.stock_alert_threshold||5}" style="width:100px"></div>
  <div class="form-group mt-2"><label class="form-label">Renewal Reminder Days Before Expiry</label><input class="form-input" id="renewal-days" type="number" value="${s.renewal_reminder_days||3}" style="width:100px"></div>
  <div class="form-group mt-2"><label class="form-label">Referral Reward (₹)</label><input class="form-input" id="ref-reward" type="number" value="${s.referral_reward_inr||20}" style="width:100px"></div>
  <button class="btn btn-primary btn-sm mt-3" onclick="saveDelivery()">Save</button>
</div>
</div>`);

    window.saveUpi = async () => {
      const msg = document.getElementById('upi-msg');
      try {
        await api('/settings', { method:'POST', body: JSON.stringify({
          upi_id: document.getElementById('upi-id').value,
          upi_name: document.getElementById('upi-name').value,
          upi_qr_url: document.getElementById('upi-qr').value,
          upi_unique_max_delta: document.getElementById('upi-delta').value,
          upi_unique_direction: document.getElementById('upi-dir').value,
        })});
        msg.innerHTML='<div class="alert alert-success">Saved!</div>';
        setTimeout(()=>msg.innerHTML='',2000);
      } catch(e) { msg.innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
    };

    const _saveSettings = async (cardId, body) => {
      const msg = document.getElementById(cardId);
      try {
        await api('/settings', { method:'POST', body: JSON.stringify(body) });
        if (msg) { msg.innerHTML='<div class="alert alert-success">Saved!</div>'; setTimeout(()=>{ if(msg) msg.innerHTML=''; }, 2000); }
        else showToast('Saved!');
      } catch(e) { if (msg) msg.innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; else showToast(e.message,'error'); }
    };
    window.saveUsdtRate = () => _saveSettings('usdt-rate-msg', {
      usdt_inr_rate: document.getElementById('usdt-rate').value,
      usdt_fee_pct: document.getElementById('usdt-fee').value,
      usdt_payment_window_minutes: document.getElementById('usdt-window').value,
    });
    window.saveUsdtBinance = () => _saveSettings('usdt-binance-msg', {
      usdt_binance_enabled: document.getElementById('ub-en').checked ? '1' : '0',
      usdt_binance_uid: document.getElementById('ub-uid').value,
      usdt_binance_qr_url: document.getElementById('ub-qr').value,
    });
    window.saveUsdtBep20 = () => _saveSettings('usdt-bep20-msg', {
      usdt_bep20_enabled: document.getElementById('ubep-en').checked ? '1' : '0',
      usdt_bep20_address: document.getElementById('ubep-addr').value,
      usdt_bep20_qr_url: document.getElementById('ubep-qr').value,
    });
    window.saveUsdtTrc20 = () => _saveSettings('usdt-trc20-msg', {
      usdt_trc20_enabled: document.getElementById('utrc-en').checked ? '1' : '0',
      usdt_trc20_address: document.getElementById('utrc-addr').value,
      usdt_trc20_qr_url: document.getElementById('utrc-qr').value,
    });

    window.saveImap = async () => {
      const msg = document.getElementById('imap-msg');
      try {
        await api('/settings', { method:'POST', body: JSON.stringify({
          imap_enabled: document.getElementById('imap-en').checked ? '1' : '0',
          imap_email: document.getElementById('imap-email').value,
          imap_password: document.getElementById('imap-pass').value,
          imap_host: document.getElementById('imap-host').value,
          imap_port: document.getElementById('imap-port').value,
        })});
        msg.innerHTML='<div class="alert alert-success">Saved!</div>';
        setTimeout(()=>msg.innerHTML='',2000);
      } catch(e) { msg.innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
    };

    window.testImap = async () => {
      const msg = document.getElementById('imap-msg');
      msg.innerHTML='<div class="alert alert-info">Testing…</div>';
      try {
        const r = await api('/imap/test', { method:'POST', body: JSON.stringify({
          host: document.getElementById('imap-host').value,
          port: document.getElementById('imap-port').value,
          email: document.getElementById('imap-email').value,
          password: document.getElementById('imap-pass').value,
        })});
        msg.innerHTML = r.ok ? '<div class="alert alert-success">✓ IMAP connection successful!</div>' : `<div class="alert alert-error">✗ ${esc(r.error)}</div>`;
      } catch(e) { msg.innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
    };

    window.saveDelivery = async () => {
      await api('/settings', { method:'POST', body: JSON.stringify({
        stock_alert_email: document.getElementById('stock-alert-email').value,
        stock_alert_threshold: document.getElementById('stock-threshold').value,
        renewal_reminder_days: document.getElementById('renewal-days').value,
        referral_reward_inr: document.getElementById('ref-reward').value,
      })});
      showToast('Saved!');
    };

    const pmModal = (m) => {
      m = m || {};
      const ov = openModal(`
<div class="modal-header"><h3>${m.id ? 'Edit' : 'Add'} Payment Method</h3><button class="btn-icon" onclick="this.closest('.modal-overlay').remove()">✕</button></div>
<div class="modal-body">
  <div id="pm-msg"></div>
  <div class="form-group"><label class="form-label">Name</label><input class="form-input" id="pm-name" value="${esc(m.name||'')}"></div>
  <div class="form-group"><label class="form-label">Type</label>
    <select class="form-input" id="pm-type">
      <option value="upi_manual" ${m.type==='upi_manual'?'selected':''}>UPI Manual (screenshot)</option>
      <option value="upi_imap" ${m.type==='upi_imap'?'selected':''}>UPI IMAP (auto-verify)</option>
      <option value="binance" ${m.type==='binance'?'selected':''}>Binance Pay</option>
      <option value="crypto" ${m.type==='crypto'?'selected':''}>USDT/Crypto</option>
      <option value="custom" ${m.type==='custom'?'selected':''}>Custom / Bank Transfer</option>
    </select>
  </div>
  <div class="form-group"><label class="form-label">Address / UPI ID / Wallet</label><input class="form-input" id="pm-address" value="${esc(m.address||'')}"></div>
  <div class="form-group"><label class="form-label">Instructions</label><textarea class="form-input" id="pm-instr" rows="3">${esc(m.instructions||'')}</textarea></div>
  <div class="form-group"><label class="form-label">QR Image URL</label><input class="form-input" id="pm-qr" value="${esc(m.qr_url||'')}"></div>
  <label style="display:flex;align-items:center;gap:.5rem;margin-top:.5rem"><input type="checkbox" id="pm-enabled" ${m.enabled===0?'':'checked'}> Enabled</label>
</div>
<div class="modal-footer"><button class="btn btn-primary" onclick="savePm(${m.id||'null'})">Save</button></div>`);

      window.savePm = async (id) => {
        const msg = document.getElementById('pm-msg');
        const body = {
          name: document.getElementById('pm-name').value,
          type: document.getElementById('pm-type').value,
          address: document.getElementById('pm-address').value,
          instructions: document.getElementById('pm-instr').value,
          qr_url: document.getElementById('pm-qr').value,
          enabled: document.getElementById('pm-enabled').checked ? 1 : 0,
        };
        try {
          if (id) await api(`/payment-methods/${id}`, { method:'PUT', body: JSON.stringify(body) });
          else await api('/payment-methods', { method:'POST', body: JSON.stringify(body) });
          ov.remove(); views.payments();
        } catch(e) { msg.innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
      };
    };

    window.addPaymentMethod = () => pmModal(null);
    window.editPm = async (id) => {
      const ms = await api('/payment-methods');
      pmModal(ms.find(x=>x.id===id));
    };
    window.delPm = async (id) => {
      if (!confirm('Delete this payment method?')) return;
      await api(`/payment-methods/${id}`, { method:'DELETE' });
      views.payments();
    };
  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

// ── views['secure-session'] ───────────────────────────────────────────────────
views['secure-session'] = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const s = await api('/whatsapp/secure-session');
    const fmtBytes = (b) => b >= 1048576 ? (b/1048576).toFixed(1)+' MB' : b >= 1024 ? (b/1024).toFixed(0)+' KB' : (b||0)+' B';
    const fmtTime = (iso) => iso ? new Date(iso).toLocaleString() : '—';
    const volOk = s.volumeMount && s.dbPath && s.dbPath.indexOf(s.volumeMount) === 0;
    const chip = (t) => `<span style="background:var(--input-bg);padding:.12rem .55rem;border-radius:10px;font-size:.74rem">${esc(t)}</span>`;

    const snapRows = (s.snapshots||[]).map(sn => `
      <tr style="border-top:1px solid var(--border)">
        <td style="padding:.55rem .6rem;white-space:nowrap">${fmtTime(sn.created_at)}</td>
        <td style="padding:.55rem .6rem">${chip(sn.label||'manual')}</td>
        <td style="padding:.55rem .6rem;text-align:right">${sn.file_count||0}</td>
        <td style="padding:.55rem .6rem;text-align:right;color:var(--muted)">${fmtBytes(sn.size_bytes)}</td>
        <td style="padding:.55rem .6rem;text-align:right;white-space:nowrap">
          <button class="btn btn-sm btn-secondary" onclick="ssRestore(${sn.id})">↩ Restore</button>
          <button class="btn btn-sm btn-secondary" onclick="ssDeleteSnap(${sn.id})" style="color:#ef4444">🗑</button>
        </td>
      </tr>`).join('') || `<tr><td colspan="5" style="padding:.8rem;color:var(--muted)">No snapshots yet — they're taken automatically on connect, hourly, and before each deploy.</td></tr>`;

    setMain(`
<div style="max-width:920px;margin:0 auto">
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.25rem;flex-wrap:wrap;gap:.5rem">
  <h2 style="font-weight:800;margin:0">🔒 Secure Session</h2>
  <div style="display:flex;gap:.4rem">
    <button class="btn btn-sm btn-secondary" onclick="views['secure-session']()">↻ Refresh</button>
    <button class="btn btn-sm btn-primary" onclick="ssSnapshot()">📸 Snapshot now</button>
  </div>
</div>

<div class="card" style="margin-bottom:1rem;border-left:3px solid ${volOk?'#22c55e':'#f59e0b'}">
  <div style="font-weight:700">${volOk?'✅ DB looks persistent':'⚠️ DB persistence unconfirmed'}</div>
  <div style="font-size:.85rem;color:var(--muted);margin-top:.3rem">
    ${s.volumeMount ? `RAILWAY_VOLUME_MOUNT_PATH=<code>${esc(s.volumeMount)}</code> covers <code>${esc(s.dbPath||'')}</code>` : 'No Railway volume detected — mount a volume at /app/data so the session + snapshots survive redeploys.'}
  </div>
  <div style="font-size:.78rem;color:var(--muted);margin-top:.25rem">File: <code>${esc(s.dbPath||'')}</code> · ${fmtBytes(s.dbSizeBytes)} · mtime ${fmtTime(s.dbMtime)}</div>
</div>

<div class="card" style="margin-bottom:1rem">
  <div style="font-weight:700;margin-bottom:.4rem">🔑 At-rest encryption</div>
  ${s.encryptionOn ? `
    <div style="color:#22c55e;font-weight:600">✅ Encryption ON — snapshots are AES-256-GCM sealed (key fingerprint <code>${esc(s.keyFingerprint||'')}</code>).</div>
    <div style="font-size:.83rem;color:var(--muted);margin-top:.3rem">The key lives only in the Railway <code>WA_SESSION_KEY</code> env var, never in the DB. Keep a copy offsite — if you lose it AND the DB, the session is unrecoverable.</div>
  ` : `
    <div style="color:#f59e0b;font-weight:600">⚠️ Sessions are stored as plaintext. A DB leak = full WhatsApp impersonation.</div>
    <div style="font-size:.85rem;color:var(--muted);margin:.5rem 0">To enable encryption, set this env var on Railway, then redeploy:</div>
    <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
      <input class="form-input" id="ss-key" readonly value="WA_SESSION_KEY=${esc(s.suggestedKey||'')}" style="flex:1;min-width:300px;font-family:monospace;font-size:.8rem">
      <button class="btn btn-sm btn-secondary" onclick="ssCopyKey()">📋 Copy</button>
    </div>
    <div style="font-size:.78rem;color:var(--muted);margin-top:.4rem">Save this key OFFSITE (password manager). If you lose it AND the DB, the session is unrecoverable.</div>
  `}
</div>

<div class="card" style="margin-bottom:1rem">
  <div style="font-weight:700;margin-bottom:.6rem">📊 Live session</div>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1rem">
    <div><div style="font-size:.75rem;color:var(--muted)">Files</div><div style="font-size:1.4rem;font-weight:800">${s.liveFiles||0}</div></div>
    <div><div style="font-size:.75rem;color:var(--muted)">Last update</div><div style="font-weight:700">${fmtTime(s.lastUpdate)}</div></div>
    <div><div style="font-size:.75rem;color:var(--muted)">Snapshots</div><div style="font-size:1.4rem;font-weight:800">${s.snapshotCount||0}</div></div>
  </div>
</div>

<div class="card" style="margin-bottom:1rem">
  <div style="font-weight:700;margin-bottom:.4rem">💾 Offsite backup (encrypted)</div>
  <div style="font-size:.83rem;color:var(--muted);margin-bottom:.7rem">Bundle = the live session + every snapshot, packed into one AES-256-GCM blob. Useless without WA_SESSION_KEY. Recommended: download monthly, store in a different cloud.</div>
  <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
    <button class="btn btn-sm btn-secondary" onclick="ssDownloadBundle()">⬇ Download encrypted bundle</button>
    <input type="file" id="ss-bundle-file" accept=".enc" style="display:none" onchange="ssUploadBundle(this)">
    <button class="btn btn-sm btn-secondary" onclick="document.getElementById('ss-bundle-file').click()">⬆ Upload bundle (restore)</button>
    <label style="font-size:.83rem;display:flex;align-items:center;gap:.3rem"><input type="checkbox" id="ss-merge"> Merge instead of replace</label>
  </div>
</div>

<div class="card">
  <div style="font-weight:700;margin-bottom:.5rem">📸 Snapshots <span style="font-weight:400;color:var(--muted);font-size:.82rem">— auto-taken on connect, hourly, and before every shutdown (SIGTERM)</span></div>
  <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:.86rem">
      <thead><tr style="text-align:left;color:var(--muted);font-size:.72rem;letter-spacing:.05em">
        <th style="padding:.5rem .6rem">WHEN</th><th style="padding:.5rem .6rem">LABEL</th>
        <th style="padding:.5rem .6rem;text-align:right">FILES</th><th style="padding:.5rem .6rem;text-align:right">SIZE</th>
        <th style="padding:.5rem .6rem;text-align:right">ACTIONS</th>
      </tr></thead>
      <tbody>${snapRows}</tbody>
    </table>
  </div>
</div>
</div>`);

    window.ssCopyKey = () => { const i=document.getElementById('ss-key'); const k=i.value.replace(/^WA_SESSION_KEY=/,''); navigator.clipboard.writeText(k).then(()=>showToast('Key copied — paste into Railway → Variables')).catch(()=>{ i.select(); document.execCommand('copy'); showToast('Key copied'); }); };
    window.ssSnapshot = async () => { try { await api('/whatsapp/secure-session/snapshot', { method:'POST' }); showToast('Snapshot saved'); views['secure-session'](); } catch(e){ showToast(e.message,'error'); } };
    window.ssDeleteSnap = async (id) => { if(!confirm('Delete this snapshot?'))return; try { await api('/whatsapp/secure-session/snapshot/'+id, { method:'DELETE' }); showToast('Deleted'); views['secure-session'](); } catch(e){ showToast(e.message,'error'); } };
    window.ssRestore = async (id) => { if(!confirm('Restore this snapshot? The bot will stop, swap in these keys, and restart. Only restore if the bot is broken — a stale snapshot may itself trigger a re-pair.'))return; try { const r=await api('/whatsapp/secure-session/snapshot/'+id+'/restore', { method:'POST' }); showToast('Restored '+r.restored+' files — reconnecting…'); setTimeout(()=>views['secure-session'](), 5000); } catch(e){ showToast(e.message,'error'); } };
    window.ssDownloadBundle = async () => {
      try {
        showToast('Building encrypted bundle…');
        const res = await fetch('/admin/api/whatsapp/secure-session/bundle', { credentials:'include' });
        if(!res.ok) throw new Error('HTTP '+res.status);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href=url; a.download='ott24x7-wa-session-'+new Date().toISOString().slice(0,10)+'.enc'; document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
      } catch(e){ showToast(e.message,'error'); }
    };
    window.ssUploadBundle = async (input) => {
      const file = input.files[0]; if(!file) return;
      if(!confirm('Restore from this bundle? The bot will stop and load the session from the file.')) { input.value=''; return; }
      try {
        const text = await file.text();
        const merge = document.getElementById('ss-merge').checked ? '1' : '0';
        const res = await fetch('/admin/api/whatsapp/secure-session/bundle?merge='+merge, { method:'POST', credentials:'include', headers:{ 'X-CSRF-Token': getCsrfToken(), 'Content-Type':'text/plain' }, body: text });
        const j = await res.json().catch(()=>({}));
        if(!res.ok) throw new Error(j.error||('HTTP '+res.status));
        showToast('Restored '+j.restored+' files — reconnecting…'); setTimeout(()=>views['secure-session'](), 5000);
      } catch(e){ showToast(e.message,'error'); }
      input.value='';
    };
  } catch(e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

// ── views['wa-session'] ───────────────────────────────────────────────────────
views['wa-session'] = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const [status, sessionInfo] = await Promise.all([
      api('/whatsapp/status'),
      api('/whatsapp/session-info').catch(() => ({})),
    ]);

    const isConnected   = status.status === 'connected';
    const isWaitingQR   = status.status === 'waiting_qr';
    const isBaileys     = status.mode !== 'meta_cloud';
    const statusColor   = isConnected ? '#22c55e' : isWaitingQR ? '#f59e0b' : '#94a3b8';
    const statusLabel   = isConnected ? '✓ Connected' : isWaitingQR ? '⏳ Scan QR' : status.status === 'connecting' ? '⟳ Connecting…' : status.status === 'logged_out' ? '✗ Logged Out' : '● Disconnected';

    setMain(`
<div style="max-width:560px;margin:0 auto">
<span id="wa-session-active" hidden></span>
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.25rem">
  <h2 style="font-weight:800;margin:0">📱 WhatsApp Session</h2>
  <button class="btn btn-sm btn-secondary" onclick="views['wa-session']()">↻ Refresh</button>
</div>

<!-- Status card -->
<div class="card" style="margin-bottom:1rem">
  <div style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap">
    <div style="width:56px;height:56px;border-radius:50%;background:${statusColor}22;border:3px solid ${statusColor};display:flex;align-items:center;justify-content:center;font-size:1.5rem;flex-shrink:0">
      ${isConnected ? '✓' : isWaitingQR ? '📷' : '○'}
    </div>
    <div style="flex:1">
      <div style="font-size:1.1rem;font-weight:700;color:${statusColor}">${statusLabel}</div>
      ${status.number ? `<div style="font-size:.9rem;color:var(--muted);margin-top:.2rem">📱 +${esc(status.number)}</div>` : ''}
      ${isConnected ? `<div style="font-size:.8rem;color:var(--muted);margin-top:.2rem">Session secured — survives deploys ✓</div>` : ''}
    </div>
    <div style="display:flex;gap:.4rem;flex-wrap:wrap">
      ${!isConnected ? `<button class="btn btn-primary btn-sm" onclick="wsConnect()">⚡ Connect</button>` : ''}
      ${isConnected ? `<button class="btn btn-sm btn-secondary" onclick="wsReconnect()">↻ Reconnect</button>` : ''}
      ${isConnected ? `<button class="btn btn-sm btn-secondary" onclick="wsDisconnect()">⏸ Disconnect</button>` : ''}
    </div>
  </div>
</div>

<!-- QR Code (shown when waiting) -->
${isBaileys && isWaitingQR && status.qrDataUrl ? `
<div class="card" style="text-align:center;margin-bottom:1rem">
  <div style="font-weight:700;margin-bottom:.75rem;font-size:1rem">Scan with WhatsApp to connect</div>
  <img id="wa-qr-img" src="${status.qrDataUrl}" style="width:240px;height:240px;border:3px solid var(--border);border-radius:16px" alt="QR Code">
  <div style="margin-top:.75rem;font-size:.82rem;color:var(--muted)">Open WhatsApp → Linked Devices → Link a device → Scan this QR</div>
  <div style="margin-top:.5rem;font-size:.78rem;color:var(--muted)">🔄 Live — refreshes automatically. Just scan the code shown.</div>
  <button class="btn btn-sm btn-secondary" style="margin-top:.75rem" onclick="views['wa-session']()">🔄 Refresh QR</button>
</div>` : ''}

<!-- Not connected — show connect options -->
${isBaileys && !isConnected && !isWaitingQR ? `
<div class="card" style="margin-bottom:1rem">
  <div style="font-weight:700;margin-bottom:.75rem">Connect WhatsApp</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
    <div style="border:1px solid var(--border);border-radius:10px;padding:1rem;text-align:center;cursor:pointer" onclick="wsConnect()">
      <div style="font-size:2rem;margin-bottom:.4rem">📷</div>
      <div style="font-weight:600;font-size:.9rem">QR Code</div>
      <div style="font-size:.78rem;color:var(--muted);margin-top:.25rem">Scan with phone</div>
      <button class="btn btn-primary btn-sm" style="margin-top:.6rem;width:100%" onclick="wsConnect()">Generate QR</button>
    </div>
    <div style="border:1px solid var(--border);border-radius:10px;padding:1rem;text-align:center">
      <div style="font-size:2rem;margin-bottom:.4rem">🔢</div>
      <div style="font-weight:600;font-size:.9rem">Pairing Code</div>
      <div style="font-size:.78rem;color:var(--muted);margin-top:.25rem">Enter code on phone</div>
      <input class="form-input" id="ws-pair-phone" placeholder="+91XXXXXXXXXX" style="margin-top:.6rem;font-size:.82rem">
      <button class="btn btn-secondary btn-sm" style="margin-top:.4rem;width:100%" onclick="wsPairCode()">Get Code</button>
    </div>
  </div>
  <div id="ws-pair-result" style="margin-top:.75rem"></div>
</div>` : ''}

<!-- Pairing code input (when waiting for QR, offer alternative) -->
${isBaileys && isWaitingQR ? `
<div class="card" style="margin-bottom:1rem">
  <div style="font-weight:600;margin-bottom:.5rem;font-size:.9rem">Or use Pairing Code instead</div>
  <div style="display:flex;gap:.5rem">
    <input class="form-input" id="ws-pair-phone" placeholder="+91XXXXXXXXXX" style="flex:1">
    <button class="btn btn-secondary btn-sm" onclick="wsPairCode()">Get Code</button>
  </div>
  <div id="ws-pair-result" style="margin-top:.5rem"></div>
</div>` : ''}

<!-- Session info -->
<div class="card" style="margin-bottom:1rem">
  <div style="font-weight:700;margin-bottom:.75rem">Session Files</div>
  ${sessionInfo.exists ? `
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:.5rem;margin-bottom:.75rem">
    <div style="background:var(--input-bg);border-radius:8px;padding:.6rem;text-align:center">
      <div style="font-size:1.2rem;font-weight:700;color:var(--primary)">${sessionInfo.files}</div>
      <div style="font-size:.75rem;color:var(--muted)">Files</div>
    </div>
    <div style="background:var(--input-bg);border-radius:8px;padding:.6rem;text-align:center">
      <div style="font-size:1.2rem;font-weight:700;color:var(--primary)">${sessionInfo.sizeKB} KB</div>
      <div style="font-size:.75rem;color:var(--muted)">Size</div>
    </div>
    <div style="background:var(--input-bg);border-radius:8px;padding:.6rem;text-align:center">
      <div style="font-size:1rem;font-weight:700;color:#22c55e">✓</div>
      <div style="font-size:.75rem;color:var(--muted)">On Volume</div>
    </div>
  </div>
  <div style="font-size:.8rem;color:var(--muted)">Last saved: ${sessionInfo.modifiedAt ? fmtDate(sessionInfo.modifiedAt) : '—'}</div>
  <div style="font-size:.8rem;color:var(--muted);margin-top:.25rem">📁 Stored at <code>/app/data/wa-session/</code> (Railway persistent volume)</div>
  ` : `<div style="font-size:.85rem;color:var(--muted)">No session files found. Connect WhatsApp to create a session.</div>`}
  <div style="border-top:1px solid var(--border);margin-top:.75rem;padding-top:.75rem;font-size:.82rem;color:var(--muted)">
    ℹ️ Session files are stored on the Railway volume and <strong>survive code deploys and restarts</strong>.
    You only need to re-scan QR if you manually clear the session or WhatsApp logs out the device.
  </div>
</div>

<!-- Danger zone -->
<div class="card" style="border-color:#ef4444;margin-bottom:1rem">
  <div style="font-weight:700;margin-bottom:.75rem;color:#ef4444">⚠ Danger Zone</div>
  <div style="display:flex;gap:.75rem;flex-wrap:wrap">
    <div style="flex:1;min-width:200px">
      <div style="font-weight:600;font-size:.85rem;margin-bottom:.25rem">Disconnect Socket</div>
      <div style="font-size:.78rem;color:var(--muted);margin-bottom:.4rem">Closes the WA connection. Session stays valid — reconnect without QR.</div>
      <button class="btn btn-sm btn-secondary" onclick="wsDisconnect()">⏸ Disconnect</button>
    </div>
    <div style="flex:1;min-width:200px">
      <div style="font-weight:600;font-size:.85rem;margin-bottom:.25rem">Logout from WhatsApp</div>
      <div style="font-size:.78rem;color:var(--muted);margin-bottom:.4rem">Sends logout to WA servers + clears session. Requires new QR scan.</div>
      <button class="btn btn-sm btn-red" onclick="wsLogout()">✗ Logout</button>
    </div>
    <div style="flex:1;min-width:200px">
      <div style="font-weight:600;font-size:.85rem;margin-bottom:.25rem">Clear Session Files</div>
      <div style="font-size:.78rem;color:var(--muted);margin-bottom:.4rem">Deletes local session files only. Requires new QR scan to reconnect.</div>
      <button class="btn btn-sm btn-red" onclick="wsClearSession()">🗑 Clear Session</button>
    </div>
  </div>
</div>

</div>`);

    if (isWaitingQR) {
      setTimeout(() => views['wa-session'](), 20000);
    }
    if (status.status === 'connecting') {
      setTimeout(() => views['wa-session'](), 4000);
    }

    window.wsConnect = async () => {
      try { await api('/whatsapp/connect', { method:'POST' }); showToast('Connecting…'); setTimeout(() => views['wa-session'](), 3000); }
      catch(e) { showToast(e.message, 'error'); }
    };
    window.wsDisconnect = async () => {
      if (!confirm('Disconnect the socket? Session stays valid, reconnect is instant.')) return;
      try { await api('/whatsapp/disconnect', { method:'POST' }); showToast('Disconnected'); views['wa-session'](); }
      catch(e) { showToast(e.message, 'error'); }
    };
    window.wsReconnect = async () => {
      try { await api('/whatsapp/reconnect', { method:'POST' }); showToast('Reconnecting…'); setTimeout(() => views['wa-session'](), 3000); }
      catch(e) { showToast(e.message, 'error'); }
    };
    window.wsLogout = async () => {
      if (!confirm('This will LOGOUT from WhatsApp — you will need to scan QR again. Continue?')) return;
      try { await api('/whatsapp/logout', { method:'POST' }); showToast('Logged out from WhatsApp'); views['wa-session'](); }
      catch(e) { showToast(e.message, 'error'); }
    };
    window.wsClearSession = async () => {
      if (!confirm('Delete local session files? You will need to scan QR again to reconnect.')) return;
      try { await api('/whatsapp/clear-session', { method:'POST' }); showToast('Session cleared'); views['wa-session'](); }
      catch(e) { showToast(e.message, 'error'); }
    };
    window.wsPairCode = async () => {
      const phone = document.getElementById('ws-pair-phone')?.value?.trim();
      if (!phone) return showToast('Enter phone number with country code', 'error');
      const el = document.getElementById('ws-pair-result');
      if (el) el.innerHTML = '<div class="spinner"></div>';
      try {
        if (status.status !== 'waiting_qr') await api('/whatsapp/connect', { method:'POST' });
        await new Promise(r => setTimeout(r, 1500));
        const r = await api('/whatsapp/pairing-code', { method:'POST', body: JSON.stringify({ phone }) });
        if (el) el.innerHTML = `<div class="alert alert-success">Your pairing code: <strong style="font-size:1.2rem;letter-spacing:.1em">${esc(r.code)}</strong><br><span style="font-size:.8rem">Enter this in WhatsApp → Linked Devices → Link with phone number</span></div>`;
      } catch(e) { if (el) el.innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
    };

    // ── Live QR / status auto-refresh ─────────────────────────────────────────
    // The bot regenerates the QR every ~20s (and on any reconnect), so a STATIC
    // image goes stale and scanning it does nothing. Poll status, swap the QR in
    // place, and re-render on any state change. Stops when the user leaves the
    // view (the #wa-session-active marker disappears).
    clearInterval(window._waQrTimer);
    window._waQrTimer = setInterval(async () => {
      if (!document.getElementById('wa-session-active')) { clearInterval(window._waQrTimer); return; }
      try {
        const s = await api('/whatsapp/status');
        if (s.status !== status.status) { clearInterval(window._waQrTimer); return views['wa-session'](); }
        const img = document.getElementById('wa-qr-img');
        if (img && s.qrDataUrl && img.getAttribute('src') !== s.qrDataUrl) img.setAttribute('src', s.qrDataUrl);
      } catch {}
    }, 8000);
  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

// ── views.whatsapp ────────────────────────────────────────────────────────────
views.whatsapp = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const [status, settings] = await Promise.all([
      api('/whatsapp/status'),
      api('/whatsapp/settings'),
    ]);

    const modeLabel = status.mode === 'meta_cloud' ? 'Meta Cloud API' : 'Baileys (QR/Pairing)';
    const statusColor = status.status === 'connected' ? 'badge-green' : status.status === 'waiting_qr' ? 'badge-yellow' : 'badge-grey';

    setMain(`
<h2 style="font-weight:800;margin-bottom:1.5rem">WhatsApp Bot</h2>
<div style="max-width:780px;display:flex;flex-direction:column;gap:1.25rem">

<div class="card">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem">
    <div>
      <div style="font-weight:700;margin-bottom:.25rem">Connection Status</div>
      <span class="badge ${statusColor}">${esc(status.status)}</span>
      <span class="badge badge-blue" style="margin-left:.4rem">${esc(modeLabel)}</span>
      ${status.number ? `<span class="muted" style="margin-left:.5rem;font-size:.85rem">📱 ${esc(status.number)}</span>` : ''}
    </div>
    <div style="display:flex;gap:.5rem;flex-wrap:wrap">
      <button class="btn btn-sm btn-primary" onclick="waConnect()">Connect</button>
      <button class="btn btn-sm btn-secondary" onclick="waReconnect()">Reconnect</button>
      <button class="btn btn-sm btn-secondary" onclick="waDisconnect()">Disconnect</button>
      <button class="btn btn-sm btn-red" onclick="waClearSession()">Clear Session</button>
    </div>
  </div>
  ${status.hasQR && status.qrDataUrl ? `
  <div style="text-align:center;margin:1rem 0">
    <p style="font-weight:600;margin-bottom:.5rem">Scan QR Code with WhatsApp</p>
    <img src="${status.qrDataUrl}" style="width:220px;height:220px;border:4px solid var(--border);border-radius:12px" alt="QR Code">
    <p class="muted mt-2" style="font-size:.8rem">QR refreshes automatically. Click Connect if it doesn't appear.</p>
    <button class="btn btn-sm btn-secondary mt-2" onclick="refreshWaStatus()">🔄 Refresh QR</button>
  </div>` : ''}
  ${status.mode === 'baileys' && status.status !== 'connected' && status.status !== 'waiting_qr' ? `
  <div style="margin-top:.75rem">
    <div style="font-weight:600;margin-bottom:.5rem">Or use Pairing Code (no QR needed)</div>
    <div style="display:flex;gap:.5rem">
      <input class="form-input" id="wa-pair-phone" placeholder="+91XXXXXXXXXX (with country code)" style="flex:1;max-width:280px">
      <button class="btn btn-primary btn-sm" onclick="waPairCode()">Get Code</button>
    </div>
    <div id="wa-pair-result" style="margin-top:.5rem"></div>
  </div>` : ''}
</div>

<div class="card">
  <div style="font-weight:700;margin-bottom:.75rem">Bot Settings</div>
  <div id="wa-settings-msg"></div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
    <div class="form-group">
      <label class="form-label">Transport Mode</label>
      <select class="form-input" id="wa-transport">
        <option value="baileys" ${settings.wa_transport==='baileys'?'selected':''}>Baileys (QR / Pairing Code)</option>
        <option value="meta_cloud" ${settings.wa_transport==='meta_cloud'?'selected':''}>Meta Cloud API</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Bot Auto-Reply</label>
      <select class="form-input" id="wa-autoreply">
        <option value="1" ${settings.wa_autoreply_enabled!=='0'?'selected':''}>Enabled</option>
        <option value="0" ${settings.wa_autoreply_enabled==='0'?'selected':''}>Disabled (manual replies only)</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Owner WhatsApp Number</label>
      <input class="form-input" id="wa-owner-num" value="${esc(settings.wa_owner_number||'')}" placeholder="919876543210">
    </div>
    <div class="form-group">
      <label class="form-label">Owner WhatsApp LID (if applicable)</label>
      <input class="form-input" id="wa-owner-lid" value="${esc(settings.wa_owner_lid||'')}" placeholder="LID (leave blank if not needed)">
    </div>
  </div>
  <label style="display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem"><input type="checkbox" id="wa-enabled" ${settings.wa_enabled==='1'?'checked':''}> Start WhatsApp bot automatically on server startup</label>
  <label style="display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem"><input type="checkbox" id="wa-daily" ${settings.wa_daily_summary!=='0'?'checked':''}> Send daily revenue summary at 9 PM IST</label>
  <label style="display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem"><input type="checkbox" id="wa-ai-reply" ${settings.wa_ai_reply_enabled!=='0'?'checked':''}> 🤖 AI auto-reply to customer messages (uses same AI + catalog as website chat bot)</label>
  <button class="btn btn-primary btn-sm mt-2" onclick="saveWaSettings()">Save Settings</button>
</div>

<div class="card" id="meta-card" style="${settings.wa_transport==='meta_cloud'?'':'display:none'}">
  <div style="font-weight:700;margin-bottom:.75rem">Meta Cloud API Credentials</div>
  <div id="meta-msg"></div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
    <div class="form-group"><label class="form-label">Phone Number ID</label><input class="form-input" id="meta-pid" value="${esc(settings.wa_meta_phone_number_id||'')}"></div>
    <div class="form-group"><label class="form-label">Access Token</label><input class="form-input" type="password" id="meta-tok" value="${esc(settings.wa_meta_access_token||'')}"></div>
    <div class="form-group"><label class="form-label">WABA ID</label><input class="form-input" id="meta-waba" value="${esc(settings.wa_meta_waba_id||'')}"></div>
    <div class="form-group"><label class="form-label">App Secret</label><input class="form-input" type="password" id="meta-secret" value="${esc(settings.wa_meta_app_secret||'')}"></div>
    <div class="form-group"><label class="form-label">Webhook Verify Token</label><input class="form-input" id="meta-verify" value="${esc(settings.wa_meta_webhook_verify_token||'')}"></div>
  </div>
  <div style="display:flex;gap:.5rem;margin-top:.75rem">
    <button class="btn btn-primary btn-sm" onclick="saveMetaCreds()">Save Credentials</button>
    <button class="btn btn-secondary btn-sm" onclick="testMeta()">Test Connection</button>
  </div>
</div>

<div class="card">
  <div style="font-weight:700;margin-bottom:.75rem">WA Broadcast</div>
  <p class="muted" style="font-size:.85rem;margin-bottom:.75rem">Send a WhatsApp message to all customers who have a phone number. (Different from email broadcast)</p>
  <div id="wa-bc-msg"></div>
  <textarea class="form-input" id="wa-bc-text" rows="3" placeholder="Your message here... Use *bold* for WhatsApp formatting"></textarea>
  <button class="btn btn-primary btn-sm mt-2" onclick="sendWaBroadcast()">Send WA Broadcast</button>
</div>

</div>`);

    document.getElementById('wa-transport').addEventListener('change', function() {
      document.getElementById('meta-card').style.display = this.value === 'meta_cloud' ? '' : 'none';
    });

    let statusPoll;
    function refreshWaStatus() { clearInterval(statusPoll); views.whatsapp(); }
    window.refreshWaStatus = refreshWaStatus;
    // Auto-refresh QR every 20s when waiting
    if (status.status === 'waiting_qr') {
      statusPoll = setInterval(refreshWaStatus, 20000);
    }

    window.waConnect = async () => {
      try { await api('/whatsapp/connect', { method:'POST' }); showToast('Connecting…'); setTimeout(refreshWaStatus, 3000); }
      catch(e) { showToast(e.message, 'error'); }
    };
    window.waDisconnect = async () => {
      if (!confirm('Disconnect WhatsApp bot?')) return;
      await api('/whatsapp/disconnect', { method:'POST' }); refreshWaStatus();
    };
    window.waReconnect = async () => {
      await api('/whatsapp/reconnect', { method:'POST' }); showToast('Reconnecting…'); setTimeout(refreshWaStatus, 3000);
    };
    window.waClearSession = async () => {
      if (!confirm('This will delete the WA session and require re-scanning QR. Continue?')) return;
      await api('/whatsapp/clear-session', { method:'POST' }); refreshWaStatus();
    };
    window.waPairCode = async () => {
      const phone = document.getElementById('wa-pair-phone').value.trim();
      const el = document.getElementById('wa-pair-result');
      try {
        const r = await api('/whatsapp/pairing-code', { method:'POST', body: JSON.stringify({ phone }) });
        el.innerHTML = `<div class="alert alert-success">Your pairing code: <strong>${esc(r.code)}</strong> — enter this in WhatsApp → Linked Devices → Link a Device → Link with phone number</div>`;
      } catch(e) { el.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`; }
    };

    window.saveWaSettings = async () => {
      const msg = document.getElementById('wa-settings-msg');
      try {
        await api('/whatsapp/settings', { method:'POST', body: JSON.stringify({
          wa_enabled: document.getElementById('wa-enabled').checked ? '1' : '0',
          wa_transport: document.getElementById('wa-transport').value,
          wa_owner_number: document.getElementById('wa-owner-num').value,
          wa_owner_lid: document.getElementById('wa-owner-lid').value,
          wa_autoreply_enabled: document.getElementById('wa-autoreply').value,
          wa_daily_summary: document.getElementById('wa-daily').checked ? '1' : '0',
          wa_ai_reply_enabled: document.getElementById('wa-ai-reply').checked ? '1' : '0',
        })});
        msg.innerHTML='<div class="alert alert-success">Saved!</div>';
        setTimeout(()=>msg.innerHTML='',2000);
      } catch(e) { msg.innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
    };

    window.saveMetaCreds = async () => {
      const msg = document.getElementById('meta-msg');
      try {
        await api('/whatsapp/settings', { method:'POST', body: JSON.stringify({
          wa_meta_phone_number_id: document.getElementById('meta-pid').value,
          wa_meta_access_token: document.getElementById('meta-tok').value,
          wa_meta_waba_id: document.getElementById('meta-waba').value,
          wa_meta_app_secret: document.getElementById('meta-secret').value,
          wa_meta_webhook_verify_token: document.getElementById('meta-verify').value,
        })});
        msg.innerHTML='<div class="alert alert-success">Saved!</div>';
        setTimeout(()=>msg.innerHTML='',2000);
      } catch(e) { msg.innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
    };

    window.testMeta = async () => {
      const msg = document.getElementById('meta-msg');
      msg.innerHTML='<div class="alert alert-info">Testing…</div>';
      try {
        const r = await api('/whatsapp/test-meta', { method:'POST', body: JSON.stringify({
          phoneNumberId: document.getElementById('meta-pid').value,
          accessToken: document.getElementById('meta-tok').value,
        })});
        msg.innerHTML = r.ok
          ? `<div class="alert alert-success">✓ Connected — ${esc(r.name || '')} (${esc(r.phone || '')})</div>`
          : `<div class="alert alert-error">✗ ${esc(r.error)}</div>`;
      } catch(e) { msg.innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
    };

    window.sendWaBroadcast = async () => {
      const msg = document.getElementById('wa-bc-msg');
      const text = document.getElementById('wa-bc-text').value.trim();
      if (!text) { msg.innerHTML='<div class="alert alert-error">Enter a message</div>'; return; }
      if (!confirm(`Send WA broadcast to all customers?`)) return;
      msg.innerHTML='<div class="alert alert-info">Sending…</div>';
      try {
        const r = await api('/whatsapp/broadcast', { method:'POST', body: JSON.stringify({ message: text }) });
        msg.innerHTML=`<div class="alert alert-success">Sent: ${r.sent}, Failed: ${r.failed}</div>`;
      } catch(e) { msg.innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
    };

  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

// Build WA offers from selected products — auto-generates a marketing message + Buy link.
window.fromProducts = async function () {
  const ov = openModal(`
<div class="modal-header"><h3>🛍️ Add offers from Products</h3><button class="btn-icon" onclick="this.closest('.modal-overlay').remove()">✕</button></div>
<div class="modal-body">
  <p class="muted" style="font-size:.85rem;margin-bottom:.5rem">Pick products — each becomes a ready-to-post WhatsApp offer with a marketing message + your live Buy link, added active to the rotation.</p>
  <div style="display:flex;gap:.5rem;align-items:center;margin-bottom:.6rem;flex-wrap:wrap">
    <input class="form-input" id="fp-search" style="flex:1;min-width:140px" placeholder="Filter products..." oninput="fpFilter(this.value)">
    <button class="btn btn-sm btn-secondary" onclick="fpSelectAll(true)">All</button>
    <button class="btn btn-sm btn-secondary" onclick="fpSelectAll(false)">None</button>
  </div>
  <div id="fp-msg"></div>
  <div id="fp-list"><div class="spinner"></div></div>
</div>
<div class="modal-footer">
  <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
  <button class="btn btn-primary" id="fp-add-btn">+ Add selected</button>
</div>`);
  try {
    const d = await api('/wa-offers/products');
    const products = (d && d.products) || [];
    const list = document.getElementById('fp-list');
    if (!products.length) { list.innerHTML = '<p class="muted">No active products found.</p>'; return; }
    list.innerHTML = `<div style="display:flex;flex-direction:column;gap:.35rem;max-height:50vh;overflow-y:auto">
      ${products.map(p => `<label data-name="${esc(((p.platform || '') + ' ' + (p.name || '') + ' ' + (p.category || '')).toLowerCase())}" style="display:flex;align-items:center;gap:.55rem;padding:.45rem .55rem;border:1px solid var(--border,#334155);border-radius:8px;cursor:pointer">
        <input type="checkbox" class="fp-cb" value="${p.id}">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:.86rem">${esc(p.platform || '')} ${esc(p.name || '')} ${p.provider_api === 'bot' ? '<span class="badge badge-blue" style="font-size:.6rem">🤖 bot</span>' : ''}</div>
          <div class="muted" style="font-size:.76rem">₹${p.price_inr}${Number(p.original_price_inr) > Number(p.price_inr) ? ` · was ₹${p.original_price_inr}` : ''}${p.category ? ` · ${esc(p.category)}` : ''}</div>
        </div>
      </label>`).join('')}
    </div>`;
    document.getElementById('fp-add-btn').onclick = async () => {
      const ids = Array.from(document.querySelectorAll('.fp-cb:checked')).map(cb => Number(cb.value));
      if (!ids.length) { document.getElementById('fp-msg').innerHTML = '<div class="alert alert-error">Select at least one product.</div>'; return; }
      try {
        const r = await api('/wa-offers/from-products', { method: 'POST', body: JSON.stringify({ plan_ids: ids }) });
        showToast(`Added ${r.added} offer(s) ✅`); ov.remove(); views['wa-offers']();
      } catch (e) { document.getElementById('fp-msg').innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`; }
    };
  } catch (e) { const l = document.getElementById('fp-list'); if (l) l.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`; }
};
window.fpFilter = (q) => { q = (q || '').toLowerCase(); document.querySelectorAll('#fp-list label[data-name]').forEach(l => { l.style.display = l.dataset.name.includes(q) ? '' : 'none'; }); };
window.fpSelectAll = (on) => document.querySelectorAll('.fp-cb').forEach(cb => { if (cb.closest('label').style.display !== 'none') cb.checked = on; });

// ── views['wa-offers'] ────────────────────────────────────────────────────────
views['wa-offers'] = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const [offers, settings] = await Promise.all([
      api('/wa-offers'),
      api('/whatsapp/settings'),
    ]);

    const groupsStr = settings.wa_autopost_groups || '[]';

    // Upcoming posting order — mirrors wa-worker.js next-pick: active offers,
    // never-posted first, then oldest last_posted_at, then id.
    const _waQueue = offers.filter(o => o.active).slice().sort((a, b) => {
      const an = a.last_posted_at == null, bn = b.last_posted_at == null;
      if (an !== bn) return an ? -1 : 1;
      if (!an) { const at = new Date(a.last_posted_at).getTime(), bt = new Date(b.last_posted_at).getTime(); if (at !== bt) return at - bt; }
      return (a.id || 0) - (b.id || 0);
    });
    const _waUpcomingHtml = _waQueue.length ? `<div style="background:#161b22;border:1px solid var(--border,#30363d);border-radius:10px;padding:.75rem .9rem;margin-bottom:.85rem">
      <div style="font-size:.78rem;font-weight:700;color:var(--muted,#8b949e);margin-bottom:.5rem">🔜 Upcoming posting order — ${_waQueue.length} active, cycles in this order</div>
      ${_waQueue.slice(0, 6).map((o, i) => `<div style="display:flex;align-items:center;gap:.55rem;font-size:.82rem;padding:.18rem 0">
        <span style="flex:0 0 auto;min-width:46px;text-align:center;font-weight:700;font-size:.62rem;padding:.18rem .5rem;border-radius:20px;${i === 0 ? 'background:#16a34a;color:#fff' : 'background:#1e293b;color:var(--muted,#8b949e)'}">${i === 0 ? 'NEXT' : '#' + (i + 1)}</span>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;color:${i === 0 ? '#ffffff;font-weight:600' : '#c9d1d9'}">${esc((o.text || '').replace(/\s+/g, ' ').slice(0, 90))}</span>
      </div>`).join('')}
      ${_waQueue.length > 6 ? `<div style="font-size:.72rem;color:var(--muted,#8b949e);padding:.25rem 0 0 52px">+ ${_waQueue.length - 6} more in rotation…</div>` : ''}
    </div>` : '';
    const _waBulkBar = offers.length ? `<div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.6rem">
      <span id="waof-bulk-count" style="font-size:.8rem;color:var(--muted,#8b949e);min-width:70px">0 selected</span>
      <button class="btn btn-sm btn-secondary" onclick="waBulkActive(1)">▶ Activate</button>
      <button class="btn btn-sm btn-secondary" onclick="waBulkActive(0)">⏸ Pause</button>
      <button class="btn btn-sm btn-secondary" onclick="waBulkEdit()">✏️ Edit Content</button>
      <button class="btn btn-sm btn-secondary" onclick="waBulkReplace()">🔁 Find &amp; Replace…</button>
      <button class="btn btn-sm btn-danger" onclick="waBulkDelete()">🗑 Delete</button>
    </div>` : '';

    setMain(`
<h2 style="font-weight:800;margin-bottom:1.5rem">WA Group Offers</h2>
<div style="max-width:780px;display:flex;flex-direction:column;gap:1.25rem">

<div class="card">
  <div style="font-weight:700;margin-bottom:.75rem">Autopost Schedule</div>
  <div id="waop-msg"></div>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:.75rem">
    <div class="form-group"><label class="form-label">Interval (min)</label><input class="form-input" id="waop-interval" type="number" value="${esc(settings.wa_autopost_interval||'45')}" style="width:100px"></div>
    <div class="form-group"><label class="form-label">Start (IST hour)</label><input class="form-input" id="waop-start" type="number" value="${esc(settings.wa_autopost_start||'9')}" min="0" max="23" style="width:80px"></div>
    <div class="form-group"><label class="form-label">End (IST hour)</label><input class="form-input" id="waop-end" type="number" value="${esc(settings.wa_autopost_end||'23')}" min="0" max="23" style="width:80px"></div>
  </div>
  <label style="display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem"><input type="checkbox" id="waop-enabled" ${settings.wa_autopost_enabled==='1'?'checked':''}> Enable WA Group Autopost</label>
  <div class="form-group" style="margin-bottom:.75rem">
    <label class="form-label">Selected Groups (JSON array of group JIDs)</label>
    <textarea class="form-input" id="waop-groups" rows="2" style="font-family:monospace;font-size:.8rem">${esc(groupsStr)}</textarea>
    <p class="muted mt-1" style="font-size:.8rem">Go to Admin → WA Bot → Connect, then use the groups list below. Paste the JID array here.</p>
  </div>
  <div style="display:flex;gap:.5rem">
    <button class="btn btn-primary btn-sm" onclick="saveWaOpSettings()">Save Schedule</button>
    <button class="btn btn-secondary btn-sm" onclick="loadWaGroups()">Fetch Groups →</button>
  </div>
  <div id="waop-groups-list" style="margin-top:.75rem"></div>
</div>

<div class="card">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem">
    <div style="font-weight:700">Scheduled Offers (${offers.length})</div>
    <div style="display:flex;gap:.5rem">
      <button class="btn btn-sm btn-secondary" onclick="fromProducts()">🛍️ From Products</button>
      <button class="btn btn-sm btn-secondary" onclick="fromAutopost()">+ From AutoPost</button>
      <button class="btn btn-sm btn-primary" onclick="addWaOffer()">+ New Offer</button>
    </div>
  </div>
  <div id="waof-list">
  ${_waUpcomingHtml}${_waBulkBar}${offers.length ? `<div class="table-wrap"><table>
    <thead><tr><th style="width:30px;text-align:center"><input type="checkbox" id="waof-check-all" onclick="waToggleAll(this)" title="Select all"></th><th style="width:32px">#</th><th style="width:56px">Image</th><th>Post</th><th style="width:90px">Sent</th><th style="width:100px">Last Sent</th><th style="width:70px">Status</th><th style="width:120px">Actions</th></tr></thead>
    <tbody>${offers.map((o,i)=>`<tr>
      <td style="text-align:center"><input type="checkbox" class="waof-chk" value="${o.id}" onclick="waUpdateBulk()"></td>
      <td class="muted" style="font-size:.82rem">${i+1}</td>
      <td>${o.has_image
        ? `<img src="/admin/api/wa-offers/${o.id}/image" style="width:44px;height:44px;object-fit:cover;border-radius:6px;display:block">`
        : `<div style="width:44px;height:44px;border-radius:6px;background:#1e293b;display:flex;align-items:center;justify-content:center;font-size:1.2rem">📷</div>`}</td>
      <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.85rem">${esc(o.text)}</td>
      <td style="font-size:.82rem;text-align:center">${o.times_sent || 0}</td>
      <td style="font-size:.78rem">${o.last_posted_at ? fmtDateShort(o.last_posted_at) : '—'}</td>
      <td>${o.active ? '<span class="badge badge-green">Active</span>' : '<span class="badge badge-grey">Paused</span>'}</td>
      <td style="white-space:nowrap">
        <button title="Post Now" onclick="postNow(${o.id})" style="background:#16a34a;color:#fff;border:none;border-radius:5px;padding:5px 7px;cursor:pointer;font-size:.85rem">▶</button>
        <button title="Edit" onclick="editWaOffer(${o.id})" style="background:#d97706;color:#fff;border:none;border-radius:5px;padding:5px 7px;cursor:pointer;font-size:.85rem">✏️</button>
        <button title="Clone" onclick="cloneWaOffer(${o.id})" style="background:#0ea5e9;color:#fff;border:none;border-radius:5px;padding:5px 7px;cursor:pointer;font-size:.85rem">⧉</button>
        <button title="Delete" onclick="delWaOffer(${o.id})" style="background:#dc2626;color:#fff;border:none;border-radius:5px;padding:5px 7px;cursor:pointer;font-size:.85rem">🗑</button>
      </td>
    </tr>`).join('')}</tbody>
  </table></div>` : '<p class="muted">No offers yet. Add one above.</p>'}
  </div>
</div>

</div>`);

    window.saveWaOpSettings = async () => {
      const msg = document.getElementById('waop-msg');
      try {
        await api('/whatsapp/settings', { method:'POST', body: JSON.stringify({
          wa_autopost_enabled: document.getElementById('waop-enabled').checked ? '1' : '0',
          wa_autopost_interval: document.getElementById('waop-interval').value,
          wa_autopost_start: document.getElementById('waop-start').value,
          wa_autopost_end: document.getElementById('waop-end').value,
          wa_autopost_groups: document.getElementById('waop-groups').value,
        })});
        msg.innerHTML='<div class="alert alert-success">Saved!</div>';
        setTimeout(()=>msg.innerHTML='',2000);
      } catch(e) { msg.innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
    };

    window.loadWaGroups = async () => {
      const el = document.getElementById('waop-groups-list');
      el.innerHTML = '<div class="spinner"></div>';
      try {
        const groups = await api('/whatsapp/groups');
        if (!groups.length) { el.innerHTML = '<p class="muted">No groups found. Make sure WA bot is connected and the bot account is in some WhatsApp groups.</p>'; return; }
        el.innerHTML = `<div style="font-weight:600;margin-bottom:.5rem">Select groups to post to:</div>
        <div style="display:flex;flex-direction:column;gap:.4rem;max-height:200px;overflow-y:auto">
          ${groups.map(g=>`<label style="display:flex;align-items:center;gap:.5rem">
            <input type="checkbox" class="wa-group-cb" data-id="${esc(g.id)}" value="${esc(g.id)}">
            ${esc(g.name)} <span class="muted">(${g.participants} members)</span>
          </label>`).join('')}
        </div>
        <button class="btn btn-sm btn-secondary mt-2" onclick="applyGroupSelection()">Apply Selection</button>`;
        // Check already-selected groups
        const sel = JSON.parse(document.getElementById('waop-groups').value || '[]');
        document.querySelectorAll('.wa-group-cb').forEach(cb => { if (sel.includes(cb.value)) cb.checked = true; });
        window.applyGroupSelection = () => {
          const checked = [...document.querySelectorAll('.wa-group-cb:checked')].map(cb=>cb.value);
          document.getElementById('waop-groups').value = JSON.stringify(checked);
          showToast('Groups selected — click Save Schedule to save');
        };
      } catch(e) { el.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`; }
    };

    const offerModal = (o) => {
      o = o || {};
      const ov = openModal(`
<div class="modal-header"><h3>${o.id ? 'Edit' : 'New'} WA Offer</h3><button class="btn-icon" onclick="this.closest('.modal-overlay').remove()">✕</button></div>
<div class="modal-body">
  <div id="waof-msg"></div>
  <div class="form-group"><label class="form-label">Message Text (WhatsApp formatting: *bold*, _italic_)</label>
    <textarea class="form-input" id="waof-text" rows="5" placeholder="🔥 Hot offer! Get Netflix 4K for ₹199...\n\n📱 DM to order!">${esc(o.text||'')}</textarea>
  </div>
  <div class="form-group"><label class="form-label">Image (base64, optional)</label>
    <input type="file" accept="image/*" id="waof-img-file" onchange="readWaImg(this)">
    ${o.has_image ? '<p class="muted mt-1" style="font-size:.8rem">✓ Image attached. Upload new file to replace.</p>' : ''}
    <input type="hidden" id="waof-img-b64">
  </div>
  <label style="display:flex;align-items:center;gap:.5rem;margin-top:.5rem"><input type="checkbox" id="waof-active" ${o.active !== 0?'checked':''}> Active</label>
</div>
<div class="modal-footer"><button class="btn btn-primary" onclick="saveWaOffer(${o.id||'null'})">Save</button></div>`);

      // Downscale + compress the chosen image to a WhatsApp-friendly JPEG before
      // base64-encoding it. Phone photos are 2-5MB and the raw base64 blows past
      // the JSON body limit, so the upload silently failed; resizing keeps it to
      // a couple hundred KB and works every time.
      window.readWaImg = (inp) => {
        const file = inp.files[0];
        if (!file) return;
        const out = document.getElementById('waof-img-b64');
        const reader = new FileReader();
        reader.onload = (e) => {
          const img = new Image();
          img.onload = () => {
            const MAX = 1600;
            let w = img.width, h = img.height;
            if (Math.max(w, h) > MAX) { const sc = MAX / Math.max(w, h); w = Math.round(w * sc); h = Math.round(h * sc); }
            const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
            cv.getContext('2d').drawImage(img, 0, 0, w, h);
            const dataUrl = cv.toDataURL('image/jpeg', 0.82);
            out.value = dataUrl.split(',')[1];
            let prev = document.getElementById('waof-img-prev');
            if (!prev) { prev = document.createElement('div'); prev.id = 'waof-img-prev'; prev.style.cssText = 'margin-top:.5rem;font-size:.8rem;color:#16a34a'; inp.parentNode.appendChild(prev); }
            const kb = Math.round((out.value.length * 3 / 4) / 1024);
            prev.innerHTML = `<img src="${dataUrl}" style="width:64px;height:64px;object-fit:cover;border-radius:6px;display:block;margin-bottom:.25rem">✓ Image ready — ${w}×${h}, ~${kb} KB`;
          };
          img.onerror = () => { out.value = e.target.result.split(',')[1]; };
          img.src = e.target.result;
        };
        reader.readAsDataURL(file);
      };

      window.saveWaOffer = async (id) => {
        const msg = document.getElementById('waof-msg');
        const body = {
          text: document.getElementById('waof-text').value.trim(),
          active: document.getElementById('waof-active').checked ? 1 : 0,
        };
        const img = document.getElementById('waof-img-b64').value;
        if (img) body.image_b64 = img;
        if (!body.text) { msg.innerHTML='<div class="alert alert-error">Text required</div>'; return; }
        try {
          if (id) await api(`/wa-offers/${id}`, { method:'PUT', body: JSON.stringify(body) });
          else await api('/wa-offers', { method:'POST', body: JSON.stringify(body) });
          ov.remove(); views['wa-offers']();
        } catch(e) { msg.innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
      };
    };

    window.addWaOffer = () => offerModal(null);

    // ── Bulk actions over selected WA offers (reuse the per-offer endpoints) ──
    const waSelectedIds = () => [...document.querySelectorAll('.waof-chk:checked')].map(el => Number(el.value));
    window.waToggleAll = (cb) => { document.querySelectorAll('.waof-chk').forEach(el => { el.checked = cb.checked; }); window.waUpdateBulk(); };
    window.waUpdateBulk = () => {
      const n = waSelectedIds().length;
      const c = document.getElementById('waof-bulk-count'); if (c) c.textContent = n + ' selected';
      const all = document.getElementById('waof-check-all'); const total = document.querySelectorAll('.waof-chk').length;
      if (all) all.checked = n > 0 && n === total;
    };
    window.waBulkActive = async (active) => {
      const ids = waSelectedIds(); if (!ids.length) return showToast('Select offers first');
      for (const id of ids) { const o = offers.find(x => x.id === id); if (!o) continue; try { await api('/wa-offers/' + id, { method: 'PUT', body: JSON.stringify({ text: o.text, active }) }); } catch (e) {} }
      showToast((active ? 'Activated ' : 'Paused ') + ids.length + ' offer' + (ids.length > 1 ? 's' : '')); views['wa-offers']();
    };
    window.waBulkEdit = () => {
      const ids = waSelectedIds(); if (!ids.length) return showToast('Select offers first');
      const sel = ids.map(id => offers.find(x => x.id === id)).filter(Boolean);
      const ov = openModal(`
<div class="modal-header"><h3>✏️ Edit ${sel.length} Post${sel.length > 1 ? 's' : ''}</h3><button class="btn-icon" data-close>✕</button></div>
<div class="modal-body" style="max-height:70vh;overflow-y:auto">
  <div id="wabe-msg"></div>
  <p class="muted" style="font-size:.8rem;margin-bottom:.75rem">Edit the text of each selected post, then Save All. Unchanged posts are skipped.</p>
  ${sel.map(o => `<div class="form-group" style="margin-bottom:1rem">
    <label class="form-label" style="font-size:.78rem">#${o.id} ${o.active ? '· <span style="color:#16a34a">Active</span>' : '· <span class="muted">Paused</span>'}</label>
    <textarea class="form-input wabe-text" data-id="${o.id}" rows="4">${esc(o.text || '')}</textarea>
  </div>`).join('')}
</div>
<div class="modal-footer" style="gap:.5rem">
  <button class="btn btn-secondary" data-close>Cancel</button>
  <button class="btn btn-primary" id="wabe-save">💾 Save All</button>
</div>`);
      document.getElementById('wabe-save').onclick = async () => {
        const msg = document.getElementById('wabe-msg');
        const btn = document.getElementById('wabe-save');
        btn.disabled = true;
        msg.innerHTML = '<div class="alert">Saving…</div>';
        let saved = 0, failed = 0;
        for (const ta of document.querySelectorAll('.wabe-text')) {
          const id = Number(ta.dataset.id);
          const o = offers.find(x => x.id === id);
          if (!o || ta.value === o.text) continue; // skip unchanged
          try { await api('/wa-offers/' + id, { method: 'PUT', body: JSON.stringify({ text: ta.value, active: o.active }) }); saved++; }
          catch (e) { failed++; }
        }
        ov.remove();
        showToast(`Saved ${saved} post${saved !== 1 ? 's' : ''}${failed ? `, ${failed} failed` : ''}`);
        views['wa-offers']();
      };
    };
    window.waBulkDelete = async () => {
      const ids = waSelectedIds(); if (!ids.length) return showToast('Select offers first');
      if (!confirm('Delete ' + ids.length + ' selected offer' + (ids.length > 1 ? 's' : '') + '? This cannot be undone.')) return;
      for (const id of ids) { try { await api('/wa-offers/' + id, { method: 'DELETE' }); } catch (e) {} }
      showToast('Deleted ' + ids.length + ' offer' + (ids.length > 1 ? 's' : '')); views['wa-offers']();
    };
    window.waBulkReplace = async () => {
      const ids = waSelectedIds(); if (!ids.length) return showToast('Select offers first');
      const find = prompt('Find this text across the ' + ids.length + ' selected offer' + (ids.length > 1 ? 's' : '') + ':');
      if (!find) return;
      const repl = prompt('Replace "' + find + '" with (leave blank to remove it):', '');
      if (repl === null) return;
      let changed = 0;
      for (const id of ids) { const o = offers.find(x => x.id === id); if (!o || !o.text || o.text.indexOf(find) < 0) continue; try { await api('/wa-offers/' + id, { method: 'PUT', body: JSON.stringify({ text: o.text.split(find).join(repl), active: o.active }) }); changed++; } catch (e) {} }
      showToast(changed + ' offer' + (changed === 1 ? '' : 's') + ' updated'); views['wa-offers']();
    };
    window.editWaOffer = async (id) => {
      const o = await api(`/wa-offers/${id}`);
      offerModal(o);
    };
    window.delWaOffer = async (id) => {
      if (!confirm('Delete this offer?')) return;
      await api(`/wa-offers/${id}`, { method:'DELETE' });
      views['wa-offers']();
    };
    window.cloneWaOffer = async (id) => {
      try {
        await api(`/wa-offers/${id}/clone`, { method:'POST' });
        showToast('Offer cloned (inactive draft)');
        views['wa-offers']();
      } catch(e) { showToast(e.message, 'error'); }
    };
    window.fromAutopost = async () => {
      const ov = openModal(`
<div class="modal-header"><h3>Import from AutoPost Campaign</h3><button class="btn-icon" onclick="this.closest('.modal-overlay').remove()">✕</button></div>
<div class="modal-body">
  <p class="muted" style="font-size:.85rem;margin-bottom:1rem">Select a campaign to import as a WA offer (saved as inactive draft). The message text and image will be copied.</p>
  <div id="ap-pick-msg"></div>
  <div id="ap-pick-list"><div class="spinner"></div></div>
</div>`);
      try {
        const camps = await api('/autopost');
        const list = document.getElementById('ap-pick-list');
        if (!camps.length) { list.innerHTML = '<p class="muted">No autopost campaigns found.</p>'; return; }
        list.innerHTML = `<div style="display:flex;flex-direction:column;gap:.5rem;max-height:400px;overflow-y:auto">
          ${camps.map(c => `<div style="display:flex;align-items:flex-start;gap:.75rem;padding:.6rem;border:1px solid #334155;border-radius:8px">
            ${c.image_url ? `<img src="${esc(c.image_url)}" style="width:44px;height:44px;object-fit:cover;border-radius:6px;flex-shrink:0" onerror="this.style.display='none'">` : `<div style="width:44px;height:44px;background:#1e293b;border-radius:6px;flex-shrink:0;display:flex;align-items:center;justify-content:center">📷</div>`}
            <div style="flex:1;min-width:0">
              <div style="font-weight:600;font-size:.88rem;margin-bottom:.2rem">${esc(c.title)}</div>
              <div style="font-size:.78rem;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.message)}</div>
            </div>
            <button onclick="importAutopostCamp(${c.id}, this)" style="background:#16a34a;color:#fff;border:none;border-radius:6px;padding:5px 12px;cursor:pointer;font-size:.82rem;flex-shrink:0">Import</button>
          </div>`).join('')}
        </div>`;
        window.importAutopostCamp = async (campId, btn) => {
          btn.disabled = true; btn.textContent = '…';
          try {
            await api(`/wa-offers/from-autopost/${campId}`, { method:'POST' });
            showToast('Imported as inactive WA offer');
            ov.remove(); views['wa-offers']();
          } catch(e) { btn.disabled=false; btn.textContent='Import'; document.getElementById('ap-pick-msg').innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
        };
      } catch(e) { document.getElementById('ap-pick-list').innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
    };
    window.postNow = async (id) => {
      try {
        const r = await api(`/wa-offers/${id}/post-now`, { method:'POST' });
        showToast(`Posted to ${r.sent}/${r.total} groups`);
        views['wa-offers']();
      } catch(e) { showToast(e.message, 'error'); }
    };

  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

// ── views.suppliers ───────────────────────────────────────────────────────────
views.suppliers = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const [suppliers, plans] = await Promise.all([
      api('/suppliers'),
      api('/plans'),
    ]);

    const planMap = {};
    plans.forEach(p => { planMap[p.id] = `${p.platform} — ${p.name}`; });

    setMain(`
<h2 style="font-weight:800;margin-bottom:1.5rem">Suppliers</h2>
<div class="card" style="max-width:780px">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem">
    <div style="font-weight:700">Suppliers (${suppliers.length})</div>
    <button class="btn btn-sm btn-primary" onclick="addSupplier()">+ Add Supplier</button>
  </div>
  <p class="muted" style="font-size:.85rem;margin-bottom:1rem">Suppliers receive WhatsApp notifications when stock is low. You can also send them messages directly.</p>
  ${suppliers.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Name</th><th>Phone</th><th>Products</th><th>Active</th><th></th></tr></thead>
    <tbody id="sup-rows">${suppliers.map(s=>{
      const prods = JSON.parse(s.product_ids||'[]').map(pid=>planMap[pid]||'Plan #'+pid).join(', ') || '—';
      return `<tr>
        <td style="font-weight:600">${esc(s.name)}</td>
        <td style="font-family:monospace">${esc(s.phone)}</td>
        <td style="font-size:.85rem">${esc(prods)}</td>
        <td>${s.active?'<span class="badge badge-green">Yes</span>':'<span class="badge badge-grey">No</span>'}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-sm btn-primary" onclick="notifySupplier(${s.id},'${esc(s.name)}')">💬 WA</button>
          <button class="btn btn-sm btn-secondary" onclick="editSupplier(${s.id})">Edit</button>
          <button class="btn btn-sm btn-red" onclick="delSupplier(${s.id})">Del</button>
        </td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>` : '<p class="muted">No suppliers yet.</p>'}
</div>`);

    const supModal = (s, allPlans) => {
      s = s || {};
      const sel = JSON.parse(s.product_ids||'[]');
      const ov = openModal(`
<div class="modal-header"><h3>${s.id?'Edit':'Add'} Supplier</h3><button class="btn-icon" onclick="this.closest('.modal-overlay').remove()">✕</button></div>
<div class="modal-body">
  <div id="sup-msg"></div>
  <div class="form-group"><label class="form-label">Name</label><input class="form-input" id="sup-name" value="${esc(s.name||'')}"></div>
  <div class="form-group"><label class="form-label">Phone (with country code)</label><input class="form-input" id="sup-phone" value="${esc(s.phone||'')}" placeholder="919876543210"></div>
  <div class="form-group"><label class="form-label">Assigned Plans (for low-stock notifications)</label>
    <div style="max-height:150px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:.5rem;display:flex;flex-direction:column;gap:.3rem">
      ${allPlans.map(p=>`<label style="display:flex;align-items:center;gap:.5rem;font-size:.85rem"><input type="checkbox" class="sup-plan-cb" value="${p.id}" ${sel.includes(p.id)?'checked':''}> ${esc(p.platform)} — ${esc(p.name)}</label>`).join('')}
    </div>
  </div>
  <div class="form-group"><label class="form-label">Notes</label><textarea class="form-input" id="sup-notes" rows="2">${esc(s.notes||'')}</textarea></div>
  <label style="display:flex;align-items:center;gap:.5rem;margin-top:.5rem"><input type="checkbox" id="sup-active" ${s.active!==0?'checked':''}> Active</label>
</div>
<div class="modal-footer"><button class="btn btn-primary" onclick="saveSupplier(${s.id||'null'})">Save</button></div>`);

      window.saveSupplier = async (id) => {
        const msg = document.getElementById('sup-msg');
        const product_ids = [...document.querySelectorAll('.sup-plan-cb:checked')].map(cb=>parseInt(cb.value));
        const body = {
          name: document.getElementById('sup-name').value.trim(),
          phone: document.getElementById('sup-phone').value.trim().replace(/\D/g,''),
          notes: document.getElementById('sup-notes').value,
          active: document.getElementById('sup-active').checked ? 1 : 0,
          product_ids,
        };
        if (!body.name || !body.phone) { msg.innerHTML='<div class="alert alert-error">Name and phone required</div>'; return; }
        try {
          if (id) await api(`/suppliers/${id}`, { method:'PUT', body: JSON.stringify(body) });
          else await api('/suppliers', { method:'POST', body: JSON.stringify(body) });
          ov.remove(); views.suppliers();
        } catch(e) { msg.innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
      };
    };

    window.addSupplier = () => supModal(null, plans);
    window.editSupplier = async (id) => {
      const s = suppliers.find(x=>x.id===id);
      supModal(s, plans);
    };
    window.delSupplier = async (id) => {
      if (!confirm('Delete supplier?')) return;
      await api(`/suppliers/${id}`, { method:'DELETE' });
      views.suppliers();
    };
    window.notifySupplier = async (id, name) => {
      const msg = prompt(`Send WhatsApp message to ${name}:`);
      if (!msg) return;
      try {
        const r = await api(`/suppliers/${id}/notify`, { method:'POST', body: JSON.stringify({ message: msg }) });
        showToast(r.ok ? 'Message sent!' : 'Failed to send');
      } catch(e) { showToast(e.message, 'error'); }
    };

  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

// ── views['contact-team'] ─────────────────────────────────────────────────────
views['contact-team'] = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const { team } = await api('/contact-team');

    function renderTeam(list) {
      if (!list.length) return `<p class="muted" style="padding:.5rem 0">No contacts added yet. Add your first contact below.</p>`;
      return `<table class="data-table" style="margin-bottom:0">
        <thead><tr><th style="width:2rem">#</th><th>Name</th><th>Role</th><th>Phone (with country code)</th><th>WhatsApp Link</th><th style="width:6rem">Actions</th></tr></thead>
        <tbody id="team-tbody">
        ${list.map((c, i) => `<tr>
          <td class="muted">${i+1}</td>
          <td>${esc(c.name)}</td>
          <td><span style="background:var(--border);padding:.15rem .5rem;border-radius:4px;font-size:.78rem">${esc(c.role)}</span></td>
          <td><code>+${esc(c.phone)}</code></td>
          <td><a href="https://wa.me/${esc(c.phone)}" target="_blank" style="color:var(--accent);font-size:.83rem">wa.me/${esc(c.phone)}</a></td>
          <td style="display:flex;gap:.4rem">
            <button class="btn btn-xs btn-secondary" onclick="editContact(${i})">✏️</button>
            <button class="btn btn-xs btn-red" onclick="deleteContact(${i})">✕</button>
          </td>
        </tr>`).join('')}
        </tbody></table>`;
    }

    setMain(`
<h2 style="font-weight:800;margin-bottom:1.5rem">👥 Support Team</h2>
<div style="max-width:760px;display:flex;flex-direction:column;gap:1.25rem">

<div class="card" style="border-left:3px solid #10b981">
  <div style="font-weight:700;margin-bottom:.4rem">Human Help Contacts</div>
  <p class="muted" style="font-size:.84rem;margin-bottom:0">These numbers are shared by the AI chatbot (website &amp; WhatsApp) when a customer asks to speak with a human, needs help, or has a complaint. The bot sends clickable <code>wa.me/...</code> links directly in the chat.</p>
</div>

<div class="card">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.9rem">
    <div style="font-weight:700">Team Contacts</div>
    <button class="btn btn-sm btn-primary" onclick="openAddContact()">+ Add Contact</button>
  </div>
  <div id="team-msg"></div>
  <div id="team-list">${renderTeam(team)}</div>
</div>

<div class="card" style="border-left:3px solid #f59e0b">
  <div style="font-weight:700;margin-bottom:.5rem">How it works</div>
  <ul style="font-size:.84rem;color:var(--muted);margin:0;padding-left:1.2rem;line-height:1.8">
    <li>When a customer types "talk to human", "need help", "contact support" etc., the AI shares these contacts</li>
    <li>Phone numbers must include country code — e.g. <code>919876543210</code> for India (+91)</li>
    <li>You can add Owner, Sales, Manager, or any custom role</li>
    <li>Order matters — the bot lists them in the order shown here</li>
    <li>Changes take effect immediately (no restart needed)</li>
  </ul>
</div>

</div>`);

    let _team = JSON.parse(JSON.stringify(team));

    async function saveTeam() {
      const msg = document.getElementById('team-msg');
      try {
        const r = await api('/contact-team', { method:'POST', body: JSON.stringify({ team: _team }) });
        _team = r.team;
        document.getElementById('team-list').innerHTML = renderTeam(_team);
        msg.innerHTML = '<div class="alert alert-success" style="padding:.4rem .75rem;margin-bottom:.5rem">Saved!</div>';
        setTimeout(() => msg.innerHTML = '', 2500);
      } catch(e) {
        msg.innerHTML = `<div class="alert alert-error" style="padding:.4rem .75rem;margin-bottom:.5rem">${esc(e.message)}</div>`;
      }
    }

    window.deleteContact = async (idx) => {
      if (!confirm(`Remove ${_team[idx]?.name || 'this contact'}?`)) return;
      _team.splice(idx, 1);
      await saveTeam();
    };

    window.editContact = (idx) => {
      const c = _team[idx];
      openContactModal(c, async (updated) => {
        _team[idx] = updated;
        await saveTeam();
      });
    };

    window.openAddContact = () => {
      openContactModal(null, async (newc) => {
        _team.push(newc);
        await saveTeam();
      });
    };

    function openContactModal(existing, onSave) {
      const isEdit = !!existing;
      const ov = document.createElement('div');
      ov.className = 'modal-overlay';
      ov.innerHTML = `
<div class="modal" style="max-width:420px">
  <div style="font-weight:700;font-size:1.1rem;margin-bottom:1rem">${isEdit ? '✏️ Edit Contact' : '+ Add Contact'}</div>
  <div class="form-group">
    <label class="form-label">Name <span class="muted" style="font-size:.8rem">(person's name, optional)</span></label>
    <input class="form-input" id="ct-name" value="${esc(existing?.name||'')}" placeholder="e.g. Rahul, Owner, Sales Team">
  </div>
  <div class="form-group">
    <label class="form-label">Role</label>
    <select class="form-input" id="ct-role">
      ${['Owner','Sales','Manager','Support','Tech Support','Customer Care'].map(r =>
        `<option value="${r}" ${(existing?.role||'Support')===r?'selected':''}>${r}</option>`
      ).join('')}
      <option value="_custom" ${!['Owner','Sales','Manager','Support','Tech Support','Customer Care'].includes(existing?.role) && existing?.role ? 'selected' : ''}>Custom…</option>
    </select>
    <input class="form-input" id="ct-role-custom" style="margin-top:.4rem;display:${!['Owner','Sales','Manager','Support','Tech Support','Customer Care'].includes(existing?.role) && existing?.role ? 'block':'none'}" value="${esc(!['Owner','Sales','Manager','Support','Tech Support','Customer Care'].includes(existing?.role) ? (existing?.role||'') : '')}" placeholder="Custom role name">
  </div>
  <div class="form-group">
    <label class="form-label">Phone Number <span style="color:var(--red)">*</span></label>
    <input class="form-input" id="ct-phone" value="${esc(existing?.phone||'')}" placeholder="919876543210 (with country code, no +)">
    <p class="muted" style="font-size:.78rem;margin-top:.25rem">India: 91XXXXXXXXXX &nbsp;|&nbsp; UAE: 971XXXXXXXXX &nbsp;|&nbsp; US: 1XXXXXXXXXX</p>
  </div>
  <div id="ct-modal-err" style="margin-bottom:.5rem"></div>
  <div style="display:flex;gap:.75rem;justify-content:flex-end">
    <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
    <button class="btn btn-primary" onclick="ctSave()">Save Contact</button>
  </div>
</div>`;
      document.body.appendChild(ov);

      document.getElementById('ct-role').addEventListener('change', function() {
        document.getElementById('ct-role-custom').style.display = this.value === '_custom' ? 'block' : 'none';
      });

      window.ctSave = async () => {
        const name  = document.getElementById('ct-name').value.trim();
        const roleEl = document.getElementById('ct-role');
        const role  = roleEl.value === '_custom' ? document.getElementById('ct-role-custom').value.trim() : roleEl.value;
        const phone = document.getElementById('ct-phone').value.replace(/\D/g,'');
        const err   = document.getElementById('ct-modal-err');
        if (!role) { err.innerHTML = '<div class="alert alert-error" style="padding:.3rem .6rem">Role is required</div>'; return; }
        if (phone.length < 7) { err.innerHTML = '<div class="alert alert-error" style="padding:.3rem .6rem">Enter a valid phone number with country code</div>'; return; }
        ov.remove();
        await onSave({ name, role, phone });
      };
    }

  } catch(e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

// ── views['ai-agent'] ─────────────────────────────────────────────────────────
views['ai-agent'] = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const s = await api('/ai-settings');

    setMain(`
<h2 style="font-weight:800;margin-bottom:1.5rem">AI Agent Settings</h2>
<div class="card" style="max-width:680px">
  <div id="ai-msg"></div>
  <p class="muted" style="font-size:.85rem;margin-bottom:.75rem">
    Powers AI replies on WhatsApp <b>and</b> the website chat. Use an OpenAI-compatible provider —
    <b>Token Club</b> (recommended), OpenRouter, OpenAI, or a custom endpoint. Saving here wires the
    AI on automatically.
  </p>
  ${s._active_channel
    ? `<div class="alert alert-success" style="font-size:.82rem">✅ AI is live — channel <b>${esc(s._active_channel.url)}</b> · model <b>${esc(s._active_channel.model||'')}</b></div>`
    : `<div class="alert" style="font-size:.82rem;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412">⚠️ No active AI channel yet — pick a provider, paste your API key, and Save to switch the AI on.</div>`}
  <label style="display:flex;align-items:center;gap:.5rem;margin:.75rem 0 1rem"><input type="checkbox" id="ai-enabled" ${s.ai_enabled==='1'?'checked':''}> Enable AI Auto-Reply on WhatsApp</label>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
    <div class="form-group">
      <label class="form-label">Provider</label>
      <select class="form-input" id="ai-provider">
        <option value="tokenclub" ${(!['openrouter','openai','custom'].includes(s.ai_provider))?'selected':''}>Token Club (recommended)</option>
        <option value="openrouter" ${s.ai_provider==='openrouter'?'selected':''}>OpenRouter</option>
        <option value="openai" ${s.ai_provider==='openai'?'selected':''}>OpenAI</option>
        <option value="custom" ${s.ai_provider==='custom'?'selected':''}>Custom (OpenAI-compatible)</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Model</label>
      <select class="form-input" id="ai-model-preset" style="margin-bottom:.4rem">
        <option value="gpt-5.4-mini">gpt-5.4-mini — $0.75 / $4.5 per 1M · cheapest ✅</option>
        <option value="gpt-5.5">gpt-5.5 — $5 / $30 per 1M</option>
        <option value="gpt-5.5-openai-compact">gpt-5.5-openai-compact — $5 / $30 per 1M</option>
        <option value="__custom">Custom / other…</option>
      </select>
      <input class="form-input" id="ai-model" value="${esc(s.ai_model||'')}" placeholder="gpt-5.4-mini">
    </div>
    <div class="form-group">
      <label class="form-label">API Key</label>
      <input class="form-input" type="password" id="ai-key" value="${esc(s.ai_api_key||'')}" placeholder="Your provider API key (sk-...)">
    </div>
    <div class="form-group">
      <label class="form-label">Daily Message Cap</label>
      <input class="form-input" type="number" id="ai-cap" value="${esc(s.ai_daily_cap||'500')}" style="width:100px">
    </div>
  </div>

  <div class="form-group mt-2">
    <label class="form-label">Base URL <span class="muted">(provider endpoint, without /v1)</span></label>
    <input class="form-input" id="ai-base" value="${esc(s.ai_base_url||'')}" placeholder="https://s1.tokenclub.top">
    <p class="muted mt-1" style="font-size:.8rem">Leave blank for Token Club's default (<code>s1.tokenclub.top</code>). Required only for "Custom".</p>
  </div>

  <div class="form-group mt-2">
    <label class="form-label">Custom Persona / System Prompt</label>
    <textarea class="form-input" id="ai-persona" rows="5" placeholder="You are a helpful sales assistant for [Store Name]. You help customers with OTT subscription queries...">${esc(s.ai_persona||'')}</textarea>
    <p class="muted mt-1" style="font-size:.8rem">Leave blank to use the default product-aware persona. The AI automatically knows your plans and prices.</p>
  </div>

  <div class="form-group mt-2">
    <label class="form-label">📦 Order Playbook — delivery rules the AI follows</label>
    <textarea class="form-input" id="ai-playbook" rows="5" placeholder="e.g. Deliver in-stock orders instantly; otherwise promise within 30 min and notify admin. If a customer says the login doesn't work, escalate. Refunds only within 24h. Be warm and use Hinglish for Hindi customers.">${esc(s.ai_order_playbook||'')}</textarea>
    <p class="muted mt-1" style="font-size:.8rem">Your delivery / escalation / refund policy &amp; tone. The order concierge follows this when talking to customers <b>and</b> to you. The AI also auto-detects English vs Hinglish.</p>
  </div>

  <div class="form-group mt-2">
    <label class="form-label">Fallback Message (when AI fails / quota exceeded)</label>
    <input class="form-input" id="ai-fallback" value="${esc(s.ai_fallback_message||'')}" placeholder="Thank you! Our team will get back to you shortly.">
    <p class="muted mt-1" style="font-size:.8rem">Leave blank to stay silent (seller can reply manually).</p>
  </div>

  <div style="display:flex;gap:.5rem;align-items:center;margin-top:1rem;flex-wrap:wrap">
    <button class="btn btn-primary" onclick="saveAiSettings()">Save AI Settings</button>
    <button class="btn btn-secondary" onclick="testAiSettings()">⚡ Save & Test</button>
  </div>
</div>`);

    (function wireModelPreset(){
      const sel = document.getElementById('ai-model-preset'), inp = document.getElementById('ai-model');
      if (!sel || !inp) return;
      const PRESETS = ['gpt-5.4-mini','gpt-5.5','gpt-5.5-openai-compact'];
      sel.value = PRESETS.includes(inp.value.trim()) ? inp.value.trim() : '__custom';
      inp.style.display = sel.value === '__custom' ? '' : 'none';
      sel.onchange = () => {
        if (sel.value === '__custom') { inp.style.display = ''; inp.value = ''; inp.focus(); }
        else { inp.value = sel.value; inp.style.display = 'none'; }
      };
    })();
    window.saveAiSettings = async () => {
      const msg = document.getElementById('ai-msg');
      try {
        await api('/ai-settings', { method:'POST', body: JSON.stringify({
          ai_enabled: document.getElementById('ai-enabled').checked ? '1' : '0',
          ai_provider: document.getElementById('ai-provider').value,
          ai_model: document.getElementById('ai-model').value,
          ai_api_key: document.getElementById('ai-key').value,
          ai_base_url: document.getElementById('ai-base').value,
          ai_daily_cap: document.getElementById('ai-cap').value,
          ai_persona: document.getElementById('ai-persona').value,
          ai_order_playbook: document.getElementById('ai-playbook').value,
          ai_fallback_message: document.getElementById('ai-fallback').value,
        })});
        msg.innerHTML='<div class="alert alert-success">Saved! AI channel updated.</div>';
        return true;
      } catch(e) { msg.innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; return false; }
    };
    window.testAiSettings = async () => {
      const msg = document.getElementById('ai-msg');
      if (!(await saveAiSettings())) return;
      msg.innerHTML='<div class="alert">⏳ Testing your AI provider…</div>';
      try {
        const r = await api('/ai-settings/test', { method:'POST', body: JSON.stringify({}) });
        msg.innerHTML = r.ok
          ? `<div class="alert alert-success">✅ AI works! <b>${esc(r.model||'')}</b> replied: "${esc((r.reply||'').slice(0,80))}"</div>`
          : `<div class="alert alert-error">❌ ${esc(r.error||'Test failed')}</div>`;
      } catch(e) { msg.innerHTML=`<div class="alert alert-error">❌ ${esc(e.message)}</div>`; }
    };

  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

// ── views.fulfillment ─────────────────────────────────────────────────────────
views.fulfillment = async function (statusFilter) {
  statusFilter = statusFilter || 'all';
  setMain('<div class="spinner"></div>');
  try {
    const [jobs, stats, fSettings] = await Promise.all([
      api('/fulfillment' + (statusFilter !== 'all' ? `?status=${statusFilter}` : '')),
      api('/fulfillment/stats'),
      api('/fulfillment-settings'),
    ]);

    const tabs = ['all','pending','placing','polling','delivered','failed','manual_review','cancelled'];
    const tabBar = tabs.map(t => `<button class="btn btn-sm ${t===statusFilter?'btn-primary':'btn-secondary'}" onclick="views.fulfillment('${t}')">${t === 'manual_review' ? '⚠ Manual Review' : t.charAt(0).toUpperCase()+t.slice(1)}${stats[t]>0?` (${stats[t]})`:''}</button>`).join('');

    const statusBadgeMap = { pending:'badge-yellow',placing:'badge-blue',polling:'badge-blue',delivered:'badge-green',failed:'badge-red',manual_review:'badge-yellow',cancelled:'badge-grey' };

    setMain(`
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;flex-wrap:wrap;gap:.5rem">
  <div>
    <h2 style="font-weight:800;margin:0">Auto Fulfillment</h2>
    <div class="muted" style="font-size:.83rem">Orders with a provider set on the plan are placed automatically on ResellKeys. Keys delivered within 15 min – 24 hr (5 AM–11 PM IST).</div>
  </div>
  <div style="display:flex;gap:.5rem;align-items:center">
    ${fSettings.fulfillment_enabled==='1' ? '<span class="badge badge-green">✓ Automation ON</span>' : '<span class="badge badge-grey">Automation OFF</span>'}
    <button class="btn btn-sm btn-secondary" onclick="views.fulfillment('${statusFilter}')">↻ Refresh</button>
    <button class="btn btn-sm btn-secondary" onclick="openFulfillmentSettings()">⚙ Settings</button>
  </div>
</div>
<div style="display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:1rem">${tabBar}</div>
<div class="card" style="padding:0">
${jobs.length ? `<div class="table-wrap"><table>
  <thead><tr><th>#</th><th>Customer</th><th>Plan</th><th>Provider ID</th><th>Status</th><th>Attempts</th><th>Last Try</th><th></th></tr></thead>
  <tbody>${jobs.map(j=>`<tr>
    <td style="font-weight:600">#${j.order_id}</td>
    <td style="font-size:.83rem">${esc(j.customer_name||'—')}<br><span class="muted" style="font-size:.75rem">${esc(j.customer_email||'')}</span></td>
    <td style="font-size:.83rem">${esc(j.platform||'')} ${esc(j.plan_name||'')}</td>
    <td style="font-family:monospace;font-size:.78rem">${esc(j.provider_order_id||j.provider_product_id||'—')}</td>
    <td><span class="badge ${statusBadgeMap[j.status]||'badge-grey'}">${esc(j.status)}</span>${j.error_msg?`<br><span class="muted" style="font-size:.72rem" title="${esc(j.error_msg)}">⚠ ${esc(j.error_msg.slice(0,30))}…</span>`:''}</td>
    <td style="text-align:center">${j.attempt_count}</td>
    <td style="font-size:.78rem">${fmtDate(j.last_attempt_at||j.created_at)}</td>
    <td style="white-space:nowrap">
      ${j.status!=='delivered'&&j.status!=='cancelled'?`<button class="btn btn-sm btn-primary" onclick="retryFulfillment(${j.id})">↻ Retry</button>`:''}
      ${j.status!=='cancelled'&&j.status!=='delivered'?`<button class="btn btn-sm btn-red" onclick="cancelFulfillment(${j.id})">Cancel</button>`:''}
      ${j.status!=='manual_review'&&j.status!=='delivered'&&j.status!=='cancelled'?`<button class="btn btn-sm btn-secondary" onclick="flagManual(${j.id})">Flag</button>`:''}
    </td>
  </tr>`).join('')}</tbody>
</table></div>` : `<div style="padding:2rem;text-align:center;color:var(--muted)">No fulfillment jobs yet.</div>`}
</div>`);

    window.retryFulfillment = async (id) => {
      await api(`/fulfillment/retry/${id}`, { method:'POST' });
      showToast('Retrying…'); views.fulfillment(statusFilter);
    };
    window.cancelFulfillment = async (id) => {
      if (!confirm('Cancel this fulfillment job?')) return;
      await api(`/fulfillment/${id}/status`, { method:'PUT', body: JSON.stringify({ status:'cancelled' }) });
      showToast('Cancelled'); views.fulfillment(statusFilter);
    };
    window.flagManual = async (id) => {
      await api(`/fulfillment/${id}/status`, { method:'PUT', body: JSON.stringify({ status:'manual_review' }) });
      showToast('Flagged for manual review'); views.fulfillment(statusFilter);
    };

    window.openFulfillmentSettings = () => {
      const ov = openModal(`
<div class="modal-header"><h3>Fulfillment Settings</h3><button class="btn-icon" data-close>✕</button></div>
<div class="modal-body">
  <div id="fs-msg"></div>
  <label style="display:flex;align-items:center;gap:.6rem;margin-bottom:1rem">
    <input type="checkbox" id="fs-enabled" ${fSettings.fulfillment_enabled==='1'?'checked':''}>
    <span style="font-weight:600">Enable Auto Fulfillment</span>
  </label>
  <div class="form-group"><label class="form-label">ResellKeys Base URL</label>
    <input class="form-input" id="fs-url" value="${esc(fSettings.resellkeys_api_url||'https://www.resellkeys.com')}"></div>
  <div class="form-group"><label class="form-label">API Key</label>
    <input class="form-input" id="fs-key" type="password" value="${esc(fSettings.resellkeys_api_key||'')}" placeholder="Leave blank to keep current"></div>
  <div class="form-group"><label class="form-label">Login Email (if API key not available)</label>
    <input class="form-input" id="fs-email" value="${esc(fSettings.resellkeys_email||'')}" type="email"></div>
  <div class="form-group"><label class="form-label">Password</label>
    <input class="form-input" id="fs-pass" type="password" value="${esc(fSettings.resellkeys_password||'')}" placeholder="Leave blank to keep current"></div>
  <div class="form-group"><label class="form-label">Poll Interval (minutes)</label>
    <input class="form-input" id="fs-poll" type="number" value="${esc(fSettings.fulfillment_poll_interval||'10')}" min="2" max="60" style="width:100px"></div>
</div>
<div class="modal-footer">
  <button class="btn btn-secondary" data-close>Cancel</button>
  <button class="btn btn-primary" id="fs-save">Save</button>
</div>`);
      document.getElementById('fs-save').onclick = async () => {
        const msg = document.getElementById('fs-msg');
        try {
          await api('/fulfillment-settings', { method:'POST', body: JSON.stringify({
            fulfillment_enabled: document.getElementById('fs-enabled').checked?'1':'0',
            resellkeys_api_url: document.getElementById('fs-url').value.trim(),
            resellkeys_api_key: document.getElementById('fs-key').value,
            resellkeys_email: document.getElementById('fs-email').value.trim(),
            resellkeys_password: document.getElementById('fs-pass').value,
            fulfillment_poll_interval: document.getElementById('fs-poll').value,
          })});
          ov.remove(); showToast('Settings saved'); views.fulfillment(statusFilter);
        } catch(e) { msg.innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
      };
    };

  } catch(e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

// ── views['chat-bot'] ────────────────────────────────────────────────────────
views['chat-bot'] = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const s = await api('/bot-settings');
    let customLinks = []; try { customLinks = JSON.parse(s.support_custom_links || '[]'); if (!Array.isArray(customLinks)) customLinks = []; } catch { customLinks = []; }
    const customRow = (l = {}) => `<div class="cw-custom-row" style="display:flex;gap:.5rem;margin-bottom:.4rem"><input class="form-input cwc-label" value="${esc(l.label || '')}" placeholder="Label (e.g. Discord)" style="flex:0 0 36%"><input class="form-input cwc-url" value="${esc(l.url || '')}" placeholder="https://…" style="flex:1"><button type="button" class="btn btn-sm btn-red" data-del title="Remove">✕</button></div>`;

    setMain(`
<h2 style="font-weight:800;margin-bottom:1.5rem">Chat Bot Widget</h2>
<div style="max-width:720px;display:flex;flex-direction:column;gap:1.25rem">

<div class="card" style="border-left:3px solid #7c3aed">
  <div style="display:flex;gap:.75rem;align-items:flex-start">
    <div style="font-size:2rem">💬</div>
    <div>
      <div style="font-weight:700">AI-Powered Store Chat Widget</div>
      <div class="muted" style="font-size:.84rem;margin-top:.25rem">A floating chat button on your store. The AI is auto-trained with your live product catalogue &amp; pricing. Requires an active <b>API Channel</b>.</div>
    </div>
  </div>
</div>

<div class="card">
  <div style="font-weight:700;margin-bottom:.9rem">Widget Settings</div>
  <div id="bot-msg"></div>

  <label style="display:flex;align-items:center;gap:.6rem;margin-bottom:1rem">
    <input type="checkbox" id="bot-enabled" ${s.bot_enabled==='1'?'checked':''}>
    <span style="font-weight:600">Enable Chat Widget on Store</span>
  </label>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
    <div class="form-group"><label class="form-label">Bot Name</label>
      <input class="form-input" id="bot-name" value="${esc(s.bot_name||'Store AI')}" placeholder="Store AI"></div>
    <div class="form-group"><label class="form-label">Status Text</label>
      <input class="form-input" id="bot-tagline" value="${esc(s.bot_tagline||'Online · Replies instantly')}" placeholder="Online · Replies instantly"></div>
  </div>

  <div class="form-group"><label class="form-label">Accent Color</label>
    <div style="display:flex;align-items:center;gap:.75rem">
      <input type="color" class="form-input" id="bot-accent" value="${esc(s.bot_accent||'#7c3aed')}" style="width:60px;height:40px;padding:.2rem;cursor:pointer">
      <span class="muted" style="font-size:.83rem">Used for button color and chat bubble</span>
    </div>
  </div>

  <div class="form-group"><label class="form-label">Greeting Message <span class="muted">(use <code>{site_name}</code> for dynamic store name, use *bold*)</span></label>
    <textarea class="form-input" id="bot-greeting" rows="2">${esc(s.bot_greeting||"👋 Hi! I'm your *{site_name}* AI.\nWhat would you like to do?")}</textarea></div>

  <div class="form-group"><label class="form-label">Bot Avatar (PNG/JPG, optional)</label>
    <input type="file" accept="image/*" id="bot-av-file" onchange="loadBotAvatar(this)">
    ${s.bot_avatar && s.bot_avatar.length>10 ? `<div style="margin-top:.5rem"><img src="data:image/png;base64,${s.bot_avatar}" style="width:52px;height:52px;border-radius:50%;object-fit:cover;border:2px solid var(--border)"></div>` : '<p class="muted mt-1" style="font-size:.8rem">No avatar set — bot uses 🤖 emoji.</p>'}
    <input type="hidden" id="bot-av-b64">
  </div>

  <button class="btn btn-primary" onclick="saveBotSettings()">Save Widget Settings</button>
</div>

<div class="card" style="border-left:3px solid #25D366">
  <div style="font-weight:700;margin-bottom:.4rem">📱 Contact Buttons — WhatsApp &amp; Telegram</div>
  <p class="muted" style="font-size:.83rem;margin-bottom:.9rem">These show inside the floating widget's <b>“Chat with us”</b> menu on your store. Leave a field empty to hide that button.</p>
  <div id="contact-msg"></div>
  <div class="form-group"><label class="form-label">🟢 WhatsApp Number</label>
    <input class="form-input" id="cw-whatsapp" value="${esc(s.support_whatsapp||'')}" placeholder="+91 98765 43210">
    <p class="muted" style="font-size:.78rem;margin-top:.3rem">Opens a <code>wa.me</code> chat with a pre-filled message.</p></div>
  <div class="form-group"><label class="form-label">🔵 Telegram (direct chat)</label>
    <input class="form-input" id="cw-telegram" value="${esc(s.support_telegram||'')}" placeholder="@yourchannel or https://t.me/yourchannel">
    <p class="muted" style="font-size:.78rem;margin-top:.3rem">A username (<code>@name</code>) or a full <code>t.me/…</code> link.</p></div>
  <div class="form-group"><label class="form-label">📷 Instagram</label>
    <input class="form-input" id="cw-instagram" value="${esc(s.support_instagram||'')}" placeholder="@handle or https://instagram.com/handle"></div>
  <div class="form-group"><label class="form-label">👥 WhatsApp Community</label>
    <input class="form-input" id="cw-wacommunity" value="${esc(s.support_wa_community||'')}" placeholder="https://chat.whatsapp.com/…">
    <p class="muted" style="font-size:.78rem;margin-top:.3rem">Paste the community/group <b>invite link</b>.</p></div>
  <div class="form-group"><label class="form-label">📣 Telegram Channel</label>
    <input class="form-input" id="cw-tgchannel" value="${esc(s.support_telegram_channel||'')}" placeholder="@channel or https://t.me/channel"></div>
  <div class="form-group"><label class="form-label">🔗 Custom links</label>
    <div id="cw-custom-list">${customLinks.map(customRow).join('')}</div>
    <button type="button" class="btn btn-sm" id="cw-custom-add">+ Add link</button>
    <p class="muted" style="font-size:.78rem;margin-top:.3rem">Any extra button — Discord, YouTube, a help page, etc.</p></div>
  <button class="btn btn-primary" onclick="saveContactChannels()">Save Contact Buttons</button>
</div>

<div class="card">
  <div style="font-weight:700;margin-bottom:.5rem">Custom AI Instructions <span class="muted" style="font-weight:400;font-size:.83rem">(optional)</span></div>
  <p class="muted" style="font-size:.83rem;margin-bottom:.75rem">The bot is auto-trained with your live products &amp; pricing. Use this field to add extra rules — tone, special offers, things to avoid, etc.</p>
  <textarea class="form-input" id="bot-sys" rows="5" placeholder="E.g: Always upsell annual plans. Mention free delivery on all orders. Do not discuss competitor pricing.">${esc(s.bot_system_prompt||'')}</textarea>
  <button class="btn btn-secondary btn-sm mt-2" onclick="saveBotSettings()">Save Instructions</button>
</div>

<div class="card">
  <div style="font-weight:700;margin-bottom:.75rem">Preview & Test</div>
  <p class="muted" style="font-size:.83rem;margin-bottom:.75rem">Test the AI with a message below. Uses your live product data and the active API Channel.</p>
  <div id="bot-test-msg"></div>
  <div class="form-group"><input class="form-input" id="bot-test-in" placeholder="Ask something like: What Netflix plans do you have?" onkeydown="if(event.key==='Enter')testBotChat()"></div>
  <button class="btn btn-primary btn-sm" onclick="testBotChat()">Send Test Message →</button>
  <div id="bot-test-reply" style="margin-top:.75rem"></div>
</div>

</div>`);

    window.loadBotAvatar = (inp) => {
      const file = inp.files[0];
      if (!file) return;
      const r = new FileReader();
      r.onload = e => { document.getElementById('bot-av-b64').value = e.target.result.split(',')[1]; };
      r.readAsDataURL(file);
    };

    window.saveBotSettings = async () => {
      const msg = document.getElementById('bot-msg');
      const body = {
        bot_enabled: document.getElementById('bot-enabled').checked ? '1' : '0',
        bot_name: document.getElementById('bot-name').value.trim(),
        bot_tagline: document.getElementById('bot-tagline').value.trim(),
        bot_accent: document.getElementById('bot-accent').value,
        bot_greeting: document.getElementById('bot-greeting').value,
        bot_system_prompt: document.getElementById('bot-sys').value,
      };
      const av = document.getElementById('bot-av-b64').value;
      if (av) body.bot_avatar = av;
      try {
        await api('/bot-settings', { method: 'POST', body: JSON.stringify(body) });
        msg.innerHTML = '<div class="alert alert-success">Saved!</div>';
        setTimeout(() => msg.innerHTML = '', 2500);
      } catch(e) { msg.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`; }
    };

    document.getElementById('cw-custom-add').onclick = () => document.getElementById('cw-custom-list').insertAdjacentHTML('beforeend', customRow({}));
    document.getElementById('cw-custom-list').addEventListener('click', e => { const b = e.target.closest('[data-del]'); if (b) { const row = b.closest('.cw-custom-row'); if (row) row.remove(); } });

    window.saveContactChannels = async () => {
      const msg = document.getElementById('contact-msg');
      const customs = [...document.querySelectorAll('.cw-custom-row')].map(r => ({ label: r.querySelector('.cwc-label').value.trim(), url: r.querySelector('.cwc-url').value.trim() })).filter(l => l.label && l.url);
      const body = {
        support_whatsapp: document.getElementById('cw-whatsapp').value.trim(),
        support_telegram: document.getElementById('cw-telegram').value.trim(),
        support_instagram: document.getElementById('cw-instagram').value.trim(),
        support_wa_community: document.getElementById('cw-wacommunity').value.trim(),
        support_telegram_channel: document.getElementById('cw-tgchannel').value.trim(),
        support_custom_links: JSON.stringify(customs),
      };
      try {
        await api('/bot-settings', { method: 'POST', body: JSON.stringify(body) });
        msg.innerHTML = '<div class="alert alert-success">Saved! Hard-refresh your store to see the updated chat widget.</div>';
        setTimeout(() => msg.innerHTML = '', 4000);
      } catch(e) { msg.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`; }
    };

    window.testBotChat = async () => {
      const q = document.getElementById('bot-test-in').value.trim();
      if (!q) return;
      const reply = document.getElementById('bot-test-reply');
      const msg = document.getElementById('bot-test-msg');
      reply.innerHTML = '<div style="display:flex;gap:.3rem;padding:.4rem 0"><span style="animation:tdot .9s infinite;background:#9f75ff;width:8px;height:8px;border-radius:50%;display:inline-block"></span><span style="animation:tdot .9s .18s infinite;background:#9f75ff;width:8px;height:8px;border-radius:50%;display:inline-block"></span><span style="animation:tdot .9s .36s infinite;background:#9f75ff;width:8px;height:8px;border-radius:50%;display:inline-block"></span></div>';
      msg.innerHTML = '';
      try {
        const r = await api('/ai/chat', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: q }] }) });
        reply.innerHTML = `<div style="background:var(--input-bg);border-radius:10px;padding:.75rem 1rem;white-space:pre-wrap;font-size:.9rem;border-left:3px solid #7c3aed">${esc(r.reply)}</div>`;
      } catch(e) {
        reply.innerHTML = '';
        msg.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
      }
    };

  } catch(e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

// ── views['api-channels'] ─────────────────────────────────────────────────────
views['api-channels'] = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const channels = await api('/api-channels');

    setMain(`
<h2 style="font-weight:800;margin-bottom:1.5rem">API Channels</h2>
<div style="max-width:820px;display:flex;flex-direction:column;gap:1.25rem">

<div class="card" style="border-left:3px solid var(--purple)">
  <div style="display:flex;gap:.75rem;align-items:flex-start">
    <div style="font-size:2rem">🔌</div>
    <div>
      <div style="font-weight:700">OpenAI-Compatible API Channels</div>
      <div class="muted" style="font-size:.85rem;margin-top:.25rem">Connect any OpenAI-compatible API endpoint — New API, one-api, custom proxies, or direct providers. The <b>active</b> channel is used by the AI Agent and all AI features.</div>
    </div>
  </div>
</div>

<div class="card">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem">
    <div style="font-weight:700">Channels (${channels.length})</div>
    <button class="btn btn-sm btn-primary" onclick="addChannel()">+ Add Channel</button>
  </div>
  ${channels.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Label</th><th>Type</th><th>Endpoint</th><th>Model</th><th>Key</th><th>Status</th><th></th></tr></thead>
    <tbody>${channels.map(c => `<tr>
      <td style="font-weight:600">${esc(c.label)}</td>
      <td><span class="badge badge-blue" style="font-size:.75rem">${esc(c.type||'newapi_channel_conn')}</span></td>
      <td style="font-family:monospace;font-size:.8rem;color:var(--muted)">${esc(c.url)}</td>
      <td style="font-size:.82rem">${esc(c.model||'gpt-4o-mini')}</td>
      <td style="font-family:monospace;font-size:.78rem;color:var(--muted)">${esc(c.api_key)}</td>
      <td>${c.active ? '<span class="badge badge-green">Active</span>' : '<span class="badge badge-grey">Off</span>'}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-sm btn-primary" onclick="testChannel(${c.id})" title="Test connection">Test</button>
        <button class="btn btn-sm btn-secondary" onclick="setActiveChannel(${c.id})" title="Set as default">Set Active</button>
        <button class="btn btn-sm btn-secondary" onclick="editChannel(${c.id})">Edit</button>
        <button class="btn btn-sm btn-red" onclick="delChannel(${c.id})">Del</button>
      </td>
    </tr>`).join('')}</tbody>
  </table></div>` : '<p class="muted">No channels yet. Add one to enable AI features.</p>'}
</div>

<div class="card">
  <div style="font-weight:700;margin-bottom:.75rem">Test AI Chat</div>
  <div id="ai-test-msg"></div>
  <div class="form-group"><label class="form-label">Your message</label>
    <textarea class="form-input" id="ai-test-input" rows="3" placeholder="Ask anything to test the active channel..."></textarea></div>
  <button class="btn btn-primary btn-sm" onclick="sendAiTest()">Send →</button>
  <div id="ai-test-reply" style="margin-top:.75rem"></div>
</div>

</div>`);

    window.addChannel = () => channelModal(null);
    window.editChannel = async (id) => {
      const c = channels.find(x => x.id === id);
      if (c) channelModal(c);
    };
    window.delChannel = async (id) => {
      if (!confirm('Delete this channel?')) return;
      await api(`/api-channels/${id}`, { method: 'DELETE' });
      views['api-channels']();
    };
    window.setActiveChannel = async (id) => {
      await api(`/api-channels/${id}/set-active`, { method: 'POST' });
      showToast('Channel set as active');
      views['api-channels']();
    };
    window.testChannel = async (id) => {
      showToast('Testing connection…');
      try {
        const r = await api(`/api-channels/${id}/test`, { method: 'POST' });
        showToast(`✓ Connected — model: ${r.model}, reply: "${r.reply}"`);
      } catch (e) { showToast(e.message, 'error'); }
    };
    window.sendAiTest = async () => {
      const input = document.getElementById('ai-test-input').value.trim();
      if (!input) return;
      const replyEl = document.getElementById('ai-test-reply');
      const msgEl = document.getElementById('ai-test-msg');
      replyEl.innerHTML = '<div class="spinner" style="margin:.5rem 0"></div>';
      msgEl.innerHTML = '';
      try {
        const r = await api('/ai/chat', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: input }] }) });
        replyEl.innerHTML = `<div style="background:var(--input-bg);border-radius:var(--radius-sm);padding:.75rem 1rem;white-space:pre-wrap;font-size:.9rem">${esc(r.reply)}</div>`;
      } catch (e) {
        replyEl.innerHTML = '';
        msgEl.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`;
      }
    };

    function channelModal(c) {
      c = c || {};
      const ov = openModal(`
<div class="modal-header"><h3>${c.id ? 'Edit' : 'Add'} API Channel</h3><button class="btn-icon" data-close>✕</button></div>
<div class="modal-body">
  <div id="ch-msg"></div>
  <div class="form-group"><label class="form-label">Label</label>
    <input class="form-input" id="ch-label" value="${esc(c.label||'')}" placeholder="My API Channel"></div>
  <div class="form-group"><label class="form-label">Type</label>
    <select class="form-input" id="ch-type">
      <option value="newapi_channel_conn" ${(c.type||'newapi_channel_conn')==='newapi_channel_conn'?'selected':''}>New API (newapi_channel_conn)</option>
      <option value="openai" ${c.type==='openai'?'selected':''}>OpenAI Direct</option>
      <option value="custom" ${c.type==='custom'?'selected':''}>Custom OpenAI-compatible</option>
    </select></div>
  <div class="form-group"><label class="form-label">Base URL <span class="muted">(without /v1)</span></label>
    <input class="form-input" id="ch-url" value="${esc(c.url||'')}" placeholder="s1.tokenclub.top or https://api.openai.com"></div>
  <div class="form-group"><label class="form-label">API Key</label>
    <input class="form-input" id="ch-key" type="password" value="${esc(c.api_key||'')}" placeholder="${c.id ? 'Leave blank to keep current' : 'sk-...' }"></div>
  <div class="form-group"><label class="form-label">Default Model</label>
    <input class="form-input" id="ch-model" value="${esc(c.model||'gpt-4o-mini')}" placeholder="gpt-4o-mini"></div>
  <div class="form-group"><label class="form-label">Notes <span class="muted">(optional)</span></label>
    <input class="form-input" id="ch-notes" value="${esc(c.notes||'')}" placeholder="e.g. 1M tokens/day free tier"></div>
  <label style="display:flex;align-items:center;gap:.5rem;margin-top:.25rem">
    <input type="checkbox" id="ch-active" ${c.active !== 0 ? 'checked' : ''}> Set as active channel
  </label>
</div>
<div class="modal-footer">
  <button class="btn btn-secondary" data-close>Cancel</button>
  <button class="btn btn-primary" id="ch-save">Save Channel</button>
</div>`);

      document.getElementById('ch-save').onclick = async () => {
        const msg = document.getElementById('ch-msg');
        const body = {
          label: document.getElementById('ch-label').value.trim(),
          type: document.getElementById('ch-type').value,
          url: document.getElementById('ch-url').value.trim(),
          api_key: document.getElementById('ch-key').value,
          model: document.getElementById('ch-model').value.trim() || 'gpt-4o-mini',
          active: document.getElementById('ch-active').checked ? 1 : 0,
          notes: document.getElementById('ch-notes').value.trim(),
        };
        if (!body.label || !body.url) { msg.innerHTML = '<div class="alert alert-error">Label and URL required</div>'; return; }
        if (!c.id && !body.api_key) { msg.innerHTML = '<div class="alert alert-error">API Key required</div>'; return; }
        try {
          if (c.id) await api(`/api-channels/${c.id}`, { method: 'PUT', body: JSON.stringify(body) });
          else await api('/api-channels', { method: 'POST', body: JSON.stringify(body) });
          ov.remove(); views['api-channels']();
        } catch (e) { msg.innerHTML = `<div class="alert alert-error">${esc(e.message)}</div>`; }
      };
    }

  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

// ── views['email-marketing'] ──────────────────────────────────────────────────
views['email-marketing'] = async function (tab) {
  tab = tab || 'campaigns';
  setMain('<div class="spinner"></div>');
  try {
    const tabs = ['campaigns','templates','accounts'];
    const tabBar = tabs.map(t => `<button class="btn btn-sm ${t===tab?'btn-primary':'btn-secondary'}" onclick="views['email-marketing']('${t}')">${t.charAt(0).toUpperCase()+t.slice(1)}</button>`).join('');

    if (tab === 'accounts') {
      const accounts = await api('/email-accounts');
      setMain(`
<h2 style="font-weight:800;margin-bottom:1rem">Email Marketing</h2>
<div style="display:flex;gap:.5rem;margin-bottom:1.25rem;flex-wrap:wrap">${tabBar}</div>
<div class="card" style="max-width:700px">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem">
    <div style="font-weight:700">Gmail Accounts (${accounts.length})</div>
    <button class="btn btn-sm btn-primary" onclick="addEmailAccount()">+ Add Account</button>
  </div>
  <p class="muted" style="font-size:.83rem;margin-bottom:.75rem">Add Gmail accounts with App Passwords. Enable 2FA on Gmail, then create an App Password under Google Account → Security.</p>
  <div id="email-acc-list">
  ${accounts.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Label</th><th>Email</th><th>SMTP Host</th><th>Active</th><th></th></tr></thead>
    <tbody>${accounts.map(a=>`<tr>
      <td style="font-weight:600">${esc(a.label)}</td>
      <td style="font-size:.85rem">${esc(a.user)}</td>
      <td style="font-size:.8rem;color:var(--muted)">${esc(a.host||'smtp.gmail.com')}:${a.port||587}</td>
      <td>${a.active?'<span class="badge badge-green">On</span>':'<span class="badge badge-grey">Off</span>'}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-sm btn-secondary" onclick="testEmailAccount(${a.id})">Test</button>
        <button class="btn btn-sm btn-secondary" onclick="editEmailAccount(${a.id})">Edit</button>
        <button class="btn btn-sm btn-red" onclick="delEmailAccount(${a.id})">Del</button>
      </td>
    </tr>`).join('')}</tbody>
  </table></div>` : '<p class="muted">No accounts yet.</p>'}
  </div>
</div>`);

      window.addEmailAccount = () => emailAccountModal(null);
      window.editEmailAccount = async (id) => {
        const a = (await api('/email-accounts')).find(x=>x.id===id);
        if (a) emailAccountModal(a);
      };
      window.delEmailAccount = async (id) => {
        if (!confirm('Delete this account?')) return;
        await api(`/email-accounts/${id}`, { method:'DELETE' });
        views['email-marketing']('accounts');
      };
      window.testEmailAccount = async (id) => {
        try {
          const r = await api(`/email-accounts/${id}/test`, { method:'POST' });
          showToast(`✓ Connected as ${r.email}`);
        } catch(e) { showToast(e.message, 'error'); }
      };

      function emailAccountModal(a) {
        a = a || {};
        const ov = openModal(`
<div class="modal-header"><h3>${a.id?'Edit':'Add'} Gmail Account</h3><button class="btn-icon" data-close>✕</button></div>
<div class="modal-body">
  <div id="eacc-msg"></div>
  <div class="form-group"><label class="form-label">Label (e.g. "Marketing Account 1")</label>
    <input class="form-input" id="eacc-label" value="${esc(a.label||'')}" placeholder="My Gmail"></div>
  <div class="form-group"><label class="form-label">Gmail Address</label>
    <input class="form-input" id="eacc-user" type="email" value="${esc(a.user||'')}" placeholder="you@gmail.com"></div>
  <div class="form-group"><label class="form-label">App Password <span class="muted">(16-char, no spaces)</span></label>
    <input class="form-input" id="eacc-pass" type="password" value="${esc(a.app_password||'')}" placeholder="${a.id?'Leave blank to keep current':'abcd efgh ijkl mnop'}"></div>
  <div class="form-group"><label class="form-label">From Name</label>
    <input class="form-input" id="eacc-fname" value="${esc(a.from_name||'')}" placeholder="OTT Store"></div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
    <div class="form-group"><label class="form-label">SMTP Host</label>
      <input class="form-input" id="eacc-host" value="${esc(a.host||'smtp.gmail.com')}"></div>
    <div class="form-group"><label class="form-label">Port</label>
      <input class="form-input" id="eacc-port" type="number" value="${a.port||587}"></div>
  </div>
  <label style="display:flex;align-items:center;gap:.5rem"><input type="checkbox" id="eacc-active" ${a.active!==0?'checked':''}> Active</label>
</div>
<div class="modal-footer">
  <button class="btn btn-secondary" data-close>Cancel</button>
  <button class="btn btn-primary" id="eacc-save">Save Account</button>
</div>`);
        document.getElementById('eacc-save').onclick = async () => {
          const msg = document.getElementById('eacc-msg');
          const body = {
            label: document.getElementById('eacc-label').value.trim(),
            user: document.getElementById('eacc-user').value.trim(),
            app_password: document.getElementById('eacc-pass').value,
            from_name: document.getElementById('eacc-fname').value.trim(),
            host: document.getElementById('eacc-host').value.trim(),
            port: +document.getElementById('eacc-port').value,
            active: document.getElementById('eacc-active').checked ? 1 : 0,
          };
          if (!body.label || !body.user) { msg.innerHTML='<div class="alert alert-error">Label and email required</div>'; return; }
          try {
            if (a.id) await api(`/email-accounts/${a.id}`, { method:'PUT', body: JSON.stringify(body) });
            else await api('/email-accounts', { method:'POST', body: JSON.stringify(body) });
            ov.remove(); views['email-marketing']('accounts');
          } catch(e) { msg.innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
        };
      }

    } else if (tab === 'templates') {
      const templates = await api('/email-templates');
      const cats = [...new Set(templates.map(t=>t.category))];
      let activeCat = 'all';

      const renderTemplates = (cat) => {
        activeCat = cat;
        const filtered = cat === 'all' ? templates : templates.filter(t=>t.category===cat);
        document.getElementById('tpl-grid').innerHTML = filtered.map(t=>`
<div class="card" style="padding:.75rem;display:flex;flex-direction:column;gap:.4rem;border:1px solid var(--border)">
  <div style="font-weight:700;font-size:.9rem">${esc(t.name)}</div>
  <div style="font-size:.78rem;color:var(--muted)">${esc(t.category)} • ${t.is_system?'System':'Custom'}</div>
  <div style="font-size:.82rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary)">${esc(t.subject)}</div>
  <div style="display:flex;gap:.4rem;margin-top:.25rem;flex-wrap:wrap">
    <button class="btn btn-sm btn-secondary" onclick="previewTemplate(${t.id})">Preview</button>
    <button class="btn btn-sm btn-secondary" onclick="editTemplate(${t.id})">Edit</button>
    ${!t.is_system ? `<button class="btn btn-sm btn-red" onclick="delTemplate(${t.id})">Del</button>` : ''}
    <button class="btn btn-sm btn-primary" onclick="useTemplate(${t.id})">Use in Campaign</button>
  </div>
</div>`).join('');
      };

      setMain(`
<h2 style="font-weight:800;margin-bottom:1rem">Email Marketing</h2>
<div style="display:flex;gap:.5rem;margin-bottom:1.25rem;flex-wrap:wrap">${tabBar}</div>
<div style="max-width:900px">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem;flex-wrap:wrap;gap:.5rem">
    <div style="display:flex;gap:.35rem;flex-wrap:wrap">
      <button class="btn btn-sm btn-secondary" onclick="filterTplCat('all')">All (${templates.length})</button>
      ${cats.map(c=>`<button class="btn btn-sm btn-secondary" onclick="filterTplCat('${esc(c)}')">${esc(c)} (${templates.filter(t=>t.category===c).length})</button>`).join('')}
    </div>
    <button class="btn btn-sm btn-primary" onclick="newTemplate()">+ New Template</button>
  </div>
  <div id="tpl-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:.75rem"></div>
</div>`);

      renderTemplates('all');

      window.filterTplCat = renderTemplates;

      window.previewTemplate = async (id) => {
        const t = await api(`/email-templates/${id}`);
        openModal(`
<div class="modal-header"><h3>Preview: ${esc(t.name)}</h3><button class="btn-icon" data-close>✕</button></div>
<div class="modal-body" style="padding:0">
  <iframe srcdoc="${t.html.replace(/"/g,'&quot;')}" style="width:100%;height:65vh;border:0"></iframe>
</div>
<div class="modal-footer"><button class="btn btn-secondary" data-close>Close</button></div>`);
      };

      window.useTemplate = async (id) => {
        const t = await api(`/email-templates/${id}`);
        sessionStorage.setItem('em_tpl', JSON.stringify({ subject: t.subject, html: t.html }));
        views['email-marketing']('campaigns');
        showToast('Template loaded — click New Campaign');
      };

      window.editTemplate = async (id) => {
        const t = await api(`/email-templates/${id}`);
        templateModal(t);
      };
      window.newTemplate = () => templateModal(null);
      window.delTemplate = async (id) => {
        if (!confirm('Delete this template?')) return;
        await api(`/email-templates/${id}`, { method:'DELETE' });
        views['email-marketing']('templates');
      };

      function templateModal(t) {
        t = t || {};
        const ov = openModal(`
<div class="modal-header"><h3>${t.id?'Edit':'New'} Template</h3><button class="btn-icon" data-close>✕</button></div>
<div class="modal-body">
  <div id="tpl-msg"></div>
  <div class="form-group"><label class="form-label">Name</label><input class="form-input" id="tpl-name" value="${esc(t.name||'')}"></div>
  <div class="form-group"><label class="form-label">Category</label>
    <select class="form-input" id="tpl-cat">
      ${['welcome','order','offer','product','retention','newsletter'].map(c=>`<option ${(t.category||'offer')===c?'selected':''}>${c}</option>`).join('')}
    </select></div>
  <div class="form-group"><label class="form-label">Subject</label><input class="form-input" id="tpl-subject" value="${esc(t.subject||'')}"></div>
  <div class="form-group"><label class="form-label">HTML Body <span class="muted">(Use {{name}}, {{site_name}}, {{site_url}}, {{email}})</span></label>
    <textarea class="form-input" id="tpl-html" rows="10" style="font-family:monospace;font-size:.8rem">${esc(t.html||'')}</textarea></div>
</div>
<div class="modal-footer">
  <button class="btn btn-secondary" data-close>Cancel</button>
  <button class="btn btn-primary" id="tpl-save">Save Template</button>
</div>`);
        document.getElementById('tpl-save').onclick = async () => {
          const msg = document.getElementById('tpl-msg');
          const body = {
            name: document.getElementById('tpl-name').value.trim(),
            category: document.getElementById('tpl-cat').value,
            subject: document.getElementById('tpl-subject').value.trim(),
            html: document.getElementById('tpl-html').value,
          };
          if (!body.name || !body.subject || !body.html) { msg.innerHTML='<div class="alert alert-error">All fields required</div>'; return; }
          try {
            if (t.id) await api(`/email-templates/${t.id}`, { method:'PUT', body: JSON.stringify(body) });
            else await api('/email-templates', { method:'POST', body: JSON.stringify(body) });
            ov.remove(); views['email-marketing']('templates');
          } catch(e) { msg.innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
        };
      }

    } else {
      // campaigns tab (default)
      const campaigns = await api('/email-campaigns');
      const storedTpl = sessionStorage.getItem('em_tpl');

      setMain(`
<h2 style="font-weight:800;margin-bottom:1rem">Email Marketing</h2>
<div style="display:flex;gap:.5rem;margin-bottom:1.25rem;flex-wrap:wrap">${tabBar}</div>
<div style="max-width:860px">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem">
    <div style="font-weight:700">Campaigns (${campaigns.length})</div>
    <button class="btn btn-sm btn-primary" onclick="newCampaign()">+ New Campaign</button>
  </div>
  ${campaigns.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Name</th><th>Subject</th><th>Target</th><th>Account</th><th>Status</th><th>Progress</th><th></th></tr></thead>
    <tbody>${campaigns.map(c=>`<tr>
      <td style="font-weight:600">${esc(c.name)}</td>
      <td style="font-size:.82rem;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.subject)}</td>
      <td><span class="badge badge-blue">${esc(c.target)}</span></td>
      <td style="font-size:.8rem;color:var(--muted)">${esc(c.account_email||'—')}</td>
      <td>${statusBadge(c.status)}</td>
      <td style="font-size:.8rem">${c.total_recipients>0 ? `${c.sent_count}/${c.total_recipients}${c.failed_count>0?` (${c.failed_count} fail)`:''}`:'—'}</td>
      <td style="white-space:nowrap">
        ${c.status!=='sending'?`<button class="btn btn-sm btn-primary" onclick="sendCampaign(${c.id})">Send</button>`:'<span class="badge badge-blue">Sending…</span>'}
        <button class="btn btn-sm btn-secondary" onclick="editCampaign(${c.id})">Edit</button>
        <button class="btn btn-sm btn-secondary" onclick="dupCampaign(${c.id})">Clone</button>
        ${c.status!=='sending'?`<button class="btn btn-sm btn-red" onclick="delCampaign(${c.id})">Del</button>`:''}
      </td>
    </tr>`).join('')}</tbody>
  </table></div>` : '<p class="muted">No campaigns yet. Click "+ New Campaign" to start.</p>'}
</div>`);

      window.newCampaign = async () => {
        const tplData = storedTpl ? JSON.parse(storedTpl) : null;
        sessionStorage.removeItem('em_tpl');
        campaignModal(null, tplData);
      };
      window.editCampaign = async (id) => {
        const c = campaigns.find(x=>x.id===id);
        if (c) campaignModal(c, null);
      };
      window.sendCampaign = async (id) => {
        if (!confirm('Send this campaign now? This cannot be undone.')) return;
        try {
          await api(`/email-campaigns/${id}/send`, { method:'POST' });
          showToast('Campaign started! Sending in background…');
          views['email-marketing']('campaigns');
        } catch(e) { showToast(e.message, 'error'); }
      };
      window.dupCampaign = async (id) => {
        try {
          await api(`/email-campaigns/${id}/duplicate`, { method:'POST' });
          showToast('Campaign cloned as draft');
          views['email-marketing']('campaigns');
        } catch(e) { showToast(e.message, 'error'); }
      };
      window.delCampaign = async (id) => {
        if (!confirm('Delete this campaign?')) return;
        await api(`/email-campaigns/${id}`, { method:'DELETE' });
        views['email-marketing']('campaigns');
      };

      async function campaignModal(c, prefill) {
        c = c || {};
        const [accounts, templates] = await Promise.all([api('/email-accounts'), api('/email-templates')]);
        const subject = prefill?.subject || c.subject || '';
        const html = prefill?.html || c.html || '';
        const ov = openModal(`
<div class="modal-header"><h3>${c.id?'Edit':'New'} Campaign</h3><button class="btn-icon" data-close>✕</button></div>
<div class="modal-body" style="max-height:78vh;overflow-y:auto">
  <div id="camp-msg"></div>
  <div class="form-group"><label class="form-label">Campaign Name</label>
    <input class="form-input" id="camp-name" value="${esc(c.name||'')}"></div>
  <div class="form-group"><label class="form-label">Subject</label>
    <input class="form-input" id="camp-subject" value="${esc(subject)}"></div>
  <div class="form-group"><label class="form-label">Email Account</label>
    <select class="form-input" id="camp-acc">
      <option value="">— Select Account —</option>
      ${accounts.map(a=>`<option value="${a.id}" ${c.account_id===a.id?'selected':''}>${esc(a.label)} &lt;${esc(a.user)}&gt;</option>`).join('')}
    </select></div>
  <div class="form-group"><label class="form-label">Target Audience</label>
    <select class="form-input" id="camp-target" onchange="toggleCustomEmails()">
      ${[['all','All Customers'],['recent7','Ordered in last 7 days'],['recent30','Ordered in last 30 days'],['custom','Custom Email List']].map(([v,l])=>`<option value="${v}" ${(c.target||'all')===v?'selected':''}>${l}</option>`).join('')}
    </select></div>
  <div class="form-group" id="camp-custom-wrap" style="display:${c.target==='custom'?'block':'none'}">
    <label class="form-label">Custom Emails (one per line or comma-separated)</label>
    <textarea class="form-input" id="camp-custom" rows="4">${esc(c.custom_emails||'')}</textarea></div>
  <div class="form-group"><label class="form-label">Load from Template</label>
    <select class="form-input" id="camp-tpl" onchange="loadTplIntoEditor()">
      <option value="">— pick a template —</option>
      ${templates.map(t=>`<option value="${t.id}" data-cat="${esc(t.category)}">${esc(t.name)} (${esc(t.category)})</option>`).join('')}
    </select></div>
  <div class="form-group"><label class="form-label">HTML Body <span class="muted">(Use {{name}}, {{site_name}}, {{site_url}}, {{email}})</span></label>
    <textarea class="form-input" id="camp-html" rows="12" style="font-family:monospace;font-size:.78rem">${esc(html)}</textarea></div>
</div>
<div class="modal-footer">
  <button class="btn btn-secondary" data-close>Cancel</button>
  <button class="btn btn-primary" id="camp-save">Save Draft</button>
</div>`);

        window.toggleCustomEmails = () => {
          document.getElementById('camp-custom-wrap').style.display =
            document.getElementById('camp-target').value === 'custom' ? 'block' : 'none';
        };
        window.loadTplIntoEditor = async () => {
          const id = +document.getElementById('camp-tpl').value;
          if (!id) return;
          const t = await api(`/email-templates/${id}`);
          document.getElementById('camp-subject').value = t.subject;
          document.getElementById('camp-html').value = t.html;
        };

        document.getElementById('camp-save').onclick = async () => {
          const msg = document.getElementById('camp-msg');
          const body = {
            name: document.getElementById('camp-name').value.trim(),
            subject: document.getElementById('camp-subject').value.trim(),
            account_id: +document.getElementById('camp-acc').value || null,
            target: document.getElementById('camp-target').value,
            custom_emails: document.getElementById('camp-custom').value.trim(),
            html: document.getElementById('camp-html').value,
          };
          if (!body.name || !body.subject || !body.html) { msg.innerHTML='<div class="alert alert-error">Name, subject and HTML required</div>'; return; }
          try {
            if (c.id) await api(`/email-campaigns/${c.id}`, { method:'PUT', body: JSON.stringify(body) });
            else await api('/email-campaigns', { method:'POST', body: JSON.stringify(body) });
            ov.remove(); views['email-marketing']('campaigns');
          } catch(e) { msg.innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
        };
      }
    }

  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

// ── views['pwa-manager'] ──────────────────────────────────────────────────────
views['pwa-manager'] = async function (tab) {
  tab = tab || 'branding';
  setMain('<div class="spinner"></div>');
  try {
    const tabs = ['branding','push','subscribers'];
    const tabBar = tabs.map(t => `<button class="btn btn-sm ${t===tab?'btn-primary':'btn-secondary'}" onclick="views['pwa-manager']('${t}')">${t.charAt(0).toUpperCase()+t.slice(1)}</button>`).join('');

    if (tab === 'branding') {
      const s = await api('/pwa-settings');
      setMain(`
<h2 style="font-weight:800;margin-bottom:1rem">App Manager (PWA)</h2>
<div style="display:flex;gap:.5rem;margin-bottom:1.25rem;flex-wrap:wrap">${tabBar}</div>
<div style="max-width:640px;display:flex;flex-direction:column;gap:1.25rem">

<div class="card">
  <div style="font-weight:700;margin-bottom:.75rem">App Branding</div>
  <div id="pwa-msg"></div>
  <div class="form-group"><label class="form-label">App Name (full)</label>
    <input class="form-input" id="pwa-name" value="${esc(s.pwa_name||'')}" placeholder="OTT Store"></div>
  <div class="form-group"><label class="form-label">Short Name (home screen)</label>
    <input class="form-input" id="pwa-sname" value="${esc(s.pwa_short_name||'')}" placeholder="OTT"></div>
  <div class="form-group"><label class="form-label">Description</label>
    <input class="form-input" id="pwa-desc" value="${esc(s.pwa_description||'')}" placeholder="Buy OTT Subscriptions at Best Prices"></div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
    <div class="form-group"><label class="form-label">Theme Color</label>
      <input class="form-input" id="pwa-theme" type="color" value="${esc(s.pwa_theme_color||'#7c3aed')}" style="height:40px;padding:.25rem"></div>
    <div class="form-group"><label class="form-label">Background Color</label>
      <input class="form-input" id="pwa-bg" type="color" value="${esc(s.pwa_bg_color||'#0d1117')}" style="height:40px;padding:.25rem"></div>
  </div>
  <div class="form-group"><label class="form-label">App Icon (PNG, min 512×512)</label>
    <input type="file" accept="image/png,image/jpeg" id="pwa-icon-file" onchange="loadPwaIcon(this)">
    ${s.pwa_icon_b64 ? `<div style="margin-top:.5rem"><img src="data:image/png;base64,${s.pwa_icon_b64}" style="width:80px;height:80px;border-radius:12px;object-fit:cover;border:2px solid var(--border)"></div>` : ''}
    <input type="hidden" id="pwa-icon-b64">
  </div>
  <label style="display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem">
    <input type="checkbox" id="pwa-prompt" ${s.pwa_force_prompt==='1'?'checked':''}>
    Force install prompt on store visit
  </label>
  <button class="btn btn-primary" onclick="savePwaSettings()">Save Branding</button>
</div>

<div class="card">
  <div style="font-weight:700;margin-bottom:.5rem">VAPID Keys (Push Notifications)</div>
  <p class="muted" style="font-size:.83rem;margin-bottom:.75rem">Required for push notifications. Generate once — changing keys will invalidate all existing subscriptions.</p>
  ${s.vapid_public_key ? `<div style="font-size:.78rem;font-family:monospace;word-break:break-all;background:var(--input-bg);padding:.5rem;border-radius:6px;margin-bottom:.75rem">${esc(s.vapid_public_key)}</div>` : '<p class="muted" style="font-size:.83rem">No VAPID keys yet.</p>'}
  <div style="display:flex;gap:.5rem">
    <button class="btn btn-secondary btn-sm" onclick="genVapid()">${s.vapid_public_key?'Regenerate':'Generate'} VAPID Keys</button>
  </div>
</div>

</div>`);

      window.loadPwaIcon = (inp) => {
        const file = inp.files[0];
        if (!file) return;
        const r = new FileReader();
        r.onload = e => { document.getElementById('pwa-icon-b64').value = e.target.result.split(',')[1]; };
        r.readAsDataURL(file);
      };

      window.savePwaSettings = async () => {
        const msg = document.getElementById('pwa-msg');
        const body = {
          pwa_name: document.getElementById('pwa-name').value.trim(),
          pwa_short_name: document.getElementById('pwa-sname').value.trim(),
          pwa_description: document.getElementById('pwa-desc').value.trim(),
          pwa_theme_color: document.getElementById('pwa-theme').value,
          pwa_bg_color: document.getElementById('pwa-bg').value,
          pwa_force_prompt: document.getElementById('pwa-prompt').checked ? '1' : '0',
        };
        const icon = document.getElementById('pwa-icon-b64').value;
        if (icon) body.pwa_icon_b64 = icon;
        try {
          await api('/pwa-settings', { method:'POST', body: JSON.stringify(body) });
          msg.innerHTML='<div class="alert alert-success">Saved!</div>';
          setTimeout(()=>msg.innerHTML='',2000);
        } catch(e) { msg.innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
      };

      window.genVapid = async () => {
        if (!confirm('Generate new VAPID keys? All existing push subscriptions will stop working.')) return;
        try {
          const r = await api('/pwa-settings/generate-vapid', { method:'POST' });
          showToast('VAPID keys generated');
          views['pwa-manager']('branding');
        } catch(e) { showToast(e.message, 'error'); }
      };

    } else if (tab === 'push') {
      const settings = await api('/pwa-settings');
      setMain(`
<h2 style="font-weight:800;margin-bottom:1rem">App Manager (PWA)</h2>
<div style="display:flex;gap:.5rem;margin-bottom:1.25rem;flex-wrap:wrap">${tabBar}</div>
<div style="max-width:640px;display:flex;flex-direction:column;gap:1.25rem">

<div class="card">
  <div style="font-weight:700;margin-bottom:.5rem">Send Push Notification</div>
  <p class="muted" style="font-size:.83rem;margin-bottom:.75rem">Subscribers: <strong>${settings.subscription_count||0}</strong></p>
  <div id="push-msg"></div>
  <div class="form-group"><label class="form-label">Title</label>
    <input class="form-input" id="push-title" placeholder="🔥 New Deal Available!"></div>
  <div class="form-group"><label class="form-label">Body</label>
    <textarea class="form-input" id="push-body" rows="3" placeholder="Netflix 4K • 1 Year • Only ₹699 — Shop now!"></textarea></div>
  <div class="form-group"><label class="form-label">URL (on click)</label>
    <input class="form-input" id="push-url" placeholder="/"></div>
  <button class="btn btn-primary" onclick="sendPushNow()">Send to All Subscribers</button>
</div>

<div class="card">
  <div style="font-weight:700;margin-bottom:.5rem">Notification History</div>
  <div id="push-history"><div class="spinner"></div></div>
</div>

</div>`);

      window.sendPushNow = async () => {
        const msg = document.getElementById('push-msg');
        const title = document.getElementById('push-title').value.trim();
        const body = document.getElementById('push-body').value.trim();
        const url = document.getElementById('push-url').value.trim() || '/';
        if (!title || !body) { msg.innerHTML='<div class="alert alert-error">Title and body required</div>'; return; }
        if (!confirm(`Send push notification to all subscribers?`)) return;
        msg.innerHTML='<div class="alert alert-info">Sending…</div>';
        try {
          const r = await api('/push-notifications/send', { method:'POST', body: JSON.stringify({ title, body, url }) });
          msg.innerHTML=`<div class="alert alert-success">Sent: ${r.success}/${r.total}</div>`;
          loadPushHistory();
        } catch(e) { msg.innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
      };

      async function loadPushHistory() {
        const el = document.getElementById('push-history');
        try {
          const hist = await api('/push-notifications');
          el.innerHTML = hist.length ? `<div class="table-wrap"><table>
            <thead><tr><th>Title</th><th>Sent</th><th>Success</th><th>Date</th></tr></thead>
            <tbody>${hist.map(n=>`<tr>
              <td>${esc(n.title)}</td>
              <td>${n.total}</td>
              <td><span class="badge badge-green">${n.success_count}</span></td>
              <td style="font-size:.8rem">${fmtDate(n.sent_at)}</td>
            </tr>`).join('')}</tbody>
          </table></div>` : '<p class="muted">No notifications sent yet.</p>';
        } catch(e) { el.innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
      }
      loadPushHistory();

    } else if (tab === 'subscribers') {
      const subs = await api('/push-subscriptions');
      setMain(`
<h2 style="font-weight:800;margin-bottom:1rem">App Manager (PWA)</h2>
<div style="display:flex;gap:.5rem;margin-bottom:1.25rem;flex-wrap:wrap">${tabBar}</div>
<div style="max-width:860px">
  <div style="font-weight:700;margin-bottom:.75rem">Push Subscribers (${subs.length})</div>
  ${subs.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Device / Browser</th><th>Endpoint (short)</th><th>Subscribed</th><th></th></tr></thead>
    <tbody>${subs.map(s=>`<tr>
      <td style="font-size:.83rem">${esc(s.user_agent||'Unknown')}</td>
      <td style="font-family:monospace;font-size:.75rem;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.endpoint.split('/').slice(-1)[0].slice(0,24)+'…')}</td>
      <td style="font-size:.8rem">${fmtDate(s.created_at)}</td>
      <td><button class="btn btn-sm btn-red" onclick="delSub(${s.id})">Remove</button></td>
    </tr>`).join('')}</tbody>
  </table></div>` : '<p class="muted">No subscribers yet. Install the PWA and allow notifications.</p>'}
</div>`);

      window.delSub = async (id) => {
        if (!confirm('Remove this subscriber?')) return;
        await api(`/push-subscriptions/${id}`, { method:'DELETE' });
        views['pwa-manager']('subscribers');
      };
    }

  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

// ── views['store-theme'] ──────────────────────────────────────────────────────
views['store-theme'] = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const s = await api('/store-theme');
    const current = s.theme || 'midnight-purple';

    const THEMES = [
      { id:'midnight-purple', label:'Midnight Purple',   bg:'#0d1117', card:'#161b2e', a1:'#7c3aed', a2:'#a855f7', text:'#e2e8f0', dark:true  },
      { id:'neon-dark',       label:'Neon Dark',         bg:'#0a0a0f', card:'#12121e', a1:'#00ff94', a2:'#00d4ff', text:'#f0fdf4', dark:true  },
      { id:'ocean-deep',      label:'Ocean Deep',        bg:'#061e2f', card:'#0a2540', a1:'#0ea5e9', a2:'#38bdf8', text:'#e0f2fe', dark:true  },
      { id:'cosmic',          label:'Cosmic',            bg:'#050d1a', card:'#0d1630', a1:'#8b5cf6', a2:'#3b82f6', text:'#ede9fe', dark:true  },
      { id:'sunset-glow',     label:'Sunset Glow',       bg:'#1a0d05', card:'#2a1508', a1:'#f97316', a2:'#ef4444', text:'#fff7ed', dark:true  },
      { id:'forest-dark',     label:'Forest Dark',       bg:'#051a0d', card:'#0a2e18', a1:'#22c55e', a2:'#10b981', text:'#f0fdf4', dark:true  },
      { id:'royal-gold',      label:'Royal Gold',        bg:'#0d0a00', card:'#1e1800', a1:'#f59e0b', a2:'#fbbf24', text:'#fffbeb', dark:true  },
      { id:'rose-noir',       label:'Rose Noir',         bg:'#1a050e', card:'#2a0a1a', a1:'#f43f5e', a2:'#ec4899', text:'#fff1f2', dark:true  },
      { id:'arctic-light',    label:'Arctic Light',      bg:'#f0f4f8', card:'#ffffff', a1:'#0ea5e9', a2:'#6366f1', text:'#0f172a', dark:false },
      { id:'sakura',          label:'Sakura',            bg:'#fff5f7', card:'#ffffff', a1:'#f43f5e', a2:'#ec4899', text:'#1e0010', dark:false },
      { id:'slate-minimal',   label:'Slate Minimal',     bg:'#f8fafc', card:'#ffffff', a1:'#475569', a2:'#334155', text:'#0f172a', dark:false },
      { id:'cyberpunk',       label:'Cyberpunk',         bg:'#0d0017', card:'#160028', a1:'#ff00ff', a2:'#00ffff', text:'#f0e6ff', dark:true  },
      { id:'aurora-teal',     label:'Aurora Teal',       bg:'#020d12', card:'#061824', a1:'#14b8a6', a2:'#06b6d4', text:'#ccfbf1', dark:true  },
      { id:'volcano',         label:'Volcano',           bg:'#160800', card:'#240e00', a1:'#f97316', a2:'#dc2626', text:'#fff7ed', dark:true  },
      { id:'lavender-mist',   label:'Lavender Mist',     bg:'#f5f0ff', card:'#ffffff', a1:'#7c3aed', a2:'#a855f7', text:'#1e0050', dark:false },
      { id:'navy-classic',    label:'Navy Classic',      bg:'#001233', card:'#001e4d', a1:'#3b82f6', a2:'#1d4ed8', text:'#dbeafe', dark:true  },
      { id:'emerald-city',    label:'Emerald City',      bg:'#022c22', card:'#044034', a1:'#059669', a2:'#10b981', text:'#d1fae5', dark:true  },
      { id:'crystal-clean',   label:'Crystal Clean',     bg:'#ffffff', card:'#f8fafc', a1:'#2563eb', a2:'#4f46e5', text:'#0f172a', dark:false },
      { id:'obsidian-gold',   label:'Obsidian Gold',     bg:'#0c0c0c', card:'#1a1a1a', a1:'#f59e0b', a2:'#d97706', text:'#fef9c3', dark:true  },
      { id:'electric-blue',   label:'Electric Blue',     bg:'#000a1a', card:'#00122e', a1:'#2563eb', a2:'#3b82f6', text:'#dbeafe', dark:true  },
      { id:'crimson-tide',    label:'Crimson Tide',      bg:'#0d0000', card:'#1f0000', a1:'#dc2626', a2:'#ef4444', text:'#fee2e2', dark:true  },
      { id:'teal-ocean',      label:'Teal Ocean',        bg:'#01151e', card:'#00253a', a1:'#0891b2', a2:'#0ea5e9', text:'#e0f2fe', dark:true  },
      { id:'movieverse',      label:'MovieVerse 🎬',     bg:'#04030a', card:'#0a0816', a1:'#ff2a4d', a2:'#ffd36a', text:'#fff8f2', dark:true  },
    ];

    // Mini-page mockup: brand row + hero gradient + price/title text + 2 buttons + card row.
    // MovieVerse gets a cinema-specific tweak — gold accent + a reel glyph in the hero.
    const cards = THEMES.map(t => {
      const isCurrent = t.id === current;
      const accentText = t.dark ? '#fff' : t.text;
      const subText = t.dark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.6)';
      const cardLine = t.dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
      const border = isCurrent ? `3px solid ${t.a1}` : `1.5px solid ${t.dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.12)'}`;
      const shadow = isCurrent ? `0 0 0 3px ${t.a1}55, 0 10px 30px ${t.a1}33` : '0 4px 14px rgba(0,0,0,0.18)';
      const checkmark = isCurrent ? `<div style="position:absolute;top:10px;right:10px;background:${t.a1};color:#fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;box-shadow:0 4px 12px ${t.a1}55;z-index:2">✓</div>` : '';
      const isMv = t.id === 'movieverse';
      const heroExtras = isMv ? `<div style="position:absolute;left:8px;bottom:6px;width:18px;height:18px;border-radius:50%;background:conic-gradient(from 0deg,${t.a2},${t.a1},${t.a2});border:2px solid rgba(255,255,255,.5);opacity:.85"></div>` : '';
      return `
<div data-theme-tile="${t.id}" style="cursor:pointer;border-radius:18px;overflow:hidden;border:${border};box-shadow:${shadow};transition:all .25s;position:relative;background:${t.bg}">
  ${checkmark}
  <!-- Brand bar -->
  <div style="position:relative;height:84px;background:linear-gradient(135deg,${t.a1},${t.a2});display:flex;align-items:center;gap:9px;padding:0 14px">
    <div style="width:30px;height:30px;border-radius:8px;background:rgba(255,255,255,.32);border:1.5px solid rgba(255,255,255,.55);display:grid;place-items:center;color:#fff;font-weight:900;font-size:13px">${isMv ? '▶' : 'O'}</div>
    <div style="flex:1;min-width:0">
      <div style="height:7px;border-radius:4px;background:rgba(255,255,255,0.55);width:70%;margin-bottom:5px"></div>
      <div style="height:5px;border-radius:3px;background:rgba(255,255,255,0.3);width:45%"></div>
    </div>
    ${heroExtras}
  </div>
  <!-- Mock hero card -->
  <div style="padding:14px 12px 10px;background:${t.card}">
    <div style="height:7px;border-radius:4px;background:linear-gradient(90deg,${t.a1},${t.a2});width:62%;margin-bottom:6px"></div>
    <div style="height:5px;border-radius:3px;background:${t.dark?'rgba(255,255,255,0.18)':'rgba(0,0,0,0.16)'};width:90%;margin-bottom:5px"></div>
    <div style="height:5px;border-radius:3px;background:${t.dark?'rgba(255,255,255,0.12)':'rgba(0,0,0,0.1)'};width:70%;margin-bottom:10px"></div>
    <div style="display:flex;gap:6px">
      <div style="flex:1;height:24px;border-radius:7px;background:linear-gradient(135deg,${t.a1},${t.a2});box-shadow:0 4px 10px ${t.a1}55"></div>
      <div style="flex:1;height:24px;border-radius:7px;background:transparent;border:1.5px solid ${t.dark?'rgba(255,255,255,.22)':'rgba(0,0,0,.18)'}"></div>
    </div>
  </div>
  <!-- Mock card row -->
  <div style="padding:0 12px 12px;background:${t.card}">
    <div style="border-top:1px dashed ${cardLine};padding-top:10px;margin-top:4px;display:flex;align-items:center;gap:8px">
      <div style="width:24px;height:24px;border-radius:6px;background:linear-gradient(135deg,${t.a1}22,${t.a2}33);border:1px solid ${t.a1}55"></div>
      <div style="flex:1">
        <div style="height:5px;border-radius:3px;background:${t.dark?'rgba(255,255,255,0.22)':'rgba(0,0,0,0.18)'};width:65%;margin-bottom:3px"></div>
        <div style="height:4px;border-radius:2px;background:${t.dark?'rgba(255,255,255,0.12)':'rgba(0,0,0,0.1)'};width:42%"></div>
      </div>
      <div style="font-size:10px;font-weight:800;padding:3px 6px;border-radius:999px;background:linear-gradient(135deg,${t.a1},${t.a2});color:#fff">₹99</div>
    </div>
  </div>
  <!-- Footer with theme label + buttons -->
  <div style="padding:10px 12px;background:${t.bg};border-top:1px solid ${cardLine};display:flex;align-items:center;justify-content:space-between;gap:6px">
    <div style="min-width:0;flex:1">
      <div style="font-size:13px;font-weight:800;color:${accentText};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.label)}</div>
      <div style="font-size:10px;color:${isCurrent ? t.a1 : subText};margin-top:1px;font-weight:600">${isCurrent ? '● Active' : 'Tap to apply'}</div>
    </div>
    <button data-theme-apply="${t.id}" style="border:0;cursor:pointer;font-size:10px;font-weight:800;padding:6px 9px;border-radius:7px;color:#fff;background:linear-gradient(135deg,${t.a1},${t.a2});box-shadow:0 4px 12px ${t.a1}44">Apply</button>
  </div>
</div>`;
    }).join('');

    const currentMeta = THEMES.find(t=>t.id===current) || { label: current, a1: '#6366f1', a2: '#8b5cf6', bg: '#0d1117' };
    setMain(`
<h2 style="font-weight:800;margin-bottom:.25rem">Theme Settings</h2>
<p style="color:var(--muted);margin-bottom:1.5rem;font-size:.9rem">Pick a visual skin for your storefront. The Default theme is your current site; <strong>MovieVerse 🎬</strong> swaps the home page to a cinematic movie-store layout and re-skins every public page. Changes are live for all visitors immediately.</p>
<div id="theme-msg"></div>
<div style="background:linear-gradient(135deg,${currentMeta.a1}18,${currentMeta.a2}18);border:1px solid ${currentMeta.a1}44;border-radius:14px;padding:1.1rem 1.25rem;margin-bottom:1.5rem;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
  <div style="width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg,${currentMeta.a1},${currentMeta.a2});display:grid;place-items:center;font-size:20px;color:#fff;font-weight:900;box-shadow:0 6px 18px ${currentMeta.a1}55">${current === 'movieverse' ? '🎬' : '🎨'}</div>
  <div style="flex:1;min-width:160px">
    <div style="font-weight:800;font-size:1rem">Active Theme: <span style="color:${currentMeta.a1}">${esc(currentMeta.label)}</span></div>
    <div style="font-size:.78rem;color:var(--muted);margin-top:2px">Theme ID: <code>${esc(current)}</code></div>
  </div>
  <a href="/" target="_blank" class="btn btn-sm btn-secondary">Preview Storefront ↗</a>
</div>
<div id="theme-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px">
${cards}
</div>
<style>
  #theme-grid [data-theme-tile]:hover { transform:translateY(-4px); }
</style>`);

    // Wire up tile + apply-button clicks (replaces inline onclick="setTheme(...)").
    const grid = document.getElementById('theme-grid');
    if (grid) {
      grid.addEventListener('click', (e) => {
        const applyBtn = e.target.closest('[data-theme-apply]');
        if (applyBtn) { e.stopPropagation(); window.setTheme(applyBtn.dataset.themeApply); return; }
        const tile = e.target.closest('[data-theme-tile]');
        if (tile) window.setTheme(tile.dataset.themeTile);
      });
    }

    window.setTheme = async function(id) {
      const theme = THEMES.find(t => t.id === id);
      if (!theme) return;
      const msg = document.getElementById('theme-msg');
      try {
        await api('/store-theme', { method:'POST', body: JSON.stringify({ theme: id }) });
        if (msg) { msg.innerHTML = `<div class="alert alert-success">Theme updated successfully — ${esc(theme.label)} is now live.</div>`; setTimeout(() => { if (msg) msg.innerHTML = ''; }, 4000); }
        showToast(`Theme applied: ${theme.label}`);
        views['store-theme']();
      } catch(e) { showToast(e.message, 'error'); }
    };

  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

// ── Logo upload helpers ───────────────────────────────────────────────────────
async function uploadLogo(type, input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { showToast('File too large. Max 2MB allowed.', 'error'); input.value = ''; return; }
  const fd = new FormData();
  fd.append('logo', file);
  try {
    showToast('Uploading…');
    const r = await fetch(`/admin/api/upload-logo/${type}`, { method: 'POST', body: fd, credentials: 'include', headers: { 'X-CSRF-Token': getCsrfToken() } });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Upload failed');
    const preview = document.getElementById(`logo-${type}-preview`);
    if (preview) preview.innerHTML = `<img src="${j.url}?t=${Date.now()}" style="max-height:48px;max-width:100%;object-fit:contain">`;
    showToast('Logo uploaded!');
  } catch (e) { showToast(e.message, 'error'); }
  input.value = '';
}

async function deleteLogo(type) {
  if (!confirm('Remove this logo?')) return;
  try {
    const r = await fetch(`/admin/api/upload-logo/${type}`, { method: 'DELETE', credentials: 'include', headers: { 'X-CSRF-Token': getCsrfToken() } });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    const preview = document.getElementById(`logo-${type}-preview`);
    if (preview) preview.innerHTML = '<span style="font-size:.75rem;color:var(--muted)">No logo</span>';
    showToast('Logo removed');
  } catch (e) { showToast(e.message, 'error'); }
}

// ── expose goView globally ────────────────────────────────────────────────────
window.goView = goView;
window.views = views;
window.uploadLogo = uploadLogo;
window.deleteLogo = deleteLogo;

// ── Hash-based routing: handle browser back/forward ───────────────────────────
window.addEventListener('popstate', () => {
  const id = location.hash.replace('#', '').trim();
  const validViews = MENU.filter(m => m.id).map(m => m.id);
  if (validViews.includes(id) && id !== ACTIVE_VIEW) {
    ACTIVE_VIEW = id;
    document.getElementById('topbar-title').textContent = MENU.find(m => m.id === id)?.label || id;
    buildSidebar();
    const fn = views[id];
    if (fn) fn();
  }
});

// ── Kick off ──────────────────────────────────────────────────────────────────
initAdmin();
