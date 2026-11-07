# SPEC Patch — Supplier claims: supplier problems, returns, cancellations

*Drafted 2026-11-05 with Maria (whiteboard walkthrough). Amends §22 (PO
module, incl. the "Supplier defects" section added by e424903 / migration
094), §26 (email ingestion), §11 (Velocity). Supersedes the data model and
review list of `docs/claude_spec-patch-po-cancellations-from-email.md`
(§3, §5); that patch's ingestion (§4), net quantities (§6) and backfill (§8)
stay valid and feed this one. Also supersedes the backlog's "Allocate to
another PO" (2026-11-05) and its "until built" workaround: see §3.7.*

> **Status: APPROVED 2026-11-06. Amended 2026-11-07** after the commit 0
> probe — see §0. Formerly "PO issues" (`claude_spec-patch-po-issues.md`);
> renamed 2026-11-07: the record is a **claim** everywhere (tables, code,
> UI, docs). "Issue" is not used for this concept anywhere in AF.

## 0. Changes 2026-11-07 (Maria, after the probe)

- **Name:** "claims" everywhere. Tables `supplier_claims`,
  `supplier_claim_events`, `supplier_claim_tasks`, `supplier_claim_refunds`;
  `claim_id` on `po_tracking` / `po_documents`; UI "Claims".
- **D10 replaced — no replacement POs.** A replacement stays on the original
  PO as part of its claim (§3.4). A reship that comes with its own order #
  (e.g. Michaels R…) is added to the original PO's existing
  `purchase_orders.alt_order_ids` (migration 086) so emails and tracking
  match there. Nothing about a replacement is ever sent to Velocity as a
  separate order.
- **Carrier tracking aggregator is added in this patch** (commit 4, §3.8):
  **EasyPost** (Maria 2026-11-07). Before it, a **tracking parser fix**
  (commit 3, §3.9) so shipping emails that today yield no number get one.
- **Legacy badges are part of the claims flow.** The manual action items
  "Missing / damaged from supplier" and "Confirm refund / replacement"
  convert to claims and leave the action-item list; chips come from claims
  (§4.3, §5).
- **`amount_owed` can be overridden by hand** and then stays as typed
  (`amount_owed_source`, §3.6).
- **Michaels 9800109062072825:** the sheet's 11-unit / $32.25 loss is
  dropped — already refunded by the $36.11 Michaels eGift card (§6).
- Probe corrections: cols V/W **were** imported (`po_asins.unreimbursed_loss_*`,
  §4.3); AF has no carrier status today (§3.8); Velocity can't take a qty
  PUT on fully received orders and has no DELETE (§3.5); Walmart emails
  the return label PDF (§3.3); fixture facts updated (§6).

## 1. Why

Today a supplier problem is a badge plus a note. The defect record from
e424903 added qty and $ owed for one case. Refund-due rows hold the same
money a second time. Returns, replacements, expired and gated items, and
orders that never arrive have no record at all. Maria's process (whiteboard,
2026-11-05) has three branches from a PO: **Received** with a problem,
**Canceled** (full or partial), **Charged, not received**. All three end in the
same place: the supplier refunds, replaces, gives credit, or nothing happens
and it's written off. AF should hold that as one claim per problem, do every
step it can check itself, and remind Maria of the rest.

## 2. Decisions (Maria 2026-11-05, amended 2026-11-07)

- **D1 — One record.** A claim carries the $ owed. Refund-due rows stop
  being a separate notion (§4.3 migrates them).
- **D2 — Kinds:** `missing` (short count) · `damaged` (damaged or defective,
  one kind) · `wrong_item` · `expired` (expired or short-dated) ·
  `never_received` (whole shipment: never shipped, or carrier lost it) ·
  `cant_sell` (gated / hazmat / restricted, e.g. the Oreos; not the
  supplier's fault, never counted as a supplier defect) · `canceled` (full
  or partial, from the cancellations patch).
- **D3 — One outcome per claim, no mix:** `refund_card` · `gift_card` ·
  `store_credit` · `replacement` · `write_off`.
- **D4 — Refunded items you keep are disposed** ("keep it" refunds
  included). Wrong items are always returned or tossed. Expired items are
  returned or disposed. None become stock.
- **D5 — Returns:** frequent (Walmart especially). 99% of the time Velocity
  ships them back with a label Maria sends on Discord. The label is saved on
  the PO and its tracking is followed. Walmart emails the label PDF itself
  ("Drop off your return at FedEx by …"), so AF saves it from the email.
- **D6 — Refund has two ticks:** *Confirmed by supplier* (email, automatic
  or by hand) and *Received* (Maria saw it on the card, gift card or store
  credit; always her tick). Until Received, the money counts as owed.
- **D7 — Reminders:** supplier hasn't answered in **7 days**; return
  delivered to supplier, no refund confirmation in **7 days**.
- **D8 — Velocity check-in lag:** "missing" is raised only after every
  tracking number on the PO shows delivered (carrier status, §3.8),
  **3 business days** have passed since the last delivery, and Velocity's
  received count is still below what shipped. Compare against
  shipped-and-delivered qty, never ordered qty.
- **D9 — Velocity can't take a note via API.** Steps AF can't do (tell
  Velocity a replacement is coming, send a label, change or delete a
  received order) are shown as tasks with a done tick.
- **D10 — Replacements stay on the original PO** (amended 2026-11-07). No
  `_replacement` POs. A reship order # becomes an alias on the original PO
  (`alt_order_ids`).
- **D11 — Write-off:** per-unit COGS unchanged; the $ goes to a **Supplier
  write-offs** line in the Cost of goods block (next to SellerBoard's
  Lost/damaged by Amazon and Disposal of sellable products).
- **D12 — Velocity return fees:** not in v1 (revisit; rare, only when many
  returns come back to back).
- **D13 — Discord:** manual in v1. A read-only bot on Maria's channel needs
  Velocity's agreement; anything logging in as Maria is out.

## 3. Lifecycle

```
found → reported → [return: label → shipped back → delivered to supplier]
      → resolved (refund | gift card | store credit | replacement | write-off)
      → refund: confirmed by supplier → received   |   replacement: arrived
      → closed
```

`status` on the claim: `suggested` (auto-found, not yet opened) → `open` →
`reported` → `awaiting_return` (only when a return is needed) →
`awaiting_resolution` → `resolved` (outcome set) → `closed` (refund received
/ replacement arrived / written off). `dismissed` = a suggestion Maria
rejected. Every transition is a `supplier_claim_events` row and a History
row on the PO with who and when.

### 3.1 Found

| Kind | How it's found |
|---|---|
| missing | Auto per D8 (Received by Velocity < shipped & delivered, after the lag), or Maria from Velocity's Discord message |
| damaged / wrong_item / expired / cant_sell | Maria, from Velocity's Discord message or her own check (home POs) |
| never_received | Auto, two ways. **With tracking:** not delivered by the carrier's estimated date, or carrier status looks lost (exception / returned to sender / no scan for 7 days / in transit more than 14 days with no scan in the last 3 days) — needs the aggregator (§3.8). **With nothing at all:** no tracking and no shipping email 14 days after the order date — AF data only. Shows as a suggestion: "Looks not received. Open a claim?" Maria confirms. |
| canceled | Cancellation emails (cancellations patch §4), or by hand |

Auto-found claims land as **suggested** (one click to open, one to dismiss);
they never change a PO until Maria opens them.

### 3.2 Reported

Maria clicks **Contacted supplier** (date, channel: chat / email / phone,
optional note). The 7-day "no answer" reminder starts.

**Supplier replies from email.** orders@ is already read every pass. A
message from the supplier's domain (alias map) that matches an open claim
(order # incl. `alt_order_ids` in subject/body, or the thread of a known
message) attaches to the claim: "Supplier replied 11/5", one-line Haiku
summary ("offers a refund of $5.97", "wants it returned, label attached",
"sending a replacement"), link to the email. AF **suggests** the outcome;
Maria confirms. A reply resets the 7-day reminder. A label PDF in the reply
is saved per §3.3. Many supplier conversations happen in other mailboxes
(mpeters.cqg@, mashalelek@); orders@ sees only part of each thread, so
Contacted supplier and outcomes stay settable by hand.

### 3.3 Return (when the supplier wants it back)

- **Label:** arrives in a supplier email (Walmart: PDF attached) or Maria
  uploads it on the claim. Saved as a PO document `type = return_label`,
  `claim_id` set, named `YYYY-MM-DD_supplier_POID_return-label.pdf` in the
  Invoices month folder.
- **Tracking:** regex first where the carrier format is unambiguous, Haiku
  reads the label otherwise (fixed schema). Stored as a `po_tracking` row
  with `direction = return` and `claim_id` (never pushed to Velocity).
- **Task:** "Send label to Velocity" with a done tick (Discord, by hand).
- Carrier status per §3.8. Delivered to supplier → 7-day "no refund yet"
  reminder (D7).
- Units returned leave expected quantities exactly like a cancel (§3.5).

### 3.4 Resolved

| Outcome | What AF does |
|---|---|
| refund_card / gift_card / store_credit | Amount (prefilled from the supplier email or $ owed). *Confirmed by supplier* ticks itself when a refund/credit email matches (order # + amount within 1¢, or Maria confirms a looser match). *Received* is Maria's tick (D6) and writes the `po_line_refunds` row (status received), linked through `supplier_claim_refunds`. One refund can cover several claims (Michaels: one $36.11 gift card for three cancellations). Gift card / store credit also records the card/credit name (feeds the Gift Cards page when it's built). |
| replacement | Stays on the original PO (D10). The claim records `replacement_qty`, `replacement_shipped_at`, `replacement_arrived_at`. Same order # → the replacement's tracking matches the PO as usual and is linked to the claim (`po_tracking.claim_id`); it pushes to the original Velocity order like any tracking. New order # → AF adds it to the PO's `alt_order_ids` (Maria confirms), so its emails and tracking land on the original PO. Task "Tell Velocity: replacement on the way". Closes when Velocity's received count on the line covers what was ordered (or Maria ticks Arrived for home POs). |
| write_off | Reason required. $ → Supplier write-offs (D11). |

**No "replacement from another PO"** (Maria 2026-11-06): POs stay true to
the transactions. Units Velocity counts under a different PO are a
Velocity attribution mismatch (§3.7), not a claim outcome: no cost moves,
no link.

**Disposal (D4):** a refunded / written-off `damaged`, `wrong_item` or
`expired` claim whose units sit at Velocity gets a task "Velocity: dispose
N units" (or "return" when a label exists). The units leave At Prep Center
when Velocity's count drops; AF records `qty_disposed` on the claim.

### 3.5 Quantities

- A claim's qty reduces the line's **expected** units (On Order, the
  Velocity upload, auto-close) once its outcome is refund / credit /
  write-off, the same way `qty_canceled` does (cancellations patch §6).
  A `canceled` claim writes `po_line_items.qty_canceled`.
- A replacement keeps the expected units on the original line; nothing
  drops. If the replacement never arrives and the outcome changes to
  refund / write-off, the expected units drop then.
- **Updating Velocity:** for an inbound (not fully received) order, the
  existing Qty-mismatch opt-in PUT on the next Upload to Velocity plan. For
  a fully received order, or a delete (fully canceled / never received
  with nothing checked in), AF shows a task: Velocity's API takes no PUT on
  received orders and has no DELETE, so Maria does it in Velocity's
  dashboard. Never automatic.
- Stored, never derived: the claim qty is never computed from Ordered −
  Received (Received changes when replacements are checked in under the
  same Velocity order).

### 3.6 Money

- **$ owed** = claim qty × the line's **sourcing cost** per retailer unit
  (what was paid incl. tax and shipping, after coupons/sales, BEFORE the
  gift-card / card-reward % — the same basis as the Sourcing cost sent to
  Amazon). never_received / full cancel = the PO total share of the lines.
- **Manual override:** Maria can type `amount_owed`. `amount_owed_source`
  = `auto | manual`; once manual, AF never recalculates it (same guard as
  `cogs_source`), the field shows it was set by hand, and "Reset to auto"
  brings the calculated value back. Every change is a History row.
- **Spend** (Dashboard) subtracts: refunds Received, plus open claims whose
  expected outcome is a refund or credit (amount still owed). A replacement
  is not money owed.
- **Refunds due** tile = Σ $ owed on claims not yet Received (and not
  replacement / write-off).
- **Cost of goods block** gains two lines, live before the Finances patch:
  **Supplier write-offs** (write-off claims, dated by write-off date) and
  **Lost/damaged by us** (the existing PO column × that line's COGS).
  `cant_sell` write-offs go to Supplier write-offs too but are labeled
  "can't sell" in the breakdown (not a supplier defect, D2).
- Customer refunds (Amazon "Refund cost") are a different thing; never
  called "refund due" in the UI.

### 3.7 Velocity attribution mismatches (Maria 2026-11-06)

Occasionally Velocity counts units under a different PO than the one that
bought them. Caress case: 200015557295492 = 12 bought, 1 missing, refunded
→ 5.5 ASIN units; 200015663718988 = 11 bought → 5.5 ASIN units. Velocity
sees them as 6 and 5 because the extra single was checked in under the
earlier PO. AF keeps the POs true to the transactions and does not model
Velocity's view. Instead:
- Any Velocity-vs-AF warning on a PO (qty mismatch, over-received, Extra
  units shipped, FBA receiving mismatch) can be **dismissed with a required
  note** ("1 single checked in under 200015557295492"). The dismissal is
  stored per PO + warning type + the quantities it was dismissed at
  (`po_warning_dismissals`); it stays dismissed until those quantities
  change, then comes back. A dismissed warning never blocks auto-close
  (e.g. 5.5 expected, 6 shipped FBA: "Extra units shipped" dismissed with
  note → the PO auto-closes).
- A PO whose units Velocity attributes elsewhere can't auto-close on its
  own count; Maria closes it by hand (existing Close), and the dismissal
  note shows on the PO.
- Tracking for the unit may still need to reach the other PO's Velocity
  order (the one-off rule from 8e9fbab); no general mechanism in v1.
- Probe 2026-11-07: no COGS adjustment was made on either Caress PO. On
  200015663718988 Maria set qty 11 by hand on 11/05 (correct: 11 bought);
  Velocity order 9822 says 10, fully received → a dismiss-with-note case,
  not a revert.

### 3.8 Carrier status (aggregator, new 2026-11-07)

AF reads tracking numbers from emails only and never queries a carrier;
`po_tracking.status` is AF's own workflow, not the carrier's. This patch
adds **EasyPost's Tracker API** (Maria 2026-11-07). Why: volume is
~200–250 packages/month (production, Aug–Oct 2026), almost all UPS / FedEx
/ USPS plus a little DHL and Amazon, no OnTrac or LaserShip; EasyPost
covers those, is pay-per-tracker (~$0.01–0.03, no monthly fee), and gives
status, `est_delivery_date`, timestamped scan history, a return flag and
`tracker.updated` webhooks. Alternatives compared: 17TRACK, Ship24,
TrackingMore, AfterShip (all dearer at this volume).
- Every open tracking row (inbound and return, `is_return` for returns) is
  registered with `POST /trackers`; status is stored on `po_tracking`:
  `carrier_status`, `est_delivery_at`, `last_scan_at` (latest
  `tracking_details[].datetime`), `delivered_at`, `carrier_checked_at`,
  `easypost_tracker_id`.
- Updates by webhook (`tracker.updated` → a public endpoint verified with
  EasyPost's webhook secret); a daily sweep re-reads trackers with no
  update in 3 days as a backstop. Registration stops once delivered or 60
  days old. Carriers EasyPost can't track (e.g. GLS) keep no carrier
  status.
- `EASYPOST_API_KEY` and the webhook secret are Render env vars; Maria
  creates the account (stop before signup).
- Velocity's per-tracking `tracking_status` (already in its GET, unused) is
  a fallback when the aggregator has nothing.
- Feeds D8 (all delivered + lag), never_received (§3.1), return delivered
  (D7), and the backlog's prep-center performance work later.

### 3.9 Tracking parser fix (new 2026-11-07)

Probe, Aug–Nov 2026: 41 shipping emails became placeholder rows
(`email:<sender>:<order #>`) with no tracking number. D8 can't fire on a PO
whose packages have no number, so these are fixed before the aggregator:
- **Walgreens** (mktx.walgreens.com): read the 12-digit number next to the
  order # and the carrier the email names (USPS / FedEx).
- **Follow the tracking link** (as AF already does for Michaels) for Duluth,
  Ace, Zara, Typology (Klaviyo click-tracker), ui.com (AWS click-tracker),
  Harbor Freight (parcel-api.versand-status.de), Golden Waffles / Café Mam
  (Shopify), Lowe's (TPSD…), Summit Racing (Narvar); read number + carrier
  from the landing page. A link that needs a login or yields nothing stays
  a placeholder.
- **GLS** added as a carrier (byrdhair.com via Shopify, 16 digits).
- A placeholder row is replaced in place when a later email or link gives
  the number, so it isn't counted twice.
- Senders with no tracking at all (Sephora, LG, Equal Exchange) and
  gift-card senders (giftcardoutlets) stay as they are: those POs rely on
  the "nothing at all after 14 days" rule (§3.1).
- Fixtures from the probe's rows, scrubbed; backfill over the existing
  placeholders (dry run → report → live).

## 4. Data

Existing tables, verified against migrations 028–098. One migration for
§4.1–4.6, plus a second for §4.7 (aggregator columns) in commit 4.

### 4.1 `supplier_claims` (renames and widens `po_line_defects`, 094)

| Column | Notes |
|---|---|
| `id` | bigserial, kept |
| `po_id` | FK purchase_orders, kept |
| `po_line_item_id` | FK po_line_items; becomes **nullable** (NULL = whole PO: never_received, full cancel) |
| `kind` | CHECK widened to the seven kinds (D2) |
| `qty` | retailer units, kept |
| `amount_owed` | was `amount` |
| `amount_owed_source` | `auto` \| `manual`, default auto |
| `status` | CHECK widened (§3) |
| `outcome` | was `resolution`; CHECK widened (D3) |
| `outcome_amount`, `outcome_detail` | card / gift card / store credit name |
| `write_off_reason` | kept, same CHECK |
| `replacement_qty`, `replacement_shipped_at`, `replacement_arrived_at` | new |
| `return_required`, `qty_disposed` | new |
| `found_by` | `auto` \| `maria` \| `email` |
| `found_at` | was `opened_at` |
| `reported_at`, `reported_channel`, `last_supplier_reply_at`, `supplier_confirmed_at`, `received_at`, `closed_at` | new (`resolved_at` → `closed_at`) |
| `note`, `created_by`, `created_at`, `updated_at` | |
| dropped | `replacement_po_line_item_id` (no replacement POs) |

### 4.2 `supplier_claim_events`

`id, claim_id, at, type (found | reported | supplier_reply | label_saved |
return_shipped | return_delivered | outcome_set | supplier_confirmed |
received | replacement_shipped | replacement_arrived | task_done |
amount_overridden | reopened | dismissed), summary, gmail_message_id,
po_document_id, po_tracking_id, by`. The claim's timeline.

### 4.3 `supplier_claim_tasks`

`id, claim_id, kind (send_label | tell_velocity_replacement | dispose |
return | update_velocity), qty, created_at, done_at, done_by`. Open = no
`done_at`.

### 4.4 `supplier_claim_refunds` (renames `po_line_defect_refunds`, 094)

`claim_id, po_line_refund_id`, PK on both. Many-to-many.

### 4.5 `po_warning_dismissals`

`id, po_id, warning_type, quantities_json (as dismissed), note,
dismissed_by, dismissed_at`.

### 4.6 Changes to existing tables

- `po_tracking`: `claim_id` (FK, nullable), `direction` (`inbound` \|
  `return`, default inbound).
- `po_documents`: `claim_id` (FK, nullable); type CHECK gains `return_label`.
- `po_line_refunds`: holds money actually received only; `due` rows convert
  to claims (§4.8). The `status` column stays for history until a cleanup
  migration.
- `po_line_action_items`: after conversion (§4.8), "Missing / damaged from
  supplier" and "Confirm refund / replacement" leave the CHECK list for new
  rows; chips for supplier problems come from `supplier_claims`.
- `po_edit_log`: entity CHECK gains `claim`.
- `purchase_orders.alt_order_ids` (086): reship order #s go here; no change.

### 4.7 Aggregator columns (commit 4)

`po_tracking`: `carrier_status, est_delivery_at, last_scan_at,
delivered_at, carrier_checked_at, easypost_tracker_id`.

### 4.8 Migration of existing data (dry run → Maria reviews → live)

- Defect row → claim 1:1 (Caress 200015557295492: missing, 1, $5.97, open).
- Refund-due rows (`po_line_refunds.status = 'due'`; today one, the same
  Caress $5.97) → the claim's `amount_owed`; the due row is removed, never
  double-counted.
- **"Confirm refund / replacement"** action items (23, all on open POs) →
  claims with status `resolved`, waiting on Maria's *Received* tick; kind
  from the line's note / other action items when obvious, else flagged
  "kind unclear" for Maria. Then the action item is cleared (`cleared_by =
  auto`, reason "converted to claim").
- **"Missing / damaged from supplier"** action items (60, Maria
  2026-11-07): the 12 on open POs → open claims (kind from the note when
  obvious, else flagged "kind unclear"); the 48 on closed POs → **closed**
  claims for history (no outcome guessed; note carried over). Then each
  action item is cleared (`cleared_by = auto`, reason "converted to
  claim").
- **Sheet write-offs** come from AF, not the sheet: `po_asins.unreimbursed_loss_qty`
  / `_amount` (143 rows, $7,059.23; 140 match sheet cols V/W, three are
  ASINs spread over several sheet rows where the sheet repeats the value).
  Each → a closed `write_off` claim (kind `missing` unless the notes say
  otherwise), dated by the PO's last edit. Plus the one row missing from
  AF: chewy 1627249988 B08F2JGCXT, 3 / $8.55. **Excluded:** michaels.com
  9800109062072825 Red Heart (11 / $32.25) — already refunded (§0).
- `po_cancellations` doesn't exist (never built) → nothing to convert.

## 5. UI

- **POs page → Claims** inbox (replaces the planned Cancellations chip):
  tabs *Needs me* (suggested, reminders due, outcome to confirm, Received
  to tick, tasks), *Waiting on supplier*, *Waiting on return /
  replacement*, *Closed*. Each row: PO, supplier, kind, qty, $ owed,
  status, last event, next step.
- **PO page → Claims tab** (replaces Supplier defects on Payments): the
  claim timeline (§4.2), buttons per step (Contacted supplier · Upload label
  · Set outcome · Supplier confirmed · Received · Write off · Reopen), tasks
  with done ticks, $ owed editable with Reset to auto.
- **Chip** on PO row / ASIN row / line, derived from open claims; hover
  lists each. Content (next step vs kind + $) — *Maria to decide (§8)*.
  Quiet colors (UI rule).
- **Open a claim** from a line's menu (kind, qty prefilled from the gap
  when AF knows it, note). Replaces the two manual action items.
- Dashboard: Refunds due, Spend per §3.6; Cost of goods lines per §3.6.

## 6. Fixtures (real cases, facts from the 2026-11-07 probe)

- **Caress 200015557295492** — missing 1 of 12, refund expected (Walmart
  chat refused). AF ASIN qty 6.00, received 5.5; Velocity 8127 fully
  received (12 singles).
- **Caress 200015663718988** — 11 bought, ASIN qty 5.5; Velocity 9822 qty
  10, fully received. §3.7: dismiss with note, close by hand.
- **Voltage 65705** — 1 received of a 12-pack; supplier (writes from
  voltagesupply.com) said 11/2 the remaining 11 jars ship next day; second
  UPS tracking 11/3 already pushed to the same Velocity order 6778 (1 of 12
  received). Replacement under the same order # (D10).
- **Waffle mix — goldenwaffles.com 8307** (10/23, PO note "Expires in a
  month") — expired, return requested. Velocity 8787: 6 of 18 received;
  AF shows received 0 / at prep 0 (sync gap to check).
- **Oreos — walmart.com 200015193721348** (9/10) — cant_sell (gated).
  Return started 10/31, label PDF attached to the email, refund $47.76 to
  OnePay. Velocity 5667: 8 singles, status inventory; AF shows 4 shipped
  FBA (mismatch to check).
- **petsmart.com 1113689148** (3/31/2026, home PO, sheet import; AF status
  Closed with `closed_at` empty) — Maria 2026-11-06: fix with this patch.
  - Bil-Jac B07762PPYF (4-pack): 21 ordered, 15 received; V/W 6 units /
    $15.46 → write-off.
  - Rachael Ray B07KWJTLCN (Pack of 2): 5 ordered in AF and the sheet;
    sheet note "Ordered 20. 5 got canceled. Also, PetSmart shipped 3, 2 of
    them bigger size instead of 5 smaller size"; 1 received, 0.5 shipped
    FBA combined at Velocity with another PO's units (§3.7); 2 units still
    to ship, then the PO closes by hand. Claims proposed in the dry run for
    Maria (the note and the qty disagree).
  - Top Fin B0BXBP5GZP: 4/4, fine.
  - Sheet subtotal $194.10 is $40.47 above the lines' sum.
- **michaels.com 9800109062072825** (2/16/2026, 120 items, $384.55; AF
  status Closed with `closed_at` empty) — three partial cancellations
  (2/18 $9.96, 2/18 $17.85, 2/19 $8.30) refunded as one Michaels eGift card
  $36.11 (2/19); no separate cancellation emails. Red Heart Cherry Red
  B07N6V47HC: 60 ordered, 49 received. → canceled claims linked to one
  refund; the sheet's 11 / $32.25 loss is not converted (§0).
- **Never received — dkhardware.com DKH-3192308** (6/8): "Delivery issue"
  6/22, cancellation + "Refund Issued … $77.23" 8/25. AF: closed, 0
  received, refund 0.
- **Full cancel — Jellycat 8918590** (9/2): cancelled 9/3, refund $380.00.
  AF: order total $0, open, no tracking.

## 7. Email facts (probe, orders@, 90 days)

- **Walmart:** fixed templates, regex reliable. "You're getting a $X
  refund: [item]" (amount in subject; order # in body with a dash,
  2000155-50741831); "Canceled: … from delivery" (no amount); "Drop off
  your return at FedEx by …" (label PDF, refund amount, card last 4);
  "Return pickup confirmation" (PDF); "We received your return"; "Your
  replacement is in the works".
- **Target:** cancel email shows only the order #'s last 4; replacement
  emails "processing your replacement request" / "replacement item is ready
  to ship".
- **Michaels:** refunds and cancellations arrive as "You received a gift
  card" (amount + order # in body); customer care in "Case Number" threads;
  reships get their own order # (R…) → `alt_order_ids`.
- Regex-able refund/cancel senders: Home Depot "Credit Applied to Order
  WK…", DK Hardware "Refund Issued for Order# DKH-…", Jellycat, Sephora,
  Supplyhouse, Staples, Blick (oraclecloud.com); Carter's damage claims
  from carters.narvar.com.
- Haiku: free-text supplier replies (7 in 90 days: Voltage from
  voltagesupply.com, Hardware World, Michaels Customer Care, Yankee Candle,
  First Choice Buying).
- Noise to exclude: Spoiled Child loyalty "credit", one.app credit-score
  mail.
- Full list: `docs/po-issues-probe-supplier-emails-2026-11-07.csv` (probe
  file names keep their original names).

## 8. Open for Maria (before commit 1's live run)

1. ~~Legacy badges~~ — decided 2026-11-07 (§4.8).
2. UI (§5) — to be settled with Maria; §5 is a draft until then.
3. ~~Aggregator provider~~ — EasyPost, decided 2026-11-07 (§3.8).

## 9. Commits

0. ~~Probe~~ — done 2026-11-07 (report in this chat; CSVs in docs/).
1. Migration §4.1–4.6 (renames, new tables, columns); conversions §4.8
   (dry run → Maria reviews → live).
2. Lifecycle + quantities (§3.5) + money (§3.6, incl. manual override) +
   Claims tab / inbox + chips + Open a claim; retire the two manual action
   items.
3. Tracking parser fix (§3.9) + placeholder backfill (dry run → report →
   live).
4. EasyPost aggregator (§3.8, migration §4.7): register, webhook, daily
   backstop, store; Velocity `tracking_status` fallback.
5. Auto-found: missing (D8), never_received (§3.1) as suggestions.
6. Email: supplier replies, refund/credit confirmations, labels in replies
   (regex first per §7, Haiku for free text).
7. Returns: label → document + tracking (direction = return) + reminders.
8. Replacements on the original PO (`alt_order_ids`, tracking ↔ claim) +
   §3.7 dismiss-with-note.
9. Dashboard lines; SPEC §22/§26/§11, CLAUDE.md; mark the cancellations
   patch's §3/§5 superseded.

Stops: after 1's dry run, after 3's backfill dry run, before 4's EasyPost
signup (Maria creates the account and sets the env vars), and for anything
this patch doesn't cover.
