import { describe, it, expect } from "vitest";
import { BOOT_RETRY_DELAYS_MS, isTransientDbError, withBootRetry } from "./boot-retry";

describe("boot retry (Postgres refusing connections at startup)", () => {
  it("the delays back off 2s, 4s, 8s … and sum to two minutes", () => {
    expect(BOOT_RETRY_DELAYS_MS).toEqual([2000, 4000, 8000, 16000, 32000, 58000]);
    expect(BOOT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBe(120_000);
  });

  it("connection refusals, resets, 'service temporarily unavailable', cannot_connect_now and too many connections are transient; a migration error or a bad query is not", () => {
    expect(isTransientDbError(Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), { code: "ECONNREFUSED" }))).toBe(true);
    expect(isTransientDbError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe(true);
    expect(isTransientDbError(new Error("service temporarily unavailable"))).toBe(true);
    expect(isTransientDbError(Object.assign(new Error("the database system is starting up"), { code: "57P03" }))).toBe(true);
    expect(isTransientDbError(Object.assign(new Error("sorry, too many clients already"), { code: "53300" }))).toBe(true);
    expect(isTransientDbError(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isTransientDbError(new Error("timeout expired"))).toBe(true);
    expect(isTransientDbError(Object.assign(new Error('relation "nope" does not exist'), { code: "42P01" }))).toBe(false);
    expect(isTransientDbError(Object.assign(new Error("107_x.sql: syntax error"), { name: "MigrationError" }))).toBe(false);
    expect(isTransientDbError(null)).toBe(false);
    expect(isTransientDbError("ECONNREFUSED")).toBe(false);
  });

  it("retries a transient failure with the backoff and returns the first success", async () => {
    const slept: number[] = [], logged: string[] = [];
    let calls = 0;
    const r = await withBootRetry("migrations", async () => {
      calls++;
      if (calls < 4) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      return "ok";
    }, { sleep: async (ms) => { slept.push(ms); }, log: (m) => logged.push(m) });
    expect(r).toBe("ok");
    expect(calls).toBe(4);
    expect(slept).toEqual([2000, 4000, 8000]);
    expect(logged[0]).toBe("migrations: database not reachable (ECONNREFUSED connect ECONNREFUSED) — retrying in 2s (attempt 1 of 6)");
    expect(logged[2]).toMatch(/retrying in 8s \(attempt 3 of 6\)/);
  });

  it("gives up after the last delay and rethrows the last transient error", async () => {
    const slept: number[] = [];
    let calls = 0;
    await expect(withBootRetry("migrations", async () => { calls++; throw new Error("service temporarily unavailable"); }, { sleep: async (ms) => { slept.push(ms); } }))
      .rejects.toThrow("service temporarily unavailable");
    expect(calls).toBe(7); // the first try + one per delay
    expect(slept).toEqual(BOOT_RETRY_DELAYS_MS);
  });

  it("names the code when the message is empty (node's AggregateError on a refused connect)", async () => {
    const logged: string[] = [];
    await expect(withBootRetry("migrations", async () => { throw Object.assign(new AggregateError([], ""), { code: "ECONNREFUSED" }); }, { delays: [1], sleep: async () => {}, log: (m) => logged.push(m) })).rejects.toBeInstanceOf(AggregateError);
    expect(logged).toEqual(["migrations: database not reachable (ECONNREFUSED) — retrying in 0.001s (attempt 1 of 1)"]);
  });

  it("a non-transient error is thrown at once, with no sleep", async () => {
    const slept: number[] = [];
    let calls = 0;
    const err = Object.assign(new Error("101_x.sql: column does not exist"), { name: "MigrationError" });
    await expect(withBootRetry("migrations", async () => { calls++; throw err; }, { sleep: async (ms) => { slept.push(ms); } })).rejects.toBe(err);
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
  });
});
