"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import type { ScriptDetail, UploadResult } from "@/lib/types";
import { Spinner } from "@/components/ui";
import { CodeEditor } from "@/components/CodeEditor";
import { FadeUp } from "@/components/motion";
import {
  IconDownload,
  IconExternal,
  IconPlay,
  IconUpload,
} from "@/components/icons";

const DEFAULT_PARAMS = `{
  "params": [
    { "username": "", "password": "" }
  ]
}`;

// ---------------------------------------------------------------------------
// The single edit surface for a recording. Used inline in the Recordings page
// so browsing and editing happen on one screen. Pass initialName="" to author
// a brand-new recording; pass an existing name to load and edit it.
//
// The parent keys this component by selection, so switching recordings
// remounts it and the load effect re-runs from a clean slate.
// ---------------------------------------------------------------------------
export function RecordingEditor({
  initialName,
  inSuite,
  onToggleSuite,
  onRun,
  onSaved,
  loader,
  stageBeforeRun = false,
}: {
  initialName: string;
  inSuite: boolean;
  onToggleSuite: () => void;
  onRun: () => void;
  onSaved: (name: string) => void;
  // Where the content comes from. Defaults to the local backend
  // (api.script(name)); the Recordings page passes a platform loader when the
  // selected source is sbox/local-platform, so this component stays identical
  // either way — only the origin of the bytes changes.
  loader?: (name: string) => Promise<ScriptDetail>;
  // The local worker can only execute what is in the LOCAL bucket, so a
  // platform-sourced recording has to be materialised there before Run. This
  // stages the objects only (register=false) — it deliberately does NOT create
  // the recorded_flows row, so "Save to MinIO + DB" stays the explicit action
  // that puts a recording in your library.
  stageBeforeRun?: boolean;
}) {
  const isNew = !initialName;
  const { toast } = useStore();

  const [name, setName] = useState(initialName);
  const [overwrite, setOverwrite] = useState(true);
  const [script, setScript] = useState("");
  const [paramsText, setParamsText] = useState(DEFAULT_PARAMS);
  const [prompt, setPrompt] = useState("");
  const [repeatable, setRepeatable] = useState(false);
  const [startUrl, setStartUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [staging, setStaging] = useState(false);
  const [loadingExisting, setLoadingExisting] = useState(!isNew);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState("");

  // Load the existing recording into the form. (setState only inside the
  // promise callbacks — never synchronously.)
  useEffect(() => {
    if (isNew) return;
    let alive = true;
    (loader ? loader(initialName) : api.script(initialName))
      .then((d) => {
        if (!alive) return;
        setName(d.name);
        setScript(d.py_text);
        const payload: Record<string, unknown> = { params: d.params };
        if (d.line_items.length) payload.line_items = d.line_items;
        setParamsText(JSON.stringify(payload, null, 2));
        setPrompt(d.recording_config?.prompt || "");
        setRepeatable(
          (d.recording_config?.repeatable_blocks?.length ?? 0) > 0 || d.line_items.length > 0,
        );
        setStartUrl(d.db?.start_url || "");
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoadingExisting(false));
    return () => {
      alive = false;
    };
  }, [initialName, isNew, loader]);

  const parseParams = useCallback((): unknown => {
    const text = paramsText.trim();
    if (!text) return { params: [{}] };
    return JSON.parse(text);
  }, [paramsText]);

  // Returns whether the save succeeded, so "Save & Run" can chain on it.
  const doUpload = async (): Promise<boolean> => {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const parsed = parseParams();
      const res = await api.upload({
        name,
        script,
        params: parsed,
        prompt,
        overwrite,
        repeatable_blocks: repeatable ? [{ enabled: true, sheet_name: "line_items" }] : null,
      });
      setResult(res);
      toast("ok", `Saved ${res.name} · ${res.param_rows} param row(s)`);
      onSaved(res.name);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast("err", `Save failed: ${msg}`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const downloadPreview = async () => {
    setError("");
    try {
      const res = await api.paramsXlsx(name || "recording", parseParams());
      window.open(res.download_url, "_blank");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast("err", `Preview failed: ${msg}`);
    }
  };

  if (loadingExisting) {
    return (
      <div className="card flex items-center gap-2 p-8 text-sm text-ink-mid">
        <Spinner size={16} /> Loading {initialName}…
      </div>
    );
  }

  return (
    <FadeUp className="space-y-4">
      {/* Toolbar: identity + primary actions */}
      <div className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="eyebrow">{isNew ? "New recording" : "Edit recording"}</div>
            <h2 className="display truncate text-xl font-bold text-ink">
              {name || "Untitled recording"}
            </h2>
            {startUrl && (
              <a
                href={startUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1.5 text-xs text-teal hover:underline"
              >
                <IconExternal width={13} height={13} />
                <span className="max-w-md truncate">{startUrl}</span>
              </a>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!isNew && (
              <>
                <button
                  className={`btn-ghost btn-sm ${inSuite ? "border-teal text-teal" : ""}`}
                  onClick={onToggleSuite}
                >
                  {inSuite ? "In suite" : "+ Suite"}
                </button>
                <button
                  className="btn-ghost btn-sm"
                  disabled={busy || staging}
                  onClick={async () => {
                    if (stageBeforeRun) {
                      setStaging(true);
                      try {
                        const res = await api.upload({
                          name,
                          script,
                          params: parseParams(),
                          prompt,
                          overwrite: true,
                          register: false,
                          repeatable_blocks: repeatable
                            ? [{ enabled: true, sheet_name: "line_items" }]
                            : null,
                        });
                        toast("ok", `Staged ${res.name} locally · running`);
                      } catch (e) {
                        const msg = e instanceof Error ? e.message : String(e);
                        setError(msg);
                        toast("err", `Could not stage for the local runner: ${msg}`);
                        return; // fail loudly; do not dispatch a run that cannot work
                      } finally {
                        setStaging(false);
                      }
                    }
                    onRun();
                  }}
                >
                  {staging ? <Spinner size={14} /> : <IconPlay width={14} height={14} />}
                  Run
                </button>
              </>
            )}
            <button className="btn btn-sm" onClick={doUpload} disabled={busy || !script.trim()}>
              {busy ? <Spinner size={14} /> : <IconUpload width={14} height={14} />}
              Save to MinIO + DB
            </button>
          </div>
        </div>
      </div>

      {/* Name + overwrite */}
      <div className="card grid gap-4 p-5 sm:grid-cols-[1fr_180px]">
        <div>
          <label className="label">Recording name</label>
          <input
            className="field"
            placeholder="recording_name_v1"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Overwrite</label>
          <select
            className="field"
            value={String(overwrite)}
            onChange={(e) => setOverwrite(e.target.value === "true")}
          >
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </div>
      </div>

      {/* Script + params */}
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="card p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="eyebrow">Script</div>
            <span className="text-[11px] text-ink-dim">Playwright or plain Python</span>
          </div>
          <CodeEditor value={script} onChange={setScript} language="python" height={420} />
        </div>
        <div className="card p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="eyebrow">Parameters</div>
            <span className="text-[11px] text-ink-dim">flat JSON · {`{"params":[...]}`}</span>
          </div>
          <CodeEditor value={paramsText} onChange={setParamsText} language="json" height={420} />
        </div>
      </div>

      {/* Prompt + repeatable */}
      <div className="card space-y-4 p-5">
        <div>
          <label className="label">Prompt</label>
          <textarea
            className="field font-sans"
            rows={3}
            placeholder="Recording guidance. If it has a repeatable block, name the repeated fields here, e.g. 'Repeat the line item for each row: Description, Quantity, Unit Price'."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>
        <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-line-2 px-4 py-3 text-sm text-ink">
          <input
            type="checkbox"
            checked={repeatable}
            onChange={(e) => setRepeatable(e.target.checked)}
          />
          This recording has a repeatable block
        </label>
        {repeatable && (
          <div className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-xs leading-relaxed text-ink-mid">
            Rows loop over the <b className="text-ink">line_items</b> sheet (linked by{" "}
            <b className="text-ink">ref_id</b>). Put the loop instructions in the Prompt field above.
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost btn-sm" onClick={downloadPreview}>
            <IconDownload width={14} height={14} />
            Download params.xlsx preview
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-bad/25 bg-bad-soft px-4 py-3 text-sm text-bad">
          {error}
        </div>
      )}

      {result && (
        <FadeUp className="card accent-l space-y-3 p-5">
          <div className="eyebrow">Saved</div>
          <div className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            <KV k="Name" v={result.name} />
            <KV k="Bucket" v={result.bucket} />
            <KV k="Param rows" v={String(result.param_rows)} />
            <KV k="Line rows" v={String(result.multi_line_row_count)} />
            <KV k="Start URL" v={result.start_url || "—"} />
            <KV
              k="DB"
              v={
                result.db_error
                  ? `error: ${result.db_error}`
                  : result.db?.inserted
                    ? "inserted"
                    : result.db?.conflict
                      ? "unchanged"
                      : "updated"
              }
            />
          </div>
          {result.missing_placeholders.length > 0 && (
            <div className="rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-sm text-warn">
              Missing values for placeholders: {result.missing_placeholders.join(", ")}
            </div>
          )}
        </FadeUp>
      )}
    </FadeUp>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line py-1">
      <span className="text-ink-mid">{k}</span>
      <span className="min-w-0 truncate text-right font-mono text-xs text-ink" title={v}>
        {v}
      </span>
    </div>
  );
}
