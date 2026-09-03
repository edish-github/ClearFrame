"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Poll a projection.
 *
 * Firestore listeners are the other option and the endpoints return the same
 * shapes either way (see docs/FRONTEND-CONTRACT.md). Polling is what ships here:
 * it needs no client credentials, it works identically against a laptop and a
 * deployment, and at these payload sizes a one-second cadence is cheap.
 */
export function useLive<T>(
  loader: () => Promise<T>,
  intervalMs = 1500,
  deps: unknown[] = [],
): { data: T | null; error: string | null; loading: boolean; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(loader, deps);

  const refresh = useCallback(() => {
    load()
      .then((value) => {
        if (!alive.current) return;
        setData(value);
        setError(null);
      })
      .catch((cause: Error) => {
        if (alive.current) setError(cause.message);
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
  }, [load]);

  useEffect(() => {
    alive.current = true;
    refresh();
    if (intervalMs <= 0) return () => { alive.current = false; };
    const timer = setInterval(refresh, intervalMs);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh, intervalMs]);

  return { data, error, loading, refresh };
}

/** A one-shot async action with pending and error state, for buttons. */
export function useAction<Args extends unknown[], T>(
  fn: (...args: Args) => Promise<T>,
): {
  run: (...args: Args) => Promise<T | null>;
  pending: boolean;
  error: string | null;
  clearError: () => void;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (...args: Args) => {
      setPending(true);
      setError(null);
      try {
        return await fn(...args);
      } catch (cause) {
        setError((cause as Error).message);
        return null;
      } finally {
        setPending(false);
      }
    },
    [fn],
  );

  return { run, pending, error, clearError: () => setError(null) };
}
