// AsinFlow Chrome Extension — Capture PO side panel (patch
// docs/claude_spec-patch-po-ai-prefill.md §4.1). Shown whenever the active tab
// is not an Amazon product page (the calculator keeps those). Hints only:
// the step chips tick when a page of that step was captured; Maria can
// capture any page any number of times. "Found so far" is a regex-level
// pre-extraction of the scrubbed text (no AI) so she can see the capture
// worked; "Open in AF" makes the one AI call, server side.
(function () {
  "use strict";
  const el = (id) => document.getElementById(id);
  const root = el("capture-content"), emptyState = el("empty-state"), productContent = el("product-content");
  const retailerEl = el("capture-retailer"), newSupplierEl = el("capture-new-supplier"), orderEl = el("capture-order"), badgeEl = el("capture-shipto-badge");
  const chips = Array.from(document.querySelectorAll("#capture-chips .capture-chip"));
  const captureBtn = el("capture-btn"), statusEl = el("capture-status"), foundEl = el("capture-found"), openBtn = el("capture-open-btn"), clearBtn = el("capture-clear-btn"), feedback = el("capture-feedback");
  let config = null; // { velocityStreet, homeStreets, prepCost, suppliers }
  let current = null; // the stored capture for the active tab

  const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? { success: false, message: chrome.runtime.lastError.message } : r)));
  const money = /(-?\$?\s?\d[\d,]*\.\d{2})/;
  const norm = (s) => { const m = /\b(\d{1,6})\s+([A-Za-z][A-Za-z'-]*)/.exec(s || ""); return m ? `${m[1]} ${m[2].toLowerCase()}` : null; };

  /** Regex-level facts from the captured pages (anything unclear is simply not shown). */
  function preExtract(cap) {
    const texts = [...Object.values(cap.pages || {}), ...(cap.others || [])].map((p) => p.text || "");
    const all = texts.join("\n");
    const f = {};
    const order = /\border\s*(?:#|number|no\.?|id)\s*:?\s*([A-Z0-9][A-Z0-9-]{4,})/i.exec(all);
    if (order) f.order = order[1];
    const amt = (label) => { const m = new RegExp(`\\b${label}\\b[^\\n$\\d-]{0,24}` + money.source, "i").exec(all); return m ? m[1].replace(/\s/g, "") : null; };
    f.subtotal = amt("subtotal"); f.discount = amt("(?:discount|savings|promotion)"); f.tax = amt("(?:estimated )?tax"); f.shipping = amt("(?:estimated )?shipping"); f.total = amt("(?:order )?total");
    const qty = all.match(/\b(?:qty|quantity)\s*:?\s*\d+/gi); if (qty) f.lines = qty.length;
    const ship = /(?:deliver(?:s|y|ing)?\s*(?:to|address)|ship(?:ping)?\s*(?:to|address)|delivery\s*address)[^\n]*\n?([^\n]*\d{1,6}\s+[A-Za-z][^\n]*)/i.exec(all);
    if (ship) f.shipTo = ship[1].trim(); else { const line = all.split("\n").find((l) => /\b\d{1,6}\s+(grandy|rivercrest)\b/i.test(l)); if (line) f.shipTo = line.trim(); }
    const pays = all.match(/[^\n]*•••• ?\d{4}[^\n]*/g); if (pays) f.payments = Array.from(new Set(pays.map((p) => p.trim()))).slice(0, 4);
    return f;
  }

  function shipToKind(street) {
    if (!config || !street) return null;
    const n = norm(street);
    if (!n) return null;
    if (n === norm(config.velocityStreet)) return "Velocity";
    if ((config.homeStreets || []).some((h) => norm(h) === n)) return "Home";
    return null;
  }

  function render(info) {
    const cap = info.capture;
    current = cap;
    const host = (cap && cap.host) || info.host || "—";
    retailerEl.textContent = host.replace(/^www\./, "");
    newSupplierEl.style.display = config && config.suppliers && !config.suppliers.includes(host.replace(/^www\./, "").toLowerCase()) && host !== "—" ? "" : "none";
    const f = cap ? preExtract(cap) : {};
    orderEl.textContent = f.order ? `Order # ${f.order}` : "Order # not seen yet";
    const kind = shipToKind(f.shipTo);
    badgeEl.style.display = kind ? "" : "none"; badgeEl.textContent = kind || "";
    const stepNow = currentStepGuess(info);
    chips.forEach((c) => { const s = c.dataset.step; c.classList.toggle("done", !!(cap && cap.pages && cap.pages[s])); c.classList.toggle("current", s === stepNow); });
    const n = cap ? cap.count : 0;
    statusEl.textContent = `${n} page${n === 1 ? "" : "s"} captured · card numbers masked before anything leaves the browser`;
    openBtn.disabled = !n; clearBtn.disabled = !n;
    foundEl.innerHTML = "";
    const rows = [];
    if (f.lines) rows.push(["Lines", `${f.lines} qty line${f.lines === 1 ? "" : "s"}`]);
    if (f.shipTo) rows.push(["Ship to", f.shipTo + (kind ? ` · ${kind}` : "")]);
    for (const [k, l] of [["subtotal", "Subtotal"], ["discount", "Discount"], ["tax", "Tax"], ["shipping", "Shipping"], ["total", "Total"]]) if (f[k]) rows.push([l, f[k]]);
    if (f.payments) rows.push(["Payment", f.payments.join(" · ")]);
    if (rows.length === 0) { const dd = document.createElement("dd"); dd.className = "capture-muted"; dd.textContent = n ? "Captured — nothing recognisable yet (the AI reads the whole text)" : "Nothing captured yet"; foundEl.appendChild(dd); }
    for (const [k, v] of rows) { const dt = document.createElement("dt"); dt.textContent = k; const dd = document.createElement("dd"); dd.textContent = v; foundEl.append(dt, dd); }
  }

  function currentStepGuess(info) {
    const u = (info.host || "") + " " + (info.title || "");
    if (/thank|confirm|review/i.test(u)) return "review";
    if (/pay|billing/i.test(u)) return "payment";
    if (/ship|deliver/i.test(u)) return "shipping";
    if (/cart|basket|bag/i.test(u)) return "cart";
    return null;
  }

  function say(text, kind) { feedback.style.display = ""; feedback.className = `capture-feedback${kind ? " " + kind : ""}`; feedback.textContent = text; }
  function hush() { feedback.style.display = "none"; }

  async function refresh() {
    const info = await send({ type: "GET_CAPTURE" });
    if (!info) return;
    if (info.isAmazonProduct) { root.style.display = "none"; return; }
    // Not an Amazon product page: the capture panel takes the empty state's place.
    root.style.display = ""; emptyState.style.display = "none"; productContent.style.display = "none";
    render(info);
  }

  async function capture() {
    hush(); captureBtn.disabled = true; captureBtn.textContent = "Capturing…";
    try {
      let r = await send({ type: "CAPTURE_PAGE" });
      if (r && !r.success && r.needsPermission) {
        const granted = await chrome.permissions.request({ origins: [r.needsPermission] }).catch(() => false);
        if (granted) r = await send({ type: "CAPTURE_PAGE" });
        else { say(`AsinFlow needs permission to read ${r.needsPermission.replace(/\/\*$/, "")} — click Capture again and allow it`, "error"); return; }
      }
      if (!r || !r.success) { say(r?.message || "Could not capture this page", "error"); return; }
      if (r.chars < 200) say("This page gave very little text (a canvas or iframe checkout?). Try the order review page.", "");
      await refresh();
    } finally { captureBtn.disabled = false; captureBtn.textContent = "Capture this page"; }
  }

  async function openInAf() {
    hush(); openBtn.disabled = true; openBtn.textContent = "Reading the pages…";
    try {
      const r = await send({ type: "OPEN_IN_AF" });
      if (!r || !r.success) { say(r?.message || "Could not open in AF — the capture is kept", "error"); return; }
      say(`Opened in AF${r.lines != null ? ` · ${r.lines} line${r.lines === 1 ? "" : "s"} read` : ""}${r.schema_ok === false ? " · the pages could not be read into the form; the text is in the form's drawer" : ""}${r.warnings && r.warnings.length ? `\n${r.warnings.join("\n")}` : ""}`, "ok");
      await refresh();
    } finally { openBtn.textContent = "Open in AF"; openBtn.disabled = !(current && current.count); }
  }

  async function clear() { hush(); await send({ type: "CLEAR_CAPTURE" }); await refresh(); }

  async function loadConfig() {
    const r = await send({ type: "GET_CAPTURE_CONFIG" });
    config = r && r.success ? r.config : null;
    if (r && !r.success && r.status === 401) say("Sign in to AsinFlow in a tab first — the extension uses your session", "error");
  }

  captureBtn.addEventListener("click", capture);
  openBtn.addEventListener("click", openInAf);
  clearBtn.addEventListener("click", clear);
  chrome.tabs.onActivated.addListener(() => refresh());
  chrome.tabs.onUpdated.addListener((_id, change) => { if (change.status === "complete" || change.url) refresh(); });
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
  loadConfig().then(refresh);
})();
