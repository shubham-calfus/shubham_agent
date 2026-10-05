"""Pins the Runs page's report file naming and its pass/fail signal."""

from __future__ import annotations

import importlib.util
import io
import sys
from pathlib import Path


_APP_PATH = Path(__file__).resolve().parents[1] / "app.py"
_SPEC = importlib.util.spec_from_file_location("agent_shubham_app_run_report", _APP_PATH)
assert _SPEC and _SPEC.loader
app = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = app
_SPEC.loader.exec_module(app)

# Shape of a real ACT Agent result (workflow ACT Agent-1b7b8cd7..., one failed recording, CLI exit 0).
_PREFIX = "46f11dab-bdfc-4c9c-b096-0cb7c9d68599"
_FAILED_RESULT = [
    {
        "type": "s3_download_link",
        "title": "shubham-Manage_Mapping_Sets",
        "file_key": f"{_PREFIX}/TestSuite_shubham-Manage_Mapping_Sets_2123e019-3b32-41bd-bfdc-3b5f74eb6d64.html",
        "label": "Download HTML Report",
        "extension": "html",
    },
    {"type": "summary", "test_suite_id": "shubham-Manage_Mapping_Sets", "total": 1, "passed": 0, "failed": 1, "execution_mode": "parallel"},
]


class _FakeS3:
    def __init__(self, objects: dict[str, bytes]) -> None:
        self.objects = objects

    def get_object(self, *, Bucket: str, Key: str):
        return {"Body": io.BytesIO(self.objects[Key])}


def test_two_runs_of_one_recording_get_their_own_report_file(monkeypatch, tmp_path) -> None:
    old = f"{_PREFIX}/TestSuite_shubham-Manage_Mapping_Sets_0cc9bbdf-1632-4003-8f17-84f94e150076.html"
    new = _FAILED_RESULT[0]["file_key"]
    monkeypatch.setattr(app, "_s3", lambda: _FakeS3({old: b"old run", new: b"new run"}))
    monkeypatch.setattr(app, "DOWNLOADS_DIR", tmp_path)

    old_path, old_url = app._download_run_report(old)
    new_path, new_url = app._download_run_report(new)

    assert old_url != new_url
    assert new_url == "/downloads/TestSuite_shubham-Manage_Mapping_Sets_2123e019-3b32-41bd-bfdc-3b5f74eb6d64.html"
    assert Path(old_path).read_bytes() == b"old run"
    assert Path(new_path).read_bytes() == b"new run"


def test_suite_passed_comes_from_the_summary_not_the_exit_code() -> None:
    assert app._find_report_key(_FAILED_RESULT) == _FAILED_RESULT[0]["file_key"]
    assert app._suite_passed(_FAILED_RESULT) is False
    passed = [_FAILED_RESULT[0], {**_FAILED_RESULT[1], "passed": 1, "failed": 0}]
    assert app._suite_passed(passed) is True
    assert app._suite_passed({"result": passed}) is True
    assert app._suite_passed([{"type": "error", "message": "test_suite_id is required."}]) is False
    assert app._suite_passed([{"type": "summary", "total": 0, "passed": 0, "failed": 0}]) is False
    assert app._suite_passed(None) is False
