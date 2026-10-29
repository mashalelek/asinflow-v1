// Column resize + persist — the ASINs table's mechanism, shared (PO table v2
// §4: the POs table reuses it, no second one). Widths are per browser in
// localStorage under the caller's key, saved 300 ms after the last move;
// they move into a user-scoped table with the Buy-List-to-DB patch.
import { useState, useRef, useCallback } from "react";

export type ColumnWidths = Record<string, number>;

export function loadColumnWidths(storageKey: string): ColumnWidths {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored) return JSON.parse(stored);
  } catch {}
  return {};
}

export function useColumnWidths(storageKey: string, minWidth = 50) {
  const [colWidths, setColWidths] = useState<ColumnWidths>(() => loadColumnWidths(storageKey));
  const resizeRef = useRef<{ colId: string; startX: number; startW: number } | null>(null);
  const widthSaveTimer = useRef<ReturnType<typeof setTimeout>>();
  // Debounced save to localStorage
  const saveWidths = useCallback((widths: ColumnWidths) => {
    clearTimeout(widthSaveTimer.current);
    widthSaveTimer.current = setTimeout(() => {
      try { localStorage.setItem(storageKey, JSON.stringify(widths)); } catch {}
    }, 300);
  }, [storageKey]);

  const handleResizeStart = useCallback((e: React.MouseEvent, colId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const th = (e.target as HTMLElement).closest("th");
    if (!th) return;
    const startW = th.getBoundingClientRect().width;
    resizeRef.current = { colId, startX: e.clientX, startW };

    const onMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return;
      const delta = ev.clientX - resizeRef.current.startX;
      const newW = Math.max(minWidth, resizeRef.current.startW + delta);
      setColWidths((prev) => {
        const next = { ...prev, [resizeRef.current!.colId]: newW };
        saveWidths(next);
        return next;
      });
    };
    const onUp = () => {
      resizeRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [saveWidths, minWidth]);

  /** Back to the defaults: the stored widths are removed. */
  const resetWidths = useCallback(() => {
    clearTimeout(widthSaveTimer.current);
    try { localStorage.removeItem(storageKey); } catch {}
    setColWidths({});
  }, [storageKey]);

  return { colWidths, handleResizeStart, resetWidths };
}

export function ResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  const lineRef = useRef<HTMLDivElement>(null);
  return (
    <div
      onMouseDown={onMouseDown}
      onMouseEnter={() => { if (lineRef.current) lineRef.current.style.background = "hsl(var(--primary) / 0.5)"; }}
      onMouseLeave={() => { if (lineRef.current) lineRef.current.style.background = "transparent"; }}
      style={{ position: "absolute", right: -3, top: 0, bottom: 0, width: 7, cursor: "col-resize", zIndex: 10 }}
    >
      <div
        ref={lineRef}
        style={{
          position: "absolute",
          right: 3,
          top: "15%",
          bottom: "15%",
          width: 2,
          borderRadius: 1,
          background: "transparent",
          transition: "background 0.15s",
        }}
      />
    </div>
  );
}
