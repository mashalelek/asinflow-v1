import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// §21 settings-drift guard (2026-09-09): Bulk Calc's Settings differed from
// the ASINs page because the movedToggles sections rendered only where the
// host passed them (hidden ≠ disabled), and Include Inbound Shipping was a
// home.tsx-local key that Bulk silently hard-defaulted. These pins enforce:
// ONE dialog component, ONE key set, both pages.
const read = (rel: string) => readFileSync(join(__dirname, "..", "..", "..", rel), "utf8");

describe("one Settings dialog, one storage key set (§21)", () => {
  it("both pages import the same SettingsDialog component", () => {
    for (const page of ["client/src/pages/home.tsx", "client/src/pages/bulk-calc.tsx"]) {
      expect(read(page)).toMatch(/import \{ SettingsDialog \} from "@\/components\/settings-dialog"/);
    }
  });

  it("the Settings key constant lives ONLY in lib/settings.ts", () => {
    const owner = read("client/src/lib/settings.ts");
    expect(owner).toContain('"fba-analyzer-settings"');
    for (const page of ["client/src/pages/home.tsx", "client/src/pages/bulk-calc.tsx", "client/src/components/settings-dialog.tsx"]) {
      expect(read(page), `${page} must not re-declare the settings key`).not.toContain('"fba-analyzer-settings"');
    }
  });

  it("Include Inbound Shipping: one shared key, both pages via lib/settings", () => {
    const owner = read("client/src/lib/settings.ts");
    expect(owner).toContain('"fba-include-inbound"');
    for (const page of ["client/src/pages/home.tsx", "client/src/pages/bulk-calc.tsx"]) {
      const src = read(page);
      expect(src, `${page} must use the shared loader`).toMatch(/loadIncludeInbound/);
      expect(src, `${page} must not own the key`).not.toContain('"fba-include-inbound"');
    }
  });

  it("Bulk Calc renders the full dialog; disabled set is EXACTLY {showParked, showDead, resetCogs}", () => {
    const src = read("client/src/pages/bulk-calc.tsx");
    expect(src).toMatch(/movedToggles=\{\{/);
    const block = src.slice(src.indexOf("disabledReasons: {"), src.indexOf("}", src.indexOf("disabledReasons: {")));
    const keys = Array.from(block.matchAll(/(\w+):\s*"/g)).map((m) => m[1]).sort();
    // Gated/meltable/price-source APPLY on Bulk Calc (2026-09-09) — only
    // main-catalog statuses and the main-writing action stay disabled.
    expect(keys).toEqual(["resetCogs", "showDead", "showParked"]);
  });

  it("price source: one shared key, owned by lib/settings", () => {
    expect(read("client/src/lib/settings.ts")).toContain('"fba-price-source"');
    for (const page of ["client/src/pages/home.tsx", "client/src/pages/bulk-calc.tsx"]) {
      const src = read(page);
      expect(src).toMatch(/loadPriceSource/);
      expect(src).not.toContain('"fba-price-source"');
    }
  });

  it("no page-local settings keys exist outside lib/settings.ts", () => {
    const SETTINGS_KEYS = ['"fba-analyzer-settings"', '"fba-include-inbound"', '"fba-price-source"'];
    for (const page of ["client/src/pages/home.tsx", "client/src/pages/bulk-calc.tsx", "client/src/pages/analytics.tsx", "client/src/components/settings-dialog.tsx"]) {
      const src = read(page);
      for (const key of SETTINGS_KEYS) expect(src, `${page} must not own ${key}`).not.toContain(key);
    }
    // The analytics-only inbound key was folded 2026-09-09 — it may appear
    // ONLY in lib/settings.ts (the one-time migration) and nowhere else.
    for (const page of ["client/src/pages/analytics.tsx", "client/src/pages/home.tsx", "client/src/pages/bulk-calc.tsx"]) {
      expect(read(page)).not.toContain("fba-analytics-include-inbound");
    }
  });
});
