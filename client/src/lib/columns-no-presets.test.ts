// View presets are gone (Maria 2026-11-18, docs/claude_spec-patch-remove-view-presets-and-light-mode.md).
// The rule: the columns each user saw before the patch are the columns they see after it. Activating a preset
// always copied its columns into the plain per-user store (`fba-column-config`), so the table's config never
// lived inside a preset record — these three cases pin that down, and the source scan keeps the feature out.
import { describe, it, expect, beforeEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { ALL_COLUMNS } from "@shared/schema";
import { loadColumnConfig, getDefaultConfig } from "./columns";

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

// A full column order a user might have (the default, rotated: Additional info first), three columns visible.
const defaultOrder = getDefaultConfig().order;
const saved = { order: [...defaultOrder.slice(-9), ...defaultOrder.slice(0, -9)], visible: ["product", "stock", "notes"], stockOrderV: 1 };

describe("column config without view presets", () => {
  beforeEach(() => store.clear());

  it("a user whose active view was a named preset keeps the columns the preset had written to fba-column-config", () => {
    store.set("fba-column-config", JSON.stringify(saved));
    store.set("fba-active-preset", "eba14f6a-8253-4dd7-90cb-b3b6cb637696"); // the old marker, now inert
    const cfg = loadColumnConfig();
    expect(cfg.order).toEqual(saved.order);
    expect(Array.from(cfg.visible)).toEqual(saved.visible);
  });

  it("a user in the 'Custom' state (no active preset) keeps the same stored config", () => {
    store.set("fba-column-config", JSON.stringify(saved));
    const cfg = loadColumnConfig();
    expect(cfg.order).toEqual(saved.order);
    expect(Array.from(cfg.visible)).toEqual(saved.visible);
  });

  it("a user with no saved config gets every column with its defaultVisible", () => {
    const cfg = loadColumnConfig();
    expect(cfg).toEqual(getDefaultConfig());
    expect(Array.from(cfg.visible).sort()).toEqual(ALL_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.id).sort());
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "__fixtures__") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !p.endsWith("columns-no-presets.test.ts")) out.push(p);
  }
  return out;
}

describe("no route, component or query references view presets", () => {
  it("client/src, server and shared are clean", () => {
    const root = resolve(__dirname, "../../..");
    const hits = ["client/src", "server", "shared"]
      .flatMap((d) => walk(resolve(root, d)))
      .filter((p) => /view[-_]?presets?|ViewPreset|fba-active-preset|Save As New View/i.test(readFileSync(p, "utf8")));
    expect(hits).toEqual([]);
  });
});
