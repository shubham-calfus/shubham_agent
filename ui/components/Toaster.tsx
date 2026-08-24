"use client";

import { useStore } from "@/lib/store";
import { IconCheck, IconClose } from "./icons";

export function Toaster() {
  const { toasts, dismissToast } = useStore();
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`fade-up pointer-events-auto flex items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur ${
            t.kind === "ok"
              ? "border-good/25 bg-good-soft text-good"
              : t.kind === "err"
                ? "border-bad/25 bg-bad-soft text-bad"
                : "border-line bg-surface text-ink-mid"
          }`}
        >
          {t.kind === "ok" && <IconCheck width={16} height={16} className="mt-0.5 shrink-0" />}
          <span className="flex-1 leading-snug">{t.text}</span>
          <button
            onClick={() => dismissToast(t.id)}
            className="shrink-0 opacity-60 hover:opacity-100"
            aria-label="Dismiss"
          >
            <IconClose width={14} height={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
