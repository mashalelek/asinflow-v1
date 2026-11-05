import { describe, it, expect, vi } from "vitest";
vi.mock("./db", () => ({ query: vi.fn(), default: {} }));
import { createPoDocumentsRouter, uploadInvoice, deleteDocument, documentRouteDeps } from "./po-documents-routes";
import { INVOICES_ROOT_ID } from "./drive-client";
import { paperclipAction } from "../client/src/components/po-documents";

function fakes() {
  const docs: any[] = [{ id: 1, po_id: "p1", drive_file_id: "old", file_name: "2026-10-18_walmart.com_1.pdf", source: "linked_existing" }];
  const log: any[] = [];
  const query = (async (sql: string, p: any[] = []) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("SELECT id, order_date, supplier, order_id FROM purchase_orders")) return { rows: p[0] === "p1" ? [{ id: "p1", order_date: "2026-10-18", supplier: "walmart.com", order_id: "1" }] : [] };
    if (s.startsWith("SELECT file_name FROM po_documents WHERE po_id")) return { rows: docs.filter((d) => d.po_id === p[0]) };
    if (s.startsWith("INSERT INTO po_documents")) { const id = docs.length + 1; docs.push({ id, po_id: p[0], drive_file_id: p[1], file_name: p[2], bytes: p[3], created_by_user_id: p[4], source: "upload", type: "invoice_manual", document_at: new Date() }); return { rows: [{ id }] }; }
    if (s.startsWith("INSERT INTO po_edit_log")) { log.push(p); return { rows: [] }; }
    if (s.startsWith("SELECT d.id, d.po_id")) return { rows: docs.filter((d) => d.po_id === p[0]).map((d) => ({ ...d, document_at: d.document_at ?? new Date() })) };
    if (s.startsWith("SELECT id, po_id, drive_file_id, file_name, source FROM po_documents WHERE id")) return { rows: docs.filter((d) => d.id === p[0]) };
    if (s.startsWith("DELETE FROM po_documents")) { const i = docs.findIndex((d) => d.id === p[0]); docs.splice(i, 1); return { rows: [] }; }
    throw new Error(`unexpected SQL: ${s.slice(0, 80)}`);
  }) as any;
  const uploads: string[] = [], trashed: string[] = [];
  const parentOf: Record<string, string> = { f1: "m", m: "y", y: INVOICES_ROOT_ID };
  const drive: any = {
    files: {
      list: async ({ q }: { q: string }) => {
        const parent = /'([^']+)' in parents/.exec(q)![1];
        if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) return { data: { files: parent === INVOICES_ROOT_ID ? [{ id: "y", name: "Invoices - 2026" }] : parent === "y" ? [{ id: "m", name: "Invoices 2026-10" }] : [] } };
        return { data: { files: [{ id: "old", name: "2026-10-18_walmart.com_1.pdf" }] } };
      },
      create: async ({ requestBody }: any) => { uploads.push(requestBody.name); return { data: { id: `f${uploads.length}`, size: "5" } }; },
      get: async ({ fileId }: any) => ({ data: { parents: parentOf[fileId] ? [parentOf[fileId]] : [] } }),
      update: async ({ fileId }: any) => { trashed.push(fileId); return { data: {} }; },
    },
  };
  return { query, drive, docs, log, uploads, trashed };
}

describe("PO documents routes", () => {
  it("registers the five routes", () => {
    const r = createPoDocumentsRouter(async () => ({ rows: [], rowCount: 0 }));
    const routes = (r as any).stack.filter((l: any) => l.route).map((l: any) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
    expect(routes).toEqual(["GET /api/pos/:id/documents", "GET /api/pos/:id/documents/zip", "GET /api/pos/documents/:docId/download", "POST /api/pos/:id/documents", "DELETE /api/pos/documents/:docId"]);
  });

  it("an uploaded PDF is named _invoice in the PO's month folder, with a History row", async () => {
    const f = fakes();
    const d = await uploadInvoice(f.query, f.drive, "p1", { buffer: Buffer.from("%PDF-1.4 x"), mimetype: "application/pdf", originalname: "receipt.pdf" }, 7);
    expect(f.uploads).toEqual(["2026-10-18_walmart.com_1_invoice.pdf"]);
    expect(d).toMatchObject({ type: "invoice_manual", source: "upload", file_name: "2026-10-18_walmart.com_1_invoice.pdf" });
    expect(f.log).toEqual([["p1", 7, "2", null, "2026-10-18_walmart.com_1_invoice.pdf"]]);
    await uploadInvoice(f.query, f.drive, "p1", { buffer: Buffer.from("%PDF-1.4 y"), mimetype: "application/pdf", originalname: "b.pdf" }, 7);
    expect(f.uploads[1]).toBe("2026-10-18_walmart.com_1_invoice-2.pdf");
  });

  it("an image is converted to PDF; anything else is refused", async () => {
    const f = fakes();
    const conv = vi.spyOn(documentRouteDeps, "imageToPdf").mockResolvedValue(Buffer.from("%PDF-img"));
    await uploadInvoice(f.query, f.drive, "p1", { buffer: Buffer.from("png"), mimetype: "image/png", originalname: "r.png" }, 7);
    expect(conv).toHaveBeenCalledOnce();
    await expect(uploadInvoice(f.query, f.drive, "p1", { buffer: Buffer.from("x"), mimetype: "text/csv", originalname: "r.csv" }, 7)).rejects.toThrow(/PDF or an image/);
    conv.mockRestore();
  });

  it("delete: a linked existing file is only unlinked — never trashed; AF's own file goes to the trash", async () => {
    const f = fakes();
    expect(await deleteDocument(f.query, f.drive, 1, 7)).toEqual({ trashed: false });
    expect(f.trashed).toEqual([]);
    f.docs.push({ id: 9, po_id: "p1", drive_file_id: "f1", file_name: "x_invoice.pdf", source: "upload" });
    expect(await deleteDocument(f.query, f.drive, 9, 7)).toEqual({ trashed: true });
    expect(f.trashed).toEqual(["f1"]);
    expect(f.docs).toEqual([]);
    expect(f.log.map((l: any[]) => l[3])).toEqual(["2026-10-18_walmart.com_1.pdf", "x_invoice.pdf"]);
  });

  it("the paperclip: none → the Documents tab, one → download, several → a menu", () => {
    const d = { id: 1, type: "order_confirmation" as const, file_name: "a.pdf", document_at: "2026-11-01T00:00:00Z" };
    expect(paperclipAction([])).toBe("open_tab");
    expect(paperclipAction([d])).toBe("download");
    expect(paperclipAction([d, { ...d, id: 2 }])).toBe("menu");
  });
});
