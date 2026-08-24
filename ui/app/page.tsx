"use client";

import Link from "next/link";
import { useCallback } from "react";
import { api } from "@/lib/api";
import { useAsyncData } from "@/lib/useAsyncData";
import { useRunner } from "@/lib/runner";
import { useStore } from "@/lib/store";
import type { AppConfig, ScriptListItem } from "@/lib/types";
import { PageHeader, Spinner } from "@/components/ui";
import { FadeUp, Stagger, StaggerItem } from "@/components/motion";
import {
  IconDatabase,
  IconEdit,
  IconFilm,
  IconPlay,
  IconPlus,
  IconRefresh,
} from "@/components/icons";

interface DashboardData {
  scripts: ScriptListItem[];
  config: AppConfig | null;
}

export default function DashboardPage() {
  const fetcher = useCallback(async (): Promise<DashboardData> => {
    const [s, c] = await Promise.allSettled([api.scripts(), api.config()]);
    if (s.status !== "fulfilled") throw s.reason;
    return { scripts: s.value.scripts, config: c.status === "fulfilled" ? c.value : null };
  }, []);

  const { data, error, loading, reload } = useAsyncData<DashboardData>(fetcher);
  const scripts = data?.scripts ?? null;
  const config = data?.config ?? null;
  const { runSingle } = useRunner();
  const { suite, runTabs, toggleSuite, inSuite } = useStore();
  const load = reload;

  const total = scripts?.length ?? 0;
  const registered = scripts?.filter((s) => s.has_db).length ?? 0;
  const unregistered = total - registered;

  const stats = [
    { label: "Recordings", value: total, icon: IconFilm, tone: "brand" as const },
    { label: "Registered", value: registered, icon: IconDatabase, tone: "good" as const },
    { label: "Unregistered", value: unregistered, icon: IconDatabase, tone: "warn" as const },
    { label: "In suite", value: suite.length, icon: IconPlus, tone: "violet" as const },
    { label: "Run tabs", value: runTabs.length, icon: IconPlay, tone: "brand" as const },
  ];

  const toneClass: Record<string, string> = {
    brand: "bg-brand-soft text-brand",
    good: "bg-good-soft text-good",
    warn: "bg-warn-soft text-warn",
    violet: "bg-violet-soft text-violet",
  };

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title="Dashboard"
        subtitle="ACT Agent authoring & execution at a glance."
        actions={
          <>
            <button className="btn-ghost btn-sm" onClick={load} disabled={loading}>
              {loading ? <Spinner size={14} /> : <IconRefresh width={14} height={14} />}
              Refresh
            </button>
            <Link href="/recordings" className="btn btn-sm">
              <IconPlus width={14} height={14} />
              New recording
            </Link>
          </>
        }
      />

      <div className="space-y-6 p-8">
        {error && (
          <div className="rounded-xl border border-bad/25 bg-bad-soft px-4 py-3 text-sm text-bad">
            Could not reach the backend: {error}. Is the shubham_agent server running on{" "}
            <code className="font-mono">:8765</code>?
          </div>
        )}

        {/* Stat tiles */}
        <Stagger className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {stats.map(({ label, value, icon: Icon, tone }) => (
            <StaggerItem key={label}>
              <div className="card accent-l h-full p-4">
                <div
                  className={`mb-3 inline-flex h-9 w-9 items-center justify-center rounded-xl ${toneClass[tone]}`}
                >
                  <Icon width={18} height={18} />
                </div>
                <div className="display text-3xl font-bold text-ink">
                  {loading ? <span className="text-ink-dim">—</span> : value}
                </div>
                <div className="mt-0.5 text-xs font-semibold text-ink-mid">{label}</div>
              </div>
            </StaggerItem>
          ))}
        </Stagger>

        <FadeUp delay={0.15} className="grid gap-6 lg:grid-cols-3">
          {/* Recent recordings */}
          <div className="card lg:col-span-2">
            <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
              <h2 className="text-sm font-bold text-ink">Recent recordings</h2>
              <Link href="/recordings" className="text-xs font-semibold text-brand hover:underline">
                View all →
              </Link>
            </div>
            <div className="divide-y divide-line">
              {loading && (
                <div className="flex items-center gap-2 px-5 py-8 text-sm text-ink-mid">
                  <Spinner size={16} /> Loading recordings…
                </div>
              )}
              {!loading && scripts && scripts.length === 0 && (
                <div className="px-5 py-8 text-sm text-ink-mid">
                  No recordings yet.{" "}
                  <Link href="/recordings" className="font-semibold text-brand hover:underline">
                    Author one →
                  </Link>
                </div>
              )}
              {!loading &&
                scripts?.slice(0, 6).map((s) => (
                  <div
                    key={s.name}
                    className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-surface-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-ink">{s.name}</div>
                      <div className="mt-0.5 flex items-center gap-2">
                        <span className={`badge ${s.has_db ? "badge-good" : "badge-muted"}`}>
                          {s.has_db ? "Registered" : "No DB row"}
                        </span>
                        {s.params_key && (
                          <span className="chip">
                            {s.params_key.endsWith(".csv") ? "csv" : "xlsx"}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        className={`btn-ghost btn-sm ${inSuite(s.name) ? "border-brand text-brand" : ""}`}
                        onClick={() => toggleSuite(s.name)}
                        title={inSuite(s.name) ? "Remove from suite" : "Add to suite"}
                      >
                        {inSuite(s.name) ? "In suite" : "+ Suite"}
                      </button>
                      <Link
                        href={`/recordings?name=${encodeURIComponent(s.name)}`}
                        className="btn-ghost btn-sm"
                        title="Edit"
                      >
                        <IconEdit width={14} height={14} />
                      </Link>
                      <button className="btn btn-sm" onClick={() => runSingle(s.name)} title="Run">
                        <IconPlay width={14} height={14} />
                        Run
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          </div>

          {/* Backend / environment */}
          <div className="card">
            <div className="border-b border-line px-5 py-3.5">
              <h2 className="text-sm font-bold text-ink">Environment</h2>
            </div>
            <dl className="space-y-3 p-5 text-sm">
              {config ? (
                <>
                  <EnvRow label="Bucket" value={config.bucket} />
                  <EnvRow label="Storage" value={config.storage_endpoint} mono />
                  <EnvRow
                    label="Postgres"
                    value={`${config.pg.host}:${config.pg.port}/${config.pg.db}`}
                    mono
                  />
                  <EnvRow label="Runner dir" value={config.test_runner_dir} mono />
                  <EnvRow label="Default wait" value={`${config.default_after_action_wait_ms} ms`} />
                  <Link
                    href="/config"
                    className="mt-1 block text-xs font-semibold text-brand hover:underline"
                  >
                    Full settings →
                  </Link>
                </>
              ) : (
                <div className="text-ink-dim">{loading ? "Loading…" : "Unavailable"}</div>
              )}
            </dl>
          </div>
        </FadeUp>
      </div>
    </>
  );
}

function EnvRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-ink-mid">{label}</dt>
      <dd
        className={`min-w-0 truncate text-right text-ink ${mono ? "font-mono text-xs" : ""}`}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}
