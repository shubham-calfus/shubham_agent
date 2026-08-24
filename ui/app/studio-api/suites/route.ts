import { NextResponse } from "next/server";
import { listSuites, saveSuite } from "@/lib/suitesDb";

// Local file-DB endpoints live under /studio-api (NOT /api) so they are never
// caught by the next.config proxy that forwards /api/* to the FastAPI backend.
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ suites: await listSuites() });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ detail: "suite name is required" }, { status: 400 });
  }
  const suite = await saveSuite({
    name,
    execution_mode: body.execution_mode === "parallel" ? "parallel" : "sequential",
    members: Array.isArray(body.members) ? body.members.map(String) : [],
    graph: body.graph && typeof body.graph === "object" ? body.graph : undefined,
  });
  return NextResponse.json(suite);
}
