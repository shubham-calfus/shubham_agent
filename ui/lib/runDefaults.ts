"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Suite-level values every run sends: the application URL, and the fallback credentials.
 *
 * WHY THESE LIVE HERE AND NOT IN A FORM PER RUN. One local stack points at one Oracle
 * environment, so the URL is the same for every run until you switch environments. Asking for
 * it on each trigger would be three clicks of pure ceremony, and the four places that can start
 * a run (dashboard, recording editor, suites page, suite panel) would each need their own copy
 * of the field. `useRunner` reads these instead, so every trigger point picks them up unchanged.
 *
 * WHY THE URL MATTERS AT ALL. Since act 6.0.88 the suite URL is the ONLY source of a
 * recording's start URL -- the one stored in the params workbook is ignored outright -- so a
 * recording whose first navigation is a `{{placeholder}}` fails before the browser opens when
 * nothing supplies one. Runs triggered from Studio had no way to pass it, which is the failure
 * this fixes.
 *
 * WHERE EACH VALUE IS KEPT, and why they differ:
 *   url, username -> localStorage.   Not secret, and you want them to survive a restart.
 *   password      -> sessionStorage. Cleared when the browser closes. A dev box is not a
 *                    hostile environment, but a password that outlives the tab for no reason
 *                    is a cost with no benefit -- and a blank one simply falls back to the
 *                    credential in each recording's own params workbook, which is where most
 *                    of them already live.
 */
export interface RunDefaults {
  url: string;
  username: string;
  password: string;
}

const EMPTY: RunDefaults = { url: "", username: "", password: "" };

const URL_KEY = "act.run.url";
const USERNAME_KEY = "act.run.username";
const PASSWORD_KEY = "act.run.password";

// Every access is wrapped: storage throws in a private window and on a blocked-cookies origin,
// and a thrown read here would take the whole run trigger down with it. Losing a remembered
// URL is recoverable; failing to start a run is not worth it.
function read(store: Storage | undefined, key: string): string {
  try {
    return store?.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function write(store: Storage | undefined, key: string, value: string): void {
  try {
    if (value) store?.setItem(key, value);
    else store?.removeItem(key);
  } catch {
    /* storage unavailable -- the value simply is not remembered */
  }
}

// The snapshot is CACHED rather than rebuilt per call, because `useSyncExternalStore` compares
// it by reference: a fresh object each time would be seen as a change on every render and spin
// forever. It is invalidated only by setRunDefaults.
let cache: RunDefaults | null = null;
const listeners = new Set<() => void>();

/** The current defaults. Safe to call outside React; returns blanks during SSR. */
export function getRunDefaults(): RunDefaults {
  if (typeof window === "undefined") return EMPTY;
  if (cache === null) {
    cache = {
      url: read(window.localStorage, URL_KEY).trim(),
      username: read(window.localStorage, USERNAME_KEY).trim(),
      password: read(window.sessionStorage, PASSWORD_KEY),
    };
  }
  return cache;
}

export function setRunDefaults(next: RunDefaults): void {
  if (typeof window === "undefined") return;
  write(window.localStorage, URL_KEY, next.url.trim());
  write(window.localStorage, USERNAME_KEY, next.username.trim());
  write(window.sessionStorage, PASSWORD_KEY, next.password);
  cache = { url: next.url.trim(), username: next.username.trim(), password: next.password };
  listeners.forEach((notify) => notify());
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

/**
 * React binding for the settings form.
 *
 * `useSyncExternalStore` rather than state-seeded-from-an-effect: storage is not readable
 * during the server render, and this is exactly the case the API exists for -- it takes a
 * separate server snapshot, so there is no hydration mismatch and no effect that writes state
 * on mount. It also means a save in one component is seen by every other one immediately.
 */
export function useRunDefaults(): [RunDefaults, (next: RunDefaults) => void] {
  const values = useSyncExternalStore(subscribe, getRunDefaults, () => EMPTY);
  const save = useCallback((next: RunDefaults) => setRunDefaults(next), []);
  return [values, save];
}
