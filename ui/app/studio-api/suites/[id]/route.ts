import { NextResponse } from "next/server";
import { deleteSuite, getSuite, updateSuite } from "@/lib/suitesDb";

export const dynamic = "force-dynamic";

// Next 15+ passes route params as a Promise.
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const suite = await getSuite(id);
  if (!suite) return NextResponse.json({ detail: "not found" }, { status: 404 });
  return NextResponse.json(suite);
}

export async function PUT(req: Request, { params }: Ctx) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const updated = await updateSuite(id, {
    name: typeof body?.name === "string" ? body.name : undefined,
    // Same coercion the POST route applies: an unknown string must never reach
    // the runner's payload as an execution mode.
    execution_mode:
      body?.execution_mode === undefined
        ? undefined
        : body.execution_mode === "parallel"
          ? "parallel"
          : "sequential",
    members: Array.isArray(body?.members) ? body.members.map(String) : undefined,
    graph: body?.graph && typeof body.graph === "object" ? body.graph : undefined,
  });
  if (!updated) return NextResponse.json({ detail: "not found" }, { status: 404 });
  return NextResponse.json(updated);
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const ok = await deleteSuite(id);
  if (!ok) return NextResponse.json({ detail: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
