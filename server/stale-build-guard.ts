// Stale-page guard, server half (2026-10-18). A tab left open on an older
// build kept resending an 11-ASIN upload (jobs 59–68) after the fix shipped.
// Every mutating /api request must carry the current build id (X-AF-Build,
// sent by every client since this build); one with none or an older one is
// refused with 409 "AF was updated — reload this page". Read-only requests
// (GET / HEAD / OPTIONS) keep working. The server's build id is the entry
// script its own index.html names; in dev (Vite, no built index) there is
// none and the guard is off.
//
// Exempt: /api/auth/* (login / logout must work from any page) and every
// route the Chrome extension calls (EXTENSION_API_ROUTES) — the extension is
// not an AF page and has no build id. 2026-11-05: v1.3's POST
// /api/pos/capture-preview was not on the old two-route list and every AI
// preview got 409 (the 2026-11-01 prefill bug again); the list is now one
// place and stale-build-guard.test.ts fails when the extension's source names
// an /api route that is not on it. The PO form the capture opens
// (/pos/new?prefill=<id>) is an AF page and its POST /api/pos carries the
// page's build id like any other.
import fs from "fs";
import path from "path";
import type { Request, Response, NextFunction } from "express";
import { BUILD_HEADER, entryScriptFromHtml } from "@shared/build-id";

export const STALE_BUILD_MESSAGE = "AF was updated — reload this page";
/** Every /api route chrome-extension/ calls (paths relative to /api; ":x" = one path segment). */
export const EXTENSION_API_ROUTES = [
  "/settings", "/credentials-status", "/import-asin", "/asins/check/:asin",
  "/pos/prefill", "/pos/capture-preview", "/pos/capture-config", "/extension/history",
] as const;
const routeRe = (r: string) => new RegExp(`^${r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[a-z]+/gi, "[^/]+")}$`);
const EXEMPT = [/^\/auth\//, ...EXTENSION_API_ROUTES.map(routeRe)];
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/** The production build id: the entry script dist/public/index.html names. Null in dev. */
export function readServerBuildId(publicDir?: string): string | null {
  // __dirname exists only in the production CJS bundle (dist/index.cjs, next
  // to dist/public). Under `npm run dev` (tsx, ESM) it is undefined — the
  // default must not be evaluated there, or the server cannot boot; dev has
  // no built index, so the answer is null (guard off).
  const dir = publicDir ?? (typeof __dirname !== "undefined" ? path.resolve(__dirname, "public") : null);
  if (!dir) return null;
  try { return entryScriptFromHtml(fs.readFileSync(path.join(dir, "index.html"), "utf8")); } catch { return null; }
}

/** Express middleware mounted on /api (req.path is relative to /api). */
export function staleBuildGuard(serverBuildId: string | null) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!serverBuildId || SAFE.has(req.method) || EXEMPT.some((re) => re.test(req.path))) { next(); return; }
    const sent = req.get(BUILD_HEADER);
    if (sent === serverBuildId) { next(); return; }
    res.status(409).json({ message: STALE_BUILD_MESSAGE, code: "STALE_BUILD" });
  };
}
