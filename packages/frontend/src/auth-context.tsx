import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { API_BASE, setApiToken, setUnauthorizedHandler } from "./api.js";

interface AuthState {
  token: string;
  /** Role id (admin, planner, operator, …). */
  role: string;
  roleName?: string;
  name?: string;
  userId?: string;
  /** What this user may do; the backend enforces the same list (permissions.ts). */
  permissions: string[];
  /** false until the server confirmed the permissions (an older stored session has none). */
  permissionsKnown: boolean;
}

interface AuthContextValue {
  auth: AuthState | null;
  mfaPendingToken: string | null;
  mfaSetupRequired: boolean;
  login: (email: string, password: string) => Promise<void>;
  submitMfaCode: (code: string) => Promise<void>;
  completeMfaSetup: () => void;
  logout: () => void;
  /** Does the signed-in user hold this permission? */
  can: (permission: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const STORAGE_KEY = "mes-auth";

function readStoredAuth(): AuthState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AuthState>;
    // Older stored sessions have no permission list: it is fetched right after start (/api/auth/me).
    return typeof parsed.token === "string" && typeof parsed.role === "string"
      ? { token: parsed.token, role: parsed.role, roleName: parsed.roleName, name: parsed.name, userId: parsed.userId, permissions: Array.isArray(parsed.permissions) ? parsed.permissions : [], permissionsKnown: Array.isArray(parsed.permissions) }
      : null;
  } catch {
    // Sérült localStorage érték ne akassza meg az egész alkalmazást.
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuthState] = useState<AuthState | null>(() => {
    const stored = readStoredAuth();
    // Szinkronban, még az első render előtt: a gyerek komponensek effektjei
    // a szülőé ELŐTT futnak, így egy useEffect-ben beállított token az első
    // API-hívásokról lemaradna.
    setApiToken(stored?.token ?? null);
    return stored;
  });
  const [mfaPendingToken, setMfaPendingToken] = useState<string | null>(null);
  const [mfaSetupRequired, setMfaSetupRequired] = useState(false);

  /** Az auth állapot egyetlen írási pontja — az apiFetch tokenjét is szinkronban frissíti. */
  const applyAuth = useCallback((next: AuthState | null) => {
    setApiToken(next?.token ?? null);
    setAuthState(next);
  }, []);

  useEffect(() => {
    if (auth) localStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
    else localStorage.removeItem(STORAGE_KEY);
  }, [auth]);

  // Lejárt vagy visszavont session: bármely hitelesített API-hívás 401-e
  // kilépteti a felhasználót. A szerveroldali session ilyenkor már nem él,
  // ezért logout-kérést nem küldünk.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      applyAuth(null);
      setMfaPendingToken(null);
      setMfaSetupRequired(false);
    });
    return () => setUnauthorizedHandler(null);
  }, [applyAuth]);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `${res.status} ${res.statusText}`);
      }
      const data = await res.json();
      if (data.mfaRequired) {
        setMfaPendingToken(data.pendingToken);
        return;
      }
      applyAuth(fromResponse(data.token, data));
      setMfaSetupRequired(Boolean(data.mfaSetupRequired));
    },
    [applyAuth],
  );

  const submitMfaCode = useCallback(
    async (code: string) => {
      const res = await fetch(`${API_BASE}/api/auth/mfa/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pendingToken: mfaPendingToken, code }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `${res.status} ${res.statusText}`);
      }
      const data = await res.json();
      setMfaPendingToken(null);
      applyAuth(fromResponse(data.token, data));
    },
    [mfaPendingToken, applyAuth],
  );

  // The role's permissions can change while signed in (Admin → Roles): fetched
  // at start, every 5 minutes and when the tab comes back.
  const token = auth?.token;
  useEffect(() => {
    if (!token) return;
    let alive = true;
    const refresh = () => {
      fetch(`${API_BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
        .then(async (res) => {
          if (!alive) return;
          if (res.status === 401) {
            applyAuth(null);
            return;
          }
          if (!res.ok) return;
          const data = await res.json();
          if (!alive) return;
          applyAuth(fromResponse(token, data));
          if (data.mfaSetupRequired) setMfaSetupRequired(true);
        })
        .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 5 * 60_000);
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [token, applyAuth]);

  const can = useCallback((permission: string) => auth?.permissions.includes(permission) ?? false, [auth]);

  const completeMfaSetup = useCallback(() => setMfaSetupRequired(false), []);

  const logout = useCallback(() => {
    if (auth) {
      fetch(`${API_BASE}/api/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${auth.token}` },
      }).catch(() => {});
    }
    applyAuth(null);
    setMfaPendingToken(null);
    setMfaSetupRequired(false);
  }, [auth, applyAuth]);

  return (
    <AuthContext.Provider
      value={{ auth, mfaPendingToken, mfaSetupRequired, login, submitMfaCode, completeMfaSetup, logout, can }}
    >
      {children}
    </AuthContext.Provider>
  );
}

function fromResponse(token: string, data: { role: string; roleName?: string; name?: string; userId?: string; permissions?: string[] }): AuthState {
  return { token, role: data.role, roleName: data.roleName, name: data.name, userId: data.userId, permissions: Array.isArray(data.permissions) ? data.permissions : [], permissionsKnown: true };
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
