/**
 * Big Quams Media® — Shared Account Widget
 * Sign In / Create Account modal, usable from any page.
 * Reuses the same Firebase project & 'cbt_users' collection as daily.html
 * so accounts created here work everywhere else on the site (CBT, profile, daily challenges).
 *
 * Usage: <script src="auth.js" defer></script>
 * Open it from anywhere with: window.bqmOpenAuth('signin' | 'register')
 *
 * ── ARCHITECTURE NOTES (Phase 1.6 — read before extending) ──────────────────
 * This is intentionally a *lightweight* v1: a single modal, one Firestore
 * collection, no dedicated auth routes. It is built so the pieces below can
 * be lifted out into a real system later without a rewrite:
 *
 * 1. ROUTES (not yet built): this modal can be moved behind real URLs
 *    (login.html, register.html, forgot-password.html) later. Keep the
 *    functions below (doSignIn/doRegister/doPasswordReset/doGoogle) as pure
 *    as possible so a future page-based UI can call the same functions —
 *    only the markup/open-close logic is modal-specific.
 *
 * 2. RBAC (not yet enforced): every profile written to 'cbt_users' now
 *    includes a `role` field, defaulted to 'student'. No page currently
 *    reads or checks this field. When Founder/Publisher dashboards are
 *    built, gate them by reading `role` from the user's cbt_users doc —
 *    do NOT trust a client-set role for anything sensitive; a real RBAC
 *    rollout should set/verify roles via Firestore security rules or a
 *    backend function, not the client.
 *
 * 3. FORGOT PASSWORD: implemented here as a thin wrapper around Firebase's
 *    built-in sendPasswordResetEmail — no custom backend needed. This is
 *    the extent of "auth" this phase should own; anything more (custom
 *    tokens, session servers, SSO) is a later-phase decision.
 *
 * 4. DASHBOARD ROUTING: afterAuthSuccess() currently hardcodes a redirect
 *    to profile.html for every account. Once roles exist, this is the one
 *    place that should branch (student → profile.html, founder → future
 *    founder dashboard, publisher → future publisher dashboard).
 * ─────────────────────────────────────────────────────────────────────────
 */
(function(){
  'use strict';
  if (window.bqmOpenAuth) return; // already initialised on this page

  var FIREBASE_CFG = {
    apiKey: 'AIzaSyCRrp0cGK-hlBy8Ez8blesCsWn3FP7I-lQ',
    authDomain: 'big-quams-media.firebaseapp.com',
    projectId: 'big-quams-media'
  };

  var auth, db, fs; // fs = firestore fn helpers
  var fbReady = false, fbLoading = false;
  var pendingAction = null;

  function loadFirebase(){
    if (fbLoading) return;
    fbLoading = true;
    Promise.all([
      import('https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js'),
      import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js')
    ]).then(function(mods){
      var appMod = mods[0], authMod = mods[1], fsMod = mods[2];
      var app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(FIREBASE_CFG);
      auth = authMod.getAuth(app);
      db = fsMod.getFirestore(app);
      fs = {
        doc: fsMod.doc, getDoc: fsMod.getDoc, setDoc: fsMod.setDoc,
        updateDoc: fsMod.updateDoc, increment: fsMod.increment
      };
      fs.signIn = authMod.signInWithEmailAndPassword;
      fs.createAccount = authMod.createUserWithEmailAndPassword;
      fs.sendPasswordResetEmail = authMod.sendPasswordResetEmail;
      fs.googleProvider = new authMod.GoogleAuthProvider();
      fs.signInWithPopup = authMod.signInWithPopup;
      fs.updateProfile = authMod.updateProfile;
      window._auth = window._auth || auth;
      window._db = window._db || db;
      fbReady = true;
      if (pendingAction){ var a = pendingAction; pendingAction = null; a(); }
    }).catch(function(err){
      console.warn('[BQM Auth] Firebase failed to load:', err.message);
      showErr('bqm-auth-err', 'Connection problem. Check your internet and try again.');
    });
  }

  /* ── STYLES (self-contained, hardcoded brand colours — matches site palette) ── */
  var style = document.createElement('style');
  style.textContent = [
    '.bqm-auth-overlay{position:fixed;inset:0;background:rgba(10,20,60,.72);z-index:9500;display:none;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(6px)}',
    '.bqm-auth-overlay.open{display:flex}',
    '.bqm-auth-card{background:#fff;border-radius:20px;padding:28px 24px;width:100%;max-width:380px;box-shadow:0 32px 80px rgba(0,0,0,.35);font-family:"Roboto",sans-serif;animation:bqmAuthPop .3s cubic-bezier(.34,1.56,.64,1)}',
    '@keyframes bqmAuthPop{0%{transform:scale(.9);opacity:0}100%{transform:scale(1);opacity:1}}',
    '.bqm-auth-logo{width:52px;height:52px;border-radius:50%;border:3px solid #f97316;margin:0 auto 10px;overflow:hidden;display:block}',
    '.bqm-auth-logo img{width:100%;height:100%;object-fit:cover;display:block}',
    '.bqm-auth-title{font-family:"Montserrat",sans-serif;font-size:1rem;font-weight:800;color:#1e2749;text-align:center;margin-bottom:4px}',
    '.bqm-auth-sub{font-size:.74rem;color:#64748b;text-align:center;margin-bottom:16px;line-height:1.5}',
    '.bqm-auth-tabs{display:flex;gap:0;margin-bottom:14px;border-radius:9px;overflow:hidden;border:1.5px solid #e2e8f4}',
    '.bqm-auth-tab-btn{flex:1;padding:8px;font-family:"Montserrat",sans-serif;font-size:.74rem;font-weight:800;border:none;cursor:pointer;background:#f0f4ff;color:#64748b}',
    '.bqm-auth-tab-btn.active{background:#1a3fa8;color:#fff}',
    '.bqm-google-btn{width:100%;display:flex;align-items:center;justify-content:center;gap:10px;background:#fff;border:1.5px solid #e2e8f4;border-radius:9px;padding:11px;font-family:"Montserrat",sans-serif;font-weight:700;font-size:.84rem;color:#1e2749;cursor:pointer;margin-bottom:10px}',
    '.bqm-auth-divider{display:flex;align-items:center;gap:8px;margin:6px 0;color:#64748b;font-size:.68rem}',
    '.bqm-auth-divider::before,.bqm-auth-divider::after{content:"";flex:1;height:1px;background:#e2e8f4}',
    '.bqm-auth-input{width:100%;padding:11px 13px;border:1.5px solid #e2e8f4;border-radius:9px;font-size:.9rem;font-family:"Roboto",sans-serif;color:#1e2749;background:#f0f4ff;margin-bottom:10px}',
    '.bqm-auth-error{color:#b91c1c;font-size:.74rem;background:#fee2e2;border-radius:7px;padding:7px 10px;margin-bottom:8px;display:none}',
    '.bqm-auth-btn{width:100%;padding:12px;background:linear-gradient(135deg,#0c1f6e,#1a3fa8);color:#fff;border:none;border-radius:9px;font-family:"Montserrat",sans-serif;font-weight:800;font-size:.88rem;cursor:pointer;margin-bottom:8px}',
    '.bqm-auth-btn:disabled{opacity:.6;cursor:default}',
    '.bqm-auth-close{background:none;border:none;color:#64748b;font-size:.74rem;cursor:pointer;display:block;margin:4px auto 0;text-decoration:underline}',
    '.bqm-auth-forgot{background:none;border:none;color:#1a3fa8;font-size:.72rem;font-weight:700;cursor:pointer;display:block;margin:-4px 0 10px;text-decoration:underline;padding:0}',
    '.bqm-auth-consent{display:flex;align-items:flex-start;gap:8px;font-size:.68rem;color:#64748b;line-height:1.5;margin:2px 0 12px}',
    '.bqm-auth-consent input{margin-top:2px;flex-shrink:0}',
    '.bqm-auth-consent a{color:#1a3fa8;font-weight:700;text-decoration:underline}'
  ].join('');
  document.head.appendChild(style);

  /* ── MARKUP ── */
  var wrap = document.createElement('div');
  wrap.className = 'bqm-auth-overlay';
  wrap.id = 'bqmAuthOverlay';
  wrap.innerHTML =
    '<div class="bqm-auth-card">' +
      '<a class="bqm-auth-logo" href="index.html" tabindex="-1"><img src="https://bigquamsmedia.com.ng/logo.png" alt="Big Quams Media"></a>' +
      '<div class="bqm-auth-title" id="bqm-auth-title">Welcome Back</div>' +
      '<div class="bqm-auth-sub" id="bqm-auth-sub">Sign in to access your student dashboard.</div>' +
      '<div class="bqm-auth-tabs">' +
        '<button type="button" class="bqm-auth-tab-btn active" data-tab="signin">Sign In</button>' +
        '<button type="button" class="bqm-auth-tab-btn" data-tab="register">Sign Up</button>' +
      '</div>' +
      '<button type="button" class="bqm-google-btn" id="bqm-google-btn">' +
        '<svg width="17" height="17" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.1 0 5.8 1.1 8 2.9l6-6C34.5 3.1 29.6 1 24 1 14.8 1 7 6.7 3.7 14.6l7 5.4C12.5 13.8 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.4c-.5 2.8-2.1 5.2-4.5 6.8l7 5.4C43.1 36.8 46.1 31.1 46.1 24.5z"/><path fill="#FBBC05" d="M10.7 28.6c-.5-1.4-.8-2.9-.8-4.6s.3-3.2.8-4.6l-7-5.4C2.2 17.1 1 20.4 1 24s1.2 6.9 3.7 9.9l7-5.3z"/><path fill="#34A853" d="M24 47c5.6 0 10.4-1.9 13.8-5.1l-7-5.4c-1.9 1.3-4.2 2-6.8 2-6.2 0-11.5-4.3-13.3-10l-7 5.4C7 41.3 14.8 47 24 47z"/></svg>' +
        'Continue with Google' +
      '</button>' +
      '<div class="bqm-auth-divider">or email</div>' +
      '<div id="bqm-signin-form">' +
        '<input class="bqm-auth-input" type="email" id="bqm-auth-email" placeholder="Email address" autocomplete="email">' +
        '<input class="bqm-auth-input" type="password" id="bqm-auth-pw" placeholder="Password" autocomplete="current-password">' +
        '<button type="button" class="bqm-auth-forgot" id="bqm-forgot-btn">Forgot password?</button>' +
        '<div class="bqm-auth-error" id="bqm-auth-err"></div>' +
        '<button type="button" class="bqm-auth-btn" id="bqm-signin-btn">Sign In →</button>' +
      '</div>' +
      '<div id="bqm-register-form" style="display:none">' +
        '<input class="bqm-auth-input" type="text" id="bqm-reg-name" placeholder="Your full name" autocomplete="name">' +
        '<input class="bqm-auth-input" type="email" id="bqm-reg-email" placeholder="Email address" autocomplete="email">' +
        '<input class="bqm-auth-input" type="password" id="bqm-reg-pw" placeholder="Password (min 6 chars)" autocomplete="new-password">' +
        '<label class="bqm-auth-consent"><input type="checkbox" id="bqm-reg-consent">I agree to the <a href="terms.html" target="_blank" rel="noopener">Terms &amp; Conditions</a> and <a href="privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.</label>' +
        '<div class="bqm-auth-error" id="bqm-reg-err"></div>' +
        '<button type="button" class="bqm-auth-btn" id="bqm-reg-btn">Create Free Account →</button>' +
      '</div>' +
      '<button type="button" class="bqm-auth-close" id="bqm-auth-close">Maybe later</button>' +
    '</div>';
  document.addEventListener('DOMContentLoaded', function(){ document.body.appendChild(wrap); attachEvents(); });
  // In case DOMContentLoaded already fired (script has `defer`, so usually fine either way)
  if (document.readyState === 'interactive' || document.readyState === 'complete'){
    document.body.appendChild(wrap);
    attachEvents();
  }

  function $(id){ return document.getElementById(id); }

  function attachEvents(){
    wrap.querySelectorAll('.bqm-auth-tab-btn').forEach(function(btn){
      btn.addEventListener('click', function(){ switchTab(btn.getAttribute('data-tab')); });
    });
    $('bqm-auth-close').addEventListener('click', window.bqmCloseAuth);
    $('bqm-signin-btn').addEventListener('click', doSignIn);
    $('bqm-forgot-btn').addEventListener('click', doPasswordReset);
    $('bqm-reg-btn').addEventListener('click', doRegister);
    $('bqm-google-btn').addEventListener('click', doGoogle);
    $('bqm-auth-pw').addEventListener('keydown', function(e){ if(e.key==='Enter') doSignIn(); });
    $('bqm-reg-pw').addEventListener('keydown', function(e){ if(e.key==='Enter') doRegister(); });
    wrap.addEventListener('click', function(e){ if (e.target === wrap) window.bqmCloseAuth(); });
  }

  function switchTab(tab){
    wrap.querySelectorAll('.bqm-auth-tab-btn').forEach(function(b){
      b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    });
    $('bqm-signin-form').style.display = tab === 'signin' ? 'block' : 'none';
    $('bqm-register-form').style.display = tab === 'register' ? 'block' : 'none';
    $('bqm-auth-title').textContent = tab === 'signin' ? 'Welcome Back' : 'Join Big Quams Media®';
    $('bqm-auth-sub').textContent = tab === 'signin'
      ? 'Sign in to access your student dashboard.'
      : 'Create a free account for CBT tracking, coins, streaks and more.';
    hideErr('bqm-auth-err'); hideErr('bqm-reg-err');
  }

  function showErr(id, msg){ var el = $(id); if(!el) return; el.textContent = '❌ ' + msg; el.style.display = 'block'; }
  function hideErr(id){ var el = $(id); if(!el) return; el.style.display = 'none'; }

  window.bqmOpenAuth = function(mode){
    mode = mode === 'register' ? 'register' : 'signin';
    if (!wrap.parentNode) document.body.appendChild(wrap);
    switchTab(mode);
    wrap.classList.add('open');
    document.body.style.overflow = 'hidden';
    if (!fbReady) loadFirebase();
  };

  window.bqmCloseAuth = function(){
    wrap.classList.remove('open');
    document.body.style.overflow = '';
  };

  function withFirebase(action){
    if (fbReady) { action(); return; }
    pendingAction = action;
    loadFirebase();
  }

  function generateReferralCode(name){
    var base = (name || 'STUDENT').toUpperCase().replace(/[^A-Z]/g, '').substring(0, 8) || 'STUDENT';
    var rand = Math.random().toString(36).substring(2, 6).toUpperCase();
    return base + '-' + rand;
  }

  function ensureUserProfile(user, extra){
    extra = extra || {};
    var ref = fs.doc(db, 'cbt_users', user.uid);
    return fs.getDoc(ref).then(function(snap){
      if (snap.exists()) return snap.data();
      var urlRef = new URLSearchParams(window.location.search).get('ref') || '';
      var name = extra.name || user.displayName || (user.email ? user.email.split('@')[0] : 'Student');
      var myCode = generateReferralCode(name);
      var profile = {
        uid: user.uid, email: user.email || '', displayName: name, nickname: name,
        gender: extra.gender || '', photoURL: user.photoURL || '',
        role: 'student', /* RBAC placeholder — not enforced yet, see architecture notes above */
        referralCode: myCode, referredBy: urlRef, referralCount: 0,
        coinsBalance: 0, coinsDailyEarned: 0, dailyStreak: 0, lastDailyVisit: '',
        sessions: 0, bestScore: 0, totalCorrect: 0, totalQuestions: 0,
        streak: 0, lastPracticeDate: '', subjectHistory: {}, achievements: [],
        joinDate: new Date().toISOString(), sessionHistory: [], subjectsPractised: []
      };
      return fs.setDoc(ref, profile).then(function(){
        return fs.setDoc(fs.doc(db, 'referral_codes', myCode), {
          uid: user.uid, email: user.email || '', name: name, code: myCode, createdAt: new Date().toISOString()
        }, { merge: true });
      }).then(function(){
        if (urlRef && urlRef !== myCode){
          return fs.getDoc(fs.doc(db, 'referral_codes', urlRef)).then(function(codeDoc){
            if (codeDoc.exists()){
              var referrerUid = codeDoc.data().uid;
              if (referrerUid && referrerUid !== user.uid){
                return fs.updateDoc(fs.doc(db, 'cbt_users', referrerUid), {
                  referralCount: fs.increment(1), coinsBalance: fs.increment(20)
                }).catch(function(){});
              }
            }
          }).catch(function(){});
        }
      }).then(function(){ return profile; });
    }).catch(function(e){ console.warn('[BQM Auth] profile error:', e.message); return null; });
  }

  function afterAuthSuccess(){
    // NOTE: single redirect target for now. When roles exist, branch here:
    // e.g. role==='founder' -> founder-dashboard.html, role==='publisher' -> publisher-dashboard.html
    window.bqmCloseAuth();
    var onDashboard = /profile\.html/i.test(window.location.pathname);
    if (!onDashboard) window.location.href = 'profile.html';
  }

  function doPasswordReset(){
    var email = $('bqm-auth-email').value.trim();
    if (!email){ showErr('bqm-auth-err', 'Enter your email address above first, then tap "Forgot password?" again.'); return; }
    hideErr('bqm-auth-err');
    var btn = $('bqm-forgot-btn'); var original = btn.textContent; btn.textContent = 'Sending…'; btn.disabled = true;
    withFirebase(function(){
      fs.sendPasswordResetEmail(auth, email).then(function(){
        btn.textContent = 'Reset link sent ✓';
        setTimeout(function(){ btn.textContent = original; btn.disabled = false; }, 4000);
      }).catch(function(err){
        showErr('bqm-auth-err', err.code === 'auth/user-not-found' ? 'No account found with that email.' : err.message);
        btn.textContent = original; btn.disabled = false;
      });
    });
  }

  function doSignIn(){
    var email = $('bqm-auth-email').value.trim();
    var pw = $('bqm-auth-pw').value;
    if (!email || !pw){ showErr('bqm-auth-err', 'Enter email and password.'); return; }
    hideErr('bqm-auth-err');
    var btn = $('bqm-signin-btn'); btn.disabled = true; btn.textContent = 'Signing in…';
    withFirebase(function(){
      fs.signIn(auth, email, pw).then(function(){
        afterAuthSuccess();
      }).catch(function(err){
        showErr('bqm-auth-err', err.code === 'auth/invalid-credential' ? 'Incorrect email or password.' : err.message);
      }).finally(function(){ btn.disabled = false; btn.textContent = 'Sign In →'; });
    });
  }

  function doRegister(){
    var name = $('bqm-reg-name').value.trim();
    var email = $('bqm-reg-email').value.trim();
    var pw = $('bqm-reg-pw').value;
    var consent = $('bqm-reg-consent').checked;
    if (!name || !email || !pw){ showErr('bqm-reg-err', 'Fill in all fields.'); return; }
    if (pw.length < 6){ showErr('bqm-reg-err', 'Password must be at least 6 characters.'); return; }
    if (!consent){ showErr('bqm-reg-err', 'Please agree to the Terms & Privacy Policy to continue.'); return; }
    hideErr('bqm-reg-err');
    var btn = $('bqm-reg-btn'); btn.disabled = true; btn.textContent = 'Creating account…';
    withFirebase(function(){
      fs.createAccount(auth, email, pw).then(function(cred){
        var updateP = cred.user ? fs.updateProfile(cred.user, { displayName: name }) : Promise.resolve();
        return updateP.then(function(){ return ensureUserProfile(cred.user, { name: name }); });
      }).then(function(){
        afterAuthSuccess();
      }).catch(function(err){
        showErr('bqm-reg-err', err.code === 'auth/email-already-in-use' ? 'Email already registered. Sign in instead.' : err.message);
      }).finally(function(){ btn.disabled = false; btn.textContent = 'Create Free Account →'; });
    });
  }

  function doGoogle(){
    withFirebase(function(){
      fs.signInWithPopup(auth, fs.googleProvider).then(function(cred){
        return ensureUserProfile(cred.user, {});
      }).then(function(){
        afterAuthSuccess();
      }).catch(function(err){
        if (err.code !== 'auth/popup-closed-by-user') showErr('bqm-auth-err', err.message);
      });
    });
  }
})();
