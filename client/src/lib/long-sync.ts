// Long-sync fetch (2026-08-11). The buffered sync endpoints used to send zero
// bytes until completion; Chrome aborts a byte-silent response around the
// 5-minute mark, so long syncs showed a red "sync failed" toast while the
// server kept working (and later logged 200). Those endpoints now stream a
// heartbeat line every 15s, then exactly one terminal line:
//   { type: "result", data }  → resolve with data
//   { type: "error", message } → reject with the server's error, verbatim
// Guard-path failures (503/400 before the stream starts) are plain JSON and
// surface via the !res.ok branch. There is NO client-side timeout — the
// heartbeat keeps the connection alive for as long as the sync runs.
export async function fetchLongSync(url: string, body?: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).message || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.type === "result") return msg.data;
      if (msg.type === "error") throw new Error(msg.message ?? "sync failed");
      // heartbeat → keep reading
    }
  }
  throw new Error("Sync stream ended without a result");
}
