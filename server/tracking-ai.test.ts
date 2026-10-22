// PO tracking AI fallback — the ai_disabled path (SPEC §26, patch commit 9).
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { aiFallbackAvailable, AI_DISABLED_REASON } from "./tracking-ai";
import { rowsFromEmail } from "./tracking-ingest";
import { parseTrackingEmail } from "./tracking-parse";

describe("AI fallback: disabled", () => {
  it("never available — even with a key set, until it is built", () => {
    expect(aiFallbackAvailable({ ANTHROPIC_API_KEY: "sk-test" } as any)).toBe(false);
    expect(aiFallbackAvailable({} as any)).toBe(false);
  });
  it("a shipped email nothing can read is queued as unmatched / ai_disabled — no AI call", () => {
    const msg = { id: "m", threadId: null, date: new Date(), subject: "Your order #12345 has shipped", text: "Your order #12345 has shipped. Track it in your account.", fromDomain: "shop.example.com" };
    expect(rowsFromEmail(msg, parseTrackingEmail(msg))).toEqual([expect.objectContaining({ match_reason: AI_DISABLED_REASON, tracking_number: "email:shop.example.com:12345", carrier: "OTHER" })]);
  });
  it("no server module talks to an Anthropic client", () => {
    for (const f of readdirSync(__dirname).filter((x) => x.endsWith(".ts") && !x.endsWith(".test.ts"))) {
      expect(readFileSync(join(__dirname, f), "utf8")).not.toMatch(/@anthropic-ai|api\.anthropic\.com/);
    }
  });
});
