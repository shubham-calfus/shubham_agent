"use client";

import { useEffect, useState } from "react";
import { Provider } from "react-redux";
import { makeStore } from "@/lib/realapi/store";
import { connectionHydrated, setConnection } from "@/lib/realapi/connectionSlice";

const STORAGE_KEY = "act-connection";

// Single store per browser session (lazy useState initializer keeps it stable
// without touching a ref during render). Connection state (env/token/realm) is
// hydrated from localStorage after mount (SSR-safe) and persisted on change.
export function ReduxProvider({ children }: { children: React.ReactNode }) {
  const [store] = useState(makeStore);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) store.dispatch(setConnection(JSON.parse(saved)));
    } catch {
      /* ignore malformed cache */
    }
    // Always mark hydrated, even with nothing stored, so source-dependent UI
    // stops waiting.
    store.dispatch(connectionHydrated());
    const unsubscribe = store.subscribe(() => {
      try {
        // `hydrated` is runtime-only — never persist it, or a reload would
        // start out claiming storage was already applied.
        const { source, token, realm } = store.getState().connection;
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ source, token, realm }));
      } catch {
        /* storage full / unavailable — non-fatal */
      }
    });
    return unsubscribe;
  }, [store]);

  return <Provider store={store}>{children}</Provider>;
}
