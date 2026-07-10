import { describe, it, expect } from "vitest";
import {
  mapPutListingsResponse,
  matchesCatalogDeleted,
  matchesGated,
  matchesExpiration,
} from "./listings-error-map";

// ============================================================================
// Network errors (fetch reject, no response from Amazon)
// ============================================================================
describe("mapPutListingsResponse — network errors", () => {
  it("network_error → transient + retryable + preserves message", () => {
    const r = mapPutListingsResponse({ kind: "network_error", message: "ECONNRESET" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("transient");
      expect(r.retryable).toBe(true);
      expect(r.originalMessage).toBe("ECONNRESET");
      expect(r.originalCode).toBeNull();
    }
  });
});

// ============================================================================
// HTTP non-2xx errors (status code path)
// ============================================================================
describe("mapPutListingsResponse — HTTP errors", () => {
  it("429 → throttled + retryable", () => {
    const r = mapPutListingsResponse({
      kind: "http_error",
      status: 429,
      body: { errors: [{ code: "QuotaExceeded", message: "Rate limit" }] },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("throttled");
      expect(r.retryable).toBe(true);
      expect(r.originalCode).toBe("QuotaExceeded");
    }
  });

  it("500 → transient + retryable", () => {
    const r = mapPutListingsResponse({ kind: "http_error", status: 500 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("transient");
      expect(r.retryable).toBe(true);
    }
  });

  it("503 → transient + retryable", () => {
    const r = mapPutListingsResponse({ kind: "http_error", status: 503 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("transient");
  });

  it("4xx with NOT_FOUND code → catalog_deleted + not retryable", () => {
    const r = mapPutListingsResponse({
      kind: "http_error",
      status: 404,
      body: { errors: [{ code: "NOT_FOUND", message: "Requested resource not found" }] },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("catalog_deleted");
      expect(r.retryable).toBe(false);
      expect(r.originalCode).toBe("NOT_FOUND");
    }
  });

  it("4xx with INVALID_ASIN code → catalog_deleted", () => {
    const r = mapPutListingsResponse({
      kind: "http_error",
      status: 400,
      body: { errors: [{ code: "INVALID_ASIN", message: "ASIN B0XXX is invalid" }] },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("catalog_deleted");
  });

  it("4xx with catalog-deleted message (no code match) → catalog_deleted", () => {
    const r = mapPutListingsResponse({
      kind: "http_error",
      status: 400,
      body: { errors: [{ code: "GENERIC", message: "Product not found in catalog" }] },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("catalog_deleted");
  });

  it("403 with gating code → gated", () => {
    const r = mapPutListingsResponse({
      kind: "http_error",
      status: 403,
      body: { errors: [{ code: "90220020", message: "Approval required" }] },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("gated");
      expect(r.retryable).toBe(false);
    }
  });

  it("403 with gating message → gated", () => {
    const r = mapPutListingsResponse({
      kind: "http_error",
      status: 403,
      body: { errors: [{ code: "X", message: "You are not authorized to list this ASIN" }] },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("gated");
  });

  it("4xx unrecognized → unknown + preserves originalCode/Message", () => {
    const r = mapPutListingsResponse({
      kind: "http_error",
      status: 400,
      body: { errors: [{ code: "WEIRD_BAD_REQUEST", message: "Something we haven't seen before" }] },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unknown");
      expect(r.originalCode).toBe("WEIRD_BAD_REQUEST");
      expect(r.originalMessage).toBe("Something we haven't seen before");
      expect(r.rawResponse).toBeDefined();
    }
  });

  it("401 (auth) → unknown (we don't have a specific bucket)", () => {
    const r = mapPutListingsResponse({
      kind: "http_error",
      status: 401,
      body: { errors: [{ code: "Unauthorized", message: "Bad token" }] },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unknown");
  });

  it("HTTP error with no body → unknown with HTTP status fallback message", () => {
    const r = mapPutListingsResponse({ kind: "http_error", status: 418 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unknown");
      expect(r.originalMessage).toBe("HTTP 418");
      expect(r.originalCode).toBeNull();
    }
  });
});

// ============================================================================
// HTTP 200 success path (body.status === "ACCEPTED")
// ============================================================================
describe("mapPutListingsResponse — 200-ACCEPTED success path", () => {
  it("ACCEPTED with no issues → ok=true, warnings=[]", () => {
    const r = mapPutListingsResponse({
      kind: "ok",
      body: { sku: "AMG-BPC-X8M-RRC-001", status: "ACCEPTED", submissionId: "sub-123" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sku).toBe("AMG-BPC-X8M-RRC-001");
      expect(r.submissionId).toBe("sub-123");
      expect(r.warnings).toEqual([]);
    }
  });

  it("ACCEPTED with WARNING-only issues → ok=true, warnings populated", () => {
    const r = mapPutListingsResponse({
      kind: "ok",
      body: {
        sku: "AMG-BPC-X8M-RRC-001",
        status: "ACCEPTED",
        submissionId: "sub-456",
        issues: [
          { code: "INCOMPLETE_IMAGE", message: "Image missing alt text", severity: "WARNING" },
        ],
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0].code).toBe("INCOMPLETE_IMAGE");
    }
  });

  it("ACCEPTED with expiration WARNING → ok=false, reason=expiration_issue (spec carve-out)", () => {
    // Even on 200-ACCEPTED, an expiration issue means full failure per spec.
    const r = mapPutListingsResponse({
      kind: "ok",
      body: {
        sku: "...",
        status: "ACCEPTED",
        submissionId: "sub-789",
        issues: [{ code: "8541", message: "Expiration date is required", severity: "WARNING" }],
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("expiration_issue");
      expect(r.originalCode).toBe("8541");
      expect(r.retryable).toBe(false);
    }
  });
});

// ============================================================================
// HTTP 200 INVALID path (same HTTP status as success — body.status === "INVALID")
// This is the trickiest path — same HTTP code as success, must inspect body.
// ============================================================================
describe("mapPutListingsResponse — 200-INVALID path", () => {
  it("INVALID with gating code → gated", () => {
    const r = mapPutListingsResponse({
      kind: "ok",
      body: {
        sku: "...",
        status: "INVALID",
        issues: [{ code: "90220020", message: "Approval required to list this brand", severity: "ERROR" }],
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("gated");
      expect(r.originalCode).toBe("90220020");
    }
  });

  it("INVALID with gating message (no code match) → gated", () => {
    const r = mapPutListingsResponse({
      kind: "ok",
      body: {
        sku: "...",
        status: "INVALID",
        issues: [{ code: "OTHER", message: "Brand registry restriction applies", severity: "ERROR" }],
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("gated");
  });

  it("INVALID with catalog-deleted code → catalog_deleted", () => {
    const r = mapPutListingsResponse({
      kind: "ok",
      body: {
        sku: "...",
        status: "INVALID",
        issues: [{ code: "ASIN_NOT_FOUND", message: "ASIN does not exist", severity: "ERROR" }],
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("catalog_deleted");
  });

  it("INVALID with expiration code → expiration_issue (not invalid_attribute)", () => {
    const r = mapPutListingsResponse({
      kind: "ok",
      body: {
        sku: "...",
        status: "INVALID",
        issues: [{ code: "EXPIRATION_REQUIRED", message: "Set expiration date", severity: "ERROR" }],
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("expiration_issue");
  });

  it("INVALID with expiration message → expiration_issue", () => {
    const r = mapPutListingsResponse({
      kind: "ok",
      body: {
        sku: "...",
        status: "INVALID",
        issues: [{ code: "X", message: "Product is expired", severity: "ERROR" }],
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("expiration_issue");
  });

  it("INVALID with generic ERROR (no special pattern) → invalid_attribute", () => {
    const r = mapPutListingsResponse({
      kind: "ok",
      body: {
        sku: "...",
        status: "INVALID",
        issues: [{ code: "INVALID_VALUE", message: "Required field 'color' is missing", severity: "ERROR" }],
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("invalid_attribute");
      expect(r.originalCode).toBe("INVALID_VALUE");
    }
  });

  it("INVALID with both WARNING and ERROR → classifies by ERROR (warnings ignored for failure type)", () => {
    const r = mapPutListingsResponse({
      kind: "ok",
      body: {
        sku: "...",
        status: "INVALID",
        issues: [
          { code: "NICE_TO_HAVE", message: "Bullet points recommended", severity: "WARNING" },
          { code: "REQUIRED_MISSING", message: "Required attribute 'brand' missing", severity: "ERROR" },
        ],
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("invalid_attribute");
      expect(r.originalCode).toBe("REQUIRED_MISSING");
    }
  });

  it("INVALID with multiple ERRORs, first matches gating → gated (first-match-wins)", () => {
    const r = mapPutListingsResponse({
      kind: "ok",
      body: {
        sku: "...",
        status: "INVALID",
        issues: [
          { code: "90220020", message: "Approval required", severity: "ERROR" },
          { code: "INVALID_VALUE", message: "Bad color enum", severity: "ERROR" },
        ],
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("gated");
  });

  it("INVALID with no issues at all → unknown (weird shape, preserve raw)", () => {
    const r = mapPutListingsResponse({
      kind: "ok",
      body: { sku: "...", status: "INVALID", issues: [] },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("unknown");
      expect(r.rawResponse).toBeDefined();
    }
  });

  it("INVALID with only WARNING issues (no ERRORs) → unknown (genuinely odd; expiration check would catch expiration warnings first)", () => {
    const r = mapPutListingsResponse({
      kind: "ok",
      body: {
        sku: "...",
        status: "INVALID",
        issues: [{ code: "NICE_TO_HAVE", message: "Image quality could be better", severity: "WARNING" }],
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unknown");
  });

  it("INVALID with rawResponse preserved for human review", () => {
    const body = { sku: "X", status: "INVALID" as const, issues: [] };
    const r = mapPutListingsResponse({ kind: "ok", body });
    if (!r.ok) {
      expect(r.rawResponse).toBe(body);
    }
  });
});

// ============================================================================
// unknown-fallthrough preservation
// ============================================================================
describe("mapPutListingsResponse — unknown bucket always preserves originals", () => {
  it("HTTP 4xx unrecognized: originalCode + originalMessage + rawResponse all present", () => {
    const body = { errors: [{ code: "FOO", message: "bar baz" }] };
    const r = mapPutListingsResponse({ kind: "http_error", status: 402, body });
    if (!r.ok && r.reason === "unknown") {
      expect(r.originalCode).toBe("FOO");
      expect(r.originalMessage).toBe("bar baz");
      expect(r.rawResponse).toBe(body);
    }
  });
});

// ============================================================================
// Matcher helpers (exported for fine-grained testing + future config tuning)
// ============================================================================
describe("matcher helpers", () => {
  it("matchesCatalogDeleted: codes + message patterns", () => {
    expect(matchesCatalogDeleted("NOT_FOUND", "")).toBe(true);
    expect(matchesCatalogDeleted("INVALID_ASIN", "")).toBe(true);
    expect(matchesCatalogDeleted("ASIN_NOT_FOUND", "")).toBe(true);
    expect(matchesCatalogDeleted("90100003", "")).toBe(true);
    expect(matchesCatalogDeleted(null, "Invalid ASIN B0XYZ provided")).toBe(true);
    expect(matchesCatalogDeleted(null, "ASIN not found in marketplace")).toBe(true);
    expect(matchesCatalogDeleted(null, "Product not found in catalog")).toBe(true);
    expect(matchesCatalogDeleted("UNKNOWN", "normal error message")).toBe(false);
  });

  it("matchesGated: codes + message patterns", () => {
    expect(matchesGated("90220020", "")).toBe(true);
    expect(matchesGated("90230001", "")).toBe(true);
    expect(matchesGated(null, "Approval required for this brand")).toBe(true);
    expect(matchesGated(null, "You are not authorized to list this product")).toBe(true);
    expect(matchesGated(null, "Brand Registry restriction applies")).toBe(true);
    expect(matchesGated("X", "Color enum is invalid")).toBe(false);
  });

  it("matchesExpiration: case-insensitive, matches all expir* variants", () => {
    expect(matchesExpiration("EXPIRATION_REQUIRED")).toBe(true);
    expect(matchesExpiration("expires_at_missing")).toBe(true);
    expect(matchesExpiration("Product has expired")).toBe(true);
    expect(matchesExpiration("expiry date needed")).toBe(true);
    expect(matchesExpiration("Color enum invalid")).toBe(false);
    expect(matchesExpiration(undefined)).toBe(false);
  });
});
