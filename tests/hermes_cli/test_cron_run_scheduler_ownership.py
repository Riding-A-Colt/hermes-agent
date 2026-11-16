"""A never-closed cron run is live while the scheduler OWNS it, not while it ticked recently (#88443).

``is_active`` on a run row is a 300s activity window. A live run inside a long tool call writes no
heartbeat, so it reads inactive exactly like a zombie whose process died. ``scheduler_owned`` is
the durable answer the desktop keys its view-only decision on; these tests drive the real
execution ledger in a temp HERMES_HOME.
"""

import json
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

import hermes_cli.web_routers.cron as _rt_cron


@pytest.fixture()
def homes(tmp_path, monkeypatch):
    from hermes_cli import profiles

    default_home = tmp_path / ".hermes"
    profiles_root = default_home / "profiles"
    worker_home = profiles_root / "worker_alpha"
    for home in (default_home, worker_home):
        (home / "cron").mkdir(parents=True, exist_ok=True)
        (home / "config.yaml").write_text("model: test-model\n", encoding="utf-8")
    monkeypatch.setenv("HERMES_HOME", str(default_home))
    monkeypatch.setattr(profiles, "_get_default_hermes_home", lambda: default_home)
    monkeypatch.setattr(profiles, "_get_profiles_root", lambda: profiles_root)
    return {"default": default_home, "worker_alpha": worker_home}


def _claim(home: Path, job_id: str) -> dict:
    """Create + start a ledger attempt owned by THIS (live) process, inside ``home``."""
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    from cron.executions import create_execution, mark_execution_running

    token = set_hermes_home_override(str(home))
    try:
        record = create_execution(job_id, source="test")
        return mark_execution_running(record["id"]) or record
    finally:
        reset_hermes_home_override(token)


def _claimed_epoch(execution: dict) -> float:
    epoch = _rt_cron._iso_to_epoch(execution["claimed_at"])
    assert epoch is not None
    return epoch


def _dead_pid() -> int:
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    return proc.pid


def _kill_owner(home: Path, execution_id: str) -> None:
    conn = sqlite3.connect(home / "cron" / "executions.db")
    try:
        conn.execute("UPDATE executions SET pid=? WHERE id=?", (_dead_pid(), execution_id))
        conn.commit()
    finally:
        conn.close()


def _runs(monkeypatch, job_id: str, rows: list, profile: str = "default") -> dict:
    class _FakeDB:
        def list_cron_job_runs(self, canonical, limit=20, offset=0):
            return [dict(r) for r in rows]

        def close(self):
            pass

    monkeypatch.setattr(_rt_cron, "_open_session_db_for_profile", lambda _p, *, read_only: _FakeDB())
    monkeypatch.setattr(_rt_cron, "_job_owner_profile", lambda _j, _p: profile)
    monkeypatch.setattr(
        _rt_cron, "_call_cron_for_profile",
        lambda _p, cmd, *_a, **_k: {"id": job_id} if cmd == "get_job" else None,
    )
    result = _rt_cron._list_cron_job_runs_sync(job_id, limit=10)
    return {run["id"]: run for run in result["runs"]}


def _open_row(job_id: str, suffix: str, started_at: float) -> dict:
    # last_active far in the past: the activity window alone would call it dead.
    return {
        "id": f"cron_{job_id}_{suffix}", "source": "cron", "started_at": started_at,
        "last_active": started_at, "ended_at": None, "archived": False,
    }


def test_owned_run_past_the_activity_window_is_scheduler_owned(homes, monkeypatch):
    job_id = "longtool"
    execution = _claim(homes["default"], job_id)
    claimed = _claimed_epoch(execution)
    live = _open_row(job_id, "20260929_120000", claimed + 1)
    zombie = _open_row(job_id, "20260929_110000", claimed - 3600)
    monkeypatch.setattr(_rt_cron.time, "time", lambda: claimed + 1800)  # 30 min without a tick

    runs = _runs(monkeypatch, job_id, [live, zombie])

    assert runs[live["id"]]["is_active"] is False  # the stale window
    assert runs[live["id"]]["scheduler_owned"] is True  # ...but the scheduler still runs it
    # An older never-closed run of the same job predates the live claim: still a zombie.
    assert runs[zombie["id"]]["scheduler_owned"] is False


def test_run_whose_owner_process_died_is_not_owned(homes, monkeypatch):
    job_id = "crashed"
    execution = _claim(homes["default"], job_id)
    _kill_owner(homes["default"], execution["id"])
    claimed = _claimed_epoch(execution)
    row = _open_row(job_id, "20260929_120000", claimed + 1)

    assert _runs(monkeypatch, job_id, [row])[row["id"]]["scheduler_owned"] is False


def test_finished_attempt_and_closed_run_are_not_owned(homes, monkeypatch):
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    from cron.executions import finish_execution

    job_id = "done"
    execution = _claim(homes["default"], job_id)
    claimed = _claimed_epoch(execution)
    closed = {**_open_row(job_id, "20260929_130000", claimed + 1), "ended_at": claimed + 60}

    assert _runs(monkeypatch, job_id, [closed])[closed["id"]]["scheduler_owned"] is False

    token = set_hermes_home_override(str(homes["default"]))
    try:
        finish_execution(execution["id"], success=False, error="watchdog")
    finally:
        reset_hermes_home_override(token)
    open_row = _open_row(job_id, "20260929_120000", claimed + 1)

    assert _runs(monkeypatch, job_id, [open_row])[open_row["id"]]["scheduler_owned"] is False


def test_ownership_reads_the_owner_profiles_ledger(homes, monkeypatch):
    """A→B→A: a live claim in worker_alpha never makes default's run look owned, and back."""
    job_id = "shared-name"
    execution = _claim(homes["worker_alpha"], job_id)
    claimed = _claimed_epoch(execution)
    row = _open_row(job_id, "20260929_120000", claimed + 1)

    assert _runs(monkeypatch, job_id, [row], profile="worker_alpha")[row["id"]]["scheduler_owned"] is True
    assert _runs(monkeypatch, job_id, [row], profile="default")[row["id"]]["scheduler_owned"] is False
    assert _runs(monkeypatch, job_id, [row], profile="worker_alpha")[row["id"]]["scheduler_owned"] is True


def test_session_detail_stamps_the_same_answer_for_cron_runs_only(homes):
    job_id = "detail"
    execution = _claim(homes["default"], job_id)
    claimed = _claimed_epoch(execution)
    row = _open_row(job_id, "20260929_120000", claimed + 1)

    assert _rt_cron.cron_run_scheduler_owned(row, None) is True
    assert _rt_cron.cron_run_scheduler_owned({**row, "ended_at": claimed + 5}, None) is False
    assert _rt_cron.cron_run_scheduler_owned({**row, "source": "desktop"}, None) is None


def _adopted(row: dict) -> dict:
    """The same never-closed row, after a user's first turn adopted it (its ``ended_at`` is
    cleared by ``reopen_session``, which alone reads as a zombie)."""
    return {**row, "model_config": json.dumps({"_adopted_from_cron": 1.0})}


def test_a_user_adopted_run_is_writable_with_no_scheduler_anywhere(homes, monkeypatch):
    """One turn of chat must not lock the next one out: adoption is the durable answer, and it
    holds even though no attempt is in flight and the activity window is long stale (#88443)."""
    job_id = "adopted"
    row = _adopted(_open_row(job_id, "20260929_120000", 1000.0))

    assert _runs(monkeypatch, job_id, [row])[row["id"]]["scheduler_owned"] is True
    assert _rt_cron.cron_run_scheduler_owned(row, None) is True

    # The very same row without the marker is a zombie: adoption, not the shape, is the difference.
    unadopted = {k: v for k, v in row.items() if k != "model_config"}
    assert _runs(monkeypatch, job_id, [unadopted])[unadopted["id"]]["scheduler_owned"] is False


def test_adoption_marker_never_makes_a_non_cron_session_writable(homes):
    """Only ``source='cron'`` rows are gated, so the marker on anything else is inert."""
    row = {"id": "20260929_120000_abc", "source": "desktop", "started_at": 1.0,
           "last_active": 1.0, "ended_at": None, "archived": False,
           "model_config": json.dumps({"_adopted_from_cron": 1.0})}

    assert _rt_cron.cron_run_scheduler_owned(row, None) is None
    assert _rt_cron.cron_run_user_adopted(row) is False


def test_mark_cron_run_adopted_stamps_only_cron_rows_and_only_once(homes):
    """The stamp lives in ``model_config`` (no schema change) and keeps the keys already there."""
    from hermes_state import SessionDB
    from hermes_state_sessions import _parse_model_config
    from hermes_state_sessions_model_config import CRON_ADOPTED_MODEL_CONFIG_KEY

    db = SessionDB(homes["default"] / "state.db")
    try:
        db.create_session("cron-run", source="cron", model_config={"_branched_from": "parent-1"})
        db.create_session("plain-chat", source="desktop")

        assert db.mark_cron_run_adopted("cron-run") is True
        first = _parse_model_config(db.get_session("cron-run")["model_config"])
        assert first[CRON_ADOPTED_MODEL_CONFIG_KEY] is not None
        assert first["_branched_from"] == "parent-1", "the merge must not drop other keys"

        assert db.mark_cron_run_adopted("cron-run") is True
        second = _parse_model_config(db.get_session("cron-run")["model_config"])
        assert second[CRON_ADOPTED_MODEL_CONFIG_KEY] == first[CRON_ADOPTED_MODEL_CONFIG_KEY], \
            "a re-adopt keeps the first stamp"

        assert db.mark_cron_run_adopted("plain-chat") is False
        assert db.get_session("plain-chat")["model_config"] is None
        assert db.mark_cron_run_adopted("missing-row") is False
    finally:
        db.close()
