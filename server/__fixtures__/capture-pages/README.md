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

`shagtools/` is TRANSCRIBED from Maria's screenshots of the real
shagtools.com pages (2026-11-03; a WooCommerce store) — line for line as
Chrome's innerText joins them, cells with tabs — and is replaced verbatim by
the panel's "Copy page text" when that paste lands (it was dropped twice in
transit). `cart.txt`: the Driftwood caulk × 10 on backorder — the table
header "PRODUCT PRICE QUANTITY SUBTOTAL", the title line, "Available on
backorder", then "REMOVE / $8.93 / − / + / $89.30" tab-joined (the stepper's
value is in the input, captured as the field "<product name> quantity"),
the free-shipping meter, the shipping-policy line, and CART TOTALS with the
three shipping radios ("Ground: $24.77" selected, "2 Day", "Next Day", each
with a "(Delivery by …)" line), "TAX  Taxes will be calculated at checkout"
and TOTAL $114.07. `cart-alabaster.txt`: the same cart later with the
Alabaster caulk × 5 (Ground $22.99, Total $67.64). `checkout.txt`: the
checkout before an address is entered — the title line, "× 10" under it,
"Available on backorder" tab-joined with $89.30, SUBTOTAL, "SHIPPING  Enter
your address to view shipping options.", TAX $0.00, TOTAL $89.30; the
address is in the captured fields, not the text. The v1.2.2 row rule, the
v1.2.3 quantity shapes, the v1.2.6 availability / shipping-method rules and
the v1.2.7 cart-table and rebuild rules are tested against them.
