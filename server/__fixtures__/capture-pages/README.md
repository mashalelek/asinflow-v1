Synthetic checkout texts for the Capture PO scrubber tests (patch po-ai-prefill
§4.3). Written by hand; every card / gift-card number is a public test number
(4111 1111 1111 1111, 5555 5555 5555 4444, 3782 822463 10005, 6011 1111 1111
1117) or an invented one — never a real card. No real order ids, names or
addresses beyond the two business ship-to streets. `addresses/` holds the two-address
pages (`walmart-review-two-addresses`, `michaels-address-picker`): the
selected-address fixtures for `server/extension-buckets.test.ts` (v1.2),
kept out of the scrubber sweep (no prices on them).
`walmart-po/` is a synthetic cart + confirmation pair shaped like the first
real Walmart PO (2026-11-01; order # and card invented): the rollback /
"Bought N times" / recommendation strips, the "You saved" headline, the
"Have a promo code?" prompt and the size-variant radios the v1.2.1 parser
rules are tested against.

`shagtools/` is SYNTHETIC — shaped from Maria's description of the
shagtools.com cart and checkout (2026-11-02), to be replaced by the real
text from the panel's "Copy page text" when she pastes it. `cart.txt`: one
`<tr>` per product whose cells (title, $8.93, quantity stepper, $133.95)
innerText joins with tabs, a header row, a recommendation row without a
quantity, and one coupon shown four ways (banner, "GET 10% OFF", cart
notice, COUPON: row). `checkout.txt` (reshaped 2026-11-03 after Maria's first real
"Copy page text", a WooCommerce review table): the title line ending "× 15",
"Available on backorder" and the line subtotal on the next line (no unit
price, no quantity input), and the Shipping row listing the methods — "Free
shipping" then "Flat rate: $24.77" — with the Total reconciling to the free
one; the address and card lines around it. The v1.2.2 row rule and promo
dedupe, the v1.2.3 quantity shapes and the v1.2.6 availability-line and
shipping-method rules are tested against them.
