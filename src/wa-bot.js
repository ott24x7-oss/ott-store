'use strict';
/**
 * WhatsApp Bot — Baileys (QR / pairing-code) + Meta Cloud API transport.
 *
 * Baileys is ESM-only; we load it lazily via dynamic import() from this CJS module.
 * Falls back gracefully if Baileys is not installed or fails to load.
 *
 * Transport is selected by the `wa_transport` setting:
 *   'baileys'    → Baileys WA Web (default, QR scan or pairing code)
 *   'meta_cloud' → Meta WhatsApp Cloud API (phone_number_id + access_token)
 */
const path = require('path');
const fs   = require('fs');
const https = require('https');
const { getSettingSync, setSettingSync, getDb } = require('./db');

const SESSION_DIR = path.join(__dirname, '..', 'data', 'wa-session');

// ─── Bot state ────────────────────────────────────────────────────────────────
let sock             = null;
let currentQR        = null;
let isStarting       = false;
let connStatus       = 'disconnected'; // disconnected | connecting | waiting_qr | connected | logged_out | error
let connectedNumber  = null;
let watchdogTimer    = null;
let probeFails       = 0;
let wdLastChange     = Date.now();
let wdLastStatus     = 'disconnected';
const sentCache      = new Map();
const SENT_CACHE_MAX = 500;

// ─── WA AI reply sessions (per JID conversation history) ─────────────────────
const _waSessions    = new Map(); // jid → { messages: [], lastActive: ms }
const WA_SESSION_TTL = 30 * 60 * 1000; // 30 min inactivity resets session
const WA_MAX_HISTORY = 8; // messages to keep per session

function extractWAText(msg) {
  const m = msg.message;
  if (!m) return null;
  return m.conversation
    || m.extendedTextMessage?.text
    || m.imageMessage?.caption
    || m.videoMessage?.caption
    || m.buttonsResponseMessage?.selectedDisplayText
    || m.listResponseMessage?.title
    || null;
}

async function processIncomingWA(msg) {
  const jid = msg.key.remoteJid;
  if (!jid) return;
  if (jid.endsWith('@g.us') || jid === 'status@broadcast') return; // skip groups & status
  if (msg.key.fromMe) return;

  const text = extractWAText(msg);
  if (!text || text.trim().length < 1) return;

  // Check if WA AI reply is enabled
  const waAiEnabled = getSettingSync('wa_ai_reply_enabled');
  if (waAiEnabled === '0') return;
  const botEnabled = getSettingSync('bot_enabled');
  if (botEnabled === '0') return;

  // Enforce per-JID rate limit: 10 messages / minute
  const now = Date.now();
  const session = _waSessions.get(jid) || { messages: [], lastActive: now, count: 0, countTs: now };
  if (now - session.countTs > 60000) { session.count = 0; session.countTs = now; }
  session.count = (session.count || 0) + 1;
  if (session.count > 10) return; // silent rate limit

  // Reset session if idle > TTL
  if (now - session.lastActive > WA_SESSION_TTL) {
    session.messages = [];
  }
  session.lastActive = now;

  // Append user message to history
  session.messages.push({ role: 'user', content: text.trim() });
  if (session.messages.length > WA_MAX_HISTORY) {
    session.messages = session.messages.slice(-WA_MAX_HISTORY);
  }
  _waSessions.set(jid, session);

  try {
    const db = await getDb();
    const { chat, buildStoreSystemPrompt } = require('./ai');
    const systemPrompt = await buildStoreSystemPrompt(db);

    // WA-specific tweak: no [BUTTONS:] syntax for WhatsApp
    const waSystemPrompt = systemPrompt.replace(
      /- Add action buttons at end.*\[BUTTONS.*\]\(max 4\)/,
      '- Do NOT use [BUTTONS:] syntax — this is WhatsApp. Give options as numbered list if needed.'
    );

    const rawReply = await chat(session.messages, {
      max_tokens: 300,
      _systemOverride: waSystemPrompt,
    });

    // Strip any [BUTTONS: ...] that slipped through
    const reply = rawReply.replace(/\[BUTTONS:[^\]]*\]/gi, '').trim();
    if (!reply) return;

    // Append assistant reply to history
    session.messages.push({ role: 'assistant', content: reply });
    if (session.messages.length > WA_MAX_HISTORY) {
      session.messages = session.messages.slice(-WA_MAX_HISTORY);
    }

    // Send reply via Baileys or Meta
    const s = getActiveSock();
    if (s) await s.sendMessage(jid, { text: reply });
  } catch (e) {
    console.error('[wa-bot] AI reply error:', e.message);
  }
}

// Skip-reason tracking (exposed to /admin/api/whatsapp/diagnostics)
const _lastSkip = { reason: null, at: null };
function recordSkip(reason) {
  _lastSkip.reason = reason;
  _lastSkip.at     = new Date().toISOString();
}

// ─── Baileys loader (lazy ESM import) ────────────────────────────────────────
let _B = null;
async function loadBaileys() {
  if (_B) return _B;
  _B = await import('@whiskeysockets/baileys');
  return _B;
}

// ─── Start Baileys bot ────────────────────────────────────────────────────────
async function startBaileysBot() {
  if (isStarting) return sock;
  isStarting = true;

  if (sock) {
    try { sock.ev.removeAllListeners(); } catch {}
    try { sock.end(); } catch {}
    sock = null;
  }

  connStatus  = 'connecting';
  currentQR   = null;

  try {
    const B = await loadBaileys();
    const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = B;
    const { Boom } = require('@hapi/boom');

    fs.mkdirSync(SESSION_DIR, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version }          = await fetchLatestBaileysVersion();

    // Minimal silent pino logger; fallback to no-op if pino not installed
    let logger;
    try { logger = require('pino')({ level: 'silent' }); }
    catch {
      logger = { level:'silent', fatal:()=>{}, error:()=>{}, warn:()=>{}, info:()=>{}, debug:()=>{}, trace:()=>{}, child() { return this; } };
    }

    sock = makeWASocket({
      version, logger, auth: state,
      browser: Browsers.ubuntu('Chrome'),
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      getMessage: async (key) => {
        try { return sentCache.get(key.id) || { conversation: '' }; } catch { return { conversation: '' }; }
      },
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR  = qr;
        connStatus = 'waiting_qr';
        console.log('[wa-bot] QR ready — scan from Admin → WhatsApp');
      }

      if (connection === 'close') {
        currentQR       = null;
        const code      = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const reconnect = (code !== DisconnectReason.loggedOut);
        connStatus       = 'disconnected';
        connectedNumber  = null;
        if (reconnect) {
          isStarting = false;
          setTimeout(() => startBaileysBot(), 3000);
        } else {
          connStatus = 'logged_out';
          isStarting = false;
        }
      }

      if (connection === 'open') {
        currentQR       = null;
        connStatus       = 'connected';
        connectedNumber  = sock.user?.id?.split(':')[0] || sock.user?.id || 'Unknown';
        console.log(`[wa-bot] Connected as ${connectedNumber}`);
        try { if (typeof sock.uploadPreKeysToServerIfRequired === 'function') await sock.uploadPreKeysToServerIfRequired(); } catch {}
        try { await sock.sendPresenceUpdate('available'); } catch {}
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      for (const msg of messages) {
        // Cache own sent messages (needed for retry/re-encrypt)
        if (msg.key.fromMe && msg.key.id && msg.message) {
          sentCache.set(msg.key.id, msg.message);
          if (sentCache.size > SENT_CACHE_MAX) {
            const oldest = sentCache.keys().next().value;
            if (oldest) sentCache.delete(oldest);
          }
        }
        // Process incoming customer messages with AI
        if (!msg.key.fromMe && type === 'notify') {
          processIncomingWA(msg).catch(() => {});
        }
      }
    });

  } catch (e) {
    console.error('[wa-bot] Baileys start error:', e.message);
    connStatus = 'error';
  }

  isStarting = false;
  return sock;
}

// ─── Meta Cloud API duck-typed sock ──────────────────────────────────────────
function makeMetaSock() {
  const phoneNumberId = getSettingSync('wa_meta_phone_number_id');
  const accessToken   = getSettingSync('wa_meta_access_token');
  if (!phoneNumberId || !accessToken) return null;

  function metaPost(body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req  = https.request({
        hostname: 'graph.facebook.com',
        path: `/v21.0/${phoneNumberId}/messages`,
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout: 10000,
      }, (res) => {
        let s = '';
        res.on('data', c => s += c);
        res.on('end', () => {
          try { const d = JSON.parse(s); if (d.error) reject(new Error(d.error.message || 'Meta API error')); else resolve(d); }
          catch { resolve({}); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Meta API timeout')); });
      req.write(data);
      req.end();
    });
  }

  return {
    __meta: true,
    user: { id: `${phoneNumberId}@meta` },
    async sendMessage(jid, content) {
      const to = String(jid).split('@')[0].replace(/[^0-9]/g, '');
      if (!to) return;
      if (content && typeof content.text === 'string') {
        return metaPost({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: content.text, preview_url: false } });
      }
      // Image with caption
      if (content && content.image) {
        const fallback = content.caption || '';
        if (fallback) return metaPost({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: String(fallback) } });
      }
      const fallback = content?.caption || content?.text || '';
      if (fallback) return metaPost({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: String(fallback) } });
    },
    async sendPresenceUpdate() {},
    async logout() {},
    end() {},
    ev: { on() {}, off() {}, once() {}, removeAllListeners() {} },
    async groupFetchAllParticipating() { return {}; },
    async requestPairingCode() { throw new Error('Pairing code not applicable for Meta Cloud API'); },
  };
}

// ─── Active sock ─────────────────────────────────────────────────────────────
function getActiveSock() {
  const mode = getSettingSync('wa_transport') || 'baileys';
  if (mode === 'meta_cloud') return makeMetaSock();
  return sock;
}

// ─── Status ───────────────────────────────────────────────────────────────────
function getStatus() {
  const mode = getSettingSync('wa_transport') || 'baileys';
  if (mode === 'meta_cloud') {
    const pid = getSettingSync('wa_meta_phone_number_id');
    const tok = getSettingSync('wa_meta_access_token');
    return { mode: 'meta_cloud', status: (pid && tok) ? 'connected' : 'disconnected', number: pid || null, hasQR: false };
  }
  return { mode: 'baileys', status: connStatus, number: connectedNumber, hasQR: !!currentQR };
}

function getQR() { return currentQR; }

// Generate QR as base64 PNG data-URL for admin panel
async function getQRBase64() {
  if (!currentQR) return null;
  try {
    const QRCode = require('qrcode');
    return await QRCode.toDataURL(currentQR, { width: 256, margin: 2 });
  } catch { return null; }
}

// ─── Connect / Disconnect / Reconnect ─────────────────────────────────────────
async function connect() {
  const mode = getSettingSync('wa_transport') || 'baileys';
  if (mode === 'meta_cloud') return;
  return startBaileysBot();
}

async function disconnect() {
  if (sock) {
    try { await sock.logout(); } catch {}
    try { sock.ev.removeAllListeners(); } catch {}
    sock = null;
  }
  currentQR       = null;
  connStatus       = 'disconnected';
  connectedNumber  = null;
}

async function reconnect() {
  if (sock) {
    try { sock.ev.removeAllListeners(); } catch {}
    try { sock.end(); } catch {}
    sock = null;
  }
  currentQR       = null;
  connStatus       = 'connecting';
  connectedNumber  = null;
  return startBaileysBot();
}

async function clearSession() {
  await disconnect();
  if (fs.existsSync(SESSION_DIR)) {
    try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch {}
  }
}

async function requestPairingCode(phoneNumber) {
  if (!sock) throw new Error('Bot not started — click Connect first');
  if (connStatus === 'connected') throw new Error('Already connected');
  return sock.requestPairingCode(String(phoneNumber).replace(/\D/g, ''));
}

// ─── Send helpers ─────────────────────────────────────────────────────────────
async function sendToPhone(phone, text) {
  const s = getActiveSock();
  if (!s) { recordSkip('no active sock'); return false; }
  try {
    const jid = String(phone).replace(/\D/g, '') + '@s.whatsapp.net';
    await s.sendMessage(jid, { text: String(text) });
    return true;
  } catch (e) {
    console.error('[wa-bot] sendToPhone error:', e.message);
    return false;
  }
}

async function sendToGroup(groupId, content) {
  const s = getActiveSock();
  if (!s) { recordSkip('no active sock'); return false; }
  try {
    await s.sendMessage(groupId, content);
    return true;
  } catch (e) {
    console.error('[wa-bot] sendToGroup error:', e.message);
    return false;
  }
}

// ─── Groups ───────────────────────────────────────────────────────────────────
async function getGroups() {
  const s = getActiveSock();
  if (!s || s.__meta) return [];
  if (connStatus !== 'connected') return [];
  try {
    const groups = await s.groupFetchAllParticipating();
    return Object.entries(groups).map(([id, g]) => ({
      id, name: g.subject || id, participants: g.participants?.length || 0,
    }));
  } catch { return []; }
}

// ─── Test Meta credentials ────────────────────────────────────────────────────
async function testMetaCreds({ phoneNumberId, accessToken }) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'graph.facebook.com',
      path: `/v21.0/${phoneNumberId}?fields=display_phone_number,verified_name`,
      headers: { 'Authorization': `Bearer ${accessToken}` },
      timeout: 8000,
    }, (res) => {
      let s = '';
      res.on('data', c => s += c);
      res.on('end', () => {
        try {
          const d = JSON.parse(s);
          if (d.error) resolve({ ok: false, error: d.error.message });
          else resolve({ ok: true, phone: d.display_phone_number, name: d.verified_name });
        } catch { resolve({ ok: false, error: 'Invalid API response' }); }
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Request timed out' }); });
    req.end();
  });
}

// ─── Watchdog ─────────────────────────────────────────────────────────────────
function startWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(async () => {
    const mode = getSettingSync('wa_transport') || 'baileys';
    if (mode !== 'baileys') return;

    try {
      if (connStatus !== wdLastStatus) {
        wdLastStatus  = connStatus;
        wdLastChange  = Date.now();
        probeFails = 0;
      }
      const stuckMs = Date.now() - wdLastChange;

      if (connStatus === 'disconnected' && !isStarting && stuckMs > 90000) {
        wdLastChange = Date.now();
        try { await startBaileysBot(); } catch {}
      } else if (connStatus === 'connected' && sock && !isStarting) {
        try {
          await Promise.race([
            sock.sendPresenceUpdate('available'),
            new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 5000)),
          ]);
          probeFails = 0;
        } catch {
          probeFails++;
          if (probeFails >= 2) {
            probeFails = 0;
            console.log('[wa-bot] Watchdog: zombie socket — forcing reconnect');
            try { sock.ev.removeAllListeners(); } catch {}
            try { sock.end(); } catch {}
            sock           = null;
            connStatus      = 'disconnected';
            connectedNumber = null;
            try { await startBaileysBot(); } catch {}
          }
        }
      }
    } catch {}
  }, 60 * 1000);
}

module.exports = {
  connect, disconnect, reconnect, clearSession, requestPairingCode,
  getStatus, getQR, getQRBase64, getActiveSock,
  sendToPhone, sendToGroup,
  getGroups, testMetaCreds, startWatchdog,
  getDiagnostics: () => _lastSkip,
};
