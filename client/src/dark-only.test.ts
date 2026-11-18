// AF is dark only (Maria 2026-11-18, the light-mode removal patch): `dark` is set once
// on <html>, no stored preference and no OS preference is read, no theme toggle, one token block in index.css.
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";

const client = resolve(__dirname, "..");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|css|html)$/.test(name) && !p.endsWith("dark-only.test.ts")) out.push(p);
  }
  return out;
}

describe("dark only", () => {
  it("the app root is dark before any script runs, whatever the browser or OS prefers", () => {
    expect(readFileSync(join(client, "index.html"), "utf8")).toMatch(/<html lang="en" class="dark">/);
  });
  it("no theme provider, stored preference, OS preference read or toggle remains", () => {
    expect(existsSync(join(client, "src/components/theme-provider.tsx"))).toBe(false);
    const hits = walk(join(client, "src")).filter((p) => /fba-theme|prefers-color-scheme|toggleTheme|useTheme|theme-provider|Toggle theme/.test(readFileSync(p, "utf8")));
    expect(hits).toEqual([]);
  });
  it("index.css has one token block: :root carries the dark values and there is no .dark block", () => {
    const css = readFileSync(join(client, "src/index.css"), "utf8");
    expect(css).not.toMatch(/^\.dark\b/m);
    expect(css).toMatch(/:root \{[\s\S]*--background: 24 10% 10%;/);
  });
});
