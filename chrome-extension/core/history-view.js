// AsinFlow extensions — purchase history view (core, SPEC §11 "Purchase history", 2026-11-05). Both panels render
// GET /api/extension/history's answer with these: historyLines (pure, tested in server/extension-history.test.ts)
// and renderHistory (DOM). AF data only — no AI. Money per ASIN unit; dates as AF stores them (the PO's order date).
(function () {
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtDate(d) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || "")); return m ? `${MON[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : String(d || ""); }
  const money = (n) => (n == null ? "—" : `$${Number(n).toFixed(2)}`);
  const units = (n) => `${Math.round(Number(n) * 100) / 100} unit${Number(n) === 1 ? "" : "s"}`;
  /** Pure: one ASIN's history → its text lines ({ k, v } pairs; k is the label). showSupplier: name each PO's supplier (the Analyzer's view spans suppliers); a recent purchase outside thisYear shows its year. */
  function historyLines(h, showSupplier, thisYear) {
    if (!h) return [];
    const yr = String(thisYear || new Date().getFullYear());
    const out = [];
    const sup = (s) => (showSupplier && s ? ` · ${s}` : "");
    out.push({ k: "Last COGS", v: h.last ? `${money(h.last.cogs)} · ${fmtDate(h.last.orderDate)} · PO ${h.last.orderId}${sup(h.last.supplier)}` : "no purchase in AF" });
    out.push({ k: "365 days", v: h.pos365 ? `avg ${money(h.avg365)} · ${h.pos365} PO${h.pos365 === 1 ? "" : "s"} · ${units(h.units365)}` : "no POs" });
    if (h.conversion) out.push({ k: "Pack", v: h.conversion });
    for (const r of h.recent || []) out.push({ k: fmtDate(r.orderDate).replace(/, \d{4}$/, "") + (r.orderDate && r.orderDate.slice(0, 4) !== yr ? ` ${r.orderDate.slice(0, 4)}` : ""), v: `${r.how}${r.asinUnits != null ? ` → ${units(r.asinUnits)}` : ""}${r.cogs != null ? ` · ${money(r.cogs)}` : ""}${sup(r.supplier)}`, recent: true });
    return out;
  }
  const h = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  /** DOM: one ASIN's history into `box` (cleared). */
  function renderHistory(box, hist, opts) {
    opts = opts || {};
    box.innerHTML = "";
    if (!hist) return;
    const head = h("div", "hist-asin");
    head.append(h("span", "hist-asin-id", hist.asin));
    if (hist.title) { const t = h("span", "hist-asin-title", ` ${hist.title}`); t.title = hist.title; head.append(t); }
    box.append(head);
    const lines = historyLines(hist, opts.showSupplier);
    let recentHead = false;
    for (const l of lines) {
      if (l.recent && !recentHead) { box.append(h("div", "hist-sub", "Recent purchases")); recentHead = true; }
      const row = h("div", `hist-row${l.recent ? " recent" : ""}`);
      row.append(h("span", "hist-k", l.k), h("span", "hist-v", l.v));
      box.append(row);
    }
  }
  const api = { historyLines: historyLines, renderHistory: renderHistory, fmtDate: fmtDate };
  globalThis.AfHistory = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
