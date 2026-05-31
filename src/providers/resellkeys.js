'use strict';
// ─────────────────────────────────────────────────────────
//  ResellKeys provider — isolated Playwright driver (ott-store / CommonJS).
//
//  Ported from the reference store.whatsapp-Bot provider. Adapted to ott-store:
//    • credentials + base URL come from SETTINGS (resellkeys_email /
//      resellkeys_password / resellkeys_base_url|api_url), not env vars.
//    • URLs are built from the resolved base using canonical OpenCart routes
//      (verified working for resellkeys.com in the Phase-1 HTTP login test).
//
//  Contract:
//    openSession()                            → { browser, context, page }
//    login(ctx)                               → void   (throws on fail)
//    getWalletBalance(ctx)                    → number (best-effort)
//    placeOrder(ctx, { productUrl, qty })     → { providerOrderRef, status }
//    waitForKeyInline(ctx, ref, opts)         → { status, key? }
//    fetchOrderStatus(ctx, ref)               → 'pending'|'processing'|'complete'|'failed'
//    fetchKey(ctx, ref)                       → string
//    closeSession(ctx)                        → void
//    testLogin()                              → { ok, message, account?, balance? }
//
//  Playwright is imported LAZILY so requiring this module never launches a
//  browser and never breaks boot if Chromium isn't present. Callers MUST
//  closeSession(ctx) in a finally block. Auto-ordering stays gated behind the
//  `fulfillment_enabled` setting — this module is only loaded on demand.
// ─────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

// ─── Lazy Playwright import ──────────────────────────────
let _chromium = null;
async function getChromium() {
  if (_chromium) return _chromium;
  const pw = await import('playwright'); // throws if not installed → caller treats as NO_BROWSER
  _chromium = pw.chromium;
  return _chromium;
}

// ─── Config (from ott-store settings, env fallback) ──────
async function getConfig() {
  const { getDb, get } = require('../db');
  const db = await getDb();
  const s = (k) => get(db, `SELECT value FROM settings WHERE key=?`, [k])?.value || '';
  const base = String(
    s('resellkeys_base_url') || s('resellkeys_api_url') || process.env.RESELLKEYS_BASE_URL || 'https://resellkeys.com'
  ).replace(/\/index\.php.*$/i, '').replace(/\/+$/, '') || 'https://resellkeys.com';
  return {
    base,
    email: s('resellkeys_email') || process.env.RESELLKEYS_EMAIL || '',
    password: s('resellkeys_password') || process.env.RESELLKEYS_PASSWORD || '',
  };
}

// Canonical OpenCart URLs, built from the resolved base.
const U = {
  login: (b) => `${b}/index.php?route=account/login`,
  account: (b) => `${b}/index.php?route=account/account`,
  checkout: (b) => `${b}/index.php?route=checkout/checkout`,
  cart: (b) => `${b}/index.php?route=checkout/cart`,
  orderInfo: (b, ref) => `${b}/index.php?route=account/order/info&order_id=${encodeURIComponent(ref)}`,
  ordersList: (b) => `${b}/index.php?route=account/order`,
};

// ─── Selectors (CSS only — single source of truth) ───────
const SELECTORS = {
  login: {
    emailInput: 'input[name="email"], input[type="email"]',
    passwordInput: 'input[name="password"], input[type="password"]',
    submitButton: 'input[type="submit"][value*="Login" i], button[type="submit"], button:has-text("Login"), button:has-text("Sign in")',
    // Visible only when logged in (OpenCart account/logout link).
    loggedInMarker: 'a[href*="route=account/logout"], a[href*="route=account/account"], a:has-text("Logout"), a:has-text("My Account")',
    errorBanner: '.alert-danger, .alert-warning, .error, [role="alert"]',
  },
  wallet: {
    // Best-effort balance text. Resolved against the account page.
    balanceText: '.wallet-balance, .balance, [data-balance], td:has-text("Balance") + td, :text("Reward Points")',
  },
  product: {
    buyButton: '#button-cart, button#button-cart, button:has-text("ADD TO CART"), button:has-text("Add to Cart"), button:has-text("BUY NOW"), button:has-text("Buy Now"), a:has-text("ADD TO CART"), a:has-text("Add to Cart"), a:has-text("BUY NOW"), a:has-text("Buy Now"), a.btn-cart, button.btn-cart',
    qtyInput: 'input[name="quantity"], input[type="number"][name*="qty"]',
  },
  checkout: {
    cartDropdownCheckout: 'a:has-text("CHECKOUT"), a:has-text("Checkout"), a.btn-checkout, #cart a[href*="route=checkout/checkout"], .dropdown-menu a[href*="checkout"]',
    walletOption: 'input[name="payment_method"][value="free_checkout"], input[name="payment_method"][value*="wallet" i], input[name="payment_method"][value="reward"], input[value="wallet"], input[value="free_checkout"], label:has-text("Free Checkout"), label:has-text("Store Credit"), label:has-text("Wallet"), label:has-text("Account Balance"), label:has-text("Reward Points")',
    agreeCheckbox: 'input[name="agree"], #agree, input[type="checkbox"][value="1"]',
    stepButtons: '#button-payment-method, #button-payment-address, #button-shipping-method, #button-shipping-address, #button-guest, #button-reward, #button-voucher, #button-account, #button-login',
    placeOrderButton: 'button:has-text("PLACE ORDER"), button:has-text("Place Order"), a.btn:has-text("PLACE ORDER"), a:has-text("PLACE ORDER"), #button-confirm, button#button-confirm, button:has-text("Confirm Order"), button:has-text("Confirm"), input[type="submit"][value*="Place" i], input[type="submit"][value*="Confirm" i]',
    successUrlRegex: /checkout\/success|order[_-]?success|thank[-_]?you|route=account\/order\/info|[?&]order_id=\d+/i,
    confirmationMarker: '#content h1:has-text("Order Information"), #content h1:has-text("Your Order Has Been Placed"), #content h1:has-text("Your Order Has Been Processed"), :text("Order Information"), :text("Your order has been placed"), :text("Your order has been processed"), :text("Thank you for your order"), :text("Your Products"), :text("Invoice No"), .alert-success, .order-confirmation, .success',
    orderRefText: '#content p:has-text("Order ID"), #content p:has-text("Invoice"), #content p:has-text("order ID"), #content p:has-text("Order #"), .order-id, [data-order-id], a[href*="order_id="]',
  },
  orderHistory: {
    keyText: '.your-products code, .product-keys code, code.bg-danger, code.bg-light, code.text-danger, .key-code, code.key, code, pre, .license-key, [data-key], textarea.key',
    revealKeyButton: 'button:has-text("Reveal"), button:has-text("Show Key"), a:has-text("View Key")',
    keyPattern: /\b([A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5})\b/,
  },
};

// Allow selector / URL overrides via settings without code edits.
function resolveLoginCfg(base) {
  return {
    url: process.env.RESELLKEYS_LOGIN_URL || U.login(base),
    emailInput: process.env.RESELLKEYS_EMAIL_SELECTOR || SELECTORS.login.emailInput,
    passwordInput: process.env.RESELLKEYS_PASSWORD_SELECTOR || SELECTORS.login.passwordInput,
    submitButton: process.env.RESELLKEYS_SUBMIT_SELECTOR || SELECTORS.login.submitButton,
    loggedInMarker: process.env.RESELLKEYS_LOGGED_IN_SELECTOR || SELECTORS.login.loggedInMarker,
    errorBanner: SELECTORS.login.errorBanner,
  };
}

// ─── Paths (Railway volume-backed data dir) ──────────────
const DATA_DIR = process.env.RESELLKEYS_SESSION_PATH
  ? path.dirname(process.env.RESELLKEYS_SESSION_PATH)
  : path.join(process.cwd(), 'data', 'resellkeys');
const STORAGE_STATE = process.env.RESELLKEYS_SESSION_PATH || path.join(DATA_DIR, 'storage_state.json');
const SCREENSHOT_DIR = process.env.RESELLKEYS_SCREENSHOT_DIR || path.join(DATA_DIR, 'screenshots');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(SCREENSHOT_DIR, { recursive: true }); } catch {}

const HEADLESS = process.env.RESELLKEYS_HEADLESS !== 'false';
const DEFAULT_TIMEOUT_MS = parseInt(process.env.RESELLKEYS_TIMEOUT_MS || '30000', 10);
const LOGIN_SUCCESS_TIMEOUT_MS = 20000;
const NAV_WAIT = 'domcontentloaded';

// ─── Session lifecycle ───────────────────────────────────
async function openSession() {
  const chromium = await getChromium();
  const browser = await chromium.launch({
    headless: HEADLESS,
    // Container-friendly + memory-conscious flags. --disable-dev-shm-usage is
    // essential on small /dev/shm (Railway); --no-sandbox required as non-root
    // isn't guaranteed; gpu/extensions off trims RAM.
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-extensions', '--disable-background-networking'],
  });
  const contextOpts = { viewport: { width: 1280, height: 800 } };
  if (fs.existsSync(STORAGE_STATE)) {
    try { contextOpts.storageState = STORAGE_STATE; } catch {}
  }
  const context = await browser.newContext(contextOpts);
  context.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
  const page = await context.newPage();
  return { browser, context, page };
}

async function closeSession(ctx) {
  if (!ctx) return;
  try { await ctx.context?.close(); } catch {}
  try { await ctx.browser?.close(); } catch {}
}

async function saveStorageState(ctx) {
  try { await ctx.context.storageState({ path: STORAGE_STATE }); }
  catch (e) { console.warn('[resellkeys] saveStorageState failed:', e.message); }
}

async function screenshotOnFailure(ctx, jobId, tag = 'error') {
  if (!ctx?.page) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(SCREENSHOT_DIR, `${jobId || 'nojob'}-${tag}-${ts}.png`);
  try { await ctx.page.screenshot({ path: file, fullPage: true }); return file; }
  catch { return null; }
}

async function describePage(page) {
  try {
    const url = page.url();
    const title = await page.title().catch(() => '?');
    const inputs = await page.$$eval('input', els => els.slice(0, 10).map(i =>
      `${i.tagName.toLowerCase()}[type=${i.type || '?'}${i.name ? ` name=${i.name}` : ''}${i.id ? ` id=${i.id}` : ''}]`)).catch(() => []);
    return `url=${url} · title="${title}" · inputs=[${inputs.join(', ') || 'none'}]`;
  } catch { return 'page state unavailable'; }
}

// ─── isLoggedIn / login ─────────────────────────────────
async function isLoggedIn(page, base) {
  try {
    await page.goto(U.account(base), { waitUntil: NAV_WAIT });
    return await page.locator(SELECTORS.login.loggedInMarker).first().isVisible({ timeout: 3000 }).catch(() => false);
  } catch { return false; }
}

async function login(ctx) {
  const { page } = ctx;
  const { base, email, password } = await getConfig();
  if (!email || !password) throw new Error('ResellKeys email / password not set in Settings');
  const cfg = resolveLoginCfg(base);

  if (await isLoggedIn(page, base)) return; // session reused

  await page.goto(cfg.url, { waitUntil: NAV_WAIT });

  const emailField = page.locator(cfg.emailInput).first();
  try {
    await emailField.waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    const shot = await screenshotOnFailure(ctx, 'login', 'no-email-field');
    throw new Error(`login: email field not found ('${cfg.emailInput}'). State: ${await describePage(page)}.${shot ? ` Screenshot: ${shot}` : ''}`);
  }
  await emailField.fill(email);

  const passwordField = page.locator(cfg.passwordInput).first();
  let pwVisible = await passwordField.isVisible({ timeout: 2000 }).catch(() => false);
  if (!pwVisible) {
    try { await page.click(cfg.submitButton, { timeout: 5000 }); } catch {}
    pwVisible = await passwordField.isVisible({ timeout: 10000 }).catch(() => false);
  }
  if (!pwVisible) {
    const shot = await screenshotOnFailure(ctx, 'login', 'no-password-field');
    throw new Error(`login: password field not found ('${cfg.passwordInput}'). State: ${await describePage(page)}.${shot ? ` Screenshot: ${shot}` : ''}`);
  }
  await passwordField.fill(password);

  await page.click(cfg.submitButton).catch(() => {});
  try {
    await page.waitForSelector(cfg.loggedInMarker, { timeout: LOGIN_SUCCESS_TIMEOUT_MS });
  } catch {
    const bannerErr = await page.locator(cfg.errorBanner).first().textContent({ timeout: 1000 }).catch(() => null);
    const shot = await screenshotOnFailure(ctx, 'login', 'no-logged-in-marker');
    throw new Error(
      `login: credentials submitted but logged-in marker never appeared (${LOGIN_SUCCESS_TIMEOUT_MS}ms). ` +
      (bannerErr ? `Site said: "${bannerErr.trim()}". ` : '') +
      `Likely wrong password, MFA, or a Cloudflare challenge. State: ${await describePage(page)}.${shot ? ` Screenshot: ${shot}` : ''}`
    );
  }
  await saveStorageState(ctx);
}

// ─── Wallet balance (best-effort) ───────────────────────
function parseBalance(text) {
  if (!text) return NaN;
  const m = String(text).replace(/[,]/g, '').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
}

async function getWalletBalance(ctx) {
  const { base } = await getConfig();
  const { page } = ctx;
  await page.goto(U.account(base), { waitUntil: NAV_WAIT });
  const text = await page.locator(SELECTORS.wallet.balanceText).first().textContent({ timeout: 5000 }).catch(() => '');
  const n = parseBalance(text);
  if (Number.isNaN(n)) throw new Error('could not parse wallet balance');
  return n;
}

// ─── Place order (OpenCart + SimpleCheckout) ────────────
async function placeOrder(ctx, { productUrl, qty = 1 } = {}) {
  const { page } = ctx;
  if (!productUrl) throw new Error('placeOrder: productUrl is required');
  const { base } = await getConfig();
  const log = (m) => console.log(`[resellkeys.placeOrder] ${m}`);

  log(`goto product: ${productUrl}`);
  await page.goto(productUrl, { waitUntil: NAV_WAIT });

  if (qty > 1) {
    const qtyLoc = page.locator(SELECTORS.product.qtyInput).first();
    if (await qtyLoc.isVisible({ timeout: 2000 }).catch(() => false)) await qtyLoc.fill(String(qty));
  }

  const buyBtn = page.locator(SELECTORS.product.buyButton).first();
  try { await buyBtn.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS }); }
  catch { throw new Error(`placeOrder: "Add to Cart" button not found on ${page.url()}`); }
  await buyBtn.scrollIntoViewIfNeeded().catch(() => {});
  await buyBtn.click({ force: true });

  const cartUpdated = await Promise.race([
    page.waitForSelector('.alert-success, #alert-success, .toast-success', { timeout: 6000 }).then(() => 'alert'),
    page.waitForFunction(() => {
      const m = (document.body.innerText || '').toLowerCase().match(/(\d+)\s*item\(s\)/);
      return m ? parseInt(m[1], 10) > 0 : false;
    }, { timeout: 6000 }).then(() => 'cart-count'),
  ]).catch(() => null);
  log(cartUpdated ? `cart confirmed via ${cartUpdated}` : 'cart confirm timed out — continuing');
  await page.waitForTimeout(1000);

  await page.goto(U.checkout(base), { waitUntil: NAV_WAIT });
  await page.waitForLoadState('domcontentloaded', { timeout: DEFAULT_TIMEOUT_MS });
  if (/\/cart(?:\/|\?|$)|route=checkout\/cart/i.test(page.url())) {
    throw new Error(`placeOrder: checkout redirected to ${page.url()} — cart empty after Add-to-Cart (button selector likely off for this product).`);
  }

  const payRadio = page.locator(SELECTORS.checkout.walletOption).first();
  if (await payRadio.isVisible({ timeout: 2000 }).catch(() => false)) {
    await payRadio.check({ force: true }).catch(async () => payRadio.click({ force: true }).catch(() => {}));
  }

  const ticked = await page.evaluate(() => {
    const cb = document.querySelector('input[name="agree"], #agree, input[type="checkbox"][value="1"]');
    if (!cb) return false;
    cb.checked = true;
    cb.dispatchEvent(new Event('input', { bubbles: true }));
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    cb.dispatchEvent(new Event('click', { bubbles: true }));
    return cb.checked === true;
  });
  if (!ticked) {
    const agree = page.locator(SELECTORS.checkout.agreeCheckbox).first();
    await agree.scrollIntoViewIfNeeded().catch(() => {});
    await agree.check({ force: true }).catch(() => {});
    if (!(await agree.isChecked().catch(() => false))) {
      await page.locator('label:has-text("I have read and agree"), label:has-text("agree to the"), label:has-text("Terms")').first().click({ force: true }).catch(() => {});
    }
    const stillChecked = await page.evaluate(() => {
      const cb = document.querySelector('input[name="agree"], #agree');
      return cb ? cb.checked : null;
    });
    if (stillChecked !== true) throw new Error(`placeOrder: could not tick Terms & Conditions at ${page.url()}`);
  }

  const placeBtn = page.locator(SELECTORS.checkout.placeOrderButton).first();
  await placeBtn.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS });
  await placeBtn.scrollIntoViewIfNeeded().catch(() => {});

  const dialogPromise = new Promise((_, rej) => {
    page.once('dialog', async d => { const msg = d.message(); try { await d.dismiss(); } catch {} rej(new Error(`placeOrder: site dialog "${msg}"`)); });
  });
  await placeBtn.click({ force: true });
  page.waitForTimeout(3000).then(async () => {
    try {
      if (/route=checkout\/checkout/i.test(page.url())) {
        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button, a, input[type="submit"], .btn'))
            .find(el => /place\s*order|confirm\s*order/i.test(el.textContent || el.value || ''));
          if (btn) btn.click();
        });
      }
    } catch {}
  });

  try {
    await Promise.race([
      page.waitForURL(SELECTORS.checkout.successUrlRegex, { timeout: DEFAULT_TIMEOUT_MS }),
      page.waitForSelector(SELECTORS.checkout.confirmationMarker, { timeout: DEFAULT_TIMEOUT_MS }),
      dialogPromise,
    ]);
  } catch (e) {
    const short = ((await page.locator('body').textContent({ timeout: 2000 }).catch(() => '')) || '').replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`placeOrder: no confirmation at ${page.url()} — ${e?.message || ''} — page: "${short}"`);
  }

  let ref = parseOrderRef(page.url());
  if (!ref) ref = parseOrderRef(await page.locator(SELECTORS.checkout.orderRefText).first().textContent({ timeout: 3000 }).catch(() => null));
  if (!ref) ref = parseOrderRef(await page.locator('body').textContent({ timeout: 2000 }).catch(() => ''));
  if (!ref) ref = parseOrderRef(await page.content().catch(() => ''));
  if (!ref) throw new Error(`placeOrder: confirmation shown but no order ref at ${page.url()}`);
  log(`placed — providerRef=${ref}`);
  return { providerOrderRef: ref, status: 'pending' };
}

const MIN_ORDER_ID_DIGITS = 4;
function parseOrderRef(text) {
  if (!text) return null;
  const s = String(text);
  const mUrl = s.match(/[?&]order_id=(\d+)/i);
  if (mUrl && mUrl[1].length >= MIN_ORDER_ID_DIGITS) return mUrl[1];
  const mPath = s.match(/orders?\/(?:info\/)?(\d{4,})\b/);
  if (mPath) return mPath[1];
  const mText = s.match(/\border\s*(?:id|number|#)\s*[:#]?\s*(\d{4,})\b/i);
  if (mText) return mText[1];
  const mRK = s.match(/\bRK-?(\d{4,})\b/i);
  if (mRK) return mRK[1];
  return null;
}

// ─── Poll & fetch key ───────────────────────────────────
async function fetchOrderStatus(ctx, providerOrderRef) {
  const { base } = await getConfig();
  const { page } = ctx;
  await page.goto(U.orderInfo(base, providerOrderRef), { waitUntil: NAV_WAIT });
  const html = await page.content().catch(() => '');
  if (SELECTORS.orderHistory.keyPattern.test(html)) return 'complete';
  const yourProducts = await page.locator('.your-products, :has-text("Your Products")').first().textContent({ timeout: 2000 }).catch(() => '');
  if (yourProducts && yourProducts.replace(/\s+/g, ' ').replace(/your\s+products/i, '').trim().length > 30) return 'complete';
  if (/processing|being\s+processed|in\s+progress/i.test(html)) return 'processing';
  if (/order\s+(?:has\s+been\s+)?(?:cancell?ed|refunded|failed)\b/i.test(html)) return 'failed';
  return 'pending';
}

async function waitForKeyInline(ctx, providerOrderRef, { timeoutMs = 60000, intervalMs = 3000 } = {}) {
  const { base } = await getConfig();
  const { page } = ctx;
  const url = U.orderInfo(base, providerOrderRef);
  const deadline = Date.now() + timeoutMs;
  let sawProcessing = false;
  while (Date.now() < deadline) {
    await page.goto(url, { waitUntil: NAV_WAIT });
    const html = await page.content().catch(() => '');
    const m = html.match(SELECTORS.orderHistory.keyPattern);
    if (m) return { status: 'complete', key: m[1] };
    try {
      const domContent = await extractDeliveryFromDom(page);
      if (domContent) {
        const good = domContent.split('\n').map(l => l.trim()).filter(Boolean).find(looksLikeDeliveryContent);
        if (good) return { status: 'complete', key: good };
        if (looksLikeDeliveryContent(domContent)) return { status: 'complete', key: domContent };
      }
    } catch {}
    if (/processing|being\s+processed|in\s+progress/i.test(html)) sawProcessing = true;
    await page.waitForTimeout(intervalMs);
  }
  return { status: sawProcessing ? 'processing' : 'pending' };
}

function looksLikeDeliveryContent(s) {
  if (!s) return false;
  const t = String(s).trim();
  if (t.length < 5 || t.length > 1000) return false;
  if (/window\s*[.[]|document\.(get|query|cookie)|function\s*\(|=>\s*\{|"isPopup"|"isPhone"|"isTablet"|countdownDay/.test(t)) return false;
  if (/^(home|about us|contact|faq|menu|copy|download|your products)\s*$/i.test(t)) return false;
  return true;
}

async function extractDeliveryFromDom(page) {
  return await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null);
    let header = null;
    while (walker.nextNode()) {
      const el = walker.currentNode;
      if (/^(H[1-6]|STRONG|B|SPAN|LEGEND|DIV)$/.test(el.tagName)) {
        const direct = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' ');
        if (/^your\s+products$/i.test(direct)) { header = el; break; }
      }
    }
    if (!header) return null;
    let container = header;
    for (let i = 0; i < 4 && container.parentElement; i++) {
      container = container.parentElement;
      if (container.querySelector('code, pre, .bg-danger, .bg-light, .text-danger, [class*="key"], textarea')) break;
    }
    if (!container || container.tagName === 'BODY') return null;
    const seen = new Set(); const results = [];
    for (const el of container.querySelectorAll('code, pre, .bg-danger, .bg-light, .text-danger, [class*="key-code"], [class*="license"], textarea')) {
      if (el.querySelector && el.querySelector('script')) continue;
      const t = (el.textContent || '').trim();
      if (!t || seen.has(t)) continue;
      seen.add(t); results.push(t);
    }
    return results.length ? results.join('\n') : null;
  });
}

async function fetchKey(ctx, providerOrderRef) {
  const { base } = await getConfig();
  const { page } = ctx;
  await page.goto(U.orderInfo(base, providerOrderRef), { waitUntil: NAV_WAIT });
  const reveal = page.locator(SELECTORS.orderHistory.revealKeyButton).first();
  if (await reveal.isVisible({ timeout: 2000 }).catch(() => false)) { await reveal.click().catch(() => {}); await page.waitForTimeout(600); }

  for (const el of await page.locator(SELECTORS.orderHistory.keyText).all()) {
    const t = ((await el.textContent().catch(() => '')) || '').trim();
    if (!t || t.length > 500) continue;
    const m = t.match(SELECTORS.orderHistory.keyPattern);
    if (m) return m[1];
  }
  const html = await page.content().catch(() => '');
  const mHtml = html.match(SELECTORS.orderHistory.keyPattern);
  if (mHtml) return mHtml[1];

  const domContent = await extractDeliveryFromDom(page);
  if (domContent) {
    const good = domContent.split('\n').map(l => l.trim()).filter(Boolean).find(looksLikeDeliveryContent);
    if (good) return good;
    if (looksLikeDeliveryContent(domContent)) return domContent;
  }
  throw new Error(`fetchKey: no valid delivery content for order ${providerOrderRef} (may still be processing)`);
}

// ─── Convenience: connection test for the admin panel ────
// Opens a browser, logs in, optionally reads balance, closes. Throws an error
// tagged NO_BROWSER if Playwright/Chromium isn't available so the caller can
// fall back to the lightweight HTTP check.
async function testLogin() {
  const cfg = await getConfig();
  if (!cfg.email || !cfg.password) return { ok: false, stage: 'config', message: 'ResellKeys email and/or password are not set. Add them in Settings.' };
  let ctx;
  try {
    ctx = await openSession();
  } catch (e) {
    const err = new Error(e.message || 'browser launch failed');
    err.code = 'NO_BROWSER';
    throw err;
  }
  try {
    await login(ctx);
    let balance = null;
    try { balance = await getWalletBalance(ctx); } catch {}
    return {
      ok: true,
      stage: 'ok',
      message: `Connected ✓ Logged in to ${cfg.base} as ${cfg.email}${balance != null ? ` · wallet ≈ ${balance}` : ''}.`,
      account: cfg.email,
      balance,
    };
  } catch (e) {
    return { ok: false, stage: 'login', message: `Login failed: ${e.message}` };
  } finally {
    await closeSession(ctx);
  }
}

module.exports = {
  openSession, closeSession, login, getWalletBalance,
  placeOrder, parseOrderRef, fetchOrderStatus, waitForKeyInline, fetchKey,
  screenshotOnFailure, testLogin, getConfig, SELECTORS,
};
