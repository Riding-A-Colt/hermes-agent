"""Conversation-wide ``sessions.model_config`` keys: read-modify-write at the compression tip and the
key scan. Bodies of :class:`hermes_state_sessions.SessionSessionsMixin`'s two methods of the same names."""

from __future__ import annotations

import json
import time
from typing import Any, Callable, Optional

from hermes_state_common import _sql_json_extract

# ``model_config`` key marking a cron run session a user took over by sending into it (#88443).
# Written by ``mark_cron_run_adopted`` (the Desktop submit path, via ``reopen_session``'s caller),
# read by ``hermes_cli.web_routers.cron.cron_run_scheduler_owned`` so an adopted run stops reading
# as a zombie. A conversation-wide key: compression carries it onto the continuation child.
CRON_ADOPTED_MODEL_CONFIG_KEY = "_adopted_from_cron"


def mark_cron_run_adopted(db, session_id: str) -> bool:
    """Durably mark a ``source='cron'`` run session as taken over by a user turn (#88443).

    The first user turn in a run's session reopens the row (``ended_at`` cleared), which is
    exactly the shape of a run whose scheduler died before finalizing: the Desktop write gate
    cannot tell them apart from ``ended_at`` alone, so after one round of chat it locked the next
    one out. This marker IS that difference — it outlives the process, and it rides
    ``model_config`` so no schema change is needed (the merge keeps
    ``_branched_from``/``_reset_from``/``_delegate_from`` intact). Only a cron row is stamped, and
    a re-adopt keeps the first stamp. Returns whether the row now carries it.
    """
    from hermes_state_sessions import _parse_model_config

    if not session_id:
        return False

    def _do(conn) -> bool:
        row = conn.execute(
            "SELECT source, model_config FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if row is None or (row[0] or "") != "cron":
            return False
        config = _parse_model_config(row[1])
        if config.get(CRON_ADOPTED_MODEL_CONFIG_KEY) is not None:
            return True
        config[CRON_ADOPTED_MODEL_CONFIG_KEY] = time.time()
        conn.execute(
            "UPDATE sessions SET model_config = ? WHERE id = ?",
            (json.dumps(config), session_id),
        )
        return True

    return bool(db._execute_write(_do))


def update_conversation_model_config_value(db, session_id: str, key: str,
                                           update: Callable[[Any], Any]) -> Optional[str]:
    """Read a conversation-wide ``key`` at *session_id*'s compression tip and write ``update(value)``
    back, in one write transaction: a concurrent writer of the key cannot be overwritten with a stale
    copy, and a rotation cannot publish between finding the tip and writing it (the child would keep
    the old copy). ``update`` may run more than once (lock retry) and must be pure; returning None
    removes the key. Returns the id written, None when the row does not exist."""
    from hermes_state_sessions import _parse_model_config

    def _do(conn) -> Optional[str]:
        tip = db._compression_tip_on(conn, session_id)
        row = conn.execute("SELECT model_config FROM sessions WHERE id = ?", (tip,)).fetchone()
        if row is None:
            return None
        config = _parse_model_config(row[0])
        if (value := update(config.get(key))) is None:
            config.pop(key, None)
        else:
            config[key] = value
        conn.execute("UPDATE sessions SET model_config = ? WHERE id = ?", (json.dumps(config), tip))
        return tip
    return db._execute_write(_do)


def session_ids_with_model_config_key(db, key: str) -> list[str]:
    """Ids of the sessions whose model_config carries ``key``, newest first."""
    with db._read_ctx() as conn:
        rows = conn.execute(
            f"SELECT id FROM sessions WHERE {_sql_json_extract('model_config', '$.' + key)} IS NOT NULL "
            "ORDER BY started_at DESC").fetchall()
    return [row["id"] for row in rows]
