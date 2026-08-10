import { useState, useRef, useEffect } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";

interface NoteEditorProps {
  asin: string;
  currentNote: string | null;
  onNoteChanged: (note: string | null) => void;
  // Field variant (Promos reuses the exact Notes interaction, §6). Defaults
  // preserve the Notes cell byte-for-byte. Empty input always saves NULL,
  // never an empty string (the save path trims and coalesces).
  saveUrl?: string;      // default /api/asins/:asin/notes
  bodyField?: string;    // default "notes"
  placeholder?: string;  // default "Add a note..."
  emptyLabel?: string;   // default "+ note"
}

export function NoteEditor({
  asin, currentNote, onNoteChanged,
  saveUrl, bodyField = "notes", placeholder = "Add a note...", emptyLabel = "+ note",
}: NoteEditorProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(currentNote ?? "");
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setText(currentNote ?? "");
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [open, currentNote]);

  async function save() {
    setSaving(true);
    try {
      await fetch(saveUrl ?? `/api/asins/${asin}/notes`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [bodyField]: text.trim() || null }),
      });
      onNoteChanged(text.trim() || null);
      setOpen(false);
    } catch {}
    setSaving(false);
  }

  const display = currentNote;
  const truncated = display && display.length > 30 ? display.substring(0, 30) + "..." : display;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div className="cursor-pointer min-h-[20px]" onClick={(e) => e.stopPropagation()}>
          {display ? (
            display.length > 30 ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-sm text-muted-foreground cursor-help">{truncated}</span>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-[300px]">
                  <p className="text-xs whitespace-pre-wrap">{display}</p>
                </TooltipContent>
              </Tooltip>
            ) : (
              <span className="text-sm text-muted-foreground">{display}</span>
            )
          ) : (
            <span className="text-muted-foreground/50 text-sm">{emptyLabel}</span>
          )}
        </div>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" align="start" sideOffset={4} onClick={(e) => e.stopPropagation()}>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="w-full h-24 text-sm p-2 rounded border border-border bg-background resize-none focus:outline-none focus:ring-1 focus:ring-ring"
          placeholder={placeholder}
        />
        <div className="flex justify-end gap-2 mt-2">
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" className="h-7 text-xs" onClick={save} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
