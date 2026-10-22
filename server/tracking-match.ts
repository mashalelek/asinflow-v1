// Tracking row → AF PO (SPEC §26; patch po-tracking-velocity §5, §6).
//
// Supplier from the sender domain: an explicit tracking.supplier_domain_map
// entry wins; otherwise an OBVIOUS pair — the sender's registrable domain is
// an AF supplier name (oe.target.com → target.com), or a supplier shares it
// (equalexchange.coop ↔ shop.equalexchange.coop), or, for a notification
// platform, the first label is (tractorsupply.narvar.com → tractorsupply.com).
// An obvious pair is written into the map when matching runs live, so the map
// stays the one editable record (§6). Unknown → unmatched / unknown_sender.
//
// PO: supplier = guess AND base(order_id) = retailer order #, compared with
// punctuation stripped (Walmart prints 2000153-28073060, AF stores
// 200015328073060). base = order_id without a trailing _N (D4). An AF
// order_id holding two ids ("115449859 / 115450009") matches either.
// 0 → no_po (retried every run), 1 → matched, > 1 → ambiguous.
// A row placed by hand (source manual, or reassigned) is never touched.
import type { QueryLike } from "./scheduler/types";

export const DOMAIN_MAP_KEY = "tracking.supplier_domain_map";
/** Hosted notification / storefront platforms: the store is the first label, not the domain. */
const PLATFORMS = new Set(["narvar.com", "narvarnotify.com", "shopifyemail.com", "shipstation.com", "parcelpanel.net", "aftership.com", "veeqo.com", "zendesk.com"]);

export const registrable = (domain: string): string => domain.toLowerCase().split(".").slice(-2).join(".");
export const normOrder = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
/** D4: AF's "_N" suffix (a second PO for one retailer order) matches on the base id. */
export const baseOrderId = (orderId: string): string => orderId.trim().replace(/_\d+$/, "");
/** Every id an AF order_id field holds ("115449859 / 115450009" → both). */
export const orderIdParts = (orderId: string): string[] => orderId.split(/\s*[/,]\s*/).map(baseOrderId).filter(Boolean);

/** Pure. */
export function resolveSupplier(domain: string | null, map: Record<string, string>, suppliers: readonly string[]): { supplier: string | null; obvious: boolean } {
  if (!domain) return { supplier: null, obvious: false };
  const d = domain.toLowerCase();
  const reg = registrable(d);
  const hit = map[d] ?? map[reg];
  if (hit) return { supplier: hit, obvious: false };
  const lower = new Map(suppliers.map((s) => [s.toLowerCase(), s]));
  if (lower.has(reg)) return { supplier: lower.get(reg)!, obvious: true };
  const sameReg = suppliers.filter((s) => registrable(s) === reg);
  if (sameReg.length === 1) return { supplier: sameReg[0], obvious: true };
  if (PLATFORMS.has(reg)) {
    const first = d.split(".")[0];
    const cand = lower.get(`${first}.com`);
    if (cand) return { supplier: cand, obvious: true };
  }
  return { supplier: null, obvious: false };
}

export interface PoRef { id: string; supplier: string; order_id: string }

/** Pure: the POs a tracking row's order # names for that supplier. */
export function findPos(supplier: string, retailerOrderId: string, pos: readonly PoRef[]): PoRef[] {
  const want = normOrder(baseOrderId(retailerOrderId));
  if (!want) return [];
  return pos.filter((p) => p.supplier === supplier && orderIdParts(p.order_id).some((x) => normOrder(x) === want));
}

export type MatchOutcome = { status: "matched"; po_id: string } | { status: "unmatched"; reason: "unknown_sender" | "no_po" | "ambiguous" | "unpaired"; candidates?: string[] };

/** Pure: one row's match. */
export function matchRow(row: { sender_domain: string | null; retailer_order_id: string | null }, map: Record<string, string>, suppliers: readonly string[], pos: readonly PoRef[]): MatchOutcome & { supplier: string | null; obvious: boolean } {
  const s = resolveSupplier(row.sender_domain, map, suppliers);
  if (!s.supplier) return { status: "unmatched", reason: "unknown_sender", ...s };
  if (!row.retailer_order_id) return { status: "unmatched", reason: "unpaired", ...s };
  const hits = findPos(s.supplier, row.retailer_order_id, pos);
  if (hits.length === 1) return { status: "matched", po_id: hits[0].id, ...s };
  if (hits.length === 0) return { status: "unmatched", reason: "no_po", ...s };
  return { status: "unmatched", reason: "ambiguous", candidates: hits.map((h) => h.id), ...s };
}

export async function loadDomainMap(query: QueryLike): Promise<Record<string, string>> {
  const v = (await query(`SELECT value FROM settings WHERE key = $1`, [DOMAIN_MAP_KEY])).rows[0]?.value;
  return v && typeof v === "object" ? v : {};
}

export async function setDomainMapEntry(query: QueryLike, domain: string, supplier: string | null): Promise<void> {
  if (supplier == null) {
    await query(`UPDATE settings SET value = value - $2, updated_at = NOW() WHERE key = $1`, [DOMAIN_MAP_KEY, domain.toLowerCase()]);
    return;
  }
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, jsonb_build_object($2::text, $3::text), NOW())
     ON CONFLICT (key) DO UPDATE SET value = settings.value || jsonb_build_object($2::text, $3::text), updated_at = NOW()`,
    [DOMAIN_MAP_KEY, domain.toLowerCase(), supplier],
  );
}

export interface MatchRunResult { considered: number; matched: number; unmatched: Record<string, number>; seeded: Record<string, string> }

/**
 * Match every open unmatched row the sync may move (not manual, not
 * reassigned, not dismissed, not an ai_disabled placeholder, not a return). Dry run:
 * computes, writes nothing.
 */
export async function matchTrackingRows(query: QueryLike, opts: { dryRun?: boolean } = {}): Promise<MatchRunResult> {
  const rows = (await query(
    `SELECT id, sender_domain, retailer_order_id FROM po_tracking
      WHERE status = 'unmatched' AND source <> 'manual' AND reassigned_at IS NULL
        AND COALESCE(match_reason, '') NOT IN ('dismissed', 'ai_disabled', 'return')`,
  )).rows;
  const r: MatchRunResult = { considered: rows.length, matched: 0, unmatched: {}, seeded: {} };
  if (rows.length === 0) return r;
  const map = await loadDomainMap(query);
  const pos: PoRef[] = (await query(`SELECT id, supplier, order_id FROM purchase_orders`)).rows.map((x: any) => ({ id: String(x.id), supplier: String(x.supplier), order_id: String(x.order_id) }));
  const suppliers = Array.from(new Set(pos.map((p) => p.supplier)));
  for (const row of rows) {
    const m = matchRow(row, { ...map, ...r.seeded }, suppliers, pos);
    if (m.obvious && m.supplier && row.sender_domain && !map[row.sender_domain]) r.seeded[String(row.sender_domain).toLowerCase()] = m.supplier;
    if (m.status === "matched") r.matched++; else r.unmatched[m.reason] = (r.unmatched[m.reason] ?? 0) + 1;
    if (opts.dryRun) continue;
    await query(
      `UPDATE po_tracking SET supplier_guess = $2, po_id = $3, status = $4, match_reason = $5, updated_at = NOW()
        WHERE id = $1 AND status = 'unmatched' AND source <> 'manual' AND reassigned_at IS NULL`,
      [row.id, m.supplier, m.status === "matched" ? m.po_id : null, m.status, m.status === "matched" ? null : m.reason],
    );
  }
  if (!opts.dryRun) for (const [d, s] of Object.entries(r.seeded)) await setDomainMapEntry(query, d, s);
  return r;
}
