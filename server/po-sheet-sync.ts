// Orders-sheet → PO module sync (patch docs/claude_spec-patch-po-sheet-sync.md,
// 2026-10-16). Repeatable: the ASINs-page Sync POs button runs this first,
// then the per-ASIN COGS/ordered-qty sync (`runSheetsSync`).
//
// "Sheet wins for now" (D2): every field the sheet carries is overwritten
// from the sheet — header fields, line fields, and the Status cell mapped
// through server/po-status-map.ts PER ROW (patch row-level-status §2,
// 2026-10-17: a sheet row is a product): the row's action items → that
// line's action_items (full replace); the row's Canceled → that line's
// qty_canceled = qty_ordered; the PO is Closed only when EVERY row says
// Closed (else Open). purchase_orders.action_items is no longer written. AF-owned fields (SPEC §14) are never written here: the six
// po_asins quantity columns, po_asin_shipments, po_asins.notes,
// po_line_items.notes, item_discount, and po_asins.sku after insert.
//
// The sheet is parsed EXACTLY as the one-time importer parsed it
// (script/import-po-2026.ts — grouping on (supplier, order_id), the cleanup
// map, the S=1 same-ASIN merge rule, first-row-wins for order-level cells,
// the 2026 year filter of classifyRows). That assembly is ported here, not
// shared: the script is a frozen one-off and stays as it ran.
//
// Canceled POs (Maria 2026-10-16): the VA zeroes Col L / Col N on a canceled
// order. For a PO already in AF the stored ordered quantities are KEPT and
// qty_canceled = that ordered qty; a new PO that arrives already zeroed is
// inserted as-is (0 / 0) and counted under "canceled with no ordered qty".
//
// Fail-closed (§3.7): a header mismatch, an empty read, a mixed-Col-S PO or
// an unmapped Status token means NOTHING is written — the result reports
// why. Deletes (§3.4 / §3.5) happen only on a complete read. A PO missing
// from the sheet is never deleted (reported "in AF, not in sheet"); a
// po_asins row that disappears is deleted only when it has no shipment rows.
import pool from "./db";
import { getSheetValues } from "./sheet-read";
import { COL, t, classifyRows } from "./po-import-classify";
import { mapSheetStatus, ACTION_ITEMS, type ActionItem } from "./po-status-map";

// ── parsing helpers (ported verbatim from script/import-po-2026.ts) ──────────

/** Header sanity: refuse to run against a differently-shaped sheet. */
export const PO_SHEET_HEADER_EXPECT: Array<[number, string]> = [
  [COL.orderId, "Order ID"], [COL.orderDate, "Order Date"], [COL.supplier, "Supplier"],
  [COL.asin, "ASIN"], [COL.asinQtyTotal, "Total ASIN Qty per Order"],
  [COL.adjProductCost, "Adjusted Product Cost"], [COL.adjCogs, "COGS"],
  [COL.prepCost, "Prep cost"], [COL.soldAs, "sold_as"], [COL.unitsPerPack, "units_per_pack"],
];

/** Verbatim money: "$1,234.56" → "1234.56" (exact string). "" → null. "#DIV/0!" → null. "(1.23)" → "-1.23". */
export function moneyVerbatim(raw: string): { value: string | null; divzero: boolean } {
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

export function pctToNumber(raw: string): string | null {
  const s = t(raw);
  if (s === "") return null;
  const x = s.replace(/%$/, "").trim();
  if (!/^\d*\.?\d+$/.test(x)) throw new Error(`unparseable percent: ${JSON.stringify(s)}`);
  return x;
}

export function intOrNull(raw: string): number | null {
  const s = t(raw);
  if (s === "") return null;
  const n = Number(s.replace(/,/g, ""));
  if (!Number.isFinite(n)) throw new Error(`unparseable int: ${JSON.stringify(s)}`);
  return Math.round(n);
}

/** Exact decimal string → integer cents (no float). "13.93" → 1393. */
export function toCents(dec: string): number {
  const neg = dec.startsWith("-");
  const [w, f = ""] = (neg ? dec.slice(1) : dec).split(".");
  const cents = Number(w || "0") * 100 + Number((f + "00").slice(0, 2));
  if (!Number.isFinite(cents)) throw new Error(`toCents: ${JSON.stringify(dec)}`);
  return neg ? -cents : cents;
}
const centsToDec = (c: number): string => `${c < 0 ? "-" : ""}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, "0")}`;

const SEEDED_PAYMENT = new Set(["Gift cards","Amex (1001)","Amex (1005)","Chase (7927)","Chase (9647)","Chase Ink (7927)","Chase (6120)","Citi (9510)","Discover","Webstaurant Visa","Amex (1002)","Walmart card","Citi (9627)"]);
const SEEDED_PAYMENT_BY_LC = new Map(Array.from(SEEDED_PAYMENT).map((v) => [v.toLowerCase(), v]));
const DEFAULT_EMAIL = "orders@coastalqualitygoods.com";

// ── parsed shapes ─────────────────────────────────────────────────────────────

export interface SheetLine {
  position: number;
  productName: string | null;
  supplierSku: string | null;
  price: string | null;
  qtyOrdered: number | null;
  qtyReceived: number | null;
  qtyReturned: number;
  asinQtyPerProduct: string;
  adjustedProductCost: string | null;
  // Row-level Status (patch row-level-status §2, 2026-10-17): a sheet row is a
  // product, so its Status cell maps onto THIS line only.
  statusCell: string;
  actionItems: ActionItem[];
  /** Row says Canceled → this line's qty_canceled = qty_ordered. */
  canceled: boolean;
  /** Row says Returned (the qty itself comes from Col R when the sheet carries one). */
  returned: boolean;
  /** Col R blank (as opposed to 0) — a Returned row with no qty leaves qty_returned as stored. */
  qtyReturnedBlank: boolean;
}

export interface SheetPoAsin {
  asin: string;
  asinName: string | null;
  qty: number;
  costPerUnit: string | null;
  prep: string;
  soldAs: string;
  unitsPerPack: number;
  lossQty: number;
  lossAmount: string;
  /** Sheet Col S (unique products per ASIN); bundles derive Canceled/Returned ÷ this. */
  uniqueProducts: number | null;
  lines: SheetLine[];
}

export interface SheetPo {
  key: string;
  orderId: string;
  supplier: string;
  orderDate: string;
  /** First row's Status cell (reporting only). */
  statusCell: string;
  /** Union of the rows' action items — reported, never written to the PO (§2.1). */
  actionItems: ActionItem[];
  /** §2.3: Closed only when EVERY row's Status contains Closed. */
  closed: boolean;
  subtotal: string; tax: string; shDonations: string; discount: string; refundAmount: string; orderTotal: string;
  payment: string | null;
  wgc: string | null;
  promo: string | null;
  cashback: string | null;
  cashbackPct: string | null;
  purchasedBy: string | null;
  subscription: boolean;
  email: string;
  invoiceAttached: boolean;
  notes: string | null;
  poAsins: SheetPoAsin[];
}

export interface ParsedPoSheet {
  pos: SheetPo[];
  rawRowsRead: number;
  importedRows: number;
  /** POs skipped as a data error (mixed Col S inside one ASIN group) — "supplier order_id: reason". */
  skippedMixed: string[];
  /** POs carrying a Status token the map does not know — the sync writes nothing while any exist. */
  unmapped: Array<{ po: string; tokens: string[] }>;
}

export const poKey = (supplier: string, orderId: string) => `${supplier}\u0000${orderId}`;

/** Parse the A1:AZ header + A2:AZ cells into PO records, exactly as the importer did. */
export function parsePoSheet(header: string[], dataCells: string[][]): ParsedPoSheet {
  for (const [idx, expect] of PO_SHEET_HEADER_EXPECT) {
    if (!String(header[idx] ?? "").includes(expect)) {
      throw new Error(`PO sheet header mismatch at col ${idx}: expected to contain ${JSON.stringify(expect)}, got ${JSON.stringify(header[idx])}`);
    }
  }
  const dataRows = dataCells.map((cells, i) => ({ cells: cells.map((c) => String(c ?? "")), srcRow: i + 2 }));
  const cls = classifyRows(dataRows);

  type Row = { cells: string[]; srcRow: number; dateIso: string };
  interface Group { orderId: string; supplier: string; rows: Row[] }
  const groups = new Map<string, Group>();
  for (const r of cls.rows) {
    let supplier = t(r.cells[COL.supplier]);
    if (supplier === "shop.tetleyusa.com / WorldPantry.com") supplier = "shop.tetleyusa.com";
    const orderId = t(r.cells[COL.orderId]);
    const key = poKey(supplier, orderId);
    if (!groups.has(key)) groups.set(key, { orderId, supplier, rows: [] });
    groups.get(key)!.rows.push(r);
  }

  const money = (cells: string[], idx: number): string | null => moneyVerbatim(cells[idx]).value;
  const skippedMixed: string[] = [];
  const unmapped: ParsedPoSheet["unmapped"] = [];
  const pos: SheetPo[] = [];

  for (const g of Array.from(groups.values())) {
    const f = g.rows[0];
    const c = f.cells;
    const label = `${g.supplier} ${g.orderId}`;

    let payment: string | null = t(c[COL.paymentMethod]) || null;
    if (payment === "Gift card") payment = "Gift cards";
    if (payment === "Visa 7927") payment = "Chase (7927)";
    if (payment && !payment.includes(":") && !SEEDED_PAYMENT.has(payment)) {
      const seeded = SEEDED_PAYMENT_BY_LC.get(payment.toLowerCase());
      if (seeded) payment = seeded;
    }
    let cashback: string | null = t(c[COL.cashbackSite]) || null;
    if (cashback === "Topcashback") cashback = "TopCashback";
    if (cashback === "-" || cashback === "Coupons") cashback = null;
    let wgc = pctToNumber(c[COL.weightedGcPct]);
    if (g.orderId === "130097" && wgc != null) wgc = null;
    const email = t(c[COL.emailUsed]) || DEFAULT_EMAIL;
    const rcpt = t(c[COL.rcpt]).toUpperCase() === "TRUE";

    const byAsin = new Map<string, Row[]>();
    for (const r of g.rows) {
      const a = t(r.cells[COL.asin]).toUpperCase();
      if (!byAsin.has(a)) byAsin.set(a, []);
      byAsin.get(a)!.push(r);
    }
    const poAsins: SheetPoAsin[] = [];
    const rowUnmapped = new Set<string>();
    let mixedSError = false;
    for (const [asin, ars] of Array.from(byAsin.entries())) {
      const ar = ars[0];
      const sVals = ars.map((r) => intOrNull(r.cells[COL.uniqueProductsPerAsin]) ?? 1);
      const isBundleGroup = sVals.every((v) => v >= 2);
      const isS1Group = sVals.every((v) => v <= 1);
      if (ars.length > 1 && !isBundleGroup && !isS1Group) {
        skippedMixed.push(`${label} — ASIN ${asin}: mixed Col S values ${JSON.stringify(sVals)} across rows ${ars.map((r) => r.srcRow).join(",")}`);
        mixedSError = true;
        break;
      }
      let qty: number;
      let costPerUnit: string | null;
      if (ars.length > 1 && isS1Group) {
        // S=1 merge rule: additive rows → qty = SUM(Col N); cost verbatim when
        // all rows agree, else a Col-N-weighted average in integer cents.
        const perRow = ars.map((r) => ({ n: intOrNull(r.cells[COL.asinQtyTotal]) ?? 0, y: money(r.cells, COL.adjCogs) }));
        qty = perRow.reduce((a, r) => a + r.n, 0);
        const yVals = Array.from(new Set(perRow.map((r) => r.y ?? "NULL")));
        if (yVals.length === 1) {
          costPerUnit = perRow[0].y;
        } else {
          const usable = perRow.filter((r) => r.y != null && r.n > 0);
          const totQty = usable.reduce((a, r) => a + r.n, 0);
          const wCents = totQty > 0 ? Math.round(usable.reduce((a, r) => a + toCents(r.y!) * r.n, 0) / totQty) : null;
          costPerUnit = wCents != null ? centsToDec(wCents) : null;
        }
      } else {
        qty = intOrNull(ar.cells[COL.asinQtyTotal]) ?? 0;
        costPerUnit = money(ar.cells, COL.adjCogs);
      }
      const prepRaw = t(ar.cells[COL.prepCost]);
      const prep = prepRaw === "" ? "0" : moneyVerbatim(prepRaw).value ?? "0";
      const soldAs = t(ar.cells[COL.soldAs]) || "individual";
      const upp = soldAs === "individual" ? 1 : (intOrNull(ar.cells[COL.unitsPerPack]) ?? 1);
      poAsins.push({
        asin, asinName: t(ar.cells[COL.asinName]) || null,
        qty, costPerUnit, prep, soldAs, unitsPerPack: upp,
        lossQty: intOrNull(ar.cells[COL.lossQty]) ?? 0,
        lossAmount: moneyVerbatim(t(ar.cells[COL.lossAmount])).value ?? "0",
        uniqueProducts: intOrNull(ar.cells[COL.uniqueProductsPerAsin]),
        lines: ars.map((r, i) => {
          const statusCell = t(r.cells[COL.status]) || "Ordered";
          const st = mapSheetStatus(statusCell);
          for (const u of st.unmapped) rowUnmapped.add(u);
          return {
          position: i,
          productName: t(r.cells[COL.productName]) || null,
          supplierSku: t(r.cells[COL.skuUpc]) || null,
          price: money(r.cells, COL.price),
          qtyOrdered: intOrNull(r.cells[COL.qtyOrdered]),
          qtyReceived: intOrNull(r.cells[COL.qtyReceived]),
          qtyReturned: intOrNull(r.cells[COL.qtyReturned]) ?? 0,
          asinQtyPerProduct: t(r.cells[COL.asinQtyPerProduct]) === "" ? "1" : t(r.cells[COL.asinQtyPerProduct]),
          adjustedProductCost: money(r.cells, COL.adjProductCost),
          statusCell, actionItems: st.actionItems, canceled: st.canceled, returned: st.returned,
          qtyReturnedBlank: t(r.cells[COL.qtyReturned]) === "",
        }; }),
      });
    }
    if (mixedSError) continue;

    if (rowUnmapped.size > 0) unmapped.push({ po: label, tokens: Array.from(rowUnmapped) });
    const allLines = poAsins.flatMap((a) => a.lines);
    const union = new Set<string>(); for (const l of allLines) for (const ai of l.actionItems) union.add(ai);
    pos.push({
      key: poKey(g.supplier, g.orderId),
      orderId: g.orderId, supplier: g.supplier, orderDate: f.dateIso, statusCell: t(c[COL.status]) || "Ordered",
      actionItems: ACTION_ITEMS.filter((a) => union.has(a)),
      closed: allLines.length > 0 && allLines.every((l) => mapSheetStatus(l.statusCell).closed),
      subtotal: money(c, COL.subtotal) ?? "0", tax: money(c, COL.tax) ?? "0",
      shDonations: money(c, COL.shDonations) ?? "0", discount: money(c, COL.discount) ?? "0",
      refundAmount: money(c, COL.refundAmount) ?? "0", orderTotal: money(c, COL.orderTotal) ?? "0",
      payment, wgc, promo: t(c[COL.promo]) || null, cashback, cashbackPct: pctToNumber(c[COL.cashbackPct]),
      purchasedBy: t(c[COL.purchasedBy]) || null,
      subscription: t(c[COL.subscription]).toUpperCase() === "TRUE",
      email, invoiceAttached: rcpt, notes: t(c[COL.notes]) || null,
      poAsins,
    });
  }
  return { pos, rawRowsRead: dataRows.length, importedRows: cls.rows.length, skippedMixed, unmapped };
}

/** Raw read: header A1:AZ1 + cells A2:AZ. Throws (fail-closed) when either is empty. */
export async function readPoSheet(sheetId: string): Promise<{ header: string[]; dataCells: string[][] }> {
  const headerRows = await getSheetValues(sheetId, "Sheet1!A1:AZ1");
  if (headerRows.length !== 1) throw new Error(`PO sheet header read: expected 1 row from A1:AZ1, got ${headerRows.length}`);
  const header = headerRows[0].map((c: any) => String(c ?? ""));
  const dataCells = (await getSheetValues(sheetId, "Sheet1!A2:AZ")).map((row: any[]) => row.map((c: any) => String(c ?? "")));
  if (dataCells.length === 0) throw new Error("PO sheet read returned 0 rows — nothing written (fail-closed)");
  return { header, dataCells };
}

// ── diff + apply ──────────────────────────────────────────────────────────────

export interface PoSyncCounts {
  sheetPos: number;
  inserted: number;
  updated: number;
  unchanged: number;
  linesDeleted: number;
  poAsinsDeleted: number;
  poAsinsKeptWithShipments: number;
  /** Existing canceled POs whose zeroed sheet qty was NOT applied (stored ordered qty kept, qty_canceled = ordered). */
  canceledKeptOrderedQty: number;
  /** Rows that say Returned but carry no Col R qty — qty_returned left as stored (§2.2). */
  returnedNoQty: number;
  /** Lines whose action items change (row Status → line, full replace). */
  lineActionItemsChanged: number;
  /** New canceled POs inserted with every line at ordered qty 0 (as the sheet has them). */
  canceledNoOrderedQty: number;
  posInAfNotInSheet: number;
  unmappedTokens: number;
  skippedMixed: number;
}

export interface PoSyncResult {
  dryRun: boolean;
  /** false when nothing was written: dry run, or a stop condition (unmapped tokens / mixed Col S). */
  wrote: boolean;
  stop: string | null;
  counts: PoSyncCounts;
  /** First 10 changed EXISTING POs (inserts are just "new PO"), each with its first changes. */
  samples: string[];
  /** Every PO the sync would touch: inserts and updates with their field-level changes. */
  diffs: Array<{ po: string; kind: "insert" | "update"; changes: string[] }>;
  unmapped: Array<{ po: string; tokens: string[] }>;
  skippedMixed: string[];
  inAfNotInSheet: string[];
  keptWithShipments: string[];
  canceledKept: string[];
  canceledNoQty: string[];
  rawRowsRead: number;
}

type Q = {
  query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>;
  /** Transaction client for the live apply; the default pool provides it. Tests inject a fake. */
  connect?: () => Promise<Q & { release: () => void }>;
};

const isZero = (v: number | null | undefined) => v == null || v === 0;

const numEq = (a: any, b: any): boolean => (a == null || a === "") && (b == null || b === "") ? true : a != null && b != null && Math.abs(Number(a) - Number(b)) < 1e-9;
const strEq = (a: any, b: any): boolean => (a == null ? null : String(a)) === (b == null ? null : String(b));
const boolEq = (a: any, b: any): boolean => Boolean(a) === Boolean(b);
const arrEq = (a: any, b: string[]): boolean => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
const dateEq = (a: any, b: string): boolean => {
  if (a == null) return false;
  const d = a instanceof Date ? `${a.getFullYear()}-${String(a.getMonth() + 1).padStart(2, "0")}-${String(a.getDate()).padStart(2, "0")}` : String(a).slice(0, 10);
  return d === b;
};

interface HeaderField { col: string; sheet: (p: SheetPo) => any; eq: (db: any, sheet: any) => boolean }
const HEADER_FIELDS: HeaderField[] = [
  { col: "order_date", sheet: (p) => p.orderDate, eq: dateEq },
  { col: "subtotal", sheet: (p) => p.subtotal, eq: numEq },
  { col: "tax", sheet: (p) => p.tax, eq: numEq },
  { col: "sh_donations", sheet: (p) => p.shDonations, eq: numEq },
  { col: "discount", sheet: (p) => p.discount, eq: numEq },
  { col: "refund_amount", sheet: (p) => p.refundAmount, eq: numEq },
  { col: "order_total", sheet: (p) => p.orderTotal, eq: numEq },
  { col: "payment_method", sheet: (p) => p.payment, eq: strEq },
  { col: "weighted_gc_discount_pct", sheet: (p) => p.wgc, eq: numEq },
  { col: "promo", sheet: (p) => p.promo, eq: strEq },
  { col: "cashback_site", sheet: (p) => p.cashback, eq: strEq },
  { col: "cashback_pct", sheet: (p) => p.cashbackPct, eq: numEq },
  { col: "purchased_by", sheet: (p) => p.purchasedBy, eq: strEq },
  { col: "subscription", sheet: (p) => p.subscription, eq: boolEq },
  { col: "email_used", sheet: (p) => p.email, eq: strEq },
  { col: "invoice_attached", sheet: (p) => p.invoiceAttached, eq: boolEq },
  { col: "notes", sheet: (p) => p.notes, eq: strEq },
  // purchase_orders.action_items is no longer written (row-level Status §2.1).
];

interface AsinField { col: string; sheet: (a: SheetPoAsin) => any; eq: (db: any, sheet: any) => boolean }
const ASIN_FIELDS: AsinField[] = [
  { col: "asin_name", sheet: (a) => a.asinName, eq: strEq },
  { col: "qty", sheet: (a) => a.qty, eq: numEq },
  { col: "cost_per_unit", sheet: (a) => a.costPerUnit, eq: numEq },
  { col: "prep_cost", sheet: (a) => a.prep, eq: numEq },
  { col: "sold_as", sheet: (a) => a.soldAs, eq: strEq },
  { col: "units_per_pack", sheet: (a) => a.unitsPerPack, eq: numEq },
  { col: "unreimbursed_loss_qty", sheet: (a) => a.lossQty, eq: numEq },
  { col: "unreimbursed_loss_amount", sheet: (a) => a.lossAmount, eq: numEq },
  { col: "unique_products", sheet: (a) => a.uniqueProducts, eq: numEq },
];

interface LineField { col: string; sheet: (l: SheetLine, po: SheetPo) => any; eq: (db: any, sheet: any) => boolean }
const LINE_FIELDS: LineField[] = [
  { col: "product_name", sheet: (l) => l.productName, eq: strEq },
  { col: "supplier_sku", sheet: (l) => l.supplierSku, eq: strEq },
  { col: "price", sheet: (l) => l.price, eq: numEq },
  { col: "qty_ordered", sheet: (l) => l.qtyOrdered, eq: numEq },
  { col: "qty_received", sheet: (l) => l.qtyReceived, eq: numEq },
  { col: "qty_returned", sheet: (l) => l.qtyReturned, eq: numEq },
  { col: "asin_qty_per_product", sheet: (l) => l.asinQtyPerProduct, eq: numEq },
  { col: "adjusted_product_cost", sheet: (l) => l.adjustedProductCost, eq: numEq },
  // Row-level (§2.2): this ROW says Canceled → qty_ordered; otherwise NULL (not tracked).
  { col: "qty_canceled", sheet: (l) => (l.canceled ? l.qtyOrdered : null), eq: numEq },
  // Row-level (§2.1): this row's action items, full replace.
  { col: "action_items", sheet: (l) => l.actionItems, eq: arrEq },
];

const fmt = (v: any) => (v == null ? "NULL" : Array.isArray(v) ? JSON.stringify(v) : v instanceof Date ? v.toISOString().slice(0, 10) : String(v));

/**
 * Run the sync. `dryRun` computes the plan and the counts without a transaction.
 * A stop condition (unmapped tokens, mixed Col S) is reported and nothing is
 * written in either mode.
 */
export async function syncPoSheet(opts: { sheetId: string; dryRun: boolean; db?: Q; read?: (sheetId: string) => Promise<{ header: string[]; dataCells: string[][] }> }): Promise<PoSyncResult> {
  const db: Q = opts.db ?? (pool as unknown as Q);
  const { header, dataCells } = await (opts.read ?? readPoSheet)(opts.sheetId);
  const parsed = parsePoSheet(header, dataCells);

  // Current AF state.
  const dbPos = (await db.query(`SELECT * FROM purchase_orders`)).rows;
  const dbPoByKey = new Map<string, any>(dbPos.map((r) => [poKey(r.supplier, r.order_id), r]));
  const dbAsins = (await db.query(`SELECT pa.*, (SELECT COUNT(*)::int FROM po_asin_shipments s WHERE s.po_asin_id = pa.id) AS shipment_rows FROM po_asins pa`)).rows;
  const dbAsinsByPo = new Map<string, any[]>();
  for (const a of dbAsins) { if (!dbAsinsByPo.has(a.po_id)) dbAsinsByPo.set(a.po_id, []); dbAsinsByPo.get(a.po_id)!.push(a); }
  const dbLines = (await db.query(`SELECT * FROM po_line_items ORDER BY po_asin_id, position`)).rows;
  const dbLinesByAsinId = new Map<string, any[]>();
  for (const l of dbLines) { const k = String(l.po_asin_id); if (!dbLinesByAsinId.has(k)) dbLinesByAsinId.set(k, []); dbLinesByAsinId.get(k)!.push(l); }
  const allAsins = Array.from(new Set(parsed.pos.flatMap((p) => p.poAsins.map((a) => a.asin))));
  const skuByAsin = new Map<string, string | null>(
    (await db.query(`SELECT asin, primary_sku FROM asins WHERE asin = ANY($1::text[])`, [allAsins])).rows.map((r) => [r.asin, r.primary_sku ?? null]),
  );

  // Plan.
  type LineOp = { kind: "insert"; poAsinId: string | null; asinIdx: number; line: SheetLine } | { kind: "update"; id: string; set: Record<string, any> } | { kind: "delete"; id: string };
  type AsinOp = { kind: "insert"; a: SheetPoAsin } | { kind: "update"; id: string; set: Record<string, any> } | { kind: "delete"; id: string; lineIds: string[] } | { kind: "keep"; id: string };
  /** `changes` are writes; `notes` are reported facts that write nothing (kept rows) and do not make a PO "updated". */
  interface PoPlan { po: SheetPo; db: any | null; changes: string[]; notes: string[]; headerSet: Record<string, any>; asinOps: AsinOp[]; lineOps: LineOp[] }
  const plans: PoPlan[] = [];
  const counts: PoSyncCounts = {
    sheetPos: parsed.pos.length, inserted: 0, updated: 0, unchanged: 0, linesDeleted: 0, poAsinsDeleted: 0,
    poAsinsKeptWithShipments: 0, canceledKeptOrderedQty: 0, canceledNoOrderedQty: 0, returnedNoQty: 0, lineActionItemsChanged: 0,
    posInAfNotInSheet: 0, unmappedTokens: parsed.unmapped.length, skippedMixed: parsed.skippedMixed.length,
  };
  const keptWithShipments: string[] = [];
  const canceledKept: string[] = [];
  const canceledNoQty: string[] = [];

  for (const po of parsed.pos) {
    const existing = dbPoByKey.get(po.key) ?? null;
    const plan: PoPlan = { po, db: existing, changes: [], notes: [], headerSet: {}, asinOps: [], lineOps: [] };
    plans.push(plan);
    if (!existing) {
      counts.inserted++; plan.changes.push("new PO");
      const lines0 = po.poAsins.flatMap((a) => a.lines);
      if (lines0.length > 0 && lines0.every((l) => l.canceled && isZero(l.qtyOrdered))) {
        counts.canceledNoOrderedQty++; canceledNoQty.push(`${po.supplier} ${po.orderId}`); plan.changes.push("canceled with no ordered qty (inserted 0/0)");
      }
      continue;
    }
    let keptOnCancel = false;

    for (const f of HEADER_FIELDS) {
      const sv = f.sheet(po);
      if (!f.eq(existing[f.col], sv)) { plan.headerSet[f.col] = sv; plan.changes.push(`${f.col}: ${fmt(existing[f.col])} → ${fmt(sv)}`); }
    }
    // Closed (§3.3): sheet Closed → keep closed_at if set, else now(); closed_by='sheet'. Not Closed → both NULL.
    const dbClosed = existing.closed_at != null;
    if (po.closed) {
      if (!dbClosed) { plan.headerSet.closed_at = "NOW()"; plan.headerSet.closed_by = "sheet"; plan.changes.push(`closed: open → closed (sheet)`); }
      else if (existing.closed_by !== "sheet") { plan.headerSet.closed_by = "sheet"; plan.changes.push(`closed_by: ${fmt(existing.closed_by)} → sheet`); }
    } else if (dbClosed) {
      plan.headerSet.closed_at = null; plan.headerSet.closed_by = null; plan.changes.push(`closed: closed (${fmt(existing.closed_by)}) → open`);
    }

    const dbA = dbAsinsByPo.get(existing.id) ?? [];
    const dbAByAsin = new Map<string, any>(dbA.map((a) => [a.asin, a]));
    const seen = new Set<string>();
    po.poAsins.forEach((a, asinIdx) => {
      seen.add(a.asin);
      const ex = dbAByAsin.get(a.asin);
      if (!ex) { plan.asinOps.push({ kind: "insert", a }); plan.changes.push(`${a.asin}: new ASIN row`); return; }
      const set: Record<string, any> = {};
      // Keep-on-cancel (decision 2): a canceled PO zeroed in the sheet keeps its stored ASIN qty.
      const aEff: SheetPoAsin = a.lines.length > 0 && a.lines.every((l) => l.canceled) && isZero(a.qty) && Number(ex.qty) > 0 ? { ...a, qty: Number(ex.qty) } : a;
      if (aEff !== a) keptOnCancel = true;
      for (const f of ASIN_FIELDS) {
        const sv = f.sheet(aEff);
        if (!f.eq(ex[f.col], sv)) { set[f.col] = sv; plan.changes.push(`${a.asin}.${f.col}: ${fmt(ex[f.col])} → ${fmt(sv)}`); }
      }
      if (Object.keys(set).length > 0) plan.asinOps.push({ kind: "update", id: ex.id, set });
      // Lines by (po_asin, position).
      const exLines = dbLinesByAsinId.get(String(ex.id)) ?? [];
      a.lines.forEach((l, i) => {
        const el = exLines.find((x) => x.position === i);
        if (!el) { plan.lineOps.push({ kind: "insert", poAsinId: ex.id, asinIdx, line: l }); plan.changes.push(`${a.asin} line ${i}: new line`); return; }
        const lset: Record<string, any> = {};
        // Keep-on-cancel (decision 2): stored qty_ordered stays; qty_canceled = that qty.
        const lEff: SheetLine = l.canceled && isZero(l.qtyOrdered) && Number(el.qty_ordered) > 0 ? { ...l, qtyOrdered: Number(el.qty_ordered) } : l;
        if (lEff !== l) keptOnCancel = true;
        for (const f of LINE_FIELDS) {
          // §2.2 Returned: a Returned row with no Col R qty leaves qty_returned as stored (reported).
          if (f.col === "qty_returned" && l.returned && l.qtyReturnedBlank) { counts.returnedNoQty++; plan.notes.push(`${a.asin} line ${i}: Returned with no qty — qty_returned left at ${fmt(el.qty_returned)}`); continue; }
          const sv = f.sheet(lEff, po);
          if (!f.eq(el[f.col], sv)) {
            lset[f.col] = sv; plan.changes.push(`${a.asin} line ${i}.${f.col}: ${fmt(el[f.col])} → ${fmt(sv)}`);
            if (f.col === "action_items") counts.lineActionItemsChanged++;
          }
        }
        if (Object.keys(lset).length > 0) plan.lineOps.push({ kind: "update", id: el.id, set: lset });
      });
      for (const el of exLines) {
        if (el.position == null || el.position >= a.lines.length) { plan.lineOps.push({ kind: "delete", id: el.id }); plan.changes.push(`${a.asin} line ${fmt(el.position)}: deleted (not in sheet)`); counts.linesDeleted++; }
      }
    });
    for (const ex of dbA) {
      if (seen.has(ex.asin)) continue;
      const lineIds = (dbLinesByAsinId.get(String(ex.id)) ?? []).map((l) => l.id);
      if (ex.shipment_rows > 0) {
        plan.asinOps.push({ kind: "keep", id: ex.id });
        counts.poAsinsKeptWithShipments++;
        keptWithShipments.push(`${po.supplier} ${po.orderId} — ${ex.asin} (${ex.shipment_rows} shipment row(s))`);
        plan.notes.push(`${ex.asin}: not in sheet — KEPT (${ex.shipment_rows} shipment rows)`);
      } else {
        plan.asinOps.push({ kind: "delete", id: ex.id, lineIds });
        counts.poAsinsDeleted++;
        counts.linesDeleted += lineIds.length;
        plan.changes.push(`${ex.asin}: ASIN row deleted (not in sheet; ${lineIds.length} line(s))`);
      }
    }
    if (keptOnCancel) { counts.canceledKeptOrderedQty++; canceledKept.push(`${po.supplier} ${po.orderId}`); plan.notes.push("canceled: sheet qty 0 ignored, stored ordered qty kept"); }
    if (plan.changes.length > 0) counts.updated++; else counts.unchanged++;
  }

  const sheetKeys = new Set(parsed.pos.map((p) => p.key));
  const inAfNotInSheet = dbPos.filter((r) => !sheetKeys.has(poKey(r.supplier, r.order_id))).map((r) => `${r.supplier} ${r.order_id} (${fmt(r.order_date)})`).sort();
  counts.posInAfNotInSheet = inAfNotInSheet.length;

  const diffs = plans.filter((p) => p.changes.length > 0)
    .map((p) => ({ po: `${p.po.supplier} ${p.po.orderId}`, kind: (p.db ? "update" : "insert") as "insert" | "update", changes: [...p.changes, ...p.notes] }));
  const samples = diffs.filter((d) => d.kind === "update").slice(0, 10)
    .map((d) => `${d.po}: ${d.changes.slice(0, 6).join("; ")}${d.changes.length > 6 ? `; … (+${d.changes.length - 6})` : ""}`);

  const stop = parsed.unmapped.length > 0
    ? `unmapped Status token(s) on ${parsed.unmapped.length} PO(s): ${parsed.unmapped.slice(0, 5).map((u) => `${u.po} ${JSON.stringify(u.tokens)}`).join("; ")}`
    : parsed.skippedMixed.length > 0 ? `mixed Col S on ${parsed.skippedMixed.length} PO(s): ${parsed.skippedMixed.slice(0, 3).join("; ")}` : null;

  const result: PoSyncResult = {
    dryRun: opts.dryRun, wrote: false, stop, counts, samples, diffs,
    unmapped: parsed.unmapped, skippedMixed: parsed.skippedMixed, inAfNotInSheet, keptWithShipments, canceledKept, canceledNoQty, rawRowsRead: parsed.rawRowsRead,
  };
  if (opts.dryRun || stop) return result;

  // Apply, one transaction.
  const client = await (db.connect ? db.connect() : (pool as any).connect());
  try {
    await client.query("BEGIN");
    for (const plan of plans) {
      const po = plan.po;
      if (!plan.db) {
        const ins = await client.query(
          `INSERT INTO purchase_orders (order_id, order_date, supplier, action_items, closed_at, closed_by, subtotal, tax, sh_donations, discount, refund_amount, order_total,
             payment_method, weighted_gc_discount_pct, promo, cashback_site, cashback_pct, purchased_by, subscription, email_used, invoice_attached, notes, source)
           VALUES ($1,$2,$3,$4::text[],$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'sheet_import') RETURNING id`,
          [po.orderId, po.orderDate, po.supplier, [], po.closed ? new Date() : null, po.closed ? "sheet" : null,
           po.subtotal, po.tax, po.shDonations, po.discount, po.refundAmount, po.orderTotal,
           po.payment, po.wgc, po.promo, po.cashback, po.cashbackPct, po.purchasedBy, po.subscription, po.email, po.invoiceAttached, po.notes],
        );
        const poId = ins.rows[0].id;
        for (const a of po.poAsins) await insertPoAsin(client, poId, a, po, skuByAsin.get(a.asin) ?? null);
        continue;
      }
      if (plan.changes.length === 0) continue;
      const poId = plan.db.id;
      const cols = Object.keys(plan.headerSet);
      if (cols.length > 0) {
        const sets: string[] = []; const params: any[] = [poId];
        for (const c of cols) {
          const v = plan.headerSet[c];
          if (c === "closed_at" && v === "NOW()") { sets.push(`closed_at = NOW()`); continue; }
          params.push(v);
          sets.push(c === "action_items" ? `action_items = $${params.length}::text[]` : `${c} = $${params.length}`);
        }
        await client.query(`UPDATE purchase_orders SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $1`, params);
      } else {
        await client.query(`UPDATE purchase_orders SET updated_at = NOW() WHERE id = $1`, [poId]);
      }
      for (const op of plan.asinOps) {
        if (op.kind === "insert") await insertPoAsin(client, poId, op.a, po, skuByAsin.get(op.a.asin) ?? null);
        else if (op.kind === "update") {
          const ks = Object.keys(op.set); const params: any[] = [op.id];
          const sets = ks.map((k) => { params.push(op.set[k]); return `${k} = $${params.length}`; });
          await client.query(`UPDATE po_asins SET ${sets.join(", ")} WHERE id = $1`, params);
        } else if (op.kind === "delete") {
          if (op.lineIds.length > 0) await client.query(`DELETE FROM po_line_items WHERE id = ANY($1::uuid[])`, [op.lineIds]);
          await client.query(`DELETE FROM po_asins WHERE id = $1`, [op.id]);
        }
      }
      for (const op of plan.lineOps) {
        if (op.kind === "insert") {
          await insertLine(client, poId, op.poAsinId, op.line, po);
        } else if (op.kind === "update") {
          const ks = Object.keys(op.set); const params: any[] = [op.id];
          const sets = ks.map((k) => { params.push(op.set[k]); return k === "action_items" ? `action_items = $${params.length}::text[]` : `${k} = $${params.length}`; });
          await client.query(`UPDATE po_line_items SET ${sets.join(", ")} WHERE id = $1`, params);
        } else {
          await client.query(`DELETE FROM po_line_items WHERE id = $1`, [op.id]);
        }
      }
    }
    await client.query("COMMIT");
    result.wrote = true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return result;
}

async function insertPoAsin(client: Q, poId: string, a: SheetPoAsin, po: SheetPo, sku: string | null): Promise<void> {
  const pa = await client.query(
    `INSERT INTO po_asins (po_id, asin, asin_name, sku, qty, cost_per_unit, prep_cost, sold_as, units_per_pack, unreimbursed_loss_qty, unreimbursed_loss_amount, unique_products)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [poId, a.asin, a.asinName, sku, a.qty, a.costPerUnit, a.prep, a.soldAs, a.unitsPerPack, a.lossQty, a.lossAmount, a.uniqueProducts],
  );
  for (const l of a.lines) await insertLine(client, poId, pa.rows[0].id, l, po);
}

async function insertLine(client: Q, poId: string, poAsinId: string | null, l: SheetLine, po: SheetPo): Promise<void> {
  // final_qty is GENERATED — never inserted. item_discount stays 0 as the importer wrote it.
  await client.query(
    `INSERT INTO po_line_items (po_id, po_asin_id, position, product_name, supplier_sku, price, item_discount, qty_ordered, qty_received, qty_returned, asin_qty_per_product, adjusted_product_cost, qty_canceled, action_items)
     VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$9,$10,$11,$12,$13::text[])`,
    [poId, poAsinId, l.position, l.productName, l.supplierSku, l.price, l.qtyOrdered, l.qtyReceived, l.qtyReturned, l.asinQtyPerProduct, l.adjustedProductCost, l.canceled ? l.qtyOrdered : null, l.actionItems],
  );
}
