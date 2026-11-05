// AsinFlow Chrome Extension — Capture PO side panel (SPEC §11 "Chrome
// extension — Capture PO", v1.2). Shown whenever the active tab is not an
// Amazon product page (the calculator keeps those). One "Capture this page"
// button; "Found so far" is the tab's six data buckets (buckets.js, regex
// level, no AI — the background merges every capture newest-wins per field);
// "Open in AF" is NEVER gated (v1.2.4, Maria 2026-11-02 — the buckets are a
// preview, not a gate): with pages captured it makes the one AI call, server
// side, and opens the prefilled form; with none it opens /pos/new blank with
// the supplier prefilled from the tab's hostname (no model call). Captures
// are per tab: the panel shows the active tab's and lists the other tabs with
// a capture in progress. v1.3: each capture is also read by a small AI
// extraction (background.js requestPreview); the buckets switch to its
// reading when it lands, and the status line says where it stands.
(function () {
  "use strict";
  const B = globalThis.AfBuckets;
  const el = (id) => document.getElementById(id);
  const root = el("capture-content"), emptyState = el("empty-state"), productContent = el("product-content");
  const retailerEl = el("capture-retailer"), newSupplierEl = el("capture-new-supplier"), orderEl = el("capture-order"), badgeEl = el("capture-shipto-badge");
  const captureBtn = el("capture-btn"), statusEl = el("capture-status"), missingEl = el("capture-missing"), bucketsEl = el("capture-buckets");
  const openBtn = el("capture-open-btn"), clearBtn = el("capture-clear-btn"), copyBtn = el("capture-copy-btn"), feedback = el("capture-feedback"), alsoEl = el("also-capturing");
  let debugCapture = false; // options page: "Show Copy page text" (v1.2.3)
  let config = null; // { velocityStreet, homeStreets, prepCost, suppliers }
  let current = null; // the stored capture for the active tab

  const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? { success: false, message: chrome.runtime.lastError.message } : r)));
  const h = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  function bucket(key, isFilled, count, body) {
    const box = h("div", `bucket${isFilled ? " filled" : ""}`);
    box.dataset.bucket = key;
    const head = h("div", "bucket-head");
    head.append(h("span", "bucket-tick", isFilled ? "✓" : "—"), h("span", "bucket-name", B.LABELS[key]));
    if (count != null) head.append(h("span", "bucket-count", String(count)));
    box.append(head);
    if (body && body.childNodes.length) { body.className = "bucket-body"; box.append(body); }
    return box;
  }
  const pairs = (list) => { const p = h("div", "bucket-pairs"); for (const [k, v] of list) { const s = h("span"); s.append(h("span", "k", k), document.createTextNode(v)); p.append(s); } return p; };

  function renderBuckets(b, f) {
    bucketsEl.innerHTML = "";
    // Products: one line per product actually parsed — qty × name · SKU / UPC · price.
    const prod = h("div");
    for (const p of b.products) {
      const row = h("div", "bucket-row");
      row.append(h("span", "b-qty", p.qty != null ? `${p.qty} ×` : "—"));
      const name = h("span", "b-name", p.name); name.title = p.name;
      if (p.sku) name.append(h("span", "b-sku", ` · ${p.sku}`));
      row.append(name, h("span", "b-price", p.price || ""));
      prod.append(row);
    }
    bucketsEl.append(bucket("products", f.products, b.products.length || null, prod));
    // Shipping: the selected address → Velocity / Home / Unknown: <street>; both when ambiguous.
    const ship = h("div");
    for (const line of B.describeShipping(b.shipping, config)) ship.append(h("div", "bucket-line", line));
    if (b.shipping && !b.shipping.street && (b.shipping.candidates || []).length > 1) ship.append(h("div", "bucket-note", "Two addresses on the pages — Ships to stays blank on the form"));
    bucketsEl.append(bucket("shipping", f.shipping, null, ship));
    // Payment: card nickname + last 4, gift cards + amounts.
    const pay = h("div");
    for (const c of b.payment.cards) pay.append(h("div", "bucket-line", `${c.nickname} •••• ${c.last4}${c.amount ? ` · ${c.amount}` : ""}`));
    for (const g of b.payment.giftCards) pay.append(h("div", "bucket-line", `Gift card${g.last4 ? ` •••• ${g.last4}` : ""}${g.amount ? ` · ${g.amount}` : ""}`));
    bucketsEl.append(bucket("payment", f.payment, null, pay));
    // Totals.
    const tot = h("div");
    const tl = [["Subtotal", b.totals.subtotal], ["Discount", b.totals.discount], ["Tax", b.totals.tax], ["Shipping", b.totals.shipping], ["Total", b.totals.total]].filter(([, v]) => v);
    if (tl.length) tot.append(pairs(tl));
    bucketsEl.append(bucket("totals", f.totals, null, tot));
    // Promos.
    const promo = h("div");
    for (const line of b.promos) promo.append(h("div", "bucket-line", line));
    bucketsEl.append(bucket("promos", f.promos, b.promos.length || null, promo));
    // Order: order #, date, subscription (the subscription can come from any page; # and date usually from the confirmation).
    const ord = h("div");
    const ol = [];
    if (b.order.number) ol.push(["#", b.order.number]);
    if (b.order.date) ol.push(["Date", b.order.date]);
    if (b.order.email) ol.push(["Email", b.order.email]);
    if (b.order.subscription) ol.push(["Subscription", b.order.subscription.on ? (b.order.subscription.every || "on") : "off"]);
    if (ol.length) ord.append(pairs(ol));
    bucketsEl.append(bucket("order", f.order, null, ord));
  }

  function render(info) {
    const cap = info.capture;
    current = cap;
    const host = ((cap && cap.host) || info.host || "—").replace(/^www\./, "");
    const b = (cap && cap.buckets) || B.emptyBuckets();
    const f = B.filled(b);
    retailerEl.textContent = host;
    newSupplierEl.style.display = config && config.suppliers && host !== "—" && !config.suppliers.includes(host.toLowerCase()) ? "" : "none";
    orderEl.textContent = b.order.number ? `· # ${b.order.number}` : "";
    const kind = b.shipping && b.shipping.street ? B.shipToKind(b.shipping.street, config) : null;
    badgeEl.style.display = kind ? "" : "none"; badgeEl.textContent = kind || "";
    const n = cap ? cap.count : 0;
    // v1.3: the AI preview's state beside the page count ("AI reading…", "AI read", "AI preview is off").
    const ai = B.previewStatus(cap);
    statusEl.textContent = `${plural(n, "page")} captured${ai ? ` · ${ai}` : ""}`;
    const miss = B.missing(b);
    missingEl.textContent = !n ? "Capture the cart, then the review page — any page, any number of times" : miss.length ? `Still missing: ${miss.join(", ")}` : "Everything found";
    openBtn.disabled = false; // never gated (v1.2.4)
    openBtn.title = n ? "" : `Opens a blank PO for ${host} — capture pages first to prefill it`;
    clearBtn.disabled = !n;
    copyBtn.disabled = !n;
    renderBuckets(b, f);
    const others = info.others || [];
    alsoEl.style.display = others.length ? "" : "none";
    alsoEl.textContent = others.length ? `Also capturing: ${others.map((o) => `${o.host} (${plural(o.count, "page")})`).join(" · ")}` : "";
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
      if (r.blank) { say(`Opened a blank PO for ${r.host || "this site"} — nothing was captured, so nothing was prefilled`, "ok"); return; }
      say(`Opened in AF${r.lines != null ? ` · ${plural(r.lines, "line")} read` : ""}${r.schema_ok === false ? " · the pages could not be read into the form; the text is in the form's drawer" : ""}${r.warnings && r.warnings.length ? `\n${r.warnings.join("\n")}` : ""}`, "ok");
      await refresh();
    } finally { openBtn.textContent = "Open in AF"; openBtn.disabled = false; }
  }

  async function clear() { hush(); await send({ type: "CLEAR_CAPTURE" }); await refresh(); }

  // "Copy page text" (debug, v1.2.3): the tab's captured pages — the scrubbed innerText and the fields, exactly what buckets.js parsed — to the clipboard, so a page whose products the parser missed can be pasted into the chat and become a fixture. Nothing is sent anywhere.
  async function copyPageText() {
    hush();
    if (!current || !current.count) { say("Nothing captured yet", "error"); return; }
    const payload = B.debugText(current);
    let ok = false;
    try { await navigator.clipboard.writeText(payload); ok = true; } catch (e) { ok = false; }
    if (!ok) {
      const ta = document.createElement("textarea"); ta.value = payload; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.append(ta); ta.select();
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      ta.remove();
    }
    say(ok ? `Copied ${plural(current.count, "page")} · ${payload.length.toLocaleString()} characters — paste it into the chat as a code block so the tabs survive` : "Could not copy — click the panel first, then try again", ok ? "ok" : "error");
  }
  function applyDebug() { copyBtn.style.display = debugCapture ? "" : "none"; }

  async function loadConfig() {
    const r = await send({ type: "GET_CAPTURE_CONFIG" });
    config = r && r.success ? r.config : null;
    if (r && !r.success && r.status === 401) say("Sign in to AsinFlow in a tab first — the extension uses your session", "error");
  }

  captureBtn.addEventListener("click", capture);
  openBtn.addEventListener("click", openInAf);
  clearBtn.addEventListener("click", clear);
  copyBtn.addEventListener("click", copyPageText);
  chrome.storage.sync.get(["debugCapture"], (s) => { debugCapture = !!(s && s.debugCapture); applyDebug(); });
  chrome.tabs.onActivated.addListener(() => refresh());
  chrome.tabs.onUpdated.addListener((_id, change) => { if (change.status === "complete" || change.url) refresh(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" || area === "session") refresh(); // v1.3.1: the captures live in local
    if (area === "sync" && changes.debugCapture) { debugCapture = !!changes.debugCapture.newValue; applyDebug(); }
  });
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
  loadConfig().then(refresh);
})();
