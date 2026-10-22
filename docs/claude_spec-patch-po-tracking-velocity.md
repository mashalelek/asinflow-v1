# Spec patch — PO tracking numbers → Velocity

Status: READY FOR APPROVAL 2026-10-21 — decisions D1–D6 answered; §9 filled from the Claude Code probe (2026-10-21). Domain-wide delegation for `asinflow-sheets` → `orders@` (scope `gmail.readonly`) is set up and the Gmail API is enabled in the same Cloud project.
Repo path: `docs/claude_spec-patch-po-tracking-velocity.md`. Adds SPEC §26 "PO tracking".

## 1. Goal

Supplier shipping emails arrive at `orders@coastalqualitygoods.com` (incl. `mpeters.cqg+alias@gmail.com` forwards). AF reads them, extracts carrier + tracking number + retailer order #, attaches each tracking number to the AF PO, and pushes it to the matching Velocity inbound orders so Velocity can check POs in accurately. Where the PO can't be pushed, AF raises an action item for Maria.

Tracking only matters while the PO is still in Velocity's **Inbound** (unit_status `pending` / `partially_received`): pushes target only those orders. Fully received and shipped orders are never pushed to — but they ARE consulted for the action item (amended 2026-10-21, Maria, stop b): a PO Velocity already received or shipped is not a missed upload, so it raises nothing.

## 2. Decisions (answered 2026-10-21)

- **D1 — Automation.** Tracking-only push is EXEMPT from the "no cron for Velocity" rule. It runs as a component of the 00:00 ET pass (gated by `ENABLE_CRONS` like everything else) and is also triggerable manually. It never creates Velocity orders and never changes quantities — it only adds tracking to existing inbound orders. Principles file / SPEC §14 get this rider.
- **D2 — Gmail access.** Existing Google service account `asinflow-sheets` (`google-credentials.json`) + domain-wide delegation on the Workspace domain (DONE), impersonating `orders@coastalqualitygoods.com`, scope `https://www.googleapis.com/auth/gmail.readonly`. Gmail API enabled (DONE). No OAuth consent flow, no refresh tokens.
- **D3 — Parser.** Carrier-pattern regex first; AI extraction (Claude API) as fallback for shipped-type emails where regex finds no tracking or no order #. Anything still unresolved → unmatched queue.
- **D4 — Matching key.** Supplier (from sender domain) + retailer order #. Order IDs carrying an AF suffix (`_N`) match on the base ID. If the base matches more than one PO → unmatched queue, Maria picks.
- **D5 — Backfill.** POs currently in Velocity Inbound (`pending` or `partially_received`). Gmail scan window for backfill = oldest order date among those POs → now.
- **D6.** Velocity's receiving address is 805 Grandy Ave, La Grande, OR 97850. Home: 65 Rivercrest (the only home address).

## 3. Data model

Migration NNN:

```
po_tracking
  id                  bigserial PK
  po_id               FK purchase_orders, nullable (NULL = unmatched)
  carrier             text            -- normalized AF value: UPS / FEDEX / USPS / DHL / AMAZON / ONTRAC / LASERSHIP / OTHER
  tracking_number     text NOT NULL
  retailer_order_id   text            -- as printed in the email
  supplier_guess      text            -- from sender domain map
  ship_to_street      text            -- normalized "number + street word", e.g. "805 grandy"; NULL if not in email
  shipped_at          timestamptz     -- email date unless the email states a ship date
  items_json          jsonb           -- [{name, qty}] when the email lists per-shipment items (Target does)
  gmail_message_id    text NOT NULL
  gmail_thread_id     text
  source              text NOT NULL   -- 'regex' | 'ai' | 'manual'
  status              text NOT NULL   -- 'unmatched' | 'matched' | 'pushed' | 'push_failed' | 'held'
  push_error          text
  pushed_at           timestamptz
  pushed_velocity_ids text[]          -- Velocity order_ids this tracking was pushed to
  suppressed_at       timestamptz     -- set when Maria manually clears the action item (see §8)
  reassigned_from_po_id FK purchase_orders, nullable
  reassigned_at       timestamptz
  created_at / updated_at
  UNIQUE (carrier, tracking_number)
```

Dedup is on `(carrier, tracking_number)`, not message id — "shipped", "out for delivery" and "delivered" emails repeat the same number. A repeat email updates `gmail_message_id`/`shipped_at` only if the row is still `unmatched`; otherwise it is ignored.

`purchase_orders.ships_to text NOT NULL DEFAULT 'velocity'` — values `velocity` | `home`. Shown and editable on the PO; on the New PO form (default Velocity). Backfill: all existing POs → `velocity`.

`gmail_sync_state` (or a row in an existing settings/kv table): `last_history_id` / `last_scanned_at` watermark for the mailbox.

Settings (AF Settings page, stored in DB):
- `tracking.velocity_street` = "805 grandy"
- `tracking.home_streets` = ["65 rivercrest"]
- `tracking.supplier_domain_map` — sender domain → AF supplier name (editable table; see §6)
- `tracking.carrier_map` — AF carrier → Velocity carrier string (seed: FEDEX→"FedEx", UPS→"UPS", USPS→"USPS", DHL→"DHL", AMAZON→"Amazon", ONTRAC→"OnTrac", LASERSHIP→"LaserShip"; Claude Code corrects from Velocity docs if they define an enum)

## 4. Gmail ingestion

- Component `po_tracking_ingest` in the 00:00 pass (runs after Sync POs so new POs exist before matching) + manual trigger button on the POs page ("Sync tracking").
- Auth: service-account JWT with `subject = orders@coastalqualitygoods.com`. Commit 2 includes a one-shot `npm run gmail:check` that lists the 5 most recent subjects, to verify delegation before anything else is built on it.
- Query: messages since watermark, excluding `category:promotions`. Fetch plain-text body (fall back to HTML→text).
- Candidate email = body contains a carrier-pattern match OR subject/body contains shipped-type language ("shipped", "on the way", "on its way", "tracking", "about to ship", "out for delivery", "delivered"). Non-candidates are skipped and the watermark advances.
- Carrier patterns (Claude Code refines; require a tracking-context word within ~60 chars for the ambiguous all-digit formats to avoid phone/order numbers):
  - UPS `1Z[0-9A-Z]{16}`
  - FedEx 12, 15, 20, 22 or 34 digits
  - USPS 20–22 digits starting with 9, or `[A-Z]{2}\d{9}US`
  - DHL 10 digits (context required)
  - Amazon Logistics `TBA\d{12}`
  - OnTrac `C\d{14}`, LaserShip `1LS\d{12,}`
- Retailer order #: nearest "Order #|Order number|Order:" token; multiple distinct order #s in one email → one row per (order #, tracking) pair, only if the email structure clearly pairs them, otherwise unmatched with a note.
- Ship-to: look for "Delivers to|Ship to|Shipping Address" block; normalize to `"<number> <first street word>"` lowercased (e.g. "805 Grandy Ave" and "805 Grandy Avenue" both → "805 grandy"). Zip/suite/unit ignored.
- Per-shipment items: parse `name / Qty: N` pairs when present (Target). Stored only; no quantity logic in this patch.
- AI fallback (D3): for a candidate email where regex yields no tracking or no order #, call Claude API with the plain text and a fixed JSON schema `{carrier, tracking_number, retailer_order_id, ship_to, items[]}`. `source='ai'`. Requires `ANTHROPIC_API_KEY` in Render env. If the key is absent, skip the fallback and queue the email as unmatched with reason `ai_disabled`.

## 5. Matching

1. `supplier_guess` from sender domain via `supplier_domain_map` (§6). Unknown domain → row stays `unmatched`, reason `unknown_sender`; the queue UI lets Maria map the domain to a supplier once, then re-match.
2. Find POs where `supplier = supplier_guess` and `base(order_id) = retailer_order_id` (base = order_id with a trailing `_N` removed).
   - 0 matches → `unmatched`, reason `no_po`. Re-tried on every run (the PO may be entered later).
   - 1 match → `matched`.
   - >1 matches → `unmatched`, reason `ambiguous`; Maria picks in the queue.
3. A row whose `po_id` was set manually (source `manual` or `reassigned_at IS NOT NULL`) is never re-matched or moved by the sync.

## 6. Supplier ↔ sender domain map

Seeded by Claude Code from the distinct supplier names in `purchase_orders` vs sender domains seen in the backfill scan; most will be the obvious pair (michaels.com ↔ Michaels, oe.target.com ↔ Target). Unmapped domains surface in the unmatched queue with a one-click "map to supplier" action. Stored in AF, editable under Settings.

## 7. Routing rules (per matched tracking row, evaluated on every run and on every new row)

"In Velocity" (amended 2026-10-21, Maria, stop b) = the PO appears **anywhere** in Velocity — inbound, inventory or shipments (`fetchAllKnownOrders`; bundle parents match through their children). Pushes still target only `GET /inbound` orders with `unit_status IN ('pending','partially_received')`. So each PO is **inbound** (the table's "yes" rows), **known** — Velocity already received / shipped it: no push, no action item — or **absent** (the table's "no" rows). The original reading (`/inbound` only) flagged ~53 already-received POs as "not in Velocity" in the 2026-10-21 local dry run.

| PO in Velocity | Email ship-to | `ships_to` | Result |
|---|---|---|---|
| yes | none, or agrees with `ships_to` | — | push tracking, no warning |
| yes | disagrees with `ships_to` | — | push tracking + action item (reason: address mismatch) |
| no | Velocity street | any | action item (reason: not in Velocity) |
| no | none | velocity | action item (reason: not in Velocity) |
| no | any | velocity | action item (reason: not in Velocity) |
| no | home street | home | `held`, no warning |
| no | none | home | `held`, no warning (amended 2026-10-22, Maria: was "any → not in Velocity") |
| no | unknown street (neither Velocity nor home) | any | action item (reason: unknown address) |

Address agreement = normalized street equality (§4); any street that is neither the Velocity street nor a home street counts as "unknown".

Additional triggers (same action item, different reason):
- Tracking arrives for a PO that is canceled/returned in AF → reason `shipped but canceled`.
- Velocity push fails → status `push_failed`, reason = Velocity error text.

No grace period: Maria uploads POs to Velocity daily and the tracking components run at 00:00, so a "not in Velocity" item normally means an upload was missed.

## 8. Action item

New auto-managed action item **"Review Velocity"** in the PO Action Items multi-select (separate from the manual "ATTN: Velocity"). The reason(s) show on the tracking row and in the PO's Action Items tooltip.

- Auto-set by the rules in §7.
- Auto-cleared when the triggering condition goes away: PO appears in Velocity Inbound (for "not in Velocity"), push succeeds (for `push_failed`).
- Manual clear suppresses only the tracking rows that existed at clear time (`suppressed_at` on the row); a new tracking row for the same PO re-evaluates and may re-raise it.

## 9. Velocity push (from the 2026-10-21 probe)

What Velocity has (`server/velocity-api.ts`, `server/routes.ts:2251–2253`, SPEC ~1180/1464):
- Tracking is a **per-order array**; each Velocity inbound order is one ASIN row of a PO, so one AF PO = N Velocity orders. There are no per-line fields below the order.
- `GET /inbound` returns `trackings: [{carrier, tracking_number, tracking_status}]` (e.g. `{"carrier":"FedEx","tracking_number":"875279827111","tracking_status":null}`).
- `PUT /inbound/:order_id` takes `trackingNumbers` and it must ALWAYS be sent (omitting it crashes their handler). Today the echo-merge sends back `trackingNumbers: current.trackings ?? []`.
- POST uses `tracking_numbers` / `trackings` (always empty today). Not touched by this patch — creates keep sending empty arrays; tracking goes on afterwards via PUT.
- UNVERIFIED: the element shape the PUT accepts — object `{carrier, tracking_number}` (GET shape) vs plain string. Resolved by the gated probe in commit 5 (below).

Push rules:
- Target set for a PO = every `GET /inbound` order whose `normKey(order_number)` = PO order_id and `status = 'inbound'` and `unit_status IN ('pending','partially_received')`. Push the PO's tracking numbers to **every** order in that set (Velocity's receivers see the same package for all ASIN rows). `items_json` is not used for per-ASIN targeting in this patch.
- **Amended 2026-10-22 (Maria, after the TEST-BUNDLE-001 probe):** every push — bundles (to the parent) and ordinary orders — goes through `PUT /inbound/bulk {order_ids, tracking_numbers}`, append-only, no echo, one call per target order with the numbers it lacks. The echo-merge below is superseded for tracking (SPEC §26 "Velocity push"); bundles are no longer hand pushes.
- ~~Echo-merge~~ (superseded) per order: fresh GET immediately before each PUT; `trackingNumbers` = existing `trackings` + any of the PO's tracking rows not already present (compare on `tracking_number`); all other fields echoed unchanged. Never remove an existing entry; never touch quantities, items or status.
- Carrier string via `tracking.carrier_map`.
- Idempotent: if every target order already has the number → row `pushed`, no PUT. Partial coverage → PUT only the missing orders. `pushed_velocity_ids` records where it landed.
- Any PUT error → row `push_failed` with the error text; the other orders in the set still get their PUT.
- Component `po_tracking_push` runs in the 00:00 pass right after `po_tracking_ingest`, and from the "Sync tracking" button. Dry-run (`?dryRun=true`) reports per PO: target orders, numbers to add, numbers already present.
- Cost privacy unchanged — nothing but carrier + tracking leaves AF.

Gated probe (commit 5, the ONE live write that needs Maria's go-ahead): `npm run velocity:tracking-probe -- --order <velocity_order_id> --carrier FedEx --tracking <n>` does GET → PUT with one object-shaped element → GET, and prints the before/after `trackings`. Run it on the real case in §10 (Velocity order(s) for PO 4798028553, tracking from PO 4800667218's email) so the probe is also the fix Maria needs. If the PUT rejects objects, retry with a plain string, and record which shape works in SPEC §26 and the push code.

## 10. Manual reassign (the case that started this)

POs 4800667218 and 4798028553 were switched at Velocity: 4798028553's package was checked in and shipped under 4800667218. Velocity now needs 4800667218's tracking on its 4798028553 inbound order(s).

On a tracking row: **Move to PO…** → pick another PO → sets `reassigned_from_po_id`, `reassigned_at`, `source='manual'`, re-runs §7 for the new PO (which pushes to Velocity's 4798028553 orders if they're in Inbound). The sync never moves a reassigned row back (§5.3), and dedup on tracking number means re-reading the original email creates no second row. The row shows "moved from 4800667218".

## 11. UI

- POs page → expanded PO → new **Tracking** tab: carrier, tracking # (link to carrier tracking page), order # as printed, shipped date, ship-to street, status chip, reason, pushed at + which Velocity orders, Move to PO…, Add tracking manually.
- POs page toolbar: **Sync tracking** button (ingest + push, with dry-run option) and an **Unmatched tracking (N)** chip opening the queue: rows with reason (`unknown_sender` / `no_po` / `ambiguous` / `ai_disabled`), actions: map domain → supplier, attach to PO, dismiss.
- PO row/form: `Ships to` field (Velocity | Home).
- Action Items: "Review Velocity" appears like the others, with reason on hover.

## 12. Backfill

1. Pull `GET /inbound` → set of PO order_ids with `unit_status IN ('pending','partially_received')` (84 orders today: 61 pending, 23 partially received).
2. Scan Gmail from the oldest order date among those POs; ingest per §4–§5.
3. Push per §7/§9 as a reviewed dry run first, then live.
4. Report: emails scanned / candidates / rows created / matched / unmatched by reason / pushed (orders touched) / action items raised.

## 13. Scheduler

Two new components appended to the daily block of the 00:00 pass, in order: `po_tracking_ingest`, `po_tracking_push`. Both after Sync POs. Not in the hourly passes.

## 14. SPEC / CLAUDE.md updates

- SPEC §14: Velocity rule reworded — manual-only for order creation and quantity changes; tracking-only pushes are allowed on the schedule.
- SPEC §11 (Velocity): PUT `trackingNumbers` element shape (from the probe), `tracking.carrier_map`.
- SPEC §22 (PO module): `ships_to`, Tracking tab, "Review Velocity" action item; `qty_shipped_supplier` note ("hand-entered until email tracking") updated to point at §26.
- New SPEC §26 "PO tracking" = §3–§12 of this patch.
- CLAUDE.md: Gmail DWD credentials note (same JSON, impersonation subject); `ANTHROPIC_API_KEY` optional.

## 15. Commits (single-concern, gated)

1. Migration: `po_tracking`, `purchase_orders.ships_to`, settings keys, sync watermark.
2. Gmail client (service account + DWD impersonation) + `gmail:check` + ingest component with regex parser + tests on fixture emails (Target, Michaels, Community Coffee at minimum; Claude Code captures 5–10 more from the mailbox as fixtures with order #s/addresses scrubbed).
3. Supplier domain map + matching + unmatched queue API.
4. Routing rules + "Review Velocity" action item.
5. Velocity push component (echo-merge) + dry run + `velocity:tracking-probe` — STOP for Maria's go-ahead before the probe's live PUT.
6. UI: Tracking tab, Sync tracking button, unmatched queue, Ships to field, Move to PO.
7. Scheduler registration + SPEC/CLAUDE.md.
8. Backfill run (dry → live) + report.
9. AI fallback (optional, last; skipped if no key).
