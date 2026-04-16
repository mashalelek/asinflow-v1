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

interface MappingField {
  key: keyof ColumnMapping;
  label: string;
  required: boolean;
  matchPatterns: RegExp[];
}

const MAPPING_FIELDS: MappingField[] = [
  {
    key: "asin",
    label: "ASIN",
    required: true,
    matchPatterns: [/^asin$/i, /\basin\b/i],
  },
  {
    key: "cogs",
    label: "COGS",
    required: true,
    matchPatterns: [/^cogs$/i, /cost\s*of\s*goods/i, /\bcogs\b/i, /\bunit\s*cost\b/i, /\bpurchase\s*price\b/i, /\bprice\s*paid\b/i, /\bbuy\s*cost\b/i, /\bcost\b/i],
  },
  {
    key: "buyLink",
    label: "Buy Link",
    required: false,
    matchPatterns: [/buy\s*link/i, /\blink\b/i, /\burl\b/i, /\bsource\b/i, /supplier\s*link/i],
  },
  {
    key: "prepCost",
    label: "Prep Cost",
    required: false,
    matchPatterns: [/prep\s*cost/i, /\bprep\b/i],
  },
  {
    key: "additionalFees",
    label: "Additional Fees",
    required: false,
    matchPatterns: [/additional\s*fees/i, /storage/i, /\bfees\b/i, /\bmisc\b/i, /\bother\s*fees\b/i, /\bextra\b/i],
  },
  {
    key: "tags",
    label: "Tags",
    required: false,
    matchPatterns: [/^tags?$/i, /\btags?\b/i],
  },
  {
    key: "notes",
    label: "Notes",
    required: false,
    matchPatterns: [/^notes?$/i, /\bnotes?\b/i, /\bcomments?\b/i],
  },
];

const NOT_IN_FILE = "__not_in_file__";

interface ColumnMappingModalProps {
  open: boolean;
  headers: string[];
  onCancel: () => void;
  onContinue: (mapping: ColumnMapping) => void;
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
}: ColumnMappingModalProps) {
  const [mappings, setMappings] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open && headers.length > 0) {
      setMappings(autoMatch(headers));
    }
  }, [open, headers]);

  const canContinue = useMemo(() => {
    return MAPPING_FIELDS.filter((f) => f.required).every(
      (f) => mappings[f.key] && mappings[f.key] !== NOT_IN_FILE
    );
  }, [mappings]);

  const handleChange = (key: string, value: string) => {
    setMappings((prev) => ({ ...prev, [key]: value }));
  };

  const handleContinue = () => {
    const optVal = (key: string) => mappings[key] === NOT_IN_FILE || !mappings[key] ? null : mappings[key];
    const mapping: ColumnMapping = {
      asin: mappings.asin || "",
      cogs: mappings.cogs || "",
      buyLink: optVal("buyLink"),
      prepCost: optVal("prepCost"),
      additionalFees: optVal("additionalFees"),
      tags: optVal("tags"),
      notes: optVal("notes"),
    };
    onContinue(mapping);
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
            const currentValue = mappings[field.key] || "";
            const isMapped = currentValue && currentValue !== NOT_IN_FILE;
            const showWarning = field.required && !isMapped;

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
                  {field.required ? (
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
                    {!field.required && (
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
