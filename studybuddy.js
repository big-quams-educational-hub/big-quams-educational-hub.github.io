/**
 * Big Quams Media® — AI Study Buddy
 * Powered by Claude (Anthropic)
 * A floating chat widget for Nigerian students — JAMB, Post-UTME, university questions
 * Usage: <script src="studybuddy.js"></script> on any page
 */
(function(){
  'use strict';

  // ── CONFIG ──
  const BQM_BRAND = 'Big Quams Media®';
  const MAX_FREE  = 3; // questions per day for anonymous users
  const STORAGE_KEY = 'bqm_buddy_usage';
  const HISTORY_KEY = 'bqm_buddy_history';

  // ── STATE ──
  let isOpen = false;
  let isTyping = false;
  let messageHistory = []; // for multi-turn context
  let currentUser = null; // set by auth listener if available

  // ── CSS ──
  const style = document.createElement('style');
  style.textContent = `
    #bqm-buddy-fab {
      position:fixed;bottom:24px;left:18px;z-index:8000;
      width:56px;height:56px;border-radius:50%;
      background:linear-gradient(135deg,#1a3fa8,#f97316);
      border:none;cursor:pointer;box-shadow:0 4px 20px rgba(26,63,168,.45);
      display:flex;align-items:center;justify-content:center;
      font-size:1.4rem;transition:.28s cubic-bezier(.34,1.56,.64,1);
      animation:bqmPulse 3s ease-in-out infinite;
    }
    #bqm-buddy-fab:hover{transform:scale(1.1);}
    #bqm-buddy-fab.open{transform:scale(1) rotate(0deg);animation:none;}
    @keyframes bqmPulse{0%,100%{box-shadow:0 4px 20px rgba(26,63,168,.45)}50%{box-shadow:0 4px 28px rgba(26,63,168,.75),0 0 0 8px rgba(26,63,168,.08)}}
    #bqm-buddy-badge{
      position:absolute;top:-2px;right:-2px;
      background:#f97316;color:#fff;border-radius:50%;
      width:18px;height:18px;font-size:.65rem;font-weight:800;
      display:flex;align-items:center;justify-content:center;
      border:2px solid #fff;opacity:0;transition:.2s;
    }
    #bqm-buddy-badge.show{opacity:1;}
    #bqm-buddy-panel{
      position:fixed;bottom:90px;left:14px;z-index:8001;
      width:min(380px,calc(100vw - 32px));
      height:min(560px,calc(100vh - 110px));
      background:#fff;border-radius:20px;
      box-shadow:0 20px 60px rgba(8,21,48,.22),0 0 0 1.5px rgba(26,63,168,.12);
      display:flex;flex-direction:column;overflow:hidden;
      transform:scale(.92) translateY(16px);opacity:0;pointer-events:none;
      transition:transform .28s cubic-bezier(.34,1.56,.64,1),opacity .2s ease;
    }
    @media(max-width:480px){#bqm-buddy-panel{left:8px;right:8px;width:auto;}}
    #bqm-buddy-panel.open{transform:scale(1) translateY(0);opacity:1;pointer-events:all;}
    body.dark #bqm-buddy-panel{background:#161b27;box-shadow:0 20px 60px rgba(0,0,0,.5),0 0 0 1.5px rgba(255,255,255,.08);}
    .buddy-header{
      background:linear-gradient(135deg,#0c1f6e,#1a3fa8);
      padding:14px 16px;display:flex;align-items:center;gap:10px;flex-shrink:0;
    }
    .buddy-avatar{
      width:36px;height:36px;border-radius:50%;
      background:rgba(255,255,255,.15);border:2px solid rgba(255,255,255,.3);
      display:flex;align-items:center;justify-content:center;font-size:1.1rem;flex-shrink:0;
    }
    .buddy-title{font-family:'Montserrat',sans-serif;font-size:.82rem;font-weight:800;color:#fff;}
    .buddy-sub{font-size:.62rem;color:rgba(255,255,255,.55);margin-top:1px;}
    .buddy-status{display:flex;align-items:center;gap:5px;font-size:.62rem;color:rgba(255,255,255,.55);margin-left:auto;}
    .buddy-dot{width:7px;height:7px;border-radius:50%;background:#22c55e;animation:bqmBlink 2s infinite;}
    @keyframes bqmBlink{0%,100%{opacity:1}50%{opacity:.4}}
    .buddy-close{background:rgba(255,255,255,.1);border:none;color:#fff;width:28px;height:28px;
      border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:.9rem;flex-shrink:0;}
    .buddy-messages{flex:1;overflow-y:auto;padding:14px 12px;display:flex;flex-direction:column;gap:10px;scroll-behavior:smooth;}
    .buddy-messages::-webkit-scrollbar{width:4px;}
    .buddy-messages::-webkit-scrollbar-track{background:transparent;}
    .buddy-messages::-webkit-scrollbar-thumb{background:rgba(26,63,168,.2);border-radius:2px;}
    .buddy-msg{max-width:88%;display:flex;flex-direction:column;gap:3px;animation:bqmFadeIn .2s ease;}
    @keyframes bqmFadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
    .buddy-msg.user{align-self:flex-end;}
    .buddy-msg.ai{align-self:flex-start;}
    .buddy-bubble{padding:10px 13px;border-radius:14px;font-size:.82rem;line-height:1.6;word-break:break-word;}
    .buddy-msg.user .buddy-bubble{background:linear-gradient(135deg,#1a3fa8,#2563eb);color:#fff;border-radius:14px 14px 4px 14px;}
    .buddy-msg.ai .buddy-bubble{background:#f0f4ff;color:#1e2749;border-radius:14px 14px 14px 4px;}
    body.dark .buddy-msg.ai .buddy-bubble{background:#1a2236;color:#e6edf3;}
    .buddy-msg-time{font-size:.58rem;color:#94a3b8;padding:0 4px;}
    .buddy-msg.user .buddy-msg-time{text-align:right;}
    .buddy-typing{align-self:flex-start;display:none;}
    .buddy-typing.show{display:flex;}
    .buddy-typing .buddy-bubble{background:#f0f4ff;padding:12px 16px;}
    body.dark .buddy-typing .buddy-bubble{background:#1a2236;}
    .buddy-dots{display:flex;gap:4px;align-items:center;}
    .buddy-dots span{width:6px;height:6px;border-radius:50%;background:#94a3b8;animation:bqmDot 1.2s infinite;}
    .buddy-dots span:nth-child(2){animation-delay:.2s;}
    .buddy-dots span:nth-child(3){animation-delay:.4s;}
    @keyframes bqmDot{0%,80%,100%{transform:scale(.8);opacity:.5}40%{transform:scale(1.2);opacity:1}}
    .buddy-suggestions{padding:0 12px 8px;display:flex;flex-wrap:wrap;gap:6px;flex-shrink:0;}
    .buddy-chip{padding:5px 11px;border:1.5px solid #c7d9ff;border-radius:20px;font-size:.71rem;
      font-weight:700;color:#1a3fa8;background:#f0f4ff;cursor:pointer;white-space:nowrap;transition:.15s;}
    .buddy-chip:hover{background:#1a3fa8;color:#fff;border-color:#1a3fa8;}
    body.dark .buddy-chip{border-color:#2a3550;background:#1a2236;color:#93c5fd;}
    body.dark .buddy-chip:hover{background:#1a3fa8;color:#fff;}
    .buddy-input-row{padding:10px 12px;border-top:1px solid #e2e8f4;display:flex;gap:8px;align-items:flex-end;flex-shrink:0;}
    body.dark .buddy-input-row{border-color:#2a3550;}
    .buddy-textarea{
      flex:1;border:1.5px solid #e2e8f4;border-radius:12px;padding:9px 12px;
      font-size:.84rem;font-family:'Roboto',sans-serif;resize:none;
      color:#1e2749;background:#f8fafc;outline:none;max-height:100px;min-height:40px;
      line-height:1.5;transition:.18s;
    }
    .buddy-textarea:focus{border-color:#1a3fa8;background:#fff;}
    body.dark .buddy-textarea{background:#111624;color:#e6edf3;border-color:#2a3550;}
    body.dark .buddy-textarea:focus{border-color:#3b82f6;background:#161b27;}
    .buddy-send{
      width:38px;height:38px;border-radius:10px;flex-shrink:0;
      background:linear-gradient(135deg,#0c1f6e,#1a3fa8);
      border:none;color:#fff;cursor:pointer;font-size:.9rem;
      display:flex;align-items:center;justify-content:center;transition:.18s;
    }
    .buddy-send:hover{opacity:.9;transform:scale(1.05);}
    .buddy-send:disabled{opacity:.4;cursor:not-allowed;transform:none;}
    .buddy-footer{padding:6px 12px 8px;text-align:center;flex-shrink:0;}
    .buddy-footer-txt{font-size:.58rem;color:#94a3b8;}
    .buddy-usage{padding:6px 12px;text-align:center;flex-shrink:0;}
    .buddy-usage-bar{height:3px;background:#e2e8f4;border-radius:2px;margin:4px 0;}
    body.dark .buddy-usage-bar{background:#2a3550;}
    .buddy-usage-fill{height:100%;background:linear-gradient(90deg,#1a3fa8,#f97316);border-radius:2px;transition:.4s;}
    .buddy-usage-txt{font-size:.6rem;color:#94a3b8;}
    .buddy-signin-prompt{
      margin:8px 12px;padding:10px 12px;
      background:linear-gradient(135deg,rgba(26,63,168,.08),rgba(249,115,22,.06));
      border:1.5px solid rgba(26,63,168,.18);border-radius:10px;
      text-align:center;font-size:.74rem;color:#1a3fa8;font-weight:600;
    }
    body.dark .buddy-signin-prompt{background:rgba(26,63,168,.15);color:#93c5fd;border-color:rgba(59,130,246,.25);}
    .buddy-signin-prompt button{
      margin-top:6px;background:#1a3fa8;color:#fff;border:none;
      padding:6px 14px;border-radius:7px;font-size:.72rem;font-weight:800;cursor:pointer;font-family:inherit;
    }
  `;
  document.head.appendChild(style);

  // ── HTML ──
  const today = new Date().toDateString();
  function getUsage(){
    try{const d=JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}');return d.date===today?(d.count||0):0;}catch(e){return 0;}
  }
  function setUsage(n){
    try{localStorage.setItem(STORAGE_KEY,JSON.stringify({date:today,count:n}));}catch(e){}
  }

  const container = document.createElement('div');
  container.innerHTML = `
    <button id="bqm-buddy-fab" aria-label="Open Big Quams Study Buddy" onclick="window.bqmToggleBuddy()">
      🎓
      <span id="bqm-buddy-badge"></span>
    </button>
    <div id="bqm-buddy-panel" role="dialog" aria-label="Big Quams Media Study Buddy">
      <div class="buddy-header">
        <div class="buddy-avatar">🎓</div>
        <div>
          <div class="buddy-title">Big Quams Study Buddy</div>
          <div class="buddy-sub">AI-powered · Powered by Claude</div>
        </div>
        <div class="buddy-status"><div class="buddy-dot"></div>Online</div>
        <button class="buddy-close" onclick="window.bqmToggleBuddy()" aria-label="Close">✕</button>
      </div>

      <div class="buddy-messages" id="bqm-buddy-messages">
        <div class="buddy-msg ai">
          <div class="buddy-bubble">👋 Hello! I'm your Big Quams Study Buddy — powered by AI.<br><br>Ask me anything about JAMB, Post-UTME, university courses, subject combinations, scholarship applications, or general study tips for Nigerian students.<br><br>What would you like to know? 📚</div>
          <div class="buddy-msg-time">Just now</div>
        </div>
      </div>

      <div class="buddy-typing buddy-msg ai" id="bqm-buddy-typing">
        <div class="buddy-bubble"><div class="buddy-dots"><span></span><span></span><span></span></div></div>
      </div>

      <div class="buddy-suggestions" id="bqm-buddy-chips">
        <button class="buddy-chip" onclick="window.bqmAskChip(this)">JAMB cutoff for Medicine 🏥</button>
        <button class="buddy-chip" onclick="window.bqmAskChip(this)">Best JAMB prep tips 📝</button>
        <button class="buddy-chip" onclick="window.bqmAskChip(this)">How is Post-UTME calculated? 🧮</button>
        <button class="buddy-chip" onclick="window.bqmAskChip(this)">Subject combo for Law ⚖️</button>
        <button class="buddy-chip" onclick="window.bqmAskChip(this)">NELFUND loan requirements 💳</button>
      </div>

      <div class="buddy-usage" id="bqm-buddy-usage-wrap">
        <div class="buddy-usage-bar"><div class="buddy-usage-fill" id="bqm-usage-fill" style="width:0%"></div></div>
        <div class="buddy-usage-txt" id="bqm-usage-txt"></div>
      </div>

      <div id="bqm-signin-prompt" style="display:none" class="buddy-signin-prompt">
        🔒 Sign in to get unlimited questions!<br>
        <button onclick="window.openBuddySignIn()">Sign In / Create Account →</button>
      </div>

      <div class="buddy-input-row">
        <textarea class="buddy-textarea" id="bqm-buddy-input" placeholder="Ask any study question…" rows="1"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();window.bqmSend();}"
          oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,100)+'px'"></textarea>
        <button class="buddy-send" id="bqm-buddy-send" onclick="window.bqmSend()" title="Send">➤</button>
      </div>
      <div class="buddy-footer"><span class="buddy-footer-txt">Big Quams Media® AI · Answers may not always be 100% accurate — verify important info</span></div>
    </div>
  `;
  document.body.appendChild(container);

  // ── TOGGLE ──
  window.bqmToggleBuddy = function(){
    isOpen = !isOpen;
    const fab = document.getElementById('bqm-buddy-fab');
    const panel = document.getElementById('bqm-buddy-panel');
    fab.classList.toggle('open', isOpen);
    panel.classList.toggle('open', isOpen);
    document.getElementById('bqm-buddy-badge').classList.remove('show');
    if(isOpen){
      document.getElementById('bqm-buddy-input').focus();
      updateUsageBar();
    }
  };

  // ── USAGE BAR ──
  function updateUsageBar(){
    const isSignedIn = !!(currentUser || (window.firebase && window.firebase.auth && window.firebase.auth().currentUser));
    const used = getUsage();
    const wrap = document.getElementById('bqm-buddy-usage-wrap');
    const fill = document.getElementById('bqm-usage-fill');
    const txt  = document.getElementById('bqm-usage-txt');
    const prompt = document.getElementById('bqm-signin-prompt');
    if(isSignedIn){
      wrap.style.display='none';
      prompt.style.display='none';
    } else {
      wrap.style.display='block';
      fill.style.width = Math.min((used/MAX_FREE)*100,100)+'%';
      txt.textContent = used >= MAX_FREE
        ? 'Daily limit reached — sign in for unlimited questions'
        : `${MAX_FREE - used} free question${MAX_FREE-used===1?'':'s'} remaining today`;
      prompt.style.display = used >= MAX_FREE ? 'block' : 'none';
    }
  }

  // ── SEND ──
  window.bqmSend = async function(){
    const input = document.getElementById('bqm-buddy-input');
    const q = (input.value||'').trim();
    if(!q || isTyping) return;

    const isSignedIn = !!(currentUser || (window.firebase && window.firebase.auth && window.firebase.auth().currentUser));
    const used = getUsage();

    if(!isSignedIn && used >= MAX_FREE){
      updateUsageBar();
      return;
    }

    // Add user message
    addMessage('user', q);
    input.value = '';
    input.style.height = 'auto';

    // Hide chips after first use
    document.getElementById('bqm-buddy-chips').style.display='none';

    // Increment usage
    if(!isSignedIn) setUsage(used+1);

    // Build history (last 6 turns for context)
    messageHistory.push({role:'user', content:q});
    if(messageHistory.length > 12) messageHistory = messageHistory.slice(-12);

    // Show typing
    isTyping = true;
    document.getElementById('bqm-buddy-send').disabled = true;
    document.getElementById('bqm-buddy-typing').classList.add('show');
    scrollToBottom();

    try{
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          model:'claude-sonnet-4-6',
          max_tokens:1000,
          system:`You are the Big Quams Study Buddy — an expert AI tutor built into Big Quams Media®, Nigeria's leading student success platform. Your sole purpose is helping Nigerian secondary school and university students succeed academically.

You specialise in:
- JAMB UTME (subjects, topics, cutoff marks, registration process, result checking, profile codes)
- Post-UTME screening (aggregate calculation, school-specific requirements)
- Nigerian university admissions (CAPS, DE, supplementary forms)
- Course/subject combinations for all Nigerian universities
- O'Level requirements (WAEC, NECO, NABTEB grading)
- GPA/CGPA calculation on 4.0 and 5.0 scales
- Scholarship opportunities for Nigerian students
- NELFUND student loan application and eligibility
- Study tips and exam strategies for Nigerian syllabuses
- University life, hostel tips, campus advice

Rules:
- Always respond in clear, friendly, encouraging Nigerian student-friendly language
- Keep answers concise but complete — use bullet points for lists
- If a question is outside your scope (e.g. politics, adult content), politely redirect to academic topics
- Never make up specific cutoff marks — say "cutoff marks vary by year, check JAMB's official website or Big Quams Media® for the latest"
- Always end answers with one follow-up question or tip to keep the student engaged
- Refer to the platform as "Big Quams Media®" never "BQM" or anything shorter`,
          messages: messageHistory
        })
      });
      const data = await response.json();
      const answer = data.content?.[0]?.text || 'Sorry, I had trouble answering that. Please try again!';
      messageHistory.push({role:'assistant', content:answer});
      if(messageHistory.length > 12) messageHistory = messageHistory.slice(-12);
      document.getElementById('bqm-buddy-typing').classList.remove('show');
      addMessage('ai', answer);
    }catch(e){
      document.getElementById('bqm-buddy-typing').classList.remove('show');
      addMessage('ai','⚠️ I\'m having connection trouble. Please check your internet and try again.');
    }

    isTyping = false;
    document.getElementById('bqm-buddy-send').disabled = false;
    updateUsageBar();
  };

  // ── CHIP SHORTCUT ──
  window.bqmAskChip = function(btn){
    const input = document.getElementById('bqm-buddy-input');
    input.value = btn.textContent.replace(/[🏥📝🧮⚖️💳]/g,'').trim();
    window.bqmSend();
  };

  // ── SIGN IN REDIRECT ──
  window.openBuddySignIn = function(){
    // Try to open daily.html auth modal if on same page, else navigate
    if(typeof window.openAuth === 'function'){window.openAuth();window.bqmToggleBuddy();}
    else window.location.href='daily.html?signup=1';
  };

  // ── ADD MESSAGE ──
  function addMessage(role, text){
    const msgs = document.getElementById('bqm-buddy-messages');
    const div = document.createElement('div');
    div.className = 'buddy-msg '+role;
    const time = new Date().toLocaleTimeString('en-NG',{hour:'2-digit',minute:'2-digit'});
    // Convert markdown-style bold and line breaks
    const html = text
      .replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')
      .replace(/\*(.*?)\*/g,'<em>$1</em>')
      .replace(/\n/g,'<br>');
    div.innerHTML = `<div class="buddy-bubble">${html}</div><div class="buddy-msg-time">${time}</div>`;
    msgs.appendChild(div);
    // Insert before typing indicator
    const typing = document.getElementById('bqm-buddy-typing');
    msgs.insertBefore(div, typing);
    scrollToBottom();

    // Badge when closed
    if(!isOpen){
      const badge = document.getElementById('bqm-buddy-badge');
      badge.classList.add('show');
    }
  }

  function scrollToBottom(){
    const msgs = document.getElementById('bqm-buddy-messages');
    setTimeout(()=>{msgs.scrollTop = msgs.scrollHeight;},50);
  }

  // ── LISTEN FOR AUTH STATE ──
  setTimeout(()=>{
    if(window._onAuth){
      window._onAuth(user=>{
        currentUser=user;
        updateUsageBar();
      });
    }
  },1000);

  // Initial usage bar update
  setTimeout(updateUsageBar, 500);

})();
