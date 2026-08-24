import type { ReactNode } from "react";

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="sticky top-0 z-10 flex items-end justify-between gap-4 border-b border-line bg-bg/80 px-8 py-5 backdrop-blur">
      <div>
        {eyebrow && <div className="eyebrow mb-2">{eyebrow}</div>}
        <h1 className="display text-2xl font-bold text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-mid">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Spinner({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <span
      className={`spin inline-block rounded-full border-2 border-current border-t-transparent align-[-2px] ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-line-2 bg-surface-2 px-6 py-14 text-center">
      {icon && <div className="mb-3 text-ink-dim">{icon}</div>}
      <div className="text-sm font-semibold text-ink">{title}</div>
      {hint && <div className="mt-1 max-w-sm text-sm text-ink-mid">{hint}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${ok ? "bg-good" : "bg-ink-dim"}`}
      aria-hidden
    />
  );
}
