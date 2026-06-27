// Generates placeholder OTT24x7 app-icon + splash source images (gold play mark)
// for @capacitor/assets. Replaced later with the real uploaded logo.
const sharp = require('sharp');
const grad = '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fbbf24"/><stop offset="1" stop-color="#f59e0b"/></linearGradient></defs>';
const play = '<path d="M420 338 L720 512 L420 686 Z" fill="#1a1206"/>';
const bg  = `<svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg">${grad}<rect width="1024" height="1024" fill="url(#g)"/></svg>`;
const fg  = `<svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg">${play}</svg>`;
const ic  = `<svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg">${grad}<rect width="1024" height="1024" rx="180" fill="url(#g)"/>${play}</svg>`;
const sp  = `<svg width="2732" height="2732" xmlns="http://www.w3.org/2000/svg">${grad}<rect width="2732" height="2732" fill="#0a0b16"/><rect x="1186" y="1186" width="360" height="360" rx="84" fill="url(#g)"/><path d="M1320 1286 L1476 1366 L1320 1446 Z" fill="#1a1206"/></svg>`;
Promise.all([
  sharp(Buffer.from(bg)).resize(1024, 1024).png().toFile('assets/icon-background.png'),
  sharp(Buffer.from(fg)).resize(1024, 1024).png().toFile('assets/icon-foreground.png'),
  sharp(Buffer.from(ic)).resize(1024, 1024).png().toFile('assets/icon.png'),
  sharp(Buffer.from(sp)).resize(2732, 2732).png().toFile('assets/splash.png'),
  sharp(Buffer.from(sp)).resize(2732, 2732).png().toFile('assets/splash-dark.png'),
]).then(() => console.log('icons+splash generated')).catch(e => { console.error(e); process.exit(1); });
