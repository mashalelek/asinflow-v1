/**
 * Typed client wrappers for the Purchase Orders API (Phase 3).
 *
 * Server endpoints live in server/po-routes.ts. These match its shapes and
 * give callers proper TypeScript types instead of `any`.
 */
import { apiRequest } from "./queryClient";

export type DiscType = "percentage" | "dollar" | null;
export type PoStatus = "Ordered" | "Received in Full" | "Received Partial" | "Canceled" | "Closed";
export type LiStatus = "Ordered" | "Received in Full" | "Received Partial" | "Canceled" | "Returned" | "Shipped FBA" | "FBM";

export interface GiftCard {
  id: string;
  card_number: string;
  purchase_date: string;
  face_value: number | string;
  amount_paid: number | string;
  discount_percentage: number | string;
  current_balance: number | string;
  purchase_source: string | null;
  status: "Active" | "Depleted" | "Expired";
}

export interface PoOrderFields {
  order_id: string;
  order_date: string;
  supplier: string;
  order_subtotal: number;
  shipping_cost?: number;
  tax?: number;
  order_discount?: number;
  order_discount_type?: DiscType;
  discount_description?: string | null;
  order_total: number;
  refund?: number;
  refund_manual_override?: boolean;
  cashback_website?: "BeFrugal" | "TopCashback" | "Rakuten" | "None" | null;
  cashback_percentage?: number;
  tracking_number?: string | null;
  payment_method?: string | null;
  purchased_by?: string | null;
  is_subscription?: boolean;
  subscription_frequency?: string | null;
  subscription_next_order_date?: string | null;
  general_notes?: string | null;
  internal_email?: string | null;
  invoice_file_path?: string | null;
  status?: PoStatus;
}

export interface LineItemFields {
  id?: string;
  sku?: string | null;
  product_name: string;
  product_price: number;
  product_discount?: number;
  product_discount_type?: DiscType;
  qty_ordered: number;
  qty_received?: number;
  qty_canceled?: number;
  qty_returned_refunded?: number;
  unreimbursed_lost_damaged_qty?: number;
  unreimbursed_lost_damaged_amount?: number;
  expiration_date?: string | null;
  tax_exempt?: boolean;
  unique_products_per_asin?: number;
  asin: string;
  asin_qty_per_product: number;
  tags?: string[] | null;
  notes?: string | null;
  refund_amount?: number;
  status?: LiStatus;
}

export interface PoCreateBody extends PoOrderFields {
  line_items: LineItemFields[];
  gift_cards?: { gift_card_id: string; amount_used: number }[];
}

export interface PoDetailLineItem extends LineItemFields {
  id: string;
  adjusted_qty_ordered: number;
  po_asin_id: string | null;
  pa_qty_received: number | string | null;
  adjusted_product_cost: number | string | null;
  cogs_per_asin_unit: number | string | null;
  sourcing_cost_per_asin_unit: number | string | null;
  receipt_date: string | null;
  asin_title: string | null;
  fulfillment_channel: "FBA" | "FBM" | null;
  status: LiStatus;
  created_at: string;
}

export interface PoDetailGiftCard {
  link_id: string;
  amount_used: number | string;
  gift_card_id: string;
  card_number: string;
  face_value: number | string;
  amount_paid: number | string;
  discount_percentage: number | string;
  current_balance: number | string;
  status: "Active" | "Depleted" | "Expired";
}

export interface PoDetail {
  po: PoOrderFields & { id: string; created_at: string; updated_at: string; status: PoStatus };
  line_items: PoDetailLineItem[];
  gift_cards: PoDetailGiftCard[];
  refund_warning: { warning: boolean; message?: string };
}

export interface PoListRow {
  id: string;
  order_id: string;
  order_date: string;
  supplier: string;
  order_total: number | string;
  status: PoStatus;
  is_subscription: boolean;
  payment_method: string | null;
  refund: number | string;
  refund_manual_override: boolean;
  created_at: string;
  line_item_count: number;
  total_units_ordered: number;
  total_units_received: number;
}

export interface PoListResponse {
  rows: PoListRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PoListFilters {
  startDate?: string;
  endDate?: string;
  supplier?: string[];
  status?: PoStatus[];
  payment_method?: string[];
  is_subscription?: boolean;
  search?: string;
  page?: number;
  pageSize?: number;
  sortBy?: "order_date" | "order_id" | "supplier" | "order_total" | "status" | "created_at";
  sortDir?: "ASC" | "DESC";
}

// ─── Endpoints ────────────────────────────────────────────────────────────────

export async function listPos(f: PoListFilters = {}): Promise<PoListResponse> {
  const p = new URLSearchParams();
  if (f.startDate)              p.set("startDate", f.startDate);
  if (f.endDate)                p.set("endDate", f.endDate);
  if (f.supplier?.length)       p.set("supplier", f.supplier.join(","));
  if (f.status?.length)         p.set("status", f.status.join(","));
  if (f.payment_method?.length) p.set("payment_method", f.payment_method.join(","));
  if (f.is_subscription)        p.set("is_subscription", "true");
  if (f.search)                 p.set("search", f.search);
  if (f.page)                   p.set("page", String(f.page));
  if (f.pageSize)               p.set("pageSize", String(f.pageSize));
  if (f.sortBy)                 p.set("sortBy", f.sortBy);
  if (f.sortDir)                p.set("sortDir", f.sortDir);
  const r = await apiRequest("GET", `/api/pos?${p.toString()}`);
  return r.json();
}

export async function getPo(id: string): Promise<PoDetail> {
  const r = await apiRequest("GET", `/api/pos/${id}`);
  return r.json();
}

export async function createPo(body: PoCreateBody): Promise<PoDetail> {
  const r = await apiRequest("POST", "/api/pos", body);
  return r.json();
}

export async function updatePo(id: string, body: Partial<PoCreateBody>): Promise<PoDetail> {
  const r = await apiRequest("PUT", `/api/pos/${id}`, body);
  return r.json();
}

export async function deletePo(id: string): Promise<void> {
  await apiRequest("DELETE", `/api/pos/${id}`);
}

export async function addLineItem(poId: string, li: LineItemFields): Promise<PoDetail> {
  const r = await apiRequest("POST", `/api/pos/${poId}/line-items`, li);
  return r.json();
}

export async function updateLineItem(poId: string, lineItemId: string, patch: Partial<LineItemFields>): Promise<PoDetail> {
  const r = await apiRequest("PUT", `/api/pos/${poId}/line-items/${lineItemId}`, patch);
  return r.json();
}

export async function deleteLineItem(poId: string, lineItemId: string): Promise<PoDetail> {
  const r = await apiRequest("DELETE", `/api/pos/${poId}/line-items/${lineItemId}`);
  return r.json();
}

export async function listGiftCards(status: "Active" | "all" = "Active"): Promise<{ rows: GiftCard[] }> {
  const r = await apiRequest("GET", `/api/gift-cards?status=${status}`);
  return r.json();
}

// Coerce numeric strings (pg returns numerics as strings) to numbers safely.
export const n = (v: any): number => v == null ? 0 : Number(v);
