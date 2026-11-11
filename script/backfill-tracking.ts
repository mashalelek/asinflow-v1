// PO tracking backfill (SPEC §26; patch po-tracking-velocity §12, commit 8).
//
//   npm run backfill:tracking                 # DRY RUN (default): reads Gmail + Velocity + AF, writes nothing
//   npm run backfill:tracking -- --live       # ingest + match + push for real
//   --live --stage ingest   ingest + match only (sets the watermark) — then backfill ships_to / apply moves
//   --live --stage push     the push only
//   [--live] --stage links  re-read EVERY ai_disabled placeholder's email through the
//                           tracking-link follow (any age), then re-match (2026-10-22)
//   [--live] --stage match  re-run the matcher alone over the unmatched queue, the
//                           email-text rule included; prints the link list (2026-11-04)
//   [--live] --stage ai     the tracking AI fallback over every ai_disabled placeholder
//                           naming one AF PO (dry run: counts, no model call), then
//                           re-match; --ai-max N caps the calls (default 25; 2026-11-04)
//   [--live] --stage placeholders   claims patch §3.10 (2026-11-11): every open
//                           "email:" placeholder — first those a real row for the same
//                           order already replaces (dropped), then each remaining one
//                           re-read through the fixed parser (schema.org ParcelDelivery
//                           markup, anchor rules, GET-only click trackers): resolved →
//                           rows + placeholder dropped, else the reason it stays (where
//                           its links end). Dismissed ones are listed, never re-read.
//                           Dry run writes docs/tracking-placeholders-<date>.csv.
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
import "./env";
import pool from "../server/db";
import { gmailClient, listMessageIds, getMessage, emailTextFor } from "../server/gmail-client";
import { parseTrackingEmail } from "../server/tracking-parse";
import { rowsFromEmail, withLinkTracking, ingestTracking, isPlaceholder, resolveLinkPlaceholders, aiPlaceholders, dropResolvedPlaceholders, dropPlaceholdersFor, upsertTrackingRow, type TrackingRowDraft } from "../server/tracking-ingest";
import { extractorFor, trackingLinks, genericTrackingLinks, ruleAnchors, followDiagnostic, linkOutcome } from "../server/tracking-links";
import { carrierFromName } from "../server/tracking-parse";
import { writeFileSync } from "fs";
import { matchRow, loadDomainMap, matchTrackingRows, type PoRef } from "../server/tracking-match";
import { replacementLookup } from "../server/tracking-replacement";
import { routeTracking, joinReasons } from "../server/tracking-route-rules";
import { indexInbound, knownOrderNumbersHydrated, trackingNumbersOf, pushTracking } from "../server/tracking-push";
import { fetchAllInboundOrders, fetchAllKnownOrders } from "../server/velocity-api";
import type { QueryLike } from "../server/scheduler/types";

const live = process.argv.includes("--live");
const stageArg = (() => { const i = process.argv.indexOf("--stage"); return i >= 0 ? process.argv[i + 1] : "all"; })();
if (!["all", "ingest", "push", "links", "match", "ai", "placeholders"].includes(stageArg)) throw new Error("--stage must be ingest, push, links, match, ai, placeholders or all");
const query: QueryLike = (sql, params) => pool.query(sql, params) as any;

/** A carrier the email names in prose ("being delivered by FedEx", "Shipping Method FDXGND"). */
function carrierNamed(text: string): string | null {
  const m = /\b(?:delivered by|shipped (?:via|with|by)|carrier|shipping method)\b[\s:]*([A-Za-z][A-Za-z ]{1,20})/i.exec(text);
  return carrierFromName(m?.[1] ?? null) ?? (/\bFDXG|FDXGND|FDX\b/.test(text) ? "FEDEX" : null);
}

async function placeholdersStage(): Promise<void> {
  const gmail = gmailClient();
  const csv: string[] = ["id,sender_domain,order,shipped_at,match_reason,outcome,carrier,tracking_number,detail"];
  const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  // 1. already answered by a later email / link / the AI: a real row for the same order
  const replaced = await dropResolvedPlaceholders(query, { dryRun: !live });
  const all = (await query(`SELECT id, sender_domain, retailer_order_id, match_reason, gmail_message_id, shipped_at::date::text AS shipped_at, email_subject FROM po_tracking WHERE tracking_number LIKE 'email:%' AND status = 'unmatched' ORDER BY sender_domain, id`)).rows;
  const replacedIds = new Set(replaced.map((r) => r.id));
  for (const r of replaced) {
    const row = all.find((x: any) => Number(x.id) === r.id);
    csv.push([r.id, r.sender_domain, r.retailer_order_id, row?.shipped_at, row?.match_reason, "replaced", r.carrier, r.tracking_number, `real row #${r.by_id} already holds the number`].map(q).join(","));
  }
  let resolved = 0, stay = 0, dismissed = 0, rows = 0;
  for (const r of all) {
    const id = Number(r.id);
    if (replacedIds.has(id)) continue;
    if (r.match_reason === "dismissed") { dismissed++; csv.push([id, r.sender_domain, r.retailer_order_id, r.shipped_at, r.match_reason, "dismissed", "", "", "dismissed by hand — not re-read"].map(q).join(",")); continue; }
    // 2. re-read through the fixed parser and link follow
    const msg = await getMessage(gmail, String(r.gmail_message_id));
    const parsed = parseTrackingEmail(msg);
    const p = await withLinkTracking(msg, parsed);
    const drafts = rowsFromEmail(msg, p).filter((d) => !isPlaceholder(d.tracking_number));
    if (drafts.length) {
      resolved++; rows += drafts.length;
      for (const d of drafts) csv.push([id, r.sender_domain, r.retailer_order_id, r.shipped_at, r.match_reason, "resolved", d.carrier, d.tracking_number, parsed.shipments.length ? "from the email's markup (schema.org ParcelDelivery)" : "from a tracking link"].map(q).join(","));
      if (live) { for (const d of drafts) await upsertTrackingRow(query, d); await dropPlaceholdersFor(query, r.sender_domain, r.retailer_order_id); }
      continue;
    }
    // 3. stays: why — where its candidate links end, and the carrier it names
    stay++;
    const ex = extractorFor(p.senderDomain);
    const candidates = ex ? trackingLinks(msg.text, ex) : genericTrackingLinks(msg.text, msg.trackLinks ?? [], ruleAnchors(p.senderDomain, msg.links ?? []));
    const ends: string[] = [];
    for (const u of candidates.slice(0, 4)) ends.push(linkOutcome(await followDiagnostic(u)));
    const named = carrierNamed(msg.text);
    const detail = [candidates.length === 0 ? "no tracking link in the email" : `${candidates.length} link(s): ${Array.from(new Set(ends)).join("; ")}`, named ? `names ${named}, prints no number` : "names no carrier"].join(" · ");
    csv.push([id, r.sender_domain, r.retailer_order_id, r.shipped_at, r.match_reason, "stays", "", "", detail].map(q).join(","));
  }
  const m = live ? await matchTrackingRows(query, { textFor: emailTextFor(gmailClient()), replacementFor: replacementLookup(gmailClient()) }) : null;
  const date = new Date().toISOString().slice(0, 10);
  const file = `docs/tracking-placeholders-${live ? "live" : "dry-run"}-${date}.csv`;
  writeFileSync(file, csv.join("\n") + "\n");
  console.log(`${live ? "LIVE" : "DRY RUN"} — placeholders ${all.length}: replaced by an existing row ${replaced.length} · resolved now ${resolved} (${rows} rows) · stay ${stay} · dismissed ${dismissed}${m ? ` · re-match matched ${m.matched} ${JSON.stringify(m.unmatched)}` : ""}`);
  for (const line of csv.slice(1)) console.log("  " + line);
  console.log(`report: ${file}`);
  await pool.end();
}

async function main(): Promise<void> {
  if (stageArg === "placeholders") { await placeholdersStage(); return; }
  if (stageArg === "match") {
    const m = await matchTrackingRows(query, { dryRun: !live, textFor: emailTextFor(gmailClient()), replacementFor: replacementLookup(gmailClient()) });
    console.log(`${live ? "LIVE" : "DRY RUN"} — ${JSON.stringify({ ...m, links: undefined })}`);
    for (const l of m.links) {
      const t = (await query(`SELECT t.retailer_order_id, t.sender_domain, t.email_subject, p.supplier, p.order_id, p.order_date::text AS order_date FROM po_tracking t, purchase_orders p WHERE t.id = $1 AND p.id = $2`, [l.id, l.po_id])).rows[0];
      console.log(`  #${l.id} ${l.via} · ${t?.sender_domain} "${String(t?.email_subject ?? "").slice(0, 60)}" (printed ${t?.retailer_order_id ?? "—"}) → ${t?.supplier} ${t?.order_id} (${t?.order_date})`);
    }
    await pool.end();
    return;
  }
  if (stageArg === "ai") {
    const i = process.argv.indexOf("--ai-max");
    const r = await aiPlaceholders(query, { gmail: gmailClient(), aiMaxCalls: i > 0 ? Number(process.argv[i + 1]) : undefined }, { dryRun: !live });
    if (!r) { console.log("AI is off (no ANTHROPIC_API_KEY)"); await pool.end(); return; }
    console.log(`${live ? "LIVE" : "DRY RUN"} — placeholders ${r.placeholders} · naming one AF PO ${r.one_po} · not one PO ${r.no_single_po} · calls ${r.calls} (resolved ${r.resolved} → ${r.rows} rows, none ${r.none}, failed ${r.failed}, over cap ${r.skipped_cap}, would ask ${r.dry_run}) ≈ $${r.cost}`);
    for (const x of r.items) console.log(`  #${x.id} ${x.sender_domain} ${x.order_id} ${x.outcome}${x.numbers ? ` → ${x.numbers.join(", ")} (${x.via})` : ""}${x.error ? ` ${x.error}` : ""}`);
    if (live) { const m = await matchTrackingRows(query, { textFor: emailTextFor(gmailClient()), replacementFor: replacementLookup(gmailClient()) }); console.log(`re-match: matched ${m.matched} ${JSON.stringify(m.unmatched)}`); }
    await pool.end();
    return;
  }
  if (stageArg === "links") {
    const r = await resolveLinkPlaceholders(query, { gmail: gmailClient() }, { dryRun: !live, allAges: true });
    const m = live ? await matchTrackingRows(query) : null;
    console.log(`${live ? "LIVE" : "DRY RUN"} — placeholders read ${r.placeholders}, resolved ${r.resolved} (${r.rows} rows)${m ? ` · re-match ${JSON.stringify(m)}` : ""}`);
    await pool.end();
    return;
  }
  const inboundOrders = await fetchAllInboundOrders();
  const inbound = indexInbound(inboundOrders);
  // ships_to as the prep-cost backfill sets it (server/ships-to-backfill.ts) —
  // computed here, so a dry run before the backfill (or before migration 066)
  // routes exactly as the live run will after it.
  const pos: Array<PoRef & { order_date: string; ships_to: string; canceled_or_returned: boolean }> = (await query(
    `SELECT p.id, p.supplier, p.order_id, p.order_date::text AS order_date,
            CASE WHEN (SELECT MAX(a.prep_cost) FROM po_asins a WHERE a.po_id = p.id) > 0 THEN 'velocity' ELSE 'home' END AS ships_to,
            (EXISTS (SELECT 1 FROM po_line_items l WHERE l.po_id = p.id)
              AND NOT EXISTS (SELECT 1 FROM po_line_expected le WHERE le.po_id = p.id AND COALESCE(le.expected_product, 0) > 0)) AS canceled_or_returned
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
    if (d.match_reason === "unpaired" || d.match_reason === "return") { unmatched[d.match_reason] = (unmatched[d.match_reason] ?? 0) + 1; continue; }
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
