import { useState, useEffect, useMemo } from "react";
import { AlertTriangle, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ColumnMapping } from "@shared/schema";
import { MAPPING_FIELDS, NOT_IN_FILE, buildColumnMapping } from "./column-mapping";
import { LEAD_SOURCES } from "@shared/schema";

// Radix Select cannot hold an empty-string value, so "no lead source" needs
// a sentinel — the same reason NOT_IN_FILE exists for the column mappings.
const NONE_LEAD_SOURCE = "__none__";


interface ColumnMappingModalProps {
  open: boolean;
  headers: string[];
  onCancel: () => void;
  onContinue: (mapping: ColumnMapping, leadSource: string | null) => void;
  // §21 bulk page: COGS column may be absent from a supplier catalog.
  // Default (true) preserves the main upload flow exactly.
  cogsRequired?: boolean;
}

// Exported for test (2026-10-03): the export -> re-import binding is the
// thing that broke when headers became group-qualified, so the test drives
// THIS function over a real export header row, not a replica of it.
export function autoMatch(headers: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const usedHeaders = new Set<string>();

  for (const field of MAPPING_FIELDS) {
    for (const header of headers) {
      if (usedHeaders.has(header)) continue;
      // §6 (2026-10-03): a header this field must never claim, however well
      // matchPatterns fit. See MappingField.excludePatterns.
      if (field.excludePatterns?.some((re) => re.test(header))) continue;
      for (const pattern of field.matchPatterns) {
        if (pattern.test(header)) {
          result[field.key] = header;
          usedHeaders.add(header);
          break;
        }
      }
      if (result[field.key]) break;
    }
  }

  return result;
}

export function ColumnMappingModal({
  open,
  headers,
  onCancel,
  onContinue,
  cogsRequired = true,
}: ColumnMappingModalProps) {
  const [mappings, setMappings] = useState<Record<string, string>>({});
  // §6 (2026-10-13): one lead source applied to the WHOLE upload. Blank =
  // none. A per-row lead_source column in the file overrides it — the file
  // is more specific than the dropdown.
  const [leadSource, setLeadSource] = useState<string>("");

  useEffect(() => {
    if (open && headers.length > 0) {
      setMappings(autoMatch(headers));
    }
  }, [open, headers]);

  const canContinue = useMemo(() => {
    return MAPPING_FIELDS.filter((f) => f.required && (cogsRequired || f.key !== "cogs")).every(
      (f) => mappings[f.key] && mappings[f.key] !== NOT_IN_FILE
    );
  }, [mappings, cogsRequired]);

  const handleChange = (key: string, value: string) => {
    setMappings((prev) => ({ ...prev, [key]: value }));
  };

  const handleContinue = () => {
    // Serialization is derived from MAPPING_FIELDS (2026-09-08) — the
    // hand-typed literal here silently dropped promos/dateAdded once.
    onContinue(buildColumnMapping(mappings), leadSource || null);
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onCancel(); }}>
      <DialogContent dialogId="column-mapping" className="sm:max-w-md" data-testid="dialog-column-mapping">
        <DialogHeader>
          <DialogTitle data-testid="text-mapping-title">Match your columns</DialogTitle>
          <DialogDescription>
            Map the columns from your file to the required fields. Required fields must be mapped to continue.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {MAPPING_FIELDS.map((field) => {
            const isRequired = field.required && (cogsRequired || field.key !== "cogs");
            const currentValue = mappings[field.key] || "";
            const isMapped = currentValue && currentValue !== NOT_IN_FILE;
            const showWarning = isRequired && !isMapped;

            return (
              <div key={field.key} className="flex items-center gap-3">
                <div className="flex items-center gap-2 w-36 shrink-0">
                  {showWarning ? (
                    <AlertTriangle className="h-4 w-4 text-destructive shrink-0" data-testid={`icon-warning-${field.key}`} />
                  ) : isMapped ? (
                    <Check className="h-4 w-4 text-green-600 dark:text-green-400 shrink-0" data-testid={`icon-check-${field.key}`} />
                  ) : (
                    <div className="h-4 w-4 shrink-0" />
                  )}
                  <span className="text-sm font-medium" data-testid={`text-field-label-${field.key}`}>
                    {field.label}
                  </span>
                  {isRequired ? (
                    <Badge variant="destructive" className="text-[10px] px-1 py-0 no-default-active-elevate" data-testid={`badge-required-${field.key}`}>
                      Required
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="text-[10px] px-1 py-0 no-default-active-elevate" data-testid={`badge-optional-${field.key}`}>
                      Optional
                    </Badge>
                  )}
                </div>

                <Select
                  value={currentValue || ""}
                  onValueChange={(val) => handleChange(field.key, val)}
                >
                  <SelectTrigger className="flex-1" data-testid={`select-mapping-${field.key}`}>
                    <SelectValue placeholder="Select a column..." />
                  </SelectTrigger>
                  <SelectContent>
                    {!isRequired && (
                      <SelectItem value={NOT_IN_FILE} data-testid={`option-not-in-file-${field.key}`}>
                        Not in my file
                      </SelectItem>
                    )}
                    {headers.filter((h) => h !== "").map((header) => (
                      <SelectItem key={header} value={header} data-testid={`option-header-${field.key}-${header}`}>
                        {header}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          })}
        </div>

        {/* §6 (2026-10-13): one lead source for the whole upload. Sits below
            the column mappings because it is NOT a column mapping — it is a
            value applied to every row that does not carry its own. A
            lead_source column in the file overrides it per row. */}
        <div className="border-t pt-3 space-y-1">
          <label className="text-xs font-medium">Lead source</label>
          <Select value={leadSource || NONE_LEAD_SOURCE} onValueChange={(v) => setLeadSource(v === NONE_LEAD_SOURCE ? "" : v)}>
            <SelectTrigger className="h-8 text-xs" data-testid="select-upload-lead-source">
              <SelectValue placeholder="None" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_LEAD_SOURCE}>None</SelectItem>
              {LEAD_SOURCES.map((ls) => (
                <SelectItem key={ls} value={ls}>{ls}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground">
            Applied to every uploaded row. A <code>Lead Source</code> column in the file overrides it per row.
          </p>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onCancel} data-testid="button-mapping-cancel">
            Cancel
          </Button>
          <Button onClick={handleContinue} disabled={!canContinue} data-testid="button-mapping-continue">
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
