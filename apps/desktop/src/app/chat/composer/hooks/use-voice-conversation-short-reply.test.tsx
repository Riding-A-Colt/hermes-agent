import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { type ChatMessage, collectUnspokenTurnSpeech } from '@/lib/chat-messages'
import { stopVoicePlayback } from '@/lib/voice-playback'
import { $autoSpeakReplies } from '@/store/voice-prefs'

import { useVoiceConversation } from './use-voice-conversation'

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  spoken: [] as string[],
  mic: {
    cancel: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => ({
      audio: new Blob(['fixture']),
      heardSpeech: true,
      durationMs: 900
    }))
  }
}))

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getApiRequestConnection: () => null,
  getApiRequestProfile: () => null,
  hermesApi: mocks.config,
  speakText: (text: string) => {
    mocks.spoken.push(text)

    return Promise.resolve({ data_url: 'blob:fixture' })
  }
}))
vi.mock('@/api/client', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ownerScoped: (value: unknown) => value ?? {},
  profileScoped: (value: unknown) => value
}))
vi.mock('./use-mic-recorder', () => ({ useMicRecorder: () => ({ handle: mocks.mic, level: 0 }) }))
vi.mock('@/lib/voice-barge-in', () => ({ monitorSpeechDuringPlayback: () => vi.fn() }))
vi.mock('@/lib/thinking-sound', () => ({ startThinkingSound: vi.fn(), stopThinkingSound: vi.fn() }))
vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: { notifications: { voice: {} } } }) }))

class TestAudio extends EventTarget {
  static instances: TestAudio[] = []
  src: string
  constructor(src: string) {
    super()
    this.src = src
    TestAudio.instances.push(this)
  }
  play = vi.fn(async () => undefined)
  pause = vi.fn()
  load = vi.fn()
}

afterEach(() => {
  $autoSpeakReplies.set(false)
  cleanup()
  stopVoicePlayback()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('still speaks a reply shorter than the sentence floor', async () => {
  $autoSpeakReplies.set(true)
  vi.useFakeTimers()
  TestAudio.instances = []
  vi.stubGlobal('Audio', TestAudio)
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:fixture')
      static revokeObjectURL = vi.fn()
    }
  )
  mocks.config.mockResolvedValue({
    ok: true,
    stt: { mode: 'relay' },
    tts: {
      mode: 'direct',
      wire: 'openai-speech',
      provider: 'openai',
      base_url: 'https://tts.invalid/v1',
      api_key: 'fixture-only',
      model: 'tts-fixture',
      voice: 'fixture',
      speed: null
    }
  })
  mocks.spoken.length = 0
  // 2 个字：「一加一等于几？」的回答就是这种长度——低于客户端 24 字的切句门槛。
  const reply = '2。'
  const messages: ChatMessage[] = []

  const hook = renderHook(
    ({ busy }) =>
      useVoiceConversation({
        busy,
        enabled: true,
        consumePendingResponse: vi.fn(),
        onSubmit: vi.fn(async () => {
          hook.rerender({ busy: true })
        }),
        onTranscribeAudio: async () => '一加一等于几',
        pendingResponse: () => collectUnspokenTurnSpeech(messages, null)
      }),
    { initialProps: { busy: false } }
  )

  await act(async () => {
    await hook.result.current.start()
  })
  await act(async () => {
    hook.result.current.stopTurn()
  })

  messages.push({ id: 'a1', role: 'assistant', pending: true, parts: [{ type: 'text', text: reply }] })
  hook.rerender({ busy: true })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })

  messages[0].pending = false
  hook.rerender({ busy: false })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })

  expect(mocks.spoken).toEqual([reply])
})

it('speaks a short reply whose bubble vanishes before the turn settles', async () => {
  // 语音会话里很短的回复（「2。」「7。」）不会走到句界，原文只存在客户端缓冲里。
  // 如果气泡在忙碌期间被消费掉，旧代码直接 finish()，这段文字就永远没送出去——
  // 表现为一直「正在准备音频」且日志里一次合成都没有。
  $autoSpeakReplies.set(true)
  vi.useFakeTimers()
  TestAudio.instances = []
  vi.stubGlobal('Audio', TestAudio)
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:fixture')
      static revokeObjectURL = vi.fn()
    }
  )
  mocks.config.mockResolvedValue({
    ok: true,
    stt: { mode: 'relay' },
    tts: {
      mode: 'direct',
      wire: 'openai-speech',
      provider: 'openai',
      base_url: 'https://tts.invalid/v1',
      api_key: 'fixture-only',
      model: 'tts-fixture',
      voice: 'fixture',
      speed: null
    }
  })
  mocks.spoken.length = 0
  const messages: ChatMessage[] = []

  const hook = renderHook(
    ({ busy }) =>
      useVoiceConversation({
        busy,
        enabled: true,
        consumePendingResponse: vi.fn(),
        onSubmit: vi.fn(async () => {
          hook.rerender({ busy: true })
        }),
        onTranscribeAudio: async () => '一加一等于几',
        pendingResponse: () => collectUnspokenTurnSpeech(messages, null)
      }),
    { initialProps: { busy: false } }
  )

  await act(async () => {
    await hook.result.current.start()
  })
  await act(async () => {
    hook.result.current.stopTurn()
  })

  messages.push({ id: 'a2', role: 'assistant', pending: true, parts: [{ type: 'text', text: '2。' }] })
  hook.rerender({ busy: true })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })

  // 气泡被消费掉（会话视图重建），客户端手里只剩还没送出的那一小段。
  messages.length = 0
  hook.rerender({ busy: false })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })

  expect(mocks.spoken).toEqual(['2。'])
})
