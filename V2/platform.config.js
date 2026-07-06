/**
 * platform.config.js
 * Big Quams Media® — Platform Foundation
 * Sprint 1.1/8
 *
 * Central source of truth for:
 *   - Brand identity constants
 *   - Module registry
 *   - Environment config
 *
 * Rule: Every module must be registered here before it is loaded.
 * No module should import another module directly — all cross-module
 * communication goes through the platform event bus (core/events.js).
 */

// ─────────────────────────────────────────────
// BRAND IDENTITY
// ─────────────────────────────────────────────
export const BRAND = {
  name: "Big Quams Media®",
  shortName: "BQM",
  tagline: "For Nigerian Students, By Nigerian Students",
  taglineAlt: "Nigeria's #1 Free Student Platform",
  siteUrl: "https://big-quams-educational-hub.github.io",
  orgEmail: "bigquamsmedia024@gmail.com",
  githubOrg: "big-quams-educational-hub",
};

// ─────────────────────────────────────────────
// DESIGN TOKENS
// ─────────────────────────────────────────────
export const TOKENS = {
  color: {
    blueDeep:    "#0c1f6e",
    blueMain:    "#1a3fa8",
    blueLight:   "#dde9ff",
    orange:      "#f97316",
    green:       "#16a34a",
    red:         "#dc2626",

    // Light theme surfaces
    surface:     "#ffffff",
    surfaceAlt:  "#f0f4ff",
    pageBg:      "#f5f7ff",
    border:      "#e2e8f4",
    textMain:    "#1e2749",
    textMuted:   "#64748b",

    // Dark theme surfaces
    dark: {
      surface:    "#161b27",
      surfaceAlt: "#111624",
      pageBg:     "#0d1117",
      border:     "#2a3550",
      textMain:   "#e6edf3",
      textMuted:  "#8b949e",
    },
  },

  gradient: {
    header:  "linear-gradient(135deg, #0c1f6e, #1a3fa8)",
    hero:    "linear-gradient(135deg, #081530, #0f2060, #1a3fa8)",
    footer:  "linear-gradient(135deg, #081530, #0c1f6e)",
    primary: "linear-gradient(135deg, #0c1f6e, #1a3fa8)",
  },

  typography: {
    display: "'Montserrat', sans-serif",   // headings, brand, CTAs
    body:    "'Roboto', sans-serif",        // prose, UI copy
    weights: { light: 300, regular: 400, medium: 500, bold: 700, black: 800 },
  },

  radius: {
    sm: "8px",
    md: "14px",
  },

  shadow: {
    md: "0 8px 28px rgba(26, 63, 168, 0.12)",
  },
};

// ─────────────────────────────────────────────
// MODULE REGISTRY
// ─────────────────────────────────────────────
/**
 * Every top-level module must be declared here.
 * Fields:
 *   id        — machine identifier, matches /modules/{id}/
 *   label     — display name shown in nav/UI
 *   icon      — emoji or icon key (UI layer resolves this)
 *   path      — URL base path this module owns
 *   authGuard — whether the module requires authentication
 *   enabled   — feature-flag: false = module exists but is not loaded
 *   order     — position in primary navigation
 */
export const MODULE_REGISTRY = [
  {
    id:        "home",
    label:     "Home",
    icon:      "🏠",
    path:      "/",
    authGuard: false,
    enabled:   true,
    order:     1,
  },
  {
    id:        "learn",
    label:     "Learn",
    icon:      "📚",
    path:      "/learn",
    authGuard: false,
    enabled:   true,
    order:     2,
  },
  {
    id:        "discover",
    label:     "Discover",
    icon:      "🔭",
    path:      "/discover",
    authGuard: false,
    enabled:   true,
    order:     3,
  },
  {
    id:        "navigate",
    label:     "Navigate",
    icon:      "🧭",
    path:      "/navigate",
    authGuard: false,
    enabled:   true,
    order:     4,
  },
  {
    id:        "connect",
    label:     "Connect",
    icon:      "🤝",
    path:      "/connect",
    authGuard: true,
    enabled:   true,
    order:     5,
  },
  {
    id:        "profile",
    label:     "Profile",
    icon:      "👤",
    path:      "/profile",
    authGuard: true,
    enabled:   true,
    order:     6,
  },
  {
    id:        "search",
    label:     "Search",
    icon:      "🔍",
    path:      "/search",
    authGuard: false,
    enabled:   true,
    order:     7,
  },
  {
    id:        "notifications",
    label:     "Notifications",
    icon:      "🔔",
    path:      "/notifications",
    authGuard: true,
    enabled:   true,
    order:     8,
  },
  {
    id:        "authentication",
    label:     "Sign In",
    icon:      "🔐",
    path:      "/auth",
    authGuard: false,
    enabled:   true,
    order:     9,
  },
  {
    id:        "help-support",
    label:     "Help & Support",
    icon:      "💬",
    path:      "/help",
    authGuard: false,
    enabled:   true,
    order:     10,
  },
];

// ─────────────────────────────────────────────
// ENVIRONMENT
// ─────────────────────────────────────────────
export const ENV = {
  firebase: {
    // Populated per environment — never hardcode credentials here
    projectId:    process.env.BQM_FIREBASE_PROJECT_ID    || null,
    apiKey:       process.env.BQM_FIREBASE_API_KEY        || null,
    authDomain:   process.env.BQM_FIREBASE_AUTH_DOMAIN    || null,
    storageBucket:process.env.BQM_FIREBASE_STORAGE_BUCKET || null,
    messagingSenderId: process.env.BQM_FIREBASE_MESSAGING_SENDER_ID || null,
    appId:        process.env.BQM_FIREBASE_APP_ID         || null,
  },
  render: {
    serverUrl: process.env.BQM_RENDER_SERVER_URL || null,
  },
  ceoDashboardEmails: [
    "bigquamsmedia024@gmail.com",
    "abdulrasqquwamdeen@gmail.com",
  ],
  isProd: process.env.NODE_ENV === "production",
};
