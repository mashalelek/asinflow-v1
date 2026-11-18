# Keepa spike — 2026-11-18 (commit 1, read-only)

`docs/claude_spec-patch-keepa-trends.md` → "Commit 1 — spike". Run with `npm run keepa:spike` (`tsx script/keepa-spike.ts`,
Starter plan, 20 tokens/min). The raw run is reproduced under "Run output" below; this section is the reading of it
against the patch's decision rules.

## Decisions

| # | Question | Answer | Rule applied |
|---|---|---|---|
| S1 | Series where expected? | **Yes, all five.** `buy_box` = csv[18] (triples: time, price, shipping — price is the Buy Box price, shipping separate; $25.30 + $0.00 at 19:35Z against the chart's $25.31 taken earlier the same day), `new_price` = csv[1] ($25.25; the chart read $25.28 before the 16:48Z change), `sales_rank` = csv[3] (#175,887 — exact), `offers_new` = csv[11] (7 — exact), `rating_count` = csv[17] (222 — exact). | Use what the response shows → build. Nothing the chart shows is missing. |
| S2 | New, FBA offer count history | **In this request: csv[34] `COUNT_NEW_FBA`** (last value 3 — exact; csv[35] `COUNT_NEW_FBM` = 4; 3 + 4 = the 7 New offers). Keepa's Product-object docs name both; the API changelog dates them 2026-02-23, and this ASIN's csv[34] starts 2026-02-10. So the New, FBA line exists but **begins in February 2026** for every ASIN; on `All` it starts where its data starts (the gap rule). The changelog's caveat ("entries dated before 2026-02-23 reflect the lowest listing price") concerns the first days only; the fetcher keeps them as Keepa sends them. | In this request → **build the New, FBA line and its toggle.** No `offers` parameter. |
| S3 | Tokens per ASIN | **4** with `buybox=1&rating=1` (base 1, +2 buybox, +1 rating); the 20-ASIN batch cost 80. Daily need: 4 × 2,456 active + parked ASINs (local copy count) = **9,824 tokens/day**, under 20,000. Plan: bucket ~1,260 at the start, refill 21/min → a full daily job runs about (9,824 − 1,260) / 21 ≈ 6 h 50 min. | ≤ 20,000 → **proceed.** The patch's "about 3 tokens" becomes 4 (SPEC text updated in commit 6). |
| S4 | How `monthlySoldHistory` ends a value | **An explicit `-1` change point.** B08G6J2PY5: 50 from 2025-10-25, `-1` on 2025-12-06, 50 again 2025-12-12, `-1` on 2026-01-16 and nothing since — exactly the chart's "Dec to late Jan with a short gap in Dec, nothing since". The current `monthlySold` field is absent. | Stored series: value holds until the next change point; `-1` → NULL. Matches. |
| S5 | Batch payload | 20 ASINs = **10.28 MB, 1.9 s HTTP, 24 ms parse** (Keepa processing 387 ms); 1 ASIN ≈ 0.4–0.8 MB (the product object carries every history series, images, description, variations). | < 30 MB and < 10 s → **batch size stays 20.** |
| S6 | Fresh without `update`? | **Yes.** `lastUpdate` age across the batch: min 0.1 h, median 2.7 h, max 17.9 h; none over a day. | Leave `update` unset. |

Other facts the build uses:

- `lastUpdate`, `lastPriceChange`, `lastRatingUpdate`, `trackingSince` are Keepa minutes (`unix ms = (t + 21564000) × 60000`).
- csv[11] (`COUNT_NEW`) and csv[17] last changed on 2026-11-12 / 2026-11-11 while `lastUpdate` is today: a series' last value holds to `lastUpdate`'s day (the patch's rule), not to its own last change point.
- Every one of the 20 ASINs came back (`products` = 20 of 20) with csv 1, 3, 11, 17, 18, 34, 35 present; `monthlySoldHistory` is absent on 6 of 20 (never had a Monthly Sold figure) → empty Monthly Sold line, Sales Rank still draws (acceptance row 8).
- `refillRate` reports 21 (the plan's 20 + 1); the fetcher reads `tokensLeft` / `refillIn` / `refillRate` from each reply rather than assuming the plan.

## Read-only check asked for before commit 1: the Product cell's Keepa hover graph

`client/src/components/results-table.tsx` (`KeepaLink`) builds
`https://graph.keepa.com/pricehistory.png?asin=<ASIN>&domain=1&range=365&width=800&height=300&bb=1`
and the browser loads it directly (`new Image()` + `<img src>`, `referrerPolicy="no-referrer"`). **It carries no API key**: this is
Keepa's public `graph.keepa.com` image endpoint, not the token-metered Graph Image API (`api.keepa.com/graphimage?key=…`). So
the key is not exposed and no tokens are spent per hover. Not changed (out of scope by the patch).

## A deviation to note: the component number

The patch and the brief say "component 25". In the code #25 is already **PO tracking ingest** (`server/scheduler/components/25-po-tracking-ingest.ts`,
SPEC §11 component table, 2026-10-21); the component list is strictly increasing by number (`components/index.ts` throws otherwise).
Keepa history therefore lands as **component 33**, the next free number — the patch's "25" came from the older component map
(`docs/af_data_components.csv` row 31 "Keepa product data, TBD"). Nothing else about it changes: it runs only in Keepa jobs on lane K.

## Run output


Read-only run of `tsx script/keepa-spike.ts` against the Keepa API (Starter plan). Test ASIN B08G6J2PY5 plus 19 catalog ASINs. Nothing was written to any database; the key is not in this file.

## Requests and tokens (S3)

| Request | HTTP | tokensConsumed | tokensLeft after | refillIn (ms) | refillRate | bytes | http ms | parse ms |
|---|---|---|---|---|---|---|---|---|
| 1 ASIN, base | 200 | 1 | 1259 | 12498 | 21 | 426,755 | 1012 | 1.2 |
| 1 ASIN, +buybox | 200 | 3 | 1256 | 10290 | 21 | 823,761 | 837 | 5 |
| 1 ASIN, +buybox +rating | 200 | 4 | 1252 | 7948 | 21 | 831,083 | 684 | 4.6 |
| 20 ASINs, +buybox +rating | 200 | 80 | 1172 | 5374 | 21 | 10,780,169 | 1897 | 23.8 |

Per ASIN in the batch: **4.00 tokens**. Products returned: 20 of 20.

## Series positions for B08G6J2PY5 (S1)

Top-level keys: asin, author, availabilityAmazon, binding, brand, brandStoreName, brandStoreUrl, brandStoreUrlName, buyBoxEligibleOfferCounts, buyBoxSellerIdHistory, categories, categoryTree, color, competitivePriceThreshold, coupon, couponHistory, csv, description, domainId, eanList, ebayListingIds, edition, fbaFees, features, format, frequentlyBoughtTogether, g, hasReviews, images, isAdultProduct, isEligibleForSuperSaverShipping, isEligibleForTradeIn, isHeatSensitive, isRedirectASIN, isSNS, itemHeight, itemLength, itemTypeKeyword, itemWeight, itemWidth, languages, lastEbayUpdate, lastPriceChange, lastRatingUpdate, lastSoldUpdate, lastUpdate, lastViewUpdate, launchpad, listedSince, liveOffersOrder, manufacturer, material, materials, model, monthlySoldHistory, numberOfItems, numberOfPages, offersSuccessful, packageHeight, packageLength, packageQuantity, packageWeight, packageWidth, parentAsin, parentAsinHistory, partNumber, productGroup, productType, promotions, publicationDate, referralFeePercent, referralFeePercentage, releaseDate, reviews, rootCategory, salesRankDisplayGroup, salesRankReference, salesRankReferenceHistory, salesRanks, size, title, trackingSince, type, unitCount, upcList, urlSlug, variations, viewCountHistory, websiteDisplayGroup, websiteDisplayGroupName

`lastUpdate` = 8353175 → 2026-11-18T19:35:00.000Z; `lastPriceChange` → 2026-11-18T19:35:00.000Z; `lastRatingUpdate` → 2026-11-18T16:49:00.000Z; `trackingSince` → 2020-09-07T14:04:00.000Z

| csv index | Keepa name | points | span | last | -1 count |
|---|---|---|---|---|---|
| 0 AMAZON | 1 points | 2020-09-07 → 2020-09-07 | last value -1 | 1 × -1 |
| 1 NEW | 2780 points | 2020-09-07 → 2026-11-18 | last value 2525 | 3 × -1 |
| 2 USED | 1 points | 2020-09-07 → 2020-09-07 | last value -1 | 1 × -1 |
| 3 SALES | 10109 points | 2020-09-07 → 2026-11-18 | last value 175887 | 1 × -1 |
| 4 LISTPRICE | 135 points | 2020-09-20 → 2025-12-20 | last value 2496 | 53 × -1 |
| 5 COLLECTIBLE | absent (null) | | | |
| 6 REFURBISHED | absent (null) | | | |
| 7 NEW_FBM_SHIPPING | absent (null) | | | |
| 8 LIGHTNING_DEAL | absent (null) | | | |
| 9 WAREHOUSE | absent (null) | | | |
| 10 NEW_FBA | absent (null) | | | |
| 11 COUNT_NEW | 1199 points | 2020-09-07 → 2026-11-12 | last value 7 | 3 × -1 |
| 12 COUNT_USED | 1 points | 2023-06-08 → 2023-06-08 | last value -1 | 1 × -1 |
| 13 COUNT_REFURBISHED | 1 points | 2023-06-08 → 2023-06-08 | last value -1 | 1 × -1 |
| 14 COUNT_COLLECTIBLE | 1 points | 2023-06-08 → 2023-06-08 | last value -1 | 1 × -1 |
| 15 EXTRA_INFO_UPDATES | 7359 points | 2020-09-07 → 2026-11-18 | last value 7 | 0 × -1 |
| 16 RATING | 59 points | 2020-10-07 → 2025-12-06 | last value 46 | 10 × -1 |
| 17 COUNT_REVIEWS | 403 points | 2020-10-07 → 2026-11-11 | last value 222 | 10 × -1 |
| 18 BUY_BOX_SHIPPING | 8540 points | 2020-09-07 → 2026-11-18 | last value 2530 (+ shipping 0) | 10 × -1 |
| 19 USED_NEW_SHIPPING | absent (null) | | | |
| 20 USED_VERY_GOOD_SHIPPING | absent (null) | | | |
| 21 USED_GOOD_SHIPPING | absent (null) | | | |
| 22 USED_ACCEPTABLE_SHIPPING | absent (null) | | | |
| 23 COLLECTIBLE_NEW_SHIPPING | absent (null) | | | |
| 24 COLLECTIBLE_VERY_GOOD_SHIPPING | absent (null) | | | |
| 25 COLLECTIBLE_GOOD_SHIPPING | absent (null) | | | |
| 26 COLLECTIBLE_ACCEPTABLE_SHIPPING | absent (null) | | | |
| 27 REFURBISHED_SHIPPING | absent (null) | | | |
| 28 EBAY_NEW_SHIPPING | 155 points | 2024-06-04 → 2026-09-30 | last value -1 (+ shipping -1) | 3 × -1 |
| 29 EBAY_USED_SHIPPING | absent (null) | | | |
| 30 TRADE_IN | absent (null) | | | |
| 31 RENT | absent (null) | | | |
| 32 BUY_BOX_USED_SHIPPING | absent (null) | | | |
| 33 PRIME_EXCL | absent (null) | | | |
| 34 ? | 48 points | 2026-02-10 → 2026-11-12 | last value 3 | 1 × -1 |
| 35 ? | 27 points | 2026-02-10 → 2026-10-08 | last value 4 | 0 × -1 |

### Current values vs Keepa's chart (reference 2026-11-18: Buy Box $25.31 · New $25.28 · Sales Rank #175,887 · Rating Count 222 · New offers 7 · New, FBA 3)

- buy_box csv[18]: price $25.30 + shipping $0.00 (at 2026-11-18T19:35:00.000Z)
- new_price csv[1]: $25.25 (at 2026-11-18T16:48:00.000Z)
- sales_rank csv[3]: #175,887 (at 2026-11-18T14:07:00.000Z)
- offers_new csv[11]: 7 (at 2026-11-12T00:53:00.000Z)
- rating_count csv[17]: 222 (at 2026-11-11T13:01:00.000Z)
- monthlySold (current field): —
- stats present: no (no `stats` parameter sent)

## New, FBA offer count (S2)

Keys mentioning FBA: `fbaFees` (object).
`offers` in the response: absent (not requested). csv[10] NEW_FBA is a PRICE series (lowest new FBA offer), not a count.

## monthlySoldHistory (S4)

16 change points. Every point:

| at | value |
|---|---|
| 2024-01-10T01:34:00.000Z | 50 |
| 2024-11-06T01:58:00.000Z | 100 |
| 2024-11-06T07:44:00.000Z | 50 |
| 2024-11-06T13:32:00.000Z | 100 |
| 2024-11-07T12:52:00.000Z | 50 |
| 2024-11-08T16:24:00.000Z | 100 |
| 2024-11-13T09:08:00.000Z | 50 |
| 2025-06-01T04:44:00.000Z | -1 |
| 2025-07-19T04:50:00.000Z | 50 |
| 2025-08-02T05:56:00.000Z | -1 |
| 2025-08-31T10:54:00.000Z | 50 |
| 2025-10-13T06:20:00.000Z | -1 |
| 2025-10-25T04:36:00.000Z | 50 |
| 2025-12-06T02:28:00.000Z | -1 |
| 2025-12-12T06:32:00.000Z | 50 |
| 2026-01-16T03:22:00.000Z | -1 |

## Batch payload (S5)

20 ASINs: 10.28 MB, HTTP 1897 ms (Keepa processingTimeInMs 387), JSON.parse 23.8 ms. Rule: halve the batch above 30 MB or 10 s — within bounds.

| ASIN | present | lastUpdate | csv indices present | monthlySoldHistory |
|---|---|---|---|---|
| B08G6J2PY5 | yes | 2026-11-18 | 0 1 2 3 4 11 12 13 14 15 16 17 18 28 34 35 | 16 points |
| B00BTO3GWK | yes | 2026-11-18 | 0 1 2 3 4 5 11 12 13 14 15 16 17 18 28 34 35 | 57 points |
| B0060RZBUG | yes | 2026-11-18 | 0 1 2 3 4 11 12 13 15 16 17 18 28 34 35 | 11 points |
| B00A6GIC26 | yes | 2026-11-18 | 0 1 2 3 4 11 15 16 17 18 34 35 | 17 points |
| B07G39GQX5 | yes | 2026-11-18 | 0 1 2 3 4 11 12 13 14 15 16 17 18 28 34 35 | 29 points |
| B01IP0F65A | yes | 2026-11-18 | 0 1 2 3 4 11 13 15 16 17 18 34 35 | 2 points |
| B0053O1YKS | yes | 2026-11-18 | 0 1 2 3 4 11 12 13 15 16 17 18 32 34 35 | 6 points |
| B001O07BC0 | yes | 2026-11-18 | 0 1 2 3 4 11 12 13 15 16 17 18 32 34 35 | — |
| B07RTJP2PZ | yes | 2026-11-18 | 0 1 2 3 4 11 13 15 16 17 18 34 35 | 6 points |
| B0095XBRA0 | yes | 2026-11-18 | 0 1 2 3 4 11 13 15 16 17 18 33 34 35 | — |
| B00HNQBJLS | yes | 2026-11-18 | 0 1 2 3 4 5 11 12 14 15 16 17 18 33 34 35 | — |
| B07MZR2XYY | yes | 2026-11-18 | 0 1 2 3 4 11 12 13 14 15 16 17 18 33 34 35 | 12 points |
| B07BC7KM25 | yes | 2026-11-18 | 0 1 2 3 4 5 11 12 13 14 15 16 17 18 28 29 32 34 35 | 79 points |
| B099KRQ1W7 | yes | 2026-11-18 | 0 1 2 3 4 11 13 15 16 17 18 28 34 35 | — |
| B08599S3L6 | yes | 2026-11-18 | 0 1 2 3 4 11 13 15 16 17 18 28 29 34 35 | — |
| B07MZPKFPT | yes | 2026-11-18 | 0 1 2 3 4 11 12 13 14 15 16 17 18 34 35 | 35 points |
| B074MSD8L1 | yes | 2026-11-18 | 0 1 2 3 4 11 12 15 16 17 18 28 29 34 35 | 6 points |
| B084KZLTZ2 | yes | 2026-11-18 | 0 1 2 3 4 11 12 13 15 16 17 18 32 34 35 | 55 points |
| B0BWPLY3LD | yes | 2026-11-18 | 0 1 2 3 4 11 13 15 16 17 18 34 35 | 31 points |
| B002P6NREI | yes | 2026-11-18 | 0 1 2 3 4 11 12 13 14 15 16 17 18 32 34 35 | — |

## Freshness without `update` (S6)

lastUpdate age across the batch: min 0.1 h, median 2.7 h, max 17.9 h; 0 of 20 older than a day.

