/**
 * Inline notes (Maria 2026-11-04): one editor for every note on the PO
 * pages — the POs table's Notes cell, the expanded ASIN rows and product
 * lines, the Products tab and the PO Details NOTES box. Since 2026-11-05
 * every notes field in AF (Maria: "notes everywhere"): the ASINs / Bulk Calc
 * / ASIN Analytics Notes and Promos columns, Subscriptions, PO refunds — a
 * column that showed the note's text keeps showing it (showText).
 *
 * Hover the icon shows the full note; a click opens a textarea in place.
 * Enter saves, Shift+Enter is a newline, Esc cancels, blur saves. The
 * caller PATCHes the field (the server writes the History row); a toast
 * appears only when the save fails. Icon filled = a note, outline = none.
 */
import React, { useEffect, useRef, useState } from "react";
import { StickyNote } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";

/** What a key does in the note textarea. */
export function noteKeyAction(e: { key: string; shiftKey?: boolean; nativeEvent?: { isComposing?: boolean } }): "save" | "cancel" | null {
  if (e.key === "Escape") return "cancel";
  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent?.isComposing) return "save";
  return null;
}

/** The value to send, or undefined when nothing changed: ends trimmed, blank = no note (null). */
export function nextNoteValue(draft: string, stored: string | null | undefined): string | null | undefined {
  const next = draft.trim() === "" ? null : draft.trim();
  return next === ((stored ?? "").trim() || null) ? undefined : next;
}

/** The note icon: filled when a note exists, outline when empty — the same muted colour either way. */
export function NoteIcon({ has, className = "h-3.5 w-3.5" }: { has: boolean; className?: string }) {
  return <StickyNote className={`${className} ${has ? "text-muted-foreground" : "text-muted-foreground/40"}`} fill={has ? "currentColor" : "none"} fillOpacity={has ? 0.35 : undefined} data-note={has ? "filled" : "empty"} />;
}

function useNoteEditor(value: string | null | undefined, onSave: (v: string | null) => Promise<void>) {
  const { toast } = useToast();
  const [shown, setShown] = useState<string | null>(value ?? null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const done = useRef(true);
  useEffect(() => { setShown(value ?? null); }, [value]);
  const start = () => { setDraft(shown ?? ""); done.current = false; setEditing(true); };
  const finish = (save: boolean) => {
    if (done.current) return; // blur, Esc and the popover's close can all arrive for one edit
    done.current = true;
    setEditing(false);
    if (!save) return;
    const next = nextNoteValue(draft, shown);
    if (next === undefined) return;
    const before = shown;
    setShown(next);
    onSave(next).catch((e: any) => { setShown(before); toast({ title: "Note not saved", description: e?.message ?? String(e), variant: "destructive" }); });
  };
  const textareaProps = {
    autoFocus: true,
    value: draft,
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: () => finish(true),
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
    onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      e.stopPropagation();
      const a = noteKeyAction(e);
      if (a) { e.preventDefault(); finish(a === "save"); }
    },
    onFocus: (e: React.FocusEvent<HTMLTextAreaElement>) => { const n = e.target.value.length; e.target.setSelectionRange(n, n); },
  };
  return { shown, editing, start, finish, textareaProps };
}

/** A table cell's note: the icon, the full note on hover, the textarea in a popover anchored to the cell. */
export function InlineNoteCell({ value, onSave, testId, label = "note", className = "", showText = false, emptyLabel }: {
  value: string | null | undefined; onSave: (v: string | null) => Promise<void>; testId: string; label?: string;
  /** Classes for the click target — pass the cell's padding here and give the td p-0, so the whole cell opens the editor. */
  className?: string;
  /** The note's first line as truncated text instead of the icon (columns that always showed the text); empty → emptyLabel. */
  showText?: boolean; emptyLabel?: string;
}) {
  const ed = useNoteEditor(value, onSave);
  const has = !!ed.shown;
  return (
    <Popover open={ed.editing} onOpenChange={(o) => { if (o) ed.start(); else ed.finish(true); }}>
      <Tooltip open={ed.editing || !has ? false : undefined}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button type="button" onClick={(e) => e.stopPropagation()} aria-label={has ? `Edit ${label}` : `Add ${label}`}
              className={`flex w-full min-w-0 items-center text-left ${className}`} data-testid={`note-${testId}`}>
              {showText
                ? (has ? <span className="truncate text-sm text-muted-foreground" data-testid={`note-text-${testId}`}>{ed.shown}</span> : <span className="text-sm text-muted-foreground/50">{emptyLabel ?? `+ ${label}`}</span>)
                : <NoteIcon has={has} />}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        {has && <TooltipContent side="top" className="max-w-sm"><p className="whitespace-pre-wrap text-xs" data-testid={`note-tip-${testId}`}>{ed.shown}</p></TooltipContent>}
      </Tooltip>
      <PopoverContent align="end" side="bottom" className="w-80 p-2" onClick={(e) => e.stopPropagation()}
        onEscapeKeyDown={() => ed.finish(false)} onOpenAutoFocus={(e) => e.preventDefault()}
        // Focus stays where the click left it — returning it to the icon popped the hover tooltip open after every save.
        onCloseAutoFocus={(e) => e.preventDefault()}>
        <textarea {...ed.textareaProps} rows={4} placeholder={`Add a ${label}`}
          className="w-full resize-y rounded border border-input bg-background px-2 py-1 text-sm" data-testid={`note-input-${testId}`} />
        <div className="mt-1 text-[11px] text-muted-foreground">Enter saves · Shift+Enter new line · Esc cancels</div>
      </PopoverContent>
    </Popover>
  );
}

/** A note shown as text (PO Details NOTES box): click the text to edit it in place. */
export function InlineNoteBox({ value, onSave, testId, label = "note" }: { value: string | null | undefined; onSave: (v: string | null) => Promise<void>; testId: string; label?: string }) {
  const ed = useNoteEditor(value, onSave);
  if (ed.editing) {
    return (
      <div>
        <textarea {...ed.textareaProps} rows={4} placeholder={`Add a ${label}`}
          className="w-full resize-y rounded border border-input bg-background px-2 py-1 text-sm" data-testid={`note-input-${testId}`} />
        <div className="mt-1 text-[11px] text-muted-foreground">Enter saves · Shift+Enter new line · Esc cancels</div>
      </div>
    );
  }
  return (
    <button type="button" onClick={ed.start} className="block w-full text-left rounded hover:bg-muted/40" title="Click to edit" data-testid={`note-${testId}`}>
      {ed.shown ? <span className="whitespace-pre-wrap text-sm">{ed.shown}</span> : <span className="text-sm text-muted-foreground/50">Add a {label}</span>}
    </button>
  );
}
