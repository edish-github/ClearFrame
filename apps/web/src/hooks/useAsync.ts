import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/api/client";

interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (next: T) => void;
}

/**
 * Loads once, exposes a reload, and never sets state after unmount. Errors are
 * carried as the server's own wording so screens can show it verbatim.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  const run = useRef(fn);
  run.current = fn;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const reload = useCallback(async () => {
    try {
      const next = await run.current();
      if (alive.current) { setData(next); setError(null); }
    } catch (err) {
      if (alive.current) {
        setError(err instanceof ApiError ? err.message : "Could not reach the server.");
      }
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => { setLoading(true); void reload(); /* eslint-disable-next-line */ }, deps);

  return { data, error, loading, reload, setData };
}
