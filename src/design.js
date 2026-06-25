'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// DESIGN ENGINE — one source of truth for the whole site's look.
//
// The store historically had THREE disconnected styling systems:
//   1. storefront tokens   --th-/--st-/--sp-   (themes.css + store-theme.css)
//   2. self-contained landing --blue/--grad-a  (movieverse-home.html)
//   3. admin + portal      --page-bg/--grad-1  (style.css)
//
// This module emits ONE canonical token set (--d-*) from the admin's saved
// "Appearance" settings, then BRIDGES all three legacy systems to it. Every
// page includes the generated <style> in its <head> (after the other sheets,
// so it wins by source order), so a single change — brand colour, font,
// light/dark, contrast, density — reflects everywhere at once.
//
// No layout is rewritten; only the token *values* are centralised.
// ─────────────────────────────────────────────────────────────────────────────

// ── Curated Google Fonts (heading + body picker) ────────────────────────────
// name → the css2 `family=` fragment (with the weights we use).
const FONTS = {
  'Inter':               'Inter:wght@400;500;600;700;800',
  'Hanken Grotesk':      'Hanken+Grotesk:wght@400;500;600;700;800',
  'Bricolage Grotesque': 'Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,700;12..96,800',
  'Sora':                'Sora:wght@400;500;600;700;800',
  'Space Grotesk':       'Space+Grotesk:wght@400;500;600;700',
  'Plus Jakarta Sans':   'Plus+Jakarta+Sans:wght@400;500;600;700;800',
  'Outfit':              'Outfit:wght@400;500;600;700;800',
  'Poppins':             'Poppins:wght@400;500;600;700;800',
  'Manrope':             'Manrope:wght@400;500;600;700;800',
  'DM Sans':             'DM+Sans:wght@400;500;700',
  'Montserrat':          'Montserrat:wght@400;500;600;700;800',
  'Work Sans':           'Work+Sans:wght@400;500;600;700',
  'Figtree':             'Figtree:wght@400;500;600;700;800',
  'Lexend':              'Lexend:wght@400;500;600;700;800',
};
const FONT_FALLBACK = "system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif";

// Storefront palette → {brand, accent} so the live look is PRESERVED on first
// deploy (before the admin sets explicit colours). Mirrors themes.css.
const PALETTE_MAP = {
  'movieverse':   { brand: '#2b6fff', accent: '#8d5cff' },
  'volt':         { brand: '#9be80f', accent: '#00d08a' },
  'sunset':       { brand: '#fb923c', accent: '#f43f5e' },
  'aqua':         { brand: '#22d3ee', accent: '#3b82f6' },
  'plasma':       { brand: '#a855f7', accent: '#ec4899' },
  'gold':         { brand: '#fbbf24', accent: '#f97316' },
  'ice':          { brand: '#60a5fa', accent: '#818cf8' },
  'mint':         { brand: '#2dd4bf', accent: '#4ade80' },
  'rose':         { brand: '#f472b6', accent: '#fb7185' },
  'cyber':        { brand: '#6366f1', accent: '#06b6d4' },
  'ember':        { brand: '#ef4444', accent: '#f59e0b' },
  'midnight-purple': { brand: '#7c3aed', accent: '#4f46e5' },
  'neon-dark':    { brand: '#00ffc6', accent: '#00b8ff' },
};

const DEFAULTS = {
  design_brand:        '',                 // '' → derive from active palette
  design_accent:       '',
  design_mode:         'dark',             // 'light' | 'dark'
  design_visitor_toggle: '0',              // '1' lets visitors flip light/dark
  design_contrast:     'normal',           // 'normal' | 'high'
  design_radius:       '16',               // base corner radius, px
  design_density:      'comfortable',      // 'compact' | 'comfortable' | 'spacious'
  design_font_heading: 'Bricolage Grotesque',
  design_font_body:    'Hanken Grotesk',
  design_enabled:      '1',                // master switch
};

// ── colour helpers ──────────────────────────────────────────────────────────
function hexToRgb(hex) {
  let h = String(hex || '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
function clampHex(hex, fallback) {
  return hexToRgb(hex) ? (hex[0] === '#' ? hex : '#' + hex) : fallback;
}
function relLuminance({ r, g, b }) {
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrastRatio(L1, L2) { const a = Math.max(L1, L2), b = Math.min(L1, L2); return (a + 0.05) / (b + 0.05); }
// Pick near-black or white ink for legible text ON a coloured fill.
function pickInk(hex) {
  const rgb = hexToRgb(hex); if (!rgb) return '#ffffff';
  const L = relLuminance(rgb);
  const onWhite = contrastRatio(L, 1), onBlack = contrastRatio(L, relLuminance({ r: 10, g: 11, b: 13 }));
  return onBlack >= onWhite ? '#0a0b0d' : '#ffffff';
}
function rgbTriplet(hex) { const c = hexToRgb(hex); return c ? `${c.r},${c.g},${c.b}` : '43,111,255'; }
// Mix a hex toward white/black by t (0..1) — for soft tints without color-mix.
function mix(hex, target, t) {
  const a = hexToRgb(hex), b = hexToRgb(target); if (!a || !b) return hex;
  const m = (x, y) => Math.round(x + (y - x) * t);
  return `#${[m(a.r, b.r), m(a.g, b.g), m(a.b, b.b)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

// ── resolve saved settings → concrete values ────────────────────────────────
function resolve(settings = {}, storeTheme = 'movieverse') {
  const s = { ...DEFAULTS, ...settings };
  const pal = PALETTE_MAP[storeTheme] || PALETTE_MAP.movieverse;
  const brand  = clampHex(s.design_brand, pal.brand);
  const accent = clampHex(s.design_accent, pal.accent);
  const mode = s.design_mode === 'light' ? 'light' : 'dark';
  const high = s.design_contrast === 'high';
  const radius = Math.max(0, Math.min(28, parseInt(s.design_radius, 10) || 16));
  const density = ['compact', 'comfortable', 'spacious'].includes(s.design_density) ? s.design_density : 'comfortable';
  const headingFont = FONTS[s.design_font_heading] ? s.design_font_heading : 'Bricolage Grotesque';
  const bodyFont    = FONTS[s.design_font_body]    ? s.design_font_body    : 'Hanken Grotesk';
  return {
    brand, accent, mode, high, radius, density, headingFont, bodyFont,
    visitorToggle: s.design_visitor_toggle === '1',
    enabled: s.design_enabled !== '0',
    onAccent: pickInk(brand),
    onAccent2: pickInk(accent),
    brandRgb: rgbTriplet(brand),
    accentRgb: rgbTriplet(accent),
    grad: `linear-gradient(135deg, ${brand}, ${accent})`,
    densityPad: density === 'compact' ? '.82' : density === 'spacious' ? '1.18' : '1',
  };
}

// ── canonical tokens (--d-*) : mode + contrast + density aware ───────────────
function buildVars(d) {
  const padScale = d.densityPad;
  // light surface ramp
  const light = {
    bg: '#f4f6fb', surface: '#ffffff', surface2: '#f6f8fd', solid: '#ffffff',
    border: d.high ? '#cdd6e6' : '#e3e8f2',
    text: d.high ? '#0a0f1c' : '#1b2333', muted: d.high ? '#3a4456' : '#5b6577',
    glow: `rgba(${d.brandRgb},.12)`,
  };
  // dark surface ramp
  const dark = {
    bg: '#0a0a0c', surface: 'rgba(255,255,255,.06)', surface2: 'rgba(255,255,255,.09)', solid: '#16171c',
    border: d.high ? 'rgba(255,255,255,.24)' : 'rgba(255,255,255,.12)',
    text: '#ffffff', muted: d.high ? '#c4c6d0' : '#9a9ba4',
    glow: `rgba(${d.brandRgb},.30)`,
  };
  const common = `
  --d-brand:${d.brand}; --d-accent:${d.accent}; --d-accent2:${mix(d.accent, '#ffffff', .12)};
  --d-on-accent:${d.onAccent}; --d-on-accent-2:${d.onAccent2};
  --d-brand-rgb:${d.brandRgb}; --d-accent-rgb:${d.accentRgb};
  --d-grad:${d.grad}; --d-grad-soft:linear-gradient(135deg,${mix(d.brand, '#000000', .12)},${mix(d.accent, '#000000', .12)});
  --d-brand-strong:${mix(d.brand, '#000000', .14)}; --d-accent-strong:${mix(d.accent, '#000000', .14)};
  --d-radius:${d.radius}px; --d-radius-sm:${Math.max(4, d.radius - 6)}px; --d-radius-lg:${d.radius + 6}px;
  --d-pad:${padScale}; --d-font-heading:'${d.headingFont}',${FONT_FALLBACK}; --d-font-body:'${d.bodyFont}',${FONT_FALLBACK};`;
  const ramp = (m) => `--d-bg:${m.bg};--d-surface:${m.surface};--d-surface-2:${m.surface2};--d-surface-solid:${m.solid};--d-border:${m.border};--d-text:${m.text};--d-muted:${m.muted};--d-glow:${m.glow};`;
  return `:root{${common}\n  ${ramp(light)}}
[data-theme="dark"]{${ramp(dark)}}
:root[data-theme="dark"]{color-scheme:dark}`;
}

// ── bridge: point the 3 legacy systems at the canonical --d-* tokens ─────────
// Injected LAST in <head>, so these win over themes.css / store-theme.css /
// style.css by source order (equal specificity). They reference --d-* which are
// themselves mode-switched, so light/dark/contrast all flow through.
const BRIDGE = `
/* DESIGN ENGINE BRIDGE — legacy tokens now read from --d-* */
:root,html[data-store-theme],[data-theme]{
  /* storefront (#1) */
  --th-bg:var(--d-bg);--st-bg:var(--d-bg);--sp-bg:var(--d-bg);--bg:var(--d-bg);--page-bg:var(--d-bg);
  --th-card:var(--d-surface);--st-card:var(--d-surface);--card:var(--d-surface);--glass:var(--d-surface);--glass2:var(--d-surface-2);
  --th-card-solid:var(--d-surface-solid);--st-card-solid:var(--d-surface-solid);--card-solid:var(--d-surface-solid);
  --th-border:var(--d-border);--st-border:var(--d-border);--sp-border:var(--d-border);--border:var(--d-border);
  --th-text:var(--d-text);--st-text:var(--d-text);--sp-text:var(--d-text);--text:var(--d-text);
  --th-muted:var(--d-muted);--st-muted:var(--d-muted);--sp-muted:var(--d-muted);--muted:var(--d-muted);
  --th-accent:var(--d-brand);--st-accent:var(--d-brand);--sp-accent:var(--d-brand);--red:var(--d-brand);
  --th-accent-end:var(--d-accent);--st-accent-end:var(--d-accent);--sp-accent2:var(--d-accent);--sp-accent-end:var(--d-accent);--orange:var(--d-accent);--purple:var(--d-accent);
  --th-accent-pop:var(--d-accent2);
  --th-btn:var(--d-grad);--st-btn:var(--d-grad);--sp-btn:var(--d-grad);--th-badge-bg:var(--d-grad);
  --btn-ink:var(--d-on-accent);
  --th-glow:var(--d-glow);--th-blob1:rgba(var(--d-brand-rgb),.16);--th-blob2:rgba(var(--d-accent-rgb),.10);--th-blob3:rgba(var(--d-brand-rgb),.06);
  --th-nav-bg:var(--d-surface-solid);--st-nav:var(--d-surface-solid);--sp-nav:var(--d-surface-solid);--header-bg:var(--d-surface-solid);
  --grad-1:var(--d-brand);--grad-2:var(--d-accent2);--grad-3:var(--d-accent);
  /* landing (#2) */
  --blue:var(--d-brand);--violet:var(--d-accent);--amber:var(--d-brand);--amber-2:var(--d-accent);
  --grad-a:var(--d-grad);--grad-b:var(--d-grad);--gold:var(--d-accent2);
  --accent-rgb:var(--d-brand-rgb);--accent2-rgb:var(--d-accent-rgb);
  /* admin + portal (#3) */
  --my-card:var(--d-surface);--my-border:var(--d-border);--my-text:var(--d-text);--my-muted:var(--d-muted);--my-page-bg:var(--d-bg);
  --input-bg:var(--d-surface-2);
  /* shared radius */
  --radius:var(--d-radius);--radius-sm:var(--d-radius-sm);
}
/* fonts — heading vs body, reach the explicit landing/admin overrides too */
body,.my-page,.admin-wrap,.sp-main,.legal-page,.blog-post-page{font-family:var(--d-font-body)!important}
h1,h2,h3,h4,h5,h6,.h1,.h2,.big,.display,.sidebar-logo,.snav-logo,.sp-logo,.mv-logo,.hero-title,.section-title{font-family:var(--d-font-heading)!important}
input,select,textarea,button{font-family:var(--d-font-body)}
code,kbd,pre,[style*="monospace"]{font-family:'DM Mono',ui-monospace,monospace}
/* visitor light/dark toggle — shown only when enabled in Appearance (data-vtoggle="1") */
html:not([data-vtoggle="1"]) #theme-toggle,html:not([data-vtoggle="1"]) #theme-toggle-hdr,html:not([data-vtoggle="1"]) #theme-toggle-drawer{display:none!important}
html[data-vtoggle="1"] #theme-toggle,html[data-vtoggle="1"] #theme-toggle-hdr{display:inline-flex!important}`;

// ── font <link> for the chosen heading + body fonts ─────────────────────────
function fontLink(d) {
  const fams = [...new Set([FONTS[d.headingFont], FONTS[d.bodyFont], 'DM+Mono:wght@400;500'])].filter(Boolean);
  const href = 'https://fonts.googleapis.com/css2?' + fams.map(f => 'family=' + f).join('&') + '&display=swap';
  return `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${href}">`;
}

// ── public: the full <head> payload to inject before </head> ────────────────
// `mode`/`contrast`/`density`/`toggle` are also surfaced as data-* on <html>
// via designHtmlAttrs() so the very first paint is correct (no flash).
function designHead(settings, storeTheme) {
  const d = resolve(settings, storeTheme);
  if (!d.enabled) return '';
  return `${fontLink(d)}\n<style id="design-engine">\n${buildVars(d)}\n${BRIDGE}\n${densityCss(d)}\n</style>`;
}
function densityCss(d) {
  // gentle spacing scale via a multiplier on common paddings (opt-in classes).
  return `[data-density]{--d-pad:${d.densityPad}}
[data-contrast="high"] *{text-shadow:none}`;
}
// Attributes to stamp on <html> so CSS + first paint match the saved settings.
function designHtmlAttrs(settings, storeTheme) {
  const d = resolve(settings, storeTheme);
  if (!d.enabled) return '';
  return ` data-theme="${d.mode}" data-contrast="${d.high ? 'high' : 'normal'}" data-density="${d.density}" data-vtoggle="${d.visitorToggle ? '1' : '0'}"`;
}
// Runs FIRST in <head>: when visitors may switch light/dark, honour their saved
// choice; otherwise lock to the admin's mode. Set before the page's own theme
// scripts so it wins the first paint (those scripts then keep the current attr).
function earlyModeScript(settings, storeTheme) {
  const d = resolve(settings, storeTheme);
  if (!d.enabled) return '';
  return `<script>(function(){try{var v=${d.visitorToggle ? 1 : 0},t=(v&&localStorage.getItem('theme'))||'${d.mode}';document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>`;
}

module.exports = {
  FONTS, PALETTE_MAP, DEFAULTS,
  resolve, designHead, designHtmlAttrs, earlyModeScript, fontLink, buildVars, BRIDGE,
  pickInk, hexToRgb, contrastRatio, relLuminance,
};
