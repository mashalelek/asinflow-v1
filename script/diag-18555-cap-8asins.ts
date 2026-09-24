// DIAGNOSTIC ONLY — read-only. For the 8 repricer-suppressed listings:
// fetch reference data (fetchCompetingOffers → CPT + buy box from the same
// getItemOffers payload) and compute the 18555 cap via the SHIPPED cap chain
// (860ee27): CPT strictly below (.x9) → buy box × 1.5 (.x9) → no reference.
//
// The cap is extracted through resolveOfferPrice itself — a synthetic
// sky-high competing offer makes Rule 1 always exceed the cap, so
// resolvedPrice IS the shipped chain's cap value (capReference says which
// reference bound; noPriceReference = neither present). No reimplemented
// flooring, zero drift risk.
//
// Current price + 18555 confirmation read from getListingsItem
// (attributes.purchasable_offer + issues). NO WRITES anywhere.
import "dotenv/config";
import { spApiGet } from "../server/spapi-auth";
import { fetchCompetingOffers } from "../server/listings-offers-fetch";
import { resolveOfferPrice } from "../shared/price-resolver";
import { settingsSchema } from "../shared/schema";

const MKT = "ATVPDKIKX0DER";
const sellerId = process.env.SP_API_SELLER_ID!;
const settings = settingsSchema.parse({});

const TARGETS: { asin: string; sku: string }[] = [
  { asin: "B07RCWCX43", sku: "GOL-PET-X43-JRD-001" },
  { asin: "B0GXWPHD5M", sku: "DM-9C1A-PVJO" },
  { asin: "B0D9Q1RQ55", sku: "BAM-IND-Q55-BLP-001" },
  { asin: "B0GSSYTCJM", sku: "2A-DQ9Q-X1G2" },
  { asin: "B00QGW3T3Q", sku: "FS-N7PO-8WQC" },
  // Maria's list says "amzn.gr.71-… SKU"; primary 71-O6XL-WV9L also probed
  // for cross-checking which SKU carries the suppressed listing.
  { asin: "B07VRQM27X", sku: "amzn.gr.71-O6XL-WV9L-XDcJL4l91Q9CGNgl-LN" },
  { asin: "B07VRQM27X", sku: "71-O6XL-WV9L" },
  { asin: "B0055729DE", sku: "GF-WE9U-C26R" },
  { asin: "B0BRR26CH1", sku: "5D-034C-T857" },
];

function extractOurPrice(d: any): number | null {
  const po = d?.attributes?.purchasable_offer;
  if (!Array.isArray(po)) return null;
  for (const offer of po) {
    const sched = offer?.our_price?.[0]?.schedule?.[0];
    const v = sched?.value_with_tax ?? sched?.value;
    const n = v != null ? parseFloat(v) : NaN;
    if (!isNaN(n)) return n;
  }
  return null;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // De-dup offer fetches per ASIN (B07VRQM27X has two SKU probes).
  const offersByAsin = new Map<string, any>();
  const rows: any[] = [];

  for (const { asin, sku } of TARGETS) {
    console.log(`\n===== ${asin}  ${sku} =====`);

    // 1. Listing state: current price + 18555 present?
    let currentPrice: number | null = null;
    let listingNote = "";
    let statuses: string[] = [];
    let has18555 = false;
    try {
      const d = await spApiGet(
        `/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}`,
        { marketplaceIds: MKT, includedData: "summaries,attributes,issues" },
      );
      statuses = d?.summaries?.[0]?.status ?? [];
      currentPrice = extractOurPrice(d);
      const issues = (d?.issues ?? []).map((i: any) => `${i.code}/${i.severity}`);
      has18555 = (d?.issues ?? []).some((i: any) => String(i.code) === "18555");
      console.log(`  listing: status=[${statuses.join(",")}] price=${currentPrice ?? "?"} issues=[${issues.join(" ")}]`);
    } catch (err: any) {
      listingNote = err?.response?.status === 404 ? "listing 404" : `listing fetch error: ${err.message}`;
      console.log(`  listing: ${listingNote}`);
    }

    // 2. Reference data (getItemOffers, ~0.5 rps — pace between ASINs)
    let offers = offersByAsin.get(asin);
    if (!offers) {
      offers = await fetchCompetingOffers(asin, sellerId);
      offersByAsin.set(asin, offers);
      await delay(2300);
    }

    let cpt: number | null = null;
    let bb: number | null = null;
    let cap: string = "-";
    let reference: string = "-";
    if (offers.ok) {
      cpt = offers.competitivePriceThreshold;
      bb = offers.buyBoxPrice;
      console.log(`  offers: competing=${offers.competingOffers.length} CPT=${cpt ?? "absent"} BB=${bb ?? "absent"}`);
      // 3. Shipped cap chain via resolveOfferPrice (synthetic sky-high rule price)
      const res = resolveOfferPrice(
        {
          cogs: 1, fbaFee: null, referralFee: null, feesEstimatePrice: null,
          weightLbs: null, isHazmat: false, category: null,
          prepCost: 0, storageCost: 0,
          offers: { kind: "definitive", competing: [999999], competitivePriceThreshold: cpt, buyBoxPrice: bb },
        },
        settings,
        true,
      );
      if (res.noPriceReference) {
        cap = "NO REFERENCE";
        reference = "none (CPT + BB absent)";
      } else if (res.capApplied) {
        cap = `$${res.resolvedPrice!.toFixed(2)}`;
        reference = res.capReference === "cpt" ? `CPT $${cpt!.toFixed(2)}` : `BB $${bb!.toFixed(2)} × 1.5`;
      } else {
        cap = "UNEXPECTED: cap did not bind";
      }
      console.log(`  cap: ${cap} (${reference})`);
    } else {
      cap = `offers fetch failed: ${offers.reason}`;
      console.log(`  offers: FAILED ${offers.reason} ${offers.message ?? ""}`);
    }

    rows.push({
      asin, sku,
      status: statuses.join(",") || listingNote || "?",
      has18555,
      currentPrice: currentPrice != null ? `$${currentPrice.toFixed(2)}` : "?",
      cpt: cpt != null ? `$${cpt.toFixed(2)}` : "-",
      bb: bb != null ? `$${bb.toFixed(2)}` : "-",
      reference, cap,
    });
  }

  console.log("\n\n===== SUMMARY TABLE =====");
  console.log(JSON.stringify(rows, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
