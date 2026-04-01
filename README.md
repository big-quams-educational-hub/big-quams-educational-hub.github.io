# BIG QUAMS MEDIA® — Website Documentation

> Nigeria's #1 student-focused media platform. Simplifying campus life through timely JAMB updates, admission guides, scholarship alerts, campus news, and digital services.

**Live Site:** https://big-quams-educational-hub.github.io  
**Admin Panel:** https://big-quams-educational-hub.github.io/bigquamsmedia-admin/admin.html

---

## 📁 File Structure

```
big-quams-educational-hub.github.io/   ← Main site repo
│
├── index.html          — Homepage (all sections)
├── newsroom.html       — Full news page with search & filters
├── elibrary.html       — eLibrary with book grid
├── dyk.html            — DYK, History & Current Affairs page
├── spotlight.html      — Student Spotlight page
│
├── news.json           — News articles database
├── books.json          — eLibrary books database
├── dyk.json            — DYK / History / Current Affairs database
├── spotlight.json      — Spotlight items database
│
└── README.md           — This file

bigquamsmedia-admin/                    ← Admin repo
└── admin.html          — Admin panel (password protected)
```

---

## 🌐 Pages Overview

### `index.html` — Homepage
The main landing page. Contains all sections in order:
- Hero banner with CTA buttons
- About Us + stats
- Our Services (7 service cards with modals)
- eLibrary promo section
- Latest News (top 5, links to newsroom)
- DYK, History & Current Affairs (top 3 cards)
- Score Calculator (popup)
- Spotlight (top 3 cards)
- Student Reviews
- Contact form + links
- Footer

### `newsroom.html` — Newsroom
Full news page with:
- Search bar
- Category filter tabs (JAMB / Campus / Scholarship / Admission / Services)
- Pinned articles shown first with gold badge
- Full article modal with image, author, content, action buttons (View / Download / Share)

### `elibrary.html` — eLibrary
Free book library with:
- Search bar + category filter tabs
- Book grid (2–5 columns depending on screen)
- Book detail modal with Read Online / Download buttons (Google Drive integration)

### `dyk.html` — Knowledge Hub
Did You Know, Today in History, and Current Affairs with:
- Search + category filters
- Card grid
- Full article modal with image and share button

### `spotlight.html` — Spotlight
Celebrating students, birthdays, and achievements with:
- Card grid with photos
- Full detail modal with share button

---

## 🗃️ JSON Data Files

All content is managed through JSON files. The **admin panel** reads and writes these files directly to GitHub via the API.

### `news.json`
```json
[
  {
    "title": "Article headline",
    "category": "JAMB Update",
    "date": "April 1, 2026",
    "author": "BIG QUAMS MEDIA",
    "summary": "Short 2–3 sentence preview shown on cards",
    "fullContent": "Full article text. Use blank lines for paragraphs.",
    "image": "base64 or URL",
    "pinned": true,
    "link": "https://wa.me/message/OVCVEDHU3I2PH1",
    "actions": {
      "share": true,
      "viewUrl": "https://...",
      "downloadUrl": "https://..."
    }
  }
]
```
**Categories:** JAMB Update · Campus News · Scholarship · Admission Guide · Services · Academic Coaching · Lifestyle · Announcement

### `books.json`
```json
[
  {
    "title": "Book title",
    "author": "Author name",
    "category": "JAMB (UTME & DE)",
    "description": "Short description",
    "cover": "base64 or URL",
    "driveId": "Google Drive file ID",
    "readUrl": "optional direct read URL"
  }
]
```
**Categories:** JAMB (UTME & DE) · University · Novels & Fiction · Secondary School · Scholarship · Professional

### `dyk.json`
```json
[
  {
    "title": "Did You Know? ...",
    "category": "DYK Fact",
    "date": "April 1, 2026",
    "author": "BIG QUAMS MEDIA",
    "summary": "Short teaser",
    "content": "Full content text",
    "image": "base64 or URL"
  }
]
```
**Categories:** DYK Fact · Today in History · Current Affairs

### `spotlight.json`
```json
[
  {
    "title": "Celebrating Aisha — JAMB 320!",
    "category": "Student Achievement",
    "date": "April 1, 2026",
    "summary": "Short summary for homepage card",
    "content": "Full details",
    "image": "base64 or URL"
  }
]
```
**Categories:** Student Achievement · Birthday · Celebration

---

## 🔐 Admin Panel

**URL:** `https://big-quams-educational-hub.github.io/bigquamsmedia-admin/admin.html`

### Login
- Password: stored securely (btoa obfuscated in the HTML)
- Session persists until tab is closed

### GitHub Token
- Required each session (stored in `sessionStorage` only — never in code)
- Needs `repo` scope
- Token allows admin to read/write JSON files directly to the main site repo via GitHub API

### Admin Sections
| Tab | What it manages |
|-----|----------------|
| 📰 News | Add, edit, delete, pin articles |
| 📚 eLibrary | Add, edit, delete books |
| 💡 DYK | Add, edit, delete DYK/History/Current Affairs |
| 🌟 Spotlight | Add, edit, delete spotlights |

### Pinning News
- Maximum **3 pinned articles** at a time
- Pinned articles always appear first on homepage and newsroom
- Gold "📌 PINNED" badge shown on pinned cards

---

## ⚙️ Features

| Feature | Detail |
|---------|--------|
| 🌙 Dark Mode | Toggle in header, saved to `localStorage` |
| 🧮 Calculator | JAMB score + screening points, PDF download |
| 📢 WA Popup | WhatsApp channel popup, once per session |
| 📤 Share | Native share API or WhatsApp fallback |
| 🖼️ Image Upload | Base64 conversion in admin (max 500KB) |
| 📌 Pin Articles | Max 3 pinned, sorted to top |
| 🔍 Search | Newsroom, eLibrary, DYK all have search |
| 📱 Responsive | Mobile-first, works on all screen sizes |

---

## 🛠️ Technology Stack

| Layer | Technology |
|-------|------------|
| Hosting | GitHub Pages (free, static) |
| Frontend | HTML5 + CSS3 + Vanilla JavaScript |
| Fonts | Montserrat (headings) + Roboto (body) |
| Content | JSON files (news.json, books.json, dyk.json, spotlight.json) |
| Admin | GitHub REST API v3 (read/write JSON) |
| Images | Base64 encoded (stored in JSON) |
| Forms | Formspree (contact form) |

---

## 📱 WhatsApp Links

| Link | Purpose |
|------|---------|
| `https://wa.me/message/OVCVEDHU3I2PH1` | Direct chat / support |
| `https://wa.me/+2349049871643` | Builder contact |
| `https://chat.whatsapp.com/FDtwbP0d4Z87e8o8lTW0UO` | Brainy Buddies Group |
| `https://whatsapp.com/channel/0029VbC665dFnSzF7HzlDh2Q` | BIG QUAMS MEDIA Channel |

---

## 🚀 How to Update Content

### Adding a news article (via Admin)
1. Open admin panel → sign in → paste GitHub token
2. Click **📰 News** → **Add Article**
3. Fill in title, category, date, author, summary, full content
4. Optionally upload cover image and set action buttons (View / Download / Share)
5. Click **Publish Article** — live within 1–2 minutes

### Adding a book (via Admin)
1. Open admin panel → **📚 eLibrary** → **Add Book**
2. Fill in title, author, category, description
3. Upload cover image (optional)
4. Paste Google Drive File ID (from the share link)
5. Click **Add to eLibrary**

### Manually editing JSON
You can also edit any `.json` file directly on GitHub if needed. Just make sure to keep the array structure valid.

---

## 📞 Contact & Support

**Big Quams Media®**  
WhatsApp: [+2349049871643](https://wa.me/+2349049871643)  
Email: bigquamsmedia024@gmail.com  

*© 2025 Big Quams Media®. All rights reserved.*

