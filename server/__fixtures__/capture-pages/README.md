Synthetic checkout texts for the Capture PO scrubber tests (patch po-ai-prefill
§4.3). Written by hand; every card / gift-card number is a public test number
(4111 1111 1111 1111, 5555 5555 5555 4444, 3782 822463 10005, 6011 1111 1111
1117) or an invented one — never a real card. No real order ids, names or
addresses beyond the two business ship-to streets. `addresses/` holds the two-address
pages (`walmart-review-two-addresses`, `michaels-address-picker`): the
selected-address fixtures for `server/extension-buckets.test.ts` (v1.2),
kept out of the scrubber sweep (no prices on them).
