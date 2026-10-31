// Pure planning for the migration-075 data backfills (patch po-ai-prefill
// §8–§9 as amended 2026-10-31). The driver is script/backfill-po-model.ts
// (dry run by default). Nothing here touches a stored COGS / AQ / AR / Y.

/** Subscription frequency from the sheet's Notes / Promo text; weeks. Months are 4-week multiples. */
export function frequencyWeeksFromText(text: string | null | undefined): number | null {
  const t = String(text ?? "").toLowerCase();
  let m: RegExpExecArray | null;
  if ((m = /every\s+(\d+)\s*weeks?/.exec(t))) return Number(m[1]);
  if ((m = /every\s+(\d+)\s*months?/.exec(t))) return Number(m[1]) * 4;
  if ((m = /(\d+)[\s-]*months?\b/.exec(t))) return Number(m[1]) * 4;
  if ((m = /(\d+)[\s-]*days?\b/.exec(t))) return Math.max(1, Math.round(Number(m[1]) / 7));
  if (/monthly|every month|1-month|autoship/.test(t)) return 4;
  return null;
}

export function subscriptionStatusFromText(text: string | null | undefined): "active" | "canceled" {
  return /cancel|unsubscribe/i.test(String(text ?? "")) ? "canceled" : "active";
}

/** YYYY-MM-DD + weeks, local components only (never a UTC shift). */
export function addWeeks(ymd: string, weeks: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d + weeks * 7);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

export interface PackSource { asin: string; title: string | null; sold_as: string; units_per_pack: number | null; pos: number }
export interface PackPlan {
  set: Array<{ asin: string; sold_as: string; units_per_pack: number }>;
  gaps: Array<{ asin: string; title: string | null; values: Array<{ sold_as: string; units_per_pack: number; pos: number }> }>;
}
/**
 * asins.sold_as / units_per_pack from the PO rows (amendment 3): every
 * non-canceled 2026 ASIN row with a pack value, grouped per ASIN; all agree →
 * set; disagree → a gap row listing each distinct value with its PO count.
 * ASINs with no row at all are passed in `noValue` (title only) → gap rows.
 */
export function planAsinPack(rows: readonly PackSource[], noValue: ReadonlyArray<{ asin: string; title: string | null }>): PackPlan {
  const byAsin = new Map<string, Map<string, { sold_as: string; units_per_pack: number; pos: number; title: string | null }>>();
  for (const r of rows) {
    const upp = r.sold_as === "individual" ? 1 : Number(r.units_per_pack ?? 1) || 1;
    const k = `${r.sold_as}×${upp}`;
    if (!byAsin.has(r.asin)) byAsin.set(r.asin, new Map());
    const m = byAsin.get(r.asin)!;
    const cur = m.get(k);
    if (cur) cur.pos += r.pos; else m.set(k, { sold_as: r.sold_as, units_per_pack: upp, pos: r.pos, title: r.title });
  }
  const plan: PackPlan = { set: [], gaps: [] };
  for (const [asin, m] of Array.from(byAsin.entries())) {
    const vals = Array.from(m.values()).sort((a, b) => b.pos - a.pos);
    if (vals.length === 1) plan.set.push({ asin, sold_as: vals[0].sold_as, units_per_pack: vals[0].units_per_pack });
    else plan.gaps.push({ asin, title: vals[0].title, values: vals.map(({ sold_as, units_per_pack, pos }) => ({ sold_as, units_per_pack, pos })) });
  }
  for (const n of noValue) if (!byAsin.has(n.asin)) plan.gaps.push({ asin: n.asin, title: n.title, values: [] });
  plan.set.sort((a, b) => a.asin.localeCompare(b.asin));
  plan.gaps.sort((a, b) => a.asin.localeCompare(b.asin));
  return plan;
}

export interface RefundSource { po_id: string; refund_amount: string; lines: Array<{ id: string; qty_returned: number | null }> }
export interface RefundPlan { po_id: string; po_line_item_id: string | null; qty: number | null; amount: string; needs_split: boolean }
/**
 * §8.3 backfill of the PO-level refund amount: one line → on it; several
 * lines of which exactly one has a returned qty → on that line; otherwise a
 * PO-level placeholder (line NULL) flagged needs_split.
 */
export function planRefund(src: RefundSource): RefundPlan | null {
  if (!(Number(src.refund_amount) > 0)) return null;
  const amount = Number(src.refund_amount).toFixed(2);
  if (src.lines.length === 1) return { po_id: src.po_id, po_line_item_id: src.lines[0].id, qty: src.lines[0].qty_returned ?? null, amount, needs_split: false };
  const returned = src.lines.filter((l) => (l.qty_returned ?? 0) > 0);
  if (returned.length === 1) return { po_id: src.po_id, po_line_item_id: returned[0].id, qty: returned[0].qty_returned, amount, needs_split: false };
  return { po_id: src.po_id, po_line_item_id: null, qty: null, amount, needs_split: true };
}

/** CSV with every field quoted as needed. */
export function csv(rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  return rows.map((r) => r.map((v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(",")).join("\n") + "\n";
}
