// Scheduler v1 (SPEC §11 "Refresh job"; patch docs/claude_spec-patch-scheduler-v1.md).
//
// RULE: every refresh of Amazon-side or sheet-side data is a job on one
// queue, executed by one runner, one job at a time, in one fixed component
// order. Scheduled passes and the Refresh button enqueue the same job with
// different scopes. Nothing refreshes data outside the queue.

export type JobKind = "refresh";
export type JobTrigger = "scheduled" | "manual" | "onboarding" | "bulk";

/**
 * Two lanes (Maria, 2026-10-16: manual actions never wait on the scheduled
 * pass). Lane S = the scheduled pass, one at a time. Lane M = everything a
 * person or an onboarding started (manual, onboarding, bulk), one at a time
 * in queue order. Both lanes run concurrently in the same process; a lane M
 * job starts the moment it is enqueued if lane M is idle.
 */
export type Lane = "S" | "M";
export const LANE_TRIGGERS: Record<Lane, readonly JobTrigger[]> = { S: ["scheduled"], M: ["manual", "onboarding", "bulk"] };
export function laneOf(trigger: JobTrigger): Lane { return trigger === "scheduled" ? "S" : "M"; }

/**
 * An onboarding job runs ONLY the per-ASIN components for its scope: the
 * daily block 2–8 and 10–17. Never 1, 9, 18, 19–21 — those are account-wide
 * and belong to the scheduled pass or a manual Refresh. This is what stops
 * an onboarding job from discovering more ASINs and enqueuing itself again.
 */
export const ONBOARDING_COMPONENTS: readonly number[] = [2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17];

/**
 * Listing hygiene (SPEC §11, 2026-10-19): components that run ONLY in the
 * scheduled pass — 22 (close, 00:00 since 2026-10-20), 23 (ledger, 00:00) and 24 (delete,
 * 00:00). A Refresh click, an onboarding or a bulk job must never have SC
 * writes as a side effect. A non-scheduled job runs one of them only when it
 * lists it in `components` AND carries that component's own parameters —
 * the manual entry points (POST /api/listing-hygiene/run and /release → 22
 * or 24 with `params.listing_hygiene`; the ledger backfill → 23 with
 * `params.ledger_window`).
 */
export const SCHEDULED_ONLY_COMPONENTS: readonly number[] = [22, 23, 24];
export function explicitlyAuthorized(n: number, params: Record<string, any> | null | undefined): boolean {
  if (n === 23) return params?.ledger_window != null;
  if (n === 22) return params?.listing_hygiene?.action === "close";
  if (n === 24) return params?.listing_hygiene?.action === "delete";
  return true;
}
export type JobTarget = "main" | "bulk";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobProgress {
  /** Component number currently (or last) in flight. */
  component?: number;
  /** Last ASIN fully processed by the current component; null = none yet. */
  asin_cursor?: string | null;
  /** 1-based position of the cursor within the job scope, and the scope size — for the button label. */
  position?: number;
  total?: number;
  /** What position/total count when not ASINs — "chunk" for the sales backfill (2026-10-16). */
  unit?: string;
  /** Component numbers completed in this job. */
  done: number[];
}

export interface Flip {
  asin: string;
  /** Which fact flipped. Only these two are reported (decision 16). */
  field: "gating" | "suppression";
  from: string;
  to: string;
}

/** A listing-hygiene SC write Amazon accepted (components 22 / 24) — the completion toast's Changes panel. */
export interface ListingActionChange {
  action: "close" | "delete";
  asin: string;
  sku: string;
}

export interface JobSummary {
  asins: number;
  durationMs: number;
  components: Record<string, Record<string, number>>;
  flips: Flip[];
  /** Listings closed / deleted in this job (2026-10-19); absent = none. */
  listingActions?: ListingActionChange[];
  /** Component number that failed / was cancelled, if any. */
  stoppedAt?: number;
}

export interface JobRow {
  id: number;
  kind: JobKind;
  trigger: JobTrigger;
  target: JobTarget;
  bulk_list_id: string | null;
  include_daily: boolean;
  scope_asins: string[] | null;
  /**
   * Component numbers this job runs (sequence order is kept); NULL = the
   * whole sequence, daily block per include_daily. Decision 9: Add to SC
   * enqueues {8} (gating) and Push to Aura {9} (PO sheet) for a selection.
   */
  components: number[] | null;
  /** Per-job parameters components read (migration 054); null = none. e.g. {sales_window: {from, to}}. */
  params: Record<string, any> | null;
  status: JobStatus;
  progress: JobProgress;
  summary: JobSummary | null;
  requested_by: number | null;
  queued_at: string | Date;
  started_at: string | Date | null;
  finished_at: string | Date | null;
  error: string | null;
}

export interface ComponentResult {
  counts: Record<string, number>;
  /** Per-ASIN outcome strings, Prices & Stock shape; only non-trivial ones need listing. */
  outcomes: Record<string, string>;
  flips?: Flip[];
  listingActions?: ListingActionChange[];
}

export type QueryLike = (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>;

export class CancelledError extends Error {
  constructor() { super("job cancelled"); }
}

/**
 * A component failure that still has something to record: the runner writes
 * `partial` to the ledger row and the job summary before marking the job
 * failed. The sales component uses it so a chunk that failed after others
 * succeeded leaves the per-chunk results visible, not just an error string.
 */
export class ComponentError extends Error {
  constructor(message: string, public readonly partial: ComponentResult) { super(message); }
}

export interface ComponentContext {
  job: JobRow;
  query: QueryLike;
  log: (message: string) => void;
  sellerId: string;
  /**
   * The ASINs this component must process, in the job's stable order
   * (asins.id). For per-ASIN and batch components on a resumed job this is
   * the REMAINDER after the cursor; account-level components receive the
   * whole scope for reference only.
   */
  asins: string[];
  /** The whole job scope, regardless of resume position. */
  scopeAsins: string[];
  /**
   * Record that work up to and including `lastAsin` is durably done
   * (progress is written), and honour a cancel request by throwing
   * CancelledError. Per-ASIN components call it every 50 ASINs; batch
   * components at each batch boundary.
   */
  checkpoint: (lastAsin: string | null) => Promise<void>;
  /**
   * Progress in a unit other than ASINs (the sales backfill reports
   * "chunk 3/30"). Writes progress; does not check for cancel.
   */
  setProgress: (position: number, total: number, unit: string) => Promise<void>;
  /** Shared per-job cache so riders reuse one API response (catalog, prices, inventory, listings). */
  cache: Map<string, unknown>;
}

export type ComponentKind =
  | "account"  // one account-wide call; not resumable mid-way (reruns on resume)
  | "asin"     // per-ASIN calls; resumable at the cursor
  | "batch"    // batched calls; resumable at the batch containing the cursor
  | "derived"; // no API call; reads what earlier components left

export interface ComponentDef {
  n: number;
  /** Ledger stage key, e.g. "10_prices". */
  key: string;
  name: string;
  tier: "hourly" | "daily";
  kind: ComponentKind;
  /** The SP-API / sheet call this component makes or rides, for the record. */
  call: string;
  run: (ctx: ComponentContext) => Promise<ComponentResult>;
}

/** Progress is written every N ASINs inside per-ASIN components (decision 14). */
export const ASIN_CHECKPOINT_EVERY = 50;
/** Batch components chunk at 5 SP-API batches of 20, so no partial batch is spent on a checkpoint. */
export const BATCH_CHUNK = 100;
