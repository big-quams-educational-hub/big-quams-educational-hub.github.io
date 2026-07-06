/**
 * index.js
 * Big Quams Media® — Platform Bootstrap
 * Sprint 1.1/8
 *
 * Entry point for the entire platform.
 * Responsibilities:
 *   1. Validate the module registry
 *   2. Register all enabled modules with the platform router
 *   3. Initialise the event bus
 *   4. Bootstrap the auth service (needed before any guarded module loads)
 *   5. Hand off to the router to resolve the initial route
 *
 * What this file must NEVER do:
 *   - Implement feature logic
 *   - Import from a module directly (use registry + dynamic import only)
 *   - Render UI
 */

import { MODULE_REGISTRY, BRAND, ENV } from "./platform.config.js";
import { createRouter }   from "./core/router.js";
import { createEventBus } from "./core/events.js";
import { createAuthGuard } from "./core/auth-guard.js";
import { createStorage }  from "./core/storage.js";

// ─────────────────────────────────────────────
// PLATFORM INSTANCE
// ─────────────────────────────────────────────
const platform = {
  brand:    BRAND,
  env:      ENV,
  router:   null,
  events:   null,
  auth:     null,
  storage:  null,
  modules:  new Map(),  // id → loaded module manifest
};

// ─────────────────────────────────────────────
// BOOTSTRAP SEQUENCE
// ─────────────────────────────────────────────
async function bootstrap() {
  console.info(`[BQM Platform] Booting ${BRAND.name}…`);

  // 1. Core services
  platform.events  = createEventBus();
  platform.storage = createStorage();
  platform.auth    = createAuthGuard({ events: platform.events, env: ENV });
  platform.router  = createRouter({
    registry: MODULE_REGISTRY,
    events:   platform.events,
    auth:     platform.auth,
  });

  // 2. Load enabled modules
  const enabledModules = MODULE_REGISTRY.filter(m => m.enabled);
  for (const entry of enabledModules) {
    await loadModule(entry);
  }

  // 3. Resolve current route
  await platform.router.resolve(window.location.pathname);

  // 4. Listen for browser back/forward
  window.addEventListener("popstate", () => {
    platform.router.resolve(window.location.pathname);
  });

  console.info(`[BQM Platform] Ready. ${platform.modules.size} modules loaded.`);
  platform.events.emit("platform:ready", { modules: [...platform.modules.keys()] });
}

// ─────────────────────────────────────────────
// MODULE LOADER
// ─────────────────────────────────────────────
/**
 * Dynamically imports a module's manifest and registers it.
 * Each module exports a default manifest — no side effects on import.
 */
async function loadModule(entry) {
  try {
    const { default: manifest } = await import(`./modules/${entry.id}/index.js`);

    // Validate manifest contract
    assertManifest(manifest, entry.id);

    platform.modules.set(entry.id, {
      ...manifest,
      _registry: entry,
    });

    // Register the module's routes with the router
    if (manifest.routes && manifest.routes.length > 0) {
      platform.router.registerRoutes(entry.id, manifest.routes);
    }

    console.info(`[BQM Platform] ✓ Module loaded: ${entry.id}`);
  } catch (err) {
    console.error(`[BQM Platform] ✗ Failed to load module: ${entry.id}`, err);
    // A failed module must not crash the platform
  }
}

// ─────────────────────────────────────────────
// MANIFEST CONTRACT VALIDATOR
// ─────────────────────────────────────────────
function assertManifest(manifest, id) {
  const required = ["id", "label", "version", "routes"];
  for (const field of required) {
    if (manifest[field] === undefined) {
      throw new Error(`Module "${id}" manifest is missing required field: "${field}"`);
    }
  }
  if (manifest.id !== id) {
    throw new Error(`Module manifest id "${manifest.id}" does not match registry id "${id}"`);
  }
}

// ─────────────────────────────────────────────
// PUBLIC PLATFORM API
// ─────────────────────────────────────────────
/**
 * Exposed globally so modules can access platform services
 * without creating circular imports.
 * Usage inside any module: window.__BQM__.events.emit(...)
 */
window.__BQM__ = platform;

// Run
bootstrap().catch(err => {
  console.error("[BQM Platform] Bootstrap failed:", err);
});
