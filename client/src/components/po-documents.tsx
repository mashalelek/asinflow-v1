// PO documents (patch po-documents §6; SPEC §22 "PO documents"): the POs
// table's paperclip and the PO's Documents tab. Every download streams
// through AF (/api/pos/documents/:id/download) — the browser never needs
// Drive access.
import { useRef, useState } from "react";
import { Paperclip, Download, ExternalLink, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { DOCUMENT_TYPE_LABEL, type PoDocumentType } from "@shared/po-documents";

export interface PoDocumentLite { id: number; type: PoDocumentType; file_name: string; /** The document's own date (the email's, the Drive file's, the upload's). */ document_at: string }
export interface PoDocument extends PoDocumentLite { bytes: number | null; source: "email" | "upload" | "linked_existing"; drive_url: string; created_by_name: string | null }

export const downloadUrl = (id: number) => `/api/pos/documents/${id}/download`;

/** "Nov 1, 2026" in the viewer's zone. */
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export const SOURCE_LABEL: Record<PoDocument["source"], string> = { email: "Order email", upload: "Uploaded", linked_existing: "Linked from Drive" };

/** Pure: what a paperclip click does — download the one document, list several, or open the Documents tab. */
export function paperclipAction(docs: readonly PoDocumentLite[]): "download" | "menu" | "open_tab" {
  return docs.length === 0 ? "open_tab" : docs.length === 1 ? "download" : "menu";
}

function startDownload(id: number) {
  const a = document.createElement("a");
  a.href = downloadUrl(id); a.download = "";
  document.body.appendChild(a); a.click(); a.remove();
}

/**
 * The POs-table cell. At least one document: the paperclip drawn at full
 * weight, a click downloads it (one) or opens a menu by type and date
 * (several). None: the outline at 40 %, a click opens the Documents tab.
 * The row's own click (open the PO) never fires from here.
 */
export function DocumentsPaperclip({ docs, orderId, onOpenTab }: { docs: readonly PoDocumentLite[]; orderId: string; onOpenTab: () => void }) {
  const action = paperclipAction(docs);
  const has = docs.length > 0;
  const icon = <Paperclip className={has ? "h-3.5 w-3.5 text-foreground/80" : "h-3.5 w-3.5 text-muted-foreground/40"} strokeWidth={has ? 2.25 : 1.5} data-doc={has ? "has" : "none"} />;
  const title = action === "download" ? `Download ${docs[0].file_name}` : action === "menu" ? `${docs.length} documents` : "No documents — open the Documents tab";
  const btn = "inline-flex items-center gap-0.5 rounded px-1 py-0.5 hover:bg-muted";
  if (action === "menu") {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className={btn} title={title} aria-label={title} data-testid={`paperclip-${orderId}`} onClick={(e) => e.stopPropagation()}>
            {icon}<span className="text-[10px] text-muted-foreground">{docs.length}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72" onClick={(e) => e.stopPropagation()}>
          {docs.map((d) => (
            <DropdownMenuItem key={d.id} onSelect={() => startDownload(d.id)} data-testid={`paperclip-item-${d.id}`} title={d.file_name}>
              <Download className="h-3.5 w-3.5 mr-2 shrink-0 text-muted-foreground" />
              <span className="truncate">{DOCUMENT_TYPE_LABEL[d.type]}</span>
              <span className="ml-auto pl-3 text-xs text-muted-foreground whitespace-nowrap">{fmtDay(d.document_at)}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  return (
    <button type="button" className={btn} title={title} aria-label={title} data-testid={`paperclip-${orderId}`}
      onClick={(e) => { e.stopPropagation(); if (action === "download") startDownload(docs[0].id); else onOpenTab(); }}>
      {icon}
    </button>
  );
}

/** Documents tab column widths (px; UI rules: fixed layout, a filler takes the rest). */
export const DOC_COL_WIDTHS = { type: 170, file_name: 380, date: 110, source: 150, actions: 230 } as const;

export function PoDocumentsTab({ poId, documents, onChanged }: { poId: string; documents: readonly PoDocument[]; onChanged: () => void }) {
  const { toast } = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<PoDocument | null>(null);

  async function upload(file: File) {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/pos/${poId}/documents`, { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      onChanged();
    } catch (e: any) {
      toast({ title: "Invoice not uploaded", description: e?.message ?? String(e), variant: "destructive" });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function remove(d: PoDocument) {
    try {
      const res = await fetch(`/api/pos/documents/${d.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      onChanged();
    } catch (e: any) {
      toast({ title: "Document not deleted", description: e?.message ?? String(e), variant: "destructive" });
    }
  }

  const w = DOC_COL_WIDTHS;
  return (
    <div className="space-y-3" data-testid="po-documents-tab">
      <div className="flex items-center gap-3">
        <input ref={input} type="file" accept="application/pdf,image/*" className="hidden" data-testid="input-upload-invoice"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
        <Button variant="outline" size="sm" disabled={busy} onClick={() => input.current?.click()} data-testid="button-upload-invoice">
          <Upload className="h-3.5 w-3.5 mr-1" /> {busy ? "Uploading…" : "Upload invoice"}
        </Button>
        <span className="text-xs text-muted-foreground">A PDF or an image (converted to PDF), saved to Drive as the PO's invoice.</span>
      </div>
      {documents.length === 0 ? (
        <div className="text-sm text-muted-foreground py-6" data-testid="po-documents-empty">No documents yet. Order emails are saved here automatically once they match this PO.</div>
      ) : (
        <div className="rounded-md overflow-hidden" style={{ border: "0.5px solid hsl(var(--border))" }}>
          <table className="border-collapse text-sm table-fixed w-full">
            <colgroup>
              <col style={{ width: w.type }} /><col style={{ width: w.file_name }} /><col style={{ width: w.date }} /><col style={{ width: w.source }} /><col style={{ width: w.actions }} /><col />
            </colgroup>
            <thead>
              <tr className="table-header-stone text-xs">
                <th className="px-3 py-2 text-left font-medium">Type</th>
                <th className="px-3 py-2 text-left font-medium">File name</th>
                <th className="px-3 py-2 text-left font-medium">Date</th>
                <th className="px-3 py-2 text-left font-medium">Source</th>
                <th className="px-3 py-2 text-left font-medium"></th>
                <th aria-hidden />
              </tr>
            </thead>
            <tbody>
              {documents.map((d) => (
                <tr key={d.id} className="border-t border-border" data-testid={`po-document-${d.id}`}>
                  <td className="px-3 py-2 truncate">{DOCUMENT_TYPE_LABEL[d.type]}</td>
                  <td className="px-3 py-2 truncate font-mono text-xs" title={d.file_name}>{d.file_name}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{fmtDay(d.document_at)}</td>
                  <td className="px-3 py-2 truncate" title={d.created_by_name ? `${SOURCE_LABEL[d.source]} by ${d.created_by_name}` : SOURCE_LABEL[d.source]}>{SOURCE_LABEL[d.source]}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <a href={downloadUrl(d.id)} download className="inline-flex items-center rounded px-1.5 py-1 text-xs hover:bg-muted" data-testid={`button-download-${d.id}`}>
                      <Download className="h-3.5 w-3.5 mr-1" />Download
                    </a>
                    <a href={d.drive_url} target="_blank" rel="noreferrer" className="inline-flex items-center rounded px-1.5 py-1 text-xs hover:bg-muted" data-testid={`button-open-drive-${d.id}`}>
                      <ExternalLink className="h-3.5 w-3.5 mr-1" />Open in Drive
                    </a>
                    <button type="button" onClick={() => setConfirm(d)} className="inline-flex items-center rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted" title="Delete" aria-label="Delete" data-testid={`button-delete-document-${d.id}`}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                  <td aria-hidden />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <AlertDialog open={confirm != null} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <AlertDialogContent dialogId="po-document-delete">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this document?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.source === "linked_existing"
                ? <>The link to <span className="font-mono text-xs break-all">{confirm?.file_name}</span> is removed from this PO. The file was in Drive before AF and stays there, untouched.</>
                : <><span className="font-mono text-xs break-all">{confirm?.file_name}</span> is removed from this PO and moved to Drive's trash (recoverable there for 30 days).</>}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-document">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { const d = confirm; setConfirm(null); if (d) void remove(d); }} data-testid="button-confirm-delete-document">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
