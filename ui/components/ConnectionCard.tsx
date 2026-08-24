"use client";

import { useAppDispatch, useAppSelector, useRecordingSource } from "@/lib/realapi/hooks";
import {
  RECORDING_SOURCES,
  platformPrefix,
  setConnection,
  type RecordingSource,
} from "@/lib/realapi/connectionSlice";
import { useStore } from "@/lib/store";

// Picks WHERE the Recordings list is fetched from, and holds the credentials the
// platform sources need. Redux-controlled and auto-saved to localStorage by
// ReduxProvider — no explicit save step.
export function ConnectionCard() {
  const dispatch = useAppDispatch();
  const conn = useAppSelector((s) => s.connection);
  const { toast } = useStore();
  // Gated so the per-source helper text/badge render identically on the server
  // and in the first client pass (see useRecordingSource).
  const { source, onPlatform } = useRecordingSource();

  return (
    <div className="card p-5">
      <div className="mb-4 flex items-center justify-between">
        <div className="eyebrow">Recordings source</div>
        <span
          className={`badge ${!onPlatform ? "badge-brand" : conn.token ? "badge-good" : "badge-muted"}`}
        >
          {!onPlatform ? "local runner" : conn.token ? "token set" : "no token"}
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label">Fetch recordings from</label>
          <select
            className="field"
            value={source}
            onChange={(e) => dispatch(setConnection({ source: e.target.value as RecordingSource }))}
          >
            {RECORDING_SOURCES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-[11px] text-ink-dim">
            Drives the Recordings page. The local runner lists this machine&apos;s MinIO bucket;
            a platform source lists its <code className="font-mono">recorded-flow-list</code>.
          </p>
        </div>
        <div>
          <label className="label">Realm (x-realm-id)</label>
          <input
            className="field"
            value={conn.realm}
            placeholder="demo"
            disabled={!onPlatform}
            onChange={(e) => dispatch(setConnection({ realm: e.target.value }))}
          />
        </div>
      </div>

      <div className="mt-4">
        <label className="label">Bearer token</label>
        <textarea
          className="field font-mono !text-[11px]"
          rows={4}
          placeholder="Paste the Bearer token (without the 'Bearer ' prefix)…"
          value={conn.token}
          spellCheck={false}
          disabled={!onPlatform}
          onChange={(e) => dispatch(setConnection({ token: e.target.value.trim() }))}
        />
        <p className="mt-1.5 text-[11px] text-ink-dim">
          {onPlatform ? (
            <>
              Sent as <code className="font-mono">Authorization: Bearer …</code> +{" "}
              <code className="font-mono">x-realm-id</code>, proxied via{" "}
              <code className="font-mono">/rapi/{platformPrefix(source)}</code>. Auto-saved in
              your browser.
            </>
          ) : (
            <>
              Only used by the platform sources — the local runner talks to{" "}
              <code className="font-mono">app.py</code>, which needs no token.
            </>
          )}
        </p>
      </div>

      <div className="mt-4 flex gap-2">
        <button
          className="btn-ghost btn-sm"
          onClick={() => {
            dispatch(setConnection({ token: "" }));
            toast("ok", "Token cleared");
          }}
          disabled={!conn.token}
        >
          Clear token
        </button>
      </div>
    </div>
  );
}
