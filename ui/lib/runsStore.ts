import { promises as fs } from "fs";
import path from "path";
import type { RunResult } from "./types";

// --------------------------------------------------------------------------
// Server-side store for ASYNC runs. A run is triggered by /studio-api/run,
// which backgrounds the (long, blocking) call to the shubham_agent backend and
// records progress here; the browser polls /studio-api/run/[id] instead of
// holding one long request open (which was timing out and showing a false
// "Internal Server Error" even though the run completed). One JSON file per run
// under localdb/runs/. Override the location with ACT_LOCALDB_DIR.
// --------------------------------------------------------------------------
const DIR = path.join(process.env.ACT_LOCALDB_DIR || path.join(process.cwd(), "localdb"), "runs");

export type RunStatus = "running" | "done" | "error";

export interface RunRecord {
  id: string;
  kind: "single" | "suite";
  // "done"  = the backend returned a RunResult (which may itself be pass OR fail)
  // "error" = the trigger/backend call itself failed (network / 5xx)
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  result?: RunResult;
  error?: string;
}

export async function writeRun(rec: RunRecord): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(path.join(DIR, `${rec.id}.json`), JSON.stringify(rec), "utf8");
}

export async function readRun(id: string): Promise<RunRecord | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(DIR, `${id}.json`), "utf8")) as RunRecord;
  } catch {
    return null; // missing/corrupt → treat as unknown
  }
}
