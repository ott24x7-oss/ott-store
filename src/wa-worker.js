'use strict';
/**
 * WhatsApp Worker — two jobs:
 *
 *  1. Group Auto-Post (5-min tick, IST 9–23)
 *     Rotates through wa_offers, posts one to all selected WA groups
 *     per interval (default 45 min). Records per-group success/fail.
 *
 *  2. Daily Summary (9 PM IST, once per day)
 *     Sends revenue + order stats to the admin's WhatsApp number.
 */
const { getDb, getSettingSync, setSettingSync, all, get } = require('./db');
const { getActiveSock, sendToPhone } = require('./wa-bot');

// IST hour helper: UTC + 5h30m
function istHour() {
  const d = new Date();
  return (d.getUTCHours() * 60 + d.getUTCMinutes() + 330) % 1440 / 60 | 0;
}

// ─── Skip-reason tracking ─────────────────────────────────────────────────────
const _lastSkip = {};
function recordSkip(key, reason) {
  _lastSkip[key] = { reason, at: new Date().toISOString() };
  const now = Date.now();
  const logKey = key + '|' + reason;
  if (!_logCooldown[logKey] || now - _logCooldown[logKey] > 30 * 60 * 1000) {
    console.log(`[wa-worker] ${key}: skipped — ${reason}`);
    _logCooldown[logKey] = now;
  }
}
const _logCooldown = {};
function getDiagnostics() { return { ..._lastSkip }; }

// ─── Auto-Post tick ───────────────────────────────────────────────────────────
async function runAutoPost() {
  const enabled = getSettingSync('wa_autopost_enabled');
  if (enabled !== '1') return recordSkip('autopost', 'wa_autopost_enabled is off');

  const sock = getActiveSock();
  if (!sock) return recordSkip('autopost', 'WhatsApp not connected');

  const groups = JSON.parse(getSettingSync('wa_autopost_groups') || '[]');
  if (!groups.length) return recordSkip('autopost', 'no groups selected');

  const startH    = parseInt(getSettingSync('wa_autopost_start')    || '9');
  const endH      = parseInt(getSettingSync('wa_autopost_end')      || '23');
  const intervalM = parseInt(getSettingSync('wa_autopost_interval') || '45');
  const h         = istHour();

  if (h < startH || h >= endH) return recordSkip('autopost', `outside IST ${startH}–${endH} (current ${h})`);

  const lastTime = getSettingSync('wa_autopost_last_time') || '0';
  if ((Date.now() - parseInt(lastTime)) / 60000 < intervalM) {
    const left = Math.ceil(intervalM - (Date.now() - parseInt(lastTime)) / 60000);
    return recordSkip('autopost', `interval not elapsed (${left} min left)`);
  }

  const db = await getDb();
  // Pick next active offer (round-robin via last_posted_at)
  const offer = get(db,
    `SELECT * FROM wa_offers WHERE active=1 ORDER BY last_posted_at ASC NULLS FIRST, id ASC LIMIT 1`
  );
  if (!offer) return recordSkip('autopost', 'no active WA offers');

  let sent = 0;
  let metaMap = {};
  try {
    if (typeof sock.groupFetchAllParticipating === 'function') {
      const all_ = await sock.groupFetchAllParticipating();
      for (const k of Object.keys(all_)) metaMap[k] = all_[k].subject || null;
    }
  } catch {}

  for (const gid of groups) {
    const groupName = metaMap[gid] || null;
    let success = false;
    let errMsg  = null;
    try {
      if (offer.image_b64) {
        const buf = Buffer.from(offer.image_b64, 'base64');
        await sock.sendMessage(gid, { image: buf, caption: offer.text });
      } else {
        await sock.sendMessage(gid, { text: offer.text });
      }
      success = true;
      sent++;
      await new Promise(r => setTimeout(r, 2000)); // 2s pacing
    } catch (e) {
      errMsg = e.message || String(e);
    }
    // Record per-group result
    db.run(
      `INSERT INTO wa_offer_log (offer_id, group_id, group_name, success, error) VALUES (?, ?, ?, ?, ?)`,
      [offer.id, gid, groupName, success ? 1 : 0, errMsg]
    );
  }

  db.run(`UPDATE wa_offers SET last_posted_at=datetime('now') WHERE id=?`, [offer.id]);
  setSettingSync('wa_autopost_last_time', String(Date.now()));
  console.log(`[wa-worker] autopost: offer #${offer.id} → ${sent}/${groups.length} groups`);
}

// ─── Daily summary ────────────────────────────────────────────────────────────
async function runDailySummary() {
  if (getSettingSync('wa_daily_summary') !== '1') return;
  const ownerNum = getSettingSync('wa_owner_number');
  if (!ownerNum) return;

  const h     = istHour();
  const today = new Date().toISOString().split('T')[0];
  if (h !== 21) return; // 9 PM IST only
  // Dedup ACROSS RESTARTS via a persisted date (not an in-memory flag, which reset on
  // every restart and sent a duplicate per redeploy). We persist only AFTER a confirmed
  // send, and bail if the bot is offline, so a disconnected 9 PM (e.g. mid-redeploy)
  // retries on the next tick instead of silently burning the day with no summary at all.
  if (getSettingSync('wa_last_daily_summary') === today) return;
  if (!getActiveSock()) return;

  try {
    const db = await getDb();
    // Count by IST calendar day (UTC+5:30) to match the 9 PM-IST send window — otherwise
    // orders placed IST 00:00–05:30 (a prior UTC day) silently drop out of the summary.
    const stats = get(db,
      `SELECT COALESCE(SUM(amount_inr),0) as rev, COUNT(*) as orders,
              COUNT(DISTINCT customer_jid) as customers
       FROM orders WHERE status NOT IN ('cancelled')
         AND date(created_at,'+330 minutes')=date('now','+330 minutes')`
    );
    const topPlan = get(db,
      `SELECT p.name, COUNT(*) as c FROM orders o LEFT JOIN plans p ON o.plan_id=p.id
       WHERE o.status NOT IN ('cancelled')
         AND date(o.created_at,'+330 minutes')=date('now','+330 minutes')
       GROUP BY o.plan_id ORDER BY c DESC LIMIT 1`
    );
    const pending = get(db, `SELECT COUNT(*) as c FROM orders WHERE status='pending'`);

    const date = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
    const msg =
      `📊 *Daily Summary — ${date}*\n\n` +
      `💰 Revenue: ₹${(stats.rev || 0).toFixed(2)}\n` +
      `📦 Orders: ${stats.orders || 0} completed, ${pending.c || 0} pending\n` +
      `👥 Customers: ${stats.customers || 0} unique\n` +
      `🏆 Top: ${topPlan ? topPlan.name + ' (' + topPlan.c + ' sales)' : 'N/A'}\n\n` +
      `_OTT Store Admin Panel_`;

    const ok = await sendToPhone(ownerNum, msg);
    if (ok) {
      setSettingSync('wa_last_daily_summary', today); // burn the day only on a real send
      console.log('[wa-worker] Daily summary sent to', ownerNum);
    } else {
      console.warn('[wa-worker] Daily summary not sent (WhatsApp offline) — will retry next tick');
    }
  } catch (e) {
    console.error('[wa-worker] Daily summary error:', e.message);
  }
}

// ─── Ticker ───────────────────────────────────────────────────────────────────
function startWaWorker() {
  // Main tick every 5 minutes
  setInterval(async () => {
    try { await runAutoPost(); } catch (e) { console.error('[wa-worker] autopost tick:', e.message); }
    try { await runDailySummary(); } catch (e) { console.error('[wa-worker] summary tick:', e.message); }
  }, 5 * 60 * 1000);

  // First tick after 90s (give bot time to connect)
  setTimeout(async () => {
    try { await runAutoPost(); } catch {}
    try { await runDailySummary(); } catch {}
  }, 90 * 1000);

  console.log('[wa-worker] WA autopost + daily summary worker started');
}

module.exports = { startWaWorker, getDiagnostics };
