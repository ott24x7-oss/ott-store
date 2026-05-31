'use strict';
const fs = require('fs');
const path = require('path');

const apiPath = path.join(__dirname, '..', 'src', 'admin-api.js');
let c = fs.readFileSync(apiPath, 'utf8');

// Remove any botched earlier insert attempts (lines with SELECT: command not found noise)
// Insert the clean routes before the second occurrence of '// ─── Check auth status'
const MARKER = '// ─── Check auth status ────────────────────────────────────────────────────────\nrouter.get(\'/me\', requireAdmin, (req, res) => res.json({ ok: true, role: \'admin\' }));\n\n// ─── Cross-origin WA offer';

if (c.includes('contact-team')) {
  console.log('contact-team routes already present, skipping');
  process.exit(0);
}

const INSERT = `// ─── Support Team Contacts ────────────────────────────────────────────────────
router.get('/contact-team', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const row = get(db, \`SELECT value FROM settings WHERE key='contact_team'\`);
    let team = [];
    try { team = JSON.parse(row?.value || '[]'); } catch {}
    if (!Array.isArray(team)) team = [];
    res.json({ team });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/contact-team', requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    let team = req.body.team;
    if (!Array.isArray(team)) return res.status(400).json({ error: 'team must be array' });
    team = team.map(c => ({
      name:  String(c.name  || '').trim().slice(0, 80),
      role:  String(c.role  || 'Support').trim().slice(0, 40),
      phone: String(c.phone || '').replace(/[^0-9]/g, '').slice(0, 15),
    })).filter(c => c.phone.length >= 7);
    run(db, \`INSERT OR REPLACE INTO settings (key,value) VALUES ('contact_team',?)\`, [JSON.stringify(team)]);
    res.json({ ok: true, team });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

`;

const replaced = c.replace(MARKER, INSERT + MARKER);
if (replaced === c) {
  console.error('ERROR: marker not found — check the marker string');
  process.exit(1);
}
fs.writeFileSync(apiPath, replaced);
console.log('Patched admin-api.js with contact-team routes');
