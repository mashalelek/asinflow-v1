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

export type PackValue = { sold_as: string; units_per_pack: number | null };
/**
 * The sheet's Col AX / AY, literally (Maria 2026-11-01, review answer 3):
 * blank AX = no information (null — never "individual"); "individual" = 1
 * per pack; any other value takes AY (blank AY → null units).
 */
export function packFromSheetCells(ax: string | undefined, ay: string | undefined): PackValue | null {
  const soldAs = String(ax ?? "").trim().toLowerCase();
  if (!soldAs) return null;
  if (soldAs === "individual") return { sold_as: "individual", units_per_pack: 1 };
  const n = Number(String(ay ?? "").trim().replace(/,/g, ""));
  return { sold_as: soldAs, units_per_pack: Number.isInteger(n) && n >= 1 ? n : null };
}
export const packKey = (v: PackValue): string => `${v.sold_as}×${v.units_per_pack ?? "?"}`;

export interface PackRow { asin: string; title: string | null; po: string; pack: PackValue | null }
export interface PackPlan {
  /** Every row with a value agrees → the ASIN takes it (from the newest row). */
  set: Array<{ asin: string; sold_as: string; units_per_pack: number | null; from_po: string; rows: number }>;
  /** Rows with a value disagree → "possible mismatch": each distinct pair with its PO numbers, newest first. */
  mismatches: Array<{ asin: string; title: string | null; values: Array<{ key: string; sold_as: string; units_per_pack: number | null; pos: string[] }> }>;
  /** No row carries a value at all. */
  noInfo: Array<{ asin: string; title: string | null; rows: number }>;
}
/**
 * asins.sold_as / units_per_pack from the sheet-literal pack of every PO
 * ASIN row (rows newest first). A pair with unknown units ("multi-pack×?")
 * is its own value, so it never silently agrees with a known count.
 */
export function planAsinPack(rows: readonly PackRow[]): PackPlan {
  const byAsin = new Map<string, { title: string | null; rows: number; values: Map<string, { v: PackValue; pos: string[] }> }>();
  for (const r of rows) {
    if (!byAsin.has(r.asin)) byAsin.set(r.asin, { title: r.title, rows: 0, values: new Map() });
    const a = byAsin.get(r.asin)!;
    a.rows++;
    if (!a.title && r.title) a.title = r.title;
    if (!r.pack) continue;
    const k = packKey(r.pack);
    const cur = a.values.get(k);
    if (cur) cur.pos.push(r.po); else a.values.set(k, { v: r.pack, pos: [r.po] });
  }
  const plan: PackPlan = { set: [], mismatches: [], noInfo: [] };
  for (const [asin, a] of Array.from(byAsin.entries())) {
    const vals = Array.from(a.values.entries());
    if (vals.length === 0) plan.noInfo.push({ asin, title: a.title, rows: a.rows });
    else if (vals.length === 1) plan.set.push({ asin, sold_as: vals[0][1].v.sold_as, units_per_pack: vals[0][1].v.units_per_pack, from_po: vals[0][1].pos[0], rows: vals[0][1].pos.length });
    else plan.mismatches.push({ asin, title: a.title, values: vals.map(([key, x]) => ({ key, sold_as: x.v.sold_as, units_per_pack: x.v.units_per_pack, pos: x.pos })) });
  }
  for (const l of [plan.set, plan.mismatches, plan.noInfo] as Array<Array<{ asin: string }>>) l.sort((x, y) => x.asin.localeCompare(y.asin));
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
