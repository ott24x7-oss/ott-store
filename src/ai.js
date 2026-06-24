'use strict';
const https = require('https');
const http = require('http');
const { getDb, getSetting, get, all, run } = require('./db');

function request(url, opts, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method: opts.method || 'POST',
      headers: opts.headers,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function getActiveChannel(db) {
  return get(db, `SELECT * FROM api_channels WHERE active=1 ORDER BY id ASC LIMIT 1`);
}

// Daily AI call counter. In-memory only — resets on process restart, which is
// fine for the soft daily cap. Persists per-UTC-day so any restart on the same
// day picks up roughly where we left off via the audit_log fallback below.
const _aiCallsToday = { day: '', count: 0 };
async function _checkAiDailyCap(db) {
  const today = new Date().toISOString().slice(0, 10);
  if (_aiCallsToday.day !== today) {
    _aiCallsToday.day = today;
    // Restore today's count from audit_log so a restart doesn't reset the
    // cap to zero mid-day.
    try {
      const r = get(db, `SELECT COUNT(*) as c FROM audit_log
        WHERE action='ai_chat_call' AND created_at >= datetime('now', 'start of day')`);
      _aiCallsToday.count = r?.c || 0;
    } catch { _aiCallsToday.count = 0; }
  }
  const cap = parseInt(await getSetting('ai_daily_cap') || '500', 10) || 500;
  if (_aiCallsToday.count >= cap) {
    const err = new Error('AI daily quota reached. Please ask the team to top up.');
    err.code = 'AI_QUOTA_EXCEEDED';
    throw err;
  }
}

async function chat(messages, opts = {}) {
  const db = await getDb();
  await _checkAiDailyCap(db);
  const ch = await getActiveChannel(db);
  if (!ch) throw new Error('No active API channel configured. Add one in Admin → API Channels.');

  const baseUrl = ch.url.startsWith('http') ? ch.url : `https://${ch.url}`;
  const endpoint = `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`;

  const finalMessages = opts._systemOverride
    ? [{ role: 'system', content: opts._systemOverride }, ...messages]
    : messages;

  const payload = {
    model: opts.model || ch.model || 'gpt-5.4-mini',
    messages: finalMessages,
    max_tokens: opts.max_tokens || 1024,
    temperature: opts.temperature ?? 0.7,
    stream: false,
  };

  const res = await request(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ch.api_key}`,
    },
  }, payload);

  // Sanitize provider error before letting it leak — strip the Authorization
  // header value (the api key) from any echoed request body Meta/OpenAI might
  // include in error responses.
  if (res.status !== 200) {
    let msg = res.body?.error?.message || res.body?.message || `HTTP ${res.status}`;
    msg = String(msg).replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/g, 'Bearer ***');
    throw new Error(`AI API error: ${msg}`);
  }
  _aiCallsToday.count++;
  try { run(db, `INSERT INTO audit_log (actor_kind,actor_label,action,target_kind) VALUES (?,?,?,?)`, ['system','ai','ai_chat_call','ai_call']); } catch {}
  return res.body.choices?.[0]?.message?.content?.trim() || '';
}

async function testChannel(channelId) {
  const db = await getDb();
  const ch = get(db, `SELECT * FROM api_channels WHERE id=?`, [channelId]);
  if (!ch) throw new Error('Channel not found');

  const baseUrl = ch.url.startsWith('http') ? ch.url : `https://${ch.url}`;
  const endpoint = `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`;

  const res = await request(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ch.api_key}`,
    },
  }, {
    model: ch.model || 'gpt-5.4-mini',
    messages: [{ role: 'user', content: 'Say "OK" in one word.' }],
    max_tokens: 10,
    stream: false,
  });

  if (res.status !== 200) {
    const msg = res.body?.error?.message || res.body?.message || `HTTP ${res.status}`;
    throw new Error(`Connection failed: ${msg}`);
  }
  const reply = res.body.choices?.[0]?.message?.content?.trim() || '';
  return { ok: true, model: ch.model, reply };
}

// ─── Shared store system prompt ───────────────────────────────────────────────
// Used by: website chat widget, WA bot AI replies, admin test panel
async function buildStoreSystemPrompt(db) {
  const siteRows = all(db, `SELECT key,value FROM settings WHERE key IN ('site_name','site_tagline','support_whatsapp','support_email','bot_system_prompt','base_url','wa_owner_number','wa_bot_number')`, []);
  const s = {};
  siteRows.forEach(r => s[r.key] = r.value);

  // Declare siteUrl BEFORE the plans map — it's referenced inside the map for product URLs.
  const payMethods = all(db, `SELECT name FROM payment_methods WHERE enabled=1`).map(m => m.name).join(', ');
  const siteUrl  = (s.base_url || '').replace(/\/$/, '');
  const siteName = s.site_name || 'OTT Store';

  const plans = all(db, `SELECT id,slug,platform,name,duration_days,price_inr,original_price_inr,description,delivery_type,delivery_time_est FROM plans WHERE active=1 ORDER BY platform,price_inr ASC`);
  const platforms = [...new Set(plans.map(p => p.platform))];
  const plansText = plans.map(p => {
    const orig = (p.original_price_inr > p.price_inr) ? ` (was ₹${p.original_price_inr})` : '';
    const dur  = !p.duration_days ? 'lifetime'
               : p.duration_days >= 365 ? `${Math.round(p.duration_days/365)} year`
               : p.duration_days >= 30  ? `${Math.round(p.duration_days/30)} month`
               : `${p.duration_days} days`;
    const del  = p.delivery_type === 'instant' ? ' | Instant delivery'
               : p.delivery_time_est ? ` | Delivery: ${p.delivery_time_est}` : '';
    // Direct product URL — uses the SEO slug route when available
    const planUrl = siteUrl
      ? (p.slug ? `${siteUrl}/plans/${p.slug}` : `${siteUrl}/plans?q=${encodeURIComponent(p.name)}#plan-${p.id}`)
      : null;
    const urlPart = planUrl ? ` | URL: ${planUrl}` : '';
    return `• [ID:${p.id}] ${p.platform} — ${p.name} | ${dur} | ₹${p.price_inr}${orig}${del}${p.description ? ` | ${p.description}` : ''}${urlPart}`;
  }).join('\n');

  // Support team contacts. NEVER hand out the bot's OWN number — that just loops
  // the customer back into this AI. Drop it everywhere and prefer the admin
  // (wa_owner_number) so a customer asking for help always reaches a human.
  const botNum = String(s.wa_bot_number || '').replace(/\D/g, '').slice(-10);
  const isBotNum = (p) => !!botNum && String(p || '').replace(/\D/g, '').slice(-10) === botNum;
  let teamRow;
  try { teamRow = all(db, `SELECT value FROM settings WHERE key='contact_team'`, [])[0]; } catch {}
  let contactTeam = [];
  try { contactTeam = JSON.parse(teamRow?.value || '[]'); } catch {}
  if (!Array.isArray(contactTeam)) contactTeam = [];
  contactTeam = contactTeam.filter(c => c && c.phone && !isBotNum(c.phone));
  // Admin number first, then the support line — skipping the bot's own number.
  const supportNum = [s.wa_owner_number, s.support_whatsapp]
    .map(v => String(v || '').replace(/\D/g, ''))
    .find(v => v && !isBotNum(v)) || '';
  const teamText = contactTeam.length
    ? contactTeam.map(c => `• ${c.role}${c.name ? ` (${c.name})` : ''} — https://wa.me/${String(c.phone).replace(/\D/g, '')}`).join('\n')
    : (supportNum ? `• Support — https://wa.me/${supportNum}` : '');

  const humanSupportLine = contactTeam.length
    ? `send their wa.me link (see HUMAN SUPPORT TEAM below)`
    : (supportNum ? `WhatsApp ${supportNum}` : 'contact support');

  return `You are ${siteName}'s friendly AI sales assistant — available on the website and WhatsApp.

STORE: ${siteName}${s.site_tagline ? ` — ${s.site_tagline}` : ''}
${siteUrl ? `WEBSITE: ${siteUrl}` : ''}

AVAILABLE PLANS (live catalog):
${plansText || 'No plans listed yet — check back soon.'}

PLATFORMS WE SELL: ${platforms.join(', ') || 'Netflix, Spotify, Amazon Prime, Disney+ Hotstar and more'}

PAYMENT METHODS ACCEPTED: ${payMethods || 'UPI, Bank Transfer, Razorpay'}

HOW TO ORDER:
1. Visit ${siteUrl || 'our website'} and register / login free
2. Add wallet balance using UPI / bank transfer / Razorpay
3. Browse plans → click "Buy Now"
4. Receive credentials instantly via Email + WhatsApp

DELIVERY: Instant after payment confirmed. Credentials sent to email and WhatsApp.
VALIDITY: Shown clearly on each plan (days / months / year).
${s.support_email ? `SUPPORT EMAIL: ${s.support_email}` : ''}
${teamText ? `\nHUMAN SUPPORT TEAM (share these wa.me links when a customer asks to speak to a human, needs help, or has a complaint):\n${teamText}` : ''}
${s.bot_system_prompt ? `\nCUSTOM STORE INSTRUCTIONS:\n${s.bot_system_prompt}` : ''}

HOW TO ORDER:
1. Visit ${siteUrl || 'our website'}/plans and browse
2. Register / login free → click Buy Now on any plan
3. Pay via UPI or USDT → receive credentials instantly

YOUR ROLE:
- Answer questions about plans, pricing, and availability confidently
- Help customers pick the right plan based on their budget and viewing habits
- When a customer asks about a specific plan, share its direct Buy link from the catalog above (the "Buy:" URL)
- Proactively suggest plans — ask what they like to watch if they're unsure
- For order tracking → ${siteUrl ? siteUrl + '/my' : 'the website'} → My Orders
- For browsing all plans → ${siteUrl ? siteUrl + '/plans' : 'our website'}
- For human support → ${humanSupportLine}
- The AVAILABLE PLANS list above is the COMPLETE, LIVE catalog — it is rebuilt from our database on EVERY message, so it is always current. It is your ONLY source of truth for what we sell, our prices, and our links.
- NEVER invent, confirm, price, or link a product that is not in that list. If a customer asks about a product that is NOT listed (we may have removed or discontinued it), tell them it isn't currently available and suggest the closest plan from the list — do not pretend we still sell it.
- NEVER use placeholder text like "<link>" — always paste the real "URL:" from the catalog above

RESPONSE LANGUAGE (match the customer — important):
- Reply in the SAME language the customer writes in. An English message → reply in clear, natural English. A Hindi message → reply in Hindi. A Hinglish (Hindi+English mix) message → reply in Hinglish.
- Decide from their LATEST message and mirror it; if they switch language mid-chat, switch with them. NEVER reply in Hindi or Hinglish to a customer who is writing in English.

RESPONSE FORMAT:
- Short, conversational replies (2–4 sentences max)
- Always use ₹ for prices
- When sharing a direct plan link, use the "Buy:" URL from the catalog above
- Add action buttons at end (website only): [BUTTONS: Option1 | Option2 | Option3] (max 4)
- Be warm, friendly — not corporate/robotic`;
}

module.exports = { chat, testChannel, getActiveChannel, buildStoreSystemPrompt };
