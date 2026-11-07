# SPEC Patch — PO issues: supplier problems, returns, cancellations

*Drafted 2026-11-05 with Maria (whiteboard walkthrough). Amends §22 (PO
module, incl. the "Supplier defects" section added by e424903 / migration
094), §26 (email ingestion), §11 (Velocity). Supersedes the data model and
review list of `docs/claude_spec-patch-po-cancellations-from-email.md`
(§3, §5); that patch's ingestion (§4), net quantities (§6) and backfill (§8)
stay valid and feed this one. Also supersedes the backlog's "Allocate to
another PO" (2026-11-05) and its "until built" workaround: see §3.7.*

> **Status: APPROVED 2026-11-06.** Tidied 2026-11-06 (duplicates merged,
> §3.6/§3.7 order, replacement-from-another-PO columns dropped, probe
> scope clarified). No decisions changed.

## 1. Why

Today a supplier problem is a badge plus a note. The defect record from
e424903 added qty and $ owed for one case. Refund-due rows hold the same
money a second time. Returns, replacements, expired and gated items, and
orders that never arrive have no record at all. Maria's process (whiteboard,
2026-11-05) has three branches from a PO: **Received** with a problem,
**Canceled** (full or partial), **Charged, not received**. All three end in the
same place: the supplier refunds, replaces, gives credit, or nothing happens
and it's written off. AF should hold that as one record per issue, do every
step it can check itself, and remind Maria of the rest.

## 2. Decisions (Maria 2026-11-05)

- **D1 — One record.** An issue carries the $ owed. Refund-due rows stop
  being a separate notion (§4.3 migrates them).
- **D2 — Kinds:** `missing` (short count) · `damaged` (damaged or defective,
  one kind) · `wrong_item` · `expired` (expired or short-dated) ·
  `never_received` (whole shipment: never shipped, or carrier lost it) ·
  `cant_sell` (gated / hazmat / restricted, e.g. the Oreos; not the
  supplier's fault, never counted as a supplier defect) · `canceled` (full
  or partial, from the cancellations patch).
- **D3 — One outcome per issue, no mix:** `refund_card` · `gift_card` ·
  `store_credit` · `replacement` · `write_off`.
- **D4 — Refunded items you keep are disposed** ("keep it" refunds
  included). Wrong items are always returned or tossed. Expired items are
  returned or disposed. None become stock.
- **D5 — Returns:** frequent (Walmart especially). 99% of the time Velocity
  ships them back with a label Maria sends on Discord. The label is saved on
  the PO and its tracking is followed.
- **D6 — Refund has two ticks:** *Confirmed by supplier* (email, automatic
  or by hand) and *Received* (Maria saw it on the card, gift card or store
  credit; always her tick). Until Received, the money counts as owed.
- **D7 — Reminders:** supplier hasn't answered in **7 days**; return
  delivered to supplier, no refund confirmation in **7 days**.
- **D8 — Velocity check-in lag:** "missing" is raised only after every
  tracking number on the PO shows delivered, **3 business days** have
  passed since the last delivery, and Velocity's received count is still
  below what shipped. Compare against shipped-and-delivered qty, never
  ordered qty.
- **D9 — Velocity can't take a note via API.** Steps AF can't do (tell
  Velocity a replacement is coming, send a label) are shown as tasks with a
  done tick.
- **D10 — Replacement under the same order #** becomes its own PO with
  order # `POID_replacement` (`_replacement-2` for a second).
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

`status` on the issue: `open` → `reported` → `awaiting_return` (only when a
return is needed) → `awaiting_resolution` → `resolved` (outcome set) →
`closed` (refund received / replacement arrived / written off). Every
transition is a History row on the PO with who and when.

### 3.1 Found

| Kind | How it's found |
|---|---|
| missing | Auto per D8 (Received by Velocity < shipped & delivered, after the lag), or Maria from Velocity's Discord message |
| damaged / wrong_item / expired / cant_sell | Maria, from Velocity's Discord message or her own check (home POs) |
| never_received | Auto: tracking not delivered by the carrier's estimated date, or carrier status looks lost (exception / returned to sender / no scan for 7 days / in transit more than 14 days with no scan in the last 3 days), or no tracking and no shipping email 14 days after the order date. Shows as a suggestion: "Looks not received. Open an issue?" Maria confirms. |
| canceled | Cancellations-from-email review list (that patch §4), or by hand |

Auto-found issues land as **suggested** (one click to open, one to dismiss);
they never change a PO until Maria opens them.

### 3.2 Reported

Maria clicks **Contacted supplier** (date, channel: chat / email / phone,
optional note). The 7-day "no answer" reminder starts.

**Supplier replies from email.** orders@ is already read every pass. A
message from the supplier's domain (alias map) that matches an open issue
(order # in subject/body or the thread of a known message) attaches to the
issue: "Supplier replied 11/5", one-line Haiku summary ("offers a refund of
$5.97", "wants it returned, label attached", "sending a replacement"), link
to the email. AF **suggests** the outcome; Maria confirms. A reply resets
the 7-day reminder. A label PDF in the reply is saved per §3.3.

### 3.3 Return (when the supplier wants it back)

- **Label:** Maria uploads it on the issue (or it arrives in a supplier
  email). Saved as a PO document `type = return_label`, named
  `YYYY-MM-DD_supplier_POID_return-label.pdf` in the Invoices month folder.
- **Tracking:** Haiku reads the tracking # and carrier off the label (fixed
  schema; regex first where the carrier format is unambiguous). Stored as a
  `po_tracking` row with `direction = return` (never pushed to Velocity as
  inbound).
- **Task:** "Send label to Velocity" with a done tick (Discord, by hand).
- Carrier status is checked every pass. Delivered to supplier → 7-day
  "no refund yet" reminder (D7).
- Units returned leave expected quantities exactly like a cancel (§3.5).

### 3.4 Resolved

| Outcome | What AF does |
|---|---|
| refund_card / gift_card / store_credit | Amount (prefilled from the supplier email or $ owed). *Confirmed by supplier* ticks itself when a refund/credit email matches (order # + amount within 1¢, or Maria confirms a looser match). *Received* is Maria's tick (D6). Gift card / store credit also records the card/credit name (feeds the Gift Cards page when it's built). |
| replacement | Links a replacement PO: same order # → AF creates `POID_replacement` (D10) with the issue's lines and qty at $0 cost; a new order # → pick or create that PO. Task "Tell Velocity: replacement on the way". Closed when the replacement's units are received by Velocity (or by Maria for home POs). |
| write_off | Reason required. $ → Supplier write-offs (D11). |

**No "replacement from another PO"** (Maria 2026-11-06): POs stay true to
the transactions. Units Velocity counts under a different PO are a
Velocity attribution mismatch (§3.7), not an issue outcome: no cost moves,
no link.

**Disposal (D4):** a refunded / written-off `damaged`, `wrong_item` or
`expired` issue whose units sit at Velocity gets a task "Velocity: dispose
N units" (or "return" when a label exists). The units leave At Prep Center
when Velocity's count drops; AF records `qty_disposed` on the issue.

### 3.5 Quantities

- An issue's qty reduces the line's **expected** units (On Order, the
  Velocity upload, auto-close) once its outcome is refund / credit /
  write-off, the same way `qty_canceled` does (cancellations patch §6).
- A replacement keeps the expected units on the original line until the
  replacement PO's units arrive, then the issue closes and the original
  line's expected units drop by the issue qty (the replacement PO carries
  them).
- **"Update Velocity"** = the existing Qty-mismatch opt-in PUT on the next
  Upload to Velocity plan (smaller qty), or delete the inbound order when a
  PO is fully canceled / never received with no units checked in. Never
  automatic.
- Stored, never derived: the issue qty is never computed from Ordered −
  Received (Received changes when replacements are checked in under the
  same Velocity order).

### 3.6 Money

- **$ owed** = issue qty × the line's **sourcing cost** per retailer unit
  (what was paid incl. tax and shipping, after coupons/sales, BEFORE the
  gift-card / card-reward % — the same basis as the Sourcing cost sent to
  Amazon), editable. never_received / full cancel = the
  PO total share of the lines.
- **Spend** (Dashboard) subtracts: refunds Received, plus open issues whose
  expected outcome is a refund or credit (amount still owed). A replacement
  is not money owed.
- **Refunds due** tile = Σ $ owed on open/resolved issues not yet Received.
- **Cost of goods block** gains two lines, live before the Finances patch:
  **Supplier write-offs** (write-off issues, dated by write-off date) and
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
  stored per PO + warning type + the quantities it was dismissed at; it
  stays dismissed until those quantities change, then comes back. A
  dismissed warning never blocks auto-close (e.g. 5.5 expected, 6 shipped
  FBA: "Extra units shipped" dismissed with note → the PO auto-closes).
- A PO whose units Velocity attributes elsewhere can't auto-close on its
  own count; Maria closes it by hand (existing Close), and the dismissal
  note shows on the PO.
- Tracking for the unit may still need to reach the other PO's Velocity
  order (the one-off rule from 8e9fbab); no general mechanism in v1.
- Any hand workaround made under the superseded backlog plan (ASIN qty set
  by hand, negative COGS adjustment, PO note on 200015663718988) is found
  by the probe and reverted with Maria's approval.

## 4. Data

### 4.1 `po_issues` (evolves the migration-094 defect table in place)

`id, po_id, po_line_item_id (NULL = whole PO), kind, qty (retailer units),
amount_owed, status, outcome, outcome_amount, outcome_detail (card / gift
card / store credit name), replacement_po_id, return_required,
qty_disposed, found_by (auto | maria | email), found_at, reported_at,
reported_channel, last_supplier_reply_at, supplier_confirmed_at,
received_at, closed_at, write_off_reason, note, created_by, updated_at`.

Warning dismissals (§3.7) are their own small table: `po_id, warning_type,
quantities_json (as dismissed), note, dismissed_by, dismissed_at`.

### 4.2 `po_issue_events`

One row per thing that happened: `issue_id, at, type (found | reported |
supplier_reply | label_saved | return_shipped | return_delivered |
outcome_set | supplier_confirmed | received | task_done | reopened),
gmail_message_id, po_document_id, po_tracking_id, summary, by`. The issue
page is this timeline.

### 4.3 Migration of existing data

- Defect rows (e424903) → `po_issues` 1:1 (200015557295492: missing, 1,
  $5.97).
- Refund-due rows on `po_line_refunds` → each becomes an issue (kind from
  its note when obvious, else `missing` flagged for review) with
  `amount_owed`; the due row is removed. Received refund rows stay as
  money history and link to their issue where one exists. Dry run lists
  every conversion; Maria reviews the "kind unclear" ones.
- `po_cancellations` (if built) → `kind = canceled` issues; the
  cancellations review list becomes the **Issues** inbox (§5).
- **Sheet write-offs:** the Orders sheet's "Unreimbursed Product Loss Qty"
  and "Unreimbursed Loss Amount (adjusted)" columns (V/W, "Unreimb. Loss",
  imported but unused in AF) are sheet-era write-offs. Each non-empty pair
  → a closed `write_off` issue (kind `missing` unless the row's notes say
  otherwise; qty in retailer units, amount from W), dated by the PO's last
  edit, so Supplier write-offs history is complete. Fixture: petsmart.com
  1113689148, Bil-Jac B07762PPYF — 6 units, $15.46. Dry run lists all
  rows; nothing is written until Maria approves.
- The 60 legacy badges (`missing-damaged-badges-2026-11-05.csv`) stay as
  badges; Maria converts the open ones by hand from the list (Voltage 65705
  → damaged/missing with outcome replacement is the first).

## 5. UI

- **POs page → Issues** (replaces the Cancellations chip): tabs *Needs me*
  (suggested, reminders due, outcome to confirm, Received to tick, tasks),
  *Waiting on supplier*, *Waiting on return / replacement*, *Closed*.
  Each row: PO, supplier, kind, qty, $ owed, status, last event, next step.
- **PO page → Issues tab** (replaces Supplier defects on Payments): the
  issue timeline (§4.2), buttons per step (Contacted supplier · Upload label
  · Set outcome · Supplier confirmed · Received · Write off · Reopen), tasks
  with done ticks.
- **Badge** on PO row / ASIN row / line: derived from open issues, shows
  kind + qty + $ ("missing 1 · $5.97"); hover lists each.
- **Open an issue** from a line's menu (kind, qty prefilled from the gap
  when AF knows it, note).
- Dashboard: Refunds due, Spend per §3.6; Cost of goods lines per §3.6.

## 6. Fixtures (real cases)

- 200015557295492 — missing 1 of 12, refund expected (Walmart chat refused).
- 200015663718988 / 200015557295492 — Velocity attribution mismatch
  (§3.7): dismiss with note, close by hand.
- Voltage 65705 — 1 received instead of 1 × 12-pack; supplier sent a
  replacement.
- Waffle mixes (Velocity 11/3: expire next month) — expired, return
  requested. *Maria: PO #?*
- Oreos — cant_sell (gated), return label sent 10/31. *Maria: PO #?*
- petsmart.com 1113689148 (3/31/2026, home PO, sheet import, open, PO note
  "Finalize COGS when order is fulfilled") — Maria 2026-11-06: fix it with
  this patch, not before. Several kinds on one PO:
  - Bil-Jac B07762PPYF (4-pack): 21 ordered, 15 received (sheet col M) →
    5.25 ASIN units in AF, 3.25 shipped FBA; sheet records an unreimbursed
    loss of 6 units / $15.46 (cols V/W) → write-off.
  - Rachael Ray B07KWJTLCN (Pack of 2): sheet note "Ordered 20. 5 got
    canceled. Also, PetSmart shipped 3, 2 of them bigger size instead of 5
    smaller size" → cancel + missing + wrong item; 1 received, 0.5 shipped
    FBA combined at Velocity with another PO's units (§3.7); 2 units still
    to ship, then the PO closes by hand.
  - Top Fin B0BXBP5GZP: 4/4, fine.
  - The combined promo "Buy 3 Get 1 Free Select Dog Treats + Buy 1 Get 2nd
    50% off Select Aquatic Media + SMART20 + Autoship savings" has no type.
  Probe (commit 0) reads the sheet row values and notes for this PO and
  proposes the issues before anything is written.
- michaels.com 9800109062072825 (2/16/2026, sheet import, open) — Maria
  2026-11-06: fix with this patch. Several partial cancellations, each
  refunded (Michaels order page "Cancellation Summary": 2/18 6 items
  $9.96, 2/18 4 items $17.85, 2/19 5 items $8.30, possibly more); Red Heart
  Cherry Red B07N6V47HC: 60 ordered, 49 received (sheet col M), sheet ASIN
  qty 20 (multi-pack ×3). Good test of several canceled-and-refunded issues
  on one line, matched from the cancellation emails.
- A never-received case and a full cancel from the mailbox (Code picks,
  scrubbed).

## 7. Commits

0. Probe (read-only, production): current defect / refund-due / badge
   counts; which suppliers' refund-confirmation and reply emails exist in
   orders@ (top 15 suppliers, 90 days), with examples; carrier statuses
   available for "looks lost"; whether a fully checked-in Velocity order
   accepts a qty PUT — answered from Velocity's docs and past responses
   only, **no PUT against production** (if unknown, say so; test later on
   a throwaway order with Maria's OK); the petsmart 1113689148 sheet row
   (§6); any hand workaround on 200015663718988 (§3.7). Report, stop.
1. `po_issues` + `po_issue_events` + warning dismissals migration from the
   094 table; refund-due conversion (dry run → Maria reviews → live).
2. Lifecycle + quantities (§3.5) + money (§3.6) + Issues tab/inbox + badges.
3. Auto-found: missing (D8), never_received (§3.1) as suggestions.
4. Email: supplier replies, refund/credit confirmations, labels in replies
   (Haiku summary + suggestion; regex first where reliable).
5. Returns: label upload → document + tracking (direction = return) +
   reminders.
6. Replacements: `POID_replacement` creation; §3.7 dismiss-with-note.
7. Dashboard lines; SPEC §22/§26/§11, CLAUDE.md; mark the cancellations
   patch's §3/§5 superseded.

Stops: after 0, after 1's dry run, and for anything this patch doesn't cover.
