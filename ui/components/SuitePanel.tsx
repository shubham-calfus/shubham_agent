"use client";

import { useState } from "react";
import { useRunner } from "@/lib/runner";
import { useStore } from "@/lib/store";
import type { ExecutionMode } from "@/lib/types";
import { IconArrowDown, IconArrowUp, IconClose, IconPlay } from "./icons";
import { Spinner } from "./ui";

export function SuitePanel() {
  const { suite, moveSuite, removeFromSuite, clearSuite } = useStore();
  const { runSuite } = useRunner();
  const [mode, setMode] = useState<ExecutionMode>("sequential");
  const [waitMs, setWaitMs] = useState<number>(0);
  const [video, setVideo] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!suite.length) return null;

  const run = async () => {
    setBusy(true);
    await runSuite(
      suite.map((name) => ({ name })),
      { executionMode: mode, afterActionWaitMs: waitMs, recordVideo: video },
    );
    setBusy(false);
  };

  return (
    <div className="card fade-up overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h3 className="text-sm font-bold text-ink">
          Suite <span className="text-ink-dim">({suite.length})</span>
        </h3>
        <button className="btn-ghost btn-sm" onClick={clearSuite}>
          Clear
        </button>
      </div>

      <ol className="space-y-1.5 p-3">
        {suite.map((name, i) => (
          <li
            key={name}
            className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2"
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-brand-soft text-[11px] font-bold text-brand-ink">
              {i + 1}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">{name}</span>
            <button
              className="btn-ghost btn-sm !px-1.5"
              onClick={() => moveSuite(i, -1)}
              disabled={i === 0}
              title="Move up"
            >
              <IconArrowUp width={13} height={13} />
            </button>
            <button
              className="btn-ghost btn-sm !px-1.5"
              onClick={() => moveSuite(i, 1)}
              disabled={i === suite.length - 1}
              title="Move down"
            >
              <IconArrowDown width={13} height={13} />
            </button>
            <button
              className="btn-ghost btn-sm !px-1.5"
              onClick={() => removeFromSuite(name)}
              title="Remove"
            >
              <IconClose width={13} height={13} />
            </button>
          </li>
        ))}
      </ol>

      <div className="grid grid-cols-2 gap-3 px-3 pb-3">
        <div>
          <label className="label">Mode</label>
          <select
            className="field"
            value={mode}
            onChange={(e) => setMode(e.target.value as ExecutionMode)}
          >
            <option value="sequential">sequential</option>
            <option value="parallel">parallel</option>
          </select>
        </div>
        <div>
          <label className="label">Wait (ms)</label>
          <input
            className="field"
            type="number"
            min={0}
            step={100}
            value={waitMs}
            onChange={(e) => setWaitMs(Number(e.target.value || 0))}
          />
        </div>
      </div>

      <label className="mx-3 mb-3 flex cursor-pointer items-center gap-2 text-xs text-ink-mid">
        <input type="checkbox" checked={video} onChange={(e) => setVideo(e.target.checked)} />
        Record video (slower, larger report)
      </label>

      <div className="border-t border-line p-3">
        <button className="btn w-full" onClick={run} disabled={busy}>
          {busy ? <Spinner size={14} /> : <IconPlay width={15} height={15} />}
          Run suite
        </button>
      </div>
    </div>
  );
}
