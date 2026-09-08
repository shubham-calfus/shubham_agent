"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, pollRun } from "./api";
import type { RunRecord, RunResult } from "./types";

// --------------------------------------------------------------------------
// App state shared across pages: the suite being assembled, the run output
// tabs, and toast notifications.
//
// The suite cart and the toasts are session state (client-side only). The RUN
// TABS are not: they are a view of the file-DB records under localdb/runs/, so
// they are restored on mount and a run that is still executing is picked back
// up. Before that, closing or reloading the tab abandoned live runs and hid
// finished reports that were sitting on disk the whole time.
// --------------------------------------------------------------------------

// How many past runs come back as tabs. The strip has to stay readable, and
// older records remain on disk (and in /downloads) either way.
const RUN_TABS_LIMIT = 12;

export interface Toast {
  id: number;
  kind: "ok" | "err" | "info";
  text: string;
}

// A tab IS a run record — same id, same fields — so nothing has to be mapped
// between the two representations.
export type RunTab = RunRecord;

// The id is minted here and sent to the server, so the tab and the record are
// one thing. crypto.randomUUID needs a secure context (localhost counts); the
// fallback keeps the shape valid on a plain-http origin, because the server
// refuses an id that is not a uuid.
function newRunId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const rand = (Math.random() * 16) | 0;
    return (ch === "x" ? rand : (rand & 0x3) | 0x8).toString(16);
  });
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
  // Every run id this session already has a tab for (live or restored). Guards
  // the restore pass from re-adding a run that is on screen and from starting a
  // second poller for it.
  const tracked = useRef<Set<string>>(new Set());

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
    const id = newRunId();
    tracked.current.add(id);
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

  // Closing a tab forgets the run for good: without deleting the record it
  // would just come back on the next reload. The HTML report stays in the
  // backend's downloads/ folder.
  const closeRun = useCallback((id: string) => {
    tracked.current.delete(id);
    setRunTabs((t) => {
      const next = t.filter((r) => r.id !== id);
      setActiveRunId((cur) => (cur === id ? (next[next.length - 1]?.id ?? "") : cur));
      return next;
    });
    void api.runs.remove(id).catch(() => {});
  }, []);

  // Follow a run that is executing server-side until it settles. Used for runs
  // restored on mount; a run triggered in this session is already awaited by
  // the caller in lib/runner.ts.
  const watchRun = useCallback(
    (rec: RunRecord) => {
      pollRun(rec.id, rec.startedAt)
        .then((result) => finishRun(rec.id, result))
        .catch((e) => failRun(rec.id, e instanceof Error ? e.message : String(e)));
    },
    [finishRun, failRun],
  );

  // Restore the run history once per mount. A failure here is not fatal — the
  // app still works, it just starts with an empty tab strip — so it only warns.
  useEffect(() => {
    let alive = true;
    api.runs
      .list(RUN_TABS_LIMIT)
      .then(({ runs }) => {
        if (!alive) return;
        const restored = runs.filter((rec) => !tracked.current.has(rec.id));
        if (!restored.length) return;
        restored.forEach((rec) => tracked.current.add(rec.id));
        setRunTabs((current) => [...restored, ...current]);
        restored.filter((rec) => rec.status === "running").forEach(watchRun);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [watchRun]);

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
