'use strict';
// ─── OTT Store Admin SPA ──────────────────────────────────────────────────────

// ── State ─────────────────────────────────────────────────────────────────────
let ACTIVE_VIEW = 'dashboard';
let PENDING_TOPUPS = 0, PENDING_ORDERS = 0;

const MENU = [
  { group: 'OVERVIEW' },
  { id: 'dashboard',   label: 'Dashboard',    icon: '📊' },
  { group: 'CATALOG' },
  { id: 'plans',       label: 'Plans',        icon: '🎬' },
  { group: 'SALES' },
  { id: 'orders',      label: 'Orders',       icon: '📦' },
  { id: 'topups',      label: 'Top-ups',      icon: '💳' },
  { id: 'customers',   label: 'Customers',    icon: '👥' },
  { group: 'STOREFRONT' },
  { id: 'mystore',     label: 'My Store',     icon: '🏪' },
  { id: 'payments',    label: 'Payments',     icon: '💰' },
  { id: 'tickets',     label: 'Support',      icon: '🎧' },
  { id: 'blog',        label: 'Blog CMS',     icon: '✍️' },
  { id: 'seo',         label: 'SEO',          icon: '🔍' },
  { id: 'googleindex', label: 'Google Index', icon: '🌐' },
  { group: 'ACCOUNT' },
  { id: 'settings',    label: 'Settings',     icon: '⚙️' },
  { id: 'auditlog',    label: 'Audit Log',    icon: '📋' },
  { id: 'backup',      label: 'DB Backup',    icon: '💾' },
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
    goView('dashboard');
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
<div class="modal-footer">
  <button class="btn btn-secondary" data-close>Cancel</button>
  <button class="btn btn-primary" id="save-order-btn">Save Changes</button>
</div>`);

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

// ── expose goView globally ────────────────────────────────────────────────────
window.goView = goView;
window.views = views;

// ── Kick off ──────────────────────────────────────────────────────────────────
initAdmin();
