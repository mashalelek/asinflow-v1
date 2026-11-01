// AsinFlow Chrome Extension — Background Service Worker
//
// Every request to AsinFlow sends the session cookie (credentials: "include",
// SPEC §25 — every /api route needs a session; the server URL must be in
// host_permissions). Sign in to AsinFlow in a normal tab first; a 401 is
// reported as "Sign in to AsinFlow".
//
// Capture PO (patch docs/claude_spec-patch-po-ai-prefill.md §4; v1.2 SPEC
// §11): the panel's "Capture this page" injects scrub.js + capture.js into
// the active tab and stores the scrubbed result in chrome.storage.session
// under the tab id (one record per tab — buckets.js applyPage): one page
// entry per checkout step (the latest capture of a step replaces the
// previous one) plus the six data buckets, merged newest-wins per field.
// "Open in AF" POSTs the pages (and the selected ship-to) to
// /api/pos/prefill (one AI call, server side) and opens /pos/new?prefill=<id>
// in a new tab; the capture is cleared on success, on Clear, or when the
// tab closes.

importScripts("buckets.js");

const DEFAULT_SERVER_URL = "http://localhost:3000";
const AF_FETCH = { credentials: "include" };
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
        const prev = (await chrome.storage.session.get([key]))[key] || null;
        const cur = AfBuckets.applyPage(prev, page, new URL(tab.url).hostname, new Date().toISOString());
        await chrome.storage.session.set({ [key]: cur });
        sendResponse({ success: true, capture: cur, step: page.step, chars: page.chars });
      } catch (err) { sendResponse({ success: false, message: err.message }); }
    })();
    return true;
  }
  if (message.type === "GET_CAPTURE") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const all = await chrome.storage.session.get(null);
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
      if (tab?.id) await chrome.storage.session.remove([AfBuckets.captureKey(tab.id)]);
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
        const cur = key ? (await chrome.storage.session.get([key]))[key] : null;
        if (!cur || !cur.count) { sendResponse({ success: false, message: "Nothing captured yet" }); return; }
        const pages = AfBuckets.pagesForPrefill(cur);
        const shipTo = AfBuckets.shipToForPrefill(cur); // the SELECTED address (or the ambiguous candidates) — the server leaves Ships to blank when ambiguous
        const serverUrl = await getServerUrl();
        const r = await fetch(`${serverUrl}/api/pos/prefill`, {
          ...AF_FETCH, method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ retailerHost: cur.host, capturedAt: cur.updatedAt, pages, ...(shipTo ? { shipTo } : {}) }),
          signal: AbortSignal.timeout(90000),
        });
        const data = await r.json().catch(() => ({}));
        if (r.status === 401) { sendResponse({ success: false, message: "Sign in to AsinFlow in a tab first — the extension uses your session" }); return; }
        if (!r.ok) { sendResponse({ success: false, message: data.message || `AsinFlow answered ${r.status}` }); return; }
        await chrome.tabs.create({ url: `${serverUrl}${data.url}` });
        await chrome.storage.session.remove([key]);
        sendResponse({ success: true, lines: data.lines, warnings: data.warnings || [], schema_ok: data.schema_ok });
      } catch (err) { sendResponse({ success: false, message: /abort|timeout/i.test(err.message) ? "AsinFlow did not answer in time — the capture is kept, try again" : `AsinFlow is unreachable — the capture is kept (${err.message})` }); }
    })();
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => { chrome.storage.session.remove([AfBuckets.captureKey(tabId)]).catch(() => {}); });

// Listen for storage changes (when product data is updated by content script)
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.currentProduct) {
    // Notify side panel that product data changed
    chrome.runtime.sendMessage({ type: "PRODUCT_DATA_UPDATED", data: changes.currentProduct.newValue }).catch(() => {});
  }
});

// Initialize
startSettingsRefresh();
