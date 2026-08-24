"use client";

import { useCallback, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useAsyncData } from "@/lib/useAsyncData";
import { useRunner } from "@/lib/runner";
import { useStore } from "@/lib/store";
import { useRecordingSource } from "@/lib/realapi/hooks";
import { sourceLabel } from "@/lib/realapi/connectionSlice";
import { useGetTestSuitesQuery } from "@/lib/realapi/realApi";
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

function errText(err: unknown): string {
  if (!err) return "";
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const e = err as { error?: unknown; data?: unknown; status?: unknown };
    if (typeof e.error === "string") return e.error;
    if (typeof e.data === "string") return e.data;
    if (e.status !== undefined) return `HTTP ${String(e.status)}`;
  }
  return String(err);
}

export default function SuitesPage() {
  const { source, onPlatform } = useRecordingSource();
  const { runSuite } = useRunner();
  const { toast } = useStore();
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

  // The agent is always local, so every member must exist in the local bucket.
  // Check first and name what is missing — running a suite that silently skips
  // recordings would report a green suite that never ran half its steps.
  const runLocally = async (suite: SuiteRow) => {
    if (!suite.members.length) {
      toast("err", `${suite.name} has no recordings`);
      return;
    }
    setChecking(suite.id);
    try {
      const local = new Set((await api.scripts()).scripts.map((s) => s.name));
      const missing = suite.members.filter((name) => !local.has(name));
      if (missing.length) {
        toast(
          "err",
          `${suite.name}: ${missing.length} recording(s) not on the local runner — ${missing.join(", ")}. Import them from Recordings first.`,
        );
        return;
      }
      await runSuite(suite.members.map((name) => ({ name })));
    } catch (e) {
      toast("err", `${suite.name}: ${e instanceof Error ? e.message : String(e)}`);
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
            ? `Suites from ${sourceLabel(source)} — they run on your local worker.`
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
