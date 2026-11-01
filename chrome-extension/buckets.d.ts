// Types for buckets.js (plain script shared by the extension and the vitest fixtures).
export interface CapturePage { step?: string; url: string; title?: string; text: string; fields?: { label: string; value: string }[]; capturedAt?: string; chars?: number }
export interface BucketProduct { name: string; qty: number | null; price: string | null; total: string | null; sku: string | null }
export interface BucketShipping { street: string | null; candidates: string[]; selected: boolean }
export interface BucketCard { nickname: string; last4: string | null; amount: string | null }
export interface BucketGiftCard { last4: string | null; amount: string | null }
export interface BucketTotals { subtotal?: string; discount?: string; tax?: string; shipping?: string; total?: string }
export interface BucketOrder { number?: string; date?: string; subscription?: { on: boolean; every: string | null } }
export interface Buckets { products: BucketProduct[]; shipping: BucketShipping | null; payment: { cards: BucketCard[]; giftCards: BucketGiftCard[] }; totals: BucketTotals; promos: string[]; order: BucketOrder }
export type BucketKey = "products" | "shipping" | "payment" | "totals" | "promos" | "order";
export interface CaptureRecord { host: string; pages: Record<string, CapturePage>; others: CapturePage[]; count: number; updatedAt: string | null; buckets: Buckets }
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
export function extractOrder(page: CapturePage): BucketOrder;
export function filled(b: Buckets | null): Record<BucketKey, boolean>;
export function missing(b: Buckets | null): string[];
export function canOpen(b: Buckets | null): boolean;
export function streetIn(text: string): string | null;
export function normStreet(s: string): string | null;
export function captureKey(tabId: number): string;
export function newCapture(host: string): CaptureRecord;
export function applyPage(cur: CaptureRecord | null, page: CapturePage, host: string, now: string): CaptureRecord;
export function pagesForPrefill(cap: CaptureRecord): { step: string | undefined; url: string; title: string | undefined; text: string; fields: { label: string; value: string }[] }[];
export function shipToForPrefill(cap: CaptureRecord | null): { street: string | null; candidates: string[] } | null;
export function othersCapturing(store: Record<string, any>, tabId: number): { tabId: number; host: string; count: number }[];
export function shipToKind(street: string | null, config: ShipConfig | null): "Velocity" | "Home" | null;
export function describeShipping(shipping: BucketShipping | null, config: ShipConfig | null): string[];
