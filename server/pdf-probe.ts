// Renderer probe (patch po-documents §8 commit 0 → commit 1; Maria
// 2026-11-04): does headless Chromium run in the Render image — memory,
// fonts, inline and remote images. One render of a fixed test page. Runs
// once per deployed commit, 60 s after boot (production only), and on
// demand from GET /api/admin/pdf-probe; the last result is the setting
// `pdf.render_probe`, readable with --prod.
import express, { type Router, type Request, type Response } from "express";
import { execFile } from "child_process";
import os from "os";
import { requireRole } from "./auth";
import { renderHtmlToPdf } from "./pdf-render";
import type { QueryLike } from "./scheduler/types";

export const PROBE_KEY = "pdf.render_probe";

// 1×1 red PNG — stands in for an email's cid: image, which the ingest inlines as a data: URI.
const INLINE_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const REMOTE_IMG = "https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png";
const DEAD_IMG = "https://asinflow-probe.invalid/missing.png";

export const PROBE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial,Helvetica,sans-serif}</style></head><body>
<h1>AsinFlow PDF probe</h1>
<p id="latin">Order 200015415094735 — Total $1,234.56 · café crème · Größe</p>
<p id="cjk">注文確認 订单确认 주문 확인</p>
<p id="emoji">📦 ✅</p>
<img id="inline" src="${INLINE_PNG}" width="40" height="40">
<img id="remote" src="${REMOTE_IMG}">
<img id="dead" src="${DEAD_IMG}">
<table border="1"><tr><th>Item</th><th>Qty</th></tr><tr><td>Probe item</td><td>2</td></tr></table>
</body></html>`;

const fontFamilies = (): Promise<number | null> => new Promise((resolve) => {
  execFile("fc-list", [":", "family"], { timeout: 5000 }, (err, out) => resolve(err ? null : new Set(out.split("\n").filter(Boolean)).size));
});

export interface ProbeResult {
  ok: boolean; at: string; commit: string | null; error?: string;
  bytes?: number; ms?: number; chrome?: string; chrome_rss_mb?: number | null; node_rss_mb?: number;
  host_mem_total_mb?: number; host_mem_free_mb?: number; font_families?: number | null;
  images?: { inline: boolean; remote: boolean; dead_blank: boolean };
  /** Rendered width (px) of each line: a missing font falls back to tofu, so 0 means nothing drew. */
  text_widths?: Record<string, number>;
}

export async function runPdfProbe(): Promise<ProbeResult> {
  const base = { at: new Date().toISOString(), commit: (process.env.RENDER_GIT_COMMIT ?? "").slice(0, 7) || null };
  try {
    const r = await renderHtmlToPdf(PROBE_HTML, {
      javaScript: true,
      // A string, not a function: tsx / esbuild's keepNames wraps functions in __name(), which the page does not have.
      inspect: (page) => page.evaluate(`(() => {
        const img = (id) => document.getElementById(id)?.naturalWidth ?? 0;
        const span = (id) => { const el = document.getElementById(id); const s = document.createElement("span"); s.textContent = el.textContent; el.replaceChildren(s); return Math.round(s.getBoundingClientRect().width); };
        return { images: { inline: img("inline") > 0, remote: img("remote") > 0, dead_blank: img("dead") === 0 }, text_widths: { latin: span("latin"), cjk: span("cjk"), emoji: span("emoji") } };
      })()`),
    });
    const i = r.inspected as { images: ProbeResult["images"]; text_widths: Record<string, number> };
    return {
      ...base, ok: r.pdf.length > 1000 && r.pdf.subarray(0, 5).toString() === "%PDF-",
      bytes: r.pdf.length, ms: r.ms, chrome: r.chrome, chrome_rss_mb: r.chromeRssKb == null ? null : Math.round(r.chromeRssKb / 1024),
      node_rss_mb: Math.round(process.memoryUsage().rss / 1048576),
      host_mem_total_mb: Math.round(os.totalmem() / 1048576), host_mem_free_mb: Math.round(os.freemem() / 1048576),
      font_families: await fontFamilies(), images: i.images, text_widths: i.text_widths,
    };
  } catch (err: any) {
    return { ...base, ok: false, error: String(err?.message ?? err).slice(0, 500) };
  }
}

async function store(query: QueryLike, r: ProbeResult): Promise<void> {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [PROBE_KEY, JSON.stringify(r)],
  );
}

/** Production boot: probe once per deployed commit, after the server settles. */
export function schedulePdfProbeOnBoot(query: QueryLike, log: (m: string) => void, delayMs = 60_000): void {
  const commit = (process.env.RENDER_GIT_COMMIT ?? "").slice(0, 7);
  if (!commit) return;
  setTimeout(async () => {
    try {
      const prev = (await query(`SELECT value FROM settings WHERE key = $1`, [PROBE_KEY])).rows[0]?.value;
      if (prev?.commit === commit) return;
      const r = await runPdfProbe();
      await store(query, r);
      log(`pdf probe ${r.ok ? "ok" : "FAILED"}: ${r.ok ? `${r.bytes} bytes, ${r.ms} ms, chrome ${r.chrome_rss_mb ?? "?"} MB` : r.error}`);
    } catch (err: any) { log(`pdf probe error: ${err?.message ?? err}`); }
  }, delayMs).unref();
}

export function createPdfProbeRouter(query: QueryLike): Router {
  const router = express.Router();
  router.get("/api/admin/pdf-probe", requireRole("admin"), async (_req: Request, res: Response) => {
    const r = await runPdfProbe();
    await store(query, r);
    res.status(r.ok ? 200 : 500).json(r);
  });
  return router;
}
