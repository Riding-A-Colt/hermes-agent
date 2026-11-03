"""语音开场（无 caption 的语音消息）必须真的能命名，Discord 线程才会跟着改名。

Discord 把「只发了一条语音、没有文字」的消息投成占位串
``(The user sent a message with no text content)``。它在 ``event.text`` 里是 truthy，
``event.text or None`` 于是把它当成用户正文传给 titler；占位串在 titler 里被剥干净后
变成空串，命名链路直接 return —— 不写标题、不报错、不重试，语音开的线程就永久停在
Discord 给的开场名上（2026-11-03 实测过一整条会话）。

修法：只有真正可命名的文本才占用 title_user_message，否则让它为空、走转写正文兜底。
"""

from __future__ import annotations

import types
from unittest.mock import patch

import pytest

from gateway.run_turn_prepare import _title_user_message_for_turn

PLACEHOLDER = "(The user sent a message with no text content)"


def _event(text):
    return types.SimpleNamespace(text=text)


def test_a_captionless_voice_note_does_not_claim_the_title_slot():
    assert _title_user_message_for_turn(_event(PLACEHOLDER)) is None


def test_a_sender_prefixed_voice_placeholder_does_not_claim_the_title_slot():
    """多用户线程在 STT 之前就打上 ``[发言人]`` 前缀，占位串要被一起剥掉。"""
    assert _title_user_message_for_turn(_event(f"[RidingAColt] {PLACEHOLDER}")) is None


def test_real_typed_text_still_names_the_session():
    assert _title_user_message_for_turn(_event("看看这个线程名对不对")) == "看看这个线程名对不对"


@pytest.mark.parametrize("text", [None, "", "   "])
def test_an_empty_opener_falls_back_too(text):
    assert _title_user_message_for_turn(_event(text)) is None


class _TitlingAgent:
    """Only what ``_maybe_title_session_at_turn_start`` reads off an agent."""

    def __init__(self):
        self.platform = "discord"
        self.session_id = "sess-1"
        self.model = "test/model"
        self.provider = "openrouter"
        self.base_url = "https://openrouter.ai/api/v1"
        self.api_key = "sk-x"
        self.api_mode = "chat_completions"
        self._session_db = types.SimpleNamespace()
        self._session_db_created = True
        self._on_session_title = None


def test_the_transcript_then_drives_the_title():
    """把手让空之后，进场的就是转写正文 —— 命名真的会发生。"""
    from agent import turn_context

    transcript = "[RidingAColt] 我终于把网关重启了，测一下线程改名"
    with patch("agent.title_generator.maybe_auto_title") as titler:
        turn_context._maybe_title_session_at_turn_start(
            _TitlingAgent(), [{"role": "user", "content": transcript}], None,
        )
    assert titler.called
    assert "网关重启" in titler.call_args.args[2]
