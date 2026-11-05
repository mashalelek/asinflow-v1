// Types for core/history-view.js (a plain extension script, tested in server/extension-history.test.ts).
export interface HistoryLine { k: string; v: string; recent?: boolean; promos?: string }
export interface ThisPoLine { k: string; v: string; note?: boolean | string; strong?: boolean; neg?: boolean }
export function historyLines(h: unknown, showSupplier?: boolean, thisYear?: number): HistoryLine[];
export function renderHistory(box: unknown, hist: unknown, opts?: { showSupplier?: boolean; thisPo?: unknown; onSale?: (v: number | null) => void; sale?: number | null }): void;
export function thisPoLines(t: unknown, now?: number): ThisPoLine[];
export function thisPoTotals(list: unknown[]): { units: number; cogs: number; profit: number | null; priced: number; of: number; estimate: boolean } | null;
export function codeLines(codes: unknown[], appliedText?: string, thisYear?: number): { code: string; v: string; applied: boolean }[];
export function ago(iso: string | null | undefined, now?: number): string;
export function vsLast(f: number | null | undefined): string;
export function fmtDate(d: string | null | undefined): string;
