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
//
// 2026-10-22 (Maria — the queue was a matcher gap):
// - Platform senders (tracking.platform_senders: ShipStation, ParcelPanel,
//   Shopify, Veeqo, WorldPantry…) send for many stores. With no map entry
//   the store is read from the SUBJECT ("your Los Poblanos order", "order
//   with Tetley and WorldPantry.com") and matched to a supplier by name
//   (match_reason 'retailer_name'). A platform domain is never seeded into
//   the map.
// - Order-#-unique: when the sender resolves to NO supplier (unmapped),
//   the order # is compared digits-only (also without a trailing -N / _N)
//   against EVERY AF PO; exactly one hit attaches it (match_reason
//   'order_id_unique'). Zero or several → queued as before. 5+ digits only.
//   A sender that does resolve keeps its supplier: its no_po is never
//   attached to another store's PO by number alone.
//
// 2026-10-29 (PO matching patch §7): the order-# handling (punctuation, a
// free-text prefix, AF's _N, a retailer's -N, two-id AF order_ids) is the
// shared server/order-number.ts, the same functions shipment sync A uses;
// a platform email's subject name resolves through supplier_aliases first.
import type { QueryLike } from "./scheduler/types";
import { normOrder, baseOrderId, orderIdParts, stripShipmentSuffix, digitForms } from "./order-number";
import { loadAliases, aliasKey } from "./supplier-aliases";
export { normOrder, baseOrderId, orderIdParts } from "./order-number";

export const DOMAIN_MAP_KEY = "tracking.supplier_domain_map";
export const PLATFORM_SENDERS_KEY = "tracking.platform_senders";
/** Hosted notification / storefront / fulfilment platforms (registrable domains): the store is not the sender. Default for tracking.platform_senders. */
export const DEFAULT_PLATFORM_SENDERS = ["narvar.com", "narvarnotify.com", "shopifyemail.com", "shipstation.com", "parcelpanel.net", "aftership.com", "veeqo.com", "zendesk.com", "worldpantry.com"];

export const registrable = (domain: string): string => domain.toLowerCase().split(".").slice(-2).join(".");

/** Pure. */
export function resolveSupplier(domain: string | null, map: Record<string, string>, suppliers: readonly string[], platforms: readonly string[] = DEFAULT_PLATFORM_SENDERS): { supplier: string | null; obvious: boolean } {
  if (!domain) return { supplier: null, obvious: false };
  const d = domain.toLowerCase();
  const reg = registrable(d);
  const hit = map[d] ?? map[reg];
  if (hit) return { supplier: hit, obvious: false };
  const lower = new Map(suppliers.map((s) => [s.toLowerCase(), s]));
  if (lower.has(reg)) return { supplier: lower.get(reg)!, obvious: true };
  const sameReg = suppliers.filter((s) => registrable(s) === reg);
  if (sameReg.length === 1) return { supplier: sameReg[0], obvious: true };
  if (platforms.includes(reg)) {
    const first = d.split(".")[0];
    const cand = lower.get(`${first}.com`);
    if (cand) return { supplier: cand, obvious: true };
  }
  return { supplier: null, obvious: false };
}

export interface PoRef { id: string; supplier: string; order_id: string }

/** Pure: the POs a tracking row's order # names for that supplier. */
export function findPos(supplier: string, retailerOrderId: string, pos: readonly PoRef[]): PoRef[] {
  // The email's number as printed, and without a retailer's trailing -N
  // shipment suffix (WorldPantry 70633076-1 → 70633076).
  const raw = baseOrderId(retailerOrderId);
  const want = new Set([raw, stripShipmentSuffix(raw)].map(normOrder).filter(Boolean));
  if (want.size === 0) return [];
  return pos.filter((p) => p.supplier === supplier && orderIdParts(p.order_id).some((x) => want.has(normOrder(x))));
}

export type MatchVia = "order_id_unique" | "retailer_name";
export type MatchOutcome = { status: "matched"; po_id: string; via?: MatchVia } | { status: "unmatched"; reason: "unknown_sender" | "no_po" | "ambiguous" | "unpaired"; candidates?: string[] };

const NAME_PATTERNS = [/\byour\s+(.{2,40}?)\s+order\b/i, /\border with\s+(.{2,40}?)\s+(?:and|has|is)\b/i];
const NAME_STOP = /^(new|recent|online|latest|last|first|next|the)$/i;
const NAME_LABEL_SKIP = new Set(["www", "shop", "store", "us", "usa", "en", "m"]);
const alnum = (x: string) => x.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");

/** Pure: the store a platform email names in its subject ("your Los Poblanos order"), or null. */
export function retailerNameFromSubject(subject: string | null): string | null {
  for (const re of NAME_PATTERNS) {
    const m = re.exec(subject ?? "");
    const n = m?.[1]?.trim();
    if (n && !NAME_STOP.test(n) && alnum(n).length >= 3) return n;
  }
  return null;
}

/** Pure: the ONE supplier whose domain label is that name (lospoblanos ↔ shop.lospoblanos.com; tetley ↔ shop.tetleyusa.com, prefix of 5+). */
export function supplierByName(name: string, suppliers: readonly string[]): string | null {
  const key = alnum(name.replace(/\b(llc|inc|co|ltd)\b\.?/gi, ""));
  if (key.length < 3) return null;
  const hits = suppliers.filter((sup) => {
    const labels = sup.toLowerCase().split(".").slice(0, -1).filter((l) => !NAME_LABEL_SKIP.has(l)).map(alnum);
    return labels.some((l) => l === key || (key.length >= 5 && l.startsWith(key)));
  });
  return hits.length === 1 ? hits[0] : null;
}

/** Pure: every AF PO whose order # equals this one digits-only, any supplier. */
export function findPosByOrderDigits(retailerOrderId: string, pos: readonly PoRef[]): PoRef[] {
  const want = new Set(digitForms(retailerOrderId));
  if (want.size === 0) return [];
  return pos.filter((p) => orderIdParts(p.order_id).some((x) => digitForms(x).some((d) => want.has(d))));
}

/** Pure: one row's match. */
export function matchRow(
  row: { sender_domain: string | null; retailer_order_id: string | null; email_subject?: string | null },
  map: Record<string, string>, suppliers: readonly string[], pos: readonly PoRef[], platforms: readonly string[] = DEFAULT_PLATFORM_SENDERS,
  aliases: ReadonlyMap<string, string> = new Map(),
): MatchOutcome & { supplier: string | null; obvious: boolean } {
  let s = resolveSupplier(row.sender_domain, map, suppliers, platforms);
  let via: MatchVia | undefined;
  if (!s.supplier && row.sender_domain && platforms.includes(registrable(row.sender_domain))) {
    const name = retailerNameFromSubject(row.email_subject ?? null);
    const sup = name ? (aliases.get(aliasKey(name)) ?? supplierByName(name, suppliers)) : null;
    if (sup) { s = { supplier: sup, obvious: false }; via = "retailer_name"; }
  }
  if (!row.retailer_order_id) return { status: "unmatched", reason: s.supplier ? "unpaired" : "unknown_sender", ...s };
  const hits = s.supplier ? findPos(s.supplier, row.retailer_order_id, pos) : [];
  if (hits.length === 1) return { status: "matched", po_id: hits[0].id, ...(via ? { via } : {}), ...s };
  if (hits.length > 1) return { status: "unmatched", reason: "ambiguous", candidates: hits.map((h) => h.id), ...s };
  // Order-#-unique (unmapped sender only): the number alone names exactly one PO.
  const any = s.supplier ? [] : findPosByOrderDigits(row.retailer_order_id, pos);
  if (any.length === 1) return { status: "matched", po_id: any[0].id, via: "order_id_unique", supplier: any[0].supplier, obvious: false };
  return { status: "unmatched", reason: s.supplier ? "no_po" : "unknown_sender", ...s };
}

export async function loadPlatformSenders(query: QueryLike): Promise<string[]> {
  const v = (await query(`SELECT value FROM settings WHERE key = $1`, [PLATFORM_SENDERS_KEY])).rows[0]?.value;
  return Array.isArray(v) && v.length ? v.map((x) => String(x).toLowerCase()) : DEFAULT_PLATFORM_SENDERS;
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

export interface MatchRunResult { considered: number; matched: number; matched_via: Record<string, number>; unmatched: Record<string, number>; seeded: Record<string, string> }

/**
 * Match every open unmatched row the sync may move (not manual, not
 * reassigned, not dismissed, not an ai_disabled placeholder, not a return). Dry run:
 * computes, writes nothing.
 */
export async function matchTrackingRows(query: QueryLike, opts: { dryRun?: boolean } = {}): Promise<MatchRunResult> {
  const rows = (await query(
    `SELECT id, sender_domain, retailer_order_id, email_subject FROM po_tracking
      WHERE status = 'unmatched' AND source <> 'manual' AND reassigned_at IS NULL
        AND COALESCE(match_reason, '') NOT IN ('dismissed', 'ai_disabled', 'return')`,
  )).rows;
  const r: MatchRunResult = { considered: rows.length, matched: 0, matched_via: {}, unmatched: {}, seeded: {} };
  if (rows.length === 0) return r;
  const map = await loadDomainMap(query);
  const platforms = await loadPlatformSenders(query);
  const aliases = await loadAliases(query);
  const pos: PoRef[] = (await query(`SELECT id, supplier, order_id FROM purchase_orders`)).rows.map((x: any) => ({ id: String(x.id), supplier: String(x.supplier), order_id: String(x.order_id) }));
  const suppliers = Array.from(new Set(pos.map((p) => p.supplier)));
  for (const row of rows) {
    const m = matchRow(row, { ...map, ...r.seeded }, suppliers, pos, platforms, aliases);
    if (m.obvious && m.supplier && row.sender_domain && !map[row.sender_domain]) r.seeded[String(row.sender_domain).toLowerCase()] = m.supplier;
    if (m.status === "matched") { r.matched++; const k = m.via ?? "supplier"; r.matched_via[k] = (r.matched_via[k] ?? 0) + 1; } else r.unmatched[m.reason] = (r.unmatched[m.reason] ?? 0) + 1;
    if (opts.dryRun) continue;
    await query(
      `UPDATE po_tracking SET supplier_guess = $2, po_id = $3, status = $4, match_reason = $5, updated_at = NOW()
        WHERE id = $1 AND status = 'unmatched' AND source <> 'manual' AND reassigned_at IS NULL`,
      [row.id, m.supplier, m.status === "matched" ? m.po_id : null, m.status, m.status === "matched" ? m.via ?? null : m.reason],
    );
  }
  if (!opts.dryRun) for (const [d, s] of Object.entries(r.seeded)) await setDomainMapEntry(query, d, s);
  return r;
}
