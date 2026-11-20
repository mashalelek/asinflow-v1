# Finances API patch: acceptance table

*Approved by Maria 2026-11-20. Becomes the test for the patch;
Code fills in the "Result" column in its report. Answer keys:
`docs/claude_finances-sb-fixture.md` (SB screenshots + decisions). Look:
`docs/mockups/finances-breakdown-2026-11-19.html` (approved 2026-11-20).*

| # | Where | Step | What Maria sees | Result |
|---|---|---|---|---|
| 1 | Dashboard | Open any range set | Every tile's SALES and PROFIT sections show numbers: Sales, Orders / Units, Refunds (count · $), Net profit, Gross profit, Est. payout, Margin, ROI. No "—" placeholders, no "after the Finances API patch" text | |
| 2 | Dashboard | Custom range Aug 1 – 31, 2026 | Sales $33,775.91 · Units 1,232 · Refunds 33 or 32 · Est. payout within $3 of $21,000.67 | |
| 3 | Dashboard | Click "More" on that tile | The breakdown panel from the mockup: same line names and order as SB; groups Refund cost, Amazon fees, Cost of goods expand and collapse | |
| 4 | More panel, Aug 1 – 31 | Read Amazon fees | Every line equals the SB August screenshot to the cent, except: FBA removal fee and FBA disposal fee (together within $7), FBA storage fee (within $0.10). Group total within $3 of -$11,912.24 | |
| 5 | More panel, Aug 1 – 31 | Read Refund cost | Refunded amount -$962.50, Refund commission -$27.21, FBA customer return per unit fee -$9.28, Refunded referral fee $135.99 to the cent; Value of returned items within 5% of $260.63 | |
| 6 | More panel, Aug 1 – 31 | Read Cost of goods | COGS -$16,198.54 (cost of the PO in force on each sale's day, within $10); Prep as its own line; Lost/damaged by Amazon within $2 of -$189.18; Disposal of sellable products -$10.66 | |
| 7 | More panel | Read the bottom block | Gross profit, Net profit (equal), Estimated payout, Refund rate, Sellable returns, Margin, ROI. Estimated payout = Sales + Refund cost without Value of returned items + Amazon fees. No deposits line | |
| 8 | ASINs page | Date range Oct 19 – Nov 17, 2026, find B0756KB8N1, click its Actual Profit cell | The same panel for that ASIN: Sales $2,330.82 · Units 26 · Refunds 1 · Refund cost -$79.19 · Referral fee -$349.63 (±$0.01) · FBA fee -$293.02 · both clawbacks -$22.55 · Inbound transportation within $5 of -$95.66 · FBA storage fee within $1 of -$10.33 · COGS -$1,066.46 · Estimated payout $1,457.89 (±$6) | |
| 9 | ASIN panel | Compare with the account panel | Subscription is not on any ASIN panel. Every other line, summed over all ASINs, equals the account panel's line | |
| 10 | ASINs table, Repricer table, ASIN Analytics, CSV export | Look at Actual Refunds, Refund %, Profit, Profit / unit, ROI, Margin | Real numbers from the same data as the panel, no $0 columns on the Repricer; an ASIN's Actual Profit in the table equals Net profit in its panel for the same range | |
| 11 | Prep | A unit sold from a Velocity PO | Prep = the Settings prep value ($1.20 today) | |
| 12 | Prep | A unit sold from a Home PO | Prep = $0.00 | |
| 13 | Prep | A hazmat ASIN sold from a Velocity PO | Prep = Settings prep + the DG/Hazmat prep surcharge + the DG/Hazmat shipping surcharge ($1.20 + $0 + $1.00 on 2026-11-20) | |
| 14 | Settings | Change prep to $1.30, save, open AF in another browser | Prep lines and profit use $1.30 everywhere, in both browsers. Change it back and they return | |
| 15 | Recent days | A range that includes the last two weeks | Sales and Units include pending orders. Fee lines include Amazon's own fee for unsettled orders. Hovering a fee line shows how much is estimated, e.g. "includes $5.77 estimated for 1 pending unit". Nothing else on screen marks it | |
| 16 | Recent days | The same range a few weeks later, once Amazon has settled the orders | Fee lines show Amazon's posted fees; the hover text is gone; no order's fee is counted twice | |
| 17 | Cancellations | An order Amazon cancels a week after it was placed | It drops out of Sales, Units and Orders on its day by the next hourly pass | |
| 18 | Refunds | A refund Amazon posts today | It appears in today's Refunds count and Refund cost (by the day Amazon posts it, Pacific), on the Dashboard and on the ASIN | |
| 19 | History | Custom range Nov 19, 2024 – Dec 31, 2024 | Real numbers. A range starting before Nov 19, 2024 shows the existing "data from Nov 19, 2024" marker on the profit cells | |
| 20 | Hourly pass | Open the jobs dialog after a scheduled pass | Components 19–21 (Sales, Refunds, Actual fees) show as run, not "finances patch pending"; the pass does not take noticeably longer than before | |

## Accepted differences from SellerBoard (each with its reason)
- Cost of goods: AF shows COGS and Prep separately and uses the Settings
  prep (Home POs $0); SB's single line has the per-PO prep that was uploaded
  to it. Profit, Margin and ROI differ by that amount.
- FBA removal / disposal fees: SB dates them by the removal order, AF by
  the day Amazon posts them (Maria 2026-11-20: stay with Amazon's posting
  day).
- FBA storage: AF books Amazon's monthly charge on the day it posts, not
  amortized. SB rounds the storage report (cents).
- Pending orders with nothing from Amazon yet: AF estimates their fees from
  the same ASIN's last real fee; SB's guess runs higher. Gone once settled.
- ASIN-level Estimated payout: cash only in AF; SB's product page adds
  Lost/damaged.
- Refund count can differ by one (SB counts a two-item refund twice); the
  money matches.
