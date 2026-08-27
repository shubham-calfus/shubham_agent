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
import type { Suite } from "@/lib/types";
import { PageHeader, EmptyState, Spinner } from "@/components/ui";
import { IconFlow, IconPlay, IconRefresh } from "@/components/icons";

// One shape for both sources: the platform's test-suite-list (suites of
// recorded_flows) and the local file-DB (suites of recording names).
interface SuiteRow {
  id: string;
  name: string;
  members: string[];
}

export default function SuitesPage() {
  const { source, onPlatform } = useRecordingSource();
  const { runSuite } = useRunner();
  const { toast } = useStore();
  const { stageForLocalRun } = usePlatformStaging();
  const [checking, setChecking] = useState("");

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

  const rows = useMemo<SuiteRow[]>(() => {
    if (onPlatform) {
      return (platformSuites ?? []).map((suite, index) => ({
        id: String(suite.id ?? index),
        name: String(suite.name ?? suite.title ?? "(unnamed)"),
        members: (suite.recorded_flows ?? []).map((flow) => flow.name).filter(Boolean),
      }));
    }
    return (localSuites ?? []).map((suite) => ({
      id: suite.id,
      name: suite.name,
      members: suite.members,
    }));
  }, [onPlatform, platformSuites, localSuites]);

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
      await runSuite(suite.members.map((name) => ({ name })));
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
          <button className="btn-ghost btn-sm" onClick={load} disabled={loading}>
            {loading ? <Spinner size={14} /> : <IconRefresh width={14} height={14} />}
            Refresh
          </button>
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

        <div className="grid gap-4 lg:grid-cols-2">
          {rows.map((suite) => (
            <div key={suite.id} className="card p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="truncate text-[15px] font-semibold text-ink" title={suite.name}>
                    {suite.name}
                  </h2>
                  <p className="mt-1 text-[12px] text-ink-dim">
                    {suite.members.length} recording{suite.members.length === 1 ? "" : "s"} ·
                    sequential
                  </p>
                </div>
                <button
                  className="btn btn-sm shrink-0"
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
