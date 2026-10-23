// Close-after-create (listing-hygiene amendment 2026-10-23): a create-time
// end_at is stored but not applied, so the first §19 probe that sees the new
// listing sends component 22's close PATCH — once.
import { describe, it, expect, vi } from "vitest";
import { closeAfterCreate, BORN_CLOSED_REASON } from "./listing-hygiene-run";
import { fakeSc } from "./listing-hygiene.test-fixtures";
import { findForbiddenQuantityPaths, BORN_CLOSED_END_AT } from "./offer-add";

function actionsDb() {
  const rows: any[] = [];
  const query = async (sql: string, params: any[] = []) => {
    if (sql.startsWith("SELECT 1 FROM listing_actions")) {
      const hit = rows.filter((r) => r.sku === params[0] && r.action === "close" && !r.dry_run && r.fired_at >= params[1]);
      return { rows: hit.length ? [{ "?column?": 1 }] : [], rowCount: hit.length };
    }
    if (sql.startsWith("INSERT INTO listing_actions")) {
      rows.push({ sku: params[0], asin: params[1], action: params[2], job_id: params[3], dry_run: params[4], evidence: JSON.parse(params[5]), status: params[6], submission_id: params[7], fired_at: new Date().toISOString() });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected ${sql.slice(0, 50)}`);
  };
  return { rows, query };
}
const row = { asin: "B000000001", sku: "NEW-SKU-001", submittedAt: "2026-10-23T18:00:00Z" };

describe("closeAfterCreate", () => {
  it("a new open listing → exactly one close PATCH (merge, end_at from the helper, no quantity key) and one listing_actions row, reason born_closed", async () => {
    const sc = fakeSc({ "NEW-SKU-001": { end: null } });
    const db = actionsDb();
    const r = await closeAfterCreate(db.query as any, "SELLER", row);
    expect(r).toMatchObject({ status: "accepted", outcome: "closed" });
    expect(sc.patches).toHaveLength(1);
    expect(sc.patches[0].body.patches[0]).toMatchObject({ op: "merge", path: "/attributes/purchasable_offer" });
    expect(sc.patches[0].body.patches[0].value[0].end_at).toEqual({ value: BORN_CLOSED_END_AT });
    expect(findForbiddenQuantityPaths(sc.patches[0].body)).toEqual([]);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ sku: "NEW-SKU-001", action: "close", job_id: null, dry_run: false, status: "accepted", submission_id: "sub-1" });
    expect(db.rows[0].evidence).toMatchObject({ reason: BORN_CLOSED_REASON, live: true });
  });
  it("sent once: the next ladder probe (any live close row since the submission) sends nothing", async () => {
    const sc = fakeSc({ "NEW-SKU-001": { end: null } });
    const db = actionsDb();
    await closeAfterCreate(db.query as any, "SELLER", row);
    expect(await closeAfterCreate(db.query as any, "SELLER", row)).toBeNull();
    expect(await closeAfterCreate(db.query as any, "SELLER", row)).toBeNull();
    expect(sc.patches).toHaveLength(1);
    expect(db.rows).toHaveLength(1);
  });
  it("a pre-flight read that fails sends nothing and writes nothing — the next probe retries", async () => {
    fakeSc({});
    const { hygieneDeps } = await import("./listing-hygiene-run");
    const orig = hygieneDeps.sc.get;
    hygieneDeps.sc.get = async () => { const e: any = new Error("throttled"); e.response = { status: 429 }; throw e; };
    const db = actionsDb();
    const r = await closeAfterCreate(db.query as any, "SELLER", row);
    hygieneDeps.sc.get = orig;
    expect(r?.status).toBe("error");
    expect(db.rows).toHaveLength(0);
  });
});

describe("verifyPending → closeAfterCreate hook", () => {
  it("called for a probe that sees the SKU listed; not called without the hook (tests / callers that do not opt in)", async () => {
    vi.resetModules();
    vi.doMock("./submission-verify", () => ({
      probeListingState: async () => ({ throttled: false, classification: { status: "processing", reviewFlags: [], terminalConflict: false }, input: { found: true, listed: true, status: [], hasOffer: true, issues: [] } }),
      extractConflictAsin: () => null,
    }));
    vi.doMock("./live-offer-write", () => ({ writeLiveOfferVerdict: async () => {}, reprobeAsinLiveOffer: async () => {} }));
    const { verifyPending } = await import("./listing-submissions-repo");
    const query = async (sql: string) => sql.includes("FROM listing_submissions")
      ? { rows: [{ id: "s1", asin: "B000000001", sku: "NEW-SKU-001", submitted_at: "2026-10-23T18:00:00Z", age_hours: 0.1 }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
    const hook = vi.fn(async () => null);
    await verifyPending("SELLER", { query: query as any, delayMs: 0, closeAfterCreate: hook });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith({ asin: "B000000001", sku: "NEW-SKU-001", submittedAt: "2026-10-23T18:00:00Z" });
    await expect(verifyPending("SELLER", { query: query as any, delayMs: 0 })).resolves.toBeTruthy();
    vi.doUnmock("./submission-verify"); vi.doUnmock("./live-offer-write"); vi.resetModules();
  });
});
