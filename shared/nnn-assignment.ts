// NNN (product number) assignment for new SKU generation.
//
// Rules (per Maria's spec):
//   1. NNN unique per (BRD, DEP) bucket, sequential, monotonic-increase only.
//   2. Never reuse a retired number — naturally satisfied by scanning
//      asin_skus (which retains every SKU ever observed; deleted SKUs still
//      contribute to the max).
//   3. No gap-filling — middle numbers freed by retired SKUs stay vacant.
//      Always max+1, never the lowest unused.
//   4. Batch sequencing — within a single Add-to-SC batch, multiple ASINs in
//      the same (BRD,DEP) get sequential numbers (max+1, max+2, max+3…),
//      NOT all independently compute max+1 and collide.
//   5. NNN is 3 digits (1-999). 999 → overflow error (don't silently wrap
//      or 4-digit). Per-ASIN error; other buckets in the same batch still
//      get assigned.
//
// Discriminator: NNNs are parsed ONLY from SKUs that match the current
// canonical format (matchesCurrentSkuFormat). Legacy AMG, Amazon-random,
// all-digit, PFL_* prep-center SKUs etc. are ignored entirely — same
// discriminator the resurrection orchestrator uses.

import { matchesCurrentSkuFormat } from "./sku-classifier";

// Bucket key = "BRD-DEP" → set of NNN numbers already used in that bucket.
export type ExistingNnns = Map<string, Set<number>>;

export interface NnnAssignmentRequest {
  asin: string;        // for error reporting and order correlation
  brandCode: string;   // resolved BRD (uppercase, 3 chars)
  deptCode: string;    // resolved DEP (uppercase, 3 chars)
}

export type NnnAssignmentOutcome =
  | { kind: "assigned"; asin: string; brandCode: string; deptCode: string; nnn: number }
  | { kind: "overflow"; asin: string; brandCode: string; deptCode: string; bucket: string; detail: string };

const NNN_MAX = 999;

// Parse a conforming current-format SKU and extract (BRD, DEP, NNN).
// Returns null for non-conforming SKUs — caller filters with this.
export function parseConformingSku(sku: string): { brd: string; dep: string; nnn: number } | null {
  if (!matchesCurrentSkuFormat(sku)) return null;
  const parts = sku.split("-");
  // Current format: BRD-DEP-AS3-TTL-NNN[-X]
  // matchesCurrentSkuFormat validates the 4-segment prefix; we need at least 5 segments to have NNN.
  if (parts.length < 5) return null;
  const nnn = parseInt(parts[4], 10);
  if (isNaN(nnn) || nnn < 1 || nnn > NNN_MAX) return null;
  return { brd: parts[0], dep: parts[1], nnn };
}

// Convenience: scan a list of raw SKUs and build the ExistingNnns map.
// Non-conforming SKUs are silently filtered (intentional — same discriminator
// as resurrection; we never count non-current-format NNNs).
export function buildExistingNnnsFromSkus(skus: string[]): ExistingNnns {
  const out: ExistingNnns = new Map();
  for (const sku of skus) {
    const parsed = parseConformingSku(sku);
    if (!parsed) continue;
    const key = bucketKey(parsed.brd, parsed.dep);
    let set = out.get(key);
    if (!set) {
      set = new Set();
      out.set(key, set);
    }
    set.add(parsed.nnn);
  }
  return out;
}

function bucketKey(brd: string, dep: string): string {
  return `${brd}-${dep}`;
}

/**
 * Assign NNNs to a batch of requests. Pure function — no DB, no I/O.
 *
 * Output order matches input order (one outcome per request, in the same
 * position). Errors come back as outcomes too (kind: "overflow") rather than
 * a separate errors array — uniform with the rest of the codebase's outcome
 * patterns.
 *
 * Batch sequencing: a cursor per bucket tracks the highest-allocated NNN
 * (initial from `existing`, then increments as we assign within this batch).
 * Multiple requests in the same bucket get sequential numbers without
 * re-reading existing — they share the cursor.
 *
 * Overflow: when cursor + 1 > 999, that specific request errors. The cursor
 * does NOT advance (so subsequent requests in the same overflowing bucket
 * all error too — there's no number left). Other buckets are unaffected.
 */
export function assignNnns(
  requests: NnnAssignmentRequest[],
  existing: ExistingNnns,
): NnnAssignmentOutcome[] {
  // Initialize cursor per bucket from existing max (deleted SKUs in
  // `existing` naturally contribute — that's how retired numbers stay
  // reserved and gaps stay un-filled).
  const cursor = new Map<string, number>();
  for (const [key, set] of Array.from(existing.entries())) {
    let max = 0;
    for (const n of Array.from(set)) if (n > max) max = n;
    cursor.set(key, max);
  }

  const out: NnnAssignmentOutcome[] = [];
  for (const req of requests) {
    const key = bucketKey(req.brandCode, req.deptCode);
    const current = cursor.get(key) ?? 0;
    const next = current + 1;
    if (next > NNN_MAX) {
      out.push({
        kind: "overflow",
        asin: req.asin,
        brandCode: req.brandCode,
        deptCode: req.deptCode,
        bucket: key,
        detail: `NNN bucket ${key} at maximum ${NNN_MAX}; cannot assign next number`,
      });
      // Don't advance cursor — subsequent requests in this bucket also overflow,
      // which is the correct signal: the bucket is genuinely exhausted.
      continue;
    }
    out.push({
      kind: "assigned",
      asin: req.asin,
      brandCode: req.brandCode,
      deptCode: req.deptCode,
      nnn: next,
    });
    cursor.set(key, next);
  }

  return out;
}
