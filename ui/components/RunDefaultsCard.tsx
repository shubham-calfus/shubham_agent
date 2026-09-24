"use client";

import { useState } from "react";
import { useRunDefaults, type RunDefaults } from "@/lib/runDefaults";
import { useStore } from "@/lib/store";
import { IconSettings } from "@/components/icons";

/**
 * The Application URL and fallback credentials every run sends.
 *
 * The URL is the one that matters: since act 6.0.88 it is the only source of a recording's
 * start URL, so leaving it blank fails any recording that navigates via a `{{placeholder}}`
 * before the browser even opens. The credentials are optional -- a recording whose own params
 * workbook supplies one keeps using it.
 */
export function RunDefaultsCard({ defaultUrl = "" }: { defaultUrl?: string }) {
  const [saved, save] = useRunDefaults();
  const store = useStore();

  // null means "untouched", so the form simply SHOWS the saved values until the user types.
  // That avoids copying `saved` into state, which would need an effect to stay in sync with
  // the storage read that only happens after hydration -- and that effect is what React now
  // (rightly) flags.
  const [edited, setEdited] = useState<RunDefaults | null>(null);
  const draft = edited ?? saved;

  const dirty =
    edited !== null &&
    (draft.url !== saved.url ||
      draft.username !== saved.username ||
      draft.password !== saved.password);

  const field = (
    key: keyof RunDefaults,
    label: string,
    placeholder: string,
    hint: string,
    type: "text" | "password" = "text",
  ) => (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-ink">{label}</span>
      <input
        className="field w-full font-mono text-xs"
        type={type}
        value={draft[key]}
        placeholder={placeholder}
        autoComplete={type === "password" ? "new-password" : "off"}
        onChange={(e) => setEdited({ ...draft, [key]: e.target.value })}
      />
      <span className="mt-1 block text-xs text-ink-mid">{hint}</span>
    </label>
  );

  return (
    <div className="card accent-l p-5">
      <div className="mb-4 flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-soft text-teal">
          <IconSettings width={16} height={16} />
        </span>
        <div>
          <h2 className="text-sm font-bold text-ink">Run defaults</h2>
          <p className="text-xs text-ink-mid">
            Sent with every run you trigger from Studio, as the suite-level values.
          </p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {field(
          "url",
          "Application URL",
          defaultUrl || "https://your-instance.oracle.com",
          defaultUrl
            ? "The start URL for every recording — the one saved in a recording's workbook is ignored. Leave blank to use the default shown."
            : "Required. The start URL for every recording — the one saved in a recording's workbook is ignored.",
        )}
        {field(
          "username",
          "Username",
          "optional",
          "Used only by recordings whose own data sheet has no username.",
        )}
        {field(
          "password",
          "Password",
          "optional",
          "Kept for this browser session only, never written to disk.",
          "password",
        )}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          className="btn btn-sm"
          disabled={!dirty}
          onClick={() => {
            save(draft);
            // Back to "untouched" so the form follows the store again.
            setEdited(null);
            store.toast("ok", "Run defaults saved");
          }}
        >
          Save
        </button>
        {dirty && <span className="text-xs text-ink-mid">Unsaved changes</span>}
      </div>
    </div>
  );
}
