# PO Module — v1 Frame Plan

Scope of this document: the **frame only** — schema, 2026 importer, list view, and a
read-only expanded view. The entry form is layer 1, not the frame. The frame proves the
data model renders correctly against real migrated data before we build any input UX.

Guiding constraint: **the frame is purely additive.** The Google Sheet stays the source
of truth for every existing integration (PO sync → actual_cogs/prep_override, Velocity
export, SB COGS export, sourcing-cost export). Nothing repoints to the new tables until
a deliberate cutover layer. Zero changes to existing code paths beyond the POs page
itself.

---

## 1. Schema (migration 028)

Three tables + settings-backed lookup lists. No gift-card tables, no subscription
scheduling, no file storage — just the indicator booleans.

```sql
CREATE TABLE purchase_orders (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id        TEXT NOT NULL,            -- supplier's real order number
    order_date      DATE NOT NULL,
    supplier        TEXT NOT NULL,            -- bare domain
    status          TEXT NOT NULL DEFAULT 'Ordered',  -- comma-joined tokens, sheet vocabulary

    -- money (order level)
    subtotal        NUMERIC(12,2) DEFAULT 0,
    tax             NUMERIC(12,2) DEFAULT 0,
    sh_donations    NUMERIC(12,2) DEFAULT 0,  -- S&H + Donations
    discount        NUMERIC(12,2) DEFAULT 0,  -- order-level discount
    refund_amount   NUMERIC(12,2) DEFAULT 0,
    order_total     NUMERIC(12,2) DEFAULT 0,

    -- payment
    payment_method  TEXT,
    weighted_gc_discount_pct NUMERIC(6,2),    -- plain number; no GC ledger in v1
    promo           TEXT,
    cashback_site   TEXT,
    cashback_pct    NUMERIC(6,2),

    -- meta
    purchased_by    TEXT,                     -- entry default 'Maria' (UI concern)
    subscription    BOOLEAN DEFAULT FALSE,    -- plain flag, alerts deferred
    email_used      TEXT,                     -- entry default mpeters.cqg@gmail.com (UI concern)
    invoice_attached BOOLEAN DEFAULT FALSE,   -- replaces Rcpt; file storage is a later layer
    notes           TEXT,                     -- PO-level notes

    source          TEXT NOT NULL DEFAULT 'manual'
                    CHECK (source IN ('manual','sheet_import')),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE (supplier, order_id)               -- order IDs collide across suppliers (§10)
);

CREATE TABLE po_asins (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    po_id           UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    asin            VARCHAR(10) NOT NULL,
    asin_name       TEXT,                     -- snapshot at entry/import
    sku             VARCHAR(50),              -- our AMAZON SKU (primary_sku at entry); NULL → amber warning. UI label: "Amazon SKU"
    qty             INTEGER NOT NULL DEFAULT 0,       -- sheet Col N (per-ASIN total)
    cost_per_unit   NUMERIC(10,2),            -- adjusted COGS snapshot (sheet Col Y)
    prep_cost       NUMERIC(10,2) DEFAULT 0,  -- per unit; blank-on-real-row = 0 (§3)
    sold_as         TEXT DEFAULT 'individual'
                    CHECK (sold_as IN ('individual','multi-pack','bundle')),
    units_per_pack  INTEGER DEFAULT 1,        -- forced 1 when sold_as = individual
    unreimbursed_loss_qty    INTEGER DEFAULT 0,
    unreimbursed_loss_amount NUMERIC(10,2) DEFAULT 0,
    notes           TEXT,
    UNIQUE (po_id, asin)
);

CREATE TABLE po_line_items (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    po_id           UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    po_asin_id      UUID REFERENCES po_asins(id) ON DELETE SET NULL,
    position        INTEGER,                  -- stable display order within the PO
    product_name    TEXT,
    supplier_sku    TEXT,                     -- sheet SKU/UPC (Col F), often blank. UI label: "Supplier SKU / UPC"
    price           NUMERIC(10,2),
    item_discount   NUMERIC(10,2) DEFAULT 0,  -- NEW per-item discount ($); % helper in form later
    qty_ordered     INTEGER,
    qty_received    INTEGER,                  -- NULL = not yet tracked (blank in sheet)
    qty_refunded    INTEGER DEFAULT 0,
    asin_qty_per_product NUMERIC(8,2) DEFAULT 1,  -- yield: 5-pack → 5
    adjusted_product_cost NUMERIC(10,2),      -- snapshot (sheet Col X)
    notes           TEXT
);

CREATE INDEX idx_po_date ON purchase_orders(order_date DESC);
CREATE INDEX idx_po_supplier ON purchase_orders(supplier);
CREATE INDEX idx_po_asins_po ON po_asins(po_id);
CREATE INDEX idx_po_asins_asin ON po_asins(asin);   -- powers the future POs-by-ASIN view
CREATE INDEX idx_po_lines_po ON po_line_items(po_id);
```

**Lookup lists live in the existing `settings` table** (JSONB), not new tables:

- `po_payment_methods` — seeded: Gift cards, Amex (1001), Amex (1005), Chase (7927),
  Chase (9647), Chase Ink (7927), Chase (6120), Citi (9510), Discover, Webstaurant Visa
- `po_cashback_sites` — seeded: BeFrugal, TopCashback, Rakuten, RetailMeNot, Coupert
- `po_emails` — seeded: mpeters.cqg@gmail.com (default), orders@coastalqualitygoods.com
- `po_purchasers` — seeded: Maria (default)

Add/remove happens in the entry form (layer 1). The frame only seeds them.

### Stored vs. computed — the dividing line

Stored (snapshots, written at save/import): `cost_per_unit` (adjusted COGS),
`adjusted_product_cost`. Editing a PO recomputes them (layer 2); migration copies the
sheet's values **verbatim** — never re-derived, so day-one numbers match the sheet
exactly.

Computed at render (never stored): ASIN total cost (`qty × cost_per_unit`), COGS with
prep, PO-level rollups (units, ASIN count, COGS total), unique-products-per-ASIN
(count of line items sharing a `po_asin_id`), Velocity quantity
(`units_per_pack × qty`), invoice file name (`YYYY-MM-DD_supplier_orderID`), bundle
set-count check (`min` over components of `qty_ordered × asin_qty_per_product`).

Dead sheet columns with no successor: ASIN Qty per Row (U), Total Adjusted ASIN Cost
per Row (AA), Order Total no duplicates (AH), Prep Center Shipment Name Template (AV),
DG (J — app derives DG per §13/§18), Exp. date (Q — dropped; notes fields replace the
shipping-notes half).

---

## 2. Importer — 2026 data (`script/import-po-2026.ts`)

One-time script, CSV input (export of the Orders tab), **dry-run by default**; live run
requires `--live` and a reviewed dry-run report, per AF's dry-run-before-writes
principle. Idempotent: keyed on `(supplier, order_id)` — re-running skips existing POs
and reports them, so a partial import can be resumed safely.

**Selection:** parse Col C by splitting on `/` (never `new Date(str)`); keep rows with
year 2026. Skip the grand-totals row (no Order ID + no date) and fully blank rows.
Expected: 1,158 line rows → 768 POs.

**Grouping:** rows group by `(Order ID, Supplier)` → one `purchase_orders` row.
Order-level fields are read from the first row; if any later row of the same order
disagrees on an order-level value, the discrepancy is REPORTED (first-row-wins applies,
but nothing is silently averaged).

Within an order, rows group by ASIN → one `po_asins` row per ASIN:
- `qty` = Col N (per-ASIN total — identical across the group's rows by construction)
- `cost_per_unit` = Col Y verbatim; `prep_cost` = Col AS (blank → 0, per §3)
- `sold_as`/`units_per_pack` = Cols AX/AY verbatim (blank → individual/1)
- `sku` = current `asins.primary_sku` when the ASIN exists in AF (join at import time);
  NULL otherwise — the amber no-SKU warning then shows honest state
- Groups with 2+ rows (sheet Col S ≥ 2) are bundles: each source row still becomes its
  own `po_line_items` row, all pointing at the one `po_asins` row. 2026 has 14 such
  rows across 6 orders (one 3-component bundle).

Every source row → one `po_line_items` row: product name, SKU/UPC, price, qtys,
`asin_qty_per_product` = Col T, `adjusted_product_cost` = Col X verbatim,
`item_discount` = 0 (field is new; historical rows have none).

**Cleanup map (all occurrences reported, none silent):**
- `#DIV/0!` in any cost cell → NULL (3 known orders, all `Closed, Canceled`, qty 0)
- Payment: `Gift card` → `Gift cards`; `Visa 7927` → `Chase (7927)`
- Cashback: `Topcashback` → `TopCashback`; `-` and `Coupons` → NULL
- Order `130097`: drop the stray 6.78% Weighted GC Discount (per 2026-08-19 decision;
  COGS snapshots stand as-is)
- `Rcpt` TRUE → `invoice_attached = true`
- `qty_received` blank → NULL (not 0 — "not tracked" ≠ "received none")
- Status, purchased_by, promo → verbatim; supplier verbatim except
  `shop.tetleyusa.com / WorldPantry.com` → `shop.tetleyusa.com`; any other odd
  supplier value is reported
- Email blank → `orders@coastalqualitygoods.com` (the column's "if different from
  orders@" semantics)

**Row accounting identity (AF pattern):**
`rawRowsRead = totalsRow + blankRows + nonYtd2026 + importedRows` — remainder must be
0, printed by both dry-run and live run. Live run also prints per-PO counts
(768 POs / N po_asins / 1,158 line items) and the full cleanup report.

**Verification gate before the frame is "done":** spot-check in the UI — order
`130097` (bundle renders with 2 components, 5 sets, $29.68/unit, no GC%),
`CAR118805142` (3-line multi-ASIN order), one canceled `#DIV/0!` order (renders with
em-dash costs, not $0.00), one single-line order. Totals strip must match the sheet
for each.

---

## 3. UI frame

### POs page — list view

Replaces the shell content; the existing **Upload to Velocity** toolbar action stays
exactly where it is.

Toolbar: search (order ID / ASIN / product name) · Status filter · Supplier filter ·
date-range (reuses the global picker pattern) · right: **+ New PO** (disabled with
"Soon" tooltip in the frame — it activates in layer 1) · Upload to Velocity.

Columns: PO Date (sort desc default) · Order ID · Supplier · Status (muted token
chips) · Order Total · ASINs (count) · Units Ordered · Units Received · Invoice
(paperclip when attached) · Notes icon. Row click → expanded view. Pagination, §7
styling throughout (zebra + hairlines, dark header bar, no row tints, semantic color
in text only). Summary tiles: deferred (not in the frame).

### Expanded PO view (read-only in the frame)

In-place, "← Back to POs". Header: Order ID large, supplier + date muted, status
chips. Summary strip: ASINs · Units Ordered · Units Received · Order Total · COGS.
Edit pencil: hidden in the frame (arrives layer 2).

Tabs — **PO Details · ASINs · Products** (mirroring the approved drawer-Overview card
layout, widened):

- **PO Details** — grouped cards: Order (ID, date, supplier, status) / Money
  (subtotal, tax, S&H+donations, discount, refund, total; $0.00 renders muted) /
  Payment (method, weighted GC %, cashback site + %, promo) / Meta (purchased by,
  email used, subscription, **invoice file name + copy icon** — computed live from
  date/supplier/orderID) / Notes (inline).
- **ASINs** — one row per `po_asins`: thumbnail (joined from `asins` when present) ·
  ASIN (link) · title · **Amazon SKU** (our SKU from `po_asins.sku`; amber warning
  icon when NULL) · Qty · Cost/Unit · Total Cost (computed) · Prep · Sold As ·
  Units/Pack · Qty (units, computed) · Unreimbursed Loss · notes icon. Bundle rows
  get an expander revealing component line items nested beneath; component rows show
  a muted dash in the Amazon SKU column (SKU is ASIN-level — their supplier SKUs
  live on the Products tab).
- **Products** — one row per `po_line_items`: product name · **Supplier SKU / UPC** ·
  price · item discount · qty ordered/received/refunded · → ASIN chip (bundle
  components share a chip) · notes icon.

The two SKU concepts are always labeled in full — **"Amazon SKU"** (ours, ASIN-level)
vs. **"Supplier SKU / UPC"** (theirs, product-level) — never a bare "SKU" header.

Money rendering: all money fields neutral — no red/green on Discount or Refund
Amount; `$0.00` renders muted. Semantic color stays reserved for warnings (amber)
per §7.

### Endpoints

- `GET /api/pos` — list; params: search, status, supplier, from/to, page. Returns POs
  with computed rollups (asin_count, units_ordered, units_received, has_notes).
- `GET /api/pos/:id` — full detail: PO + po_asins (with computed totals + joined
  thumbnail/primary-SKU freshness) + line items grouped by po_asin_id.

No write endpoints in the frame. The importer is a script, not an endpoint.

---

## 4. Build order

1. Migration 028 + seed lookup lists in `settings`
2. Importer script → dry-run → review report → `--live` → spot-check queries in psql
3. `GET /api/pos` + list view (renders migrated data)
4. `GET /api/pos/:id` + expanded view, three tabs
5. Verification pass (§2 gate: 130097, CAR118805142, canceled order, single-line)
6. SPEC.md: new §22 (PO Module) documenting the rules above — doc updated in the same
   session the frame lands (doc-first per Maintenance rule)
7. Commit per Definition of Done; tsc gate reported baseline vs. introduced

## 5. Layers after the frame (agreed order, build one at a time)

1. **Entry form** — create PO: order-level section + dynamic line rows; ASIN search
   (by ASIN or title against `asins`), auto-pull ASIN name + primary SKU (warning when
   missing); bundle grouping via "same ASIN on 2+ rows → merge prompt"; managed
   dropdowns (add/remove emails, purchasers, payment methods, cashback sites);
   defaults: Maria, mpeters.cqg@gmail.com, $0 money fields, status Ordered.
2. **Edit + recompute** — pencil on the expanded view; COGS formula engine (discounted
   price + tax/S&H allocation − weighted GC; per-item discount participates); editing
   recomputes both snapshots.
3. **Invoice file upload** — stored file replaces the bare indicator; copy icon stays.
4. **POs by ASIN view** — cross-PO purchase history (PO date · order ID · supplier ·
   status · qty · cost/unit · total · prep), ASIN header with lifetime totals.
5. **Cutover** — repoint actual_cogs/prep sync, Velocity export, SB COGS export, and
   sourcing-cost export from the sheet to these tables; retire the mirror; POs sub-nav
   strip (§8). Each repoint gets its own dry-run.
6. **Later, unordered** — gift-card ledger (with the Gift Cards module), subscription
   alerts, Velocity bundle support, product-level discount refinements (%), §15
   FIFO/lots.

## 6. Importer decisions (resolved 2026-08-20, folded into §2)

1. `Visa 7927` → `Chase (7927)`. ✅
2. `shop.tetleyusa.com / WorldPantry.com` → `shop.tetleyusa.com`. ✅
3. Blank Email → `orders@coastalqualitygoods.com`. ✅

No open questions remain. The plan is ready for build.
