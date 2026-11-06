// The FBA fee cell's hover lines (Maria 2026-11-06, SPEC §11 component 13). Pure.
//   - a fallback (weight-estimated) fee is provisional; with the catalog-dimensions error it says so by name;
//   - a fee estimated at a non-FBA price;
//   - Amazon's fee promotion: the fee shown is the one BEFORE it — "FBA fee waived by promotion ($X)";
//   - a fee whose last fetch failed is the last good one, stale since its date — never blanked or estimated over.
import type { AsinResult } from "@shared/schema";

export interface FeeNotes { lines: string[]; warn: boolean; kind: "fallback" | "nonfba" | "stale" | "promotion" | null }

const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric", timeZone: "America/New_York" }) : null);
const money = (x: number) => `$${x.toFixed(2)}`;

export function feeNotes(r: Pick<AsinResult, "feeSource" | "fbaFeePromotion" | "feeFetchedAt" | "feeError" | "feeErrorAt" | "feesData" | "pricingData">): FeeNotes {
  const lines: string[] = [];
  let kind: FeeNotes["kind"] = null;
  const fee = r.feesData.fbaFulfillmentFee;
  const failing = !!r.feeError && (!r.feeFetchedAt || !r.feeErrorAt || r.feeErrorAt > r.feeFetchedAt);
  if (r.feeSource === "fallback") {
    kind = "fallback";
    lines.push(/catalog lacks package dimensions/i.test(r.feeError ?? "")
      ? "Estimated from weight — no FBA estimate from Amazon: the catalog lacks package dimensions/weight"
      : "Estimated from weight — SP-API fee fetch failed; will retry on next analyze");
  } else if (fee != null && r.pricingData.lowestFbaPrice == null && (r.pricingData.buyBoxPrice != null || r.pricingData.lowestPrice != null)) {
    kind = "nonfba";
    lines.push("Fee estimated at the buy-box/lowest price — no FBA offer exists");
  }
  if (r.fbaFeePromotion != null && r.fbaFeePromotion > 0 && r.feeSource !== "fallback") {
    kind ??= "promotion";
    const waived = fee != null && r.fbaFeePromotion >= fee - 0.005;
    lines.push(`FBA fee ${waived ? "waived" : "reduced"} by promotion (${money(r.fbaFeePromotion)}) — the fee shown is before it`);
  }
  if (failing && r.feeSource !== "fallback" && fee != null) {
    kind = kind === "promotion" || kind == null ? "stale" : kind;
    lines.push(`Stale — last good fee ${day(r.feeFetchedAt) ? `from ${day(r.feeFetchedAt)}` : "from before 11/6/2026"}; the fetch on ${day(r.feeErrorAt) ?? "?"} failed: ${r.feeError}`);
  }
  return { lines, warn: kind === "fallback" || kind === "nonfba" || kind === "stale", kind };
}
