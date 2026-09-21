import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";

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

const WS_URL = import.meta.env.VITE_BACKEND_WS_URL ?? "ws://localhost:3001/ws";
const API_BASE = WS_URL.replace(/^ws/, "http").replace(/\/ws$/, "");
const STORAGE_KEY = "mes-auth";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState | null>(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AuthState) : null;
  });
  const [mfaPendingToken, setMfaPendingToken] = useState<string | null>(null);
  const [mfaSetupRequired, setMfaSetupRequired] = useState(false);

  useEffect(() => {
    if (auth) localStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
    else localStorage.removeItem(STORAGE_KEY);
  }, [auth]);

  const login = useCallback(async (email: string, password: string) => {
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
    setAuth({ token: data.token, role: data.role });
    setMfaSetupRequired(Boolean(data.mfaSetupRequired));
  }, []);

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
      setAuth({ token: data.token, role: data.role });
    },
    [mfaPendingToken],
  );

  const completeMfaSetup = useCallback(() => setMfaSetupRequired(false), []);

  const logout = useCallback(() => {
    if (auth) {
      fetch(`${API_BASE}/api/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${auth.token}` },
      }).catch(() => {});
    }
    setAuth(null);
    setMfaPendingToken(null);
    setMfaSetupRequired(false);
  }, [auth]);

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