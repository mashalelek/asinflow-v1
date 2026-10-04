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
import { resolveLegend, NO_VALUE_CODE, type QueryFn } from "@shared/sku-legend";
import { generateSku } from "@shared/sku-generator";

export interface ResolutionTrail {
  brd: string;
  dep: string;
  ttl: string;
  // null when the catalog has no chain for our marketplace (DEP = NUL).
  category: string | null;
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
      case "transient_error":
        return { ok: false, reason: "transient_error", details: `${fetched.status ?? "?"}: ${fetched.message}` };
    }
  }

  const { category, brand, itemName, imageUrl, isDangerousGood, dgHzRegulation } = fetched.data;

  // §18 ABSENT FROM THE CATALOG → NUL, in either position.
  //
  //   brand    absent/null/""/whitespace  → BRD = NUL  (2026-09-24)
  //   category no chain for our marketplace → DEP = NUL  (2026-10-04)
  //
  // Both are decided at the fetch boundary (sku-catalog-fetch trims brand to
  // null and resolves OUR marketplace's chain to null), so null here means
  // genuinely absent on a SUCCESSFUL response — never a fetch failure, which
  // returns dead_asin/transient_error above and never reaches this line.
  //
  // Automatic: no approval step, no legend lookup, and critically NO pending
  // entry — there is no raw value, so there is nothing a human could approve.
  // The retired brand flow surfaced an approval row with an EMPTY raw value;
  // approving it wrote a sku_legend row keyed on "" that then captured every
  // later brandless ASIN. NUL is reserved (shared/sku-legend) precisely so
  // the legend never has to represent "absent" as a value — in either column.
  const brandless = brand == null;
  const categoryless = category == null;

  // Self-heal first — succeed-and-write even if the legend lookup later
  // returns pending, so the data is fresh for the next attempt. It writes
  // only REAL catalog values: NUL is a code, never a brand or category name,
  // and must never reach asins.brand / asins.category (§14 — catalog stays
  // the only source for catalog fields). A categoryless ASIN keeps
  // asins.category NULL; a brandless one keeps asins.brand NULL.
  if (deps.selfHealWrite && brand != null && category != null) {
    await deps.selfHealWrite({ asin, category, brand, itemName, imageUrl });
  }

  const [brandRes, deptRes] = await Promise.all([
    brandless
      ? Promise.resolve({ status: "approved", code: NO_VALUE_CODE, derivedProposal: null } as any)
      : resolveLegend("brand", brand!, deps.queryFn),
    categoryless
      ? Promise.resolve({ status: "approved", code: NO_VALUE_CODE, derivedProposal: null } as any)
      : resolveLegend("dept", category, deps.queryFn),
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
      category,
      // Brandless ASIN: no catalog brand exists, so the brand NAME is empty
      // (never "NUL" — that is a BRD code, not a brand name).
      brand: brand ?? "",
      itemName: itemName ?? null,
      isDangerousGood,
      dgHzRegulation,
    },
  };
}
