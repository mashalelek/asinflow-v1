import { describe, it, expect } from "vitest";
import { isSubmissionPending, submissionFailureReason } from "./results-table";
import type { AsinResult } from "@shared/schema";

// §18 two-part definition (2026-09-21): the icon means "submitted (pending)"
// OR "listed (confirmed)", and the §19 ledger row is the ONLY thing that
// distinguishes them.
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

  it("'failed'/'deleted' are not pending (the flag reverts; icon returns to +)", () => {
    expect(isSubmissionPending(withStatus("failed"))).toBe(false);
    expect(isSubmissionPending(withStatus("deleted"))).toBe(false);
  });

  it("an ASIN with no submission at all is confirmed-by-probe, not pending", () => {
    // has_live_offer TRUE with no ledger row = discovered by a probe.
    expect(isSubmissionPending(withStatus(null))).toBe(false);
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
