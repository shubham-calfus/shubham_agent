import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { Suite, SuiteInput } from "./types";

// --------------------------------------------------------------------------
// File-based "DB" for act_ui — no real database yet. The `suites` table is a
// single JSON file (an array of suites) under localdb/. Server-side only; used
// by the /studio-api/suites route handlers. Override the location with
// ACT_LOCALDB_DIR.
// --------------------------------------------------------------------------
const DIR = process.env.ACT_LOCALDB_DIR || path.join(process.cwd(), "localdb");
const FILE = path.join(DIR, "suites.json");

async function readAll(): Promise<Suite[]> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Suite[]) : [];
  } catch {
    return []; // missing/corrupt file → empty table
  }
}

async function writeAll(rows: Suite[]): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(rows, null, 2), "utf8");
}

export async function listSuites(): Promise<Suite[]> {
  const rows = await readAll();
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getSuite(id: string): Promise<Suite | null> {
  return (await readAll()).find((s) => s.id === id) ?? null;
}

// Save = upsert by NAME, so re-saving a suite with the same name overwrites it.
export async function saveSuite(input: SuiteInput): Promise<Suite> {
  const name = input.name.trim();
  const rows = await readAll();
  const now = new Date().toISOString();
  const existing = rows.find((s) => s.name.toLowerCase() === name.toLowerCase());
  const suite: Suite = {
    id: existing?.id ?? randomUUID(),
    name,
    execution_mode: input.execution_mode === "parallel" ? "parallel" : "sequential",
    members: Array.isArray(input.members) ? input.members : [],
    graph: input.graph,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  const next = existing ? rows.map((s) => (s.id === suite.id ? suite : s)) : [...rows, suite];
  await writeAll(next);
  return suite;
}

export async function updateSuite(id: string, patch: Partial<SuiteInput>): Promise<Suite | null> {
  const rows = await readAll();
  const idx = rows.findIndex((s) => s.id === id);
  if (idx < 0) return null;
  const current = rows[idx];
  const updated: Suite = {
    ...current,
    name: patch.name?.trim() || current.name,
    execution_mode: patch.execution_mode ?? current.execution_mode,
    members: patch.members ?? current.members,
    graph: patch.graph ?? current.graph,
    updated_at: new Date().toISOString(),
  };
  rows[idx] = updated;
  await writeAll(rows);
  return updated;
}

export async function deleteSuite(id: string): Promise<boolean> {
  const rows = await readAll();
  const next = rows.filter((s) => s.id !== id);
  if (next.length === rows.length) return false;
  await writeAll(next);
  return true;
}
