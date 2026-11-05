// AsinFlow Analyzer — Background Service Worker (the extension split 2026-11-05, SPEC §11): everything on Amazon
// product pages — product info from content.js, COGS / sale price / fees / profit (the side panel), Update in
// AsinFlow (import-asin), auto-open on product pages, the Amazon-page purchase history. Only amazon.* and Seller
// Central: the side panel is switched off on every other tab (Capture PO, chrome-extension/, has those).
// Every request to AsinFlow sends the session cookie (core/af-client.js; sign in to AsinFlow in a tab first).

importScripts("core/af-client.js");

const SETTINGS_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes
const AF_FETCH = AfCore.AF_FETCH;
const getServerUrl = () => AfCore.getServerUrl();

// ── Only on Amazon (2026-11-05) ─────────────────────────────────────────────
async function gatePanel(tabId, url) {
  if (tabId == null) return;
  try { await chrome.sidePanel.setOptions({ tabId, path: "sidepanel.html", enabled: AfCore.isAmazonUrl(url) }); } catch (e) { /* tab gone */ }
}
chrome.tabs.onUpdated.addListener((tabId, change, tab) => { if (change.url || change.status === "loading") gatePanel(tabId, change.url || tab.url); });
chrome.tabs.onActivated.addListener(async ({ tabId }) => { try { const t = await chrome.tabs.get(tabId); gatePanel(tabId, t.url); } catch (e) { /* tab gone */ } });
async function gateAllTabs() {
  await chrome.sidePanel.setOptions({ enabled: false }).catch(() => {}); // default off; Amazon tabs turn it on
  for (const t of await chrome.tabs.query({})) gatePanel(t.id, t.url);
}
chrome.runtime.onStartup.addListener(() => { gateAllTabs().catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { gateAllTabs().catch(() => {}); });


let cachedSettings = null;
let settingsTimer = null;


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

// Handle extension icon click — open the side panel (Amazon tabs only)
chrome.action.onClicked.addListener(async (tab) => {
  if (!AfCore.isAmazonUrl(tab.url)) return;
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

  // Purchase history (2026-11-05, SPEC §11): AF's past POs for this ASIN — GET only, AF data, no AI.
  if (message.type === "HISTORY") {
    const asin = String(message.asin || "").toUpperCase();
    AfCore.afJson(`/api/extension/history?asin=${encodeURIComponent(asin)}`).then(sendResponse).catch((e) => sendResponse({ ok: false, message: String(e?.message || e) }));
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

  if (message.type === "REFRESH_SETTINGS") {
    fetchSettings().then(() => sendResponse({ success: true }));
    return true;
  }

  if (message.type === "TEST_CONNECTION") { AfCore.testConnection(message.serverUrl).then(sendResponse); return true; }
});

// Listen for storage changes (when product data is updated by content script)
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.currentProduct) {
    // Notify side panel that product data changed
    chrome.runtime.sendMessage({ type: "PRODUCT_DATA_UPDATED", data: changes.currentProduct.newValue }).catch(() => {});
  }
});

// Initialize
startSettingsRefresh();

