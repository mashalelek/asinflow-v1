// AsinFlow Capture PO — supplier verification (SPEC §11 "Supplier verification", 2026-11-05). The header's
// "Verify supplier" runs ONE Claude call with web search, on click only (POST /api/extension/supplier-check); the
// result is stored on the supplier, so a later visit to any page of that retailer shows it with its date and a
// "Re-check" (suggested after 6 months). An AI assessment, not a guarantee — the box says so.
(function () {
  "use strict";
  const el = (id) => document.getElementById(id);
  const btn = el("verify-btn"), box = el("verify-box"), summary = el("verify-summary"), body = el("verify-body");
  const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? null : r)));
  const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const LABEL = { looks_legit: "Looks legit", mixed: "Mixed", red_flags: "Red flags" };
  const YNU = { yes: "yes", no: "no", unclear: "unclear" };
  const fmt = (iso) => (globalThis.AfHistory ? AfHistory.fmtDate(String(iso || "").slice(0, 10)) : String(iso || "").slice(0, 10));
  let host = null, running = false;
  const stored = new Map(); // host → the stored check

  const connEl = el("status-text");
  function render(c, err) {
    btn.style.display = host ? "" : "none";
    // At 380 px the header holds the brand and one more thing: while connected that is the button ("Connected" hides); offline / sign-in messages stay.
    connEl.classList.toggle("hide-when-connected", !!host);
    btn.disabled = running;
    btn.textContent = running ? "Checking…" : c && c.verifiedAt ? "Re-check" : "Verify supplier";
    btn.title = c && !c.aiAvailable ? "AI is off on the server (ANTHROPIC_API_KEY)" : running ? "" : `One AI web search about ${c ? c.supplier : host} — legitimacy, US-based, review red flags, domain age`;
    if (running) { box.style.display = ""; box.className = "verify"; summary.textContent = `Checking ${c ? c.supplier : host} on the web…`; body.innerHTML = ""; return; }
    if (err) { box.style.display = ""; box.className = "verify error"; box.open = true; summary.textContent = "Supplier check failed"; body.innerHTML = ""; body.append(mk("div", "verify-point", err)); return; }
    if (!c || !c.verifiedAt) { box.style.display = "none"; return; }
    box.style.display = ""; box.className = `verify ${c.verdict}`;
    summary.innerHTML = "";
    summary.append(mk("span", "verify-verdict", LABEL[c.verdict] || c.verdict), mk("span", "verify-date", ` · AI check ${fmt(c.verifiedAt)}${c.recheckSuggested ? " · over 6 months old — re-check" : ""}`));
    body.innerHTML = "";
    const f = c.findings || {};
    body.append(mk("div", "verify-facts", `Legitimate business: ${YNU[f.legitimate] || "unclear"} · US-based: ${YNU[f.usBased] || "unclear"}${f.domainAge ? ` · Domain: ${f.domainAge}` : ""}`));
    const ul = mk("ul", "verify-points");
    for (const p of f.points || []) ul.append(mk("li", null, p));
    body.append(ul);
    if ((c.sources || []).length) {
      const src = mk("div", "verify-sources");
      for (const s of c.sources) { const a = mk("a", null, s.title || s.url); a.href = s.url; a.target = "_blank"; a.rel = "noopener noreferrer"; a.title = s.url; src.append(a); }
      body.append(src);
    }
    body.append(mk("div", "verify-caption", "An AI assessment from a web search, not a guarantee."));
  }

  async function update(info) {
    const h = info && !info.isAmazon ? ((info.capture && info.capture.host) || info.host) : null;
    if (h !== host) { host = h; if (!h) { render(null); return; } }
    if (!host) return;
    if (!stored.has(host)) {
      stored.set(host, null);
      const r = await send({ type: "SUPPLIER_CHECK_GET", host });
      if (r && r.ok) stored.set(host, r.data);
    }
    if (!running) render(stored.get(host));
  }

  btn.addEventListener("click", async () => {
    if (!host || running) return;
    const h = host;
    running = true; render(stored.get(h));
    const r = await send({ type: "SUPPLIER_CHECK_RUN", host: h });
    running = false;
    if (r && r.ok) { stored.set(h, r.data); if (host === h) { render(r.data); box.open = true; } }
    else if (host === h) render(stored.get(h), (r && r.data && r.data.message) || (r && r.message) || "Could not reach AsinFlow");
  });
  globalThis.AfCaptureVerify = { update: update };
})();
