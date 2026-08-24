# localdb — act_ui's file-based "DB"

No real database yet, so act_ui persists data as JSON files here. Each file is a
"table". Served by the Next.js route handlers under `app/studio-api/` (kept off
the `/api/*` prefix so the FastAPI proxy never intercepts them).

Tables:
- `suites.json` — saved Suite Designer suites: `{ id, name, execution_mode,
  members[], graph{nodes,edges}, created_at, updated_at }`. Upserted by name.
- `runs/*.json` — transient run records; git-ignored.

Override the location with `ACT_LOCALDB_DIR`. The `*.json` data files are
git-ignored (local runtime state); this folder + README are tracked.

The component **registry is not here, and not in this UI at all** — it lives in
the runner as the committed `act/components/component.json`, which act resolves
via a hardcoded path with no UI and no env involved. Edit that file directly.
