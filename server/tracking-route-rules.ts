// Routing rules for a matched tracking row (SPEC §26; patch
// po-tracking-velocity §7). Pure — evaluated on every run and every new row,
// by the push component (it is the one that knows Velocity's Inbound state).
//
// "PO in Velocity" (Maria 2026-10-21, stop b): the PO appears ANYWHERE in
// Velocity — inbound, inventory or shipments. Pushing still targets only
// inbound pending / partially_received orders, so the PO is one of:
//   inbound — pushable (the table's "yes" rows);
//   known   — Velocity already received / shipped it: no push, no warning
//             (the push window has passed; this is not a missed upload);
//   absent  — Velocity has never seen it (the table's "no" rows).
// | PO in Velocity | email ship-to                | ships_to | result                               |
// |----------------|------------------------------|----------|--------------------------------------|
// | yes            | Velocity street              | home     | HELD + review "Home PO in Velocity; address mismatch" |
// | yes            | other                        | home     | review "Home PO in Velocity", no push|
// | yes            | home street                  | velocity | HELD + review "address mismatch"     |
// | yes            | none, or Velocity street     | velocity | push                                 |
// | yes            | unknown street               | velocity | push + review "address mismatch"     |
// The HELD rows (hold rule, Maria 2026-10-29): the email names the OTHER
// known address than ships_to, so the parcel is going somewhere AF does not
// expect — never push it; the tracking stays on the PO (status held) and the
// review reason raises Review Velocity.
// | no             | home street                  | home     | held, no review                      |
// | no             | none                         | home     | held, no review (Maria 2026-10-22)   |
// | no             | none / Velocity street       | velocity | review "not in Velocity"             |
// | no             | Velocity street              | home     | review "not in Velocity"             |
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
  homeInVelocity: "Home PO in Velocity",
  notInVelocity: "not in Velocity",
  unknownAddress: "unknown address",
  canceled: "shipped but canceled",
} as const;

export type VelocityPresence = "inbound" | "known" | "absent";

export function routeTracking(i: {
  velocity: VelocityPresence;
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
  if (i.velocity === "known") return { push: false, held: false, reasons: [] };
  if (i.velocity === "inbound") {
    // A Home PO is never pushed, even when Velocity has an order for it
    // (Maria 2026-10-29): the order there is the mistake — review only.
    if (i.shipsTo === "home") {
      return isVelocity
        ? { push: false, held: true, reasons: [REASON.homeInVelocity, REASON.addressMismatch] }
        : { push: false, held: false, reasons: [REASON.homeInVelocity] };
    }
    // Hold rule: a Velocity PO whose email names the home street.
    if (isHome) return { push: false, held: true, reasons: [REASON.addressMismatch] };
    return { push: true, held: false, reasons: unknown ? [REASON.addressMismatch] : [] };
  }
  // A home PO whose email names the home street — or no street at all (USPS
  // emails often carry none) — is going where AF expects: held, no review.
  if ((isHome || street == null) && i.shipsTo === "home") return { push: false, held: true, reasons: [] };
  const reasons: string[] = [];
  if (street == null || isVelocity || i.shipsTo === "velocity") reasons.push(REASON.notInVelocity);
  if (unknown) reasons.push(REASON.unknownAddress);
  return { push: false, held: false, reasons };
}

export const joinReasons = (r: readonly string[]): string | null => (r.length ? Array.from(new Set(r)).join("; ") : null);
