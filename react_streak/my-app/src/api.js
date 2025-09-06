import { auth } from "./auth";

const API_BASE = "http://localhost:4000";

// Generic fetch with Authorization header and 1-time refresh retry on 401
export async function api(path, opts = {}, retry = true) {
  const headers = {
    "Content-Type": "application/json",
    ...(opts.headers || {}),
  };
  if (auth.accessToken) headers.Authorization = `Bearer ${auth.accessToken}`;

  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers });
  if (res.status !== 401 || !retry) return res;

  // try refresh once
  const rt = auth.getRefreshToken();
  if (!rt) return res;

  const r2 = await fetch(`${API_BASE}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: rt }),
  });
  if (!r2.ok) return res;

  const { accessToken } = await r2.json();
  auth.setTokens({ accessToken });
  return api(path, opts, false);
}

// Convenience helpers that parse JSON
export async function apiJson(path, opts = {}) {
  const r = await api(path, opts);
  if (!r.ok) throw new Error(`${opts.method || "GET"} ${path} ${r.status}`);
  return r.json();
}

export const API_BASE_URL = API_BASE;
