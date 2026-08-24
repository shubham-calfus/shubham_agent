"use client";

import { useCallback } from "react";
import { api } from "@/lib/api";
import { useAsyncData } from "@/lib/useAsyncData";
import type { AppConfig } from "@/lib/types";
import { PageHeader, Spinner } from "@/components/ui";
import { FadeUp } from "@/components/motion";
import { ConnectionCard } from "@/components/ConnectionCard";
import { IconDatabase, IconLink, IconRefresh, IconSettings } from "@/components/icons";

export default function ConfigPage() {
  const fetcher = useCallback(() => api.config(), []);
  const { data: config, error, loading, reload: load } = useAsyncData<AppConfig>(fetcher);

  const groups = config
    ? [
        {
          icon: IconLink,
          title: "Object storage",
          rows: [
            ["Bucket", config.bucket],
            ["Endpoint", config.storage_endpoint],
          ],
        },
        {
          icon: IconDatabase,
          title: "Postgres",
          rows: [
            ["Host", config.pg.host],
            ["Port", String(config.pg.port)],
            ["Database", config.pg.db],
          ],
        },
        {
          icon: IconSettings,
          title: "Runner",
          rows: [
            ["aetherion CLI", config.aetherion_bin],
            ["Runner dir", config.test_runner_dir],
            ["Default wait", `${config.default_after_action_wait_ms} ms`],
          ],
        },
      ]
    : [];

  return (
    <>
      <PageHeader
        eyebrow="Environment"
        title="Settings"
        subtitle="Backend configuration reported by the local runner."
        actions={
          <button className="btn-ghost btn-sm" onClick={load} disabled={loading}>
            {loading ? <Spinner size={14} /> : <IconRefresh width={14} height={14} />}
            Refresh
          </button>
        }
      />

      <div className="space-y-6 p-8">
        <ConnectionCard />

        {error && (
          <div className="rounded-xl border border-bad/25 bg-bad-soft px-4 py-3 text-sm text-bad">
            Could not reach the backend: {error}
          </div>
        )}
        {loading && !config && (
          <div className="flex items-center gap-2 text-sm text-ink-mid">
            <Spinner size={16} /> Loading…
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-3">
          {groups.map(({ icon: Icon, title, rows }, i) => (
            <FadeUp key={title} delay={i * 0.08}>
              <div className="card accent-l h-full p-5">
                <div className="mb-4 flex items-center gap-2.5">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-soft text-teal">
                    <Icon width={16} height={16} />
                  </span>
                  <h2 className="text-sm font-bold text-ink">{title}</h2>
                </div>
                <dl className="space-y-2.5 text-sm">
                  {rows.map(([k, v]) => (
                    <div key={k} className="flex items-start justify-between gap-3 border-b border-line pb-2">
                      <dt className="shrink-0 text-ink-mid">{k}</dt>
                      <dd
                        className="min-w-0 break-all text-right font-mono text-xs text-ink"
                        title={v}
                      >
                        {v}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            </FadeUp>
          ))}
        </div>

        <div className="card p-5 text-sm leading-relaxed text-ink-mid">
          <div className="eyebrow mb-3">About</div>
          ACT Studio is a Next.js front-end for the local ACT Agent stack. It proxies{" "}
          <code className="chip">/api/*</code> to the shubham_agent FastAPI backend, which talks to
          MinIO, Postgres and the <code className="chip">aetherion</code> CLI. Set{" "}
          <code className="chip">ACT_BACKEND_URL</code> to target a different backend host.
        </div>
      </div>
    </>
  );
}
