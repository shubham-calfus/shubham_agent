import { promises as fs } from "fs";
import path from "path";

// --------------------------------------------------------------------------
// Pinned suites — the `pins` table of act_ui's file-DB (a single JSON array
// under localdb/, same shape as suites.json). Server-side only; used by the
// /studio-api/pins route handlers. Override the location with ACT_LOCALDB_DIR.
//
// Keyed by suite NAME, not id, because the Suites page lists TWO sources: local
// file-DB suites (a real uuid) and platform test suites (`String(suite.id ??
// index)` — an index for anything the platform lists without an id, which moves
// as soon as a suite is added upstream). The name is the identity a user
// recognises, is unique in the local table (saveSuite upserts by name), and
// lets one pin follow a suite whichever source it is listed from.
// --------------------------------------------------------------------------
const DIR = process.env.ACT_LOCALDB_DIR || path.join(process.cwd(), "localdb");
const FILE = path.join(DIR, "pins.json");

async function readAll(): Promise<string[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(FILE, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((name): name is string => typeof name === "string" && name.trim() !== "");
  } catch {
    return []; // missing/corrupt file → nothing pinned
  }
}

async function writeAll(names: string[]): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(names, null, 2), "utf8");
}

// Stored with the name as typed (so the file stays readable) but matched
// case-insensitively, the same way saveSuite compares suite names.
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

const sorted = (names: string[]) => [...names].sort((a, b) => a.localeCompare(b));

export async function listPins(): Promise<string[]> {
  return sorted(await readAll());
}

export async function setPin(name: string, pinned: boolean): Promise<string[]> {
  const trimmed = name.trim();
  const rows = await readAll();
  if (!trimmed) return sorted(rows);
  // Already in the wanted state (re-pinning a pinned suite) → return what is on
  // disk rather than writing, so the reply never reports a state that was not
  // stored.
  if (rows.some((row) => same(row, trimmed)) === pinned) return sorted(rows);
  const next = pinned ? [...rows, trimmed] : rows.filter((row) => !same(row, trimmed));
  await writeAll(next);
  return sorted(next);
}
