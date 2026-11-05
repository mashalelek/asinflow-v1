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
    for (const r of h.recent || []) {
      const line = { k: fmtDate(r.orderDate).replace(/, \d{4}$/, "") + (r.orderDate && r.orderDate.slice(0, 4) !== yr ? ` ${r.orderDate.slice(0, 4)}` : ""), v: `${r.how}${r.asinUnits != null ? ` → ${units(r.asinUnits)}` : ""}${r.cogs != null ? ` · ${money(r.cogs)}` : ""}${sup(r.supplier)}`, recent: true };
      // That PO's promos (2026-11-05): "FAIRTHANKS20 · 20% · −$39.60", "Sale −$12.00", or "no promos".
      if (Array.isArray(r.promos)) line.promos = r.promos.length ? r.promos.map((p) => p.label).join(" + ") : "no promos";
      out.push(line);
    }
    return out;
  }
  /** Pure: "2h ago" from an ISO time (now injectable for tests). */
  function ago(iso, now) {
    const t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return "";
    const m = Math.max(0, Math.round(((now != null ? now : Date.now()) - t) / 60000));
    return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
  }
  const pc = (n) => `${Math.round(Number(n))}%`;
  /** Pure: "−20% vs last" / "+5% vs last" / "same as last"; "" without a last COGS. */
  function vsLast(f) { if (f == null) return ""; const p = Math.round(f * 100); return p === 0 ? "same as last" : `${p < 0 ? "−" : "+"}${Math.abs(p)}% vs last`; }
  /**
   * Pure (Capture PO, 2026-11-05): the server's "This PO" answer → its lines. COGS per ASIN unit (an estimate until
   * Totals and Payment are captured), the sale price used and where it came from, profit · ROI · margin per unit, or
   * "—" with what is missing — never a guess. All numbers are the server's (shared/po-cost.ts, calculateProfit).
   */
  function thisPoLines(t, now) {
    if (!t) return [];
    const out = [];
    const cogs = t.cogs == null ? "—" : [money(t.cogs), vsLast(t.vsLast), t.estimate ? "estimate" : ""].filter(Boolean).join(" · ");
    out.push({ k: "COGS", v: t.asinUnits != null && t.cogs != null ? `${cogs}` : cogs, note: t.asinUnits != null ? `${units(t.asinUnits)}${(t.paymentParts || []).length ? ` · ${t.paymentParts.join(", ")}` : ""}` : "" });
    for (const n of t.notes || []) out.push({ k: "", v: n, note: true });
    const s = t.sale;
    out.push({ k: "Sale price", v: s ? `${s.typed ? "your price" : s.label} ${money(s.price)}${!s.typed && s.fetchedAt ? ` · ${ago(s.fetchedAt, now)}` : ""}` : "—" });
    if (t.profit != null) out.push({ k: "Profit", v: `${money(t.profit)} · ROI ${pc(t.roi)} · Margin ${pc(t.margin)}`, strong: true, neg: t.profit < 0 });
    else out.push({ k: "Profit", v: "—", strong: true });
    for (const m of t.missing || []) out.push({ k: "", v: m, note: true });
    if (t.profit != null) out.push({ k: "", v: `fees FBA ${money(t.fees.fba)} + referral ${money(t.fees.referral)} · prep ${money(t.prep.value)} (${t.prep.why})`, note: true });
    return out;
  }
  /** Pure: several listings' "This PO" → the totals line ({ units, cogs, profit, priced, of }); null under 2 costed lines. */
  function thisPoTotals(list) {
    const costed = (list || []).filter((t) => t && t.cogs != null && t.asinUnits != null);
    if (costed.length < 2) return null;
    const r2 = (x) => Math.round(x * 100) / 100;
    const priced = costed.filter((t) => t.profit != null);
    return { units: r2(costed.reduce((a, t) => a + t.asinUnits, 0)), cogs: r2(costed.reduce((a, t) => a + t.cogs * t.asinUnits, 0)), profit: priced.length === costed.length ? r2(priced.reduce((a, t) => a + t.profit * t.asinUnits, 0)) : null, priced: priced.length, of: costed.length, estimate: costed.some((t) => t.estimate) };
  }
  /** Pure: the supplier's codes (a date of thisYear without its year) with "applied" when the current capture's promos name it (case-insensitive). */
  function codeLines(codes, appliedText, thisYear) {
    const hay = String(appliedText || "").toUpperCase();
    const yr = String(thisYear || new Date().getFullYear());
    const day = (d) => (String(d || "").slice(0, 4) === yr ? fmtDate(d).replace(/, \d{4}$/, "") : fmtDate(d));
    return (codes || []).map((c) => ({
      code: c.code,
      v: [c.type ? c.type[0].toUpperCase() + c.type.slice(1) : null, c.percent != null ? `${Math.round(c.percent * 100) / 100}%` : null, c.amount != null ? `−${money(c.amount)}` : null, `last ${day(c.lastDate)}`, `${c.pos} PO${c.pos === 1 ? "" : "s"}`].filter(Boolean).join(" · "),
      applied: hay.length > 0 && new RegExp(`(^|[^A-Z0-9])${c.code.toUpperCase().replace(/[^A-Z0-9]/g, (x) => `\\${x}`)}([^A-Z0-9]|$)`).test(hay),
    }));
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
    if (opts.thisPo) renderThisPo(box, opts.thisPo, opts.onSale, opts.sale);
    const lines = historyLines(hist, opts.showSupplier);
    let recentHead = false;
    for (const l of lines) {
      if (l.recent && !recentHead) { box.append(h("div", "hist-sub", "Recent purchases")); recentHead = true; }
      const row = h("div", `hist-row${l.recent ? " recent" : ""}`);
      const v = h("span", "hist-v", l.v);
      if (l.promos) v.append(h("span", `hist-promo${l.promos === "no promos" ? " none" : ""}`, l.promos));
      row.append(h("span", "hist-k", l.k), v);
      box.append(row);
    }
  }
  /** DOM: the "This PO" block (above Last COGS) and its what-if sale price (onSale(value | null); never saved). */
  function renderThisPo(box, t, onSale, typed) {
    const wrap = h("div", "hist-this");
    wrap.append(h("div", "hist-sub first", "This PO"));
    for (const l of thisPoLines(t)) {
      const row = h("div", `hist-row${l.note === true ? " note" : ""}${l.strong ? " strong" : ""}${l.neg ? " neg" : ""}`);
      const v = h("span", "hist-v", l.v);
      if (typeof l.note === "string" && l.note) v.append(h("span", "hist-promo", l.note));
      row.append(h("span", "hist-k", l.k), v);
      wrap.append(row);
    }
    if (onSale) {
      const row = h("label", "hist-row hist-whatif");
      const inp = h("input", "hist-sale");
      inp.type = "text"; inp.inputMode = "decimal"; inp.placeholder = t.sale && !t.sale.typed ? Number(t.sale.price).toFixed(2) : "0.00";
      if (typed != null) inp.value = String(typed);
      inp.setAttribute("aria-label", "What-if sale price (not saved)");
      const go = () => { const x = Number(String(inp.value).replace(/[$,\s]/g, "")); onSale(inp.value.trim() && Number.isFinite(x) && x > 0 ? x : null); };
      inp.addEventListener("change", go);
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
      const cell = h("span", "hist-v");
      cell.append(h("span", "hist-dollar", "$"), inp, h("span", "hist-promo", " what-if, not saved"));
      row.append(h("span", "hist-k", "Try price"), cell);
      wrap.append(row);
    }
    box.append(wrap);
  }
  const api = { historyLines: historyLines, renderHistory: renderHistory, fmtDate: fmtDate, thisPoLines: thisPoLines, thisPoTotals: thisPoTotals, codeLines: codeLines, ago: ago, vsLast: vsLast };
  globalThis.AfHistory = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
