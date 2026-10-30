// Upload to Velocity — the date-change race (2026-10-30): typing a date fired
// a plan request per complete value (10/4 → 1/4/2026 on the way to
// 11/4/2026) and whichever answer landed last won, emptying the list or
// resetting the ticks. Date edits are debounced and only the newest request
// may update the dialog.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const d = readFileSync(join(__dirname, "upload-to-velocity-dialog.tsx"), "utf8");
const fetchReview = d.slice(d.indexOf("const fetchReview = useCallback("), d.indexOf("const scheduleReview = useCallback("));
const scheduleReview = d.slice(d.indexOf("const scheduleReview = useCallback("), d.indexOf("useEffect(() => {\n    if (open) fetchReview"));

describe("date inputs are debounced", () => {
  it("both inputs go through scheduleReview; neither fetches directly", () => {
    expect(d.match(/onChange=\{\(e\) => \{ set(From|To)Ymd\(e\.target\.value\); scheduleReview\(/g)).toHaveLength(2);
    expect(d).not.toMatch(/onChange=\{[^}]*fetchReview\(/);
  });
  it("scheduleReview clears the pending timer and fetches after DATE_DEBOUNCE_MS, only for complete dates", () => {
    expect(d).toMatch(/export const DATE_DEBOUNCE_MS = 400;/);
    expect(scheduleReview).toMatch(/if \(dateTimer\.current\) clearTimeout\(dateTimer\.current\);/);
    expect(scheduleReview).toMatch(/if \(!isCompleteYmd\(fYmd\) \|\| !isCompleteYmd\(tYmd\)\)/);
    expect(scheduleReview).toMatch(/setTimeout\(\(\) => \{[^}]*fetchReview\(fYmd, tYmd\); \}, DATE_DEBOUNCE_MS\)/);
  });
});

describe("only the newest plan request updates the dialog", () => {
  it("each request takes a new seq and aborts the previous one", () => {
    expect(fetchReview).toMatch(/const seq = \+\+reqSeq\.current;\s*reqAbort\.current\?\.abort\(\);/);
    expect(fetchReview).toMatch(/\{ signal: ctrl\.signal \}/);
  });
  it("a superseded response touches nothing: checked before data, error and loading", () => {
    const parsed = fetchReview.indexOf("await res.json()");
    const guard = fetchReview.indexOf("if (seq !== reqSeq.current) return;");
    expect(guard).toBeGreaterThan(parsed);
    expect(guard).toBeLessThan(fetchReview.indexOf("setData(body"));
    expect(guard).toBeLessThan(fetchReview.indexOf("setSelCreates("));
    expect(fetchReview).toMatch(/catch \(e: any\) \{\s*if \(seq !== reqSeq\.current\) return;/);
    expect(fetchReview).toMatch(/finally \{\s*if \(seq === reqSeq\.current\) setLoading\(false\);/);
  });
  it("a date edit invalidates the in-flight request at once; closing the dialog does too", () => {
    expect(scheduleReview).toMatch(/reqSeq\.current\+\+;\s*reqAbort\.current\?\.abort\(\);/);
    const close = d.slice(d.indexOf("if (open) fetchReview(fromYmd, toYmd);"), d.indexOf("}, [open]);"));
    expect(close).toMatch(/return \(\) => \{[\s\S]*clearTimeout\(dateTimer\.current\)[\s\S]*reqSeq\.current\+\+;[\s\S]*reqAbort\.current\?\.abort\(\);/);
  });
});
