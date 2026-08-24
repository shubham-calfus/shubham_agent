"use client";

import Link from "next/link";
import { useState } from "react";
import { useStore, type RunTab } from "@/lib/store";
import { PageHeader, EmptyState, Spinner } from "@/components/ui";
import { FadeUp } from "@/components/motion";
import { IconClose, IconDownload, IconExternal, IconPlay } from "@/components/icons";

export default function RunsPage() {
  const { runTabs, activeRunId, setActiveRunId, closeRun } = useStore();
  const active = runTabs.find((r) => r.id === activeRunId) ?? runTabs[runTabs.length - 1];

  return (
    <>
      <PageHeader
        eyebrow="Execution"
        title="Runs"
        subtitle="Live output and HTML reports for every triggered run."
        actions={
          <Link href="/recordings" className="btn btn-sm">
            <IconPlay width={14} height={14} />
            Trigger a run
          </Link>
        }
      />

      <div className="p-8">
        {runTabs.length === 0 ? (
          <EmptyState
            icon={<IconPlay width={30} height={30} />}
            title="No runs yet"
            hint="Run a recording or a suite from the Recordings page — its output shows up here as a tab."
            action={
              <Link href="/recordings" className="btn btn-sm">
                Go to recordings
              </Link>
            }
          />
        ) : (
          <div className="space-y-4">
            {/* Run tabs */}
            <div className="flex flex-wrap gap-2">
              {runTabs.map((r) => {
                const on = r.id === active?.id;
                return (
                  <button
                    key={r.id}
                    onClick={() => setActiveRunId(r.id)}
                    className={`group flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold transition-all ${
                      on
                        ? "border-teal bg-teal-soft text-teal"
                        : "border-line-2 text-ink-mid hover:text-ink"
                    }`}
                  >
                    <StatusDotFor status={r.status} />
                    <span className="max-w-[180px] truncate">{r.label}</span>
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        closeRun(r.id);
                      }}
                      className="opacity-40 transition-opacity hover:opacity-100"
                    >
                      <IconClose width={13} height={13} />
                    </span>
                  </button>
                );
              })}
            </div>

            {active && <RunDetail key={active.id} run={active} />}
          </div>
        )}
      </div>
    </>
  );
}

function StatusDotFor({ status }: { status: RunTab["status"] }) {
  if (status === "running") return <Spinner size={12} className="text-teal" />;
  const color =
    status === "done" ? "bg-teal" : status === "error" ? "bg-bad" : "bg-ink-dim";
  return <span className={`h-2 w-2 rounded-full ${color}`} />;
}

function RunDetail({ run }: { run: RunTab }) {
  const [showLogs, setShowLogs] = useState(false);
  const res = run.result;

  return (
    <FadeUp className="space-y-4">
      <div className="card flex flex-wrap items-center justify-between gap-3 p-5">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="display text-lg font-bold text-ink">{run.label}</h2>
            <span
              className={`badge ${
                run.status === "done"
                  ? "badge-good"
                  : run.status === "error"
                    ? "border-bad/30 bg-bad-soft text-bad"
                    : "badge-muted"
              }`}
            >
              {run.status === "running" ? "running" : run.status === "done" ? "passed" : "failed"}
            </span>
          </div>
          {res && (
            <div className="mt-1 text-xs text-ink-mid">
              mode {res.execution_mode} · wait {res.used_after_action_wait_ms}ms
              {res.prepared_recording_count ? ` · ${res.prepared_recording_count} recording(s)` : ""}
              {res.returncode !== undefined ? ` · exit ${res.returncode}` : ""}
            </div>
          )}
        </div>

        {res?.report_url && (
          <div className="flex items-center gap-2">
            <a href={res.report_url} target="_blank" rel="noreferrer" className="btn btn-sm">
              <IconExternal width={14} height={14} />
              Open report
            </a>
            <a href={res.report_url} download className="btn-ghost btn-sm">
              <IconDownload width={14} height={14} />
              Download
            </a>
          </div>
        )}
      </div>

      {run.status === "running" && (
        <div className="card flex items-center gap-3 p-8 text-sm text-ink-mid">
          <Spinner size={18} className="text-teal" />
          Executing — this can take a while for real Oracle flows…
        </div>
      )}

      {run.error && (
        <div className="rounded-xl border border-bad/25 bg-bad-soft px-4 py-3 text-sm text-bad">
          {run.error}
        </div>
      )}

      {/* Embedded report */}
      {res?.report_url && (
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <div className="eyebrow">HTML report</div>
            <span className="text-[11px] text-ink-dim">{res.report_key}</span>
          </div>
          <iframe
            src={res.report_url}
            title="ACT report"
            className="h-[70vh] w-full bg-white"
            sandbox="allow-scripts allow-same-origin allow-popups"
          />
        </div>
      )}

      {res && !res.report_url && run.status !== "running" && (
        <div className="rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-sm text-warn">
          The run finished but no report artifact was returned. Check the logs below.
        </div>
      )}

      {/* Logs */}
      {res && (
        <div className="card overflow-hidden">
          <button
            onClick={() => setShowLogs((s) => !s)}
            className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold text-ink"
          >
            <span>Execution logs (stdout / stderr)</span>
            <span className="text-ink-dim">{showLogs ? "Hide" : "Show"}</span>
          </button>
          {showLogs && (
            <div className="space-y-3 border-t border-line p-4">
              {res.stdout && (
                <div>
                  <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.14em] text-ink-dim">
                    stdout
                  </div>
                  <pre className="max-h-80 overflow-auto rounded-xl border border-line bg-surface-2 p-3 font-mono text-xs leading-relaxed text-ink">
                    {res.stdout}
                  </pre>
                </div>
              )}
              {res.stderr && (
                <div>
                  <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.14em] text-ink-dim">
                    stderr
                  </div>
                  <pre className="max-h-80 overflow-auto rounded-xl border border-line bg-surface-2 p-3 font-mono text-xs leading-relaxed text-bad">
                    {res.stderr}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </FadeUp>
  );
}
