// The /api request log line (2026-10-21). Method, path, status and duration
// only — response bodies are NEVER logged: the old logger appended the whole
// JSON body, so GET /api/asins wrote every ASIN with its COGS, buy links and
// notes into Render's application logs. For a 4xx / 5xx the body's `error`
// and `message` strings are kept (truncated) so failures stay diagnosable;
// no other field is read.
const MAX_ERROR_CHARS = 300;

export function requestLogLine(method: string, path: string, status: number, durationMs: number, body?: unknown): string {
  let line = `${method} ${path} ${status} in ${durationMs}ms`;
  if (status >= 400 && body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const parts = [b.error, b.message].filter((v): v is string => typeof v === "string" && v.length > 0);
    if (parts.length) {
      const text = parts.join(": ");
      line += ` :: ${text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text}`;
    }
  }
  return line;
}
