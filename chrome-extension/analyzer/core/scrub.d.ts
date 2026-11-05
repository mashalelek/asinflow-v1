// Types for scrub.js (plain script shared by the extension and the vitest fixtures).
export function luhn(digits: string): boolean;
export function maskCardRuns(text: string): string;
export function cardPrefix(digits: string): boolean;
export function removeExpiries(text: string): string;
export function removeCvvs(text: string): string;
export function maskGiftCards(text: string): string;
export function scrubText(text: string): string;
export function scrubField(label: string, value: string): { label: string; value: string } | null;
export function cardShaped(value: string): boolean;
export function isCardInput(label: string, autocomplete: string | null | undefined, value: string): boolean;
export function isSecretInput(type: string | null | undefined, autocomplete: string | null | undefined): boolean;
export function paymentFormField(label: string, value: string, autocomplete?: string | null): { label: string; value: string };
export function rescrubFields(fields: { label: string; value: string }[]): { label: string; value: string }[];
