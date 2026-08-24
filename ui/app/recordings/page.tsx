"use client";

import { Suspense, useCallback, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useAsyncData } from "@/lib/useAsyncData";
import { useRunner } from "@/lib/runner";
import { useStore } from "@/lib/store";
import { useRecordingSource } from "@/lib/realapi/hooks";
import { sourceLabel } from "@/lib/realapi/connectionSlice";
import {
  useGetRecordedFlowsQuery,
  useGetTestSuitesQuery,
  type PlatformRecording,
} from "@/lib/realapi/realApi";
import {
  errText,
  keyHintsFromSuites,
  pickStr,
  platformKeys,
  usePlatformStaging,
} from "@/lib/realapi/staging";
import { setConnection } from "@/lib/realapi/connectionSlice";
import { useAppDispatch } from "@/lib/realapi/hooks";
import type { ScriptDetail, ScriptListItem } from "@/lib/types";
import { PageHeader, EmptyState, Spinner } from "@/components/ui";
import { RecordingEditor } from "@/components/RecordingEditor";
import { SuitePanel } from "@/components/SuitePanel";
import { IconCopy, IconFilm, IconPlus, IconRefresh, IconSearch } from "@/components/icons";

// Sentinel for the "author a new recording" selection (an empty editor).
const NEW = " new";

// ---- platform → list-row mapping -----------------------------------------
function toListItem(flow: PlatformRecording): ScriptListItem {
  const row = flow as Record<string, unknown>;
  return {
    name: flow.name || pickStr(row, ["recording_name", "file_name"]) || String(flow.id ?? ""),
    py_key: pickStr(row, ["file_path", "file_name", "py_key", "script_path"]),
    params_key: pickStr(row, ["data_file_path", "data_file_name", "params_key"]),
    has_db: true, // it came out of the platform's recorded_flows table by definition
  };
}

function RecordingsInner() {
  // Gated: reports the SSR default until localStorage has been applied, so the
  // first client render matches the server HTML (see useRecordingSource).
  const { source, onPlatform: fromPlatform } = useRecordingSource();

  // Local runner: /api/scripts via app.py. Skipped (returns []) on a platform
  // source — the fetcher is keyed on `fromPlatform`, so switching re-runs it.
  const fetcher = useCallback(
    async () => (fromPlatform ? [] : (await api.scripts()).scripts),
    [fromPlatform],
  );
  const { data: runnerScripts, error: runnerError, loading: runnerLoading, reload } =
    useAsyncData<ScriptListItem[]>(fetcher);

  // Platform: recorded-flow-list via /rapi/<prefix>, with the pasted token.
  const {
    data: platformFlows,
    isFetching: platformLoading,
    error: platformError,
    refetch,
  } = useGetRecordedFlowsQuery(undefined, { skip: !fromPlatform });

  const rows = useMemo<ScriptListItem[]>(
    () => (fromPlatform ? (platformFlows ?? []).map(toListItem) : (runnerScripts ?? [])),
    [fromPlatform, platformFlows, runnerScripts],
  );
  // name -> the untouched platform record, for the detail panel.
  const rawByName = useMemo(() => {
    const map = new Map<string, PlatformRecording>();
    for (const flow of platformFlows ?? []) map.set(toListItem(flow).name, flow);
    return map;
  }, [platformFlows]);
  const loading = fromPlatform ? platformLoading : runnerLoading;
  const error = fromPlatform ? errText(platformError) : runnerError;
  const load = useCallback(() => {
    if (fromPlatform) refetch();
    else reload();
  }, [fromPlatform, refetch, reload]);

  const [query, setQuery] = useState("");

  // Deep-link support: /recordings?name=foo opens that recording in the editor.
  const searchParams = useSearchParams();
  const [picked, setPicked] = useState<string>(() => searchParams.get("name") || "");

  const { runSingle } = useRunner();
  const { toggleSuite, inSuite, toast } = useStore();
  const dispatch = useAppDispatch();
  const { fetchPlatformFiles } = usePlatformStaging();

  // Suites are only fetched to learn each flow's real storage keys.
  const { data: suites } = useGetTestSuitesQuery(undefined, { skip: !fromPlatform });
  const keysFromSuites = useMemo(() => keyHintsFromSuites(suites), [suites]);

  // Loader for a PLATFORM recording, shaped exactly like api.script() so the
  // editor cannot tell the difference: pull the .py and the params workbook out
  // of the platform's storage, and let app.py parse the workbook back into rows
  // (same parser the local read path uses). Only the origin differs.
  const platformLoader = useCallback(
    async (recordingName: string): Promise<ScriptDetail> => {
      const flow = rawByName.get(recordingName);
      const keys = platformKeys(flow, recordingName, keysFromSuites);
      // No fallbacks: if either file cannot be read this THROWS, naming the key
      // (see fetchPlatformFiles). Seeding params from the script's
      // {{placeholders}} looked helpful but was actively dangerous — those blank
      // values are indistinguishable from a real template, and saving them would
      // write a wrong workbook into the local bucket.
      const { script: pyText, workbookB64: b64 } = await fetchPlatformFiles(keys);
      const parsed = await api.parseParams({ filename: keys.workbook, content_b64: b64 });

      const row = (flow ?? {}) as Record<string, unknown>;
      const detail: ScriptDetail = {
        name: recordingName,
        py_key: keys.script,
        py_text: pyText,
        params_key: keys.workbook,
        params: parsed.params,
        placeholders: [],
        // Not a local recorded_flows row — this is what the PLATFORM reports, so
        // the editor can show the start URL it came with.
        db: {
          id: String(row.id ?? ""),
          file_name: keys.script,
          data_file_name: keys.workbook,
          start_url: String(row.start_url ?? ""),
        },
        // Declare the repeatable sheet the workbook ACTUALLY uses (the ingest
        // agent names it multi_line; this UI names it line_items), so saving or
        // staging writes a sidecar the runner can follow.
        recording_config: parsed.multi_line.length
          ? { repeatable_blocks: [{ enabled: true, sheet_name: parsed.multi_line_sheet }] }
          : {},
        line_items: parsed.multi_line,
        // The workbook exactly as the platform holds it, so an unedited Run
        // stages a byte-for-byte copy instead of a rebuild (see RecordingEditor).
        params_b64: b64,
      };
      return detail;
    },
    [rawByName, keysFromSuites, fetchPlatformFiles],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((s) => !q || s.name.toLowerCase().includes(q));
  }, [rows, query]);

  // Effective selection: the user's pick, else the first row in view.
  const selected = picked || filtered[0]?.name || "";
  const editing = selected === NEW ? "" : selected; // "" => new recording

  return (
    <div className="flex h-[100dvh] flex-col">
      <PageHeader
        eyebrow="Library"
        title="Recordings"
        subtitle={
          fromPlatform
            ? `Browsing ${sourceLabel(source)} — read-only.`
            : "Browse, edit, register and run your flows — all in one place."
        }
        actions={
          <>
            <button className="btn-ghost btn-sm" onClick={load} disabled={loading}>
              {loading ? <Spinner size={14} /> : <IconRefresh width={14} height={14} />}
              Refresh
            </button>
            {!fromPlatform && (
              <button className="btn btn-sm" onClick={() => setPicked(NEW)}>
                <IconPlus width={14} height={14} />
                New recording
              </button>
            )}
          </>
        }
      />

      {/* min-h-0 lets the flex child shrink so its children can scroll instead
          of pushing the page taller. */}
      <div className="grid min-h-0 flex-1 gap-6 p-8 lg:grid-cols-[340px_minmax(0,1fr)]">
        {/* List column — search/suite stay put, only the rows scroll. */}
        <div className="flex min-h-0 flex-col gap-4">
          <div className="relative shrink-0">
            <IconSearch
              width={16}
              height={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-dim"
            />
            <input
              className="field pl-9"
              placeholder="Search recordings…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {!fromPlatform && (
            <div className="shrink-0">
              <SuitePanel />
            </div>
          )}

          {error && (
            <div className="shrink-0 rounded-xl border border-bad/25 bg-bad-soft px-4 py-3 text-sm text-bad">
              {error}
            </div>
          )}

          {/* The only scroller in this column. */}
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            {/* New-recording entry — authoring writes to the LOCAL bucket, so it
                is only offered when the local runner is the source. */}
            {!fromPlatform && (
              <button
                onClick={() => setPicked(NEW)}
                className={`card w-full px-3.5 py-3 text-left transition-all ${
                  selected === NEW ? "!border-teal ring-2 ring-teal/20" : "hover:border-line-2"
                }`}
              >
                <div className="flex items-center gap-2 text-sm font-semibold text-teal">
                  <IconPlus width={14} height={14} />
                  New recording
                </div>
              </button>
            )}

            {loading && (
              <div className="flex items-center gap-2 px-1 py-4 text-sm text-ink-mid">
                <Spinner size={16} /> Loading…
              </div>
            )}
            {!loading && filtered.length === 0 && (
              <div className="px-1 py-4 text-sm text-ink-dim">No recordings match.</div>
            )}
            {filtered.map((s) => {
              const active = s.name === selected;
              return (
                // The row is a div, not a button, so the copy control can sit
                // INLINE right after the name — a <button> inside a <button> is
                // invalid HTML. role/tabIndex/onKeyDown keep it keyboard-usable.
                <div
                  key={s.name}
                  role="button"
                  tabIndex={0}
                  onClick={() => setPicked(s.name)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setPicked(s.name);
                    }
                  }}
                  className={`card w-full cursor-pointer px-3.5 py-3 text-left transition-all ${
                    active ? "!border-teal ring-2 ring-teal/20" : "hover:border-line-2"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div className="flex min-w-0 flex-1 items-center gap-1">
                      <span className="min-w-0 truncate text-sm font-semibold text-ink">
                        {s.name}
                      </span>
                      <button
                        type="button"
                        title={`Copy "${s.name}"`}
                        aria-label={`Copy ${s.name} to clipboard`}
                        className="shrink-0 rounded-md p-1 text-ink-dim transition-colors hover:bg-surface-2 hover:text-ink"
                        onClick={async (e) => {
                          e.stopPropagation();
                          try {
                            await navigator.clipboard.writeText(s.name);
                            toast("ok", `Copied ${s.name}`);
                          } catch (err) {
                            // Clipboard needs a secure context and a user gesture;
                            // say so rather than looking like nothing happened.
                            toast("err", `Copy failed: ${err instanceof Error ? err.message : err}`);
                          }
                        }}
                      >
                        <IconCopy width={12} height={12} />
                      </button>
                    </div>
                    <span className={`badge shrink-0 ${s.has_db ? "badge-good" : "badge-muted"}`}>
                      {s.has_db ? "DB" : "no DB"}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    {fromPlatform ? (
                      <span className="chip">platform</span>
                    ) : (
                      <span className="chip">{s.params_key.endsWith(".csv") ? "csv" : "xlsx"}</span>
                    )}
                    {!fromPlatform && inSuite(s.name) && (
                      <span className="badge badge-brand">in suite</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Editor column — scrolls independently of the list. */}
        <div className="min-w-0 overflow-y-auto pr-1">
          {selected ? (
            <RecordingEditor
              key={`${source}:${selected}`}
              initialName={editing}
              loader={fromPlatform ? platformLoader : undefined}
              stageBeforeRun={fromPlatform}
              inSuite={!!editing && inSuite(editing)}
              onToggleSuite={() => editing && toggleSuite(editing)}
              onRun={async () => {
                if (!editing) return;
                // Pre-flight, not a fallback: the local worker downloads the
                // script from the LOCAL bucket, so running something that was
                // never saved there dies deep in the worker with a NoSuchKey
                // whose report says nothing useful. Refuse up front instead, and
                // say which button fixes it. Fetched fresh so a just-saved
                // recording is not reported missing from a stale list.
                const local = new Set((await api.scripts()).scripts.map((r) => r.name));
                if (!local.has(editing)) {
                  toast(
                    "err",
                    `${editing} is not on the local runner yet — click "Save to MinIO + DB" first, then Run.`,
                  );
                  return;
                }
                runSingle(editing);
              }}
              onSaved={(savedName) => {
                // Saving a platform recording IS the import — it now lives in the
                // local bucket, so switch the source and reload the local list.
                if (fromPlatform) {
                  dispatch(setConnection({ source: "runner" }));
                  toast("ok", `${savedName} imported — now on the local runner`);
                } else {
                  load();
                }
                setPicked(savedName);
              }}
            />
          ) : (
            <EmptyState
              icon={<IconFilm width={30} height={30} />}
              title="No recording selected"
              hint="Pick a recording on the left to edit and run it, or start a new one."
            />
          )}
        </div>
      </div>
    </div>
  );
}
export default function RecordingsPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-ink-mid">Loading…</div>}>
      <RecordingsInner />
    </Suspense>
  );
}
