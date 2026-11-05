# COGS rule — what COGS includes (Maria 2026-11-04, authoritative)

COGS = price actually paid + **tax** + **shipping / handling from the
supplier** − coupons − sales − **gift-card discount %**, allocated across
lines by line total, converted to ASIN units, + adjustment.
- **Rewards:** Maria's call per PO (the promo's COGS toggle; default off).
- **Card reward %** (e.g. Walmart card 5%, Maria 2026-11-04): counts, like
  the gift-card discount — stored on the payment method, weighted by payment
  amount (the sheet's col AJ).
- **Cashback portals** (Rakuten, BeFrugal, …): never.
- When line prices already include a discount (Σ line totals = post-discount
  subtotal within 1¢), that discount is not subtracted again.
- Compute from line totals, never from a rounded unit price.

A 2026-10-31 prompt wrongly said tax and shipping are not allocated; that
was based on a probe's reading of the sheet formulas and contradicted the
sheet's own values (BB&B 482270182: (394.90 − 78.98 + 22.12) ÷ 10 = 33.80 =
col X; globalcommercialparts 20000101283: $20.94 price + $15.95 S&H → $22.54).
If in doubt about what counts, ask Maria — do not infer from a probe.
