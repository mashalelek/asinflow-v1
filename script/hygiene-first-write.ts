// Listing hygiene — first-write protocol (SPEC §11 components 22 / 24;
// patch "First-write protocol", steps 3–4; Maria 2026-10-20, option (a)).
//
//   tsx script/hygiene-first-write.ts --action close  --sku ABC-DEF-001          # report only
//   tsx script/hygiene-first-write.ts --action close  --sku ABC-DEF-001 --live   # one live close
//   tsx script/hygiene-first-write.ts --action delete --sku ABC-DEF-001 --live   # one live delete
//
// ONE named SKU. Re-checks it against the same rules the components use
// (evaluateClose / evaluateDelete) with LIVE reads — getListingsItem
// (summaries + attributes), getInventorySummaries for the SKU, the PO
// pipeline, and for delete the ledger availability and a live Velocity read —
// and REFUSES (exit 2) when it does not qualify. Without --live it prints the
// evaluation and the exact request it would send, and writes nothing.
//
// --live sends through the same code path as the components (fireClose /
// fireDelete: live pre-flight read, findForbiddenQuantityPaths abort, op
// merge with closedEndAt(), never a price field), writes a listing_actions
// row (dry_run = false, evidence.first_write = true; component 16 verifies
// it on the next pass like any other), then reads back: close → end_at;
// delete → the probe (404 / empty summaries expected), polled for up to
// 10 minutes because Amazon applies both asynchronously.
//
// --live is this script's own gate: LISTING_CLOSE_LIVE / LISTING_DELETE_LIVE
// are NOT consulted — they govern the scheduled components, and stay unset
// until Maria sets them. Needs DATABASE_URL and the SP-API (and, for delete,
// Velocity) credentials in the environment.
import "dotenv/config";
import pool from "../server/db";
import {
  loadSkuFacts, attachPipeline, readListingLive, readInventoryLive, evaluateClose, evaluateDelete,
  ledgerAvailability, velocityOnHandByAsin, buildClosePatchBody, fireClose, fireDelete, realScDeps,
  type HygieneAction, type Basis,
} from "../server/listing-hygiene";
import { insertAction } from "../server/listing-hygiene-run";
import type { QueryLike } from "../server/scheduler/types";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<number> {
  const action = arg("action") as HygieneAction | undefined;
  const sku = arg("sku");
  const live = process.argv.includes("--live");
  if (action !== "close" && action !== "delete") { console.error("--action close|delete required"); return 1; }
  if (!sku) { console.error("--sku required"); return 1; }
  const sellerId = process.env.SP_API_SELLER_ID;
  if (!sellerId) { console.error("SP_API_SELLER_ID is not set"); return 1; }
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is not set"); return 1; }
  const query: QueryLike = (sql, params) => pool.query(sql, params) as any;
  const now = new Date();
  const sc = realScDeps;

  console.log(`${live ? "LIVE" : "REPORT ONLY"} — ${action} ${sku}`);
  const facts = await loadSkuFacts(query, { skus: [sku] }, action, now);
  if (facts.length === 0) { console.error(`REFUSED: AF has no asin_skus row for ${sku}`); return 2; }
  const f = facts[0];

  // Live re-reads — the same inputs the Release path uses.
  const l = await readListingLive(sellerId, sku, sc);
  if (!l.ok) { console.error(`REFUSED: listing read failed — ${l.message}`); return 2; }
  f.listing = !l.present
    ? { checkedAt: now, createdAt: null, offerEndAt: null }
    : { checkedAt: now, createdAt: l.state.createdAt ? new Date(l.state.createdAt) : null, offerEndAt: l.state.offerEndAt ? new Date(l.state.offerEndAt) : null };
  const inv = (await readInventoryLive([sku], sc, now)).get(sku)!;
  f.inventory = { ...inv, lastNonzeroAt: f.inventory?.lastNonzeroAt ?? null };
  await attachPipeline(facts, query);
  if (action === "delete") {
    const ledger = await ledgerAvailability(query, now);
    if (!ledger.ok) { console.error(`REFUSED: ledger_unavailable — ${ledger.reason}`); return 2; }
    try {
      const m = velocityOnHandByAsin(await sc.velocity());
      f.velocityOnHand = f.asins.reduce((s, a) => s + (m.get(a.toUpperCase()) ?? 0), 0);
    }
    catch (err: any) { console.error(`REFUSED: velocity_unavailable — ${err?.message ?? err}`); return 2; }
  }
  const basis: Basis = { now, inventoryFrom: now, listingFrom: now };
  const e = action === "close" ? evaluateClose(f, basis) : evaluateDelete(f, basis);
  console.log(`listing (live): ${l.present ? `present, end_at ${l.state.offerEndAt ?? "null (open)"}, productType ${l.state.productType}` : "absent"}`);
  console.log("evaluation:", JSON.stringify({ outcome: e.outcome, ...e.evidence }, null, 2));
  if (!e.candidate) { console.error(`REFUSED: ${sku} does not qualify — ${e.outcome}`); return 2; }

  const endpoint = `/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}?marketplaceIds=ATVPDKIKX0DER`;
  if (!live) {
    if (action === "close") {
      console.log(`would send: PATCH ${endpoint}`);
      console.log(JSON.stringify(buildClosePatchBody(l.ok && l.present ? (l.state.productType ?? "?") : "?"), null, 2));
    } else {
      console.log(`would send: DELETE ${endpoint}`);
    }
    console.log("nothing written (no --live).");
    return 0;
  }

  const r = action === "close" ? await fireClose(sellerId, sku, sc, new Date()) : await fireDelete(sellerId, sku, sc, new Date());
  console.log("result:", JSON.stringify(r, null, 2));
  if (r.status !== "skipped") {
    await insertAction(query, {
      sku, asin: f.asin, action, jobId: null, dryRun: false,
      evidence: { ...e.evidence, live: true, first_write: true, script: "hygiene-first-write.ts", preflight: r.preflight ?? null },
      status: r.status, submissionId: r.submissionId, issues: r.issues,
    });
    console.log(`listing_actions row written (status ${r.status}).`);
  }
  if (r.status !== "accepted") return r.status === "skipped" ? 2 : 3;

  // Read back. Amazon applies both writes asynchronously.
  for (let i = 0; i < 20; i++) {
    await sleep(30_000);
    const back = await readListingLive(sellerId, sku, sc);
    const t = new Date().toISOString();
    if (!back.ok) { console.log(`${t} read-back failed: ${back.message}`); continue; }
    if (action === "close") {
      console.log(`${t} end_at = ${back.present ? back.state.offerEndAt ?? "null (still open)" : "listing absent"}`);
      if (back.present && back.state.offerEndAt && Date.parse(back.state.offerEndAt) <= Date.now()) { console.log("CLOSED — end_at is in the past."); return 0; }
    } else {
      console.log(`${t} probe: ${back.present ? `still present (end_at ${back.state.offerEndAt})` : "absent — 404 / empty summaries"}`);
      if (!back.present) { console.log("DELETED — the probe finds no listing."); return 0; }
    }
  }
  console.log("not yet effective after 10 min — component 16 keeps verifying (not_effective after two passes).");
  return 4;
}

main().then(async (code) => { await pool.end(); process.exit(code); }).catch(async (err) => { console.error(err?.message ?? err); await pool.end().catch(() => {}); process.exit(1); });
