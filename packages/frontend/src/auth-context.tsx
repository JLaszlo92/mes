import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { API_BASE, setApiToken, setUnauthorizedHandler } from "./api.js";

interface AuthState {
  token: string;
  role: string;
}

interface AuthContextValue {
  auth: AuthState | null;
  mfaPendingToken: string | null;
  mfaSetupRequired: boolean;
  login: (email: string, password: string) => Promise<void>;
  submitMfaCode: (code: string) => Promise<void>;
  completeMfaSetup: () => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const STORAGE_KEY = "mes-auth";

function readStoredAuth(): AuthState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AuthState>;
    return typeof parsed.token === "string" && typeof parsed.role === "string"
      ? { token: parsed.token, role: parsed.role }
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
      applyAuth({ token: data.token, role: data.role });
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
      applyAuth({ token: data.token, role: data.role });
    },
    [mfaPendingToken, applyAuth],
  );

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
      value={{ auth, mfaPendingToken, mfaSetupRequired, login, submitMfaCode, completeMfaSetup, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
