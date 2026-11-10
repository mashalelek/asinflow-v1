// The ASIN pack size as a reviewed catalog field (Maria 2026-11-06, migration 098). asins.sold_as /
// units_per_pack are the CONFIRMED pack — what every PO line uses. A pack is confirmed without Maria's review
// only when
//   (a) her PO lines for the ASIN all agree on it — lines she set by hand (an AF-created PO, or a row whose
//       sold as / units per pack she edited), or sheet lines whose stored Ordered that pack reproduces within
//       0.01 — or
//   (b) Velocity's units per pack for the ASIN says it,
// and the two don't contradict each other. Anything else needs review: PO lines that disagree (with each other
// or with Velocity) list each PO # / Velocity value; the catalog's item_package_quantity, the title ("Pack of 2",
// "Lot of 6") and the AI are suggestions only, however confident — and where the ASIN has past PO lines only a
// pack that reproduces their stored Ordered can be suggested. A pack Maria set herself (Update ASIN in AF, the
// ASINs table, an upload, a PO entry) is never re-decided. Pack size = manufactured retail packages in one ASIN
// unit, never the items inside a package.
import type { QueryLike } from "./scheduler/types";
import { changedFields, logEdits, linesAtPack, fillAsinPackGaps, CLEAR_PACK_SUGGESTION_SQL, EditError, type PackGapSkip } from "./po-edit";
import { titlePackSuggestion } from "../shared/pack-parse";

export type SoldAsValue = "individual" | "multi-pack" | "bundle";
export interface PackValue { sold_as: SoldAsValue; units: number }
export const packKey = (p: PackValue): string => `${p.sold_as}|${p.sold_as === "individual" ? 1 : p.units}`;
export const packLabel = (p: PackValue): string => (p.sold_as === "individual" ? "individual" : `${p.sold_as} ×${p.units}`);
export const packFromUnits = (n: number): PackValue => (n <= 1 ? { sold_as: "individual", units: 1 } : { sold_as: "multi-pack", units: n });

export interface PackLine { qty_ordered: unknown; retailer_units_per_product: unknown; asin_units_per_pack: unknown; asin_qty_per_product: unknown }
export interface PackRow {
  order_id: string; supplier: string; closed: boolean; order_date: string | null;
  /** An AF-created PO, or a row whose sold as / units per pack a user edited. */
  hand: boolean;
  pack: PackValue | null; qty: number; velocity_units: number | null; lines: PackLine[];
}
export interface PackEvidence { asin: string; title: string | null; record: PackValue | null; recordSource: string | null; recordMine: boolean; rows: PackRow[] }
export interface CatalogPack { item_package_quantity: number | null; number_of_items: number | null }
export interface AiPack { sold_as: SoldAsValue | null; units_per_pack: number | null; note: string }

export type ReviewReason = "po_conflict" | "po_velocity_conflict" | "velocity_conflict" | "suggestion" | "nothing";
export type PackDecision =
  | { kind: "mine" }
  | { kind: "confirmed"; pack: PackValue; source: "po" | "velocity" | "po_velocity"; note: string }
  | { kind: "review"; reason: ReviewReason; suggestion: PackValue | null; suggestionSource: string | null; note: string };

/** Pure: does this pack reproduce the row's stored Ordered (each line's yield a whole number of retailer units at the pack, Σ within 0.01)? */
export function packReproduces(row: Pick<PackRow, "qty" | "lines">, p: PackValue): boolean {
  if (p.sold_as === "bundle" || row.lines.length === 0) return false;
  const fit = linesAtPack(row.lines as any[], p.sold_as === "individual" ? 1 : p.units);
  return fit != null && Math.abs(fit.units - row.qty) <= 0.01 + 1e-9;
}
/** Pure: a pack every past PO row with lines and an Ordered can carry — what a suggestion must satisfy. */
export function packFitsHistory(rows: readonly PackRow[], p: PackValue): boolean {
  return rows.filter((r) => r.lines.length > 0 && r.qty > 0).every((r) => packReproduces(r, p));
}

const tally = <T>(vals: Array<{ key: string; v: T; label: string }>) => {
  const m = new Map<string, { v: T; n: number; labels: string[] }>();
  for (const x of vals) { const e = m.get(x.key) ?? { v: x.v, n: 0, labels: [] }; e.n++; e.labels.push(x.label); m.set(x.key, e); }
  return Array.from(m.values()).sort((a, b) => b.n - a.n);
};

/** Pure: (a) and (b) for one ASIN — confirmed, a conflict to review, or nothing (then the suggestions decide). */
export function decideFromEvidence(ev: PackEvidence): PackDecision | null {
  if (ev.recordMine) return { kind: "mine" };
  // (a) the PO rows that count: set by hand, or a sheet row whose stored Ordered its pack reproduces. Newest first.
  const rows = [...ev.rows].sort((x, y) => String(y.order_date ?? "").localeCompare(String(x.order_date ?? "")));
  const po = tally(rows.filter((r) => r.pack && (r.hand || packReproduces(r, r.pack))).map((r) => ({ key: packKey(r.pack!), v: r.pack!, label: `${r.supplier} ${r.order_id}` })));
  const vel = tally(rows.filter((r) => r.velocity_units != null && r.velocity_units >= 1).map((r) => { const p = packFromUnits(r.velocity_units!); return { key: packKey(p), v: p, label: `${r.supplier} ${r.order_id}` }; }));
  const list = (t: typeof po, who: string) => t.map((e) => `${who} ${packLabel(e.v)}: ${e.labels.slice(0, 4).join(", ")}${e.labels.length > 4 ? ` +${e.labels.length - 4} more` : ""}`).join(" · ");
  if (po.length > 1) return { kind: "review", reason: "po_conflict", suggestion: po[0].v, suggestionSource: "po", note: `PO lines disagree — ${list(po, "PO")}${vel.length ? ` · ${list(vel, "Velocity")}` : ""}` };
  if (vel.length > 1) return { kind: "review", reason: "velocity_conflict", suggestion: po[0]?.v ?? vel[0].v, suggestionSource: po.length ? "po" : "velocity", note: `Velocity values disagree — ${list(vel, "Velocity")}${po.length ? ` · ${list(po, "PO")}` : ""}` };
  if (po.length === 1 && vel.length === 1 && packKey(po[0].v) !== packKey(vel[0].v)) {
    return { kind: "review", reason: "po_velocity_conflict", suggestion: po[0].v, suggestionSource: "po", note: `PO lines and Velocity disagree — ${list(po, "PO")} · ${list(vel, "Velocity")}` };
  }
  if (po.length === 1 && vel.length === 1) return { kind: "confirmed", pack: po[0].v, source: "po_velocity", note: `${list(po, "PO")} · ${list(vel, "Velocity")}` };
  if (po.length === 1) return { kind: "confirmed", pack: po[0].v, source: "po", note: list(po, "PO") };
  if (vel.length === 1) return { kind: "confirmed", pack: vel[0].v, source: "velocity", note: list(vel, "Velocity") };
  return null;
}

/**
 * Pure: the suggestions for an ASIN with nothing from (a) / (b) — the AI (image count over the title's number), the
 * catalog's item_package_quantity, the title, an earlier unreviewed value on record — in that order, each only when it
 * fits the ASIN's past PO rows. Never confirmed. number_of_items counts items, not packages: shown, never suggested.
 */
export function suggestPack(ev: PackEvidence, catalog: CatalogPack | null, ai: AiPack | null): Extract<PackDecision, { kind: "review" }> {
  const notes: string[] = [];
  const cands: Array<{ p: PackValue; source: string }> = [];
  if (ai) {
    if (ai.sold_as) cands.push({ p: { sold_as: ai.sold_as, units: ai.sold_as === "individual" ? 1 : Math.max(1, ai.units_per_pack ?? 1) }, source: "ai" });
    notes.push(`AI: ${ai.sold_as ? packLabel(cands[cands.length - 1].p) : "no pack"}${ai.note ? ` (${ai.note})` : ""}`);
  }
  if (catalog?.item_package_quantity != null && catalog.item_package_quantity >= 1) { const p = packFromUnits(catalog.item_package_quantity); cands.push({ p, source: "catalog" }); notes.push(`catalog item_package_quantity ${catalog.item_package_quantity}`); }
  if (catalog?.number_of_items != null) notes.push(`catalog number_of_items ${catalog.number_of_items} (items, not packages)`);
  const t = titlePackSuggestion(ev.title);
  if (t) { cands.push({ p: { sold_as: t.sold_as, units: t.units_per_pack }, source: "title" }); notes.push(`title says "${t.text}"`); }
  if (ev.record) { cands.push({ p: ev.record, source: "record" }); notes.push(`on record ${packLabel(ev.record)}, never reviewed`); }
  const withHistory = ev.rows.some((r) => r.lines.length > 0 && r.qty > 0);
  for (const c of cands) {
    if (c.p.sold_as === "bundle" || !withHistory || packFitsHistory(ev.rows, c.p)) {
      return { kind: "review", reason: "suggestion", suggestion: c.p, suggestionSource: c.source, note: notes.join(" · ") };
    }
  }
  const rejected = cands.length && withHistory ? ` · none of these reproduces the past PO quantities` : "";
  return { kind: "review", reason: "nothing", suggestion: null, suggestionSource: null, note: (notes.join(" · ") || "nothing found") + rejected };
}

/** Evidence for some ASINs (all when `asins` is omitted). */
export async function loadPackEvidence(query: QueryLike, asins?: string[]): Promise<PackEvidence[]> {
  const filter = asins ? `WHERE a.asin = ANY($1::text[])` : "";
  const recs = (await query(
    `SELECT a.asin, a.title, a.sold_as, a.units_per_pack, a.pack_source,
            EXISTS (SELECT 1 FROM asin_field_log f WHERE f.asin = a.asin AND f.user_id IS NOT NULL AND f.field IN ('sold_as', 'units_per_pack')) AS user_logged
       FROM asins a ${filter}`, asins ? [asins.map((x) => x.toUpperCase())] : [],
  )).rows;
  const rows = (await query(
    `SELECT pa.id, pa.asin, pa.sold_as, pa.units_per_pack, e.ordered_asin AS qty, pa.velocity_units_per_pack, p.order_id, p.supplier, p.order_date, p.closed_at IS NOT NULL AS closed,
            (p.cost_formula_version IS NOT NULL OR EXISTS (SELECT 1 FROM po_edit_log e WHERE e.entity = 'asin' AND e.entity_id = pa.id::text AND e.user_id IS NOT NULL
               AND e.field IN ('sold_as', 'units_per_pack') AND NOT COALESCE(e.derived, false))) AS hand
       FROM po_asins pa JOIN po_asin_expected e ON e.id = pa.id JOIN purchase_orders p ON p.id = pa.po_id ${asins ? `WHERE pa.asin = ANY($1::text[])` : ""}`, asins ? [asins.map((x) => x.toUpperCase())] : [],
  )).rows;
  // Product units for the pack arithmetic (the view, D17).
  const lines = (await query(
    `SELECT l.po_asin_id, le.ordered_product AS qty_ordered, l.retailer_units_per_product, l.asin_units_per_pack, l.asin_qty_per_product
       FROM po_line_items l JOIN po_line_expected le ON le.line_id = l.id JOIN po_asins pa ON pa.id = l.po_asin_id ${asins ? `WHERE pa.asin = ANY($1::text[])` : ""}`, asins ? [asins.map((x) => x.toUpperCase())] : [],
  )).rows;
  const linesBy = new Map<string, PackLine[]>();
  for (const l of lines) { const k = String(l.po_asin_id); const a = linesBy.get(k) ?? []; a.push(l); linesBy.set(k, a); }
  const rowsBy = new Map<string, PackRow[]>();
  for (const r of rows) {
    const pack = r.sold_as == null ? null : r.sold_as === "individual" ? { sold_as: "individual" as const, units: 1 }
      : Number(r.units_per_pack) >= 1 ? { sold_as: r.sold_as as SoldAsValue, units: Number(r.units_per_pack) } : null;
    const a = rowsBy.get(r.asin) ?? [];
    a.push({ order_id: String(r.order_id), supplier: String(r.supplier ?? ""), closed: !!r.closed, order_date: r.order_date ? new Date(r.order_date).toISOString().slice(0, 10) : null,
      hand: !!r.hand, pack, qty: Number(r.qty) || 0, velocity_units: r.velocity_units_per_pack == null ? null : Number(r.velocity_units_per_pack), lines: linesBy.get(String(r.id)) ?? [] });
    rowsBy.set(r.asin, a);
  }
  return recs.map((a: any) => {
    const record = a.sold_as == null ? null : { sold_as: a.sold_as as SoldAsValue, units: a.sold_as === "individual" ? 1 : Number(a.units_per_pack) || 1 };
    return { asin: a.asin, title: a.title ?? null, record, recordSource: a.pack_source ?? null,
      recordMine: record != null && (["manual", "upload", "po_entry"].includes(a.pack_source) || !!a.user_logged), rows: rowsBy.get(a.asin) ?? [] };
  });
}

export interface ApplyResult { recordChanged: boolean; demoted: boolean; gaps: { openRows: number; closedRows: number; closedSkipped: number; lines: number } }

/** Write one decision: a confirmed pack (record + History + its PO gaps filled), or a review (suggestion columns; an unreviewed value on record moves there). */
export async function applyPackDecision(query: QueryLike, asin: string, d: PackDecision, userId: number | null): Promise<ApplyResult> {
  const a = asin.toUpperCase();
  const none = { openRows: 0, closedRows: 0, closedSkipped: 0, lines: 0 };
  if (d.kind === "mine") return { recordChanged: false, demoted: false, gaps: none };
  const cur = (await query(`SELECT sold_as, units_per_pack FROM asins WHERE asin = $1`, [a])).rows[0];
  if (!cur) return { recordChanged: false, demoted: false, gaps: none };
  const curVals = { sold_as: cur.sold_as ?? null, units_per_pack: cur.units_per_pack == null ? null : Number(cur.units_per_pack) };
  if (d.kind === "confirmed") {
    const next = { sold_as: d.pack.sold_as, units_per_pack: d.pack.sold_as === "individual" ? 1 : d.pack.units };
    const changes = changedFields(curVals, next);
    await query(`UPDATE asins SET sold_as = $2, units_per_pack = $3, pack_source = $4, pack_suggested_sold_as = NULL, pack_suggested_units = NULL, pack_suggestion_source = NULL, pack_review_reason = NULL, pack_note = $5, pack_evaluated_at = now() WHERE asin = $1`, [a, next.sold_as, next.units_per_pack, d.source, d.note]);
    for (const c of changes) await query(`INSERT INTO asin_field_log (asin, user_id, field, old_value, new_value, source) VALUES ($1, $2, $3, $4, $5, 'backfill')`, [a, userId, c.field, c.old, c.new]);
    const gaps = d.pack.sold_as === "bundle" ? none : await fillAsinPackGaps(query, a, d.pack.sold_as, next.units_per_pack, userId);
    return { recordChanged: changes.length > 0, demoted: false, gaps };
  }
  const demote = cur.sold_as != null;
  if (demote) {
    for (const c of changedFields(curVals, { sold_as: null, units_per_pack: null })) await query(`INSERT INTO asin_field_log (asin, user_id, field, old_value, new_value, source) VALUES ($1, $2, $3, $4, $5, 'backfill')`, [a, userId, c.field, c.old, c.new]);
  }
  await query(
    `UPDATE asins SET ${demote ? "sold_as = NULL, units_per_pack = NULL, pack_source = NULL, " : ""}pack_suggested_sold_as = $2, pack_suggested_units = $3, pack_suggestion_source = $4, pack_review_reason = $5, pack_note = $6, pack_evaluated_at = now() WHERE asin = $1`,
    [a, d.suggestion?.sold_as ?? null, d.suggestion ? (d.suggestion.sold_as === "individual" ? 1 : d.suggestion.units) : null, d.suggestionSource, d.reason, d.note],
  );
  return { recordChanged: demote, demoted: demote, gaps: none };
}

/**
 * Maria sets or confirms an ASIN's pack (the ASINs table, Confirm, an upload): confirmed with her as the source, History,
 * the suggestion cleared, every PO row with no pack filled STRICTLY by default (Maria 2026-11-06: open rows too only
 * where the pack reproduces the stored Ordered — a non-fitting row is listed in gaps.skipped, not written).
 */
export async function setAsinPack(query: QueryLike, asin: string, p: PackValue, userId: number | null, source: "manual" | "upload", opts: { strict?: boolean } = { strict: true }): Promise<{ asin: string; changed: boolean; gaps: ApplyResult["gaps"] & { openSkipped?: number; skipped?: PackGapSkip[] } }> {
  const a = asin.toUpperCase();
  if (!["individual", "multi-pack", "bundle"].includes(p.sold_as)) throw new EditError(400, "sold as must be individual, multi-pack or bundle");
  const units = p.sold_as === "individual" ? 1 : Number(p.units);
  if (!Number.isInteger(units) || units < 1 || (p.sold_as === "multi-pack" && units < 2)) throw new EditError(400, p.sold_as === "multi-pack" ? "a multi-pack needs 2 or more Individual units per ASIN unit" : "the pack size (Individual units per ASIN unit) must be a whole number");
  const cur = (await query(`SELECT sold_as, units_per_pack FROM asins WHERE asin = $1`, [a])).rows[0];
  if (!cur) throw new EditError(404, `${a} is not in AF`);
  const changes = changedFields({ sold_as: cur.sold_as ?? null, units_per_pack: cur.units_per_pack == null ? null : Number(cur.units_per_pack) }, { sold_as: p.sold_as, units_per_pack: units });
  await query(`UPDATE asins SET sold_as = $2, units_per_pack = $3, pack_source = $4, ${CLEAR_PACK_SUGGESTION_SQL}, pack_evaluated_at = now() WHERE asin = $1`, [a, p.sold_as, units, source]);
  for (const c of changes) await query(`INSERT INTO asin_field_log (asin, user_id, field, old_value, new_value, source) VALUES ($1, $2, $3, $4, $5, $6)`, [a, userId, c.field, c.old, c.new, source]);
  // A confirmation with no change still counts: the review is done.
  if (changes.length === 0) await query(`INSERT INTO asin_field_log (asin, user_id, field, old_value, new_value, source) VALUES ($1, $2, 'pack confirmed', NULL, $3, $4)`, [a, userId, packLabel({ sold_as: p.sold_as, units }), source]);
  const gaps = p.sold_as === "bundle" ? { openRows: 0, closedRows: 0, closedSkipped: 0, lines: 0 } : await fillAsinPackGaps(query, a, p.sold_as, units, userId, undefined, opts);
  return { asin: a, changed: changes.length > 0, gaps };
}

/** Bulk Confirm: each selected ASIN's suggestion becomes its pack (one with no suggestion, or already confirmed, is skipped). */
export async function confirmPackSuggestions(query: QueryLike, asins: string[], userId: number | null): Promise<{ confirmed: number; skipped: number; gaps: ApplyResult["gaps"] & { openSkipped: number; skipped: Array<PackGapSkip & { asin: string }> } }> {
  const rows = (await query(`SELECT asin, pack_suggested_sold_as, pack_suggested_units FROM asins WHERE asin = ANY($1::text[]) AND sold_as IS NULL AND pack_suggested_sold_as IS NOT NULL`, [asins.map((x) => x.toUpperCase())])).rows;
  const gaps = { openRows: 0, closedRows: 0, closedSkipped: 0, lines: 0, openSkipped: 0, skipped: [] as Array<PackGapSkip & { asin: string }> };
  for (const r of rows) {
    const g = (await setAsinPack(query, r.asin, { sold_as: r.pack_suggested_sold_as, units: Number(r.pack_suggested_units) || 1 }, userId, "manual")).gaps;
    gaps.openRows += g.openRows; gaps.closedRows += g.closedRows; gaps.closedSkipped += g.closedSkipped; gaps.lines += g.lines;
    gaps.openSkipped += g.openSkipped ?? 0; for (const s of g.skipped ?? []) gaps.skipped.push({ ...s, asin: r.asin });
  }
  return { confirmed: rows.length, skipped: asins.length - rows.length, gaps };
}

/** Pure: an exported / uploaded cell → a pack, or null (blank, or a value ending "?" — an unconfirmed suggestion is never confirmed by a round-trip). */
export function parseUploadPack(soldAs: unknown, size: unknown): PackValue | null {
  const s = String(soldAs ?? "").trim().toLowerCase(), n = String(size ?? "").trim();
  if (!s || s.endsWith("?") || n.endsWith("?")) return null;
  const sold = s === "individual" || s === "single" ? "individual" : s === "multi-pack" || s === "multipack" || s === "multi pack" ? "multi-pack" : s === "bundle" ? "bundle" : null;
  if (!sold) return null;
  if (sold === "individual") return { sold_as: "individual", units: 1 };
  const u = Number(n);
  return Number.isInteger(u) && u >= (sold === "multi-pack" ? 2 : 1) ? { sold_as: sold, units: u } : null;
}
