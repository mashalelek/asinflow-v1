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
//
// KNOWN OVER-FLAG (see resolveDgHzRegulation below + the deferred DG audit): the
// hazmat array is a UN-transport block that non-DG items ALSO carry (with
// per-country "*_Unregulated" exceptions), so PRESENCE has confirmed false
// positives (B07H3B443Q fuel filter, B001DKV5H8 lubricant — Amazon says NOT DG).
// The offer payload no longer trusts this flag for the declaration value; it
// mirrors the catalog's own supplier_declared_dg_hz_regulation instead.
export function isDangerousGoodFromAttributes(attrs: any): boolean {
  return Array.isArray(attrs?.hazmat) && attrs.hazmat.length > 0;
}

// ── supplier_declared_dg_hz_regulation (offer-add payload value) ──────────────
//
// The DG DECLARATION attribute for putListingsItem. SOURCE = the catalog's own
// attributes.supplier_declared_dg_hz_regulation (Amazon's classification),
// verified against SC dangerous-goods ground truth (not_applicable ⇔ not DG;
// a real regulation value ⇔ genuine DG). NOT the hazmat array (its values are
// never in this enum) and NOT the old `consumer_commodity` constant (enum-
// invalid for every product type). The offer-side value is advisory — Amazon
// classifies from its own catalog data (B00HX6N2WW went live with not_applicable
// despite Amazon holding "storage") — so our value only needs to be enum-valid
// and should truthfully mirror Amazon's.
//
// Enum verified PRODUCT-TYPE-INVARIANT (PRODUCT / FUEL_FILTER / MACHINE_LUBRICANT
// / CALCULATOR / PORTABLE_STOVE all identical) via getDefinitionsProductType.
export const DG_HZ_REGULATION_ENUM: readonly string[] = [
  "ghs", "not_applicable", "other", "storage", "transportation", "unknown", "waste",
];

const MARKETPLACE_US = "ATVPDKIKX0DER";

// Catalog's declared regulation value for the US marketplace, or null if absent.
export function dgHzRegulationFromAttributes(attrs: any): string | null {
  const entries = attrs?.supplier_declared_dg_hz_regulation;
  if (!Array.isArray(entries)) return null;
  const us = entries.find((e: any) => e?.marketplace_id === MARKETPLACE_US);
  const v = us?.value;
  return typeof v === "string" && v.length > 0 ? v : null;
}

export type DgHzResolution = { kind: "value"; value: string } | { kind: "unresolved" };

// Resolve the payload's supplier_declared_dg_hz_regulation. Pure pass-through:
//   - catalog value present AND enum-valid → pass through verbatim, REGARDLESS
//     of the is_dangerous_good flag. Self-healing: the presence-derivation's
//     false positives carry `not_applicable` in the catalog, so they submit
//     correctly even before is_dangerous_good is re-derived.
//   - absent / enum-invalid:
//       isDangerousGood → unresolved (fail-closed; caller excludes for manual
//                         selection — no 'unknown' guess).
//       else            → not_applicable (proven-safe non-DG value).
export function resolveDgHzRegulation(
  catalogValue: string | null,
  isDangerousGood: boolean,
  allowedEnum: readonly string[] = DG_HZ_REGULATION_ENUM,
): DgHzResolution {
  if (catalogValue != null && allowedEnum.includes(catalogValue)) {
    return { kind: "value", value: catalogValue };
  }
  if (isDangerousGood) return { kind: "unresolved" };
  return { kind: "value", value: "not_applicable" };
}
