import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Principal, Role } from "@clearframe/shared";
import { api, ApiError } from "@/api/client";

const TOKEN_KEY = "clearframe.token";

interface AuthValue {
  user: Principal | null;
  ready: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  register: (input: { orgName: string; name: string; email: string; password: string }) => Promise<void>;
  signOut: () => void;
  /** Server-side authority is the real gate; this only decides what to render. */
  can: (...roles: Role[]) => boolean;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Principal | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (!stored) { setReady(true); return; }
    api.setToken(stored);
    api.me()
      .then((r) => setUser(r.user))
      .catch(() => { localStorage.removeItem(TOKEN_KEY); api.setToken(null); })
      .finally(() => setReady(true));
  }, []);

  const adopt = useCallback((token: string, principal: Principal) => {
    localStorage.setItem(TOKEN_KEY, token);
    api.setToken(token);
    setUser(principal);
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const r = await api.login(email, password);
    adopt(r.token, r.user);
  }, [adopt]);

  const register = useCallback(async (input: { orgName: string; name: string; email: string; password: string }) => {
    const r = await api.register(input);
    adopt(r.token, r.user);
  }, [adopt]);

  const signOut = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    api.logout();
    setUser(null);
  }, []);

  const value = useMemo<AuthValue>(() => ({
    user, ready, signIn, register, signOut,
    can: (...roles: Role[]) => (user ? roles.includes(user.role) : false),
  }), [user, ready, signIn, register, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

export const isAuthError = (err: unknown): boolean =>
  err instanceof ApiError && (err.status === 401 || err.status === 403);
