import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

// --------------------------------------------------------------------------
// WHERE THE RECORDINGS LIST COMES FROM. This is the single setting the
// Settings dropdown drives:
//
//   "runner"          -> the local app.py backend: /api/scripts, i.e. the MinIO
//                        bucket + recorded_flows rows on THIS machine.
//   "platform-local"  -> the real Aetherion API at ACT_LOCAL_API_URL (:8001),
//   "platform-sbox"   -> the real Aetherion API at ACT_SBOX_API_URL,
//                        both proxied via /rapi/<prefix> (see next.config.ts) and
//                        authenticated with the pasted Bearer token + x-realm-id.
//
// The field is deliberately named `source`, not the old `env`: a browser that
// still has {"env":"local"} in localStorage from before this existed would
// otherwise silently start listing PLATFORM recordings. Ignoring the unknown key
// makes stale state fall back to the local runner, which is the safe default.
// --------------------------------------------------------------------------
export type RecordingSource = "runner" | "platform-local" | "platform-sbox";

export const RECORDING_SOURCES: { value: RecordingSource; label: string }[] = [
  { value: "runner", label: "Local runner (app.py → MinIO)" },
  { value: "platform-local", label: "Platform · local (:8001)" },
  { value: "platform-sbox", label: "Platform · sbox" },
];

// The /rapi/<prefix>/ segment for a platform source; "" for the local runner,
// which has no platform API at all.
export function platformPrefix(source: RecordingSource): string {
  if (source === "platform-local") return "local";
  if (source === "platform-sbox") return "sbox";
  return "";
}

export function isPlatformSource(source: RecordingSource): boolean {
  return platformPrefix(source) !== "";
}

export function sourceLabel(source: RecordingSource): string {
  return RECORDING_SOURCES.find((s) => s.value === source)?.label ?? source;
}

function isRecordingSource(value: unknown): value is RecordingSource {
  return RECORDING_SOURCES.some((s) => s.value === value);
}

export interface ConnectionState {
  source: RecordingSource;
  token: string; // pasted Bearer token (no auth flow yet) — platform sources only
  realm: string; // x-realm-id header — platform sources only
  // False until ReduxProvider has applied localStorage. Anything that renders
  // DIFFERENT TEXT per source must wait for this (see useRecordingSource):
  // the server has no localStorage, so using the persisted value in the first
  // client render is a guaranteed hydration mismatch.
  hydrated: boolean;
}

// SSR-safe defaults; the real values are applied from localStorage on the
// client by ReduxProvider, after mount.
const initialState: ConnectionState = {
  source: "runner",
  token: "",
  realm: "demo",
  hydrated: false,
};

const connectionSlice = createSlice({
  name: "connection",
  initialState,
  reducers: {
    // Assign only known, valid keys — this is what makes a stale/foreign
    // localStorage payload degrade to the defaults instead of corrupting state.
    setConnection: (state, action: PayloadAction<Partial<ConnectionState>>) => {
      const { source, token, realm } = action.payload;
      if (isRecordingSource(source)) state.source = source;
      if (typeof token === "string") state.token = token;
      if (typeof realm === "string") state.realm = realm;
    },
    clearToken: (state) => {
      state.token = "";
    },
    // Dispatched once by ReduxProvider after localStorage has been read —
    // whether or not anything was stored.
    connectionHydrated: (state) => {
      state.hydrated = true;
    },
  },
});

export const { setConnection, clearToken, connectionHydrated } = connectionSlice.actions;
export default connectionSlice.reducer;
