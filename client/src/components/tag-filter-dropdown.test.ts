import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { TAG_COLORS } from "./column-filter";
import { compareTagRecords } from "@/lib/use-tag-groups";

// §20 Filter dropdown (2026-10-13).
//
// The list used to be built from the CURRENT RESULT SET, so a tag no visible
// ASIN carried vanished entirely — St. Patrick's Day and Back to School
// disappeared from Seasonal whenever nothing matched, which reads as "that
// tag doesn't exist" rather than "nothing here has it".
//
// Now every tag is listed with its count, `(0)` included, and the dropdown
// can create and delete tags through the SAME endpoints the row picker uses.

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "").replace(/[ \t]+\/\/.*$/gm, "");
const code = (p: string) => stripComments(readFileSync(join(__dirname, p), "utf8"));
const server = (p: string) => stripComments(readFileSync(join(__dirname, "..", "..", "..", "server", p), "utf8"));

// The option-building logic, mirrored from results-table's tagOptions so the
// rule is testable without mounting the table.
type Tag = { id: string; name: string; color: string; tag_group: string | null; sort_order: number | null };
function buildOptions(allTags: Tag[], rows: Array<{ tags?: { name: string; color: string }[] }>) {
  const counts = new Map<string, number>();
  let noTagCount = 0;
  for (const r of rows) {
    if (!r.tags || r.tags.length === 0) { noTagCount++; continue; }
    for (const t of r.tags) counts.set(t.name.toLowerCase(), (counts.get(t.name.toLowerCase()) ?? 0) + 1);
  }
  const opts = [{ value: "__none__", label: "No tags", count: noTagCount }] as any[];
  for (const t of allTags) {
    opts.push({
      value: t.name.toLowerCase(), label: t.name, color: t.color,
      count: counts.get(t.name.toLowerCase()) ?? 0,
      group: t.tag_group ?? undefined, tagId: t.id,
    });
  }
  return opts;
}

const T = (name: string, group: string | null = null, sort: number | null = null): Tag =>
  ({ id: `id-${name}`, name, color: "#EF4444", tag_group: group, sort_order: sort });

describe("every tag is listed, always — including 0 matches", () => {
  const all = [
    T("OA Hunt"), T("Fall/Q4", "Seasonal", 1), T("St. Patrick's Day", "Seasonal", 3),
    T("Back to School", "Seasonal", 7),
  ];

  it("a tag no visible ASIN carries still appears, with (0)", () => {
    // The reported bug, exactly: nothing in the set has these two.
    const opts = buildOptions(all, [{ tags: [{ name: "OA Hunt", color: "#EF4444" }] }]);
    const byLabel = Object.fromEntries(opts.map((o) => [o.label, o.count]));
    expect(byLabel["St. Patrick's Day"]).toBe(0);
    expect(byLabel["Back to School"]).toBe(0);
    expect(byLabel["OA Hunt"]).toBe(1);
  });

  it("an EMPTY result set still lists every tag", () => {
    const opts = buildOptions(all, []);
    expect(opts.filter((o) => o.value !== "__none__")).toHaveLength(all.length);
    expect(opts.filter((o) => o.value !== "__none__").every((o) => o.count === 0)).toBe(true);
  });

  it("counts are real where they exist", () => {
    const opts = buildOptions(all, [
      { tags: [{ name: "OA Hunt", color: "#EF4444" }] },
      { tags: [{ name: "OA Hunt", color: "#EF4444" }, { name: "Fall/Q4", color: "#EF4444" }] },
      { tags: [] },
    ]);
    const byLabel = Object.fromEntries(opts.map((o) => [o.label, o.count]));
    expect(byLabel["OA Hunt"]).toBe(2);
    expect(byLabel["Fall/Q4"]).toBe(1);
    expect(byLabel["No tags"]).toBe(1);
  });

  it("preserves the §20 render order it was given (ungrouped first, then groups)", () => {
    const sorted = [...all].sort(compareTagRecords);
    const opts = buildOptions(sorted, []).filter((o) => o.value !== "__none__");
    expect(opts.map((o) => o.label)).toEqual([
      "OA Hunt", "Fall/Q4", "St. Patrick's Day", "Back to School",
    ]);
    expect(opts[0].group).toBeUndefined();          // ungrouped first
    expect(opts[1].group).toBe("Seasonal");
  });

  it("every real tag carries a tagId — that is what makes it deletable", () => {
    const opts = buildOptions(all, []);
    expect(opts.find((o) => o.value === "__none__")!.tagId).toBeUndefined();
    expect(opts.filter((o) => o.value !== "__none__").every((o) => !!o.tagId)).toBe(true);
  });
});

describe("the colour palette is the server's", () => {
  it("client TAG_COLORS matches server tags-repo TAG_COLORS exactly", () => {
    // POST /api/tags accepts a colour only if it is in the server list, so a
    // drifted client palette would silently fall back to a random colour.
    const src = server("tags-repo.ts");
    const m = src.match(/export const TAG_COLORS = \[([^\]]+)\]/);
    expect(m).not.toBeNull();
    const serverColors = m![1].split(",").map((x) => x.trim().replace(/['"]/g, "")).filter(Boolean);
    expect(TAG_COLORS).toEqual(serverColors);
  });
});

describe("create and delete go through the one writer", () => {
  const cf = code("column-filter.tsx");

  it("create POSTs to /api/tags with name, color and tagGroup", () => {
    expect(cf).toMatch(/fetch\("\/api\/tags", \{/);
    expect(cf).toMatch(/body: JSON\.stringify\(\{ name, color: newColor, tagGroup: newGroup \|\| null \}\)/);
  });

  it("the name check is case-insensitive on the trimmed value", () => {
    expect(cf).toMatch(/const n = newName\.trim\(\)\.toLowerCase\(\)/);
    expect(cf).toMatch(/o\.label\.toLowerCase\(\) === n/);
  });

  it("delete calls DELETE /api/tags/:id", () => {
    expect(cf).toMatch(/fetch\(`\/api\/tags\/\$\{opt\.tagId\}`, \{ method: "DELETE" \}\)/);
  });

  it("the confirmation names the live count", () => {
    expect(cf).toMatch(/Removes it from\{" "\}/);
    expect(cf).toMatch(/confirmDelete\.count \?\? 0/);
  });

  it("deleting a tag that is in the ACTIVE filter drops it and re-applies", () => {
    // Otherwise the filter keeps referencing a tag that no longer exists and
    // the view silently shows nothing.
    const i = cf.indexOf("async function deleteTag");
    const fn = cf.slice(i, i + 1400);
    expect(fn).toMatch(/if \(selected\.has\(opt\.value\)\)/);
    expect(fn).toMatch(/next\.delete\(opt\.value\)/);
    expect(fn).toMatch(/if \(next\.size === 0\) onClear\(\)/);
  });

  it("both actions refetch rather than reload the page", () => {
    expect(cf).toMatch(/onTagsChanged\?\.\(\)/);
    expect(cf).not.toMatch(/location\.reload/);
  });

  it("management is off unless the caller opts in — tags only", () => {
    expect(cf).toMatch(/const manageable = typeof onTagsChanged === "function"/);
    expect(cf).toMatch(/onTagsChanged=\{colId === "tags" \? onTagsChanged : undefined\}/);
  });
});

describe("server endpoints", () => {
  const routes = server("routes.ts");

  it("POST /api/tags stays backward-compatible for the row picker", () => {
    const i = routes.indexOf('app.post("/api/tags"');
    const fn = routes.slice(i, i + 2200);
    // colour and group are OPTIONAL; {name} alone still works.
    expect(fn).toMatch(/const \{ name, color: colorRaw, tagGroup \} = req\.body/);
    expect(fn).toMatch(/TAG_COLORS\[Math\.floor\(Math\.random\(\)/);  // fallback preserved
    // an existing name is RETURNED, not an error — the picker relies on it
    expect(fn).toMatch(/if \(existing\.rows\.length > 0\) \{ res\.json\(existing\.rows\[0\]\); return; \}/);
  });

  it("POST /api/tags only accepts a colour from the server palette", () => {
    const i = routes.indexOf('app.post("/api/tags"');
    expect(routes.slice(i, i + 2200)).toMatch(/TAG_COLORS as readonly string\[\]\)\.includes\(colorRaw\)/);
  });

  it("DELETE /api/tags/:id exists and reports the affected-ASIN count", () => {
    const i = routes.indexOf('app.delete("/api/tags/:id"');
    expect(i).toBeGreaterThan(-1);
    const fn = routes.slice(i, i + 1200);
    expect(fn).toMatch(/SELECT count\(\*\)::int AS n FROM asin_tags WHERE tag_id = \$1/);
    expect(fn).toMatch(/DELETE FROM tags WHERE id = \$1/);
    expect(fn).toMatch(/asinsAffected: n/);
    // it must NOT delete asin_tags by hand — the §20 cascade owns that
    expect(fn).not.toMatch(/DELETE FROM asin_tags/);
    // unknown id is a 404, not a silent ok
    expect(fn).toMatch(/res\.status\(404\)/);
  });
});
