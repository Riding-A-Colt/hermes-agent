import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $voicePlayback } from '@/store/voice-playback'
import { $autoSpeakReplies, $ttsStreamsSpeech } from '@/store/voice-prefs'

import { useVoiceConversation } from './use-voice-conversation'

// 播报契约（2026-10-29 改）：整条回复落定后再一次性发音，不再边生成边按句朗读。
// 原因：command 型 provider（asuka / kokoro）每句都要起一次脚本进程，逐句播放会在
// 段与段之间各弹一次「正在准备音频」，长回复还会只念前半。
// 因此这里钉住的是一句话：**只在回复 sealed 之后调用一次 playSpeechText**。

const mocks = vi.hoisted(() => {
  let deferPlayback = false
  let onSilence: null | (() => void) = null
  let resolvePlayback: null | ((played: boolean) => void) = null

  const stopVoicePlayback = vi.fn(() => {
    const current = $voicePlayback.get()
    $voicePlayback.set({ ...current, sequence: current.sequence + 1, status: 'idle' })
  })

  const playSpeechText = vi.fn(() => {
    stopVoicePlayback()

    if (deferPlayback) {
      return new Promise<boolean>(resolve => {
        resolvePlayback = resolve
      })
    }

    return Promise.resolve(true)
  })

  const chainAppends: string[] = []
  const startSpeechChain = vi.fn(() => ({
    append: (text: string) => chainAppends.push(text),
    done: new Promise<'done' | 'fallback'>(() => undefined),
    finish: vi.fn(),
    flush: vi.fn()
  }))

  const handle = {
    cancel: vi.fn(),
    start: vi.fn(async (options: { onSilence: () => void }) => {
      onSilence = options.onSilence
    }),
    stop: vi.fn(async () => ({
      audio: new Blob(['voice'], { type: 'audio/webm' }),
      heardSpeech: true
    }))
  }

  return {
    consumePendingResponse: vi.fn(),
    deferPlayback() {
      deferPlayback = true
    },
    finishPlayback() {
      resolvePlayback?.(true)
      resolvePlayback = null
    },
    handle,
    playSpeechText,
    chainAppends,
    startSpeechChain,
    resetSpeechMocks() {
      deferPlayback = false
      resolvePlayback = null
    },
    stopVoicePlayback,
    triggerSilence() {
      onSilence?.()
    }
  }
})

vi.mock('./use-mic-recorder', () => ({
  useMicRecorder: () => ({ handle: mocks.handle, level: 0 })
}))

vi.mock('@/lib/voice-barge-in', () => ({
  monitorSpeechDuringPlayback: () => vi.fn()
}))

vi.mock('@/lib/voice-playback', () => ({
  markVoicePlaybackInterrupted: vi.fn(),
  playSpeechText: mocks.playSpeechText,
  startSpeechChain: mocks.startSpeechChain,
  stopVoicePlayback: mocks.stopVoicePlayback,
  takeVoicePlaybackInterrupted: vi.fn(() => true)
}))

vi.mock('@/lib/thinking-sound', () => ({
  startThinkingSound: vi.fn(),
  stopThinkingSound: vi.fn()
}))

vi.mock('@/store/notifications', () => ({
  notify: vi.fn(),
  notifyError: vi.fn()
}))

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      notifications: {
        voice: {
          configureSpeechToText: '',
          couldNotStartSession: '',
          microphoneFailed: '',
          playbackFailed: '',
          transcriptionFailed: '',
          unavailable: ''
        }
      }
    }
  })
}))

const IDLE = {
  audioElement: null,
  messageId: null,
  sequence: 0,
  source: null,
  status: 'idle' as const
}

function renderConversation(responseId: string, sealedText: string) {
  let response: null | { id: string; pending: boolean; text: string } = null

  const hook = renderHook(
    ({ enabled }) =>
      useVoiceConversation({
        busy: false,
        consumePendingResponse: mocks.consumePendingResponse,
        enabled,
        onSubmit: async () => {
          response = { id: responseId, pending: true, text: '' }
        },
        onTranscribeAudio: async () => 'Hello',
        pendingResponse: () => response
      }),
    { initialProps: { enabled: false } }
  )

  return {
    hook,
    setText(text: string) {
      if (response) {
        response = { ...response, text }
      }
    },
    seal(text = sealedText) {
      response = { id: responseId, pending: false, text }
    }
  }
}

async function beginReply(hook: ReturnType<typeof renderConversation>['hook']) {
  hook.rerender({ enabled: true })
  await waitFor(() => expect(mocks.handle.start).toHaveBeenCalledTimes(1))

  await act(async () => {
    mocks.triggerSilence()
  })
}

describe('useVoiceConversation playback', () => {
  beforeEach(() => {
    // These tests exercise the TTS playback paths, which the read-aloud
    // toggle gates in useVoiceConversation (#44263); opt in like the app
    // does when replies are spoken.
    $autoSpeakReplies.set(true)
  })

  afterEach(() => {
    $autoSpeakReplies.set(false)
    cleanup()
    vi.clearAllMocks()
    mocks.resetSpeechMocks()
    $voicePlayback.set({ ...IDLE })
  })

  it('does not speak while the reply is still streaming', async () => {
    const { hook, setText } = renderConversation('reply-streaming', 'First part. Second part.')

    await beginReply(hook)
    setText('First part. ')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 400))
    })

    expect(mocks.playSpeechText).not.toHaveBeenCalled()
  })

  it('speaks the whole sealed reply once, then re-arms the microphone', async () => {
    const { hook, seal } = renderConversation('reply-whole', 'Hello back. And a second sentence.')

    await beginReply(hook)
    seal('Hello back. And a second sentence.')

    await waitFor(() =>
      expect(mocks.playSpeechText).toHaveBeenCalledWith(
        'Hello back. And a second sentence.',
        expect.objectContaining({ messageId: 'reply-whole', source: 'voice-conversation', syncOnly: true })
      )
    )
    // One playback for the whole reply — not one per sentence.
    expect(mocks.playSpeechText).toHaveBeenCalledTimes(1)

    await waitFor(() => expect(mocks.handle.start).toHaveBeenCalledTimes(2))
    // status flips to 'listening' only after start() resolves — poll for it.
    await waitFor(() => expect(hook.result.current.status).toBe('listening'))
  })

  it('keeps the loop live after playback resolves', async () => {
    mocks.deferPlayback()
    const { hook, seal } = renderConversation('reply-live', 'One line.')

    await beginReply(hook)
    seal('One line.')

    await waitFor(() => expect(mocks.playSpeechText).toHaveBeenCalledTimes(1))
    expect(mocks.handle.start).toHaveBeenCalledTimes(1)

    await act(async () => {
      mocks.finishPlayback()
    })

    await waitFor(() => expect(mocks.handle.start).toHaveBeenCalledTimes(2))
  })

  it('re-arms the microphone after an external Stop silences the reply', async () => {
    mocks.deferPlayback()
    const { hook, seal } = renderConversation('reply-stopped', 'Playing now.')

    await beginReply(hook)
    seal('Playing now.')
    await waitFor(() => expect(mocks.playSpeechText).toHaveBeenCalledTimes(1))

    mocks.stopVoicePlayback()
    await act(async () => {
      mocks.finishPlayback()
    })

    // Stop silences the reply, not the conversation: the mic re-arms.
    await waitFor(() => expect(mocks.handle.start).toHaveBeenCalledTimes(2))
    expect(mocks.playSpeechText).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(hook.result.current.status).toBe('listening'))
  })

  it('feeds sentences into the speech chain for a streaming voice', async () => {
    // kokoro 这种声明了 speech_stream 的音色：出字就念，但状态只准备一次。
    $ttsStreamsSpeech.set(true)

    try {
      const { hook, seal } = renderConversation('reply-local', '本地引擎回复。')

      await beginReply(hook)
      seal('本地引擎回复。')

      await waitFor(() => expect(mocks.startSpeechChain).toHaveBeenCalled())
      await waitFor(() => expect(mocks.chainAppends.join('')).toContain('本地引擎回复'))
      expect(mocks.playSpeechText).not.toHaveBeenCalled()
    } finally {
      $ttsStreamsSpeech.set(false)
    }
  })

  it('stops waiting for a seal once the hook unmounts', async () => {
    const { hook, setText } = renderConversation('reply-unmount', 'Never sealed.')

    await beginReply(hook)
    setText('still streaming')
    hook.unmount()
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 400))
    })

    expect(mocks.playSpeechText).not.toHaveBeenCalled()
  })
})
