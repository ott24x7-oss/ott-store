'use strict';
// Daily database backup → Telegram. Mirrors the other workers' structure: a
// guarded tick on an interval that checks whether enough time has elapsed since
// the last successful backup, then exports the sql.js DB and sends it as a
// document to the configured Telegram chat/channel. backupNow() is the shared
// path used by both this scheduler and the admin "Backup now" button.
const { getDb, getSetting, setSetting } = require('./db');
const telegram = require('./telegram');

function backupFilename() {
  // store-backup-2026-06-12T16-45-04.db
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `store-backup-${stamp}.db`;
}

// Export the current DB and push it to Telegram. Throws on misconfiguration or
// API failure so callers can surface the reason. `reason` is shown in the caption.
async function backupNow(reason) {
  const token = (await getSetting('telegram_bot_token') || '').trim();
  const chatId = (await getSetting('telegram_backup_chat_id') || '').trim();
  if (!token || !chatId) throw new Error('Set the Telegram bot token and chat/channel ID first.');
  const db = await getDb();
  const buf = Buffer.from(db.export());
  const siteName = (await getSetting('site_name')) || 'Virtual Market';
  const caption = `🗄️ <b>${siteName}</b> — ${reason || 'Backup'}\n${Math.round(buf.length / 1024).toLocaleString()} KB · ${new Date().toUTCString()}`;
  await telegram.sendDocument(token, chatId, buf, backupFilename(), caption);
  await setSetting('backup_last_at', new Date().toISOString());
  await setSetting('backup_last_size', String(buf.length));
  return { size: buf.length };
}

let _running = false;
async function runBackupTick() {
  if (_running) return;
  _running = true;
  try {
    if ((await getSetting('backup_telegram_enabled')) !== '1') return;
    const token = (await getSetting('telegram_bot_token') || '').trim();
    const chatId = (await getSetting('telegram_backup_chat_id') || '').trim();
    if (!token || !chatId) return;
    const intervalH = Math.max(1, parseFloat(await getSetting('backup_interval_hours') || '24') || 24);
    const last = await getSetting('backup_last_at');
    if (last) {
      const elapsedH = (Date.now() - new Date(last).getTime()) / 3600000;
      if (elapsedH < intervalH) return; // not due yet
    }
    await backupNow('Scheduled backup');
    console.log('[backup-worker] backup sent to Telegram');
  } catch (e) {
    console.error('[backup-worker]', e.message);
  } finally {
    _running = false;
  }
}

function startBackupWorker() {
  setInterval(runBackupTick, 30 * 60 * 1000); // re-check every 30 min
  setTimeout(runBackupTick, 60 * 1000);       // first check ~1 min after boot
}

module.exports = { startBackupWorker, runBackupTick, backupNow };
