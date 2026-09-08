// §21 lead-date helpers (2026-09-08) — PURE module, deliberately free of
// any ./index import: server/index.ts boots Express on import, which killed
// the backfill script with EADDRINUSE mid-apply on first run. Everything
// here is side-effect-free; bulk-lists.ts re-exports for its callers.

// §21 Date Added backdate (2026-09-04): M/D/YYYY parses as LOCAL midnight
// (the server runs in America/New_York — never UTC midnight, so 09/02/2026
// renders 09/02/2026); ISO strings (what Export CSV emits for Date Added)
// parse natively, so export → re-upload round-trips. Unparseable/absent →
// null, caller falls back to NOW() — a bad date never fails the row.
export function parseAddedAt(raw: string | null | undefined): Date | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (mdy) {
    const m = Number(mdy[1]), day = Number(mdy[2]), y = Number(mdy[3]);
    const d = new Date(y, m - 1, day);
    // JS Date rolls invalid components over (13/45 → Feb of next year) —
    // reject unless the constructed date round-trips exactly.
    if (d.getFullYear() !== y || d.getMonth() !== m - 1 || d.getDate() !== day) return null;
    return d;
  }
  const iso = new Date(s);
  return isNaN(iso.getTime()) ? null : iso;
}

// §21 resolution chain (2026-09-08): explicit Date Added column > Notes
// "Lead date MM/DD/YYYY" regex > NOW(). BOTH inputs go through the same
// parseAddedAt (local midnight, rollover-rejecting) — one parser, two
// inputs. Returns the source so createBulkList can log every NOW()
// fallback per row (the 42f0f42 modal bug silently stamped upload day on
// every row of a real Spark list; a fallback must never be invisible).
export function resolveAddedAt(
  addedAtRaw: string | null | undefined,
  notes: string | null | undefined,
): { date: Date | null; source: "column" | "notes" | "fallback"; raw: string | null } {
  const fromColumn = parseAddedAt(addedAtRaw);
  if (fromColumn) return { date: fromColumn, source: "column", raw: addedAtRaw ?? null };
  const m = /Lead date (\d{1,2}\/\d{1,2}\/\d{4})/.exec(notes ?? "");
  if (m) {
    const fromNotes = parseAddedAt(m[1]);
    if (fromNotes) return { date: fromNotes, source: "notes", raw: m[1] };
  }
  return { date: null, source: "fallback", raw: (addedAtRaw ?? "").trim() || null };
}

// §21 promo extraction from Notes (2026-09-08, backfill + explicit-only
// fallback): the Spark Notes format is "… | Promo: WELCOME | …". Take the
// explicit value up to the next " | " delimiter (or end) — never guess.
export function extractPromoFromNotes(notes: string | null | undefined): string | null {
  const m = /Promo: ([^|]+?)(?:\s*\||$)/.exec(notes ?? "");
  const v = m ? m[1].trim() : "";
  return v || null;
}
