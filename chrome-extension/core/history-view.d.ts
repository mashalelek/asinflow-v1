// Types for core/history-view.js (a plain extension script, tested in server/extension-history.test.ts).
export interface HistoryLine { k: string; v: string; recent?: boolean }
export function historyLines(h: unknown, showSupplier?: boolean, thisYear?: number): HistoryLine[];
export function renderHistory(box: unknown, hist: unknown, opts?: { showSupplier?: boolean }): void;
export function fmtDate(d: string | null | undefined): string;
