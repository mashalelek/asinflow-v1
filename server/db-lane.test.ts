import { describe, it, expect } from "vitest";
import { currentDbLane, runInDbLane } from "./db-lane";

describe("db lane (which pool a query uses)", () => {
  it("is web outside any lane, job inside runInDbLane('job') — through awaits and nested calls — and web again after", async () => {
    expect(currentDbLane()).toBe("web");
    const seen: string[] = [];
    const inner = async () => { await new Promise((r) => setTimeout(r, 1)); seen.push(currentDbLane()); };
    await runInDbLane("job", async () => {
      seen.push(currentDbLane());
      await inner();
      await Promise.all([inner(), inner()]);
    });
    expect(seen).toEqual(["job", "job", "job", "job"]);
    expect(currentDbLane()).toBe("web");
  });

  it("a concurrent web call is not caught in a running job's lane", async () => {
    let fromJob = "", fromWeb = "";
    const job = runInDbLane("job", async () => { await new Promise((r) => setTimeout(r, 5)); fromJob = currentDbLane(); });
    const web = (async () => { await new Promise((r) => setTimeout(r, 1)); fromWeb = currentDbLane(); })();
    await Promise.all([job, web]);
    expect(fromJob).toBe("job");
    expect(fromWeb).toBe("web");
  });

  it("returns the function's value and propagates its error", async () => {
    expect(await runInDbLane("job", async () => 42)).toBe(42);
    await expect(runInDbLane("job", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  });
});
