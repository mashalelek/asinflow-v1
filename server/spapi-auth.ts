// LWA token + thin HTTP wrappers for SP-API. Lifted out of server/spapi.ts so
// modules that need SP-API access (e.g. sku-catalog-fetch) can import without
// transitively pulling in server/index.ts (Express boot). spapi.ts re-exports
// these for backwards compatibility.

import axios from "axios";
import { withRateLimit } from "./spapi-rate-limit";

const SP_API_BASE = "https://sellingpartnerapi-na.amazon.com";

interface SpApiTokens {
  accessToken: string;
  expiresAt: number;
}

let cachedTokens: SpApiTokens | null = null;

export async function getAccessToken(): Promise<string> {
  if (cachedTokens && Date.now() < cachedTokens.expiresAt - 60000) {
    return cachedTokens.accessToken;
  }

  const clientId = process.env.SP_API_CLIENT_ID;
  const clientSecret = process.env.SP_API_CLIENT_SECRET;
  const refreshToken = process.env.SP_API_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "SP-API credentials not configured. Add SP_API_CLIENT_ID, SP_API_CLIENT_SECRET, and SP_API_REFRESH_TOKEN to your environment.",
    );
  }

  const res = await axios.post("https://api.amazon.com/auth/o2/token", {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  cachedTokens = {
    accessToken: res.data.access_token,
    expiresAt: Date.now() + res.data.expires_in * 1000,
  };

  return cachedTokens.accessToken;
}

// SPEC §11 "SP-API rate limiting" (2026-09-06): every request goes through
// the shared per-operation token-bucket limiter (429s handled there, once)
// and carries a hard timeout — a hung socket ends as a per-item error, never
// a frozen job (decision 9: 30 s per API request; the S3 report-document
// download is a plain URL outside these wrappers and uses its own 120 s).
const SP_API_TIMEOUT_MS = 30_000;
// The LWA token is read INSIDE the rate-limited send (2026-10-19): a request
// can wait in its bucket's queue — minutes for createReport — and a token
// fetched before the wait can expire before the request leaves (ledger
// backfill job 13: "The access token you provided has expired").

export async function spApiGet(endpoint: string, params?: Record<string, any>) {
  const res = await withRateLimit(endpoint, async () => {
    const token = await getAccessToken();
    return axios.get(`${SP_API_BASE}${endpoint}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "x-amz-access-token": token,
        "Content-Type": "application/json",
      },
      params,
      timeout: SP_API_TIMEOUT_MS,
    });
  });
  return res.data;
}

export async function spApiPost(endpoint: string, body: any) {
  const res = await withRateLimit(endpoint, async () => {
    const token = await getAccessToken();
    return axios.post(`${SP_API_BASE}${endpoint}`, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        "x-amz-access-token": token,
        "Content-Type": "application/json",
      },
      timeout: SP_API_TIMEOUT_MS,
    });
  });
  return res.data;
}

// DA-4: PUT for putListingsItem (Listings Items API 2021-08-01). Mirrors the
// spApiGet/spApiPost pattern. Caller passes query params (e.g. marketplaceIds)
// separately from the body. Errors propagate as axios rejections — caller is
// expected to translate via mapPutListingsResponse to get the typed AF outcome.
export async function spApiPut(
  endpoint: string,
  body: any,
  params?: Record<string, any>,
) {
  const res = await withRateLimit(endpoint, async () => {
    const token = await getAccessToken();
    return axios.put(`${SP_API_BASE}${endpoint}`, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        "x-amz-access-token": token,
        "Content-Type": "application/json",
      },
      params,
      timeout: SP_API_TIMEOUT_MS,
    });
  });
  return res.data;
}

// Listing hygiene (SPEC §11 components 22 / 24, 2026-10-19): PATCH for
// patchListingsItem (close) and DELETE for deleteListingsItem. Same single
// choke point as GET/POST/PUT — the path decides the bucket, so both land in
// `listings.items` (5 rps / burst 10) with getListingsItem and the PUT. No
// listings write may be sent outside these wrappers.
export async function spApiPatch(
  endpoint: string,
  body: any,
  params?: Record<string, any>,
) {
  const res = await withRateLimit(endpoint, async () => {
    const token = await getAccessToken();
    return axios.patch(`${SP_API_BASE}${endpoint}`, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        "x-amz-access-token": token,
        "Content-Type": "application/json",
      },
      params,
      timeout: SP_API_TIMEOUT_MS,
    });
  });
  return res.data;
}

export async function spApiDelete(endpoint: string, params?: Record<string, any>) {
  const res = await withRateLimit(endpoint, async () => {
    const token = await getAccessToken();
    return axios.delete(`${SP_API_BASE}${endpoint}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "x-amz-access-token": token,
        "Content-Type": "application/json",
      },
      params,
      timeout: SP_API_TIMEOUT_MS,
    });
  });
  return res.data;
}
