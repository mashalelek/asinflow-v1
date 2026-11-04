import { describe, it, expect } from "vitest";
import {
  documentBaseName, documentFileName, nextDocumentFileName, orderYmd, typeFromFileName, matchesExactName, matchesLooseName,
  planLinks, monthFolderNames, yearFolderName, type PoLite, type DriveFileLite,
} from "./po-documents";

// Real col AU names from the Invoices root (production, read 2026-11-04).
const AU = [
  { po: { order_date: "2026-10-18", supplier: "walmart.com", order_id: "200015383864738" }, file: "2026-10-18_walmart.com_200015383864738.pdf" },
  { po: { order_date: "2026-02-07", supplier: "michaels.com", order_id: "3300109488189945" }, file: "2026-02-07_michaels.com_3300109488189945.pdf" },
  { po: { order_date: "2025-11-29", supplier: "webstaurantstore.com", order_id: "119181547" }, file: "2025-11-29_webstaurantstore.com_119181547.pdf" },
  { po: { order_date: "2025-10-19", supplier: "lowes.com", order_id: "300901292251720359" }, file: "2025-10-19_lowes.com_300901292251720359.pdf" },
];

describe("§2 file name (col AU)", () => {
  it("reproduces the sheet's AU names", () => {
    for (const { po, file } of AU) expect(documentFileName(documentBaseName(po), "order_confirmation")).toBe(file);
  });
  it("a pg DATE (local midnight) keeps its day", () => {
    expect(orderYmd(new Date(2026, 9, 18))).toBe("2026-10-18");
  });
  it("type suffixes and -N", () => {
    const b = "2026-10-18_walmart.com_200015383864738";
    expect(documentFileName(b, "shipped")).toBe(`${b}_shipped.pdf`);
    expect(documentFileName(b, "delivered", 2)).toBe(`${b}_delivered-2.pdf`);
    expect(documentFileName(b, "invoice_manual")).toBe(`${b}_invoice.pdf`);
    expect(documentFileName(b, "order_confirmation", 3)).toBe(`${b}-3.pdf`);
  });
  it("the next free name skips taken ones, case-insensitively", () => {
    const b = "2026-10-18_walmart.com_1";
    expect(nextDocumentFileName(b, "shipped", [])).toBe(`${b}_shipped.pdf`);
    expect(nextDocumentFileName(b, "shipped", [`${b}_SHIPPED.pdf`, `${b}_shipped-2.pdf`])).toBe(`${b}_shipped-3.pdf`);
  });
  it("folders: the year, and the month under either spelling (Invoices first)", () => {
    expect(yearFolderName("2027-01-05")).toBe("Invoices - 2027");
    expect(monthFolderNames("2025-07-12")).toEqual(["Invoices 2025-07", "Receipts_2025-07"]);
  });
});

describe("linking existing PDFs", () => {
  const po = (id: string, d: string, s: string, o: string): PoLite => ({ id, order_date: d, supplier: s, order_id: o });
  const f = (id: string, name: string, mimeType = "application/pdf"): DriveFileLite => ({ id, name, mimeType });

  it("rule 1 ignores case and spaces and reads the type suffix", () => {
    expect(matchesExactName("2025-11-29_michaels.com_ 1000111373091577.pdf", "2025-11-29_michaels.com_1000111373091577")).toBe(true);
    expect(matchesExactName("2025-10-01_Walmart.com_123456_shipped-2.PDF", "2025-10-01_walmart.com_123456")).toBe(true);
    expect(matchesExactName("2025-10-01_walmart.com_1234567.pdf", "2025-10-01_walmart.com_123456")).toBe(false);
    expect(typeFromFileName("x_shipped-2.pdf")).toBe("shipped");
    expect(typeFromFileName("x_delivered.pdf")).toBe("delivered");
    expect(typeFromFileName("x_invoice.pdf")).toBe("order_confirmation");
  });

  it("rule 2: same date, the order # as a whole token, any supplier spelling", () => {
    const p = po("a", "2025-07-12", "farmandfleet.com", "31885729");
    expect(matchesLooseName("2025-07-12_Blains Farm and Fleet_31885729.pdf", p)).toBe(true);
    expect(matchesLooseName("2025-07-13_Blains_31885729.pdf", p)).toBe(false);
    expect(matchesLooseName("2025-07-12_Blains_318857290.pdf", p)).toBe(false);
    expect(matchesLooseName("2025-07-12_x_31885729 (invoice).pdf", p)).toBe(true);
  });

  it("links rule-1 files (a duplicate name links both), rule-2 only when exactly one fits", () => {
    const pos = [po("a", "2026-01-02", "walmart.com", "111111"), po("b", "2025-08-26", "walmart.com", "222222"), po("c", "2025-07-01", "x.com", "333333")];
    const files = [
      f("1", "2026-01-02_walmart.com_111111.pdf"), f("2", "2026-01-02_Walmart.com_111111.pdf"),
      f("3", "2025-08-26_Walmart_222222.pdf"), f("4", "2025-08-26_Walmart_222222_Confirmation.pdf"),
      f("5", "2025-07-01_X_333333.pdf"), f("6", "2025-07-01_X_333333.png", "image/png"),
    ];
    const plan = planLinks(pos, files);
    expect(plan.links.map((l) => [l.po_id, l.file.id, l.rule])).toEqual([["a", "1", "name"], ["a", "2", "name"], ["c", "5", "loose"]]);
    expect(plan.review).toHaveLength(1);
    expect(plan.review[0]).toMatchObject({ reason: "several_files", po: { id: "b" } });
  });

  it("a rule-2 file that fits two POs goes to review for both", () => {
    const pos = [po("a", "2025-08-10", "mrosupreme.com", "377870-1754865180"), po("b", "2025-08-10", "mrosupply.com", "377870-1754865180")];
    const plan = planLinks(pos, [f("1", "2025-08-10_MROSupply_377870-1754865180.pdf")]);
    expect(plan.links).toHaveLength(0);
    expect(plan.review.map((r) => r.reason)).toEqual(["file_fits_several_pos", "file_fits_several_pos"]);
  });

  it("a re-run plans nothing new", () => {
    const pos = [po("a", "2026-01-02", "walmart.com", "111111"), po("c", "2025-07-01", "x.com", "333333")];
    const files = [f("1", "2026-01-02_walmart.com_111111.pdf"), f("5", "2025-07-01_X_333333.pdf")];
    const first = planLinks(pos, files);
    expect(first.links).toHaveLength(2);
    expect(planLinks(pos, files, new Set(first.links.map((l) => l.file.id)))).toEqual({ links: [], review: [] });
  });
});
