'use strict';
const https = require('https');
const http = require('http');
const { getDb, get } = require('./db');

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

module.exports = { chat, testChannel, getActiveChannel };
