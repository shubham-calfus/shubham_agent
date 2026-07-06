from __future__ import annotations

import importlib.util
from pathlib import Path


_APP_PATH = Path(__file__).resolve().parents[1] / "app.py"
_SPEC = importlib.util.spec_from_file_location("agent_shubham_app", _APP_PATH)
assert _SPEC and _SPEC.loader
app = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(app)


def test_resolve_upload_multi_line_rows_keeps_explicit_multi_line() -> None:
    param_sets = [{"header_value": "A"}]
    payload = {
        "params": param_sets,
        "line_items": [{"line_amount": "100", "distribution_combination_id": "850"}],
    }

    resolved_params, resolved_multi_line = app._resolve_upload_multi_line_rows(
        payload=payload,
        param_sets=param_sets,
        repeatable_blocks=[{"enabled": True, "sheet_name": "line_items", "prompt": "", "match_key": ""}],
        recording_name="demo",
        bucket="tenant",
        overwrite=True,
    )

    assert resolved_params == param_sets
    assert resolved_multi_line == [{"line_amount": "100", "distribution_combination_id": "850"}]


def test_resolve_upload_multi_line_rows_preserves_saved_sheet_when_payload_omits_it(monkeypatch) -> None:
    param_sets = [{"invoice_number": "INV-1"}]

    monkeypatch.setattr(
        app,
        "_load_saved_runtime_payload",
        lambda name, bucket: (
            [{"invoice_number": "INV-1"}],
            [{"line_amount": "100", "distribution_combination_id": "850"}],
            "recordings/demo/demo_params.xlsx",
        ),
    )

    resolved_params, resolved_multi_line = app._resolve_upload_multi_line_rows(
        payload={"params": param_sets},
        param_sets=param_sets,
        repeatable_blocks=[{"enabled": True, "sheet_name": "line_items", "prompt": "", "match_key": ""}],
        recording_name="demo",
        bucket="tenant",
        overwrite=True,
    )

    assert resolved_params == param_sets
    assert resolved_multi_line == [{"line_amount": "100", "distribution_combination_id": "850"}]


def test_resolve_upload_multi_line_rows_does_not_preserve_when_payload_explicitly_clears_it(monkeypatch) -> None:
    param_sets = [{"invoice_number": "INV-1"}]

    monkeypatch.setattr(
        app,
        "_load_saved_runtime_payload",
        lambda name, bucket: (
            [{"invoice_number": "INV-1"}],
            [{"line_amount": "100", "distribution_combination_id": "850"}],
            "recordings/demo/demo_params.xlsx",
        ),
    )

    resolved_params, resolved_multi_line = app._resolve_upload_multi_line_rows(
        payload={"params": param_sets, "line_items": []},
        param_sets=param_sets,
        repeatable_blocks=[{"enabled": True, "sheet_name": "line_items", "prompt": "", "match_key": ""}],
        recording_name="demo",
        bucket="tenant",
        overwrite=True,
    )

    assert resolved_params == param_sets
    assert resolved_multi_line == []


def test_build_recording_entry_includes_inline_multi_line_rows() -> None:
    entry = app._build_recording_entry(
        "demo",
        parameters={
            "params": [{"invoice_number": "INV-1"}],
            "line_items": [{"line_amount": "100", "distribution_combination_id": "850"}],
        },
        after_action_wait_ms=0,
        bucket="tenant",
    )

    assert entry["parameters"] == {"invoice_number": "INV-1"}
    assert entry["line_items"] == [{"line_amount": "100", "distribution_combination_id": "850"}]
    assert entry["skip_parameters_file_load"] is True


def test_build_recording_entry_keeps_saved_multi_line_rows(monkeypatch) -> None:
    monkeypatch.setattr(
        app,
        "_load_saved_runtime_payload",
        lambda name, bucket: (
            [{"invoice_number": "INV-1"}],
            [{"line_amount": "100", "distribution_combination_id": "850"}],
            "recordings/demo/demo_params.xlsx",
        ),
    )

    entry = app._build_recording_entry(
        "demo",
        parameters=None,
        after_action_wait_ms=0,
        bucket="tenant",
    )

    assert entry["parameters"] == {"invoice_number": "INV-1"}
    assert entry["line_items"] == [{"line_amount": "100", "distribution_combination_id": "850"}]
    assert entry["skip_parameters_file_load"] is True


def test_normalize_repeatable_blocks_config_keeps_match_key() -> None:
    config = app._normalize_repeatable_blocks_config(
        [{
            "enabled": True,
            "sheet_name": "line_items",
            "match_key": "Ref ID",
            "prompt": "loop rows",
        }]
    )

    assert config == [{
        "enabled": True,
        "sheet_name": "line_items",
        "match_key": "ref_id",
        "prompt": "loop rows",
    }]


def test_build_recording_entries_groups_multi_line_rows_by_match_key(monkeypatch) -> None:
    monkeypatch.setattr(
        app,
        "_load_recording_config",
        lambda name, bucket: {
            "repeatable_blocks": [
                {
                    "enabled": True,
                    "sheet_name": "line_items",
                    "match_key": "ref_id",
                    "prompt": "",
                }
            ]
        },
    )

    entries = app._build_recording_entries(
        "demo",
        parameters={
            "params": [
                {"ref_id": "INV1", "customer_name": "Customer 1"},
                {"ref_id": "INV2", "customer_name": "Customer 2"},
            ],
            "line_items": [
                {"ref_id": "INV1", "line_description": "Line 1", "quantity": "1"},
                {"ref_id": "INV1", "line_description": "Line 2", "quantity": "2"},
                {"ref_id": "INV2", "line_description": "Line 3", "quantity": "3"},
            ],
        },
        after_action_wait_ms=0,
        bucket="tenant",
    )

    assert len(entries) == 2
    assert entries[0]["name"] == "demo [row 1]"
    assert entries[0]["parameters"] == {"ref_id": "INV1", "customer_name": "Customer 1"}
    assert entries[0]["line_items"] == [
        {"ref_id": "INV1", "line_description": "Line 1", "quantity": "1"},
        {"ref_id": "INV1", "line_description": "Line 2", "quantity": "2"},
    ]
    assert entries[1]["parameters"] == {"ref_id": "INV2", "customer_name": "Customer 2"}
    assert entries[1]["line_items"] == [
        {"ref_id": "INV2", "line_description": "Line 3", "quantity": "3"},
    ]


def test_build_recording_entries_rejects_multi_headers_without_match_key(monkeypatch) -> None:
    monkeypatch.setattr(app, "_load_recording_config", lambda name, bucket: {})

    try:
        app._build_recording_entries(
            "demo",
            parameters={
                "params": [
                    {"customer_name": "Customer 1"},
                    {"customer_name": "Customer 2"},
                ],
                "line_items": [
                    {"ref_id": "INV1", "line_description": "Line 1", "quantity": "1"},
                ],
            },
            after_action_wait_ms=0,
            bucket="tenant",
        )
    except app.HTTPException as exc:
        assert exc.status_code == 400
        assert "match_key" in str(exc.detail)
    else:  # pragma: no cover - defensive
        raise AssertionError("expected HTTPException")
