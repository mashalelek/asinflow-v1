// §18 Part B phase c (2026-10-11) — ASINs that exist in Seller Central but
// not in AsinFlow.
//
// Phases a and b reconcile ASINs AF already knows. Phase c closes the other
// direction of "AF mirrors the SC catalog": if SC has a listing and AF does
// not have the ASIN at all, AF adds it.
//
// SOURCE: searchListingsItems with NO identifiers — the unfiltered account
// listing. Verified live 2026-10-09 against the real account: HTTP 200,
// numberOfResults 805, pageSize=20, pagination.nextToken, 41 calls in 18.7s.
// The Reports-API fallback (GET_MERCHANT_LISTINGS_ALL_DATA) is NOT needed and
// is not implemented — the spike settled it.
//
// A1 APPLIES: a row with no summary is a SKU shell, not a listing, and is not
// onboarded. The ASIN comes from summaries[0].asin — with
// includedData=summaries the response carries only { sku, summaries }, so
// there is no other source for it.
//
// A PARTIAL PULL ONBOARDS NOTHING. Any page failing, or pagination ending
// early, makes the whole list inconclusive: `sc_list_incomplete`. Onboarding
// from a truncated list would create rows for some ASINs and silently omit
// others, and the omission is invisible — there is no "missing" to see.

import { spApiGet as realSpApiGet } from "./spapi-auth";
import type { HttpGetFn } from "./sku-catalog-fetch";
import { extractDomain } from "@shared/schema";

const MARKETPLACE = "ATVPDKIKX0DER";
const PAGE_SIZE = 20;
// 41 pages observed; the cap is a runaway guard, not an expected bound.
const MAX_PAGES = 200;

export interface ScListing {
  sku: string;
  asin: string;
  statuses: string[];
}

export type AccountListingsOutcome =
  | { ok: true; listings: ScListing[]; pages: number; numberOfResults: number | null }
  | { ok: false; reason: "sc_list_incomplete"; detail: string; pagesFetched: number };

/**
 * Pull every listing in the account. One page at a time, following
 * pagination.nextToken.
 *
 * Returns ok:false on ANY failure — a thrown page, a page cap hit, or a row
 * that cannot be attributed to an ASIN. The caller onboards nothing.
 */
export async function fetchAllAccountListings(
  sellerId: string,
  httpGet: HttpGetFn = realSpApiGet,
  pacingMs = 260,
): Promise<AccountListingsOutcome> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const listings: ScListing[] = [];
  let token: string | undefined;
  let pages = 0;
  let numberOfResults: number | null = null;

  for (;;) {
    const q: Record<string, string> = {
      marketplaceIds: MARKETPLACE,
      pageSize: String(PAGE_SIZE),
      includedData: "summaries",
    };
    if (token) q.pageToken = token;

    let data: any;
    try {
      data = await httpGet(`/listings/2021-08-01/items/${sellerId}`, q);
    } catch (err: any) {
      return {
        ok: false,
        reason: "sc_list_incomplete",
        detail: `page ${pages + 1} failed (${err?.response?.status ?? "?"}): ${err?.response?.data?.errors?.[0]?.message ?? err?.message ?? "unknown"}`,
        pagesFetched: pages,
      };
    }
    pages++;
    if (numberOfResults == null && typeof data?.numberOfResults === "number") {
      numberOfResults = data.numberOfResults;
    }

    for (const it of data?.items ?? []) {
      // A1: no summary → SKU shell → not a listing.
      const sm = Array.isArray(it?.summaries) && it.summaries.length > 0 ? it.summaries[0] : null;
      if (!sm) continue;
      const asin = String(sm.asin ?? "").trim();
      const sku = String(it?.sku ?? "").trim();
      if (!asin || !sku) continue;
      listings.push({ sku, asin, statuses: Array.isArray(sm.status) ? sm.status : [] });
    }

    token = data?.pagination?.nextToken;
    if (!token) break;
    if (pages >= MAX_PAGES) {
      return {
        ok: false,
        reason: "sc_list_incomplete",
        detail: `page cap ${MAX_PAGES} hit with a nextToken still present — refusing to onboard from a truncated list`,
        pagesFetched: pages,
      };
    }
    await sleep(pacingMs);
  }

  return { ok: true, listings, pages, numberOfResults };
}

// ── Onboarding data resolution ──────────────────────────────────────────────

export interface OnboardResolution {
  asin: string;
  skus: string[];
  /** 'po_sheet' when the ASIN has Orders-sheet rows; 'none' otherwise. */
  cogsSource: "po_sheet" | "none";
  buyLink: string | null;
  supplier: string | null;
  /** Which precedence arm supplied the buy link (§18 phase c step 3). */
  buyLinkSource: "master" | "orders" | "none";
}

/**
 * Normalize an Orders-sheet supplier cell into a bare host, then a URL.
 *
 * The column holds a domain, not a URL ("macys.com"), but operators paste —
 * so strip a scheme and a www. prefix before trusting it, and lowercase.
 * Returns null for anything that does not look like a host.
 */
export function normalizeSupplierDomain(raw: string | null | undefined): string | null {
  let v = String(raw ?? "").trim().toLowerCase();
  if (!v) return null;
  v = v.replace(/^https?:\/\//, "").replace(/^www\./, "");
  v = v.split("/")[0].split("?")[0].trim();
  if (!v || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) return null;
  return v;
}

/**
 * Resolve COGS source, buy link and supplier for the ASINs phase c is about
 * to onboard. Pure given its inputs — the caller supplies the two sheet
 * lookups, so this is unit-testable without Google.
 *
 * Precedence (§18 phase c step 3), FIRST match wins:
 *   a. Master sheet (SOURCING_SHEET_ID) ASINs tab col N — a full URL. Used
 *      as-is; supplier derived with extractDomain, the same helper the Buy
 *      Link column edit uses.
 *   b. Orders sheet col E — a bare domain. supplier = the domain,
 *      buy_link = "https://" + domain.
 *   c. Neither → both NULL. The UI already renders $0.00 / no link; no
 *      synthetic value is stored.
 */
export function resolveOnboardData(
  asins: string[],
  skusByAsin: Map<string, string[]>,
  masterBuyLinks: Map<string, string>,
  ordersSuppliers: Map<string, string | null>,
): OnboardResolution[] {
  return asins.map((asin) => {
    const master = (masterBuyLinks.get(asin) ?? "").trim();
    if (master) {
      return {
        asin,
        skus: skusByAsin.get(asin) ?? [],
        cogsSource: ordersSuppliers.has(asin) ? "po_sheet" : "none",
        buyLink: master,
        supplier: extractDomain(master) || null,
        buyLinkSource: "master",
      };
    }
    const domain = normalizeSupplierDomain(ordersSuppliers.get(asin) ?? null);
    if (domain) {
      return {
        asin,
        skus: skusByAsin.get(asin) ?? [],
        cogsSource: "po_sheet",
        buyLink: `https://${domain}`,
        supplier: domain,
        buyLinkSource: "orders",
      };
    }
    return {
      asin,
      skus: skusByAsin.get(asin) ?? [],
      // An ASIN can have Orders rows (so PO COGS applies) while its supplier
      // cell is blank — the two are resolved independently.
      cogsSource: ordersSuppliers.has(asin) ? "po_sheet" : "none",
      buyLink: null,
      supplier: null,
      buyLinkSource: "none",
    };
  });
}
