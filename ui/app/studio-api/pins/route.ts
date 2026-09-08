import { NextResponse } from "next/server";
import { listPins, setPin } from "@/lib/pinsDb";

// Local file-DB endpoints live under /studio-api (NOT /api) so they are never
// caught by the next.config proxy that forwards /api/* to the FastAPI backend.
// A sibling of /studio-api/suites rather than a child, so the suites route's
// dynamic [id] segment can never swallow it.
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ pins: await listPins() });
}

export async function PUT(req: Request) {
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ detail: "suite name is required" }, { status: 400 });
  }
  return NextResponse.json({ pins: await setPin(name, body?.pinned !== false) });
}
