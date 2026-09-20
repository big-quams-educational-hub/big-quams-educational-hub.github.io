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

// Fetches only documents whose `updatedAt` is strictly after `sinceISO`, via
// Firestore's :runQuery endpoint (the plain "list documents" REST endpoint
// used by fetchCollection has no filtering — a structured query is the only
// way to ask Firestore server-side for "just what changed"). This is what
// lets the workflow run every 20 minutes without re-reading the entire
// collection each time: on a quiet day this returns zero documents, using
// one read-quota unit for the query itself rather than one per article.
//
// IMPORTANT ASSUMPTION: this requires every fs_news document to carry an
// `updatedAt` timestamp set on BOTH creation and edit (not just
// `createdAt`). If the admin panel only stamps `updatedAt` on edits, a
// brand-new never-edited article would never match this filter and would
// silently never get a page. Confirm this before relying on it — if it
// turns out only `createdAt` is reliably set, swap the fieldPath below to
// `createdAt` (this will miss edits-with-no-new-article instead, which is
// the lesser problem since content edits are rarer than net-new posts).
async function fetchChangedArticles(sinceISO) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery${FIREBASE_API_KEY ? `?key=${encodeURIComponent(FIREBASE_API_KEY)}` : ''}`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'fs_news' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'updatedAt' },
          op: 'GREATER_THAN',
          value: { timestampValue: sinceISO },
        },
      },
      // Firestore requires the first orderBy to match the inequality's
      // field — this isn't just a nicety, the query is rejected without it.
      orderBy: [{ field: { fieldPath: 'updatedAt' }, direction: 'ASCENDING' }],
    },
  };
  const res = await fetchWithRetry(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  if (!res.ok) {
    throw new Error(`Firestore runQuery failed: ${res.status} ${await res.text()}`);
  }
  const rows = await res.json();
  const docs = [];
  for (const row of rows) {
    if (!row.document) continue; // trailing progress-only rows carry no document
    const id = row.document.name.split('/').pop();
    docs.push({ _id: id, ...decodeFields(row.document.fields || {}) });
  }
  return docs;
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
          <a href="https://wa.me/2349049871643" target="_blank" rel="noopener">\ud83d\udcac WhatsApp Us</a>
          <a href="https://chat.whatsapp.com/FDtwbP0d4Z87e8o8lTW0UO" target="_blank" rel="noopener">\ud83d\udc65 Join Group</a>
          <a href="https://instagram.com/bigquamsmedia" target="_blank" rel="noopener">\ud83d\udcf8 Instagram</a>
          <a href="https://tiktok.com/@bigquamsmedia" target="_blank" rel="noopener">\ud83c\udfb5 TikTok</a>
          <a href="${SITE_ORIGIN}/index.html#install-app">\ud83d\udcf2 Install App</a>
        </div>
      </div>
    </div>
    <div class="footer-copy">\u00a9 ${new Date().getFullYear()} Big Quams Media\u00ae \u00b7 All rights reserved \u00b7 Created by <a href="https://bigquams.vercel.app/#home" target="_blank" rel="noopener noreferrer" style="color:rgba(255,255,255,.5);font-weight:700">Abdulrasaq Quwamdeen</a>.</div>
  </div>
</footer>`;
}

function renderPage(article, resolvedImage) {
  const slug = article.slug || makeSlug(article.title || '');
  const seg = `${slug}--${article._id}`;
  const canonical = `${SITE_ORIGIN}/${OUTPUT_DIR}/${seg}/`;
  const title = escapeHtml(`${article.seoTitle || article.title || 'News'} — Big Quams Media®`);
  const rawDesc = article.seoDesc || firstSentenceExcerpt(article.fullContent || '');
  const desc = escapeHtml(rawDesc);
  const image = escapeHtml(resolvedImage || GLOBAL_NEWS_DEFAULT_IMAGE || SITE_DEFAULT_IMAGE);
  const spaTarget = `${SITE_ORIGIN}/newsroom.html#${seg}`;
  const publishedTime = typeof article.createdAt === 'string' ? article.createdAt : '';
  const bodyHtml = formatArticleBody(article.fullContent || '');
  const mins = readingTime(article.fullContent || '');
  const category = escapeHtml(article.category || 'News');
  const headline = escapeHtml(article.title || 'News');
  const dateLabel = publishedTime
    ? new Date(publishedTime).toLocaleDateString('en-NG', { year: 'numeric', month: 'long', day: 'numeric' })
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
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
    </div>
    ${image ? `<img class="art-image" src="${image}" alt="${headline}">` : ''}
    <div class="art-content">${bodyHtml}</div>
    <a class="open-app-cta" href="${spaTarget}">Open in Newsroom app for related stories &amp; comments \u2192</a>
  </div>
</div>
${renderFooter()}
</body>
</html>
`;
}

// ---------------------------------------------------------------------
// Persisted news state: the incremental-fetch checkpoint, plus a running
// index of every article ever generated (needed because with incremental
// fetching, most runs only see a handful of changed articles — the
// sitemap still has to list ALL of them, so we can't just rebuild it from
// "this run's articles" the way the old full-fetch version did).
// ---------------------------------------------------------------------
const NEWS_STATE_FILE = 'news-state.json';

async function loadNewsState() {
  try {
    const raw = await readFile(NEWS_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      lastRunReadTime: parsed.lastRunReadTime || null,
      articles: parsed.articles && typeof parsed.articles === 'object' ? parsed.articles : {},
    };
  } catch {
    return { lastRunReadTime: null, articles: {} }; // no state yet — first run does a full fetch
  }
}

async function saveNewsState(state) {
  await writeFile(NEWS_STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
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

// Posts one article to one Facebook Page's feed. Facebook's own crawler
// fetches `link` itself and builds the preview card from ITS og:* tags —
// the same static page + materialized image this script already
// generates — so there's nothing extra to attach here beyond the link.
async function postArticleToFacebook(article, canonicalUrl, destination) {
  const message = article.title || 'New article on Big Quams Media\u00ae';
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

async function main() {
  const newsState = await loadNewsState();
  // Captured BEFORE the fetch fires, not after — so any article written
  // mid-run lands after this checkpoint and simply gets picked up on the
  // *next* run rather than being missed. A 20-minute delay on a brand-new
  // article is fine; silently never generating its page is not.
  const requestTime = new Date().toISOString();

  let articles;
  if (!newsState.lastRunReadTime) {
    console.log('No previous checkpoint found — doing a full fetch (first run).');
    articles = await fetchCollection('fs_news');
  } else {
    console.log(`Fetching articles changed since ${newsState.lastRunReadTime}...`);
    articles = await fetchChangedArticles(newsState.lastRunReadTime);
  }
  console.log(`  ${articles.length} article(s) to (re)generate.`);

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

  await mkdir(OUTPUT_DIR, { recursive: true });

  const postedLog = FB_ENABLED ? await loadPostedLog() : {};

  for (const article of articles) {
    const slug = article.slug || makeSlug(article.title || '');
    const seg = `${slug}--${article._id}`;
    const pageDir = path.join(OUTPUT_DIR, seg);
    await mkdir(pageDir, { recursive: true });

    const rawImage = resolvePreviewImage(article, categoryDefaults);
    const materialized = await materializeImage(rawImage, pageDir);
    const resolvedImageUrl =
      materialized && !/^https?:\/\//i.test(materialized)
        ? `${SITE_ORIGIN}/${OUTPUT_DIR}/${seg}/${materialized}`
        : materialized || rawImage;

    const html = renderPage(article, resolvedImageUrl);
    await writeFile(path.join(pageDir, 'index.html'), html, 'utf8');

    const canonical = `${SITE_ORIGIN}/${OUTPUT_DIR}/${seg}/`;
    const lastmod = typeof article.updatedAt === 'string' ? article.updatedAt : requestTime;
    // Record this article in the persisted index regardless of whether it
    // was new or already known — this index (not "articles from this run")
    // is what the sitemap gets built from below, since most runs now only
    // touch a handful of documents.
    newsState.articles[article._id] = { seg, lastmod };

    if (FB_ENABLED) {
      const alreadyPosted = postedLog[article._id] || [];
      for (const destination of FB_DESTINATIONS) {
        if (alreadyPosted.includes(destination.id)) continue;
        try {
          console.log(`  Posting "${article.title}" to Page ${destination.id}...`);
          const postId = await postArticleToFacebook(article, canonical, destination);
          console.log(`    -> posted: ${postId}`);
          postedLog[article._id] = [...alreadyPosted, destination.id];
        } catch (err) {
          console.error(`    -> FB post failed for Page ${destination.id}: ${err.message}`);
          // Leave this destination absent from postedLog so the next run
          // retries it, rather than silently giving up forever.
        }
      }
    }
  }

  if (FB_ENABLED) await savePostedLog(postedLog);

  // Sitemap is built from the FULL persisted index, not just this run's
  // (usually much smaller) batch — otherwise an incremental run with zero
  // or one changed article would wipe out every other article's sitemap
  // entry.
  const sitemapEntries = Object.values(newsState.articles).map(
    ({ seg, lastmod }) => `  <url><loc>${escapeHtml(`${SITE_ORIGIN}/${OUTPUT_DIR}/${seg}/`)}</loc><lastmod>${lastmod}</lastmod></url>`
  );
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapEntries.join('\n')}\n</urlset>\n`;
  await writeFile('sitemap-news.xml', sitemap, 'utf8');

  newsState.lastRunReadTime = requestTime;
  await saveNewsState(newsState);

  console.log(`Done — (re)generated ${articles.length} page(s); ${Object.keys(newsState.articles).length} total in sitemap.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
