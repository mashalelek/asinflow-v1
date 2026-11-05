// AsinFlow extensions — shared core (2026-11-05: two extensions from one repo, SPEC §11): the AF client both
// AsinFlow Capture PO (chrome-extension/) and AsinFlow Analyzer (chrome-extension/analyzer/) use. Every request
// sends the session cookie (credentials: "include", SPEC §25 — sign in to AsinFlow in a tab first); the server URL
// is each extension's own options setting (chrome.storage.sync, per extension). Every AF route either extension
// calls is listed in core/extension-routes.json and exempt from the stale-page guard (server/stale-build-guard.ts).
// Plain script: defines globalThis.AfCore (service worker importScripts, options page <script>).
// The Analyzer's copy of core/ is kept identical by `npm run ext:sync-core` (server/extension-split.test.ts).
(function (root) {
  var DEFAULT_SERVER_URL = "http://localhost:3000";
  var AF_FETCH = { credentials: "include" };
  async function getServerUrl() {
    var stored = await chrome.storage.sync.get(["serverUrl"]);
    return stored.serverUrl || DEFAULT_SERVER_URL;
  }
  /** One AF call → { ok, status, data } (data = the parsed JSON, {} when none). Never throws for an HTTP status. */
  async function afJson(path, opts) {
    opts = opts || {};
    var serverUrl = opts.serverUrl || await getServerUrl();
    var init = Object.assign({}, AF_FETCH, { method: opts.method || "GET" });
    if (opts.body !== undefined) { init.headers = { "Content-Type": "application/json" }; init.body = JSON.stringify(opts.body); }
    if (opts.timeoutMs) init.signal = AbortSignal.timeout(opts.timeoutMs);
    var r = await fetch(serverUrl + path, init);
    var data = await r.json().catch(function () { return {}; });
    return { ok: r.ok, status: r.status, data: data, serverUrl: serverUrl };
  }
  /** The options page's "Test connection". */
  async function testConnection(serverUrl) {
    try {
      var r = await afJson("/api/credentials-status", { serverUrl: serverUrl, timeoutMs: 5000 });
      return r.ok ? { success: true } : { success: false, message: r.status === 401 ? "Sign in to AsinFlow in a tab first (the extension uses your session)" : "Server returned " + r.status };
    } catch (e) { return { success: false, message: String((e && e.message) || e) }; }
  }
  /** Any Amazon site — amazon.com, amazon.co.uk, sellercentral.amazon.com … (Capture PO never runs there; Analyzer only there). */
  function isAmazonUrl(url) { return /^https?:\/\/([a-z0-9-]+\.)*amazon\.[a-z.]{2,8}(\/|$)/i.test(String(url || "")); }
  var api = { DEFAULT_SERVER_URL: DEFAULT_SERVER_URL, AF_FETCH: AF_FETCH, getServerUrl: getServerUrl, afJson: afJson, testConnection: testConnection, isAmazonUrl: isAmazonUrl };
  root.AfCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
