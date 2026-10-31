// Types for scrub.js (plain script shared by the extension and the vitest fixtures).
export function luhn(digits: string): boolean;
export function maskCardRuns(text: string): string;
export function removeExpiries(text: string): string;
export function removeCvvs(text: string): string;
export function maskGiftCards(text: string): string;
export function scrubText(text: string): string;
export function scrubField(label: string, value: string): { label: string; value: string } | null;
