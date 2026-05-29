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
  { group: 'SALES' },
  { id: 'orders',         label: 'Orders',        icon: '🛒' },
  { id: 'topups',         label: 'Top-ups',       icon: '💳' },
  { id: 'customers',      label: 'Customers',     icon: '👥' },
  { id: 'resellers',      label: 'Resellers',     icon: '🤝' },
  { id: 'referrals',      label: 'Referrals',     icon: '🔗' },
  { group: 'WHATSAPP' },
  { id: 'whatsapp',       label: 'WA Bot',        icon: '💬' },
  { id: 'wa-offers',      label: 'WA Offers',     icon: '📋' },
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
function fmtDate(s) { if (!s) return '—'; try { return new Date(s).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return s; } }
function fmtDateShort(s) { if (!s) return '—'; try { return new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return s; } }

function statusBadge(s) {
  const map = { pending:'badge-yellow', processing:'badge-blue', delivered:'badge-green', expired:'badge-grey', cancelled:'badge-red', open:'badge-blue', closed:'badge-grey', approved:'badge-green', rejected:'badge-red' };
  return `<span class="badge ${map[s] || 'badge-grey'}">${esc(s)}</span>`;
}

async function api(path, opts = {}) {
  const res = await fetch('/admin/api' + path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  if (res.status === 401) { renderLogin(); throw new Error('Unauthorized'); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
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
applyTheme(document.documentElement.getAttribute('data-theme') || 'light');

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
  await fetch('/admin/api/logout', { method: 'POST', credentials: 'include' });
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
    <button type="submit" class="btn btn-primary btn-block">Login</button>
  </form>
</div>`;
  document.getElementById('admin-login-form').onsubmit = async e => {
    e.preventDefault();
    const err = document.getElementById('login-err');
    try {
      await api('/login', { method: 'POST', body: JSON.stringify({ password: document.getElementById('admin-pass').value }) });
      loginEl.style.display = 'none';
      document.getElementById('admin-wrap').style.display = '';
      initAdmin();
    } catch (ex) { err.innerHTML = `<div class="alert alert-error">${esc(ex.message)}</div>`; }
  };
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function initAdmin() {
  try {
    await api('/me');
    // Load pending counts
    try {
      const dash = await api('/dashboard');
      PENDING_TOPUPS = dash.pending_topups || 0;
      PENDING_ORDERS = dash.pending_orders || 0;
    } catch {}
    buildSidebar();
    // Restore view from URL hash, fallback to dashboard
    const hashView = location.hash.replace('#', '').trim();
    const validViews = MENU.filter(m => m.id).map(m => m.id);
    goView(validViews.includes(hashView) ? hashView : 'dashboard');
  } catch { renderLogin(); }
}

// ─── Views ────────────────────────────────────────────────────────────────────
const views = {};

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
views.plans = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const plans = await api('/plans');
    renderPlansTable(plans);
  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

function renderPlansTable(plans) {
  const rows = plans.map(p => `
<tr>
  <td>${p.id}</td>
  <td>${esc(p.platform)}</td>
  <td style="font-weight:600">${esc(p.name)}</td>
  <td>${p.duration_days ? p.duration_days + 'd' : '∞'}</td>
  <td>${fmt(p.price_inr)}</td>
  <td>${p.stock === -1 ? '∞' : p.stock}</td>
  <td>${p.badge ? `<span class="badge badge-purple">${esc(p.badge)}</span>` : '—'}</td>
  <td>
    <label class="toggle-switch"><input type="checkbox" ${p.active ? 'checked' : ''} onchange="togglePlan(${p.id})"><span class="toggle-slider"></span></label>
  </td>
  <td>
    <button class="btn btn-secondary btn-sm" onclick="editPlan(${p.id})">Edit</button>
    <button class="btn btn-red btn-sm" onclick="deletePlan(${p.id})">Del</button>
  </td>
</tr>`).join('');

  setMain(`
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem">
  <h2 style="font-weight:800">OTT Plans</h2>
  <button class="btn btn-primary" onclick="openPlanModal()">+ Add Plan</button>
</div>
<div class="table-wrap"><table>
  <thead><tr><th>ID</th><th>Platform</th><th>Name</th><th>Duration</th><th>Price</th><th>Stock</th><th>Badge</th><th>Active</th><th>Actions</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="9" class="muted" style="text-align:center;padding:2rem">No plans yet. Add your first plan!</td></tr>'}</tbody>
</table></div>`);
}

const PLATFORMS = ['Netflix', 'Amazon Prime', 'Disney+', 'Sony LIV', 'Zee5', 'Hotstar', 'JioCinema', 'MX Player', 'Apple TV+', 'Voot', 'Other'];

window.openPlanModal = function (plan = null) {
  const f = plan || {};
  const features = Array.isArray(f.features) ? f.features : [];
  const isEdit = !!plan;

  const ov = openModal(`
<div class="modal-header"><h3>${isEdit ? 'Edit' : 'New'} Plan</h3><button class="btn-icon" data-close>✕</button></div>
<div class="modal-body" style="max-height:70vh;overflow-y:auto">
  <div id="plan-err"></div>
  <div class="form-row">
    <div class="form-group">
      <label class="form-label">Platform *</label>
      <select class="form-input" id="pf-platform">
        ${PLATFORMS.map(p => `<option ${f.platform === p ? 'selected' : ''}>${p}</option>`).join('')}
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Badge</label>
      <select class="form-input" id="pf-badge">
        <option value="" ${!f.badge ? 'selected' : ''}>None</option>
        ${['POPULAR','BEST VALUE','NEW','HOT'].map(b => `<option ${f.badge === b ? 'selected' : ''}>${b}</option>`).join('')}
      </select>
    </div>
  </div>
  <div class="form-group"><label class="form-label">Plan Name *</label><input class="form-input" id="pf-name" value="${esc(f.name || '')}" placeholder="e.g. Netflix 4K — 1 Month"></div>
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
    <div class="form-group" style="justify-content:flex-end;align-items:center;flex-direction:row;gap:.75rem;padding-top:1.5rem">
      <label class="form-label">Active</label>
      <label class="toggle-switch"><input type="checkbox" id="pf-active" ${f.active !== 0 ? 'checked' : ''}><span class="toggle-slider"></span></label>
    </div>
  </div>
</div>
<div class="modal-footer">
  <button class="btn btn-secondary" data-close>Cancel</button>
  <button class="btn btn-primary" id="save-plan-btn">${isEdit ? 'Update' : 'Create'} Plan</button>
</div>`);

  document.getElementById('feat-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addFeature(); } });

  document.getElementById('save-plan-btn').addEventListener('click', async () => {
    const body = {
      platform: document.getElementById('pf-platform').value,
      name: document.getElementById('pf-name').value.trim(),
      duration_days: parseInt(document.getElementById('pf-duration').value) || null,
      price_inr: parseFloat(document.getElementById('pf-price').value) || 0,
      original_price_inr: parseFloat(document.getElementById('pf-orig').value) || null,
      description: document.getElementById('pf-desc').value.trim(),
      features: getFeatures(),
      badge: document.getElementById('pf-badge').value || null,
      stock: parseInt(document.getElementById('pf-stock').value) ?? -1,
      active: document.getElementById('pf-active').checked ? 1 : 0,
      sort_order: parseInt(document.getElementById('pf-sort').value) || 0,
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
    <button class="btn btn-secondary btn-sm" onclick="openOrderModal(${JSON.stringify(esc(JSON.stringify(o)))})">Manage</button>
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

window.openOrderModal = function (orderJson) {
  const o = JSON.parse(orderJson);
  const creds = o.credentials || {};
  const credFields = ['username', 'password', 'pin', 'email', 'notes'].map(k => `
<div class="form-group"><label class="form-label">${k.charAt(0).toUpperCase()+k.slice(1)}</label>
<input class="form-input" id="oc-${k}" value="${esc(creds[k] || '')}" placeholder="${k}"></div>`).join('');

  const ov = openModal(`
<div class="modal-header"><h3>Order #${o.id}</h3><button class="btn-icon" data-close>✕</button></div>
<div class="modal-body" style="max-height:75vh;overflow-y:auto">
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem;background:var(--input-bg);border-radius:var(--radius-sm);padding:.9rem;margin-bottom:.5rem">
    <div><div class="muted" style="font-size:.73rem">CUSTOMER</div><div style="font-weight:600">${esc(o.customer_email||'—')}</div></div>
    <div><div class="muted" style="font-size:.73rem">PLAN</div><div style="font-weight:600">${esc(o.platform||'')} — ${esc(o.plan_name||'')}</div></div>
    <div><div class="muted" style="font-size:.73rem">AMOUNT</div><div style="font-weight:600">${fmt(o.amount_inr)}</div></div>
    <div><div class="muted" style="font-size:.73rem">STATUS</div><div>${statusBadge(o.status)}</div></div>
  </div>
  <div class="form-group">
    <label class="form-label">Status</label>
    <select class="form-input" id="oc-status">
      ${['pending','processing','delivered','expired','cancelled'].map(s=>`<option ${o.status===s?'selected':''}>${s}</option>`).join('')}
    </select>
  </div>
  <div style="font-weight:700;margin:.5rem 0 .25rem">Credentials</div>
  ${credFields}
  <div class="form-group"><label class="form-label">Delivery Note (shown to customer)</label>
    <textarea class="form-input" id="oc-note" rows="2">${esc(o.delivery_note||'')}</textarea></div>
  <div class="form-group"><label class="form-label">Expires At</label>
    <input class="form-input" id="oc-expires" type="datetime-local" value="${o.expires_at ? o.expires_at.replace(' ','T').slice(0,16) : ''}"></div>
</div>
<div class="modal-footer" style="flex-wrap:wrap;gap:.4rem">
  <button class="btn btn-secondary" data-close>Cancel</button>
  <button class="btn btn-secondary" id="copy-creds-btn" title="Copy credentials to clipboard">📋 Copy Creds</button>
  <button class="btn btn-secondary" id="resend-email-btn" title="Re-send delivery email">📧 Resend Email</button>
  <button class="btn btn-secondary" id="wa-deliver-btn" title="Send via WhatsApp">💬 WA Deliver</button>
  <button class="btn btn-primary" id="save-order-btn">Save Changes</button>
</div>`);

  document.getElementById('copy-creds-btn').addEventListener('click', () => {
    const lines = ['username','password','pin','email','notes']
      .map(k => { const v = document.getElementById(`oc-${k}`)?.value.trim(); return v ? `${k}: ${v}` : null; })
      .filter(Boolean);
    if (!lines.length) { showToast('No credentials to copy', 'error'); return; }
    navigator.clipboard.writeText(lines.join('\n')).then(() => showToast('Credentials copied!'));
  });

  document.getElementById('resend-email-btn').addEventListener('click', async () => {
    if (!confirm('Re-send delivery email to customer?')) return;
    try {
      await api(`/orders/${o.id}/resend-email`, { method: 'POST' });
      showToast('Email sent!');
    } catch (ex) { showToast(ex.message, 'error'); }
  });

  document.getElementById('wa-deliver-btn').addEventListener('click', async () => {
    if (!confirm('Send credentials via WhatsApp to customer?')) return;
    try {
      await api(`/orders/${o.id}/wa-deliver`, { method: 'POST' });
      showToast('Sent via WhatsApp!');
    } catch (ex) { showToast(ex.message, 'error'); }
  });

  document.getElementById('save-order-btn').addEventListener('click', async () => {
    const credentials = {};
    ['username','password','pin','email','notes'].forEach(k => {
      const v = document.getElementById(`oc-${k}`)?.value.trim();
      if (v) credentials[k] = v;
    });
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
views.topups = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const topups = await api('/topups?status=pending');
    const all = await api('/topups');
    PENDING_TOPUPS = topups.length; buildSidebar();

    const pendingRows = topups.map(t => `
<tr>
  <td>#${t.id}</td>
  <td>${esc(t.email||'—')}</td>
  <td style="font-weight:700">${fmt(t.amount_inr)}</td>
  <td><span class="badge badge-blue">${esc(t.method)}</span></td>
  <td style="font-size:.8rem">${esc(t.reference||'—')}</td>
  <td>${t.screenshot_url ? `<a href="${esc(t.screenshot_url)}" target="_blank" class="btn btn-secondary btn-sm">View</a>` : '—'}</td>
  <td>${fmtDateShort(t.created_at)}</td>
  <td>
    <button class="btn btn-green btn-sm" onclick="actTopup(${t.id},'approve')">✓ Approve</button>
    <button class="btn btn-red btn-sm" onclick="actTopup(${t.id},'reject')">✗ Reject</button>
  </td>
</tr>`).join('');

    const histRows = all.filter(t=>t.status!=='pending').slice(0,50).map(t=>`
<tr>
  <td>#${t.id}</td>
  <td>${esc(t.email||'—')}</td>
  <td>${fmt(t.amount_inr)}</td>
  <td>${esc(t.method)}</td>
  <td>${statusBadge(t.status)}</td>
  <td>${fmtDateShort(t.created_at)}</td>
</tr>`).join('');

    setMain(`
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem">
  <h2 style="font-weight:800">Top-ups</h2>
  <button class="btn btn-primary" onclick="openManualCreditModal()">+ Manual Credit</button>
</div>
<div class="card" style="margin-bottom:1.5rem">
  <div style="font-weight:700;margin-bottom:.75rem">Pending Approvals ${topups.length?`<span class="pending-dot">${topups.length}</span>`:''}</div>
  <div class="table-wrap"><table>
    <thead><tr><th>ID</th><th>Customer</th><th>Amount</th><th>Method</th><th>Reference</th><th>Screenshot</th><th>Date</th><th>Actions</th></tr></thead>
    <tbody>${pendingRows||'<tr><td colspan="8" class="muted" style="text-align:center;padding:1.5rem">No pending topups</td></tr>'}</tbody>
  </table></div>
</div>
<div class="card">
  <div style="font-weight:700;margin-bottom:.75rem">History</div>
  <div class="table-wrap"><table>
    <thead><tr><th>ID</th><th>Customer</th><th>Amount</th><th>Method</th><th>Status</th><th>Date</th></tr></thead>
    <tbody>${histRows||'<tr><td colspan="6" class="muted" style="text-align:center;padding:1rem">No history</td></tr>'}</tbody>
  </table></div>
</div>`);
  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

window.actTopup = async function (id, action) {
  try {
    await api(`/topups/${id}`, { method: 'PUT', body: JSON.stringify({ action }) });
    showToast(`Topup ${action}d`); views.topups();
  } catch (e) { showToast(e.message, 'error'); }
};

window.openManualCreditModal = function () {
  const ov = openModal(`
<div class="modal-header"><h3>Manual Credit</h3><button class="btn-icon" data-close>✕</button></div>
<div class="modal-body">
  <div id="mc-err"></div>
  <div class="form-group"><label class="form-label">Customer JID or Email</label><input class="form-input" id="mc-jid" placeholder="email_at_domain@email.local or search"></div>
  <div class="form-group"><label class="form-label">Amount (₹)</label><input class="form-input" id="mc-amount" type="number" min="1" placeholder="500"></div>
  <div class="form-group"><label class="form-label">Label</label><input class="form-input" id="mc-label" placeholder="e.g. Bonus credit" value="Admin Credit"></div>
</div>
<div class="modal-footer">
  <button class="btn btn-secondary" data-close>Cancel</button>
  <button class="btn btn-primary" id="mc-btn">Credit Wallet</button>
</div>`);
  document.getElementById('mc-btn').addEventListener('click', async () => {
    let jid = document.getElementById('mc-jid').value.trim();
    if (jid.includes('@') && !jid.endsWith('@email.local')) jid = jid.replace('@','_at_') + '@email.local';
    const amount = parseFloat(document.getElementById('mc-amount').value);
    const label = document.getElementById('mc-label').value.trim();
    if (!jid || !amount) return showToast('JID and amount required', 'error');
    try {
      await api('/topups/manual-credit', { method: 'POST', body: JSON.stringify({ customer_jid: jid, amount, label }) });
      ov.remove(); showToast('Wallet credited!'); views.topups();
    } catch (ex) { document.getElementById('mc-err').innerHTML = `<div class="alert alert-error">${esc(ex.message)}</div>`; }
  });
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
  <td>${fmt(c.wallet_inr)}</td>
  <td>${c.order_count}</td>
  <td>${c.blocked ? '<span class="badge badge-red">Blocked</span>' : '<span class="badge badge-green">Active</span>'}</td>
  <td>${fmtDateShort(c.created_at)}</td>
  <td>
    <button class="btn btn-secondary btn-sm" onclick="openCustomerModal('${esc(c.jid)}')">Edit</button>
  </td>
</tr>`).join('');

    setMain(`
<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.75rem;margin-bottom:1rem">
  <h2 style="font-weight:800">Customers</h2>
  <div style="display:flex;gap:.6rem">
    <input class="form-input" id="cust-search" style="width:220px" placeholder="Search name/email/phone..." value="${esc(q)}" oninput="searchCustomers(this.value)">
  </div>
</div>
<div class="table-wrap"><table>
  <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Wallet</th><th>Orders</th><th>Status</th><th>Joined</th><th>Actions</th></tr></thead>
  <tbody>${rows||'<tr><td colspan="8" class="muted" style="text-align:center;padding:2rem">No customers found</td></tr>'}</tbody>
</table></div>`);
  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

let _custSearchTimer;
window.searchCustomers = function (q) {
  clearTimeout(_custSearchTimer);
  _custSearchTimer = setTimeout(() => views.customers(q), 350);
};

window.openCustomerModal = async function (jid) {
  try {
    const customers = await api(`/customers?q=${encodeURIComponent(jid)}`);
    const c = customers.find(x => x.jid === jid);
    if (!c) return showToast('Customer not found', 'error');

    const ov = openModal(`
<div class="modal-header"><h3>Edit Customer</h3><button class="btn-icon" data-close>✕</button></div>
<div class="modal-body" style="max-height:75vh;overflow-y:auto">
  <div id="cust-err"></div>
  <div class="form-row">
    <div class="form-group"><label class="form-label">Name</label><input class="form-input" id="cm-name" value="${esc(c.name||'')}"></div>
    <div class="form-group"><label class="form-label">Email</label><input class="form-input" id="cm-email" value="${esc(c.email||'')}"></div>
  </div>
  <div class="form-row">
    <div class="form-group"><label class="form-label">Phone</label><input class="form-input" id="cm-phone" value="${esc(c.phone||'')}"></div>
    <div class="form-group"><label class="form-label">Wallet (₹)</label><input class="form-input" id="cm-wallet" type="number" step="0.01" value="${c.wallet_inr||0}"></div>
  </div>
  <div class="form-row">
    <div class="form-group"><label class="form-label">Discount %</label><input class="form-input" id="cm-disc" type="number" min="0" max="100" value="${c.discount_percent||0}"></div>
    <div class="form-group" style="justify-content:center;align-items:center;flex-direction:row;gap:.75rem;padding-top:1.3rem">
      <label class="form-label">Blocked</label>
      <label class="toggle-switch"><input type="checkbox" id="cm-blocked" ${c.blocked?'checked':''}><span class="toggle-slider"></span></label>
    </div>
  </div>
  <hr style="border-color:var(--border);margin:.5rem 0">
  <div class="form-group"><label class="form-label">Reset Password</label>
    <div style="display:flex;gap:.5rem">
      <input class="form-input" id="cm-newpass" type="password" placeholder="New password (leave blank to skip)">
      <button class="btn btn-secondary btn-sm" onclick="resetCustPass('${esc(jid)}')">Set</button>
    </div>
  </div>
  <p style="font-size:.78rem;color:var(--muted)">JID: ${esc(c.jid)}</p>
</div>
<div class="modal-footer">
  <button class="btn btn-secondary" data-close>Cancel</button>
  <button class="btn btn-green btn-sm" onclick="loginAsCustomer('${esc(jid)}')">Login As</button>
  <button class="btn btn-primary" id="save-cust-btn">Save</button>
</div>`);

    document.getElementById('save-cust-btn').addEventListener('click', async () => {
      try {
        await api(`/customers/${encodeURIComponent(jid)}`, { method: 'PUT', body: JSON.stringify({
          name: document.getElementById('cm-name').value,
          email: document.getElementById('cm-email').value,
          phone: document.getElementById('cm-phone').value,
          wallet_inr: parseFloat(document.getElementById('cm-wallet').value),
          discount_percent: parseFloat(document.getElementById('cm-disc').value),
          blocked: document.getElementById('cm-blocked').checked ? 1 : 0,
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
  <div class="form-group"><label class="form-label">Logo URL</label><input class="form-input" name="logo_url" value="${esc(s.logo_url||'')}" placeholder="https://..."></div>
  <div class="form-row">
    <div class="form-group"><label class="form-label">Support Email</label><input class="form-input" name="support_email" type="email" value="${esc(s.support_email||'')}"></div>
    <div class="form-group"><label class="form-label">WhatsApp Support</label><input class="form-input" name="support_whatsapp" value="${esc(s.support_whatsapp||'')}" placeholder="+91..."></div>
  </div>
  <div class="form-group"><label class="form-label">Announcement Banner</label><textarea class="form-input" name="announcement" rows="2" placeholder="Shown in customer dashboard">${esc(s.announcement||'')}</textarea></div>
  <div class="form-group"><label class="form-label">Timezone</label>
    <select class="form-input" name="timezone">
      ${['Asia/Kolkata','Asia/Dubai','Asia/Singapore','America/New_York','Europe/London'].map(tz=>`<option ${s.timezone===tz?'selected':''}>${tz}</option>`).join('')}
    </select>
  </div>
  <div class="form-group"><label class="form-label">Base URL</label><input class="form-input" name="base_url" value="${esc(s.base_url||'')}" placeholder="https://store.watshop.in"></div>
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

// ── views.payments ────────────────────────────────────────────────────────────
views.payments = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const s = await api('/settings');
    setMain(`
<h2 style="font-weight:800;margin-bottom:1.5rem">Payment Methods</h2>
<div class="card" style="max-width:640px">
<form id="pay-form" style="display:flex;flex-direction:column;gap:1.1rem">
  <div id="pay-msg"></div>
  <div style="font-weight:700">Razorpay</div>
  <div style="display:flex;align-items:center;gap:.75rem">
    <label class="toggle-switch"><input type="checkbox" name="razorpay_enabled" id="rz-toggle" ${s.razorpay_enabled==='1'?'checked':''}><span class="toggle-slider"></span></label>
    <label class="form-label" for="rz-toggle">Enable Razorpay</label>
  </div>
  <div class="form-row">
    <div class="form-group"><label class="form-label">Key ID</label><input class="form-input" name="razorpay_key_id" value="${esc(s.razorpay_key_id||'')}" placeholder="rzp_live_..."></div>
    <div class="form-group"><label class="form-label">Key Secret</label><input class="form-input" name="razorpay_key_secret" type="password" value="${esc(s.razorpay_key_secret||'')}"></div>
  </div>
  <hr style="border-color:var(--border)">
  <div style="font-weight:700">Manual UPI</div>
  <div style="display:flex;align-items:center;gap:.75rem">
    <label class="toggle-switch"><input type="checkbox" name="upi_manual_enabled" id="upi-toggle" ${s.upi_manual_enabled!=='0'?'checked':''}><span class="toggle-slider"></span></label>
    <label class="form-label" for="upi-toggle">Enable Manual UPI</label>
  </div>
  <div class="form-row">
    <div class="form-group"><label class="form-label">UPI ID</label><input class="form-input" name="upi_id" value="${esc(s.upi_id||'')}" placeholder="yourname@upi"></div>
    <div class="form-group"><label class="form-label">Display Name</label><input class="form-input" name="upi_name" value="${esc(s.upi_name||'')}" placeholder="Store Name"></div>
  </div>
  <button type="submit" class="btn btn-primary">Save Payment Settings</button>
</form></div>`);
    document.getElementById('pay-form').onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = { razorpay_enabled: document.getElementById('rz-toggle').checked ? '1' : '0', upi_manual_enabled: document.getElementById('upi-toggle').checked ? '1' : '0' };
      fd.forEach((v, k) => { if (k !== 'razorpay_enabled' && k !== 'upi_manual_enabled') body[k] = v; });
      try {
        await api('/settings', { method: 'POST', body: JSON.stringify(body) });
        document.getElementById('pay-msg').innerHTML = '<div class="alert alert-success">Saved!</div>';
        setTimeout(() => document.getElementById('pay-msg').innerHTML = '', 2500);
      } catch (ex) { document.getElementById('pay-msg').innerHTML = `<div class="alert alert-error">${esc(ex.message)}</div>`; }
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
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem">
  <h2 style="font-weight:800">Blog CMS</h2>
  <button class="btn btn-primary" onclick="openBlogModal()">+ New Post</button>
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
  <div class="form-group"><label class="form-label">Body (Markdown supported)</label><textarea class="form-input" id="bl-body" rows="10" style="font-family:monospace">${esc(p.body||'')}</textarea></div>
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

  document.getElementById('save-blog-btn').addEventListener('click', async () => {
    const body = {
      title: document.getElementById('bl-title').value.trim(),
      slug: document.getElementById('bl-slug').value.trim(),
      body: document.getElementById('bl-body').value,
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
    <div class="form-group"><label class="form-label">GSC Verification Code</label><input class="form-input" name="seo_gsc_verification" value="${esc(s.seo_gsc_verification||'')}" placeholder="google-site-verification=..."></div>
    <div class="form-group"><label class="form-label">Bing Verification</label><input class="form-input" name="seo_bing_verification" value="${esc(s.seo_bing_verification||'')}"></div>
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
  <div style="font-weight:700;margin-bottom:.75rem">SMTP Email</div>
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
  setMain(`
<h2 style="font-weight:800;margin-bottom:1.5rem">Database Backup</h2>
<div class="card" style="max-width:480px;text-align:center;padding:2.5rem">
  <div style="font-size:3rem;margin-bottom:1rem">💾</div>
  <h3 style="margin-bottom:.5rem">Download SQLite Database</h3>
  <p class="muted" style="margin-bottom:1.5rem">Download a full backup of the store database. Keep this safe — it contains all customer and order data.</p>
  <a href="/admin/api/backup/download" class="btn btn-primary" download>⬇️ Download Backup</a>
</div>`);
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
    const refs = await api('/referrals');
    setMain(`
<h2 style="font-weight:800;margin-bottom:1.5rem">Referrals</h2>
<div class="table-wrap"><table>
<thead><tr><th>Referrer</th><th>Referred</th><th>Reward</th><th>Status</th><th>Date</th><th></th></tr></thead>
<tbody>${refs.length ? refs.map(r => `<tr>
  <td>${esc(r.referrer_name||r.referrer_jid||'—')}<br><span class="muted">${esc(r.referrer_email||'')}</span></td>
  <td>${esc(r.referred_name||r.referred_jid||'—')}<br><span class="muted">${esc(r.referred_email||'')}</span></td>
  <td>₹${r.reward_inr}</td>
  <td>${statusBadge(r.status)}</td>
  <td>${fmtDateShort(r.created_at)}</td>
  <td>${r.status==='pending' ? `<button class="btn btn-sm btn-green" onclick="creditRef(${r.id})">Credit</button>` : ''}</td>
</tr>`).join('') : '<tr><td colspan=6 class="muted" style="text-align:center;padding:2rem">No referrals yet</td></tr>'}</tbody></table></div>`);

    window.creditRef = async function(id) {
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
    const campaigns = await api('/autopost');
    const renderMain = () => setMain(`
<div style="display:flex;align-items:center;gap:1rem;margin-bottom:1.5rem">
  <h2 style="font-weight:800;flex:1">Auto-Post Campaigns</h2>
  <button class="btn btn-primary" onclick="newCampaign()">+ New Campaign</button>
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

// ── views.payments (enhanced with IMAP config + payment methods) ───────────────
const _origPaymentsView = views.payments;
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
  <label style="display:flex;align-items:center;gap:.5rem;margin-top:.75rem"><input type="checkbox" id="upi-manual-en" ${s.upi_manual_enabled==='1'?'checked':''}> UPI Manual (screenshot) enabled</label>
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
  <div style="font-weight:700;margin-bottom:.75rem">Razorpay</div>
  <label style="display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem"><input type="checkbox" id="rz-en" ${s.razorpay_enabled==='1'?'checked':''}> Enable Razorpay</label>
  <p class="muted" style="font-size:.85rem">Razorpay keys are configured via environment variables (RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET).</p>
  <button class="btn btn-primary btn-sm mt-3" onclick="saveRz()">Save</button>
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
          upi_manual_enabled: document.getElementById('upi-manual-en').checked ? '1' : '0',
        })});
        msg.innerHTML='<div class="alert alert-success">Saved!</div>';
        setTimeout(()=>msg.innerHTML='',2000);
      } catch(e) { msg.innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
    };

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

    window.saveRz = async () => {
      await api('/settings', { method:'POST', body: JSON.stringify({ razorpay_enabled: document.getElementById('rz-en').checked ? '1' : '0' }) });
      showToast('Saved!');
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

// ── views['wa-offers'] ────────────────────────────────────────────────────────
views['wa-offers'] = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const [offers, settings] = await Promise.all([
      api('/wa-offers'),
      api('/whatsapp/settings'),
    ]);

    const groupsStr = settings.wa_autopost_groups || '[]';

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
    <div style="font-weight:700">Offers (${offers.length})</div>
    <button class="btn btn-sm btn-primary" onclick="addWaOffer()">+ New Offer</button>
  </div>
  <div id="waof-list">
  ${offers.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Text</th><th>Image</th><th>Active</th><th>Last Posted</th><th></th></tr></thead>
    <tbody>${offers.map(o=>`<tr>
      <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(o.text)}</td>
      <td>${o.has_image ? '🖼️ Yes' : '—'}</td>
      <td>${o.active ? '<span class="badge badge-green">On</span>' : '<span class="badge badge-grey">Off</span>'}</td>
      <td style="font-size:.8rem">${fmtDate(o.last_posted_at)}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-sm btn-primary" onclick="postNow(${o.id})">Post Now</button>
        <button class="btn btn-sm btn-secondary" onclick="editWaOffer(${o.id})">Edit</button>
        <button class="btn btn-sm btn-secondary" onclick="cloneWaOffer(${o.id})">Clone</button>
        <button class="btn btn-sm btn-red" onclick="delWaOffer(${o.id})">Del</button>
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

      window.readWaImg = (inp) => {
        const file = inp.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => { document.getElementById('waof-img-b64').value = e.target.result.split(',')[1]; };
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

// ── views['ai-agent'] ─────────────────────────────────────────────────────────
views['ai-agent'] = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const s = await api('/ai-settings');

    setMain(`
<h2 style="font-weight:800;margin-bottom:1.5rem">AI Agent Settings</h2>
<div class="card" style="max-width:680px">
  <div id="ai-msg"></div>
  <p class="muted" style="font-size:.85rem;margin-bottom:1rem">
    Configure an AI assistant that auto-replies to WhatsApp messages (when bot is in human mode).
    Supports Google Gemini and OpenRouter (any free model).
  </p>
  <label style="display:flex;align-items:center;gap:.5rem;margin-bottom:1rem"><input type="checkbox" id="ai-enabled" ${s.ai_enabled==='1'?'checked':''}> Enable AI Auto-Reply on WhatsApp</label>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
    <div class="form-group">
      <label class="form-label">Provider</label>
      <select class="form-input" id="ai-provider">
        <option value="gemini" ${s.ai_provider==='gemini'?'selected':''}>Google Gemini (free tier)</option>
        <option value="openrouter" ${s.ai_provider==='openrouter'?'selected':''}>OpenRouter (any model)</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Model <span class="muted">(leave blank for default)</span></label>
      <input class="form-input" id="ai-model" value="${esc(s.ai_model||'')}" placeholder="gemini-2.0-flash or leave blank">
    </div>
    <div class="form-group">
      <label class="form-label">API Key</label>
      <input class="form-input" type="password" id="ai-key" value="${esc(s.ai_api_key||'')}" placeholder="Google AI Studio or OpenRouter key">
    </div>
    <div class="form-group">
      <label class="form-label">Daily Message Cap</label>
      <input class="form-input" type="number" id="ai-cap" value="${esc(s.ai_daily_cap||'500')}" style="width:100px">
    </div>
  </div>

  <div class="form-group mt-2">
    <label class="form-label">Custom Persona / System Prompt</label>
    <textarea class="form-input" id="ai-persona" rows="5" placeholder="You are a helpful sales assistant for [Store Name]. You help customers with OTT subscription queries...">${esc(s.ai_persona||'')}</textarea>
    <p class="muted mt-1" style="font-size:.8rem">Leave blank to use the default product-aware persona. The AI automatically knows your plans and prices.</p>
  </div>

  <div class="form-group mt-2">
    <label class="form-label">Fallback Message (when AI fails / quota exceeded)</label>
    <input class="form-input" id="ai-fallback" value="${esc(s.ai_fallback_message||'')}" placeholder="Thank you! Our team will get back to you shortly.">
    <p class="muted mt-1" style="font-size:.8rem">Leave blank to stay silent (seller can reply manually).</p>
  </div>

  <button class="btn btn-primary mt-3" onclick="saveAiSettings()">Save AI Settings</button>
</div>`);

    window.saveAiSettings = async () => {
      const msg = document.getElementById('ai-msg');
      try {
        await api('/ai-settings', { method:'POST', body: JSON.stringify({
          ai_enabled: document.getElementById('ai-enabled').checked ? '1' : '0',
          ai_provider: document.getElementById('ai-provider').value,
          ai_model: document.getElementById('ai-model').value,
          ai_api_key: document.getElementById('ai-key').value,
          ai_daily_cap: document.getElementById('ai-cap').value,
          ai_persona: document.getElementById('ai-persona').value,
          ai_fallback_message: document.getElementById('ai-fallback').value,
        })});
        msg.innerHTML='<div class="alert alert-success">Saved!</div>';
        setTimeout(()=>msg.innerHTML='',2000);
      } catch(e) { msg.innerHTML=`<div class="alert alert-error">${esc(e.message)}</div>`; }
    };

  } catch (e) { setMain(`<div class="alert alert-error">${esc(e.message)}</div>`); }
};

// ── views['chat-bot'] ────────────────────────────────────────────────────────
views['chat-bot'] = async function () {
  setMain('<div class="spinner"></div>');
  try {
    const s = await api('/bot-settings');

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

// ── expose goView globally ────────────────────────────────────────────────────
window.goView = goView;
window.views = views;

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
