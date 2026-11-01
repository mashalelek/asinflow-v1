# Capture PO / AI prefill — commit 0 probe report (2026-10-30)

Patch: `docs/claude_spec-patch-po-ai-prefill.md` §3. Read-only: nothing was written to the DB, the sheet, Gmail or any API. Scratch scripts ran from the session scratchpad; none are in the repo.

## Findings that need Maria's word before commit 1

**P1 — The Orders sheet AF reads is an IMPORTRANGE mirror; the formulas live in a sheet the service account cannot open.**
`GOOGLE_SHEET_ID`'s `Sheet1!A1` is `=IMPORTRANGE("…/d/1xwblYLfpd8CIhcqLZ8anwEv_pYsM7KVRb1jDokD-Gno/…", "Orders!A:AZ")`; every other cell is a spilled value (`userEnteredValue` empty, FORMULA render returns nothing). Reading the source spreadsheet with the service account returns HTTP 403. To read the X/Y formulas, share `1xwblYLfpd8CIhcqLZ8anwEv_pYsM7KVRb1jDokD-Gno` (viewer) with `asinflow-sheets@amazon-fba-463600.iam.gserviceaccount.com`. What the values alone prove is in item 5 below: every relationship **except col AQ "Product Cost"** is exact on 150/150 recent rows.

**P2 — §8.1 columns mostly exist already, as dollars not cents.**
`purchase_orders` already has `discount`, `tax`, `sh_donations`, `refund_amount` (numeric, default 0), `cashback_site`, `cashback_pct`, `purchased_by` (text: Maria 1918, blank 452, Anna 124), `subscription` (bool, 48 true), `email_used`, `notes`, `promo` (text, 753 non-null), `weighted_gc_discount_pct` (percent units, 7.00 = 7 %), `source` (all 2494 = `sheet_import`; the form writes `manual`). Recommendation (deviation from the patch text): do not add `discount_cents`/`tax_cents`/`shipping_cents`; keep the numeric columns and widen `source` to `sheet_import | manual | extension | email_renewal`. Add only `purchased_by_user_id` (backfill "Maria" → user 1; "Anna" has no `users` row — users are Maria and Jason — so it stays NULL with the text kept). The default-0 money columns violate the patch's tri-state rule; changing them to NULL-default is a separate decision.

**P3 — AF has no ASIN-level pack fields.**
`sold_as` / `units_per_pack` exist only on `po_asins` (per PO row; `velocity_units_per_pack` beside them since migration 070). The `asins` table has none, the ASINs page shows none. §6.4 ("pack type / units per pack come from AF when known") and §6.5 ("Update ASIN in AF writes the ASIN's pack fields with a History row") assume an ASIN-level value. Options: (a) add `asins.sold_as` + `asins.units_per_pack`, backfilled from the newest non-canceled PO ASIN row (the same "newest" rule `loadAfAsinCostMap` uses for cost), History in `po_edit_log` is PO-scoped so an ASIN-level change needs its own log or `asin_estimates`-style row; (b) derive "AF's value" from the newest PO row at form time and make "Update ASIN in AF" write that row's future default. Recommendation: (a).

**P4 — Update COGS in SC sends col Y today, not col AR.**
§7.1 says Sourcing cost is "the col AR value … this is what Update COGS in SC sends" and commit 2 calls it probe-confirmed. It is not: `buildSourcingCost` (`server/sourcing-cost.ts:171-192`) submits `asin_estimates.actual_cogs` where `cogs_source = 'po_sheet'`, and `actual_cogs` is `po_asins.cost_per_unit` = sheet col Y "Adjusted COGS" (after the gift-card discount). Switching SC to the AR value (before the gift-card discount) raises every submitted cost by the GC % — a behaviour change for Maria to confirm, not a probe confirmation. Also, AR is not "list-price-based": AR = Σ(AQ × L) ÷ N where AQ is the price actually paid per product after sale/coupon (item 5), so "Sourcing cost = COGS before the gift-card discount, promos included" is the accurate description.

**P5 — Extension authentication: there is none, and every `/api` route needs a session.**
See item 1. The prefill route cannot reuse "the extension's session" because the extension has no session; see the recommendation there.

Smaller deviations proposed: promo backfill keyword rule (item 7); payment backfill shapes (item 7).

## 1. Extension (`chrome-extension/`)

- **Manifest**: MV3, name "AsinFlow", version `1.0.0`. Permissions `sidePanel, activeTab, storage, tabs`. `host_permissions`: `https://www.amazon.com/*`, `https://amazon.com/*`, `http://localhost:3000/*` — **no production host**, so the shipped extension can only talk to a local dev server.
- **Side panel**: `sidepanel.html` + `sidepanel.js` (651 lines, profit calculator + Import to AsinFlow); `background.js` service worker (280 lines); `content.js` (368 lines) runs only on Amazon `/dp/` and `/gp/product/` pages; `options.html/js` (server URL + auto-open, `chrome.storage.sync`).
- **Auth to AF**: none. `background.js` calls `GET /api/settings`, `GET /api/asins/check/:asin`, `POST /api/import-asin`, `GET /api/credentials-status` with plain `fetch` (no `credentials` option, no token). Since auth v1 (`server/index.ts:151` `app.use("/api", requireAuth)`; session cookie `httpOnly, sameSite: "lax", secure in production`, `server/auth.ts:201-204`) those calls answer 401; SPEC §25 decision 6 records the extension as "treated as dead" and the `chrome-extension://*` CORS allowance removed (`server/index.ts:42-44`). **For §4.5/§5**: the extension must send the AF session cookie — `fetch(..., { credentials: "include" })` from the background worker plus the production origin in `host_permissions` (host-permission fetches bypass CORS, so no server CORS change). Whether Chrome attaches the `SameSite=Lax` cookie to an extension-initiated request must be verified against a logged-in Chrome in commit 5 before the prefill route is built on it; the fallback is a short-lived token minted by the logged-in AF tab.
- **Message passing**: content → background `PRODUCT_DATA` (validated against the sender tab's URL/ASIN, stored in `chrome.storage.session.currentProduct`); panel ↔ background `GET_SETTINGS`, `GET_CURRENT_PRODUCT`, `REQUEST_PRODUCT_FROM_TAB` (background relays `REQUEST_PRODUCT_DATA` to the tab), `CHECK_ASIN`, `IMPORT_ASIN`, `TEST_CONNECTION`, `REFRESH_SETTINGS`; `storage.session.onChanged` → `PRODUCT_DATA_UPDATED` broadcast to the panel. `chrome.storage.session` keyed by a single `currentProduct`, not by tab id.
- **Page text**: `content.js` reads targeted DOM selectors (title, price, byline, detail tables, BSR) — never `innerText` of the body, never inputs. Nothing today captures a non-Amazon page; a second content script (match `<all_urls>` or the retailer list, triggered by the panel's Capture button via `chrome.scripting`/`activeTab`) is new code.

## 2. New PO form

- **Files**: `client/src/components/new-po-dialog.tsx` (dialog, opened from the POs page `+ New PO`, `client/src/pages/purchase-orders.tsx:581-584`; there is no `/pos/new` route — `client/src/App.tsx` has `/purchase-orders` and `/purchase-orders/:id`); state + validator `shared/po-form.ts` (`PoFormState`, `checkPoForm`, `shipsToFromForm`); cost prefill `shared/po-cost.ts`; server `server/po-create.ts` (`createPoFromForm`, `lookupAsins`).
- **Fields today** (header): supplier, order_id, order_date, purchased_by, ships_to (select, follows prep until edited), subtotal, tax, sh_donations, discount, refund_amount, order_total, payment_method (free text), weighted_gc_discount_pct, cashback_site, cashback_pct, notes. Per product row: product_name, supplier_sku, price, qty_ordered, asin (typeahead `GET /api/pos/asin-lookup`, 12 rows by ASIN prefix or title substring), asin_qty_per_product ("Yield"), sold_as (individual | multi-pack | bundle), units_per_pack (disabled for individual), prep_cost (default "1"). Per derived ASIN row: cost / unit override (`cost_overrides[asin]`). No retailer-level "Units/pack", no per-line notes, no payments/promos blocks, no email_used, no subscription.
- **Cost-per-unit prefill** (`shared/po-cost.ts`, formula v1): per product `adjusted = price × (orderTotal ÷ subtotal) × (1 − gcPct/100)`; per ASIN `cost/unit = Σ(adjusted × qty_ordered) ÷ ASIN Ordered`, rounded once. Measured at 73.7 % (1,166 of 1,582) against imported 2026 rows — the same ceiling item 5 explains. `orderTotal` is the typed total else `subtotal + tax + sh_donations − discount`; `subtotal` is typed else Σ price × qty. Per line `adjusted_product_cost` is stored rounded.
- **Calculator**: `MoneyCalcInput` (`client/src/components/money-calc-input.tsx`) over `shared/money-expr.ts` — an expression ("24.99*2/3+1.5") settles on blur/Enter; `settleMoney` in the dialog settles every money field before save.
- **Decimals / partial units**: qty_ordered ≤ 2 decimals and > 0; yield ≤ 4 decimals and > 0, restored to its fraction by `trueYield` (0.33 → 1/3); units_per_pack whole ≥ 2 for packs/bundles; ASIN Ordered = Σ qty × yield (2 dp), bundle = min over components which must agree; a non-whole Ordered is a warning (`WHOLE_PACKS_WARNING`, Upload to Velocity skips it), not an error.
- **Save**: `POST /api/pos` (`server/routes.ts`) → `withPoTx(createPoFromForm)` → re-runs `checkPoForm`, rejects a duplicate (supplier, order_id) with 409, inserts `purchase_orders` (`source = 'manual'`, `entry_seq = afEntrySeq(now)`, `promo NULL`, `ships_to` from the form or prep), one `po_asins` per ASIN (title + primary_sku from `asins`, `cost_per_unit` = override else computed, `prep_cost`, `sold_as`, `units_per_pack`, `unique_products` for bundles), `po_line_items` per product (`adjusted_product_cost`, `asin_qty_per_product`, `item_discount 0`), one `po_edit_log` "PO created" row. It does **not** touch `asin_estimates`: `actual_cogs` catches up on the next hourly component 9, Sync POs, Push to Aura or COGS reset (item 4).

## 3. Pack fields

- Names: `po_asins.sold_as` (text, default `'individual'`), `po_asins.units_per_pack` (integer, default 1), `po_asins.velocity_units_per_pack` (integer, NULL = no Velocity line seen; migration 070). Nothing on `asins`, `asin_skus` or `asin_estimates` (P3).
- Inline-editable on the PO ASIN rows (`client/src/components/po-asin-rows.tsx:437-438`, `SelectEdit` / `InlineEdit` → `server/po-edit.ts:340-351`: individual forces units_per_pack 1, a sold_as change recomputes the ASIN qty).
- Readers: Upload to Velocity (`server/velocity-export.ts:229-268`, CSV cols AX/AY, `invalid_pack_math` skip when qty % units_per_pack ≠ 0, bundle units = sets × units); shipment matcher (`server/shipment-match.ts:96` `capacityUnits` = qty × units_per_pack); On Order (`server/asin-po-pipeline.ts:77`, bundle divisor); `loadAfPoRows` (`server/po-af-source.ts`); Pack size missing / mismatch action items (`server/po-action-items.ts:49-63`, derived from `velocity_units_per_pack ≠ units_per_pack`); the New PO form (per product row, grouped per ASIN, products of one ASIN must agree).

## 4. Costs

- **`actual_cogs` writer**: only `runSheetsSync` (`server/routes.ts:892-962`): source `loadAfAsinCostMap` (`server/po-af-source.ts:33-45`) = the newest non-canceled `po_asins` row per ASIN (`order_date DESC, entry_seq DESC`) → `cogs = actual_cogs = cost_per_unit`, `cogs_source = 'po_sheet'`, `estimated_cogs` too unless its source is `manual`, `prep_override = prep_cost`, `asins.supplier` COALESCE. Callers: Sync POs (`routes.ts:1815`, after `syncPoSheet`), Push to Aura's cost half (`routes.ts:4001`), hourly component 9 (`server/scheduler/components/09-po-sheet.ts`), COGS reset (`routes.ts:4186-4192`, single ASIN). `PUT /api/asins/:asin/cogs` ignores `actual_cogs` (`routes.ts:4141-4147`).
- **Where `cost_per_unit` comes from**: sheet import/sync → col Y "Adjusted COGS" (`COL.adjCogs = 24`, `server/po-import-classify.ts:20`; `server/po-sheet-sync.ts:525, 811`), never col AR; New PO form → the override or `costPerUnitPrefill` (item 2). Col AR (index 43) and AQ (42) are not read anywhere today.
- **Update COGS in SC** (`POST /api/export/sourcing-cost`, button at `client/src/pages/home.tsx:1738`): `buildSourcingCost` (`server/sourcing-cost.ts:171-192`) writes "Seller New Cost" = `round2(actual_cogs)` for ASINs purchased in the date range **only where `cogs_source = 'po_sheet'`**; skips an approved-equal cost and never lowers an approved cost. No prep. (P4.)
- **Push to Aura** (`POST /api/sync/aura/push` → `runAuraSyncChain`): cost half = `runSheetsSync` scoped, then `resolveCostsBySku` (`server/aura-cost-sync.ts:106-124`) → `computedCost = round((actual_cogs + prep_override) × 100)` cents (`:168`); NULL `actual_cogs` → `SKIP:null_cogs`, ≤ 0 → `SKIP:zero_cost`. So Aura gets COGS **plus prep**, SC gets COGS without prep.

## 5. Orders sheet cols X/Y — what the values prove (150 newest rows, mirror values)

Headers (0-based index → letter): K Product Price, L Product Qty Ordered, N Total ASIN Qty per Order, S Unique Products per ASIN, T ASIN Qty Per Product, U ASIN Qty per Row, X Adjusted Product Cost, Y Adjusted COGS, Z Total Adjusted ASIN Cost per Order, AA … per Row, AB Order Subtotal, AC Tax, AD S&H + Donations, AE Discount, AF Refund Amount, AG Order Total, AH Order Total (no duplicates), AJ Weighted Gift Card Discount (%) (a fraction in the sheet: 0.05; AF stores 5.00), AQ Product Cost, AR COGS, AS Prep cost, AW COGS with Prep.

Exact (within $0.005) on every row:

| Relation | Match |
|---|---|
| `X = AQ × (1 − AJ)` | 150/150 |
| `Y = AR × (1 − AJ)` | 150/150 |
| `AA = Y × U` | 149/149 |
| `AW = Y + AS` | 150/150 |
| `AR = Σ over the ASIN's rows in the order (AQ_i × L_i) ÷ N` | 143/149 single-row form `AQ × L ÷ N`; the 6 misses are S > 1 rows whose siblings I cannot see per row — the bundle examples reconstruct exactly (5.87 × 12 + 31.70 × 12) ÷ 12 = 37.57 |

Not exact: **AQ "Product Cost"**. `AQ = K × AG ÷ AB` fits 110/150 (73.3 %, the same ceiling as formula v1); adding `AG ÷ L` as an alternative reaches 119/149. The 40 misses have AQ/K at round per-row fractions (0.75, 0.85, 0.80, 0.70, 0.6667, 0.50, 1.25) with AE = 0 or an AE that is not the proportional share — i.e. AQ is the **price actually paid per product after an item-level sale/coupon**, keyed or formula'd per row by the VA, not derivable from the header totals. So: tax, S&H and the order-level discount are **not** allocated proportionally onto X in a way the values confirm (AC > 0 on 1 row, AD > 0 on 8, AE > 0 on 74 of 150); the gift-card discount is a flat `× (1 − AJ)`; prep is added after. The pure function for commit 2 is therefore: per product `paid = unit price paid (AQ)`; per ASIN `sourcing = Σ(paid_i × qty_i) ÷ asinQty` (AR); `cogs = sourcing × (1 − gc)` (Y); `cogs_with_prep = cogs + prep` (AW) — the capture supplies `paid` directly from the checkout line, which removes the one input the sheet leaves to the VA. Whether the source sheet's X/Y cells also add tax/shipping terms that happened to be zero in this sample can only be read from the formulas (P1). `shared/po-cost.ts` already has this shape (`Σ adjusted × qty ÷ Ordered`); its `price × (orderTotal ÷ subtotal)` term is the AQ approximation to replace.

## 6. Mailbox

104 POs dated 2026-10-09 … 10-23 checked against `orders@` by order number: **104/104 have retailer mail** (87 matched a confirmation subject on the first pass; the 17 "misses" were my subject filter). Formats to carry into the §6.7 reconcile: Walmart confirmations are "Thanks for your delivery order, Maria" with the order number only in the body as `2000152-48695719` (AF stores `200015248695719`; `normOrder` in `server/order-number.ts` already strips the dash); JCPenney "Thank you for your JCPenney.com order #2026-2846-1345-0906" (4-4-4-4); Bed Bath & Beyond "Your Bed Bath & Beyond order is confirmed." (number in body only); Target "Thanks for shopping with us! Here's your order #…"; Michaels "We've received your order!"; Shopify stores "Order #N confirmed". Subscription renewals exist as mail ("Confirmed! Your subscription has been renewed", drmartypets.com).

## 7. Payment method today (`purchase_orders.payment_method`)

2,494 POs, 222 distinct values, 9 blank. Shapes: 1,197 single name only ("Gift cards" 893, "Webstaurant Visa" 180, "Discover" 71, "Walmart card" 53); 1,067 `Name (1234)`; 185 multi-payment `Name: $amt, Name: $amt` (sum should equal order total — a 2-pass regex parses them); 7 "(through PayPal)"; 29 other free text ("Gift cards: 7204, 9283, 7246", "Rewards balance (from returns)", "Check after it's processed…"). Card nickname + last4 seen: Amex 1001/1002/1005/1008, Amex Plus 1005, Chase 7927/9647/6120, Chase Ink 7927, Chase Ink Cash 6120, Citi 9510/9627, CapitalOne 6830, Visa 7927/9647, plus "Chase (6210)" ×2 (likely a 6120 typo). Backfill plan for §8.2: name-only → one row (`gift_card` for "Gift card(s)", `card` without last4 for the named cards, `other` for Rewards/Walmart balance/Refund credit); `Name (1234)` → `card` nickname + last4; multi → one row per part with amount; the 29 others → one `other` row holding the text, flagged for review. Promo (§8.4) backfill rule proposed: /reward/ → `rewards`; /coupon|code|with [A-Z0-9]{4,}/ → `coupon` (most entries are "30% off with COMEBACK47Z5"); else `sale` — the patch's "keyword else sale" would file those codes as sale. Refund (§8.3) backfill sizes: 150 POs with `refund_amount > 0` — 77 single-line (attach), 73 multi-line (`needs_split`); 43 lines with `qty_returned > 0`. Subscriptions (§9): 48 POs flagged. Cashback sites: TopCashback 349, BeFrugal 292, Rakuten 57, RetailMeNot 18, Coupert 7.

## Other facts the patch relies on

- §4.4 addresses: `settings` `tracking.velocity_street` = "805 grandy"; `tracking.home_streets` default `["65 rivercrest"]` (`server/tracking-push.ts:175-177`, `normalizeStreet` in `server/tracking-parse.ts:53`). Velocity prep rate: `settings.prep_cost` = 1.00.
- §4.1 supplier from hostname: `supplier_aliases` has 0 rows; AF's supplier **is** the domain (354 distinct, one non-domain "RA: Food Lion"), subdomain kept where the store lives there ("shop.tetleyusa.com", "us.typology.com"). Hostname → supplier = strip "www." then look up `purchase_orders.supplier`; `resolveRetailer` (`server/supplier-aliases.ts`) covers the alias/equality step.
- `ANTHROPIC_API_KEY` is already an optional env var (tracking AI fallback, SPEC §26); no `server/config/ai.ts` exists yet.
- Latest migration: `074_po_line_action_items.sql`; the patch's migration is 075.
- `source` values: `sheet_import` (import + Sync POs), `manual` (form). `po_edit_log` (id, po_id, user_id, entity, entity_id, field, old_value, new_value, at) is the History table.

## Item 5, resolved 2026-10-31: the source sheet's formulas (read-only)

Maria shared the source spreadsheet (`💵 Orders`, tab `Orders`, 4,134 data rows) with the service account; the formulas were read with `valueRenderOption: FORMULA`. **Nothing was recomputed or changed** — this section records what the cells hold. The per-order variation below is by design (Maria adjusts X/Y per order); the "review list" at the end names rows that look like clear errors, for Maria's review only.

**Every derived column is one formula, sheet-wide:** `N = L × T` (3,745; 223 typed), `U = N ÷ S` (4,128), `Z = Y × N` (4,133), `AA = Z ÷ S` (4,133), `AW = Y + AS` (4,134), `AZ = AY × N` (696 — AX/AY are filled on 2026 rows only), **`AQ = X ÷ (1 − AJ)` (4,125) and `AR = Y ÷ (1 − AJ)` (4,125)** — so "Product Cost" and "COGS" are derived *back* from the adjusted columns, never keyed: AR is Y before the gift-card discount (confirmed on 3,940 of 3,946 rows with values; the 6 others are #DIV/0! rows). `AJ` is typed (1,698) or `=<gift-card savings>/AG` (183 shapes, e.g. `=(46*0.06+87*0.07+151.98*0.1596)/AG`).

**X "Adjusted Product Cost" is a per-order formula (161 shapes; 159 typed):**

| Shape | Rows | Reading |
|---|---|---|
| `=K×(1−AJ)` | 1,115 | list price × gift-card factor; no discount / tax / shipping |
| `=AG÷L×(1−AJ)` / `=AG÷L` / `=(AH÷L)×(1−AJ)` / `=(AG÷L)×(1−AJ)` | 433 / 427 / 82 / 49 | single-product orders: the order **total** ÷ qty — which does fold tax, shipping and the discount into the unit cost |
| `=K×(1−AJ)×(1−AE÷AB)` and the `(1−AE/AB)` family | 351 + 61 + 52 + 49 + 33 + 13 | order-level discount allocated pro rata |
| `… ×(1+AD÷AB)` / `×(1+AC÷AB)` / `×1.06` / `×1.07` | 170 / 61 / 37 / 29 + 27 + 25 + 17 + 14 | shipping or tax **added** pro rata or as a flat 6–7 % |
| `=K` | 226 | list price as is (gift-card factor not applied — 3 of these have AJ > 0, see the review list) |
| `=K×0.85` / `×0.8` / `×0.7` / `×0.9` / `×0.5…` / `×2/3` | 47 / 30 / 23 / 14 / … / 13 | a per-row item-level sale keyed by the VA |

**Y "Adjusted COGS"** is `=X ÷ T` on 3,847 rows (51 typed); the 13 other shapes are per-row adjustments: `=X/T×S` (17, bundles), `=X/T+X/T` (12), `=X+X` (10), `=X+X+X` (6), `=X×2+X` (4), `=X/T×3` (3), `=X/T+X` (2), `=(X/T)×(8/15)+(X/T)×(7/15)` (2), `=(AG+AG)/(L+L)` (2), `=X/T+3` (1, "prep materials"), `=1.25×6` (1).

So the historical allocation is *not* one rule — tax and shipping are allocated on roughly a third of rows (the AG÷L and ×1.07 families) and not on the rest — which is why no single function matched more than 73.7 % and why Maria's 2026-10-31 instruction stands: **historical values stay exactly as imported (never recomputed); new POs use the §7.1 rule as corrected** (AQ = the captured per-item price actually paid, item-level promos in it; promos with `counts_toward_cogs = false` added back; tax and shipping never allocated).

**AF vs the sheet.** AF's `po_asins.cost_per_unit` matches the sheet's Y on 3,814 of 3,865 ASIN rows found in the sheet (34 AF rows are not in the sheet — the pre-2026 merges). 42 of the 51 differences are the importer's cent rounding (10.985 → 10.99). The 9 that differ by more than two cents are in `docs/po-cogs-af-vs-sheet-2026-10-31.csv` — the sheet was edited after the import, or AF was (e.g. walmart.com 200015550741831 B07GLVS7FV: sheet 16.92, AF 79.44). Not changed; Maria decides which side is right.

**Review list — `docs/po-cogs-review-2026-10-31.csv` (67 rows, non-canceled only).** Each row: sheet row, order #, date, supplier, ASIN, status, K, AJ, the X and Y formulas and values, AR, AF's cost / unit, and why it looks wrong:

| Why | Rows |
|---|---|
| X formula ignores the gift-card % although AJ > 0 (e.g. `=K×0.85`, `=AG/L` with AJ = 0.07) → COGS overstated by the GC % | 33 |
| `=K` list price with AJ > 0 | 3 |
| X > 1.5 × the product price (bundle sums `=(K65*5+K66)*0.7` keyed on one row, `=K*1.07*0.8*(1-AJ)*2`) — may be intended; listed so Maria can confirm | 16 |
| Y shows `#DIV/0!` (T = 0 or blank) — AF holds NULL cost for these | 12 |
| Y ≤ 0 with a product price > 0 | 5 |

Nothing changes without Maria's say-so. The AI-prefill patch does not touch any of these rows.

**Superseded 2026-11-01 (Maria, review answer 4).** The two lists above
(`po-cogs-review-2026-10-31.csv`, `po-cogs-af-vs-sheet-2026-10-31.csv`)
compared the stale local database against per-row sheet cells, and AF's
PO-level cost — the N-weighted average over an S=1 merge, the bundle sum —
is correct where they said "wrong". Both are deleted. The one list that
replaces them is built against production by `npm run po:cogs-review --
--prod`: per sheet-imported ASIN row, AF's cost vs the sheet's PO-level
Adjusted COGS computed AF's way (Σ col X × col L ÷ col N, bundle-aware,
`server/po-cogs-review.ts`), rows Maria already answered excluded, and —
when more than 10 differ — one Haiku pass over each row's sheet context
answering "is AF's value explainable from these rows?"; only the "no" rows
reach `docs/po-cogs-review-<date>.csv`, with the reason.
