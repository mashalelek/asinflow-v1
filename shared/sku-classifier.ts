// Pure format check for AsinFlow's canonical SKU format.
// Persists nothing. Used by the resurrection logic at offer-add time:
// if no asin_skus SKU for this ASIN matches this format, generate a new one.
// Non-conforming SKUs (legacy, Amazon-generated, all-digit, etc.) just don't
// match — no allowlist, no special-case buckets.
//
// Canonical format: BRD(3)-DEP(3)-AS3(3 alphanumeric)-TTL(3)-NNN[-X]
// Prefix-only check: the first 4 segments are the discriminator that
// distinguishes our format from legacy AMG (2-char dept) and Amazon-random
// patterns (e.g. XX-XXXX-XXXX, amzn.gr.*).
const CURRENT_FORMAT_PREFIX = /^[A-Z]{3}-[A-Z]{3}-[A-Z0-9]{3}-[A-Z]{3}-/;

export function matchesCurrentSkuFormat(sku: string): boolean {
  return CURRENT_FORMAT_PREFIX.test(sku);
}
