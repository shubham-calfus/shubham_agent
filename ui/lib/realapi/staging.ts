"use client";

import { useCallback } from "react";
import { api } from "@/lib/api";
import type { UploadResult } from "@/lib/types";
import {
  useDownloadPlatformFileB64Mutation,
  useDownloadPlatformFileMutation,
  type PlatformRecording,
  type RecordedFlowRef,
} from "./realApi";

// ---------------------------------------------------------------------------
// Bringing a PLATFORM recording to the local runner.
//
// Runs always execute on this machine's worker, which downloads the script from
// the LOCAL bucket. A recording that only exists on the platform therefore has
// to be materialised here first. That is "staging": write the objects, but do
// NOT create the recorded_flows row -- adding something to your library stays an
// explicit Save.
//
// Shared by the Recordings page (one recording) and the Suites page (every
// member the suite needs), so both resolve keys and stage identically.
// ---------------------------------------------------------------------------

export interface PlatformKeys {
  script: string;
  workbook: string;
}

// name -> the storage keys a suite listing reported for that member.
export type KeyHints = Map<string, { file_path: string; data_file_path?: string }>;

// recorded-flow-list is the platform's own recorded_flows table, so field names
// vary by deployment; read the first key that is actually present.
export function pickStr(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

export function errText(err: unknown): string {
  if (!err) return "";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (typeof err === "object") {
    const e = err as { error?: unknown; data?: unknown; status?: unknown };
    if (typeof e.error === "string") return e.error;
    if (typeof e.data === "string") return e.data;
    if (e.data && typeof e.data === "object" && "detail" in e.data) {
      return String((e.data as { detail: unknown }).detail);
    }
    if (e.status !== undefined) return `HTTP ${String(e.status)}`;
  }
  return String(err);
}

// Build the hint map from suite listings — test-suite-list is the one endpoint
// that carries real storage keys (file_path / data_file_path).
export function keyHintsFromSuites(
  suites: { recorded_flows?: RecordedFlowRef[] }[] | undefined,
): KeyHints {
  const map: KeyHints = new Map();
  for (const suite of suites ?? []) {
    for (const flow of suite.recorded_flows ?? []) {
      if (flow.name && flow.file_path) {
        map.set(flow.name, { file_path: flow.file_path, data_file_path: flow.data_file_path });
      }
    }
  }
  return map;
}

// recorded-flow-list returns only {id, name, start_url}, so prefer a suite hint,
// then whatever the record itself carries, then the layout both sides agree on.
export function platformKeys(
  flow: PlatformRecording | undefined,
  name: string,
  hints: KeyHints,
): PlatformKeys {
  const row = (flow ?? {}) as Record<string, unknown>;
  const hint = hints.get(name);
  const script =
    hint?.file_path ||
    pickStr(row, ["file_path", "file_name", "py_key", "script_path", "file"]) ||
    `recordings/${name}/${name}.py`;
  return {
    script,
    // Derived from the script key rather than guessed separately: if the script
    // key resolved, its sibling is the best available guess for the workbook.
    workbook:
      hint?.data_file_path ||
      pickStr(row, ["data_file_path", "data_file_name", "params_key"]) ||
      script.replace(/\.py$/, "_params.xlsx"),
  };
}

export function usePlatformStaging() {
  const [downloadPlatformFile] = useDownloadPlatformFileMutation();
  const [downloadPlatformFileB64] = useDownloadPlatformFileB64Mutation();

  // Both files, or a loud error naming the key that could not be read. No
  // placeholder content, ever: an unreadable script or workbook must stop the
  // caller, not produce a plausible-looking empty one.
  const fetchPlatformFiles = useCallback(
    async (keys: PlatformKeys): Promise<{ script: string; workbookB64: string }> => {
      let script: string;
      try {
        script = await downloadPlatformFile({ path: keys.script }).unwrap();
      } catch (e) {
        throw new Error(`script not readable — ${keys.script}: ${errText(e)}`);
      }
      let workbookB64: string;
      try {
        workbookB64 = await downloadPlatformFileB64({ path: keys.workbook }).unwrap();
      } catch (e) {
        throw new Error(`data template not readable — ${keys.workbook}: ${errText(e)}`);
      }
      return { script, workbookB64 };
    },
    [downloadPlatformFile, downloadPlatformFileB64],
  );

  // Copy the platform's bytes into the local bucket. The workbook is stored
  // VERBATIM (params_b64) rather than rebuilt from parsed rows: the rebuild
  // injects a ref_id column, drops blank cells from the repeatable sheet, and
  // drops sheets the parser does not read. A copy runs here the way it runs
  // there, which is the whole point of staging.
  const stageForLocalRun = useCallback(
    async (name: string, keys: PlatformKeys): Promise<UploadResult> => {
      const { script, workbookB64 } = await fetchPlatformFiles(keys);
      return api.upload({
        name,
        script,
        params: { params: [] }, // unused: params_b64 supplies the workbook
        params_b64: workbookB64,
        overwrite: true,
        register: false,
      });
    },
    [fetchPlatformFiles],
  );

  return { fetchPlatformFiles, stageForLocalRun };
}
