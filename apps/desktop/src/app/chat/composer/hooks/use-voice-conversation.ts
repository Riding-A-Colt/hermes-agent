import { useCallback, useEffect, useRef, useState } from 'react'

import { type ResolvedOwner, resolveOwnerNow } from '@/hermes'
import { useI18n } from '@/i18n'
import { capSpeechText } from '@/lib/speech-text'
import { syncSttLease, VOICE_INPUT_LEASE } from '@/lib/stt-lease'
import { startThinkingSound, stopThinkingSound } from '@/lib/thinking-sound'
import { monitorSpeechDuringPlayback } from '@/lib/voice-barge-in'
import {
  markVoicePlaybackInterrupted,
  playSpeechText,
  stopVoicePlayback,
  takeVoicePlaybackInterrupted
} from '@/lib/voice-playback'
import { isVoiceStopCommand } from '@/lib/voice-stop-word'
import { isTtsEcho } from '@/lib/voice-tts-echo'
import { notify, notifyError } from '@/store/notifications'
import { $voicePlayback } from '@/store/voice-playback'
import {
  $autoSpeakReplies,
  $bargeInEnabled,
  $bargeInThresholdMultiplier,
  $voiceSilenceMs,
  currentSpeechLimit
} from '@/store/voice-prefs'

import { useComposerScope } from '../scope'

import { useMicRecorder } from './use-mic-recorder'

export type ConversationStatus = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking'

interface PendingVoiceResponse {
  id: string
  pending: boolean
  text: string
}

interface VoiceConversationOptions {
  busy: boolean
  enabled: boolean
  onFatalError?: () => void
  /** Interrupt the in-flight agent turn (the same seam as the Stop button).
   *  Fired when the user speaks while the model is still generating. */
  onInterrupt?: () => Promise<void> | void
  onStopWord?: () => void
  onSubmit: (text: string) => Promise<void> | void
  onTranscribeAudio?: (audio: Blob, owner?: ResolvedOwner) => Promise<string>
  pendingResponse: () => PendingVoiceResponse | null
  consumePendingResponse: () => void
  /** Surface a transcript that cannot be delivered as a turn (live busy never
   *  settled): park it in the composer input and focus it, so a spoken
   *  interruption is never silently dropped (#123357). */
  parkText?: (text: string) => void
  focusInput?: () => void
  /** Awaited right before the mic is opened. Used to let the wake-word listener
   *  fully release the capture device first, so the two never contend. */
  beforeMicOpen?: () => Promise<void> | void
}

/**
 * One voice conversation, from start() to end(). Its STT owner is resolved
 * once at start and used for every warm-up, transcription and the final
 * release. `warmup` is the latest listening start's warm-up: transcription
 * awaits it so a cold model load never runs inside the transcription
 * request's decode budget (#105955).
 */
interface Conversation {
  owner: ResolvedOwner
  warmup: Promise<void>
}

/** How long a barge-triggered interrupt may take to settle before we submit
 *  the captured utterance anyway. */
const INTERRUPT_SETTLE_TIMEOUT_MS = 5_000

/** A take whose level meter died is sent to STT (the meter can't say whether
 *  it heard speech) unless it is shorter than this. */
const METER_FAILURE_MIN_CLIP_MS = 750

/** Back-to-back takes with a dead meter mean the device isn't recovering;
 *  stop and say so rather than re-arm forever. */
const METER_FAILURE_LIMIT = 2

export function useVoiceConversation({
  busy,
  enabled,
  onFatalError,
  onInterrupt,
  onStopWord,
  onSubmit,
  onTranscribeAudio,
  pendingResponse,
  consumePendingResponse,
  parkText,
  focusInput,
  beforeMicOpen
}: VoiceConversationOptions) {
  const { t } = useI18n()
  const voiceCopy = t.notifications.voice
  const { handle, level } = useMicRecorder(voiceCopy)
  // The scope's session owner (a Bot's own connection + profile) picks the TTS
  // voice; a ref keeps the long-lived turn closures below reading the current
  // value.
  const { connectionId: ownerConnectionId, profile: ownerProfile } = useComposerScope()
  const ownerRef = useRef({ connectionId: ownerConnectionId, profile: ownerProfile })
  ownerRef.current = { connectionId: ownerConnectionId, profile: ownerProfile }
  const [status, setStatus] = useState<ConversationStatus>('idle')
  const [muted, setMuted] = useState(false)
  const turnTimeoutRef = useRef<number | null>(null)
  const pendingStartRef = useRef(false)
  const turnClosingRef = useRef(false)
  const meterFailuresRef = useRef(0)
  const awaitingSpokenResponseRef = useRef(false)
  // The live conversation. Every await in a turn is followed by a check that
  // it is still this one: end() and unmount clear it (and a new start()
  // replaces it), so a warm-up or transcript settling afterwards cannot
  // transcribe, submit, or move status.
  const conversationRef = useRef<Conversation | null>(null)
  const responseIdRef = useRef<string | null>(null)
  const spokenSourceLengthRef = useRef(0)
  const stopBargeMonitorRef = useRef<(() => void) | null>(null)
  const bargeCapturePendingRef = useRef(false)
  const bargedRef = useRef(false)
  // Reply text that was playing when the barge tripped ('' for a
  // generation-phase trip: nothing audible, so nothing to echo).
  const bargeEchoTextRef = useRef('')
  const speechStartSequenceRef = useRef(0)
  const enabledRef = useRef(enabled)
  const mutedRef = useRef(muted)
  const busyRef = useRef(busy)
  const statusRef = useRef<ConversationStatus>('idle')
  const wasEnabledRef = useRef(enabled)
  const onStopWordRef = useRef(onStopWord)
  const onInterruptRef = useRef(onInterrupt)
  // `submitVoiceTurn` (the composer's real `onSubmit`) re-creates per render
  // and its busy guard captures THAT render's state; the barge monitor arms
  // once per turn, so `submitCapturedUtterance` can outlive the render that
  // created it and would otherwise hold that stale submit forever. Read the
  // latest callback at call time, mirroring `onInterruptRef` (#123357).
  const onSubmitRef = useRef(onSubmit)

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    onInterruptRef.current = onInterrupt
  }, [onInterrupt])

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    onSubmitRef.current = onSubmit
  }, [onSubmit])

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    onStopWordRef.current = onStopWord
  }, [onStopWord])

  const beforeMicOpenRef = useRef(beforeMicOpen)

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    beforeMicOpenRef.current = beforeMicOpen
  }, [beforeMicOpen])

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    enabledRef.current = enabled
  }, [enabled])

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    mutedRef.current = muted
  }, [muted])

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    statusRef.current = status
  }, [status])

  // The sentence-by-sentence fallback polls the pending reply on a timer; it
  // must not outlive the session or the hook (a stray tick after unmount hits
  // a torn-down window).

  useEffect(
    () => () => {
      const conversation = conversationRef.current
      conversationRef.current = null

      if (conversation) {
        void syncSttLease(VOICE_INPUT_LEASE, false, conversation.owner)
      }
    },
    []
  )

  const clearTurnTimeout = () => {
    if (turnTimeoutRef.current) {
      window.clearTimeout(turnTimeoutRef.current)
      turnTimeoutRef.current = null
    }
  }

  const dropSpeechSession = () => {
    stopBargeMonitorRef.current?.()
    stopBargeMonitorRef.current = null
    bargeCapturePendingRef.current = false
    bargedRef.current = false
    bargeEchoTextRef.current = ''
    responseIdRef.current = null
    spokenSourceLengthRef.current = 0
  }

  const handleTurn = useCallback(
    async (forceTranscribe = false) => {
      if (turnClosingRef.current) {
        return
      }

      turnClosingRef.current = true
      clearTurnTimeout()
      setStatus('transcribing')
      const conversation = conversationRef.current
      const live = () => conversation !== null && conversationRef.current === conversation

      try {
        const result = await handle.stop()

        if (!conversation || !live()) {
          return // ended while the recorder stopped
        }

        const meterFailed = Boolean(result?.meterFailed)

        meterFailuresRef.current = meterFailed ? meterFailuresRef.current + 1 : 0

        if (meterFailuresRef.current >= METER_FAILURE_LIMIT) {
          meterFailuresRef.current = 0
          notifyError(new Error(voiceCopy.recordingFailed), voiceCopy.microphoneFailed)
          pendingStartRef.current = false
          setStatus('idle')
          onFatalError?.()

          return
        }

        // `heardSpeech` comes from the level meter alone. When the meter died
        // (AudioContext device error) it is unknown, not false — let STT judge
        // the clip instead of silently dropping the turn (#75329).
        const transcribable =
          result?.heardSpeech ||
          forceTranscribe ||
          (meterFailed && (result?.durationMs ?? 0) >= METER_FAILURE_MIN_CLIP_MS)

        if (!result || !transcribable || !onTranscribeAudio) {
          if (enabledRef.current && !mutedRef.current && !busyRef.current && statusRef.current !== 'speaking') {
            pendingStartRef.current = true
          }

          setStatus('idle')

          return
        }

        try {
          // Readiness first: let the listening-start warm-up settle before
          // handing the clip to transcription (#105955) — a cold model load
          // must not run inside the transcription request's decode budget.
          // syncSttLease never rejects.
          await conversation.warmup

          if (!live()) {
            return
          }

          const transcript = (await onTranscribeAudio(result.audio, conversation.owner)).trim()

          if (!live()) {
            return
          }

          if (!transcript) {
            if (enabledRef.current) {
              pendingStartRef.current = true
            }

            setStatus('idle')

            return
          }

          // A spoken "stop" (or "never mind", "goodbye", …) ends the
          // conversation instead of being submitted as a turn. Only whole-
          // utterance stop commands match, so "stop the container" still goes
          // through as a real request.
          if (isVoiceStopCommand(transcript)) {
            dropSpeechSession()
            setStatus('idle')
            onStopWordRef.current?.()

            return
          }

          awaitingSpokenResponseRef.current = true
          dropSpeechSession()
          // The reply we just finished playing is stale the moment a new turn
          // is submitted. Mark it spoken BEFORE submit (barge path parity):
          // otherwise the turn-drive effect sees `awaiting` + an "unspoken"
          // previous reply and re-speaks it via the whole-text fallback while
          // the model is still thinking — the old answer plays until the new
          // one arrives and barges in.
          consumePendingResponse()
          await onSubmit(transcript)

          if (live()) {
            setStatus('thinking')
          }
        } catch (error) {
          if (!live()) {
            return
          }

          notifyError(error, voiceCopy.transcriptionFailed)

          if (enabledRef.current && !mutedRef.current && !busyRef.current) {
            pendingStartRef.current = true
          }

          setStatus('idle')
        }
      } finally {
        turnClosingRef.current = false
      }
    },
    [
      consumePendingResponse,
      handle,
      onFatalError,
      onSubmit,
      onTranscribeAudio,
      voiceCopy.microphoneFailed,
      voiceCopy.recordingFailed,
      voiceCopy.transcriptionFailed
    ]
  )

  const startListening = useCallback(async () => {
    pendingStartRef.current = false

    if (!enabledRef.current || mutedRef.current || busyRef.current) {
      return
    }

    if (bargeCapturePendingRef.current) {
      return // the barge monitor is mid-capture and owns the mic
    }

    if (statusRef.current !== 'idle') {
      return
    }

    // Let the wake-word listener fully release the capture device before we
    // open ours — opening the mic while wake still holds it makes getUserMedia
    // fail (the "clicked voice but it never starts listening" bug).
    try {
      await beforeMicOpenRef.current?.()
    } catch {
      // A pause failure shouldn't block the user's explicit start.
    }

    // enabled/muted/busy or an interleaved turn may have changed while we waited.
    const conversation = conversationRef.current

    if (!conversation || !enabledRef.current || mutedRef.current || busyRef.current || statusRef.current !== 'idle') {
      return
    }

    try {
      // VAD tuning mirrors `tools.voice_mode` defaults so the browser loop matches the CLI.
      // `silenceMs` honours `voice.silence_duration` (seeded by useHermesConfig): only a
      // user-set value overrides the desktop's tuned 1.25 s hold, which every turn sits
      // through as dead air.
      await handle.start({
        silenceLevel: 0.075,
        silenceMs: $voiceSilenceMs.get(),
        idleSilenceMs: 12_000,
        onError: error => {
          notifyError(error, voiceCopy.microphoneFailed)
          pendingStartRef.current = false
          onFatalError?.()
        },
        onMeterFailure: () => void handleTurn(),
        onSilence: () => void handleTurn()
      })
      setStatus('listening')
      // Same warm-up as push-to-talk dictation: a cold local model loads while
      // the user speaks instead of inside the transcription timeout (#105955).
      // Sent on every listening start: the idle watcher may have evicted the
      // model during a long reply or a mute, and the backend re-warm is a
      // cache hit otherwise. The promise is the readiness barrier the
      // transcription paths await before submitting audio.
      conversation.warmup = syncSttLease(VOICE_INPUT_LEASE, true, conversation.owner)
      // Clear any prior turn-timeout before arming a fresh one. Each listen
      // cycle reassigns turnTimeoutRef; without clearing first, a stale 60s
      // timer from an earlier cycle survives and later fires handleTurn() in
      // the middle of a new listen, cutting it short (or, after enough idle
      // re-listens, wedging the loop into a state it doesn't re-arm from).
      clearTurnTimeout()
      turnTimeoutRef.current = window.setTimeout(() => void handleTurn(), 60_000)
    } catch (error) {
      notifyError(error, voiceCopy.couldNotStartSession)
      pendingStartRef.current = false
      setStatus('idle')
      onFatalError?.()
    }
  }, [handle, handleTurn, onFatalError, voiceCopy.couldNotStartSession, voiceCopy.microphoneFailed])

  const settleAfterSpeech = useCallback(
    (barged: boolean, stoppedDuringSetup = false) => {
      const stoppedExternally =
        stoppedDuringSetup ||
        (speechStartSequenceRef.current > 0 && $voicePlayback.get().sequence > speechStartSequenceRef.current)

      if (barged || stoppedExternally || !awaitingSpokenResponseRef.current) {
        awaitingSpokenResponseRef.current = false
        consumePendingResponse()
      }

      if (bargeCapturePendingRef.current) {
        // The barge monitor is still capturing the user's interruption — it
        // owns the next turn. Keep it alive and don't re-open the mic; the
        // utterance callback transcribes and submits when they go quiet.
            responseIdRef.current = null
        spokenSourceLengthRef.current = 0
            setStatus('listening')

        return
      }

      dropSpeechSession()

      // An external stopVoicePlayback() (Stop/Esc) silences the current reply;
      // it does not end hands-free conversation mode. end() owns that path and
      // clears pendingStartRef before disabling the loop. While still enabled,
      // always re-arm so the user can speak immediately after cutting TTS.
      speechStartSequenceRef.current = 0

      if (enabledRef.current) {
        pendingStartRef.current = true
      }

      setStatus('idle')
    },
    [consumePendingResponse]
  )

  /**
   * Submit the utterance the barge monitor captured — the user's interruption
   * from its first syllable, no re-listen round trip. Empty/failed captures
   * fall back to normal listening.
   */
  const submitCapturedUtterance = useCallback(
    async (audio: Blob | null) => {
      const echoSource = bargeEchoTextRef.current
      const conversation = conversationRef.current
      const live = () => conversation !== null && conversationRef.current === conversation

      bargeEchoTextRef.current = ''

      const resumeListening = () => {
        if (enabledRef.current && !mutedRef.current) {
          pendingStartRef.current = true
        }

        setStatus('idle')
      }

      if (!conversation || !live()) {
        return // ended while the barge monitor was capturing
      }

      if (!audio || !onTranscribeAudio) {
        resumeListening()

        return
      }

      setStatus('transcribing')

      try {
        // Same readiness barrier as handleTurn: the barge capture transcribes
        // with the warm-up issued when this conversation last started
        // listening (the monitor is armed through the whole turn, so the
        // barrier is normally already settled by speech time).
        await conversation.warmup

        if (!live()) {
          return
        }

        const transcript = (await onTranscribeAudio(audio, conversation.owner)).trim()

        if (!live()) {
          return
        }

        if (!transcript) {
          resumeListening()

          return
        }

        // A spoken stop command while barging means "stop everything" — the
        // turn/playback was already cut at trip time; now end the conversation
        // instead of submitting "stop" as a new prompt.
        if (isVoiceStopCommand(transcript)) {
          dropSpeechSession()
          setStatus('idle')
          onStopWordRef.current?.()

          return
        }

        // Fail-closed echo guard (tools/voice_mode_transcript.is_tts_echo):
        // over speakers the reply bleeds into the mic and trips the playback-
        // phase trigger. A transcript matching what was being spoken is
        // Hermes hearing itself — treat it as silence: no submit, and clear
        // the interruption latch so a later real turn isn't annotated.
        if (echoSource && isTtsEcho(transcript, echoSource)) {
          takeVoicePlaybackInterrupted()
          resumeListening()

          return
        }

        // A generation-phase barge interrupted the in-flight turn; the submit
        // path refuses while `busy`, so wait for the interrupt to settle.
        const deadline = Date.now() + INTERRUPT_SETTLE_TIMEOUT_MS

        while (busyRef.current && Date.now() < deadline) {
          await new Promise(resolve => window.setTimeout(resolve, 100))
        }

        if (!live()) {
          return
        }

        // Live busy never settled: submitting would be refused by the
        // composer's live-busy guard and the spoken interruption would be
        // lost. Park the transcript in the composer input instead — visible,
        // editable, one Enter away from sending — and resume listening.
        // Never drop a transcribed turn without a trace (#123357).
        if (busyRef.current) {
          parkText?.(transcript)
          focusInput?.()
          resumeListening()

          return
        }

        awaitingSpokenResponseRef.current = true
        dropSpeechSession()
        consumePendingResponse()
        await onSubmitRef.current(transcript)

        if (live()) {
          setStatus('thinking')
        }
      } catch (error) {
        if (live()) {
          notifyError(error, voiceCopy.transcriptionFailed)
          resumeListening()
        }
      }
    },
    [consumePendingResponse, focusInput, onTranscribeAudio, parkText, voiceCopy.transcriptionFailed]
  )

  /**
   * Full-duplex barge-in monitor for the WHOLE agent turn: armed at submit,
   * live through generation (thinking) AND playback (speaking).
   *
   * - generation phase (`busy`): speech interrupts the in-flight turn via
   *   `onInterrupt` — the same seam as the Stop button — and cuts any TTS that
   *   managed to start, so the stale reply never speaks.
   * - playback phase: speech cuts playback and the captured interruption is
   *   transcribed and submitted as the next turn.
   *
   * Idempotent — one monitor owns the mic per turn; re-arming while one is
   * live is a no-op (the live/fallback speech paths and the turn-drive effect
   * all call this).
   */
  const ensureBargeMonitor = useCallback(() => {
    // `voice.barge_in: false` disarms the listener entirely, mirroring the
    // gateway's `_arm_barge_listener_if_enabled` gate.
    if (!$bargeInEnabled.get()) {
      return
    }

    if (stopBargeMonitorRef.current) {
      return
    }

    stopBargeMonitorRef.current = monitorSpeechDuringPlayback({
      isPlaying: () => $voicePlayback.get().status === 'speaking',
      thresholdMultiplier: $bargeInThresholdMultiplier.get(),
      onSpeech: () => {
        // Snapshot before playback is cut: the reply may be consumed by the
        // time the capture is transcribed.
        bargeEchoTextRef.current = $voicePlayback.get().status === 'speaking' ? (pendingResponse()?.text ?? '') : ''
        bargeCapturePendingRef.current = true
        bargedRef.current = true
        markVoicePlaybackInterrupted()
        stopVoicePlayback()

        if (busyRef.current) {
          // Mid-generation: stop the in-flight turn so the captured utterance
          // becomes the next one instead of queueing behind a stale reply.
          void onInterruptRef.current?.()
        }
      },
      onUtterance: audio => {
        bargeCapturePendingRef.current = false
        stopBargeMonitorRef.current = null
        void submitCapturedUtterance(audio)
      }
    })
  }, [pendingResponse, submitCapturedUtterance])

  // `voice.barge_in` flipping off MID-TURN disarms the live monitor too: the
  // gate above only covers creation, so a config refresh that says barge-in is
  // off must also stop a monitor that already armed, or the rest of the turn
  // keeps interrupting on speech while the pref says off. A capture that was
  // mid-flight is dropped (the pref changed under it) and the loop resumes
  // normal listening the way a failed capture does.
  // eslint-disable-next-line no-restricted-syntax -- atom-edge CLEANUP of the live monitor handle, not a mirror: nothing copies atom state into a ref
  useEffect(() => {
    const unsubscribe = $bargeInEnabled.subscribe(enabled => {
      if (enabled) {
        return
      }

      stopBargeMonitorRef.current?.()
      stopBargeMonitorRef.current = null

      if (bargeCapturePendingRef.current) {
        bargeCapturePendingRef.current = false
        bargedRef.current = false
        bargeEchoTextRef.current = ''

        if (enabledRef.current && !mutedRef.current) {
          pendingStartRef.current = true
        }

        setStatus('idle')
      }
    })

    return unsubscribe
  }, [])

  /**
   * Speak the reply ONCE, after it is fully generated.
   *
   * 所有音色都走这条：本地 kokoro 念全文、云端 asuka 只念摘要，区别只在
   * `speak_max_chars` 预算。之所以不再对「command 型 provider」做流式分流：
   * asuka 在配置里也是 `type: command`（外壳脚本打 MiniMax 云接口），按类型判定
   * 会把它误当成本地引擎，于是又回到逐句分段。
   *
   * 这条链以前是「边说边合成」：把回复按句喂进 /api/audio/speak-stream，
   * 服务端逐句调 text_to_speech_tool。对 command 型 provider（asuka / kokoro）
   * 那就是每句起一次脚本进程，合成串在播放后面 → 段与段之间各弹一次
   * 「正在准备音频」，听感上像被切成好几段，长回复还会只念前半。
   *
   * 现在改成：等整条回复落地，一次性 POST 到 /api/audio/speak，拿回一个
   * 完整的音频文件播一遍。一次 preparing、一段声音；全文就是全文，摘要才按
   * speak_max_chars 截。
   */
  const openLiveSpeech = useCallback(
    (responseId: string) => {
      if (responseIdRef.current === responseId) {
        return
      }

      responseIdRef.current = responseId
      spokenSourceLengthRef.current = 0

      // Hold the loop in 'speaking' for the whole wait: the effect's
      // "turn ended without a speakable reply" branch would otherwise drop the
      // session when a short bubble vanishes before the poll sees it sealed.
      setStatus('speaking')

      const current = () => responseIdRef.current === responseId

      /** Wait for the turn's last bubble to seal: no half sentences spoken. */
      const waitForSealed = (): Promise<null | string> => {
        // The bubble can be dropped (session view rebuilt) right as the turn
        // settles — a very short reply ("2。") would then vanish before we saw
        // it sealed. Keep the last text we observed so it still gets spoken.
        let lastSeen = ''

        return new Promise(resolve => {
          const tick = () => {
            if (!current()) {
              resolve(null)

              return
            }

            const response = pendingResponse()

            if (!response || response.id !== responseId) {
              // The bubble was consumed/rewritten under us. If we already saw
              // text, speak that; otherwise give the loop a moment to publish
              // the durable bubble.
              if (lastSeen) {
                resolve(lastSeen)
              } else {
                window.setTimeout(() => resolve(current() ? (pendingResponse()?.text ?? null) : null), 200)
              }

              return
            }

            const text = response.text

            if (response.pending || busyRef.current) {
              lastSeen = text
              window.setTimeout(tick, 150)

              return
            }

            // 气泡刚 sealed 的那一帧，store 里的文字还差最后一段（渲染层分帧落地）。
            // 要求连续两次轮询文本一致才开口，否则 243 字的故事会被念成 160 字。
            if (text !== lastSeen) {
              lastSeen = text
              window.setTimeout(tick, 150)

              return
            }

            resolve(text)
          }

          tick()
        })
      }

      void (async () => {
        const text = await waitForSealed()

        if (!current()) {
          return
        }

        if (!text || !text.trim()) {
          awaitingSpokenResponseRef.current = false
          settleAfterSpeech(false)

          return
        }

        const budget = currentSpeechLimit()
        const speakable = budget > 0 ? capSpeechText(text, budget) : text

        if (!speakable.trim()) {
          awaitingSpokenResponseRef.current = false
          settleAfterSpeech(false)

          return
        }

        // VAD barge-in: the user talking over the reply cuts playback, drops
        // the remainder, AND keeps capturing — the interruption is transcribed
        // from its first syllable.
        ensureBargeMonitor()
        speechStartSequenceRef.current = $voicePlayback.get().sequence

        try {
          // syncOnly: one POST to /api/audio/speak — the whole reply in a single
          // synthesis, no WS sentence chunks, no client-direct ladder.
          const started = await playSpeechText(speakable, {
            ...ownerRef.current,
            messageId: responseId,
            source: 'voice-conversation',
            syncOnly: true
          })

          if (!current()) {
            return
          }

          if (!started) {
            notifyError(new Error('speech playback did not start'), voiceCopy.playbackFailed)
          }
        } catch (error) {
          if (current()) {
            notifyError(error, voiceCopy.playbackFailed)
          }
        }

        if (!current()) {
          return
        }

        awaitingSpokenResponseRef.current = false
        settleAfterSpeech(bargedRef.current)
      })()
    },
    [ensureBargeMonitor, pendingResponse, settleAfterSpeech, voiceCopy.playbackFailed]
  )

  const start = useCallback(async () => {
    if (!onTranscribeAudio) {
      notify({
        kind: 'warning',
        title: voiceCopy.unavailable,
        message: voiceCopy.configureSpeechToText
      })
      onFatalError?.()

      return
    }

    setMuted(false)
    awaitingSpokenResponseRef.current = false
    dropSpeechSession()
    consumePendingResponse()
    // A fresh conversation: its owner is resolved now and kept to the end.
    // Replacing the ref also fences any continuation of a previous one.
    conversationRef.current = { owner: resolveOwnerNow(ownerRef.current), warmup: Promise.resolve() }
    pendingStartRef.current = true
    await startListening()
  }, [
    consumePendingResponse,
    onFatalError,
    onTranscribeAudio,
    startListening,
    voiceCopy.configureSpeechToText,
    voiceCopy.unavailable
  ])

  const end = useCallback(async () => {
    pendingStartRef.current = false
    clearTurnTimeout()
    stopVoicePlayback()
    handle.cancel()
    turnClosingRef.current = false
    awaitingSpokenResponseRef.current = false
    dropSpeechSession()
    consumePendingResponse()
    // Conversation over: drop the STT lease to the owner that acquired it,
    // and fence every continuation still awaiting a warm-up or transcript.
    // One lease is shared per renderer, so a concurrent dictation session
    // re-acquires on its next start; the backend keeps the model resident
    // regardless of the count.
    const conversation = conversationRef.current
    conversationRef.current = null

    if (conversation) {
      void syncSttLease(VOICE_INPUT_LEASE, false, conversation.owner)
    }

    setMuted(false)
    setStatus('idle')
  }, [consumePendingResponse, handle])

  const stopTurn = useCallback(() => {
    if (statusRef.current === 'listening') {
      void handleTurn(true)
    }
  }, [handleTurn])

  const toggleMute = useCallback(() => {
    setMuted(value => {
      const next = !value

      if (next) {
        clearTurnTimeout()
        handle.cancel()
        setStatus('idle')
      } else if (enabledRef.current && !busyRef.current && statusRef.current === 'idle') {
        pendingStartRef.current = true
      }

      return next
    })
  }, [handle])

  useEffect(() => {
    if (!enabled) {
      return
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat || event.metaKey || event.ctrlKey || event.altKey) {
        return
      }

      if (statusRef.current !== 'listening') {
        return
      }

      event.preventDefault()
      stopTurn()
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })

    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [enabled, stopTurn])

  // Ambient "thinking" sound: while the agent works (status 'thinking') no
  // audio flows, which reads as dead air mid-conversation. Calm bubble blips
  // fill the gap; they stop the INSTANT speech starts, the mic re-arms, or the
  // conversation ends. Gated by voice.thinking_sound + the shared sound mute.
  useEffect(() => {
    if (enabled && !muted && status === 'thinking') {
      startThinkingSound()

      return stopThinkingSound
    }

    stopThinkingSound()

    return undefined
  }, [enabled, muted, status])

  // Drive the loop: when a voice-submitted reply appears, open a live speech
  // session (which feeds itself from then on). Otherwise start listening when
  // idle between turns.
  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    if (!enabled || muted) {
      return
    }

    if (awaitingSpokenResponseRef.current && status !== 'speaking') {
      // Generation phase: the turn is in flight but no reply audio exists
      // yet. Keep the mic live so speech can interrupt the model mid-
      // generation (full-duplex) instead of going deaf until playback.
      if (status === 'thinking' && (busy || bargeCapturePendingRef.current)) {
        ensureBargeMonitor()
      }

      const response = pendingResponse()

      // "Read replies aloud" off (#44263): Voice Chat is STT-only — the reply
      // stays text on screen, the loop consumes it and re-arms the mic for
      // the next turn without ever starting TTS.
      if (response && !$autoSpeakReplies.get()) {
        awaitingSpokenResponseRef.current = false
        dropSpeechSession()
        consumePendingResponse()
        pendingStartRef.current = true
        setStatus('idle')

        return
      }

      if (response) {
        openLiveSpeech(response.id)

        return
      }

      if (!busy && status === 'thinking' && !bargeCapturePendingRef.current) {
        // Turn finished without any speakable reply (tool-only, error). A
        // live barge capture owns the loop instead — it submits or resumes.
        awaitingSpokenResponseRef.current = false
        dropSpeechSession()
        pendingStartRef.current = true
        setStatus('idle')

        return
      }
    }

    if (busy || status !== 'idle') {
      return
    }

    if (pendingStartRef.current) {
      void startListening()
    }
  }, [busy, enabled, muted, ensureBargeMonitor, openLiveSpeech, pendingResponse, startListening, status])

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    if (enabled && !wasEnabledRef.current) {
      void start()
    }

    if (!enabled && wasEnabledRef.current) {
      void end()
    }

    wasEnabledRef.current = enabled
  }, [enabled, end, start])

  return { end, level, muted, start, status, stopTurn, toggleMute }
}
