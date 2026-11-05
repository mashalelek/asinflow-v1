import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile } from "fs/promises";
import { execFileSync } from "child_process";
import { existsSync } from "fs";

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times
const allowlist = [
  "@google/generative-ai",
  "axios",
  "connect-pg-simple",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "express-session",
  "jsonwebtoken",
  "memorystore",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "passport",
  "passport-local",
  "pg",
  "stripe",
  "uuid",
  "ws",
  "xlsx",
  "zod",
  "zod-validation-error",
];

// PO documents (SPEC §22): the renderer's Chrome lives in .cache/puppeteer
// inside the project (.puppeteerrc.cjs). Render restores node_modules from
// its build cache, so puppeteer's postinstall (the download) does not run
// again on a later deploy, while the checkout's .cache starts empty: every
// render failed with "Could not find Chrome" from 2026-11-04 (component 29).
// The build runs the same install script itself (a no-op when the browser
// is there) and fails when Chrome is still missing — the deploy then stays
// on the previous instance instead of shipping a server that cannot render.
async function ensureChrome() {
  console.log("installing the PDF renderer's Chrome (puppeteer)...");
  execFileSync(process.execPath, ["node_modules/puppeteer/install.mjs"], { stdio: "inherit" });
  const { default: puppeteer } = await import("puppeteer");
  const exe = await puppeteer.executablePath();
  if (!existsSync(exe)) throw new Error(`puppeteer's Chrome is missing after install: ${exe}`);
  console.log(`Chrome: ${exe}`);
}

async function buildAll() {
  await rm("dist", { recursive: true, force: true });
  await ensureChrome();

  console.log("building client...");
  await viteBuild();

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
