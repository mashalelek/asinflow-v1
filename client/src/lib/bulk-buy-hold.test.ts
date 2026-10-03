import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { planBulkSetToggle, bulkToggleLabel, promoteTargets, applyBulkPlan } from "./bulk-buy-hold";

// §21 Bulk Buy List / Hold (2026-10-03). The toggle DIRECTION is the part
// with real semantics, so it lives in a pure module both pages drive —
// these tests are the contract, not a mirror of one page's wiring.

describe("toggle semantics", () => {
  it("EVERY selected already in the set -> remove them all", () => {
    const p = planBulkSetToggle(["A", "B", "C"], new Set(["A", "B", "C", "Z"]));
    expect(p.direction).toBe("remove");
    expect(p.targets).toEqual(["A", "B", "C"]);
    expect(p.selectedCount).toBe(3);
  });

  it("MIXED selection -> add only the missing ones, remove nothing", () => {
    const p = planBulkSetToggle(["A", "B", "C"], new Set(["B"]));
    expect(p.direction).toBe("add");
    expect(p.targets).toEqual(["A", "C"]); // B already in, untouched
  });

  it("NONE in the set -> add all of them", () => {
    const p = planBulkSetToggle(["A", "B"], new Set());
    expect(p.direction).toBe("add");
    expect(p.targets).toEqual(["A", "B"]);
  });

  it("a single already-in ASIN still counts as all-in -> remove", () => {
    expect(planBulkSetToggle(["A"], new Set(["A"])).direction).toBe("remove");
  });

  it("never produces a partly-add-partly-remove plan", () => {
    // The whole point: one direction per click, whatever the mix.
    for (const current of [new Set<string>(), new Set(["A"]), new Set(["A", "B"]), new Set(["A", "B", "C"])]) {
      const p = planBulkSetToggle(["A", "B", "C"], current);
      if (p.direction === "add") expect(p.targets.every((a) => !current.has(a))).toBe(true);
      else expect(p.targets.every((a) => current.has(a))).toBe(true);
    }
  });
});

describe("no selection", () => {
  it("yields an empty plan — the control is disabled, never 'all'", () => {
    const p = planBulkSetToggle([], new Set(["A", "B"]));
    expect(p.targets).toEqual([]);
    expect(p.selectedCount).toBe(0);
  });

  it('labels the disabled state "Select rows first"', () => {
    expect(bulkToggleLabel(planBulkSetToggle([], new Set()), "Buy List")).toBe("Select rows first");
  });
});

describe("tooltip states the resolved direction and count", () => {
  const many = Array.from({ length: 52 }, (_, i) => `A${i}`);

  it("add direction", () => {
    expect(bulkToggleLabel(planBulkSetToggle(many, new Set()), "Buy List")).toBe("Add 52 to Buy List");
    expect(bulkToggleLabel(planBulkSetToggle(many, new Set()), "Hold")).toBe("Add 52 to Hold");
  });

  it("remove direction", () => {
    expect(bulkToggleLabel(planBulkSetToggle(many, new Set(many)), "Buy List")).toBe("Remove 52 from Buy List");
  });

  it("counts the SELECTION, not the write size, on a mixed add", () => {
    // 52 selected, 30 already in -> still "Add 52", because that is what
    // the operator selected and what they mean.
    const current = new Set(many.slice(0, 30));
    expect(bulkToggleLabel(planBulkSetToggle(many, current), "Buy List")).toBe("Add 52 to Buy List");
  });
});

describe("promote targets", () => {
  it("only the add direction promotes, and only ASINs not in the database", () => {
    const plan = planBulkSetToggle(["A", "B", "C"], new Set());
    expect(promoteTargets(plan, new Set(["B"]))).toEqual(["A", "C"]);
  });

  it("the remove direction NEVER promotes", () => {
    const plan = planBulkSetToggle(["A", "B"], new Set(["A", "B"]));
    expect(plan.direction).toBe("remove");
    expect(promoteTargets(plan, new Set())).toEqual([]);
  });

  it("nothing to promote when every target is already in the database", () => {
    const plan = planBulkSetToggle(["A", "B"], new Set());
    expect(promoteTargets(plan, new Set(["A", "B"]))).toEqual([]);
  });
});

describe("applying a plan — error ASINs excluded, mutual exclusion kept", () => {
  it("an ASIN whose promote errored is NOT added to the set", () => {
    const plan = planBulkSetToggle(["A", "B", "C"], new Set());
    const landed = new Set(["A", "C"]); // B errored
    const { target } = applyBulkPlan(plan, landed, { target: new Set(), other: new Set() });
    expect(Array.from(target).sort()).toEqual(["A", "C"]);
    expect(target.has("B")).toBe(false);
  });

  it("adding to Buy List evicts those ASINs from Hold", () => {
    const plan = planBulkSetToggle(["A", "B"], new Set());
    const { target, other } = applyBulkPlan(plan, new Set(["A", "B"]), {
      target: new Set(), other: new Set(["A", "Z"]),
    });
    expect(Array.from(target).sort()).toEqual(["A", "B"]);
    expect(Array.from(other)).toEqual(["Z"]); // A evicted, Z untouched
  });

  it("REMOVING from a set never touches the other set", () => {
    const plan = planBulkSetToggle(["A"], new Set(["A"]));
    const { target, other } = applyBulkPlan(plan, new Set(["A"]), {
      target: new Set(["A"]), other: new Set(["A"]),
    });
    expect(target.has("A")).toBe(false);
    expect(other.has("A")).toBe(true); // untouched by a removal
  });

  it("an errored ASIN is not evicted from the other set either", () => {
    // B failed to promote, so nothing about B changes anywhere.
    const plan = planBulkSetToggle(["A", "B"], new Set());
    const { other } = applyBulkPlan(plan, new Set(["A"]), {
      target: new Set(), other: new Set(["B"]),
    });
    expect(other.has("B")).toBe(true);
  });
});

// ============================================================================
// Wiring pins — the ordering and dialog rules live in the page component, so
// they are pinned as source text (the repo's existing pattern for rules that
// are not pure functions).
// ============================================================================
describe("Bulk Calc wiring: promote BEFORE the set, dialog only when promoting", () => {
  const src = () => readFileSync(join(__dirname, "../pages/bulk-calc.tsx"), "utf8");
  const commitBody = () => {
    const s = src();
    const i = s.indexOf("const commitBulkSet");
    expect(i).toBeGreaterThan(-1);
    return s.slice(i, s.indexOf("const startBulkSet", i));
  };

  it("promote is awaited BEFORE the set is written", () => {
    const b = commitBody();
    const promoteIdx = b.indexOf("await promoteAsins(");
    const setIdx = b.indexOf("applyBulkPlan(");
    expect(promoteIdx).toBeGreaterThan(-1);
    expect(setIdx).toBeGreaterThan(promoteIdx); // ordering is the rule
  });

  it("an error outcome removes that ASIN from the landed set", () => {
    expect(commitBody()).toMatch(/outcome === "error"[\s\S]*landed\.delete/);
  });

  it("already_in_database is NOT treated as an error", () => {
    const b = commitBody();
    expect(b).toMatch(/already_in_database/);
    // No single line both names already_in_database and drops it from the
    // landed set. (Line-scoped on purpose: a dotAll regex here matches
    // across the unrelated catch block.)
    const bad = b.split("\n").filter((l) => l.includes("already_in_database") && l.includes("landed.delete"));
    expect(bad).toEqual([]);
    // Only the error outcome prunes landed.
    expect(b).toMatch(/outcome === "error"\) \{ landed\.delete/);
  });

  it("the confirm dialog opens ONLY when there is something to promote", () => {
    const s = src();
    const start = s.slice(s.indexOf("const startBulkSet"), s.indexOf("const handleSort"));
    // zero to promote -> straight to commit, no dialog
    expect(start).toMatch(/toPromote\.length > 0[\s\S]*setPendingBulkSet/);
    expect(start).toMatch(/commitBulkSet\(which, plan, \[\]\)/);
  });

  it("an empty selection is refused before any work", () => {
    const s = src();
    const start = s.slice(s.indexOf("const startBulkSet"), s.indexOf("const handleSort"));
    expect(start).toMatch(/selectedCount === 0[\s\S]*return/);
  });
});

describe("main page wiring: same semantics, no promote step", () => {
  const src = () => readFileSync(join(__dirname, "../pages/home.tsx"), "utf8");

  it("drives the SAME shared planner, not a local copy", () => {
    expect(src()).toMatch(/from "@\/lib\/bulk-buy-hold"/);
  });

  it("never calls a promote endpoint from the bulk set handler", () => {
    const s = src();
    const body = s.slice(s.indexOf("const runBulkSet"), s.indexOf("const handleSort"));
    // The CALL, not the word — a comment may legitimately mention promoting.
    expect(body).not.toMatch(/promoteAsins\s*\(/);
    expect(body).not.toMatch(/\/promote/);
  });

  it("both pages disable the buttons on an empty selection", () => {
    for (const f of ["../pages/home.tsx", "../pages/bulk-calc.tsx"]) {
      const s = readFileSync(join(__dirname, f), "utf8");
      expect(s, f).toMatch(/bulkActionsDisabled=\{selectedSet\.size === 0\}/);
    }
  });
});
