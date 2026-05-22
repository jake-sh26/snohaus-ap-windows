import { QueryClient, QueryFunction } from "@tanstack/react-query";

// Local Express serves both frontend and API on the same port — no proxy needed.
const API_BASE = "";

const TOKEN_KEY = "snohaus_token";

/**
 * PR #R4g — Always read the token from localStorage AT REQUEST TIME.
 *
 * The previous implementation cached the token in a module-level `authToken`
 * variable, set once at module init and mutated by setAuthToken. That worked
 * for the common login flow but broke on a relogin mid-session: if anything
 * else (a stale closure, a raw fetch outside this module, a tab that wrote
 * the new token from a different code path) updated localStorage without
 * routing through setAuthToken, the in-memory copy stayed stale and every
 * subsequent request sent the old/dead token.
 *
 * Reading fresh on each request is cheap (synchronous localStorage hit) and
 * eliminates the entire class of "I have a fresh token in storage but my
 * requests are 401ing" bugs.
 */
function readTokenFresh(): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;
  } catch {
    return null;
  }
}

export function setAuthToken(token: string | null) {
  try {
    if (typeof localStorage === "undefined") return;
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

export function getAuthToken(): string | null {
  // External callers (AuthProvider seed-from-storage) also get the fresh read,
  // so an external write-then-read sequence is always coherent.
  return readTokenFresh();
}

/**
 * Centralized 401 handler. Clears the token, fires a window event so a top-
 * level component can show a "session expired" banner, and bounces to the
 * login hash route. The event lets the banner appear even on background
 * polls (where there's no UI mutation to attach a toast to).
 *
 * Idempotent — multiple 401s in flight at once all converge on the same
 * cleared state without thrashing.
 */
function handle401() {
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
  if (typeof window !== "undefined") {
    // Fire once; listeners coalesce their own re-renders.
    try { window.dispatchEvent(new CustomEvent("auth-expired")); } catch {}
    if (!window.location.hash.startsWith("#/login")) {
      window.location.hash = "#/login";
    }
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
  // PR #R4g — fresh-read on every request so a token swap is picked up
  // immediately, no module restart required.
  const token = readTokenFresh();
  if (token) headers["Authorization"] = `Bearer ${token}`;

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
    // PR #R4g — same fresh-read for React Query's default fetcher.
    const token = readTokenFresh();
    if (token) headers["Authorization"] = `Bearer ${token}`;
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
