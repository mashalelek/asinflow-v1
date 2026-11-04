// Order-# normalization, one module for both PO matchers (shipment sync A and
// the tracking matcher) — patch docs/claude_spec-patch-po-matching.md §3.2.
//
// normOrder: a free-text prefix ("Confirmation #", "Order #", "Order No.",
// "PO #") dropped, uppercase, only [A-Z0-9] kept — Walmart prints
// 2000152-79183885 where AF stores 200015279183885.
// baseOrderId: AF's "_N" (a second PO for one retailer order, D4) removed.
// stripShipmentSuffix: a retailer's trailing -N / _N shipment or re-key
// suffix of 1–2 digits removed (WorldPantry 70633076-1, Velocity
// CAR118805142_1).
// orderIdParts: an AF order_id holding two ids ("115449859 / 115450009")
// yields both, each without its "_N".

const PREFIX = /^\s*(?:confirmation|purchase\s+order|order|po)\s*(?:no\.?|number|#)\s*[:#]?\s*/i;
const ORDER_WORD = /^\s*order\s+(?=\S*\d)/i;

export const stripOrderPrefix = (s: string): string => s.replace(PREFIX, "").replace(ORDER_WORD, "");
export const normOrder = (s: string): string => stripOrderPrefix(s).toUpperCase().replace(/[^A-Z0-9]/g, "");
/** D4: AF's "_N" suffix (a second PO for one retailer order) matches on the base id. */
export const baseOrderId = (orderId: string): string => orderId.trim().replace(/_\d+$/, "");
export const stripShipmentSuffix = (s: string): string => s.trim().replace(/[-_]\d{1,2}$/, "");
/** Every id an AF order_id field holds ("115449859 / 115450009" → both). */
export const orderIdParts = (orderId: string): string[] => orderId.split(/\s*[/,]\s*/).map(baseOrderId).filter(Boolean);

/** Every id a PO is matched by: its order # and its alternate order #s (purchase_orders.alt_order_ids, comma-separated; migration 086), as one order_id string orderIdParts / afOrderKeys read. */
export const matchOrderId = (po: { order_id: string; alt_order_ids?: string | null }): string =>
  po.alt_order_ids && po.alt_order_ids.trim() ? `${po.order_id} / ${po.alt_order_ids}` : po.order_id;

/** The full key: normalized as written (a suffixed id keeps its suffix). */
export const orderKey = (s: string): string => normOrder(s);
/** The base key: without "_N" / "-N" (1–2 digits), then normalized. */
export const orderBaseKey = (s: string): string => normOrder(stripShipmentSuffix(baseOrderId(stripOrderPrefix(s))));

/** Full keys of every id an AF order_id holds, keeping a suffixed id's own key. */
export const afOrderKeys = (orderId: string): string[] =>
  Array.from(new Set(orderId.split(/\s*[/,]\s*/).filter(Boolean).map(normOrder).filter(Boolean)));
/** Base keys of every id an AF order_id holds. */
export const afOrderBaseKeys = (orderId: string): string[] =>
  Array.from(new Set(orderIdParts(orderId).map(orderBaseKey).filter(Boolean)));

/** Digits-only forms of an order #: as is, and without a trailing -N / _N (5+ digits only). */
export const digitForms = (s: string): string[] => {
  const t = stripOrderPrefix(s).trim();
  return Array.from(new Set([t, t.replace(/[-_]\d{1,2}$/, "")].map((x) => x.replace(/\D/g, "")).filter((d) => d.length >= 5)));
};

/** ILIKE "contains" pattern with \, % and _ escaped (use with ESCAPE '\'): "CAR118805142_1" matches literally. */
export const likeContains = (s: string): string => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// Order # named in an email's text (2026-11-04, Maria — the ShagTools PO and
// the unmatched tracking queue): carrier notices (UPS, FedEx), platform
// senders (ShipStation) and emails whose labelled number is the wrong one
// (Groomer's Choice prints a customer # beside the order #) still print the
// AF order # somewhere. A PO counts as named when one of its ids is a WHOLE
// token of the text — compared alnum-only, also with leading zeros dropped
// (Summit Racing prints 0412645 for AF's 412645), and a hyphenated token
// also joined (Walmart 2000152-79183885). Short ids are too easy to hit by
// chance: 6+ characters with a digit, and across every supplier (no sender
// to narrow by) 8+ characters or letters mixed with digits.

const dropZeros = (k: string): string => k.replace(/^0+(?=\d)/, "");

/** Pure: the comparable forms of every token in a text — as is, hyphen parts, hyphen-joined, leading zeros dropped. */
export function orderTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of Array.from((text ?? "").matchAll(/[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*/g))) {
    const t = m[0].toUpperCase();
    const forms = [t.replace(/[-_]/g, ""), ...t.split(/[-_]/)];
    for (const f of forms) if (f) { out.add(f); out.add(dropZeros(f)); }
  }
  return out;
}

/** Pure: an AF order id is specific enough to be matched from free text. */
export const namedIdOk = (key: string, scope: "supplier" | "any"): boolean =>
  key.length >= 6 && /\d/.test(key) && (scope === "supplier" || key.length >= 8 || /[A-Z]/.test(key));

/** Pure: the POs whose order # (any id the order_id holds, without AF's _N) is a whole token of the text. */
export function posNamedInText<T extends { order_id: string; alt_order_ids?: string | null }>(text: string, pos: readonly T[], scope: "supplier" | "any"): T[] {
  const tokens = orderTokens(text);
  return pos.filter((p) => orderIdParts(matchOrderId(p)).some((x) => {
    const k = dropZeros(normOrder(x));
    return namedIdOk(k, scope) && tokens.has(k);
  }));
}
