// One-time 2026 PO importer — docs/po-module-v1-frame-plan.md §2.
//
// DRY-RUN BY DEFAULT: no writes of any kind without --live, and a live run
// is only legitimate after the dry-run report has been reviewed (AF's
// dry-run-before-writes principle). Idempotent on (supplier, order_id):
// existing POs are skipped and reported, so a partial import resumes safely.
//
// Input CSV is the Orders-tab export, PRE-FILTERED to 2026 (1,158 rows, 768
// orders, all 52 columns, cells verbatim). The pre-filter means the
// totalsRow/blankRows/nonYear2026 buckets must all report 0 — they are still
// counted and printed in the row-accounting identity as proof.
//
// Snapshots copy VERBATIM (cost_per_unit = Col Y, adjusted_product_cost =
// Col X): values are carried as exact decimal strings — never re-derived,
// never rounded, never through a float. ONE exception (ruled 2026-08-21):
// same-ASIN groups where every row has Col S = 1 are independent supplier
// pack-size listings feeding one ASIN — additive rows, NOT bundles. Their
// qty = SUM(Col N); cost_per_unit = verbatim when all rows agree, else a
// qty-weighted average in integer cents (SPEC §11 SB-export same-date-merge
// precedent), reported as a deviation-from-verbatim. Cross-check per group:
// SUM(Col N) == SUM(qty_ordered × asin_qty_per_product) — mismatches are
// reported loudly (imported with SUM(N), never silently). Mixed groups
// (some rows S=1, some S≥2) are a data error: the whole PO is skipped and
// reported, never guessed.
//
// Usage (sheet mode, default): npx tsx script/import-po-2026.ts [--live]
//   Reads the mirror sheet directly — GOOGLE_SHEET_ID, Sheet1, A2:AZ — through
//   the same shared raw read as the PO sync (server/sheet-read.ts). Header
//   sanity reads A1:AZ1. SPEC §11 mirror caveats apply (IMPORTRANGE coverage,
//   mirror refresh lag).
// Usage (CSV fallback): npx tsx script/import-po-2026.ts --csv <orders.csv> [--live]
//   Identical parsing/gates/identity; the CSV's line 1 is the header row, so
//   data rows start at source row 2 in both modes and row numbering matches.
import "dotenv/config";
import fs from "fs";
import Papa from "papaparse";
import pg from "pg";
import { getSheetValues } from "../server/sheet-read";
// Row classification + the pure primitives it needs live in server/ so the
// test can import classifyRows WITHOUT pulling this driver into the test
// typecheck (2026-10-03). One definition of each, imported back here.
import { COL, t, parseDateMDY, classifyRows } from "../server/po-import-classify";
import { mapSheetStatus } from "../server/po-status-map";

const LIVE = process.argv.includes("--live");
const CSV_FLAG = process.argv.indexOf("--csv");
const csvPath = CSV_FLAG >= 0 ? process.argv[CSV_FLAG + 1] : null;
if (CSV_FLAG >= 0 && (!csvPath || csvPath.startsWith("--"))) {
  console.error("usage: npx tsx script/import-po-2026.ts [--csv <orders.csv>] [--live]");
  process.exit(1);
}

// Header sanity: refuse to run against a differently-shaped export.
const HEADER_EXPECT: Array<[number, string]> = [
  [COL.orderId, "Order ID"], [COL.orderDate, "Order Date"], [COL.supplier, "Supplier"],
  [COL.asin, "ASIN"], [COL.asinQtyTotal, "Total ASIN Qty per Order"],
  [COL.adjProductCost, "Adjusted Product Cost"], [COL.adjCogs, "COGS"],
  [COL.prepCost, "Prep cost"], [COL.soldAs, "sold_as"], [COL.unitsPerPack, "units_per_pack"],
];

// ── cleanup + parsing helpers ─────────────────────────────────────────────────
interface CleanupHit { rule: string; row: number; order: string; from: string; to: string }
const cleanupHits: CleanupHit[] = [];
const observations: string[] = [];

// Verbatim money: "$1,234.56" → "1234.56" (exact string, no float). "" → null.
// "#DIV/0!" → null + cleanup hit (caller records). "(1.23)" → "-1.23".
function moneyVerbatim(raw: string): { value: string | null; divzero: boolean } {
  const s = t(raw);
  if (s === "") return { value: null, divzero: false };
  if (s.includes("#DIV/0!")) return { value: null, divzero: true };
  let neg = false;
  let x = s.replace(/[$,\s]/g, "");
  if (/^\(.*\)$/.test(x)) { neg = true; x = x.slice(1, -1); }
  if (x.startsWith("-")) { neg = true; x = x.slice(1); }
  if (!/^\d*\.?\d*$/.test(x) || x === "" || x === ".") throw new Error(`unparseable money: ${JSON.stringify(s)}`);
  return { value: (neg ? "-" : "") + x, divzero: false };
}

function pctToNumber(raw: string): string | null {
  const s = t(raw);
  if (s === "") return null;
  const x = s.replace(/%$/, "").trim();
  if (!/^\d*\.?\d+$/.test(x)) throw new Error(`unparseable percent: ${JSON.stringify(s)}`);
  return x;
}

function intOrNull(raw: string): number | null {
  const s = t(raw);
  if (s === "") return null;
  const n = Number(s.replace(/,/g, ""));
  if (!Number.isFinite(n)) throw new Error(`unparseable int: ${JSON.stringify(s)}`);
  return Math.round(n);
}

// Exact decimal string → integer cents (no float). "13.93" → 1393.
function toCents(dec: string): number {
  const neg = dec.startsWith("-");
  const [w, f = ""] = (neg ? dec.slice(1) : dec).split(".");
  const cents = Number(w || "0") * 100 + Number((f + "00").slice(0, 2));
  if (!Number.isFinite(cents)) throw new Error(`toCents: ${JSON.stringify(dec)}`);
  return neg ? -cents : cents;
}
const centsToDec = (c: number): string => `${c < 0 ? "-" : ""}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, "0")}`;

// Exact decimal string → integer hundredths (for Col T, NUMERIC(8,2)).
const toHundredths = toCents;

function hit(rule: string, row: number, order: string, from: string, to: string) {
  cleanupHits.push({ rule, row, order, from, to });
}

async function main() {
  // Both modes yield the same shape: a header row (CSV line 1 / sheet A1:AZ1)
  // for the sanity check, and data rows whose srcRow numbering starts at 2
  // (CSV line 2 / sheet row 2 — the A2:AZ range).
  let header: string[];
  let dataCells: string[][];
  if (csvPath) {
    const raw = fs.readFileSync(csvPath, "utf-8");
    const parsed = Papa.parse<string[]>(raw.replace(/^﻿/, ""), { skipEmptyLines: false });
    if (parsed.errors.length > 0) throw new Error(`CSV parse errors: ${JSON.stringify(parsed.errors.slice(0, 3))}`);
    const all = parsed.data as string[][];
    header = all[0];
    dataCells = all.slice(1);
  } else {
    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) throw new Error("GOOGLE_SHEET_ID not configured (sheet mode is the default; use --csv <path> for a file)");
    const headerRows = await getSheetValues(sheetId, "Sheet1!A1:AZ1");
    if (headerRows.length !== 1) throw new Error(`sheet header read: expected 1 row from A1:AZ1, got ${headerRows.length}`);
    header = headerRows[0].map((c: any) => String(c ?? ""));
    dataCells = (await getSheetValues(sheetId, "Sheet1!A2:AZ")).map(
      (row: any[]) => row.map((c: any) => String(c ?? "")),
    );
  }
  for (const [idx, expect] of HEADER_EXPECT) {
    if (!String(header[idx] ?? "").includes(expect)) {
      throw new Error(`header mismatch at col ${idx}: expected to contain ${JSON.stringify(expect)}, got ${JSON.stringify(header[idx])}`);
    }
  }
  const dataRows = dataCells.map((cells, i) => ({ cells, srcRow: i + 2 })); // 1-based incl. header

  const cls = classifyRows(dataRows);
  const { totalsRow, blankRows, nonYear2026, blankOrderId, noAsin, rows } = cls;
  observations.push(...cls.notes);

  // ── group by (Order ID, Supplier) ────────────────────────────────────────────
  interface PoGroup { orderId: string; supplier: string; rows: typeof rows }
  const groups = new Map<string, PoGroup>();
  for (const r of rows) {
    let supplier = t(r.cells[COL.supplier]);
    if (supplier === "shop.tetleyusa.com / WorldPantry.com") {
      hit("supplier tetley/WorldPantry", r.srcRow, t(r.cells[COL.orderId]), supplier, "shop.tetleyusa.com");
      supplier = "shop.tetleyusa.com";
    }
    const orderId = t(r.cells[COL.orderId]);
    const key = `${supplier}\u0000${orderId}`;
    if (!groups.has(key)) groups.set(key, { orderId, supplier, rows: [] as any });
    groups.get(key)!.rows.push(r);
  }

  // ── order-level disagreement check (first-row-wins, every disagreement reported) ──
  const ORDER_LEVEL: Array<[number, string]> = [
    [COL.rcpt, "Rcpt"], [COL.orderDate, "Order Date"], [COL.status, "Status"],
    [COL.subtotal, "Subtotal"], [COL.tax, "Tax"], [COL.shDonations, "S&H+Donations"],
    [COL.discount, "Discount"], [COL.refundAmount, "Refund Amount"], [COL.orderTotal, "Order Total"],
    [COL.paymentMethod, "Payment Method"], [COL.weightedGcPct, "Weighted GC %"], [COL.promo, "Promo"],
    [COL.cashbackSite, "Cashback Site"], [COL.cashbackPct, "Cashback %"], [COL.purchasedBy, "Purchased by"],
    [COL.subscription, "Subscription"], [COL.notes, "Notes"], [COL.emailUsed, "Email used"],
  ];
  const discrepancies: string[] = [];
  for (const g of groups.values()) {
    const first = g.rows[0].cells;
    for (const r of g.rows.slice(1)) {
      for (const [idx, label] of ORDER_LEVEL) {
        if (t(r.cells[idx]) !== t(first[idx])) {
          discrepancies.push(`${g.supplier} ${g.orderId} [${label}]: first-row ${JSON.stringify(t(first[idx]))} wins over row ${r.srcRow} ${JSON.stringify(t(r.cells[idx]))}`);
        }
      }
    }
  }

  // ── build PO records with cleanup map ────────────────────────────────────────
  const divzeroCells: string[] = [];
  const outsideLookups = { payment: new Map<string, number>(), cashback: new Map<string, number>() };
  const SEEDED_PAYMENT = new Set(["Gift cards","Amex (1001)","Amex (1005)","Chase (7927)","Chase (9647)","Chase Ink (7927)","Chase (6120)","Citi (9510)","Discover","Webstaurant Visa","Amex (1002)","Walmart card","Citi (9627)"]); // incl. migration 029 additions
const SEEDED_PAYMENT_BY_LC = new Map([...SEEDED_PAYMENT].map((v) => [v.toLowerCase(), v]));
  const SEEDED_CASHBACK = new Set(["BeFrugal","TopCashback","Rakuten","RetailMeNot","Coupert"]);

  const money = (g: PoGroup, r: { cells: string[]; srcRow: number }, idx: number): string | null => {
    const m = moneyVerbatim(r.cells[idx]);
    if (m.divzero) { divzeroCells.push(`${g.supplier} ${g.orderId} row ${r.srcRow} col ${idx}`); hit("#DIV/0! → NULL", r.srcRow, g.orderId, "#DIV/0!", "NULL"); }
    return m.value;
  };

  // S=1 same-ASIN merge rule (2026-08-21) reporting structures
  const mergedGroups: string[] = [];
  const crossCheckMismatches: string[] = [];
  const skippedMixedPOs: string[] = [];

  const pos: any[] = [];
  for (const g of groups.values()) {
    const f = g.rows[0];
    const c = f.cells;

    let payment: string | null = t(c[COL.paymentMethod]) || null;
    if (payment === "Gift card") { hit("payment Gift card → Gift cards", f.srcRow, g.orderId, payment, "Gift cards"); payment = "Gift cards"; }
    if (payment === "Visa 7927") { hit("payment Visa 7927 → Chase (7927)", f.srcRow, g.orderId, payment, "Chase (7927)"); payment = "Chase (7927)"; }
    // Case-insensitive normalization (ruled 2026-08-21): any casing variant
    // of a seeded value normalizes to the seeded spelling. Single-token only —
    // split-payment strings stay verbatim.
    if (payment && !payment.includes(":") && !SEEDED_PAYMENT.has(payment)) {
      const seeded = SEEDED_PAYMENT_BY_LC.get(payment.toLowerCase());
      if (seeded) { hit(`payment case-normalized → ${seeded}`, f.srcRow, g.orderId, payment, seeded); payment = seeded; }
    }
    if (payment && !SEEDED_PAYMENT.has(payment)) outsideLookups.payment.set(payment, (outsideLookups.payment.get(payment) ?? 0) + 1);

    let cashback: string | null = t(c[COL.cashbackSite]) || null;
    if (cashback === "Topcashback") { hit("cashback Topcashback → TopCashback", f.srcRow, g.orderId, cashback, "TopCashback"); cashback = "TopCashback"; }
    if (cashback === "-" || cashback === "Coupons") { hit(`cashback ${cashback} → NULL`, f.srcRow, g.orderId, cashback, "NULL"); cashback = null; }
    if (cashback && !SEEDED_CASHBACK.has(cashback)) outsideLookups.cashback.set(cashback, (outsideLookups.cashback.get(cashback) ?? 0) + 1);

    let wgc = pctToNumber(c[COL.weightedGcPct]);
    if (g.orderId === "130097" && wgc != null) {
      hit("order 130097: drop stray Weighted GC %", f.srcRow, g.orderId, `${wgc}%`, "NULL");
      wgc = null;
    }

    let email: string | null = t(c[COL.emailUsed]) || null;
    if (email === null) email = "orders@coastalqualitygoods.com"; // blank = the column's "if different from orders@" semantics

    const rcpt = t(c[COL.rcpt]).toUpperCase() === "TRUE";
    if (rcpt) hit("Rcpt TRUE → invoice_attached", f.srcRow, g.orderId, "TRUE", "invoice_attached=true");

    // po_asins: group rows by ASIN
    const byAsin = new Map<string, typeof g.rows>();
    for (const r of g.rows) {
      const a = t(r.cells[COL.asin]).toUpperCase();
      if (!byAsin.has(a)) byAsin.set(a, [] as any);
      byAsin.get(a)!.push(r);
    }
    const poAsins: any[] = [];
    let mixedSError = false;
    for (const [asin, ars] of byAsin) {
      const ar = ars[0];
      const sVals = ars.map((r) => intOrNull(r.cells[COL.uniqueProductsPerAsin]) ?? 1);
      const isBundleGroup = sVals.every((v) => v >= 2);
      const isS1Group = sVals.every((v) => v <= 1);
      // Mixed S within one ASIN group = data error: skip the whole PO, never guess.
      if (ars.length > 1 && !isBundleGroup && !isS1Group) {
        skippedMixedPOs.push(`${g.supplier} ${g.orderId} — ASIN ${asin}: mixed Col S values ${JSON.stringify(sVals)} across rows ${ars.map((r) => r.srcRow).join(",")}`);
        mixedSError = true;
        break;
      }

      let qty: number;
      let costPerUnit: string | null;
      if (ars.length > 1 && isS1Group) {
        // S=1 merge rule: independent supplier pack-size listings feeding one
        // ASIN — additive rows. qty = SUM(Col N). Cross-check against
        // SUM(qty_ordered × Col T); mismatch reported LOUDLY, never silent.
        const perRow = ars.map((r) => ({
          srcRow: r.srcRow,
          n: intOrNull(r.cells[COL.asinQtyTotal]) ?? 0,
          qtyOrdered: intOrNull(r.cells[COL.qtyOrdered]) ?? 0,
          tHundredths: toHundredths(t(r.cells[COL.asinQtyPerProduct]) === "" ? "1" : t(r.cells[COL.asinQtyPerProduct])),
          y: money(g, r, COL.adjCogs),
        }));
        qty = perRow.reduce((a, r) => a + r.n, 0);
        const derivedHundredths = perRow.reduce((a, r) => a + r.qtyOrdered * r.tHundredths, 0);
        const crossOk = derivedHundredths === qty * 100;
        if (!crossOk) {
          crossCheckMismatches.push(`${g.supplier} ${g.orderId} — ASIN ${asin}: SUM(Col N)=${qty} vs SUM(qty_ordered×Col T)=${(derivedHundredths / 100).toFixed(2)} — IMPORTED with SUM(Col N), review`);
        }
        // cost_per_unit: verbatim when all rows agree; else qty-weighted
        // average in integer cents (SPEC §11 same-date-merge precedent).
        // Weight basis = Col N (per-row ASIN qty). REVIEWED 2026-08-20 AND
        // STANDS: the homedepot WN63100522 group (N=1/N=0 → $17.61) was
        // examined and accepted as an outlier, not a rule problem — do not
        // reopen the weighting basis.
        const yVals = [...new Set(perRow.map((r) => r.y ?? "NULL"))];
        if (yVals.length === 1) {
          costPerUnit = perRow[0].y;
        } else {
          const usable = perRow.filter((r) => r.y != null && r.n > 0);
          const totQty = usable.reduce((a, r) => a + r.n, 0);
          const wCents = totQty > 0 ? Math.round(usable.reduce((a, r) => a + toCents(r.y!) * r.n, 0) / totQty) : null;
          costPerUnit = wCents != null ? centsToDec(wCents) : null;
        }
        mergedGroups.push(
          `${g.supplier} ${g.orderId} — ASIN ${asin} (${ars.length} rows):\n` +
          perRow.map((r) => `      row ${r.srcRow}: N=${r.n} qty_ordered=${r.qtyOrdered} T=${(r.tHundredths / 100).toFixed(2)} Y=${r.y ?? "NULL"}`).join("\n") +
          `\n      → qty=${qty}  cross-check SUM(qty_ordered×T)=${(derivedHundredths / 100).toFixed(2)} ${crossOk ? "✓" : "✗ MISMATCH"}  cost_per_unit=${costPerUnit ?? "NULL"}${yVals.length > 1 ? " (qty-weighted avg — DEVIATION FROM VERBATIM, inputs: " + perRow.map((r) => `${r.y ?? "NULL"}×${r.n}`).join(", ") + ")" : " (verbatim, all rows agree)"}`,
        );
      } else {
        // Single row, or bundle group (S ≥ 2): Col N is the duplicated group
        // total — take-first, verbatim. Verify N agreement on bundles.
        if (ars.length > 1) {
          const qtys = new Set(ars.map((r) => t(r.cells[COL.asinQtyTotal])));
          if (qtys.size > 1) discrepancies.push(`${g.supplier} ${g.orderId} [ASIN ${asin} Col N]: differing per-ASIN qty ${JSON.stringify([...qtys])} — first-row wins`);
        }
        qty = intOrNull(ar.cells[COL.asinQtyTotal]) ?? 0;
        costPerUnit = money(g, ar, COL.adjCogs);
      }

      const prepRaw = t(ar.cells[COL.prepCost]);
      const prep = prepRaw === "" ? "0" : moneyVerbatim(prepRaw).value ?? "0";
      const soldAs = t(ar.cells[COL.soldAs]) || "individual";
      const upp = soldAs === "individual" ? 1 : (intOrNull(ar.cells[COL.unitsPerPack]) ?? 1);
      poAsins.push({
        asin, asinName: t(ar.cells[COL.asinName]) || null,
        qty,
        costPerUnit,
        prep, soldAs, unitsPerPack: upp,
        lossQty: intOrNull(ar.cells[COL.lossQty]) ?? 0,
        lossAmount: moneyVerbatim(t(ar.cells[COL.lossAmount])).value ?? "0",
        isBundle: isBundleGroup && ars.length > 1,
        componentRows: ars.length,
        lines: ars.map((r, i) => ({
          srcRow: r.srcRow, position: i,
          productName: t(r.cells[COL.productName]) || null,
          supplierSku: t(r.cells[COL.skuUpc]) || null,
          price: money(g, r, COL.price),
          qtyOrdered: intOrNull(r.cells[COL.qtyOrdered]),
          qtyReceived: intOrNull(r.cells[COL.qtyReceived]), // blank → NULL, never 0
          qtyReturned: intOrNull(r.cells[COL.qtyReturned]) ?? 0, // blank = none occurred (stands, 2026-08-22)
          asinQtyPerProduct: t(r.cells[COL.asinQtyPerProduct]) === "" ? "1" : t(r.cells[COL.asinQtyPerProduct]),
          adjustedProductCost: money(g, r, COL.adjProductCost),
        })),
      });
    }

    if (mixedSError) continue; // PO skipped + reported above

    // Status cell → Action Items model (patch §6; 2026-10-16). The old
    // `status` column is no longer written: action items → action_items,
    // "Closed" → closed_at/closed_by='sheet', "Canceled" → qty_canceled on
    // every line (PO-wide), Received/Returned/Ordered → nothing. An
    // unmapped token is reported and the PO is skipped.
    const sheetStatus = mapSheetStatus(t(c[COL.status]) || "Ordered");
    if (sheetStatus.unmapped.length > 0) { discrepancies.push(`${g.supplier} ${g.orderId} [Status]: unmapped token(s) ${JSON.stringify(sheetStatus.unmapped)} — PO skipped`); continue; }
    pos.push({
      orderId: g.orderId, orderDate: g.rows[0].dateIso, supplier: g.supplier,
      actionItems: sheetStatus.actionItems, closedFromSheet: sheetStatus.closed, canceledFromSheet: sheetStatus.canceled,
      subtotal: money(g, f, COL.subtotal) ?? "0", tax: money(g, f, COL.tax) ?? "0",
      shDonations: money(g, f, COL.shDonations) ?? "0", discount: money(g, f, COL.discount) ?? "0",
      refundAmount: money(g, f, COL.refundAmount) ?? "0", orderTotal: money(g, f, COL.orderTotal) ?? "0",
      payment, wgc, promo: t(c[COL.promo]) || null, cashback, cashbackPct: pctToNumber(c[COL.cashbackPct]),
      purchasedBy: t(c[COL.purchasedBy]) || null,
      subscription: t(c[COL.subscription]).toUpperCase() === "TRUE",
      email, invoiceAttached: rcpt, notes: t(c[COL.notes]) || null,
      poAsins,
    });
  }

  // ── DB: idempotency + Amazon SKU join (read-only in dry-run) ────────────────
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const existing = new Set(
    (await pool.query(`SELECT supplier, order_id FROM purchase_orders`)).rows
      .map((r: any) => `${r.supplier}\u0000${r.order_id}`),
  );
  const allAsins = [...new Set(pos.flatMap((p) => p.poAsins.map((a: any) => a.asin)))];
  const skuRows = (await pool.query(
    `SELECT asin, primary_sku FROM asins WHERE asin = ANY($1::text[])`, [allAsins],
  )).rows;
  const skuByAsin = new Map(skuRows.map((r: any) => [r.asin, r.primary_sku]));

  const toImport = pos.filter((p) => !existing.has(`${p.supplier}\u0000${p.orderId}`));
  const skippedExisting = pos.length - toImport.length;

  let asinRowsTotal = 0, lineRowsTotal = 0, skuMatched = 0, skuNull = 0;
  const bundles: string[] = [];
  for (const p of toImport) {
    for (const a of p.poAsins) {
      asinRowsTotal++;
      lineRowsTotal += a.lines.length;
      a.sku = skuByAsin.get(a.asin) ?? null;
      if (a.sku) skuMatched++; else skuNull++;
      if (a.isBundle) bundles.push(`${p.supplier} ${p.orderId} — ${a.asin} (${a.componentRows} components, sold_as=${a.soldAs})`);
    }
  }

  // ── report ──────────────────────────────────────────────────────────────────
  const importedRows = rows.length - 0; // every classified row belongs to a group
  const rawRowsRead = dataRows.length;
  const remainder = rawRowsRead - (totalsRow + blankRows + nonYear2026 + blankOrderId + noAsin + importedRows);

  console.log(`\n=== PO IMPORT ${LIVE ? "LIVE RUN" : "DRY RUN (no writes)"} — ${csvPath ?? `sheet ${process.env.GOOGLE_SHEET_ID} (mirror, Sheet1!A2:AZ)`} ===\n`);
  console.log(`ROW ACCOUNTING IDENTITY`);
  console.log(`  rawRowsRead(${rawRowsRead}) = totalsRow(${totalsRow}) + blankRows(${blankRows}) + nonYear2026(${nonYear2026}) + blankOrderId(${blankOrderId}) + noAsin(${noAsin}) + importedRows(${importedRows})`);
  console.log(`  remainder: ${remainder} ${remainder === 0 ? "✓" : "✗✗✗ MUST BE 0"}`);
  console.log(`\nWOULD ${LIVE ? "INSERT" : "INSERT (dry)"}:`);
  console.log(`  purchase_orders: ${toImport.length}  (skipped existing: ${skippedExisting})`);
  console.log(`  po_asins:        ${asinRowsTotal}  (Amazon SKU joined: ${skuMatched}, NULL → amber: ${skuNull})`);
  console.log(`  po_line_items:   ${lineRowsTotal}`);
  console.log(`\nS=1 SAME-ASIN MERGES (additive rows → one po_asins): ${mergedGroups.length} groups`);
  console.log(`  (N-weighted cost basis reviewed 2026-08-20 and stands — homedepot WN63100522 $17.61 outlier accepted; do not reopen)`);
  for (const m of mergedGroups) console.log(`  ${m}`);
  console.log(`\nCROSS-CHECK MISMATCHES (SUM N ≠ SUM qty_ordered×T): ${crossCheckMismatches.length}`);
  for (const m of crossCheckMismatches) console.log(`  ${m}`);
  console.log(`\nPOs SKIPPED — MIXED Col S GROUPS (data error): ${skippedMixedPOs.length}`);
  for (const m of skippedMixedPOs) console.log(`  ${m}`);
  console.log(`\nBUNDLES (Col S ≥ 2): ${bundles.length} po_asins rows`);
  for (const b of bundles) console.log(`  ${b}`);
  console.log(`\n#DIV/0! CELLS → NULL: ${divzeroCells.length}`);
  for (const d of divzeroCells) console.log(`  ${d}`);
  const byRule = new Map<string, CleanupHit[]>();
  for (const h of cleanupHits) { if (!byRule.has(h.rule)) byRule.set(h.rule, []); byRule.get(h.rule)!.push(h); }
  console.log(`\nCLEANUP MAP HITS (${cleanupHits.length} total):`);
  for (const [rule, hs] of byRule) {
    console.log(`  ${rule}: ${hs.length}`);
    if (rule !== "Rcpt TRUE → invoice_attached" && rule !== "#DIV/0! → NULL") {
      for (const h of hs) console.log(`    row ${h.row} order ${h.order}: ${JSON.stringify(h.from)} → ${JSON.stringify(h.to)}`);
    }
  }
  console.log(`\nORDER-LEVEL DISAGREEMENTS (first-row-wins applied): ${discrepancies.length}`);
  for (const d of discrepancies) console.log(`  ${d}`);
  console.log(`\nVALUES OUTSIDE SEEDED LOOKUPS (imported verbatim — review):`);
  console.log(`  payment: ${JSON.stringify([...outsideLookups.payment.entries()])}`);
  console.log(`  cashback: ${JSON.stringify([...outsideLookups.cashback.entries()])}`);
  if (observations.length) { console.log(`\nOBSERVATIONS:`); for (const o of observations) console.log(`  ${o}`); }

  // ── live writes (guarded) ───────────────────────────────────────────────────
  if (LIVE) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const p of toImport) {
        const po = await client.query(
          // AF-owned columns (SPEC §14): action_items / closed_at / closed_by are
          // written ONLY on this one-time INSERT (the importer never updates
          // an existing PO — see the idempotency filter above).
          `INSERT INTO purchase_orders (order_id, order_date, supplier, action_items, closed_at, closed_by, subtotal, tax, sh_donations, discount, refund_amount, order_total,
             payment_method, weighted_gc_discount_pct, promo, cashback_site, cashback_pct, purchased_by, subscription, email_used, invoice_attached, notes, source)
           VALUES ($1,$2,$3,$4::text[],$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'sheet_import') RETURNING id`,
          [p.orderId, p.orderDate, p.supplier, p.actionItems, p.closedFromSheet ? new Date() : null, p.closedFromSheet ? "sheet" : null,
           p.subtotal, p.tax, p.shDonations, p.discount, p.refundAmount, p.orderTotal,
           p.payment, p.wgc, p.promo, p.cashback, p.cashbackPct, p.purchasedBy, p.subscription, p.email, p.invoiceAttached, p.notes],
        );
        const poId = po.rows[0].id;
        for (const a of p.poAsins) {
          const pa = await client.query(
            `INSERT INTO po_asins (po_id, asin, asin_name, sku, qty, cost_per_unit, prep_cost, sold_as, units_per_pack, unreimbursed_loss_qty, unreimbursed_loss_amount)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
            [poId, a.asin, a.asinName, a.sku, a.qty, a.costPerUnit, a.prep, a.soldAs, a.unitsPerPack, a.lossQty, a.lossAmount],
          );
          const paId = pa.rows[0].id;
          for (const l of a.lines) {
            await client.query(
              // qty_canceled: NULL (= not tracked) UNLESS the sheet's Status said
              // "Canceled" — a PO-wide cancel sets qty_canceled = qty_ordered on
              // every line (§6.4). Per-ASIN partial cancels are not inferrable.
              // final_qty is GENERATED — never inserted.
              `INSERT INTO po_line_items (po_id, po_asin_id, position, product_name, supplier_sku, price, item_discount, qty_ordered, qty_received, qty_returned, asin_qty_per_product, adjusted_product_cost, qty_canceled)
               VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$9,$10,$11,$12)`,
              [poId, paId, l.position, l.productName, l.supplierSku, l.price, l.qtyOrdered, l.qtyReceived, l.qtyReturned, l.asinQtyPerProduct, l.adjustedProductCost, p.canceledFromSheet ? l.qtyOrdered : null],
            );
          }
        }
      }
      await client.query("COMMIT");
      console.log(`\nLIVE: committed ${toImport.length} POs / ${asinRowsTotal} po_asins / ${lineRowsTotal} line items.`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  await pool.end();
}

// Run only when executed directly (tsx script/import-po-2026.ts ...) — the
// classifier above is imported by tests, and importing must never start a run.
import { pathToFileURL } from "url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
