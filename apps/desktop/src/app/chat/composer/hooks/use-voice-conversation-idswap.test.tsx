import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setVoicePlaybackState } from '@/store/voice-playback'
import { $autoSpeakReplies, $ttsStreamsSpeech } from '@/store/voice-prefs'

import type { MicRecording } from './use-mic-recorder'
import { useVoiceConversation } from './use-voice-conversation'

// Regression: the streaming bubble is swapped for the durable message id the
// moment the reply seals, while the text it carries is the same reply only
// longer. Comparing ids strictly declared "not this reply" on that first tick
// and finished the session — the spoken audio stopped mid-word and the last
// clause (「…还是你自己有安排？」) never reached TTS.

const appended: string[] = []
let finishCount = 0

const startSpeechStream = vi.hoisted(() =>
  vi.fn(async (_options: unknown) => ({
    append: (text: string) => appended.push(text),
    // Never settles on its own: the feed loop must stay alive while the reply
    // is still being written.
    done: new Promise<never>(() => undefined),
    finish: () => {
      finishCount += 1
    },
    flush: () => undefined
  }))
)

vi.mock('@/lib/voice-barge-in', () => ({
  monitorSpeechDuringPlayback: () => () => undefined
}))

vi.mock('@/lib/voice-playback', () => ({
  markVoicePlaybackInterrupted: () => undefined,
  playSpeechText: async () => true,
  startSpeechChain: () => ({
    append: () => undefined,
    done: new Promise(() => undefined),
    finish: () => undefined,
    flush: () => undefined
  }),
  startSpeechStream: (options: unknown) => startSpeechStream(options),
  stopVoicePlayback: () => undefined,
  takeVoicePlaybackInterrupted: () => true
}))

vi.mock('@/lib/thinking-sound', () => ({
  startThinkingSound: () => undefined,
  stopThinkingSound: () => undefined
}))

const micHandle = {
  cancel: vi.fn(),
  start: vi.fn(async () => undefined),
  stop: vi.fn<() => Promise<MicRecording | null>>(async () => null)
}

vi.mock('./use-mic-recorder', () => ({
  useMicRecorder: () => ({ handle: micHandle, level: 0, recording: false })
}))

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      notifications: {
        voice: {
          configureSpeechToText: 'configure STT',
          couldNotStartSession: 'could not start',
          microphoneFailed: 'mic failed',
          playbackFailed: 'playback failed',
          transcriptionFailed: 'transcription failed',
          unavailable: 'unavailable'
        }
      }
    }
  })
}))

vi.mock('@/store/notifications', () => ({
  notify: () => undefined,
  notifyError: () => undefined
}))

const STREAMING = '要不要我先看一眼'
const SEALED = '要不要我先看一眼今天该干的事，还是你自己有安排？'

describe('useVoiceConversation streaming reply across an id swap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    appended.length = 0
    finishCount = 0
    // "Read replies aloud" off turns Voice Chat into STT-only (no speech at
    // all); a cloud provider routes to speakWholeReply instead of the stream.
    $autoSpeakReplies.set(true)
    $ttsStreamsSpeech.set(true)
    // Module-level playback state outlives a file: a leftover 'speaking' here
    // makes the next turn hold instead of opening its own stream.
    setVoicePlaybackState({ audioElement: null, messageId: null, sequence: 0, source: null, status: 'idle' })
    micHandle.start.mockResolvedValue(undefined)
    micHandle.stop.mockResolvedValue(null)
  })

  afterEach(cleanup)

  it('keeps feeding the same reply after its bubble id changes, and speaks the tail', async () => {
    let reply: null | { id: string; pending: boolean; text: string } = null

    const hook = renderHook(({ busy }: { busy: boolean }) =>
      useVoiceConversation({
        busy,
        consumePendingResponse: vi.fn(),
        enabled: true,
        onStopWord: vi.fn(),
        onSubmit: vi.fn(),
        onTranscribeAudio: async () => 'go',
        pendingResponse: () => reply
      }), { initialProps: { busy: false } }
    )

    // The conversation is entered from a quiet state (the user opens Voice
    // Chat); startListening() refuses to open the mic while the agent is busy.
    await act(async () => {
      await hook.result.current.start()
    })
    await waitFor(() => expect(hook.result.current.status).toBe('listening'))

    // The answer's turn is in flight: the agent is busy while it writes.
    hook.rerender({ busy: true })
    await waitFor(() => expect(hook.result.current.status).toBe('listening'))

    reply = { id: 'assistant-stream-1', pending: true, text: STREAMING }
    micHandle.stop.mockResolvedValueOnce({
      audio: new Blob(['q'], { type: 'audio/webm' }),
      durationMs: 900,
      heardSpeech: true
    })

    // stopTurn() is fire-and-forget: the turn closes once the take is
    // transcribed and submitted.
    await act(async () => {
      hook.result.current.stopTurn()
    })
    await waitFor(() => expect(startSpeechStream).toHaveBeenCalledTimes(1))

    // A cut shorter than the minimum sentence length stays buffered until the
    // reply seals — nothing is spoken mid-clause.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 350))
    })
    expect(appended.join('')).toBe('')

    // The seal swaps the id; the rest of the sentence lands a beat later.
    reply = { id: 'msg-42', pending: false, text: SEALED }

    await waitFor(() => expect(appended.join('')).toContain('还是你自己有安排'), { timeout: 5000 })

    // One session, one seal — the id change neither restarted nor double-closed it.
    expect(startSpeechStream).toHaveBeenCalledTimes(1)

    // The turn ends: with nothing else in flight the session seals instead of
    // flushing a provisional tail.
    hook.rerender({ busy: false })
    await waitFor(() => expect(finishCount).toBe(1))
  })
})
