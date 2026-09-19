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
 * ------------------------------------------------------------------------
 */

import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';

const PROJECT_ID = 'big-quams-media';
const SITE_ORIGIN = 'https://bigquamsmedia.com.ng';
const OUTPUT_DIR = 'news';
const GLOBAL_NEWS_DEFAULT_IMAGE = `${SITE_ORIGIN}/newsroom-default.png`;
const SITE_DEFAULT_IMAGE = `${SITE_ORIGIN}/bigquamsmedia.png`;

// ---------------------------------------------------------------------
// Facebook auto-posting (MULTI-PAGE SUPPORT)
// FB_PAGE_ID can now be "1170305112838317,109930298011435"
// ---------------------------------------------------------------------
const FB_PAGE_IDS = (process.env.FB_PAGE_ID || '').split(',').map(s => s.trim()).filter(Boolean);
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN || '';
const FB_ENABLED = Boolean(FB_PAGE_IDS.length && FB_PAGE_ACCESS_TOKEN);
const FB_POSTED_LOG = 'fb-posted-articles.json';
const FB_API_VERSION = 'v21.0';

// ---------------------------------------------------------------------
// Small helpers
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
  if (!match) return src;
  const [, mime, b64] = match;
  const ext = MIME_EXT[mime.toLowerCase()] || 'jpg';
  let buffer;
  try {
    buffer = Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
  const filename = `preview.${ext}`;
  await writeFile(path.join(outDir, filename), buffer);
  return filename;
}

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

async function fetchWithRetry(url, { retries = 5, baseDelayMs = 1000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}: ${await res.text()}`);
        throw lastErr;
      }
      return res;
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

async function fetchCollection(name) {
  const base = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${name}?pageSize=300`;
  const docs = [];
  let pageToken = '';
  do {
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
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${name}/${id}`;
  const res = await fetchWithRetry(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore fetch failed for ${name}/${id}: ${res.status}`);
  const data = await res.json();
  return decodeFields(data.fields || {});
}

function resolvePreviewImage(article, categoryDefaults) {
  if (article.previewImage) return article.previewImage;
  if (article.useFeaturedAsPreview !== false && article.image) return article.image;
  if (article.category && categoryDefaults[article.category]) return categoryDefaults[article.category];
  if (categoryDefaults.__global__) return categoryDefaults.__global__;
  return GLOBAL_NEWS_DEFAULT_IMAGE || SITE_DEFAULT_IMAGE;
}

function renderPage(article, categoryDefaults, resolvedImage) {
  const slug = article.slug || makeSlug(article.title || '');
  const seg = `${slug}--${article._id}`;
  const canonical = `${SITE_ORIGIN}/${OUTPUT_DIR}/${seg}/`;
  const title = escapeHtml(`${article.seoTitle || article.title || 'News'} — Big Quams Media®`);
  const rawDesc = article.seoDesc || firstSentenceExcerpt(article.fullContent || '');
  const desc = escapeHtml(rawDesc);
  const image = escapeHtml(resolvedImage || GLOBAL_NEWS_DEFAULT_IMAGE || SITE_DEFAULT_IMAGE);
  const spaTarget = `${SITE_ORIGIN}/newsroom.html#${seg}`;
  const publishedTime = typeof article.createdAt === 'string' ? article.createdAt : '';

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

<script>location.replace(${JSON.stringify(spaTarget)});</script>
<link rel="icon" type="image/png" href="${SITE_ORIGIN}/logo.png">
</head>
<body>
<p style="font-family:sans-serif;padding:24px;text-align:center;color:#475569">
  Loading article&hellip; If you are not redirected automatically,
  <a href="${spaTarget}">tap here to continue</a>.
</p>
</body>
</html>
`;
}

// ---------------------------------------------------------------------
// Facebook posting helpers (MULTI-PAGE)
// ---------------------------------------------------------------------

async function loadPostedLog() {
  try {
    const raw = await readFile(FB_POSTED_LOG, 'utf8');
    const ids = JSON.parse(raw);
    return new Set(Array.isArray(ids) ? ids : []);
  } catch {
    return null;
  }
}

async function savePostedLog(idsSet) {
  await writeFile(FB_POSTED_LOG, JSON.stringify([...idsSet].sort(), null, 2) + '\n', 'utf8');
}

let cachedPageTokens = {};
async function derivePageAccessToken(pageId) {
  if (cachedPageTokens[pageId]) return cachedPageTokens[pageId];
  const url = `https://graph.facebook.com/${FB_API_VERSION}/${pageId}?fields=access_token&access_token=${encodeURIComponent(FB_PAGE_ACCESS_TOKEN)}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || !data.access_token) {
    throw new Error(data.error?.message || `Could not derive a Page Access Token for ${pageId}`);
  }
  cachedPageTokens[pageId] = data.access_token;
  return cachedPageTokens[pageId];
}

async function postArticleToFacebook(article, canonicalUrl) {
  const message = article.title || 'New article on Big Quams Media®';

  for (const pageId of FB_PAGE_IDS) {
    const url = `https://graph.facebook.com/${FB_API_VERSION}/${pageId}/feed`;

    const attemptPost = async (token) => {
      const body = new URLSearchParams({ message, link: canonicalUrl, access_token: token });
      const postRes = await fetch(url, { method: 'POST', body });
      const data = await postRes.json().catch(() => ({}));
      return { ok: postRes.ok && !data.error, data, status: postRes.status };
    };

    let result = await attemptPost(FB_PAGE_ACCESS_TOKEN);
    if (!result.ok && result.data?.error?.code === 200) {
      const pageToken = await derivePageAccessToken(pageId);
      result = await attemptPost(pageToken);
    }
    if (!result.ok) {
      console.error(`  FB post failed for Page ${pageId}: ${result.data.error?.message || `HTTP ${result.status}`}`);
    } else {
      console.log(`  FB posted to ${pageId}: ${result.data.id}`);
    }
  }
  return true;
}

async function main() {
  console.log('Fetching articles from Firestore…');
  const [articles, categoryDefaults] = await Promise.all([
    fetchCollection('fs_news'),
    fetchDoc('fs_config', 'category_defaults').then((d) => d || {}),
  ]);
  console.log(`Found ${articles.length} article(s).`);

  await rm(OUTPUT_DIR, { recursive: true, force: true });
  await mkdir(OUTPUT_DIR, { recursive: true });

  const sitemapUrls = [];
  let written = 0;

  let postedLog = null;
  if (FB_ENABLED) {
    postedLog = await loadPostedLog();
    if (postedLog === null) {
      console.log('fb-posted-articles.json not found — first run, will not auto-post existing articles.');
      postedLog = new Set(articles.map(a => a._id));
    }
  }

  for (const article of articles) {
    if (!article.title || !article._id) continue;
    const slug = article.slug || makeSlug(article.title);
    const seg = `${slug}--${article._id}`;
    const dir = path.join(OUTPUT_DIR, seg);
    await mkdir(dir, { recursive: true });
    const rawImage = resolvePreviewImage(article, categoryDefaults);
    const materialized = await materializeImage(rawImage, dir);
    const resolvedImage =
      materialized && materialized !== rawImage
        ? `${SITE_ORIGIN}/${OUTPUT_DIR}/${seg}/${materialized}`
        : materialized || GLOBAL_NEWS_DEFAULT_IMAGE || SITE_DEFAULT_IMAGE;
    await writeFile(path.join(dir, 'index.html'), renderPage(article, categoryDefaults, resolvedImage), 'utf8');
    sitemapUrls.push(`${SITE_ORIGIN}/${OUTPUT_DIR}/${seg}/`);
    written++;

    if (FB_ENABLED && postedLog && !postedLog.has(article._id)) {
      const canonical = `${SITE_ORIGIN}/${OUTPUT_DIR}/${seg}/`;
      console.log(`New article detected: ${article._id} — posting to ${FB_PAGE_IDS.length} page(s)...`);
      try {
        await postArticleToFacebook(article, canonical);
        postedLog.add(article._id);
        await savePostedLog(postedLog);
      } catch (err) {
        console.error(`  FB auto-post error for ${article._id}: ${err.message}`);
      }
    }
  }

  const sitemap =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    sitemapUrls.map((u) => `  <url><loc>${u}</loc></url>`).join('\n') +
    `\n</urlset>\n`;
  await writeFile('sitemap-news.xml', sitemap, 'utf8');

  console.log(`Generated ${written} static article page(s) in ./${OUTPUT_DIR}/`);
  console.log(`Wrote sitemap-news.xml with ${sitemapUrls.length} URL(s).`);

  if (FB_ENABLED && postedLog) {
    await savePostedLog(postedLog);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
