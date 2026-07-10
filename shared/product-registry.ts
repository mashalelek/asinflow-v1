// Pure types + lookup helpers for the brand_product_registry.
//
// The registry maps (brand_code, nnn) → ttl. Product identity within a brand
// is this pair. TTL is a property of the product (stable across all ASINs of
// that product), NOT of the listing.
//
// Schema authority: database/migrations/015_brand_product_registry.sql
//
// Key constraint repeated here so future readers don't have to chase the SQL:
//   - UNIQUE (brand_code, nnn) — NOT (brand, dept, nnn). NNN is unique per BRAND.
//   - dept_code on a row is informational only. The same product (same NNN +
//     TTL) can appear under different Amazon depts across ASINs because each
//     listing carries its own dept from Amazon's catalog. The registry's
//     stored dept is just "what dept the FIRST registering ASIN had."
//
// This module is pure: no DB access, no I/O. DB read/write lives in
// server/product-registry-repo.ts (forthcoming).

// ============================================================================
// Row shape
// ============================================================================

/**
 * One product in a brand's registry. Stable identity = (brandCode, nnn).
 * ttl is the canonical product code used in every SKU under this NNN.
 */
export interface ProductRegistryRow {
  brandCode: string;     // 3-char [A-Z]
  nnn: number;           // 1..999
  ttl: string;           // 3-char [A-Z]
  deptCode: string;      // 3-char [A-Z] — informational, dept of the FIRST registering ASIN
  productName: string | null; // ASIN title at registration time, for inspection
  firstAsin: string | null;   // first ASIN that registered this product
  registeredAt: Date;
}

// ============================================================================
// Lookup result for "operator typed an NNN — what's there?"
// ============================================================================

/**
 * Three-way result for a per-brand NNN lookup. Drives the UI's TTL display
 * lock/unlock behavior in the preview editor:
 *   - existing → TTL display locked to row.ttl (same-product-different-ASIN reuse)
 *   - available → TTL display editable (new product; operator picks TTL,
 *                 starting from the derived-from-product-name default)
 *   - invalid → operator typed something outside 1..999
 */
export type NnnLookupResult =
  | { kind: "existing"; row: ProductRegistryRow }
  | { kind: "available"; nnn: number }
  | { kind: "invalid"; reason: string };

/**
 * Pure lookup: given a brand's full registry and a typed NNN value (string
 * from the UI input), return the three-way classification. Caller provides
 * the registry list — this function does NOT do I/O.
 *
 * String input parsing is intentionally lenient (accepts "1", "01", "001",
 * "  5  ") so the operator's intent is captured early; canonical formatting
 * (zero-padding to 3 digits) happens at SKU assembly time.
 */
export function lookupNnnInBrand(
  rawNnn: string,
  brandRegistry: ProductRegistryRow[],
): NnnLookupResult {
  const trimmed = rawNnn.trim();
  if (!/^\d{1,3}$/.test(trimmed)) {
    return { kind: "invalid", reason: "NNN must be 1–3 digits (no other characters)" };
  }
  const n = parseInt(trimmed, 10);
  if (n < 1 || n > 999) {
    return { kind: "invalid", reason: "NNN must be between 001 and 999" };
  }
  const existing = brandRegistry.find((r) => r.nnn === n);
  if (existing) return { kind: "existing", row: existing };
  return { kind: "available", nnn: n };
}

// ============================================================================
// Validation for submit-time (server-side)
// ============================================================================

/**
 * What an operator's submitted (brand, nnn, ttl) means under the registry.
 *   - reuse_ok: NNN exists in registry AND submitted TTL matches → same-product-different-ASIN
 *   - ttl_mismatch: NNN exists but submitted TTL differs → REJECT (operator
 *                   tried to rename an existing product's TTL via a new ASIN)
 *   - new_registration: NNN is free → accept and write a new registry row on
 *                       successful PUT
 */
export type RegistryValidationResult =
  | { kind: "reuse_ok"; existing: ProductRegistryRow }
  | { kind: "ttl_mismatch"; existing: ProductRegistryRow; submittedTtl: string; details: string }
  | { kind: "new_registration"; nnn: number; ttl: string };

/**
 * Validate a submitted (brandCode, nnn, ttl) triple against the registry.
 * Pure — caller pre-loads the relevant brand's registry rows. This is the
 * authoritative server-side check that runs immediately before the PUT.
 *
 * Dept is NOT a parameter and NOT validated here. The same product can
 * legitimately appear under different depts across ASINs (Amazon
 * categorization varies per listing). The SKU's DEP segment comes from the
 * per-ASIN catalog resolution upstream, not from this function.
 */
export function validateRegistryUse(
  brandCode: string,
  nnn: number,
  ttl: string,
  brandRegistry: ProductRegistryRow[],
): RegistryValidationResult {
  const existing = brandRegistry.find((r) => r.brandCode === brandCode && r.nnn === nnn);
  if (!existing) {
    return { kind: "new_registration", nnn, ttl };
  }
  if (existing.ttl === ttl) {
    return { kind: "reuse_ok", existing };
  }
  return {
    kind: "ttl_mismatch",
    existing,
    submittedTtl: ttl,
    details: `NNN ${nnn} in brand ${brandCode} is bound to TTL '${existing.ttl}' (${existing.productName ?? "unnamed product"}); submitted SKU uses '${ttl}'. The product's TTL is fixed by the first ASIN that registered it.`,
  };
}
