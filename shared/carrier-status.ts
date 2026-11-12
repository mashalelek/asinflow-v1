// Carrier status (SPEC §26 "Carrier status — EasyPost", claims patch §3.9, commit 4): the words the readers show
// for a tracking row's EasyPost status, and the Velocity fallback when EasyPost has nothing. Pure.

/** EasyPost tracker statuses (api docs, Tracker object). */
export const EASYPOST_STATUSES = ["pre_transit", "in_transit", "out_for_delivery", "delivered", "available_for_pickup", "return_to_sender", "failure", "cancelled", "error", "unknown"] as const;
export type EasypostStatus = (typeof EASYPOST_STATUSES)[number];

const LABELS: Record<EasypostStatus, string> = {
  pre_transit: "Label created", in_transit: "In transit", out_for_delivery: "Out for delivery", delivered: "Delivered",
  available_for_pickup: "Available for pickup", return_to_sender: "Returned to sender", failure: "Delivery failed",
  cancelled: "Cancelled", error: "Carrier error", unknown: "Unknown",
};

export interface CarrierStatusRow {
  carrier_status?: string | null;
  est_delivery_at?: string | Date | null;
  last_scan_at?: string | Date | null;
  delivered_at?: string | Date | null;
  velocity_tracking_status?: string | null;
}

/** The status word: EasyPost's when AF has it, else Velocity's per-tracking status marked as such, else null. */
export function carrierStatusText(r: CarrierStatusRow): { text: string; source: "easypost" | "velocity" } | null {
  if (r.carrier_status) return { text: LABELS[r.carrier_status as EasypostStatus] ?? r.carrier_status, source: "easypost" };
  if (r.velocity_tracking_status) return { text: `Velocity: ${r.velocity_tracking_status}`, source: "velocity" };
  return null;
}

/** Terminal for AF: nothing more will arrive on this number. */
export const isTerminalStatus = (s: string | null | undefined): boolean => s === "delivered" || s === "return_to_sender" || s === "cancelled";
