/**
 * /pos/:id/edit — Edit PO as a full page (Maria 2026-11-04), replacing the
 * centered dialog: the New PO form's layout and components (order rows A–D,
 * lines as bought with ↳ ASIN rows, promos, payments, the three costs, the
 * adjustment, the footer), prefilled from GET /api/pos/:id/form. No prefill
 * banner; a "Last edited" line; Save = PUT /api/pos/:id/form, one History row
 * per changed field (server/po-edit-form.ts); the pack override works as on
 * New. Refunds per line stay on the detail page's Payments tab. Cancel and a
 * save both return to the PO.
 */
import { useEffect, useState } from "react";
import { useLocation, useParams } from "wouter";
import { NewPoForm, type EditPoContext, type AsinInfo } from "@/components/new-po-dialog";
import { useToast } from "@/hooks/use-toast";
import type { PoFormState } from "@shared/po-form";

interface FormLoad {
  form: PoFormState; imported: boolean; stored_costs: EditPoContext["storedCosts"];
  po: { id: string; supplier: string; order_id: string; closed_at: string | null };
  last_edit: EditPoContext["lastEdit"]; known: AsinInfo[];
}

export default function PoEditPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [load, setLoad] = useState<FormLoad | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLoad(null); setError(null);
    fetch(`/api/pos/${encodeURIComponent(id)}/form`)
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || `HTTP ${r.status}`); return r.json(); })
      .then((d: FormLoad) => { if (!cancelled) setLoad(d); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [id]);
  const back = () => navigate(`/purchase-orders/${id}`);
  if (error) return <div className="px-6 py-8 text-sm text-destructive" data-testid="po-edit-error">{error}</div>;
  if (!load) return <div className="px-6 py-8 text-sm text-muted-foreground" data-testid="po-edit-loading">Loading the PO…</div>;
  const edit: EditPoContext = {
    poId: load.po.id, form: load.form, imported: load.imported, storedCosts: load.stored_costs, lastEdit: load.last_edit, known: load.known, closed: load.po.closed_at != null,
    onSaved: (r) => { toast({ title: r.changes > 0 ? `PO saved (${r.changes} change${r.changes === 1 ? "" : "s"} in History)` : "No changes to save", description: r.warning ?? undefined }); back(); },
  };
  return (
    <div className="px-6 pt-3">
      <NewPoForm open edit={edit} onOpenChange={(v) => { if (!v) back(); }} onCreated={() => back()} />
    </div>
  );
}
