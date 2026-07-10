// Pure mapper: putListingsItem response → typed AF outcome.
//
// Two failure modes from Amazon to handle:
//   A) HTTP non-2xx — JSON envelope { errors: [{code, message}] }
//   B) HTTP 2xx with body.status='INVALID' — same HTTP as success, must inspect
//      the body.issues[] array. status='ACCEPTED' is the success path.
//
// Design notes:
//   - First-match-wins rule order. Order matters (e.g., expiration checked
//     before invalid_attribute because expiration is a more specific subset).
//   - 'unknown' is the explicit catch-all bucket — preserves rawResponse +
//     originalCode/Message for human review. We expect to refine known-code
//     sets after the first real production responses.
//   - Pure — no DB, no network. The caller (DA-4 wiring) decides what side
//     effects to fire (e.g., applyCatalogDeletedSignal on catalog_deleted).
//   - Per Maria's decision: gated does NOT write back to eligibility_status
//     (avoids two writers on one §14-owned field). catalog_deleted DOES
//     trigger the shared helper, since 404 is binary/unambiguous.

// ============================================================================
// Types
// ============================================================================

export interface ListingsIssue {
  code?: string;
  message?: string;
  severity?: "ERROR" | "WARNING";
  attributeNames?: string[];
}

export interface ListingsItemResponse {
  sku?: string;
  status?: "ACCEPTED" | "INVALID";
  submissionId?: string;
  issues?: ListingsIssue[];
}

export interface ListingsHttpErrorBody {
  errors?: Array<{ code?: string; message?: string; details?: string }>;
}

// Caller wraps axios outcome into one of three discriminated shapes. The
// mapper doesn't deal with axios directly — keeps it pure & testable.
export type PutListingsCallResult =
  | { kind: "ok"; body: ListingsItemResponse }
  | { kind: "http_error"; status: number; body?: ListingsHttpErrorBody }
  | { kind: "network_error"; message: string };

export type OfferAddFailureReason =
  | "gated"             // Amazon restriction; user can't list this ASIN as-is
  | "catalog_deleted"   // ASIN gone from catalog (caller fires applyCatalogDeletedSignal)
  | "invalid_attribute" // payload validation rejected — missing/bad required field
  | "expiration_issue"  // per spec: expiration in offer-add = full failure (NOT a warning)
  | "throttled"         // 429 — retryable
  | "transient"         // 5xx / network — retryable
  | "unknown";          // didn't match any rule — rawResponse preserved for review

export type OfferAddOutcome =
  | {
      ok: true;
      sku: string;
      submissionId: string;
      warnings: ListingsIssue[];
    }
  | {
      ok: false;
      reason: OfferAddFailureReason;
      originalCode: string | null;
      originalMessage: string;
      retryable: boolean;
      rawResponse?: unknown;
    };

// ============================================================================
// Rule data (starter sets — refine after real responses come in)
// ============================================================================

// Codes reported in community threads for brand/IP/category gating rejections.
// Will expand as we collect real responses.
const GATING_CODES = new Set(["90220020", "90230001"]);
const GATING_MESSAGE_RE = /not approved|not authorized|approval required|restriction|brand registry/i;

// Codes that indicate the ASIN itself isn't in Amazon's catalog. Treated the
// same as a getCatalogItem 404 — caller flips is_catalog_deleted via the
// shared helper.
const CATALOG_DELETED_CODES = new Set(["INVALID_ASIN", "ASIN_NOT_FOUND", "90100003", "NOT_FOUND"]);
const CATALOG_DELETED_MESSAGE_RE = /invalid asin|asin not found|product not found/i;

// Expiration matches anything with "expir" — catches "expiration", "expires",
// "expiry", "expired" without false positives in normal listings vocabulary.
const EXPIRATION_RE = /expir/i;

// ============================================================================
// Mapper
// ============================================================================

export function mapPutListingsResponse(input: PutListingsCallResult): OfferAddOutcome {
  if (input.kind === "network_error") {
    return {
      ok: false,
      reason: "transient",
      originalCode: null,
      originalMessage: input.message,
      retryable: true,
    };
  }

  if (input.kind === "http_error") {
    return mapHttpError(input.status, input.body);
  }

  // input.kind === "ok" — HTTP 2xx; inspect body.status + body.issues
  return mapOkBody(input.body);
}

function mapHttpError(status: number, body: ListingsHttpErrorBody | undefined): OfferAddOutcome {
  const firstErr = body?.errors?.[0];
  const code = firstErr?.code ?? null;
  const message = firstErr?.message ?? `HTTP ${status}`;
  const raw = body;

  // 429 — most specific HTTP-level signal, check first
  if (status === 429) {
    return { ok: false, reason: "throttled", originalCode: code, originalMessage: message, retryable: true, rawResponse: raw };
  }

  // 5xx — retryable transient
  if (status >= 500 && status < 600) {
    return { ok: false, reason: "transient", originalCode: code, originalMessage: message, retryable: true, rawResponse: raw };
  }

  // 4xx — could be catalog-deleted or gated; check by code/message
  if (status >= 400 && status < 500) {
    if (matchesCatalogDeleted(code, message)) {
      return { ok: false, reason: "catalog_deleted", originalCode: code, originalMessage: message, retryable: false, rawResponse: raw };
    }
    if (status === 403 && matchesGated(code, message)) {
      return { ok: false, reason: "gated", originalCode: code, originalMessage: message, retryable: false, rawResponse: raw };
    }
  }

  return { ok: false, reason: "unknown", originalCode: code, originalMessage: message, retryable: false, rawResponse: raw };
}

function mapOkBody(body: ListingsItemResponse): OfferAddOutcome {
  const issues: ListingsIssue[] = body.issues ?? [];

  // Expiration check fires FIRST — per spec, even on 200-ACCEPTED, an
  // expiration issue means full failure (not "successful with warnings").
  const expirationHit = issues.find(
    (i) => matchesExpiration(i.code) || matchesExpiration(i.message),
  );
  if (expirationHit) {
    return {
      ok: false,
      reason: "expiration_issue",
      originalCode: expirationHit.code ?? null,
      originalMessage: expirationHit.message ?? "Expiration attribute issue",
      retryable: false,
      rawResponse: body,
    };
  }

  if (body.status === "ACCEPTED") {
    return {
      ok: true,
      sku: body.sku ?? "",
      submissionId: body.submissionId ?? "",
      warnings: issues.filter((i) => i.severity === "WARNING"),
    };
  }

  // body.status === "INVALID" (or anything else) — classify the error-severity issues
  const errorIssues = issues.filter((i) => i.severity === "ERROR");

  const catalogHit = errorIssues.find((i) => matchesCatalogDeleted(i.code ?? null, i.message ?? ""));
  if (catalogHit) {
    return {
      ok: false,
      reason: "catalog_deleted",
      originalCode: catalogHit.code ?? null,
      originalMessage: catalogHit.message ?? "ASIN not found in catalog",
      retryable: false,
      rawResponse: body,
    };
  }

  const gatedHit = errorIssues.find((i) => matchesGated(i.code ?? null, i.message ?? ""));
  if (gatedHit) {
    return {
      ok: false,
      reason: "gated",
      originalCode: gatedHit.code ?? null,
      originalMessage: gatedHit.message ?? "Gated by Amazon",
      retryable: false,
      rawResponse: body,
    };
  }

  if (errorIssues.length > 0) {
    const first = errorIssues[0];
    return {
      ok: false,
      reason: "invalid_attribute",
      originalCode: first.code ?? null,
      originalMessage: first.message ?? "Invalid attribute",
      retryable: false,
      rawResponse: body,
    };
  }

  // 200-INVALID with no error-severity issues, or weird shape → unknown
  return {
    ok: false,
    reason: "unknown",
    originalCode: null,
    originalMessage: `Unexpected response: status=${body.status ?? "missing"}, issues=${issues.length}`,
    retryable: false,
    rawResponse: body,
  };
}

// ============================================================================
// Matchers (exported for unit tests to introspect)
// ============================================================================

export function matchesCatalogDeleted(code: string | null, message: string): boolean {
  if (code && CATALOG_DELETED_CODES.has(code)) return true;
  if (message && CATALOG_DELETED_MESSAGE_RE.test(message)) return true;
  return false;
}

export function matchesGated(code: string | null, message: string): boolean {
  if (code && GATING_CODES.has(code)) return true;
  if (message && GATING_MESSAGE_RE.test(message)) return true;
  return false;
}

export function matchesExpiration(s: string | undefined): boolean {
  return !!s && EXPIRATION_RE.test(s);
}
