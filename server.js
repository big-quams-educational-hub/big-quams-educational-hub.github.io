// BIG QUAMS MEDIA® — FCM Push Notification + AI Chat Server
// Deploy on Render.com (free plan)

const https  = require('https');
const http   = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

// ── SERVICE ACCOUNT (for FCM) ──
const SERVICE_ACCOUNT = {
  project_id:   'big-quams-media',
  client_email: 'firebase-adminsdk-fbsvc@big-quams-media.iam.gserviceaccount.com',
  private_key:  process.env.FCM_PRIVATE_KEY.replace(/\\n/g, '\n'),
};

// ── ANTHROPIC API KEY (for Study Buddy) ──
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY; // Add this env var in Render dashboard

const FCM_ENDPOINT = `https://fcm.googleapis.com/v1/projects/${SERVICE_ACCOUNT.project_id}/messages:send`;

const ALLOWED_ORIGINS = [
  'https://bigquamsmedia.com.ng',
  'https://www.bigquamsmedia.com.ng',
  'https://big-quams-educational-hub.github.io',
];

// ── SYSTEM PROMPT FOR STUDY BUDDY ──
const STUDY_BUDDY_SYSTEM = `You are the Big Quams Study Buddy — an expert AI tutor built into Big Quams Media®, Nigeria's leading student success platform. Your sole purpose is helping Nigerian secondary school and university students succeed academically.

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
- University life, hostel tips, campus advice in Nigeria

Rules:
- Always respond in clear, friendly, encouraging Nigerian student-friendly language
- Keep answers concise but complete — use bullet points for lists
- If a question is outside your scope (politics, adult content, violence), politely redirect to academic topics
- Never make up specific cutoff marks — say "cutoff marks vary by year, check the official school website or Big Quams Media® for the latest"
- Always end answers with one follow-up tip or question to keep the student engaged
- Refer to this platform as "Big Quams Media®" — never abbreviate`;

// ══ SERVER ══
const server = http.createServer(async (req, res) => {
  const origin = req.headers['origin'] || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Health check
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'Big Quams Media® Server is running ✅', routes: ['/send', '/chat'] }));
    return;
  }

  // Parse body for POST requests
  let body = '';
  if (req.method === 'POST') {
    await new Promise(resolve => {
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', resolve);
    });
  }

  // ══ ROUTE: /send — FCM Push Notifications ══
  if (req.method === 'POST' && req.url === '/send') {
    try {
      const { title, message, link, icon, tokens } = JSON.parse(body);
      if (!title || !message) { res.writeHead(400); res.end(JSON.stringify({ error: 'title and message are required' })); return; }
      if (!tokens || !tokens.length) { res.writeHead(400); res.end(JSON.stringify({ error: 'No tokens provided' })); return; }
      const accessToken = await getAccessToken();
      const results = await sendToAll(accessToken, tokens, { title, message, link, icon });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ...results }));
    } catch (e) {
      console.error('FCM error:', e.message);
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ══ ROUTE: /chat — AI Study Buddy ══
  if (req.method === 'POST' && req.url === '/chat') {
    if (!ANTHROPIC_KEY) {
      res.writeHead(503); res.end(JSON.stringify({ error: 'AI service not configured. Add ANTHROPIC_API_KEY to Render environment variables.' }));
      return;
    }
    try {
      const { messages } = JSON.parse(body);
      if (!messages || !Array.isArray(messages) || !messages.length) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'messages array is required' })); return;
      }
      // Keep last 12 messages for context
      const context = messages.slice(-12);
      const anthropicBody = JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: STUDY_BUDDY_SYSTEM,
        messages: context
      });
      const reply = await callAnthropic(anthropicBody);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: reply }));
    } catch (e) {
      console.error('Chat error:', e.message);
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => console.log(`Big Quams Media® Server running on port ${PORT}`));

// ══ ANTHROPIC API CALL ══
function callAnthropic(body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.content && parsed.content[0]) resolve(parsed.content[0].text);
          else reject(new Error(parsed.error?.message || 'No content in response'));
        } catch (e) { reject(new Error('Parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', e => reject(e));
    req.write(body);
    req.end();
  });
}

// ══ FCM FUNCTIONS ══
async function sendToAll(accessToken, tokens, payload) {
  const { title, message, link, icon } = payload;
  const notifIcon = icon || 'https://bigquamsmedia.com.ng/logo.png';
  const notifLink = link || 'https://bigquamsmedia.com.ng/';
  let sent = 0, failed = 0, invalidTokens = [];
  const CHUNK = 100;
  for (let i = 0; i < tokens.length; i += CHUNK) {
    const chunk = tokens.slice(i, i + CHUNK);
    const results = await Promise.allSettled(
      chunk.map(token => sendOne(accessToken, token, { title, message, notifIcon, notifLink }))
    );
    results.forEach((r, idx) => {
      if (r.status === 'fulfilled') { sent++; }
      else { failed++; if (r.reason?.includes?.('UNREGISTERED') || r.reason?.includes?.('NOT_FOUND')) invalidTokens.push(chunk[idx]); }
    });
  }
  return { sent, failed, total: tokens.length, invalidTokens };
}

function sendOne(accessToken, token, { title, message, notifIcon, notifLink }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      message: {
        token,
        data: { title, body: message, icon: notifIcon, url: notifLink, tag: 'bqm-broadcast' },
        webpush: { headers: { Urgency: 'high' }, fcm_options: { link: notifLink } },
      },
    });
    const options = {
      hostname: 'fcm.googleapis.com',
      path: `/v1/projects/${SERVICE_ACCOUNT.project_id}/messages:send`,
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => { res.statusCode === 200 ? resolve(data) : reject(data); });
    });
    req.on('error', e => reject(e.message));
    req.write(body); req.end();
  });
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header  = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iss: SERVICE_ACCOUNT.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const unsigned = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  const signature = base64url(sign.sign(SERVICE_ACCOUNT.private_key));
  const jwt = `${unsigned}.${signature}`;
  return new Promise((resolve, reject) => {
    const postData = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    const options = { hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) } };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => { try { const p = JSON.parse(data); p.access_token ? resolve(p.access_token) : reject(new Error('No token: ' + data)); } catch (e) { reject(e); } });
    });
    req.on('error', e => reject(e));
    req.write(postData); req.end();
  });
}

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
