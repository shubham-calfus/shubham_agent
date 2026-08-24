import { useSyncExternalStore } from "react";
import { useDispatch, useSelector } from "react-redux";
import type { AppDispatch, RootState } from "./store";
import { isPlatformSource, type RecordingSource } from "./connectionSlice";

export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();

// Never notifies — the snapshot flips exactly once, when React swaps the server
// snapshot for the client one after this component has hydrated.
const neverChanges = () => () => {};

// True only after THIS component has hydrated. The store-level `hydrated` flag
// is not sufficient on its own: ReduxProvider lives in the layout, which
// hydrates (and runs its effects) BEFORE a <Suspense>-wrapped page renders on
// the client — so by that page's first client render the store already held the
// persisted value while the server HTML did not. A per-component gate is
// ordering-proof.
//
// useSyncExternalStore rather than useState+useEffect: this codebase enforces
// react-hooks/set-state-in-effect, and this is the idiom React added
// getServerSnapshot for.
function useHydrated(): boolean {
  return useSyncExternalStore(
    neverChanges,
    () => true, // client
    () => false, // server, and this component's hydration render
  );
}

// --------------------------------------------------------------------------
// The ONLY way UI should read the recordings source.
//
// The persisted source comes from localStorage, which the server does not have,
// so any render that could be a hydration render must still produce the server's
// output. Until this component has hydrated AND ReduxProvider has applied
// storage, this reports the SSR default ("runner"); then the real value arrives
// and the tree re-renders. Reading `state.connection.source` directly in render
// re-breaks hydration.
// --------------------------------------------------------------------------
export function useRecordingSource(): {
  source: RecordingSource;
  onPlatform: boolean;
  hydrated: boolean;
} {
  const { source, hydrated } = useAppSelector((s) => s.connection);
  const ready = useHydrated() && hydrated;
  const effective: RecordingSource = ready ? source : "runner";
  return { source: effective, onPlatform: isPlatformSource(effective), hydrated: ready };
}
