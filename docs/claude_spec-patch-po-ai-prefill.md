# SPEC Patch — Capture PO: AI-prefilled New PO from the retailer checkout, and the PO data model that replaces the Orders sheet

*Drafted 2026-10-30 with Maria. Amends §11 (extension, sync rules), §14 (ownership), §22 (PO module), §26 (email ingestion); adds §27 (Subscriptions). Mockup: canvas "Capture PO mockup" (side panel + prefilled New PO form).*

> **Status: APPROVED 2026-10-30.** Implementation order: commit 0 probe → stop → commits 1–9. After this patch ships, the Orders sheet is no longer a PO record source (follow-on patch, §10).
>
> **Amendment 2026-11-01 (Maria, after the local SC-switch dry run — 423 of 830 ASINs would have changed):** item 4's switch is **scoped to v2 POs only**. Update COGS in SC sends `sourcing_cost` for an ASIN whose newest non-canceled PO was created by this patch forward (cost formula v2 / source `extension` / `email_renewal`); every other ASIN keeps sending `actual_cogs`. The backfilled col AR on sheet-imported rows stays stored and is never submitted. Production scripts take `--prod` (`script/env.ts`, `.env.production.local`).
>
> **Amendments after the probe (Maria, 2026-10-31; probe report `docs/po-ai-prefill-probe-2026-10-30.md`):**
> 1. The source sheet was shared; X/Y/AQ/AR formulas read for understanding only (they vary per order by design). **No historical COGS / AQ / AR / Y value is ever recomputed or changed.** Clear-looking errors go on a review list for Maria. §7.1 corrected for new POs: AQ = captured per-item paid price; non-counting promos added back; tax and shipping never allocated.
> 2. §8.1: no `_cents` twins — the existing dollar columns stay; add `purchased_by_user_id` (nullable) and widen `source` to `sheet_import | manual | extension | email_renewal`. "Anna" keeps the text with a NULL id.
> 3. `asins.sold_as` and `asins.units_per_pack` are added, backfilled from the sheet's AX/AY as imported on `po_asins` (2026 rows), newest non-canceled row first; an ASIN whose rows disagree, or with AX/AY blank on every row, stays NULL and goes to `docs/pack-size-gaps-2026-10-31.csv` for Maria. §6.4/§6.5 read and write these fields.
> 4. Update COGS in SC switches to the AR value (Sourcing cost). Production dry run first; STOP until Maria has seen the changed-SKU list (count, min / median / max delta).
> 5. Extension auth: `credentials: "include"` on its fetches plus the production host in `host_permissions`; verified against a logged-in Chrome in commit 5.
>    **2026-11-01 (review answer 7): the logged-in-Chrome check is the LAST step of the rollout — after the deploy, with Maria signed in to production in Chrome: load the unpacked extension, set the server URL to production, capture a checkout page, Open in AF → `/pos/new?prefill=<id>` must answer with the session cookie (no 401).**
> 6. Promo backfill (col AK → `po_promos`) replaces §8.4's keyword rule: one Haiku batch call over the DISTINCT non-empty AK values → type (sale | coupon | rewards), normalized description, amount or percent when stated, confidence. Rules: a code with a discount → coupon; rewards / points / store credit earned → rewards; site-wide or category sales, clearance, B1G1 → sale; **michaels.com exception**: site-wide 20–40 % sales that require a displayed code are SALE, description "<N>% on regular priced items". Raw AK text kept in `po_promos.raw_text`; high-confidence results applied; low-confidence rows go to `docs/promo-classification-review-2026-10-31.csv` with type NULL for Maria. The same classifier runs on each new captured PO's promo lines. The backfill call is logged in `po_prefill_log` with `kind = backfill`.

## 1. Why

Recording POs while buying costs Maria real time, and the Orders sheet is the last place PO data is still entered by hand. After this patch the only two ways a PO enters AF are the Chrome extension's **Capture PO** (prefilled from the retailer's checkout pages) and AF's **New PO** form. The patch also brings over every Orders-sheet field that AF still lacks, so the sheet can be retired.

Decisions (Maria, 2026-10-30):

- Capture PO goes into the **existing** extension now, not the rebuild.
- **No draft PO.** The extension opens the New PO form with the fields in the URL state. Nothing is stored until Save.
- Capture is **cumulative across checkout pages** (cart, shipping, payment, review); one Claude call (Haiku-class) runs when Maria clicks **Open in AF**, never per page.
- Card and gift-card numbers are **masked in the extension** before anything leaves the browser (§4.3). AF stores last 4 + nickname only.
- **ASIN** may be prefilled by the model's best guess, ranked below AF's own history matches; Maria confirms or changes it (§6.4).
- If AF knows the ASIN, AF's title / SKU / pack type / units per pack win; if not, the model prefills them and Maria overrides.
- A pack-size change on the form is **This PO only** by default, with an explicit **Update ASIN in AF** choice (§6.5).
- Three costs per ASIN row: **COGS** (normalized), **Paid cost** (actual cash), **Sourcing cost** (col AR, pushed to Seller Central) — §7.
- Discount rules for COGS: gift-card discount, sale and coupon **always count**; **rewards default off** (per-promo toggle); cashback **never** (§7.2). Trigger: Michaels rewards applied to a small PO set COGS at $5 for a $10 item.
- Promos are **multiple per PO** with type / description / amount; if this proves too tedious, fall back to one text field.
- Refunds are tracked **per supplier line**, not per PO.
- Subscriptions: AF creates renewal POs from the confirmation email, raises a review action item, alerts 7 days before the next order, and gets its own **Subscriptions** page.
- `ANTHROPIC_API_KEY` as a Render env var; model pinned by name in config; one call per capture; cost logged per PO.

## 2. Scope

In: extension capture flow; `/api/pos/prefill`; New PO form prefill + URL state; PO data model additions (§7–§8); ASIN picker; pack-size override semantics; subscriptions (§9); confirmation-email reconcile; probe commit.
Out (follow-ons): Orders-sheet retirement (§10), PO documents patch (uses `rcpt`-derived state), cancellations patch (already drafted; uses the per-line refund table from §8.3 — amend it to write there).

## 3. Commit 0 — probe (read-only, report, then stop)

Report before building anything:

1. **Extension**: current manifest version, permissions, side-panel entry point, how it authenticates to AF (session cookie? token?), existing message passing between content script and panel, and whether it already reads page text anywhere.
2. **New PO form**: file(s), every field it has today, the cost-per-unit prefill formula, the calculator component, how decimals and partial units are handled, and how a saved PO is written (route + tables).
3. **ASINs page pack fields**: what pack type / units per pack are called (`sold_as`, `units_per_pack` or otherwise), whether they are inline-editable, and what reads them (Velocity upload, shipment matcher, New PO form).
4. **Costs**: where `actual_cogs` comes from on a PO save and on Sync POs (col Y "Adjusted COGS" or AR "COGS"); what **Update COGS in SC** sends today; what Push to Aura sends.
5. **Orders sheet cols X/Y formulas** (read the live sheet via the service account, formulas not values): the exact allocation of discount, tax, S&H and gift-card discount into Adjusted Product Cost / Adjusted COGS. Reproduce in a pure function and confirm against ≥ 50 recent rows (target: exact match, not 73.7%).
6. **Mailbox**: confirm all retailer confirmation emails for recent POs arrive in orders@ (Maria: everything is forwarded there).
7. **Payment method today**: what `purchase_orders.payment_method` holds (free text like "CapitalOne (6830)"?) and how many distinct values exist — this seeds §8.2's payment methods list.

## 4. Extension — Capture PO

### 4.1 Panel UI (side panel, warm stone, no loud chips)

- Header: retailer (hostname → supplier via the alias map; unknown hostname shows the hostname and a "new supplier" note), order # once a captured page contains one, ship-to street once seen → **Home / Velocity** badge (§4.4).
- Capture chips **Cart · Shipping · Payment · Review** — hints only; each ticks when any page is captured while that chip is "current" (the extension guesses the step from URL/page headings; Maria can capture any page any number of times; the latest capture of a step replaces the previous one).
- **Capture this page** button. Status line: "N pages captured · card numbers masked before anything leaves the browser".
- **Found so far**, with no AI: a text-only pre-extraction of what it can see cheaply (line count, ship-to street, subtotal / discount / tax / shipping / total, payment lines) so Maria can tell the capture worked. Regex-level only; anything unclear is simply not shown here.
- Footer: **Open in AF** (primary) and **Clear**. Caption: "One AI call runs when you open it".

### 4.2 What is captured

Per page: `document.title`, URL (query string stripped), the page's rendered text (`innerText` of `body`, with hidden elements excluded), plus the current values of `input`, `select` and `textarea` elements and their labels (visible text misses them: quantity inputs, selected shipping option). Never raw HTML, never screenshots. Stored in `chrome.storage.session` keyed by tab id; cleared on Clear, on Open in AF success, or when the tab closes.

Screenshot fallback: only when a captured page yields fewer than ~200 characters of text (canvas/iframe checkout). The panel then offers "Capture as image" and shows the image before it is included. Not in v1 unless the probe finds a retailer that needs it.

### 4.3 Scrubbing (in the extension, before any network call)

Applied to every captured text and field value:

- Any run of 13–19 digits (spaces/dashes allowed) that passes Luhn → `••••` + last 4.
- 3–4 digit value whose label matches /cvv|cvc|security code/i → removed.
- Expiry patterns (`MM/YY`, `MM/YYYY`) within 40 chars of /exp|valid/i → removed.
- Gift-card / e-gift numbers (label match /gift card|egift|gift certificate/i) → last 4 kept.
- Email addresses other than Maria's known ones → kept (needed for "email used"); passwords: any `input[type=password]` is never read.

Unit tests with synthetic checkout text for Walmart, Michaels, Bed Bath & Beyond, Lakeshore, Webstaurant (fixtures written by hand; no real card data in the repo).

### 4.4 Ship-to → `ships_to` / prep

- Street "805 Grandy" → Velocity, prep $1.00 (the configured Velocity prep rate).
- Street "65 Rivercrest" → Home, prep $0.
- Anything else or none → blank; the form requires Ships to before Save.
Addresses come from the same constants the tracking router uses (§26) — no second copy.

### 4.5 Open in AF

`POST /api/pos/prefill` with `{ retailerHost, pages: [{step, url, title, text, fields}] }` (scrubbed). Response is the prefill object (§5). The extension opens `/pos/new?prefill=<id>` where `<id>` is a 10-minute server-side cache key (the payload can exceed URL limits; the cache is in-memory, not a table — this is not a draft). If the server is unreachable, the panel says so and keeps the capture.

## 5. Server — `/api/pos/prefill`

- Auth: the extension's session (probe 3.1 says how).
- One Claude call (Haiku-class; model id and `max_tokens` in `server/config/ai.ts`; `ANTHROPIC_API_KEY` from env). Prompt = the merged page texts + a strict JSON schema for the response: retailer, order id, order date, lines `[{productName, retailerSku, qty, unitsPerPack, unitPrice, lineTotal, asinGuess}]`, subtotal, discount, tax, shipping, total, promos `[{type, description, amount}]`, payments `[{method, nickname, last4, amount}]`, shipTo street, subscription `{present, frequencyWeeks}`, purchasedEmail, confidence notes. Temperature 0. Response validated with zod; a schema failure returns the raw-text fallback (form opens empty with the captured text in a side drawer so Maria can copy from it).
- Server-side enrichment, no AI: supplier via alias map; `ships_to`/prep via §4.4; ASIN candidates per line via §6.4; totals cross-check (lines sum vs subtotal, payments sum vs total) → warnings on the form.
- Logging: `po_prefill_log` (id, created_at, user, retailer, model, input chars, output tokens, cost estimate, duration, schema ok, po_id once saved). Nothing from the page text is stored here.

## 6. New PO form — behaviour

### 6.1 Prefill markers
Every field shows where its value came from: **amber** = model (from captured pages), **stone** = AF database (set once an ASIN is chosen), none = typed by Maria. Banner: "Prefilled from <supplier> · N pages captured <time>", plus warnings (totals don't add up, ship-to unknown, ASIN not in AF).

### 6.2 Order fields
Supplier, Order #, Order date, Ships to, Prep cost/unit, Subtotal, **Discount**, **Tax**, **Shipping** (S&H + donations), Order total, Purchased by (= logged-in user; editable), Email used, Subscription (§9), PO notes. Tax and Shipping are separate fields (Maria 2026-10-30).

### 6.3 Lines
Retailer line as bought: product name, retailer SKU, Qty, **Units/pack** (retailer pack, e.g. 12), unit price, line total. Beneath, one or more ASIN rows (bundle = several retailer lines → one ASIN row; split = one retailer line → several ASIN rows; "+ Add ASIN to this line"). Per-line notes field. Per-line refund entries (§8.3) are added later from the PO editor, not the New PO form.

### 6.4 ASIN picker
Type-ahead over AF's asins table by ASIN, title, SKU, brand. Suggestion order before typing:
1. ASINs on past PO lines from the same supplier whose product name matches this line's product name (exact, then normalized token match) — history wins.
2. AF title-word matches.
3. The model's `asinGuess` (amber-marked).
The top suggestion is prefilled; the field stays editable; an ASIN not in AF shows "Not in AF — Add to AF" which runs the normal onboarding refresh for that ASIN and then fills the row. Pack type / units per pack / title / SKU come from AF when known (stone), else from the model (amber).

### 6.5 Quantities, costs, pack override
- ASIN qty = retailer qty × retailer units/pack ÷ ASIN units/pack; shown as a math line; both Units/pack fields and ASIN qty editable; decimals allowed (SPEC rule).
- COGS / ASIN unit per §7, shown with the allocation math and the adjustment.
- **COGS adjustment** per ASIN row: amount + reason (e.g. "prep materials $3"). Replaces today's note-only practice.
- Changing an ASIN row's Units/pack when AF knows the ASIN shows: "Units/pack changed from AF's X to Y. Apply to: ( ) This PO only (default) ( ) Update ASIN in AF". The second writes the ASIN's pack fields with a History row, recomputes open POs' ASIN qty / COGS / On Order / At Prep, and raises "pack size mismatch" on any open PO whose Velocity order was created with the old size. Closed POs are untouched.

### 6.6 Save
Writes `purchase_orders`, `po_asins`, `po_line_items`, `po_promos`, `po_payments`, optional `subscriptions`; History rows; `po_prefill_log.po_id`. Order # + supplier must be unique (base id); duplicate → error naming the existing PO. Sync POs (while it still exists) skips any order # already in AF.

### 6.7 Confirmation-email reconcile (no AI)
When the order-confirmation email for an AF PO arrives (matched on order #), compare order #, total and line count; on a difference raise action item **Confirm order details** with the diff. Nothing is written to the PO.

## 7. Costs

### 7.1 Three costs per ASIN row (corrected 2026-10-31, Maria — applies to NEW POs only)
- **AQ, the per-product paid price** = the captured per-item price actually paid (item-level promos are already in it). Promos with `counts_toward_cogs = false` (rewards, by default) are **added back** onto it, pro rata over the order subtotal. **Tax and shipping are never allocated into cost.** The order-level discount (header Discount) is allocated pro rata the same way, minus the non-counting promos' amounts.
- **Sourcing cost** (col AR) per ASIN unit = Σ(AQ × product qty) ÷ ASIN qty — COGS before the gift-card discount, promos applied. This is what **Update COGS in SC** sends (confirmed 2026-10-31: the gift-card discount is financing, not product cost; dry-run on production first, STOP until Maria has seen the changed-SKU list).
- **COGS** (col Y) = Sourcing cost × (1 − weighted gift-card %) **+ adjustment**. Feeds profitability, Aura push, repricing. This is what `actual_cogs` is (`po_asins.cost_per_unit`).
- **Paid cost** = the same allocation with **every** discount counted (rewards too) × (1 − gift-card %). Unused today; for the sales/profit dashboard.
- Historical rows: COGS = col Y and Sourcing cost = col AR **exactly as imported from the sheet — never recomputed, never changed** (Maria 2026-10-31; the formulas vary per order by design, see the probe doc). Paid cost = COGS for imported rows (accepted). Rows that look like clear errors are listed in `docs/po-cogs-review-2026-10-31.csv` for Maria; nothing changes without her say-so.

### 7.2 What counts toward COGS
| Source | Default |
|---|---|
| Gift-card discount (payment-level %) | always counts |
| Promo type `sale` | counts (toggle) |
| Promo type `coupon` | counts (toggle) |
| Promo type `rewards` | **does not** count (toggle) |
| Cashback | never |

## 8. Data model additions (one migration)

### 8.1 `purchase_orders`
`discount_cents`, `tax_cents`, `shipping_cents` (separate; S&H + donations), `purchased_by_user_id`, `email_used`, `cashback_site`, `cashback_pct`, `cashback_status` (`pending|received|denied|null`), `notes` (if not present), `source` (`extension|form|sheet|email_renewal`). Drop nothing yet.

### 8.2 `po_payments`
`id, po_id, method (card|gift_card|store_credit|paypal|other), nickname, last4, amount_cents, gift_card_discount_pct (nullable)`. Several per PO; sum should equal order total (warning, not a constraint). `purchase_orders.payment_method` is backfilled into one row per PO (parse "Name (1234)" → nickname + last4) and kept until the sheet retirement patch removes it.

### 8.3 `po_line_refunds`
`id, po_line_item_id, qty, amount_cents, refunded_at, method (same enum as payments) , nickname, last4, source (manual|email), email_message_id, note`. The cancellations patch writes here instead of a PO-level refund triple. Col AF "Refund Amount" (PO-level) and col R "Product Qty Refunded" backfill: when a PO has exactly one line, attach to it; otherwise create one PO-level placeholder row (line NULL allowed) flagged `needs_split`.

### 8.4 `po_promos`
`id, po_id, type (sale|coupon|rewards), description, amount_cents, counts_toward_cogs bool (default per §7.2)`. Col AK backfill: one promo per PO, type guessed from the text ("coupon"/"sale"/"rewards" keyword, else `sale`), amount NULL.

### 8.5 `po_asins`
`cogs_adjustment_cents`, `cogs_adjustment_reason`, `sourcing_cost_cents`, `paid_cost_cents`, `notes`; `po_line_items.notes`.

### 8.6 `po_prefill_log` (§5), `subscriptions` (§9).

Tri-state discipline: NULL = not recorded; never default money to 0 on import.

## 9. Subscriptions (§27)

- `subscriptions`: `id, supplier_id, asin_row_ref (po_asin_id of the originating PO), frequency_weeks, next_order_date, status (active|paused|canceled), last_po_id, created_from (capture|manual|email)`.
- Capture sets one when the checkout text shows a subscription and its frequency; the form shows Subscription: Yes · every N weeks.
- 00:00 pass: for each active subscription with `next_order_date − 7 days ≤ today`, raise action item **Subscription renews** on the last PO (clears when a renewal PO is created or the subscription is canceled/paused).
- Renewal emails: an order-confirmation email whose supplier + product lines match an active subscription creates a new PO (`source = email_renewal`, lines copied from the last PO with the email's quantities/prices, payments from the email where present) with action item **Review renewal PO**; advances `next_order_date`.
- **Subscriptions page** (nav, after POs): table of all subscriptions — supplier, product/ASIN, frequency, next order, status, last PO — inline edit of frequency / next date / status, link to POs. Quiet chrome, same table conventions as POs (sortable, resizable via the shared hook).

## 10. Follow-on: Orders-sheet retirement (separate patch, after this ships)

Every remaining Orders-sheet reader, to be inventoried by its probe: Sync POs intake (retire), the prep-drift apply (retire), Push to Aura's PO-sheet read for the selection, the hourly PO-sheet COGS component, Export SB COGS, Col P as the shipment matcher's backup signal, the §11 PO mirror sheet. Also: import the **Missing Orders** tab (14 rows) as POs with action items, or confirm they are handled. Dead Pile / Lost Box / Supplies tabs are out of PO scope (Dead Pile → backlog).

## 11. Tests

Scrubber fixtures (§4.3); prefill schema validation and raw-text fallback; allocation function vs sheet rows (probe 5); ASIN suggestion ranking (history beats title beats model); pack override both branches incl. open-PO recompute and mismatch flag; payments/promos/refunds CRUD and COGS recompute when `counts_toward_cogs` flips; subscription alert timing and renewal-PO creation from a fixture email; duplicate order # rejection; Sync POs skip of AF-owned order #s. Route registration test updated.

## 12. Commits

0. Probe (§3) — report, stop.
1. Migration + model (§8, §9 tables), backfills with dry run, SPEC §22 data model.
2. Costs: allocation function from the probe, three costs, adjustment, promo toggles; `actual_cogs` → COGS; Update COGS in SC → Sourcing cost (probe-confirmed).
3. New PO form: new fields, lines with Units/pack both levels, ASIN picker with history ranking, pack override dialog, payments/promos/cashback blocks, markers, URL-state prefill.
4. `/api/pos/prefill` + AI config + log; raw-text fallback.
5. Extension: capture, scrub, panel UI, Open in AF.
6. Confirmation-email reconcile + **Confirm order details** item.
7. Subscriptions: table, capture hook, alert, renewal-from-email, page.
8. PO editor: refunds per line, payments/promos editing (so existing POs can be completed).
9. SPEC §11/§14/§22/§26/§27, CLAUDE.md (ai config, extension dev steps), backlog update.

Stops: after commit 0; before commit 2 if the probe's col X/Y formula cannot be matched exactly (report the residual); otherwise run through and report once before pushing.
