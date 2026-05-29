'use strict';
const https = require('https');
const crypto = require('crypto');
const { getDb, getSetting, all, run } = require('./db');

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function makeJwt(serviceAccountJson) {
  const sa = typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson;
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64url(Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/indexing',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })));
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = base64url(sign.sign(sa.private_key));
  return `${header}.${payload}.${sig}`;
}

async function getAccessToken(saJson) {
  const jwt = makeJwt(saJson);
  return new Promise((resolve, reject) => {
    const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { const j = JSON.parse(data); resolve(j.access_token); }
        catch (e) { reject(new Error('Token parse error: ' + data)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function submitUrl(accessToken, url, type = 'URL_UPDATED') {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ url, type });
    const req = https.request({
      hostname: 'indexing.googleapis.com',
      path: '/v3/urlNotifications:publish',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function pingSitemap(sitemapUrl) {
  return new Promise((resolve, reject) => {
    const pingUrl = `https://www.google.com/ping?sitemap=${encodeURIComponent(sitemapUrl)}`;
    const u = new URL(pingUrl);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET' }, res => {
      resolve({ status: res.statusCode });
    });
    req.on('error', reject);
    req.end();
  });
}

async function submitUrls(urls) {
  const credsJson = await getSetting('google_index_credentials');
  if (!credsJson) throw new Error('Google service account not configured');
  const token = await getAccessToken(credsJson);
  const results = [];
  for (const url of urls) {
    try {
      const r = await submitUrl(token, url);
      results.push({ url, status: r.status, ok: r.status === 200 });
      // log to audit
      const db = await getDb();
      run(db, `INSERT INTO audit_log (actor_kind,actor_label,action,target_kind,target_id,after_json,created_at)
               VALUES ('admin','google-index','submit','url',?,?,datetime('now'))`,
        [url, JSON.stringify({ status: r.status, body: r.body })]);
    } catch (e) {
      results.push({ url, status: 0, ok: false, error: e.message });
    }
  }
  return results;
}

module.exports = { submitUrls, pingSitemap, getAccessToken };
