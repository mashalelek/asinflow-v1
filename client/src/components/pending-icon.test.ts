import { describe, it, expect } from "vitest";
import { isSubmissionPending, submissionFailureReason, offerCheckedAge } from "./results-table";
import type { AsinResult } from "@shared/schema";

// §6 Catalog icon — three states, two sources (2026-10-10). Pendingness
// comes from the §19 LEDGER, liveness from has_live_offer. Precedence is
// Pending > Listed > Not listed, and pending is evaluated FIRST regardless
// of the flag: with ACCEPTED-at-submit no longer writing TRUE, a freshly
// submitted ASIN is pending while the flag is still FALSE or NULL.
const withStatus = (status: string | null, issues: any[] = []): AsinResult => ({
  asin: "B0PEND0001",
  submission: status == null ? null : { latest: { sku: "S", status, submittedAt: "2026-09-21T00:00:00Z", verifiedAt: null, issues, reviewFlags: [], terminalConflict: false, acknowledged: false }, history: [] },
} as any);

describe("pending vs confirmed", () => {
  it("unresolved ledger states render pending", () => {
    for (const s of ["pending", "processing", "stale"]) {
      expect(isSubmissionPending(withStatus(s)), s).toBe(true);
    }
  });

  it("'live' is confirmed — solid icon", () => {
    expect(isSubmissionPending(withStatus("live"))).toBe(false);
  });

  it("'failed'/'deleted' are not pending (resolved — icon falls through to the flag)", () => {
    expect(isSubmissionPending(withStatus("failed"))).toBe(false);
    expect(isSubmissionPending(withStatus("deleted"))).toBe(false);
  });

  it("an ASIN with no submission at all is never pending", () => {
    // Its icon is decided by the flag alone — TRUE = found by a probe.
    expect(isSubmissionPending(withStatus(null))).toBe(false);
  });

  it("'stale' MUST stay pending — the Add-to-SC guard uses the same three", () => {
    // Server-side NON_TERMINAL and countOpenAmong both gate on
    // ('pending','processing','stale'), and home.tsx builds its disable set
    // from THIS predicate. An icon that disagreed with the guard about
    // whether a submit is in flight is exactly the inconsistency the
    // two-source split exists to prevent.
    expect(isSubmissionPending(withStatus("stale"))).toBe(true);
  });
});

describe("precedence: pending outranks the flag, in both directions", () => {
  const withBoth = (status: string | null, hasLiveOffer: boolean | null): AsinResult =>
    ({ ...withStatus(status), hasLiveOffer } as any);

  it("pending wins over a FALSE flag — the post-submit case", () => {
    // ACCEPTED writes nothing now, so this is the normal state seconds after
    // Add to SC. Nesting pending inside `hasLiveOffer === true` (the old
    // structure) would render this as "+", i.e. never-submitted.
    const r = withBoth("pending", false);
    expect(isSubmissionPending(r)).toBe(true);
    expect(r.hasLiveOffer).toBe(false);
  });

  it("pending wins over a NULL flag — never-probed and just submitted", () => {
    expect(isSubmissionPending(withBoth("processing", null))).toBe(true);
  });

  it("pending wins over a TRUE flag — a second submit on a listed ASIN", () => {
    expect(isSubmissionPending(withBoth("pending", true))).toBe(true);
  });

  it("a resolved ledger row defers to the flag entirely", () => {
    expect(isSubmissionPending(withBoth("live", true))).toBe(false);
    expect(isSubmissionPending(withBoth("failed", false))).toBe(false);
  });
});

describe("offerCheckedAge — shown in the Listed tooltip, never acted on", () => {
  const at = (iso: string | null) => ({ offerCheckedAt: iso } as any as AsinResult);
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  it("null when never checked", () => {
    expect(offerCheckedAge(at(null))).toBeNull();
    expect(offerCheckedAge({} as any)).toBeNull();
  });

  it("minutes, hours, days", () => {
    expect(offerCheckedAge(at(ago(5 * 60_000)))).toBe("5m ago");
    expect(offerCheckedAge(at(ago(3 * 3_600_000)))).toBe("3h ago");
    expect(offerCheckedAge(at(ago(2 * 86_400_000)))).toBe("2d ago");
  });

  it("'just now' under a minute", () => {
    expect(offerCheckedAge(at(ago(10_000)))).toBe("just now");
  });

  it("null rather than nonsense on a bad or future timestamp", () => {
    expect(offerCheckedAge(at("not-a-date"))).toBeNull();
    expect(offerCheckedAge(at(new Date(Date.now() + 60_000).toISOString()))).toBeNull();
  });
});

describe("failure reason surfaces in the '+' tooltip", () => {
  it("names the issue so '+' doesn't read like 'never touched'", () => {
    const r = withStatus("failed", [{ code: "5886", message: "Restricted generic" }]);
    expect(submissionFailureReason(r)).toBe("Submission failed: Restricted generic — Add to SC to retry");
  });

  it("falls back to the code, then to a bare message", () => {
    expect(submissionFailureReason(withStatus("failed", [{ code: "13013" }]))).toContain("13013");
    expect(submissionFailureReason(withStatus("failed"))).toBe("Submission failed — Add to SC to retry");
  });

  it("is null for every non-failed state (normal tooltip wins)", () => {
    for (const s of ["pending", "processing", "live", "deleted", "stale"]) {
      expect(submissionFailureReason(withStatus(s)), s).toBeNull();
    }
  });
});
