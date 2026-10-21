// Release confirmation (Maria 2026-10-21): nothing is queued until confirmed.
import { describe, it, expect, vi } from "vitest";
import { createReleaseFlow, releasePromptText } from "./release-flow";
import { readFileSync } from "fs";
import { join } from "path";

describe("release flow", () => {
  it("request() opens the prompt and queues NOTHING; confirm() is the only call", async () => {
    const release = vi.fn(async () => ({ job: { id: 9 }, held: 162 }));
    const f = createReleaseFlow(release);
    const p = f.request(123, "delete", 162);
    expect(p.text).toBe("Delete 162 listings in Seller Central? Each is re-checked live first.");
    expect(release).not.toHaveBeenCalled();
    await f.confirm();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(123, "delete");
  });
  it("cancel() queues nothing; confirm without a request throws; a second confirm (double click) does not queue twice", async () => {
    const release = vi.fn(async () => "ok");
    const f = createReleaseFlow(release);
    f.request(1, "close", 30);
    f.cancel();
    await expect(f.confirm()).rejects.toThrow(/no release to confirm/);
    f.request(1, "close", 30);
    const a = f.confirm();
    await expect(f.confirm()).rejects.toThrow(/no release to confirm/);
    await a;
    expect(release).toHaveBeenCalledTimes(1);
  });
  it("wording for closes and deletes", () => {
    expect(releasePromptText("close", 30)).toBe("Close 30 listings in Seller Central? Each is re-checked live first.");
    expect(releasePromptText("delete", 1)).toBe("Delete 1 listing in Seller Central? Each is re-checked live first.");
  });
  it("no component calls releaseHeld directly — every Release goes through the confirm", () => {
    const dir = join(__dirname, "..", "components");
    for (const f of ["listing-hygiene-panel.tsx", "jobs-dialog.tsx"]) {
      expect(readFileSync(join(dir, f), "utf8")).not.toMatch(/releaseHeld\(/);
    }
    expect(readFileSync(join(dir, "release-confirm.tsx"), "utf8")).toMatch(/createReleaseFlow\(/);
  });
});
