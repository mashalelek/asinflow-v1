// Gating probe — the ONE writer of eligibility_status / gating_checked_at.
//
// Used by component 8 of the Refresh job (daily block) and, inline, by the
// Add to SC preview for its selection (decision 9, confirmed by the
// 2026-10-16 test: putListingsItem ACCEPTS a brand-gated ASIN and creates a
// SKU, so the Listings Restrictions check is the only thing that says no).
// Same code, same writes, same rate limiter (getEligibility → spApiGet) in
// both places; the preview just runs it without a jobs row.
//
// CALL-4 Listings Restrictions per ASIN. Only restrictions[].length is kept:
// empty → yes, otherwise → no. A failed probe writes nothing and moves no
// stamp (the stored answer stands). gated↔ungated flips feed the completion
// notification (decision 16).
import { getEligibility as realGetEligibility } from "./spapi";
import type { QueryLike, Flip } from "./scheduler/types";

export interface GatingProbeCounts { updated: number; yes: number; no: number; flips: number; error: number; missing_row: number }
export interface GatingProbeResult {
  counts: GatingProbeCounts;
  /** Per-ASIN: "flip: yes -> no", "error: <msg>", "error: no asin_estimates row"; successful non-flips are not listed. */
  outcomes: Record<string, string>;
  flips: Flip[];
  /** The status now stored for each ASIN probed successfully this run. */
  statuses: Record<string, "yes" | "no">;
}

export interface GatingProbeDeps {
  query: QueryLike;
  probe?: typeof realGetEligibility;
  /**
   * Iteration strategy. Default: sequential. Component 8 passes the
   * runner's forEachAsin so progress checkpoints and cancel keep working.
   */
  forEach?: (asins: string[], fn: (asin: string) => Promise<void>) => Promise<void>;
}

export async function probeGatingForAsins(asins: string[], deps: GatingProbeDeps): Promise<GatingProbeResult> {
  const probe = deps.probe ?? realGetEligibility;
  const forEach = deps.forEach ?? (async (list, fn) => { for (const a of list) await fn(a); });
  const prior = new Map<string, string | null>(
    asins.length === 0 ? [] :
    (await deps.query(`SELECT asin, eligibility_status FROM asin_estimates WHERE asin = ANY($1::text[])`, [asins]))
      .rows.map((r: any) => [String(r.asin), r.eligibility_status]),
  );
  const counts: GatingProbeCounts = { updated: 0, yes: 0, no: 0, flips: 0, error: 0, missing_row: 0 };
  const outcomes: Record<string, string> = {};
  const flips: Flip[] = [];
  const statuses: Record<string, "yes" | "no"> = {};
  await forEach(asins, async (asin) => {
    const p = await probe(asin);
    if (p.kind !== "ok") { counts.error++; outcomes[asin] = `error: ${p.message}`; return; }
    const r = await deps.query(`UPDATE asin_estimates SET eligibility_status = $2 WHERE asin = $1`, [asin, p.status]);
    if ((r.rowCount ?? 0) === 0) { counts.missing_row++; outcomes[asin] = "error: no asin_estimates row"; return; }
    await deps.query(`UPDATE asins SET gating_checked_at = NOW() WHERE asin = $1`, [asin]);
    counts.updated++;
    statuses[asin] = p.status;
    if (p.status === "yes") counts.yes++; else counts.no++;
    const was = prior.get(asin) ?? null;
    if (was != null && was !== "check" && was !== p.status) {
      counts.flips++;
      outcomes[asin] = `flip: ${was} -> ${p.status}`;
      flips.push({ asin, field: "gating", from: was === "yes" ? "ungated" : "gated", to: p.status === "yes" ? "ungated" : "gated" });
    }
  });
  return { counts, outcomes, flips, statuses };
}
