// Read-only: capture x-amzn-RateLimit-Limit header from getItemOffers
// to confirm our account's actual per-second rate.
import "dotenv/config";
import axios from "axios";

let cachedToken: { value: string; expiresAt: number } | null = null;
async function getAccessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60000) return cachedToken.value;
  const res = await axios.post("https://api.amazon.com/auth/o2/token", {
    grant_type: "refresh_token",
    refresh_token: process.env.SP_API_REFRESH_TOKEN!,
    client_id: process.env.SP_API_CLIENT_ID!,
    client_secret: process.env.SP_API_CLIENT_SECRET!,
  });
  cachedToken = { value: res.data.access_token, expiresAt: Date.now() + res.data.expires_in * 1000 };
  return cachedToken.value;
}

(async () => {
  const token = await getAccessToken();
  // Hit getItemOffers once with a known-good ASIN; capture headers.
  const res = await axios.get(
    "https://sellingpartnerapi-na.amazon.com/products/pricing/v0/items/B00CA6Z37C/offers",
    {
      headers: { Authorization: `Bearer ${token}`, "x-amz-access-token": token },
      params: { MarketplaceId: "ATVPDKIKX0DER", ItemCondition: "New" },
    },
  );
  console.log("Status:", res.status);
  // Surface every header containing 'rate' or 'amzn' for completeness
  for (const [k, v] of Object.entries(res.headers)) {
    if (k.toLowerCase().includes("rate") || k.toLowerCase().includes("amzn")) {
      console.log(`  ${k}: ${v}`);
    }
  }
})().catch((err) => {
  console.error("Failed:", err.response?.status, err.message);
  // Even on error, show headers if present
  if (err.response?.headers) {
    for (const [k, v] of Object.entries(err.response.headers)) {
      if (k.toLowerCase().includes("rate") || k.toLowerCase().includes("amzn")) {
        console.log(`  ${k}: ${v}`);
      }
    }
  }
});
