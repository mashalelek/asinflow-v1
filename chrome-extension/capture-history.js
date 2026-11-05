// AsinFlow Capture PO — purchase history in the panel (SPEC §11 "Purchase history", 2026-11-05). AF data only, no AI.
// On any page of a retailer: the last email used with that supplier. For the listings in view — the captured
// Products (up to 5), else the product the page itself names (background PAGE_PRODUCT: schema.org Product, og:title,
// once the site's read permission is granted) — past PO lines from the same supplier: one confident match shows its
// history, otherwise the top 3 to pick from; the pick is remembered per listing URL (+ name, for a cart's lines) in
// chrome.storage.local and sent back as &asin=.
(function () {
  "use strict";
  const H = globalThis.AfHistory;
  const el = (id) => document.getElementById(id);
  const box = el("capture-history"), emailEl = el("history-email"), listEl = el("history-list");
  const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? null : r)));
  const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const cache = new Map(); // query string → answer (or a pending promise)
  let pageProducts = new Map(); // tab url → { name, sku } | null
  let seq = 0;

  const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 120);
  const listingUrl = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch (e) { return String(u || ""); } };
  const pickKey = (url, name) => `historyPick:${listingUrl(url)}|${normName(name)}`;

  async function fetchHistory(params) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== "")).toString();
    if (!cache.has(qs)) cache.set(qs, send({ type: "HISTORY", query: qs }).then((r) => (r && r.ok ? r.data : null)));
    return cache.get(qs);
  }

  async function listingsFor(info) {
    const prods = ((info.capture && info.capture.buckets && info.capture.buckets.products) || []).slice(0, 5);
    if (prods.length) return prods.map((p) => ({ name: p.name, sku: p.sku || null }));
    const url = info.url || "";
    if (!pageProducts.has(url)) pageProducts.set(url, send({ type: "PAGE_PRODUCT" }).then((r) => (r && r.name ? { name: r.name, sku: r.sku || null } : null)));
    const p = await pageProducts.get(url);
    return p ? [p] : [];
  }

  function renderChoices(row, l, ans, url) {
    const c = ans.match.choices;
    row.append(mk("div", "hist-note", c.length ? `${c.length === 1 ? "A possible match" : `${c.length} possible matches`} — pick the ASIN this listing is` : "No past PO line from this supplier matches"));
    for (const ch of c) {
      const b = mk("button", "hist-pick");
      b.type = "button";
      b.append(mk("span", "hist-asin-id", ch.asin), mk("span", "hist-pick-name", ` ${ch.title || ch.productName}`));
      b.title = `${ch.productName}${ch.by === "sku" ? " (same SKU)" : ` (name match ${Math.round(ch.score * 100)}%)`}`;
      b.addEventListener("click", () => { chrome.storage.local.set({ [pickKey(url, l.name)]: ch.asin }); });
      row.append(b);
    }
  }

  async function update(info) {
    const my = ++seq;
    const host = (info.capture && info.capture.host) || info.host;
    if (!host || info.isAmazon) { box.style.display = "none"; return; }
    const url = info.url || "";
    const listings = await listingsFor(info);
    const base = await fetchHistory({ supplier: host });
    if (my !== seq) return;
    const sup = base && base.supplier;
    emailEl.textContent = sup && sup.lastEmail ? `Last email used with ${sup.supplier}: ${sup.lastEmail.email} · ${H.fmtDate(sup.lastEmail.orderDate)}` : sup && !sup.known ? `${sup.supplier}: no PO in AF yet` : sup ? `No email recorded on ${sup.supplier}'s POs` : "";
    const picks = await new Promise((r) => chrome.storage.local.get(listings.map((l) => pickKey(url, l.name)), (s) => r(s || {})));
    const rows = await Promise.all(listings.map(async (l) => {
      const picked = picks[pickKey(url, l.name)] || null;
      return { l, picked, ans: await fetchHistory({ supplier: host, name: l.name, sku: l.sku, asin: picked }) };
    }));
    if (my !== seq) return;
    listEl.innerHTML = "";
    for (const { l, picked, ans } of rows) {
      const row = mk("div", "hist-listing");
      const name = mk("div", "hist-listing-name", l.name + (l.sku ? ` · ${l.sku}` : "")); name.title = l.name;
      row.append(name);
      if (!ans) row.append(mk("div", "hist-note", "History unavailable — check the connection"));
      else if (ans.history) {
        const hb = mk("div", "hist-box"); H.renderHistory(hb, ans.history, { showSupplier: false }); row.append(hb);
        const how = ans.match.kind === "picked" ? "your pick" : ans.match.by === "sku" ? "SKU" : "name";
        const foot = mk("div", "hist-foot", `Matched by ${how}`);
        if (picked) { const ch = mk("button", "hist-link", "Change"); ch.type = "button"; ch.addEventListener("click", () => chrome.storage.local.remove(pickKey(url, l.name))); foot.append(document.createTextNode(" · "), ch); }
        row.append(foot);
      } else renderChoices(row, l, ans, url);
      listEl.append(row);
    }
    box.style.display = sup || rows.length ? "" : "none";
  }
  globalThis.AfCaptureHistory = { update: update, pickKey: pickKey };
})();
