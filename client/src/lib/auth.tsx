import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { apiRequest, setAuthToken, getAuthToken } from "./queryClient";

/**
 * RBAC permission grant resolved for the currently logged-in user.
 * `entity_id_scope` of null means the grant applies to all entities.
 */
export type PermissionGrant = {
  key: string;
  entity_id_scope: number | null;
};

type AuthState = {
  email: string | null;
  token: string | null;
  role: "admin" | "user" | null;
  name: string | null;
  user_id: number | null;
  permissions: PermissionGrant[];
};

type AuthContextValue = AuthState & {
  setSession: (token: string, email: string, role?: "admin" | "user", name?: string | null) => void;
  logout: () => Promise<void>;
  /**
   * Permission check. Returns true if the user has the given permission key,
   * optionally for a specific entity. Pass entityId=undefined when scope doesn't
   * matter; entityId=number to require a grant that covers that entity
   * (either all-entities or that specific one).
   */
  hasPermission: (key: string, entityId?: number) => boolean;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const EMAIL_KEY = "snohaus_email";
const ROLE_KEY = "snohaus_role";

function readPersistedEmail(): string | null {
  try { return typeof localStorage !== "undefined" ? localStorage.getItem(EMAIL_KEY) : null; }
  catch { return null; }
}

function writePersistedEmail(email: string | null) {
  try {
    if (typeof localStorage === "undefined") return;
    if (email) localStorage.setItem(EMAIL_KEY, email);
    else localStorage.removeItem(EMAIL_KEY);
  } catch {}
}

function readPersistedRole(): "admin" | "user" | null {
  try {
    const r = typeof localStorage !== "undefined" ? localStorage.getItem(ROLE_KEY) : null;
    return (r === "admin" || r === "user") ? r : null;
  } catch { return null; }
}

function writePersistedRole(role: string | null) {
  try {
    if (typeof localStorage === "undefined") return;
    if (role) localStorage.setItem(ROLE_KEY, role);
    else localStorage.removeItem(ROLE_KEY);
  } catch {}
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // Seed state from localStorage so a page refresh inside the 1-day session
  // doesn't bounce the user to /login.
  const initialToken = getAuthToken();
  const initialEmail = readPersistedEmail();
  const initialRole = readPersistedRole();
  const [state, setState] = useState<AuthState>({
    email: initialToken ? initialEmail : null,
    token: initialToken,
    role: initialToken ? initialRole : null,
    name: null,
    user_id: null,
    permissions: [],
  });

  // Validate the persisted token against the server. If it's expired/invalid,
  // /api/me returns 401 and queryClient.handle401 will clear the token + redirect.
  useEffect(() => {
    if (!initialToken) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiRequest("GET", "/api/me");
        const json = await res.json();
        if (!cancelled && json?.email) {
          writePersistedEmail(json.email);
          writePersistedRole(json.role || "admin");
          setState({
            token: initialToken,
            email: json.email,
            role: json.role || "admin",
            name: json.name || null,
            user_id: json.user_id ?? null,
            permissions: Array.isArray(json.permissions) ? json.permissions : [],
          });
        }
      } catch {
        // queryClient.handle401 already cleared token + redirected on 401.
        if (!cancelled) setState({ email: null, token: null, role: null, name: null, user_id: null, permissions: [] });
      }
    })();
    return () => { cancelled = true; };
  }, [initialToken]);

  function setSession(token: string, email: string, role?: "admin" | "user", name?: string | null) {
    setAuthToken(token);
    writePersistedEmail(email);
    writePersistedRole(role || "admin");
    // Initial setSession (from login) doesn't include permissions — they get loaded
    // by the /api/me effect above on next render.
    setState({ token, email, role: role || "admin", name: name || null, user_id: null, permissions: [] });
    // Fire-and-forget refresh of permissions so the UI updates without a reload.
    (async () => {
      try {
        const res = await apiRequest("GET", "/api/me");
        const json = await res.json();
        setState((prev) => ({
          ...prev,
          user_id: json.user_id ?? null,
          permissions: Array.isArray(json.permissions) ? json.permissions : [],
          role: json.role || prev.role,
          name: json.name ?? prev.name,
        }));
      } catch {}
    })();
  }

  async function logout() {
    try {
      await apiRequest("POST", "/api/auth/logout");
    } catch {}
    setAuthToken(null);
    writePersistedEmail(null);
    writePersistedRole(null);
    setState({ email: null, token: null, role: null, name: null, user_id: null, permissions: [] });
    window.location.hash = "#/login";
  }

  function hasPermission(key: string, entityId?: number): boolean {
    if (!state.permissions || state.permissions.length === 0) return false;
    for (const p of state.permissions) {
      if (p.key !== key) continue;
      if (entityId === undefined) return true;
      if (p.entity_id_scope === null) return true; // all-entities grant
      if (p.entity_id_scope === entityId) return true;
    }
    return false;
  }

  return (
    <AuthContext.Provider value={{ ...state, setSession, logout, hasPermission }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be inside AuthProvider");
  return ctx;
}
