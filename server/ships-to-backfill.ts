// purchase_orders.ships_to backfill (SPEC §26; Maria 2026-10-22). Replaces
// migration 066's blanket 'velocity' default. PREP COST ONLY:
//   any ASIN row of the PO with prep_cost > 0 (Maria enters $1 for Velocity) → 'velocity';
//   every row 0 or NULL (or no ASIN rows) → 'home'.
// Prep = AF's po_asins.prep_cost (the PO module's column, not the sheet).
// The Velocity start date is NOT a rule — only a sanity check: a PO dated
// before tracking.velocity_start_date (migration 067: the first PO with
// prep > 0, stored once) that comes out 'velocity' is a data error, reported
// and left as computed (never overridden). VELOCITY_MIN_ORDER_DATE is the
// Upload to Velocity creation floor and is not read here.
import type { QueryLike } from "./scheduler/types";

/** Pure: the rule. `maxPrep` = the largest prep_cost over the PO's ASIN rows (null = none recorded / no rows). */
export function shipsToFromPrep(maxPrep: number | null): "home" | "velocity" {
  return maxPrep != null && maxPrep > 0 ? "velocity" : "home";
}

/** Pure: the sanity check — a pre-Velocity PO that comes out 'velocity'. */
export function isPreVelocityDataError(orderDate: string, cutoff: string, shipsTo: "home" | "velocity"): boolean {
  return orderDate < cutoff && shipsTo === "velocity";
}

export const VELOCITY_START_DATE_KEY = "tracking.velocity_start_date";

/** The sanity-check cutoff (YYYY-MM-DD), or null when the setting is absent. */
export async function readVelocityStartDate(query: QueryLike): Promise<string | null> {
  const v = (await query(`SELECT value FROM settings WHERE key = $1`, [VELOCITY_START_DATE_KEY])).rows[0]?.value;
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

export interface ShipsToFacts { id: string; order_id: string; supplier: string; order_date: string; ships_to: string | null; max_prep: number | null }

export async function loadShipsToFacts(query: QueryLike): Promise<ShipsToFacts[]> {
  const hasCol = (await query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'purchase_orders' AND column_name = 'ships_to'`)).rows.length > 0;
  const r = await query(
    `SELECT p.id, p.order_id, p.supplier, p.order_date::text AS order_date, ${hasCol ? "p.ships_to" : "NULL::text AS ships_to"},
            (SELECT MAX(a.prep_cost) FROM po_asins a WHERE a.po_id = p.id)::float8 AS max_prep
       FROM purchase_orders p ORDER BY p.order_date, p.order_id`,
  );
  return r.rows.map((x: any) => ({ ...x, id: String(x.id), max_prep: x.max_prep == null ? null : Number(x.max_prep) }));
}
