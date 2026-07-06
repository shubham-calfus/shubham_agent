# agent_shubham

A tiny **local** replica of the ghostwriter ingest + run loop, with a web UI. It does **not**
own a worker/container — runs go through the agent you already run in your terminal.

What it does:
- **List** recordings stored in MinIO (`recordings/<name>/...`) and show whether each has a
  `recorded_flows` DB row.
- **Upload / Edit**: paste a `.py` script + a params JSON; Playwright recordings may use
  `{{placeholders}}`, while plain Python/API scripts can read runtime JSON directly with
  `from src.runtime.api_helpers import get_runtime_params`; it
  builds the sibling params workbook (`xlsx` default, `csv` optional), stores both in MinIO
  at `recordings/<name>/`, and **upserts the `recorded_flows` row** (same columns ghostwriter
  writes: `file_name`, `data_file_name`, `start_url`, `created_by/updated_by`).
- **Run**: shells out to your **local** aetherion CLI
  (`aetherion agent 'ACT Agent' '<payload>' --wait`) with `cwd = act_agent/`, so the job is
  picked up by the worker running in your terminal — not a packaged container. The HTML report
  is downloaded into `act_agent/downloads/`.

## Run it

```bash
cd act-v2
./agent_shubham/run
# or: act_agent/.venv/bin/python agent_shubham/app.py
```
Open http://localhost:8765 . Make sure your local `ACT Agent` worker is running in a
terminal so the **Run** button has something to execute the job.

## Config (auto-detected, env-overridable)

| setting | default | source |
|---|---|---|
| `STORAGE_ENDPOINT` | `http://localhost:9000` | `act_agent/.env` |
| `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` | — | `act_agent/.env` |
| bucket | `TENANT_ID` → `STORAGE_ACTIVITIES_BUCKET` → `local-dev-bucket` | the bucket your local agent reads |
| `POSTGRES_HOST/PORT/USER/PASSWORD/DB` | `localhost:5435 aetherion/aetherion/aetherion` | local `aetherion-postgresql` container |
| `USER_ID` | `4562a98e-809c-40e8-bc3c-6426bc5d47aa` | `created_by`/`updated_by` for new rows |
| `TEST_RUNNER_DIR` | `../act_agent` | where the agent + venv live |
| `PORT` | `8765` | web UI port |

Override any of these via environment variables before launching.

## Notes
- MinIO upload and the DB upsert are independent: if Postgres is unreachable the upload still
  succeeds and the UI shows the DB error, so you can fix creds and re-upload.
- `start_url` is extracted from `page.goto("...")`; if it's `{{url}}` it's resolved from the
  `url` param value.
- Params are a flat `{key: value}` set (one row). Playwright recordings rely on `{{placeholder}}`
  substitution; plain Python/script-step recordings read the same flat dict via
  `get_runtime_params()`. Flow context was removed from the runner — capture downstream values
  with `ai_extract()` (Playwright) or `api_helpers.extract()` (script step) instead.
