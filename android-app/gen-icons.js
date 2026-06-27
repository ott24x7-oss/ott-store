// OTT24x7 app-icon + splash sources for @capacitor/assets.
// Dark squircle + a large gold play button (fills the adaptive safe zone so it
// no longer looks like a tiny floating mark). Placeholder until the real logo.
const sharp = require('sharp');
const G = '<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffd25e"/><stop offset="1" stop-color="#f59e0b"/></linearGradient>';
const D = '<linearGradient id="d" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d1608"/><stop offset="1" stop-color="#070503"/></linearGradient>';
const PLAY = '<circle cx="512" cy="512" r="268" fill="url(#g)"/><path d="M455 398 L648 512 L455 626 Z" fill="#1a1206"/>';
const bg = `<svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg"><defs>${D}</defs><rect width="1024" height="1024" fill="url(#d)"/></svg>`;
const fg = `<svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg"><defs>${G}</defs>${PLAY}</svg>`;
const ic = `<svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg"><defs>${G}${D}</defs><rect width="1024" height="1024" rx="190" fill="url(#d)"/>${PLAY}</svg>`;
const sp = `<svg width="2732" height="2732" xmlns="http://www.w3.org/2000/svg"><defs>${G}</defs><rect width="2732" height="2732" fill="#0a0b16"/><circle cx="1366" cy="1300" r="200" fill="url(#g)"/><path d="M1323 1214 L1470 1300 L1323 1386 Z" fill="#1a1206"/></svg>`;
Promise.all([
  sharp(Buffer.from(bg)).resize(1024, 1024).png().toFile('assets/icon-background.png'),
  sharp(Buffer.from(fg)).resize(1024, 1024).png().toFile('assets/icon-foreground.png'),
  sharp(Buffer.from(ic)).resize(1024, 1024).png().toFile('assets/icon.png'),
  sharp(Buffer.from(sp)).resize(2732, 2732).png().toFile('assets/splash.png'),
  sharp(Buffer.from(sp)).resize(2732, 2732).png().toFile('assets/splash-dark.png'),
]).then(() => console.log('icons+splash regenerated')).catch(e => { console.error(e); process.exit(1); });
