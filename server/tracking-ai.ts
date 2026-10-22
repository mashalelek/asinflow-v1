// AI fallback for PO tracking (SPEC §26; patch po-tracking-velocity §4 D3,
// commit 9). Status 2026-10-21: NOT BUILT — ANTHROPIC_API_KEY is not
// configured (local or Render), so per the patch the fallback is skipped and
// a shipped-type email the regex and the tracking-link extractors cannot read
// is queued as unmatched with reason "ai_disabled" (tracking-ingest.ts
// placeholders). When a key exists, the fallback is built here: plain text →
// a fixed JSON schema {carrier, tracking_number, retailer_order_id, ship_to,
// items[]}, source 'ai'.
export const AI_DISABLED_REASON = "ai_disabled";

/** True only once the fallback is built AND a key is configured. */
export function aiFallbackAvailable(_env: NodeJS.ProcessEnv = process.env): boolean {
  return false; // not built (no key at the time of commit 9)
}
