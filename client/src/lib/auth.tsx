import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { apiRequest, setAuthToken, getAuthToken } from "./queryClient";

type AuthState = {
  email: string | null;
  token: string | null;
  role: "admin" | "user" | null;
  name: string | null;
};

type AuthContextValue = AuthState & {
  setSession: (token: string, email: string, role?: "admin" | "user", name?: string | null) => void;
  logout: () => Promise<void>;
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
          setState({ token: initialToken, email: json.email, role: json.role || "admin", name: json.name || null });
        }
      } catch {
        // queryClient.handle401 already cleared token + redirected on 401.
        if (!cancelled) setState({ email: null, token: null, role: null, name: null });
      }
    })();
    return () => { cancelled = true; };
  }, [initialToken]);

  function setSession(token: string, email: string, role?: "admin" | "user", name?: string | null) {
    setAuthToken(token);
    writePersistedEmail(email);
    writePersistedRole(role || "admin");
    setState({ token, email, role: role || "admin", name: name || null });
  }

  async function logout() {
    try {
      await apiRequest("POST", "/api/auth/logout");
    } catch {}
    setAuthToken(null);
    writePersistedEmail(null);
    writePersistedRole(null);
    setState({ email: null, token: null, role: null, name: null });
    window.location.hash = "#/login";
  }

  return (
    <AuthContext.Provider value={{ ...state, setSession, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be inside AuthProvider");
  return ctx;
}
