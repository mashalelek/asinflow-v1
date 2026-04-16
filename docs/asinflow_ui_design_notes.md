# AsinFlow UI Design Notes

## Product Column (Combined Cell — SellerBoard-inspired)

Layout within a single "Product" column cell:

```
┌─────────────────────────────────────────────────────────┐
│  ┌───────┐  B003XCR7TO · SKU IY-9P1I-IR4D              │
│  │       │  Tubigrip Size D Tubular Bandage 10M... 🔓✅  │
│  │ IMAGE │  supplier.com ↗ · COGS: $15.29 · Stock: 12▲ │
│  │       │                                              │
│  └───────┘  [SAS icon] [Keepa icon]                     │
└─────────────────────────────────────────────────────────┘
```

### Line-by-line breakdown:
1. **ASIN** (clickable → Amazon listing) + **SKU** — smaller/muted text
2. **Title** (truncated with ellipsis) + **Ungating icon**:
   - Green unlocked padlock = ungated
   - Yellow locked padlock = gated (clickable → Amazon approval page)
   - Dash or no icon = API check failed
3. **Supplier** (domain, clickable → buy link URL) · **COGS** ($X.XX, show $0.00 if unavailable) · **Stock** (total_inventory_position, with hover breakdown)
4. **SellerAmp + Keepa icons** (stacked or inline, within the cell)

### Stock hover breakdown:
- Available (FBA or FBM)
- Ordered (from PO sheet)
- Reserved
- Sent to FBA (inbound_shipped + inbound_receiving)

### Notes:
- Image thumbnail on the left side of the cell
- SellerAmp URL dynamically reflects active price toggle (COGS + sale price)
- Keepa icon shows hover tooltip with price history graph (800×300px, 365-day range)
- Stock number shows ▲ warning icon if low (threshold TBD)
- COGS source priority: PO Sheet > CSV > Manual; shows $0.00 if none available

## Table Header Sections

Two high-level header groupings:
- **Estimates** — sale_price, est_profit, est_margin, est_roi, fba_fee, referral_fee, inbound_ship, prep_cost
- **Actuals** — units_sold, revenue, refunds, actual_profit, actual_profit_unit, actual_margin, actual_roi

Actuals columns are date-range dependent (date range selector at top of table).

## Date Range Selector
- Default: Last 30 days
- Presets: This Month, Last Month, Last 14 Days
- Custom date range option

## Additional UI Features
- Inbound shipping cost toggle (include/exclude from profit/margin/ROI calculations)
- Custom view presets (saved column configurations, switchable)
- Staleness indicator: subtle timestamp showing when estimates were last refreshed
- Refresh: "Refresh Selected" with option to select all
- Archiving: ASINs can be archived (hidden from default view, data preserved)

## Competition Columns
- BSR (with category shown)
- Sellers (FBA) — count
- Sellers (FBM) — count
