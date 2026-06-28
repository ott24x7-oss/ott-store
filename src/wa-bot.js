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
const waSession = require('./wa-session-store');

const SESSION_DIR = path.join(__dirname, '..', 'data', 'wa-session');

// ─── Bot state ────────────────────────────────────────────────────────────────
let sock             = null;
let currentQR        = null;
let isStarting       = false;
let connStatus       = 'disconnected'; // disconnected | connecting | waiting_qr | connected | logged_out | error
let connectedNumber  = null;
let watchdogTimer    = null;
// Exponential-backoff reconnect: on a flapping link (rate-limited, no network,
// Baileys auth race) the old 3-second fixed retry can fire 20 times a minute
// and either rate-bans the number or pegs CPU. Track consecutive failures and
// scale: 3s → 6s → 12s → 24s → 48s → 60s (cap).
let _waReconnectAttempts = 0;
let _stoodDown       = false; // set after connectionReplaced — blocks the watchdog from auto-reconnecting so a dying container can't steal the session back from the live one
let _snapTimer       = null;  // hourly secure-session snapshot timer
let _lastSnapAt      = 0;     // cooldown for on-connect snapshots
let probeFails       = 0;
let wdLastChange     = Date.now();
let wdLastStatus     = 'disconnected';
const sentCache      = new Map();
const SENT_CACHE_MAX = 500;
let _ghostCheckDone  = false; // stale-ghost auto-clear runs at most once per process (never during a pairing)

// ─── WA AI reply sessions (per JID conversation history) ─────────────────────
const _waSessions    = new Map(); // jid → { messages: [], lastActive: ms }
const WA_SESSION_TTL = 30 * 60 * 1000; // 30 min inactivity resets session
const WA_MAX_HISTORY = 8; // messages to keep per session

// The AI emits standard markdown (**bold**, __bold__). WhatsApp's own bold is a
// single asterisk (*bold*) and italic is _italic_, so double-asterisk markdown
// renders as literal "**" on WhatsApp. Convert it to WhatsApp's flavor before
// sending. Single-marker *italic* / _italic_ already render natively, so they
// pass through untouched.
function mdToWhatsApp(text) {
  return String(text || '')
    .replace(/\*\*([^\n*]+?)\*\*/g, '*$1*')   // **bold** → *bold*
    .replace(/__([^\n_]+?)__/g, '*$1*');      // __bold__ → *bold*
}

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

// ─── 1-tap WhatsApp login trigger ────────────────────────────────────────────
// Customer taps "1-Tap WhatsApp Login" on the website → wa.me link prefills the
// message "Help me login to <Brand>" → they hit Send → this handler picks the
// incoming message up, creates a wa_magic token (10-min TTL), and replies with
// a tap-to-login URL. Mirrors the existing /send-wa-magic flow but driven from
// the user's WhatsApp instead of the website form.
function isLoginTrigger(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  // Match the canonical phrase + a few common variants. We anchor on the start
  // of the message to avoid false positives in general chat.
  return /^(help\s*me\s*login|login(\s*link)?|send\s*(me\s*)?login|magic\s*link|i\s*want\s*to\s*login)\b/i.test(t);
}

async function handleLoginTrigger(msg, jid, text) {
  if (!isLoginTrigger(text)) return false;
  try {
    const waEnabled = getSettingSync('wa_enabled');
    if (waEnabled === '0') return false; // bot not active for logins
    const crypto = require('crypto');
    const { run } = require('./db');
    const db = await getDb();

    const phoneCC = String(jid).split('@')[0].replace(/[^0-9]/g, '');
    if (!phoneCC || phoneCC.length < 10) return false;

    // Rate-limit login requests to 1 per 30s per JID so a curious user can't
    // spam-create tokens by tapping the link repeatedly.
    const last = _waLoginLast.get(jid) || 0;
    const now  = Date.now();
    if (now - last < 30 * 1000) {
      const s = getActiveSock();
      if (s) await s.sendMessage(jid, { text: '⏳ Please wait a few seconds before requesting another login link.' });
      return true; // handled — suppress AI reply
    }
    _waLoginLast.set(jid, now);

    const token   = crypto.randomBytes(32).toString('hex');
    const expires = new Date(now + 10 * 60 * 1000).toISOString();
    run(db, `INSERT INTO auth_tokens (token,purpose,phone,expires_at) VALUES (?,?,?,?)`,
      [token, 'wa_magic', phoneCC, expires]);

    const baseUrl  = (getSettingSync('base_url') || '').replace(/\/+$/, '') || 'https://ott24x7.com';
    const siteName = getSettingSync('site_name') || 'OTT Store';
    const magicUrl = `${baseUrl}/user/api/auth/wa-magic?token=${token}`;

    const s = getActiveSock();
    if (s) {
      await s.sendMessage(jid, {
        text:
          `🔐 *${siteName} — Tap to Login*\n\n` +
          `Tap this link to sign in instantly:\n${magicUrl}\n\n` +
          `Valid for 10 minutes. Do not share with anyone.`,
      });
    }
    return true; // handled — suppress AI reply
  } catch (e) {
    console.error('[wa-bot] login trigger error:', e.message);
    return false;
  }
}
const _waLoginLast = new Map(); // jid → last-login-link timestamp (ms)

// ─── WhatsApp community feed — mirror the announcement group → /community ─────
const COMMUNITY_DIR = path.join(__dirname, '..', 'data', 'uploads', 'community');
async function captureCommunityPost(msg) {
  try {
    if (getSettingSync('community_enabled') !== '1') return;
    const jid = msg.key && msg.key.remoteJid;
    const wantJid = (getSettingSync('community_jid') || '').trim();
    if (!jid || !wantJid || jid !== wantJid) return;
    const m = msg.message; if (!m) return;
    const inner = (m.viewOnceMessageV2 && m.viewOnceMessageV2.message) || (m.viewOnceMessage && m.viewOnceMessage.message) || m;
    const text = extractWAText(msg) || (inner.imageMessage && inner.imageMessage.caption) || (inner.videoMessage && inner.videoMessage.caption) || null;
    const img = inner.imageMessage || null;
    if (!text && !img) return; // skip stickers / reactions / system events
    const msgId = msg.key && msg.key.id; if (!msgId) return;
    const { run, get } = require('./db');
    const db = await getDb();
    if (get(db, `SELECT 1 FROM community_posts WHERE wa_msg_id=? LIMIT 1`, [msgId])) return; // dedupe
    let imagePath = null;
    if (img && _B && typeof _B.downloadMediaMessage === 'function') {
      try {
        fs.mkdirSync(COMMUNITY_DIR, { recursive: true });
        const buf = await _B.downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock && sock.updateMediaMessage });
        if (buf && buf.length) {
          const fname = String(msgId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) + '.jpg';
          fs.writeFileSync(path.join(COMMUNITY_DIR, fname), buf);
          imagePath = '/data/uploads/community/' + fname;
        }
      } catch { /* image is optional — keep the text post */ }
    }
    const ts = Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000);
    const sender = String((msg.key && msg.key.participant) || msg.pushName || '').split('@')[0];
    run(db, `INSERT OR IGNORE INTO community_posts (wa_msg_id, jid, sender, body, image_path, msg_ts) VALUES (?,?,?,?,?,?)`,
      [msgId, jid, sender, (text || '').trim(), imagePath, ts]);
  } catch { /* never break the message pipeline */ }
}

async function processIncomingWA(msg) {
  const jid = msg.key.remoteJid;
  if (!jid) return;
  if (jid.endsWith('@g.us') || jid === 'status@broadcast') return; // skip groups & status
  if (msg.key.fromMe) return;
  // Phone number behind a @lid address, when Baileys exposes it — lets owner
  // recognition work even when WhatsApp routes the sender via a LID.
  const senderPn = msg.key.senderPn || msg.key.participantPn || null;

  const text = extractWAText(msg);
  if (!text || text.trim().length < 1) return;

  // `.id` / `.whoami` — anyone may ask what address the bot sees them as, so the
  // owner can copy their LID into Settings → Owner WhatsApp LID.
  if (text.trim().toLowerCase() === '.id' || text.trim().toLowerCase() === '.whoami') {
    const s = getActiveSock();
    if (s) await s.sendMessage(jid, { text: `🆔 The bot sees you as:\n\nJID: ${jid}${senderPn ? `\nPhone: ${senderPn}` : ''}\n\nIf the JID ends in *@lid*, paste the number part into Admin → WhatsApp → *Owner WhatsApp LID* to enable admin commands.` });
    return;
  }

  // ── Owner admin commands (.deliver / .orders / .verify …) ──────────────────
  // Highest priority: handled even when the AI bot is disabled, and only for the
  // store owner (wa_owner_number / support_whatsapp / wa_owner_lid). A non-owner
  // who types a "." message just falls through to the normal AI flow.
  if (text.trim().startsWith('.')) {
    try {
      const waAdmin = require('./wa-admin');
      const owner = waAdmin.isOwnerJid(jid, senderPn);
      console.log(`[wa-bot] dot-command from jid=${jid}${senderPn ? ` pn=${senderPn}` : ''} owner=${owner}`);
      if (owner) {
        await waAdmin.handleAdminCommand(jid, text);
        return;
      }
    } catch (e) {
      console.error('[wa-bot] admin command error:', e.message);
    }
  }

  // 1-tap login trigger runs BEFORE rate-limit + AI checks so the magic link
  // still goes out even if the AI bot is disabled.
  if (await handleLoginTrigger(msg, jid, text)) return;

  // ── AI: order concierge (customer) + order-ops (owner) ─────────────────────
  const db = await getDb();
  let isOwner = false;
  try { isOwner = require('./wa-admin').isOwnerJid(jid, senderPn); } catch {}

  // The customer concierge is gated by the AI toggles; the owner's order-ops AI
  // always runs (when an AI channel is set) so the seller can manage via chat.
  if (!isOwner) {
    if (getSettingSync('wa_ai_reply_enabled') === '0') return;
    if (getSettingSync('bot_enabled') === '0') return;
  }

  // Per-JID rate limit (owner exempt) + rolling conversation history.
  const now = Date.now();
  const session = _waSessions.get(jid) || { messages: [], lastActive: now, count: 0, countTs: now };
  if (now - session.countTs > 60000) { session.count = 0; session.countTs = now; }
  session.count = (session.count || 0) + 1;
  if (!isOwner && session.count > 10) return; // silent rate limit
  if (now - session.lastActive > WA_SESSION_TTL) session.messages = [];
  session.lastActive = now;
  session.messages.push({ role: 'user', content: text.trim() });
  if (session.messages.length > WA_MAX_HISTORY) session.messages = session.messages.slice(-WA_MAX_HISTORY);
  _waSessions.set(jid, session);

  try {
    const aiOrders = require('./ai-orders');
    const reply = isOwner
      ? await aiOrders.runAdminTurn(db, jid, session.messages)
      : await aiOrders.runCustomerTurn(db, jid, session.messages);
    if (!reply) return;
    session.messages.push({ role: 'assistant', content: reply });
    if (session.messages.length > WA_MAX_HISTORY) session.messages = session.messages.slice(-WA_MAX_HISTORY);
    const s = getActiveSock();
    if (s) await s.sendMessage(jid, { text: mdToWhatsApp(reply) });
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

    // Secure session: rebuild the live session from the newest encrypted snapshot
    // if it's gone (volume reset / accidental clear) BEFORE Baileys reads the auth
    // state, retire the old per-file mirror, and re-index any orphan snapshots.
    try { await waSession.restoreSession(); } catch {}
    try { await waSession.dropLegacyMirror(); } catch {}
    try { await waSession.reconcileSnapshots(); } catch {}

    let { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    // ── Auto-recover from a STALE "ghost" session — ONCE per process ──────────
    // A leftover registered:false+me session (a previously-interrupted pairing)
    // is a silent ghost WhatsApp delivers no messages to. We clear it ONCE, on
    // the first connect after boot, so we start from a clean QR.
    //
    // CRITICAL: we must NOT re-check on later in-process reconnects. Right after
    // a fresh QR scan Baileys closes with a 515 "restart required" and the new
    // creds momentarily read registered:false+me — wiping THEN would destroy the
    // just-scanned session and the phone would spin forever in a re-pair loop.
    // The once-per-process guard (_ghostCheckDone) ensures the auto-clear only
    // runs at boot, never during a pairing.
    if (!_ghostCheckDone) {
      _ghostCheckDone = true;
      if (state?.creds?.registered === false && state?.creds?.me) {
        // We used to WIPE a registered:false session here. That was destructive:
        // on Baileys 7.x a working multi-device link can legitimately read
        // registered:false, so the wipe was logging out good sessions on every
        // boot/deploy. We NEVER auto-wipe now — if the link is truly dead the admin
        // re-links or restores a snapshot from Admin → Secure Session.
        console.warn('[wa-bot] session reports registered:false — NOT auto-wiping. If the bot is not delivering messages, re-link or restore a snapshot from Admin → Secure Session.');
      }
    }
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
        connStatus       = 'disconnected';
        connectedNumber  = null;

        // Another instance took over this exact session — almost always the NEW
        // container during an overlapping Railway deploy. Reconnecting here would
        // fight it (connectionReplaced ping-pong), and that storm is what makes
        // WhatsApp eventually invalidate the link. Stand down quietly and KEEP the
        // session — the new instance owns it now (this old container will exit on
        // its own SIGTERM shortly).
        if (code === DisconnectReason.connectionReplaced) {
          isStarting = false;
          _waReconnectAttempts = 0;
          _stoodDown = true; // don't let the watchdog auto-reconnect and steal the session from the live instance
          console.log('[wa-bot] connection replaced by another instance — standing down, session preserved');
          return;
        }

        const reconnect = (code !== DisconnectReason.loggedOut);
        if (reconnect) {
          isStarting = false;
          _waReconnectAttempts = Math.min(_waReconnectAttempts + 1, 6);
          const delayMs = Math.min(3000 * Math.pow(2, _waReconnectAttempts - 1), 60000);
          console.log(`[wa-bot] reconnect attempt #${_waReconnectAttempts} in ${delayMs}ms (close code ${code})`);
          setTimeout(() => startBaileysBot(), delayMs);
        } else {
          // WhatsApp logged us out (genuine unlink, or a conflict that escalated).
          // Keep snapshots so the admin can roll back if it was accidental; the
          // dead live session just sits until they re-link or restore a snapshot.
          connStatus = 'logged_out';
          isStarting = false;
          _waReconnectAttempts = 0;
        }
      }

      if (connection === 'open') {
        currentQR       = null;
        connStatus       = 'connected';
        connectedNumber  = sock.user?.id?.split(':')[0] || sock.user?.id || 'Unknown';
        _waReconnectAttempts = 0; // happy path resets the backoff
        _stoodDown = false;       // we own the connection again
        // Persist the bot's own number so the storefront 1-tap WhatsApp login
        // sends users to the bot (which auto-replies a magic link), not the
        // human support line.
        try { if (/^\d{6,}$/.test(connectedNumber)) setSettingSync('wa_bot_number', connectedNumber); } catch {}
        console.log(`[wa-bot] Connected as ${connectedNumber}`);
        // Registration sanity: a "ghost" session (registered:false) opens a
        // socket and reports a number, but WhatsApp delivers NO messages to it —
        // the bot looks connected yet silently never replies. Make that loud.
        try {
          if (state?.creds?.registered === false) {
            console.warn('[wa-bot] ⚠️ SESSION NOT REGISTERED (ghost link) — WhatsApp will NOT deliver messages here. Re-link: Admin → WhatsApp → Logout → Connect → scan the QR with the bot phone.');
          } else {
            console.log('[wa-bot] session registered ✓ (messages will be delivered)');
          }
        } catch {}
        try { if (typeof sock.uploadPreKeysToServerIfRequired === 'function') await sock.uploadPreKeysToServerIfRequired(); } catch {}
        try { await sock.sendPresenceUpdate('available'); } catch {}
        // Secure session: snapshot on connect (cooldown-guarded) + ensure the
        // hourly snapshot timer is running.
        maybeSnapshot('on_connect');
        startSnapshotTimer();
      }
    });

    sock.ev.on('creds.update', saveCreds); // live session persists on the volume; snapshots are the backup

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
        // Mirror community/announcement-group posts to the /community feed
        // (captures own posts too, since admins may post from this number).
        if (type === 'notify') captureCommunityPost(msg).catch(() => {});
      }
    });

    // Backfill older posts: when WhatsApp delivers chat history (the recent-history
    // batch on connect, or an on-demand fetch), mirror any community-group posts we
    // don't already have. Lets some pre-existing group messages show on /community.
    sock.ev.on('messaging-history.set', ({ messages }) => {
      try {
        if (!Array.isArray(messages) || !messages.length) return;
        if (getSettingSync('community_enabled') !== '1') return;
        const wantJid = (getSettingSync('community_jid') || '').trim();
        if (!wantJid) return;
        for (const msg of messages) {
          if (msg && msg.key && msg.key.remoteJid === wantJid) captureCommunityPost(msg).catch(() => {});
        }
      } catch { /* never break on a history batch */ }
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

// Close socket WITHOUT logging out from WhatsApp — session files stay valid.
// Use this on deploy / reconnect so session persists.
async function disconnect() {
  if (sock) {
    try { sock.ev.removeAllListeners(); } catch {}
    try { sock.end(); } catch {}
    sock = null;
  }
  currentQR       = null;
  connStatus       = 'disconnected';
  connectedNumber  = null;
}

// Actually log out from WhatsApp (invalidates session on WA servers).
// Only call when the user explicitly wants to un-link the device.
async function logout() {
  if (sock) {
    try { await sock.logout(); } catch {}
    try { sock.ev.removeAllListeners(); } catch {}
    sock = null;
  }
  currentQR       = null;
  connStatus       = 'logged_out';
  connectedNumber  = null;
  try { setSettingSync('wa_bot_number', ''); } catch {}
  // Keep snapshots on logout so an accidental unlink can still be rolled back.
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

// Clears session files — forces fresh QR scan next connect.
async function clearSession() {
  await disconnect();
  if (fs.existsSync(SESSION_DIR)) {
    try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch {}
  }
  try { await waSession.clearAll(); } catch {} // wipe snapshots too, else next boot restores them
  connStatus = 'disconnected';
}

function getSessionInfo() {
  try {
    if (!fs.existsSync(SESSION_DIR)) return { exists: false, files: 0, sizeKB: 0, modifiedAt: null };
    const files = fs.readdirSync(SESSION_DIR);
    let totalSize = 0;
    let lastMod = 0;
    for (const f of files) {
      try {
        const st = fs.statSync(path.join(SESSION_DIR, f));
        totalSize += st.size;
        if (st.mtimeMs > lastMod) lastMod = st.mtimeMs;
      } catch {}
    }
    return { exists: true, files: files.length, sizeKB: Math.round(totalSize / 1024), modifiedAt: lastMod ? new Date(lastMod).toISOString() : null };
  } catch { return { exists: false, files: 0, sizeKB: 0, modifiedAt: null }; }
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

      if (connStatus === 'disconnected' && !isStarting && !_stoodDown && stuckMs > 90000) {
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

// Secure-session snapshot helpers.
function maybeSnapshot(label) {
  const now = Date.now();
  if (label === 'on_connect' && now - _lastSnapAt < 120000) return; // cooldown: don't spam on reconnect flaps
  _lastSnapAt = now;
  waSession.createSnapshot(label).catch(() => {});
}
function startSnapshotTimer() {
  if (_snapTimer) return;
  _snapTimer = setInterval(() => {
    if (connStatus === 'connected') waSession.createSnapshot('hourly').catch(() => {});
  }, 60 * 60 * 1000);
}

// Graceful shutdown — snapshot the latest state + close the socket WITHOUT logging
// out. Called from index.js on SIGTERM/SIGINT (Railway deploys), so the old
// container stops using the WhatsApp connection during an overlapping deploy.
function shutdownBot() {
  try { waSession.createSnapshot('pre_shutdown'); } catch {} // capture latest state before Railway kills us
  try { if (sock) { sock.ev.removeAllListeners(); sock.end(); } } catch {}
  sock = null;
  connStatus = 'disconnected';
}

module.exports = {
  connect, disconnect, logout, reconnect, clearSession, requestPairingCode, shutdownBot,
  getStatus, getQR, getQRBase64, getActiveSock,
  sendToPhone, sendToGroup,
  getGroups, testMetaCreds, startWatchdog,
  getSessionInfo,
  getDiagnostics: () => _lastSkip,
};
