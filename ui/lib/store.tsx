"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { RunResult } from "./types";

// --------------------------------------------------------------------------
// In-memory app state shared across pages: the suite being assembled, the run
// output tabs, and toast notifications. Kept client-side only (no persistence)
// so a page refresh starts clean — matching shubham_agent's session model.
// --------------------------------------------------------------------------

export interface Toast {
  id: number;
  kind: "ok" | "err" | "info";
  text: string;
}

export interface RunTab {
  id: string;
  label: string;
  kind: "single" | "suite";
  startedAt: number;
  status: "running" | "done" | "error";
  result?: RunResult;
  error?: string;
}

interface Store {
  suite: string[];
  inSuite: (name: string) => boolean;
  toggleSuite: (name: string) => void;
  removeFromSuite: (name: string) => void;
  moveSuite: (index: number, delta: number) => void;
  clearSuite: () => void;

  runTabs: RunTab[];
  activeRunId: string;
  setActiveRunId: (id: string) => void;
  startRun: (label: string, kind: "single" | "suite") => string;
  finishRun: (id: string, result: RunResult) => void;
  failRun: (id: string, error: string) => void;
  closeRun: (id: string) => void;

  toasts: Toast[];
  toast: (kind: Toast["kind"], text: string) => void;
  dismissToast: (id: number) => void;
}

const Ctx = createContext<Store | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [suite, setSuite] = useState<string[]>([]);
  const [runTabs, setRunTabs] = useState<RunTab[]>([]);
  const [activeRunId, setActiveRunId] = useState("");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const inSuite = useCallback((name: string) => suite.includes(name), [suite]);

  const toggleSuite = useCallback((name: string) => {
    setSuite((s) => (s.includes(name) ? s.filter((n) => n !== name) : [...s, name]));
  }, []);

  const removeFromSuite = useCallback((name: string) => {
    setSuite((s) => s.filter((n) => n !== name));
  }, []);

  const moveSuite = useCallback((index: number, delta: number) => {
    setSuite((s) => {
      const j = index + delta;
      if (j < 0 || j >= s.length) return s;
      const next = [...s];
      [next[index], next[j]] = [next[j], next[index]];
      return next;
    });
  }, []);

  const clearSuite = useCallback(() => setSuite([]), []);

  const toast = useCallback((kind: Toast["kind"], text: string) => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const startRun = useCallback((label: string, kind: "single" | "suite") => {
    const id = `run-${++seq.current}`;
    setRunTabs((t) => [
      ...t,
      { id, label, kind, startedAt: Date.now(), status: "running" as const },
    ]);
    setActiveRunId(id);
    return id;
  }, []);

  const finishRun = useCallback((id: string, result: RunResult) => {
    setRunTabs((t) =>
      t.map((r) => (r.id === id ? { ...r, status: result.ok ? "done" : "error", result } : r)),
    );
  }, []);

  const failRun = useCallback((id: string, error: string) => {
    setRunTabs((t) => t.map((r) => (r.id === id ? { ...r, status: "error", error } : r)));
  }, []);

  const closeRun = useCallback((id: string) => {
    setRunTabs((t) => {
      const next = t.filter((r) => r.id !== id);
      setActiveRunId((cur) => (cur === id ? (next[next.length - 1]?.id ?? "") : cur));
      return next;
    });
  }, []);

  const value = useMemo<Store>(
    () => ({
      suite,
      inSuite,
      toggleSuite,
      removeFromSuite,
      moveSuite,
      clearSuite,
      runTabs,
      activeRunId,
      setActiveRunId,
      startRun,
      finishRun,
      failRun,
      closeRun,
      toasts,
      toast,
      dismissToast,
    }),
    [
      suite,
      inSuite,
      toggleSuite,
      removeFromSuite,
      moveSuite,
      clearSuite,
      runTabs,
      activeRunId,
      startRun,
      finishRun,
      failRun,
      closeRun,
      toasts,
      toast,
      dismissToast,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useStore must be used inside <AppProvider>");
  return ctx;
}
