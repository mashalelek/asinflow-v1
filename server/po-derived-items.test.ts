import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { PO_ACTION_ITEMS_SQL, PO_CLOSE_ACTION_ITEMS_SQL, NO_INVOICE_EXISTS_SQL } from "./po-action-items";
import { NO_INVOICE_SAVED, AUTO_ACTION_ITEMS, normalizeActionItems } from "./po-status-map";
import { AF_CREATED_SOURCES } from "./po-documents";
import { noInvoiceTitle } from "@shared/po-documents";

// "No invoice saved" (2026-11-05, SPEC §22 "PO documents"), on the real local schema, rolled back.
const url = process.env.DATABASE_URL || "postgresql://localhost:5432/asinflow";
let client: pg.Client | null = null;
beforeAll(async () => {
  const c = new pg.Client({ connectionString: url });
  try { await c.connect(); await c.query("SELECT 1 FROM po_documents LIMIT 0"); client = c; } catch { await c.end().catch(() => {}); }
});
afterAll(async () => { await client?.end(); });

type Q = (sql: string, params?: any[]) => Promise<any>;
async function inTx(fn: (q: Q) => Promise<void>) {
  const q: Q = (sql, params) => client!.query(sql, params);
  await q("BEGIN");
  try { await fn(q); } finally { await q("ROLLBACK"); }
  expect((await client!.query(`SELECT count(*)::int AS n FROM purchase_orders WHERE supplier = 'zz-derived-test.com'`)).rows[0].n).toBe(0);
}
const po = async (q: Q, o: { order_id: string; days_ago: number; source?: string; closed?: boolean }) =>
  (await q(`INSERT INTO purchase_orders (order_id, order_date, supplier, source, closed_at) VALUES ($1, (NOW() AT TIME ZONE 'America/New_York')::date - $2::int, 'zz-derived-test.com', $3, $4) RETURNING id`,
    [o.order_id, o.days_ago, o.source ?? "extension", o.closed ? new Date() : null])).rows[0].id as string;
const items = async (q: Q, sql: string, id: string) => (await q(`SELECT ${sql} AS items FROM purchase_orders p WHERE p.id = $1`, [id])).rows[0].items as string[];

describe("No invoice saved", () => {
  it("derived, never set by hand; the SQL's AF sources are po-documents' AF_CREATED_SOURCES", () => {
    expect(AUTO_ACTION_ITEMS).toContain(NO_INVOICE_SAVED);
    expect(normalizeActionItems([NO_INVOICE_SAVED])).toEqual({ ok: true, value: [] });
    expect(NO_INVOICE_EXISTS_SQL("p")).toContain(`IN (${AF_CREATED_SOURCES.map((s) => `'${s}'`).join(", ")})`);
  });
  it("from the day after the order date, with no document; open POs and AF-created POs; display only (not in the close set)", async (ctx) => {
    if (!client) return ctx.skip();
    await inTx(async (q) => {
      const yesterday = await po(q, { order_id: "zz-1", days_ago: 1 });
      const today = await po(q, { order_id: "zz-2", days_ago: 0 });
      const withDoc = await po(q, { order_id: "zz-3", days_ago: 3 });
      await q(`INSERT INTO po_documents (po_id, type, drive_file_id, file_name, source) VALUES ($1, 'invoice', 'zz-drive-file', 'x_invoice.pdf', 'linked_existing')`, [withDoc]);
      const closedSheet = await po(q, { order_id: "zz-4", days_ago: 90, source: "sheet_import", closed: true });
      const openSheet = await po(q, { order_id: "zz-5", days_ago: 90, source: "sheet_import" });
      const closedAf = await po(q, { order_id: "zz-6", days_ago: 5, closed: true });
      expect(await items(q, PO_ACTION_ITEMS_SQL, yesterday)).toContain(NO_INVOICE_SAVED);
      expect(await items(q, PO_ACTION_ITEMS_SQL, today)).not.toContain(NO_INVOICE_SAVED);
      expect(await items(q, PO_ACTION_ITEMS_SQL, withDoc)).not.toContain(NO_INVOICE_SAVED);
      expect(await items(q, PO_ACTION_ITEMS_SQL, closedSheet)).not.toContain(NO_INVOICE_SAVED);
      expect(await items(q, PO_ACTION_ITEMS_SQL, openSheet)).toContain(NO_INVOICE_SAVED);
      expect(await items(q, PO_ACTION_ITEMS_SQL, closedAf)).toContain(NO_INVOICE_SAVED);
      expect(await items(q, PO_CLOSE_ACTION_ITEMS_SQL, yesterday)).not.toContain(NO_INVOICE_SAVED);
    });
  });
  it("the hover names the last failed save, else what the next pass links", () => {
    const p = { order_date: "2026-11-04", supplier: "acmetools.com", order_id: "42838131" };
    expect(noInvoiceTitle(p, { error: "Could not find Chrome (ver. 156.0.8078.47). This can occur\n 1. you did not", at: "2026-11-05T20:47:33.312Z" }))
      .toBe("No invoice saved: the last save failed 2026-11-05 20:47 UTC — Could not find Chrome (ver. 156.0.8078.47). This can occur. The next pass retries.");
    expect(noInvoiceTitle(p, null)).toContain("2026-11-04_acmetools.com_42838131.pdf");
  });
});
