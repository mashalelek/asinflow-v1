// Born-closed poll (SPEC §18, Maria 2026-11-04): new offers closed within minutes, from the DB.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { bornClosedTick, BORN_CLOSED_DUE_SQL, BORN_CLOSED_WINDOW_MIN, BORN_CLOSED_POLL_MS } from "./born-closed-poll";

const row = (id: string, verify_status: string) => ({ id, asin: "B0ZZTEST0" + id, sku: "ZZ-" + id, submitted_at: new Date("2026-11-04T20:19:25Z"), verify_status });

describe("born-closed poll", () => {
  it("every minute, for 30 minutes after submission; not open_on_create, not failed, no live close since submitted", () => {
    expect(BORN_CLOSED_POLL_MS).toBe(60_000);
    expect(BORN_CLOSED_WINDOW_MIN).toBe(30);
    expect(BORN_CLOSED_DUE_SQL).toMatch(/open_on_create IS NOT TRUE/);
    expect(BORN_CLOSED_DUE_SQL).toMatch(/verify_status IN \('pending', 'processing', 'live'\)/);
    expect(BORN_CLOSED_DUE_SQL).toMatch(/action = 'close' AND a\.dry_run = FALSE AND a\.fired_at >= s\.submitted_at/);
  });
  it("open rows go through verifyPending (scoped, with the close hook); a row already live is closed directly; nothing due → no probe", async () => {
    const calls: any[] = [], closed: string[] = [];
    const deps = {
      query: async () => ({ rows: [row("1", "pending"), row("2", "processing"), row("3", "live")] }),
      verify: (async (_s: string, o: any) => { calls.push(o.ids); await o.closeAfterCreate({ asin: "B0ZZTEST01", sku: "ZZ-1", submittedAt: "x" }); return {} as any; }) as any,
      close: async (_q: any, _s: string, r: any) => { closed.push(r.sku); return null; },
    };
    expect(await bornClosedTick("SELLER", deps)).toEqual({ due: 3, closes: 2 });
    expect(calls).toEqual([["1", "2"]]);
    expect(closed).toEqual(["ZZ-1", "ZZ-3"]);
    const none = { ...deps, query: async () => ({ rows: [] }), verify: (async () => { throw new Error("no probe expected"); }) as any };
    expect(await bornClosedTick("SELLER", none)).toEqual({ due: 0, closes: 0 });
  });
  it("starts with the schedule (production, ENABLE_CRONS=true) — never from a local dev server on a copied DB", () => {
    const idx = readFileSync(resolve(__dirname, "index.ts"), "utf8");
    const gate = idx.indexOf('process.env.ENABLE_CRONS === "true" && process.env.SP_API_SELLER_ID');
    expect(gate).toBeGreaterThan(0);
    expect(idx.indexOf("startBornClosedPoll(")).toBeGreaterThan(gate);
    expect(idx.indexOf("startBornClosedPoll(")).toBeLessThan(idx.indexOf("} else if", gate));
  });
});
