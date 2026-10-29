// The app's console logger. Lives here, not in index.ts, because importing
// index.ts boots the server (migrations, Express, the job runner) — a script
// that reached it through a server module ran a second runner against
// whatever DATABASE_URL it had (script/relist.ts, 2026-10-29).
export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}
