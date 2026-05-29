'use strict';
const { getDb, run } = require('./db');

async function audit({ actorKind, actorLabel, action, targetKind, targetId, before, after, ip }) {
  try {
    const db = await getDb();
    run(db,
      `INSERT INTO audit_log (actor_kind,actor_label,action,target_kind,target_id,before_json,after_json,ip)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        actorKind || 'system',
        actorLabel || '',
        action || '',
        targetKind || '',
        String(targetId || ''),
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        ip || '',
      ]
    );
  } catch (e) {
    // audit must never crash the request
  }
}

module.exports = { audit };
