import { NextResponse } from "next/server";
import { readRun } from "@/lib/runsStore";

export const dynamic = "force-dynamic";

// Next 15+ passes route params as a Promise.
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const rec = await readRun(id);
  if (!rec) return NextResponse.json({ detail: "not found" }, { status: 404 });
  return NextResponse.json(rec);
}
