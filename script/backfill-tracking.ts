// PO tracking backfill (SPEC §26; patch po-tracking-velocity §12, commit 8).
//
//   npm run backfill:tracking                 # DRY RUN (default): reads Gmail + Velocity + AF, writes nothing
//   npm run backfill:tracking -- --live       # ingest + match + push for real
//   --live --stage ingest   ingest + match only (sets the watermark) — then backfill ships_to / apply moves
//   --live --stage push     the push only
//
// 1. GET /inbound → the order numbers with unit_status pending /
//    partially_received → their AF POs → the oldest order date among them.
// 2. Scan Gmail (orders@) from that date — the same parser, the Michaels
//    tracking-link extractor and the dedup the 00:00 component uses.
// 3. Match (supplier domain map + base order #) and route (§7) every row;
//    plan the Velocity PUTs (§9).
// 4. Report: emails scanned / candidates / rows / matched / unmatched by
//    reason / Velocity orders to PUT / action items raised.
//
// The dry run plans entirely in memory from the same pure functions — no
// po_tracking row, no settings write, no PUT. --live writes through the real
// ingestTracking → matchTrackingRows → pushTracking (since = the oldest order
// date), i.e. exactly what Sync tracking does, with a wider window.
// Talks to DATABASE_URL directly (no API token for scripts).
import "dotenv/config";
import pool from "../server/db";
import { gmailClient, listMessageIds, getMessage } from "../server/gmail-client";
import { parseTrackingEmail } from "../server/tracking-parse";
import { rowsFromEmail, withLinkTracking, ingestTracking, isPlaceholder, type TrackingRowDraft } from "../server/tracking-ingest";
import { matchRow, loadDomainMap, matchTrackingRows, type PoRef } from "../server/tracking-match";
import { routeTracking, joinReasons } from "../server/tracking-route-rules";
import { indexInbound, knownOrderNumbersHydrated, trackingNumbersOf, pushTracking } from "../server/tracking-push";
import { fetchAllInboundOrders, fetchAllKnownOrders } from "../server/velocity-api";
import type { QueryLike } from "../server/scheduler/types";

const live = process.argv.includes("--live");
const stageArg = (() => { const i = process.argv.indexOf("--stage"); return i >= 0 ? process.argv[i + 1] : "all"; })();
if (!["all", "ingest", "push"].includes(stageArg)) throw new Error("--stage must be ingest, push or all");
const query: QueryLike = (sql, params) => pool.query(sql, params) as any;

async function main(): Promise<void> {
  const inboundOrders = await fetchAllInboundOrders();
  const inbound = indexInbound(inboundOrders);
  // ships_to as the prep-cost backfill sets it (server/ships-to-backfill.ts) —
  // computed here, so a dry run before the backfill (or before migration 066)
  // routes exactly as the live run will after it.
  const pos: Array<PoRef & { order_date: string; ships_to: string; canceled_or_returned: boolean }> = (await query(
    `SELECT p.id, p.supplier, p.order_id, p.order_date::text AS order_date,
            CASE WHEN (SELECT MAX(a.prep_cost) FROM po_asins a WHERE a.po_id = p.id) > 0 THEN 'velocity' ELSE 'home' END AS ships_to,
            (EXISTS (SELECT 1 FROM po_line_items l WHERE l.po_id = p.id)
              AND NOT EXISTS (SELECT 1 FROM po_line_items l WHERE l.po_id = p.id
                               AND COALESCE(l.qty_canceled, 0) + COALESCE(l.qty_returned, 0) < COALESCE(l.qty_ordered, 0))) AS canceled_or_returned
       FROM purchase_orders p`,
  )).rows.map((r: any) => ({ ...r, id: String(r.id), order_id: String(r.order_id), canceled_or_returned: r.canceled_or_returned === true }));
  const inScope = pos.filter((p) => inbound.has(String(p.order_id).trim()));
  const oldest = inScope.map((p) => p.order_date).sort()[0];
  console.log(`Velocity inbound (pending / partially received): ${inboundOrders.filter((o) => ["pending", "partially_received"].includes(String(o.unit_status))).length} orders · ${inbound.size} order numbers · ${inScope.length} AF POs · oldest order date ${oldest ?? "—"}`);
  if (!oldest) { await pool.end(); return; }
  const since = new Date(`${oldest}T00:00:00Z`);

  if (live) {
    if (stageArg !== "push") {
      const ing = await ingestTracking({ query, deps: { gmail: gmailClient() }, since, log: console.log });
      const m = await matchTrackingRows(query);
      console.log(JSON.stringify({ ingest: { ...ing, drafts: undefined }, match: m }, null, 1));
    }
    if (stageArg !== "ingest") {
      const p = await pushTracking({ query, log: console.log });
      console.log(JSON.stringify({ push: { ...p, plans: undefined } }, null, 1));
      for (const pl of p.plans) for (const t of pl.targets) if (t.to_add.length) console.log(`  PUT ${t.velocity_order_id}  PO ${pl.order_id}  ${t.asin}  +${t.to_add.join(", ")}`);
      for (const pl of p.plans) for (const r of pl.rows) if (r.decision === "review") console.log(`  REVIEW PO ${pl.order_id} ${r.tracking_number}: ${r.reasons.join("; ")}`);
    }
    await pool.end();
    return;
  }

  // ── DRY RUN, in memory ────────────────────────────────────────────────
  const gmail = gmailClient();
  const ids = await listMessageIds(gmail, `-category:promotions after:${Math.floor(since.getTime() / 1000) - 86400}`, 20000);
  let candidates = 0, linkResolved = 0;
  const drafts = new Map<string, TrackingRowDraft>();
  for (const id of ids) {
    const msg = await getMessage(gmail, id);
    const parsed = parseTrackingEmail(msg);
    if (!parsed.candidate) continue;
    candidates++;
    const p = await withLinkTracking(msg, parsed);
    if (p !== parsed) linkResolved++;
    for (const d of rowsFromEmail(msg, p)) { const k = `${d.carrier}|${d.tracking_number}`; if (!drafts.has(k)) drafts.set(k, d); }
  }
  const known = await knownOrderNumbersHydrated(await fetchAllKnownOrders(), query);
  const map = await loadDomainMap(query);
  const suppliers = Array.from(new Set(pos.map((p) => p.supplier)));
  const settings = Object.fromEntries((await query(`SELECT key, value FROM settings WHERE key LIKE 'tracking.%'`)).rows.map((r: any) => [r.key, r.value]));
  const velocityStreet = String(settings["tracking.velocity_street"] ?? "805 grandy");
  const homeStreets: string[] = settings["tracking.home_streets"] ?? ["65 rivercrest"];

  const unmatched: Record<string, number> = {};
  const seeded = new Set<string>();
  let matched = 0, placeholders = 0;
  const review: string[] = [];
  const decisions: Record<string, number> = {};
  const puts = new Map<string, { po: string; asin: string; add: Set<string> }>();
  for (const d of Array.from(drafts.values())) {
    if (isPlaceholder(d.tracking_number)) { placeholders++; unmatched.ai_disabled = (unmatched.ai_disabled ?? 0) + 1; continue; }
    if (d.match_reason === "unpaired") { unmatched.unpaired = (unmatched.unpaired ?? 0) + 1; continue; }
    const m = matchRow(d, map, suppliers, pos);
    if (m.obvious && d.sender_domain) seeded.add(`${d.sender_domain}→${m.supplier}`);
    if (m.status !== "matched") { unmatched[m.reason] = (unmatched[m.reason] ?? 0) + 1; continue; }
    matched++;
    const po = pos.find((p) => p.id === m.po_id)!;
    const orderId = String(po.order_id).trim();
    const targets = inbound.get(orderId) ?? [];
    const r = routeTracking({
      velocity: targets.length ? "inbound" : known.has(orderId) ? "known" : "absent",
      emailStreet: d.ship_to_street, shipsTo: po.ships_to === "home" ? "home" : "velocity",
      velocityStreet, homeStreets, poCanceledOrReturned: po.canceled_or_returned,
    });
    const dec = r.push ? "push" : r.held ? "held" : r.reasons.length ? "review" : "received_by_velocity";
    decisions[dec] = (decisions[dec] ?? 0) + 1;
    if (r.reasons.length) review.push(`PO ${orderId} (${po.supplier}) ${d.carrier} ${d.tracking_number}: ${joinReasons(r.reasons)}`);
    if (!r.push) continue;
    for (const t of targets) {
      if (String(t.sold_as ?? "").toLowerCase() === "bundle") continue;
      if (trackingNumbersOf(t).includes(d.tracking_number)) continue;
      const e = puts.get(t.order_id) ?? { po: orderId, asin: t.asin, add: new Set<string>() };
      e.add.add(d.tracking_number);
      puts.set(t.order_id, e);
    }
  }
  const reviewPos = new Set(review.map((x) => x.split(" ")[1]));
  console.log(`\nDRY RUN — nothing written to AF or Velocity`);
  console.log(`emails scanned ${ids.length} · candidates ${candidates} · via tracking link ${linkResolved}`);
  console.log(`rows (distinct carrier + tracking) ${drafts.size} · matched ${matched} · unmatched ${JSON.stringify(unmatched)} (ai_disabled = shipped, no number found: ${placeholders})`);
  console.log(`routing of matched: ${JSON.stringify(decisions)}`);
  console.log(`Velocity orders to PUT ${puts.size} (POs ${new Set(Array.from(puts.values()).map((x) => x.po)).size}) · action items to raise: ${reviewPos.size} PO(s)`);
  console.log(`domain map pairs that would be seeded: ${seeded.size}`);
  for (const [oid, x] of Array.from(puts.entries())) console.log(`  PUT ${oid}  PO ${x.po}  ${x.asin}  +${Array.from(x.add).join(", ")}`);
  for (const r of review) console.log(`  REVIEW ${r}`);
  await pool.end();
}

main().catch(async (e) => { console.error(e?.message ?? e); await pool.end().catch(() => {}); process.exit(1); });
