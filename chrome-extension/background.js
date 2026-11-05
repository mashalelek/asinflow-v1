// AsinFlow Chrome Extension — Background Service Worker
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

importScripts("buckets.js", "scrub.js", "platform-map.js");

const DEFAULT_SERVER_URL = "http://localhost:3000";
const AF_FETCH = { credentials: "include" };
// v1.3.1: the capture records (capture:<tabId>) live in chrome.storage.local — they survive a service-worker restart and an extension update.
const captureStore = chrome.storage.local;
const SETTINGS_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes

let cachedSettings = null;
let settingsTimer = null;

// Get the configured server URL
async function getServerUrl() {
  const stored = await chrome.storage.sync.get(["serverUrl"]);
  return stored.serverUrl || DEFAULT_SERVER_URL;
}

// Fetch settings from AsinFlow server
async function fetchSettings() {
  try {
    const serverUrl = await getServerUrl();
    const response = await fetch(`${serverUrl}/api/settings`, AF_FETCH);
    if (response.ok) {
      cachedSettings = await response.json();
      await chrome.storage.local.set({ afSettings: cachedSettings, afConnected: true });
      return cachedSettings;
    }
    await chrome.storage.local.set({ afConnected: false });
  } catch (err) {
    console.log("AsinFlow server not reachable:", err.message);
    await chrome.storage.local.set({ afConnected: false });
  }
  return cachedSettings;
}

// Start periodic settings refresh
function startSettingsRefresh() {
  fetchSettings();
  if (settingsTimer) clearInterval(settingsTimer);
  settingsTimer = setInterval(fetchSettings, SETTINGS_REFRESH_INTERVAL);
}

// Check if URL is an Amazon product page
function isAmazonProductPage(url) {
  if (!url) return false;
  return /amazon\.com\/(dp\/|.*\/dp\/|gp\/product\/)[A-Z0-9]{10}/i.test(url);
}

// Extract ASIN from an Amazon URL
function asinFromUrl(url) {
  if (!url) return null;
  const m = url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/);
  return m ? m[1] : null;
}

// Broadcast helper — notify side panel (ignore "no receiver" errors)
function broadcastProductUpdate(data) {
  try {
    chrome.runtime.sendMessage({ type: "PRODUCT_DATA_UPDATED", data }).catch(() => {});
  } catch (e) { /* ignore */ }
}

// Clear stale product data when the active tab navigates to a different ASIN
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Fire on URL change (earlier than "complete") so the panel clears quickly
  if (changeInfo.url) {
    const newAsin = asinFromUrl(changeInfo.url);
    const { currentProduct } = await chrome.storage.session.get(["currentProduct"]);
    if (!newAsin) {
      // Navigated off a product page
      if (currentProduct) {
        await chrome.storage.session.remove(["currentProduct"]);
      }
    } else if (currentProduct && currentProduct.asin !== newAsin) {
      // Navigating to a different ASIN — immediately replace with a partial
      // placeholder so the side panel stops showing stale data
      await chrome.storage.session.set({
        currentProduct: {
          asin: newAsin,
          title: null,
          imageUrl: null,
          price: null,
          brand: null,
          category: null,
          weightOz: null,
          lengthIn: null,
          widthIn: null,
          heightIn: null,
          bsr: null,
          url: changeInfo.url,
          _partial: true,
        },
      });
    }
  }

  // Auto-open side panel when the page finishes loading an Amazon product
  if (changeInfo.status !== "complete" || !tab.url) return;

  if (isAmazonProductPage(tab.url)) {
    const stored = await chrome.storage.sync.get(["autoOpen"]);
    const autoOpen = stored.autoOpen !== false; // default true
    if (autoOpen) {
      try {
        await chrome.sidePanel.open({ tabId });
      } catch (err) {
        console.log("Could not open side panel:", err.message);
      }
    }
  }
});

// When the user switches tabs, ask the newly-active tab's content script
// for fresh data so the side panel reflects what they're looking at
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !isAmazonProductPage(tab.url)) {
      await chrome.storage.session.remove(["currentProduct"]);
      return;
    }
    chrome.tabs.sendMessage(tabId, { type: "REQUEST_PRODUCT_DATA" }, (response) => {
      if (chrome.runtime.lastError) return; // content script not ready
      if (response?.data) {
        chrome.storage.session.set({ currentProduct: response.data });
      }
    });
  } catch (err) {
    // Tab may be gone
  }
});

// Handle extension icon click — toggle side panel
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (err) {
    console.log("Could not toggle side panel:", err.message);
  }
});

// Handle messages from content scripts and side panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PRODUCT_DATA") {
    // Validate the data's ASIN matches the sender tab's current URL, so a
    // slow-returning scrape from a previous page can't overwrite fresh data
    (async () => {
      try {
        const data = message.data;
        if (!data || !data.asin) return;
        const senderTabId = sender.tab?.id;
        if (senderTabId != null) {
          const tab = await chrome.tabs.get(senderTabId);
          const tabAsin = asinFromUrl(tab?.url || "");
          if (tabAsin && tabAsin !== data.asin) {
            // Stale — tab has since navigated elsewhere
            return;
          }
          // Only store if the sender tab is the currently active tab,
          // otherwise a background tab's scrape could hijack the panel
          if (!tab.active) return;
        }
        await chrome.storage.session.set({ currentProduct: data });
      } catch (e) { /* ignore */ }
    })();
    return;
  }

  if (message.type === "GET_SETTINGS") {
    (async () => {
      if (!cachedSettings) {
        await fetchSettings();
      }
      const connected = (await chrome.storage.local.get(["afConnected"])).afConnected || false;
      sendResponse({ settings: cachedSettings, connected });
    })();
    return true; // async response
  }

  if (message.type === "GET_CURRENT_PRODUCT") {
    chrome.storage.session.get(["currentProduct"], (result) => {
      sendResponse({ data: result.currentProduct || null });
    });
    return true; // async response
  }

  if (message.type === "REQUEST_PRODUCT_FROM_TAB") {
    // Ask the content script in the active tab for product data
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "REQUEST_PRODUCT_DATA" }, (response) => {
          if (chrome.runtime.lastError) {
            sendResponse({ data: null });
          } else {
            if (response?.data) {
              chrome.storage.session.set({ currentProduct: response.data });
            }
            sendResponse({ data: response?.data || null });
          }
        });
      } else {
        sendResponse({ data: null });
      }
    });
    return true;
  }

  if (message.type === "CHECK_ASIN") {
    (async () => {
      try {
        const serverUrl = await getServerUrl();
        const asin = (message.asin || "").toUpperCase();
        const response = await fetch(`${serverUrl}/api/asins/check/${encodeURIComponent(asin)}`, {
          ...AF_FETCH, signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          const result = await response.json();
          sendResponse({ success: true, ...result });
        } else {
          sendResponse({ success: false, exists: false });
        }
      } catch (err) {
        sendResponse({ success: false, exists: false, message: err.message });
      }
    })();
    return true;
  }

  if (message.type === "IMPORT_ASIN") {
    (async () => {
      try {
        const serverUrl = await getServerUrl();
        const response = await fetch(`${serverUrl}/api/import-asin`, {
          ...AF_FETCH, method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(message.data),
        });
        const result = await response.json();
        if (response.ok) {
          sendResponse({ success: true, ...result });
        } else {
          sendResponse({ success: false, message: result.message || "Import failed" });
        }
      } catch (err) {
        sendResponse({ success: false, message: "Could not connect to AsinFlow server" });
      }
    })();
    return true;
  }

  if (message.type === "TEST_CONNECTION") {
    (async () => {
      try {
        const serverUrl = message.serverUrl || await getServerUrl();
        const response = await fetch(`${serverUrl}/api/credentials-status`, { ...AF_FETCH, signal: AbortSignal.timeout(5000) });
        if (response.ok) {
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, message: response.status === 401 ? "Sign in to AsinFlow in a tab first (the extension uses your session)" : `Server returned ${response.status}` });
        }
      } catch (err) {
        sendResponse({ success: false, message: err.message });
      }
    })();
    return true;
  }

  if (message.type === "REFRESH_SETTINGS") {
    fetchSettings().then(() => sendResponse({ success: true }));
    return true;
  }

  // ── Capture PO ──────────────────────────────────────────────────────────
  if (message.type === "CAPTURE_PAGE") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) { sendResponse({ success: false, message: "Open the retailer's checkout page in the active tab first" }); return; }
        const origin = new URL(tab.url).origin;
        let results;
        try {
          results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["scrub.js", "capture.js"] });
        } catch (err) {
          // No host permission for this site yet: the panel asks for it (a user gesture) and retries.
          sendResponse({ success: false, needsPermission: `${origin}/*`, message: err.message });
          return;
        }
        const page = results?.[0]?.result;
        if (!page || page.error) { sendResponse({ success: false, message: page?.error || "Nothing could be read from this page" }); return; }
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
      sendResponse({ capture: cur || null, tabId: tab?.id ?? null, host, title: tab?.title ?? null, isAmazonProduct: isAmazonProductPage(tab?.url), others });
    })();
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
      body: JSON.stringify({ retailerHost: host, page: { step: page.step, url: page.url, title: page.title, text: page.text, fields: page.fields || [] }, structured: { platform: structured?.platform ?? null, products: !!structured?.filled?.products, totals: !!structured?.filled?.totals } }),
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

// Listen for storage changes (when product data is updated by content script)
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.currentProduct) {
    // Notify side panel that product data changed
    chrome.runtime.sendMessage({ type: "PRODUCT_DATA_UPDATED", data: changes.currentProduct.newValue }).catch(() => {});
  }
});

// Initialize
startSettingsRefresh();
