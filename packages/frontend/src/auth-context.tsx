
import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";

interface AuthState {
  token: string;
  role: string;
}

interface AuthContextValue {
  auth: AuthState | null;
  login: (email: string, password: string) => Promise<void>;
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
    setAuth({ token: data.token, role: data.role });
  }, []);

  const logout = useCallback(() => {
    if (auth) {
      // Best-effort — a szerver oldali session sort is töröljük, de a
      // kijelentkezés a kliens oldalon akkor is megtörténik, ha ez elszáll.
      fetch(`${API_BASE}/api/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${auth.token}` },
      }).catch(() => {});
    }
    setAuth(null);
  }, [auth]);

  return <AuthContext.Provider value={{ auth, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}