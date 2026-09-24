// SKU resolution + generation orchestrator.
//   1. Live catalog fetch (brand + category from classifications top-level).
//   2. Self-heal: COALESCE-write the catalog-derived fields back to `asins`
//      (catalog data ownership per SPEC §14). Only writes when values are
//      non-null AND different from stored.
//   3. Legend resolve: brand → BRD, category → DEP. Surfaces approval gate
//      via 'legend_pending' if either is not-approved.
//   4. Pure generateSku with the resolved codes.
//
// Returns a typed outcome so the offer-add preview can render per-ASIN status.

import { fetchCatalogForSku, type CatalogFetchOutcome, type HttpGetFn } from "./sku-catalog-fetch";
import { resolveLegend, NO_BRAND_CODE, type QueryFn } from "@shared/sku-legend";
import { generateSku } from "@shared/sku-generator";

export interface ResolutionTrail {
  brd: string;
  dep: string;
  ttl: string;
  category: string;
  brand: string;
  // First-ASIN product name (from the catalog's itemName), captured so the
  // registry's reserve() can record what product this NNN actually is.
  // Nullable because catalog occasionally lacks itemName (rare; defensive).
  itemName: string | null;
  // DG live-derived from the same catalog fetch — threaded to the offer-add
  // payload gate so it never reads the stored column.
  isDangerousGood: boolean;
  // Catalog's own supplier_declared_dg_hz_regulation (US), or null. Passed
  // through verbatim (when enum-valid) as the offer's DG declaration value.
  dgHzRegulation: string | null;
}

export type ResolveSkuOutcome =
  | { ok: true; sku: string; trail: ResolutionTrail }
  | {
      ok: false;
      reason:
        | "dead_asin"
        | "no_brand"
        | "no_category"
        | "transient_error"
        | "legend_pending";
      details: string;
      // For legend_pending — caller surfaces these for human approval
      pending?: {
        // A brandless ASIN never appears here (§18, 2026-09-24): it resolves
        // to NUL automatically. A brand row means a REAL brand name that the
        // legend hasn't approved yet — so rawValue is always non-empty.
        brand?: { rawValue: string; proposedCode: string; status: "proposed" | "not_in_legend" };
        dept?: { rawValue: string; proposedCode: string; status: "proposed" | "not_in_legend" };
      };
    };

export interface ResolveSkuDeps {
  httpGet?: HttpGetFn;            // SP-API GET — default real
  queryFn: QueryFn;               // DB query — required (no sane default for a server module)
  selfHealWrite?: (catalog: { asin: string; category: string; brand: string; itemName: string | null; imageUrl: string | null }) => Promise<void>;
}

export async function resolveAndGenerateSku(
  asin: string,
  productNumber: number,
  deps: ResolveSkuDeps,
  variantSuffix?: string,
): Promise<ResolveSkuOutcome> {
  const fetched: CatalogFetchOutcome = await fetchCatalogForSku(asin, deps.httpGet);

  if (!fetched.ok) {
    switch (fetched.reason) {
      case "dead_asin":
        return { ok: false, reason: "dead_asin", details: `getCatalogItem returned 404 for ${asin}` };
      case "no_brand":
        break; // §18 brandless → BRD = NUL below. Not an error, not pending.
      case "no_category":
        return { ok: false, reason: "no_category", details: `classifications block empty for ${asin}` };
      case "transient_error":
        return { ok: false, reason: "transient_error", details: `${fetched.status ?? "?"}: ${fetched.message}` };
    }
  }

  const { category, brand, itemName, imageUrl, isDangerousGood, dgHzRegulation } = fetched.data;

  // §18 brandless ASIN (2026-09-24, replaces the 2026-08-29 manual-code flow):
  // brand absent/null/empty/whitespace in the catalog → BRD = NUL, decided
  // here, automatically. No approval step, no legend lookup, and critically NO
  // pending.brand — there is no raw value, so there is nothing a human could
  // approve. `brand` is already trimmed-to-null at the fetch boundary
  // (sku-catalog-fetch), so null here means genuinely brandless.
  //
  // The old flow surfaced an approval row with an empty raw value; approving
  // it wrote a sku_legend row keyed on "" that then captured every later
  // brandless ASIN. NUL is reserved (shared/sku-legend) precisely so the
  // legend never has to represent "no brand" as a value.
  const brandless = brand == null;

  // Self-heal first — succeed-and-write even if legend lookup later returns pending,
  // so the data is fresh for the next attempt. Skipped when the catalog has no
  // brand: NUL is a code, never a brand name, and must never reach asins.brand
  // (§14 — catalog stays the only source for catalog fields).
  if (deps.selfHealWrite && brand != null) {
    await deps.selfHealWrite({ asin, category: category!, brand: brand!, itemName, imageUrl });
  }

  const [brandRes, deptRes] = await Promise.all([
    brandless
      ? Promise.resolve({ status: "approved", code: NO_BRAND_CODE, derivedProposal: null } as any)
      : resolveLegend("brand", brand!, deps.queryFn),
    resolveLegend("dept", category!, deps.queryFn),
  ]);

  if (brandRes.status !== "approved" || deptRes.status !== "approved") {
    return {
      ok: false,
      reason: "legend_pending",
      details: `awaiting legend approval: brand=${brandRes.status}, dept=${deptRes.status}`,
      pending: {
        ...(brandRes.status !== "approved" && {
          brand: {
            rawValue: brand!,
            proposedCode: brandRes.derivedProposal ?? brandRes.code ?? "?",
            status: brandRes.status,
          },
        }),
        ...(deptRes.status !== "approved" && {
          dept: {
            rawValue: category!,
            proposedCode: deptRes.derivedProposal ?? deptRes.code ?? "?",
            status: deptRes.status,
          },
        }),
      },
    };
  }

  // Pure assembly
  const sku = generateSku({
    asin,
    brand: brand ?? "",
    title: itemName ?? "",
    brandCode: brandRes.code!,
    departmentCode: deptRes.code!,
    productNumber,
    variantSuffix,
  });

  return {
    ok: true,
    sku,
    trail: {
      brd: brandRes.code!,
      dep: deptRes.code!,
      ttl: sku.split("-")[3], // TTL is the 4th segment (index 3)
      category: category!,
      // Brandless ASIN: no catalog brand exists, so the brand NAME is empty
      // (never "NUL" — that is a BRD code, not a brand name).
      brand: brand ?? "",
      itemName: itemName ?? null,
      isDangerousGood,
      dgHzRegulation,
    },
  };
}
