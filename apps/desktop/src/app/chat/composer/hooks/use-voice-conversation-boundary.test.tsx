import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { type ChatMessage, collectUnspokenTurnSpeech } from '@/lib/chat-messages'
import { stopVoicePlayback } from '@/lib/voice-playback'
import { $autoSpeakReplies } from '@/store/voice-prefs'

import { useVoiceConversation } from './use-voice-conversation'

// 播报契约（2026-10-29 改）：回复生成期间不说话；整条回复落定后一次性发音。
// 早先的实现在气泡封印时就把完整句子推给服务端逐句合成，中文回复因此被切成
// 多段、段间各弹一次「正在准备音频」，长回复还会只念前半。

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

it('waits for the whole reply, then speaks it in one synthesis', async () => {
  // This test drives the TTS playback path, gated by the read-aloud toggle
  // (#44263); opt in like the app does when replies are spoken.
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
  const narration = 'Let me check the live state of the branch.'
  const answer = 'The branch is clean and the check is complete.'
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
        onTranscribeAudio: async () => 'Check the branch',
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
  messages.push({ id: 'narration', role: 'assistant', pending: true, parts: [{ type: 'text', text: narration }] })
  hook.rerender({ busy: true })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })
  // 生成途中一个字都不该合成：逐句合成正是「正在准备音频」反复弹出的来源。
  expect(mocks.spoken).toEqual([])
  messages[0].pending = false
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })
  // 回合还没结束（工具还在跑），仍然不说话。
  expect(mocks.spoken).toEqual([])
  expect(TestAudio.instances).toHaveLength(0)
  messages.push({ id: 'answer', role: 'assistant', pending: false, parts: [{ type: 'text', text: answer }] })
  hook.rerender({ busy: false })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })
  // 整轮落定：两句合成一次，一个音频、播一遍。
  expect(mocks.spoken).toEqual([`${narration} ${answer}`])
  expect(TestAudio.instances).toHaveLength(1)
  expect(TestAudio.instances[0].play).toHaveBeenCalledOnce()
})
