'use strict';
const https = require('https');
const http = require('http');
const { getDb, get, all } = require('./db');

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

async function chat(messages, opts = {}) {
  const db = await getDb();
  const ch = await getActiveChannel(db);
  if (!ch) throw new Error('No active API channel configured. Add one in Admin → API Channels.');

  const baseUrl = ch.url.startsWith('http') ? ch.url : `https://${ch.url}`;
  const endpoint = `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`;

  const finalMessages = opts._systemOverride
    ? [{ role: 'system', content: opts._systemOverride }, ...messages]
    : messages;

  const payload = {
    model: opts.model || ch.model || 'gpt-4o-mini',
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

  if (res.status !== 200) {
    const msg = res.body?.error?.message || res.body?.message || `HTTP ${res.status}`;
    throw new Error(`AI API error: ${msg}`);
  }
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
    model: ch.model || 'gpt-4o-mini',
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
  const siteRows = all(db, `SELECT key,value FROM settings WHERE key IN ('site_name','site_tagline','support_whatsapp','support_email','bot_system_prompt','base_url')`, []);
  const s = {};
  siteRows.forEach(r => s[r.key] = r.value);

  const plans = all(db, `SELECT platform,name,duration_days,price_inr,original_price_inr,description,delivery_type,delivery_time_est FROM plans WHERE active=1 ORDER BY platform,price_inr ASC`);
  const platforms = [...new Set(plans.map(p => p.platform))];
  const plansText = plans.map(p => {
    const orig = (p.original_price_inr > p.price_inr) ? ` (was ₹${p.original_price_inr})` : '';
    const dur  = !p.duration_days ? 'lifetime'
               : p.duration_days >= 365 ? `${Math.round(p.duration_days/365)} year`
               : p.duration_days >= 30  ? `${Math.round(p.duration_days/30)} month`
               : `${p.duration_days} days`;
    const del  = p.delivery_type === 'instant' ? ' | Instant delivery'
               : p.delivery_time_est ? ` | Delivery: ${p.delivery_time_est}` : '';
    return `• ${p.platform} — ${p.name} | ${dur} | ₹${p.price_inr}${orig}${del}${p.description ? ` | ${p.description}` : ''}`;
  }).join('\n');

  const payMethods = all(db, `SELECT name FROM payment_methods WHERE enabled=1`).map(m => m.name).join(', ');
  const siteUrl  = (s.base_url || '').replace(/\/$/, '');
  const siteName = s.site_name || 'OTT Store';

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
${s.support_whatsapp ? `SUPPORT WHATSAPP: ${s.support_whatsapp} — human support available here` : ''}
${s.support_email ? `SUPPORT EMAIL: ${s.support_email}` : ''}
${s.bot_system_prompt ? `\nCUSTOM STORE INSTRUCTIONS:\n${s.bot_system_prompt}` : ''}

YOUR ROLE:
- Answer questions about our plans, pricing, and availability confidently
- Help customers choose the right plan based on their budget and viewing habits
- Guide step-by-step through the order process
- Proactively suggest plans — ask what they like to watch if they're unsure
- For order tracking → ${siteUrl ? siteUrl + '/my' : 'the website'} → My Orders
- For wallet top-up → ${siteUrl ? siteUrl + '/my' : 'the website'} → Wallet
- For human support → ${s.support_whatsapp ? `WhatsApp ${s.support_whatsapp}` : 'contact support'}
- NEVER invent plans or prices that are not listed above
- NEVER use "<link>", "[link]", or any placeholder text for URLs — always use the actual URL from WEBSITE above, or say "visit our website" if no URL is configured

RESPONSE FORMAT:
- Short, conversational replies (2–4 sentences max)
- Always use ₹ for prices
- When sharing a link, use the real URL only: ${siteUrl || 'our website'}
- Add action buttons at end (website only): [BUTTONS: Option1 | Option2 | Option3] (max 4)
- Be warm, friendly — not corporate/robotic`;
}

module.exports = { chat, testChannel, getActiveChannel, buildStoreSystemPrompt };
