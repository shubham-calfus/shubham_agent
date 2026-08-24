"use client";

import { useEffect, useState } from "react";

// Tracks the `data-theme` attribute on <html> and updates live when the
// sidebar toggle flips it (via a MutationObserver).
export function useThemeMode(): "light" | "dark" {
  const [mode, setMode] = useState<"light" | "dark">("light");

  useEffect(() => {
    const el = document.documentElement;
    const read = () => setMode((el.dataset.theme as "light" | "dark") || "light");
    read();
    const obs = new MutationObserver(read);
    obs.observe(el, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  return mode;
}
