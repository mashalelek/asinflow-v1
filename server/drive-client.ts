// Google Drive client for PO documents (patch po-documents §2, §7, D1–D2;
// SPEC §22 "PO documents"). The same service account as Gmail and Sheets
// (GOOGLE_CREDENTIALS_PATH, asinflow-sheets) with domain-wide delegation,
// writing as Maria (DRIVE_SUBJECT overrides), full Drive scope — her folders
// were created by her, not by AF.
//
// AF only ever touches files under the Invoices root (D1). It adds files and
// creates missing year / month folders; it never renames or moves a file,
// and deletes (trashes) only a file AF itself created (the caller checks
// the document's source; trashFile re-checks the root).
//
// Dependency-free of ./index (it boots Express): scripts import this.
import { readFileSync } from "fs";
import { Readable } from "stream";
import { google, type drive_v3 } from "googleapis";
import { yearFolderName, monthFolderName, monthFolderNames, type DriveFileLite } from "@shared/po-documents";

export const DRIVE_SUBJECT = process.env.DRIVE_SUBJECT || "maria@coastalqualitygoods.com";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
export const INVOICES_ROOT_ID = process.env.DRIVE_INVOICES_ROOT_ID || "1oBeUBKnmpjfcxcwD_w-hCAPLCd-Bbm13";
export const FOLDER_MIME = "application/vnd.google-apps.folder";

export function driveClient(subject: string = DRIVE_SUBJECT): drive_v3.Drive {
  const keyFile = process.env.GOOGLE_CREDENTIALS_PATH;
  if (!keyFile) throw new Error("GOOGLE_CREDENTIALS_PATH not configured");
  // email + key explicitly, as gmail-client.ts: JWT({keyFile}) leaves the issuer null.
  const cred = JSON.parse(readFileSync(keyFile, "utf8")) as { client_email: string; private_key: string };
  const auth = new google.auth.JWT({ email: cred.client_email, key: cred.private_key, scopes: [DRIVE_SCOPE], subject });
  return google.drive({ version: "v3", auth });
}

/** Drive query string literal: backslash and single quote escaped. */
const lit = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

async function listChildren(drive: drive_v3.Drive, parentId: string, extra = ""): Promise<drive_v3.Schema$File[]> {
  const out: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;
  do {
    const r = await drive.files.list({
      q: `${lit(parentId)} in parents and trashed = false${extra}`, pageSize: 1000, pageToken,
      fields: "nextPageToken, files(id, name, mimeType, size, parents)", supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    out.push(...(r.data.files ?? []));
    pageToken = r.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

export interface DriveTree { files: Array<DriveFileLite & { parentId: string }>; folders: Array<{ id: string; name: string; parentId: string; path: string }> }

/** Every file and folder under the root (any depth), with each file's folder path — decision 3: linking searches the whole root. */
export async function listInvoiceTree(drive: drive_v3.Drive, rootId: string = INVOICES_ROOT_ID): Promise<DriveTree> {
  const tree: DriveTree = { files: [], folders: [] };
  const queue: Array<{ id: string; path: string }> = [{ id: rootId, path: "" }];
  while (queue.length) {
    const { id, path } = queue.shift()!;
    for (const f of await listChildren(drive, id)) {
      if (f.mimeType === FOLDER_MIME) {
        const p = path ? `${path}/${f.name}` : String(f.name);
        tree.folders.push({ id: String(f.id), name: String(f.name), parentId: id, path: p });
        queue.push({ id: String(f.id), path: p });
      } else {
        tree.files.push({ id: String(f.id), name: String(f.name), mimeType: f.mimeType ?? null, size: f.size == null ? null : Number(f.size), path, parentId: id });
      }
    }
  }
  return tree;
}

async function findFolder(drive: drive_v3.Drive, parentId: string, names: string[]): Promise<{ id: string; name: string } | null> {
  const kids = await listChildren(drive, parentId, ` and mimeType = ${lit(FOLDER_MIME)}`);
  for (const n of names) { const f = kids.find((k) => k.name === n); if (f) return { id: String(f.id), name: n }; }
  return null;
}

async function createFolder(drive: drive_v3.Drive, parentId: string, name: string): Promise<string> {
  const r = await drive.files.create({ requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId] }, fields: "id", supportsAllDrives: true });
  return String(r.data.id);
}

export interface MonthFolder { id: string; name: string; created: string[] }

/**
 * D2: `Invoices - YYYY / <month>` for an order date — the month folder under
 * either spelling (`Invoices YYYY-MM`, `Receipts_YYYY-MM`), created as
 * `Invoices YYYY-MM` only when neither exists; never a folder whose exact
 * name already exists under the parent. `dryRun` creates nothing and
 * reports what it would create.
 */
export async function ensureMonthFolder(drive: drive_v3.Drive, ymd: string, opts: { rootId?: string; dryRun?: boolean } = {}): Promise<MonthFolder> {
  const rootId = opts.rootId ?? INVOICES_ROOT_ID;
  const created: string[] = [];
  let year = await findFolder(drive, rootId, [yearFolderName(ymd)]);
  if (!year) {
    created.push(yearFolderName(ymd));
    if (opts.dryRun) return { id: "", name: monthFolderName(ymd), created: [...created, monthFolderName(ymd)] };
    year = { id: await createFolder(drive, rootId, yearFolderName(ymd)), name: yearFolderName(ymd) };
  }
  const month = await findFolder(drive, year.id, monthFolderNames(ymd));
  if (month) return { ...month, created };
  created.push(monthFolderName(ymd));
  if (opts.dryRun) return { id: "", name: monthFolderName(ymd), created };
  return { id: await createFolder(drive, year.id, monthFolderName(ymd)), name: monthFolderName(ymd), created };
}

/** File names already in a folder (the collision check for -2, -3). */
export async function folderFileNames(drive: drive_v3.Drive, folderId: string): Promise<string[]> {
  return (await listChildren(drive, folderId, ` and mimeType != ${lit(FOLDER_MIME)}`)).map((f) => String(f.name));
}

export async function uploadPdf(drive: drive_v3.Drive, folderId: string, name: string, pdf: Buffer): Promise<{ id: string; bytes: number }> {
  const r = await drive.files.create({
    requestBody: { name, mimeType: "application/pdf", parents: [folderId] },
    media: { mimeType: "application/pdf", body: Readable.from(pdf) },
    fields: "id, size", supportsAllDrives: true,
  });
  return { id: String(r.data.id), bytes: r.data.size == null ? pdf.length : Number(r.data.size) };
}

/** True when the file sits under the root at any depth (parents walked up to the root). */
export async function isUnderRoot(drive: drive_v3.Drive, fileId: string, rootId: string = INVOICES_ROOT_ID): Promise<boolean> {
  let id: string | undefined = fileId;
  for (let depth = 0; id && depth < 10; depth++) {
    const r: { data: drive_v3.Schema$File } = await drive.files.get({ fileId: id, fields: "parents", supportsAllDrives: true });
    const parent = r.data.parents?.[0];
    if (!parent) return false;
    if (parent === rootId) return true;
    id = parent;
  }
  return false;
}

export async function downloadFile(drive: drive_v3.Drive, fileId: string): Promise<{ stream: Readable; mimeType: string | null; size: number | null }> {
  const meta = await drive.files.get({ fileId, fields: "mimeType, size", supportsAllDrives: true });
  const r = await drive.files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "stream" });
  return { stream: r.data as unknown as Readable, mimeType: meta.data.mimeType ?? null, size: meta.data.size == null ? null : Number(meta.data.size) };
}

/** Trash (recoverable for 30 days in Drive) a file AF created; refuses anything outside the Invoices root. */
export async function trashFile(drive: drive_v3.Drive, fileId: string, rootId: string = INVOICES_ROOT_ID): Promise<void> {
  if (!(await isUnderRoot(drive, fileId, rootId))) throw new Error("file is not under the Invoices root — not touched");
  await drive.files.update({ fileId, requestBody: { trashed: true }, supportsAllDrives: true });
}

export const driveFileUrl = (id: string) => `https://drive.google.com/file/d/${id}/view`;
