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


interface ColumnMappingModalProps {
  open: boolean;
  headers: string[];
  onCancel: () => void;
  onContinue: (mapping: ColumnMapping) => void;
  // §21 bulk page: COGS column may be absent from a supplier catalog.
  // Default (true) preserves the main upload flow exactly.
  cogsRequired?: boolean;
}

function autoMatch(headers: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const usedHeaders = new Set<string>();

  for (const field of MAPPING_FIELDS) {
    for (const header of headers) {
      if (usedHeaders.has(header)) continue;
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
    onContinue(buildColumnMapping(mappings));
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onCancel(); }}>
      <DialogContent className="sm:max-w-md" data-testid="dialog-column-mapping">
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
