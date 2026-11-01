// COGS review list (Maria 2026-11-01, review answer 4). Read-only. For every
// sheet-imported PO ASIN row: AF's stored cost / unit vs the sheet's PO-level
// Adjusted COGS computed the way AF computes it (server/po-cogs-review.ts:
// Σ(col X × col L) ÷ col N, bundle-aware), from the Orders sheet as it is
// NOW (her fixes included). Rows she has already answered are excluded.
// Rows that differ by more than 2¢ go to docs/po-cogs-diff-<date>.csv; when
// there are more than 10, one Haiku batch call reads each row's sheet context
// (product rows, qty, pack, GC%) and answers "is AF's value explainable from
// these rows? yes / no + one line"; only the "no" rows go to
// docs/po-cogs-review-<date>.csv with the reason. 10 or fewer → no AI pass,
// the rows themselves are the list.
//
//   npm run po:cogs-review -- [--prod] [--no-ai] [--out <dir>]
// Needs DATABASE_URL, GOOGLE_SHEET_ID / GOOGLE_CREDENTIALS_PATH; the AI pass
// needs ANTHROPIC_API_KEY (with --prod from .env.production.local).
import "./env";
import { DB_TARGET } from "./env";
import fs from "fs";
import path from "path";
import pg from "pg";
import { z } from "zod/v4";
import { readPoSheet, moneyVerbatim } from "../server/po-sheet-sync";
import { COL, t } from "../server/po-import-classify";
import { csv } from "../server/po-model-backfill";
import { sheetCogsForAsin, differs, isAnswered, type SheetProductRow, type SheetCogs } from "../server/po-cogs-review";
import { aiAvailable, AI_OFF_MESSAGE, AI, estimateCost } from "../server/config/ai";
import { structuredBatchCall } from "../server/ai-batch";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const NO_AI = process.argv.includes("--no-ai");
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
const num = (v: string | undefined): number | null => { const s = t(v); if (!s) return null; try { const m = moneyVerbatim(s); return m.value == null ? null : Number(m.value); } catch { return null; } };
const qty = (v: string | undefined): number | null => { const s = t(v).replace(/,/g, ""); if (!s) return null; const n = Number(s); return Number.isFinite(n) ? n : null; };

const ReviewSchema = z.object({ items: z.array(z.object({ id: z.number().int(), explainable: z.boolean(), reason: z.string() })) });

let client: pg.Client | undefined;
async function main() {
  const url = process.env.DATABASE_URL; if (!url) throw new Error("DATABASE_URL not set");
  const c = (client = new pg.Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false } }));
  await c.connect();
  const q = (sql: string, params?: any[]) => c.query(sql, params);
  const has075 = ((await q(`SELECT 1 FROM information_schema.columns WHERE table_name = 'purchase_orders' AND column_name = 'cost_formula_version'`)).rowCount ?? 0) > 0;
  const sheetId = process.env.GOOGLE_SHEET_ID; if (!sheetId) throw new Error("GOOGLE_SHEET_ID not set");
  const { dataCells } = await readPoSheet(sheetId);
  const byRow = new Map<string, string[][]>();
  for (const cells of dataCells) {
    let supplier = t(cells[COL.supplier]); if (supplier === "shop.tetleyusa.com / WorldPantry.com") supplier = "shop.tetleyusa.com";
    const orderId = t(cells[COL.orderId]); if (!orderId) continue;
    const k = `${supplier}\u0000${orderId}\u0000${t(cells[COL.asin]).toUpperCase()}`;
    const l = byRow.get(k); if (l) l.push(cells); else byRow.set(k, [cells]);
  }
  const rows = (await q(`SELECT pa.id, pa.asin, pa.qty::float AS qty, pa.cost_per_unit::float AS af_cost, pa.sold_as, pa.units_per_pack, p.supplier, p.order_id, p.order_date, p.weighted_gc_discount_pct::float AS gc
      FROM po_asins pa JOIN purchase_orders p ON p.id = pa.po_id
     WHERE p.source = 'sheet_import' ${has075 ? "AND p.cost_formula_version IS NULL" : ""} ORDER BY p.order_date DESC, p.order_id, pa.asin`)).rows;
  type Cand = { id: number; po_asin_id: string; supplier: string; order_id: string; order_date: string; asin: string; af_cost: number | null; af_qty: number | null; gc: number | null; sheet: SheetCogs; products: SheetProductRow[] };
  const cands: Cand[] = [];
  let notInSheet = 0, answered = 0, match = 0, matchesSheetY = 0, uncomputable = 0, bothBlank = 0;
  for (const r of rows) {
    const cells = byRow.get(`${r.supplier}\u0000${r.order_id}\u0000${String(r.asin).toUpperCase()}`);
    if (!cells) { notInSheet++; continue; }
    const products: SheetProductRow[] = cells.map((x) => ({
      productName: t(x[COL.productName]), status: t(x[COL.status]) || "Ordered", price: num(x[COL.price]), qtyOrdered: qty(x[COL.qtyOrdered]), asinQty: qty(x[COL.asinQtyTotal]),
      uniqueProducts: qty(x[COL.uniqueProductsPerAsin]), yieldPerProduct: qty(x[COL.asinQtyPerProduct]), adjProductCost: num(x[COL.adjProductCost]), adjCogs: num(x[COL.adjCogs]),
      soldAs: t(x[COL.soldAs]), unitsPerPack: t(x[COL.unitsPerPack]),
    }));
    const sheet = sheetCogsForAsin(products);
    if (isAnswered(String(r.order_id), String(r.asin))) { answered++; continue; }
    // Both sides blank (AF NULL, the sheet's X and Y blank — typically a canceled-only row): nothing to review.
    if (r.af_cost == null && sheet.computed == null && sheet.sheetY == null) { bothBlank++; continue; }
    if (sheet.computed == null) { uncomputable++; }
    else if (!differs(r.af_cost, sheet.computed)) { match++; continue; }
    if (sheet.computed == null && !differs(r.af_cost, sheet.sheetY)) { match++; continue; }
    if (!differs(r.af_cost, sheet.sheetY)) matchesSheetY++;
    const od = r.order_date instanceof Date ? r.order_date.toISOString().slice(0, 10) : String(r.order_date).slice(0, 10);
    cands.push({ id: cands.length + 1, po_asin_id: String(r.id), supplier: r.supplier, order_id: r.order_id, order_date: od, asin: String(r.asin).toUpperCase(), af_cost: r.af_cost, af_qty: r.qty, gc: r.gc, sheet, products });
  }
  console.log(`COGS review against ${DB_TARGET}: ${rows.length} sheet-imported ASIN row(s); ${match} match the sheet's computed COGS (±2¢), ${answered} already answered by Maria (excluded), ${notInSheet} not in the sheet, ${bothBlank} blank on both sides (nothing to review), ${uncomputable} not computable from the sheet rows (mixed S / missing X)`);
  console.log(`  differ: ${cands.length} row(s) — of which ${matchesSheetY} equal the sheet's own col Y (the sheet's Y formula differs from Σ(X×L)÷N on that row)`);
  const outDir = arg("--out") ?? "docs";
  const ctx = (x: Cand) => `AF cost/unit ${x.af_cost ?? "NULL"} · AF ASIN qty ${x.af_qty ?? "?"} · GC% ${x.gc ?? 0} · sheet mode ${x.sheet.mode} · sheet ASIN qty ${x.sheet.asinQty ?? "?"} · Σ(X×L) ${x.sheet.productSum ?? "?"} · computed ${x.sheet.computed ?? "n/a"} · sheet Y ${x.sheet.sheetY ?? "blank"} · rows: ` +
    x.products.map((p) => `[${p.status}; "${p.productName.slice(0, 50)}"; price ${p.price ?? "?"}; L ${p.qtyOrdered ?? "?"}; N ${p.asinQty ?? "?"}; S ${p.uniqueProducts ?? "-"}; T ${p.yieldPerProduct ?? "-"}; X ${p.adjProductCost ?? "?"}; Y ${p.adjCogs ?? "?"}; pack ${p.soldAs || "-"}×${p.unitsPerPack || "-"}]`).join(" ");
  const diffFile = path.join(outDir, `po-cogs-diff-${today}.csv`);
  fs.writeFileSync(diffFile, csv([["supplier", "order_id", "order_date", "asin", "af_cost_per_unit", "sheet_computed (Σ X×L ÷ N)", "sheet_col_Y", "af_equals_sheet_Y", "delta_af_minus_computed", "sheet_context"],
    ...cands.map((x) => [x.supplier, x.order_id, x.order_date, x.asin, x.af_cost, x.sheet.computed ?? "", x.sheet.sheetY ?? "", differs(x.af_cost, x.sheet.sheetY) ? "no" : "yes", x.af_cost != null && x.sheet.computed != null ? (x.af_cost - x.sheet.computed).toFixed(2) : "", ctx(x)])]));
  console.log(`  full diff list → ${diffFile}`);
  let review: Array<{ x: Cand; reason: string }> = [];
  if (cands.length <= 10 || NO_AI) {
    review = cands.map((x) => ({ x, reason: cands.length <= 10 ? "(≤ 10 rows: no AI pass)" : "(AI pass skipped: --no-ai)" }));
    console.log(cands.length <= 10 ? "  10 or fewer rows — no AI pass; the rows are the list" : "  AI pass skipped (--no-ai)");
  } else {
    if (!aiAvailable()) throw new Error(AI_OFF_MESSAGE);
    const system = `You audit purchase-order costs for an Amazon reseller. For each item you get AF's stored cost per unit for an ASIN on one PO, and the spreadsheet rows that PO's ASIN has: product rows with price, L = units ordered, N = total ASIN qty for the order, S = unique products per ASIN (≥ 2 = a bundle), T = ASIN units per product (yield), X = Adjusted Product Cost per product, Y = the sheet's COGS per ASIN unit, pack (sold_as × units_per_pack), and GC% = the weighted gift-card discount. AF normally stores Y: the first row's Y, or the N-weighted average over several S=1 rows. "computed" = Σ(X × L) ÷ N is the expected COGS per ASIN unit.
Answer for each item whether AF's value is EXPLAINABLE from these rows: true when it equals the sheet's Y, a weighted average or bundle sum of the rows, the computed value within rounding, a per-unit cost before/after the GC% discount, a cost divided by the pack size or yield, or any other arithmetic the rows support (say which in one short line); false when no arithmetic from the rows gives AF's value (say what the rows give instead). Return every id exactly once.`;
    const user = `Audit these ${cands.length} rows. One per line: id<TAB>supplier order#<TAB>ASIN<TAB>context\n` + cands.map((x) => `${x.id}\t${x.supplier} ${x.order_id}\t${x.asin}\t${ctx(x)}`).join("\n");
    const t0 = Date.now();
    const r = await structuredBatchCall(system, user, ReviewSchema);
    const parsed = ReviewSchema.safeParse(r.parsed);
    console.log(`  AI pass: ${AI.model} · ${r.input_tokens} in / ${r.output_tokens} out · $${estimateCost(r.input_tokens, r.output_tokens)} · ${Date.now() - t0} ms · stop ${r.stop_reason} · schema ${parsed.success ? "ok" : "FAILED"}`);
    if (!parsed.success || r.stop_reason === "max_tokens") throw new Error("AI pass failed — the diff list stands, no review list written");
    const byId = new Map(parsed.data.items.map((i) => [i.id, i]));
    let yes = 0, missing = 0;
    for (const x of cands) {
      const a = byId.get(x.id);
      if (!a) { missing++; review.push({ x, reason: "(not answered by the model)" }); continue; }
      if (a.explainable) yes++; else review.push({ x, reason: a.reason });
    }
    console.log(`  explainable ${yes} · not explainable ${review.length - missing} · not answered ${missing}`);
  }
  const reviewFile = path.join(outDir, `po-cogs-review-${today}.csv`);
  fs.writeFileSync(reviewFile, csv([["supplier", "order_id", "order_date", "asin", "af_cost_per_unit", "sheet_computed (Σ X×L ÷ N)", "sheet_col_Y", "reason", "Maria: correct value / note"],
    ...review.map(({ x, reason }) => [x.supplier, x.order_id, x.order_date, x.asin, x.af_cost, x.sheet.computed ?? "", x.sheet.sheetY ?? "", reason, ""])]));
  console.log(`  review list → ${reviewFile} (${review.length} row(s))`);
  await c.end();
}
main().catch((e) => { console.error("FATAL", e?.message ?? e); process.exitCode = 1; }).finally(() => client?.end().catch(() => {}));
