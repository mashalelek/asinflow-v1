import { describe, it, expect } from "vitest";
import { fmtTriggerLabel, fmtTriggerLabelShort } from "./date-presets";

// The top nav's date picker (2026-11-06): the full label from 1440 px, the compact one below so the nav fits beside it.
describe("date picker trigger labels", () => {
  it("compact: month + day when both days are in one year, else the full label", () => {
    expect(fmtTriggerLabel("2026-10-07", "2026-11-05")).toBe("Oct 7, 2026 - Nov 5, 2026");
    expect(fmtTriggerLabelShort("2026-10-07", "2026-11-05")).toBe("Oct 7 – Nov 5");
    expect(fmtTriggerLabelShort("2025-12-20", "2026-01-05")).toBe("Dec 20, 2025 - Jan 5, 2026");
  });
});
