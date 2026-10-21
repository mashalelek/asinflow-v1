// Routing rules for a matched tracking row (SPEC §26; patch
// po-tracking-velocity §7). Pure — evaluated on every run and every new row,
// by the push component (it is the one that knows Velocity's Inbound state).
//
// | PO in Velocity | email ship-to                | ships_to | result                               |
// |----------------|------------------------------|----------|--------------------------------------|
// | yes            | none, or agrees with ships_to| —        | push                                 |
// | yes            | disagrees with ships_to      | —        | push + review "address mismatch"     |
// | no             | home street                  | home     | held, no review                      |
// | no             | none / Velocity street       | any      | review "not in Velocity"             |
// | no             | any                          | velocity | review "not in Velocity"             |
// | no             | unknown street               | any      | review "unknown address"             |
// Plus: a PO canceled / returned in AF → review "shipped but canceled" (no push).
// "Unknown" = neither the Velocity street nor a home street. When several
// rows of the table apply (unknown street on a Velocity PO), every reason is
// kept — the action item tooltip lists them.

export type ShipsTo = "velocity" | "home";
export type RouteResult = { push: boolean; held: boolean; reasons: string[] };

export const REASON = {
  addressMismatch: "address mismatch",
  notInVelocity: "not in Velocity",
  unknownAddress: "unknown address",
  canceled: "shipped but canceled",
} as const;

export function routeTracking(i: {
  inVelocity: boolean;
  emailStreet: string | null;
  shipsTo: ShipsTo;
  velocityStreet: string;
  homeStreets: readonly string[];
  poCanceledOrReturned: boolean;
}): RouteResult {
  if (i.poCanceledOrReturned) return { push: false, held: false, reasons: [REASON.canceled] };
  const street = i.emailStreet;
  const isVelocity = street != null && street === i.velocityStreet;
  const isHome = street != null && i.homeStreets.includes(street);
  const unknown = street != null && !isVelocity && !isHome;
  if (i.inVelocity) {
    const agrees = street == null || (i.shipsTo === "velocity" ? isVelocity : isHome);
    return { push: true, held: false, reasons: agrees ? [] : [REASON.addressMismatch] };
  }
  if (isHome && i.shipsTo === "home") return { push: false, held: true, reasons: [] };
  const reasons: string[] = [];
  if (street == null || isVelocity || i.shipsTo === "velocity") reasons.push(REASON.notInVelocity);
  if (unknown) reasons.push(REASON.unknownAddress);
  return { push: false, held: false, reasons };
}

export const joinReasons = (r: readonly string[]): string | null => (r.length ? Array.from(new Set(r)).join("; ") : null);
