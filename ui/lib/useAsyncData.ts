"use client";

import { useCallback, useEffect, useState } from "react";

interface AsyncState<T> {
  data: T | null;
  error: string;
  loading: boolean;
}

// Small fetch-on-mount helper. The effect only ever calls setState inside the
// promise callbacks (never synchronously), so it satisfies react-hooks'
// set-state-in-effect rule. `reload` re-runs it (from an event handler).
// `fn` must be stable (wrap it in useCallback in the caller).
export function useAsyncData<T>(fn: () => Promise<T>) {
  const [state, setState] = useState<AsyncState<T>>({ data: null, error: "", loading: true });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    fn()
      .then((d) => alive && setState({ data: d, error: "", loading: false }))
      .catch(
        (e) =>
          alive &&
          setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e), loading: false })),
      );
    return () => {
      alive = false;
    };
  }, [fn, nonce]);

  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: "" }));
    setNonce((n) => n + 1);
  }, []);

  return { ...state, reload, setData: (d: T) => setState((s) => ({ ...s, data: d })) };
}
