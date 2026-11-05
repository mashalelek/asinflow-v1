// Kept capture samples (capture_page_samples, migration 092) scrubbed again with the current scrub.js — the text and
// the fields (rescrubFields: the label rules, and on a page with a card field the payment-form rule). 2026-11-05:
// Gordon's payment page was kept with its security code (SECNO_NEW) and expiry month before the scrubber knew them.
// Dry run by default: each change is listed with the old value masked; --live writes them.
//   npm run capture:rescrub [-- --prod] [--live]
import "./env";
import { Pool } from "pg";
import "../chrome-extension/core/scrub.js";

type Field = { label: string; value: string };
const S = (globalThis as unknown as { AfScrub: typeof import("../chrome-extension/core/scrub.js") }).AfScrub;
const live = process.argv.includes("--live");
const mask = (v: string) => v.replace(/[0-9]/g, "•").replace(/[A-Za-z]/g, "x");

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /render\.com/.test(process.env.DATABASE_URL ?? "") ? { rejectUnauthorized: false } : undefined });
  try {
    const rows = (await pool.query(`SELECT id, retailer, step, title, created_at, text, fields FROM capture_page_samples ORDER BY created_at`)).rows;
    let changed = 0;
    for (const r of rows) {
      const before: Field[] = Array.isArray(r.fields) ? r.fields : [];
      const after = S.rescrubFields(before), text = S.scrubText(r.text);
      const lines: string[] = [];
      before.forEach((f) => {
        const a = after.find((x) => x.label === f.label && (x.value === f.value || x.value === "" || x.value.startsWith("••••")));
        if (!a) lines.push(`  field "${f.label}": ${mask(f.value)} → removed`);
        else if (a.value !== f.value) lines.push(`  field "${f.label}": ${mask(f.value)} → ${a.value ? a.value : "(empty)"}`);
      });
      if (text !== r.text) lines.push(`  text: ${r.text.length} → ${text.length} chars`);
      if (!lines.length) continue;
      changed++;
      console.log(`${r.retailer} · ${r.title} (${r.step}) · kept ${new Date(r.created_at).toISOString().slice(0, 16)}`);
      lines.forEach((l) => console.log(l));
      if (live) await pool.query(`UPDATE capture_page_samples SET fields = $2::jsonb, text = $3 WHERE id = $1`, [r.id, JSON.stringify(after), text]);
    }
    console.log(`${rows.length} sample(s), ${changed} to change — ${live ? "WRITTEN" : "DRY RUN, nothing written (--live writes)"}`);
  } finally { await pool.end(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
