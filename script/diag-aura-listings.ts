// DIAGNOSTIC ONLY — read-only. GET requests to Aura only; no writes to Aura,
// no AF changes. Inspects the /listings response shape for the cost-sync design.
import "dotenv/config";
import axios from "axios";

const BASE = "https://api.goaura.com";

function client() {
  const key = process.env.AURA_API_KEY;
  if (!key) {
    console.error("FATAL: AURA_API_KEY is not set. HTTP Basic auth needs the API key as the");
    console.error("       username (empty password). Add AURA_API_KEY to .env or export it, then re-run.");
    process.exit(1);
  }
  // HTTP Basic: username = API key, password = empty.
  return axios.create({ baseURL: BASE, auth: { username: key, password: "" }, timeout: 30000 });
}

// Heuristically locate the array of listings and any pagination fields in an
// unknown envelope shape.
function findListingsArray(data: any): { key: string | null; arr: any[] } {
  if (Array.isArray(data)) return { key: "(root array)", arr: data };
  for (const k of ["listings", "data", "results", "items"]) {
    if (Array.isArray(data?.[k])) return { key: k, arr: data[k] };
  }
  // fallback: first array-valued top-level property
  for (const [k, v] of Object.entries(data ?? {})) {
    if (Array.isArray(v)) return { key: k, arr: v as any[] };
  }
  return { key: null, arr: [] };
}

async function main() {
  const api = client();

  console.log("=== GET /listings ===");
  const res = await api.get("/listings");
  const data = res.data;

  // (2) envelope shape
  console.log("HTTP status:", res.status);
  console.log("top-level type:", Array.isArray(data) ? "array" : typeof data);
  if (!Array.isArray(data)) console.log("top-level keys:", JSON.stringify(Object.keys(data ?? {})));
  const paginationKeys = Object.keys(data ?? {}).filter((k) =>
    /page|cursor|next|prev|total|count|offset|limit|has_more|links|meta/i.test(k),
  );
  console.log("pagination-ish top-level fields:", JSON.stringify(paginationKeys));
  for (const k of paginationKeys) console.log(`   ${k} =`, JSON.stringify(data[k]));

  const { key, arr } = findListingsArray(data);
  console.log(`listings array at key: ${key} — count this call: ${arr.length}`);

  // (3) first 3 listings, full raw JSON
  console.log("\n=== FIRST 3 LISTINGS (full raw JSON) ===");
  for (let i = 0; i < Math.min(3, arr.length); i++) {
    console.log(`\n--- listing[${i}] ---`);
    console.log(JSON.stringify(arr[i], null, 2));
  }

  // (4) page 2 only, if a mechanism is detectable
  console.log("\n=== PAGE 2 (mechanism confirmation only) ===");
  try {
    const linksNext = data?.links?.next;
    const nextCursor = data?.next_cursor ?? data?.cursor ?? data?.meta?.next_cursor;
    const hasPageField = paginationKeys.some((k) => /^page$/i.test(k)) || data?.meta?.page != null;

    let res2: any = null;
    if (typeof linksNext === "string") {
      console.log("mechanism: links.next URL →", linksNext);
      res2 = await axios.get(linksNext, { auth: { username: process.env.AURA_API_KEY!, password: "" } });
    } else if (nextCursor) {
      console.log("mechanism: cursor →", JSON.stringify(nextCursor));
      res2 = await api.get("/listings", { params: { cursor: nextCursor } });
    } else if (hasPageField) {
      console.log("mechanism: page param → page=2");
      res2 = await api.get("/listings", { params: { page: 2 } });
    } else {
      console.log("no pagination mechanism detected in the envelope — single-page response, skipping page 2.");
    }

    if (res2) {
      const { arr: arr2 } = findListingsArray(res2.data);
      const firstId = arr2[0]?.id ?? arr2[0]?.listing_id ?? arr2[0]?.listingId ?? "(no id field)";
      console.log(`page 2 count: ${arr2.length} — first listing id: ${JSON.stringify(firstId)}`);
    }
  } catch (e: any) {
    console.log("page 2 fetch error:", e?.response?.status, e?.response?.data ? JSON.stringify(e.response.data).slice(0, 200) : e?.message);
  }
}

main().catch((e) => {
  console.error("REQUEST FAILED:", e?.response?.status, e?.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : e?.message);
  process.exit(1);
});
