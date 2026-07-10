// FBA hazmat detection via getItemEligibilityPreview (program=INBOUND).
//
// Replaces the removed getCommingleHazmat (program=COMMINGLING, code
// FBA_INB_0096). 0096 meant "ineligible for commingling" — NOT hazmat — and
// fires broadly now that commingling is discontinued. INBOUND + the exact code
// FBA_INB_0015 is the corrected source (see server/hazmat-classify.ts).
//
// Lives in its own module (NOT spapi.ts) so it can import spApiGet from
// spapi-auth without transitively pulling in server/index.ts (Express boot),
// and so it's unit-testable with an injected httpGet — same pattern as
// sku-catalog-fetch.ts.

import { spApiGet as realSpApiGet } from "./spapi-auth";
import { type HttpGetFn } from "./sku-catalog-fetch";
import { isHazmatFromInboundCodes } from "./hazmat-classify";

const MARKETPLACE = "ATVPDKIKX0DER";

export interface InboundHazmatRetry {
  maxAttempts: number;
  initialBackoffMs: number;
}
// The itemPreview endpoint is heavily rate-limited (~1 rps, low burst). A couple
// of short backoff retries on QuotaExceeded; beyond that we give up and return
// null so the paced backfill fills the gap.
const DEFAULT_RETRY: InboundHazmatRetry = { maxAttempts: 3, initialBackoffMs: 1200 };

/**
 * Detects FBA hazmat via getItemEligibilityPreview (program=INBOUND).
 *
 * Returns:
 *   true  — INBOUND ineligibility list contains a hazmat code (FBA_INB_0015).
 *   false — conclusive response WITHOUT a hazmat code (incl. eligible, or
 *           ineligible for a NON-hazmat reason like 0014/0004/0050).
 *   null  — INCONCLUSIVE (throttle/QuotaExceeded, network/API error). Callers
 *           MUST treat null as "unknown" and NEVER overwrite the stored value
 *           — a transient throttle must never write false. (COALESCE contract.)
 *
 * httpGet + retry are injected so tests can stub without network and with fast
 * backoff.
 */
export async function getInboundHazmat(
  asin: string,
  httpGet: HttpGetFn = realSpApiGet,
  retry: InboundHazmatRetry = DEFAULT_RETRY,
): Promise<boolean | null> {
  let delay = retry.initialBackoffMs;
  for (let attempt = 0; attempt < retry.maxAttempts; attempt++) {
    try {
      const data = await httpGet("/fba/inbound/v1/eligibility/itemPreview", {
        asin,
        program: "INBOUND",
        marketplaceIds: MARKETPLACE,
      });
      const reasons: any[] = data?.payload?.ineligibilityReasonList ?? [];
      const codes = reasons
        .map((r) => (typeof r === "string" ? r : r?.code))
        .filter(Boolean);
      // Exact-code match, NOT isEligibleForProgram — see hazmat-classify.ts.
      return isHazmatFromInboundCodes(codes);
    } catch (err: any) {
      const code = err?.response?.data?.errors?.[0]?.code;
      if (code === "QuotaExceeded" && attempt < retry.maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
        continue;
      }
      // Any non-throttle error, or throttle after exhausting retries →
      // inconclusive. Fail-closed: null, NEVER false.
      return null;
    }
  }
  return null;
}
