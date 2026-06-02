'use strict';
/**
 * Secure WhatsApp Session — encrypted snapshots + restore, survives Railway
 * redeploys without re-scanning the QR.
 *
 * Model (mirrors store.whatsapp-Bot's Secure Session):
 *   • LIVE session  → data/wa-session  (Baileys auth files, on the Railway volume)
 *   • SNAPSHOTS     → data/wa-snapshots/snap-<ts>-<label>.enc  (one AES-256-GCM
 *                     blob per point-in-time backup) + metadata in wa_session_snapshots.
 *   • Auto-taken on connect, hourly while online, and right before shutdown (SIGTERM),
 *     so a corrupted/wiped session can be rolled back WITHOUT re-pairing.
 *   • restoreSession() on boot rebuilds the live session from the latest snapshot
 *     if the on-disk session is gone (volume reset / accidental clear).
 *   • Offsite bundle = live session + every snapshot packed into one sealed blob,
 *     useless without WA_SESSION_KEY.
 *
 * Encryption (wa-crypto.js / WA_SESSION_KEY) is applied to every stored blob; with
 * no key set everything still works (plaintext) so the bot never breaks on a
 * missing key — it's just not encrypted until the key is configured.
 */
const fs   = require('fs');
const path = require('path');
const { getDb, all, get, run } = require('./db');
const crypto = require('./wa-crypto');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const SESSION_DIR = path.join(DATA_DIR, 'wa-session');
const SNAP_DIR    = path.join(DATA_DIR, 'wa-snapshots');
const KEEP_SNAPSHOTS = 10;

function ensureDirs() {
  try { fs.mkdirSync(SESSION_DIR, { recursive: true }); } catch {}
  try { fs.mkdirSync(SNAP_DIR, { recursive: true }); } catch {}
}

// Read all flat session files into { filename: content }.
function readSessionFiles() {
  const out = {};
  let names = [];
  try { names = fs.readdirSync(SESSION_DIR); } catch { return out; }
  for (const name of names) {
    try {
      const fp = path.join(SESSION_DIR, name);
      if (!fs.statSync(fp).isFile()) continue;
      out[name] = fs.readFileSync(fp, 'utf8');
    } catch {}
  }
  return out;
}

function writeSessionFiles(map, { wipe = true } = {}) {
  ensureDirs();
  if (wipe) {
    try { for (const f of fs.readdirSync(SESSION_DIR)) { try { fs.rmSync(path.join(SESSION_DIR, f), { force: true }); } catch {} } } catch {}
  }
  let n = 0;
  for (const [name, content] of Object.entries(map || {})) {
    try { fs.writeFileSync(path.join(SESSION_DIR, name), content); n++; } catch {}
  }
  return n;
}

// ─── Snapshots ────────────────────────────────────────────────────────────────
function safeLabel(s) { return String(s || 'manual').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24) || 'manual'; }

// Take a point-in-time snapshot of the live session. Returns metadata or null.
async function createSnapshot(label = 'manual') {
  ensureDirs();
  const files = readSessionFiles();
  const count = Object.keys(files).length;
  if (count === 0) return null; // nothing to snapshot
  const ts = Date.now();
  const fname = `snap-${ts}-${safeLabel(label)}.enc`;
  const blob = crypto.seal(JSON.stringify(files));
  try { fs.writeFileSync(path.join(SNAP_DIR, fname), blob); }
  catch (e) { console.warn('[wa-session] snapshot write failed:', e.message); return null; }
  let size = 0; try { size = fs.statSync(path.join(SNAP_DIR, fname)).size; } catch {}
  try {
    const db = await getDb();
    run(db, `INSERT INTO wa_session_snapshots (label, file_count, size_bytes, filename, created_at)
             VALUES (?,?,?,?,datetime('now'))`, [safeLabel(label), count, size, fname]);
    await pruneSnapshots();
    const row = get(db, `SELECT id, label, file_count, size_bytes, filename, created_at FROM wa_session_snapshots WHERE filename=?`, [fname]);
    console.log(`[wa-session] snapshot ${fname} (${count} files, ${(size/1024).toFixed(0)}KB)`);
    return row;
  } catch (e) { console.warn('[wa-session] snapshot meta failed:', e.message); return null; }
}

async function listSnapshots() {
  try {
    const db = await getDb();
    return all(db, `SELECT id, label, file_count, size_bytes, filename, created_at
                    FROM wa_session_snapshots ORDER BY created_at DESC, id DESC`);
  } catch { return []; }
}

async function pruneSnapshots(keep = KEEP_SNAPSHOTS) {
  try {
    const db = await getDb();
    const rows = all(db, `SELECT id, filename FROM wa_session_snapshots ORDER BY created_at DESC, id DESC`);
    for (const r of rows.slice(keep)) {
      try { fs.rmSync(path.join(SNAP_DIR, r.filename), { force: true }); } catch {}
      run(db, `DELETE FROM wa_session_snapshots WHERE id=?`, [r.id]);
    }
  } catch {}
}

async function deleteSnapshot(id) {
  const db = await getDb();
  const row = get(db, `SELECT filename FROM wa_session_snapshots WHERE id=?`, [id]);
  if (!row) return false;
  try { fs.rmSync(path.join(SNAP_DIR, row.filename), { force: true }); } catch {}
  run(db, `DELETE FROM wa_session_snapshots WHERE id=?`, [id]);
  return true;
}

// Load a snapshot's files (decrypted) — used by restore.
function loadSnapshotFiles(filename) {
  const blob = fs.readFileSync(path.join(SNAP_DIR, filename), 'utf8');
  return JSON.parse(crypto.unseal(blob));
}

// Write a snapshot's files onto the live session dir (wipes the live dir first).
// Caller is responsible for stopping/restarting the bot around this.
async function restoreSnapshotToDisk(id) {
  const db = await getDb();
  const row = get(db, `SELECT filename, file_count FROM wa_session_snapshots WHERE id=?`, [id]);
  if (!row) throw new Error('Snapshot not found');
  const files = loadSnapshotFiles(row.filename);
  const n = writeSessionFiles(files, { wipe: true });
  console.log(`[wa-session] restored snapshot #${id} → ${n} files`);
  return n;
}

// ─── Boot restore ─────────────────────────────────────────────────────────────
// If the live session is gone (no creds.json), rebuild it from the newest
// snapshot so a volume reset / accidental clear doesn't force a re-scan.
async function restoreSession() {
  try {
    ensureDirs();
    if (fs.existsSync(path.join(SESSION_DIR, 'creds.json'))) return 0; // live session present
    // Pick the newest snapshot FILE on disk by its timestamp in the name — robust
    // even if a pre-shutdown snapshot's DB metadata row didn't flush before exit.
    let newest = null, newestTs = 0;
    try {
      for (const f of fs.readdirSync(SNAP_DIR)) {
        const m = f.match(/^snap-(\d+)-.*\.enc$/);
        if (m && +m[1] > newestTs) { newestTs = +m[1]; newest = f; }
      }
    } catch {}
    if (!newest) return 0;
    const files = loadSnapshotFiles(newest);
    const n = writeSessionFiles(files, { wipe: true });
    console.log(`[wa-session] live session missing — restored ${n} files from ${newest}`);
    return n;
  } catch (e) { console.warn('[wa-session] boot restore failed:', e.message); return 0; }
}

// Re-create DB metadata rows for any snapshot .enc file on disk that the table
// doesn't know about (e.g. a pre-shutdown snapshot whose row didn't flush). Keeps
// the admin list in sync with what's actually on the volume.
async function reconcileSnapshots() {
  try {
    ensureDirs();
    const db = await getDb();
    const known = new Set(all(db, `SELECT filename FROM wa_session_snapshots`).map(r => r.filename));
    for (const f of fs.readdirSync(SNAP_DIR)) {
      if (!f.endsWith('.enc') || known.has(f)) continue;
      const m = f.match(/^snap-(\d+)-([a-z0-9_-]+)\.enc$/i);
      let count = 0, size = 0;
      try { size = fs.statSync(path.join(SNAP_DIR, f)).size; } catch {}
      try { count = Object.keys(loadSnapshotFiles(f)).length; } catch {}
      run(db, `INSERT INTO wa_session_snapshots (label, file_count, size_bytes, filename, created_at) VALUES (?,?,?,?,?)`,
        [m ? m[2] : 'import', count, size, f, m ? new Date(+m[1]).toISOString() : new Date().toISOString()]);
    }
    await pruneSnapshots();
  } catch (e) { console.warn('[wa-session] reconcile failed:', e.message); }
}

// ─── Offsite bundle (one sealed blob = live session + all snapshots) ───────────
async function exportBundle() {
  ensureDirs();
  const db = await getDb();
  const snaps = all(db, `SELECT id, label, file_count, size_bytes, filename, created_at FROM wa_session_snapshots ORDER BY created_at DESC, id DESC`);
  const snapshots = [];
  for (const s of snaps) {
    try { snapshots.push({ label: s.label, created_at: s.created_at, files: loadSnapshotFiles(s.filename) }); } catch {}
  }
  const payload = { v: 1, exported_at: new Date().toISOString(), session: readSessionFiles(), snapshots };
  return crypto.seal(JSON.stringify(payload)); // one sealed string
}

async function importBundle(sealedBlob, { merge = false } = {}) {
  const payload = JSON.parse(crypto.unseal(String(sealedBlob).trim()));
  if (!payload || payload.v !== 1) throw new Error('Unrecognised bundle format');
  ensureDirs();
  // Restore live session.
  const n = writeSessionFiles(payload.session || {}, { wipe: !merge });
  // Recreate snapshots from the bundle.
  const db = await getDb();
  if (!merge) {
    for (const r of all(db, `SELECT filename FROM wa_session_snapshots`)) { try { fs.rmSync(path.join(SNAP_DIR, r.filename), { force: true }); } catch {} }
    run(db, `DELETE FROM wa_session_snapshots`);
  }
  for (const s of (payload.snapshots || [])) {
    try {
      const ts = Date.now() + Math.floor(Object.keys(s.files || {}).length); // unique-ish
      const fname = `snap-${ts}-${safeLabel(s.label || 'import')}.enc`;
      const blob = crypto.seal(JSON.stringify(s.files || {}));
      fs.writeFileSync(path.join(SNAP_DIR, fname), blob);
      run(db, `INSERT INTO wa_session_snapshots (label, file_count, size_bytes, filename, created_at)
               VALUES (?,?,?,?,?)`, [safeLabel(s.label || 'import'), Object.keys(s.files || {}).length, blob.length, fname, s.created_at || new Date().toISOString()]);
    } catch {}
  }
  await pruneSnapshots();
  return n;
}

// Clear ALL backups (snapshots) — used by the admin "Logout & Clear" wipe. Also
// drops the legacy per-file mirror table if it still has rows.
async function clearAll() {
  try {
    const db = await getDb();
    for (const r of all(db, `SELECT filename FROM wa_session_snapshots`)) { try { fs.rmSync(path.join(SNAP_DIR, r.filename), { force: true }); } catch {} }
    run(db, `DELETE FROM wa_session_snapshots`);
    try { run(db, `DELETE FROM wa_session_files`); } catch {}
    console.log('[wa-session] all snapshots cleared');
  } catch (e) { console.warn('[wa-session] clearAll failed:', e.message); }
}

// One-time: the previous design mirrored every file into wa_session_files, which
// bloats the sql.js DB (it rewrites wholesale on each flush). The snapshot model
// replaces it — drop those rows on boot to reclaim space.
async function dropLegacyMirror() {
  try { const db = await getDb(); const r = get(db, `SELECT COUNT(*) AS c FROM wa_session_files`); if (r && r.c > 0) { run(db, `DELETE FROM wa_session_files`); console.log(`[wa-session] dropped ${r.c} legacy mirror rows`); } } catch {}
}

// ─── Status (for the admin Secure Session page) ────────────────────────────────
async function getStatus() {
  ensureDirs();
  const sessFiles = (() => { try { return fs.readdirSync(SESSION_DIR).filter(f => { try { return fs.statSync(path.join(SESSION_DIR, f)).isFile(); } catch { return false; } }); } catch { return []; } })();
  let lastUpdate = null;
  for (const f of sessFiles) { try { const m = fs.statSync(path.join(SESSION_DIR, f)).mtimeMs; if (!lastUpdate || m > lastUpdate) lastUpdate = m; } catch {} }
  const dbPath = path.join(DATA_DIR, 'store.db');
  let dbSize = 0, dbMtime = null;
  try { const st = fs.statSync(dbPath); dbSize = st.size; dbMtime = st.mtimeMs; } catch {}
  const snaps = await listSnapshots();
  return {
    encryptionOn: crypto.isConfigured(),
    keyFingerprint: crypto.keyFingerprint(),
    liveFiles: sessFiles.length,
    lastUpdate: lastUpdate ? new Date(lastUpdate).toISOString() : null,
    snapshotCount: snaps.length,
    snapshots: snaps,
    volumeMount: process.env.RAILWAY_VOLUME_MOUNT_PATH || null,
    dbPath, dbSizeBytes: dbSize, dbMtime: dbMtime ? new Date(dbMtime).toISOString() : null,
  };
}

module.exports = {
  restoreSession, reconcileSnapshots, createSnapshot, listSnapshots, pruneSnapshots, deleteSnapshot,
  restoreSnapshotToDisk, exportBundle, importBundle, clearAll, dropLegacyMirror, getStatus,
  SESSION_DIR, SNAP_DIR,
};
