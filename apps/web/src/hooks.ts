import { useCallback, useEffect, useRef, useState } from 'react';
import type { JarvisEvent } from './api.ts';

/** Fetch-on-mount with a manual `reload`. Small enough not to warrant a query library. */
export function useAsync<T>(
  fn: () => Promise<T>,
  deps: unknown[],
): {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fnRef
      .current()
      .then((value) => {
        if (!cancelled) {
          setData(value);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { data, error, loading, reload: useCallback(() => setTick((t) => t + 1), []) };
}

/**
 * Live event stream over SSE.
 *
 * The server replays from the persisted log using `afterId`, so a dropped
 * connection resumes without losing events — this is why the UI can show real
 * progress instead of polling.
 */
export function useEventStream(onEvent: (event: JarvisEvent) => void): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const lastId = useRef(0);

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const connect = () => {
      if (closed) return;
      source = new EventSource(`/api/events?afterId=${lastId.current}`);
      source.onopen = () => setConnected(true);
      source.onmessage = (message) => {
        if (!message.data) return;
        try {
          const event = JSON.parse(message.data as string) as JarvisEvent;
          if (event.id) lastId.current = Math.max(lastId.current, event.id);
          handler.current(event);
        } catch {
          /* ignore keepalive frames */
        }
      };
      source.onerror = () => {
        setConnected(false);
        source?.close();
        if (!closed) retry = setTimeout(connect, 1500);
      };
    };
    connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }, []);

  return { connected };
}

export function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState(() => localStorage.getItem('jarvis-theme') ?? 'dark');
  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light');
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('jarvis-theme', theme);
  }, [theme]);
  return [theme, useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), [])];
}
