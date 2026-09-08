# localdb — act_ui's file-based "DB"

No real database yet, so act_ui persists data as JSON files here. Each file is a
"table". Served by the Next.js route handlers under `app/studio-api/` (kept off
the `/api/*` prefix so the FastAPI proxy never intercepts them).

Tables:
- `suites.json` — saved Suite Designer suites: `{ id, name, execution_mode,
  members[], graph{nodes,edges}, created_at, updated_at }`. Upserted by name.
- `pins.json` — pinned suite NAMES (a plain JSON array). Pinned suites are
  listed first on the Suites page. Keyed by name, not id, so one pin covers a
  suite whether it is listed from the local table or from a platform source
  (whose ids are positional and move). Written by `PUT /studio-api/pins`.
- `runs/*.json` — one record per run: `{ id, kind, label, status, startedAt,
  finishedAt, result, error }`. This is the RUN HISTORY, not scratch state: the
  Runs page restores its tabs from `GET /studio-api/run` on mount and resumes
  polling anything still `running`, so reloading the browser no longer abandons
  a live run or hides a finished report. The file name is the id and the id is
  minted by the browser, so it must be a uuid (`isRunId` refuses anything else).
  Closing a run tab DELETEs the record; the HTML report itself lives in the
  backend's `downloads/` folder and is unaffected.

Override the location with `ACT_LOCALDB_DIR`. The `*.json` data files are
git-ignored (local runtime state); this folder + README are tracked.

The component **registry is not here, and not in this UI at all** — it lives in
the runner as the committed `act/components/component.json`, which act resolves
via a hardcoded path with no UI and no env involved. Edit that file directly.
