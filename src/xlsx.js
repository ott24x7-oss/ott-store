'use strict';
// Minimal, dependency-free XLSX (Office Open XML) writer.
// Produces a real .xlsx workbook as a Buffer — no npm packages required.
// Scope: a single worksheet built from a header row + data rows. Cells are
// written as numbers when the value is a finite number, otherwise as inline
// strings (so unicode like ₹ and arbitrary text round-trips cleanly). This is
// intentionally small; it is not a general spreadsheet library.

const zlib = require('zlib');

// ── CRC32 (needed for ZIP entries, even when stored uncompressed) ──────────────
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}

// ── ZIP container (store / no compression — valid and simple) ──────────────────
function zip(entries, date) {
  const d = date || new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // version needed
    local.writeUInt16LE(0x0800, 6);    // flags: UTF-8 filename
    local.writeUInt16LE(0, 8);         // method: store
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);        // extra length
    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);           // version made by
    cd.writeUInt16LE(20, 6);           // version needed
    cd.writeUInt16LE(0x0800, 8);       // flags: UTF-8
    cd.writeUInt16LE(0, 10);           // method
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);           // extra length
    cd.writeUInt16LE(0, 32);           // comment length
    cd.writeUInt16LE(0, 34);           // disk number start
    cd.writeUInt16LE(0, 36);           // internal attrs
    cd.writeUInt32LE(0, 38);           // external attrs
    cd.writeUInt32LE(offset, 42);      // local header offset
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);            // disk number
  eocd.writeUInt16LE(0, 6);            // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); // size of central directory
  eocd.writeUInt32LE(offset, 16);      // offset of central directory
  eocd.writeUInt16LE(0, 20);           // comment length
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

// ── XML helpers ────────────────────────────────────────────────────────────────
// Escape XML text and drop C0 control characters that are illegal in XML 1.0
// (everything below 0x20 except tab, newline and carriage return). Done by code
// point in a single pass so no literal control bytes ever appear in this source.
function escXml(s) {
  let out = '';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c < 0x20 && c !== 0x09 && c !== 0x0A && c !== 0x0D) continue;
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else out += ch;
  }
  return out;
}

function colName(n) { // 0-based column index → A, B, ..., Z, AA, ...
  let s = '';
  n += 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function cellXml(ref, value, styleIdx) {
  const s = styleIdx ? ` s="${styleIdx}"` : '';
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${s}><v>${value}</v></c>`;
  const text = escXml(value == null ? '' : value);
  if (text === '') return `<c r="${ref}"${s}/>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
}

// ── Public API ──────────────────────────────────────────────────────────────────
// buildXlsx(sheetName, header[], rows[][], date?) → Buffer
function buildXlsx(sheetName, header, rows, date) {
  const headerXml = `<row r="1">${header.map((h, i) => cellXml(colName(i) + '1', h, 1)).join('')}</row>`;
  const dataXml = rows.map((r, ri) => {
    const rn = ri + 2;
    return `<row r="${rn}">${r.map((v, i) => cellXml(colName(i) + rn, v, 0)).join('')}</row>`;
  }).join('');
  const lastCol = colName(Math.max(header.length, 1) - 1);
  const dim = `A1:${lastCol}${rows.length + 1}`;

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${dim}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${headerXml}${dataXml}</sheetData></worksheet>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escXml(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

  // Two cell styles: 0 = normal, 1 = bold (header row).
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`;

  return zip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/styles.xml', data: styles },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml },
  ], date);
}

// ══════════════════════════════════════════════════════════════════════════════
// Reader: parse an .xlsx Buffer into a 2D array of string cells (first row =
// header). Handles the two things real-world files do that our writer doesn't:
// DEFLATE-compressed ZIP entries (Excel re-saves) and shared strings. Inline
// strings and bare numbers are handled too. Values come back as strings; the
// caller coerces types.
// ══════════════════════════════════════════════════════════════════════════════

// Unzip via the central directory (authoritative sizes/offsets — survives data
// descriptors). Returns Map<name, Buffer> of decompressed entry contents.
function unzip(buffer) {
  const files = new Map();
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buffer.readUInt16LE(p + 10);
    const compSize = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOff = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);
    if (buffer.readUInt32LE(localOff) !== 0x04034b50) throw new Error('bad local header');
    const lNameLen = buffer.readUInt16LE(localOff + 26);
    const lExtraLen = buffer.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buffer.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = zlib.inflateRawSync(comp);
    else throw new Error('unsupported zip compression method ' + method);
    files.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&'); // must be last
}

function colToIndex(ref) { // 'A' → 0, 'Z' → 25, 'AA' → 26
  let n = 0;
  for (let i = 0; i < ref.length; i++) n = n * 26 + (ref.charCodeAt(i) - 64);
  return n - 1;
}

// Concatenate the text of every <t> inside a fragment (shared-string / inlineStr
// values can be split across multiple runs).
function collectText(fragment) {
  let text = '';
  const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = tRe.exec(fragment))) text += unescapeXml(m[1]);
  return text;
}

function parseXlsx(buffer) {
  const files = unzip(buffer);
  const readText = name => { const b = files.get(name); return b ? b.toString('utf8') : null; };

  // Shared string table (optional).
  const shared = [];
  const ss = readText('xl/sharedStrings.xml');
  if (ss) {
    const siRe = /<si>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = siRe.exec(ss))) shared.push(collectText(m[1]));
  }

  // Resolve the first worksheet through workbook rels, falling back to sheet1.
  let sheet = null;
  const wb = readText('xl/workbook.xml');
  const rels = readText('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const rid = (/<sheet[^>]*r:id="([^"]+)"/.exec(wb) || [])[1];
    if (rid) {
      const target = (new RegExp('<Relationship[^>]*Id="' + rid + '"[^>]*Target="([^"]+)"').exec(rels) || [])[1];
      if (target) {
        let path = target.replace(/^\//, '');
        if (!path.startsWith('xl/')) path = 'xl/' + path;
        sheet = readText(path);
      }
    }
  }
  if (!sheet) sheet = readText('xl/worksheets/sheet1.xml');
  if (!sheet) throw new Error('no worksheet found');

  const rows = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(sheet))) {
    const cells = [];
    const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cRe.exec(rm[1]))) {
      const attrs = cm[1], body = cm[2] || '';
      const ref = (/r="([A-Z]+)\d+"/.exec(attrs) || [])[1];
      const type = (/t="([^"]+)"/.exec(attrs) || [])[1];
      let val = '';
      if (type === 'inlineStr') {
        val = collectText(body);
      } else if (type === 's') {
        const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
        val = v != null ? (shared[parseInt(v, 10)] ?? '') : '';
      } else if (type === 'str') {
        const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
        val = v != null ? unescapeXml(v) : '';
      } else { // number / boolean / date serial
        const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
        val = v != null ? v : '';
      }
      const col = ref ? colToIndex(ref) : cells.length;
      cells[col] = val;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows.push(cells);
  }
  return rows;
}

module.exports = { buildXlsx, parseXlsx };
