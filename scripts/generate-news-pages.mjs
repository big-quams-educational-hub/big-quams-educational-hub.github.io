#!/usr/bin/env node
/**
 * generate-news-pages.mjs - QUOTA SAFE VERSION (30 latest only)
 * Keeps your /news/<slug>--<id>/index.html structure for WhatsApp/FB previews
 */
import { initializeApp } from "firebase/app";
import { getFirestore, collection, query, orderBy, limit, getDocs } from "firebase/firestore";
import fs from "fs";
import path from "path";

const firebaseConfig = {
  apiKey: "AIzaSyBSoQ9W6n8Oi-0z1q3p2...",
  authDomain: "big-quams-media.firebaseapp.com",
  projectId: "big-quams-media",
  storageBucket: "big-quams-media.firebasestorage.app",
  messagingSenderId: "123456...",
  appId: "1:123456:web:..."
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const FB_PAGE_ID = process.env.FB_PAGE_ID;
const FB_PAGE_ID_2 = process.env.FB_PAGE_ID_2;
const FB_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const FB_TOKEN_2 = process.env.FB_PAGE_ACCESS_TOKEN_2;

function slugify(text) {
  return (text || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

async function main() {
  console.log("Fetching latest 30 to save quota...");

  const q = query(collection(db, "fs_news"), orderBy("createdAt", "desc"), limit(30));
  const snapshot = await getDocs(q);

  let posted = {};
  if (fs.existsSync("fb-posted-articles.json")) {
    try { posted = JSON.parse(fs.readFileSync("fb-posted-articles.json", "utf8")); } catch {}
  }

  const baseDir = "news";
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

  let sitemapEntries = [];

  for (const docSnap of snapshot.docs) {
    const data = docSnap.data();
    const id = docSnap.id;
    const slug = data.slug || slugify(data.title);
    const folderName = `${slug}--${id}`;
    const folderPath = path.join(baseDir, folderName);
    if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });

    const publicUrl = `https://bigquams.com.ng/news/${folderName}/`;
    const image = data.image || data.imageUrl || "https://bigquams.com.ng/logo.png";

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${(data.title || "BigQuams News").replace(/</g, "&lt;")}</title>
<meta property="og:title" content="${(data.title || "").replace(/"/g, '&quot;')}" />
<meta property="og:description" content="${(data.excerpt || data.summary || "").replace(/"/g, '&quot;').slice(0, 200)}" />
<meta property="og:image" content="${image}" />
<meta property="og:url" content="${publicUrl}" />
<meta property="og:type" content="article" />
<meta http-equiv="refresh" content="0; url=https://bigquams.com.ng/newsroom.html?id=${id}" />
</head>
<body>Redirecting to <a href="https://bigquams.com.ng/newsroom.html?id=${id}">${data.title || ""}</a>...</body>
</html>`;

    fs.writeFileSync(path.join(folderPath, "index.html"), html);
    sitemapEntries.push(`<url><loc>${publicUrl}</loc><lastmod>${new Date().toISOString()}</lastmod></url>`);

    // Facebook auto-post
    if (!posted[id] && data.title) {
      try {
        console.log(`Posting ${id} to FB...`);
        for (const [pageId, token] of [[FB_PAGE_ID, FB_TOKEN], [FB_PAGE_ID_2, FB_TOKEN_2]]) {
          if (!pageId ||!token) continue;
          const res = await fetch(`https://graph.facebook.com/${pageId}/feed`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: `${data.title}\n\nRead more: ${publicUrl}`, link: publicUrl, access_token: token })
          });
          const r = await res.json();
          console.log(`FB ${pageId} result:`, r.id || r.error || r);
        }
        posted[id] = true;
      } catch (e) {
        console.error("FB error", e.message);
      }
    }
  }

  fs.writeFileSync("fb-posted-articles.json", JSON.stringify(posted, null, 2));
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${sitemapEntries.join("")}</urlset>`;
  fs.writeFileSync("sitemap-news.xml", sitemap);
  console.log(`Done - Generated ${snapshot.size} pages, quota safe.`);
}

main().catch(e => { console.error(e); process.exit(1); });
