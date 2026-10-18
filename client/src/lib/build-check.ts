// Stale-tab detection (2026-10-18). A tab opened before a deploy keeps
// running the old bundle until it is reloaded — that is how the upload fix
// (ca49978) was live on the server while Maria's tab, open since 06:04 ET,
// re-ran the same 11-ASIN upload as jobs #59 and #60 at 11:11 and 11:17.
// The page compares its own entry script with the one the server's
// index.html names now; a difference means a newer build is deployed.

/** The Vite entry script ("/assets/index-<hash>.js") an index.html names, or null. */
export function entryScriptFromHtml(html: string): string | null {
  const m = /<script[^>]*\ssrc="([^"]*\/assets\/index-[^"]+\.js)"/.exec(html);
  return m ? new URL(m[1], "http://x").pathname : null;
}

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
