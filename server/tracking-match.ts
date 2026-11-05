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
//
// 2026-11-04 (Maria — the 81-row queue): a leading zero on the printed #
// (Summit Racing 0412645 ↔ 412645) compares equal; and when the labelled #
// finds nothing, the email's TEXT is read for an AF order # as a whole
// token (posNamedInText, server/order-number.ts): the resolved supplier's
// POs, or every PO for a sender that resolves to none (a carrier notice, a
// platform). Exactly one PO named, with an order date no later than a day
// after the email → matched (match_reason 'order_in_text'). The text comes
// from Gmail by the row's message id (textFor) — only for rows the labelled
// # left unmatched.
//
// 2026-11-04 (Maria — the "PO not in AF" rows): a no_po row whose order # is
// a REPLACEMENT order — the retailer's replacement email names the original
// (tracking-replacement.ts) — attaches to the one supplier PO with that
// original # (match_reason 'replacement') and notes it on the PO with a
// History row.
//
// 2026-11-04 (Maria — the two Zara UPS notices): a CARRIER's notice (UPS /
// FedEx / USPS) is sent "at the request of" the shipper ("ZARA DEL AMO
// FASHION CENTER") and names no order #. The shipper resolves through
// supplier_aliases — an alias equal to the name, or the one supplier with an
// alias that is a word prefix of it ("zara") — then the supplier's
// candidates are its POs ordered 0–30 calendar days (Eastern) before the
// email, not closed, with a ships_to matching the notice's ship-to street
// (unknown on either side does not exclude), and not fully shipped (Σ
// qty_shipped_supplier < Σ qty). Exactly one → matched (match_reason
// 'carrier_shipper'); several → ambiguous with the candidates, none → no_po.
// The email's text naming one PO (order_in_text) still wins. A carrier
// domain is never seeded into the domain map. The shipper and the carrier's
// reference numbers are stored on the row (shipper_name, carrier_refs).
import type { QueryLike } from "./scheduler/types";
import { isCarrierSender, extractShipper, extractCarrierRefs } from "./tracking-parse";
import { normOrder, baseOrderId, orderIdParts, stripShipmentSuffix, digitForms, posNamedInText, matchOrderId } from "./order-number";
import { loadAliases, aliasKey } from "./supplier-aliases";
import { appendPoNote, replacementNote, type ReplacementLookup } from "./tracking-replacement";
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

export interface PoRef { id: string; supplier: string; order_id: string; order_date?: Date | string | null; alt_order_ids?: string | null; ships_to?: string | null; fully_shipped?: boolean; closed?: boolean }

export const CARRIER_WINDOW_DAYS = 30;
const words = (x: string) => x.toLowerCase().normalize("NFD").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
/** Pure: the supplier a carrier notice's shipper names — an alias equal to it, else the ONE supplier with an alias (4+ characters) that is a word prefix of it, else the one supplier named by it. */
export function supplierForShipper(name: string | null | undefined, aliases: ReadonlyMap<string, string>, suppliers: readonly string[]): string | null {
  const n = String(name ?? "").trim();
  if (!n) return null;
  const exact = aliases.get(aliasKey(n));
  if (exact) return exact;
  const w = words(n);
  const hits = new Set<string>();
  aliases.forEach((sup, alias) => {
    const aw = words(alias);
    if (alias.replace(/\s/g, "").length >= 4 && aw.length > 0 && aw.length <= w.length && aw.every((x, i) => w[i] === x)) hits.add(sup);
  });
  if (hits.size === 1) return Array.from(hits)[0];
  if (hits.size > 1) return null;
  return supplierByName(n, suppliers);
}
const etDay = (d: Date | string): string => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(d));
const dayNumber = (ymd: string) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10))) / 86_400_000;
/** "805 grandy" → velocity / home from the tracking.* streets; null when unknown. */
export function shipToKind(street: string | null | undefined, streets: { velocityStreet: string; homeStreets: readonly string[] }): "velocity" | "home" | null {
  const s = String(street ?? "").toLowerCase().trim();
  if (!s) return null;
  if (s.startsWith(streets.velocityStreet.toLowerCase())) return "velocity";
  if (streets.homeStreets.some((h) => s.startsWith(h.toLowerCase()))) return "home";
  return null;
}
/** Pure: a no-order-# carrier notice's candidate POs (see the 2026-11-04 note above), oldest first. */
export function carrierCandidates(supplier: string, emailDate: Date | string | null, kind: "velocity" | "home" | null, pos: readonly PoRef[]): PoRef[] {
  if (!emailDate) return [];
  const e = dayNumber(etDay(emailDate));
  return pos.filter((p) => {
    if (p.supplier !== supplier || p.order_date == null || p.closed || p.fully_shipped) return false;
    const age = e - dayNumber(String(p.order_date instanceof Date ? etDay(p.order_date) : String(p.order_date).slice(0, 10)));
    if (age < 0 || age > CARRIER_WINDOW_DAYS) return false;
    return !kind || !p.ships_to || p.ships_to === kind;
  }).sort((a, b) => String(a.order_date).localeCompare(String(b.order_date)));
}
/** The PO fields the matchers read (order #s, date, ships_to, closed, fully shipped). */
export const MATCH_POS_SQL = `SELECT p.id, p.supplier, p.order_id, p.order_date, p.alt_order_ids, p.ships_to, (p.closed_at IS NOT NULL) AS closed,
  COALESCE((SELECT SUM(a.qty_shipped_supplier) FROM po_asins a WHERE a.po_id = p.id), 0) >= NULLIF((SELECT SUM(a.qty) FROM po_asins a WHERE a.po_id = p.id), 0) AS fully_shipped
  FROM purchase_orders p`;
export const toPoRef = (x: any): PoRef => ({ id: String(x.id), supplier: String(x.supplier), order_id: String(x.order_id), order_date: x.order_date ?? null, alt_order_ids: x.alt_order_ids ?? null, ships_to: x.ships_to ?? null, closed: !!x.closed, fully_shipped: !!x.fully_shipped });
export async function loadShipStreets(query: QueryLike): Promise<{ velocityStreet: string; homeStreets: string[] }> {
  const rows = (await query(`SELECT key, value FROM settings WHERE key = ANY($1::text[])`, [["tracking.velocity_street", "tracking.home_streets"]])).rows;
  const v = (k: string) => rows.find((r: any) => r.key === k)?.value;
  return { velocityStreet: String(v("tracking.velocity_street") ?? "805 grandy"), homeStreets: (v("tracking.home_streets") as string[]) ?? ["65 rivercrest"] };
}

/** Pure: the POs a tracking row's order # names for that supplier. */
export function findPos(supplier: string, retailerOrderId: string, pos: readonly PoRef[]): PoRef[] {
  // The email's number as printed, and without a retailer's trailing -N
  // shipment suffix (WorldPantry 70633076-1 → 70633076).
  const raw = baseOrderId(retailerOrderId);
  const lz = (k: string) => k.replace(/^0+(?=\d)/, "");
  const want = new Set([raw, stripShipmentSuffix(raw)].map((x) => lz(normOrder(x))).filter(Boolean));
  if (want.size === 0) return [];
  return pos.filter((p) => p.supplier === supplier && orderIdParts(matchOrderId(p)).some((x) => want.has(lz(normOrder(x)))));
}

export type MatchVia = "order_id_unique" | "retailer_name" | "order_in_text" | "replacement" | "carrier_shipper";
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
  return pos.filter((p) => orderIdParts(matchOrderId(p)).some((x) => digitForms(x).some((d) => want.has(d))));
}

/** Pure: the ONE PO the email's text names (supplier's POs, or all when the sender resolves to none), ordered no later than a day after the email. */
export function poNamedInEmail(text: string, emailDate: Date | null, supplier: string | null, pos: readonly PoRef[]): PoRef | null {
  const scope = supplier ? pos.filter((p) => p.supplier === supplier) : pos;
  const hits = posNamedInText(text, scope, supplier ? "supplier" : "any").filter((p) =>
    !emailDate || p.order_date == null || new Date(p.order_date).getTime() <= emailDate.getTime() + 86_400_000);
  return hits.length === 1 ? hits[0] : null;
}

/** Pure: one row's match. */
export function matchRow(
  row: { sender_domain: string | null; retailer_order_id: string | null; email_subject?: string | null; shipper_name?: string | null; ship_to_kind?: "velocity" | "home" | null; shipped_at?: Date | string | null },
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
  // A carrier's notice: the supplier from the shipper it names; with no order #, the supplier's candidate POs.
  if (!s.supplier && isCarrierSender(row.sender_domain) && row.shipper_name) {
    const sup = supplierForShipper(row.shipper_name, aliases, suppliers);
    if (sup) { s = { supplier: sup, obvious: false }; via = "carrier_shipper"; }
  }
  if (!row.retailer_order_id && via === "carrier_shipper" && s.supplier) {
    const c = carrierCandidates(s.supplier, row.shipped_at ?? null, row.ship_to_kind ?? null, pos);
    if (c.length === 1) return { status: "matched", po_id: c[0].id, via, ...s };
    return { status: "unmatched", reason: c.length ? "ambiguous" : "no_po", ...(c.length ? { candidates: c.map((x) => x.id) } : {}), ...s };
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

/** The ONE AF PO a placeholder's order # names (matchRow's rule — the tracking AI fallback asks only about these), else null. */
export async function onePoResolver(query: QueryLike): Promise<(row: { sender_domain: string | null; retailer_order_id: string | null; email_subject: string | null }) => { po_id: string; supplier: string } | null> {
  const map = await loadDomainMap(query);
  const platforms = await loadPlatformSenders(query);
  const aliases = await loadAliases(query);
  const pos: PoRef[] = (await query(`SELECT id, supplier, order_id, alt_order_ids FROM purchase_orders`)).rows.map((x: any) => ({ id: String(x.id), supplier: String(x.supplier), order_id: String(x.order_id), alt_order_ids: x.alt_order_ids ?? null }));
  const suppliers = Array.from(new Set(pos.map((p) => p.supplier)));
  return (row) => {
    const m = matchRow(row, map, suppliers, pos, platforms, aliases);
    return m.status === "matched" ? { po_id: m.po_id, supplier: pos.find((p) => p.id === m.po_id)!.supplier } : null;
  };
}

/** The email behind a row, for the text rule: Gmail by message id (null when it cannot be read). */
export type EmailTextFor = (gmailMessageId: string) => Promise<{ text: string; date: Date | null } | null>;

export interface MatchRunResult {
  considered: number; matched: number; matched_via: Record<string, number>; unmatched: Record<string, number>; seeded: Record<string, string>;
  /** Every row this run matches (live) or would (dry run) — the link list a new rule is checked against. */
  links: Array<{ id: number; po_id: string; supplier: string | null; via: string }>;
}

/**
 * Match every open unmatched row the sync may move (not manual, not
 * reassigned, not dismissed, not an ai_disabled / ai_no_tracking placeholder, not a return). Dry run:
 * computes, writes nothing.
 */
export async function matchTrackingRows(query: QueryLike, opts: { dryRun?: boolean; textFor?: EmailTextFor; replacementFor?: ReplacementLookup } = {}): Promise<MatchRunResult> {
  const rows = (await query(
    `SELECT id, carrier, tracking_number, sender_domain, retailer_order_id, email_subject, gmail_message_id, shipper_name, carrier_refs, ship_to_street, shipped_at FROM po_tracking
      WHERE status = 'unmatched' AND source <> 'manual' AND reassigned_at IS NULL
        AND COALESCE(match_reason, '') NOT IN ('dismissed', 'ai_disabled', 'ai_no_tracking', 'return')`,
  )).rows;
  const r: MatchRunResult = { considered: rows.length, matched: 0, matched_via: {}, unmatched: {}, seeded: {}, links: [] };
  if (rows.length === 0) return r;
  const map = await loadDomainMap(query);
  const platforms = await loadPlatformSenders(query);
  const aliases = await loadAliases(query);
  const pos: PoRef[] = (await query(MATCH_POS_SQL)).rows.map(toPoRef);
  const suppliers = Array.from(new Set(pos.map((p) => p.supplier)));
  const streets = await loadShipStreets(query);
  for (const row of rows) {
    // A carrier notice stored before its shipper was read (2026-11-04): read it — and the reference numbers — from the email, and keep them.
    let email: { text: string; date: Date | null } | null | undefined;
    const readEmail = async () => (email !== undefined ? email : (email = opts.textFor && row.gmail_message_id ? await opts.textFor(String(row.gmail_message_id)).catch(() => null) : null));
    if (isCarrierSender(row.sender_domain) && !row.shipper_name && opts.textFor && row.gmail_message_id) {
      const e = await readEmail();
      if (e) {
        row.shipper_name = extractShipper(e.text);
        const refs = extractCarrierRefs(e.text);
        if (!opts.dryRun && (row.shipper_name || refs.length)) await query(`UPDATE po_tracking SET shipper_name = COALESCE(shipper_name, $2), carrier_refs = COALESCE(carrier_refs, $3::text[]), updated_at = NOW() WHERE id = $1`, [row.id, row.shipper_name, refs.length ? refs : null]);
      }
    }
    const subject = { ...row, ship_to_kind: shipToKind(row.ship_to_street, streets) };
    let m: ReturnType<typeof matchRow> = matchRow(subject, { ...map, ...r.seeded }, suppliers, pos, platforms, aliases);
    const carrierAmbiguous = m.status === "unmatched" && m.reason === "ambiguous" && isCarrierSender(row.sender_domain);
    if (m.status === "unmatched" && (m.reason !== "ambiguous" || carrierAmbiguous) && opts.textFor && row.gmail_message_id) {
      const email = await readEmail();
      const po = email ? poNamedInEmail(`${row.email_subject ?? ""}\n${email.text}`, email.date, m.supplier, pos) : null;
      if (po) m = { status: "matched", po_id: po.id, via: "order_in_text", supplier: po.supplier, obvious: m.supplier ? m.obvious : false };
    }
    // A replacement order (2026-11-04): the retailer's replacement email names the original order #.
    let note: string | null = null;
    if (m.status === "unmatched" && m.reason === "no_po" && m.supplier && row.retailer_order_id && opts.replacementFor) {
      const rep = await opts.replacementFor(String(row.retailer_order_id));
      const hits = rep ? findPos(m.supplier, rep.original, pos) : [];
      if (rep && hits.length === 1) {
        m = { status: "matched", po_id: hits[0].id, via: "replacement", supplier: m.supplier, obvious: m.obvious };
        note = replacementNote(String(row.retailer_order_id), rep.date, String(row.carrier), String(row.tracking_number));
      }
    }
    if (m.obvious && m.supplier && row.sender_domain && !map[row.sender_domain]) r.seeded[String(row.sender_domain).toLowerCase()] = m.supplier;
    if (m.status === "matched") { r.matched++; const k = m.via ?? "supplier"; r.matched_via[k] = (r.matched_via[k] ?? 0) + 1; r.links.push({ id: Number(row.id), po_id: m.po_id, supplier: m.supplier, via: k }); } else r.unmatched[m.reason] = (r.unmatched[m.reason] ?? 0) + 1;
    if (opts.dryRun) continue;
    await query(
      `UPDATE po_tracking SET supplier_guess = $2, po_id = $3, status = $4, match_reason = $5, updated_at = NOW()
        WHERE id = $1 AND status = 'unmatched' AND source <> 'manual' AND reassigned_at IS NULL`,
      [row.id, m.supplier, m.status === "matched" ? m.po_id : null, m.status, m.status === "matched" ? m.via ?? null : m.reason],
    );
    if (note && m.status === "matched") await appendPoNote(query, m.po_id, note);
  }
  if (!opts.dryRun) for (const [d, s] of Object.entries(r.seeded)) await setDomainMapEntry(query, d, s);
  return r;
}
