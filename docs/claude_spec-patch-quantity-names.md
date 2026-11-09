# SPEC Patch — Quantity names: ASIN units · Product units · Individual units

*Maria 2026-11-09. Labels and docs only; no column renames, no math
changes. Prerequisite for the Supplier claims patch
(`docs/claude_spec-patch-supplier-claims.md`), whose UI is born with these
words. Amends SPEC §22 (PO module), §11 (Velocity), §7 (UI vocabulary).*

> **Status: APPROVED 2026-11-09.**

## 1. Why

AF has three quantity kinds and calls them half a dozen things: "Qty",
"ASIN qty", "Ordered", "Units Ordered", "Individual Units Ordered", "units
per pack", "Units/pack", "retailer units", "quantity" (Velocity). On the
PO form and in the PO tables it is not always clear which one a number is.
Claims add one more place where the kind matters (claim qty is entered in
Individual units), so the words get fixed first.

## 2. The three kinds, with the one name each

| Name | Meaning | Example (Voltage 65705: 1 × 12-jar case, ASIN sold as a 12-pack) |
|---|---|---|
| **Individual units** | Physical items; what Velocity counts and uploads | 12 |
| **Product units** | Items as sold on the supplier's site (a case, a 2-pack, a single) | 1 |
| **ASIN units** | Sellable units of the Amazon listing | 1 |

Ratios keep their own two names: **Individual units per Product unit** and
**Individual units per ASIN unit** ("units per pack" today). Never
"retailer units", "component units", "quantity", "qty" alone, or "units"
alone.

**Entry rule (Maria 2026-11-09):** anything Maria types is **Individual
units** (claim qty, refund qty, Shipped by Supplier, At CQG Warehouse,
Lost/damaged by us), with the Product and ASIN equivalents shown beside
the field. Ordered on a product line stays Product units (the receipt);
the ASINs tab stays ASIN units; tracking quantities parsed from emails are
Product units with the Individual equivalent shown. The switch of the
stored hand-entered values to Individual units is a data change and runs
in the Supplier claims patch, commit 1 (dry run of every existing value).
This patch labels what is stored today.

**Display pattern (Maria 2026-11-09):** every quantity on a PO shows its
surface's natural kind as the main number with the **Individual count in
pale grey under it** (today's ASINs-tab Ordered "15 / 45 indiv." pattern,
applied to every quantity column on both tabs). Pack sizes show once per
row: the ASINs tab's "Sold as · ×N" (ASIN pack), and a new **Product pack**
column on the Products tab ("multi-pack ×15" — today the 15 appears only
in the product name). Header strip: "ASIN units ordered 15 · 45
individual". The Products tab's Received (sheet col M, supplier cases) is
dropped, as it was from the POs list; Canceled / Returned / Final columns
go with the claims patch (D14) and show in the PO's Claims card instead.
Add-product form: Qty / *Product units*, a Product pack field, and
"Individual units per ASIN unit".

**Stored base (Maria 2026-11-09):** every PO quantity is **stored as
Individual units** (integers; what Velocity, the emails and Maria's
entries give us) and converted on display. The storage migration runs in
Supplier claims commit 1; this patch's commit 2 builds the display from
today's storage (individual = stored × pack size) so the screens don't
change again when the storage does.

**Style (Maria 2026-11-09):** the kind is a small muted line **above**
the header text, exactly like the Actual / Estimated group labels
(*ASIN units* over "At Prep Center") — not parentheses. Where a column
holds two kinds (the inventory's bundle case: component product lines'
Product qty under a bundle's ASIN-units Ordered), Code screenshots the
case in its commit 2 report and proposes how to show it before changing
it.

## 3. Where it applies

- **POs list / expanded ASIN rows / PO page tabs:** every quantity column
  header carries the kind as the muted line above it: *ASIN units* over
  "Ordered", "Shipped FBA", "Received by Velocity"; *Product units* over
  the Products tab's "Ordered", and so on. Same header text on two
  tabs with two kinds (At Prep Center, At CQG Warehouse, Lost/damaged by
  us on the ASINs tab vs the Products tab) is fixed by the kind line.
- **ASINs page** (Stock, On Order, At Prep, Units Sold, …): all ASIN units;
  the muted *ASIN units* line above each quantity header.
- **New PO form / Edit PO:** "Qty" → *Product units* over "Qty"; "Units /
  pack" → "Individual units per Product unit"; "ASIN qty" → "ASIN units";
  "Units/pack" under Sold as → "Individual units per ASIN unit". The
  per-line math caption reads in the same words ("2 Product units × 9
  Individual units ÷ 2 per ASIN unit = 9 ASIN units").
- **Inventory 2026-11-09** (`docs/quantity-names-inventory-2026-11-09.csv`,
  142 rows): "retailer units" means Product units in some places and
  Individual-per-Product in others; the Upload to Velocity skip reason
  "N ordered ÷ U per pack" means Product units in one branch and
  Individual in the other — each branch says which; listing hygiene
  "units on hand" = Individual units (verify).
- **Pack size column (ASINs page):** "Sold as" stays; "Pack size" →
  "Individual units per ASIN unit".
- **Upload to Velocity dialog / plan / Qty mismatches:** "Individual units"
  wherever Velocity's quantity is shown; mismatch rows state both kinds
  side by side.
- **Hover text, warnings, action-item reasons** ("Extra units shipped",
  "Pack size mismatch", "FBA receiving mismatch"): name the kind.
- **Exports** (CSV headers) and **Dashboard** ("ASIN units ordered",
  "Individual units ordered").
- **Docs:** SPEC §22 gets a "Quantity vocabulary" paragraph (this §2);
  CLAUDE.md gets the rule "quantity labels always name the kind";
  `docs/UI_RULES.md` too.

## 4. Not in this patch

- No database column renames (`units_per_pack`, `qty_ordered`, … stay).
- No changes to how any quantity is computed or stored; the Individual-
  units stored base and entry switch are claims commit 1.
- The Claims UI (claims patch) uses these names from the start.
- CLAUDE.md's pointer to `docs/SCHEMA.md` (missing) is corrected to
  `database/schema_baseline_2026-10-15.sql` in commit 2.

## 5. Commits

1. Inventory (read-only): every label, header, tooltip, export header,
   warning string and SPEC/CLAUDE.md mention of a quantity, with the kind
   each one actually is. CSV in docs/. Stop for Maria's review (she
   confirms the kind on any ambiguous one).
2. Apply: labels, tooltips, captions, exports, docs. Browser check at 1280
   and 1440 for header wrapping (resize columns where a longer name wraps
   onto three lines). Single concern, push.
