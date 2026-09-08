import { promises as fs } from "fs";
import path from "path";
import type { RunRecord, RunStatus } from "./types";

export type { RunRecord, RunStatus };

// --------------------------------------------------------------------------
// Server-side store for ASYNC runs. A run is triggered by /studio-api/run,
// which backgrounds the (long, blocking) call to the shubham_agent backend and
// records progress here; the browser polls /studio-api/run/[id] instead of
// holding one long request open (which was timing out and showing a false
// "Internal Server Error" even though the run completed). One JSON file per run
// under localdb/runs/. Override the location with ACT_LOCALDB_DIR.
//
// This is also the RUN HISTORY: `listRuns` is what lets the Runs page come back
// after a reload. The run tabs used to be React state only, so closing the tab
// dropped every reference to runs that were still executing server-side and to
// finished reports that were sitting right here on disk.
// --------------------------------------------------------------------------
const DIR = path.join(process.env.ACT_LOCALDB_DIR || path.join(process.cwd(), "localdb"), "runs");

// The id becomes a FILENAME, and it is now supplied by the browser (so the run
// tab and the record share one id). Anything but a uuid is refused rather than
// sanitized: "../../x" must never resolve to a path outside localdb/runs.
const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRunId(id: unknown): id is string {
  return typeof id === "string" && RUN_ID_RE.test(id);
}

function fileFor(id: string): string {
  return path.join(DIR, `${id}.json`);
}

export async function writeRun(rec: RunRecord): Promise<void> {
  if (!isRunId(rec.id)) throw new Error(`invalid run id: ${rec.id}`);
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(fileFor(rec.id), JSON.stringify(rec), "utf8");
}

export async function readRun(id: string): Promise<RunRecord | null> {
  if (!isRunId(id)) return null;
  try {
    return JSON.parse(await fs.readFile(fileFor(id), "utf8")) as RunRecord;
  } catch {
    return null; // missing/corrupt → treat as unknown
  }
}

export async function deleteRun(id: string): Promise<boolean> {
  if (!isRunId(id)) return false;
  try {
    await fs.unlink(fileFor(id));
    return true;
  } catch {
    return false;
  }
}

// Newest `limit` runs, returned OLDEST-FIRST so the caller can render them in
// the same left-to-right order live runs are appended in.
//
// The folder keeps one file per run forever, so this stats the directory and
// parses only the newest slice: stat is far cheaper than read+JSON.parse, and a
// few hundred old runs should not slow every page load.
export async function listRuns(limit = 40): Promise<RunRecord[]> {
  let names: string[];
  try {
    names = await fs.readdir(DIR);
  } catch {
    return []; // no runs yet
  }

  const stamped = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        try {
          return { name, at: (await fs.stat(path.join(DIR, name))).mtimeMs };
        } catch {
          return { name, at: 0 }; // vanished mid-listing; sorts last
        }
      }),
  );
  stamped.sort((a, b) => b.at - a.at);

  const rows = await Promise.all(
    stamped
      .slice(0, Math.max(1, limit))
      .map((entry) => readRun(entry.name.replace(/\.json$/, ""))),
  );
  return rows
    .filter((rec): rec is RunRecord => rec !== null)
    .sort((a, b) => a.startedAt - b.startedAt);
}
