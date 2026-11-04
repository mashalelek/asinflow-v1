// Replacement orders (Maria 2026-11-04 — the "PO not in AF" rows). A retailer
// that replaces missing / damaged items opens a NEW order # for the
// replacement, and its shipping emails name only that number, so the
// tracking row finds no AF PO (no_po). The retailer's replacement-request
// email names both: Walmart "Original order number 2000148-69766592
// Replacement order number 2000154-98956485"; Target "replacing an item from
// your order: #102003764562536 … your replacement (order number
// #41400000169130960)". The matcher (tracking-match.ts) searches Gmail for a
// no_po row's order #, reads the original # from such an email, and — when
// exactly one of the supplier's POs has it — attaches the row to that PO
// (match_reason 'replacement') and notes it on the PO:
// "Replacement order #<id> (<date>) — <carrier> <tracking>", with a History
// row (po_edit_log), so the POs search finds the original by the
// replacement #.
import type { gmail_v1 } from "googleapis";
import { listMessageIds, getMessage } from "./gmail-client";
import { normOrder } from "./order-number";
import { logEdits } from "./po-edit";
import type { QueryLike } from "./scheduler/types";

const ID = "#?\\s*([A-Z0-9][A-Z0-9-]{4,}\\d)";
const ORIGINAL = [
  new RegExp(`original\\s+order\\s+(?:number|no\\.?|#)\\s*:?\\s*${ID}`, "i"),
  new RegExp(`replac\\w*\\s+(?:an?\\s+)?items?\\s+from\\s+your\\s+order\\s*:?\\s*${ID}`, "i"),
];
const REPLACEMENT = [
  new RegExp(`replacement\\s+order\\s+(?:number|no\\.?|#)\\s*:?\\s*${ID}`, "i"),
  new RegExp(`replacements?\\s*\\(\\s*order\\s+(?:number|no\\.?|#)\\s*:?\\s*${ID}`, "i"),
];

/** Pure: the original order # (and the replacement # when printed) a replacement email names, or null. */
export function replacementOriginalFromText(text: string): { original: string; replacement: string | null } | null {
  const t = (text ?? "").replace(/\s+/g, " ");
  const original = ORIGINAL.map((re) => re.exec(t)?.[1]).find(Boolean);
  if (!original) return null;
  const replacement = REPLACEMENT.map((re) => re.exec(t)?.[1]).find(Boolean) ?? null;
  return { original, replacement };
}

export type ReplacementLookup = (orderId: string) => Promise<{ original: string; date: Date } | null>;

/**
 * Gmail: the emails naming this order #; the first that names an original
 * order — and, when it prints a replacement #, names THIS one — wins.
 */
export function replacementLookup(gmail: gmail_v1.Gmail, deps: { list?: typeof listMessageIds; get?: typeof getMessage } = {}): ReplacementLookup {
  const list = deps.list ?? listMessageIds, get = deps.get ?? getMessage;
  const memo = new Map<string, Promise<{ original: string; date: Date } | null>>();
  return (orderId) => {
    const key = normOrder(orderId);
    if (!memo.has(key)) memo.set(key, (async () => {
      for (const id of await list(gmail, `"${orderId}"`, 20)) {
        const msg = await get(gmail, id);
        const hit = replacementOriginalFromText(`${msg.subject}\n${msg.text}`);
        if (!hit || normOrder(hit.original) === key) continue;
        if (hit.replacement && normOrder(hit.replacement) !== key) continue;
        return { original: hit.original, date: msg.date };
      }
      return null;
    })().catch(() => null));
    return memo.get(key)!;
  };
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
/** Pure: the PO note line. */
export const replacementNote = (replacementId: string, date: Date, carrier: string, tracking: string): string =>
  `Replacement order #${replacementId} (${ymd(date)}) — ${carrier} ${tracking}`;

/** Append a line to a PO's notes with a History row, as the PO editor's notes edit does; a line already there is not added twice. */
export async function appendPoNote(query: QueryLike, poId: string, line: string, userId: number | null = null): Promise<boolean> {
  const cur = (await query(`SELECT notes FROM purchase_orders WHERE id = $1`, [poId])).rows[0];
  if (!cur) return false;
  const old: string | null = cur.notes ?? null;
  if (old && old.includes(line)) return false;
  const next = old && old.trim() ? `${old.trimEnd()}\n${line}` : line;
  await query(`UPDATE purchase_orders SET notes = $2, updated_at = NOW() WHERE id = $1`, [poId, next]);
  await logEdits(query, poId, userId, "po", poId, [{ field: "notes", old, new: next }]);
  return true;
}
