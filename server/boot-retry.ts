// Boot resilience (2026-11-13, SPEC §24 "Deployment"): when Postgres refuses connections while the server starts —
// Render's instance restarting, the database restarting, "service temporarily unavailable", too many connections —
// the start retries with backoff instead of exit 1 (a crash loop while the database came back, 11/12–11/13).
// Only connection-level failures are retried; a failing migration (MigrationError) still exits at once.

/** 2 s, 4 s, 8 s, … — Σ 120 s, then the error is rethrown. */
export const BOOT_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 32_000, 58_000];

const TRANSIENT_CODES = new Set([
  // node net errors
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "EHOSTUNREACH", "ENETUNREACH",
  // Postgres: connection exception class 08, cannot_connect_now, too many connections, admin / crash shutdown
  "08000", "08001", "08003", "08004", "08006", "57P03", "53300", "53000", "57P01", "57P02",
]);
const TRANSIENT_MESSAGE = /temporarily unavailable|starting up|shutting down|Connection terminated|timeout expired|too many (clients|connections)|socket hang up|server closed the connection|cannot_connect_now|the database system is|connect E[A-Z]+/i;

/** A failure that a later attempt can succeed on: the database was not reachable, not a wrong migration. */
export function isTransientDbError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; name?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  if (e.name === "MigrationError") return false;
  if (typeof e.code === "string" && TRANSIENT_CODES.has(e.code)) return true;
  return typeof e.message === "string" && TRANSIENT_MESSAGE.test(e.message);
}

export interface BootRetryOptions {
  delays?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  isTransient?: (err: unknown) => boolean;
}

/** `fn` with backoff on transient database errors; any other error, or the last transient one, is rethrown. */
export async function withBootRetry<T>(what: string, fn: () => Promise<T>, opts: BootRetryOptions = {}): Promise<T> {
  const delays = opts.delays ?? BOOT_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const transient = opts.isTransient ?? isTransientDbError;
  const log = opts.log ?? (() => {});
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (!transient(err) || attempt >= delays.length) throw err;
      const ms = delays[attempt];
      // node's connect failure is an AggregateError with an empty message and the code on it: name both
      const why = [err?.code, err?.message].filter((x) => typeof x === "string" && x).join(" ") || String(err);
      log(`${what}: database not reachable (${why}) — retrying in ${ms / 1000}s (attempt ${attempt + 1} of ${delays.length})`);
      await sleep(ms);
    }
  }
}
