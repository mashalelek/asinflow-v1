// "Download all" (Maria 2026-11-04): a PO's documents in one zip named like its invoice, each under its own name.
import { describe, it, expect, vi } from "vitest";
vi.mock("./db", () => ({ query: vi.fn(), default: {} }));
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Readable } from "stream";
import { zipStore, crc32, uniqueNames } from "./zip-store";
import { createPoDocumentsRouter, documentRouteDeps, zipNameFor } from "./po-documents-routes";
import { showDownloadAll, zipUrl } from "../client/src/components/po-documents";

describe("zip-store", () => {
  it("crc32 of the standard check string", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });
  it("unique names: a repeated file name gets (2), path separators are dropped", () => {
    expect(uniqueNames(["a.pdf", "A.pdf", "b/c.pdf", "a.pdf"])).toEqual(["a.pdf", "A (2).pdf", "b_c.pdf", "a (3).pdf"]);
  });
  it("the system unzip lists and extracts every file byte for byte, UTF-8 names included", () => {
    const files = [{ name: "2026-08-24_pyramydair.com_115449859_invoice.pdf", data: Buffer.from("%PDF-1.4 invoice") }, { name: "2026-08-24_pyramydair.com_115449859_shipped – 1.pdf", data: Buffer.from("%PDF-1.4 shipped") }];
    const dir = mkdtempSync(join(tmpdir(), "zz-zip-"));
    try {
      writeFileSync(join(dir, "a.zip"), zipStore(files));
      execFileSync("unzip", ["-tq", join(dir, "a.zip")]); // CRCs and structure
      // Python's zipfile reads the UTF-8 flag (macOS's unzip 6.0 cannot create such names; Archive Utility can)
      const read = execFileSync("python3", ["-I", "-c", "import zipfile,sys,json;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps([[n, z.read(n).decode()] for n in z.namelist()]))", join(dir, "a.zip")]).toString();
      expect(JSON.parse(read)).toEqual(files.map((f) => [f.name, f.data.toString()]));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("GET /api/pos/:id/documents/zip", () => {
  it("named like the invoice (.zip for its extension), the first document when there is no invoice", () => {
    expect(zipNameFor([{ type: "order_confirmation", file_name: "2026-08-24_pyramydair.com_115449859.pdf" }, { type: "invoice", file_name: "2026-08-24_pyramydair.com_115449859_invoice.pdf" }])).toBe("2026-08-24_pyramydair.com_115449859_invoice.zip");
    expect(zipNameFor([{ type: "shipped", file_name: "x_shipped.pdf" }])).toBe("x_shipped.zip");
  });
  it("streams every document of the PO into one zip; 404 without documents; Download all shows from two documents", async () => {
    const PO = "11111111-1111-4111-8111-111111111111";
    const docs = [
      { id: 1, type: "order_confirmation", file_name: "2026-08-24_pyramydair.com_115449859.pdf", drive_file_id: "d1", document_at: new Date("2026-08-24T12:00:00Z") },
      { id: 2, type: "invoice", file_name: "2026-08-24_pyramydair.com_115449859_invoice.pdf", drive_file_id: "d2", document_at: new Date("2026-08-25T12:00:00Z") },
    ];
    const query = (async (sql: string, p: any[]) => ({ rows: /FROM po_documents WHERE po_id/.test(sql) && p[0] === PO ? docs : [] })) as any;
    const drive: any = { files: { get: async ({ fileId, alt }: any) => (alt === "media" ? { data: Readable.from([Buffer.from(`%PDF ${fileId}`)]) } : { data: { mimeType: "application/pdf", size: "8" } }) } };
    const spy = vi.spyOn(documentRouteDeps, "drive").mockReturnValue(drive);
    const layer = (createPoDocumentsRouter(query) as any).stack.find((l: any) => l.route?.path === "/api/pos/:id/documents/zip");
    const call = async (id: string) => {
      const out: any = { headers: {} as Record<string, string>, status: 200, body: null };
      const res: any = { setHeader: (k: string, v: string) => { out.headers[k] = v; }, status: (c: number) => { out.status = c; return res; }, json: (b: any) => { out.body = b; return res; }, end: (b: any) => { out.body = b; } };
      await layer.route.stack[0].handle({ params: { id }, query: {} }, res, () => {});
      return out;
    };
    const ok = await call(PO);
    expect(ok.headers["Content-Type"]).toBe("application/zip");
    expect(ok.headers["Content-Disposition"]).toContain('filename="2026-08-24_pyramydair.com_115449859_invoice.zip"');
    const dir = mkdtempSync(join(tmpdir(), "zz-zip-"));
    try {
      writeFileSync(join(dir, "a.zip"), ok.body);
      const list = execFileSync("unzip", ["-Z1", join(dir, "a.zip")]).toString().trim().split("\n");
      expect(list).toEqual(docs.map((d) => d.file_name));
    } finally { rmSync(dir, { recursive: true, force: true }); }
    expect((await call("22222222-2222-4222-8222-222222222222")).status).toBe(404);
    spy.mockRestore();
    expect(showDownloadAll([1])).toBe(false);
    expect(showDownloadAll([1, 2])).toBe(true);
    expect(zipUrl(PO)).toBe(`/api/pos/${PO}/documents/zip`);
  });
});
