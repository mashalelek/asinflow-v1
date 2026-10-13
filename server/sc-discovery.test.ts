import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  fetchAllAccountListings,
  resolveOnboardData,
  normalizeSupplierDomain,
} from "./sc-discovery";

// §18 Part B phase c (2026-10-11) — ASINs SC has that AF does not.
//
// Two things carry the risk here: the account pull must be ALL-OR-NOTHING
// (onboarding from a truncated list creates some rows and silently omits
// others, and the omission is invisible), and A1 must hold on this source
// too (a shell is not a listing, so it is not an ASIN worth creating).

const SELLER = "A1SELLER";

const item = (sku: string, asin: string, status: string[] = ["DISCOVERABLE"]) =>
  ({ sku, summaries: [{ asin, status, itemName: `item ${sku}` }] });
const shell = (sku: string) => ({ sku, summaries: [] });

/** A paginated fake: pages[i] is returned for the i-th call. */
const paged = (pages: any[][], opts: { failOn?: number; noTokenAfter?: number } = {}) => {
  let n = 0;
  return async () => {
    const i = n++;
    if (opts.failOn === i) { const e: any = new Error("boom"); e.response = { status: 500 }; throw e; }
    const last = opts.noTokenAfter != null ? i >= opts.noTokenAfter : i >= pages.length - 1;
    return { numberOfResults: pages.flat().length, items: pages[i] ?? [], pagination: last ? {} : { nextToken: `t${i}` } };
  };
};

describe("fetchAllAccountListings — paginates the unfiltered account list", () => {
  it("walks every page and returns all A1-qualified rows", async () => {
    const r = await fetchAllAccountListings(SELLER, paged([
      [item("S1", "B001"), item("S2", "B002")],
      [item("S3", "B003")],
    ]) as any, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pages).toBe(2);
    expect(r.listings.map((l) => l.asin)).toEqual(["B001", "B002", "B003"]);
    expect(r.listings[0]).toEqual({ sku: "S1", asin: "B001", statuses: ["DISCOVERABLE"] });
  });

  it("sends NO identifiers — this is the account-wide call", async () => {
    const seen: any[] = [];
    await fetchAllAccountListings(SELLER, (async (_p: string, q: any) => {
      seen.push(q);
      return { items: [], pagination: {} };
    }) as any, 0);
    expect(seen[0].identifiers).toBeUndefined();
    expect(seen[0].identifiersType).toBeUndefined();
    expect(seen[0].pageSize).toBe("20");
    expect(seen[0].includedData).toBe("summaries");
  });

  it("passes pageToken on subsequent pages only", async () => {
    const seen: any[] = [];
    await fetchAllAccountListings(SELLER, (async (_p: string, q: any) => {
      seen.push(q);
      return { items: [], pagination: seen.length < 2 ? { nextToken: "TOK" } : {} };
    }) as any, 0);
    expect(seen[0].pageToken).toBeUndefined();
    expect(seen[1].pageToken).toBe("TOK");
  });

  it("A1: shell rows are excluded, real rows on the same page survive", async () => {
    const r = await fetchAllAccountListings(SELLER, paged([
      [shell("SHELL-1"), item("S1", "B001")],
    ]) as any, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.listings.map((l) => l.sku)).toEqual(["S1"]);
  });

  it("the ASIN comes from summaries[0].asin — there is no other source", async () => {
    // includedData=summaries returns only { sku, summaries }.
    const r = await fetchAllAccountListings(SELLER, paged([
      [{ sku: "S1", summaries: [{ status: ["DISCOVERABLE"] }] }], // no asin
    ]) as any, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.listings).toEqual([]); // unattributable → dropped, never guessed
  });

  it("an empty status array is still a listing (the B01JO20V8U shape)", async () => {
    const r = await fetchAllAccountListings(SELLER, paged([[item("S1", "B001", [])]]) as any, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.listings).toHaveLength(1);
    expect(r.listings[0].statuses).toEqual([]);
  });
});

describe("fetchAllAccountListings — a partial pull onboards NOTHING", () => {
  it("a failing FIRST page is sc_list_incomplete", async () => {
    const r = await fetchAllAccountListings(SELLER, paged([[]], { failOn: 0 }) as any, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("sc_list_incomplete");
    expect(r.pagesFetched).toBe(0);
  });

  it("a failing LATER page discards the pages already fetched", async () => {
    // The dangerous case: 2 good pages then a 500. Returning the partial set
    // would onboard some ASINs and silently omit the rest.
    const r = await fetchAllAccountListings(SELLER, paged([
      [item("S1", "B001")], [item("S2", "B002")], [item("S3", "B003")],
    ], { failOn: 2 }) as any, 0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("sc_list_incomplete");
    expect(r.pagesFetched).toBe(2);
    expect((r as any).listings).toBeUndefined(); // no partial payload to misuse
  });

  it("the page cap with a token still present is incomplete, not a quiet stop", async () => {
    // Never-ending pagination must not look like a finished list.
    const r = await fetchAllAccountListings(
      SELLER,
      (async () => ({ items: [item("S", "B001")], pagination: { nextToken: "forever" } })) as any,
      0,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.detail).toMatch(/page cap/);
  });

  it("a genuinely empty account is ok, not incomplete", async () => {
    const r = await fetchAllAccountListings(SELLER, paged([[]]) as any, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.listings).toEqual([]);
  });
});

describe("normalizeSupplierDomain — the Orders col-E cell is a domain, pasted by hand", () => {
  it("passes a bare domain through, lowercased", () => {
    expect(normalizeSupplierDomain("macys.com")).toBe("macys.com");
    expect(normalizeSupplierDomain("  Macys.COM ")).toBe("macys.com");
  });

  it("strips a scheme and www.", () => {
    expect(normalizeSupplierDomain("https://www.macys.com")).toBe("macys.com");
    expect(normalizeSupplierDomain("http://macys.com/path?x=1")).toBe("macys.com");
  });

  it("rejects anything that is not a host", () => {
    for (const bad of ["", "   ", "not a domain", "macys", "/", null, undefined]) {
      expect(normalizeSupplierDomain(bad as any), String(bad)).toBeNull();
    }
  });
});

describe("resolveOnboardData — buy-link precedence (§18 phase c step 3)", () => {
  const skus = new Map([["B001", ["SKU-1"]]]);

  it("a. Master sheet col N wins; supplier derived from the URL", () => {
    const [r] = resolveOnboardData(
      ["B001"], skus,
      new Map([["B001", "https://www.target.com/p/thing/-/A-123"]]),
      new Map([["B001", "macys.com"]]), // present, but master wins
    );
    expect(r.buyLinkSource).toBe("master");
    expect(r.buyLink).toBe("https://www.target.com/p/thing/-/A-123");
    expect(r.supplier).toBe("target.com");
  });

  it("b. else Orders col E → https:// + normalized domain", () => {
    const [r] = resolveOnboardData(["B001"], skus, new Map(), new Map([["B001", "  WWW.Macys.com "]]));
    expect(r.buyLinkSource).toBe("orders");
    expect(r.buyLink).toBe("https://macys.com");
    expect(r.supplier).toBe("macys.com");
  });

  it("c. neither → both NULL, no synthetic value", () => {
    const [r] = resolveOnboardData(["B001"], skus, new Map(), new Map());
    expect(r.buyLinkSource).toBe("none");
    expect(r.buyLink).toBeNull();
    expect(r.supplier).toBeNull();
  });

  it("COGS source is independent of the buy link", () => {
    // Orders rows present but the supplier cell is blank: PO COGS still
    // applies, the buy link does not resolve.
    const [r] = resolveOnboardData(["B001"], skus, new Map(), new Map([["B001", null]]));
    expect(r.cogsSource).toBe("po_sheet");
    expect(r.buyLinkSource).toBe("none");
  });

  it("no Orders rows → COGS none (NULL, never a synthetic zero)", () => {
    const [r] = resolveOnboardData(["B001"], skus, new Map(), new Map());
    expect(r.cogsSource).toBe("none");
  });

  it("carries every SKU SC returned for the ASIN", () => {
    const [r] = resolveOnboardData(["B001"], new Map([["B001", ["A", "B"]]]), new Map(), new Map());
    expect(r.skus).toEqual(["A", "B"]);
  });
});

// ── Wiring pins ─────────────────────────────────────────────────────────────
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "").replace(/[ \t]+\/\/.*$/gm, "");
const code = (f: string) => stripComments(readFileSync(join(__dirname, f), "utf8"));

describe("phase c wiring", () => {
  it("runs on EVERY Prices & Stock run, working set irrelevant", () => {
    const s = code("refresh-job.ts");
    const i = s.indexOf("runFullScopePass({");
    expect(s.slice(i, i + 400)).toMatch(/phaseC: true/);
  });

  it("runs on Product Info ONLY at full-catalog scope", () => {
    const s = code("routes.ts");
    const i = s.indexOf("const lr = await runFullScopePass(");
    const block = s.slice(i - 600, i + 400);
    expect(block).toMatch(/const fullCatalog = totalAsins > 0 && asinList\.length >= totalAsins/);
    expect(s.slice(i, i + 400)).toMatch(/phaseC: fullCatalog/);
  });

  it("a dry run onboards nothing but still reports what it would", () => {
    const s = code("full-scope-pass.ts");
    const i = s.indexOf("if (!dryRun && resolved.length > 0 && opts.onboard)");
    expect(i).toBeGreaterThan(-1);
    expect(s.slice(i, i + 400)).toMatch(/if \(dryRun\) \{/);
  });

  it("an incomplete pull records sc_list_incomplete and onboards nothing", () => {
    const s = code("full-scope-pass.ts");
    const i = s.indexOf("if (!pull.ok)");
    const block = s.slice(i, i + 700);
    expect(block).toMatch(/onboarded: \[\]/);
    expect(block).toMatch(/sc_list_incomplete/);
    expect(block).not.toMatch(/opts\.onboard/);
  });

  it("onboarding goes through onboardNewAsins with trigger sc_discovery", () => {
    const s = code("routes.ts");
    const i = s.indexOf("async function onboardScDiscoveries");
    const fn = s.slice(i, i + 4000);
    expect(fn).toMatch(/await onboardNewAsins\(inputs, \(\) => \{\}, mainCatalogSink, "sc_discovery"\)/);
    expect(fn).toMatch(/tags: \["SC import"\]/);
    expect(fn).toMatch(/in_catalog = TRUE/);
    expect(fn).toMatch(/event: "onboarded"/);
  });

  it("the flag is written through the A2 primitive, not a raw UPDATE", () => {
    const s = code("routes.ts");
    const i = s.indexOf("async function onboardScDiscoveries");
    const fn = s.slice(i, i + 4000);
    expect(fn).toMatch(/writeLiveOfferVerdict\(/);
    expect(fn).not.toMatch(/SET has_live_offer/);
  });

  it("supplier and primary_sku writes are INSERT-branch guarded (IS NULL)", () => {
    const s = code("routes.ts");
    const i = s.indexOf("async function onboardScDiscoveries");
    const fn = s.slice(i, i + 4000);
    expect(fn).toMatch(/SET supplier = \$2 WHERE asin = \$1 AND supplier IS NULL/);
    expect(fn).toMatch(/SET primary_sku = \$2 WHERE asin = \$1 AND primary_sku IS NULL/);
  });

  it("COGS runs the real scoped PO sync, only for Orders-matched ASINs", () => {
    const s = code("routes.ts");
    const i = s.indexOf("async function onboardScDiscoveries");
    const fn = s.slice(i, i + 4000);
    expect(fn).toMatch(/cogsSource === "po_sheet"/);
    expect(fn).toMatch(/runSheetsSync\(new Set\(poAsins\)\)/);
  });

  it("migration 046 widens the trigger CHECK with sc_discovery", () => {
    const m = readFileSync(
      join(__dirname, "..", "database", "migrations", "046_refresh_runs_trigger_sc_discovery.sql"), "utf8");
    expect(m).toMatch(/DROP CONSTRAINT refresh_runs_trigger_check/);
    expect(m).toMatch(/'sc_discovery'/);
    // the existing seven must survive the rewrite
    for (const t of ["manual", "refresh", "cron", "sourcing", "upload", "extension", "backfill"]) {
      expect(m, t).toMatch(new RegExp(`'${t}'`));
    }
  });
});
