// Pure SKU assembler for AsinFlow's canonical format.
// Format: BRD-DEP-AS3-TTL-NNN[-X]
//
//   BRD  3 alpha — brand code, resolved from legend by caller
//   DEP  3 alpha — department code, resolved from legend
//   AS3  3 alphanumeric — last 3 chars of the ASIN, MANDATORY (derived here)
//   TTL  3 alpha — title code, derived deterministically from product title
//   NNN  3-digit zero-padded product number (1-999)
//   X    optional variant suffix (single A-Z) for duplicate offer on same ASIN
//
// SUB segment was removed per Option 3 after the full-catalog scan showed
// sub-categories follow a long-tail distribution (755 distinct, 390 needed
// for 80% coverage) — not a viable grouping scheme.
//
// No DB access. Legend lookup is the caller's job (resurrection wiring).

const MAX_SKU_LENGTH = 40;

// Stopwords stripped before TTL derivation. Function words + pack/size noise
// that doesn't describe the product. Keep small and obvious; collisions are
// acceptable (NNN disambiguates).
const TTL_STOPWORDS = new Set([
  // grammar / connectives
  "a", "an", "the", "and", "or", "for", "with", "of", "to", "in", "on", "at",
  "by", "from", "as", "is", "it", "be", "this", "that",
  // pack/size noise
  "new", "pack", "set", "bundle", "size", "count", "ct", "pcs", "piece",
  "pieces", "oz", "ounce", "ounces", "ml", "lb", "lbs", "fl",
]);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// TTL derivation: deterministic from (title, brandName).
//
// Algorithm:
//   1. Lowercase title.
//   2. Strip the brand string (whole-word, case-insensitive) — TTL should
//      describe the product, not repeat the brand which is already in BRD.
//   3. Strip non-alphanumeric to whitespace.
//   4. Tokenize; drop stopwords, tokens of length 1, and tokens that don't
//      start with a letter. The letter-start filter drops model-number noise
//      like "790psc10" / "25micron" / "120" that doesn't describe the product.
//   5. Combine:
//      - ≥3 significant words → first letter of each of the first 3
//      - 2 words              → first letter of word 1 + first 2 letters of word 2
//      - 1 word               → first 3 letters of that word (padded with X)
//      - 0 words              → "XXX"
//   6. Uppercase, pad/truncate to exactly 3 chars.
//
// Collisions ARE allowed — TTL is a hint, NNN is the unique key within a
// (brand, dept) bucket.
export function deriveTtl(title: string, brandName: string): string {
  let t = (title ?? "").toLowerCase();

  const brandWords = (brandName ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  for (const bw of brandWords) {
    t = t.replace(new RegExp(`\\b${escapeRegex(bw)}\\b`, "g"), " ");
  }

  t = t.replace(/[^a-z0-9 ]/g, " ");

  const words = t
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .filter((w) => !TTL_STOPWORDS.has(w))
    .filter((w) => /^[a-z]/.test(w))
    .filter((w) => w.length >= 2);

  let ttl: string;
  if (words.length >= 3) {
    ttl = words[0][0] + words[1][0] + words[2][0];
  } else if (words.length === 2) {
    ttl = words[0][0] + words[1].slice(0, 2);
  } else if (words.length === 1) {
    ttl = words[0].slice(0, 3);
  } else {
    ttl = "XXX";
  }
  return ttl.toUpperCase().padEnd(3, "X").slice(0, 3);
}

export interface SkuParts {
  brd: string;
  dep: string;
  asin: string;            // full 10-char ASIN; AS3 derived from .slice(-3)
  ttl: string;             // already-derived (call deriveTtl first)
  nnn: number;             // 1-999
  variantSuffix?: string;  // single A-Z, only for duplicate offer on same ASIN
}

function validate3Alpha(s: string, name: string): void {
  if (!/^[A-Z]{3}$/.test(s)) {
    throw new Error(`${name} must be 3 uppercase alpha chars, got ${JSON.stringify(s)}`);
  }
}
function validate3AlphaNum(s: string, name: string): void {
  if (!/^[A-Z0-9]{3}$/.test(s)) {
    throw new Error(`${name} must be 3 uppercase alphanumeric chars, got ${JSON.stringify(s)}`);
  }
}

export function buildSku(p: SkuParts): string {
  validate3Alpha(p.brd, "brd");
  validate3Alpha(p.dep, "dep");
  validate3Alpha(p.ttl, "ttl");
  if (!/^[A-Z0-9]{10}$/.test(p.asin)) {
    throw new Error(`asin must be 10 uppercase alphanumeric chars, got ${JSON.stringify(p.asin)}`);
  }
  validate3AlphaNum(p.asin.slice(-3), "as3 (derived)");
  if (!Number.isInteger(p.nnn) || p.nnn < 1 || p.nnn > 999) {
    throw new Error(`nnn must be integer 1-999, got ${p.nnn}`);
  }
  if (p.variantSuffix != null && !/^[A-Z]$/.test(p.variantSuffix)) {
    throw new Error(`variantSuffix must be a single A-Z letter, got ${JSON.stringify(p.variantSuffix)}`);
  }
  const as3 = p.asin.slice(-3);
  const nnn = String(p.nnn).padStart(3, "0");
  const tail = p.variantSuffix ? `-${p.variantSuffix}` : "";
  const sku = `${p.brd}-${p.dep}-${as3}-${p.ttl}-${nnn}${tail}`;
  if (sku.length > MAX_SKU_LENGTH) {
    throw new Error(`SKU exceeds ${MAX_SKU_LENGTH} chars: ${sku} (${sku.length})`);
  }
  return sku;
}

export interface GenerateSkuInput {
  asin: string;
  brand: string;            // raw, for stopword stripping in deriveTtl
  title: string;            // raw, for TTL derivation
  brandCode: string;        // BRD — pre-resolved from legend
  departmentCode: string;   // DEP — pre-resolved from legend
  productNumber: number;
  variantSuffix?: string;
}

export function generateSku(input: GenerateSkuInput): string {
  const ttl = deriveTtl(input.title, input.brand);
  return buildSku({
    brd: input.brandCode.toUpperCase(),
    dep: input.departmentCode.toUpperCase(),
    asin: input.asin.toUpperCase(),
    ttl,
    nnn: input.productNumber,
    variantSuffix: input.variantSuffix?.toUpperCase(),
  });
}
