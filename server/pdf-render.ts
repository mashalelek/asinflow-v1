// Email HTML → PDF with headless Chromium (SPEC §22 "PO documents", patch
// po-documents §5). One browser per render, closed after — the passes render
// a handful of emails a day, and a long-lived Chrome would hold ~150 MB on
// a 2 GB instance for nothing. Page scripts are off (an email never needs
// them); remote images load until the network goes quiet or the timeout,
// and a failed one renders blank — it never blocks the PDF.
//
// Dependency-free of ./index (it boots Express): scripts import this.
import type { Browser } from "puppeteer";

export const RENDER_TIMEOUT_MS = 20_000;
const PRINT_WIDTH_PX = 739;

// --disable-web-security: the downscale below draws remote images onto a canvas, which a cross-origin image
// would otherwise taint. Safe here: a throwaway browser with no cookies or sessions, page scripts off.
const LAUNCH_ARGS = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--font-render-hinting=none", "--disable-web-security"];

/**
 * Chrome embeds an image in the PDF at its full resolution, re-encoded
 * losslessly when the format is not PDF-native (AVIF / WebP): a Walmart
 * confirmation with 3000×3000 product photos shown at 135 px printed at
 * 15.7 MB (2026-11-04). Every image larger than twice its printed size is
 * redrawn at 2× (JPEG on white) before printing.
 * A string, not a function: tsx / esbuild's keepNames wraps functions in
 * __name(), which the page does not have.
 */
export const DOWNSCALE_IMAGES = `(async () => {
  let n = 0;
  for (const img of Array.from(document.images)) {
    const r = img.getBoundingClientRect();
    if (!img.complete || !img.naturalWidth || r.width < 1) continue;
    // The image's own aspect ratio, at twice the larger of the box's two scales (object-fit keeps working).
    const k = Math.max((r.width * 2) / img.naturalWidth, (r.height * 2) / img.naturalHeight);
    if (k >= 0.8) continue;
    const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
    try {
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h);
      img.removeAttribute("srcset");
      img.style.width = r.width + "px"; img.style.height = r.height + "px";
      img.src = c.toDataURL("image/jpeg", 0.85);
      await img.decode().catch(() => {});
      n++;
    } catch (e) {}
  }
  return n;
})()`;

/** Test seam: the launcher (the tests never start Chrome). */
export const pdfDeps = {
  launch: async (): Promise<Browser> => {
    const puppeteer = (await import("puppeteer")).default;
    return puppeteer.launch({ headless: true, args: LAUNCH_ARGS });
  },
};

export interface RenderOptions {
  /** Page scripts — off for emails; the probe turns them on to measure the page. */
  javaScript?: boolean;
  timeoutMs?: number;
  /** Runs against the loaded page before printing (the probe's measurements). */
  inspect?: (page: import("puppeteer").Page) => Promise<unknown>;
}

export interface RenderResult { pdf: Buffer; ms: number; inspected?: unknown; chrome: string; chromeRssKb: number | null }

/** Sum of VmRSS over the browser's process tree (Linux /proc); null elsewhere. */
async function treeRssKb(rootPid: number | undefined): Promise<number | null> {
  if (!rootPid || process.platform !== "linux") return null;
  const { readdir, readFile } = await import("fs/promises");
  const procs: Array<{ pid: number; ppid: number; rss: number }> = [];
  for (const d of await readdir("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const s = await readFile(`/proc/${d}/status`, "utf8");
      const ppid = Number(/^PPid:\s+(\d+)/m.exec(s)?.[1] ?? 0), rss = Number(/^VmRSS:\s+(\d+)/m.exec(s)?.[1] ?? 0);
      procs.push({ pid: Number(d), ppid, rss });
    } catch { /* gone */ }
  }
  const tree = new Set([rootPid]);
  for (let grew = true; grew;) { grew = false; for (const p of procs) if (!tree.has(p.pid) && tree.has(p.ppid)) { tree.add(p.pid); grew = true; } }
  return procs.filter((p) => tree.has(p.pid)).reduce((s, p) => s + p.rss, 0);
}

export async function renderHtmlToPdf(html: string, opts: RenderOptions = {}): Promise<RenderResult> {
  const t0 = Date.now();
  const browser = await pdfDeps.launch();
  try {
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(!!opts.javaScript);
    // Lay the page out as it prints (Letter less the margins, 7.7 in at 96 px/in), so the downscale measures printed sizes.
    await page.setViewport({ width: PRINT_WIDTH_PX, height: 1000 });
    await page.emulateMediaType("print");
    const timeout = opts.timeoutMs ?? RENDER_TIMEOUT_MS;
    // A slow or dead image host must not lose the PDF: on timeout print what loaded.
    const tolerateTimeout = (err: any) => { if (!/timeout/i.test(String(err?.message))) throw err; };
    await page.setContent(html, { waitUntil: "load", timeout }).catch(tolerateTimeout);
    await page.waitForNetworkIdle({ idleTime: 500, timeout }).catch(tolerateTimeout);
    const inspected = opts.inspect ? await opts.inspect(page) : undefined;
    await page.evaluate(DOWNSCALE_IMAGES).catch(() => 0);
    const chromeRssKb = await treeRssKb(browser.process()?.pid);
    const pdf = Buffer.from(await page.pdf({ format: "Letter", printBackground: true, margin: { top: "0.4in", bottom: "0.4in", left: "0.4in", right: "0.4in" }, timeout }));
    return { pdf, ms: Date.now() - t0, inspected, chrome: await browser.version(), chromeRssKb };
  } finally {
    await browser.close().catch(() => {});
  }
}
