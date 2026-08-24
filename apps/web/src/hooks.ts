import { useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedFetch, type JarvisEvent } from './api.ts';

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
    let controller: AbortController | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const connect = async () => {
      if (closed) return;
      controller = new AbortController();
      try {
        const response = await authenticatedFetch(`/api/events?afterId=${lastId.current}`, {
          signal: controller.signal,
          headers: { accept: 'text/event-stream' },
        });
        if (!response.ok || !response.body) throw new Error(`event stream ${response.status}`);
        setConnected(true);
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let pending = '';
        while (!closed) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += value;
          const frames = pending.split(/\r?\n\r?\n/);
          pending = frames.pop() ?? '';
          for (const frame of frames) {
            const data = frame
              .split(/\r?\n/)
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n');
            if (!data) continue;
            const event = JSON.parse(data) as JarvisEvent;
            if (event.id) lastId.current = Math.max(lastId.current, event.id);
            handler.current(event);
          }
        }
      } catch {
        if (closed || controller.signal.aborted) return;
      } finally {
        setConnected(false);
        if (!closed) retry = setTimeout(() => void connect(), 1500);
      }
    };
    void connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      controller?.abort();
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
