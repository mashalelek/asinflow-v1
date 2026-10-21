// Release confirmation (listing hygiene, Maria 2026-10-21). Every Release
// button goes through this flow: request() only opens the prompt; nothing is
// queued until confirm(). Pure so the "confirm before queue" rule is tested
// without a DOM (client/src/lib/release-flow.test.ts).
export type HygieneAction = "close" | "delete";

export interface ReleasePrompt { jobId: number; action: HygieneAction; count: number; text: string }

export function releasePromptText(action: HygieneAction, count: number): string {
  const n = `${count} listing${count === 1 ? "" : "s"}`;
  return `${action === "close" ? "Close" : "Delete"} ${n} in Seller Central? Each is re-checked live first.`;
}

export interface ReleaseFlow<R> {
  /** Open the confirm — queues nothing. */
  request: (jobId: number, action: HygieneAction, count: number) => ReleasePrompt;
  cancel: () => void;
  /** The ONLY path to the release call. Throws when nothing was requested. */
  confirm: () => Promise<R>;
  readonly prompt: ReleasePrompt | null;
}

export function createReleaseFlow<R>(release: (jobId: number, action: HygieneAction) => Promise<R>): ReleaseFlow<R> {
  let prompt: ReleasePrompt | null = null;
  return {
    request(jobId, action, count) {
      prompt = { jobId, action, count, text: releasePromptText(action, count) };
      return prompt;
    },
    cancel() { prompt = null; },
    async confirm() {
      if (!prompt) throw new Error("no release to confirm");
      const p = prompt;
      prompt = null; // one confirm, one request — a double click cannot queue twice
      return release(p.jobId, p.action);
    },
    get prompt() { return prompt; },
  };
}
