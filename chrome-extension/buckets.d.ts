// Types for buckets.js (plain script shared by the extension and the vitest fixtures).
export interface CapturePage { step?: string; url: string; title?: string; text: string; fields?: { label: string; value: string }[]; capturedAt?: string; chars?: number; previewKey?: string }
export interface BucketProduct { name: string; qty: number | null; price: string | null; total: string | null; sku: string | null }
export interface BucketShipping { street: string | null; candidates: string[]; selected: boolean }
export interface BucketCard { nickname: string; last4: string | null; amount: string | null }
export interface BucketGiftCard { last4: string | null; amount: string | null }
export interface BucketTotals { subtotal?: string; discount?: string; tax?: string; shipping?: string; total?: string }
export interface BucketOrder { number?: string; date?: string; subscription?: { on: boolean; every: string | null }; email?: string }
export interface Buckets { products: BucketProduct[]; shipping: BucketShipping | null; payment: { cards: BucketCard[]; giftCards: BucketGiftCard[] }; totals: BucketTotals; promos: string[]; order: BucketOrder }
export type BucketKey = "products" | "shipping" | "payment" | "totals" | "promos" | "order";
export interface CaptureRecord { host: string; captures?: CapturePage[]; pages?: Record<string, CapturePage>; others?: CapturePage[]; count: number; updatedAt: string | null; buckets: Buckets; previews?: Record<string, any>; previewPending?: string[]; previewError?: string | null; previewErrors?: Record<string, string> }
export interface ShipConfig { velocityStreet: string; homeStreets: string[]; prepCost?: number; suppliers?: string[] }
export const BUCKETS: BucketKey[];
export const LABELS: Record<BucketKey, string>;
export function emptyBuckets(): Buckets;
export function extractBuckets(page: CapturePage): Buckets;
export function mergeBuckets(prev: Buckets | null, next: Partial<Buckets> | null): Buckets;
export function extractProducts(page: CapturePage): BucketProduct[];
export function extractShipping(page: CapturePage): BucketShipping | null;
export function extractPayment(page: CapturePage): Buckets["payment"];
export function extractTotals(page: CapturePage): BucketTotals;
export function extractPromos(page: CapturePage): string[];
export function dedupePromos(lines: string[]): string[];
export function debugText(cap: any, now?: string): string;
export function addressFromFields(page: CapturePage): any;
export function extractOrder(page: CapturePage): BucketOrder;
export function filled(b: Buckets | null): Record<BucketKey, boolean>;
export function missing(b: Buckets | null): string[];
export function streetIn(text: string): string | null;
export function normStreet(s: string): string | null;
export function captureKey(tabId: number): string;
export function newCapture(host: string): CaptureRecord;
export function applyPage(cur: CaptureRecord | null, page: CapturePage, host: string, now: string): CaptureRecord;
export function pagesForPrefill(cap: CaptureRecord): { step: string | undefined; url: string; title: string | undefined; text: string; fields: { label: string; value: string }[] }[];
export function shipToForPrefill(cap: CaptureRecord | null): { street: string | null; candidates: string[] } | null;
export function othersCapturing(store: Record<string, any>, tabId: number): { tabId: number; host: string; count: number }[];
export function orphanCaptureKeys(store: Record<string, any>, tabIds: number[]): string[];
export function shipToKind(street: string | null, config: ShipConfig | null): "Velocity" | "Home" | null;
export function describeShipping(shipping: BucketShipping | null, config: ShipConfig | null): string[];
/** v1.3: the AI preview of a page laid over its rule-based buckets. */
export function overlayPreview(rule: any, ai: any): any;
export function applyPreview(cur: any, key: string, buckets: any, error: string | null): any;
export function previewStatus(cap: any): string | null;
export function needsPreview(cap: any, key: string | null | undefined): boolean;
export function checkoutEmailForPrefill(cap: any): string | null;
export function overlayStructured(b: any, s: any): any;
export function pageLayers(cap: any, p: any): { products: string | null; totals: string | null };
export function layersOf(cap: any): { products: string | null; totals: string | null };
export function previewError(cap: any): string | null;
export function applyStructured(cur: any, key: string, structured: any): any;
/** 2.0.4: the server's string limits; clipPage cuts a page to them (a cut field says truncated, a cut title / text / url / fields is named in page.truncated). */
export const LIMITS: { url: number; title: number; text: number; label: number; value: number; fields: number };
export function clipPage<P extends { url?: string; title?: string; text?: string; fields?: { label: string; value: string }[]; truncated?: string[] }>(page: P): P & { fields: Array<{ label: string; value: string; truncated?: boolean }>; truncated?: string[] };
/** 2.0.4: the pages the AI preview could not read, oldest first (n is 1-based). */
export function previewFailures(cap: any): Array<{ n: number; step: string; path: string; error: string }>;
/** 2.0.4: the same product across pages — two SKUs decide; one SKU: same name, qty and price; none: the name. */
export function sameProduct(a: any, b: any): boolean;

