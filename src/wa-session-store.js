'use strict';
/**
 * Secure WhatsApp Session — survive Railway redeploys without re-scanning the QR.
 *
 * Baileys keeps its auth in files under data/wa-session. On Railway a redeploy can
 * reset the container filesystem, and an overlapping deploy (old + new container
 * both connected with the same creds) can churn the link. We mirror the session
 * files into the SQLite DB (store.db) after every change and restore them on boot,
 * so the linked device persists across deploys/restarts.
 *
 * Ported from store.whatsapp-Bot/src/session-store.js to CommonJS + ott-store's db
 * helpers. DB writes are cheap here — db.js marks the DB dirty and flushes to disk
 * on a 5s timer, so backing up many small key files does not hammer the disk.
 */
const fs   = require('fs');
const path = require('path');
const { getDb, all, run } = require('./db');

// Restore session files from the DB onto disk. Called on boot BEFORE Baileys reads
// the auth state — but ONLY when the on-disk session is missing, so we never
// clobber a live local session. Returns the number of files restored.
async function restoreSession(sessionDir) {
  try {
    const db = await getDb();
    const rows = all(db, 'SELECT filename, content FROM wa_session_files');
    if (!rows.length) return 0;
    fs.mkdirSync(sessionDir, { recursive: true });
    let n = 0;
    for (const r of rows) {
      try {
        const fp = path.join(sessionDir, r.filename);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, r.content);
        n++;
      } catch {}
    }
    if (n) console.log(`[wa-session] restored ${n} session file(s) from DB`);
    return n;
  } catch (e) { console.warn('[wa-session] restore failed:', e.message); return 0; }
}

// Mirror all on-disk session files into the DB. Debounced — coalesces bursts of
// creds.update events into one backup. Pass immediate=true to flush right now
// (used on graceful shutdown).
let _timer = null;
function backupSession(sessionDir, immediate = false) {
  if (immediate) { if (_timer) { clearTimeout(_timer); _timer = null; } return _doBackup(sessionDir); }
  if (_timer) return;                       // a backup is already scheduled
  _timer = setTimeout(() => { _timer = null; _doBackup(sessionDir); }, 3000);
}

async function _doBackup(sessionDir) {
  try {
    if (!fs.existsSync(sessionDir)) return;
    const db = await getDb();
    const names = fs.readdirSync(sessionDir).filter(n => {
      try { return fs.statSync(path.join(sessionDir, n)).isFile(); } catch { return false; }
    });
    const onDisk = new Set(names);
    for (const name of names) {
      try {
        const content = fs.readFileSync(path.join(sessionDir, name), 'utf8');
        run(db, `INSERT OR REPLACE INTO wa_session_files (filename, content, updated_at) VALUES (?,?,datetime('now'))`, [name, content]);
      } catch {}
    }
    // Drop rows for keys Baileys rotated out, so the mirror doesn't grow unbounded
    // and stale keys are never restored.
    const dbRows = all(db, 'SELECT filename FROM wa_session_files');
    for (const r of dbRows) if (!onDisk.has(r.filename)) run(db, 'DELETE FROM wa_session_files WHERE filename=?', [r.filename]);
  } catch (e) { console.warn('[wa-session] backup failed:', e.message); }
}

// Wipe the DB-backed session. Call whenever the on-disk session is intentionally
// cleared or WhatsApp logs us out, so a dead/ghost session is never restored.
async function clearSavedSession() {
  try { const db = await getDb(); run(db, 'DELETE FROM wa_session_files'); console.log('[wa-session] DB session backup cleared'); }
  catch (e) { console.warn('[wa-session] clear failed:', e.message); }
}

module.exports = { restoreSession, backupSession, clearSavedSession };
