# ACT Studio (`shubham_agent/ui`)

A Next.js front-end for the local **ACT Agent** stack — the interactive,
Aetherion/Calfus-branded alternative to the `app.py` single-file HTML UI. Moved
here from the standalone `act_ui` repo so the UI is tracked alongside the backend
it talks to.

It is a **pure frontend**. Every `/api/*` and `/downloads/*` request is proxied
(see [`next.config.ts`](next.config.ts)) to the `app.py` FastAPI backend one
directory up, which owns all the real work: MinIO, Postgres, and the local
`aetherion` CLI.
So the exact recording / params-workbook / DB / run contracts are reused, not
re-implemented.

```
ui (Next.js :3111)  ──/api/*──▶  shubham_agent/app.py :8765
                                        ├─ MinIO (recordings/…)
                                        ├─ Postgres (recorded_flows)
                                        └─ aetherion CLI ("ACT Agent")
```

## Run

Use the stack launcher one directory up — it starts the workers, the API backend
and this UI, and tears all of them down on Ctrl-C:

```bash
cd shubham_agent && ./run.sh      # backend :8765, Studio UI :3111
```

Then open http://localhost:3111 . Assumes your local MinIO (:9000) and
aetherion-postgresql (:5435) are already up.

Overrides:

```bash
UI=0 ./run.sh                     # skip this UI; app.py in the foreground
UI_PORT=3200 ./run.sh             # different UI port
PORT=8780 ./run.sh                # different backend port (the UI proxy follows it)
TEST_RUNNER_DIR=../other ./run.sh # point the workers at another runner checkout
```

To run just the UI against an already-running backend:

```bash
cd ui && ACT_BACKEND_URL=http://localhost:8765 npm run dev -- --port 3111
```

`app.py` keeps serving its own HTML UI on :8765 — that port is also where the ACT
Recorder browser extension uploads recordings, so it is not going away. This
Studio UI is an additional front end over the same API.

### Component registry

Not part of this UI. Reusable components are resolved by the runner from
`act/components/component.json` via a hardcoded path
(`src/runtime/registry.py`), with no UI and no env in the loop — so edit that
file directly.

## Features

- **Dashboard** — recording / DB-registration counts, environment summary, quick-run recent flows.
- **Recordings** — searchable library with DB badges; inspect script, parameters and line-items; run, edit, or add to a suite.
- **Author** — paste a Playwright / plain-Python script, edit flat-JSON params, set a prompt, mark repeatable blocks, preview the `params.xlsx`, and upload to MinIO + upsert `recorded_flows`.
- **Runs** — one tab per triggered run, live status, embedded HTML report, and stdout/stderr logs.
- **Suite builder** — add recordings to an ordered suite from the Recordings page
  (side panel), pick sequential/parallel, then run it. The drag-and-drop Suite
  Designer canvas was removed.
- **Settings** — the backend config reported by `/api/config`.

## Brand

Teal `#3FBFAD` accent, `DM Sans` + `Stack Sans Notch` display fonts (bundled in
[`public/fonts`](public/fonts)), the signature dot-grid texture, Framer Motion
entrance animations, and full light/dark support (toggle in the sidebar).

## Stack

Next.js (App Router) · TypeScript · Tailwind CSS v4 · Framer Motion ·
CodeMirror (`@uiw/react-codemirror`) · Redux Toolkit.
