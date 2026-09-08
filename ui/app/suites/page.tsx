"use client";

import { useCallback, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useAsyncData } from "@/lib/useAsyncData";
import { useRunner } from "@/lib/runner";
import { useStore } from "@/lib/store";
import { useRecordingSource } from "@/lib/realapi/hooks";
import { sourceLabel } from "@/lib/realapi/connectionSlice";
import { useGetTestSuitesQuery } from "@/lib/realapi/realApi";
import {
  errText,
  keyHintsFromSuites,
  platformKeys,
  usePlatformStaging,
} from "@/lib/realapi/staging";
import type { ExecutionMode, Suite } from "@/lib/types";
import { PageHeader, EmptyState, Spinner } from "@/components/ui";
import { IconFlow, IconPin, IconPlay, IconRefresh, IconSearch } from "@/components/icons";

// One shape for both sources: the platform's test-suite-list (suites of
// recorded_flows) and the local file-DB (suites of recording names).
interface SuiteRow {
  id: string;
  name: string;
  members: string[];
  mode: ExecutionMode; // the suite's saved mode; the card's toggle overrides it
  pinned: boolean;
}

export default function SuitesPage() {
  const { source, onPlatform } = useRecordingSource();
  const { runSuite } = useRunner();
  const { toast } = useStore();
  const { stageForLocalRun } = usePlatformStaging();
  const [checking, setChecking] = useState("");
  const [query, setQuery] = useState("");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  // Mode picked on a card this session. Seeded from the suite's saved mode and
  // written back for LOCAL suites (a platform suite has no local row to save
  // into, so its choice lasts only until the page reloads).
  const [modeOverrides, setModeOverrides] = useState<Record<string, ExecutionMode>>({});

  // Local file-DB suites (skipped on a platform source).
  const localFetcher = useCallback(
    async () => (onPlatform ? [] : (await api.suites.list()).suites),
    [onPlatform],
  );
  const {
    data: localSuites,
    error: localError,
    loading: localLoading,
    reload,
  } = useAsyncData<Suite[]>(localFetcher);

  // Platform suites — the same endpoint sombrero lists from.
  const {
    data: platformSuites,
    isFetching: platformLoading,
    error: platformError,
    refetch,
  } = useGetTestSuitesQuery(undefined, { skip: !onPlatform });

  // The suite listing is also the only place that reports each member's real
  // storage keys, so staging reads them straight off it.
  const keyHints = useMemo(() => keyHintsFromSuites(platformSuites), [platformSuites]);

  // Pinned suite names (localdb/pins.json). Kept by NAME so one pin covers a
  // suite whether it is listed from the local file-DB or from a platform
  // source, whose ids are not stable.
  const pinsFetcher = useCallback(async () => (await api.pins.list()).pins, []);
  const { data: pins, setData: setPins } = useAsyncData<string[]>(pinsFetcher);
  const pinnedNames = useMemo(
    () => new Set((pins ?? []).map((name) => name.trim().toLowerCase())),
    [pins],
  );

  const togglePin = async (suite: SuiteRow) => {
    const next = !suite.pinned;
    // Optimistic: the card should move the moment it is clicked. A failed write
    // is reverted by the reload the toast tells you about.
    setPins(
      next
        ? [...(pins ?? []), suite.name]
        : (pins ?? []).filter((name) => name.trim().toLowerCase() !== suite.name.trim().toLowerCase()),
    );
    try {
      setPins((await api.pins.set(suite.name, next)).pins);
    } catch (e) {
      toast("err", `${suite.name}: could not ${next ? "pin" : "unpin"} — ${errText(e)}`);
    }
  };

  const rows = useMemo<SuiteRow[]>(() => {
    const listed: Omit<SuiteRow, "pinned">[] = onPlatform
      ? (platformSuites ?? []).map((suite, index) => ({
          id: String(suite.id ?? index),
          name: String(suite.name ?? suite.title ?? "(unnamed)"),
          members: (suite.recorded_flows ?? []).map((flow) => flow.name).filter(Boolean),
          mode: "sequential" as ExecutionMode, // the platform list carries no mode
        }))
      : (localSuites ?? []).map((suite) => ({
          id: suite.id,
          name: suite.name,
          members: suite.members,
          mode: suite.execution_mode,
        }));

    // Pinned suites first, each half keeping the order the source listed it in
    // (local suites arrive sorted by name). A stable sort keeps that intact.
    return listed
      .map((suite) => ({ ...suite, pinned: pinnedNames.has(suite.name.trim().toLowerCase()) }))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned));
  }, [onPlatform, platformSuites, localSuites, pinnedNames]);

  // Search matches the suite name AND its member recordings, so "which suite
  // runs RH_ORC_REQUISITION" is answerable from the same box. `pinnedOnly`
  // narrows to the pinned set.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((suite) => {
      if (pinnedOnly && !suite.pinned) return false;
      if (!q) return true;
      return (
        suite.name.toLowerCase().includes(q) ||
        suite.members.some((member) => member.toLowerCase().includes(q))
      );
    });
  }, [rows, query, pinnedOnly]);

  const filtering = query.trim() !== "" || pinnedOnly;

  const modeFor = (suite: SuiteRow): ExecutionMode => modeOverrides[suite.id] ?? suite.mode;

  // Sequential is what makes flow context work: recording 1's extracted values
  // only reach recording 2 when 2 starts after 1 finished. Parallel starts them
  // all at once, so pick it only for independent recordings.
  const setMode = (suite: SuiteRow, mode: ExecutionMode) => {
    setModeOverrides((prev) => ({ ...prev, [suite.id]: mode }));
    if (onPlatform) return; // platform suites live upstream; nothing local to persist
    api.suites.update(suite.id, { execution_mode: mode }).catch((e) => {
      toast("err", `${suite.name}: could not save mode — ${errText(e)}`);
    });
  };

  const loading = onPlatform ? platformLoading : localLoading;
  const error = onPlatform ? errText(platformError) : localError;
  const load = useCallback(() => {
    if (onPlatform) refetch();
    else reload();
  }, [onPlatform, refetch, reload]);

  // The agent is always local and downloads each recording from the LOCAL
  // bucket, so every member has to exist there before the suite starts. A
  // platform member that is missing gets STAGED (objects written, no
  // recorded_flows row) — the same thing Run does for a single recording.
  // THE SOURCE DROPDOWN DECIDES WHICH BYTES RUN. On a platform source every member is
  // re-staged from that platform first, so the run executes what is upstream RIGHT NOW; on the
  // local runner nothing is fetched and the bucket's own copy runs.
  //
  // This used to stage only the members that were MISSING locally, to avoid overwriting one you
  // had edited here. That protected the wrong thing: editing upstream and pressing Run gave you
  // a silently stale local copy, with nothing in the toast or the report saying which version
  // executed -- and a suite that runs the wrong script and passes is worse than one that fails.
  // It also disagreed with the single-recording Run, which always re-stages from the editor
  // buffer. Want the local copy instead? Switch the source to the local runner; that is what the
  // dropdown is for.
  const runLocally = async (suite: SuiteRow) => {
    if (!suite.members.length) {
      toast("err", `${suite.name} has no recordings`);
      return;
    }
    setChecking(suite.id);
    try {
      if (!onPlatform) {
        // A local suite naming a recording that is not in the bucket is a broken suite, not
        // something to fetch -- there is no upstream to fetch it from.
        const local = new Set((await api.scripts()).scripts.map((s) => s.name));
        const missing = suite.members.filter((name) => !local.has(name));
        if (missing.length) {
          toast(
            "err",
            `${suite.name}: ${missing.length} recording(s) not in the local bucket — ${missing.join(", ")}.`,
          );
          return;
        }
      } else {
        toast(
          "ok",
          `${suite.name}: staging ${suite.members.length} recording(s) from ${sourceLabel(source)}…`,
        );
        for (const name of suite.members) {
          try {
            await stageForLocalRun(name, platformKeys(undefined, name, keyHints));
          } catch (e) {
            // Fail the whole suite. Running on a partially-refreshed set would execute a mix of
            // upstream and stale local scripts -- exactly the ambiguity this rewrite removes.
            throw new Error(`could not stage ${name} — ${errText(e)}`);
          }
        }
        toast("ok", `${suite.name}: running ${sourceLabel(source)} copies of ${suite.members.join(", ")}`);
      }
      await runSuite(suite.members.map((name) => ({ name })), {
        executionMode: modeFor(suite),
        suiteName: suite.name,
      });
    } catch (e) {
      toast("err", `${suite.name}: ${errText(e)}`);
    } finally {
      setChecking("");
    }
  };

  return (
    <div className="flex h-[100dvh] flex-col">
      <PageHeader
        eyebrow="Library"
        title="Suites"
        subtitle={
          onPlatform
            ? `Suites from ${sourceLabel(source)} — each run downloads that source's current scripts and executes them on your local worker.`
            : "Saved local suites — run them end to end on your local worker."
        }
        actions={
          <>
            <div className="relative">
              <IconSearch
                width={15}
                height={15}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-dim"
              />
              <input
                className="field w-64 pl-9"
                placeholder="Search suites or recordings…"
                aria-label="Search suites"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <label
              className={`btn-ghost btn-sm cursor-pointer select-none ${
                pinnedOnly ? "text-teal" : ""
              }`}
              title="Show only pinned suites"
            >
              <input
                type="checkbox"
                className="accent-teal"
                checked={pinnedOnly}
                onChange={(e) => setPinnedOnly(e.target.checked)}
              />
              Pinned only
            </label>
            <button className="btn-ghost btn-sm" onClick={load} disabled={loading}>
              {loading ? <Spinner size={14} /> : <IconRefresh width={14} height={14} />}
              Refresh
            </button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-8">
        {error && (
          <div className="mb-4 rounded-xl border border-bad/25 bg-bad-soft px-4 py-3 text-sm text-bad">
            {error}
          </div>
        )}

        {loading && (
          <div className="flex items-center gap-2 px-1 py-4 text-sm text-ink-mid">
            <Spinner size={16} /> Loading…
          </div>
        )}

        {!loading && !rows.length && (
          <EmptyState
            icon={<IconFlow width={30} height={30} />}
            title="No suites"
            hint={
              onPlatform
                ? "This platform environment has no test suites yet."
                : "Add recordings to a suite from the Recordings page, then save it."
            }
          />
        )}

        {/* Filtered everything out — say so instead of showing the "no suites"
            empty state, which would read as "your suites are gone". */}
        {!loading && rows.length > 0 && !visible.length && (
          <EmptyState
            icon={<IconSearch width={30} height={30} />}
            title="No matching suites"
            hint={
              pinnedOnly && query.trim()
                ? "No pinned suite matches that search. Clear the filters to see all suites."
                : pinnedOnly
                  ? "Nothing is pinned yet — use the pin on a suite card to keep it at the top."
                  : "No suite name or recording matches that search."
            }
            action={
              <button
                className="btn btn-sm"
                onClick={() => {
                  setQuery("");
                  setPinnedOnly(false);
                }}
              >
                Clear filters
              </button>
            }
          />
        )}

        {filtering && visible.length > 0 && (
          <p className="mb-4 text-[12px] text-ink-dim">
            {visible.length} of {rows.length} suite{rows.length === 1 ? "" : "s"}
            {pinnedOnly ? " · pinned only" : ""}
          </p>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          {visible.map((suite) => (
            <div
              key={suite.id}
              className={`card p-5 ${suite.pinned ? "border-teal/40" : ""}`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="truncate text-[15px] font-semibold text-ink" title={suite.name}>
                    {suite.name}
                  </h2>
                  <p className="mt-1 text-[12px] text-ink-dim">
                    {suite.members.length} recording{suite.members.length === 1 ? "" : "s"}
                    {suite.pinned ? " · pinned" : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    className={`btn-ghost btn-sm !px-2 ${suite.pinned ? "text-teal" : ""}`}
                    aria-pressed={suite.pinned}
                    title={suite.pinned ? "Unpin from the top" : "Pin to the top"}
                    onClick={() => togglePin(suite)}
                  >
                    <IconPin width={16} height={16} filled={suite.pinned} />
                  </button>
                  <button
                    className="btn btn-sm"
                    disabled={checking === suite.id}
                    onClick={() => runLocally(suite)}
                  >
                    {checking === suite.id ? (
                      <Spinner size={14} />
                    ) : (
                      <IconPlay width={14} height={14} />
                    )}
                    Run suite
                  </button>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <ModeToggle
                  value={modeFor(suite)}
                  disabled={checking === suite.id}
                  onChange={(mode) => setMode(suite, mode)}
                />
                <p className="text-[11px] text-ink-dim">
                  {modeFor(suite) === "sequential"
                    ? "One after another — extracted values flow to the next recording."
                    : "All at once — faster, but nothing is passed between recordings."}
                </p>
              </div>

              <ol className="mt-4 space-y-1.5">
                {suite.members.map((name, index) => (
                  <li key={`${name}-${index}`} className="flex items-center gap-2 text-[13px]">
                    <span className="w-5 shrink-0 text-right font-mono text-[11px] text-ink-dim">
                      {index + 1}
                    </span>
                    <span className="min-w-0 truncate text-ink" title={name}>
                      {name}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Two-state execution-mode picker. A radiogroup rather than a checkbox/switch
// because both states are named choices, not on/off.
// --------------------------------------------------------------------------
const MODES: ExecutionMode[] = ["sequential", "parallel"];

function ModeToggle({
  value,
  onChange,
  disabled,
}: {
  value: ExecutionMode;
  onChange: (mode: ExecutionMode) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Execution mode"
      className="inline-flex shrink-0 rounded-xl border border-line-2 bg-surface-2 p-0.5"
    >
      {MODES.map((mode) => {
        const active = value === mode;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(mode)}
            className={`rounded-[10px] px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.12em]
              transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${
                active ? "bg-teal text-white" : "text-ink-dim hover:text-ink"
              }`}
          >
            {mode}
          </button>
        );
      })}
    </div>
  );
}
