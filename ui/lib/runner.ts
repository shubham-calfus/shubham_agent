"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { api } from "./api";
import { useStore } from "./store";
import type { ExecutionMode, ParamRow } from "./types";

export interface RunOptions {
  executionMode?: ExecutionMode;
  afterActionWaitMs?: number | null;
  recordVideo?: boolean;
  // The suite's own name. Shipped to the backend as `suite_name` (-> the agent's
  // `test_suite_name`) so the HTML report is titled with the suite name shown
  // here instead of a slug derived from its members.
  suiteName?: string;
}

// Shared "fire a run and track it as a tab" behaviour used by every page that
// can trigger execution. Navigates to /run so the user watches it live.
export function useRunner() {
  const store = useStore();
  const router = useRouter();

  const runSingle = useCallback(
    async (name: string, opts: RunOptions = {}) => {
      const id = store.startRun(name, "single");
      router.push("/run");
      try {
        // The tab's id doubles as the run record's id, so this run is findable
        // again after a reload.
        const result = await api.runQueued(
          {
            name,
            execution_mode: opts.executionMode ?? "parallel",
            after_action_wait_ms: opts.afterActionWaitMs ?? null,
            record_video: opts.recordVideo ?? false,
          },
          { id, label: name },
        );
        store.finishRun(id, result);
        store.toast(result.ok ? "ok" : "err", `${name}: ${result.ok ? "passed" : "failed"}`);
      } catch (e) {
        store.failRun(id, e instanceof Error ? e.message : String(e));
        store.toast("err", `${name}: ${e instanceof Error ? e.message : e}`);
      }
    },
    [store, router],
  );

  const runSuite = useCallback(
    async (
      recordings: Array<{ name: string; parameters?: ParamRow | null }>,
      opts: RunOptions = {},
    ) => {
      const suiteName = (opts.suiteName ?? "").trim();
      const label = suiteName || `Suite · ${recordings.length}`;
      const id = store.startRun(label, "suite");
      router.push("/run");
      try {
        const result = await api.runSuiteQueued(
          {
            recordings,
            suite_name: suiteName,
            execution_mode: opts.executionMode ?? "sequential",
            after_action_wait_ms: opts.afterActionWaitMs ?? null,
            record_video: opts.recordVideo ?? false,
          },
          { id, label },
        );
        store.finishRun(id, result);
        store.toast(result.ok ? "ok" : "err", `${label}: ${result.ok ? "passed" : "failed"}`);
      } catch (e) {
        store.failRun(id, e instanceof Error ? e.message : String(e));
        store.toast("err", `${label}: ${e instanceof Error ? e.message : e}`);
      }
    },
    [store, router],
  );

  return { runSingle, runSuite };
}
