// AsinFlow extensions — shared options page script (core). The server URL and Test connection for both extensions;
// every checkbox with data-sync-key="<key>" is one boolean in chrome.storage.sync (data-default="true" = on when unset).
(function () {
  var C = globalThis.AfCore;
  var serverUrlInput = document.getElementById("server-url");
  var testResult = document.getElementById("test-result"), saveResult = document.getElementById("save-result");
  var boxes = Array.prototype.slice.call(document.querySelectorAll("input[type=checkbox][data-sync-key]"));
  var keys = ["serverUrl"].concat(boxes.map(function (b) { return b.dataset.syncKey; }));
  chrome.storage.sync.get(keys, function (stored) {
    serverUrlInput.value = stored.serverUrl || C.DEFAULT_SERVER_URL;
    boxes.forEach(function (b) { var v = stored[b.dataset.syncKey]; b.checked = v === undefined ? b.dataset.default === "true" : v === true; });
  });
  // The server URL must be a host the extension may fetch with the session cookie: one in host_permissions, or any
  // other https host granted here once through optional_host_permissions (2026-11-01: CORS — the server allows no
  // chrome-extension origin, so a host without permission fails with "Failed to fetch").
  async function ensureHostPermission(serverUrl) {
    var origin;
    try { origin = new URL(serverUrl).origin + "/*"; } catch (e) { return { ok: false, message: "not a valid URL" }; }
    try {
      if (await chrome.permissions.contains({ origins: [origin] })) return { ok: true };
      var granted = await chrome.permissions.request({ origins: [origin] });
      return granted ? { ok: true } : { ok: false, message: "permission for " + origin + " was not granted — the extension cannot reach this server" };
    } catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
  }
  function show(el, text, cls) { el.textContent = text; el.className = cls || ""; el.style.display = "block"; }
  function url() { return serverUrlInput.value.trim().replace(/\/+$/, "") || C.DEFAULT_SERVER_URL; }
  document.getElementById("save-btn").addEventListener("click", async function () {
    var serverUrl = url();
    var perm = await ensureHostPermission(serverUrl);
    if (!perm.ok) show(testResult, "Saved, but: " + perm.message, "error");
    var out = { serverUrl: serverUrl };
    boxes.forEach(function (b) { out[b.dataset.syncKey] = b.checked; });
    chrome.storage.sync.set(out, function () {
      show(saveResult, "Saved"); setTimeout(function () { saveResult.style.display = "none"; }, 2000);
      chrome.runtime.sendMessage({ type: "REFRESH_SETTINGS" }).catch(function () {});
    });
  });
  var testBtn = document.getElementById("test-btn");
  testBtn.addEventListener("click", async function () {
    var serverUrl = url();
    testResult.style.display = "none"; testBtn.disabled = true; testBtn.textContent = "Testing…";
    var perm = await ensureHostPermission(serverUrl);
    var r = perm.ok ? await C.testConnection(serverUrl) : { success: false, message: perm.message };
    testBtn.disabled = false; testBtn.textContent = "Test connection";
    show(testResult, r.success ? "Connected" : "Connection failed: " + (r.message || "Unknown error"), r.success ? "success" : "error");
  });
})();
