// §11 Bundle identity records (2026-09-21, Parts A–C). Restores the one key
// Velocity stops serializing: a fully-shipped bundle's shipment rows carry the
// parent order_id but order_number null and NO bundle_children, and children
// cannot be enumerated from a parent once it leaves /inbound + /inventory.
//
// NOT a gatekeeper ledger (§11): nothing here records what AF sent, and no row
// causes a create or a skip on its own. A row matters only when Velocity itself
// returns that parent order_id on a shipment row. Insert/upsert only.
import { query as defaultQuery } from "./db";

type QueryLike = (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }>;

export interface BundleIdentityRow {
  velocity_order_id: string;
  asin: string;
  child_order_numbers: string[];
  child_order_ids: string[] | null;
  source: "observed" | "manual_seed" | "manual_map";
}

/** Child order numbers + ids observable on a list-visible bundle parent. */
export function childIdentityOf(o: any): { numbers: string[]; ids: string[] } {
  const kids: any[] = Array.isArray(o?.bundle_children) ? o.bundle_children : [];
  const numbers = Array.from(new Set(
    kids.map((c) => String(c?.order_number ?? "").trim()).filter((x) => x !== ""),
  ));
  const ids = Array.from(new Set(
    kids.map((c) => String(c?.order_id ?? "").trim()).filter((x) => x !== ""),
  ));
  return { numbers, ids };
}

/**
 * Part B.1 — the recordable set from a known-orders fetch: every list-leg
 * bundle parent with usable children. Pure, so the plan can REPORT it under
 * dryRun without writing (Part B.3).
 */
export function recordableBundles(orders: any[]): BundleIdentityRow[] {
  const out: BundleIdentityRow[] = [];
  for (const o of orders) {
    if (String(o?.sold_as ?? "").toLowerCase() !== "bundle") continue;
    const leg = String(o?.lifecycleSource ?? "");
    if (leg !== "inbound" && leg !== "inventory") continue; // list legs only
    const oid = String(o?.order_id ?? "").trim();
    if (oid === "") continue;
    const { numbers, ids } = childIdentityOf(o);
    if (numbers.length === 0) continue;
    out.push({
      velocity_order_id: oid,
      asin: String(o?.asin ?? "").toUpperCase(),
      child_order_numbers: numbers,
      child_order_ids: ids.length > 0 ? ids : null,
      source: "observed",
    });
  }
  return out;
}

/**
 * Upsert observed rows. While a parent is list-visible Velocity is the truth,
 * so observed children OVERWRITE the stored array; a change is reported so a
 * silent rewrite can't happen unnoticed. Never deletes.
 */
export async function recordBundleIdentities(
  rows: BundleIdentityRow[],
  deps: { query?: QueryLike } = {},
): Promise<{ written: number; changed: Array<{ velocity_order_id: string; from: string[]; to: string[] }>; errors: string[] }> {
  const query = deps.query ?? (defaultQuery as any as QueryLike);
  const changed: Array<{ velocity_order_id: string; from: string[]; to: string[] }> = [];
  const errors: string[] = [];
  let written = 0;
  for (const r of rows) {
    try {
      const prev = await query(
        `SELECT child_order_numbers FROM velocity_bundle_identity WHERE velocity_order_id = $1`,
        [r.velocity_order_id],
      );
      const before: string[] = prev.rows[0]?.child_order_numbers ?? [];
      await query(
        `INSERT INTO velocity_bundle_identity
           (velocity_order_id, asin, child_order_numbers, child_order_ids, source, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3::text[], $4::text[], 'observed', now(), now())
         ON CONFLICT (velocity_order_id) DO UPDATE SET
           asin = EXCLUDED.asin,
           child_order_numbers = EXCLUDED.child_order_numbers,
           child_order_ids = COALESCE(EXCLUDED.child_order_ids, velocity_bundle_identity.child_order_ids),
           source = 'observed',
           last_seen_at = now()`,
        [r.velocity_order_id, r.asin, r.child_order_numbers, r.child_order_ids],
      );
      written++;
      const sameSet = before.length === r.child_order_numbers.length &&
        before.every((x) => r.child_order_numbers.includes(x));
      if (before.length > 0 && !sameSet) {
        changed.push({ velocity_order_id: r.velocity_order_id, from: before, to: r.child_order_numbers });
      }
    } catch (err: any) {
      // Part B.4: surfaced, never fatal — in-batch hydration already covers
      // everything currently list-visible.
      errors.push(`${r.velocity_order_id}: ${err?.message ?? String(err)}`);
    }
  }
  return { written, changed, errors };
}

/** Part C.2(b) — stored identities for a set of parent order_ids. */
export async function loadBundleIdentities(
  orderIds: string[],
  deps: { query?: QueryLike } = {},
): Promise<Map<string, BundleIdentityRow>> {
  const query = deps.query ?? (defaultQuery as any as QueryLike);
  const out = new Map<string, BundleIdentityRow>();
  if (orderIds.length === 0) return out;
  const res = await query(
    `SELECT velocity_order_id, asin, child_order_numbers, child_order_ids, source
       FROM velocity_bundle_identity WHERE velocity_order_id = ANY($1::text[])`,
    [orderIds],
  );
  for (const r of res.rows) out.set(String(r.velocity_order_id), r as BundleIdentityRow);
  return out;
}

/** Part D UI — write a manual mapping (parent order_id → sheet order number). */
export async function mapBundleIdentity(
  args: { velocityOrderId: string; asin: string; orderNumber: string },
  deps: { query?: QueryLike } = {},
): Promise<void> {
  const query = deps.query ?? (defaultQuery as any as QueryLike);
  const num = args.orderNumber.trim();
  if (num === "") throw new Error("mapBundleIdentity: orderNumber is required");
  await query(
    `INSERT INTO velocity_bundle_identity
       (velocity_order_id, asin, child_order_numbers, child_order_ids, source, first_seen_at, last_seen_at)
     VALUES ($1, $2, ARRAY[$3]::text[], NULL, 'manual_map', now(), now())
     ON CONFLICT (velocity_order_id) DO UPDATE SET
       child_order_numbers = ARRAY[$3]::text[],
       source = 'manual_map',
       last_seen_at = now()`,
    [args.velocityOrderId, args.asin.toUpperCase(), num],
  );
}

/**
 * §11 Part C.2 (2026-09-21; shared 2026-09-24) — hydrate child-less shipment
 * bundles from the identity record, in place, and report what stayed
 * unplaced.
 *
 * SHARED BY PLAN AND EXECUTE ON PURPOSE. Execute originally built its dedup
 * key set from matchKeysForOrder(live) with no hydration at all, so a bundle
 * whose parent had SHIPPED since approval keyed on the synthetic
 * __velocity_order_id form, matched no sheet key, and would have been
 * re-sent — a duplicate (134524 / B0DKT4NDFZ, measured 2026-09-24). A second
 * copy of this logic is exactly how the two paths diverged; there is now one.
 */
export async function hydrateChildlessBundles(
  orders: any[],
  deps: { query?: QueryLike } = {},
): Promise<{ hydrated: number; unplaced: any[] }> {
  const childless = orders.filter((o) =>
    String(o?.sold_as ?? "").toLowerCase() === "bundle" &&
    !(Array.isArray(o?.bundle_children) && o.bundle_children.length > 0));
  if (childless.length === 0) return { hydrated: 0, unplaced: [] };

  const identities = await loadBundleIdentities(
    childless.map((o) => String(o?.order_id ?? "")).filter((x) => x !== ""),
    deps,
  );
  let hydrated = 0;
  for (const o of childless) {
    const rec = identities.get(String(o?.order_id ?? ""));
    if (!rec || rec.child_order_numbers.length === 0) continue;
    // Minimal children — matchKeysForOrder only reads order_number. The
    // identity source stays visible downstream (report + mapping UI).
    o.bundle_children = rec.child_order_numbers.map((n) => ({ order_number: n }));
    o.__identity_source = rec.source;
    hydrated++;
  }
  const unplaced = childless.filter((o) =>
    !(Array.isArray(o?.bundle_children) && o.bundle_children.length > 0));
  return { hydrated, unplaced };
}
