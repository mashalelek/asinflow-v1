// The copy icon (the ASINs page's Product cell, shared since 2026-11-18 with the Claims list and claim detail — Maria):
// a click copies the value, the icon reads "copied" for a moment, and the click never opens the row or follows the link.
import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export const COPIED_FOR_MS = 1500;

export function CopyValueButton({ value, label, testId, className = "ml-1 text-muted-foreground hover:text-foreground transition-colors" }: { value: string; /** The tooltip: "Copy ASIN", "Copy order #". */ label: string; testId: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  function handleCopy(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_FOR_MS);
    });
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" onClick={handleCopy} className={className} aria-label={label} data-testid={testId}>
          {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p className="text-xs">{copied ? "Copied!" : label}</p>
      </TooltipContent>
    </Tooltip>
  );
}
