// The build id (2026-10-18): the Vite entry script a page was built with —
// "/assets/index-<hash>.js". The client sends it on every API request
// (X-AF-Build); the server reads its own from the index.html it serves and
// refuses mutating requests from any other build (server/stale-build-guard.ts).

export const BUILD_HEADER = "x-af-build";

/** The entry script an index.html names, or null. */
export function entryScriptFromHtml(html: string): string | null {
  const m = /<script[^>]*\ssrc="([^"]*\/assets\/index-[^"]+\.js)"/.exec(html);
  return m ? new URL(m[1], "http://x").pathname : null;
}
