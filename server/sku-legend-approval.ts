// Bulk approval orchestration for legend_pending items surfaced by the
// offer-add preview. Three actions:
//   approve_new      — new sku_legend row + self-alias (both type=brand|dept)
//   approve_in_place — UPDATE existing proposed row's code + status=approved
//   merge            — sku_legend_alias entry pointing at existing canonical (brand-only)
//
// Server-side ordering (correctness invariant, NOT UI responsibility):
//   1) all approve_new   (so newly-approved brands are available as merge targets)
//   2) all merge         (uses pre-existing + newly-approved brand map)
//   3) all approve_in_place
//
// Dependency tracking: a merge whose intoRawValue points to an approve_new
// in THIS batch that errored gets reason='merge_target_failed' — never silently
// merges into nothing or into a wrong target. Different from target_not_found
// (which means the rawValue was never approved at all).
//
// All actions are individually atomic via the action handler; one item failing
// doesn't block the rest. Per-item outcomes are returned in input position order.

// Action handlers are abstracted so unit tests can mock them with predictable
// outcomes — the orchestrator logic (ordering, dependency tracking, result
// aggregation) is the part most likely to harbor subtle bugs, so it gets
// tested independently from the SQL.

import type pg from "pg";
import { NO_VALUE_CODE, isReservedLegendCode, isBlankRawValue } from "@shared/sku-legend";

// ============================================================================
// Types
// ============================================================================
export type LegendType = "brand" | "dept";

export type ApprovalItem =
  | { type: LegendType; rawValue: string; action: "approve_new"; code: string }
  | { type: LegendType; rawValue: string; action: "approve_in_place"; legendId: string; code: string }
  | { type: "brand"; rawValue: string; action: "merge"; intoRawValue: string };

export type ApprovalOutcomeError =
  | "code_collision"
  | "target_not_found"
  | "merge_target_failed"
  | "rawValue_already_in_legend"
  | "invalid_input"
  | "unknown";

export type ApprovalResult =
  | { rawValue: string; outcome: "created";           code: string; legendId: string }
  | { rawValue: string; outcome: "already_approved";  code: string; legendId: string }
  | { rawValue: string; outcome: "updated";           code: string; legendId: string }
  | { rawValue: string; outcome: "merged";            intoCode: string; intoLegendId: string }
  | { rawValue: string; outcome: "already_merged";    intoCode: string; intoLegendId: string }
  | { rawValue: string; outcome: "error"; reason: ApprovalOutcomeError; message: string };

// A canonical brand entry (pre-existing approved + newly approved this batch).
// Keyed by normalized raw_value (the same fold used by the DB unique indexes).
export interface ApprovedBrand {
  legendId: string;
  code: string;
}

// Action handlers — abstracted to keep orchestrator pure-testable.
export interface ApprovalActionHandlers {
  approveNew: (item: Extract<ApprovalItem, { action: "approve_new" }>) => Promise<ApprovalResult>;
  approveInPlace: (item: Extract<ApprovalItem, { action: "approve_in_place" }>) => Promise<ApprovalResult>;
  merge: (
    item: Extract<ApprovalItem, { action: "merge" }>,
    target: ApprovedBrand,
  ) => Promise<ApprovalResult>;
  // Load all approved brands as of the start of this batch (pre-existing only).
  // The orchestrator augments this with successfully-approved-this-batch brands.
  loadApprovedBrands: () => Promise<Map<string, ApprovedBrand>>;
}

// ============================================================================
// Normalization — matches the DB unique-index expression
// ============================================================================
export function normalizeRawValue(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

// ============================================================================
// Orchestrator (pure-ish — depends only on injected handlers)
// ============================================================================
export async function processBulkApproval(
  items: ApprovalItem[],
  handlers: ApprovalActionHandlers,
): Promise<ApprovalResult[]> {
  const results: ApprovalResult[] = new Array(items.length);

  // Phase 0 — input rejection (§18, 2026-09-24). Runs before ANY handler so
  // the guard holds for every action and every handler implementation.
  //
  //   blank rawValue: the legend must never hold a row keyed on ""/whitespace.
  //     One such row (brand "" → HAU, 2026-09-10) swallowed every brandless
  //     ASIN into a single code and made both Approve and Merge fail with
  //     `"" already in legend with code "HAU"`.
  //   reserved code: NUL means "no brand" and is assigned by the resolver, not
  //     by approval. Letting a real brand take it would collide with every
  //     brandless SKU.
  //
  // A rejected item is marked here and skipped by the phase loops below.
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (isBlankRawValue(item.rawValue)) {
      results[i] = {
        rawValue: item.rawValue,
        outcome: "error",
        reason: "invalid_input",
        message:
          "raw value is empty or whitespace — the legend cannot hold an entry with no value. " +
          "A brandless ASIN is assigned the reserved code NUL automatically and needs no approval.",
      };
      continue;
    }
    if (item.action === "merge") {
      if (isBlankRawValue(item.intoRawValue)) {
        results[i] = {
          rawValue: item.rawValue,
          outcome: "error",
          reason: "invalid_input",
          message: "merge target is empty or whitespace — there is no such legend entry",
        };
      }
      continue; // merge carries no code to check
    }
    if (isReservedLegendCode(item.code)) {
      results[i] = {
        rawValue: item.rawValue,
        outcome: "error",
        reason: "invalid_input",
        message:
          `code "${item.code.trim().toUpperCase()}" is reserved and cannot be assigned to a ` +
          `${item.type}. ${NO_VALUE_CODE} marks a value the catalog does not have ` +
          `— brand OR department — and is set automatically by the resolver.`,
      };
    }
  }

  // Phase 1: approve_new — must run first so new brands appear in merge targets
  for (let i = 0; i < items.length; i++) {
    if (results[i]) continue; // rejected in phase 0
    const item = items[i];
    if (item.action === "approve_new") {
      try {
        results[i] = await handlers.approveNew(item);
      } catch (err: any) {
        results[i] = {
          rawValue: item.rawValue,
          outcome: "error",
          reason: "unknown",
          message: err?.message ?? "approve_new handler threw",
        };
      }
    }
  }

  // Build approved-brand map: pre-existing + successfully-approved-this-batch.
  // Used by merge to resolve intoRawValue → legendId/code.
  const approvedBrands = await handlers.loadApprovedBrands();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const r = results[i];
    if (!item || item.action !== "approve_new" || item.type !== "brand") continue;
    if (r && (r.outcome === "created" || r.outcome === "already_approved")) {
      approvedBrands.set(normalizeRawValue(item.rawValue), {
        legendId: r.legendId,
        code: r.code,
      });
    }
  }

  // Phase 2: merge — uses the approved-brand map; tracks same-batch failures
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (results[i]) continue; // rejected in phase 0
    if (item.action !== "merge") continue;

    const normalizedTarget = normalizeRawValue(item.intoRawValue);
    const target = approvedBrands.get(normalizedTarget);

    if (!target) {
      // Distinguish "target was attempted in this batch and failed" from
      // "target was never approved at all". The former is a dependency
      // failure; the latter is a config/input mistake.
      const failedSibling = items.findIndex((sib, idx) =>
        sib &&
        sib.action === "approve_new" &&
        sib.type === "brand" &&
        normalizeRawValue(sib.rawValue) === normalizedTarget &&
        results[idx]?.outcome === "error",
      );
      if (failedSibling !== -1) {
        results[i] = {
          rawValue: item.rawValue,
          outcome: "error",
          reason: "merge_target_failed",
          message: `merge target "${item.intoRawValue}" failed to approve in this batch (see item at position ${failedSibling})`,
        };
      } else {
        results[i] = {
          rawValue: item.rawValue,
          outcome: "error",
          reason: "target_not_found",
          message: `merge target "${item.intoRawValue}" is not an approved brand`,
        };
      }
      continue;
    }

    try {
      results[i] = await handlers.merge(item, target);
    } catch (err: any) {
      results[i] = {
        rawValue: item.rawValue,
        outcome: "error",
        reason: "unknown",
        message: err?.message ?? "merge handler threw",
      };
    }
  }

  // Phase 3: approve_in_place — UPDATEs only; doesn't affect merge targets
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (results[i]) continue; // rejected in phase 0
    if (item.action !== "approve_in_place") continue;
    try {
      results[i] = await handlers.approveInPlace(item);
    } catch (err: any) {
      results[i] = {
        rawValue: item.rawValue,
        outcome: "error",
        reason: "unknown",
        message: err?.message ?? "approve_in_place handler threw",
      };
    }
  }

  return results;
}

// ============================================================================
// Production action handlers — wired with a pg.PoolClient for transactional
// per-action atomicity (canonical INSERT + self-alias must succeed together).
// ============================================================================
type ClientQuery = pg.PoolClient["query"];

const APPROVAL_NOTE = "approved via offer-add legend dialog";

export function makeProductionHandlers(client: pg.PoolClient): ApprovalActionHandlers {
  const q = client.query.bind(client);

  return {
    async loadApprovedBrands(): Promise<Map<string, ApprovedBrand>> {
      const res = await q(
        `SELECT id, raw_value, code FROM sku_legend
         WHERE type='brand' AND status='approved'`,
      );
      const map = new Map<string, ApprovedBrand>();
      for (const row of res.rows) {
        map.set(normalizeRawValue(row.raw_value), { legendId: row.id, code: row.code });
      }
      return map;
    },

    approveNew: (item) => runApproveNew(q, item),
    approveInPlace: (item) => runApproveInPlace(q, item),
    merge: (item, target) => runMerge(q, item, target),
  };
}

async function runApproveNew(
  q: ClientQuery,
  item: Extract<ApprovalItem, { action: "approve_new" }>,
): Promise<ApprovalResult> {
  // Validate code shape — 3 uppercase alpha (matches buildSku validation)
  if (!/^[A-Z]{3}$/.test(item.code)) {
    return {
      rawValue: item.rawValue,
      outcome: "error",
      reason: "invalid_input",
      message: `code "${item.code}" must be 3 uppercase letters`,
    };
  }

  // Pre-flight existence check by rawValue. We can't rely on which unique
  // constraint PG reports first when BOTH (type+rawValue) AND (type+code)
  // would be violated (idempotent re-approve hits both). Resolve the
  // ambiguity by looking up the rawValue ourselves before INSERT:
  //   - exists + same code   → already_approved (idempotent)
  //   - exists + diff code   → rawValue_already_in_legend (use approve_in_place)
  //   - doesn't exist + INSERT errors on code → code_collision (different rawValue using this code)
  const existingByRaw = await q(
    `SELECT id, code, status FROM sku_legend
     WHERE type=$1 AND LOWER(TRIM(REGEXP_REPLACE(raw_value, '\\s+', ' ', 'g')))
                   = LOWER(TRIM(REGEXP_REPLACE($2, '\\s+', ' ', 'g')))
     LIMIT 1`,
    [item.type, item.rawValue],
  );
  if (existingByRaw.rows.length > 0) {
    const existing = existingByRaw.rows[0];
    if (existing.code === item.code) {
      return {
        rawValue: item.rawValue,
        outcome: "already_approved",
        code: existing.code,
        legendId: existing.id,
      };
    }
    return {
      rawValue: item.rawValue,
      outcome: "error",
      reason: "rawValue_already_in_legend",
      message: `"${item.rawValue}" already in legend with code "${existing.code}"; use approve_in_place to change code`,
    };
  }

  // Doesn't exist by rawValue — attempt the INSERT. Any unique violation here
  // is definitively a code_collision (since the rawValue check just passed).
  await q("SAVEPOINT sp_action");
  try {
    const ins = await q(
      `INSERT INTO sku_legend (type, raw_value, code, status, approved_at, note)
       VALUES ($1, $2, $3, 'approved', NOW(), $4) RETURNING id`,
      [item.type, item.rawValue, item.code, APPROVAL_NOTE],
    );
    const legendId = ins.rows[0].id;
    await q(
      `INSERT INTO sku_legend_alias (legend_id, raw_value, note)
       VALUES ($1, $2, 'self-alias on approval')`,
      [legendId, item.rawValue],
    );
    await q("RELEASE SAVEPOINT sp_action");
    return { rawValue: item.rawValue, outcome: "created", code: item.code, legendId };
  } catch (err: any) {
    await q("ROLLBACK TO SAVEPOINT sp_action").catch(() => {});
    await q("RELEASE SAVEPOINT sp_action").catch(() => {});
    if (err?.constraint === "uq_sku_legend_type_code") {
      return {
        rawValue: item.rawValue,
        outcome: "error",
        reason: "code_collision",
        message: `code "${item.code}" is already used by another ${item.type}`,
      };
    }
    return {
      rawValue: item.rawValue,
      outcome: "error",
      reason: "unknown",
      message: err?.message ?? "INSERT failed",
    };
  }
}

async function runApproveInPlace(
  q: ClientQuery,
  item: Extract<ApprovalItem, { action: "approve_in_place" }>,
): Promise<ApprovalResult> {
  if (!/^[A-Z]{3}$/.test(item.code)) {
    return {
      rawValue: item.rawValue,
      outcome: "error",
      reason: "invalid_input",
      message: `code "${item.code}" must be 3 uppercase letters`,
    };
  }
  await q("SAVEPOINT sp_action");
  try {
    // UPDATE only if row exists. Idempotent: if already at this code+approved,
    // the UPDATE is a no-op but we still consider it success.
    const upd = await q(
      `UPDATE sku_legend
         SET code = $2, status = 'approved', approved_at = COALESCE(approved_at, NOW())
       WHERE id = $1
       RETURNING raw_value, code, status`,
      [item.legendId, item.code],
    );
    if (upd.rowCount === 0) {
      await q("ROLLBACK TO SAVEPOINT sp_action");
      await q("RELEASE SAVEPOINT sp_action");
      return {
        rawValue: item.rawValue,
        outcome: "error",
        reason: "target_not_found",
        message: `legend row id "${item.legendId}" not found`,
      };
    }
    // Ensure self-alias exists (legacy proposed rows might not have one)
    await q(
      `INSERT INTO sku_legend_alias (legend_id, raw_value, note)
       VALUES ($1, $2, 'self-alias on approve_in_place')
       ON CONFLICT DO NOTHING`,
      [item.legendId, item.rawValue],
    );
    await q("RELEASE SAVEPOINT sp_action");
    return {
      rawValue: item.rawValue,
      outcome: "updated",
      code: item.code,
      legendId: item.legendId,
    };
  } catch (err: any) {
    await q("ROLLBACK TO SAVEPOINT sp_action").catch(() => {});
    await q("RELEASE SAVEPOINT sp_action").catch(() => {});
    if (err?.constraint === "uq_sku_legend_type_code") {
      return {
        rawValue: item.rawValue,
        outcome: "error",
        reason: "code_collision",
        message: `code "${item.code}" is already used by another ${item.type}`,
      };
    }
    return {
      rawValue: item.rawValue,
      outcome: "error",
      reason: "unknown",
      message: err?.message ?? "UPDATE failed",
    };
  }
}

async function runMerge(
  q: ClientQuery,
  item: Extract<ApprovalItem, { action: "merge" }>,
  target: ApprovedBrand,
): Promise<ApprovalResult> {
  // Pre-check: rawValue must NOT already exist as canonical (per spec — error
  // with hint, never silently delete).
  const existsAsCanonical = await q(
    `SELECT id, code FROM sku_legend
     WHERE type='brand'
       AND LOWER(TRIM(REGEXP_REPLACE(raw_value, '\\s+', ' ', 'g')))
         = LOWER(TRIM(REGEXP_REPLACE($1, '\\s+', ' ', 'g')))
     LIMIT 1`,
    [item.rawValue],
  );
  if (existsAsCanonical.rows.length > 0) {
    return {
      rawValue: item.rawValue,
      outcome: "error",
      reason: "rawValue_already_in_legend",
      message: `"${item.rawValue}" already has a canonical code "${existsAsCanonical.rows[0].code}". Use approve_in_place to change it, then merge another spelling separately.`,
    };
  }

  // INSERT alias. Idempotent via ON CONFLICT — same raw_value can't be aliased
  // twice. Already-aliased to a DIFFERENT brand would also fall through here
  // as already_merged (the alias's existing legend_id wins); we can't easily
  // distinguish "merged to ME" vs "merged elsewhere" without an extra SELECT.
  const ins = await q(
    `INSERT INTO sku_legend_alias (legend_id, raw_value, note)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [
      target.legendId,
      item.rawValue,
      `merged into "${target.code}" via offer-add legend dialog`,
    ],
  );
  if (ins.rowCount === 1) {
    return {
      rawValue: item.rawValue,
      outcome: "merged",
      intoCode: target.code,
      intoLegendId: target.legendId,
    };
  }
  // rowCount === 0 — alias already existed. Check which legend_id it points at.
  const check = await q(
    `SELECT a.legend_id, l.code FROM sku_legend_alias a
     JOIN sku_legend l ON l.id = a.legend_id
     WHERE LOWER(TRIM(REGEXP_REPLACE(a.raw_value, '\\s+', ' ', 'g')))
         = LOWER(TRIM(REGEXP_REPLACE($1, '\\s+', ' ', 'g')))
     LIMIT 1`,
    [item.rawValue],
  );
  const existing = check.rows[0];
  if (existing && existing.legend_id === target.legendId) {
    return {
      rawValue: item.rawValue,
      outcome: "already_merged",
      intoCode: target.code,
      intoLegendId: target.legendId,
    };
  }
  // Aliased elsewhere — surface as conflict
  return {
    rawValue: item.rawValue,
    outcome: "error",
    reason: "rawValue_already_in_legend",
    message: `"${item.rawValue}" is already aliased to a different brand (code "${existing?.code}"). Manually remove that alias first if you want to re-merge.`,
  };
}
