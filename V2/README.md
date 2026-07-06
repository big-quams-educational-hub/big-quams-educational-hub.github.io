# Big Quams Media® — Platform Foundation
**Sprint 1.1/8 — Root Architecture**

> Nigeria's #1 Free Student Platform  
> `big-quams-educational-hub.github.io`

---

## What This Is

This is the **root architecture** of the Big Quams Media® platform. It contains no features and no UI. It establishes the contracts, folder structure, and core services that every future sprint builds on top of.

---

## Directory Structure

```
bqm-platform/
│
├── index.js                  ← Platform bootstrap (entry point)
├── platform.config.js        ← Brand constants, module registry, env config
│
├── core/                     ← Shared platform services (no UI)
│   ├── router.js             ← Client-side router
│   ├── events.js             ← Cross-module event bus
│   ├── auth-guard.js         ← Authentication state & CEO access check
│   └── storage.js            ← localStorage + Firestore abstraction
│
├── assets/
│   └── tokens.css            ← Design token system (single source of truth)
│
└── modules/                  ← One folder per top-level module
    ├── home/
    ├── learn/
    ├── discover/
    ├── navigate/
    ├── connect/
    ├── profile/
    ├── search/
    ├── notifications/
    ├── authentication/
    └── help-support/
```

Each module folder contains:
```
modules/{id}/
├── index.js      ← Module manifest (ONLY public interface)
└── routes.js     ← All route definitions this module will ever own
```

---

## The 10 Modules

| Module | Path | Auth Required | Purpose |
|---|---|---|---|
| 🏠 Home | `/` | No | Landing, quick-access tools, feed |
| 📚 Learn | `/learn` | No | CBT Practice, GPA Calc, eLibrary, Post-UTME |
| 🔭 Discover | `/discover` | No | Scholarships, Did You Know, Spotlight |
| 🧭 Navigate | `/navigate` | No | Results, Student Loan, Subject Combo |
| 🤝 Connect | `/connect` | **Yes** | CampusConnect NG, peer Q&A, groups |
| 👤 Profile | `/profile` | **Yes** | Study history, streak, referral, settings |
| 🔍 Search | `/search` | No | Platform-wide search |
| 🔔 Notifications | `/notifications` | **Yes** | FCM push notification centre |
| 🔐 Authentication | `/auth` | No | Google/Apple Sign-In, guest mode |
| 💬 Help & Support | `/help` | No | FAQs, WhatsApp, feedback |

---

## Core Rules

### 1. Modules never import each other
Cross-module communication goes through the event bus only:
```js
// ✅ Correct
window.__BQM__.events.emit("learn:session-complete", { score: 82 });

// ❌ Wrong — never do this
import something from "../learn/index.js";
```

### 2. Every module is registered before it loads
Add it to `MODULE_REGISTRY` in `platform.config.js` first. If it's not in the registry, it doesn't exist to the platform.

### 3. Features go inside modules, not at the root
```
// ✅ Correct — new CBT feature
modules/learn/features/cbt/

// ❌ Wrong — new root-level folder
modules/cbt-practice/
```

### 4. All visual values come from tokens
```css
/* ✅ Correct */
color: var(--bqm-blue-main);

/* ❌ Wrong */
color: #1a3fa8;
```

### 5. Storage is namespaced by module
```js
// ✅ Correct
storage.local.set("learn:cbt-profile", data);

// ❌ Wrong
localStorage.setItem("cbt-profile", data);
```

---

## How to Add a Feature (Future Sprints)

1. Identify which module owns the feature
2. Add the feature to `manifest.features[]` in `modules/{id}/index.js`
3. Add its route to `modules/{id}/routes.js`
4. Create `modules/{id}/features/{feature-id}/` with its own files
5. Register the route in the module manifest's `routes[]` array

No changes to `core/`, `index.js`, or other modules are needed.

---

## Platform Event Namespaces

| Namespace | Owner | Examples |
|---|---|---|
| `platform:*` | `index.js` | `platform:ready` |
| `router:*` | `core/router.js` | `router:navigate`, `router:not-found`, `router:auth-required` |
| `auth:*` | `core/auth-guard.js` + `authentication` module | `auth:signed-in`, `auth:signed-out`, `auth:ready` |
| `module:*` | Any module | `module:loaded` |
| `home:*` | Home module | (defined in sprint) |
| `learn:*` | Learn module | `learn:session-complete` |
| `discover:*` | Discover module | (defined in sprint) |
| `connect:*` | Connect module | (defined in sprint) |
| `notifications:*` | Notifications module | `notifications:received` |

---

## Brand Identity

**Name:** Big Quams Media®  
**Tagline:** For Nigerian Students, By Nigerian Students  
**URL:** big-quams-educational-hub.github.io  

**Primary colours:** `#0c1f6e` (deep) · `#1a3fa8` (main) · `#f97316` (accent/orange)  
**Typography:** Montserrat (display) · Roboto (body)  
**CEO access emails:** `bigquamsmedia024@gmail.com` · `abdulrasqquwamdeen@gmail.com`

---

*Sprint 1.1/8 complete. No UI built. Architecture ready for Sprint 1.2/8.*
