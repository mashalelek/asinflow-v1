// AsinFlow Chrome Extension — Options Page

const DEFAULT_SERVER_URL = "http://localhost:3000";

const serverUrlInput = document.getElementById("server-url");
const autoOpenCheckbox = document.getElementById("auto-open");
const saveBtn = document.getElementById("save-btn");
const testBtn = document.getElementById("test-btn");
const testResult = document.getElementById("test-result");
const saveResult = document.getElementById("save-result");

// Load saved settings
chrome.storage.sync.get(["serverUrl", "autoOpen"], (stored) => {
  serverUrlInput.value = stored.serverUrl || DEFAULT_SERVER_URL;
  autoOpenCheckbox.checked = stored.autoOpen !== false;
});

// The server URL must be a host the extension may fetch with the session
// cookie: a host in host_permissions (localhost, the Render host, the custom
// domain) bypasses CORS; any other https host is asked for here, once, through
// optional_host_permissions (2026-11-01: the custom domain was not in the
// manifest, so "Open in AF" failed with "Failed to fetch" — CORS, by design the
// server allows no chrome-extension origin).
async function ensureHostPermission(serverUrl) {
  let origin;
  try { origin = new URL(serverUrl).origin + "/*"; } catch { return { ok: false, message: "not a valid URL" }; }
  try {
    if (await chrome.permissions.contains({ origins: [origin] })) return { ok: true };
    const granted = await chrome.permissions.request({ origins: [origin] });
    return granted ? { ok: true } : { ok: false, message: `permission for ${origin} was not granted — the extension cannot reach this server` };
  } catch (e) {
    return { ok: false, message: String(e?.message || e) };
  }
}

// Save settings
saveBtn.addEventListener("click", async () => {
  const serverUrl = serverUrlInput.value.trim().replace(/\/+$/, "") || DEFAULT_SERVER_URL;
  const autoOpen = autoOpenCheckbox.checked;

  const perm = await ensureHostPermission(serverUrl);
  if (!perm.ok) {
    testResult.textContent = "Saved, but: " + perm.message;
    testResult.className = "error";
    testResult.style.display = "block";
  }
  chrome.storage.sync.set({ serverUrl, autoOpen }, () => {
    saveResult.style.display = "block";
    setTimeout(() => { saveResult.style.display = "none"; }, 2000);

    // Refresh background settings cache
    chrome.runtime.sendMessage({ type: "REFRESH_SETTINGS" });
  });
});

// Test connection
testBtn.addEventListener("click", async () => {
  const serverUrl = serverUrlInput.value.trim().replace(/\/+$/, "") || DEFAULT_SERVER_URL;
  testResult.className = "";
  testResult.style.display = "none";
  testBtn.disabled = true;
  testBtn.textContent = "Testing…";
  const perm = await ensureHostPermission(serverUrl);
  if (!perm.ok) {
    testBtn.disabled = false; testBtn.textContent = "Test connection";
    testResult.textContent = "Connection failed: " + perm.message; testResult.className = "error"; testResult.style.display = "block";
    return;
  }

  chrome.runtime.sendMessage({ type: "TEST_CONNECTION", serverUrl }, (response) => {
    testBtn.disabled = false;
    testBtn.textContent = "Test connection";

    if (response?.success) {
      testResult.textContent = "Connected";
      testResult.className = "success";
    } else {
      testResult.textContent = "Connection failed: " + (response?.message || "Unknown error");
      testResult.className = "error";
    }
    testResult.style.display = "block";
  });
});
