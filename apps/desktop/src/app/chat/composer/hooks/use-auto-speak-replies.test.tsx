import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { assistantTextPart, type ChatMessage, chatMessageText } from '@/lib/chat-messages'
import {
  assistantTurnKey,
  clearSpokenRepliesForTests,
  markAssistantIdSpoken,
  resolveSpokenReply
} from '@/lib/spoken-reply'
import { playSpeechText, startSpeechStream } from '@/lib/voice-playback'
import { $voicePlayback, setVoicePlaybackState } from '@/store/voice-playback'
import { $autoSpeakReplies } from '@/store/voice-prefs'

import { ComposerScopeProvider, MAIN_COMPOSER_SCOPE } from '../scope'

import { clearOwnedSpeechTurnsForTests, clearReadTurnsForTests, useAutoSpeakReplies } from './use-auto-speak-replies'

vi.mock('@/lib/voice-playback', () => ({
  playSpeechText: vi.fn(),
  startSpeechStream: vi.fn(async () => null)
}))

const SESSION_ID = 'session-under-test'
const IDLE_STATE = { audioElement: null, messageId: null, sequence: 0, source: null, status: 'idle' as const }

function assistantMessage(id: string, text: string): ChatMessage {
  return { id, parts: [assistantTextPart(text)], role: 'assistant' }
}

// #93515 — Edge TTS has no chunked-PCM API, so the WS attempt in
// playSpeechText's fallback ladder settles 'fallback' before any audio plays
// and the client retries over the POST endpoint. While that POST round-trip
// is in flight, the backend can rewrite the just-completed reply's renderer
// id (`assistant-stream-*`) to its durable id. The issue claims
// `resolveSpokenReply()` fails to follow that rewrite and the reply gets
// spoken a second time once `$voicePlayback` goes idle.
describe('useAutoSpeakReplies — Edge TTS fallback chain (#93515)', () => {
  afterEach(() => {
    cleanup()
    clearSpokenRepliesForTests()
    clearOwnedSpeechTurnsForTests()
    clearReadTurnsForTests()
    $autoSpeakReplies.set(false)
    setVoicePlaybackState({ ...IDLE_STATE })
    vi.clearAllMocks()
  })

  it('does not re-speak the reply once playback goes idle after an id rewrite mid-fallback', async () => {
    $autoSpeakReplies.set(true)

    const $messages = atom<ChatMessage[]>([])

    // The exact pendingReply/markSpoken contract use-composer-voice.ts wires
    // up for this hook, backed by the real ordinal-anchored dedupe.
    const pendingReply = () => {
      const messages = $messages.get()
      const last = messages.findLast(m => m.role === 'assistant' && !m.hidden)
      const spoken = resolveSpokenReply(SESSION_ID, messages)

      if (!last || last.id === spoken?.id) {
        return null
      }

      return { id: last.id, pending: Boolean(last.pending), text: chatMessageText(last) }
    }

    const markSpoken = () => {
      const messages = $messages.get()
      const last = messages.findLast(m => m.role === 'assistant' && !m.hidden)

      if (last) {
        markAssistantIdSpoken(SESSION_ID, messages, last.id)
      }
    }

    let settleFallback: (() => void) | null = null

    vi.mocked(playSpeechText).mockImplementation(async () => {
      setVoicePlaybackState({
        audioElement: null,
        messageId: 'assistant-stream-1',
        sequence: 0,
        source: 'read-aloud',
        status: 'preparing'
      })

      // Holds mid-ladder — the WS-fallback-then-POST round trip the issue
      // describes — until the test rewrites the message id underneath it.
      await new Promise<void>(resolve => {
        settleFallback = resolve
      })

      $messages.set([assistantMessage('durable-42', 'hello there')])

      setVoicePlaybackState({
        audioElement: null,
        messageId: 'durable-42',
        sequence: 0,
        source: 'read-aloud',
        status: 'idle'
      })

      return true
    })

    renderHook(
      () =>
        useAutoSpeakReplies({
          conversationActive: false,
          failureLabel: 'read-aloud failed',
          markSpoken,
          pendingReply,
          sessionId: SESSION_ID
        }),
      {
        wrapper: ({ children }) => (
          <ComposerScopeProvider value={{ ...MAIN_COMPOSER_SCOPE, $messages }}>{children}</ComposerScopeProvider>
        )
      }
    )

    act(() => {
      $messages.set([assistantMessage('assistant-stream-1', 'hello there')])
    })

    await waitFor(() => expect(playSpeechText).toHaveBeenCalledTimes(1))

    await act(async () => {
      settleFallback?.()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect($voicePlayback.get().status).toBe('idle')
    expect(playSpeechText).toHaveBeenCalledTimes(1)
  })

  it('speaks a tool-folded rewrite once when the assistant ordinal drifts', async () => {
    $autoSpeakReplies.set(true)

    const $messages = atom<ChatMessage[]>([])

    const pendingReply = () => {
      const messages = $messages.get()
      const last = messages.findLast(m => m.role === 'assistant' && !m.hidden)
      const spoken = resolveSpokenReply(SESSION_ID, messages)

      if (!last || last.id === spoken?.id) {
        return null
      }

      return { id: last.id, pending: Boolean(last.pending), text: chatMessageText(last), turnKey: `${SESSION_ID}:0` }
    }

    const markSpoken = () => {
      const messages = $messages.get()
      const last = messages.findLast(m => m.role === 'assistant' && !m.hidden)

      if (last) {
        markAssistantIdSpoken(SESSION_ID, messages, last.id)
      }
    }

    let settlePlayback: (() => void) | null = null

    vi.mocked(playSpeechText).mockImplementation(async () => {
      setVoicePlaybackState({
        audioElement: null,
        messageId: 'assistant-stream-1',
        sequence: 1,
        source: 'read-aloud',
        status: 'preparing'
      })

      await new Promise<void>(resolve => {
        settlePlayback = resolve
      })

      // Tool rows fold into one durable bubble. The assistant ordinal moves.
      $messages.set([
        { id: 'u1', parts: [assistantTextPart('do the thing')], role: 'user' },
        assistantMessage('durable-42', 'the folded answer')
      ])
      setVoicePlaybackState({ ...IDLE_STATE })

      return true
    })

    renderHook(
      () =>
        useAutoSpeakReplies({
          conversationActive: false,
          failureLabel: 'read-aloud failed',
          markSpoken,
          pendingReply,
          sessionId: SESSION_ID
        }),
      {
        wrapper: ({ children }) => (
          <ComposerScopeProvider value={{ ...MAIN_COMPOSER_SCOPE, $messages }}>{children}</ComposerScopeProvider>
        )
      }
    )

    act(() => {
      $messages.set([
        { id: 'u1', parts: [assistantTextPart('do the thing')], role: 'user' },
        assistantMessage('narration', 'checking'),
        assistantMessage('tool-segment', 'ran the tool'),
        assistantMessage('assistant-stream-1', 'the folded answer')
      ])
    })

    await waitFor(() => expect(playSpeechText).toHaveBeenCalledTimes(1))

    await act(async () => {
      settlePlayback?.()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect($voicePlayback.get().status).toBe('idle')
    expect(playSpeechText).toHaveBeenCalledTimes(1)
  })

  it('does not consume a reply when markSpoken runs before a play that never starts', async () => {
    $autoSpeakReplies.set(true)

    const $messages = atom<ChatMessage[]>([])

    const pendingReply = () => {
      const messages = $messages.get()
      const last = messages.findLast(m => m.role === 'assistant' && !m.hidden)
      const spoken = resolveSpokenReply(SESSION_ID, messages)

      if (!last || last.id === spoken?.id) {
        return null
      }

      return { id: last.id, pending: false, text: chatMessageText(last) }
    }

    const markSpoken = () => {
      const messages = $messages.get()
      const last = messages.findLast(m => m.role === 'assistant' && !m.hidden)

      if (last) {
        markAssistantIdSpoken(SESSION_ID, messages, last.id)
      }
    }

    vi.mocked(playSpeechText).mockResolvedValue(false)

    renderHook(
      () =>
        useAutoSpeakReplies({
          conversationActive: false,
          failureLabel: 'read-aloud failed',
          markSpoken,
          pendingReply,
          sessionId: SESSION_ID
        }),
      {
        wrapper: ({ children }) => (
          <ComposerScopeProvider value={{ ...MAIN_COMPOSER_SCOPE, $messages }}>{children}</ComposerScopeProvider>
        )
      }
    )

    act(() => {
      $messages.set([assistantMessage('assistant-stream-1', 'hello there')])
    })

    await waitFor(() => expect(playSpeechText).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(resolveSpokenReply(SESSION_ID, $messages.get())).toBeNull())
  })

  it('speaks a later turn that says the same thing', async () => {
    $autoSpeakReplies.set(true)

    const $messages = atom<ChatMessage[]>([])

    const pendingReply = () => {
      const messages = $messages.get()
      const last = messages.findLast(m => m.role === 'assistant' && !m.hidden)
      const spoken = resolveSpokenReply(SESSION_ID, messages)

      if (!last || last.id === spoken?.id) {
        return null
      }

      return { id: last.id, pending: false, text: chatMessageText(last) }
    }

    const markSpoken = () => {
      const messages = $messages.get()
      const last = messages.findLast(m => m.role === 'assistant' && !m.hidden)

      if (last) {
        markAssistantIdSpoken(SESSION_ID, messages, last.id)
      }
    }

    vi.mocked(playSpeechText).mockResolvedValue(true)

    renderHook(
      () =>
        useAutoSpeakReplies({
          conversationActive: false,
          failureLabel: 'read-aloud failed',
          markSpoken,
          pendingReply,
          sessionId: SESSION_ID
        }),
      {
        wrapper: ({ children }) => (
          <ComposerScopeProvider value={{ ...MAIN_COMPOSER_SCOPE, $messages }}>{children}</ComposerScopeProvider>
        )
      }
    )

    act(() => {
      $messages.set([
        { id: 'u1', parts: [assistantTextPart('again')], role: 'user' },
        assistantMessage('assistant-stream-1', 'Done.')
      ])
    })
    await waitFor(() => expect(playSpeechText).toHaveBeenCalledTimes(1))

    act(() => {
      $messages.set([
        { id: 'u1', parts: [assistantTextPart('again')], role: 'user' },
        assistantMessage('durable-1', 'Done.'),
        { id: 'u2', parts: [assistantTextPart('again')], role: 'user' },
        assistantMessage('assistant-stream-2', 'Done.')
      ])
    })
    await waitFor(() => expect(playSpeechText).toHaveBeenCalledTimes(2))
  })
})

// A turn with tool calls speaks several bubbles under ONE user turn: progress
// updates, then the final reply. Keyed on the turn alone, the progress update's
// cross-window speech claim (held for minutes) refused the final reply, and
// the reply (already marked spoken) never reached TTS.
describe('useAutoSpeakReplies — final reply after tool calls', () => {
  afterEach(() => {
    cleanup()
    clearSpokenRepliesForTests()
    clearOwnedSpeechTurnsForTests()
    $autoSpeakReplies.set(false)
    setVoicePlaybackState({ ...IDLE_STATE })
    delete (window as { hermesDesktop?: unknown }).hermesDesktop
    vi.clearAllMocks()
  })

  it('reads the final reply held behind a progress update of the same turn', async () => {
    // The main-process arbiter within its speech TTL: first claim of a key wins.
    const claimed = new Set<string>()

    ;(window as { hermesDesktop?: unknown }).hermesDesktop = {
      claimAmbientCue: async (key: string) => !claimed.has(key) && Boolean(claimed.add(key))
    }

    $autoSpeakReplies.set(true)

    const user = { id: 'u1', parts: [assistantTextPart('fix it')], role: 'user' } as ChatMessage
    const interim = { ...assistantMessage('assistant-interim-1', 'Looking into it.'), interim: true }
    const $messages = atom<ChatMessage[]>([user])

    // The pendingResponse / consumePendingResponse pair use-composer-voice.ts wires up.
    const pendingReply = () => {
      const messages = $messages.get()
      const last = messages.findLast(m => m.role === 'assistant' && !m.hidden)
      const spoken = resolveSpokenReply(SESSION_ID, messages)

      if (!last || last.id === spoken?.id) {
        return null
      }

      const text = chatMessageText(last).trim()

      return {
        id: last.id,
        pending: Boolean(last.pending),
        text,
        turnKey: assistantTurnKey(SESSION_ID, messages, last.id)
      }
    }

    const markSpoken = () => {
      const messages = $messages.get()
      const last = messages.findLast(m => m.role === 'assistant' && !m.hidden)

      if (last) {
        markAssistantIdSpoken(SESSION_ID, messages, last.id)
      }
    }

    vi.mocked(playSpeechText).mockImplementation(async (_text, options) => {
      setVoicePlaybackState({
        ...IDLE_STATE,
        messageId: options.messageId ?? null,
        source: 'read-aloud',
        status: 'speaking'
      })

      return true
    })

    renderHook(
      () =>
        useAutoSpeakReplies({
          conversationActive: false,
          failureLabel: 'read-aloud failed',
          markSpoken,
          pendingReply,
          sessionId: SESSION_ID
        }),
      {
        wrapper: ({ children }) => (
          <ComposerScopeProvider value={{ ...MAIN_COMPOSER_SCOPE, $messages }}>{children}</ComposerScopeProvider>
        )
      }
    )

    await act(async () => {
      $messages.set([user, interim])
    })
    expect(playSpeechText).toHaveBeenCalledTimes(1)

    // The final reply lands while the progress update is still playing: held.
    await act(async () => {
      $messages.set([user, interim, assistantMessage('assistant-stream-2', 'Here is the final report.')])
    })
    expect(playSpeechText).toHaveBeenCalledTimes(1)

    // The progress update's clip ends.
    await act(async () => {
      setVoicePlaybackState({ ...IDLE_STATE })
    })

    expect(playSpeechText).toHaveBeenCalledTimes(2)
    expect(playSpeechText).toHaveBeenLastCalledWith(
      'Here is the final report.',
      expect.objectContaining({ messageId: 'assistant-stream-2', source: 'read-aloud' })
    )
  })

  // 2026-11-07: 一轮回复被念了两遍。直播那条路先念完，封口那条路又整条念一次——
  // 已念标记挂在消息 id 上，hydrate 改写 id 后标记没跟过去，封口就以为没念过。
  // 现在按 turnKey 记死：同一轮只念一次，id 和文本怎么变都不影响。
  it('reads a turn once even when the text grows after it was already spoken', async () => {
    const claimed = new Set<string>()

    ;(window as { hermesDesktop?: unknown }).hermesDesktop = {
      claimAmbientCue: async (key: string) => !claimed.has(key) && Boolean(claimed.add(key))
    }

    $autoSpeakReplies.set(true)

    const $messages = atom<ChatMessage[]>([])
    let spokenId: string | null = null

    // 标记"失效"：不记录已念 id，模拟 hydrate 改写后标记没迁移过去
    const pendingReply = () => {
      const messages = $messages.get()
      const last = messages.findLast(m => m.role === 'assistant' && !m.hidden)

      if (!last) {
        return null
      }

      return { id: last.id, pending: false, text: chatMessageText(last), turnKey: `${SESSION_ID}:0` }
    }

    const markSpoken = () => {
      const messages = $messages.get()
      const last = messages.findLast(m => m.role === 'assistant' && !m.hidden)

      spokenId = last?.id ?? null
    }

    vi.mocked(playSpeechText).mockResolvedValue(true)

    renderHook(
      () =>
        useAutoSpeakReplies({
          conversationActive: false,
          failureLabel: 'read-aloud failed',
          markSpoken,
          pendingReply,
          sessionId: SESSION_ID
        }),
      {
        wrapper: ({ children }) => (
          <ComposerScopeProvider value={{ ...MAIN_COMPOSER_SCOPE, $messages }}>{children}</ComposerScopeProvider>
        )
      }
    )

    act(() => {
      $messages.set([assistantMessage('durable-7', '第一段。')])
    })

    await waitFor(() => expect(playSpeechText).toHaveBeenCalledTimes(1))

    // 同一轮的文本继续长（或 hydrate 换了 id）：不能再开一次播报
    await act(async () => {
      $messages.set([assistantMessage('durable-7', '第一段。第二段。')])
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(spokenId).toBe('durable-7')
    expect(playSpeechText).toHaveBeenCalledTimes(1)
  })

  // 多段回复（思考后还有第二段）里，第二段不能被当成"已念"。
  // 旧逻辑收尾时标的是"最后一条助手消息"，封口等待期间第二段已经到场，
  // 于是被标掉、再也不读（2026-11-07）。
  it('reads the follow-up segment of a multi-part turn', async () => {
    cleanup()
    clearOwnedSpeechTurnsForTests()
    clearReadTurnsForTests()
    clearSpokenRepliesForTests()
    setVoicePlaybackState(IDLE_STATE)

    const claimed = new Set<string>()

    ;(window as { hermesDesktop?: unknown }).hermesDesktop = {
      claimAmbientCue: async (key: string) => !claimed.has(key) && Boolean(claimed.add(key))
    }

    $autoSpeakReplies.set(true)

    const $messages = atom<ChatMessage[]>([])
    const spoken = new Set<string>()

    const markSpoken = vi.fn((replyId?: string, _chars?: number) => {
      const list = $messages.get()
      const target = replyId
        ? list.find(message => message.id === replyId)
        : list.findLast(message => message.role === 'assistant' && !message.hidden)

      if (target) {
        spoken.add(target.id)
      }
    })

    const pendingReply = () => {
      const next = $messages
        .get()
        .findLast(message => message.role === 'assistant' && !message.hidden && !spoken.has(message.id))

      return next
        ? { id: next.id, pending: false, text: chatMessageText(next), turnKey: `${SESSION_ID}:0` }
        : null
    }

    vi.mocked(playSpeechText).mockResolvedValue(true)

    renderHook(
      () =>
        useAutoSpeakReplies({
          conversationActive: false,
          failureLabel: 'read-aloud failed',
          markSpoken,
          pendingReply,
          sessionId: SESSION_ID
        }),
      {
        wrapper: ({ children }) => (
          <ComposerScopeProvider value={{ ...MAIN_COMPOSER_SCOPE, $messages }}>{children}</ComposerScopeProvider>
        )
      }
    )

    act(() => {
      $messages.set([assistantMessage('bubble-1', '第一段。')])
    })

    await waitFor(() => expect(playSpeechText).toHaveBeenCalledTimes(1))
    // 标的是刚念的那一条，不是"最后一条"——否则第二段一到场就被标成已念
    expect(markSpoken).toHaveBeenCalledWith('bubble-1', 4)

    // 思考之后第二段到场：它必须也被念
    await act(async () => {
      $messages.set([assistantMessage('bubble-1', '第一段。'), assistantMessage('bubble-2', '第二段。')])
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => expect(playSpeechText).toHaveBeenCalledTimes(2))
    expect(playSpeechText).toHaveBeenNthCalledWith(2, '第二段。', expect.anything())
    expect(spoken.has('bubble-2')).toBe(true)
  })

  // 工具调用之后还有第二段：它到场时第一段的流式会话还开着，旧代码把它当
  // "不是同一条的延续"直接 return，等会话关掉又没有事件重试，第二段永远不念
  // （2026-11-07，讲述北风与太阳的故事）。
  it('opens a second pass when a new bubble arrives mid-stream', async () => {
    cleanup()
    clearOwnedSpeechTurnsForTests()
    clearReadTurnsForTests()
    clearSpokenRepliesForTests()
    setVoicePlaybackState(IDLE_STATE)

    const claimed = new Set<string>()

    ;(window as { hermesDesktop?: unknown }).hermesDesktop = {
      claimAmbientCue: async (key: string) => !claimed.has(key) && Boolean(claimed.add(key))
    }

    $autoSpeakReplies.set(true)

    const $messages = atom<ChatMessage[]>([])
    const sessions: { append: ReturnType<typeof vi.fn>; finish: ReturnType<typeof vi.fn> }[] = []

    vi.mocked(startSpeechStream).mockImplementation(async () => {
      const session = { append: vi.fn(), finish: vi.fn(), done: new Promise<'done'>(() => {}) }

      sessions.push(session)

      return session as never
    })

    const pending = (id: string, text: string): ChatMessage => ({ ...assistantMessage(id, text), pending: true })

    const markSpoken = vi.fn()

    const pendingReply = () => {
      const last = $messages.get().findLast(message => message.role === 'assistant' && !message.hidden)

      return last ? { id: last.id, pending: true, text: chatMessageText(last), turnKey: `${SESSION_ID}:0` } : null
    }

    renderHook(
      () =>
        useAutoSpeakReplies({
          conversationActive: false,
          failureLabel: 'read-aloud failed',
          markSpoken,
          pendingReply,
          sessionId: SESSION_ID
        }),
      {
        wrapper: ({ children }) => (
          <ComposerScopeProvider value={{ ...MAIN_COMPOSER_SCOPE, $messages }}>{children}</ComposerScopeProvider>
        )
      }
    )

    act(() => {
      $messages.set([pending('bubble-1', '第一段。')])
    })

    await waitFor(() => expect(sessions).toHaveLength(1))
    expect(sessions[0].append).toHaveBeenCalledWith('第一段。')

    // 第二段到场：先收掉第一段，再为它开新的一轮
    await act(async () => {
      $messages.set([pending('bubble-1', '第一段。'), pending('bubble-2', '第二段。')])
      await Promise.resolve()
    })

    await waitFor(() => expect(sessions).toHaveLength(2))
    expect(sessions[0].finish).toHaveBeenCalled()
    expect(sessions[1].append).toHaveBeenCalledWith('第二段。')
  })
})
