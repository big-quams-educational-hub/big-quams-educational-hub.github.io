/**
 * BIG QUAMS MEDIA® — FCM Notification Module (fcm-init.js)
 * ─────────────────────────────────────────────────────────
 * Import this on every page that has notification UI.
 * Handles: token registration, Firestore storage, UI updates,
 *          welcome notification, and iOS edge cases.
 *
 * Usage: <script type="module" src="fcm-init.js"></script>
 * Then call: window.BQM_enableNotifications() from any button onclick
 */

import { initializeApp }        from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getMessaging, getToken, onMessage }
                                from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js';
import { getFirestore, doc, setDoc, serverTimestamp }
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

const VAPID_KEY = 'BBb1Kl0U1VL2p1Buf6HsxIOxRaiEqyyBKO3KuNpJupif027umU-WzgZRWGHI4FANB3w0aBo5k3tQ8lGu7LC57mo';

// Keys
const LS_NOTIF_ENABLED  = 'bqm_notif_enabled';
const LS_NOTIF_TOKEN    = 'bqm_fcm_token';
const SS_BAR_DISMISSED  = 'bqm_notif_bar_dismissed';

// ── INIT ──
const app       = initializeApp(FIREBASE_CONFIG);
const messaging = getMessaging(app);
const db        = getFirestore(app);

// ─────────────────────────────────────────────
// SUBSCRIBE TOKEN TO TOPIC 'bqm-all'
// Uses the Instance ID (IID) API — works client-side with just the token
// ─────────────────────────────────────────────
async function subscribeToTopic(token) {
  try {
    // FCM Instance ID API — subscribes a token to a topic
    // This is the correct client-accessible endpoint for topic management
    const res = await fetch(
      `https://iid.googleapis.com/iid/v1/${token}/rel/topics/bqm-all`,
      {
        method: 'POST',
        headers: {
          // Project sender ID used as the authorization key here
          'Authorization': 'key=383186323859',
          'Content-Type': 'application/json',
          'access_token_auth': 'true',
        },
      }
    );
    if (res.ok || res.status === 200) {
      console.log('[BQM FCM] Subscribed to topic bqm-all');
    } else {
      // Non-critical — token still saved to Firestore for manual sends
      console.warn('[BQM FCM] Topic subscription status:', res.status);
    }
  } catch (e) {
    console.warn('[BQM FCM] Topic subscription failed (non-critical):', e.message);
  }
}

// ─────────────────────────────────────────────
// SAVE TOKEN TO FIRESTORE
// ─────────────────────────────────────────────
async function saveTokenToFirestore(token) {
  try {
    // Use token as document ID (safe — FCM tokens are URL-safe)
    const tokenRef = doc(db, 'fcm_tokens', token);
    await setDoc(tokenRef, {
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
  if (/Android/i.test(ua))            return 'android';
  if (/iPhone|iPad|iPod/i.test(ua))   return 'ios';
  if (/Windows/i.test(ua))            return 'windows';
  if (/Mac/i.test(ua))                return 'mac';
  return 'unknown';
}

// ─────────────────────────────────────────────
// UPDATE UI (called after permission granted)
// ─────────────────────────────────────────────
function updateNotifUI(granted) {
  // Enable button → hide, show success message
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
// WELCOME NOTIFICATION (shown on first enable)
// ─────────────────────────────────────────────
async function sendWelcomeNotification() {
  try {
    const reg = await navigator.serviceWorker.ready;
    if (reg.active) {
      reg.active.postMessage({
        type:  'SHOW_NOTIFICATION',
        title: '🎓 Big Quams Media® — You\'re In!',
        body:  'Notifications enabled! You\'ll now receive JAMB updates, scholarship alerts, new eBooks and campus news — even when offline.',
        url:   'https://big-quams-educational-hub.github.io/'
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
  // 1. Browser support check
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    _showToast('⚠️ Your browser doesn\'t support notifications. Try Chrome or Firefox.');
    return;
  }

  // 2. iOS Safari — must be installed as PWA
  const isIOS        = /iPad|iPhone|iPod/i.test(navigator.userAgent) && !window.MSStream;
  const isStandalone = window.navigator.standalone ||
                       window.matchMedia('(display-mode: standalone)').matches;
  if (isIOS && !isStandalone) {
    _showToast('📱 On iPhone: Add this site to your Home Screen first, then enable notifications.');
    return;
  }

  // 3. Already granted
  if (Notification.permission === 'granted') {
    updateNotifUI(true);
    _showToast('✅ Notifications are already enabled!');
    return;
  }

  // 4. Blocked
  if (Notification.permission === 'denied') {
    _showToast('❌ Notifications blocked. Go to browser Settings → Site Settings → Notifications → Allow.');
    return;
  }

  // 5. Request permission
  _showToast('');  // clear any previous toast
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

  // 6. Register service worker
  let reg;
  try {
    reg = await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
  } catch (e) {
    console.warn('[BQM FCM] SW registration failed:', e.message);
  }

  // 7. Get FCM token
  try {
    const token = await getToken(messaging, {
      vapidKey:            VAPID_KEY,
      serviceWorkerRegistration: reg,
    });

    if (token) {
      // Save to localStorage (quick checks) and Firestore (server reference)
      localStorage.setItem(LS_NOTIF_TOKEN, token);
      await saveTokenToFirestore(token);

      // Subscribe token to 'bqm-all' topic so admin can broadcast to everyone
      await subscribeToTopic(token);

      updateNotifUI(true);
      _showToast('✅ Notifications enabled! You\'ll receive updates even when offline.');
      setTimeout(sendWelcomeNotification, 800);
    } else {
      _showToast('⚠️ Could not get notification token. Please try again.');
    }
  } catch (e) {
    console.warn('[BQM FCM] getToken failed:', e.message);
    // Still mark as enabled if permission was granted (token may come later)
    updateNotifUI(true);
    _showToast('✅ Notifications enabled!');
    setTimeout(sendWelcomeNotification, 800);
  }
}

// ─────────────────────────────────────────────
// FOREGROUND MESSAGE HANDLER
// (when user has the site open — show in-page toast)
// ─────────────────────────────────────────────
onMessage(messaging, payload => {
  const data  = payload.data || {};
  const notif = payload.notification || {};
  const title = data.title || notif.title || 'Big Quams Media®';
  const body  = data.body  || notif.body  || 'New update available!';
  const url   = data.url   || '/';

  // Show in-page toast with click-to-navigate
  _showToastWithLink(`🔔 ${title}: ${body}`, url);
});

// ─────────────────────────────────────────────
// DISMISS NOTIFICATION BAR
// ─────────────────────────────────────────────
function dismissNotifBar() {
  const bar = document.getElementById('notifBar');
  if (bar) bar.classList.remove('show');
  sessionStorage.setItem(SS_BAR_DISMISSED, '1');
}

// ─────────────────────────────────────────────
// AUTO-INIT: show bar after 5s if not dismissed
// ─────────────────────────────────────────────
(function autoInit() {
  // If already enabled, update UI immediately
  if (localStorage.getItem(LS_NOTIF_ENABLED) === '1' ||
      Notification.permission === 'granted') {
    updateNotifUI(true);
    return;
  }

  // Show notification bar after 5 seconds (if not dismissed this session)
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
  // Use page's own showToast if available, otherwise create one
  if (typeof window.showToast === 'function') {
    window.showToast(msg);
    return;
  }
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:9999;';
    document.body.appendChild(container);
  }
  const t = document.createElement('div');
  t.style.cssText = 'background:#102880;color:white;padding:12px 20px;border-radius:8px;margin-top:8px;font-weight:600;font-size:0.9rem;box-shadow:0 4px 12px rgba(0,0,0,0.2);opacity:0;transform:translateY(12px);transition:0.35s ease;white-space:nowrap;font-family:Roboto,sans-serif;';
  t.textContent = msg;
  container.appendChild(t);
  setTimeout(() => { t.style.opacity = '1'; t.style.transform = 'translateY(0)'; }, 50);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 400); }, 3500);
}

function _showToastWithLink(msg, url) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:9999;';
    document.body.appendChild(container);
  }
  const t = document.createElement('div');
  t.style.cssText = 'background:#102880;color:white;padding:12px 20px;border-radius:8px;margin-top:8px;font-weight:600;font-size:0.88rem;box-shadow:0 4px 12px rgba(0,0,0,0.2);opacity:0;transform:translateY(12px);transition:0.35s ease;cursor:pointer;max-width:320px;text-align:center;font-family:Roboto,sans-serif;';
  t.textContent = msg;
  t.onclick = () => { window.location.href = url; };
  container.appendChild(t);
  setTimeout(() => { t.style.opacity = '1'; t.style.transform = 'translateY(0)'; }, 50);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 400); }, 5000);
}

// ─────────────────────────────────────────────
// EXPOSE TO WINDOW (for onclick= handlers in HTML)
// ─────────────────────────────────────────────
window.BQM_enableNotifications = enableNotifications;
window.BQM_dismissNotifBar     = dismissNotifBar;

// Also keep old names working (backward compat with existing HTML buttons)
window.enableNotifications = enableNotifications;
window.dismissNotifBar     = dismissNotifBar;
