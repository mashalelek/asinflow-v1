// The ONE gated live write of the PO-tracking patch (commit 5): settles the
// element shape PUT /inbound/:id accepts in trackingNumbers.
//
//   npm run velocity:tracking-probe -- --order <velocity_order_id> --carrier FedEx --tracking <n>           # read + plan only
//   npm run velocity:tracking-probe -- --order <velocity_order_id> --carrier UPS --tracking <n> --live     # GET → PUT → GET
//
// --live: PUT with ONE object-shaped element {carrier, tracking_number} added
// to the order's existing trackings (echo-merge, every other field echoed
// from a fresh GET — the same body the push component sends). If Velocity
// rejects the object, retries once with a plain string. Prints before/after
// trackings and checks nothing else changed. Never touches quantities.
import "dotenv/config";
import { getInboundOrder, updateInboundOrder } from "../server/velocity-api";
import { buildTrackingPutBody, trackingNumbersOf, type TrackingElementShape } from "../server/tracking-push";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const WATCH = ["quantity", "date", "sold_as", "units_per_pack", "amazon_sku", "fulfillment_type", "item_name", "asin", "retailer", "order_number", "status", "unit_status"];

async function main(): Promise<number> {
  const orderId = arg("order"), carrier = arg("carrier"), tracking = arg("tracking")?.toUpperCase();
  const live = process.argv.includes("--live");
  if (!orderId || !carrier || !tracking) { console.error("--order, --carrier and --tracking are required"); return 1; }
  const before = await getInboundOrder(orderId);
  console.log(`order ${orderId} (${before.order_number} · ${before.asin} · qty ${before.quantity} · ${before.status}/${before.unit_status})`);
  console.log("trackings BEFORE:", JSON.stringify(before.trackings ?? []));
  if (trackingNumbersOf(before).includes(tracking)) { console.log(`already has ${tracking} — nothing to do`); return 0; }
  const body = buildTrackingPutBody(before, [{ carrier, tracking_number: tracking }], "object");
  console.log("planned PUT body:", JSON.stringify(body, null, 2));
  if (!live) { console.log("no --live: nothing sent."); return 0; }

  let shape: TrackingElementShape = "object";
  try {
    await updateInboundOrder(orderId, body);
  } catch (err: any) {
    console.log(`object element REJECTED: ${err?.message ?? err} — retrying with a plain string`);
    shape = "string";
    const fresh = await getInboundOrder(orderId);
    await updateInboundOrder(orderId, buildTrackingPutBody(fresh, [{ carrier, tracking_number: tracking }], "string"));
  }
  const after = await getInboundOrder(orderId);
  console.log("trackings AFTER:", JSON.stringify(after.trackings ?? []));
  const changed = WATCH.filter((k) => JSON.stringify((before as any)[k]) !== JSON.stringify((after as any)[k]));
  console.log(changed.length ? `CHANGED besides trackings: ${changed.map((k) => `${k} ${JSON.stringify((before as any)[k])} → ${JSON.stringify((after as any)[k])}`).join("; ")}` : "no other field changed");
  const landed = trackingNumbersOf(after).includes(tracking);
  console.log(landed ? `LANDED — PUT element shape that works: ${shape}` : `NOT visible on GET after the PUT (shape ${shape})`);
  return landed && changed.length === 0 ? 0 : 2;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e?.message ?? e); process.exit(1); });
