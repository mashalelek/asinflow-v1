# SPEC Patch — Supplier claims: supplier problems, returns, cancellations

*Drafted 2026-11-05 with Maria (whiteboard walkthrough). Amends §22 (PO
module, incl. the "Supplier defects" section added by e424903 / migration
094), §26 (email ingestion), §11 (Velocity). Supersedes the data model,
review list and net-quantity readers of
`docs/claude_spec-patch-po-cancellations-from-email.md` (§3, §5, §6); that
patch's ingestion (§4) and backfill (§8) stay valid and feed this one. Also
supersedes the backlog's "Allocate to another PO" (2026-11-05) and its
"until built" workaround: see §3.8. Prerequisite:
`docs/claude_spec-patch-quantity-names.md` (ASIN / Product / Individual
units wording), run first.*

> **Status: APPROVED 2026-11-06. Amended 2026-11-07 and 2026-11-09**
> (Maria): tasks + buckets model, Claims nav tab, quantities from claims
> only, one 5-business-day timer, refunds table. Formerly "PO issues";
> the record is a **claim** everywhere (tables, code, UI, docs).

## 0. Change log

**2026-11-13 (Maria) — commit 7, returns (§3.12):** acceptance table and
mockups approved. The return's own tracking ticks Shipped and Delivered
(replaces the temporary auto-tick); a Return card on the claim; "Copy
message for Velocity"; home POs get Dropped off; a return-by date read
from the label email warns 3 days before it passes.

**2026-11-13 (Maria) — commit 6, supplier emails (§3.11):** acceptance
table and mockups approved. Every supplier reply lands in Needs attention
until read; an exact-match refund email sets the outcome and confirms by
itself; an email on a closed claim asks for review (feedback requests and
"case resolved" notices excepted); Maria's own email to a supplier records
Contacted supplier. Three task kinds added (`read_reply`,
`review_email_match`, `closed_claim_email`). v2, not built: AI drafts the
emails to suppliers, sent only after Maria approves each one.

**2026-11-09 (Maria):**
- **Every manual action is a task** with a checkbox, in one of five
  groups; a claim's **bucket is derived** from its open tasks and timers
  (§3.2). Thirteen task kinds (§3.3).
- **Claims is its own nav tab** for now (nav rearrangement comes later).
  POs list gets a **Claims** column (count → link); PO page gets a link
  and a small card; nothing in Action Items (§5).
- **One timer: 5 business days** everywhere (supplier reply, return
  delivered without refund, refund to post, Velocity). Replaces every
  "7 days" (D7).
- **Quantities come from claims only** (D14): `qty_canceled`,
  `qty_returned` and `final_qty` are dropped; existing values convert to
  closed claims. Expected = ordered − Σ claim qty (§3.6).
- **An open claim keeps its PO open** (D15); expected units still reflect
  the claim everywhere while the PO is open.
- **Claim qty is entered in Individual units** (D16); AF shows the Product
  and ASIN equivalents.
- **Refunds table per claim** (§3.5): many refunds per claim (Kohl's, two
  gift cards) and one refund across claims (Michaels). A short refund
  stays owed until Maria decides; nothing is written off on its own.
- Review fixes: Refunds due / Spend switch moves to commit 2; Target
  last-4 refund matching; whole-PO claims spread across lines;
  cancellation emails land as suggested claims; suggested / dismissed
  claims never count as owed; Gift Cards cross-reference.

**2026-11-07 (Maria, after the commit 0 probe):**
- Name: "claims" everywhere. Tables `supplier_claims`,
  `supplier_claim_tasks`, `supplier_claim_events`, `supplier_claim_refunds`.
- D10 replaced: no replacement POs; a reship order # becomes an alias on
  the original PO (`purchase_orders.alt_order_ids`, migration 086).
- Carrier tracking: **EasyPost** (§3.9), preceded by a tracking parser fix
  (§3.10).
- Legacy badges convert to claims (§4.8). `amount_owed` can be set by
  hand and then stays as typed (§3.7).
- Michaels 9800109062072825: the sheet's 11-unit / $32.25 loss is dropped,
  already refunded by the $36.11 eGift card.
- Probe corrections: cols V/W were imported (`po_asins.unreimbursed_loss_*`);
  AF has no carrier status; Velocity takes no qty PUT on received orders
  and has no DELETE; Walmart emails the return label PDF.

## 1. Why

Today a supplier problem is a badge plus a note. Refund-due rows hold the
same money a second time. Returns, replacements, expired and gated items,
and orders that never arrive have no record at all. Maria's process
(whiteboard, 2026-11-05) has three branches from a PO: **Received** with a
problem, **Canceled** (full or partial), **Charged, not received**. All
three end in the same place: the supplier refunds, replaces, gives credit,
or nothing happens and it's written off. AF holds that as one claim per
problem, does every step it can check itself, and puts every step only
Maria can do on one list with a checkbox.

## 2. Decisions

- **D1 — One record.** A claim carries the $ owed. Refund-due rows stop
  being a separate notion (§4.8).
- **D2 — Kinds:** `missing` · `damaged` (damaged or defective) ·
  `wrong_item` · `expired` (expired or short-dated) · `never_received`
  (whole shipment) · `cant_sell` (gated / hazmat / restricted; never a
  supplier defect) · `canceled` (full or partial) · `returned` (units sent
  back for a reason outside the other kinds; mostly sheet-era history).
- **D3 — One outcome per claim:** `refund_card` · `gift_card` ·
  `store_credit` · `replacement` · `write_off`.
- **D4 — Refunded items you keep are disposed.** Wrong items are returned
  or tossed. Expired items are returned or disposed. None become stock.
- **D5 — Returns:** Velocity ships them back with a label Maria sends on
  Discord. Walmart emails the label PDF; AF saves it from the email.
- **D6 — Refund has two ticks:** *Confirmed by supplier* (email, or by
  hand) and *Received* (Maria saw the money; always her tick, one tick per
  refund row). Until received in full, the remainder counts as owed.
- **D7 — One timer: 5 business days** (Maria 2026-11-09). Supplier hasn't
  answered; return delivered to supplier with no refund confirmation;
  refund confirmed but not posted; Velocity asked to do something and
  nothing changed. Every timeout becomes a *Check on it* task.
- **D8 — Velocity check-in lag:** "missing" is suggested only after every
  tracking number on the PO shows delivered (carrier status, §3.9),
  **3 business days** have passed since the last delivery, and Velocity's
  received count is below what shipped. Shipped qty per tracking row from
  the email when stated (`po_tracking.qty`), else all-delivered = ordered −
  canceled. Compare in **Individual units**; when the figures disagree,
  show both and the two possible causes (supplier shipped a single instead
  of the case, or Velocity's pack size is wrong).
- **D9 — Velocity can't take a note, a qty change on a received order, or
  a delete via API.** Those are tasks with a done tick.
- **D10 — Replacements stay on the original PO.** A reship with its own
  order # goes into `alt_order_ids`.
- **D11 — Write-off:** per-unit COGS unchanged; the $ goes to a **Supplier
  write-offs** line in the Cost of goods block.
- **D12 — Velocity return fees:** not in v1.
- **D13 — Discord:** manual in v1.
- **D14 — Quantities come from claims** (Maria 2026-11-09). No
  `qty_canceled` / `qty_returned` columns; expected units = ordered −
  Σ claim qty (§3.6). Nothing ever edits Ordered.
- **D15 — An open claim keeps its PO open** (Maria 2026-11-09). Auto-close
  = every unit accounted for **and** no open claim. Expected units reflect
  the claim everywhere while the PO is open.
- **D17 — Stored base is Individual units** (Maria 2026-11-09). Every PO
  quantity (ordered, received by Velocity, at prep, at warehouse,
  lost/damaged, shipped FBA, received by Amazon, claim qty, refund qty) is
  stored as an integer count of Individual units and converted on display
  (Product units on the Products tab, ASIN units on the ASINs tab and the
  ASINs page, with the individual count in pale grey under each number).
  Decimals then appear only in derived ASIN units and only when real
  (Caress: 5.5 ASIN units / 11 individual). Rows with no confirmed pack
  size can't convert: they keep their stored number, flagged "pack size
  missing" (already blocks auto-close) until Maria confirms the pack.
  **Bundle rows (amended 2026-11-09, SPEC §22 "Bundles", migration 100):**
  the conversion treats a bundle row by the bundle rule, never by × pack
  size — its Individual count = ASIN units × N (N = the bundle's total
  Individual units), and a component line's quantities convert by its own
  pack and its units per bundle (`po_line_items.units_per_bundle`); the
  ÷ `unique_products` reading of Canceled / Returned goes with this commit.
- **D16 — Everything Maria types is Individual units** (Maria 2026-11-09):
  claim qty, refund qty, Shipped by Supplier, At CQG Warehouse,
  Lost/damaged by us. AF shows the Product and ASIN equivalents beside the
  field. Ordered on a product line stays Product units; the ASINs tab
  stays ASIN units. Existing hand-entered values (stored as ASIN or
  Product units) convert in commit 1 with a dry run of every value;
  readers (On Order, auto-close, Velocity plan) keep working in ASIN units
  through the view. Wording per the quantity-names patch.

## 3. How a claim works

### 3.1 Found

| Kind | How |
|---|---|
| missing | AF suggests per D8, or Maria opens it from a line |
| damaged / wrong_item / expired / cant_sell | Maria, from Velocity's Discord message or her own check |
| never_received | AF suggests: **with tracking** — not delivered by the carrier's estimated date, or looks lost (exception / returned to sender / no scan 5 business days / in transit > 14 days with no scan in the last 3); **with nothing** — no tracking and no shipping email 14 days after the order date |
| canceled | Cancellation emails (cancellations patch §4 ingestion) land directly as **suggested** canceled claims with the email's items, qty and refund amount; or Maria opens one |

Suggested claims never change a PO until Maria opens them. Opening a
`canceled` claim reduces expected units at once (§3.6).

   **Built 2026-11-12 (commit 5; migration 106 `suggestion_key` (renumbered at merge: main had taken 105); not
   pushed).** `server/claim-suggestions.ts` (missing per D8, never_received
   (a) / (b), the one writer `suggestClaim`) and
   `server/cancellation-emails.ts` (classifier, forwarded headers, 18
   retailer parsers + a generic fallback, Haiku for free text from a known
   supplier, matching, the per-line / whole-PO claims), both run by
   component 30 every hourly pass; `npm run claims:suggest` is the dry run
   / backfill. Deviations and findings: (a) never_received (b) applies to
   orders since 2026-07-29 only — before the tracking window "no shipping
   email" is meaningless (the first local run flagged 70 pre-July POs);
   (b) the AI is asked only for a candidate from a KNOWN supplier (sender
   → domain map / aliases) — otherwise gift-card deliveries and newsletters
   that mention "cancellation" would be read for nothing; (c) a negated or
   future "canceled" ("cannot be canceled", "will be cancelled",
   "canceled your subscription") is not a candidate; (d) Walgreens'
   "adjusted and has shipped" is both a shipping email and a cancellation
   (its Canceled section, ~3K characters in); the combined Folgers order
   (email 5, line 3) is suggested with the quantity unknown and the figures
   in the reason; (e) a Michaels gift-card notice becomes a canceled
   suggestion with the credit as the amount and the quantity unknown; (f)
   BigBadToyStore prints no order # — matched by the item's words to the
   one open PO of the supplier; (g) Target prints the full order # in the
   body of the "ending in 3365" email, the last-4 rule is the fallback.
   Production dry run 2026-11-12: 20 missing · 10 never_received (3 lost
   in transit, 7 nothing after the order) · 28 canceled from 38 candidate
   emails (11 without a PO in AF, 3 for Haiku);
   `docs/claim-suggestions-dry-run-2026-11-12.csv`.

### 3.2 Tasks and buckets

Every action only Maria can do is a **task** on the claim (kind, group,
created_at, due_at, reason, done_at, done_by). A claim's **bucket** is
derived, never stored:

| Bucket | When | Leaves on its own when | Timer (5 business days) → task |
|---|---|---|---|
| **Needs attention** | Any open task | The task is ticked | — |
| **Waiting on supplier** | Reported, no answer; or supplier promised a refund / credit / replacement, no confirmation yet | A reply or refund / credit / replacement email attaches | *Follow up with supplier* |
| **Waiting on shipment** | Return on its way to the supplier; replacement on its way to Velocity or home | Carrier delivered; Velocity checks the replacement in | Return delivered + 5 bd, no refund confirmation → *Check on it*; replacement looks lost → *Check on it* |
| **Waiting on refund to post** | Supplier confirmed; not received in full | Received rows cover the full amount | *Check on it* ("refund not posted") |
| **Waiting on Velocity** | Label sent, return not shipped; dispose asked, count not down; order change asked | Return tracking scans; Velocity count drops; order changes | *Check on it* |

Plus **Closed** (refund received in full, replacement arrived, written off)
and **Dismissed** (suggestions Maria rejected; a toggle).

Precedence: an open task always wins; otherwise the bucket of the running
timer. Business days = Mon–Fri, America/New_York.

### 3.3 The thirteen task kinds, in five groups

| Group | Task | AF creates it when | Ticking it | Then |
|---|---|---|---|---|
| **Decide** | `review_suggestion` | AF suggests a claim | Opens or dismisses | → `contact_supplier` (emailed cancellation: → Waiting on supplier) |
| | `confirm_outcome` | A supplier reply attaches with a suggested outcome (Maria can set one any time) | Sets outcome | → that path |
| **Supplier** | `contact_supplier` | A claim is opened | Records date, channel, note | → Waiting on supplier |
| | `follow_up_supplier` | 5 bd with no reply | Resets the timer | → Waiting on supplier |
| | `confirm_reship_order` | A tracking / email with a new order # looks like the reship | Adds it to `alt_order_ids` | → Waiting on shipment |
| **Velocity** | `send_label` | A return label is saved (Velocity PO) | Marks sent | → Waiting on Velocity, then Waiting on shipment when the return scans |
| | `tell_velocity_replacement` | Outcome = replacement, Velocity PO | Marks told | → Waiting on shipment |
| | `dispose_units` (or return) | Refund / write-off on damaged / wrong / expired / can't sell with units at Velocity | Marks asked | → Waiting on Velocity; `qty_disposed` set when the count drops |
| | `update_velocity_order` | Expected qty changed on a fully received order, or an order should be deleted | Marks done | — |
| **Money and arrivals** | `refund_received` | Supplier confirms (email match or hand tick) | Adds a refund row (method, amount, date) | Full → Closed; short → Waiting on refund to post, "short by $X" |
| | `replacement_arrived` | Outcome = replacement on a home PO | Marks arrived | → Closed |
| | `upload_return_label` | Outcome needs a return and no label came by email | Saves label, reads tracking | → `send_label` |
| **Timed out** | `check_on_it` | Any timer runs out; `reason` names which | Snooze (restarts the timer) or jump to another task | — |

Actions that are not tasks: **Set outcome**, **Write off** (reason
required), **Write off remainder** (a short refund, when Maria decides),
**Reopen**, **Dismiss warning** (§3.8). Suggestions sit under *Decide*; if
they pile up, they get their own tab (decision deferred).

### 3.4 Paths (the checklist on the claim)

- **Refund / credit:** Found → Reported → *(Return: label → sent to Velocity → shipped → delivered)* → Confirmed by supplier → Received → Closed
- **Replacement:** Found → Reported → Promised → *(Tell Velocity)* → Shipped → Arrived → Closed
- **Write-off:** Found → Reported → Written off → *(Dispose)* → Closed
- **Emailed cancellation:** Found → Confirmed by supplier → Received → Closed (`contact_supplier` appears only if the refund times out)

Steps that don't apply to the path aren't shown.

### 3.5 Outcomes, refunds, replacements, returns

**Refund / credit.** Amount prefilled from the supplier email or $ owed.
*Confirmed by supplier* ticks itself when a refund / credit email matches:
order # (incl. `alt_order_ids`) + amount within 1¢; fallback for suppliers
that print only the last 4 of the order # (Target): supplier + last 4 +
amount + 30-day window → **suggested** match. Michaels refunds arrive as
"You received a gift card" (amount + order # in the body).
*Received* adds a row to the claim's **refunds table** (`po_line_refunds`,
status received, linked through `supplier_claim_refunds`): method prefilled
from the PO's payments, amount, date. Many rows per claim (Kohl's
6739984735: two gift cards, one refunded so far) and one row across
several claims (Michaels: one $36.11 card for three cancellations;
ticking Received on one claim offers the PO's other open claims).
**Remaining = owed − Σ received.** A short refund stays owed (Waiting on
refund to post, "short by $X") until Maria ticks another refund, contacts
the supplier, or chooses *Write off remainder*. Gift card / store credit
rows also record the card / credit name; when the Gift Cards module ships,
its "credit back to an existing card / new card" flow hooks on this row.

**Replacement.** Stays on the original PO (D10). The claim records
`replacement_qty`, `replacement_shipped_at`, `replacement_arrived_at`.
Same order # → its tracking matches the PO as usual, is linked to the claim
(`po_tracking.claim_id`) and pushes to the original Velocity order. New
order # → `confirm_reship_order` adds it to `alt_order_ids`. Closes when
Velocity's received count on the line covers what was ordered, or Maria
ticks `replacement_arrived` (home POs).

**Return.** Label from the supplier email (Walmart: PDF) or
`upload_return_label`; saved as a PO document `type = return_label`,
`claim_id` set, named `YYYY-MM-DD_supplier_POID_return-label.pdf` in the
Invoices month folder. Tracking # and carrier read by regex where the
format is unambiguous, Haiku otherwise; stored as `po_tracking` with
`direction = return`, `claim_id`, registered with EasyPost as a return.
Units returned leave expected quantities when the claim's outcome is set.

**Write-off.** Reason required. $ → Supplier write-offs (D11). `cant_sell`
write-offs are labeled "can't sell" in the breakdown.

**No "replacement from another PO"** (Maria 2026-11-06): units Velocity
counts under a different PO are an attribution mismatch (§3.8).

### 3.6 Quantities (D14)

- Stored on the claim: `qty` in **Individual units**; Product and ASIN
  equivalents derived from the line's pack sizes for display.
- **Expected units per line** = ordered − Σ qty of its claims that count:
  a `canceled` claim counts from the moment it is **opened**; every other
  kind counts once its **outcome** is refund / credit / write-off (a
  replacement keeps the units expected until it arrives; if it never does
  and the outcome changes, the units drop then). Suggested and dismissed
  claims never count.
- A **whole-PO claim** (`po_line_item_id` NULL: never_received, full
  cancel) spreads its qty and $ across the PO's lines in proportion to
  ordered qty for every reader below.
- **One derived value, one place:** a SQL view / helper
  `po_line_expected` (line, ordered / expected / received / at prep /
  shipped in Individual, Product and ASIN units from the stored
  Individual base (D17), Σ canceled, Σ claimed) replaces every read of
  `qty_canceled` / `qty_returned` and every per-reader ÷ pack size: On Order (`PIPELINE_ROWS_SQL`), auto-close, the Velocity
  plan (`loadAfPoRows`, net quantities), the PO editor's Canceled /
  Returned columns, the ASIN-row roll-ups. `final_qty` (030) is dropped;
  readers use the view.
- **Auto-close** (D15) = expected units all shipped FBA / at prep / at
  warehouse per the existing rule **and** no open claim on the PO.
- **Updating Velocity:** inbound (not fully received) order → the existing
  Qty-mismatch opt-in PUT on the next Upload to Velocity plan; fully
  received order, or a delete → `update_velocity_order` task (API has
  neither). Never automatic.
- Never derived from Received: the claim qty is what Maria or the email
  said, not Ordered − Received.

### 3.7 Money

- **$ owed** = claim qty (Individual units) × the line's **sourcing cost**
  per individual unit (paid incl. tax and shipping, after coupons / sales,
  before the gift-card / card-reward %). Whole-PO claim = the PO total
  share of the lines.
- **Manual override:** `amount_owed_source = auto | manual`; once manual,
  AF never recalculates it (same guard as `cogs_source`); "Reset to auto"
  brings the calculated value back. History row on every change.
- **Remaining** = owed − Σ received refund rows (§3.5).
- **Refunds due** (Dashboard, Spend section) = Σ remaining on open claims
  whose outcome is unset or refund / credit (suggested / dismissed /
  replacement / write-off excluded). Click → Claims page, Waiting on
  refund to post + Waiting on supplier.
- **Spend** subtracts refunds received plus Refunds due.
- **Cost of goods block** gains **Supplier write-offs** (write-off claims
  and written-off remainders, dated by write-off date; "can't sell"
  labeled) and **Lost/damaged by us** (existing PO column × COGS).
- Customer refunds (Amazon) are a different thing; never called "refund
  due".

### 3.8 Velocity attribution mismatches (Maria 2026-11-06)

Caress: 200015557295492 = 12 bought, 1 missing, refunded → 5.5 ASIN units;
200015663718988 = 11 bought → 5.5. Velocity counts 6 and 5. AF keeps POs
true to the transactions:
- Any Velocity-vs-AF warning (qty mismatch, over-received, Extra units
  shipped, FBA receiving mismatch) can be **dismissed with a required
  note**; stored per PO + warning type + the quantities at dismissal
  (`po_warning_dismissals`); comes back if those change. A dismissed
  warning never blocks auto-close.
- Such a PO can't auto-close on its own count; Maria closes it by hand,
  and the note shows on the PO.
- Probe 2026-11-07: no COGS adjustment exists on either Caress PO; nothing
  to revert.

### 3.9 Carrier status — EasyPost (Maria 2026-11-07)

AF reads tracking numbers from emails only; `po_tracking.status` is AF's
workflow. Volume ~200–250 packages / month, nearly all UPS / FedEx / USPS +
a little DHL and Amazon; EasyPost covers them, pay-per-tracker, with
status, `est_delivery_date`, timestamped scans, a return flag and
`tracker.updated` webhooks.
- Every open tracking row (inbound and return) → `POST /trackers`; stored
  on `po_tracking`: `carrier_status`, `est_delivery_at`, `last_scan_at`,
  `delivered_at`, `carrier_checked_at`, `easypost_tracker_id`.
- Webhook endpoint (public, signature-verified) + a daily sweep of
  trackers silent for 3 days. Stops once delivered or 60 days old.
  Carriers EasyPost can't track (GLS) keep no status.
- Velocity's per-tracking `tracking_status` is the fallback.
- `EASYPOST_API_KEY` + webhook secret on Render; Maria creates the account
  (stop before signup).

   **Built 2026-11-11 (commit 4; migration 104; against the TEST key, not
   pushed).** (a) columns as listed plus `velocity_tracking_status` — the
   push pass records Velocity's per-tracking status from the inbound
   orders it already lists, so the fallback is a stored column the Tracking
   tab reads, not a Velocity call per page; (b) registration is component
   31 (hourly): one POST per distinct carrier + number (a re-POST returns
   the same tracker — recorded), `is_return` for return rows, the POST's
   answer applied at once, the id on every row with the number; rows on
   OPEN POs only, any age (Maria 2026-11-12 — the "60 days" became "60
   days after registration", the sweep's stop; `easypost_registered_at`),
   delivered stop, GLS / OnTrac / LaserShip / OTHER skipped with the
   reason, ≤ 60 POSTs per pass 750 ms apart, a 429 stops the pass, a
   CREDENTIALS_NOT_FOUND carrier is skipped for the pass (first production
   pass 2026-11-12: rate-limited after 7; FedEx is the managed "FedEx
   Wallet" = `FedExDefault`, with auto-detect as the fallback — a refused
   option advances the carrier for the pass); (c) the webhook is `POST /webhooks/easypost`,
   mounted before the session middleware and outside `/api`
   (`X-Hmac-Signature: hmac-sha256-hex=…` over the NFKD raw body, constant
   time; 401 unsigned / wrong / no secret; 500 on a store failure so
   EasyPost retries); (d) the sweep is component 32 (daily, trackers silent
   3 days); (e) the Tracking tab's Carrier status column + `poDeliveryState()`
   for commit 5; (f) tests on recorded test-key responses
   (`server/__fixtures__/easypost/`); (g) cost guard `npm run
   easypost:count -- --prod`: 227 trackers on day one (open POs, oldest
   shipment 2026-07-31), ~167 / month.
   Render needs `EASYPOST_API_KEY` and `EASYPOST_WEBHOOK_SECRET`; the
   webhook URL is `https://asinflow-cqg.onrender.com/webhooks/easypost`.
   Note: EasyPost answered an `is_return` POST for a code already
   registered inbound with the inbound tracker (same id, `is_return`
   false) — a return that reuses the outbound number keeps the inbound
   tracker; commit 7 (returns) should expect that.

### 3.10 Tracking parser fix (2026-11-07)

41 shipping emails (Aug–Nov) became placeholder rows with no number:
- Walgreens: read the 12-digit number + named carrier.
- Follow the tracking link (as for Michaels) for Duluth, Ace, Zara,
  Typology (Klaviyo), ui.com (AWS click-tracker), Harbor Freight, Golden
  Waffles / Café Mam (Shopify), Lowe's, Summit Racing (Narvar). A link that
  needs a login stays a placeholder.
- GLS added as a carrier.
- Placeholders are replaced in place when a number arrives.
- Sephora, LG, Equal Exchange, giftcardoutlets have nothing to read; those
  POs rely on the "nothing after 14 days" rule.
- Backfill over existing placeholders (dry run → report → live).

   **Built 2026-11-11 (commit 3; no migration).** What the 41 emails
   actually hold, against the text above: (a) Walgreens' three "adjusted
   and has shipped" emails print no number at all: each lists ONE canceled
   line (out of stock, $0.00) and a "Shipped" heading with no items and no
   number under it — the rest of the order did ship (Velocity received
   4 / 1 / 2 ASIN units on the three POs). The carrier word is there
   (FedEx / USPS), so the existing "named carrier + 12 digits" rule would
   read a number if one were printed; the nine anchors are the template's
   click-tracker links, identical across the three. Nothing to fix; a
   fixture proves the placeholder. The three were dismissed by hand
   2026-11-11 (reason "no tracking number in the email: 1 line canceled
   (out of stock), the rest shipped"); commit 5 picks them up as canceled
   claims — Liz Claiborne 1.0 fl oz qty 1 on 215691286487 (2026-09-13),
   Folgers 8 oz qty 5 on 215651271261 and qty 1 on 215651297215 (both
   2026-09-04; AF's lines hold the combined net quantities, see the PO
   notes); none has a claim or a refund yet; (b)
   Harbor Freight's number is schema.org ParcelDelivery microdata
   (parcelLab), not a link — read from the raw HTML; (c) Duluth's click
   tracker answers 404 to HEAD and redirects only a GET — the follow now
   retries as GET (body never read); (d) Summit Racing's Narvar notice
   links its tracking page from "View Up-to-Date Order Details" — a
   per-domain anchor rule follows every `cta.narvar.com` anchor; (e) Ace
   (403 bot challenge), Lowe's (403; the email names FDXGND and prints
   nothing — "TPSD…" is the item's model #), Zara ("tracking not
   available" for these old orders; the order page needs a login),
   Typology (Klaviyo → account page), Shopify stores (Golden Waffles, Café
   Mam, Equal Exchange: order status needs a login), ui.com (scripted order
   page) stay placeholders — no landing page had to be read for any
   resolvable case, so the body is still never read; (f) GLS added;
   (g) a placeholder is replaced in place by any real row for the same
   sender + order base key (a `-YYYYMMDD` suffix stripped; a Narvar sender
   = its retailer) — 14 of the 41 were already answered by a later email.
   Production dry run: 14 replaced · 2 resolved now (Duluth, Summit — UPS)
   · 23 stay · 2 dismissed; `docs/tracking-placeholders-dry-run-2026-11-11.csv`.
   Live run 2026-11-11 (Render on 2e07e21): 14 replaced · 2 resolved
   (Duluth WEB35620800 → UPS, matched to its PO; Summit 412645 → the UPS
   number an existing matched row already held, so the placeholder went
   and no row was added) · 23 stay · 2 dismissed;
   `docs/tracking-placeholders-live-2026-11-12.csv` (UTC date). Duluth's
   click tracker did not redirect on the first pass and resolved on a
   second, idempotent pass — a transient miss, not a parser gap.

### 3.11 Supplier emails (commit 6; Maria 2026-11-13)

**The mockups are the UI:** `docs/mockups/claims-list-emails-2026-11-13.html`
and `docs/mockups/claim-detail-emails-2026-11-13.html` (the two approved
Claims pages, same stylesheet, with the email-driven rows, entries and the
one banner). Where a mockup and this text differ, the mockup wins.

**Acceptance table** (approved; it is the test, filled in in the report):

| # | Email arrives | AF does by itself | Maria sees | Maria does |
|---|---|---|---|---|
| 1 | Refund / credit confirmation; order # (incl. `alt_order_ids`) and amount within 1¢ match an open claim | Sets outcome = refund (card / gift card / credit per the email), stamps `supplier_confirmed_at`, prefills the refund row (method, amount) | Claim in **Waiting on refund to post**; timeline "Confirmed by supplier · $X · from email" with **open email** | Nothing until the money shows; then **Refund received** (always her tick) |
| 2 | Same, but not sure: Target "order ending in NNNN", amount differs, no order # | Nothing | **Needs attention › Decide**: "Email M/D may be this claim's refund: … · $X · open email" | **Attach** (then row 1 applies) or **Not this claim** |
| 3 | Supplier reply on an open claim, no outcome stated | Attaches it with a one-line summary; `last_supplier_reply_at` | **Needs attention › Supplier**: "Supplier replied M/D: "…" · open email" | **Keep waiting** (→ Waiting on supplier, timer restarts from the reply) or **Set outcome** |
| 4 | Reply that states an outcome (reship / refund promised / can't help) | Same as 3 + suggests the outcome | **Needs attention › Decide**: "Supplier replied M/D: "…" → replacement?" | **Confirm outcome** (or pick another) |
| 5 | Refund email for a PO with no claim | Suggested claim with the email's amount and items, quantity "?" when not stated | **Needs attention › Decide**: "refund · from email · no claim on this PO yet" | **Open claim** or **Dismiss** |
| 6 | Return label attached (Walmart PDF) or linked | Saves the PDF as a PO document `return_label` with `claim_id` | Timeline "Return label received · from email"; Linked › Documents | Nothing yet (sending it to Velocity is commit 7) |
| 7 | Unknown sender mentioning an open claim's order # | Nothing | Banner on the claim: "An email may belong to this claim" + a Decide row | **Attach** or **Not this claim** |
| 8 | Email on a closed or dismissed claim | Attaches it to the timeline. Feedback / survey requests and "your case is resolved / closed" notices: attached quietly, no task | Everything else: **Needs attention**: "New email on a closed claim M/D: "…"" | **Reopen** or **Nothing to do** |
| 9 | Maria's own email to a supplier (sent from, or forwarded through, the watched mailboxes) about an order with an open claim | Records Contacted supplier (date, channel email, first line as the note), completes `contact_supplier` / `follow_up_supplier`, starts the timer | Timeline "Contacted supplier · from email"; claim in Waiting on supplier | Nothing. No open claim on that order → nothing happens |
| 10 | Backfill, last 90 days | Dry run: every email, the claim it would attach to, what it would set; nothing written | The report (CSV + counts per row above) | Approves; then live |

Rules:
- **Received is always Maria's tick** (D6). AF never sets an outcome on
  its own except row 1 (the supplier's own refund / credit email, exact
  match).
- Every email-made entry carries "from email" and **open email**, and is
  editable and removable like any other entry (Remove undoes what it set).
- An email attaches to one claim. Several open claims on the PO: the one
  whose items / amount the email names; otherwise row 2 / 7 (not sure).
- Matching: order # incl. `alt_order_ids`; sender → supplier through the
  domain map / aliases (commit 5); Target last-4 + supplier + amount +
  30-day window is "not sure"; forwarded headers parsed (§7). Regex for
  the known templates (§7), Haiku only for free text from a known
  supplier or a thread already attached to a claim.
- Noise never becomes a task: marketing, loyalty "credit", shipping
  notices (the tracking parser's), order confirmations.
- Three task kinds join §3.3: `read_reply` (Supplier; row 3),
  `review_email_match` (Decide; rows 2, 7), `closed_claim_email` (Decide;
  row 8). All three are active tasks (they place the claim in Needs
  attention); ticking one never changes money or quantities by itself.
  `confirm_outcome` (row 4) replaces `read_reply` when the reply states an
  outcome: one row per reply, never two.
- Keep waiting restarts the 5-business-day timer from the reply's date.
- **v2 (not in this patch):** AI drafts the emails to suppliers (report,
  follow-up, reply) from the claim's facts; Maria approves each before it
  sends. Needs this commit's thread reading first. Outbound email stays
  on hold until then.

**Notes from the dry run (Maria 2026-11-13, approved; built in commit 6):**
1. **Short order numbers.** The matcher never takes an order # under 6
   characters from free text (too easy to hit by chance). In a reply from
   the supplier's own domain a short id in the SUBJECT after "Order"
   counts (`poByShortSubjectId`: Voltage 65705, Hardware World 8CMT9,
   Golden Waffles 8307). The alias voltagesupply.com →
   voltagecoffeesupply.com is built in (`SUPPLIER_EMAIL_ALIASES`; the
   settings domain map still wins). A Michaels case thread, which carries
   no order #, matches through the thread Maria's own email started
   (`threadPoMap`: a thread takes the one PO any message of it names).
2. **An exact refund / credit email on a SUGGESTED claim** (row 1's rules:
   order # incl. alternates + amount within 1¢) opens the claim and applies
   row 1 — timeline "Opened from the supplier's refund email", then
   "Confirmed by supplier · $X · from email". Anything less than exact
   stays row 2 (the suggestion stays suggested; Attach opens it).
3. **A supplier reply on a PO with no claim** becomes a suggested claim
   under Decide: "Supplier email on a PO with no claim · M/D: "…" · open
   email", Open claim / Dismiss (kind missing until Maria changes it,
   quantity ?). Maria's own outgoing email on a PO with no claim still
   does nothing.
4. **Refund detection** ignores order confirmations and gift-card
   purchase / payment wording — "Your Sephora order:", "Thank you for your
   order", "Got it! Your order … confirmation", "e-gift card has been sent"
   and the like are never a refund, whatever the body says (`ORDER_NOISE`;
   the dry run's 5 false hits). Cancellation wording takes precedence over
   refund wording: commit 5's finder owns those emails.
5. **Row 9 watches the Sent folders of orders@ and maria@.** The service
   account's delegation reads both (`WATCHED_MAILBOXES`); mpeters.cqg@ is
   not a Workspace user and mashalelek@ is gmail.com, so neither is
   readable. A forward from a Sent folder is read as the forwarded email
   (incoming); only a genuine email to a supplier is row 9.

**Built (commit 6, 2026-11-13):** `server/claim-emails.ts` (classify →
plan → apply, the ingest), migration 112 (the three task kinds,
`supplier_claim_tasks.gmail_message_id / mailbox / payload`,
`supplier_claim_events.mailbox`, event types `email_attached` /
`email_review` / `email_dismissed`, `po_prefill_log` kind `claim_email`),
`GET /api/claims/emails/:mailbox/:id` (open email: the message rendered as
a page), component 30 runs the ingest after the commit 5 finders (hourly;
a watermark per mailbox, 6 h overlap, an email on a claim is never applied
twice; **a mailbox with no watermark yet is left alone — the first live
backfill sets it, so the pass never reads a mailbox's history without
Maria's approval**), `npm run claims:emails -- [--prod] [--days N] [--live]` is row 10.
Row 1's prefilled refund row = `outcome_amount` / `outcome_detail` ("card
••6830 · from email"); Refund received prefills from them. The decisions
go through the task tick (`POST /api/pos/claims/tasks/:id/done` with
`decision`: attach / not_this, keep, reopen / nothing). Keep waiting ticks
the task with the reply's date, so the timer restarts from the reply.
Remove on an email-made entry undoes what it set (`REMOVABLE_EVENT_TYPES`:
a `supplier_confirmed` from email clears the confirmation and the Refund
received tick; a `supplier_reply` from email re-opens what it closed and
removes its read_reply / confirm_outcome task; `email_review` removes its
task; `label_saved` detaches the document from the claim, the file stays).
Tests: `server/claim-emails.test.ts` (classify / match on the scrubbed
fixtures under `server/__fixtures__/claim-emails/`, recorded Haiku answers)
and `server/claim-emails.db.test.ts` (every table row end to end on the
real schema, rolled back, the printed table is the report's; plus two open
claims on one PO, a duplicate email, an email on a dismissed claim).

### 3.12 Returns (commit 7; Maria 2026-11-13)

**The mockups are the UI:** `docs/mockups/claims-list-returns-2026-11-13.html`
and `docs/mockups/claim-detail-returns-2026-11-13.html` (the two approved
Claims pages, same stylesheet; new: the Return card in the detail's left
column, the return rows and their wording). Where a mockup and this text
differ, the mockup wins.

**Acceptance table** (approved; it is the test, filled in in the report):

| # | What happens | AF does by itself | Maria sees | Maria does |
|---|---|---|---|---|
| 1 | Label arrives by email (§3.11 row 6 saves it), Velocity PO | Reads tracking #, carrier and the return-by date from the label / email; `po_tracking` row `direction = return`, `claim_id`; registers it with EasyPost; `return_required` = yes | **Needs attention › Velocity**: "Return label saved M/D · from email · send it to Velocity · return by M/D" + **label** and **copy message** links | Sends it on Discord, clicks **Sent label** |
| 2 | Same, home PO (ships to home) | Same | **Money and arrivals**: "Return label saved M/D · ships from home · drop off by M/D" + **label** | Drops it off, clicks **Dropped off** |
| 3 | A return is needed, no label came | Nothing | "A return is needed · no label yet" | **Upload label** (PDF / image; AF reads the tracking) or **No label** (store return, carrier pickup, tracking typed by hand or none) |
| 4 | Sent label / Dropped off ticked | Waits for the carrier | Waiting on Velocity (home PO: Waiting on shipment): "Label sent M/D · waiting for the first carrier scan" | Nothing |
| 5 | Carrier's first scan on the return tracking | Ticks **Shipped**, event `return_shipped` "from tracking" | Waiting on shipment: "Return shipped M/D · FedEx in transit · due M/D · from tracking" | Nothing |
| 6 | Carrier delivered | Ticks **Delivered**, event `return_delivered` | Waiting on supplier: "Return delivered M/D · from tracking · waiting for the refund confirmation" | Nothing |
| 7 | Refund email | §3.11 row 1 | Waiting on refund to post | **Refund received** |
| 8 | Stalls 5 business days: label sent and no scan; in transit and no scan; delivered and no refund confirmation; or the carrier reports an exception / return to sender | `check_on_it` with the reason | **Timed out** row naming it | **Check on it** or Snooze |
| 9 | Return-by date is 3 calendar days away (or past) and the return has not shipped | `check_on_it`, reason "return by M/D · N days left" | Amber "Return by M/D · 3 days left · label saved M/D, not shipped yet" | Chases Velocity or ships it |
| 10 | No tracking (store return, pickup) | Walmart "Return pickup confirmation" → Shipped, "We received your return" → Delivered, both "from email", when they arrive | Steps show the dates with their source | Otherwise sets Shipped / Delivered by hand in Steps |
| 11 | Supplier says keep it | `return_required` = no; the return steps and the Return card go | `dispose_units` as today | **Asked** (existing) |
| 12 | Claims ticked by the temporary auto-tick (commit 2b) | Keep their dates, labeled "set at confirmation, before tracking"; nothing re-opens | No change | Nothing |

Rules:
- **The Return card** (detail, left column, between Steps and Linked;
  shown while `return_required`): Ships from (Velocity / home), Units
  (Individual), Return by (+ source), Label (the document), Tracking,
  Carrier status; buttons **Download label** and **Copy message for
  Velocity**; editable in place like the Claim card.
- **Copy message for Velocity** copies plain text to the clipboard:
  "Please ship back N units of <product> (<ASIN>) from order <order #>
  using the attached label. It has to go out by <return-by date>."
  AF sends nothing (D13: Discord stays manual).
- **Steps** on a return path: Label → Sent to Velocity (home: Dropped off)
  → Shipped → Delivered, each clickable to set or change its date; a date
  set by hand is never overwritten by tracking, and a tracking date never
  by a later email.
- New task kind `drop_off_return` (group Money and arrivals; home POs,
  row 2). `send_label` and `upload_return_label` as built. **No label**
  completes `upload_return_label` with `return_no_label` = true.
- Return-by date: `supplier_claims.return_by` (date), read from the label
  email ("by Nov 30") or typed; the row 9 warning fires once per date.
- EasyPost answers an `is_return` POST for a number already registered
  inbound with the inbound tracker (§3.9 note): the return row reuses that
  tracker and reads only scans dated after the label.
- The temporary "Shipped / Delivered tick themselves at confirmation"
  (commit 2b) is removed for new claims; Confirmed by supplier no longer
  implies the return arrived.
- Units returned leave expected quantities when the outcome is set (§3.6,
  unchanged). Nothing here writes to Velocity.

   **Built 2026-11-13 (commit 7; migration 113).** Step 1 (read-only, production):
   ONE claim carried any return data — #3356 (walmart 200015497641702, a
   canceled claim, `return_required` off) with the return_label document
   commit 6 saved from the 10/02 "Return pickup confirmation" (FedEx
   798190555249; the 10/07 "We received your return" names a replacement
   order); it is untouched — the card and the steps show only while
   `return_required`. NO production claim had the commit-2b auto-tick
   (`return_required` + a confirmation): row 12's statement updates 0 rows.
   The 15 return emails of the last 90 days (orders@) are all Walmart but
   one Tractor Supply "Your return is complete": "Drop off your return at
   FedEx by …" (5; "FEDEX tracking number NNNNNNNNNNNN" in the body, the
   return-by date in the subject and the body — one QR-code variant prints no
   number until FedEx prints the label), "Return pickup confirmation: …" (5;
   the number, the pickup date, no return-by), "Drop off your return in-store
   by …" (3; a store return: a Return Code, no label, no tracking), a pickup
   reminder ("Return by …"), "We received your return". Every one reads by
   regex; Haiku is needed for none (`readReturnEmail`). The tracking ingest
   had already parked every one of those numbers as an unmatched
   `match_reason 'return'` row — `upsertReturnTracking` adopts that row.
   Interpretation noted: a pickup confirmation arrives BEFORE the pickup, so
   row 10's Shipped-from-email is dated by the scheduled pickup date, and the
   carrier's first scan corrects it (tracking over email). Rows and the
   mockups verbatim otherwise: `server/claim-returns.ts`, the Return card and
   the row wording in `client/src/pages/claims.tsx`, the words in
   `shared/claim-ui.ts`, the bucket / steps in `shared/claim-bucket.ts`;
   `server/claim-returns.db.test.ts` is the table (one test per row, plus the
   reuse of the inbound number, a hand-set date followed by a scan, a
   return-by date already past). The Velocity push now reads inbound rows
   only. Render needs nothing new.

## 4. Data

Verified against migrations 028–099. Stored base for every quantity: Individual units (D17).

### 4.1 `supplier_claims` (renames and widens `po_line_defects`, 094)

| Column | Notes |
|---|---|
| `id`, `po_id` | kept |
| `po_line_item_id` | **nullable** (NULL = whole PO) |
| `kind` | the eight kinds (D2) |
| `qty` | **Individual units**, numeric(10,2) (was retailer units) |
| `amount_owed`, `amount_owed_source` | was `amount`; `auto` \| `manual` |
| `status` | `suggested` \| `open` \| `closed` \| `dismissed` only; buckets are derived (§3.2) |
| `outcome`, `outcome_amount`, `outcome_detail`, `write_off_reason` | was `resolution` |
| `replacement_qty`, `replacement_shipped_at`, `replacement_arrived_at` | new |
| `return_required`, `qty_disposed` | new |
| `found_by` (`auto` \| `maria` \| `email`), `found_at` (was `opened_at`) | |
| `reported_at`, `reported_channel`, `last_supplier_reply_at`, `supplier_confirmed_at`, `closed_at` | new (`resolved_at` → `closed_at`) |
| `source_email_id`, `source_items_json` | for emailed cancellations |
| `note`, `created_by`, `created_at`, `updated_at` | |
| dropped | `replacement_po_line_item_id` |

### 4.2 `supplier_claim_tasks`

`id, claim_id, kind (the 13 in §3.3), group (decide | supplier | velocity |
money | timed_out), qty, reason, created_at, due_at, done_at, done_by,
snoozed_until`. Open = `done_at` NULL. One open task per kind per claim.

### 4.3 `supplier_claim_events`

`id, claim_id, at, type (found | opened | dismissed | reported |
supplier_reply | outcome_set | label_saved | return_shipped |
return_delivered | supplier_confirmed | refund_received |
replacement_shipped | replacement_arrived | task_done | amount_overridden |
remainder_written_off | reopened | closed), summary, gmail_message_id,
po_document_id, po_tracking_id, po_line_refund_id, by`.

### 4.4 `supplier_claim_refunds` (renames `po_line_defect_refunds`)

`claim_id, po_line_refund_id, amount_applied` (PK on the pair). Many-to-many
both ways; `amount_applied` lets one refund row split across claims.

### 4.5 `po_warning_dismissals`

`id, po_id, warning_type, quantities_json, note, dismissed_by, dismissed_at`.

### 4.6 `po_line_expected` (view)

Per line: ordered (individual / product / ASIN), Σ canceled, Σ claimed
(counting rule §3.6), expected in all three units. The only source for
every net-quantity reader.

### 4.7 Changes to existing tables

- **Stored base → Individual units (D17):** every quantity column on
  `po_asins` (qty_ordered, qty_shipped_supplier, qty_at_prep,
  qty_at_warehouse, qty_lost_damaged_us, qty_shipped_fba,
  qty_received_amazon, received_velocity) and `po_line_items`
  (qty_ordered …) is converted in place: stored × its pack size (ASIN pack
  for ASIN-unit columns, product pack for Product-unit columns), integer
  result required; a row whose pack size is NULL or whose product isn't a
  whole number is listed in the dry run and left unconverted with a
  per-row flag until Maria confirms its pack. Trigger-maintained sums
  (po_asin_shipments → qty_shipped_fba / qty_received_amazon) switch to
  individual units. Velocity ingest stops dividing by pack. Every reader
  goes through the view (§4.6); the dry run proves On Order, auto-close
  and the Velocity plan give identical numbers before and after for every
  production PO.
- `po_line_items`: **drop** `qty_canceled`, `qty_returned`, `final_qty`
  after conversion (§4.8). The PO page's Canceled / Returned / Final
  columns go; the PO's Claims card shows them.
- `po_tracking`: `claim_id`, `direction` (`inbound` \| `return`), EasyPost
  columns (§3.9).
- `po_documents`: `claim_id`; type `return_label`.
- `po_line_refunds`: received money only; `status` column dropped after
  conversion.
- `po_line_action_items`: "Missing / damaged from supplier" and "Confirm
  refund / replacement" leave the list for new rows (old cleared rows keep
  their text).
- `po_edit_log`: entity `claim`.
- `purchase_orders.alt_order_ids`: reship order #s; no change.

### 4.8 Conversions (one dry run → Maria reviews → live)

- Defect row → claim 1:1 (Caress 200015557295492: missing, 1, $5.97).
- Refund-due rows (`status = 'due'`; one, the same $5.97) → the claim's
  `amount_owed`; due row removed.
- `qty_canceled > 0` → closed `canceled` claim per line; `qty_returned > 0`
  → closed `returned` claim; qty converted to Individual units; dated by
  the PO's last edit; linked to a received refund row on that PO when one
  exists, else amount unknown + note "sheet-era, refund not tracked".
  Dry run reports the counts.
- "Confirm refund / replacement" action items (23, open POs) → open claims
  with an open `refund_received` task and kind / outcome / amount flagged
  for Maria.
- "Missing / damaged from supplier" (60): 12 on open POs → open claims
  with `contact_supplier`; 48 on closed POs → closed claims for history,
  note carried over, no outcome guessed. Action items cleared
  (`cleared_by = auto`, "converted to claim").
- Sheet write-offs from `po_asins.unreimbursed_loss_qty / _amount` (143
  rows, $7,059.23; 140 match the sheet) → closed `write_off` claims (kind
  `missing` unless the notes say otherwise), dated by the PO's last edit;
  plus chewy 1627249988 B08F2JGCXT 3 / $8.55 (missing from AF).
  **Excluded:** michaels 9800109062072825 Red Heart 11 / $32.25 (refunded).
- Day one: ~35 claims in Needs attention (23 + 12). Accepted (Maria).

## 5. UI

**Amended 2026-11-12 (Maria): the two mockups are the UI —
`docs/mockups/claims-list-2026-11-12.html` and
`docs/mockups/claim-detail-2026-11-12.html`. Where a mockup and this prose
differ, the mockup wins.** The server side (claims, tasks, buckets, timers,
refunds) stays as built; commit 2b rebuilds the two pages against them.

- **Claims** (list) — header: title, **Refunds due $X · N open**, a filter
  box (supplier, PO, ASIN…), a kind select, **+ Open claim** (PO picker).
  Bucket tabs with counts: Needs attention · Waiting on supplier · Waiting
  on shipment · Waiting on refund to post · Waiting on Velocity · Closed
  (+ Dismissed toggle). Needs attention is grouped Decide / Supplier /
  Velocity / Money and arrivals / Timed out, each group headed with its
  count and a short hint. Row: Supplier · PO · Product (name, ASIN) ·
  Kind (with "· suggested" / "· from email") · Qty (Individual units, "of
  N" ordered; "?" with the email's figure when unknown) · Owed / left ·
  **Step — one plain sentence of what is going on** (a suggestion's
  figures and its two possible causes; "Report to supplier"; "Reported
  11/5 by chat · no answer in 5 business days"; "Confirmed 10/28 · 1 of 2
  gift cards refunded · short by $42.00"; …) · Waiting (days) · **Do: ONE
  primary button for the task** (Open claim · Contacted supplier ·
  Followed up · Confirm outcome · Sent label · Asked · Refund received ·
  Check on it …) plus Dismiss / Snooze links where they apply. Default
  sort: longest waiting.
- **Claim detail** — header: kind · supplier · order #, then PO date ·
  product · ASIN · qty · the state sentence · days open; action buttons
  **Contacted supplier · Supplier replied · Set outcome ▾ · More ▾**.
  Three columns. **Left:** the Claim facts, each editable in place (kind,
  qty, $ owed with override and auto, received, remaining, Outcome — "not
  known yet" until set, clearable — return needed, found, reported, the
  note); the **Steps** list where every step is clickable to set or change
  its date / data, and the list changes with the outcome (a return adds
  label → sent → shipped → delivered; a replacement adds promised →
  shipped → arrived); **Linked** (PO, Velocity order, emails, tracking,
  documents). **Middle:** the **Timeline**, newest first, every entry
  editable in place and removable — **Remove this entry** (Maria
  2026-11-12) removes the contact / reply / confirmation / refund it
  records and undoes the fact it set (date cleared, confirmation dropped,
  refund row unlinked and deleted, ticks re-opened, timer re-derived),
  with a History row and no new entry; inline forms for Contacted supplier (date / how /
  note) and Supplier replied (date / how / summary; sets the outcome when
  the reply tells it); each contact or reply is its own entry; the timer
  restarts from the latest. **Right:** the Refunds table with **+ Refund
  received** and **Write off remainder**; a **What happens next** box (the
  current bucket, the timer, the possible paths); **More** (Dismiss,
  Reopen, Merge into another claim on this PO, Remove).
- Rules: no outcome is required to proceed; nothing on the page says
  "waiting" before `reported_at`; every change writes an event and a
  History row; quiet chrome and the quantity-names wording apply.
- **POs list:** a **Claims** column in the Status group right after Action
  Items — count of open claims, blank when none; hover lists kind + $;
  click → Claims page filtered to the PO. Nothing in Action Items. Filter
  "has open claims".
- **PO page:** "Claims (N)" link in the header next to the chips; a small
  Claims card on PO Details (one line per open claim, linked); **Open
  claim** in a line's menu (kind, qty in Individual units prefilled from
  the gap when AF knows it, note). No Claims tab on the PO.
- **Velocity warnings:** Dismiss with note on the chip (§3.8); the note
  shows on the PO.
- **Dashboard:** Refunds due (click → Claims), Spend, Supplier write-offs
  line (§3.7).
- Quiet chrome rule applies; wording per the quantity-names patch.

## 6. Fixtures (facts from the 2026-11-07 probe)

- **Caress 200015557295492** — missing 1 of 12, refund expected (Walmart
  chat refused). AF ASIN qty 6.00, received 5.5; Velocity 8127 fully
  received.
- **Caress 200015663718988** — 11 bought, ASIN qty 5.5; Velocity 9822 qty
  10, fully received. §3.8: dismiss with note, close by hand.
- **Voltage 65705** — 1 jar received of a 12-jar case: missing **11
  Individual units** (0.92 Product unit). Supplier (voltagesupply.com)
  shipping the remaining 11; second UPS tracking already on Velocity order
  6778. Replacement, same order # (D10).
- **goldenwaffles.com 8307** (10/23, "Expires in a month") — expired,
  return requested. Velocity 8787: 6 of 18 received; AF shows 0 (sync gap
  to check).
- **walmart.com 200015193721348** (Oreos, 9/10) — cant_sell. Return
  started 10/31, label PDF in the email, refund $47.76 to OnePay. Velocity
  5667: 8 singles in inventory; AF shows 4 shipped FBA (mismatch to check).
- **petsmart.com 1113689148** (3/31, home PO; AF "Closed" with `closed_at`
  empty) — Bil-Jac B07762PPYF: 21 ordered, 15 received, V/W 6 / $15.46 →
  write-off. Rachael Ray B07KWJTLCN: 5 ordered (sheet and AF); note says
  "Ordered 20. 5 got canceled… shipped 3, 2 of them bigger size" → the dry
  run proposes canceled + missing + wrong_item for Maria; 0.5 shipped FBA
  combined at Velocity (§3.8). Top Fin fine. Sheet subtotal $40.47 above
  the lines.
- **michaels.com 9800109062072825** (2/16) — three cancellations ($9.96,
  $17.85, $8.30) refunded as one $36.11 eGift card → three canceled claims,
  one refund row split by `amount_applied`.
- **kohls.com 6739984735** (Maria 2026-11-09) — full cancel paid with two
  gift cards, one refunded → one claim, one refund row, remaining = the
  other card.
- **dkhardware.com DKH-3192308** (6/8) — never received; "Delivery issue"
  6/22, "Refund Issued … $77.23" 8/25. AF: closed, refund 0.
- **Jellycat 8918590** (9/2) — full cancel 9/3, refund $380.00. AF: total
  $0, open, no tracking.

## 7. Email facts (probe, orders@, 90 days)

- **Walmart:** regex-reliable templates. "You're getting a $X refund:
  [item]" (amount in subject; order # in body with a dash); "Canceled: …
  from delivery" (no amount); "Drop off your return at FedEx by …" (label
  PDF, refund amount, card last 4); "Return pickup confirmation";
  "We received your return"; "Your replacement is in the works".
- **Target:** cancel email shows only the order #'s last 4 (§3.5
  fallback); "processing your replacement request" / "replacement item is
  ready to ship".
- **Michaels:** "You received a gift card" (amount + order #); "Case
  Number" threads; reships R… → `alt_order_ids`.
- Regex-able: Home Depot "Credit Applied to Order WK…", DK Hardware
  "Refund Issued for Order# DKH-…", Jellycat, Sephora, Supplyhouse, Staples,
  Blick (oraclecloud.com); Carter's claims from carters.narvar.com.
- Haiku: free-text replies (7 / 90 days). Voltage writes from
  voltagesupply.com → alias. Unknown sender domains that mention an open
  claim's order # → **suggested** attach, never automatic.
- Many threads start in mpeters.cqg@ / mashalelek@ (forwarded to orders@):
  parse forwarded headers (cancellations patch §4).
- Noise: Spoiled Child loyalty "credit", one.app credit-score mail.
- `docs/po-issues-probe-supplier-emails-2026-11-07.csv`.

## 8. Open

- Suggestions: under *Decide* for now; own tab if they pile up.

## 9. Commits

Prerequisite: `claude_spec-patch-quantity-names.md` (labels only).

0. ~~Probe~~ — done 2026-11-07.
1. Migration §4.1–4.7 + view §4.6: stored base → Individual units (D17,
   per-row dry run listing every value before/after and every row that
   can't convert); conversions §4.8; drop `qty_canceled` / `qty_returned`
   / `final_qty`; every quantity reader on the view; D16 entry fields in
   Individual units. Dry run report proves On Order / auto-close / Velocity
   plan identical before and after for every production PO. Stop for
   Maria, then live.
   **Built 2026-11-09 (migration 101, `npm run claims:dryrun -- --prod`,
   report `docs/claims-commit1-dryrun-2026-11-09.md`); LIVE on production
   2026-11-10 02:23 UTC (591f037). Two ~30 s 502 windows during the
   Render deploy; set the service's health-check path to /health
   (backlog).** Implementation notes that go beyond the text
   above: (a) two views, `po_line_expected` (per line) and
   `po_asin_expected` (per ASIN row — the stage quantities live on the
   row), the latter read by On Order / auto-close / the row loader;
   (b) a row or line whose pack was not known, or whose value × pack is not
   a whole number (tolerance 0.05 for a 2-dp third / sixth), keeps its old
   basis with `qty_basis = asin_legacy / product_legacy` and converts by
   trigger when the pack arrives — `qty_at_prep`, `received_velocity` and
   Velocity shipment rows on such a row were already Individual (units ÷ 1);
   (c) the counting rule §3.6 read precisely: closed with any outcome but
   replacement, or open and canceled / promised refund · credit · write-off;
   (d) `created_by` is `created_by_user_id` (the codebase's convention; a
   test forbids the Replit-era `created_by`); (e) `supplier_claim_conversions`
   records each converted claim's source and flags (`kind_unclear`,
   `qty_assumed_ordered`, `refund_not_tracked`, `legacy_units`, …); (f) a
   converted canceled claim whose line also carried "Confirm refund /
   replacement" is reopened with the `refund_received` task rather than
   duplicated; (g) the col V / W write-offs land on the row's first line
   (flagged when the row has several); (h) Spend subtracts what is still owed
   on open refund / credit claims (as the due rows did) — the full Refunds
   due / Spend review stays in commit 2; (i) the sheet intake maps the two
   retired badges on a NEW row to a claim (never a stop); (j) the per-PO
   Supplier claims section (Payments tab) replaces the defects section until
   the Claims page; claims are not action items — a muted "N open claims"
   note shows after the chips; (k) Maria 2026-11-09: a converted badge claim
   gets NO quantity and no $ (`qty` NULL, an `enter_quantity` task, group
   Decide — the fourteenth task kind) and counts toward nothing until the
   quantity is typed on the claim (which completes the task); a 0 / 0 sheet
   line's canceled claim has qty NULL and reads "unknown (sheet zeroed the
   line)"; (l) `server/quantity-readers.lint.test.ts` fails when server code
   outside its allowlist selects a stored quantity column directly or does
   pack arithmetic itself.
2. Tasks + buckets + paths (§3.2–3.4), outcomes + refunds table (§3.5),
   money incl. override (§3.7), Claims nav tab + claim detail + POs-list
   column + PO page link / card / Open claim (§5), Refunds due / Spend on
   claims (§3.7), retire the two manual action items.
   **Built 2026-11-10 (migration 102 — the event types only).** Notes
   beyond the text: (a) §3.2's precedence ("an open task always wins")
   and §3.3's `refund_received` / `replacement_arrived` tasks cannot both
   hold, or Waiting on refund to post / shipment would never occur — those
   two are PASSIVE ticks: they never place a claim in Needs attention and
   are offered as the row's Next action wherever it sits; (b) the timer's
   anchor for Waiting on supplier is the report date Maria typed
   (`reported_at`), else the tick; a snooze = the tick now +
   `snoozed_until` 5 business days out, and the sweep waits for it;
   **Maria 2026-11-11: the timer runs only while the claim has no open
   Needs attention task** — a claim never gets a Follow up / Check on it
   on top of one; the two passive ticks never hold it; it restarts when
   the open task is ticked (any tick; the Contact supplier tick counts
   from its typed report date). **Same day, D6's two ticks:** the Refund
   received tick opens at Confirmed by supplier, not at Set outcome —
   Set outcome = refund → Waiting on supplier (timer → Follow up),
   Confirmed → Waiting on refund to post with the tick (timer → Check on
   it "refund not posted"); migration 103 removed the ticks 101 had opened
   on unconfirmed badge claims (16 on production); (c) the sweep runs in every scheduled pass (component 30,
   `30_claim_timers`, hourly tier, scheduled passes only — the POs list's
   Claims column and the Dashboard never lag) and when the Claims page
   loads (`GET /api/claims`); (d) Refund received creates the `po_line_refunds` row itself
   (`source = 'manual'`, the claim's line and qty when the refund is for
   one claim, PO-level + `needs_split` when it is shared) and stamps
   `supplier_confirmed_at`; a short refund stays owed in Waiting on refund
   to post (event `refund_short`); (e) Write off remainder keeps the
   refund outcome, sets `write_off_reason` and `outcome_amount` = received
   — the coverage sync leaves such a closed claim alone, Reopen clears the
   reason; (f) the Dashboard's Refunds due cell opens
   `/claims?bucket=waiting_refund,waiting_supplier&from&to` (the PO date
   range filters the rows); (g) the POs list's "has open claims" is a
   select (any / has open claims / no open claims, `?claims=`) with facet
   counts; (h) the Claims nav tab sits after POs; the sidebar component is
   not in use; (i) "Days in bucket" on Needs attention = days since the
   oldest open active task; (j) the Velocity-warning dismiss (§3.8) and
   Supplier write-offs line stay in their commits; (k) migration 102 widens
   `supplier_claim_events.type` with `timed_out`, `snoozed`, `followed_up`,
   `checked`, `reship_confirmed`, `refund_short`.
3. Tracking parser fix (§3.10) + placeholder backfill.
4. EasyPost (§3.9): register, webhook, sweep, store; Velocity fallback.
5. Auto-found: missing (D8), never_received (§3.1) as suggestions;
   *(built 2026-11-12, see §3.1 "Built" — dry run on production, live waits for Maria)*
   cancellation emails → suggested canceled claims.
6. Email (§3.11, acceptance table + mockups approved 2026-11-13): supplier replies, refund / credit confirmations (incl. Target
   fallback), labels in replies (regex first, Haiku for free text).
   **Built 2026-11-13 (§3.11 "Built"; migration 112). Dry run of the last 90 days before the live backfill (row 10);
   live waits for Maria.**
7. Returns (§3.12, acceptance table + mockups approved 2026-11-13): label → document + return tracking + Velocity / shipment
   buckets.
8. Replacements (`alt_order_ids`, tracking ↔ claim) + §3.8
   dismiss-with-note.
9. Supplier write-offs line; SPEC §22 / §26 / §11, CLAUDE.md; mark the
   cancellations patch's §3 / §5 / §6 superseded.

Stops: after 1's dry run, after 3's backfill dry run, before 4's EasyPost
signup, and for anything this patch doesn't cover.
