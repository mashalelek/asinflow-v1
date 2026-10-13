import { useState, useEffect } from "react";

// Tag group/order metadata, keyed by lowercased tag name. The tag filter options
// are derived from the result set (name + color only), so they need this to order
// and group consistently with the picker (ungrouped first, then Seasonal etc.).
export interface TagMeta { group: string | null; sortOrder: number | null }

// The FULL tag list, not just ordering metadata (2026-10-13). The filter
// dropdown lists every tag — including ones no ASIN in the current set
// carries — and can create and delete them, so it needs ids and colours too.
// `reload` is what the create/delete actions call; no page reload.
export interface FullTag { id: string; name: string; color: string; tag_group: string | null; sort_order: number | null }
export function useAllTags(): { tags: FullTag[]; reload: () => void } {
  const [tags, setTags] = useState<FullTag[]>([]);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/tags")
      .then((r) => r.json())
      .then((rows: FullTag[]) => { if (!cancelled && Array.isArray(rows)) setTags(rows); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [nonce]);
  return { tags, reload: () => setNonce((n) => n + 1) };
}

export function useTagGroups(): Map<string, TagMeta> {
  const [map, setMap] = useState<Map<string, TagMeta>>(new Map());
  useEffect(() => {
    let cancelled = false;
    fetch("/api/tags")
      .then((r) => r.json())
      .then((tags: { name: string; tag_group: string | null; sort_order: number | null }[]) => {
        if (cancelled || !Array.isArray(tags)) return;
        const m = new Map<string, TagMeta>();
        for (const t of tags) m.set(t.name.toLowerCase(), { group: t.tag_group ?? null, sortOrder: t.sort_order ?? null });
        setMap(m);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return map;
}

// §20 group render order, mirroring the CASE in GET /api/tags. The server is
// authoritative — the filter list uses its order verbatim — and this exists
// for the client-side comparators, which only handle tags the server did not
// return (a stale set mid-refetch). Keep the two in step.
export const GROUP_ORDER = ["BLOCKERS", "MARK DEAD", "SEASONAL", "OTHER"];
function groupRank(g: string | null): number {
  if (g === null) return -1;              // ungrouped first
  const i = GROUP_ORDER.indexOf(g);
  return i === -1 ? GROUP_ORDER.length : i;   // unknown groups after the named ones
}

// Order tag keys (lowercased names): ungrouped first (alphabetical), then grouped
// in GROUP_ORDER, then sort_order within a group, name as the final tiebreak.
export function compareTagKeys(aKey: string, bKey: string, meta: Map<string, TagMeta>): number {
  const a = meta.get(aKey), b = meta.get(bKey);
  const ag = a?.group ?? null, bg = b?.group ?? null;
  if (ag !== bg) {
    const ra = groupRank(ag), rb = groupRank(bg);
    if (ra !== rb) return ra - rb;
    return (ag ?? "").localeCompare(bg ?? "");
  }
  if (ag !== null) {
    const as = a?.sortOrder ?? Infinity, bs = b?.sortOrder ?? Infinity;
    if (as !== bs) return as - bs;
  }
  return aKey.localeCompare(bKey);
}

// Same ordering, applied to tag records (snake_case, as returned by /api/tags).
export interface TagRecord { name: string; tag_group?: string | null; sort_order?: number | null }
export function compareTagRecords(a: TagRecord, b: TagRecord): number {
  const ag = a.tag_group ?? null, bg = b.tag_group ?? null;
  if (ag !== bg) {
    const ra = groupRank(ag), rb = groupRank(bg);
    if (ra !== rb) return ra - rb;
    return (ag ?? "").localeCompare(bg ?? "");
  }
  if (ag !== null) {
    const as = a.sort_order ?? Infinity, bs = b.sort_order ?? Infinity;
    if (as !== bs) return as - bs;
  }
  return a.name.localeCompare(b.name);
}
