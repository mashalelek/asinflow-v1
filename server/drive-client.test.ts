import { describe, it, expect } from "vitest";
import { ensureMonthFolder, trashFile, FOLDER_MIME } from "./drive-client";

/** A fake Drive: folders by parent; records creates and updates. */
function fakeDrive(folders: Array<{ id: string; name: string; parent: string }>, parents: Record<string, string> = {}) {
  const created: Array<{ name: string; parent: string }> = [], updated: string[] = [];
  let n = 0;
  const drive: any = {
    files: {
      list: async ({ q }: { q: string }) => {
        const parent = /'([^']+)' in parents/.exec(q)![1];
        return { data: { files: folders.filter((f) => f.parent === parent).map((f) => ({ id: f.id, name: f.name, mimeType: FOLDER_MIME })) } };
      },
      create: async ({ requestBody }: any) => { const id = `new${++n}`; created.push({ name: requestBody.name, parent: requestBody.parents[0] }); folders.push({ id, name: requestBody.name, parent: requestBody.parents[0] }); return { data: { id } }; },
      get: async ({ fileId }: any) => ({ data: { parents: parents[fileId] ? [parents[fileId]] : [] } }),
      update: async ({ fileId }: any) => { updated.push(fileId); return { data: {} }; },
    },
  };
  return { drive, created, updated };
}

describe("ensureMonthFolder (D2, decision 4)", () => {
  it("writes into an existing Receipts_YYYY-MM folder", async () => {
    const { drive, created } = fakeDrive([{ id: "y25", name: "Invoices - 2025", parent: "root" }, { id: "m", name: "Receipts_2025-07", parent: "y25" }]);
    expect(await ensureMonthFolder(drive, "2025-07-12", { rootId: "root" })).toEqual({ id: "m", name: "Receipts_2025-07", created: [] });
    expect(created).toEqual([]);
  });
  it("creates Invoices YYYY-MM only when neither spelling exists, and a missing year", async () => {
    const { drive, created } = fakeDrive([{ id: "y26", name: "Invoices - 2026", parent: "root" }]);
    const m = await ensureMonthFolder(drive, "2026-11-04", { rootId: "root" });
    expect(m.name).toBe("Invoices 2026-11");
    expect(created).toEqual([{ name: "Invoices 2026-11", parent: "y26" }]);
    const y = await ensureMonthFolder(drive, "2027-01-05", { rootId: "root" });
    expect(y.created).toEqual(["Invoices - 2027", "Invoices 2027-01"]);
    // A second call finds what the first created — never a duplicate folder.
    await ensureMonthFolder(drive, "2027-01-20", { rootId: "root" });
    expect(created).toHaveLength(3);
  });
  it("a dry run creates nothing", async () => {
    const { drive, created } = fakeDrive([]);
    expect((await ensureMonthFolder(drive, "2027-01-05", { rootId: "root", dryRun: true })).created).toEqual(["Invoices - 2027", "Invoices 2027-01"]);
    expect(created).toEqual([]);
  });
});

describe("trashFile", () => {
  it("refuses a file outside the Invoices root", async () => {
    const { drive, updated } = fakeDrive([], { f1: "elsewhere" });
    await expect(trashFile(drive, "f1", "root")).rejects.toThrow(/not under the Invoices root/);
    expect(updated).toEqual([]);
  });
  it("trashes a file under the root at any depth", async () => {
    const { drive, updated } = fakeDrive([], { f1: "m", m: "y", y: "root" });
    await trashFile(drive, "f1", "root");
    expect(updated).toEqual(["f1"]);
  });
});
