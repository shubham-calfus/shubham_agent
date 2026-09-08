import type {
  AppConfig,
  ExecutionMode,
  ParamRow,
  RunRecord,
  RunResult,
  ScriptDetail,
  ScriptsResponse,
  Suite,
  SuiteInput,
  UploadResult,
} from "./types";

// --------------------------------------------------------------------------
// Thin typed client over the proxied FastAPI backend. All calls go to /api/*
// which next.config rewrites to the shubham_agent server.
// --------------------------------------------------------------------------

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    cache: "no-store",
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail =
      body && typeof body === "object" && "detail" in body
        ? String((body as { detail: unknown }).detail)
        : typeof body === "string" && body
          ? body
          : `${res.status} ${res.statusText}`;
    throw new Error(detail);
  }
  return body as T;
}

// ---- Async run queue (act_ui-native, /studio-api — NOT proxied) -----------
// Trigger a run, then poll for completion, so the browser never holds one long
// blocking request open. The blocking wait now lives server-side (act_ui Node
// -> backend), which has no browser/proxy timeout, so a long run no longer shows
// a false "Internal Server Error" while it's actually still running.
//
// The run's id comes from the CALLER (the store's run tab), so the tab and the
// server-side record share one identity and a reloaded page can pick a run back
// up mid-flight via `pollRun`.
export interface RunMeta {
  id: string;
  label: string;
}

// Give up after the BACKEND's own ceiling, not before it: app.py kills the
// aetherion CLI at 40 min, so a shorter cap here reported "run timed out" for
// runs that were still perfectly alive and about to write a report.
const RUN_MAX_MS = 45 * 60 * 1000;

// Watch one run record until it settles. Used both by a freshly triggered run
// and by the Runs page after a reload, so there is one polling implementation.
export async function pollRun(id: string, startedAt = Date.now()): Promise<RunResult> {
  const deadline = startedAt + RUN_MAX_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));
    const poll = await fetch(`/studio-api/run/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (poll.status === 404) throw new Error("run record is gone");
    if (!poll.ok) continue;
    const rec = (await poll.json()) as {
      status: "running" | "done" | "error";
      result?: RunResult;
      error?: string;
    };
    if (rec.status === "done" && rec.result) return rec.result;
    if (rec.status === "error") throw new Error(rec.error || "run failed");
  }
  throw new Error("run timed out");
}

async function runViaQueue(
  kind: "single" | "suite",
  payload: unknown,
  meta: RunMeta,
): Promise<RunResult> {
  const trigger = await fetch("/studio-api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, payload, id: meta.id, label: meta.label }),
  });
  if (!trigger.ok) throw new Error(`Failed to trigger run (${trigger.status})`);
  const { runId } = (await trigger.json()) as { runId: string };
  return pollRun(runId);
}

export const api = {
  config: () => req<AppConfig>("/api/config"),

  scripts: () => req<ScriptsResponse>("/api/scripts"),

  script: (name: string) => req<ScriptDetail>(`/api/script?name=${encodeURIComponent(name)}`),

  upload: (payload: {
    name: string;
    script: string;
    params: unknown;
    prompt?: string;
    repeatable_blocks?: unknown;
    overwrite?: boolean;
    fmt?: "xlsx" | "csv";
    // false = put the objects in the bucket but skip the recorded_flows upsert
    // (staging a platform recording so the LOCAL worker can execute it).
    register?: boolean;
    // base64 workbook bytes stored verbatim instead of rebuilt from `params`
    params_b64?: string;
  }) =>
    req<UploadResult>("/api/upload", {
      method: "POST",
      body: JSON.stringify({ overwrite: true, fmt: "xlsx", ...payload }),
    }),

  // Read an EXISTING workbook (e.g. one downloaded from the platform) back into
  // rows, so its data template can be shown and edited like a local one.
  parseParams: (payload: { filename: string; content_b64: string; multi_line_sheet?: string }) =>
    req<{ params: ParamRow[]; multi_line: ParamRow[]; multi_line_sheet: string }>("/api/parse-params", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  paramsXlsx: (name: string, params: unknown) =>
    req<{ ok: boolean; download_name: string; download_url: string }>("/api/params-xlsx", {
      method: "POST",
      body: JSON.stringify({ name, params }),
    }),

  run: (payload: {
    name: string;
    parameters?: unknown;
    execution_mode?: ExecutionMode;
    after_action_wait_ms?: number | null;
    record_video?: boolean;
  }) =>
    req<RunResult>("/api/run", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  runSuite: (payload: {
    recordings: Array<{ name: string; parameters?: ParamRow | null }>;
    suite_id?: string;
    suite_name?: string;
    execution_mode?: ExecutionMode;
    after_action_wait_ms?: number | null;
    record_video?: boolean;
  }) =>
    req<RunResult>("/api/run-suite", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  // Async variants: trigger + poll (no long blocking browser request). Same
  // payloads as run/runSuite; the server backgrounds the call to the backend.
  runQueued: (
    payload: {
      name: string;
      parameters?: unknown;
      execution_mode?: ExecutionMode;
      after_action_wait_ms?: number | null;
      record_video?: boolean;
    },
    meta: RunMeta,
  ) => runViaQueue("single", payload, meta),

  runSuiteQueued: (
    payload: {
      recordings: Array<{ name: string; parameters?: ParamRow | null }>;
      suite_id?: string;
      suite_name?: string;
      execution_mode?: ExecutionMode;
      after_action_wait_ms?: number | null;
      record_video?: boolean;
    },
    meta: RunMeta,
  ) => runViaQueue("suite", payload, meta),

  // Run history — the same file-DB records the poller reads, so the Runs page
  // survives a reload instead of losing every tab.
  runs: {
    list: (limit?: number) =>
      req<{ runs: RunRecord[] }>(
        `/studio-api/run${limit ? `?limit=${encodeURIComponent(limit)}` : ""}`,
      ),
    remove: (id: string) =>
      req<{ ok: boolean }>(`/studio-api/run/${encodeURIComponent(id)}`, { method: "DELETE" }),
  },

  // Pinned suites, keyed by suite name so one pin covers both a local suite and
  // the same suite listed from a platform source.
  pins: {
    list: () => req<{ pins: string[] }>("/studio-api/pins"),
    set: (name: string, pinned: boolean) =>
      req<{ pins: string[] }>("/studio-api/pins", {
        method: "PUT",
        body: JSON.stringify({ name, pinned }),
      }),
  },

  // Saved suites — backed by act_ui's local file-DB (/studio-api, not proxied).
  suites: {
    list: () => req<{ suites: Suite[] }>("/studio-api/suites"),
    save: (body: SuiteInput) =>
      req<Suite>("/studio-api/suites", { method: "POST", body: JSON.stringify(body) }),
    update: (id: string, body: Partial<SuiteInput>) =>
      req<Suite>(`/studio-api/suites/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    remove: (id: string) =>
      req<{ ok: boolean }>(`/studio-api/suites/${encodeURIComponent(id)}`, { method: "DELETE" }),
  },
};
