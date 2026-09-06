// Export history for the Amazon sourcing cost bulk upload (migration 027).
// Records what was GENERATED, not what was uploaded — Seller Central gives us
// no upload receipt, so this is a coverage log, not a confirmation.
import { query as defaultQuery } from "./db";

type QueryLike = (sql: string, params?: any[]) => Promise<{ rows: any[] }>;

export interface ScExportRecord {
  id: number;
  filename: string;
  rangeStart: string;   // YYYY-MM-DD
  rangeEnd: string;     // YYYY-MM-DD
  purchasedAsins: number;
  asinsWritten: number;
  rowsWritten: number;
  createdAt: string;    // ISO
}

export async function recordSourcingCostExport(
  rec: Omit<ScExportRecord, "id" | "createdAt">,
  q: QueryLike = defaultQuery as any,
): Promise<number> {
  const { rows } = await q(
    `INSERT INTO sourcing_cost_exports
       (filename, range_start, range_end, purchased_asins, asins_written, rows_written)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [rec.filename, rec.rangeStart, rec.rangeEnd, rec.purchasedAsins, rec.asinsWritten, rec.rowsWritten],
  );
  return rows[0]?.id ?? 0;
}

// Newest first. The UI shows this as a plain list of filenames — the date range
// is already in the name, so the list is self-describing.
export async function listSourcingCostExports(
  limit = 50,
  q: QueryLike = defaultQuery as any,
): Promise<ScExportRecord[]> {
  const { rows } = await q(
    `SELECT id, filename, range_start, range_end, purchased_asins, asins_written, rows_written, created_at
       FROM sourcing_cost_exports
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  );
  const ymd = (v: any) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
  return rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    rangeStart: ymd(r.range_start),
    rangeEnd: ymd(r.range_end),
    purchasedAsins: Number(r.purchased_asins ?? 0),
    asinsWritten: Number(r.asins_written ?? 0),
    rowsWritten: Number(r.rows_written ?? 0),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}
