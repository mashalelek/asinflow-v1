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

const LAUNCH_ARGS = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--font-render-hinting=none"];

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
    const timeout = opts.timeoutMs ?? RENDER_TIMEOUT_MS;
    // A slow or dead image host must not lose the PDF: on timeout print what loaded.
    const tolerateTimeout = (err: any) => { if (!/timeout/i.test(String(err?.message))) throw err; };
    await page.setContent(html, { waitUntil: "load", timeout }).catch(tolerateTimeout);
    await page.waitForNetworkIdle({ idleTime: 500, timeout }).catch(tolerateTimeout);
    const inspected = opts.inspect ? await opts.inspect(page) : undefined;
    const chromeRssKb = await treeRssKb(browser.process()?.pid);
    const pdf = Buffer.from(await page.pdf({ format: "Letter", printBackground: true, margin: { top: "0.4in", bottom: "0.4in", left: "0.4in", right: "0.4in" }, timeout }));
    return { pdf, ms: Date.now() - t0, inspected, chrome: await browser.version(), chromeRssKb };
  } finally {
    await browser.close().catch(() => {});
  }
}
