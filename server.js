// BIG QUAMS MEDIA® — FCM Push Notification Server
// Deploy on Render.com (free plan)
// This server receives requests from your admin/CEO dashboard
// and sends push notifications to all subscribed devices via FCM
// — even when their browser is closed.

const https = require('https');
const http  = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

// ── SERVICE ACCOUNT ──
const SERVICE_ACCOUNT = {
  project_id:   'big-quams-media',
  client_email: 'firebase-adminsdk-fbsvc@big-quams-media.iam.gserviceaccount.com',
  private_key:  process.env.FCM_PRIVATE_KEY.replace(/\\n/g, '\n'),
};

const FCM_ENDPOINT = `https://fcm.googleapis.com/v1/projects/${SERVICE_ACCOUNT.project_id}/messages:send`;

// ── ALLOWED ORIGINS ──
const ALLOWED_ORIGINS = [
  'https://bigquamsmedia.com.ng',
  'https://www.bigquamsmedia.com.ng',
  'https://big-quams-educational-hub.github.io',
];

// ══ SERVER ══
const server = http.createServer(async (req, res) => {
  const origin = req.headers['origin'] || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'BQM FCM Server is running ✅' }));
    return;
  }

  if (req.method !== 'POST' || req.url !== '/send') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // Parse body
  let body = '';
  req.on('data', chunk => { body += chunk.toString(); });
  req.on('end', async () => {
    try {
      const { title, message, link, icon, tokens } = JSON.parse(body);

      if (!title || !message) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'title and message are required' }));
        return;
      }

      if (!tokens || !tokens.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No tokens provided' }));
        return;
      }

      const accessToken = await getAccessToken();
      const results     = await sendToAll(accessToken, tokens, { title, message, link, icon });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ...results }));

    } catch (e) {
      console.error('Send error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`BQM FCM Server running on port ${PORT}`);
});

// ══ SEND TO ALL TOKENS ══
async function sendToAll(accessToken, tokens, payload) {
  const { title, message, link, icon } = payload;
  const notifIcon = icon || 'https://bigquamsmedia.com.ng/file_000000000370724698997662ddbee6b5.png';
  const notifLink = link || 'https://bigquamsmedia.com.ng/';

  let sent = 0, failed = 0, invalidTokens = [];

  // Send in chunks of 100 concurrently
  const CHUNK = 100;
  for (let i = 0; i < tokens.length; i += CHUNK) {
    const chunk = tokens.slice(i, i + CHUNK);
    const results = await Promise.allSettled(
      chunk.map(token => sendOne(accessToken, token, { title, message: message, notifIcon, notifLink }))
    );
    results.forEach((r, idx) => {
      if (r.status === 'fulfilled') {
        sent++;
      } else {
        failed++;
        if (r.reason?.includes('UNREGISTERED') || r.reason?.includes('NOT_FOUND')) {
          invalidTokens.push(chunk[idx]);
        }
      }
    });
  }

  return { sent, failed, total: tokens.length, invalidTokens };
}

function sendOne(accessToken, token, { title, message, notifIcon, notifLink }) {
  return new Promise((resolve, reject) => {
    // Data-only message — no top-level "notification" object.
    // This ensures FCM always delivers to onBackgroundMessage in the SW
    // instead of auto-displaying at the OS level (which bypasses the SW entirely).
    // Field names match what sw.js reads: data.title, data.body, data.icon, data.url
    const body = JSON.stringify({
      message: {
        token,
        data: {
          title:  title,
          body:   message,
          icon:   notifIcon,
          url:    notifLink,
          tag:    'bqm-broadcast',
        },
        webpush: {
          headers: { Urgency: 'high' },
          fcm_options: { link: notifLink },
        },
      },
    });

    const options = {
      hostname: 'fcm.googleapis.com',
      path:     `/v1/projects/${SERVICE_ACCOUNT.project_id}/messages:send`,
      method:   'POST',
      headers:  {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(data);
        }
      });
    });

    req.on('error', e => reject(e.message));
    req.write(body);
    req.end();
  });
}

// ══ JWT / ACCESS TOKEN ══
async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);

  const header  = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss:  SERVICE_ACCOUNT.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud:  'https://oauth2.googleapis.com/token',
    iat:  now,
    exp:  now + 3600,
  }));

  const unsigned  = `${header}.${payload}`;
  const sign      = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  const signature = base64url(sign.sign(SERVICE_ACCOUNT.private_key));
  const jwt       = `${unsigned}.${signature}`;

  return new Promise((resolve, reject) => {
    const postData = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    const options  = {
      hostname: 'oauth2.googleapis.com',
      path:     '/token',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.access_token) resolve(parsed.access_token);
          else reject(new Error('No access token: ' + data));
        } catch (e) {
          reject(new Error('Token parse error: ' + data));
        }
      });
    });

    req.on('error', e => reject(e));
    req.write(postData);
    req.end();
  });
}

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
