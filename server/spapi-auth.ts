// LWA token + thin HTTP wrappers for SP-API. Lifted out of server/spapi.ts so
// modules that need SP-API access (e.g. sku-catalog-fetch) can import without
// transitively pulling in server/index.ts (Express boot). spapi.ts re-exports
// these for backwards compatibility.

import axios from "axios";

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

export async function spApiGet(endpoint: string, params?: Record<string, any>) {
  const token = await getAccessToken();
  const res = await axios.get(`${SP_API_BASE}${endpoint}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "x-amz-access-token": token,
      "Content-Type": "application/json",
    },
    params,
  });
  return res.data;
}

export async function spApiPost(endpoint: string, body: any) {
  const token = await getAccessToken();
  const res = await axios.post(`${SP_API_BASE}${endpoint}`, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      "x-amz-access-token": token,
      "Content-Type": "application/json",
    },
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
  const token = await getAccessToken();
  const res = await axios.put(`${SP_API_BASE}${endpoint}`, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      "x-amz-access-token": token,
      "Content-Type": "application/json",
    },
    params,
  });
  return res.data;
}
