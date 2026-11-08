// AsinFlow Capture PO — Background Service Worker (the extension split 2026-11-05: the Amazon product-page
// calculator is its own extension, AsinFlow Analyzer, chrome-extension/analyzer/; this one never runs on an Amazon
// site — its side panel is switched off per tab there, and a capture there is refused).
//
// Every request to AsinFlow sends the session cookie (credentials: "include",
// SPEC §25 — every /api route needs a session; the server URL must be in
// host_permissions). Sign in to AsinFlow in a normal tab first; a 401 is
// reported as "Sign in to AsinFlow".
//
// Capture PO (patch docs/claude_spec-patch-po-ai-prefill.md §4; v1.2 SPEC
// §11): the panel's "Capture this page" injects scrub.js + capture.js into
// the active tab and stores the scrubbed result in chrome.storage.local
// under the tab id (one record per tab — buckets.js applyPage): every
// capture is its own page (v1.3.1 — nothing is replaced by step or URL)
// plus the six data buckets, merged newest-wins per field. v1.3.1: local,
// not session, so a service-worker restart or an extension update loses
// nothing; navigation, reloads, redirects and SPA route changes in the tab
// never touch the record.
// "Open in AF" POSTs the pages (and the selected ship-to) to
// /api/pos/prefill (one AI call, server side) and opens /pos/new?prefill=<id>
// in a new tab; the capture is cleared on success, on Clear, or when the
// tab closes — nothing else (a browser restart renumbers the tabs, so the
// records of tabs that no longer exist go at startup; a prerendered tab
// that replaces this one takes its record).
//
// v1.3 (Maria 2026-11-04): after each capture the page's scrubbed text goes
// to /api/pos/capture-preview — one small AI extraction that fills the
// buckets (the rule-based ones show at once; these replace them when they
// answer). Cached per page key (a SHA-256 of host + text + fields): a page
// recaptured unchanged never calls again. "Open in AF" stays the one full
// prefill call and also sends the checkout email the buckets found.

importScripts("core/af-client.js", "buckets.js", "core/scrub.js", "platform-map.js");

// v1.3.1: the capture records (capture:<tabId>) live in chrome.storage.local — they survive a service-worker restart and an extension update.
const captureStore = chrome.storage.local;
const getServerUrl = () => AfCore.getServerUrl();
const AF_FETCH = AfCore.AF_FETCH;

// ── Never on Amazon (2026-11-05) ───────────────────────────────────────────
// The side panel is off on every Amazon tab (amazon.*, Seller Central) — Analyzer owns those — and on for the rest.
async function gatePanel(tabId, url) {
  if (tabId == null) return;
  try { await chrome.sidePanel.setOptions({ tabId, path: "sidepanel.html", enabled: !AfCore.isAmazonUrl(url) }); } catch (e) { /* tab gone */ }
}
chrome.tabs.onUpdated.addListener((tabId, change, tab) => { if (change.url || change.status === "loading") gatePanel(tabId, change.url || tab.url); });
chrome.tabs.onActivated.addListener(async ({ tabId }) => { try { const t = await chrome.tabs.get(tabId); gatePanel(tabId, t.url); } catch (e) { /* tab gone */ } });
async function gateAllTabs() { for (const t of await chrome.tabs.query({})) gatePanel(t.id, t.url); }
chrome.runtime.onStartup.addListener(() => { gateAllTabs().catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { gateAllTabs().catch(() => {}); });

// The toolbar icon opens the panel — never on an Amazon tab.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
chrome.action.onClicked.addListener(async (tab) => {
  if (AfCore.isAmazonUrl(tab.url)) return;
  try { await chrome.sidePanel.open({ tabId: tab.id }); } catch (err) { console.log("Could not open side panel:", err.message); }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "TEST_CONNECTION") {
    AfCore.testConnection(message.serverUrl).then(sendResponse);
    return true;
  }
  if (message.type === "REFRESH_SETTINGS") { sendResponse({ success: true }); return; }
  // ── Capture PO ──────────────────────────────────────────────────────────
  if (message.type === "CAPTURE_PAGE") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) { sendResponse({ success: false, message: "Open the retailer's checkout page in the active tab first" }); return; }
        if (AfCore.isAmazonUrl(tab.url)) { sendResponse({ success: false, message: "Capture PO does not run on Amazon — AsinFlow Analyzer handles Amazon pages" }); return; }
        const origin = new URL(tab.url).origin;
        let results;
        try {
          results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["core/scrub.js", "capture.js"] });
        } catch (err) {
          // No host permission for this site yet: the panel asks for it (a user gesture) and retries.
          sendResponse({ success: false, needsPermission: `${origin}/*`, message: err.message });
          return;
        }
        const raw = results?.[0]?.result;
        if (!raw || raw.error) { sendResponse({ success: false, message: raw?.error || "Nothing could be read from this page" }); return; }
        // 2.0.4: every string within the server's limits (a cut field says truncated) — one long label never rejects a capture.
        const page = AfBuckets.clipPage(raw);
        const key = AfBuckets.captureKey(tab.id);
        const host = new URL(tab.url).hostname;
        page.previewKey = await pageKey(host, page);
        const prev = (await captureStore.get([key]))[key] || null;
        const cur = AfBuckets.applyPage(prev, page, host, new Date().toISOString());
        await captureStore.set({ [key]: cur });
        sendResponse({ success: true, capture: cur, step: page.step, chars: page.chars });
        // v1.4, after answering: the structured reader (platform data, in the page's own world) lands first, then the
        // AI preview — the panel shows the rules now and each layer when it lands.
        (async () => {
          const structured = await readStructured(tab.id);
          const now = (await captureStore.get([key]))[key];
          if (now) await captureStore.set({ [key]: AfBuckets.applyStructured(now, page.previewKey, structured) });
          if (AfBuckets.needsPreview(prev, page.previewKey)) requestPreview(key, host, page, structured);
        })().catch(() => { if (AfBuckets.needsPreview(prev, page.previewKey)) requestPreview(key, host, page, null); });
      } catch (err) { sendResponse({ success: false, message: err.message }); }
    })();
    return true;
  }
  if (message.type === "GET_CAPTURE") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const all = await captureStore.get(null);
      const cur = tab?.id ? all[AfBuckets.captureKey(tab.id)] : null;
      let host = null; try { host = tab?.url ? new URL(tab.url).hostname : null; } catch { /* about:, chrome: */ }
      // v1.2: captures are per tab; the panel lists the other tabs with a capture in progress.
      const others = tab?.id != null ? AfBuckets.othersCapturing(all, tab.id) : [];
      sendResponse({ capture: cur || null, tabId: tab?.id ?? null, host, url: tab?.url ?? null, title: tab?.title ?? null, isAmazon: AfCore.isAmazonUrl(tab?.url), others });
    })();
    return true;
  }
  // Purchase history (2026-11-05, SPEC §11): AF's past POs for this supplier / listing — GET only, AF data, no AI.
  if (message.type === "HISTORY") {
    AfCore.afJson(`/api/extension/history?${message.query || ""}`).then(sendResponse).catch((e) => sendResponse({ ok: false, message: String(e?.message || e) }));
    return true;
  }
  // The product the page itself names (a retailer product page): schema.org Product, else og:title when og:type is product.
  // Only once the site's read permission is granted (the first Capture asks for it) — never on Amazon; nothing else read.
  if (message.type === "PAGE_PRODUCT") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || !/^https?:/.test(tab.url || "") || AfCore.isAmazonUrl(tab.url)) { sendResponse(null); return; }
        if (!(await chrome.permissions.contains({ origins: [new URL(tab.url).origin + "/*"] }))) { sendResponse(null); return; }
        const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPageProduct });
        const p = res?.result;
        sendResponse(p && p.name ? { name: AfScrub.scrubText(String(p.name)).slice(0, 300), sku: p.sku ? AfScrub.scrubText(String(p.sku)).slice(0, 60) : null } : null);
      } catch (e) { sendResponse(null); }
    })();
    return true;
  }
  // Supplier verification (2026-11-05, SPEC §11): the stored check (GET), or the one AI web-search check on click (POST).
  if (message.type === "SUPPLIER_CHECK_GET" || message.type === "SUPPLIER_CHECK_RUN") {
    const host = String(message.host || "");
    const p = message.type === "SUPPLIER_CHECK_GET"
      ? AfCore.afJson(`/api/extension/supplier-check?supplier=${encodeURIComponent(host)}`)
      : AfCore.afJson("/api/extension/supplier-check", { method: "POST", body: { supplier: host }, timeoutMs: 120000 });
    p.then(sendResponse).catch((e) => sendResponse({ ok: false, message: String(e?.message || e) }));
    return true;
  }
  if (message.type === "CLEAR_CAPTURE") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) await captureStore.remove([AfBuckets.captureKey(tab.id)]);
      sendResponse({ success: true });
    })();
    return true;
  }
  if (message.type === "GET_CAPTURE_CONFIG") {
    (async () => {
      try {
        const serverUrl = await getServerUrl();
        const r = await fetch(`${serverUrl}/api/pos/capture-config`, { ...AF_FETCH, signal: AbortSignal.timeout(5000) });
        sendResponse(r.ok ? { success: true, config: await r.json() } : { success: false, status: r.status });
      } catch (err) { sendResponse({ success: false, message: err.message }); }
    })();
    return true;
  }
  if (message.type === "OPEN_IN_AF") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const key = tab?.id ? AfBuckets.captureKey(tab.id) : null;
        const cur = key ? (await captureStore.get([key]))[key] : null;
        if (!cur || !cur.count) {
          // v1.2.4: never gated — no pages captured → a blank New PO with the supplier prefilled from the tab's hostname, no model call.
          const serverUrl0 = await getServerUrl();
          let host = ""; try { host = new URL(tab?.url || "").hostname.replace(/^www\./, ""); } catch (e) { host = ""; }
          await chrome.tabs.create({ url: `${serverUrl0}/pos/new${host ? `?supplier=${encodeURIComponent(host)}` : ""}` });
          sendResponse({ success: true, blank: true, host });
          return;
        }
        const pages = AfBuckets.pagesForPrefill(cur);
        const shipTo = AfBuckets.shipToForPrefill(cur); // the SELECTED address (or the ambiguous candidates) — the server leaves Ships to blank when ambiguous
        const checkoutEmail = AfBuckets.checkoutEmailForPrefill(cur); // v1.3: the email the checkout showed beats the supplier default
        const serverUrl = await getServerUrl();
        const r = await fetch(`${serverUrl}/api/pos/prefill`, {
          ...AF_FETCH, method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ retailerHost: cur.host, capturedAt: cur.updatedAt, pages, ...(shipTo ? { shipTo } : {}), ...(checkoutEmail ? { checkoutEmail } : {}) }),
          signal: AbortSignal.timeout(90000),
        });
        const data = await r.json().catch(() => ({}));
        if (r.status === 401) { sendResponse({ success: false, message: "Sign in to AsinFlow in a tab first — the extension uses your session" }); return; }
        if (!r.ok) { sendResponse({ success: false, message: data.message || `AsinFlow answered ${r.status}` }); return; }
        await chrome.tabs.create({ url: `${serverUrl}${data.url}` });
        await captureStore.remove([key]);
        sendResponse({ success: true, lines: data.lines, warnings: data.warnings || [], schema_ok: data.schema_ok });
      } catch (err) { sendResponse({ success: false, message: /abort|timeout/i.test(err.message) ? "AsinFlow did not answer in time — the capture is kept, try again" : `AsinFlow is unreachable — the capture is kept (${err.message})` }); }
    })();
    return true;
  }
});

// ── Capture PO v1.3: the AI preview ────────────────────────────────────────
/** SHA-256 (hex, 32 chars) of host + text + fields — the per-page cache key. */
async function pageKey(host, page) {
  const fields = (page.fields || []).map((f) => `${f.label}\u0001${f.value}`).join("\n");
  const data = new TextEncoder().encode(`${String(host).toLowerCase().replace(/^www\./, "")}\n\u0000${page.text || ""}\n\u0000${fields}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
/** Every string in the structured reader's buckets through the page scrubber (scrub.js) — a card number never leaves the worker. */
function scrubDeep(v) {
  if (typeof v === "string") return AfScrub.scrubText(v);
  if (Array.isArray(v)) return v.map(scrubDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x)]));
  return v;
}
/** v1.4: the structured reader — platform.js in the page's MAIN world (read-only; picked fields only) → buckets (platform-map.js), scrubbed. Null when the page has nothing structured or the reader could not run. */
async function readStructured(tabId) {
  try {
    const r = await chrome.scripting.executeScript({ target: { tabId }, files: ["platform.js"], world: "MAIN" });
    const mapped = AfPlatform.toBuckets(r?.[0]?.result || null);
    return mapped ? scrubDeep(mapped) : null;
  } catch { return null; }
}
/** POST one page to /api/pos/capture-preview and lay the answer over the tab's buckets (re-reading the record — another capture may have landed meanwhile). */
async function requestPreview(storeKey, host, page, structured) {
  let buckets = null, error = null;
  try {
    const serverUrl = await getServerUrl();
    const r = await fetch(`${serverUrl}/api/pos/capture-preview`, {
      ...AF_FETCH, method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retailerHost: host, page: (({ step, url, title, text, fields }) => ({ step, url, title, text, fields: fields || [] }))(AfBuckets.clipPage(page)), structured: { platform: structured?.platform ?? null, products: !!structured?.filled?.products, totals: !!structured?.filled?.totals } }),
      signal: AbortSignal.timeout(60000),
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) error = "AI preview: sign in to AsinFlow";
    else if (r.status === 503) error = "AI preview is off";
    else if (!r.ok) error = `AI preview failed (${r.status}${data.message ? `: ${String(data.message).slice(0, 120)}` : ""})`;
    else if (!data.buckets) error = "AI preview could not read this page";
    else buckets = data.buckets;
  } catch (err) { error = /abort|timeout/i.test(err.message) ? "AI preview timed out" : "AI preview: AsinFlow is unreachable"; }
  const cur = (await captureStore.get([storeKey]))[storeKey];
  if (!cur) return; // cleared or opened meanwhile
  await captureStore.set({ [storeKey]: AfBuckets.applyPreview(cur, page.previewKey, buckets, error) });
}

// v1.3.1: a tab's capture goes only when the tab closes (or Clear / Open in AF above).
chrome.tabs.onRemoved.addListener((tabId) => { captureStore.remove([AfBuckets.captureKey(tabId)]).catch(() => {}); });
// A prerendered / instant page swaps in a new tab id for the same tab: the record follows it.
chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  const from = AfBuckets.captureKey(removedTabId), to = AfBuckets.captureKey(addedTabId);
  const cur = (await captureStore.get([from]))[from];
  if (!cur) return;
  await captureStore.set({ [to]: cur });
  await captureStore.remove([from]);
});
// Tab ids are not stable across browser restarts: records of tabs that no longer exist go (local storage outlives the session).
async function dropOrphanCaptures() {
  const [all, tabs] = await Promise.all([captureStore.get(null), chrome.tabs.query({})]);
  const stale = AfBuckets.orphanCaptureKeys(all, tabs.map((t) => t.id));
  if (stale.length) await captureStore.remove(stale);
}
chrome.runtime.onStartup.addListener(() => { dropOrphanCaptures().catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { dropOrphanCaptures().catch(() => {}); });
// 2.0.2: on install / update, the capture records already in storage are scrubbed again with this build's rules — a
// page captured by an older build (Gordon's SECNO_NEW security code, 2026-11-05) keeps no payment-form value.
async function rescrubStoredCaptures() {
  const all = await captureStore.get(null), out = {};
  for (const [k, cap] of Object.entries(all || {})) {
    if (!k.startsWith("capture:") || !cap) continue;
    const before = JSON.stringify(cap);
    const fix = (p) => (p && Array.isArray(p.fields) ? { ...p, fields: AfScrub.rescrubFields(p.fields) } : p);
    const next = { ...cap };
    if (Array.isArray(cap.captures)) next.captures = cap.captures.map(fix);
    if (cap.pages) next.pages = Object.fromEntries(Object.entries(cap.pages).map(([s, p]) => [s, fix(p)]));
    if (Array.isArray(cap.others)) next.others = cap.others.map(fix);
    if (JSON.stringify(next) !== before) out[k] = next;
  }
  if (Object.keys(out).length) await captureStore.set(out);
}
chrome.runtime.onInstalled.addListener(() => { rescrubStoredCaptures().catch(() => {}); });

// Runs in the retailer's page (PAGE_PRODUCT): the product's name and SKU / GTIN only.
function readPageProduct() {
  const flat = (x) => (Array.isArray(x) ? x.flatMap(flat) : x && typeof x === "object" ? [x, ...flat(x["@graph"] || [])] : []);
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    let j; try { j = JSON.parse(s.textContent || ""); } catch (e) { continue; }
    const p = flat(j).find((o) => [].concat(o["@type"] || []).includes("Product"));
    if (p && p.name) return { name: String(p.name), sku: p.sku || p.gtin13 || p.gtin12 || p.gtin || p.mpn || null };
  }
  const og = document.querySelector('meta[property="og:type"]')?.content === "product" ? document.querySelector('meta[property="og:title"]')?.content : null;
  const name = og || null;
  return name ? { name, sku: null } : null;
}
