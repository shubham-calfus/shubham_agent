"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useStore } from "@/lib/store";
import { ThemeToggle } from "./ThemeToggle";
import { IconFilm, IconFlow, IconGrid, IconPlay, IconSettings } from "./icons";
import type { ComponentType, SVGProps } from "react";

interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}

const NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: IconGrid },
  { href: "/recordings", label: "Recordings", icon: IconFilm },
  { href: "/suites", label: "Suites", icon: IconFlow },
  { href: "/run", label: "Runs", icon: IconPlay },
  { href: "/config", label: "Settings", icon: IconSettings },
];

export function Sidebar() {
  const pathname = usePathname();
  const { suite, runTabs } = useStore();

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  const badgeFor = (href: string) => {
    if (href === "/run" && runTabs.length) return runTabs.length;
    if (href === "/recordings" && suite.length) return suite.length;
    return null;
  };

  return (
    <aside className="fixed inset-y-0 left-0 z-20 flex w-64 flex-col border-r border-line bg-surface/95 backdrop-blur">
      <div className="flex items-center gap-3 border-b border-line px-5 py-4">
        <Image src="/aetherion-mark.png" alt="Aetherion" width={30} height={30} priority />
        <div className="leading-tight">
          <div className="display text-[17px] font-bold text-ink">
            aCT<span className="text-teal"> Studio</span>
          </div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.28em] text-ink-dim">
            by Aetherion
          </div>
        </div>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-4">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = isActive(href);
          const badge = badgeFor(href);
          return (
            <Link
              key={href}
              href={href}
              className={`group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors ${
                active
                  ? "bg-teal-soft text-teal"
                  : "text-ink-mid hover:bg-surface-3 hover:text-ink"
              }`}
            >
              {active && (
                <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-teal" aria-hidden />
              )}
              <Icon
                className={active ? "text-teal" : "text-ink-dim group-hover:text-ink-mid"}
                width={18}
                height={18}
              />
              <span className="flex-1">{label}</span>
              {badge != null && (
                <span className="rounded-full bg-teal px-2 py-0.5 text-[11px] font-bold text-white">
                  {badge}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="space-y-3 border-t border-line px-4 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.28em] text-ink-dim">
            <span className="rec-dot" />
            Local runner
          </div>
          <ThemeToggle />
        </div>
        <p className="text-[11px] leading-relaxed text-ink-dim">
          Author, trigger &amp; inspect recordings against your local stack.
        </p>
      </div>
    </aside>
  );
}
