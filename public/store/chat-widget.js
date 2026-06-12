/* OTT Store Chat Widget — shared across ALL store pages.
   Include once via <script src="/store/chat-widget.js"></script> near </body>.
   Self-initialises on DOMContentLoaded (or immediately if DOM is ready) and
   fetches /user/api/bot-config to decide what to show.

   Behaviour: a floating button opens a "CHAT WITH US" menu offering — when
   configured — WhatsApp, Telegram, and the in-page AI Assistant. The FAB is
   hidden entirely if none of the three are available.

   States: 'closed' | 'menu' | 'chat'. */
(function(){
'use strict';

if(document.getElementById('cw-style'))return; // already loaded

// ── styles ───────────────────────────────────────────────────────────────────
const STYLE=`
#chat-fab{position:fixed;bottom:24px;right:24px;z-index:10001;width:58px;height:58px;border-radius:50%;
  background:linear-gradient(135deg,#ff2a4d,#ff8b22);border:none;cursor:pointer;
  box-shadow:0 8px 28px rgba(255,42,77,.5);display:none;align-items:center;justify-content:center;
  transition:transform .2s,box-shadow .2s}
#chat-fab:hover{transform:scale(1.08);box-shadow:0 10px 36px rgba(255,42,77,.65)}
#chat-fab .cw-ic-close{display:none}
#chat-fab.open .cw-ic-chat{display:none}
#chat-fab.open .cw-ic-close{display:block}

/* ── launcher menu (CHAT WITH US) ── */
#cw-menu{position:fixed;bottom:96px;right:24px;z-index:10000;width:300px;max-width:calc(100vw - 32px);
  background:#0b0712;border:1px solid rgba(255,255,255,.1);border-radius:20px;padding:14px;
  box-shadow:0 24px 70px rgba(0,0,0,.6);
  transform:scale(.85) translateY(20px);opacity:0;pointer-events:none;
  transition:transform .25s cubic-bezier(.34,1.56,.64,1),opacity .2s}
#cw-menu.open{transform:scale(1) translateY(0);opacity:1;pointer-events:all}
.cw-menu-title{font-size:.7rem;font-weight:800;letter-spacing:.13em;color:rgba(255,255,255,.42);
  text-transform:uppercase;padding:.15rem .35rem .65rem}
.cw-opt{display:flex;align-items:center;gap:.75rem;width:100%;padding:.78rem .9rem;border-radius:14px;
  border:none;cursor:pointer;color:#fff;margin-bottom:.5rem;font-family:inherit;text-align:left;
  text-decoration:none;transition:transform .15s,filter .15s;box-shadow:0 6px 18px rgba(0,0,0,.25)}
.cw-opt:last-child{margin-bottom:0}
.cw-opt:hover{transform:translateY(-2px);filter:brightness(1.08)}
.cw-opt-ic{width:30px;height:30px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:1.3rem}
.cw-opt-ic svg{width:28px;height:28px}
.cw-opt-txt{display:flex;flex-direction:column;line-height:1.25;min-width:0}
.cw-opt-name{font-weight:800;font-size:.95rem}
.cw-opt-sub{font-size:.72rem;font-weight:500;opacity:.85}
.cw-opt-wa{background:#25D366}
.cw-opt-tg{background:#229ED9}
.cw-opt-ai{background:linear-gradient(135deg,#ff2a4d,#ff8b22)}
.cw-opt-ig{background:linear-gradient(135deg,#feda75,#d62976 45%,#962fbf)}
.cw-opt-wac{background:#128C7E}
.cw-opt-tgc{background:#229ED9}
.cw-opt-link{background:linear-gradient(135deg,#5b6470,#3a4150)}

/* ── AI chat panel ── */
#chat-panel{position:fixed;bottom:96px;right:24px;z-index:10000;width:354px;max-width:calc(100vw - 16px);
  height:540px;max-height:calc(100vh - 130px);background:#0b0712;
  border:1px solid rgba(255,42,77,.28);border-radius:22px;display:flex;flex-direction:column;
  box-shadow:0 24px 70px rgba(0,0,0,.6);transform:scale(.85) translateY(20px);opacity:0;pointer-events:none;
  transition:transform .25s cubic-bezier(.34,1.56,.64,1),opacity .2s;overflow:hidden}
#chat-panel.open{transform:scale(1) translateY(0);opacity:1;pointer-events:all}
.cw-head{display:flex;align-items:center;gap:.55rem;padding:.95rem 1.05rem;
  border-bottom:1px solid rgba(255,255,255,.07);
  background:linear-gradient(135deg,rgba(255,42,77,.14),rgba(141,92,255,.14));flex-shrink:0}
.cw-back{background:none;border:none;color:#fff;font-size:1.55rem;line-height:1;cursor:pointer;
  padding:0 .15rem 0 0;flex-shrink:0;opacity:.75;transition:opacity .15s}
.cw-back:hover{opacity:1}
.cw-av{width:40px;height:40px;border-radius:50%;
  background:linear-gradient(135deg,#ff2a4d,#ff8b22);
  display:flex;align-items:center;justify-content:center;font-size:1.15rem;flex-shrink:0;overflow:hidden}
.cw-av img{width:100%;height:100%;object-fit:cover;border-radius:50%}
.cw-info{flex:1;min-width:0}
.cw-name{font-weight:800;font-size:.94rem;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cw-status{font-size:.72rem;color:#34f59b;display:flex;align-items:center;gap:.3rem}
.cw-status::before{content:'';width:6px;height:6px;background:#34f59b;border-radius:50%;display:inline-block;animation:cwPulse 2s infinite}
@keyframes cwPulse{0%,100%{opacity:1}50%{opacity:.35}}
.cw-msgs{flex:1;overflow-y:auto;padding:.9rem .95rem;display:flex;flex-direction:column;gap:.6rem;scroll-behavior:smooth}
.cw-msgs::-webkit-scrollbar{width:4px}
.cw-msgs::-webkit-scrollbar-thumb{background:rgba(255,42,77,.4);border-radius:3px}
.cw-m{display:flex;flex-direction:column;max-width:88%}
.cw-m.bot{align-self:flex-start}
.cw-m.user{align-self:flex-end;align-items:flex-end}
.cw-mb{padding:.55rem .85rem;border-radius:16px;font-size:.88rem;line-height:1.55;word-break:break-word;white-space:pre-wrap}
.cw-m.bot .cw-mb{background:rgba(255,42,77,.16);color:#ffd9df;border-bottom-left-radius:5px}
.cw-m.user .cw-mb{background:linear-gradient(135deg,#ff2a4d,#ff8b22);color:#fff;border-bottom-right-radius:5px}
.cw-m.bot .cw-mb a{color:#ffd9df;text-decoration:underline;word-break:break-all}
.cw-mb strong{font-weight:800}
.cw-m.bot .cw-mb strong{color:#fff}
.cw-mb em{font-style:italic}
.cw-mt{font-size:.64rem;color:rgba(255,255,255,.3);padding:.1rem .3rem}
.cw-btns{display:flex;flex-wrap:wrap;gap:.42rem;padding:.1rem .95rem .65rem;flex-shrink:0}
.cw-btn{background:rgba(255,42,77,.1);border:1px solid rgba(255,42,77,.32);color:#ff9aaa;
  padding:.4rem .8rem;border-radius:18px;font-size:.81rem;cursor:pointer;transition:all .15s;white-space:nowrap}
.cw-btn:hover{background:rgba(255,42,77,.26);border-color:#ff2a4d;color:#fff}
.cw-typing-wrap{display:flex;gap:.35rem;align-items:center;padding:.5rem .8rem;background:rgba(255,42,77,.14);
  border-radius:13px;border-bottom-left-radius:4px;width:fit-content}
.cw-typing-wrap span{width:7px;height:7px;background:#ff2a4d;border-radius:50%;animation:cwDot .9s infinite}
.cw-typing-wrap span:nth-child(2){animation-delay:.18s}
.cw-typing-wrap span:nth-child(3){animation-delay:.36s}
@keyframes cwDot{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-5px)}}
.cw-input-row{display:flex;align-items:center;gap:.5rem;padding:.7rem .85rem;
  border-top:1px solid rgba(255,255,255,.06);flex-shrink:0}
.cw-input{flex:1;background:rgba(255,255,255,.06);border:1px solid rgba(255,42,77,.22);border-radius:22px;
  padding:.52rem .95rem;color:#fff;font-size:.88rem;outline:none;transition:border-color .2s;font-family:inherit}
.cw-input:focus{border-color:#ff2a4d}
.cw-input::placeholder{color:rgba(255,255,255,.32)}
.cw-send{width:38px;height:38px;background:linear-gradient(135deg,#ff2a4d,#ff8b22);border:none;
  border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.cw-send:hover{opacity:.86}
.cw-send svg{width:16px;height:16px;fill:#fff}
@media(max-width:760px){
  #chat-fab{bottom:78px;right:14px;width:50px;height:50px}
  #cw-menu{bottom:138px;right:10px;left:10px;width:auto}
  #chat-panel{bottom:140px;right:8px;left:8px;width:auto;height:calc(100vh - 200px)}
}`;
const st=document.createElement('style');
st.id='cw-style';st.textContent=STYLE;document.head.appendChild(st);

// ── icons ────────────────────────────────────────────────────────────────────
const ICON_WA='<svg viewBox="0 0 32 32" fill="#fff"><path d="M16 .5C7.4.5.5 7.4.5 16c0 2.8.7 5.4 2 7.8L.5 31.5l7.9-2c2.3 1.2 4.9 1.9 7.6 1.9 8.6 0 15.5-6.9 15.5-15.5S24.6.5 16 .5zm0 28.3c-2.4 0-4.7-.6-6.7-1.8l-.5-.3-4.7 1.2 1.2-4.6-.3-.5c-1.3-2.1-2-4.5-2-7C3.3 9 9 3.3 16 3.3 23 3.3 28.7 9 28.7 16S23 28.8 16 28.8zm7.6-9.8c-.4-.2-2.5-1.2-2.9-1.4-.4-.1-.7-.2-.9.2-.3.4-1 1.4-1.3 1.6-.2.3-.5.3-.9.1-.4-.2-1.8-.7-3.4-2.1-1.2-1.1-2.1-2.5-2.3-2.9-.2-.4 0-.6.2-.8.2-.2.4-.5.6-.7.2-.2.3-.4.4-.7.1-.3 0-.5 0-.7-.1-.2-.9-2.2-1.3-3-.3-.7-.7-.6-.9-.6h-.8c-.3 0-.7.1-1.1.5-.4.4-1.4 1.4-1.4 3.4s1.5 4 1.7 4.2c.2.3 2.9 4.5 7.1 6.3 1 .4 1.8.7 2.4.9 1 .3 1.9.3 2.6.2.8-.1 2.5-1 2.8-2 .3-1 .3-1.8.2-2-.1-.2-.4-.3-.8-.5z"/></svg>';
const ICON_TG='<svg viewBox="0 0 32 32" fill="#fff"><path d="M16 0C7.2 0 0 7.2 0 16s7.2 16 16 16 16-7.2 16-16S24.8 0 16 0zm7.4 11l-2.5 11.7c-.2.8-.7 1-1.4.6l-3.9-2.9-1.9 1.8c-.2.2-.4.4-.8.4l.3-4.1 7.4-6.7c.3-.3-.1-.4-.5-.2l-9.1 5.7-3.9-1.2c-.8-.3-.9-.8.2-1.2l15.2-5.9c.7-.2 1.3.2 1.1 1.1z"/></svg>';
const ICON_IG='<svg viewBox="0 0 32 32" fill="#fff"><path d="M16 2.9c4.3 0 4.8 0 6.5.1 1.6.1 2.4.3 3 .5.8.3 1.3.6 1.9 1.2.6.6.9 1.1 1.2 1.9.2.6.4 1.4.5 3 .1 1.7.1 2.2.1 6.5s0 4.8-.1 6.5c-.1 1.6-.3 2.4-.5 3-.3.8-.6 1.3-1.2 1.9-.6.6-1.1.9-1.9 1.2-.6.2-1.4.4-3 .5-1.7.1-2.2.1-6.5.1s-4.8 0-6.5-.1c-1.6-.1-2.4-.3-3-.5-.8-.3-1.3-.6-1.9-1.2-.6-.6-.9-1.1-1.2-1.9-.2-.6-.4-1.4-.5-3-.1-1.7-.1-2.2-.1-6.5s0-4.8.1-6.5c.1-1.6.3-2.4.5-3 .3-.8.6-1.3 1.2-1.9.6-.6 1.1-.9 1.9-1.2.6-.2 1.4-.4 3-.5 1.7-.1 2.2-.1 6.5-.1M16 0c-4.4 0-4.9 0-6.6.1-1.7.1-2.9.3-3.9.7-1 .4-1.9.9-2.7 1.8C2 3.4 1.4 4.2 1 5.2.6 6.2.3 7.4.2 9.1.1 10.8 0 11.4 0 16s0 5.2.1 6.9c.1 1.7.3 2.9.7 3.9.4 1 .9 1.9 1.8 2.7.8.8 1.7 1.4 2.7 1.8 1 .4 2.2.6 3.9.7 1.7.1 2.3.1 6.9.1s5.2 0 6.9-.1c1.7-.1 2.9-.3 3.9-.7 1-.4 1.9-.9 2.7-1.8.8-.8 1.4-1.7 1.8-2.7.4-1 .6-2.2.7-3.9.1-1.7.1-2.3.1-6.9s0-5.2-.1-6.9c-.1-1.7-.3-2.9-.7-3.9-.4-1-.9-1.9-1.8-2.7-.8-.8-1.7-1.4-2.7-1.8-1-.4-2.2-.6-3.9-.7C20.9 0 20.4 0 16 0z"/><path d="M16 7.8a8.2 8.2 0 100 16.4 8.2 8.2 0 000-16.4zm0 13.5a5.3 5.3 0 110-10.6 5.3 5.3 0 010 10.6z"/><circle cx="24.7" cy="7.3" r="1.9"/></svg>';

// ── menu element ─────────────────────────────────────────────────────────────
const menu=document.createElement('div');
menu.id='cw-menu';menu.setAttribute('role','dialog');menu.setAttribute('aria-label','Chat with us');
menu.innerHTML='<div class="cw-menu-title">Chat with us</div><div id="cw-opts"></div>';

// ── FAB ──────────────────────────────────────────────────────────────────────
const fab=document.createElement('button');
fab.id='chat-fab';fab.setAttribute('aria-label','Chat with us');fab.style.display='none';
fab.innerHTML='<svg class="cw-ic-chat" viewBox="0 0 24 24" style="width:23px;height:23px;fill:#fff"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg><svg class="cw-ic-close" viewBox="0 0 24 24" style="width:23px;height:23px;fill:#fff;display:none"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';

// ── AI chat panel ────────────────────────────────────────────────────────────
const panel=document.createElement('div');
panel.id='chat-panel';panel.setAttribute('role','dialog');panel.setAttribute('aria-label','AI chat');
panel.innerHTML='<div class="cw-head"><button class="cw-back" id="cw-back" aria-label="Back">‹</button><div class="cw-av" id="cw-avatar">🤖</div><div class="cw-info"><div class="cw-name" id="cw-name">AI Assistant</div><div class="cw-status" id="cw-status">Online · Replies instantly</div></div></div><div class="cw-msgs" id="cw-msgs"></div><div class="cw-btns" id="cw-btns"></div><div class="cw-input-row"><input id="cw-input" class="cw-input" type="text" placeholder="Type a message…" autocomplete="off"><button id="cw-send" class="cw-send" aria-label="Send"><svg viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2v7z"/></svg></button></div>';

document.body.appendChild(menu);
document.body.appendChild(fab);
document.body.appendChild(panel);

// ── AI chat logic ────────────────────────────────────────────────────────────
const msgList=document.getElementById('cw-msgs');
const btnsWrap=document.getElementById('cw-btns');
const input=document.getElementById('cw-input');
const sendBtn=document.getElementById('cw-send');
const optsWrap=document.getElementById('cw-opts');
let history=[],isThinking=false,aiInit=false,aiGreeting='';
let state='closed';   // 'closed' | 'menu' | 'chat'

const QUICK=[
  {label:'🛒 Buy a Plan',msg:'I want to buy a subscription'},
  {label:'💰 See Plans & Prices',msg:'Show me all available plans with prices'},
  {label:'📦 Track My Order',msg:'I want to track my order'},
  {label:'🎧 Get Support',msg:'I need customer support'},
];

function now(){return new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'});}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

function formatBot(text){
  let html=esc(text);
  html=html.replace(/\*\*([^\n*]+?)\*\*/g,'<strong>$1</strong>')
           .replace(/__([^\n_]+?)__/g,'<strong>$1</strong>');
  html=html.replace(/(^|[\s(])\*(?!\s)([^\n*]+?)\*(?=[\s).,!?:;]|$)/g,'$1<em>$2</em>')
           .replace(/(^|[\s(])_(?!\s)([^\n_]+?)_(?=[\s).,!?:;]|$)/g,'$1<em>$2</em>');
  html=html.replace(/https?:\/\/[^\s<>"']+/g,url=>`<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
  return html;
}
function addMsg(role,text){
  const div=document.createElement('div');div.className='cw-m '+role;
  const body=role==='bot'?formatBot(text):esc(text);
  div.innerHTML=`<div class="cw-mb">${body}</div><div class="cw-mt">${now()}</div>`;
  msgList.appendChild(div);msgList.scrollTop=msgList.scrollHeight;
}
function showTyping(){
  const d=document.createElement('div');d.className='cw-m bot';d.id='cw-typing';
  d.innerHTML='<div class="cw-typing-wrap"><span></span><span></span><span></span></div>';
  msgList.appendChild(d);msgList.scrollTop=msgList.scrollHeight;
}
function removeTyping(){const e=document.getElementById('cw-typing');if(e)e.remove();}
function setButtons(btns){
  btnsWrap.innerHTML='';
  if(!btns||!btns.length)return;
  const l2m={};QUICK.forEach(q=>l2m[q.label]=q.msg);
  btns.forEach(label=>{
    const b=document.createElement('button');b.className='cw-btn';b.textContent=label;
    b.onclick=()=>send(l2m[label]||label);btnsWrap.appendChild(b);
  });
}
async function send(text){
  text=text||input.value.trim();
  if(!text||isThinking)return;
  input.value='';setButtons([]);addMsg('user',text);
  history.push({role:'user',content:text});
  isThinking=true;showTyping();
  try{
    const res=await fetch('/user/api/ai-chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:history.slice(-14)})});
    const data=await res.json();removeTyping();
    if(!res.ok)throw new Error(data.error||'Failed');
    const reply=data.text||'Sorry, I could not understand that.';
    addMsg('bot',reply);history.push({role:'assistant',content:reply});
    if(data.buttons&&data.buttons.length)setButtons(data.buttons);
  }catch(e){removeTyping();addMsg('bot','⚠️ '+(e.message||'Something went wrong.'));}
  isThinking=false;
}
function initAi(){
  if(aiInit)return;aiInit=true;
  addMsg('bot',aiGreeting);history.push({role:'assistant',content:aiGreeting});
  setButtons(QUICK.map(q=>q.label));
}

// ── state machine ────────────────────────────────────────────────────────────
function setState(s){
  state=s;
  menu.classList.toggle('open',s==='menu');
  panel.classList.toggle('open',s==='chat');
  fab.classList.toggle('open',s!=='closed');
  if(s==='chat'){initAi();setTimeout(()=>{try{input.focus();}catch(e){}},60);}
}
fab.addEventListener('click',()=>setState(state==='closed'?'menu':'closed'));
document.getElementById('cw-back').addEventListener('click',()=>setState('menu'));
sendBtn.addEventListener('click',()=>send());
input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});
// Esc closes; click outside the menu closes the menu
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&state!=='closed')setState('closed');});
document.addEventListener('click',e=>{
  if(state==='menu'&&!menu.contains(e.target)&&!fab.contains(e.target)&&!panel.contains(e.target))setState('closed');
});

// ── build a menu option ──────────────────────────────────────────────────────
function addOpt(cls,iconHtml,name,sub,onClick){
  const b=document.createElement(onClick?'button':'a');
  b.className='cw-opt '+cls;
  b.innerHTML=`<span class="cw-opt-ic">${iconHtml}</span><span class="cw-opt-txt"><span class="cw-opt-name">${esc(name)}</span><span class="cw-opt-sub">${esc(sub)}</span></span>`;
  if(onClick)b.addEventListener('click',onClick);
  optsWrap.appendChild(b);
  return b;
}

// ── normalise contact links ──────────────────────────────────────────────────
function waLink(raw){
  const digits=String(raw||'').replace(/\D/g,'');
  if(digits.length<7)return '';
  return 'https://wa.me/'+digits;
}
function tgLink(raw){
  let v=String(raw||'').trim();
  if(!v)return '';
  if(/^https?:\/\//i.test(v))return v;
  v=v.replace(/^@/,'').replace(/^t\.me\//i,'');
  return v?'https://t.me/'+v:'';
}
// A plain URL — only accept absolute http(s) links (community invites, custom links).
function urlLink(raw){
  const v=String(raw||'').trim();
  return /^https?:\/\//i.test(v)?v:'';
}
// Instagram — accept a full URL or a bare @handle.
function igLink(raw){
  let v=String(raw||'').trim();
  if(!v)return '';
  if(/^https?:\/\//i.test(v))return v;
  v=v.replace(/^@/,'').replace(/^instagram\.com\//i,'');
  return v?'https://instagram.com/'+v:'';
}

// ── boot ─────────────────────────────────────────────────────────────────────
fetch('/user/api/bot-config').then(r=>r.json()).then(cfg=>{
  const siteName=cfg.site_name||'OTT Store';
  const aiEnabled=cfg.bot_enabled==='1';
  const wa=waLink(cfg.support_whatsapp);
  const tg=tgLink(cfg.support_telegram);
  let count=0;

  // AI assistant (first, featured) — only if enabled
  if(aiEnabled){
    if(cfg.bot_accent)fab.style.background=`linear-gradient(135deg,${cfg.bot_accent},#ff8a00)`;
    const av=document.getElementById('cw-avatar');
    if(cfg.bot_avatar&&cfg.bot_avatar.length>10)av.innerHTML=`<img src="data:image/png;base64,${cfg.bot_avatar}" alt="bot">`;
    const botName=cfg.bot_name||'AI Assistant';
    document.getElementById('cw-name').textContent=botName;
    if(cfg.bot_tagline)document.getElementById('cw-status').textContent=cfg.bot_tagline;
    aiGreeting=(cfg.bot_greeting||'👋 Hi! What can I help you with?').replace('{site_name}',siteName).replace(/\*/g,'');
    addOpt('cw-opt-ai','🤖',botName,'Instant answers · 24/7',()=>setState('chat'));
    count++;
  }
  // WhatsApp
  if(wa){
    const pre=encodeURIComponent(`Hi 👋 I have a question about ${siteName}.`);
    addOpt('cw-opt-wa',ICON_WA,'WhatsApp','Chat with us on WhatsApp',()=>{
      window.open(wa+'?text='+pre,'_blank','noopener');setState('closed');
    });
    count++;
  }
  // Telegram (direct message)
  if(tg){
    addOpt('cw-opt-tg',ICON_TG,'Telegram','Message us on Telegram',()=>{
      window.open(tg,'_blank','noopener');setState('closed');
    });
    count++;
  }
  // Instagram
  const ig=igLink(cfg.support_instagram);
  if(ig){
    addOpt('cw-opt-ig',ICON_IG,'Instagram','Follow us on Instagram',()=>{
      window.open(ig,'_blank','noopener');setState('closed');
    });
    count++;
  }
  // WhatsApp Community
  const wac=urlLink(cfg.support_wa_community);
  if(wac){
    addOpt('cw-opt-wac','👥','WhatsApp Community','Join our community',()=>{
      window.open(wac,'_blank','noopener');setState('closed');
    });
    count++;
  }
  // Telegram Channel
  const tgc=tgLink(cfg.support_telegram_channel);
  if(tgc){
    addOpt('cw-opt-tgc','📣','Telegram Channel','Latest deals &amp; updates',()=>{
      window.open(tgc,'_blank','noopener');setState('closed');
    });
    count++;
  }
  // Custom links (admin-defined: [{label,url,sub,icon}])
  let customs=[];try{customs=JSON.parse(cfg.support_custom_links||'[]');}catch(e){}
  if(Array.isArray(customs)){
    customs.forEach(l=>{
      const u=urlLink(l&&l.url);
      if(u&&l&&l.label){
        addOpt('cw-opt-link',(l.icon||'🔗'),l.label,l.sub||'',()=>{
          window.open(u,'_blank','noopener');setState('closed');
        });
        count++;
      }
    });
  }

  // Nothing configured → no widget at all. Otherwise the FAB always opens the
  // "Chat with us" pop-up listing every configured channel.
  if(count===0)return;
  fab.style.display='flex';
}).catch(()=>{});
})();
