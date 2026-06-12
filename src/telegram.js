'use strict';
// Minimal Telegram Bot API client over native https (no extra dependencies).
// Used to push database backups to a private Telegram chat/channel and to send
// a test message when the admin verifies their bot credentials.
const https = require('https');

function tgApi(token, method, params) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(params);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString());
          j.ok ? resolve(j.result) : reject(new Error(j.description || `Telegram API error (${res.statusCode})`));
        } catch (e) { reject(new Error('Bad response from Telegram')); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function sendMessage(token, chatId, text) {
  return tgApi(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
}

// sendDocument with an in-memory Buffer via multipart/form-data, assembled by
// hand (no form-data dependency). Telegram caps bot uploads at 50 MB — far above
// any realistic sql.js store DB.
function sendDocument(token, chatId, buffer, filename, caption) {
  return new Promise((resolve, reject) => {
    const boundary = '----vmkt' + Buffer.from(String(buffer.length) + filename).toString('hex').slice(0, 16);
    const field = (name, val) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${val}\r\n`;
    const pre = [field('chat_id', String(chatId))];
    if (caption) pre.push(field('caption', caption));
    pre.push(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const head = Buffer.from(pre.join(''), 'utf8');
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([head, buffer, tail]);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendDocument`,
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString());
          j.ok ? resolve(j.result) : reject(new Error(j.description || `Telegram API error (${res.statusCode})`));
        } catch (e) { reject(new Error('Bad response from Telegram')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { tgApi, sendMessage, sendDocument };
