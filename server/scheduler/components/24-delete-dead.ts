// 24. Delete long-dead listings (daily, 00:00 pass only) — listing hygiene,
// SPEC §11. CALL-14 deleteListingsItem per SKU + a live Velocity read
// (/inbound + /inventory).
//
// A SKU is deleted when its listing is closed now, every FBA bucket is zero
// (Unfulfillable and Researching included), nothing is in the pipeline for
// the ASIN (asin_po_pipeline On Order = 0 and At Prep = 0, no Velocity units
// on hand), and the OOS clock has run (ever-stocked: max(ledger last stocked,
// 15's last nonzero) > 60 days ago; never-stocked: listing created > 14 days
// ago). Needs this pass's 15 and 16 and tonight's 23 — an unavailable ledger
// or any failed Velocity leg skips the whole run. deleteListingsItem is
// asynchronous (ACCEPTED ≠ done); component 16 verifies on the next pass.
// LISTING_DELETE_LIVE unset → dry run.
import { runHygiene } from "../../listing-hygiene-run";
import type { ComponentDef } from "../types";

export const deleteDead: ComponentDef = {
  n: 24, key: "24_delete_dead", name: "Delete long-dead listings", tier: "daily", kind: "account",
  call: "CALL-14 deleteListingsItem, per SKU + Velocity /inbound + /inventory",
  run: (ctx) => runHygiene("delete", ctx),
};
