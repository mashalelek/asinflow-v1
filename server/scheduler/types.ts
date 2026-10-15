// Scheduler v1 (SPEC §11 "Refresh job"; patch docs/claude_spec-patch-scheduler-v1.md).
//
// RULE: every refresh of Amazon-side or sheet-side data is a job on one
// queue, executed by one runner, one job at a time, in one fixed component
// order. Scheduled passes and the Refresh button enqueue the same job with
// different scopes. Nothing refreshes data outside the queue.

export type JobKind = "refresh";
export type JobTrigger = "scheduled" | "manual" | "onboarding" | "bulk";
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

export interface JobSummary {
  asins: number;
  durationMs: number;
  components: Record<string, Record<string, number>>;
  flips: Flip[];
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
}

export type QueryLike = (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>;

export class CancelledError extends Error {
  constructor() { super("job cancelled"); }
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
