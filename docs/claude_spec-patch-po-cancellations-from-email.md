# Spec patch — PO cancellations from email (+ net quantities everywhere)

Status: DRAFT 2026-10-23 — decisions D1–D4 answered by Maria 2026-10-23. Absorbs the still-valid parts (§2, §3) of the on-hold Col BA patch (`claude/spec-patch-canceled-qty-col-ba.md`), which is retired by this one.
Repo path: `docs/claude_spec-patch-po-cancellations-from-email.md`. Adds SPEC §27 "PO cancellations"; touches §11, §22, §26.

## 1. Goal

Suppliers email item or whole-order cancellations. AF reads them from the same mailbox and ingest pass as tracking (§26), matches them to the PO, and puts each one in a **Cancellations review list**. Nothing on the PO changes until Maria confirms a row — she also has to confirm the refund, which can't be automated yet. On confirm, AF writes the canceled quantity on the product line and carries a "Confirm Refund / Replacement" action item until the refund is marked received.

Once a cancel is on the line, every reader must use the **net** quantity: On Order on the ASINs page, the quantity sent to Velocity, auto-close. Those two readers are fixed in this patch (they were §2/§3 of the Col BA patch and apply regardless of where the cancel is entered).

## 2. Decisions

- **D1 — AF owns `qty_canceled`.** Confirmed cancellations are written by AF. The Orders sheet's Col BA is read **once, on intake** of a new PO (cheap, and it's what the VA fills today); after that the sheet is never consulted for cancels. The Sync POs drift report shows a BA edit on an already-imported PO as "sheet differs from AF" so nothing is lost silently. The "sheet-owned for now" rider from 2026-10-21 is dropped.
- **D2 — Refund tracking:** date, amount, payment method.
- **D3 — No AI.** Per-retailer/regex extraction for the big senders; anything the parser can't read still lands in the review list with the email link and empty fields for Maria to fill. The extraction sits behind one interface so an LLM step can be added later (Anthropic API, minimal use — Maria 2026-10-23) if the unparsed pile grows.
- **D4 — "Delayed" emails are ignored.**
- From the Col BA patch, adopted as decided here: blank BA at intake → `qty_canceled` NULL (not tracked), as today; On Order / auto-close use per-line COALESCE (a tracked cancel always counts, an untracked line counts 0); Status "Canceled" with a smaller BA → BA wins.

## 3. Data model

Migration NNN:

```
po_cancellations
  id                    bigserial PK
  po_id                 FK purchase_orders, nullable (NULL = unmatched)
  po_line_item_id       FK po_line_items, nullable (set on confirm, or by the parser when the line is unambiguous)
  kind                  text NOT NULL   -- 'cancel' | 'return'   (return rows come from the §26 'return' marker)
  scope                 text            -- 'full' | 'partial' | NULL (unknown)
  reason                text            -- 'out_of_stock' | 'payment' | 'security' | 'customer' | 'other' | NULL
  items_json            jsonb           -- [{name, qty, sku?}] as printed in the email
  qty_proposed          numeric         -- product units AF proposes for the line (NULL when it can't)
  refund_amount_email   numeric         -- as stated in the email, if any
  refund_method_email   text            -- e.g. "OnePay CashRewards ending in 0302"
  retailer_order_id     text
  supplier_guess        text
  gmail_message_id      text NOT NULL UNIQUE
  gmail_thread_id       text
  email_date            timestamptz
  source                text NOT NULL   -- 'regex' | 'manual'
  status                text NOT NULL   -- 'pending_review' | 'confirmed' | 'dismissed' | 'unmatched'
  qty_confirmed         numeric         -- what Maria confirmed (product units)
  confirmed_at          timestamptz
  refund_received_at    timestamptz
  refund_amount         numeric
  refund_method         text
  notes                 text
  created_at / updated_at
```

`po_line_items.qty_canceled` is the target (product units; cap `qty_ordered`; existing FBA-shipment guard applies). No new quantity columns.

Settings: `cancellations.sender_rules` is not a setting — retailer parsers are code with fixtures (§4). Reuse `tracking.supplier_domain_map`, `tracking.platform_senders`, `supplier_aliases` (PO matching patch) and the shared order-# normalization.

## 4. Ingestion (same pass as tracking, component 25)

- Classifier: an email is a cancellation candidate when it has an order # **and** cancellation language in the subject or body ("canceled", "cancelled", "cancellation", "out of stock", "couldn't complete your order", "unable to fulfill", "unable to process your order", "won't be charged"). Excluded: subscription/trial/credit "cancellation" mail with no order # (SpoiledChild, WebstaurantPlus), gift-card-from-cancellation notices, and "delayed" notices (D4).
- Forwarded emails (e.g. Kohl's via maria@): sender and date come from the forwarded header block, not the envelope.
- Extraction per retailer family, fixtures from the mailbox (scrubbed): Walmart ("Canceled: … items from delivery", item + Qty + hold amount + payment method), Target, Macy's ("Items from your order are out of stock"), Sephora (full cancel), Bath & Body Works (full), BigBadToyStore ("canceled due to non-payment", qty + item), Oracle-hosted "Order Cancellation Summary" (SKU + qty), SupplyHouse (security). Generic fallback: order #, scope guess from wording ("your order has been canceled" → full; "some items"/"items from your order" → partial), items list if a `Qty:` pattern exists; otherwise fields NULL.
- Matching: supplier (sender → domain map → aliases; platform senders → store name from subject) + normalized order #; `_N` base rule. One PO → `pending_review`; none → `unmatched` (retried every run); several → `unmatched`, reason ambiguous.
- Line proposal: if the PO has one product line, or exactly one line whose product name shares ≥ 2 distinctive tokens with the email item name, set `po_line_item_id` and `qty_proposed` = email qty (full scope → `qty_ordered`). Otherwise leave both NULL; Maria picks in the list.
- Returns: rows the §26 tracking parser marks `return` are mirrored here as `kind = 'return'` (same review flow; confirm writes `qty_returned` instead).

## 5. Review list and confirm flow

POs page toolbar chip **Cancellations (N)** (pending_review + unmatched). Each row: PO (link), supplier, email date, scope/reason, items as printed, proposed line + qty, refund amount/method from the email, link to the email. Actions:

- **Confirm** — line picker (prefilled when proposed), qty (prefilled; capped at `qty_ordered − qty_canceled`), optional note. Writes `qty_canceled += qty` on the line (edit-log row), sets `status = confirmed`, and adds the **"Confirm Refund / Replacement"** action item to that line (per-line model from PO table v2; until that ships, on the PO). Full-scope confirm on a multi-line PO confirms every line at once with a single click after review.
- **Refund received** — date (default today), amount (prefilled from the email), method (prefilled). Clears "Confirm Refund / Replacement" for that line if no other open cancellation on it.
- **Dismiss** — not a real cancellation / already handled; keeps the row under a "Dismissed" toggle.
- **Attach to PO** on unmatched rows (one-click when the order # suggests one), **Add cancellation manually** for ones that never came by email.

The PO's Cancellations tab (expanded view) lists its rows, confirmed and pending, with refund state.

## 6. Net quantities everywhere (from the Col BA patch §2–§3, unchanged in substance)

1. **Upload to Velocity sends net quantities.** In `loadAfPoRows`, every quantity term nets the line's cancel: `net_ordered = qty_ordered − COALESCE(qty_canceled, 0)`; ASIN qty, sets and Col-AZ-equivalent `quantity` derived from the net values. Fully canceled lines stay excluded / delete-candidates as today. A partial cancel → smaller `quantity`: new orders CREATE at net; existing inbound orders show under Qty mismatches as opt-in PUTs (never pre-ticked); shipped orders flag-only. Net not divisible by `units_per_pack` → `invalid_pack_math`.
2. **On Order and auto-close count every tracked line.** `PIPELINE_ROWS_SQL` and the `po-close` aggregate sum `COALESCE(qty_canceled, 0) × yield` per line; the "any line untracked → NULL" clause is dropped for these two consumers. The PO page's displayed Canceled column keeps the §22 display rule (em-dash when any line is untracked).
3. **Intake reads Col BA on insert only** (`COL.qtyCanceled = 52`, read range to BA, header expectation `[52, "Product Qty Canceled"]`, bad-cell rule BA > L skips the PO and lists it; BA ≥ L = fully canceled; Status Canceled + smaller BA → BA wins). Drift report gains `qty_canceled`.

## 7. Routing interplay with tracking (§26)

- A tracking email for a PO whose lines are all fully canceled → existing "shipped but canceled" Review Velocity reason (unchanged).
- A cancellation row on a PO that already has tracking pushed to Velocity → no automatic Velocity change; the Qty-mismatch path in §6.1 surfaces it on the next Upload to Velocity plan.

## 8. Backfill

Scan window = same as tracking backfill (2026-07-29 →), cancellation candidates only, into `pending_review` / `unmatched`. Dry run reports: candidates / matched / unmatched by reason / proposed-line coverage. No PO is changed by the backfill — only Maria's confirms write.

## 9. SPEC / CLAUDE.md

- New SPEC §27 "PO cancellations" = §3–§8.
- SPEC §22: `qty_canceled` ownership (AF; BA on intake only), per-line COALESCE for On Order / auto-close, Cancellations tab, "Confirm Refund / Replacement" auto-set/auto-clear.
- SPEC §11: net quantities in `loadAfPoRows`.
- SPEC §26: cancellation classifier runs in the same ingest; `return` rows mirror into `po_cancellations`.
- Retire `claude/spec-patch-canceled-qty-col-ba.md` (note in its header: absorbed by §27).

## 10. Commits (single-concern, gated)

1. Migration: `po_cancellations`; intake Col BA read (header expectation, bad-cell rule) + drift report column; tests.
2. Net quantities: `loadAfPoRows` + `PIPELINE_ROWS_SQL` + `po-close` per §6.1–6.2; tests (single line, multi-line S=1, multi-pack, bundle; one canceled line on a two-line ASIN row). Gate: Velocity plan preview against production, read-only — report any Qty-mismatch rows it now surfaces.
3. Cancellation classifier + retailer parsers + fixtures (≥ 8 from the mailbox, scrubbed) + matching + line proposal.
4. Review list UI + Confirm / Refund received / Dismiss / Attach / Add manually + PO Cancellations tab + action-item set/clear.
5. Return rows mirrored from §26.
6. Backfill (dry → report → live) + SPEC/CLAUDE.md; retire the Col BA patch doc.

Stops: after commit 2's production plan preview (show Maria what Qty mismatches appear before anything else lands), and for anything the patch doesn't cover.
