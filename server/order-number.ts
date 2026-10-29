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
