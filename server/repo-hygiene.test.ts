import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import path from "path";

// Repo hygiene: no literal NUL bytes in tracked text files.
//
// WHY: a raw \x00 inside a source file flips git's binary heuristic — diffs
// show "Bin", `git grep` goes silent, hunk-level staging breaks. All known
// instances came from ONE pattern (commit 666ab87): the Velocity dedup-key
// separator written as a literal byte inside a template literal instead of
// the \u0000 escape (identical runtime string). Write escapes, never bytes.
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf",
  ".eot", ".pdf", ".xlsx", ".zip", ".webp",
]);

describe("repo hygiene — no literal NUL bytes in tracked text files", () => {
  it("every tracked text file is NUL-free (use \\u0000 escapes in string literals)", () => {
    const root = path.resolve(__dirname, "..");
    const files = execSync("git ls-files -z", { cwd: root })
      .toString("latin1")
      .split("\0")
      .filter(Boolean);
    const offenders: string[] = [];
    for (const f of files) {
      if (BINARY_EXT.has(path.extname(f).toLowerCase())) continue;
      let data: Buffer;
      try {
        data = readFileSync(path.join(root, f));
      } catch {
        continue; // deleted-but-tracked etc.
      }
      // True binaries that slipped past the extension filter have high NUL
      // density; a text file with an accidental literal NUL has a tiny one.
      const nuls = data.filter((b) => b === 0).length;
      if (nuls > 0 && nuls / data.length < 0.01) offenders.push(`${f} (${nuls} NUL)`);
    }
    expect(offenders, `literal NUL bytes found — replace with \\u0000 escapes:\n${offenders.join("\n")}`).toEqual([]);
  });
});
