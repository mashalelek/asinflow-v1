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
"retailer units", "quantity", "qty" alone, or "units" alone.

## 3. Where it applies

- **POs list / expanded ASIN rows / PO page tabs:** every quantity column
  header carries the kind: e.g. "Ordered (ASIN units)", "Shipped FBA (ASIN
  units)", "Received by Velocity (ASIN units)", "Ordered (Product units)",
  "Ordered (Individual units)". Short form on narrow columns: "ASIN u.",
  "Product u.", "Indiv. u." with the full name in the header tooltip.
- **New PO form / Edit PO:** "Qty" → "Qty (Product units)"; "Units / pack"
  → "Individual units per Product unit"; "ASIN qty" → "ASIN units";
  "Units/pack" under Sold as → "Individual units per ASIN unit". The
  per-line math caption reads in the same words ("2 Product units × 9
  Individual units ÷ 2 per ASIN unit = 9 ASIN units").
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
- No changes to how any quantity is computed.
- The Claims UI (claims patch) uses these names from the start.

## 5. Commits

1. Inventory (read-only): every label, header, tooltip, export header,
   warning string and SPEC/CLAUDE.md mention of a quantity, with the kind
   each one actually is. CSV in docs/. Stop for Maria's review (she
   confirms the kind on any ambiguous one).
2. Apply: labels, tooltips, captions, exports, docs. Browser check at 1280
   and 1440 for header wrapping (resize columns where a longer name wraps
   onto three lines). Single concern, push.
