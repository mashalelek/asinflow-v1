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

// Save settings
saveBtn.addEventListener("click", () => {
  const serverUrl = serverUrlInput.value.trim().replace(/\/+$/, "") || DEFAULT_SERVER_URL;
  const autoOpen = autoOpenCheckbox.checked;

  chrome.storage.sync.set({ serverUrl, autoOpen }, () => {
    saveResult.style.display = "block";
    setTimeout(() => { saveResult.style.display = "none"; }, 2000);

    // Refresh background settings cache
    chrome.runtime.sendMessage({ type: "REFRESH_SETTINGS" });
  });
});

// Test connection
testBtn.addEventListener("click", () => {
  const serverUrl = serverUrlInput.value.trim().replace(/\/+$/, "") || DEFAULT_SERVER_URL;
  testResult.className = "";
  testResult.style.display = "none";
  testBtn.disabled = true;
  testBtn.textContent = "Testing...";

  chrome.runtime.sendMessage({ type: "TEST_CONNECTION", serverUrl }, (response) => {
    testBtn.disabled = false;
    testBtn.textContent = "Test Connection";

    if (response?.success) {
      testResult.textContent = "Connected to AsinFlow server!";
      testResult.className = "success";
    } else {
      testResult.textContent = "Connection failed: " + (response?.message || "Unknown error");
      testResult.className = "error";
    }
    testResult.style.display = "block";
  });
});
