// Pure classifiers for the two INDEPENDENT hazard flags. Deliberately kept
// free of any SP-API / Express imports (no ./index, no network) so they are
// unit-testable in isolation and safe to import anywhere — mirrors the
// spapi-auth / sku-catalog-fetch split.
//
// The two flags answer DIFFERENT questions and come from DIFFERENT sources:
//   is_dangerous_good — transport classification (getCatalogItem attributes)
//   is_hazmat         — FBA hazmat storage/handling program (INBOUND eligibility)

// ── is_hazmat ────────────────────────────────────────────────────────────────
//
// FBA hazmat signal = an INBOUND getItemEligibilityPreview ineligibility code
// in this EXACT set. See Amazon SP-API dev discussion #3554.
//
// EXACT-MATCH SET — NOT a range, NOT isEligibleForProgram=false:
//   • FBA_INB_0015 → FBA-hazmat (observed on both CO2 cylinders, true hazmat).
//
// Why not the #3554 "0007–0016 range": validation disproved it —
//   • FBA_INB_0014 fires on butane (DG-only, Hazmat=No) — a range would false-flag it.
//   • FBA_INB_0050 fires on BOTH CO2 and butane — a separate restriction, not hazmat.
//   • isEligibleForProgram=false alone is triggered by 0050 too → over-flags.
// Matching a code SET (not eligibility, not a range) is what keeps DG-only clean.
// This is the same over-flag shape as the removed COMMINGLING/0096 bug — do not
// reintroduce it by widening to the range.
//
// KNOWN LIMITATION (documented in migration 016 + docs/SPEC.md): 0015 is proven
// ONLY for compressed-gas hazmat (CO2). Other hazmat classes (corrosive,
// oxidizer, flammable solid, …) are UNANCHORED and will read false until
// validated. The set is intentionally widenable: read a misclassified item's
// INBOUND ineligibilityReasonList via script/diag-inbound-eligibility-*.ts and
// add the confirmed code here.
export const HAZMAT_INBOUND_CODES: ReadonlySet<string> = new Set(["FBA_INB_0015"]);

/** True iff any INBOUND ineligibility code is in the hazmat set. */
export function isHazmatFromInboundCodes(codes: readonly string[]): boolean {
  return codes.some((c) => HAZMAT_INBOUND_CODES.has(c));
}

// ── is_dangerous_good ─────────────────────────────────────────────────────────
//
// DG = getCatalogItem attributes.hazmat array present/non-empty. PRESENCE, not
// value validation: butane (B08MWQ7ZNT) ships a hazmat row with class "0" and
// no UN#, yet is a dangerous good. Any non-empty hazmat array = DG.
export function isDangerousGoodFromAttributes(attrs: any): boolean {
  return Array.isArray(attrs?.hazmat) && attrs.hazmat.length > 0;
}
