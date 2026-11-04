import { describe, it, expect, vi, afterEach } from "vitest";
import { PROBE_HTML, schedulePdfProbeOnBoot, runPdfProbe } from "./pdf-probe";
import { pdfDeps } from "./pdf-render";

describe("pdf probe", () => {
  const launch = pdfDeps.launch;
  afterEach(() => { pdfDeps.launch = launch; delete process.env.RENDER_GIT_COMMIT; });

  it("the test page carries an inline, a remote and a dead image, and non-Latin text", () => {
    expect(PROBE_HTML).toMatch(/id="inline" src="data:image\/png;base64,/);
    expect(PROBE_HTML).toMatch(/id="remote" src="https:/);
    expect(PROBE_HTML).toMatch(/id="dead" src="https:\/\/[^"]+\.invalid\//);
    expect(PROBE_HTML).toMatch(/注文確認/);
  });

  it("does nothing on boot without a deployed commit (local dev)", () => {
    const query = vi.fn();
    schedulePdfProbeOnBoot(query as any, () => {}, 0);
    expect(query).not.toHaveBeenCalled();
  });

  it("a launch failure is a result, not a throw", async () => {
    pdfDeps.launch = async () => { throw new Error("Failed to launch the browser process"); };
    const r = await runPdfProbe();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Failed to launch/);
  });
});
