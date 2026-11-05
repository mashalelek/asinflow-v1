export interface StructuredResult { platform: string | null; source: string; buckets: any; filled: { products: boolean; totals: boolean } }
export function toBuckets(raw: any): StructuredResult | null;
export function fromShopifyCheckout(c: any): any;
export function fromShopifyCart(c: any): any;
export function fromBigCommerce(cart: any, checkout: any, order: any): any;
export function fromJsonLd(nodes: any[]): any;
