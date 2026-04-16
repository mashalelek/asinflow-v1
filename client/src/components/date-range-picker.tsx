import { useState } from "react";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { CalendarDays } from "lucide-react";

interface DateRangePickerProps {
  preset: string;
  onPresetChange: (preset: string) => void;
  customStart: string;
  customEnd: string;
  onCustomStartChange: (date: string) => void;
  onCustomEndChange: (date: string) => void;
  /** Formatted label like "Mar 6 – Apr 5" */
  dateRangeLabel: string;
}

const PRESETS = [
  { value: "last14", label: "Last 14 Days" },
  { value: "last30", label: "Last 30 Days" },
  { value: "thisMonth", label: "This Month" },
  { value: "lastMonth", label: "Last Month" },
] as const;

function fmtDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function DateRangePicker({
  preset,
  onPresetChange,
  customStart,
  customEnd,
  onCustomStartChange,
  onCustomEndChange,
  dateRangeLabel,
}: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [pickingField, setPickingField] = useState<"start" | "end">("start");

  const isCustom = preset === "custom";

  function handlePreset(value: string) {
    onPresetChange(value);
    setOpen(false);
  }

  function handleDayClick(day: Date) {
    const formatted = fmtDate(day);
    if (pickingField === "start") {
      onCustomStartChange(formatted);
      onPresetChange("custom");
      // If end is before start, clear it
      if (customEnd && formatted > customEnd) {
        onCustomEndChange(formatted);
      }
      setPickingField("end");
    } else {
      // If selected day is before start, swap
      if (customStart && formatted < customStart) {
        onCustomEndChange(customStart);
        onCustomStartChange(formatted);
      } else {
        onCustomEndChange(formatted);
      }
      onPresetChange("custom");
      setPickingField("start");
      setOpen(false);
    }
  }

  // Compute selected range for calendar highlighting
  const rangeFrom = customStart ? parseLocalDate(customStart) : undefined;
  const rangeTo = customEnd ? parseLocalDate(customEnd) : undefined;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 text-sm gap-2 font-normal">
          <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
          <span>{dateRangeLabel}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start" sideOffset={8}>
        <div className="flex flex-col">
          {/* Preset buttons */}
          <div className="flex flex-wrap gap-1 p-3 pb-2 border-b border-border">
            {PRESETS.map((p) => (
              <Button
                key={p.value}
                variant={preset === p.value ? "default" : "ghost"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => handlePreset(p.value)}
              >
                {p.label}
              </Button>
            ))}
          </div>

          {/* Calendar */}
          <div className="p-2">
            <div className="text-xs text-muted-foreground text-center mb-1">
              {pickingField === "start" ? "Select start date" : "Select end date"}
              {isCustom && customStart && pickingField === "end" && (
                <span className="ml-1 font-medium">
                  (from {parseLocalDate(customStart).toLocaleDateString("en-US", { month: "short", day: "numeric" })})
                </span>
              )}
            </div>
            <Calendar
              mode="range"
              selected={rangeFrom && rangeTo ? { from: rangeFrom, to: rangeTo } : rangeFrom ? { from: rangeFrom, to: rangeFrom } : undefined}
              onDayClick={handleDayClick}
              numberOfMonths={1}
              defaultMonth={rangeTo ?? rangeFrom ?? new Date()}
              toDate={new Date()}
            />
          </div>

          {/* Custom range display */}
          {isCustom && customStart && customEnd && (
            <div className="px-3 pb-3 text-xs text-muted-foreground text-center">
              {parseLocalDate(customStart).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              {" – "}
              {parseLocalDate(customEnd).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
