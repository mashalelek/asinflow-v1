// Merge one payment method into another (Maria 2026-11-08: "Chase (7927)" and "Chase Ink (7927)" are the same card).
// Relabels every reference — po_payments.nickname, po_line_refunds.nickname, the PO's payment_method text — with a History
// row per PO, and takes the old name out of the settings: po_payment_methods, po_payment_method_last4 (so last 4 7927 is one
// card and resolves without "Two cards end in 7927"), po_payment_method_reward_pct; aliases that pointed at it point at the
// survivor, and the old name becomes an alias of it. Refuses when the two differ in last 4 or default reward %, or when their
// payment rows carry different reward % / gift-card % values (shown, nothing written).
//   tsx script/merge-payment-method.ts --from "Chase Ink (7927)" --to "Chase (7927)" [--prod] [--live]
// Dry run by default. `--prod` reads .env.production.local (script/env.ts).
import "./env";
import { Pool } from "pg";
import { logEdits } from "../server/po-edit";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const live = process.argv.includes("--live");
const from = arg("--from"), to = arg("--to");
if (!from || !to || from === to) { console.error('usage: --from "<old name>" --to "<surviving name>" [--prod] [--live]'); process.exit(1); }
const FIELD = `payment method merge (${from} → ${to})`;
// Rows the sheet backfill parsed keep the short form: nickname "Chase Ink" with last4 "7927" — matched too, and relabelled
// to the survivor's short form ("Chase"). raw_text, the verbatim source text, is left as it was.
const split = (name: string) => { const m = /^(.*\S)\s*\((\d{4})\)$/.exec(name); return m ? { base: m[1], last4: m[2] } : null; };
const fromS = split(from), toS = split(to);

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /render\.com/.test(process.env.DATABASE_URL ?? "") ? { rejectUnauthorized: false } : undefined });
  const client = await pool.connect();
  const query = (sql: string, params?: any[]) => client.query(sql, params);
  try {
    await query("BEGIN");
    const settings = Object.fromEntries((await query(`SELECT key, value FROM settings WHERE key = ANY($1::text[])`, [["po_payment_methods", "po_payment_method_aliases", "po_payment_method_last4", "po_payment_method_reward_pct"]])).rows.map((r: any) => [r.key, r.value]));
    const methods: string[] = Array.isArray(settings.po_payment_methods) ? settings.po_payment_methods : [];
    const aliases: Record<string, string> = settings.po_payment_method_aliases ?? {};
    const last4: Record<string, string> = settings.po_payment_method_last4 ?? {};
    const reward: Record<string, number | string> = settings.po_payment_method_reward_pct ?? {};
    const report = async (name: string) => ({
      name,
      in_method_list: methods.indexOf(name),
      last4: last4[name] ?? null,
      default_reward_pct: reward[name] ?? null,
      aliases_to_it: Object.entries(aliases).filter(([, v]) => v === name).map(([k]) => k),
      po_payments: (await query(`SELECT nickname, method, last4, reward_pct::text AS reward_pct, gift_card_discount_pct::text AS gc_pct, count(*)::int AS n, count(DISTINCT po_id)::int AS pos FROM po_payments WHERE nickname = $1 OR (nickname = $2 AND last4 = $3) GROUP BY 1,2,3,4,5 ORDER BY n DESC`, [name, split(name)?.base ?? null, split(name)?.last4 ?? null])).rows,
      po_line_refunds: (await query(`SELECT count(*)::int AS n FROM po_line_refunds WHERE nickname = $1`, [name])).rows[0].n,
      po_payment_method_text: (await query(`SELECT count(*)::int AS n FROM purchase_orders WHERE strpos(payment_method, $1) > 0`, [name])).rows[0].n,
    });
    const a = await report(from), b = await report(to);
    console.log(JSON.stringify({ mode: live ? "LIVE" : "dry run", from: a, to: b }, null, 1));
    // Differences that stop the merge: the settings, and the per-row reward % / gift-card % values.
    const diffs: string[] = [];
    if (a.last4 != null && b.last4 != null && String(a.last4) !== String(b.last4)) diffs.push(`last 4: ${a.last4} vs ${b.last4}`);
    if (a.default_reward_pct != null && Number(a.default_reward_pct) !== Number(b.default_reward_pct ?? NaN)) diffs.push(`default reward %: ${a.default_reward_pct} vs ${b.default_reward_pct}`);
    const rowVals = (r: typeof a) => new Set(r.po_payments.filter((x: any) => x.method === "card").map((x: any) => `${x.method}|${x.last4}|${x.reward_pct}|${x.gc_pct}`));
    const extra = Array.from(rowVals(a)).filter((v) => !rowVals(b).has(v));
    if (extra.length && b.po_payments.length) diffs.push(`payment rows under ${from} carry values none under ${to} do (method|last4|reward %|GC %): ${extra.join("; ")}`);
    if (diffs.length) { console.log(`STOP — the two differ:\n  ${diffs.join("\n  ")}`); await query("ROLLBACK"); process.exitCode = 2; return; }
    console.log("No differences in last 4, default reward % or payment-row values.");
    if (!live) { console.log("dry run — nothing written; add --live to write"); await query("ROLLBACK"); return; }

    const pays = (await query(`UPDATE po_payments SET nickname = $2 WHERE nickname = $1 RETURNING id, po_id`, [from, to])).rows;
    for (const r of pays) await logEdits(query, String(r.po_id), null, "po", String(r.po_id), [{ field: FIELD, old: from, new: to }]);
    if (fromS && toS && fromS.last4 === toS.last4) {
      const short = (await query(`UPDATE po_payments SET nickname = $2 WHERE nickname = $1 AND last4 = $3 RETURNING id, po_id`, [fromS.base, toS.base, fromS.last4])).rows;
      for (const r of short) await logEdits(query, String(r.po_id), null, "po", String(r.po_id), [{ field: FIELD, old: `${fromS.base} (${fromS.last4})`, new: `${toS.base} (${toS.last4})` }]);
      pays.push(...short);
    }
    const refs = (await query(`UPDATE po_line_refunds SET nickname = $2 WHERE nickname = $1 RETURNING id, po_id`, [from, to])).rows;
    for (const r of refs) await logEdits(query, String(r.po_id), null, "po", String(r.po_id), [{ field: `${FIELD}, refund`, old: from, new: to }]);
    const texts = (await query(`SELECT id, payment_method FROM purchase_orders WHERE strpos(payment_method, $1) > 0`, [from])).rows;
    for (const r of texts) {
      const next = String(r.payment_method).split(from).join(to);
      await query(`UPDATE purchase_orders SET payment_method = $2 WHERE id = $1`, [r.id, next]);
      await logEdits(query, String(r.id), null, "po", String(r.id), [{ field: "payment_method", old: r.payment_method, new: next }]);
    }
    const nextMethods = methods.filter((m) => m !== from);
    if (!nextMethods.includes(to)) nextMethods.push(to);
    const nextAliases = Object.fromEntries(Object.entries(aliases).map(([k, v]) => [k, v === from ? to : v]));
    nextAliases[from] = to;
    const nextLast4 = { ...last4 }; delete nextLast4[from];
    if (nextLast4[to] == null && last4[from] != null) nextLast4[to] = last4[from];
    const nextReward = { ...reward }; delete nextReward[from];
    if (nextReward[to] == null && reward[from] != null) nextReward[to] = reward[from];
    for (const [k, v] of [["po_payment_methods", nextMethods], ["po_payment_method_aliases", nextAliases], ["po_payment_method_last4", nextLast4], ["po_payment_method_reward_pct", nextReward]] as const)
      await query(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, JSON.stringify(v)]);
    await query("COMMIT");
    console.log(`committed: ${pays.length} payment rows, ${refs.length} refund rows, ${texts.length} PO payment texts relabelled; "${from}" out of the method list, last 4 and reward % maps; alias "${from}" → "${to}"`);
    const left = await report(from);
    console.log(`now under "${from}": ${left.po_payments.length} payment groups, ${left.po_line_refunds} refunds, ${left.po_payment_method_text} PO texts`);
  } catch (e) { await query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); await pool.end(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
