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
 * visitor is redirected (via <meta http-equiv="refresh"> AND a JS
 * location.replace, so it works with or without JS) straight into the
 * normal interactive newsroom.html SPA, landing on the same article via
 * its existing hash-routing (#slug--id).
 *
 * No Firebase credentials are needed — `fs_news` and `fs_config` are
 * public-read in firestore.rules, so this hits the public REST API.
 *
 * Run manually:   node scripts/generate-news-pages.mjs
 * Run in CI:       see .github/workflows/generate-news-pages.yml
 * ------------------------------------------------------------------------
 */

import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const PROJECT_ID = 'big-quams-media';
const SITE_ORIGIN = 'https://bigquamsmedia.com.ng';
const OUTPUT_DIR = 'news';
// Keep this fallback chain identical to resolvePreviewImage() in
// newsroom.html — this script is the authoritative one (crawlers only ever
// see this output), the client-side copy is a secondary/UI-tab convenience.
const GLOBAL_NEWS_DEFAULT_IMAGE = `${SITE_ORIGIN}/newsroom-default.png`;
const SITE_DEFAULT_IMAGE = `${SITE_ORIGIN}/bigquamsmedia.png`;

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

async function fetchCollection(name) {
  const base = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${name}?pageSize=300`;
  const docs = [];
  let pageToken = '';
  do {
    const url = pageToken ? `${base}&pageToken=${pageToken}` : base;
    const res = await fetch(url);
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
  const res = await fetch(url);
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

function renderPage(article, categoryDefaults) {
  const slug = article.slug || makeSlug(article.title || '');
  const seg = `${slug}--${article._id}`;
  const canonical = `${SITE_ORIGIN}/${OUTPUT_DIR}/${seg}/`;
  const title = escapeHtml(`${article.seoTitle || article.title || 'News'} — Big Quams Media®`);
  const rawDesc = article.seoDesc || plainPreview(article.fullContent || '').slice(0, 160);
  const desc = escapeHtml(rawDesc);
  const image = escapeHtml(resolvePreviewImage(article, categoryDefaults));
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

<!-- Human visitors: redirect straight into the interactive newsroom app,
     which opens this same article via its existing hash router. Both a
     no-JS meta-refresh AND a JS redirect are included so it works either
     way; crawlers stop at the <head> above and never reach this part. -->
<meta http-equiv="refresh" content="0; url=${spaTarget}">
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

async function main() {
  console.log('Fetching articles from Firestore\u2026');
  const [articles, categoryDefaults] = await Promise.all([
    fetchCollection('fs_news'),
    fetchDoc('fs_config', 'category_defaults').then((d) => d || {}),
  ]);
  console.log(`Found ${articles.length} article(s).`);

  await rm(OUTPUT_DIR, { recursive: true, force: true });
  await mkdir(OUTPUT_DIR, { recursive: true });

  const sitemapUrls = [];
  let written = 0;
  for (const article of articles) {
    if (!article.title || !article._id) continue; // skip malformed/partial docs
    const slug = article.slug || makeSlug(article.title);
    const seg = `${slug}--${article._id}`;
    const dir = path.join(OUTPUT_DIR, seg);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'index.html'), renderPage(article, categoryDefaults), 'utf8');
    sitemapUrls.push(`${SITE_ORIGIN}/${OUTPUT_DIR}/${seg}/`);
    written++;
  }

  const sitemap =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    sitemapUrls.map((u) => `  <url><loc>${u}</loc></url>`).join('\n') +
    `\n</urlset>\n`;
  await writeFile('sitemap-news.xml', sitemap, 'utf8');

  console.log(`Generated ${written} static article page(s) in ./${OUTPUT_DIR}/`);
  console.log(`Wrote sitemap-news.xml with ${sitemapUrls.length} URL(s).`);
}

main().catch((err) => {
  console.error('generate-news-pages failed:', err);
  process.exit(1);
});
