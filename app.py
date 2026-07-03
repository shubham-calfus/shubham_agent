#!/usr/bin/env python3
"""agent_shubham — a tiny local replica of the ghostwriter ingest + run flow.

What it does (all against your LOCAL stack, no container worker of its own):
  * lists recordings stored in MinIO (recordings/<name>/...) and whether each has a
    recorded_flows DB row,
  * uploads a pasted Playwright .py + params JSON (a flat {key: value} param set): builds the sibling params workbook,
    stores both in MinIO, and upserts the recorded_flows row (same shape ghostwriter writes),
  * runs a recording by shelling out to your LOCAL aetherion CLI
    (`./.venv/bin/aetherion agent 'ACT Agent' '<payload>' --wait`), so the job is picked up
    by the agent/worker you run in your own terminal — not a packaged container.

Run it with the act_agent venv (which already has fastapi/uvicorn/boto3/openpyxl/psycopg2):
    cd act-v2 && act_agent/.venv/bin/python agent_shubham/app.py
then open http://localhost:8765
"""
from __future__ import annotations

import ast
import csv
import io
import json
import os
import re
import socket
import subprocess
from pathlib import Path
from typing import Any

import boto3
import psycopg2
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# --------------------------------------------------------------------------- paths / config
HERE = Path(__file__).resolve().parent
# The runner project dir (formerly "test_runner", renamed to "act_agent"); the env var keeps its
# legacy name so existing shell configs keep working. It holds the venv + aetherion CLI used below.
TEST_RUNNER_DIR = Path(os.environ.get("TEST_RUNNER_DIR", HERE.parent / "act_agent")).resolve()
AETHERION_BIN = os.environ.get("AETHERION_BIN", str(TEST_RUNNER_DIR / ".venv" / "bin" / "aetherion"))
DOWNLOADS_DIR = TEST_RUNNER_DIR / "downloads"


def _load_dotenv(path: Path) -> dict[str, str]:
    cfg: dict[str, str] = {}
    if path.is_file():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                cfg[k.strip()] = v.strip().strip('"').strip("'")
    return cfg


_ENV = _load_dotenv(TEST_RUNNER_DIR / ".env")


def _cfg(key: str, default: str = "") -> str:
    return (os.environ.get(key) or _ENV.get(key) or default).strip()


DEFAULT_AFTER_ACTION_WAIT_MS = int(_cfg("DEFAULT_AFTER_ACTION_WAIT_MS", "0") or "0")
DEFAULT_MULTI_LINE_SHEET_NAME = "multi_line"


STORAGE_ENDPOINT = _cfg("STORAGE_ENDPOINT", "http://localhost:9000")
STORAGE_ACCESS_KEY = _cfg("STORAGE_ACCESS_KEY")
STORAGE_SECRET_KEY = _cfg("STORAGE_SECRET_KEY")
# The bucket the LOCAL agent reads: TENANT_ID wins, else STORAGE_ACTIVITIES_BUCKET.
BUCKET = _cfg("TENANT_ID") or _cfg("STORAGE_ACTIVITIES_BUCKET") or "local-dev-bucket"

PG = dict(
    host=_cfg("POSTGRES_HOST", "localhost"),
    port=int(_cfg("POSTGRES_PORT", "5435")),  # aetherion-postgresql is published on host :5435
    user=_cfg("POSTGRES_USER", "aetherion"),
    password=_cfg("POSTGRES_PASSWORD", "aetherion"),
    dbname=_cfg("POSTGRES_DB", "aetherion"),
)
DEFAULT_USER_ID = _cfg("USER_ID", "4562a98e-809c-40e8-bc3c-6426bc5d47aa")


def _s3():
    return boto3.client(
        "s3",
        endpoint_url=STORAGE_ENDPOINT,
        aws_access_key_id=STORAGE_ACCESS_KEY,
        aws_secret_access_key=STORAGE_SECRET_KEY,
        region_name="us-east-1",
    )


def _pg():
    return psycopg2.connect(connect_timeout=4, **PG)


# --------------------------------------------------------------------------- params helpers
def _cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (list, tuple)):
        return "|".join(_cell(v) for v in value)
    return str(value)


def _coerce_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off", ""}:
            return False
    return bool(value)


_KNOWN_MULTI_LINE_KEYS = {
    "line_description": "description",
    "description": "description",
    "item": "item",
    "memo_line": "memo_line",
    "uom": "uom",
    "quantity": "quantity",
    "unit_price": "unit_price",
    "amount": "amount",
    "tax_classification": "tax_classification",
    "transaction_business_category": "transaction_business_category",
    "rule": "rule",
    "type": "type",
    "revenue_period": "revenue_period",
}


# Sheet/wrapper names that must never become parameter keys. "Flow Context" is the
# now-removed flow-context spec sheet; the runner dropped flow context entirely (use
# ai_extract() instead), so any such entry is discarded rather than shipped as a param.
_NON_PARAM_KEYS = {
    "flow context", "flow_context", "flowcontext", "flow io", "flow_io",
    "context io", "context_io", "input output", "input_output", "output_input",
}


def _is_non_param_key(key: Any) -> bool:
    return str(key or "").strip().lower() in _NON_PARAM_KEYS


def _maybe_dict(value: Any) -> dict | None:
    """Return a dict if value is one, or a string repr of one (Python literal or JSON)."""
    if isinstance(value, dict):
        return value
    text = str(value or "").strip()
    if not (text.startswith("{") and text.endswith("}")):
        return None
    for parse in (ast.literal_eval, json.loads):
        try:
            parsed = parse(text)
        except (ValueError, SyntaxError, TypeError):
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def _flatten_param_set(row: dict[str, Any]) -> dict[str, str]:
    """Normalise one parameter set to a flat {key: value} dict.

    Repairs the corruption where a whole row was nested under a sheet-name key with the
    real params stringified as a Python/JSON dict (e.g. {"Sheet1": "{'app_url': ...}",
    "Flow Context": "{...}"}). Such a wrapper made `{{placeholders}}` unresolvable and the
    run fail. We unwrap any dict-valued cell into its own keys and drop flow-context keys.
    """
    flat: dict[str, str] = {}
    for key, value in row.items():
        if _is_non_param_key(key):
            continue
        nested = _maybe_dict(value)
        if nested is not None:
            for nested_key, nested_value in nested.items():
                if _is_non_param_key(nested_key):
                    continue
                flat[str(nested_key)] = _cell(nested_value)
        else:
            flat[str(key)] = _cell(value)
    return flat


def normalize_param_sets(payload: Any, *, allow_empty: bool = False) -> list[dict[str, str]]:
    if isinstance(payload, dict) and "params" in payload:
        raw = payload.get("params") or []
    elif isinstance(payload, list):
        raw = payload
    elif isinstance(payload, dict):
        raw = [payload]
    else:
        raise ValueError("params must be a dict, list of dicts, or {'params': [...]}")
    out = [_flatten_param_set(entry) for entry in raw if isinstance(entry, dict)]
    out = [row for row in out if row]
    if not out:
        if allow_empty:
            # A recording uploaded straight from the recorder may legitimately have no
            # params/{{placeholders}}; ship a single empty set instead of rejecting it.
            return [{}]
        raise ValueError("no parameter sets found")
    return out


def _normalize_multi_line_rows(payload: Any) -> list[dict[str, str]]:
    if payload is None:
        return []
    if isinstance(payload, dict) and DEFAULT_MULTI_LINE_SHEET_NAME in payload:
        raw = payload.get(DEFAULT_MULTI_LINE_SHEET_NAME) or []
    elif isinstance(payload, list):
        raw = payload
    else:
        return []
    rows = [_flatten_param_set(entry) for entry in raw if isinstance(entry, dict)]
    return [row for row in rows if row]


def _payload_explicitly_sets_multi_line(payload: Any) -> bool:
    return isinstance(payload, dict) and DEFAULT_MULTI_LINE_SHEET_NAME in payload


def _normalize_field_key(value: Any) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "_", str(value or "").strip()).strip("_").lower()


def _normalize_match_key(value: Any) -> str:
    return _normalize_field_key(value)


def _extract_row_value_by_key(row: dict[str, Any], match_key: str) -> str:
    normalized_match_key = _normalize_match_key(match_key)
    if not normalized_match_key or not isinstance(row, dict):
        return ""
    for key, value in row.items():
        if _normalize_field_key(key) != normalized_match_key:
            continue
        return str(value or "").strip()
    return ""


def _payload_without_multi_line(payload: Any) -> Any:
    if not isinstance(payload, dict) or DEFAULT_MULTI_LINE_SHEET_NAME not in payload:
        return payload
    cleaned = dict(payload)
    cleaned.pop(DEFAULT_MULTI_LINE_SHEET_NAME, None)
    return cleaned


def _normalize_repeatable_block_config(payload: Any) -> dict[str, Any] | None:
    if payload is None:
        return None
    if isinstance(payload, str):
        text = payload.strip()
        if not text:
            return None
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            payload = {"enabled": True, "sheet_name": DEFAULT_MULTI_LINE_SHEET_NAME, "prompt": text}
    if not isinstance(payload, dict):
        return None
    if not _coerce_bool(payload.get("enabled", True), default=True):
        return None
    sheet_name = _safe_name(str(payload.get("sheet_name") or DEFAULT_MULTI_LINE_SHEET_NAME)) or DEFAULT_MULTI_LINE_SHEET_NAME
    prompt = str(payload.get("prompt") or "").strip()
    match_key = _normalize_match_key(payload.get("match_key"))
    return {
        "enabled": True,
        "sheet_name": sheet_name,
        "prompt": prompt,
        "match_key": match_key,
    }


def _normalize_repeatable_blocks_config(
    payload: Any = None,
    *,
    legacy_payload: Any = None,
) -> list[dict[str, Any]]:
    raw = payload if payload is not None else legacy_payload
    if raw is None:
        return []
    if isinstance(raw, dict):
        if "repeatable_blocks" in raw:
            raw = raw.get("repeatable_blocks")
        else:
            raw = [raw]
    elif isinstance(raw, str):
        text = raw.strip()
        if not text:
            return []
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            raw = [text]
        else:
            raw = parsed.get("repeatable_blocks") if isinstance(parsed, dict) and "repeatable_blocks" in parsed else parsed
    if not isinstance(raw, list):
        return []
    blocks: list[dict[str, Any]] = []
    for item in raw:
        normalized = _normalize_repeatable_block_config(item)
        if normalized:
            blocks.append(normalized)
    return blocks


def _repeatable_blocks_from_recording_config(recording_config: Any) -> list[dict[str, Any]]:
    config = recording_config if isinstance(recording_config, dict) else {}
    blocks = _normalize_repeatable_blocks_config(config.get("repeatable_blocks"))
    if blocks:
        return blocks
    return _normalize_repeatable_blocks_config(legacy_payload=config.get("repeatable_line_items"))


def _resolve_upload_multi_line_rows(
    *,
    payload: Any,
    param_sets: list[dict[str, str]],
    repeatable_blocks: list[dict[str, Any]] | None,
    recording_name: str,
    bucket: str,
    overwrite: bool,
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    multi_line_rows = _normalize_multi_line_rows(payload)
    if not repeatable_blocks:
        return param_sets, multi_line_rows

    explicit_multi_line = _payload_explicitly_sets_multi_line(payload)
    if not multi_line_rows:
        param_sets, inferred_multi_line_rows = _infer_multi_line_rows_from_param_sets(param_sets)
        multi_line_rows = inferred_multi_line_rows

    # If the user overwrites an existing repeatable-line recording from the editor
    # and the payload omitted the multi_line block, preserve the saved sheet instead
    # of silently rewriting the workbook with only the params sheet.
    if not multi_line_rows and overwrite and not explicit_multi_line:
        try:
            _existing_params, existing_multi_line_rows, _existing_key = _load_saved_runtime_payload(recording_name, bucket)
        except Exception:
            existing_multi_line_rows = []
        if existing_multi_line_rows:
            multi_line_rows = existing_multi_line_rows

    return param_sets, multi_line_rows


def _infer_multi_line_rows_from_param_sets(param_sets: list[dict[str, str]]) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    header_rows: list[dict[str, str]] = []
    multi_line_rows: list[dict[str, str]] = []
    for row in param_sets:
        header_row: dict[str, str] = {}
        line_row: dict[str, str] = {}
        for key, value in row.items():
            normalized_key = str(key or "").strip()
            mapped = _KNOWN_MULTI_LINE_KEYS.get(normalized_key)
            if mapped:
                line_row[mapped] = value
            else:
                header_row[normalized_key] = value
        header_rows.append(header_row)
        if line_row:
            multi_line_rows.append(line_row)
    return header_rows, multi_line_rows


def _headers(rows: list[dict[str, str]]) -> list[str]:
    seen, order = set(), []
    for row in rows:
        for k in row:
            if k not in seen:
                seen.add(k)
                order.append(k)
    return order


def build_params_csv(param_sets: list[dict[str, str]]) -> bytes:
    headers = _headers(param_sets)
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(headers)
    for row in param_sets:
        w.writerow([row.get(h, "") for h in headers])
    return buf.getvalue().encode("utf-8")


def build_params_xlsx(
    param_sets: list[dict[str, str]],
    *,
    multi_line_rows: list[dict[str, str]] | None = None,
    multi_line_sheet_name: str = DEFAULT_MULTI_LINE_SHEET_NAME,
) -> bytes:
    import openpyxl

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "params"
    ph = _headers(param_sets)
    ws.append(ph)
    for row in param_sets:
        ws.append([row.get(h, "") for h in ph])
    if multi_line_rows is not None:
        sheet = wb.create_sheet(title=_safe_name(multi_line_sheet_name) or DEFAULT_MULTI_LINE_SHEET_NAME)
        mh = _headers(multi_line_rows)
        if mh:
            sheet.append(mh)
            for row in multi_line_rows:
                sheet.append([row.get(h, "") for h in mh])
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


def _safe_name(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", (name or "").strip()).strip("._")


def _start_url(script: str, first_params: dict[str, str]) -> str:
    m = re.search(r"page\.goto\(\s*[\"']([^\"']+)[\"']", script)
    if not m:
        return ""
    url = m.group(1)
    ph = re.match(r"^\{\{\s*([\w.-]+)\s*\}\}$", url.strip())
    if ph:
        return first_params.get(ph.group(1), url)
    return url


def _placeholders(script: str) -> list[str]:
    return sorted(set(re.findall(r"\{\{\s*([\w.-]+)\s*\}\}", script)))


def _recording_config_key(name: str) -> str:
    return f"recordings/{name}/{name}_recording_config.json"


def _build_recording_config(
    name: str,
    *,
    prompt: str = "",
    repeatable_blocks: list[dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    normalized_prompt = str(prompt or "").strip()
    normalized_repeatable_blocks = [dict(block) for block in (repeatable_blocks or []) if isinstance(block, dict)]
    if not normalized_prompt and not normalized_repeatable_blocks:
        return None
    config: dict[str, Any] = {
        "version": 1,
        "recording_name": name,
    }
    if normalized_prompt:
        config["prompt"] = normalized_prompt
    if normalized_repeatable_blocks:
        config["repeatable_blocks"] = normalized_repeatable_blocks
    return config


# --------------------------------------------------------------------------- DB ops
def db_rows_by_name(names: list[str]) -> dict[str, dict[str, Any]]:
    if not names:
        return {}
    try:
        with _pg() as cn, cn.cursor() as cur:
            cur.execute(
                "SELECT name, id, file_name, data_file_name, start_url FROM recorded_flows WHERE name = ANY(%s)",
                (names,),
            )
            return {
                r[0]: {"id": str(r[1]), "file_name": r[2], "data_file_name": r[3], "start_url": r[4]}
                for r in cur.fetchall()
            }
    except Exception:
        return {}


def upsert_recorded_flow(*, name, file_name, data_file_name, start_url, user_id, overwrite) -> dict[str, Any]:
    if overwrite:
        sql = """
            INSERT INTO recorded_flows (id, name, file_name, data_file_name, start_url, created_by, updated_by)
            VALUES (gen_random_uuid(), %(name)s, %(file_name)s, %(data_file_name)s, %(start_url)s, %(uid)s, %(uid)s)
            ON CONFLICT (name) DO UPDATE SET
                file_name = EXCLUDED.file_name,
                data_file_name = EXCLUDED.data_file_name,
                start_url = EXCLUDED.start_url,
                updated_by = EXCLUDED.updated_by
            RETURNING id, (xmax = 0) AS inserted;
        """
    else:
        sql = """
            INSERT INTO recorded_flows (id, name, file_name, data_file_name, start_url, created_by, updated_by)
            VALUES (gen_random_uuid(), %(name)s, %(file_name)s, %(data_file_name)s, %(start_url)s, %(uid)s, %(uid)s)
            ON CONFLICT (name) DO NOTHING
            RETURNING id, true AS inserted;
        """
    params = dict(name=name, file_name=file_name, data_file_name=data_file_name, start_url=start_url, uid=user_id)
    with _pg() as cn, cn.cursor() as cur:
        cur.execute(sql, params)
        row = cur.fetchone()
        cn.commit()
    if row is None:
        return {"id": None, "inserted": False, "conflict": True}
    return {"id": str(row[0]), "inserted": bool(row[1]), "conflict": False}


# --------------------------------------------------------------------------- app
app = FastAPI(title="agent_shubham")
app.mount("/downloads", StaticFiles(directory=str(DOWNLOADS_DIR), check_dir=False), name="downloads")


@app.get("/api/scripts")
def list_scripts(bucket: str = ""):
    bkt = bucket or BUCKET
    s3 = _s3()
    paginator = s3.get_paginator("list_objects_v2")
    folders = []
    for page in paginator.paginate(Bucket=bkt, Prefix="recordings/", Delimiter="/"):
        folders.extend(p["Prefix"] for p in page.get("CommonPrefixes", []))
    items = []
    for folder in folders:
        name = folder[len("recordings/"):].rstrip("/")
        if not name:
            continue
        keys = {o["Key"] for o in s3.list_objects_v2(Bucket=bkt, Prefix=folder).get("Contents", [])}
        # Only count folders that follow the runner's convention: recordings/<name>/<name>.py
        canonical_py = f"{folder}{name}.py"
        if canonical_py not in keys:
            continue
        params = next((f"{folder}{name}{ext}" for ext in ("_params.xlsx", "_params.csv") if f"{folder}{name}{ext}" in keys), "")
        items.append({"name": name, "py_key": canonical_py, "params_key": params})
    db = db_rows_by_name([i["name"] for i in items])
    for i in items:
        i["has_db"] = i["name"] in db
    items.sort(key=lambda x: x["name"].lower())
    return {"bucket": bkt, "scripts": items}


@app.get("/api/script")
def get_script(name: str, bucket: str = ""):
    bkt = bucket or BUCKET
    s3 = _s3()
    safe = _safe_name(name)
    py_key = f"recordings/{safe}/{safe}.py"
    try:
        py_text = s3.get_object(Bucket=bkt, Key=py_key)["Body"].read().decode("utf-8", "replace")
    except Exception as exc:
        raise HTTPException(404, f"script not found: {py_key} ({exc})")
    params_rows, multi_line_rows, params_key = _load_saved_runtime_payload(safe, bkt)
    recording_config = _load_recording_config(safe, bkt)
    db = db_rows_by_name([safe]).get(safe)
    return {"name": safe, "py_key": py_key, "py_text": py_text, "params_key": params_key,
            "params": params_rows, "placeholders": _placeholders(py_text), "db": db,
            "recording_config": recording_config, "multi_line": multi_line_rows}


def _parse_params_back(raw: bytes, ext: str) -> list[dict[str, str]]:
    if ext.endswith(".csv"):
        rows = list(csv.reader(io.StringIO(raw.decode("utf-8", "replace"))))
    else:
        import openpyxl

        wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
        ws = wb["params"] if "params" in wb.sheetnames else wb.active
        rows = [[("" if c is None else str(c)) for c in r] for r in ws.iter_rows(values_only=True)]
        wb.close()
    rows = [r for r in rows if any(str(c).strip() for c in r)]
    if len(rows) < 2:
        return []
    headers = [str(h).strip() for h in rows[0]]
    raw_sets = [{headers[i]: (r[i] if i < len(r) else "") for i in range(len(headers))} for r in rows[1:]]
    # Flatten so a corrupt workbook (sheet-name headers + stringified-dict cells) reads
    # back as flat params instead of being re-shipped to the agent as {Sheet1: "...", ...}.
    return [row for row in (_flatten_param_set(s) for s in raw_sets) if row]


def _parse_multi_line_back(
    raw: bytes,
    *,
    sheet_name: str = DEFAULT_MULTI_LINE_SHEET_NAME,
) -> list[dict[str, str]]:
    import openpyxl

    wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    target = None
    for candidate in wb.sheetnames:
        if _safe_name(candidate) == _safe_name(sheet_name):
            target = wb[candidate]
            break
    if target is None:
        wb.close()
        return []
    rows = [[("" if c is None else str(c)) for c in r] for r in target.iter_rows(values_only=True)]
    wb.close()
    rows = [r for r in rows if any(str(c).strip() for c in r)]
    if len(rows) < 2:
        return []
    headers = [_safe_name(str(h).strip()) for h in rows[0]]
    parsed: list[dict[str, str]] = []
    for row in rows[1:]:
        values = {
            headers[i]: row[i]
            for i in range(min(len(headers), len(row)))
            if headers[i] and str(row[i] or "").strip()
        }
        if values:
            parsed.append(values)
    return parsed


def _load_saved_runtime_payload(name: str, bucket: str) -> tuple[list[dict[str, str]], list[dict[str, str]], str]:
    s3 = _s3()
    safe = _safe_name(name)
    params_rows: list[dict[str, str]] = []
    multi_line_rows: list[dict[str, str]] = []
    params_key = ""
    recording_config = _load_recording_config(safe, bucket)
    repeatable_blocks = _repeatable_blocks_from_recording_config(recording_config)
    repeatable = repeatable_blocks[0] if repeatable_blocks else None
    multi_line_sheet_name = (
        _safe_name(str(repeatable.get("sheet_name") or DEFAULT_MULTI_LINE_SHEET_NAME))
        if isinstance(repeatable, dict)
        else DEFAULT_MULTI_LINE_SHEET_NAME
    ) or DEFAULT_MULTI_LINE_SHEET_NAME
    for ext in ("_params.xlsx", "_params.csv"):
        key = f"recordings/{safe}/{safe}{ext}"
        try:
            raw = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
            params_key = key
            params_rows = _parse_params_back(raw, ext)
            if ext.endswith(".xlsx"):
                multi_line_rows = _parse_multi_line_back(raw, sheet_name=multi_line_sheet_name)
            break
        except Exception:
            continue
    return params_rows, multi_line_rows, params_key


def _load_recording_config(name: str, bucket: str) -> dict[str, Any]:
    s3 = _s3()
    safe = _safe_name(name)
    config_key = _recording_config_key(safe)
    try:
        raw = s3.get_object(Bucket=bucket, Key=config_key)["Body"].read()
    except Exception:
        return {}
    try:
        data = json.loads(raw.decode("utf-8", "replace"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


class UploadBody(BaseModel):
    name: str = ""
    script: str
    params: Any  # dict | list | {"params":[...],"context":[...]} | JSON string
    fmt: str = "xlsx"
    overwrite: bool = True
    user_id: str = ""
    bucket: str = ""
    prompt: str = ""
    instance: str = ""
    repeatable_blocks: Any = None


def _resolve_upload_name(raw_name: str, payload: Any) -> str:
    direct = _safe_name(raw_name)
    if direct:
        return direct

    candidates: list[str] = []
    if isinstance(payload, dict):
        for key in ("name", "recording_name", "script_name", "test_suite_id"):
            value = str(payload.get(key) or "").strip()
            if value:
                candidates.append(value)
        raw_params = payload.get("params")
        if isinstance(raw_params, list) and raw_params and isinstance(raw_params[0], dict):
            for key in ("name", "recording_name", "script_name", "test_suite_id"):
                value = str(raw_params[0].get(key) or "").strip()
                if value:
                    candidates.append(value)

    for candidate in candidates:
        safe = _safe_name(candidate)
        if safe:
            return safe
    return ""


@app.post("/api/upload")
def upload(body: UploadBody):
    bkt = body.bucket or BUCKET
    payload = json.loads(body.params) if isinstance(body.params, str) else body.params
    name = _resolve_upload_name(body.name, payload)
    if not name:
        raise HTTPException(
            400,
            "recording name is required. Send 'name' in the request body, or include one of "
            "'recording_name', 'script_name', or 'test_suite_id' in the payload.",
        )
    try:
        param_sets = normalize_param_sets(payload, allow_empty=True)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    repeatable_blocks = _normalize_repeatable_blocks_config(body.repeatable_blocks)
    param_sets, multi_line_rows = _resolve_upload_multi_line_rows(
        payload=payload,
        param_sets=param_sets,
        repeatable_blocks=repeatable_blocks,
        recording_name=name,
        bucket=bkt,
        overwrite=body.overwrite,
    )

    fmt = body.fmt if body.fmt in ("xlsx", "csv") else "xlsx"
    if fmt == "csv" and repeatable_blocks:
        raise HTTPException(400, "repeatable blocks require xlsx because csv cannot store a dedicated repeatable sheet.")
    if fmt == "xlsx":
        primary_block = repeatable_blocks[0] if repeatable_blocks else None
        multi_line_sheet_name = (
            str(primary_block.get("sheet_name") or DEFAULT_MULTI_LINE_SHEET_NAME)
            if isinstance(primary_block, dict)
            else DEFAULT_MULTI_LINE_SHEET_NAME
        )
        params_bytes, ext, ct = build_params_xlsx(
            param_sets,
            multi_line_rows=multi_line_rows if repeatable_blocks else None,
            multi_line_sheet_name=multi_line_sheet_name,
        ), "_params.xlsx", \
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    else:
        params_bytes, ext, ct = build_params_csv(param_sets), "_params.csv", "text/csv"

    py_bytes = body.script.encode("utf-8")
    py_key = f"recordings/{name}/{name}.py"
    params_key = f"recordings/{name}/{name}{ext}"
    start_url = _start_url(body.script, param_sets[0])
    missing = [p for p in _placeholders(body.script) if p not in param_sets[0]]
    recording_config = _build_recording_config(
        name,
        prompt=body.prompt,
        repeatable_blocks=repeatable_blocks,
    )
    recording_config_key = _recording_config_key(name) if recording_config else ""

    s3 = _s3()
    s3.put_object(Bucket=bkt, Key=py_key, Body=py_bytes, ContentType="text/x-python")
    s3.put_object(Bucket=bkt, Key=params_key, Body=params_bytes, ContentType=ct)
    if recording_config:
        s3.put_object(
            Bucket=bkt,
            Key=recording_config_key,
            Body=json.dumps(recording_config, indent=2, sort_keys=True).encode("utf-8"),
            ContentType="application/json",
        )

    db_error = ""
    db_result: dict[str, Any] = {}
    try:
        db_result = upsert_recorded_flow(
            name=name, file_name=py_key, data_file_name=params_key,
            start_url=start_url, user_id=(body.user_id or DEFAULT_USER_ID), overwrite=body.overwrite,
        )
    except Exception as exc:  # MinIO already succeeded; surface DB issue without failing upload
        db_error = f"{type(exc).__name__}: {exc}"

    return {
        "ok": True, "bucket": bkt, "name": name, "py_key": py_key, "params_key": params_key,
        "start_url": start_url, "param_rows": len(param_sets), "missing_placeholders": missing,
        "multi_line_row_count": len(multi_line_rows),
        "recording_config_key": recording_config_key, "recording_config": recording_config,
        "db": db_result, "db_error": db_error,
        "run_cmd": _run_cmd(name, py_key, after_action_wait_ms=DEFAULT_AFTER_ACTION_WAIT_MS),
    }


def _run_payload(
    name: str,
    py_key: str,
    *,
    execution_mode: str = "parallel",
    after_action_wait_ms: int = DEFAULT_AFTER_ACTION_WAIT_MS,
) -> dict[str, Any]:
    payload = {
        "test_suite_id": name,
        "recordings": [
            {
                "id": name,
                "name": name,
                "file": py_key,
                "after_action_wait_ms": after_action_wait_ms,
            }
        ],
        "execution_mode": execution_mode,
    }
    return payload


def _run_cmd(
    name: str,
    py_key: str,
    execution_mode: str = "parallel",
    *,
    after_action_wait_ms: int = DEFAULT_AFTER_ACTION_WAIT_MS,
) -> str:
    payload = _run_payload(
        name,
        py_key,
        execution_mode=execution_mode,
        after_action_wait_ms=after_action_wait_ms,
    )
    return f"{AETHERION_BIN} agent 'ACT Agent' '{json.dumps(payload, separators=(',', ':'))}'"


class RunBody(BaseModel):
    name: str
    parameters: Any = {}
    execution_mode: str = "parallel"
    after_action_wait_ms: int | None = DEFAULT_AFTER_ACTION_WAIT_MS
    task_queue: str = ""
    download_report: bool = True


class SuiteRecording(BaseModel):
    name: str
    parameters: Any = None  # optional per-recording inline params; else saved workbook is used


class SuiteRunBody(BaseModel):
    recordings: list[SuiteRecording]
    suite_id: str = ""
    # Suites default to sequential so flow-context chaining (one recording's
    # extract/ai_extract feeding the next) actually works.
    execution_mode: str = "sequential"
    after_action_wait_ms: int | None = DEFAULT_AFTER_ACTION_WAIT_MS
    task_queue: str = ""
    download_report: bool = True


def _extract_agent_result(stdout: str) -> Any:
    for chunk in re.findall(r"\{.*\}|\[.*\]", stdout, re.DOTALL):
        try:
            return json.loads(chunk)
        except Exception:
            continue
    return None


def _find_report_key(result: Any) -> str:
    items = result if isinstance(result, list) else (result.get("result") or result.get("outputs") or [] if isinstance(result, dict) else [])
    if isinstance(result, dict) and not items:
        items = [result]
    for item in items if isinstance(items, list) else []:
        if isinstance(item, dict) and str(item.get("type") or "") == "s3_download_link":
            if item.get("file_key"):
                return str(item["file_key"])
    return ""


def _report_url_for_dest(dest: Path) -> str:
    return f"/downloads/{dest.name}"


def _build_recording_entry(
    name: str,
    *,
    parameters: Any = None,
    after_action_wait_ms: int,
    bucket: str,
) -> dict[str, Any]:
    """Build one `recordings[]` entry for the agent payload.

    Inline `parameters` win; otherwise the recording's saved workbook is loaded
    and shipped explicitly so the worker does not re-parse it remotely. Shared by
    the single-run and suite-run endpoints so both resolve params identically.
    """
    safe = _safe_name(name)
    py_key = f"recordings/{safe}/{safe}.py"
    rec: dict[str, Any] = {"id": safe, "name": safe, "file": py_key}
    if parameters:
        inline_multi_line_rows = _normalize_multi_line_rows(parameters)
        inline_parameter_payload = _payload_without_multi_line(parameters)
        try:
            rec["parameters"] = normalize_param_sets(inline_parameter_payload)[0]
        except ValueError as exc:
            raise HTTPException(400, f"{safe}: {exc}")
        if inline_multi_line_rows:
            rec[DEFAULT_MULTI_LINE_SHEET_NAME] = inline_multi_line_rows
        rec["skip_parameters_file_load"] = True
    else:
        params_rows, multi_line_rows, _params_key = _load_saved_runtime_payload(safe, bucket)
        if params_rows or multi_line_rows:
            rec["parameters"] = dict(params_rows[0]) if params_rows else {}
            if multi_line_rows:
                rec[DEFAULT_MULTI_LINE_SHEET_NAME] = list(multi_line_rows)
            rec["skip_parameters_file_load"] = True
    rec["after_action_wait_ms"] = after_action_wait_ms
    return rec


def _build_recording_entries(
    name: str,
    *,
    parameters: Any = None,
    after_action_wait_ms: int,
    bucket: str,
) -> list[dict[str, Any]]:
    safe = _safe_name(name)
    py_key = f"recordings/{safe}/{safe}.py"
    recording_config = _load_recording_config(safe, bucket)
    repeatable_blocks = _repeatable_blocks_from_recording_config(recording_config)
    repeatable = repeatable_blocks[0] if repeatable_blocks else None

    if parameters:
        inline_multi_line_rows = _normalize_multi_line_rows(parameters)
        inline_parameter_payload = _payload_without_multi_line(parameters)
        try:
            params_rows = normalize_param_sets(inline_parameter_payload, allow_empty=True)
        except ValueError as exc:
            raise HTTPException(400, f"{safe}: {exc}")
        multi_line_rows = inline_multi_line_rows
        params_key = ""
    else:
        params_rows, multi_line_rows, params_key = _load_saved_runtime_payload(safe, bucket)

    if not params_rows:
        params_rows = [{}]

    prepared_rows: list[dict[str, Any]] = []
    if len(params_rows) == 1:
        prepared_rows.append(
            {
                "parameters": dict(params_rows[0]),
                DEFAULT_MULTI_LINE_SHEET_NAME: list(multi_line_rows),
                "parameter_row_index": 1,
                "parameter_set_index": 1,
            }
        )
    elif not multi_line_rows:
        for index, header_row in enumerate(params_rows, start=1):
            prepared_rows.append(
                {
                    "parameters": dict(header_row),
                    DEFAULT_MULTI_LINE_SHEET_NAME: [],
                    "parameter_row_index": index,
                    "parameter_set_index": index,
                }
            )
    else:
        match_key = _normalize_match_key((repeatable or {}).get("match_key"))
        if not match_key:
            raise HTTPException(
                400,
                f"{safe}: multiple header rows with repeatable blocks require repeatable_blocks[0].match_key.",
            )

        grouped_lines: dict[str, list[dict[str, str]]] = {}
        for line_index, line_row in enumerate(multi_line_rows, start=1):
            line_match_value = _extract_row_value_by_key(line_row, match_key)
            if not line_match_value:
                raise HTTPException(
                    400,
                    f"{safe}: multi_line row {line_index} is missing match key '{match_key}'.",
                )
            grouped_lines.setdefault(line_match_value, []).append(dict(line_row))

        seen_header_values: set[str] = set()
        for index, header_row in enumerate(params_rows, start=1):
            header_match_value = _extract_row_value_by_key(header_row, match_key)
            if not header_match_value:
                raise HTTPException(
                    400,
                    f"{safe}: params row {index} is missing match key '{match_key}'.",
                )
            if header_match_value in seen_header_values:
                raise HTTPException(
                    400,
                    f"{safe}: duplicate params match key '{header_match_value}' for '{match_key}'.",
                )
            seen_header_values.add(header_match_value)
            matched_lines = grouped_lines.pop(header_match_value, [])
            if not matched_lines:
                raise HTTPException(
                    400,
                    f"{safe}: no multi_line rows found for params row {index} using '{match_key}={header_match_value}'.",
                )
            prepared_rows.append(
                {
                    "parameters": dict(header_row),
                    DEFAULT_MULTI_LINE_SHEET_NAME: matched_lines,
                    "parameter_row_index": index,
                    "parameter_set_index": index,
                }
            )

        if grouped_lines:
            extra_keys = ", ".join(sorted(grouped_lines))
            raise HTTPException(
                400,
                f"{safe}: multi_line rows contain unmatched '{match_key}' values: {extra_keys}.",
            )

    entries: list[dict[str, Any]] = []
    total_rows = len(prepared_rows)
    for prepared in prepared_rows:
        row_index = int(prepared.get("parameter_row_index") or 1)
        entry_name = safe if total_rows == 1 else f"{safe} [row {row_index}]"
        entry_id = safe if total_rows == 1 else f"{safe}-row-{row_index}"
        rec: dict[str, Any] = {
            "id": entry_id,
            "name": entry_name,
            "file": py_key,
            "after_action_wait_ms": after_action_wait_ms,
            "parameter_row_index": row_index,
            "parameter_set_index": int(prepared.get("parameter_set_index") or row_index),
        }
        parameters_row = prepared.get("parameters")
        multi_line_row_values = prepared.get(DEFAULT_MULTI_LINE_SHEET_NAME)
        if isinstance(parameters_row, dict):
            rec["parameters"] = dict(parameters_row)
            rec["skip_parameters_file_load"] = True
        if isinstance(multi_line_row_values, list) and multi_line_row_values:
            rec[DEFAULT_MULTI_LINE_SHEET_NAME] = list(multi_line_row_values)
            rec["skip_parameters_file_load"] = True
        if params_key:
            rec["parameters_file_key"] = params_key
        entries.append(rec)

    return entries


def _submit_agent_payload(
    payload: dict[str, Any],
    *,
    task_queue: str = "",
) -> tuple[list[str], "subprocess.CompletedProcess[str]"]:
    """Shell out to the local aetherion CLI and wait for the run to finish."""
    cmd = [AETHERION_BIN, "agent", "ACT Agent", json.dumps(payload), "--wait"]
    if task_queue:
        cmd += ["--task-queue", task_queue]
    if not Path(AETHERION_BIN).exists():
        raise HTTPException(400, f"aetherion CLI not found at {AETHERION_BIN}")
    try:
        proc = subprocess.run(cmd, cwd=str(TEST_RUNNER_DIR), capture_output=True, text=True, timeout=2400)
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "run timed out after 40 min")
    return cmd, proc


def _download_run_report(report_key: str, label: str) -> tuple[str, str]:
    """Download the run's HTML report to a unique local file; return (path, url).

    The S3 key is always <suite>/<run_id>/report.html, so naming the local file by
    basename alone makes every run collide on downloads/report.html at the same URL
    — the browser then serves a cached previous run. Key it by run_id so each run
    gets a unique URL and "Open report" always shows the run just executed.
    """
    try:
        DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)
        raw = _s3().get_object(Bucket=BUCKET, Key=report_key)["Body"].read()
        run_uuid = Path(report_key).parent.name or "run"
        dest = DOWNLOADS_DIR / f"{_safe_name(label)}_{run_uuid}.html"
        dest.write_bytes(raw)
        return str(dest), _report_url_for_dest(dest)
    except Exception as exc:
        return f"(download failed: {exc})", ""


@app.post("/api/run")
def run(body: RunBody):
    name = _safe_name(body.name)
    effective_wait_ms = DEFAULT_AFTER_ACTION_WAIT_MS if body.after_action_wait_ms is None else int(body.after_action_wait_ms)
    entries = _build_recording_entries(
        name,
        parameters=body.parameters if body.parameters else None,
        after_action_wait_ms=effective_wait_ms,
        bucket=BUCKET,
    )
    payload = {"test_suite_id": name, "recordings": entries, "execution_mode": body.execution_mode}
    cmd, proc = _submit_agent_payload(payload, task_queue=body.task_queue)
    stdout, stderr = proc.stdout, proc.stderr
    agent_result = _extract_agent_result(stdout) or _extract_agent_result(stderr)
    report_key = _find_report_key(agent_result)
    report_local, report_url = "", ""
    if report_key and body.download_report:
        report_local, report_url = _download_run_report(report_key, name)
    inline_parameters = entries[0].get("parameters") if entries and isinstance(entries[0].get("parameters"), dict) else {}
    inline_multi_line_rows = (
        entries[0].get(DEFAULT_MULTI_LINE_SHEET_NAME)
        if entries and isinstance(entries[0].get(DEFAULT_MULTI_LINE_SHEET_NAME), list)
        else []
    )
    return {
        "ok": proc.returncode == 0,
        "returncode": proc.returncode,
        "cmd": " ".join(cmd[:3]) + " '<payload>' --wait",
        "stdout": stdout[-20000:],
        "stderr": stderr[-8000:],
        "report_key": report_key,
        "report_local": report_local,
        "report_url": report_url,
        "used_after_action_wait_ms": effective_wait_ms,
        "execution_mode": body.execution_mode,
        "inline_parameter_keys": sorted(str(key) for key in inline_parameters),
        "inline_multi_line_row_count": len(inline_multi_line_rows),
        "prepared_recording_count": len(entries),
        "prepared_recording_names": [str(entry.get("name") or "") for entry in entries],
    }


@app.post("/api/run-suite")
def run_suite(body: SuiteRunBody):
    if not body.recordings:
        raise HTTPException(400, "at least one recording is required for a suite")
    effective_wait_ms = DEFAULT_AFTER_ACTION_WAIT_MS if body.after_action_wait_ms is None else int(body.after_action_wait_ms)
    entries = [
        entry
        for r in body.recordings
        for entry in _build_recording_entries(
            r.name,
            parameters=r.parameters if r.parameters else None,
            after_action_wait_ms=effective_wait_ms,
            bucket=BUCKET,
        )
    ]
    names = [e["name"] for e in entries]
    suite_id = _safe_name(body.suite_id) or _safe_name("suite_" + "_".join(names[:2]))[:80] or "suite"
    payload = {"test_suite_id": suite_id, "recordings": entries, "execution_mode": body.execution_mode}
    cmd, proc = _submit_agent_payload(payload, task_queue=body.task_queue)
    stdout, stderr = proc.stdout, proc.stderr
    agent_result = _extract_agent_result(stdout) or _extract_agent_result(stderr)
    report_key = _find_report_key(agent_result)
    report_local, report_url = "", ""
    if report_key and body.download_report:
        report_local, report_url = _download_run_report(report_key, suite_id)
    return {
        "ok": proc.returncode == 0,
        "returncode": proc.returncode,
        "cmd": " ".join(cmd[:3]) + " '<payload>' --wait",
        "stdout": stdout[-20000:],
        "stderr": stderr[-8000:],
        "report_key": report_key,
        "report_local": report_local,
        "report_url": report_url,
        "used_after_action_wait_ms": effective_wait_ms,
        "execution_mode": body.execution_mode,
        "suite_id": suite_id,
        "recordings": names,
    }


@app.get("/api/config")
def get_config():
    return {"bucket": BUCKET, "storage_endpoint": STORAGE_ENDPOINT, "aetherion_bin": AETHERION_BIN,
            "test_runner_dir": str(TEST_RUNNER_DIR), "pg": {"host": PG["host"], "port": PG["port"], "db": PG["dbname"]},
            "default_after_action_wait_ms": DEFAULT_AFTER_ACTION_WAIT_MS}


@app.get("/", response_class=HTMLResponse)
def index():
    return HTML


def _find_available_port(preferred_port: int, host: str = "127.0.0.1", *, attempts: int = 20) -> int:
    for port in range(preferred_port, preferred_port + max(1, attempts)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((host, port))
            except OSError:
                continue
            return port
    raise RuntimeError(
        f"Could not find a free port starting at {preferred_port} on {host} after {attempts} attempts."
    )


HTML = """<!doctype html><html><head><meta charset=utf-8><title>agent_shubham</title>
<style>
:root{--bg:#0f1117;--panel:#171a22;--line:#262b36;--fg:#e6e9ef;--mut:#8b93a7;--acc:#4f8cff;--ok:#36c98a;--bad:#ff6b6b}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--line);background:var(--panel)}
header h1{font-size:15px;margin:0;font-weight:600}header .meta{color:var(--mut);font-size:12px}
.wrap{display:grid;grid-template-columns:340px 1fr;height:calc(100vh - 46px)}
.col{overflow:auto;padding:14px}.col.left{border-right:1px solid var(--line);background:#12141b}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px;margin-bottom:12px}
.script{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border:1px solid var(--line);border-radius:7px;margin-bottom:7px;background:#12141b}
.script .nm{font-weight:600;font-size:13px;word-break:break-all}
.script .sub{color:var(--mut);font-size:11px}
.badge{font-size:10px;padding:1px 6px;border-radius:10px;border:1px solid var(--line)}
.badge.db{color:var(--ok);border-color:#1e4d39}.badge.nodb{color:var(--mut)}
button{background:var(--acc);color:#fff;border:0;border-radius:6px;padding:6px 11px;font-weight:600;cursor:pointer;font-size:12px}
button.ghost{background:#222838;color:var(--fg)}button:disabled{opacity:.5;cursor:wait}
a.btn{display:inline-flex;align-items:center;justify-content:center;background:var(--acc);color:#fff;border:0;border-radius:6px;padding:6px 11px;font-weight:600;cursor:pointer;font-size:12px;text-decoration:none}
a.btn.ghost{background:#222838;color:var(--fg)}
label{display:block;color:var(--mut);font-size:12px;margin:8px 0 3px}
input,textarea,select{width:100%;background:#0d0f15;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:8px;font-family:ui-monospace,Menlo,monospace;font-size:12px}
textarea{resize:vertical}.row{display:flex;gap:10px}.row>*{flex:1}
.inline-check{display:flex;align-items:center;gap:8px;margin:12px 0 4px;color:var(--fg);font-size:12px}
.inline-check input{width:auto;margin:0}
.tabs{display:flex;gap:6px;margin-bottom:10px}.tab{padding:6px 12px;border:1px solid var(--line);border-radius:6px;cursor:pointer;color:var(--mut)}
.tab.on{color:var(--fg);border-color:var(--acc);background:#16213a}
pre{background:#0a0c11;border:1px solid var(--line);border-radius:6px;padding:10px;overflow:auto;font-size:12px;white-space:pre-wrap;max-height:50vh}
.msg{padding:8px 10px;border-radius:6px;margin:8px 0;font-size:12px;display:none}
.msg.ok{background:#10271d;border:1px solid #1e4d39;color:var(--ok);display:block}
.msg.err{background:#2a1416;border:1px solid #5a2327;color:var(--bad);display:block}
a{color:var(--acc)}.spin{display:inline-block;width:12px;height:12px;border:2px solid #fff5;border-top-color:#fff;border-radius:50%;animation:s .7s linear infinite;vertical-align:-2px}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
.meta-line{color:var(--mut);font-size:12px;margin-top:8px}
@keyframes s{to{transform:rotate(360deg)}}
/* suite checkbox + selected row */
.suitechk{-webkit-appearance:checkbox;appearance:checkbox;width:18px;height:18px;accent-color:var(--acc);cursor:pointer;flex:0 0 auto;margin:0;padding:0;background:transparent;border:0;border-radius:0}
.script{transition:border-color .12s,background .12s}
.script:hover{border-color:#39507d}
.script.sel{border-color:var(--acc);background:#13203a}
/* CodeMirror integration */
.CodeMirror{border:1px solid var(--line);border-radius:6px;height:auto;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;line-height:1.5}
.CodeMirror-focused{border-color:var(--acc);box-shadow:0 0 0 1px var(--acc)}
.CodeMirror-gutters{border-right:1px solid var(--line)}
.editor-tools{display:flex;gap:8px;align-items:center;margin:4px 0 2px}
.editor-tools .pill{font-size:11px;color:var(--mut)}
</style>
<link rel=stylesheet href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.css">
<link rel=stylesheet href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/theme/dracula.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/python/python.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/javascript/javascript.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/edit/matchbrackets.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/addon/edit/closebrackets.min.js"></script>
</head><body>
<header><h1>agent_shubham</h1><span class=meta id=cfg></span><span style=flex:1></span><button class=ghost onclick=loadScripts()>↻ refresh</button></header>
<div class=wrap>
  <div class="col left">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><b>Recordings</b><span class=meta id=count></span></div>
    <input id=scriptSearch placeholder="search script name" style="margin-bottom:10px">
    <div id=suiteTray style=display:none></div>
    <div id=list></div>
  </div>
  <div class="col">
    <div class=tabs>
      <div class="tab on" id=t-edit onclick="tab('edit')">Upload / Edit</div>
      <div class="tab" id=t-run onclick="tab('run')">Run output</div>
    </div>
    <div id=p-edit>
      <div class=card>
        <div class=row><div><label>Recording name</label><input id=name placeholder="PR-based-PO_CREATE_YEUTest_v1.0"></div>
        <div style=flex:0.5><label>Params format</label><select id=fmt><option value=xlsx>xlsx</option><option value=csv>csv</option></select></div>
        <div style=flex:0.5><label>Overwrite</label><select id=ov><option value=true>true</option><option value=false>false</option></select></div></div>
        <label>Script (.py; Playwright may use {{placeholders}}, API/plain Python can call get_runtime_params())</label><textarea id=py rows=14 placeholder="paste a recorded Playwright or plain Python script"></textarea>
        <label>Runtime JSON ({"params":[{...}]} or {...} or [{...}])</label><textarea id=params rows=8 placeholder='{"params":[{"username":"...","password":"..."}]}'></textarea>
        <div class=editor-tools><button class=ghost style=padding:3px:9px onclick=formatParams()>⟳ Format JSON</button><span class=pill id=paramsStatus></span></div>
        <label>Prompt</label><textarea id=prompt rows=4 placeholder="optional recording guidance or extraction prompt"></textarea>
        <label class=inline-check><input id=repeatableLineItemsEnabled type=checkbox onchange=toggleRepeatableLineItems()>This recording has a repeatable block</label>
        <div id=repeatableLineItemsFields style=display:none>
          <div class=row>
            <div><label>Repeatable sheet name</label><input id=repeatableLineItemsSheet placeholder="multi_line" value="multi_line"></div>
            <div><label>Header-line match key</label><input id=repeatableLineItemsMatchKey placeholder="header_id"></div>
          </div>
          <label>Repeatable block instructions</label><textarea id=repeatableLineItemsPrompt rows=4 placeholder="Describe the repeated section, for example: repeat the invoice row-entry block for each row in multi_line from Description through Unit Price."></textarea>
        </div>
        <div class=msg id=upmsg></div>
        <div style=margin-top:10px><button id=upbtn onclick=doUpload()>⬆ Upload to MinIO + DB</button>
        <button class=ghost onclick=clearForm()>clear</button></div>
      </div>
    </div>
    <div id=p-run style=display:none>
      <div class=card><div style="display:flex;justify-content:space-between;align-items:center">
        <div><b id=runName>—</b> <span class=meta id=runMeta></span></div></div>
        <div class=row style="margin-top:10px">
          <div style=flex:0.5><label>Execution mode</label><select id=execMode><option value=parallel>parallel</option><option value=sequential>sequential</option></select></div>
          <div style=flex:0.5><label>After action wait (ms)</label><input id=waitMs type=number min=0 step=100 placeholder="0"></div>
        </div>
        <div class=actions id=reportActions style=display:none>
          <a id=openReportBtn class="btn" href="#" target="_blank" rel="noopener noreferrer">Open report</a>
          <a id=downloadReportBtn class="btn ghost" href="#" download>Download report</a>
        </div>
        <div class=meta-line id=reportMeta></div>
        <div class=msg id=runmsg></div>
        <pre id=out>select a recording on the left and press ▶ Run</pre>
      </div>
    </div>
  </div>
</div>
<script>
let CFG={};
let ALL_SCRIPTS=[];
let SUITE=[];let SUITE_MODE='sequential';let SUITE_WAIT=0;
function inSuite(n){return SUITE.includes(n)}
function toggleSuite(n,checked){if(checked){if(!SUITE.includes(n))SUITE.push(n)}else{SUITE=SUITE.filter(x=>x!==n)}renderSuite();renderScripts()}
function moveSuite(i,d){const j=i+d;if(j<0||j>=SUITE.length)return;const t=SUITE[i];SUITE[i]=SUITE[j];SUITE[j]=t;renderSuite()}
function removeSuite(n){SUITE=SUITE.filter(x=>x!==n);renderSuite();renderScripts()}
function clearSuite(){SUITE=[];renderSuite();renderScripts()}
function renderSuite(){
  const el=document.getElementById('suiteTray');
  if(!SUITE.length){el.style.display='none';el.innerHTML='';return}
  el.style.display='';
  el.innerHTML=`<div class=card style=padding:10px>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><b>Suite (${SUITE.length})</b>
      <button class=ghost style=padding:3px:8px onclick=clearSuite()>clear</button></div>
    <ol style="margin:0 0 8px 18px;padding:0;font-size:12px">${SUITE.map((n,i)=>`<li style="margin:3px 0;display:flex;align-items:center;gap:6px;justify-content:space-between">
      <span style=word-break:break-all>${n}</span>
      <span style=white-space:nowrap><button class=ghost style=padding:1px:6px onclick="moveSuite(${i},-1)">↑</button>
      <button class=ghost style=padding:1px:6px onclick="moveSuite(${i},1)">↓</button>
      <button class=ghost style=padding:1px:6px onclick="removeSuite('${n}')">✕</button></span></li>`).join('')}</ol>
    <div class=row style=margin-bottom:8px>
      <div style=flex:0.6><label style=margin-top:0>Mode</label>
        <select id=suiteMode onchange="SUITE_MODE=this.value">
          <option value=sequential ${SUITE_MODE=='sequential'?'selected':''}>sequential</option>
          <option value=parallel ${SUITE_MODE=='parallel'?'selected':''}>parallel</option></select></div>
      <div style=flex:0.4><label style=margin-top:0>Wait ms</label>
        <input id=suiteWaitMs type=number min=0 step=100 value="${SUITE_WAIT}" oninput="SUITE_WAIT=Number(this.value||0)"></div></div>
    <button onclick=runSuite()>▶ Run suite</button>
    <div class=meta style=margin-top:6px>sequential = flow context chains across recordings (later steps see earlier extract/ai_extract outputs)</div>
  </div>`;
}
const EDITORS=[];
function makeEditor(id,mode,height){
  const ta=document.getElementById(id);
  if(!window.CodeMirror)return ta; // offline / CDN blocked → plain textarea still works
  const cm=CodeMirror.fromTextArea(ta,{mode,theme:'dracula',lineNumbers:true,lineWrapping:true,matchBrackets:true,autoCloseBrackets:true,tabSize:2,indentUnit:2});
  cm.setSize('100%',height);
  EDITORS.push(cm);
  return {get value(){return cm.getValue()},set value(v){cm.setValue(v==null?'':String(v))},_cm:cm};
}
function refreshEditors(){EDITORS.forEach(cm=>setTimeout(()=>cm.refresh(),0))}
function formatParams(){const s=document.getElementById('paramsStatus');
  try{const p=JSON.parse(paramsInput.value);paramsInput.value=JSON.stringify(p,null,2);s.textContent='valid JSON';s.style.color='var(--ok)'}
  catch(e){s.textContent='invalid JSON: '+e.message;s.style.color='var(--bad)'}}
const recordingNameInput=document.getElementById('name');
const scriptInput=makeEditor('py','python',330);
const paramsInput=makeEditor('params',{name:'javascript',json:true},190);
const promptInput=document.getElementById('prompt');
const repeatableLineItemsEnabledInput=document.getElementById('repeatableLineItemsEnabled');
const repeatableLineItemsFields=document.getElementById('repeatableLineItemsFields');
const repeatableLineItemsSheetInput=document.getElementById('repeatableLineItemsSheet');
const repeatableLineItemsMatchKeyInput=document.getElementById('repeatableLineItemsMatchKey');
const repeatableLineItemsPromptInput=document.getElementById('repeatableLineItemsPrompt');
const uploadMessage=document.getElementById('upmsg');
const paramsFormatSelect=document.getElementById('fmt');
const overwriteSelect=document.getElementById('ov');
const runNameLabel=document.getElementById('runName');
const runMetaLabel=document.getElementById('runMeta');
const runMessage=document.getElementById('runmsg');
const runOutput=document.getElementById('out');
const executionModeSelect=document.getElementById('execMode');
const waitMsInput=document.getElementById('waitMs');
const reportActions=document.getElementById('reportActions');
const openReportBtn=document.getElementById('openReportBtn');
const downloadReportBtn=document.getElementById('downloadReportBtn');
const reportMeta=document.getElementById('reportMeta');
const scriptSearchInput=document.getElementById('scriptSearch');
async function j(u,o){const r=await fetch(u,o);const t=await r.text();let d;try{d=JSON.parse(t)}catch(e){throw new Error(t)}if(!r.ok)throw new Error(d.detail||t);return d}
function tab(n){for(const x of['edit','run']){document.getElementById('p-'+x).style.display=x==n?'':'none';document.getElementById('t-'+x).classList.toggle('on',x==n)}if(n=='edit')refreshEditors()}
function resetReportActions(){reportActions.style.display='none';openReportBtn.href='#';downloadReportBtn.href='#';reportMeta.textContent=''}
function toggleRepeatableLineItems(){repeatableLineItemsFields.style.display=repeatableLineItemsEnabledInput.checked?'':'none'}
function buildRepeatableLineItemsPayload(){
  if(!repeatableLineItemsEnabledInput.checked)return null;
  return {
    enabled:true,
    sheet_name:(repeatableLineItemsSheetInput.value||'').trim()||'multi_line',
    match_key:(repeatableLineItemsMatchKeyInput.value||'').trim(),
    prompt:(repeatableLineItemsPromptInput.value||'').trim(),
  };
}
function applyRecordingConfig(config){
  const prompt=(config&&typeof config.prompt=='string')?config.prompt:'';
  const repeatableBlocks=(config&&Array.isArray(config.repeatable_blocks))?config.repeatable_blocks:[];
  const repeatable=repeatableBlocks.length&&typeof repeatableBlocks[0]=='object'?repeatableBlocks[0]:((config&&config.repeatable_line_items&&typeof config.repeatable_line_items=='object')?config.repeatable_line_items:null);
  promptInput.value=prompt;
  repeatableLineItemsEnabledInput.checked=!!(repeatable&&repeatable.enabled!==false);
  repeatableLineItemsSheetInput.value=(repeatable&&repeatable.sheet_name)||'multi_line';
  repeatableLineItemsMatchKeyInput.value=(repeatable&&repeatable.match_key)||'';
  repeatableLineItemsPromptInput.value=(repeatable&&repeatable.prompt)||'';
  toggleRepeatableLineItems();
}
async function loadCfg(){CFG=await j('/api/config');document.getElementById('cfg').textContent=`bucket: ${CFG.bucket} · pg: ${CFG.pg.host}:${CFG.pg.port}/${CFG.pg.db} · agent: local`;waitMsInput.value=String(CFG.default_after_action_wait_ms ?? 0)}
function renderScripts(){
  const query=(scriptSearchInput.value||'').trim().toLowerCase();
  const visible=ALL_SCRIPTS.filter(s=>!query||s.name.toLowerCase().includes(query));
  document.getElementById('count').textContent=`${visible.length}/${ALL_SCRIPTS.length} in ${CFG.bucket||''}`.trim();
  document.getElementById('list').innerHTML=visible.map(s=>`<div class="script ${inSuite(s.name)?'sel':''}"><div style="display:flex;gap:9px;align-items:center;min-width:0">
   <input type=checkbox class=suitechk title="add to suite" ${inSuite(s.name)?'checked':''} onchange="toggleSuite('${s.name}',this.checked)">
   <div style=min-width:0><div class=nm>${s.name}</div>
   <div class=sub>${s.params_key?s.params_key.split('/').pop():'(no params)'} · <span class="badge ${s.has_db?'db':'nodb'}">${s.has_db?'DB ✓':'no DB'}</span></div></div></div>
   <div style=display:flex;gap:6px;flex-direction:column><button onclick="runIt('${s.name}')">▶ Run</button><button class=ghost onclick="loadOne('${s.name}')">edit</button></div></div>`).join('')||'<div class=meta>no recordings</div>'}
async function loadScripts(){const d=await j('/api/scripts');ALL_SCRIPTS=d.scripts||[];if(!CFG.bucket)CFG.bucket=d.bucket||'';renderScripts();renderSuite()}
async function loadOne(n){const d=await j('/api/script?name='+encodeURIComponent(n));recordingNameInput.value=d.name;scriptInput.value=d.py_text;
  const payload={params:d.params.length?d.params:[{}]};if(Array.isArray(d.multi_line)&&d.multi_line.length)payload.multi_line=d.multi_line;
  paramsInput.value=JSON.stringify(payload,null,2);applyRecordingConfig(d.recording_config||{});tab('edit');
  uploadMessage.className='msg ok';uploadMessage.textContent=`loaded ${d.name} · placeholders: ${d.placeholders.join(', ')||'none'} · DB: ${d.db?'yes':'no'}`}
function clearForm(){recordingNameInput.value=scriptInput.value=paramsInput.value=promptInput.value=repeatableLineItemsPromptInput.value=repeatableLineItemsMatchKeyInput.value='';repeatableLineItemsEnabledInput.checked=false;repeatableLineItemsSheetInput.value='multi_line';toggleRepeatableLineItems();uploadMessage.className='msg'}
async function doUpload(){const b=document.getElementById('upbtn');b.disabled=true;uploadMessage.className='msg';uploadMessage.textContent='';
  try{let p;try{p=JSON.parse(paramsInput.value)}catch(e){throw new Error('params JSON invalid: '+e.message)}
   const d=await j('/api/upload',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:recordingNameInput.value,script:scriptInput.value,params:p,fmt:paramsFormatSelect.value,overwrite:overwriteSelect.value=='true',prompt:promptInput.value,repeatable_blocks:(()=>{const block=buildRepeatableLineItemsPayload();return block?[block]:null;})()})});
   let m=`uploaded → ${d.py_key} + ${d.params_key.split('/').pop()} · start_url=${d.start_url||'?'} · DB ${d.db.inserted?'inserted':(d.db.conflict?'conflict':'updated')} (id ${d.db.id||'-'})`;
   if(d.recording_config_key)m+=` · config: ${d.recording_config_key.split('/').pop()}`;
   if(d.db_error)m+=` · ⚠ DB: ${d.db_error}`;if(d.missing_placeholders.length)m+=` · ⚠ missing params for: ${d.missing_placeholders.join(', ')}`;
   uploadMessage.className='msg '+(d.db_error?'err':'ok');uploadMessage.textContent=m;loadScripts()}
  catch(e){uploadMessage.className='msg err';uploadMessage.textContent=e.message}finally{b.disabled=false}}
function safeName(v){return (v||'').trim().replace(/[^A-Za-z0-9._-]+/g,'_').replace(/^[._]+|[._]+$/g,'')}
async function runIt(n){tab('run');resetReportActions();runNameLabel.textContent=n;runMessage.className='msg ok';runMessage.innerHTML='running <span class=spin></span> (uses your local agent; may take minutes)';
  const waitValue=Number(waitMsInput.value||0);
  runMetaLabel.textContent=`mode=${executionModeSelect.value} · wait=${waitValue}ms`;
  runOutput.textContent='$ aetherion agent "ACT Agent" ... --wait\\n(waiting for your local worker)';
  try{const body={name:n,execution_mode:executionModeSelect.value,after_action_wait_ms:waitValue};
   if(safeName(recordingNameInput.value)===n&&paramsInput.value.trim()){let p;try{p=JSON.parse(paramsInput.value)}catch(e){throw new Error('params JSON invalid: '+e.message)};body.parameters=p}
   const d=await j('/api/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
   runMessage.className='msg '+(d.ok?'ok':'err');let m=d.ok?'completed (exit 0)':'failed (exit '+d.returncode+')';
   if(d.prepared_recording_count&&d.prepared_recording_count>1)m+=` · expanded to ${d.prepared_recording_count} prepared runs`;
   if(d.inline_parameter_keys&&d.inline_parameter_keys.length)m+=` · inline params: ${d.inline_parameter_keys.join(', ')}`;
   if(d.report_local)m+=' · report: '+d.report_local;runMessage.textContent=m;
   runMetaLabel.textContent=`mode=${d.execution_mode} · wait=${d.used_after_action_wait_ms}ms`;
   if(d.report_url){openReportBtn.href=d.report_url;downloadReportBtn.href=d.report_url;downloadReportBtn.setAttribute('download', d.report_url.split('/').pop());reportActions.style.display='flex';reportMeta.textContent=d.report_local||d.report_key||''}
   runOutput.textContent=(d.stdout||'')+(d.stderr?'\\n--- stderr ---\\n'+d.stderr:'')}
  catch(e){runMessage.className='msg err';runMessage.textContent=e.message;runOutput.textContent=e.message}}
async function runSuite(){
  if(!SUITE.length)return;
  tab('run');resetReportActions();
  runNameLabel.textContent='Suite: '+SUITE.join(' → ');
  runMessage.className='msg ok';runMessage.innerHTML='running suite <span class=spin></span> (uses your local agent; may take minutes)';
  runMetaLabel.textContent=`mode=${SUITE_MODE} · ${SUITE.length} recordings · wait=${SUITE_WAIT}ms`;
  runOutput.textContent='$ aetherion agent "ACT Agent" ... --wait\\n(waiting for your local worker)';
  try{const body={recordings:SUITE.map(n=>({name:n})),execution_mode:SUITE_MODE,after_action_wait_ms:SUITE_WAIT};
   const d=await j('/api/run-suite',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
   runMessage.className='msg '+(d.ok?'ok':'err');
   let m=d.ok?'suite completed (exit 0)':'suite failed (exit '+d.returncode+')';
   m+=` · ${(d.recordings||[]).length} recordings`;if(d.report_local)m+=' · report: '+d.report_local;runMessage.textContent=m;
   runMetaLabel.textContent=`suite=${d.suite_id} · mode=${d.execution_mode} · wait=${d.used_after_action_wait_ms}ms`;
   if(d.report_url){openReportBtn.href=d.report_url;downloadReportBtn.href=d.report_url;downloadReportBtn.setAttribute('download', d.report_url.split('/').pop());reportActions.style.display='flex';reportMeta.textContent=d.report_local||d.report_key||''}
   runOutput.textContent=(d.stdout||'')+(d.stderr?'\\n--- stderr ---\\n'+d.stderr:'')}
  catch(e){runMessage.className='msg err';runMessage.textContent=e.message;runOutput.textContent=e.message}}
scriptSearchInput.addEventListener('input', renderScripts);
toggleRepeatableLineItems();
loadCfg();loadScripts();
</script></body></html>"""


if __name__ == "__main__":
    host = "127.0.0.1"
    requested_port = int(os.environ.get("PORT", "8765"))
    bind_port = _find_available_port(requested_port, host)
    suffix = "" if bind_port == requested_port else f"  (requested {requested_port} was busy)"
    print(
        f"agent_shubham → http://localhost:{bind_port}   "
        f"(bucket={BUCKET}, pg={PG['host']}:{PG['port']}/{PG['dbname']}){suffix}"
    )
    uvicorn.run(app, host=host, port=bind_port, log_level="info")
