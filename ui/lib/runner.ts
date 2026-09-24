"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { api } from "./api";
import { getRunDefaults } from "./runDefaults";
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
  // Suite-level values. Omitted by every caller today: they default to the Settings
  // page's values (see runDefaults), so the four trigger points need no field of their
  // own. Present here so a caller CAN override one for a single run.
  url?: string;
  username?: string;
  password?: string;
}

// Read at trigger time, not at module load: the user can change these on the Settings page
// between two runs in the same session, and a value captured at import would be stale.
//
// A blank is DROPPED rather than sent as "": the runner treats presence as provision, so an
// empty string would read as "the suite supplied a password" and blank out the credential in
// the recording's own params workbook instead of leaving it alone.
function suiteLevelValues(opts: RunOptions): Record<string, string> {
  const defaults = getRunDefaults();
  const merged = {
    url: opts.url ?? defaults.url,
    username: opts.username ?? defaults.username,
    password: opts.password ?? defaults.password,
  };
  return Object.fromEntries(
    Object.entries(merged).filter(([, value]) => (value ?? "").trim() !== ""),
  );
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
            ...suiteLevelValues(opts),
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
            ...suiteLevelValues(opts),
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
