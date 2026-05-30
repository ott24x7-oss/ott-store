/* OTT Store AI Chat Widget — shared across all store pages.
   Include once via <script src="/store/chat-widget.js"></script>
   near the closing </body>. It self-initialises on DOMContentLoaded
   (or immediately if the DOM is already ready) and fetches
   /user/api/bot-config to decide whether to show the FAB. */
(function(){
'use strict';

// --- inject CSS only once ------------------------------------------------
if(document.getElementById('cw-style'))return; // already loaded
const STYLE=`
#chat-fab{position:fixed;bottom:24px;right:24px;z-index:10001;width:58px;height:58px;border-radius:50%;
  background:linear-gradient(135deg,#ff2a4d,#ff8b22);border:none;cursor:pointer;
  box-shadow:0 8px 28px rgba(255,42,77,.5);display:none;align-items:center;justify-content:center;
  transition:transform .2s,box-shadow .2s}
#chat-fab:hover{transform:scale(1.08);box-shadow:0 10px 36px rgba(255,42,77,.65)}
#chat-fab .cw-ic-close{display:none}
#chat-fab.open .cw-ic-chat{display:none}
#chat-fab.open .cw-ic-close{display:block}
#chat-panel{position:fixed;bottom:96px;right:24px;z-index:10000;width:354px;max-width:calc(100vw - 16px);
  height:540px;max-height:calc(100vh - 130px);background:#0b0712;
  border:1px solid rgba(255,42,77,.28);border-radius:22px;display:flex;flex-direction:column;
  box-shadow:0 24px 70px rgba(0,0,0,.6);transform:scale(.85) translateY(20px);opacity:0;pointer-events:none;
  transition:transform .25s cubic-bezier(.34,1.56,.64,1),opacity .2s;overflow:hidden}
#chat-panel.open{transform:scale(1) translateY(0);opacity:1;pointer-events:all}
.cw-head{display:flex;align-items:center;gap:.65rem;padding:.95rem 1.05rem;
  border-bottom:1px solid rgba(255,255,255,.07);
  background:linear-gradient(135deg,rgba(255,42,77,.14),rgba(141,92,255,.14));flex-shrink:0}
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
/* linkify URLs inside bot messages */
.cw-m.bot .cw-mb a{color:#ffd9df;text-decoration:underline;word-break:break-all}
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
  #chat-panel{bottom:140px;right:8px;left:8px;width:auto;height:calc(100vh - 200px)}
}`;
const st=document.createElement('style');
st.id='cw-style';
st.textContent=STYLE;
document.head.appendChild(st);

// --- inject HTML ---------------------------------------------------------
const fab=document.createElement('button');
fab.id='chat-fab';
fab.setAttribute('aria-label','Chat with us');
fab.style.display='none';
fab.innerHTML=`<svg class="cw-ic-chat" viewBox="0 0 24 24" style="width:23px;height:23px;fill:#fff"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg><svg class="cw-ic-close" viewBox="0 0 24 24" style="width:23px;height:23px;fill:#fff;display:none"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;

const panel=document.createElement('div');
panel.id='chat-panel';
panel.setAttribute('role','dialog');
panel.setAttribute('aria-label','Chat');
panel.innerHTML=`<div class="cw-head"><div class="cw-av" id="cw-avatar">🤖</div><div class="cw-info"><div class="cw-name" id="cw-name">AI Assistant</div><div class="cw-status" id="cw-status">Online · Replies instantly</div></div></div><div class="cw-msgs" id="cw-msgs"></div><div class="cw-btns" id="cw-btns"></div><div class="cw-input-row"><input id="cw-input" class="cw-input" type="text" placeholder="Type a message…" autocomplete="off"><button id="cw-send" class="cw-send" aria-label="Send"><svg viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2v7z"/></svg></button></div>`;

document.body.appendChild(fab);
document.body.appendChild(panel);

// --- logic ---------------------------------------------------------------
const msgList=document.getElementById('cw-msgs');
const btnsWrap=document.getElementById('cw-btns');
const input=document.getElementById('cw-input');
const sendBtn=document.getElementById('cw-send');
let history=[],isOpen=false,isThinking=false;

const QUICK=[
  {label:'🛒 Buy a Plan',msg:'I want to buy a subscription'},
  {label:'💰 See Plans & Prices',msg:'Show me all available plans with prices'},
  {label:'📦 Track My Order',msg:'I want to track my order'},
  {label:'🎧 Get Support',msg:'I need customer support'},
];

function now(){return new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'});}

function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

// Convert plain URLs in bot text into clickable links
function linkify(text){
  return esc(text).replace(/https?:\/\/[^\s<>"']+/g,url=>`<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
}

function addMsg(role,text){
  const div=document.createElement('div');
  div.className='cw-m '+role;
  const body=role==='bot'?linkify(text):esc(text);
  div.innerHTML=`<div class="cw-mb">${body}</div><div class="cw-mt">${now()}</div>`;
  msgList.appendChild(div);
  msgList.scrollTop=msgList.scrollHeight;
}

function showTyping(){
  const d=document.createElement('div');
  d.className='cw-m bot';d.id='cw-typing';
  d.innerHTML='<div class="cw-typing-wrap"><span></span><span></span><span></span></div>';
  msgList.appendChild(d);msgList.scrollTop=msgList.scrollHeight;
}
function removeTyping(){const e=document.getElementById('cw-typing');if(e)e.remove();}

function setButtons(btns){
  btnsWrap.innerHTML='';
  if(!btns||!btns.length)return;
  const l2m={};QUICK.forEach(q=>l2m[q.label]=q.msg);
  btns.forEach(label=>{
    const b=document.createElement('button');
    b.className='cw-btn';b.textContent=label;
    b.onclick=()=>send(l2m[label]||label);
    btnsWrap.appendChild(b);
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
    addMsg('bot',reply);
    history.push({role:'assistant',content:reply});
    if(data.buttons&&data.buttons.length)setButtons(data.buttons);
  }catch(e){removeTyping();addMsg('bot','⚠️ '+(e.message||'Something went wrong.'));}
  isThinking=false;
}

fab.addEventListener('click',()=>{
  isOpen=!isOpen;
  fab.classList.toggle('open',isOpen);
  panel.classList.toggle('open',isOpen);
  if(isOpen)input.focus();
});
sendBtn.addEventListener('click',()=>send());
input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});

fetch('/user/api/bot-config').then(r=>r.json()).then(cfg=>{
  if(cfg.bot_enabled!=='1')return;
  if(cfg.bot_accent)fab.style.background=`linear-gradient(135deg,${cfg.bot_accent},#ff8a00)`;
  const av=document.getElementById('cw-avatar');
  if(cfg.bot_avatar&&cfg.bot_avatar.length>10)av.innerHTML=`<img src="data:image/png;base64,${cfg.bot_avatar}" alt="bot">`;
  document.getElementById('cw-name').textContent=cfg.bot_name||'AI Assistant';
  if(cfg.bot_tagline)document.getElementById('cw-status').textContent=cfg.bot_tagline;
  const siteName=cfg.site_name||'OTT Store';
  const greeting=(cfg.bot_greeting||'👋 Hi! What can I help you with?').replace('{site_name}',siteName).replace(/\*/g,'');
  addMsg('bot',greeting);
  history.push({role:'assistant',content:greeting});
  setButtons(QUICK.map(q=>q.label));
  fab.style.display='flex';
}).catch(()=>{});
})();
