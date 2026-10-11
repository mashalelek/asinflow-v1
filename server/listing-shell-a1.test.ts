import { describe, it, expect, vi } from "vitest";
import { checkSkuListingStatus } from "./sku-listing-fetch";
import { searchListingsItemsByAsin } from "./sku-listing-search";
import { classifyListingState, type ListingStateInput } from "./submission-verify";
import { outcomeFor, writeLiveOfferVerdict, recordTransient, recordError } from "./live-offer-write";

// §18 A1 + A2 (2026-10-09).
//
// A1 — PRESENT REQUIRES A LISTING, NOT A SKU STRING. A getListingsItem 200
// counts as listed ONLY if `summaries` is non-empty. Amazon leaves a SKU
// SHELL behind a failed submission: the SKU exists in the seller namespace,
// 200 comes back, and summaries is []. sku-listing-fetch.ts set present:true
// on ANY 200, so the shell read as "live" all the way into has_live_offer.
//
// The live case: B07J2WWWD4 / CAI-TOO-WD4-UMC-001 — never listed, its
// 2026-09-18 submission failed on 13013 + 5886, the verdict wrote FALSE, and
// a later reconcile flipped it back to TRUE off the shell.
//
// A2 — every flag write goes through ONE primitive and records a per-ASIN
// outcome. You cannot reach the UPDATE without passing an outcome sink.

const SELLER = "A1SELLER";

// The real B07J2WWWD4 shell payload, trimmed to the fields that matter.
const SHELL = {
  sku: "CAI-TOO-WD4-UMC-001",
  summaries: [],
  issues: [{ code: "5886", severity: "ERROR", message: "restricted generic ASIN…" }],
  offers: [],
  fulfillmentAvailability: [],
};

// The real B081S8MTJ5 payload shape — a genuine listing AF must keep as TRUE.
const REAL = {
  sku: "BC-DO62-O14S",
  summaries: [{ marketplaceId: "ATVPDKIKX0DER", asin: "B081S8MTJ5", status: ["DISCOVERABLE"], itemName: "Frango Mint" }],
  issues: [{ code: "99016", severity: "ERROR", message: "max 1 occurrence…" }],
  offers: [{ price: { amount: "188.89" } }],
  fulfillmentAvailability: [{ fulfillmentChannelCode: "AMAZON_NA" }],
};

// Verified live 2026-10-09: 1 of 805 account SKUs has a populated summary
// with an EMPTY status array. A real listing, mid-materialisation.
const EMPTY_STATUS = {
  sku: "ALF-BOO-V8U-RCM-001",
  summaries: [{ asin: "B01JO20V8U", status: [], itemName: "The Road" }],
  issues: [],
};

describe("A1: checkSkuListingStatus — a shell is not a listing", () => {
  it("200 with summaries: [] → present FALSE, shell flagged", async () => {
    const r = await checkSkuListingStatus(SELLER, SHELL.sku, async () => SHELL as any);
    expect(r.ok).toBe(true);
    expect((r as any).present).toBe(false);
    expect((r as any).shell).toBe(true);
  });

  it("200 with a populated summary → present TRUE with statuses and issues", async () => {
    const r = await checkSkuListingStatus(SELLER, REAL.sku, async () => REAL as any);
    expect((r as any).present).toBe(true);
    expect((r as any).statuses).toEqual(["DISCOVERABLE"]);
    expect((r as any).issues.map((i: any) => i.code)).toEqual(["99016"]);
  });

  it("THE PREDICATE IS summaries, NOT status: populated summary + empty status → present TRUE", async () => {
    // B01JO20V8U. Keying A1 on status would call this genuine listing absent,
    // and §19's classifier explicitly treats 200-with-empty-status as listed.
    const r = await checkSkuListingStatus(SELLER, EMPTY_STATUS.sku, async () => EMPTY_STATUS as any);
    expect((r as any).present).toBe(true);
    expect((r as any).statuses).toEqual([]);
  });

  it("a shell is indistinguishable from a 404 to the caller, except for the discriminator", async () => {
    const notFound = async () => { const e: any = new Error("nf"); e.response = { status: 404 }; throw e; };
    const a = await checkSkuListingStatus(SELLER, "X", notFound);
    const b = await checkSkuListingStatus(SELLER, SHELL.sku, async () => SHELL as any);
    expect((a as any).present).toBe((b as any).present);
    expect((a as any).shell).toBeUndefined(); // only the 200-with-no-summary is a shell
  });

  it("missing summaries key (not just empty) is also a shell", async () => {
    const r = await checkSkuListingStatus(SELLER, "X", async () => ({ sku: "X", issues: [] }) as any);
    expect((r as any).present).toBe(false);
    expect((r as any).shell).toBe(true);
  });
});

describe("A1: searchListingsItemsByAsin — shells filtered before present/absent", () => {
  const ok = (items: any[]) => async () => ({ numberOfResults: items.length, items });

  it("only shell rows → present FALSE (cannot make an ASIN un-addable)", async () => {
    const r = await searchListingsItemsByAsin(SELLER, "B07J2WWWD4", ok([{ sku: "SHELL-1", summaries: [] }]));
    expect(r.ok).toBe(true);
    expect((r as any).present).toBe(false);
  });

  it("a real row alongside a shell → present TRUE, shell excluded from items", async () => {
    const r = await searchListingsItemsByAsin(SELLER, "B0X", ok([
      { sku: "SHELL-1", summaries: [] },
      { sku: "REAL-1", summaries: [{ status: ["DISCOVERABLE"] }] },
    ]));
    expect((r as any).present).toBe(true);
    expect((r as any).items.map((i: any) => i.sku)).toEqual(["REAL-1"]);
  });

  it("a transient stays transient — never degraded to absent", async () => {
    const boom = async () => { const e: any = new Error("500"); e.response = { status: 500 }; throw e; };
    const r = await searchListingsItemsByAsin(SELLER, "B0X", boom, { maxAttempts: 1, initialBackoffMs: 1 });
    expect(r.ok).toBe(false);
  });
});

describe("A1: the shell still classifies `failed` — found and listed are different", () => {
  // The whole point of keeping `found` true for a shell. Dropping it to false
  // would lose the 5886 and leave the row `processing` forever.
  const shellInput: ListingStateInput = {
    found: true, listed: false, status: [], hasOffer: false,
    issues: [{ code: "5886", severity: "ERROR", message: "restricted generic ASIN" }],
  };

  it("shell + terminal 5886 → failed (unchanged by A1)", () => {
    expect(classifyListingState(shellInput).status).toBe("failed");
  });

  it("shell with no terminal signal → processing, still not live", () => {
    expect(classifyListingState({ ...shellInput, issues: [] }).status).toBe("processing");
  });

  it("listed with an empty status is NOT live yet but IS listed", () => {
    // classify says processing (not materialized); the FLAG says listed.
    const i: ListingStateInput = { found: true, listed: true, status: [], hasOffer: false, issues: [] };
    expect(classifyListingState(i).status).toBe("processing");
    expect(i.listed).toBe(true);
  });
});

describe("A2: writeLiveOfferVerdict is the one writer, and always ledgers", () => {
  const harness = () => {
    const writes: Array<{ sql: string; params: any[] }> = [];
    const outcomes: Record<string, string> = {};
    return {
      writes, outcomes,
      query: async (sql: string, params?: any[]) => { writes.push({ sql, params: params ?? [] }); return { rows: [], rowCount: 1 }; },
      sink: (asin: string, o: string) => { outcomes[asin] = o; },
    };
  };

  it("writes BOTH flags and both stamps in ONE statement", async () => {
    const h = harness();
    await writeLiveOfferVerdict(
      { asin: "B0X", prevFlag: false, listed: true, buyable: true, issues: [] },
      { query: h.query, outcomes: h.sink },
    );
    expect(h.writes).toHaveLength(1);
    const w = h.writes[0];
    expect(w.sql).toMatch(/has_live_offer = \$2/);
    expect(w.sql).toMatch(/has_buyable_offer = \$3/);
    expect(w.sql).toMatch(/offer_checked_at = now\(\)/);
    expect(w.sql).toMatch(/buyable_checked_at = now\(\)/);
    expect(w.params).toEqual(["B0X", true, true, "[]"]);
  });

  it("records an outcome on every write — the two cannot come apart", async () => {
    const h = harness();
    await writeLiveOfferVerdict(
      { asin: "B0X", prevFlag: true, listed: true, buyable: false, issues: [] },
      { query: h.query, outcomes: h.sink },
    );
    expect(h.outcomes).toEqual({ B0X: "listed" });
  });

  it("dryRun records the outcome and writes NOTHING", async () => {
    const h = harness();
    const o = await writeLiveOfferVerdict(
      { asin: "B0X", prevFlag: false, listed: true, buyable: false, issues: [] },
      { query: h.query, outcomes: h.sink, dryRun: true },
    );
    expect(h.writes).toHaveLength(0);
    expect(o).toBe("flip: false -> true");
    expect(h.outcomes.B0X).toBe("flip: false -> true");
  });

  it("never writes has_live_offer without has_buyable_offer in the same statement", async () => {
    const h = harness();
    await writeLiveOfferVerdict(
      { asin: "B0X", prevFlag: null, listed: false, buyable: false, issues: [] },
      { query: h.query, outcomes: h.sink },
    );
    for (const w of h.writes) {
      if (/has_live_offer/.test(w.sql)) expect(w.sql).toMatch(/has_buyable_offer/);
    }
  });
});

describe("A2: the outcome vocabulary", () => {
  const v = (o: Partial<Parameters<typeof outcomeFor>[0]>) =>
    outcomeFor({ asin: "B0X", prevFlag: false, listed: false, buyable: false, issues: [], ...o });

  it("unchanged TRUE → listed; unchanged FALSE → not_listed", () => {
    expect(v({ prevFlag: true, listed: true })).toBe("listed");
    expect(v({ prevFlag: false, listed: false })).toBe("not_listed");
  });

  it("a change → flip: x -> y, with NULL spelled out as a from-value", () => {
    expect(v({ prevFlag: true, listed: false })).toBe("flip: true -> false");
    expect(v({ prevFlag: false, listed: true })).toBe("flip: false -> true");
    expect(v({ prevFlag: null, listed: true })).toBe("flip: null -> true");
  });

  it("B07J2WWWD4's gate outcome is exactly `flip: true -> false`", () => {
    expect(v({ prevFlag: true, listed: false })).toBe("flip: true -> false");
  });

  it("discovery and onboarded outrank the flip label", () => {
    // A discovery is ALWAYS also a flip; the discovery is the informative
    // fact and the flip stays recoverable from the report's flips array.
    expect(v({ prevFlag: false, listed: true, event: "discovery" })).toBe("discovery");
    expect(v({ prevFlag: null, listed: true, event: "onboarded" })).toBe("onboarded");
  });

  it("transient and error are their own entry points, so a half-built verdict can't write", () => {
    const outcomes: Record<string, string> = {};
    const sink = (a: string, o: string) => { outcomes[a] = o; };
    expect(recordTransient("B0A", sink)).toBe("skipped_transient");
    expect(recordError("B0B", "429 throttled", sink)).toBe("error: 429 throttled");
    expect(outcomes).toEqual({ B0A: "skipped_transient", B0B: "error: 429 throttled" });
  });
});
