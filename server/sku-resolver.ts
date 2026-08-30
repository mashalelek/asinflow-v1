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
import { resolveLegend, type QueryFn } from "@shared/sku-legend";
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
        // status "missing" (2026-08-29): brand absent from the catalog — no
        // rawValue, nothing to derive; needs a manually-entered 3-char code.
        brand?: { rawValue: string; proposedCode: string; status: "proposed" | "not_in_legend" | "missing" };
        dept?: { rawValue: string; proposedCode: string; status: "proposed" | "not_in_legend" };
      };
    };

export interface ResolveSkuDeps {
  httpGet?: HttpGetFn;            // SP-API GET — default real
  queryFn: QueryFn;               // DB query — required (no sane default for a server module)
  selfHealWrite?: (catalog: { asin: string; category: string; brand: string; itemName: string | null; imageUrl: string | null }) => Promise<void>;
  // §18 missing-brand manual entry (2026-08-29): operator-entered 3-char BRD
  // used ONLY when the catalog has no brand. Validated here (A-Z/0-9, legend
  // collision) — invalid/colliding values return legend_pending with the
  // error in details, correctable inline.
  brandCodeOverride?: string;
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
        break; // §18 missing-brand flow below — legend_pending, not an error
      case "no_category":
        return { ok: false, reason: "no_category", details: `classifications block empty for ${asin}` };
      case "transient_error":
        return { ok: false, reason: "transient_error", details: `${fetched.status ?? "?"}: ${fetched.message}` };
    }
  }

  const { category, brand, itemName, imageUrl, isDangerousGood, dgHzRegulation } = fetched.data;

  // §18 missing-brand (2026-08-29): brand absent from the catalog. Without a
  // manual code this is legend_pending (status "missing", empty proposal —
  // there is nothing to derive). With one, validate + collision-check it and
  // use it as BRD directly; the legend is NOT consulted (no rawValue exists).
  const MISSING_PENDING = { brand: { rawValue: "", proposedCode: "", status: "missing" as const } };
  let brandOverride: string | null = null;
  if (brand == null) {
    const entered = (deps.brandCodeOverride ?? "").trim().toUpperCase();
    if (entered === "") {
      return {
        ok: false, reason: "legend_pending",
        details: `summaries[].brand missing for ${asin} — enter a 3-char brand code`,
        pending: MISSING_PENDING,
      };
    }
    if (!/^[A-Z0-9]{3}$/.test(entered)) {
      return {
        ok: false, reason: "legend_pending",
        details: `brand code must be exactly 3 characters A-Z/0-9 (got "${entered}")`,
        pending: MISSING_PENDING,
      };
    }
    const coll = await deps.queryFn(
      `SELECT raw_value FROM sku_legend WHERE type = 'brand' AND code = $1 LIMIT 1`,
      [entered],
    );
    if (coll.rows.length > 0) {
      return {
        ok: false, reason: "legend_pending",
        details: `code ${entered} is already assigned to brand "${coll.rows[0].raw_value}" in the legend`,
        pending: MISSING_PENDING,
      };
    }
    brandOverride = entered;
  }

  // Self-heal first — succeed-and-write even if legend lookup later returns pending,
  // so the data is fresh for the next attempt. Skipped when the catalog has no
  // brand: a manually-entered code is never written to asins (§18 — catalog
  // stays the only source for catalog fields).
  if (deps.selfHealWrite && brand != null) {
    await deps.selfHealWrite({ asin, category: category!, brand: brand!, itemName, imageUrl });
  }

  const [brandRes, deptRes] = await Promise.all([
    brandOverride != null
      ? Promise.resolve({ status: "approved", code: brandOverride, derivedProposal: null } as any)
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
      // Missing-brand override path: no catalog brand exists; empty string
      // (never the entered code — that is a BRD, not a brand name).
      brand: brand ?? "",
      itemName: itemName ?? null,
      isDangerousGood,
      dgHzRegulation,
    },
  };
}
