// Stale-tab detection (2026-10-18). A tab opened before a deploy keeps
// running the old bundle until it is reloaded — that is how the upload fix
// (ca49978) was live on the server while Maria's tab, open since 06:04 ET,
// re-ran the same 11-ASIN upload as jobs #59 and #60 at 11:11 and 11:17.
// The page compares its own entry script with the one the server's
// index.html names now; a difference means a newer build is deployed.

/** The Vite entry script ("/assets/index-<hash>.js") an index.html names, or null. Shared with the server (shared/build-id.ts). */
export { entryScriptFromHtml } from "@shared/build-id";

/** The entry script this page was loaded with (production builds only). */
export function currentEntryScript(doc: Pick<Document, "querySelectorAll">): string | null {
  for (const s of Array.from(doc.querySelectorAll("script[src]")) as HTMLScriptElement[]) {
    const src = s.getAttribute("src") ?? "";
    if (/\/assets\/index-[^/]+\.js$/.test(new URL(src, "http://x").pathname)) return new URL(src, "http://x").pathname;
  }
  return null;
}

/** True only when both are known and differ — an unreadable index never nags. */
export function isStaleBuild(current: string | null, served: string | null): boolean {
  return current != null && served != null && current !== served;
}

/**
 * Stale-page guard, client half (2026-10-18): every same-origin /api request
 * carries this page's build id (X-AF-Build). The server answers a mutating
 * request from another build with 409 STALE_BUILD; that answer fires
 * STALE_BUILD_EVENT, which shows the reload banner. Installed once, before
 * the app renders.
 */
export const STALE_BUILD_EVENT = "af:stale-build";
export function installBuildIdHeader(buildId: string | null, win: { fetch: typeof fetch; location: { origin: string }; dispatchEvent: (e: Event) => boolean } = window as any): void {
  if (!buildId || (win as any).__afBuildHeader) return;
  const original = win.fetch;
  win.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    let url: string;
    try { url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url; } catch { url = ""; }
    const sameOriginApi = (() => { try { const u = new URL(url, win.location.origin); return u.origin === win.location.origin && u.pathname.startsWith("/api/"); } catch { return false; } })();
    if (!sameOriginApi) return original.call(win, input as any, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("X-AF-Build", buildId);
    const res = await original.call(win, input as any, { ...init, headers });
    if (res.status === 409) {
      res.clone().json().then((b: any) => { if (b?.code === "STALE_BUILD") win.dispatchEvent(new Event(STALE_BUILD_EVENT)); }).catch(() => {});
    }
    return res;
  };
  (win as any).__afBuildHeader = true;
}
