'use strict';
/**
 * plans-util.js — pure, dependency-free helpers shared by bot imports (bot-supplier.js)
 * and manual / CSV product entry (admin-api.js), so a product's validity and brand logo
 * are derived the same way no matter how it enters the catalog.
 */

// Best-effort plan duration (in days) parsed from a product name: "1 Year" → 365,
// "12 Month" → 360, "6 Months" → 180, "1 Week" → 7, "30 Days" → 30, "1.5 Year" → 548.
// Genuine lifetime/permanent — and anything unrecognised or "0 …" — → null → "Lifetime".
function durationDaysFromName(name) {
  const s = String(name || '').toLowerCase();
  if (/(life ?time|permanent|forever)/.test(s)) return null;
  const pos = n => (Number.isFinite(n) && n > 0 ? n : null); // 0/blank → null, never 0 (which renders as "Lifetime")
  let m;
  if ((m = s.match(/(\d+(?:\.\d+)?)\s*(?:years?|yrs?)\b/)) || (m = s.match(/(\d+(?:\.\d+)?)\s*y\b/)))  return pos(Math.round(parseFloat(m[1]) * 365));
  // single-letter "m" = months, but reject "10m followers"/"2m subscribers" (m = a million-count)
  if ((m = s.match(/(\d+(?:\.\d+)?)\s*(?:months?|mons?|mo)\b/)) || (m = s.match(/(\d+(?:\.\d+)?)\s*m\b(?!\s*(?:follow|subscrib|view|like|fan|member|visit|download|install|stream|player|coin|gem|credit|diamond|point))/))) return pos(Math.round(parseFloat(m[1]) * 30));
  if ((m = s.match(/(\d+(?:\.\d+)?)\s*(?:weeks?|wks?)\b/)) || (m = s.match(/(\d+(?:\.\d+)?)\s*w\b/)))   return pos(Math.round(parseFloat(m[1]) * 7));
  if ((m = s.match(/(\d+(?:\.\d+)?)\s*(?:days?)\b/)) || (m = s.match(/(\d+(?:\.\d+)?)\s*d\b/)))         return pos(Math.round(parseFloat(m[1])));
  return null;
}

// Best-effort brand logo for a product, detected from its name/platform. Returns a
// Google-served favicon (reliable, works for both the product image and the social/OG
// preview) for known services, or '' (the box placeholder) for anything unmatched.
function logoForName(name, platform) {
  // Leading space + match ' '+key so a key only hits at a word START: ' office' matches
  // "Office 365" but NOT "LibreOffice"; still allows glued names like "HBOMax" via ' hbo'.
  const s = ' ' + (String(name || '') + ' ' + String(platform || '')).toLowerCase();
  const map = [
    ['youtube', 'youtube.com'], ['netflix', 'netflix.com'], ['spotify', 'spotify.com'],
    ['prime video', 'primevideo.com'], ['amazon prime', 'primevideo.com'], ['amazon', 'amazon.com'],
    ['hotstar', 'hotstar.com'], ['disney', 'hotstar.com'], ['hbo', 'max.com'], ['apple tv', 'tv.apple.com'],
    ['apple music', 'music.apple.com'], ['apple', 'apple.com'], ['crunchyroll', 'crunchyroll.com'],
    ['canva', 'canva.com'], ['adobe', 'adobe.com'], ['microsoft', 'microsoft.com'], ['office', 'microsoft.com'],
    ['windows', 'microsoft.com'], ['chatgpt', 'openai.com'], ['openai', 'openai.com'], ['gemini', 'gemini.google.com'],
    ['perplexity', 'perplexity.ai'], ['grammarly', 'grammarly.com'], ['linkedin', 'linkedin.com'],
    ['telegram', 'telegram.org'], ['nordvpn', 'nordvpn.com'], ['expressvpn', 'expressvpn.com'],
    ['surfshark', 'surfshark.com'], ['proton', 'proton.me'], ['cyberghost', 'cyberghost.com'],
    ['zee5', 'zee5.com'], ['sonyliv', 'sonyliv.com'], ['jiocinema', 'jiocinema.com'],
    ['jiosaavn', 'jiosaavn.com'], ['gaana', 'gaana.com'], ['wynk', 'wynk.in'], ['udemy', 'udemy.com'],
    ['coursera', 'coursera.org'], ['leetcode', 'leetcode.com'], ['scribd', 'scribd.com'], ['tinder', 'tinder.com'],
    ['twitch', 'twitch.tv'], ['discord', 'discord.com'], ['steam', 'steampowered.com'], ['notegpt', 'notegpt.io'],
    ['quillbot', 'quillbot.com'], ['picsart', 'picsart.com'], ['capcut', 'capcut.com'], ['vidiq', 'vidiq.com'],
  ];
  for (const [k, d] of map) if (s.includes(' ' + k)) return `https://www.google.com/s2/favicons?domain=${d}&sz=128`;
  return '';
}

module.exports = { durationDaysFromName, logoForName };
