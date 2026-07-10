/**
 * Smart discount parser used by the PO entry form (order- and product-level).
 *
 * Behavior per spec:
 *   "15%"  → { amount: 15, type: "percentage" }
 *   "$25"  → { amount: 25, type: "dollar" }
 *   "25"   → { amount: 25, type: "dollar" }
 *   ""     → { amount: 0,  type: "dollar" }
 *
 * Tolerates commas, spaces, and stray $ signs.
 */
import type { DiscType } from "./po-api";

export interface ParsedDiscount {
  amount: number;
  type: Exclude<DiscType, null | undefined>;
}

export function parseDiscount(input: string | number | null | undefined): ParsedDiscount {
  if (input == null) return { amount: 0, type: "dollar" };
  const s = String(input).trim();
  if (s === "") return { amount: 0, type: "dollar" };
  const cleaned = s.replace(/[$,\s]/g, "");
  if (cleaned.includes("%")) {
    const n = parseFloat(cleaned.replace("%", ""));
    return { amount: Number.isFinite(n) ? n : 0, type: "percentage" };
  }
  const n = parseFloat(cleaned);
  return { amount: Number.isFinite(n) ? n : 0, type: "dollar" };
}

/** Format a parsed discount back into the canonical display string. */
export function formatDiscount(amount: number, type: DiscType): string {
  if (!amount || amount === 0) return "";
  if (type === "percentage") return `${amount}%`;
  return `$${amount.toFixed(2)}`;
}
