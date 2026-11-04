# Spec patch — Dashboard tiles (UI only)

Status: APPROVED 2026-11-04 — ready for Claude Code
Follows: `docs/claude_spec-patch-analytics-dashboard.md` (shipped
2026-11-03). Data, API (`/api/dashboard/grid`, `/api/dashboard/series`),
range resolver, Refunds due link target, placeholders — all unchanged.
Mockup: `docs/dashboard-tiles-mockup-2026-11-04.dc.html` (approved by
Maria 2026-11-04; the layout, spacing, type sizes and colors below are
taken from it — read it before building; its `<sc-for>` / `{{…}}` is the
mockup's own templating, not something to port).
Touches: SPEC §8 (nav order), §28 (layout section); client only.

## 1. Changes

### 1.1 Nav
- **Dashboard** becomes the **first** tab, before ASINs. Order: Dashboard ·
  ASINs · Bulk Calc · ASIN Analytics · POs · Subscriptions · Gift Cards
  (soon) · Repricer · Shipments (soon). Default landing page unchanged
  unless it is already the first tab's route — then it follows.
  SPEC §8 updated.

### 1.2 Page header
- Left: the title "Dashboard" only. **Remove** the subtitle "Spend by PO
  date (Eastern) · Sales by Amazon's Pacific day".
- Right: **remove** the coverage lines ("Sales through … · synced … ·
  data from …" and "Orders from …"). They move to a tooltip on the Sales
  section label of each tile (hover "SALES" → "Sales through Nov 3 ·
  synced 6:47 PM · data from Sep 9, 2024 · Orders from Oct 31, 2024") so
  the information stays reachable; the "data from <date>" clamp marker
  on an individual cell stays as shipped.
- In the right slot: the **range-set dropdown** (replaces the four
  segmented buttons). A labeled `<select>` ("Date ranges") styled with the
  toolbar's neutral button tokens, options: "Today · This week · MTD · 30
  days" / "Today · Yesterday · MTD · Last month" / "Today · Yesterday · 7 ·
  14 · 30 days" / "Custom range…". Choosing "Custom range…" shows the
  two-date control beside the dropdown. Same localStorage key as today.

### 1.3 Tiles (replace the grid)
One card per range column, `grid-template-columns: repeat(N, minmax(0,
1fr))` with 16 px gap (N = 4 or 5 by set; 1 for Custom, capped at a
sensible max width); stacks to one column below 1024.

Card: `Card` tokens (`bg-card`, `border`, radius 10 px, overflow hidden),
three sections separated by a 1 px `border` hairline, each section
padded 14 px 18 px 16 px:

- **Header band** — range name (16 px / 700, `#FAFAF9`) and the resolved
  dates (12 px, `#E7E5E4`), padding 14 18 12. Band color by column
  position, a muted dusk-blue → slate-teal ramp (same lightness, low
  chroma — chosen to sit with the warm stone, never the red / yellow /
  green of SellerBoard):
  - dark theme: `#3A4F68` · `#3E5B6E` · `#45666E` · `#4E6E6B`
  - light theme: `#4A5F78` · `#4E6B7E` · `#55767E` · `#5E7E7B`
  - a 5th column (set 3) takes `#56746A` / `#66847A`; Custom takes the
    first color. Add these as CSS variables (`--dash-band-1…5`) under
    `:root` and `.dark`, not inline hexes.
- **SPEND** section label (11 px, 700, letter-spacing .08em,
  `muted-foreground`) → **Spend** main value (label 13 px muted, value
  28 px / 700) → 2×2 grid (12 px 16 px gap) of: Refunds due (link
  styled, 16 px / 600, → `/pos?refunds=due&from&to` as shipped) · Avg. PO
  value (value + "· N POs" in 12 px muted) · ASIN units ordered ·
  Individual units ordered (the "n rows missing pack size" note stays
  under that cell when present).
- **SALES** section → **Sales** main value → 2 columns: Orders / Units ·
  Refunds (placeholder "—" in `muted-foreground`/dim, tooltip "after the
  Finances API patch").
- **PROFIT** section: label row with "after the Finances API patch" in
  11 px dim text on the right → **Gross profit** main value as a dim "—"
  (28 px) → Net profit · Est. payout as dim "—". Rows stay visible
  (Maria 2026-11-04); the Finances patch replaces the dashes with
  numbers and drops the note.
- Sub-metric labels 12 px muted; sub-metric values 16 px / 600.
- No "More" link — every row is shown.

### 1.4 Charts
- Swap the series: **Spend = bars (left axis)**, **Sales = line (right
  axis)** in all three charts. Checkboxes, range picker (Last 12 months /
  Custom), tooltips unchanged. SPEC §28 chart table updated.

### 1.5 Tests
- Nav order test (Dashboard first); dropdown renders the four sets and
  switching persists; tile count per set (4 / 4 / 5 / 1); placeholder
  cells carry the tooltip; Refunds due link href; band variables exist in
  both themes; charts: Spend series is the bar, Sales the line.
- Headless check at 1024 / 1280 / 1440, both themes: no overflow, cards
  equal height per row, dropdown + custom control fit on one line at
  1280.

## 2. Commits
1. Nav order + page header (dropdown, coverage → tooltip); SPEC §8.
2. Tile cards replacing the grid; band variables; tests.
3. Charts swap; SPEC §28 layout + chart table.
Gates per commit (`check`, `check:tests`, tests); one report at the end,
then push.
