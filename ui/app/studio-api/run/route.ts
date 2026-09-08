import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import http from "node:http";
import https from "node:https";
import { isRunId, listRuns, writeRun, type RunRecord } from "@/lib/runsStore";
import type { RunResult } from "@/lib/types";

// Local file-DB endpoint under /studio-api (NOT proxied to the backend).
export const dynamic = "force-dynamic";

const BACKEND = process.env.ACT_BACKEND_URL || "http://localhost:8765";

// POST JSON with NO response timeout. A browser run blocks the backend for
// MINUTES (it drives a real browser); undici's default ~5-min fetch timeout would
// abort it, so use node:http directly (no timeout set -> waits for the full
// response). This call is server-to-server; the browser polls instead of waiting.
function postJsonNoTimeout(urlStr: string, bodyObj: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const data = JSON.stringify(bodyObj);
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    request.on("error", reject);
    request.write(data);
    request.end();
  });
}

// Hold in-flight tasks so the runtime doesn't drop them after the response returns.
const inflight = new Set<Promise<unknown>>();

// The run history the Runs page rehydrates from after a reload.
export async function GET(req: Request) {
  const raw = Number(new URL(req.url).searchParams.get("limit"));
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 200) : undefined;
  return NextResponse.json({ runs: await listRuns(limit) });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const kind: RunRecord["kind"] = body?.kind === "suite" ? "suite" : "single";
  const payload = body?.payload ?? {};

  // The browser mints the id so its run TAB and this record are the same thing:
  // that shared id is what lets a reloaded page find a run it already started
  // (and keep polling one that is still executing). A caller that sends nothing
  // usable still gets a server id -- but only a real uuid is accepted, since the
  // id becomes a filename.
  const id = isRunId(body?.id) ? body.id : randomUUID();
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  const base: RunRecord = {
    id,
    kind,
    label: label || (kind === "suite" ? "Suite" : "Run"),
    status: "running",
    startedAt: Date.now(),
  };
  await writeRun(base);

  const endpoint = kind === "suite" ? "/api/run-suite" : "/api/run";
  const task = (async () => {
    try {
      const { status, text } = await postJsonNoTimeout(`${BACKEND}${endpoint}`, payload);
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      if (status < 200 || status >= 300) {
        const detail =
          parsed && typeof parsed === "object" && "detail" in parsed
            ? String((parsed as { detail: unknown }).detail)
            : `backend ${status}`;
        await writeRun({ ...base, status: "error", finishedAt: Date.now(), error: detail });
      } else {
        // A RunResult (pass OR fail) means the run COMPLETED — status "done".
        await writeRun({
          ...base,
          status: "done",
          finishedAt: Date.now(),
          result: parsed as RunResult,
        });
      }
    } catch (e) {
      await writeRun({
        ...base,
        status: "error",
        finishedAt: Date.now(),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  })();
  inflight.add(task);
  void task.finally(() => inflight.delete(task));

  return NextResponse.json({ runId: id });
}
