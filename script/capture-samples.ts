// Capture page samples (migration 092): list the pages kept because Products or Totals stayed empty after every
// layer, and write one as a fixture. Read-only on the database.
//   npm run capture:samples [-- --prod]                       list
//   npm run capture:samples -- [--prod] --save <id> [--name x] write server/__fixtures__/capture-pages/samples/<host>-<step>-<id>.txt
import "./env";
import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { SAMPLE_LIST_SQL, sampleAsFixture } from "../server/capture-samples";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /render\.com/.test(process.env.DATABASE_URL ?? "") ? { rejectUnauthorized: false } : undefined });
  try {
    const id = arg("--save");
    if (!id) {
      const rows = (await pool.query(SAMPLE_LIST_SQL)).rows;
      console.log(`${rows.length} sample(s), last 30 days`);
      for (const r of rows) console.log(`${r.id}\t${new Date(r.created_at).toISOString().slice(0, 16)}\t${r.retailer}\t${r.step}\tmissing ${r.missing.join(", ")}\t${r.chars} chars\t${r.url}`);
      return;
    }
    const s = (await pool.query(`SELECT * FROM capture_page_samples WHERE id = $1`, [Number(id)])).rows[0];
    if (!s) throw new Error(`no sample ${id}`);
    const dir = path.resolve("server/__fixtures__/capture-pages/samples");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${arg("--name") ?? `${String(s.retailer).replace(/^www\./, "").replace(/[^a-z0-9.-]/gi, "_")}-${s.step ?? "other"}-${s.id}`}.txt`);
    fs.writeFileSync(file, sampleAsFixture(s));
    console.log(`wrote ${path.relative(process.cwd(), file)} — check it for anything personal before committing`);
  } finally { await pool.end(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
