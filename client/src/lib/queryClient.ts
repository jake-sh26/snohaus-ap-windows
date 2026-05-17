import { QueryClient, QueryFunction } from "@tanstack/react-query";

// Local Express serves both frontend and API on the same port — no proxy needed.
const API_BASE = "";

const TOKEN_KEY = "snohaus_token";

// Token persisted to localStorage so reload doesn't kick the user back to login.
// (App runs natively on Windows, NOT in a sandboxed iframe.)
let authToken: string | null = (() => {
  try { return typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null; }
  catch { return null; }
})();

export function setAuthToken(token: string | null) {
  authToken = token;
  try {
    if (typeof localStorage === "undefined") return;
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

export function getAuthToken(): string | null {
  return authToken;
}

// Centralized 401 handler: clear token + bounce to login.
function handle401() {
  authToken = null;
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
  if (typeof window !== "undefined" && !window.location.hash.startsWith("#/login")) {
    window.location.hash = "#/login";
  }
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    if (res.status === 401) handle401();
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (data !== undefined) headers["Content-Type"] = "application/json";
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

  const res = await fetch(`${API_BASE}${url}`, {
    method,
    headers,
    body: data !== undefined ? JSON.stringify(data) : undefined,
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const headers: Record<string, string> = {};
    if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
    const res = await fetch(`${API_BASE}${queryKey.join("/")}`, { headers });

    if (res.status === 401) {
      handle401();
      if (unauthorizedBehavior === "returnNull") return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "returnNull" }),
      refetchInterval: false,
      refetchOnWindowFocus: true,
      // staleTime 0 — invalidations always trigger refetch immediately so list pages
      // update in real time after file/reject/post mutations from the drawer.
      staleTime: 0,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
