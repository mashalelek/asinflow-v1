// One-shot delegation check (SPEC §26, patch po-tracking-velocity commit 2):
//   npm run gmail:check
// Lists the 5 most recent subjects in the orders@ mailbox through the
// service account's domain-wide delegation (gmail.readonly). Read-only.
import "dotenv/config";
import { gmailClient, listMessageIds, getMessage, GMAIL_SUBJECT } from "../server/gmail-client";

async function main() {
  const gmail = gmailClient();
  const ids = await listMessageIds(gmail, "", 5);
  console.log(`delegation OK — impersonating ${GMAIL_SUBJECT}; ${ids.length} most recent:`);
  for (const id of ids) {
    const m = await getMessage(gmail, id);
    console.log(`  ${m.date.toISOString()}  ${m.fromDomain ?? "?"}  ${m.subject}`);
  }
}

main().catch((err) => {
  const e = err?.response?.data ?? err;
  console.error("gmail:check FAILED:", JSON.stringify(e?.error ?? e?.message ?? e, null, 2), err?.message ? `(${err.message})` : "");
  process.exit(1);
});
