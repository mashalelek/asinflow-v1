// PO documents — the Documents tab and the paperclip (patch po-documents §6;
// SPEC §22 "PO documents"). Mounted after requireAuth. Downloads stream
// through AF, so the browser never needs Drive access.
//
//   GET    /api/pos/:id/documents               the PO's documents
//   GET    /api/pos/documents/:docId/download   the PDF (?inline=1 opens it in the tab)
//   POST   /api/pos/:id/documents               upload an invoice: a PDF, or an image converted to PDF (D3: `_invoice`)
//   DELETE /api/pos/documents/:docId            an AF file (email / upload) goes to Drive's trash; a linked
//                                               existing file is only unlinked — AF never deletes a file it
//                                               did not create (Maria 2026-11-04)
//
// An upload or a delete writes a History row (po_edit_log entity 'document').
import express, { type Router, type Request, type Response } from "express";
import multer from "multer";
import { query as defaultQuery } from "./db";
import { driveClient, ensureMonthFolder, folderFileNames, uploadPdf, downloadFile, trashFile, driveFileUrl } from "./drive-client";
import { renderHtmlToPdf } from "./pdf-render";
import { documentBaseName, nextDocumentFileName, orderYmd } from "@shared/po-documents";
import type { QueryLike } from "./scheduler/types";
import type { drive_v3 } from "googleapis";

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp|heic|heif|avif)$/i;

/** Test seams. */
export const documentRouteDeps = {
  drive: (): drive_v3.Drive => driveClient(),
  imageToPdf: async (data: Buffer, mime: string): Promise<Buffer> =>
    (await renderHtmlToPdf(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}img{display:block;max-width:100%;max-height:9.9in;margin:0 auto;object-fit:contain}</style></head><body><img src="data:${mime};base64,${data.toString("base64")}"></body></html>`)).pdf,
};

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const userId = (req: Request): number | null => req.session?.userId ?? null;

/** The POs list's per-row documents (the paperclip and its menu), oldest first; `p` = purchase_orders. */
export const PO_DOCUMENTS_SQL = `(SELECT COALESCE(json_agg(json_build_object('id', d.id, 'type', d.type, 'file_name', d.file_name, 'document_at', COALESCE(d.document_at, d.created_at)) ORDER BY COALESCE(d.document_at, d.created_at), d.id), '[]'::json) FROM po_documents d WHERE d.po_id = p.id)`;

export interface PoDocumentRow {
  id: number; po_id: string; type: string; file_name: string; bytes: number | null; document_at: string;
  source: string; gmail_message_id: string | null; drive_url: string; created_by_name: string | null;
}

export async function listPoDocuments(query: QueryLike, poId: string): Promise<PoDocumentRow[]> {
  const rows = (await query(
    `SELECT d.id, d.po_id, d.type, d.file_name, d.bytes, COALESCE(d.document_at, d.created_at) AS document_at, d.source, d.gmail_message_id, d.drive_file_id, u.display_name AS created_by_name
       FROM po_documents d LEFT JOIN users u ON u.id = d.created_by_user_id
      WHERE d.po_id = $1 ORDER BY COALESCE(d.document_at, d.created_at), d.id`, [poId],
  )).rows;
  return rows.map((r: any) => ({
    id: Number(r.id), po_id: String(r.po_id), type: r.type, file_name: r.file_name, bytes: r.bytes == null ? null : Number(r.bytes),
    document_at: new Date(r.document_at).toISOString(), source: r.source, gmail_message_id: r.gmail_message_id ?? null,
    drive_url: driveFileUrl(String(r.drive_file_id)), created_by_name: r.created_by_name ?? null,
  }));
}

async function history(query: QueryLike, poId: string, uid: number | null, docId: number, oldValue: string | null, newValue: string | null) {
  await query(`INSERT INTO po_edit_log (po_id, user_id, entity, entity_id, field, old_value, new_value) VALUES ($1, $2, 'document', $3, 'document', $4, $5)`,
    [poId, uid, String(docId), oldValue, newValue]);
}

/** Upload: the file as a PDF, named `<§2 name>_invoice[-N].pdf` in the PO's month folder (D2 / D3). */
export async function uploadInvoice(query: QueryLike, drive: drive_v3.Drive, poId: string, file: { buffer: Buffer; mimetype: string; originalname: string }, uid: number | null): Promise<PoDocumentRow> {
  const po = (await query(`SELECT id, order_date, supplier, order_id FROM purchase_orders WHERE id = $1`, [poId])).rows[0];
  if (!po) throw Object.assign(new Error("PO not found"), { status: 404 });
  const isPdf = file.mimetype === "application/pdf" || (/\.pdf$/i.test(file.originalname) && file.buffer.subarray(0, 5).toString() === "%PDF-");
  if (!isPdf && !IMAGE_TYPES.test(file.mimetype)) throw Object.assign(new Error("Upload a PDF or an image"), { status: 400 });
  const pdf = isPdf ? file.buffer : await documentRouteDeps.imageToPdf(file.buffer, file.mimetype);
  const folder = await ensureMonthFolder(drive, orderYmd(po.order_date));
  const onPo = (await query(`SELECT file_name FROM po_documents WHERE po_id = $1`, [poId])).rows.map((r: any) => String(r.file_name));
  const name = nextDocumentFileName(documentBaseName(po), "invoice_manual", [...(await folderFileNames(drive, folder.id)), ...onPo]);
  const up = await uploadPdf(drive, folder.id, name, pdf);
  const id = Number((await query(
    `INSERT INTO po_documents (po_id, type, drive_file_id, file_name, bytes, document_at, created_by_user_id, source) VALUES ($1, 'invoice_manual', $2, $3, $4, NOW(), $5, 'upload') RETURNING id`,
    [poId, up.id, name, up.bytes, uid],
  )).rows[0].id);
  await history(query, poId, uid, id, null, name);
  return (await listPoDocuments(query, poId)).find((d) => d.id === id)!;
}

/** Delete: AF's own file to Drive's trash, then the row; a linked existing file is never touched — only the link goes. */
export async function deleteDocument(query: QueryLike, drive: drive_v3.Drive, docId: number, uid: number | null): Promise<{ trashed: boolean }> {
  const d = (await query(`SELECT id, po_id, drive_file_id, file_name, source FROM po_documents WHERE id = $1`, [docId])).rows[0];
  if (!d) throw Object.assign(new Error("document not found"), { status: 404 });
  const trashed = d.source !== "linked_existing";
  if (trashed) await trashFile(drive, String(d.drive_file_id));
  await query(`DELETE FROM po_documents WHERE id = $1`, [docId]);
  await history(query, String(d.po_id), uid, docId, d.file_name, null);
  return { trashed };
}

export function createPoDocumentsRouter(query: QueryLike = (sql, params) => defaultQuery(sql, params)): Router {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });
  const fail = (res: Response, err: any) => res.status(err?.status ?? 500).json({ message: String(err?.message ?? err) });

  router.get("/api/pos/:id/documents", async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    if (!isUuid(id)) return res.status(404).json({ message: "PO not found" });
    try { res.json({ documents: await listPoDocuments(query, id) }); } catch (err) { fail(res, err); }
  });

  router.get("/api/pos/documents/:docId/download", async (req: Request, res: Response) => {
    const docId = Number(req.params.docId);
    try {
      const d = (await query(`SELECT drive_file_id, file_name FROM po_documents WHERE id = $1`, [Number.isFinite(docId) ? docId : -1])).rows[0];
      if (!d) return res.status(404).json({ message: "document not found" });
      const f = await downloadFile(documentRouteDeps.drive(), String(d.drive_file_id));
      res.setHeader("Content-Type", f.mimeType ?? "application/pdf");
      if (f.size != null) res.setHeader("Content-Length", String(f.size));
      const disp = req.query.inline === "1" ? "inline" : "attachment";
      res.setHeader("Content-Disposition", `${disp}; filename="${String(d.file_name).replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'")}"; filename*=UTF-8''${encodeURIComponent(String(d.file_name))}`);
      f.stream.on("error", (err) => { if (!res.headersSent) fail(res, err); else res.destroy(err as Error); });
      f.stream.pipe(res);
    } catch (err) { fail(res, err); }
  });

  router.post("/api/pos/:id/documents", (req: Request, res: Response, next) => {
    upload.single("file")(req, res, (err: any) => {
      if (err) return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ message: err.code === "LIMIT_FILE_SIZE" ? "The file is over 20 MB" : String(err.message ?? err) });
      next();
    });
  }, async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    if (!isUuid(id)) return res.status(404).json({ message: "PO not found" });
    const file = (req as any).file as { buffer: Buffer; mimetype: string; originalname: string } | undefined;
    if (!file) return res.status(400).json({ message: "No file" });
    try { res.json({ document: await uploadInvoice(query, documentRouteDeps.drive(), id, file, userId(req)) }); } catch (err) { fail(res, err); }
  });

  router.delete("/api/pos/documents/:docId", async (req: Request, res: Response) => {
    const docId = Number(req.params.docId);
    if (!Number.isFinite(docId)) return res.status(404).json({ message: "document not found" });
    try { res.json(await deleteDocument(query, documentRouteDeps.drive(), docId, userId(req))); } catch (err) { fail(res, err); }
  });

  return router;
}
