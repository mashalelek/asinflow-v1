// AsinFlow Capture PO — purchase history in the panel (SPEC §11 "Purchase history", 2026-11-05). AF data only, no AI.
// On any page of a retailer: the last email used with that supplier. For the listings in view — the captured
// Products (up to 5), else the product the page itself names (background PAGE_PRODUCT: schema.org Product, og:title,
// once the site's read permission is granted) — past PO lines from the same supplier: one confident match shows its
// history, otherwise the top 3 to pick from; the pick is remembered per listing URL (+ name, for a cart's lines) in
// chrome.storage.local and sent back as &asin=.
// 2026-11-05: "This PO" above Last COGS — the capture's lines / totals / payment / ship-to go with each listing's call
// (&po=, &line=) and AF answers the line's COGS per ASIN unit and its profit (shared/po-cost.ts, calculateProfit — the
// panel computes nothing); a what-if sale price is sent as &sale= and kept in memory only. Several ASINs: totals at the
// bottom. Under the email: "Codes used here before" (the supplier's coupon codes; one this capture applied is marked).
(function () {
  "use strict";
  const H = globalThis.AfHistory;
  const el = (id) => document.getElementById(id);
  const box = el("capture-history"), emailEl = el("history-email"), codesEl = el("history-codes"), listEl = el("history-list");
  const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? null : r)));
  const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const cache = new Map(); // query string → answer (or a pending promise)
  let pageProducts = new Map(); // tab url → { name, sku } | null
  let seq = 0;
  let lastInfo = null, showAllCodes = false;
  const whatIf = new Map(); // pick key → typed sale price (never saved)

  const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 120);
  const listingUrl = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch (e) { return String(u || ""); } };
  const pickKey = (url, name) => `historyPick:${listingUrl(url)}|${normName(name)}`;

  async function fetchHistory(params) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== "")).toString();
    if (!cache.has(qs)) cache.set(qs, send({ type: "HISTORY", query: qs }).then((r) => (r && r.ok ? r.data : null)));
    return cache.get(qs);
  }

  /** The capture as "This PO" needs it (CapturePoSchema in server/extension-history.ts); null without captured Products. */
  function capturePo(b) {
    if (!b || !(b.products || []).length) return null;
    const t = b.totals || {}, pay = b.payment || { cards: [], giftCards: [] };
    return JSON.stringify({
      lines: b.products.map((p) => ({ qty: p.qty == null ? null : Number(p.qty), price: p.price || null, total: p.total || null })),
      totals: { subtotal: t.subtotal || null, discount: t.discount || null, tax: t.tax || null, shipping: t.shipping || null, total: t.total || null },
      cards: (pay.cards || []).map((c) => ({ nickname: c.nickname || null, last4: c.last4 || null, amount: c.amount || null })),
      giftCards: (pay.giftCards || []).map((g) => ({ last4: g.last4 || null, amount: g.amount || null })),
      promos: (b.promos || []).slice(0, 20).map((x) => String(x).slice(0, 300)),
      street: (b.shipping && b.shipping.street) || null,
    });
  }

  async function listingsFor(info) {
    const prods = ((info.capture && info.capture.buckets && info.capture.buckets.products) || []).slice(0, 5);
    if (prods.length) return prods.map((p, i) => ({ name: p.name, sku: p.sku || null, line: i }));
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

  function renderCodes(codes, b) {
    codesEl.innerHTML = "";
    if (!codes || !codes.length) { codesEl.style.display = "none"; return; }
    codesEl.style.display = "";
    const applied = [...((b && b.promos) || []), (b && b.totals && b.totals.discount) || ""].join(" | ");
    const lines = H.codeLines(codes, applied);
    codesEl.append(mk("div", "hist-sub first", "Codes used here before"));
    for (const c of showAllCodes ? lines : lines.slice(0, 5)) {
      const row = mk("div", "hist-row");
      const k = mk("span", "hist-k hist-code", c.code); k.title = c.code;
      const v = mk("span", "hist-v", c.v);
      if (c.applied) v.append(mk("span", "hist-applied", "applied"));
      row.append(k, v);
      codesEl.append(row);
    }
    if (lines.length > 5) {
      const more = mk("button", "hist-link", showAllCodes ? "Show fewer" : `Show all ${lines.length}`); more.type = "button";
      more.addEventListener("click", () => { showAllCodes = !showAllCodes; renderCodes(codes, b); });
      const f = mk("div", "hist-foot"); f.append(more); codesEl.append(f);
    }
  }

  async function update(info) {
    lastInfo = info;
    const my = ++seq;
    const host = (info.capture && info.capture.host) || info.host;
    if (!host || info.isAmazon) { box.style.display = "none"; return; }
    const url = info.url || "";
    const listings = await listingsFor(info);
    const base = await fetchHistory({ supplier: host });
    if (my !== seq) return;
    const sup = base && base.supplier;
    const buckets = info.capture && info.capture.buckets;
    const poJson = capturePo(buckets);
    emailEl.textContent = sup && sup.lastEmail ? `Last email used with ${sup.supplier}: ${sup.lastEmail.email} · ${H.fmtDate(sup.lastEmail.orderDate)}` : sup && !sup.known ? `${sup.supplier}: no PO in AF yet` : sup ? `No email recorded on ${sup.supplier}'s POs` : "";
    renderCodes(sup && sup.codes, buckets);
    const picks = await new Promise((r) => chrome.storage.local.get(listings.map((l) => pickKey(url, l.name)), (s) => r(s || {})));
    const rows = await Promise.all(listings.map(async (l) => {
      const picked = picks[pickKey(url, l.name)] || null;
      const key = pickKey(url, l.name), sale = whatIf.get(key);
      const withPo = poJson && l.line != null ? { po: poJson, line: l.line, sale: sale != null ? sale : null } : {};
      return { l, key, picked, sale, ans: await fetchHistory({ supplier: host, name: l.name, sku: l.sku, asin: picked, ...withPo }) };
    }));
    if (my !== seq) return;
    listEl.innerHTML = "";
    for (const { l, key, picked, sale, ans } of rows) {
      const row = mk("div", "hist-listing");
      const name = mk("div", "hist-listing-name", l.name + (l.sku ? ` · ${l.sku}` : "")); name.title = l.name;
      row.append(name);
      if (!ans) row.append(mk("div", "hist-note", "History unavailable — check the connection"));
      else if (ans.history) {
        const onSale = ans.thisPo ? (v) => { if (v == null) whatIf.delete(key); else whatIf.set(key, v); if (lastInfo) update(lastInfo).catch(() => {}); } : null;
        const hb = mk("div", "hist-box"); H.renderHistory(hb, ans.history, { showSupplier: false, thisPo: ans.thisPo || null, onSale, sale }); row.append(hb);
        const how = ans.match.kind === "picked" ? "your pick" : ans.match.by === "sku" ? "SKU" : "name";
        const foot = mk("div", "hist-foot", `Matched by ${how}`);
        if (picked) { const ch = mk("button", "hist-link", "Change"); ch.type = "button"; ch.addEventListener("click", () => chrome.storage.local.remove(pickKey(url, l.name))); foot.append(document.createTextNode(" · "), ch); }
        row.append(foot);
      } else renderChoices(row, l, ans, url);
      listEl.append(row);
    }
    // Several ASINs: the capture's totals (units, COGS, profit), from the per-line answers.
    const tot = H.thisPoTotals(rows.map((r) => r.ans && r.ans.thisPo));
    if (tot) {
      const t = mk("div", "hist-listing hist-total");
      t.append(mk("div", "hist-sub first", `This PO · ${tot.of} ASINs${tot.estimate ? " · estimate" : ""}`));
      const money = (x) => `$${x.toFixed(2)}`;
      for (const [k, v] of [["Units", `${tot.units} ASIN units`], ["COGS", money(tot.cogs)], ["Profit", tot.profit != null ? money(tot.profit) : `— (${tot.priced} of ${tot.of} priced)`]]) {
        const r = mk("div", `hist-row${k === "Profit" ? " strong" : ""}${k === "Profit" && tot.profit != null && tot.profit < 0 ? " neg" : ""}`); r.append(mk("span", "hist-k", k), mk("span", "hist-v", v)); t.append(r);
      }
      listEl.append(t);
    }
    box.style.display = sup || rows.length ? "" : "none";
  }
  globalThis.AfCaptureHistory = { update: update, pickKey: pickKey };
})();
