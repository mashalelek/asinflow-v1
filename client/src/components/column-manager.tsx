import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Columns3, GripVertical, RotateCcw } from "lucide-react";
import { ALL_COLUMNS, type ColumnId } from "@shared/schema";
import { type ColumnConfig, getDefaultConfig, saveColumnConfig } from "@/lib/columns";

interface ColumnManagerProps {
  config: ColumnConfig;
  onChange: (config: ColumnConfig) => void;
}

export function ColumnManager({ config, onChange }: ColumnManagerProps) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  const toggleColumn = useCallback(
    (id: ColumnId) => {
      if (id === "product") return; // product column is always visible
      const next = { ...config, visible: new Set(config.visible) };
      if (next.visible.has(id)) {
        next.visible.delete(id);
      } else {
        next.visible.add(id);
      }
      saveColumnConfig(next);
      onChange(next);
    },
    [config, onChange]
  );

  const resetToDefault = useCallback(() => {
    const def = getDefaultConfig();
    saveColumnConfig(def);
    onChange(def);
  }, [onChange]);

  const handleDragStart = (idx: number) => {
    setDragIdx(idx);
  };

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    if (dragIdx === null || dragIdx === idx) return;

    const newOrder = [...config.order];
    const [moved] = newOrder.splice(dragIdx, 1);
    newOrder.splice(idx, 0, moved);
    setDragIdx(idx);

    const next = { ...config, order: newOrder, visible: new Set(config.visible) };
    saveColumnConfig(next);
    onChange(next);
  };

  const handleDragEnd = () => {
    setDragIdx(null);
  };

  const colMap = new Map(ALL_COLUMNS.map((c) => [c.id, c]));

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="secondary" size="sm" data-testid="button-column-manager">
          <Columns3 className="h-4 w-4 mr-1.5" />
          Columns
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-64 p-0"
        align="end"
        side="bottom"
      >
        <div className="p-3 pb-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">Manage Columns</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={resetToDefault}
              className="h-7 text-xs"
              data-testid="button-reset-columns"
            >
              <RotateCcw className="h-3 w-3 mr-1" />
              Reset
            </Button>
          </div>
        </div>
        <Separator />
        <div className="max-h-[320px] overflow-y-auto p-1">
          {config.order.map((id, idx) => {
            const col = colMap.get(id);
            if (!col) return null;
            return (
              <div
                key={id}
                draggable
                onDragStart={() => handleDragStart(idx)}
                onDragOver={(e) => handleDragOver(e, idx)}
                onDragEnd={handleDragEnd}
                className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-grab active:cursor-grabbing ${
                  dragIdx === idx ? "bg-accent" : ""
                }`}
                data-testid={`column-item-${id}`}
              >
                <GripVertical className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <Checkbox
                  checked={config.visible.has(id)}
                  onCheckedChange={() => toggleColumn(id)}
                  id={`col-${id}`}
                  disabled={id === "product"}
                  data-testid={`checkbox-column-${id}`}
                />
                <label
                  htmlFor={`col-${id}`}
                  className="text-sm cursor-pointer flex-1 select-none"
                >
                  {col.label}
                </label>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
