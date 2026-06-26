/**
 * BIG QUAMS MEDIA® — FCM Notification Module (fcm-init.js)
 * ─────────────────────────────────────────────────────────
 * All data is served from Firebase Firestore — no JSON files.
 * Handles: token registration, Firestore storage, UI updates,
 *          welcome notification, foreground messages, iOS edge cases.
 *
 * Usage: <script type="module" src="fcm-init.js"></script>
 * Then call: window.BQM_enableNotifications() from any button onclick
 */

import { initializeApp }     from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getMessaging, getToken, onMessage }
                             from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js';
import { getFirestore, doc, setDoc, serverTimestamp, collection, query, orderBy, limit, onSnapshot }
                             from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// ── CONFIG ──
const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyCRrp0cGK-hlBy8Ez8blesCsWn3FP7I-lQ',
  authDomain:        'big-quams-media.firebaseapp.com',
  projectId:         'big-quams-media',
  storageBucket:     'big-quams-media.firebasestorage.app',
  messagingSenderId: '383186323859',
  appId:             '1:383186323859:web:826d6b9977cfa947730066'
};

const VAPID_KEY  = 'BBb1Kl0U1VL2p1Buf6HsxIOxRaiEqyyBKO3KuNpJupif027umU-WzgZRWGHI4FANB3w0aBo5k3tQ8lGu7LC57mo';
const BQM_DOMAIN = 'https://bigquamsmedia.com.ng';
const BQM_ICON   = 'https://bigquamsmedia.com.ng/file_000000000370724698997662ddbee6b5.png';

const LS_NOTIF_ENABLED = 'bqm_notif_enabled';
const LS_NOTIF_TOKEN   = 'bqm_fcm_token';
const SS_BAR_DISMISSED = 'bqm_notif_bar_dismissed';

// ── INIT ──
const app       = initializeApp(FIREBASE_CONFIG);
const messaging = getMessaging(app);
const db        = getFirestore(app);

// ─────────────────────────────────────────────
// SAVE TOKEN TO FIRESTORE
// ─────────────────────────────────────────────
async function saveTokenToFirestore(token) {
  try {
    await setDoc(doc(db, 'fcm_tokens', token), {
      token,
      platform:  getPlatform(),
      userAgent: navigator.userAgent.slice(0, 200),
      url:       location.href,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      active:    true,
    }, { merge: true });
  } catch (e) {
    console.warn('[BQM FCM] Could not save token to Firestore:', e.message);
  }
}

function getPlatform() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua))          return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Windows/i.test(ua))          return 'windows';
  if (/Mac/i.test(ua))              return 'mac';
  return 'unknown';
}

// ─────────────────────────────────────────────
// UPDATE UI
// ─────────────────────────────────────────────
function updateNotifUI(granted) {
  const btn = document.getElementById('notifEnableBtn');
  const msg = document.getElementById('notifEnabledMsg');
  const bar = document.getElementById('notifBar');
  if (granted) {
    if (btn) btn.style.display = 'none';
    if (msg) msg.classList.add('show');
    if (bar) bar.classList.remove('show');
    localStorage.setItem(LS_NOTIF_ENABLED, '1');
  }
}

// ─────────────────────────────────────────────
// WELCOME NOTIFICATION
// ─────────────────────────────────────────────
async function sendWelcomeNotification() {
  try {
    const reg = await navigator.serviceWorker.ready;
    if (reg.active) {
      reg.active.postMessage({
        type:  'SHOW_NOTIFICATION',
        title: '🎓 Big Quams Media® — You\'re In!',
        body:  'Notifications enabled! You\'ll now receive JAMB updates, scholarship alerts, and campus news — even when offline.',
        url:   BQM_DOMAIN + '/'
      });
    }
  } catch (e) {
    console.warn('[BQM FCM] Welcome notif failed:', e.message);
  }
}

// ─────────────────────────────────────────────
// MAIN: ENABLE NOTIFICATIONS
// ─────────────────────────────────────────────
async function enableNotifications() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    _showToast('⚠️ Your browser doesn\'t support notifications. Try Chrome or Firefox.');
    return;
  }

  // iOS Safari must be installed as PWA
  const isIOS        = /iPad|iPhone|iPod/i.test(navigator.userAgent) && !window.MSStream;
  const isStandalone = window.navigator.standalone ||
                       window.matchMedia('(display-mode: standalone)').matches;
  if (isIOS && !isStandalone) {
    _showToast('📱 On iPhone: Add this site to your Home Screen first, then enable notifications.');
    return;
  }

  if (Notification.permission === 'granted') {
    updateNotifUI(true);
    _showToast('✅ Notifications are already enabled!');
    return;
  }

  if (Notification.permission === 'denied') {
    _showToast('❌ Notifications blocked. Go to browser Settings → Site Settings → Notifications → Allow.');
    return;
  }

  let perm;
  try {
    perm = await Notification.requestPermission();
  } catch (e) {
    _showToast('Could not request permission: ' + e.message);
    return;
  }

  if (perm !== 'granted') {
    _showToast('ℹ️ Notifications not enabled. You can turn them on anytime from Settings.');
    return;
  }

  let reg;
  try {
    reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
  } catch (e) {
    console.warn('[BQM FCM] SW registration failed:', e.message);
  }

  try {
    const token = await getToken(messaging, {
      vapidKey:                  VAPID_KEY,
      serviceWorkerRegistration: reg,
    });

    if (token) {
      localStorage.setItem(LS_NOTIF_TOKEN, token);
      await saveTokenToFirestore(token);
      updateNotifUI(true);
      _showToast('✅ Notifications enabled! You\'ll receive updates even when offline.');
      setTimeout(sendWelcomeNotification, 800);
    } else {
      _showToast('⚠️ Could not get notification token. Please try again.');
    }
  } catch (e) {
    console.warn('[BQM FCM] getToken failed:', e.message);
    updateNotifUI(true);
    _showToast('✅ Notifications enabled!');
    setTimeout(sendWelcomeNotification, 800);
  }
}

// ─────────────────────────────────────────────
// FOREGROUND MESSAGE HANDLER
// Shows in-page toast when user has the site open
// ─────────────────────────────────────────────
onMessage(messaging, payload => {
  const data  = payload.data || {};
  const notif = payload.notification || {};
  const title = data.title || notif.title || 'Big Quams Media®';
  const body  = data.body  || notif.body  || 'New update available!';
  const url   = data.url   || '/';
  _showToastWithLink(`🔔 ${title}: ${body}`, url);
});

// ─────────────────────────────────────────────
// BROADCAST LISTENER (browser-open fallback)
// Watches push_broadcasts in Firestore.
// Full background delivery requires the FCM backend.
// ─────────────────────────────────────────────
(function watchBroadcasts() {
  let _lastId = null;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const q = query(
      collection(db, 'push_broadcasts'),
      orderBy('sentAt', 'desc'),
      limit(1)
    );
    onSnapshot(q, async snap => {
      if (snap.empty) return;
      const latest = snap.docs[0];
      const id     = latest.id;
      const data   = latest.data();
      if (_lastId === null) { _lastId = id; return; }
      if (id === _lastId) return;
      _lastId = id;
      try {
        const reg = await navigator.serviceWorker.ready;
        if (reg.active) {
          reg.active.postMessage({
            type:  'BROADCAST_NOTIFICATION',
            title: data.title || 'Big Quams Media®',
            body:  data.body  || 'New update from BQM!',
            icon:  data.icon  || BQM_ICON,
            url:   data.link  || BQM_DOMAIN + '/',
            tag:   'bqm-broadcast-' + id,
          });
        }
      } catch (e) {
        _showToastWithLink(`🔔 ${data.title || 'BQM Update'}: ${data.body || ''}`, data.link || '/');
      }
    });
  } catch (e) {
    console.warn('[BQM FCM] Broadcast listener failed:', e.message);
  }
})();

// ─────────────────────────────────────────────
// DISMISS NOTIFICATION BAR
// ─────────────────────────────────────────────
function dismissNotifBar() {
  const bar = document.getElementById('notifBar');
  if (bar) bar.classList.remove('show');
  sessionStorage.setItem(SS_BAR_DISMISSED, '1');
}

// ─────────────────────────────────────────────
// AUTO-INIT
// ─────────────────────────────────────────────
(function autoInit() {
  if (localStorage.getItem(LS_NOTIF_ENABLED) === '1' ||
      Notification.permission === 'granted') {
    updateNotifUI(true);
    return;
  }
  if (!('Notification' in window)) return;
  if (sessionStorage.getItem(SS_BAR_DISMISSED)) return;
  setTimeout(() => {
    const bar = document.getElementById('notifBar');
    if (bar) bar.classList.add('show');
  }, 5000);
})();

// ─────────────────────────────────────────────
// TOAST HELPERS
// ─────────────────────────────────────────────
function _showToast(msg) {
  if (!msg) return;
  if (typeof window.showToast === 'function') { window.showToast(msg); return; }
  let c = document.getElementById('toast-container');
  if (!c) {
    c = document.createElement('div');
    c.id = 'toast-container';
    c.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:9999;';
    document.body.appendChild(c);
  }
  const t = document.createElement('div');
  t.style.cssText = 'background:#102880;color:white;padding:12px 20px;border-radius:8px;margin-top:8px;font-weight:600;font-size:0.9rem;box-shadow:0 4px 12px rgba(0,0,0,0.2);opacity:0;transform:translateY(12px);transition:0.35s ease;white-space:nowrap;font-family:Roboto,sans-serif;';
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => { t.style.opacity = '1'; t.style.transform = 'translateY(0)'; }, 50);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 400); }, 3500);
}

function _showToastWithLink(msg, url) {
  let c = document.getElementById('toast-container');
  if (!c) {
    c = document.createElement('div');
    c.id = 'toast-container';
    c.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:9999;';
    document.body.appendChild(c);
  }
  const t = document.createElement('div');
  t.style.cssText = 'background:#102880;color:white;padding:12px 20px;border-radius:8px;margin-top:8px;font-weight:600;font-size:0.88rem;box-shadow:0 4px 12px rgba(0,0,0,0.2);opacity:0;transform:translateY(12px);transition:0.35s ease;cursor:pointer;max-width:320px;text-align:center;font-family:Roboto,sans-serif;';
  t.textContent = msg;
  t.onclick = () => { window.location.href = url; };
  c.appendChild(t);
  setTimeout(() => { t.style.opacity = '1'; t.style.transform = 'translateY(0)'; }, 50);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 400); }, 5000);
}

// ─────────────────────────────────────────────
// EXPOSE TO WINDOW
// ─────────────────────────────────────────────
window.BQM_enableNotifications = enableNotifications;
window.BQM_dismissNotifBar     = dismissNotifBar;
window.enableNotifications     = enableNotifications;
window.dismissNotifBar         = dismissNotifBar;
