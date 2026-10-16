import { describe, it, expect, vi } from "vitest";
import express from "express";
import { createServer } from "http";

// Route-registration enforcement (companion to CLAUDE.md's blob-staging
// inventory-diff rule; motivated by 9360780, where constructed-blob staging
// of routes.ts silently deleted the three §19 ledger routes and the
// verification panel lost its only entry point).
//
// This reads the RUNNING registration — registerRoutes into a real Express
// app, then the router stack — not the file text, so routes.ts's NUL-byte
// TEMP-exclusion and parallel-session edits are irrelevant here.
//
// The suite FAILS if any expected route is missing. NEW routes are allowed
// without listing (the check is one-directional: expected ⊆ registered) —
// but add them here when they ship, so their later loss is caught too.
//
// server/index.ts is mocked: importing it boots Express (async IIFE —
// DB init + listen), which must never happen inside a test.
vi.mock("./index", () => ({ log: () => {} }));

const EXPECTED_ROUTES = [
  "DELETE /api/bulk-lists/:id",
  "DELETE /api/view-presets/:id",
  "GET /api/asins",
  "GET /api/asins/:asin/history",
  "GET /api/asins/check/:asin",
  "GET /api/asins/revival-candidates",
  "GET /api/bulk-lists",
  "GET /api/bulk-lists/:id",
  "GET /api/bulk-lists/:id/refresh/status",
  "GET /api/credentials-status",
  "GET /api/download-template",
  "GET /api/export/velocity-upload",
  "GET /api/pos",
  "GET /api/pos/:id",
  "PATCH /api/pos/:id/closed",
  "PATCH /api/pos/asin-rows/:id/quantities",
  "POST /api/pos/asin-rows/:id/shipments",
  "DELETE /api/pos/shipments/:id",
  "GET /api/prices/status",
  "GET /api/repricer/zero-sales",
  "GET /api/settings",
  "GET /api/settings/hazmat",
  "GET /api/sku-legend/brands",
  "GET /api/submissions/unverified",
  "GET /api/suppression/sync",
  "GET /api/tags",
  "GET /api/velocity/plan",
  "GET /api/view-presets",
  "POST /api/analyze",
  "POST /api/analyze/all",
  "POST /api/asins/:asin/cogs/reset",
  "POST /api/asins/:asin/cogs/sync-from-po",
  "POST /api/asins/:asin/recheck-issues",
  "POST /api/asins/in-database",
  "POST /api/asins/revive",
  "POST /api/bulk-lists",
  "POST /api/bulk-lists/:id/promote",
  "POST /api/bulk-lists/:id/refresh",
  "POST /api/cogs/bulk-sync-from-po",
  "POST /api/export/sellerboard-cogs",
  "POST /api/import-asin",
  "POST /api/inventory/sync",
  "POST /api/listings/full-scope-pass",
  "POST /api/offer-add/preview",
  "POST /api/offer-add/submit",
  "POST /api/parse-file",
  "POST /api/parse-mapped",
  "POST /api/prices/refresh",
  "POST /api/sales/sync",
  "POST /api/sheets/sync",
  "POST /api/sku-legend/approve",
  "POST /api/submissions/:id/resolve",
  "POST /api/submissions/dismiss-flags",
  "POST /api/submissions/resolve-bulk",
  "POST /api/submissions/verify",
  "POST /api/sync/aura",
  "POST /api/sync/aura/push",
  "POST /api/sync/sourcing-sheet",
  "POST /api/tags",
  "POST /api/upload/velocity",
  "POST /api/velocity/bundle-identity/map",
  "POST /api/velocity/execute",
  "POST /api/view-presets",
  "PUT /api/asins/:asin/buy-link",
  "PUT /api/asins/:asin/cogs",
  "PUT /api/asins/:asin/notes",
  "PUT /api/asins/:asin/promos",
  "PUT /api/asins/:asin/reviewed",
  "PUT /api/asins/:asin/sourcing-type",
  "PUT /api/asins/:asin/tags",
  "PUT /api/asins/archive",
  "PUT /api/asins/status",
  "PUT /api/bulk-lists/:id",
  "PUT /api/bulk-lists/:id/asins/:asin/cogs",
  "PUT /api/bulk-lists/:id/asins/:asin/last-reviewed",
  "PUT /api/bulk-lists/:id/asins/:asin/notes",
  "PUT /api/bulk-lists/:id/asins/:asin/supplier-sku",
  "PUT /api/settings/hazmat",
  "PUT /api/view-presets/:id",
];

describe("route-registration inventory", () => {
  it("every expected /api route is actually registered (running registration, not file text)", async () => {
    const { registerRoutes } = await import("./routes");
    const app = express();
    const httpServer = createServer(app);
    await registerRoutes(httpServer, app);

    const registered = new Set<string>();
    // Express 5: the router is app.router (lazy getter); _router is gone.
    for (const layer of ((app as any).router ?? (app as any)._router)?.stack ?? []) {
      const route = layer.route;
      if (!route?.path) continue;
      for (const method of Object.keys(route.methods)) {
        registered.add(`${method.toUpperCase()} ${route.path}`);
      }
    }

    const missing = EXPECTED_ROUTES.filter((r) => !registered.has(r));
    expect(
      missing,
      `routes LOST from registration (blob-staging slice? see CLAUDE.md):\n${missing.join("\n")}`,
    ).toEqual([]);
    // Sanity: the enumeration itself worked (an empty stack would vacuously pass).
    expect(registered.size).toBeGreaterThanOrEqual(EXPECTED_ROUTES.length);
  });
});
