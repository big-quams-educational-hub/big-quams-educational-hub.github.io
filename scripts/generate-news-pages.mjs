#!/usr/bin/env node
/**
 * generate-news-pages.mjs
 * ------------------------------------------------------------------------
 * WHY THIS EXISTS
 * WhatsApp, Facebook, X, Telegram, etc. read link-preview metadata (og:*,
 * twitter:*) from the RAW HTML of a URL. They do not execute JavaScript.
 * newsroom.html is a client-side app — it fetches article data from
 * Firestore and updates <meta> tags with JS AFTER the page loads. Crawlers
 * never see that update, so every shared newsroom.html link previously
 * showed the same generic site-wide preview, no matter which article.
 *
 * This script fixes that at BUILD TIME: it reads every article from the
 * public `fs_news` Firestore collection and writes a small, real,
 * server-delivered HTML file per article — with the article's own
 * headline/excerpt/image already baked into the <head> — at:
 *
 *     /news/<slug>--<id>/index.html
 *
 * A crawler hitting that URL sees the correct preview instantly. A human
 * visitor is redirected via a JS-only `location.replace()` straight into
 * the normal interactive newsroom.html SPA, landing on the same article via
 * its existing hash-routing (#slug--id). This is deliberately JS-only, NOT
 * a <meta http-equiv="refresh"> — Facebook's crawler follows refresh
 * redirects even though it doesn't run JS, which would make it bounce
 * through to newsroom.html and steal ITS generic Open Graph tags instead
 * of this article's. Real browsers all run JS, so this is sufficient; a
 * visible "tap here" link is the only fallback needed for no-JS visitors.
 *
 * No Firebase credentials are needed — `fs_news` and `fs_config` are
 * public-read in firestore.rules, so this hits the public REST API
 * directly. (The firebase SDK + apiKey approach some other draft used is
 * unnecessary and was in fact broken — a truncated/fake apiKey — since
 * public-read collections don't need auth at all.)
 *
 * Run manually:    node scripts/generate-news-pages.mjs
 * Run in CI:        see .github/workflows/generate-news-pages.yml
 * ------------------------------------------------------------------------
 */

import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';

const PROJECT_ID = 'big-quams-media';
const SITE_ORIGIN = 'https://bigquamsmedia.com.ng';

// Firebase Web API key — this is the same PUBLIC client key newsroom.html
// itself ships in browser JS (Firebase's own docs are explicit that this
// key is not a secret; access control is entirely down to Firestore
// security rules, which already make fs_news/fs_config public-read).
// Attaching it moves these REST reads off the shared anonymous-IP quota
// bucket — which is what GitHub Actions runners were hitting (HTTP 429 /
// RESOURCE_EXHAUSTED, since runner IPs are shared across many unrelated
// workflows worldwide) — onto this project's own, much higher quota.
// Stored as a repo secret (FIREBASE_API_KEY) purely for easy rotation, not
// because it needs to be hidden.
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || '';
if (!FIREBASE_API_KEY) {
  console.warn('FIREBASE_API_KEY is not set — Firestore reads will use the shared anonymous quota and may hit 429s.');
}

// Small delay between paginated Firestore pages. The 429s seen in CI came
// from a burst of rapid, unauthenticated requests; a key alone raises the
// ceiling but a short gap between pages avoids tripping any short-window
// burst limit on top of that.
const PAGE_FETCH_DELAY_MS = 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUTPUT_DIR = 'news';
// Keep this fallback chain identical to resolvePreviewImage() in
// newsroom.html — this script is the authoritative one (crawlers only ever
// see this output), the client-side copy is a secondary/UI-tab convenience.
const GLOBAL_NEWS_DEFAULT_IMAGE = `${SITE_ORIGIN}/newsroom-default.png`;
const SITE_DEFAULT_IMAGE = `${SITE_ORIGIN}/bigquamsmedia.png`;

// ---------------------------------------------------------------------
// Facebook auto-posting (optional, multi-destination)
//
// Both Pages sit under the same Business/System User, so there is exactly
// ONE token (FB_PAGE_ACCESS_TOKEN) shared across every Page ID. Page IDs
// are given as a comma-separated FB_PAGE_ID secret (e.g.
// "1170305112838317,109930298011435"), OR as separate FB_PAGE_ID /
// FB_PAGE_ID_2 secrets — both forms are accepted so you don't have to
// re-key whichever one you already set. Whitespace around IDs is trimmed
// (the "no space is the GitHub-secrets standard, but either works" note
// from earlier still holds). Entirely opt-in: if no Page ID is configured
// at all, FB_ENABLED is false and page generation runs exactly the same.
// ---------------------------------------------------------------------
function buildFbDestinations() {
  const token = process.env.FB_PAGE_ACCESS_TOKEN || '';
  const ids = new Set();
  for (const id of (process.env.FB_PAGE_ID || '').split(',')) {
    const trimmed = id.trim();
    if (trimmed) ids.add(trimmed);
  }
  const id2 = (process.env.FB_PAGE_ID_2 || '').trim();
  if (id2) ids.add(id2);
  if (!token) return [];
  return [...ids].map((id) => ({ id, token }));
}
const FB_DESTINATIONS = buildFbDestinations();
const FB_ENABLED = FB_DESTINATIONS.length > 0;
const FB_POSTED_LOG = 'fb-posted-articles.json';
const FB_API_VERSION = 'v21.0';

// ---------------------------------------------------------------------
// Small helpers (deliberately dependency-free — one file, `node` and go)
// ---------------------------------------------------------------------

function makeSlug(title) {
  return (title || 'untitled')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80) || 'untitled';
}

// Mirrors plainPreview()/preprocessPastedHtml() in newsroom.html closely
// enough for a clean plain-text excerpt (strips WhatsApp-style markdown and
// any raw HTML that slipped into the body).
function plainPreview(text) {
  return (text || '')
    .replace(/<a\s+[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_~`]/g, '')
    .replace(/^#{2,3}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-•]\s+/gm, '')
    .replace(/^\d+[.)]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Standard news-site practice for an auto-generated meta description: use
// the article's lead sentence (journalists write it to stand alone as a
// summary) rather than an arbitrary character slice, which can chop off
// mid-word/mid-sentence and look broken in a link preview. Falls back to a
// word-boundary trim only if no usable sentence break is found.
function firstSentenceExcerpt(text, hardCap = 320) {
  const clean = plainPreview(text);
  if (!clean) return '';
  const m = /[.!?](?:\s|$)/.exec(clean);
  if (m) {
    const end = m.index + 1;
    if (end >= 20 && end <= hardCap) return clean.slice(0, end).trim();
  }
  if (clean.length <= hardCap) return clean;
  const truncated = clean.slice(0, hardCap);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 40 ? truncated.slice(0, lastSpace) : truncated).trim();
}

// ---------------------------------------------------------------------
// Base64 image materialization
//
// Every image in the admin panel (Featured Image, Link Preview Image,
// category defaults) is stored as an inline base64 data: URI in Firestore
// — fine for a normal <img> tag in a browser, but WhatsApp/Facebook/X
// crawlers treat og:image strictly as a URL they fetch themselves; a
// data: URI isn't fetchable and gets silently ignored (Facebook's own
// Sharing Debugger reports this as "og:image not yet available"). So any
// base64 image gets decoded here and written out as a real file next to
// the generated page, and og:image/twitter:image point at THAT file's
// real https:// URL instead of the raw base64 string.
// ---------------------------------------------------------------------

const DATA_URI_RE = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s;
const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

async function materializeImage(src, outDir) {
  if (!src) return null;
  const match = DATA_URI_RE.exec(src);
  if (!match) return src; // already a normal fetchable URL — use as-is
  const [, mime, b64] = match;
  const ext = MIME_EXT[mime.toLowerCase()] || 'jpg';
  let buffer;
  try {
    buffer = Buffer.from(b64, 'base64');
  } catch {
    return null; // malformed base64 — fall through to the next fallback tier
  }
  const filename = `preview.${ext}`;
  await writeFile(path.join(outDir, filename), buffer);
  return filename; // caller resolves this against the page's own public URL
}

// ---------------------------------------------------------------------
// Minimal Firestore REST decoder — only the value types this app uses
// ---------------------------------------------------------------------

function decodeValue(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  return null;
}

function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = decodeValue(v);
  return out;
}

// Retries transient failures (429 rate-limits, 5xx server errors, and
// network hiccups) with exponential backoff + jitter. GitHub Actions'
// shared runner IPs sometimes get rate-limited by Google's APIs even under
// very light real usage.
async function fetchWithRetry(url, { retries = 5, baseDelayMs = 1000, ...fetchInit } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, fetchInit);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}: ${await res.text()}`);
        throw lastErr;
      }
      return res; // includes 2xx, 404, and other non-retryable statuses
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      const delay = baseDelayMs * 2 ** attempt + Math.random() * 500;
      console.warn(`  Request failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${Math.round(delay)}ms: ${err.message}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// Fetches EVERY document in the collection (paginated via nextPageToken) —
// deliberately unbounded. Capping this at N "latest" articles (as one
// draft of this script did with limit(30)) silently stops generating pages
// for anything older than the cap, forever, no matter how many times the
// workflow runs. Firestore REST reads on a public-read collection are
// cheap; there's no quota reason to cap this.
async function fetchCollection(name) {
  const base = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${name}?pageSize=300${FIREBASE_API_KEY ? `&key=${encodeURIComponent(FIREBASE_API_KEY)}` : ''}`;
  const docs = [];
  let pageToken = '';
  let firstPage = true;
  do {
    if (!firstPage) await sleep(PAGE_FETCH_DELAY_MS);
    firstPage = false;
    const url = pageToken ? `${base}&pageToken=${pageToken}` : base;
    const res = await fetchWithRetry(url);
    if (!res.ok) {
      throw new Error(`Firestore fetch failed for ${name}: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    for (const d of data.documents || []) {
      const id = d.name.split('/').pop();
      docs.push({ _id: id, ...decodeFields(d.fields || {}) });
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return docs;
}

async function fetchDoc(name, id) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${name}/${id}${FIREBASE_API_KEY ? `?key=${encodeURIComponent(FIREBASE_API_KEY)}` : ''}`;
  const res = await fetchWithRetry(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore fetch failed for ${name}/${id}: ${res.status}`);
  const data = await res.json();
  return decodeFields(data.fields || {});
}

// ---------------------------------------------------------------------
// Fallback hierarchy for the link-preview image (must match newsroom.html)
//   1. Manually selected Link Preview Image
//   2. Featured Image, if "use featured as preview" is on (default on)
//   3. Category-specific default image
//   4. Global Newsroom default image
//   5. Main website/site default image
// ---------------------------------------------------------------------

function resolvePreviewImage(article, categoryDefaults) {
  if (article.previewImage) return article.previewImage;
  if (article.useFeaturedAsPreview !== false && article.image) return article.image;
  if (article.category && categoryDefaults[article.category]) return categoryDefaults[article.category];
  if (categoryDefaults.__global__) return categoryDefaults.__global__;
  return GLOBAL_NEWS_DEFAULT_IMAGE || SITE_DEFAULT_IMAGE;
}

// ---------------------------------------------------------------------
// Article body formatter — DIRECT PORT of formatArticleBody() /
// preprocessPastedHtml() from newsroom.html. Logic is unchanged; this is
// pure string/regex processing with no DOM dependency in the original, so
// it runs identically here in Node. Keeping this a byte-for-byte port
// (rather than writing a fresh formatter) means the static page and the
// live SPA render the exact same HTML for the exact same article body —
// if you ever update the formatting rules, update BOTH copies, or the two
// will silently drift apart.
// ---------------------------------------------------------------------

function preprocessPastedHtml(raw) {
  let t = raw.replace(/<a\s+[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, url, txt) => {
    const clean = txt.replace(/<[^>]+>/g, '').trim();
    return `[${clean || url}](${url})`;
  });
  t = t.replace(/<\/?[a-z][^>]*>/gi, '');
  return t;
}

function formatArticleBody(raw) {
  if (!raw) return '';
  raw = preprocessPastedHtml(raw);
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const isValidUrl = (u) => {
    try {
      const p = new URL(u);
      return p.protocol === 'http:' || p.protocol === 'https:';
    } catch {
      return false;
    }
  };
  const inline = (line) => {
    let t = esc(line);
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, txt, url) => (isValidUrl(url) ? `<a href="${url}" target="_blank" rel="noopener">${txt}</a>` : m));
    t = t.replace(/(https?:\/\/[^\s<>"']+)/g, (u) => (u.match(/^<a /) || !isValidUrl(u) ? u : `<a href="${u}" target="_blank" rel="noopener">${u}</a>`));
    t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    t = t.replace(/\*([^\*\n]+)\*/g, '<strong>$1</strong>');
    t = t.replace(/_([^_\n]+)_/g, '<em>$1</em>');
    t = t.replace(/~([^~\n]+)~/g, '<s>$1</s>');
    return t;
  };
  const isTableRow = (l) => /^\|.*\|$/.test(l.trim());
  const isTableSep = (l) => /^\|?[\s:|-]+\|?$/.test(l.trim()) && l.includes('-');
  const parseRow = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  let html = '', buf = [], mode = null;
  const flush = () => {
    if (!buf.length) { mode = null; return; }
    if (mode === 'ul') html += '<ul>' + buf.map((l) => `<li>${inline(l)}</li>`).join('') + '</ul>';
    else if (mode === 'ol') html += '<ol>' + buf.map((l) => `<li>${inline(l)}</li>`).join('') + '</ol>';
    else if (mode === 'bq') html += '<blockquote>' + buf.map(inline).join('<br>') + '</blockquote>';
    else html += `<p>${buf.map(inline).join('<br>')}</p>`;
    buf = []; mode = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], t = line.trim();
    if (!t) { flush(); continue; }
    if (isTableRow(t) && lines[i + 1] && isTableSep(lines[i + 1])) {
      flush();
      const header = parseRow(t);
      let j = i + 2, rows = [];
      while (j < lines.length && isTableRow(lines[j].trim())) { rows.push(parseRow(lines[j])); j++; }
      html += '<div class="art-table-wrap"><table class="art-table"><thead><tr>' +
        header.map((h) => `<th>${inline(h)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c || '')}</td>`).join('') + '</tr>').join('') +
        '</tbody></table></div>';
      i = j - 1; continue;
    }
    const heading = /^#{2,3}\s+(.*)/.exec(t);
    const bullet = /^[-•]\s+(.*)/.exec(t);
    const numbered = /^\d+[.)]\s+(.*)/.exec(t);
    const quote = /^>\s?(.*)/.exec(t);
    if (heading) { flush(); html += `<h3 class="art-h">${inline(heading[1])}</h3>`; }
    else if (bullet) { if (mode && mode !== 'ul') flush(); mode = 'ul'; buf.push(bullet[1]); }
    else if (numbered) { if (mode && mode !== 'ol') flush(); mode = 'ol'; buf.push(numbered[1]); }
    else if (quote) { if (mode && mode !== 'bq') flush(); mode = 'bq'; buf.push(quote[1]); }
    else { if (mode && mode !== 'p') flush(); mode = 'p'; buf.push(t); }
  }
  flush();
  return html;
}

function readingTime(txt) {
  return Math.max(1, Math.round((txt || '').split(/\s+/).filter(Boolean).length / 200));
}

// Shared site chrome — copied verbatim from newsroom.html so generated
// pages match the live site exactly. If the site's header/footer ever
// changes, this needs updating too (see the port comment above).
const SITE_HEADER_CSS = `
:root{--blue-deep:#0c1f6e;--blue:#1a3fa8;--blue-lt:#dde9ff;--orange:#f97316;--surface:#fff;--surface2:#f0f4ff;--border:#e2e8f4;--text:#1e2749;--muted:#64748b;--r:12px;--shadow:0 8px 28px rgba(26,63,168,.11)}
body.dark{--surface:#161b27;--surface2:#111624;--border:#2a3550;--text:#e6edf3;--muted:#8b949e}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:'Roboto',sans-serif;background:var(--surface2);color:var(--text);line-height:1.6;overflow-x:hidden}
body.dark{background:#0d1117}
a{color:inherit;text-decoration:none}
img{max-width:100%;display:block}
header{background:linear-gradient(135deg,#0c1f6e,#1a3fa8);position:sticky;top:0;z-index:300;box-shadow:0 2px 20px rgba(12,31,110,.35)}
.hbar{max-width:1200px;margin:0 auto;padding:0 16px;display:flex;align-items:center;height:60px;gap:10px}
.logo-link{display:flex;align-items:center;gap:10px;flex-shrink:0;margin-right:auto}
.logo-img{width:36px;height:36px;border-radius:50%;border:2px solid var(--orange);object-fit:cover}
.logo-name{font-family:'Montserrat',sans-serif;font-size:.8rem;font-weight:800;color:#fff;text-transform:uppercase}
.logo-sub{font-size:.52rem;color:rgba(255,255,255,.42);display:block}
.back-link{color:rgba(255,255,255,.85);font-size:.8rem;font-weight:600;padding:7px 12px;border-radius:7px;background:rgba(255,255,255,.1);white-space:nowrap}
.back-link:hover{background:rgba(255,255,255,.18)}
.art-wrap{max-width:760px;margin:0 auto;padding:20px 16px 40px}
.art-card{background:var(--surface);border-radius:var(--r);box-shadow:var(--shadow);padding:20px 18px;margin-top:4px}
.art-cat{display:inline-block;font-size:.62rem;font-weight:800;padding:3px 10px;border-radius:20px;margin-bottom:10px;background:var(--blue-lt);color:var(--blue)}
.art-title{font-family:'Montserrat',sans-serif;font-size:clamp(1.1rem,3vw,1.45rem);font-weight:800;color:var(--text);line-height:1.3;margin-bottom:10px}
.art-meta{font-size:.72rem;color:var(--muted);margin-bottom:16px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-bottom:14px;border-bottom:1px solid var(--border)}
.art-image{width:100%;border-radius:10px;margin-bottom:16px;object-fit:cover;max-height:420px}
.art-content{font-size:.95rem;color:var(--text);line-height:1.9}
.art-content p{margin:0 0 16px}
.art-content p:last-child{margin-bottom:0}
.art-content strong{font-weight:800;color:var(--text)}
.art-content em{font-style:italic}
.art-content ul,.art-content ol{margin:4px 0 16px;padding-left:22px}
.art-content li{margin-bottom:7px}
.art-content s{opacity:.6}
.art-content code{background:var(--surface2);border:1px solid var(--border);padding:1px 6px;border-radius:4px;font-family:monospace;font-size:.88em}
.art-content blockquote{margin:0 0 16px;padding:10px 18px;border-left:3px solid var(--blue);background:var(--surface2);border-radius:0 8px 8px 0;font-style:italic;color:var(--muted)}
.art-content h3.art-h{font-family:'Montserrat',sans-serif;font-size:1.05rem;font-weight:800;margin:20px 0 10px;color:var(--text)}
.art-table-wrap{overflow-x:auto;margin:0 0 16px;-webkit-overflow-scrolling:touch}
.art-table{width:100%;border-collapse:collapse;font-size:.85rem;min-width:420px}
.art-table th,.art-table td{border:1px solid var(--border);padding:8px 12px;text-align:left}
.art-table th{background:var(--surface2);font-weight:800}
.art-table tr:nth-child(even) td{background:var(--surface2)}
.art-content a{color:var(--blue);text-decoration:underline;word-break:break-word}
.open-app-cta{display:block;text-align:center;margin-top:20px;padding:13px;background:var(--orange);color:#fff;font-weight:700;border-radius:10px;font-size:.85rem}
footer{background:#0a1228;color:rgba(255,255,255,.5);padding:36px 16px 24px;margin-top:40px}
.footer-inner{max-width:1100px;margin:0 auto}
.footer-brand{display:flex;align-items:center;gap:10px;margin-bottom:20px}
.footer-brand img{width:36px;height:36px;border-radius:50%;border:2px solid #f97316}
.footer-brand-name{font-family:'Montserrat',sans-serif;font-size:.82rem;font-weight:800;color:#fff}
.footer-links{display:flex;flex-direction:column;gap:5px}
.footer-links a{font-size:.72rem;color:rgba(255,255,255,.42);transition:.18s}
.footer-links a:hover{color:#fff}
.footer-copy{font-size:.68rem;border-top:1px solid rgba(255,255,255,.08);padding-top:13px;color:rgba(255,255,255,.3)}
.footer-support{font-size:.68rem;color:rgba(255,255,255,.4);padding-top:13px;border-top:1px solid rgba(255,255,255,.08);margin-bottom:8px}
.art-byline-simple{font-size:.78rem;color:var(--muted);margin:14px 0 6px}
.art-byline-simple a{color:var(--blue);font-weight:800;text-decoration:none}
.art-byline-simple a:hover{text-decoration:underline}
.art-views{font-size:.72rem;color:var(--muted)}
.share-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:20px;padding-top:16px;border-top:1px solid var(--border)}
.share-label{font-size:.72rem;font-weight:800;color:var(--muted);margin-right:2px}
.share-btn{font-size:.72rem;font-weight:700;padding:7px 13px;border-radius:20px;border:1px solid var(--border);background:var(--surface2);color:var(--text);cursor:pointer;text-decoration:none;display:inline-block}
.share-wa:hover{background:#25D366;border-color:#25D366;color:#fff}
.share-fb:hover{background:#1877F2;border-color:#1877F2;color:#fff}
.share-x:hover{background:#000;border-color:#000;color:#fff}
.share-ig:hover{background:#E4405F;border-color:#E4405F;color:#fff}
.prevnext-nav{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:20px}
.prevnext-link{display:block;padding:12px;border:1px solid var(--border);border-radius:10px;background:var(--surface2)}
.prevnext-label{display:block;font-size:.62rem;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
.prevnext-title{display:block;font-size:.78rem;font-weight:700;color:var(--text);line-height:1.4}
.prevnext-next{text-align:right}
.author-hero{text-align:center}
.author-hero-avatar{width:80px;height:80px;border-radius:50%;object-fit:cover;margin:0 auto 12px}
.author-hero-fallback{background:var(--blue);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:1.8rem}
.author-hero-bio{font-size:.82rem;color:var(--muted);line-height:1.7;max-width:480px;margin:0 auto}
.author-article-row{display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding:10px 0;border-bottom:1px solid var(--border);font-size:.85rem}
.author-article-row:last-child{border-bottom:none}
.author-article-title{font-weight:700;color:var(--text)}
.author-article-date{color:var(--muted);font-size:.72rem;white-space:nowrap}
.authors-grid{display:flex;flex-direction:column;gap:12px}
.author-card{display:flex;align-items:center;gap:12px;padding:14px;background:var(--surface);border-radius:var(--r);box-shadow:var(--shadow)}
.author-card-avatar{width:50px;height:50px;border-radius:50%;object-fit:cover;flex-shrink:0}
.author-card-name{font-weight:800;font-size:.9rem;color:var(--text)}
.author-card-count{font-size:.72rem;color:var(--muted)}
.owner-badge{display:inline-block;margin-left:6px;font-size:.55rem;font-weight:800;padding:3px 9px;border-radius:20px;background:var(--orange);color:#fff;vertical-align:middle}
.archive-section-title{font-family:'Montserrat',sans-serif;font-size:.95rem;font-weight:800;color:var(--text);margin-bottom:10px}
.archive-grid{display:flex;flex-direction:column;gap:14px}
.archive-card{display:flex;gap:0;background:var(--surface);border-radius:var(--r);box-shadow:var(--shadow);overflow:hidden}
.archive-card-img{width:110px;height:110px;object-fit:cover;flex-shrink:0}
.archive-card-body{padding:10px 12px;flex:1;min-width:0}
.archive-card-cat{display:inline-block;font-size:.6rem;font-weight:800;padding:2px 8px;border-radius:20px;background:var(--blue-lt);color:var(--blue);margin-bottom:5px}
.archive-card-title{font-family:'Montserrat',sans-serif;font-size:.88rem;font-weight:800;color:var(--text);line-height:1.35;margin-bottom:6px}
.archive-card-meta{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:center}
.archive-card-date,.archive-card-author,.archive-card-views{font-size:.68rem;color:var(--muted)}
.archive-card-author{font-weight:700;color:var(--text)}
.archive-card-date::after,.archive-card-author::after{content:'\\00b7';margin-left:8px;color:var(--muted)}
.recent-news-list{display:flex;flex-direction:column}
.recent-news-item{display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)}
.recent-news-item:last-child{border-bottom:none}
.recent-news-thumb{width:56px;height:56px;object-fit:cover;border-radius:6px;flex-shrink:0}
.recent-news-body{flex:1;min-width:0}
.recent-news-title{font-family:'Montserrat',sans-serif;font-size:.76rem;font-weight:700;color:var(--text);line-height:1.35;margin-bottom:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.recent-news-meta{display:flex;flex-wrap:wrap;gap:0;font-size:.6rem;color:var(--muted)}
.recent-news-meta span::after{content:'\\00b7';margin:0 5px}
.recent-news-meta span:last-child::after{content:''}
.view-all-news-link{display:block;text-align:center;margin-top:14px;padding:10px;font-size:.78rem;font-weight:700;color:var(--blue);border:1px solid var(--border);border-radius:8px}
.pagination{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin:22px 0}
.page-num,.page-nav{font-size:.78rem;font-weight:700;padding:7px 12px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text)}
.page-num.active{background:var(--blue);color:#fff;border-color:var(--blue)}
.page-ellipsis{padding:7px 4px;color:var(--muted);font-size:.78rem}
`;

function renderHeader() {
  return `<header>
  <div class="hbar">
    <a class="logo-link" href="${SITE_ORIGIN}/index.html">
      <img class="logo-img" src="${SITE_ORIGIN}/logo.png" alt="Big Quams Media">
      <div><div class="logo-name">Big Quams Media\u00ae</div><span class="logo-sub">Nigeria's Trusted Student Platform</span></div>
    </a>
    <a class="back-link" href="${SITE_ORIGIN}/newsroom.html">\u2190 Newsroom</a>
  </div>
</header>`;
}

// Footer copied verbatim from newsroom.html (see the port comment above
// SITE_HEADER_CSS) — keep both in sync if the live footer ever changes.
function renderFooter() {
  return `<footer>
  <div class="footer-inner">
    <div class="footer-brand">
      <img src="${SITE_ORIGIN}/logo.png" alt="BQM">
      <div>
        <div class="footer-brand-name">Big Quams Media\u00ae</div>
        <div style="font-size:.62rem;color:rgba(255,255,255,.35);margin-top:2px">Nigeria's Trusted Student Platform</div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:20px 16px;margin-bottom:20px">
      <div>
        <div style="font-size:.62rem;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:rgba(255,255,255,.25);margin-bottom:8px">Main</div>
        <div class="footer-links" style="flex-direction:column;gap:5px">
          <a href="${SITE_ORIGIN}/index.html">\ud83c\udfe0 Home</a>
          <a href="${SITE_ORIGIN}/newsroom.html">\ud83d\udcf0 Newsroom</a>
          <a href="${SITE_ORIGIN}/explore.html">\ud83d\uddc2 Explore Tools</a>
          <a href="${SITE_ORIGIN}/campus-life.html">\ud83c\udfae Campus Life</a>
          <a href="${SITE_ORIGIN}/community.html">\ud83e\udd1d Community</a>
          <a href="${SITE_ORIGIN}/profile.html">\ud83d\udc64 My Profile</a>
          <a href="${SITE_ORIGIN}/daily.html">\ud83d\udcc5 Daily Hub</a>
        </div>
      </div>
      <div>
        <div style="font-size:.62rem;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:rgba(255,255,255,.25);margin-bottom:8px">Exam Tools</div>
        <div class="footer-links" style="flex-direction:column;gap:5px">
          <a href="${SITE_ORIGIN}/cbt.html">\ud83d\udc68\ud83c\udffd\u200d\ud83d\udcbb JAMB CBT Practice</a>
          <a href="${SITE_ORIGIN}/postutme-prep.html">\ud83d\udcd6 Post-UTME Prep</a>
          <a href="${SITE_ORIGIN}/postutme-calculator.html">\ud83e\uddee Aggregate Calc</a>
          <a href="${SITE_ORIGIN}/gpa-calculator.html">\ud83c\udf93 GPA Calculator</a>
          <a href="${SITE_ORIGIN}/results.html">\ud83d\udcca Results Checker</a>
          <a href="${SITE_ORIGIN}/Jamb_Profile_Code.html">\ud83d\udd11 JAMB Profile Code</a>
        </div>
      </div>
      <div>
        <div style="font-size:.62rem;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:rgba(255,255,255,.25);margin-bottom:8px">Resources</div>
        <div class="footer-links" style="flex-direction:column;gap:5px">
          <a href="${SITE_ORIGIN}/elibrary.html">\ud83d\udcda eLibrary</a>
          <a href="${SITE_ORIGIN}/scholarship.html">\ud83d\udcb0 Scholarships</a>
          <a href="${SITE_ORIGIN}/student-loan.html">\ud83d\udcb3 Student Loan</a>
          <a href="${SITE_ORIGIN}/spotlight.html">\ud83c\udf1f Student Spotlight</a>
          <a href="${SITE_ORIGIN}/dyk.html">\ud83d\udca1 Did You Know</a>
          <a href="${SITE_ORIGIN}/subject-combo.html">\ud83d\udccb Subject Combo</a>
        </div>
      </div>
      <div>
        <div style="font-size:.62rem;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:rgba(255,255,255,.25);margin-bottom:8px">Connect</div>
        <div class="footer-links" style="flex-direction:column;gap:5px">
          <a href="https://wa.me/2349049871643?text=Hi%20Big%20Quams%20Media!%20I%20have%20a%20question." target="_blank" rel="noopener">\ud83d\udcac WhatsApp Us</a>
          <a href="https://chat.whatsapp.com/FDtwbP0d4Z87e8o8lTW0UO" target="_blank" rel="noopener">\ud83d\udc65 Join Group</a>
          <a href="https://instagram.com/bigquamsmedia" target="_blank" rel="noopener">\ud83d\udcf8 Instagram</a>
          <a href="https://tiktok.com/@bigquamsmedia" target="_blank" rel="noopener">\ud83c\udfb5 TikTok</a>
          <a href="${SITE_ORIGIN}/index.html#install-app">\ud83d\udcf2 Install App</a>
        </div>
      </div>
    </div>
    <div class="footer-support"><strong>Big Quams Media</strong> +2349049871643 \u00b7 <strong>Big Quams Campus Support</strong> +2348069821664</div>
    <div class="footer-copy">\u00a9 ${new Date().getFullYear()} Big Quams Media\u00ae \u00b7 All rights reserved \u00b7 Created by <a href="https://bigquams.vercel.app/#home" target="_blank" rel="noopener noreferrer" style="color:rgba(255,255,255,.5);font-weight:700">Abdulrasaq Quwamdeen</a>.</div>
  </div>
</footer>`;
}

// Author byline — rendered fully server-side (unlike the SPA, which
// fetches the author profile async after the page is already showing),
// since a static page benefits from the complete author info being in the
// raw HTML for both crawlers and no-JS visitors.
function renderByline(authorName, authorPageUrl, isOwner) {
  if (!authorName) return '';
  // Owner-authored pieces show the brand name instead of the individual's
  // personal name — still clickable through to that person's own author
  // page, just displayed as "Big Quams Media" rather than their name.
  const displayName = isOwner ? 'Big Quams Media' : authorName;
  // Only clickable when we actually have a profile to link to — an author
  // name with no matching fs_author_profiles entry has nowhere real to
  // send the visitor, so it stays plain text rather than a dead link.
  // Deliberately name-only here (no avatar, no bio inline) — that content
  // now lives on the author's own page (renderAuthorPage), so it isn't
  // duplicated on every single article.
  return authorPageUrl
    ? `<div class="art-byline-simple">By <a href="${authorPageUrl}">${escapeHtml(displayName)}</a></div>`
    : `<div class="art-byline-simple">By ${escapeHtml(displayName)}</div>`;
}

// Share bar — same URL formats and share-text convention (headline + short
// excerpt + link) as shareTo()/shareText() in newsroom.html, so a share
// from either the static page or the live app looks identical. Instagram
// has no web share-intent URL for posting a link (unlike WhatsApp/
// Facebook/X) — the button copies the link instead and tells the visitor
// to paste it themselves, which is the standard workaround every site
// uses for Instagram link-sharing.
function renderShareBar(canonical, title, fullContent) {
  const excerpt = firstSentenceExcerpt(fullContent || '', 140);
  const shareText = `${title} \u2014 ${excerpt}`;
  const wa = 'https://wa.me/?text=' + encodeURIComponent(shareText + ' ' + canonical);
  const fb = 'https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(canonical);
  const x = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(shareText) + '&url=' + encodeURIComponent(canonical);
  // Data attributes + addEventListener (see the shared script at the
  // bottom of renderPage), NOT inline onclick with JSON.stringify(url):
  // JSON.stringify wraps the string in double quotes, and embedding that
  // inside an ALSO double-quoted onclick="..." attribute breaks the
  // attribute early — the rest of the JS then spills out as literal
  // visible text on the page. That's exactly what happened in production
  // (confirmed: the Copy Link / Instagram button code was showing up as
  // raw text under the Share row). escapeHtml() on a plain data-* value
  // has no such failure mode.
  return `<div class="share-bar">
    <span class="share-label">Share:</span>
    <a class="share-btn share-wa" href="${wa}" target="_blank" rel="noopener">WhatsApp</a>
    <a class="share-btn share-fb" href="${fb}" target="_blank" rel="noopener">Facebook</a>
    <a class="share-btn share-x" href="${x}" target="_blank" rel="noopener">X</a>
    <button type="button" class="share-btn js-copy-link" data-url="${escapeHtml(canonical)}">Copy Link</button>
    <button type="button" class="share-btn js-copy-ig" data-url="${escapeHtml(canonical)}">Instagram</button>
  </div>`;
}

function renderPrevNext(prevArticle, nextArticle) {
  if (!prevArticle && !nextArticle) return '';
  const side = (article, label, dir) => {
    if (!article) return '<div></div>';
    const slug = article.slug || makeSlug(article.title || '');
    const seg = `${slug}--${article._id}`;
    const href = `${SITE_ORIGIN}/${OUTPUT_DIR}/${seg}/`;
    return `<a class="prevnext-link prevnext-${dir}" href="${href}">
      <span class="prevnext-label">${label}</span>
      <span class="prevnext-title">${escapeHtml(article.title || '')}</span>
    </a>`;
  };
  return `<nav class="prevnext-nav">
    ${side(prevArticle, '\u2190 Previous', 'prev')}
    ${side(nextArticle, 'Next \u2192', 'next')}
  </nav>`;
}


// Individual author page — bio, photo, and every article by them. This is
// what the byline's author name now links to. Built from whatever's in
// fs_author_profiles; there's no separate "owner" vs "author" distinction
// in the data as far as this script can see, so every profile in that
// collection gets a page here (site owners included, if they're profiled
// the same way — confirm this matches your intent, since a genuinely
// separate "team/owners" page would need its own distinct data source).
function renderAuthorPage(profile, authorArticles) {
  const name = escapeHtml(profile.nickname || 'Author');
  const bio = profile.bio ? escapeHtml(profile.bio) : '';
  const isOwner = profile.role === 'owner';
  const ownerBadge = isOwner ? '<span class="owner-badge">Owner</span>' : '';
  const avatar = profile.photo
    ? `<img src="${escapeHtml(profile.photo)}" alt="${name}" class="author-hero-avatar">`
    : `<div class="author-hero-avatar author-hero-fallback">${escapeHtml((profile.nickname || 'A').charAt(0).toUpperCase())}</div>`;
  const articlesHtml = authorArticles.map((a) => {
    const slug = a.slug || makeSlug(a.title || '');
    const seg = `${slug}--${a._id}`;
    const href = `${SITE_ORIGIN}/${OUTPUT_DIR}/${seg}/`;
    const dateLabel = typeof a.createdAt === 'string'
      ? new Date(a.createdAt).toLocaleDateString('en-NG', { year: 'numeric', month: 'long', day: 'numeric' })
      : '';
    return `<a class="author-article-row" href="${href}">
      <span class="author-article-title">${escapeHtml(a.title || '')}</span>
      ${dateLabel ? `<span class="author-article-date">${dateLabel}</span>` : ''}
    </a>`;
  }).join('');
  const title = escapeHtml(`${profile.nickname || 'Author'} \u2014 Big Quams Media\u00ae`);
  const desc = escapeHtml(bio ? bio.slice(0, 160) : `Articles by ${profile.nickname || 'this author'} on Big Quams Media\u00ae.`);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<meta name="description" content="${desc}">
<script async src="https://www.googletagmanager.com/gtag/js?id=G-RCLYVCZY2K"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-RCLYVCZY2K');</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@500;700;800&family=Roboto:wght@300;400;500&display=swap" rel="stylesheet">
<link rel="icon" type="image/png" href="${SITE_ORIGIN}/logo.png">
<style>${SITE_HEADER_CSS}</style>
</head>
<body>
${renderHeader()}
<div class="art-wrap">
  <div class="art-card author-hero">
    ${avatar}
    <h1 class="art-title">${name} ${ownerBadge}</h1>
    ${bio ? `<p class="author-hero-bio">${bio}</p>` : ''}
    <a class="prevnext-link" style="display:inline-block;margin-top:14px" href="${SITE_ORIGIN}/authors/">\u2190 All authors</a>
  </div>
  <div class="art-card" style="margin-top:16px">
    <h2 style="font-family:'Montserrat',sans-serif;font-size:1rem;margin-bottom:10px">Articles by ${name} (${authorArticles.length})</h2>
    ${articlesHtml || '<p style="color:var(--muted);font-size:.85rem">No articles yet.</p>'}
  </div>
</div>
${renderFooter()}
</body>
</html>
`;
}

// Hub page listing every author, linking to their individual page above.
function renderAuthorsHub(profilesWithCounts) {
  const cardHtml = (p) => {
    const slug = makeSlug(p.nickname || 'author');
    const seg = `${slug}--${p._id}`;
    const href = `${SITE_ORIGIN}/authors/${seg}/`;
    const avatar = p.photo
      ? `<img src="${escapeHtml(p.photo)}" alt="${escapeHtml(p.nickname || '')}" class="author-card-avatar">`
      : `<div class="author-card-avatar author-hero-fallback">${escapeHtml((p.nickname || 'A').charAt(0).toUpperCase())}</div>`;
    return `<a class="author-card" href="${href}">
      ${avatar}
      <div>
        <div class="author-card-name">${escapeHtml(p.nickname || 'Author')}</div>
        <div class="author-card-count">${p.articleCount} article${p.articleCount === 1 ? '' : 's'}</div>
      </div>
    </a>`;
  };
  // Owners get their own section, first — a profile is treated as an
  // owner when its Firestore doc has role: "owner" (any other value, or
  // no role field at all, is a regular author). Set this in the Firebase
  // Console on fs_author_profiles/{id} until/unless the admin panel gets
  // its own field for it.
  const owners = profilesWithCounts.filter((p) => p.role === 'owner');
  const authorsOnly = profilesWithCounts.filter((p) => p.role !== 'owner');
  const ownersSection = owners.length
    ? `<h2 class="archive-section-title">Founders &amp; Team</h2><div class="authors-grid">${owners.map(cardHtml).join('')}</div>`
    : '';
  const authorsSection = authorsOnly.length
    ? `<h2 class="archive-section-title" style="margin-top:${owners.length ? '22px' : '0'}">Authors</h2><div class="authors-grid">${authorsOnly.map(cardHtml).join('')}</div>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Our Authors \u2014 Big Quams Media\u00ae</title>
<meta name="description" content="Meet the writers and editors behind Big Quams Media\u00ae.">
<script async src="https://www.googletagmanager.com/gtag/js?id=G-RCLYVCZY2K"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-RCLYVCZY2K');</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@500;700;800&family=Roboto:wght@300;400;500&display=swap" rel="stylesheet">
<link rel="icon" type="image/png" href="${SITE_ORIGIN}/logo.png">
<style>${SITE_HEADER_CSS}</style>
</head>
<body>
${renderHeader()}
<div class="art-wrap">
  <div class="art-card">
    <h1 class="art-title">Our Authors</h1>
    <p style="color:var(--muted);font-size:.85rem;margin-top:8px">Meet the writers and editors behind Big Quams Media\u00ae.</p>
  </div>
  <div style="margin-top:12px">
    ${ownersSection}
    ${authorsSection}
    ${owners.length === 0 && authorsOnly.length === 0 ? '<p style="color:var(--muted);font-size:.85rem">No author profiles yet.</p>' : ''}
  </div>
</div>
${renderFooter()}
</body>
</html>
`;
}

// ---------------------------------------------------------------------
// "All News" archive — a paginated, WordPress-style index of every
// article, newest first: page 1 at /news/, page 2+ at /news/page/N/.
// ---------------------------------------------------------------------

const ARTICLES_PER_ARCHIVE_PAGE = 12;
const RECENT_NEWS_COUNT = 6; // the compact widget on every article page shows far fewer than a full archive page

function archivePageUrl(n) {
  return n <= 1 ? `${SITE_ORIGIN}/${OUTPUT_DIR}/` : `${SITE_ORIGIN}/${OUTPUT_DIR}/page/${n}/`;
}

function renderPagination(current, total) {
  if (total <= 1) return '';
  const items = [];
  if (current > 1) items.push(`<a class="page-nav" href="${archivePageUrl(current - 1)}">\u2190 Prev</a>`);
  let lastPrinted = 0;
  for (let n = 1; n <= total; n++) {
    // Always show first, last, and a small window around the current
    // page — with "…" for any gap — so this stays readable even once
    // there are many pages, rather than listing every single number.
    if (n === 1 || n === total || (n >= current - 1 && n <= current + 1)) {
      if (lastPrinted && n - lastPrinted > 1) items.push('<span class="page-ellipsis">\u2026</span>');
      items.push(`<a class="page-num${n === current ? ' active' : ''}" href="${archivePageUrl(n)}">${n}</a>`);
      lastPrinted = n;
    }
  }
  if (current < total) items.push(`<a class="page-nav" href="${archivePageUrl(current + 1)}">Next \u2192</a>`);
  return `<nav class="pagination">${items.join('')}</nav>`;
}

function renderArchiveCards(pageArticles, resolvedImages, authorProfiles = {}, compact = false) {
  return pageArticles.map((article) => {
    const slug = article.slug || makeSlug(article.title || '');
    const seg = `${slug}--${article._id}`;
    const href = `${SITE_ORIGIN}/${OUTPUT_DIR}/${seg}/`;
    const image = escapeHtml(resolvedImages[article._id] || GLOBAL_NEWS_DEFAULT_IMAGE || SITE_DEFAULT_IMAGE);
    const cat = escapeHtml(article.category || 'News');
    const cardTitle = escapeHtml(article.title || '');
    const dateLabel = typeof article.createdAt === 'string'
      ? new Date(article.createdAt).toLocaleDateString('en-NG', { year: 'numeric', month: 'short', day: 'numeric' })
      : '';
    const matchedProfile = article.author ? authorProfiles[article.author] : null;
    const authorDisplay = escapeHtml(
      matchedProfile && matchedProfile.role === 'owner' ? 'Big Quams Media' : (article.author || 'Big Quams Media')
    );
    const views = typeof article.views === 'number' ? article.views : 0;

    // Compact mode: a tight, thumbnail + headline + small meta-line list
    // (no card box/shadow, no category badge) — used for the "Recent
    // News" widget on every article page, which needs to stay small.
    // Regular mode (the full archive at /news/) keeps the bigger card
    // style with a category badge.
    if (compact) {
      return `<a class="recent-news-item" href="${href}">
        <img class="recent-news-thumb" src="${image}" alt="${cardTitle}">
        <div class="recent-news-body">
          <h3 class="recent-news-title">${cardTitle}</h3>
          <div class="recent-news-meta">
            ${dateLabel ? `<span>${dateLabel}</span>` : ''}
            <span>${authorDisplay}</span>
            <span>${views} view${views === 1 ? '' : 's'}</span>
          </div>
        </div>
      </a>`;
    }

    return `<a class="archive-card" href="${href}">
      <img class="archive-card-img" src="${image}" alt="${cardTitle}">
      <div class="archive-card-body">
        <span class="archive-card-cat">${cat}</span>
        <h2 class="archive-card-title">${cardTitle}</h2>
        <div class="archive-card-meta">
          ${dateLabel ? `<span class="archive-card-date">${dateLabel}</span>` : ''}
          <span class="archive-card-author">${authorDisplay}</span>
          <span class="archive-card-views">${views} view${views === 1 ? '' : 's'}</span>
        </div>
      </div>
    </a>`;
  }).join('');
}

function renderArchivePage(pageArticles, currentPage, totalPages, resolvedImages, authorProfiles) {
  const cards = renderArchiveCards(pageArticles, resolvedImages, authorProfiles);
  const canonical = archivePageUrl(currentPage);
  const pageTitle = currentPage > 1 ? `All News \u2014 Page ${currentPage} \u2014 Big Quams Media\u00ae` : `All News \u2014 Big Quams Media\u00ae`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(pageTitle)}</title>
<meta name="description" content="Browse every article on Big Quams Media\u00ae, newest first.">
<link rel="canonical" href="${canonical}">
<script async src="https://www.googletagmanager.com/gtag/js?id=G-RCLYVCZY2K"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-RCLYVCZY2K');</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@500;700;800&family=Roboto:wght@300;400;500&display=swap" rel="stylesheet">
<link rel="icon" type="image/png" href="${SITE_ORIGIN}/logo.png">
<style>${SITE_HEADER_CSS}</style>
</head>
<body>
${renderHeader()}
<div class="art-wrap">
  <div class="art-card">
    <h1 class="art-title">All News</h1>
    <p style="color:var(--muted);font-size:.85rem;margin-top:6px">Every article, newest first.${totalPages > 1 ? ` Page ${currentPage} of ${totalPages}.` : ''}</p>
  </div>
  <div class="archive-grid" style="margin-top:14px">
    ${cards || '<p style="color:var(--muted);font-size:.85rem">No articles yet.</p>'}
  </div>
  ${renderPagination(currentPage, totalPages)}
</div>
${renderFooter()}
</body>
</html>
`;
}


function renderPage(article, resolvedImage, { authorPageUrl, isOwnerAuthor, moreNewsArticles, resolvedImages, authorProfiles } = {}) {
  const slug = article.slug || makeSlug(article.title || '');
  const seg = `${slug}--${article._id}`;
  const canonical = `${SITE_ORIGIN}/${OUTPUT_DIR}/${seg}/`;
  const title = escapeHtml(`${article.seoTitle || article.title || 'News'} — Big Quams Media®`);
  const rawDesc = article.seoDesc || firstSentenceExcerpt(article.fullContent || '');
  const desc = escapeHtml(rawDesc);
  const image = escapeHtml(resolvedImage || GLOBAL_NEWS_DEFAULT_IMAGE || SITE_DEFAULT_IMAGE);
  const publishedTime = typeof article.createdAt === 'string' ? article.createdAt : '';
  const bodyHtml = formatArticleBody(article.fullContent || '');
  const mins = readingTime(article.fullContent || '');
  const category = escapeHtml(article.category || 'News');
  const headline = escapeHtml(article.title || 'News');
  const dateLabel = publishedTime
    ? new Date(publishedTime).toLocaleDateString('en-NG', { year: 'numeric', month: 'long', day: 'numeric' })
    : '';
  const viewCount = typeof article.views === 'number' ? article.views : 0;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<!-- Google tag (gtag.js) — same property as index.html/newsroom.html, so
     article-page traffic rolls into one unified view rather than a
     separate, disconnected dataset. -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-RCLYVCZY2K"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-RCLYVCZY2K');
</script>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<meta name="description" content="${desc}">
<link rel="canonical" href="${canonical}">

<meta property="og:type" content="article">
<meta property="og:site_name" content="Big Quams Media\u00ae">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:image" content="${image}">
<meta property="og:image:alt" content="${title}">
<meta property="og:url" content="${canonical}">
${publishedTime ? `<meta property="article:published_time" content="${escapeHtml(publishedTime)}">\n` : ''}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${image}">

<!-- This page now carries the FULL article body server-rendered in raw
     HTML (not just meta tags + a redirect) — that's what lets Google
     actually index the article's real text, not just a preview snippet.
     Because of that, there is deliberately NO auto-redirect into the SPA
     here anymore: a real visitor reading this page already has the
     complete, correctly-formatted article. The header above links back to
     the interactive Newsroom app for anyone who wants to browse/search
     other articles from there. -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@500;700;800&family=Roboto:wght@300;400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
<link rel="icon" type="image/png" href="${SITE_ORIGIN}/logo.png">
<style>${SITE_HEADER_CSS}</style>
</head>
<body>
${renderHeader()}
<div class="art-wrap">
  <div class="art-card">
    <span class="art-cat">${category}</span>
    <h1 class="art-title">${headline}</h1>
    <div class="art-meta">
      ${dateLabel ? `<span>${dateLabel}</span><span>\u00b7</span>` : ''}
      <span>${mins} min read</span>
      <span>\u00b7</span>
      <span class="art-views" id="viewCount">${viewCount} view${viewCount === 1 ? '' : 's'}</span>
    </div>
    ${renderByline(article.author, authorPageUrl, isOwnerAuthor)}
    ${image ? `<img class="art-image" src="${image}" alt="${headline}">` : ''}
    <div class="art-content">${bodyHtml}</div>
    ${renderShareBar(canonical, article.title || 'News', article.fullContent || '')}
    <a class="open-app-cta" href="${SITE_ORIGIN}/newsroom.html">Browse more Newsroom stories \u2192</a>
  </div>
  ${moreNewsArticles && moreNewsArticles.length ? `<div class="art-card" style="margin-top:16px">
    <h2 style="font-family:'Montserrat',sans-serif;font-size:.92rem;margin-bottom:10px">Recent News</h2>
    <div class="recent-news-list">${renderArchiveCards(moreNewsArticles, resolvedImages || {}, authorProfiles || {}, true)}</div>
    <a class="view-all-news-link" href="${SITE_ORIGIN}/${OUTPUT_DIR}/">View All News \u2192</a>
  </div>` : ''}
</div>
${renderFooter()}
<!-- View counter: increments the same fs_news/{id}.views field the live
     app's own recordView() writes to (mirrored intentionally, same
     Firestore write pattern already working there). This exists because
     the static page is now a real, standalone article — readers who
     never click through into the SPA app (i.e., most people arriving from
     a shared link or Google) were not being counted at all before this.
     Client-side write, fire-and-forget; failures are silently ignored
     since a missed view increment isn't worth showing an error for. -->
<script src="https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore-compat.js"></script>
<script>
(function(){
  try{
    if(!firebase.apps.length){
      firebase.initializeApp({apiKey:'AIzaSyCRrp0cGK-hlBy8Ez8blesCsWn3FP7I-lQ',authDomain:'big-quams-media.firebaseapp.com',projectId:'big-quams-media'});
    }
    firebase.firestore().collection('fs_news').doc(${JSON.stringify(article._id)}).update({views:firebase.firestore.FieldValue.increment(1)}).then(function(){
      // The number baked into the page at build time is only as fresh as
      // the last generation run (up to 20 minutes old) — bump it visibly
      // right away so a visitor sees their own view reflected instantly,
      // rather than the count looking frozen/wrong until the next run.
      var el=document.getElementById('viewCount');
      if(el){
        var n=parseInt((el.textContent||'0').replace(/[^0-9]/g,''),10)||0;
        n+=1;
        el.textContent=n+(n===1?' view':' views');
      }
    }).catch(function(){});
  }catch(e){}
})();
// Copy-link / Instagram share buttons. Deliberately addEventListener +
// data-url, not inline onclick with JSON.stringify(url) — that combo
// broke in production (see the comment on renderShareBar): JSON.stringify
// wraps the URL in double quotes, which prematurely closes an
// ALSO-double-quoted onclick="..." attribute, dumping the rest of the
// handler's JS onto the page as literal visible text.
document.querySelectorAll('.js-copy-link').forEach(function(btn){
  btn.addEventListener('click', function(){
    navigator.clipboard.writeText(btn.dataset.url).then(function(){
      var original=btn.textContent;
      btn.textContent='Copied!';
      setTimeout(function(){btn.textContent=original;},1500);
    });
  });
});
document.querySelectorAll('.js-copy-ig').forEach(function(btn){
  btn.addEventListener('click', function(){
    navigator.clipboard.writeText(btn.dataset.url).then(function(){
      var original=btn.textContent;
      btn.textContent='Link copied \u2014 paste in Instagram';
      setTimeout(function(){btn.textContent=original;},2500);
    });
  });
});
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------
// Facebook posting helpers (generalized for multiple destination Pages)
// ---------------------------------------------------------------------

// Tracks which article IDs have already been posted to EACH Facebook
// destination, e.g. { "<articleId>": ["1170305112838317"] }. This is a
// deliberate change from a flat "posted anywhere" Set: with two Pages, an
// article posted to Page 1 last month must still be eligible to post to
// Page 2 once Page 2 is newly configured. A flat Set (or the old {id:true}
// object) can't represent "posted to A but not yet to B". Old-format logs
// (an array of ids, meaning "posted to the Page configured at the time")
// are migrated in-place on first read.
async function loadPostedLog() {
  try {
    const raw = await readFile(FB_POSTED_LOG, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // Legacy flat format — treat as "posted to every destination that
      // was configured at the time" so we don't re-post old articles the
      // moment this script upgrades.
      const migrated = {};
      for (const id of parsed) migrated[id] = FB_DESTINATIONS.map((d) => d.id);
      return migrated;
    }
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // file doesn't exist yet — first run
  }
}

async function savePostedLog(postedMap) {
  await writeFile(FB_POSTED_LOG, JSON.stringify(postedMap, null, 2) + '\n', 'utf8');
}

// Facebook's /feed endpoint wants the Page's OWN access token to post AS
// the Page — a System User token proves WHO is making the request, but is
// related-yet-distinct from the Page token, even when the System User has
// full access to the Page. This exchanges the configured token for the
// real Page token once per run/per-destination and reuses it.
const cachedPageTokens = new Map(); // pageId -> page access token
async function derivePageAccessToken(pageId, systemUserToken) {
  if (cachedPageTokens.has(pageId)) return cachedPageTokens.get(pageId);
  const url = `https://graph.facebook.com/${FB_API_VERSION}/${pageId}?fields=access_token&access_token=${encodeURIComponent(systemUserToken)}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || !data.access_token) {
    throw new Error(data.error?.message || `Could not derive a Page Access Token for Page ${pageId}.`);
  }
  cachedPageTokens.set(pageId, data.access_token);
  return cachedPageTokens.get(pageId);
}

// Posts one article to one Facebook Page's feed. `link` is still passed
// separately (below) — Facebook's own crawler fetches it and builds the
// preview card from the static page's og:* tags, same as before. What's
// new is the message body itself: headline, then a short excerpt, then
// the link again as plain visible text ("Read more: ..."). Previously the
// message was just the bare headline and the post relied entirely on
// Facebook's auto-generated card below it for everything else — this adds
// real body text above that card, matching how most news Pages post.
async function postArticleToFacebook(article, canonicalUrl, destination) {
  const headline = article.title || 'New article on Big Quams Media\u00ae';
  const excerpt = article.excerpt ? String(article.excerpt).trim() : '';
  const message = excerpt
    ? `${headline}\n\n${excerpt}\n\nRead more: ${canonicalUrl}`
    : `${headline}\n\nRead more: ${canonicalUrl}`;
  const url = `https://graph.facebook.com/${FB_API_VERSION}/${destination.id}/feed`;

  const attemptPost = async (token) => {
    const body = new URLSearchParams({ message, link: canonicalUrl, access_token: token });
    // A direct fetch, not fetchWithRetry — that helper is built for the
    // read-only Firestore GETs above and retries on 429/5xx; blindly
    // retrying a POST that may have actually succeeded server-side risks
    // posting the same article twice, which is worse than one failed run.
    const postRes = await fetch(url, { method: 'POST', body });
    const data = await postRes.json().catch(() => ({}));
    return { ok: postRes.ok && !data.error, data, status: postRes.status };
  };

  // Try the configured token as-is first — it may already be a genuine
  // Page token in some setups. Only fall back to deriving one if that
  // specifically fails with Facebook's #200 permission error, which is
  // exactly what happens when a System User token is used directly
  // instead of the Page token derived from it.
  let result = await attemptPost(destination.token);
  if (!result.ok && result.data?.error?.code === 200) {
    const pageToken = await derivePageAccessToken(destination.id, destination.token);
    result = await attemptPost(pageToken);
  }
  if (!result.ok) {
    throw new Error(result.data.error?.message || `HTTP ${result.status}`);
  }
  return result.data.id; // Facebook post ID, e.g. "{page-id}_{post-id}"
}

// ---------------------------------------------------------------------
// Main
//
// NOTE: this function is reconstructed — the source pasted into this
// conversation was truncated exactly at `async function main() {`. Every
// function above this point is copied unchanged from the confirmed-working
// version. This function ties them together the way the rest of the file
// implies it must, plus the new multi-Page loop. Please diff this specific
// function against your actual repo copy before deploying, in case the
// real one built `categoryDefaults` differently (e.g. a different fs_config
// doc id/shape) or had additional bookkeeping (e.g. sitemap <lastmod>
// sourced from article data rather than run time).
// ---------------------------------------------------------------------

// Local-only handoff file between the two script phases (generate, then
// post-facebook) — deliberately NOT committed to git. Both phases run in
// the same GitHub Actions job on the same runner filesystem, so a plain
// file here is enough to pass "which articles still need posting" from
// one Node invocation to the next, without needing Firestore again.
const FB_PENDING_FILE = '.fb-pending.json';

// Polls a URL until it returns 200 (page is actually live) or the timeout
// elapses. This is THE fix for posts going out with a broken preview: a
// freshly generated page isn't live the instant `git push` returns — the
// static host still has to actually deploy it, which can take anywhere
// from a few seconds to a couple of minutes. Posting to Facebook before
// that finishes means its crawler hits a 404 and the post is stuck with a
// broken preview forever (re-scraping later does NOT fix an already-live
// post — confirmed in production). This check runs in the SEPARATE
// post-facebook phase, after the generate phase's `git push` has already
// happened, so "not live yet" here means genuinely still deploying, not
// "not pushed yet".
async function waitForUrlLive(url, { timeoutMs = 150000, intervalMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok) return true;
    } catch {
      // network hiccup / DNS still propagating — treat like a non-200 and keep polling
    }
    await sleep(intervalMs);
  }
  return false;
}

async function runGenerate() {
  const requestTime = new Date().toISOString();

  // Full fetch every run, deliberately — NOT incremental.
  //
  // This was previously an incremental fetch keyed on createdAt/updatedAt
  // timestamps, to avoid re-reading the whole collection every 20 minutes.
  // In production that silently skipped at least one real article forever
  // — it turned out to have NEITHER createdAt NOR updatedAt set, so no
  // timestamp filter could ever match it, regardless of which field was
  // queried. That's a data-completeness bug no query can work around.
  //
  // Reverted to a full fetch because, at this collection's actual size
  // (~26 articles), the cost difference is negligible: a full fetch every
  // 20 minutes is roughly 26 * 72 = ~1,872 Firestore reads/day, nowhere
  // near the 50,000/day Spark-plan limit. The earlier 429 quota crisis was
  // caused by something else entirely (see FIREBASE_API_KEY comment above)
  // — this script's own read volume was never the bottleneck. A full fetch
  // is simpler and CANNOT miss an article, regardless of what timestamp
  // fields it does or doesn't have.
  console.log('Fetching all articles from Firestore...');
  const articles = await fetchCollection('fs_news');
  console.log(`  ${articles.length} article(s) found.`);

  // Sort newest-first — fetchCollection has no guaranteed order (the
  // Firestore REST "list documents" endpoint doesn't sort), and prev/next
  // navigation below only makes sense against a stable, meaningful order
  // (matching the SPA's own `.orderBy('createdAt','desc')`).
  articles.sort((a, b) => {
    const ta = typeof a.createdAt === 'string' ? Date.parse(a.createdAt) : 0;
    const tb = typeof b.createdAt === 'string' ? Date.parse(b.createdAt) : 0;
    return tb - ta;
  });

  // Computed once, early — every individual article page's "More News"
  // section (below) links its pagination straight into the real archive
  // pages, so it needs to know the total page count up front rather than
  // after the archive is actually built later in this function.
  const totalArchivePages = Math.max(1, Math.ceil(articles.length / ARTICLES_PER_ARCHIVE_PAGE));

  // Category-specific default preview images, if configured in the admin
  // panel under fs_config. Missing/absent doc just means no category
  // overrides — resolvePreviewImage() already falls through cleanly.
  let categoryDefaults = {};
  try {
    const cfg = await fetchDoc('fs_config', 'newsCategoryDefaults');
    if (cfg) categoryDefaults = cfg;
  } catch (err) {
    console.warn(`  Could not load category default images (continuing without them): ${err.message}`);
  }

  // Author profiles (photo + bio), for the byline — same fs_author_profiles
  // collection newsroom.html's getAuthorProfile() reads, keyed by
  // `nickname`. Fetched once here and rendered fully server-side (the SPA
  // fetches this async, after the page already shows a plain-text byline —
  // a static page benefits from having it complete in the raw HTML for
  // crawlers and no-JS visitors alike).
  let authorProfiles = {};
  try {
    const profiles = await fetchCollection('fs_author_profiles');
    for (const p of profiles) {
      if (p.nickname) authorProfiles[p.nickname] = p;
    }
  } catch (err) {
    console.warn(`  Could not load author profiles (bylines will show name only): ${err.message}`);
  }

  await mkdir(OUTPUT_DIR, { recursive: true });

  const postedLog = FB_ENABLED ? await loadPostedLog() : {};
  const pending = [];
  const resolvedImages = {}; // articleId -> resolved image URL

  // PASS 1: create each article's directory and resolve/materialize its
  // image ONLY. Deliberately separate from rendering (pass 2, below) —
  // each article's page now embeds a "More News" grid that can reference
  // ANY other article, including ones later in this list that wouldn't
  // have been processed yet in a single combined loop. Resolving every
  // image first guarantees resolvedImages is complete before anything
  // reads from it.
  const pageDirs = {};
  for (const article of articles) {
    const slug = article.slug || makeSlug(article.title || '');
    const seg = `${slug}--${article._id}`;
    const pageDir = path.join(OUTPUT_DIR, seg);
    await mkdir(pageDir, { recursive: true });
    pageDirs[article._id] = pageDir;

    const rawImage = resolvePreviewImage(article, categoryDefaults);
    const materialized = await materializeImage(rawImage, pageDir);
    const resolvedImageUrl =
      materialized && !/^https?:\/\//i.test(materialized)
        ? `${SITE_ORIGIN}/${OUTPUT_DIR}/${seg}/${materialized}`
        : materialized || rawImage;
    resolvedImages[article._id] = resolvedImageUrl;
  }

  // PASS 2: render every page, now that resolvedImages is complete.
  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    const slug = article.slug || makeSlug(article.title || '');
    const seg = `${slug}--${article._id}`;
    const pageDir = pageDirs[article._id];

    const matchedAuthorProfile = article.author ? authorProfiles[article.author] : null;
    const authorPageUrl = matchedAuthorProfile
      ? `${SITE_ORIGIN}/authors/${makeSlug(matchedAuthorProfile.nickname || 'author')}--${matchedAuthorProfile._id}/`
      : null;
    const isOwnerAuthor = matchedAuthorProfile && matchedAuthorProfile.role === 'owner';
    const moreNewsArticles = articles.filter((a) => a._id !== article._id).slice(0, RECENT_NEWS_COUNT);
    const html = renderPage(article, resolvedImages[article._id], {
      authorPageUrl,
      isOwnerAuthor,
      moreNewsArticles,
      resolvedImages,
      authorProfiles,
    });
    await writeFile(path.join(pageDir, 'index.html'), html, 'utf8');

    const canonical = `${SITE_ORIGIN}/${OUTPUT_DIR}/${seg}/`;

    if (FB_ENABLED) {
      const alreadyPosted = postedLog[article._id] || [];
      const stillNeeded = FB_DESTINATIONS.map((d) => d.id).filter((id) => !alreadyPosted.includes(id));
      if (stillNeeded.length) {
        // NOT posted here — just recorded for the post-facebook phase to
        // pick up AFTER this run's git push has actually landed.
        pending.push({
          _id: article._id,
          title: article.title || '',
          excerpt: firstSentenceExcerpt(article.fullContent || '', 200),
          canonical,
        });
      }
    }
  }

  // Author pages — one per profile in fs_author_profiles, plus a hub page
  // listing all of them. This is what the byline's author name links to.
  const authorSitemapEntries = [];
  const authorProfileList = Object.values(authorProfiles);
  if (authorProfileList.length) {
    await mkdir('authors', { recursive: true });
    const profilesWithCounts = [];
    for (const profile of authorProfileList) {
      const authorArticles = articles.filter((a) => a.author === profile.nickname);
      const aSlug = makeSlug(profile.nickname || 'author');
      const aSeg = `${aSlug}--${profile._id}`;
      const aDir = path.join('authors', aSeg);
      await mkdir(aDir, { recursive: true });
      await writeFile(path.join(aDir, 'index.html'), renderAuthorPage(profile, authorArticles), 'utf8');
      profilesWithCounts.push({ ...profile, articleCount: authorArticles.length });
      authorSitemapEntries.push(`  <url><loc>${escapeHtml(`${SITE_ORIGIN}/authors/${aSeg}/`)}</loc></url>`);
    }
    await writeFile(path.join('authors', 'index.html'), renderAuthorsHub(profilesWithCounts), 'utf8');
    authorSitemapEntries.push(`  <url><loc>${escapeHtml(`${SITE_ORIGIN}/authors/`)}</loc></url>`);
    console.log(`  ${authorProfileList.length} author page(s) generated.`);
  }

  // "All News" paginated archive — page 1 at /news/, page 2+ at
  // /news/page/N/. Uses the same newest-first order already established
  // above, and reuses each article's already-materialized image (no
  // second round of image work needed).
  const archiveSitemapEntries = [];
  for (let p = 1; p <= totalArchivePages; p++) {
    const pageArticles = articles.slice((p - 1) * ARTICLES_PER_ARCHIVE_PAGE, p * ARTICLES_PER_ARCHIVE_PAGE);
    const html = renderArchivePage(pageArticles, p, totalArchivePages, resolvedImages, authorProfiles);
    const dir = p === 1 ? OUTPUT_DIR : path.join(OUTPUT_DIR, 'page', String(p));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'index.html'), html, 'utf8');
    archiveSitemapEntries.push(`  <url><loc>${escapeHtml(archivePageUrl(p))}</loc></url>`);
  }
  console.log(`  Archive: ${totalArchivePages} page(s) covering ${articles.length} article(s).`);

  // Sitemap built directly from this run's full article list — no
  // persisted state file needed, since every run already has the complete
  // set. This also removes a whole class of git merge conflicts: two runs
  // can no longer fight over a shared generated-state file, because there
  // isn't one anymore.
  const sitemapEntries = articles.map((article) => {
    const slug = article.slug || makeSlug(article.title || '');
    const seg = `${slug}--${article._id}`;
    const lastmod = typeof article.updatedAt === 'string' ? article.updatedAt
      : typeof article.createdAt === 'string' ? article.createdAt
      : requestTime;
    return `  <url><loc>${escapeHtml(`${SITE_ORIGIN}/${OUTPUT_DIR}/${seg}/`)}</loc><lastmod>${lastmod}</lastmod></url>`;
  });
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapEntries.join('\n')}\n${authorSitemapEntries.join('\n')}\n${archiveSitemapEntries.join('\n')}\n</urlset>\n`;
  await writeFile('sitemap-news.xml', sitemap, 'utf8');

  if (FB_ENABLED) {
    await writeFile(FB_PENDING_FILE, JSON.stringify(pending, null, 2) + '\n', 'utf8');
    console.log(`  ${pending.length} article(s) pending a Facebook post (deferred until after this run's push).`);
  }

  console.log(`Done — (re)generated ${articles.length} page(s); ${articles.length} total in sitemap.`);
}

async function runPostFacebook() {
  if (!FB_ENABLED) {
    console.log('Facebook posting not configured — nothing to do.');
    return;
  }
  let pending;
  try {
    pending = JSON.parse(await readFile(FB_PENDING_FILE, 'utf8'));
  } catch {
    console.log('No pending Facebook posts found.');
    return;
  }
  if (!pending.length) {
    console.log('Pending list is empty — nothing to post.');
    return;
  }

  const postedLog = await loadPostedLog();

  for (const { _id, title, excerpt, canonical } of pending) {
    console.log(`Checking if live yet: ${canonical}`);
    const isLive = await waitForUrlLive(canonical);
    if (!isLive) {
      console.warn(`  Still not live after waiting — skipping this run, will retry next run: ${canonical}`);
      continue; // leave un-posted in postedLog — next run's generate phase will re-queue it
    }
    const alreadyPosted = postedLog[_id] || [];
    for (const destination of FB_DESTINATIONS) {
      if (alreadyPosted.includes(destination.id)) continue;
      try {
        console.log(`  Posting "${title}" to Page ${destination.id}...`);
        const postId = await postArticleToFacebook({ title, excerpt }, canonical, destination);
        console.log(`    -> posted: ${postId}`);
        postedLog[_id] = [...(postedLog[_id] || alreadyPosted), destination.id];
      } catch (err) {
        console.error(`    -> FB post failed for Page ${destination.id}: ${err.message}`);
      }
    }
  }

  await savePostedLog(postedLog);
  await rm(FB_PENDING_FILE, { force: true });
}

const mode = process.argv[2];
const run = mode === 'post-facebook' ? runPostFacebook
  : mode === 'generate' ? runGenerate
  : async () => { await runGenerate(); await runPostFacebook(); }; // no arg: convenience for local/manual runs

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
