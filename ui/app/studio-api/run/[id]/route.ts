import { NextResponse } from "next/server";
import { deleteRun, readRun } from "@/lib/runsStore";

export const dynamic = "force-dynamic";

// Next 15+ passes route params as a Promise.
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const rec = await readRun(id);
  if (!rec) return NextResponse.json({ detail: "not found" }, { status: 404 });
  return NextResponse.json(rec);
}

// Closing a run tab drops the record too -- otherwise it would reappear on the
// next reload, which is not what an X on a tab means. The HTML report itself
// lives in the backend's downloads/ folder and is untouched.
export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  return NextResponse.json({ ok: await deleteRun(id) });
}
