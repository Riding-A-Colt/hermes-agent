import { useStore } from '@nanostores/react'
import { computed } from 'nanostores'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { useI18n } from '@/i18n'
import { chatMessageText, collectUnspokenTurnSpeech, lastTextPartText } from '@/lib/chat-messages'
import { triggerHaptic } from '@/lib/haptics'
import type { SpeechBubble } from '@/lib/speech-queue'
import {
  adoptSpokenReplySession,
  assistantTurnKey,
  markAssistantIdSpoken,
  resolveSpokenReply
} from '@/lib/spoken-reply'
import { CONVERSATION_LEASE, READ_ALOUD_LEASE, syncTtsLease } from '@/lib/tts-lease'
import { adoptTurnAnchorSession, rowTimestampFresh, turnAnchor, turnAnchorIsFresh } from '@/lib/turn-anchor'
import { toLiveHistory } from '@/lib/voice-live'
import { clearWakeIndicator, syncWakeIndicatorWithVoice } from '@/lib/wake-indicator'
import { $voiceConversationStartRequest, takeVoiceConversationStart } from '@/store/composer'
import { resetBrowseState } from '@/store/composer-input-history'
import { recordFeatureUse } from '@/store/desktop-metrics'
import { $gateway } from '@/store/gateway'
import { notify, notifyError } from '@/store/notifications'
import { $voiceLiveStatus, refreshVoiceLiveStatus, selectedVoiceChatMode } from '@/store/voice-live'
import { $autoSpeakReplies, $voiceStopPhrase, setAutoSpeakReplies } from '@/store/voice-prefs'
import { resumeWakeAfterVoice } from '@/store/wake-word'

import { pinFloatingComposerCapture } from '../floating-target'
import type { ComposerTarget } from '../focus'
import { onComposerDictationRequest, onComposerVoiceToggleRequest } from '../focus'
import { useComposerScope, useComposerSurfaceId } from '../scope'
import type { ChatBarProps } from '../types'

import { useAutoSpeakReplies } from './use-auto-speak-replies'
import { useVoiceConversation } from './use-voice-conversation'
import { useVoiceLiveConversation } from './use-voice-live-conversation'
import { useVoiceRecorder } from './use-voice-recorder'

interface UseComposerVoiceArgs {
  busy: boolean
  clearDraft: () => void
  disabled: boolean
  focusInput: () => void
  insertText: (text: string) => void
  maxRecordingSeconds: number
  /** Interrupt the in-flight agent turn (Stop-button seam) — fired when the
   *  user speaks over the model while it is still generating. */
  onInterrupt?: () => Promise<void> | void
  onSubmit: ChatBarProps['onSubmit']
  onTranscribeAudio: ChatBarProps['onTranscribeAudio']
  sessionId: string | null | undefined
  /** This composer's focus-bus key — voice toggles targeting another
   *  composer (or the active one, when not us) are ignored. */
  target: ComposerTarget
}

/**
 * The composer's voice engine: push-to-talk dictation (transcript → draft), the
 * full voice-conversation loop, and auto-speak of replies. Self-contained — it
 * consumes the draft/submit primitives passed in but nothing depends back on it,
 * so it lifts cleanly out of ChatBar.
 */
export function useComposerVoice({
  busy,
  clearDraft,
  disabled,
  focusInput,
  insertText,
  maxRecordingSeconds,
  onInterrupt,
  onSubmit,
  onTranscribeAudio,
  sessionId,
  target
}: UseComposerVoiceArgs) {
  const { t } = useI18n()
  // A tile's composer speaks ITS transcript, not the primary chat's.
  const { $messages } = useComposerScope()

  // Wake the voice loop once when a pending reply first becomes speakable,
  // without re-rendering the composer for every streamed token. The live
  // speech feeder still reads $messages.get() every 150 ms for later deltas.
  const $pendingVoiceReplyId = useMemo(
    () =>
      computed($messages, messages => {
        const last = messages.findLast(message => message.role === 'assistant' && !message.hidden)

        // Runs on every streamed flush: test the parts in place instead of
        // joining the whole reply into a string just to check it is non-blank.
        return last?.pending && last.parts.some(part => part.type === 'text' && /\S/.test(part.text)) ? last.id : null
      }),
    [$messages]
  )

  useStore($pendingVoiceReplyId)
  const [voiceConversationActive, setVoiceConversationActive] = useState(false)
  // Engine selection is latched at conversation START (a Settings change
  // applies to the next conversation, never mid-call).
  const [liveEngineActive, setLiveEngineActive] = useState(false)
  // Barge-in can retain a submit callback from a render where the interrupted
  // turn was still busy. Read the current gate when its transcript arrives so
  // that stale closure does not silently drop the next voice turn.
  const busyRef = useRef(busy)
  busyRef.current = busy
  const ownsWakeIndicatorRef = useRef(false)
  const previousSessionIdRef = useRef(sessionId)
  const voiceStartRequest = useStore($voiceConversationStartRequest)

  // eslint-disable-next-line no-restricted-syntax -- session-id adopt token, not an atom mirror
  useEffect(() => {
    adoptSpokenReplySession(previousSessionIdRef.current, sessionId)
    adoptTurnAnchorSession(previousSessionIdRef.current, sessionId)
    previousSessionIdRef.current = sessionId
  }, [sessionId])

  const { dictate, voiceActivityState, voiceStatus } = useVoiceRecorder({
    focusInput,
    maxRecordingSeconds,
    onTranscript: insertText,
    onTranscribeAudio
  })

  const surfaceId = useComposerSurfaceId()
  const capturing = voiceConversationActive || voiceStatus !== 'idle'

  useLayoutEffect(() => {
    if (surfaceId && capturing) {
      return pinFloatingComposerCapture(surfaceId)
    }
  }, [capturing, surfaceId])

  /**
   * 这一轮的助手气泡（按顺序，含流式中的那条）——自动朗读按「气泡」入队，
   * 不按「拼起来的整段」推算，避免范围越积越长后整段重念（2026-11-08）。
   */
  const turnBubbles = () => {
    const messages = $messages.get()

    // 锚点闸：转录会被一张滞后的快照整体替换、再逐条重放（2026-11-09 实测静止
    // 37 秒以上）。锚点退回旧行的那几帧静音——判据是锚点用户行的新鲜度（新轮
    // 时间戳就在眼前）或它就是当前轮；存储丢了当前轮用户行、行后却跟着带新鲜
    // 时间戳的助手行时，只放行那批新鲜行（liveTail）。
    const verdict = turnAnchor(sessionId, messages)

    if (!verdict.stable) {
      return []
    }

    const lastUser = messages.findLastIndex(message => message.role === 'user')

    // 没有锚点（用户行暂时缺失，比如 hydration 的空窗）就返回空：拿「全部消息」
    // 当本轮会把历史整批喂进朗读——实测 21:49 那次，五段念完后同一个会话又追加了
    // 205 字，等于把前几轮的历史重念了一遍（2026-11-08）。
    if (lastUser < 0) {
      return []
    }

    const bubbles: SpeechBubble[] = []

    for (const message of messages.slice(lastUser + 1)) {
      if (message.role !== 'assistant' || message.hidden) {
        continue
      }

      // liveTail 下旧行不管多新的朗读队列都没见过它们的账——旧行直接滤掉，
      // 否则回放重放的历史会整批重新开口。
      if (verdict.liveTail && !rowTimestampFresh(message)) {
        continue
      }

      const text = chatMessageText(message).trim()

      if (text) {
        bubbles.push({ sealed: !message.pending, text })
      }
    }

    return bubbles
  }

  /** Auto-speak selector: the latest unspoken reply only — a backlog collapses to the newest. */
  const pendingResponse = () => {
    const messages = $messages.get()

    // 同 turnBubbles 的锚点闸：滞后快照/重放帧一律当「没有要念的」。
    const verdict = turnAnchor(sessionId, messages)

    if (!verdict.stable) {
      return null
    }

    let spoken = resolveSpokenReply(sessionId, messages)

    // 渲染进程刚起（重启/换窗）还没念过任何东西，锚点却是刚到的新鲜行：锚点之前
    // 的内容归上一个渲染进程念（或本来就是历史），标掉再收，别把整段尾巴重念
    // （2026-11-09 11:39 实测跨渲染进程重复：重放插入的 auto-continue 行触发放行，
    // 空队列把本回合 10 分钟的旁白整批当新内容）。
    if (!spoken && turnAnchorIsFresh(messages)) {
      const lastUser = messages.findLastIndex(m => m.role === 'user')

      const before = messages
        .slice(0, lastUser)
        .findLast(m => m.role === 'assistant' && !m.hidden && chatMessageText(m).trim())

      if (before) {
        markAssistantIdSpoken(sessionId, messages, before.id)
        spoken = resolveSpokenReply(sessionId, messages)
      }
    }

    // liveTail（存储丢了当前轮的用户行）：只认带新鲜时间戳的助手行，旧行全滤掉。
    if (verdict.liveTail) {
      const rows = messages.filter(
        message => message.role === 'assistant' && !message.hidden && rowTimestampFresh(message) && chatMessageText(message).trim()
      )

      const row = rows.at(-1)

      if (!row) {
        return null
      }

      return {
        id: row.id,
        pending: Boolean(row.pending),
        segmentText: lastTextPartText(row),
        text: chatMessageText(row).trim(),
        turnKey: assistantTurnKey(sessionId, messages, row.id),
        charsBefore: 0
      }
    }

    // 换轮凭据：用户消息条数只在真发新消息时变，消息 id 改写和工具行插入都不动它。
    // 「已念窗口」按它清空——用 assistantTurnKey（序号算的）会在工具行插入时漂，
    // 一漂就把窗口清掉、整轮重念（2026-11-08 实测）。
    const turnNonce = String(messages.filter(message => message.role === 'user').length)
    // Same selector the voice conversation uses: every unspoken bubble of the
    // turn, in order. Taking "the last assistant row" dropped a follow-up
    // segment after a tool call (tool steps leave blank rows behind), and an
    // already-spoken row blinded the whole turn (2026-11-07).
    const unspoken = collectUnspokenTurnSpeech(messages, spoken?.id ?? null)

    if (unspoken) {
      return {
        id: unspoken.id,
        pending: unspoken.pending,
        segmentText: unspoken.text,
        text: unspoken.text,
        turnKey: assistantTurnKey(sessionId, messages, unspoken.id),
        charsBefore: 0
      }
    }

    // One bubble that kept growing after we read it: speak only the new tail.
    if (spoken) {
      const row = messages.findLast(m => m.id === spoken.id)
      const full = row ? chatMessageText(row).trim() : ''
      const read = spoken.chars ?? full.length

      if (full.length > read) {
        return {
          id: spoken.id,
          pending: Boolean(row?.pending),
          segmentText: full,
          text: full.slice(read).trim(),
          turnKey: assistantTurnKey(sessionId, messages, spoken.id),
          charsBefore: read
        }
      }
    }

    return null
  }

  /**
   * Voice-conversation selector: every unspoken assistant bubble of the turn,
   * in order — narration interims AND the final answer, not just whichever
   * bubble happens to be last. See `collectUnspokenTurnSpeech`.
   */
  const pendingTurnResponse = () => {
    const messages = $messages.get()

    return collectUnspokenTurnSpeech(messages, resolveSpokenReply(sessionId, messages)?.id ?? null)
  }

  // Mark the reply we actually spoke. Marking "the last assistant message"
  // swallowed the next segment of a multi-part turn: while the seal loop waits
  // for the text to settle, the follow-up bubble already arrives and was marked
  // spoken before it was ever read (heard part one only, 2026-11-07).
  const consumePendingResponse = (replyId?: string, chars?: number) => {
    const messages = $messages.get()

    if (replyId) {
      // Only the id we were handed. Falling back to "mark the last visible
      // assistant" here marked the NEXT segment spoken when the streaming id
      // could not resolve, and that segment never played (2026-11-07).
      markAssistantIdSpoken(sessionId, messages, replyId, chars)

      return
    }

    const last = messages.findLast(m => m.role === 'assistant' && !m.hidden)

    if (last) {
      markAssistantIdSpoken(sessionId, messages, last.id)
    }
  }

  const submitVoiceTurn = async (text: string) => {
    if (busyRef.current) {
      return
    }

    triggerHaptic('submit')
    resetBrowseState(sessionId)
    clearDraft()
    await onSubmit(text, { voiceTurn: true })
  }

  /** A GPT-Live delegation → Hermes turn. The bubble and the persisted row are
   *  what the user said; the transcript window rides the model input only. */
  const submitLiveDelegation = async (text: string, voiceContext: string) => {
    triggerHaptic('submit')
    resetBrowseState(sessionId)
    clearDraft()
    await onSubmit(text, { surface: 'voice-live', voiceContext })
  }

  /** Recent text turns of this chat, as GPT-Live startup history. */
  const seedLiveHistory = () =>
    toLiveHistory(
      $messages
        .get()
        .filter(m => !m.hidden && (m.role === 'user' || m.role === 'assistant'))
        .map(m => ({ role: m.role as 'assistant' | 'user', text: chatMessageText(m) }))
    )

  /** The tool Hermes is running right now, for quiet progress in the voice. */
  const activeToolLabel = () => {
    const last = $messages.get().findLast(m => m.role === 'assistant' && !m.hidden)
    const running = last?.parts.findLast(part => part.type === 'tool-call' && part.result === undefined)

    return running && running.type === 'tool-call' ? running.toolName : null
  }

  const wakePausedRef = useRef(false)
  // Resolves once the in-flight wake.pause round-trip completes (mic released by
  // the wake listener). The conversation awaits this before opening its own mic
  // so the two never contend for the device — on Windows especially, opening the
  // capture device while the wake listener still holds it makes getUserMedia
  // fail and the conversation never starts listening.
  const wakePauseBarrierRef = useRef<Promise<void> | null>(null)

  const chainedConversation = useVoiceConversation({
    busy,
    consumePendingResponse,
    enabled: voiceConversationActive && !liveEngineActive,
    onFatalError: () => setVoiceConversationActive(false),
    // Speaking over the model mid-generation interrupts the in-flight turn —
    // the same seam as the Stop button — so the interjection becomes the next
    // turn instead of waiting behind a reply the user already rejected.
    onInterrupt,
    // A spoken stop command ("stop", "never mind", "goodbye", …) ends the
    // hands-free conversation. Flipping the flag is the authoritative off
    // switch — the enabled=false prop + effect below drive conversation.end()
    // teardown (mic close, wake re-arm).
    onStopWord: () => setVoiceConversationActive(false),
    onSubmit: submitVoiceTurn,
    onTranscribeAudio,
    pendingResponse: pendingTurnResponse,
    // Before the conversation opens the mic, wait for any in-flight wake.pause
    // to finish releasing the capture device (see wakePauseBarrierRef).
    beforeMicOpen: () => wakePauseBarrierRef.current ?? undefined
  })

  const liveConversation = useVoiceLiveConversation({
    activeToolLabel,
    beforeMicOpen: () => wakePauseBarrierRef.current ?? undefined,
    busy,
    consumePendingResponse,
    enabled: voiceConversationActive && liveEngineActive,
    onFatalError: () => setVoiceConversationActive(false),
    onInterrupt,
    onStopWord: () => setVoiceConversationActive(false),
    onSubmit: submitLiveDelegation,
    pendingResponse: pendingTurnResponse,
    seedHistory: seedLiveHistory
  })

  const conversation = liveEngineActive ? liveConversation : chainedConversation

  /** Turn the conversation on with the engine `voice.voice_chat_mode` selects,
   *  decided in the same state batch so the other engine never sees a frame of
   *  `enabled`. gpt-live selected but not startable (no OpenAI key on the
   *  gateway) falls back to chained with a notice rather than a dead button. */
  const activateConversation = useCallback(() => {
    const status = $voiceLiveStatus.get()
    let live = false

    if (selectedVoiceChatMode(status) === 'gpt-live') {
      if (status?.available) {
        live = true
      } else {
        notify({
          id: 'voice-live-unavailable',
          kind: 'warning',
          message: t.notifications.voice.liveUnavailable(status?.reason ?? 'not configured')
        })
      }
    }

    setLiveEngineActive(live)
    setVoiceConversationActive(true)
    recordFeatureUse('voice_conversation')
  }, [t])

  useEffect(() => {
    if (!voiceConversationActive) {
      // Prefetch so the first press picks the right engine without a round trip.
      void refreshVoiceLiveStatus().catch(() => undefined)
    }
  }, [voiceConversationActive])

  // eslint-disable-next-line no-restricted-syntax -- ownership token used only by unmount cleanup
  useEffect(() => {
    if (target !== 'main') {
      return
    }

    if (syncWakeIndicatorWithVoice(voiceConversationActive, conversation.status)) {
      ownsWakeIndicatorRef.current = voiceConversationActive
    }
  }, [conversation.status, target, voiceConversationActive])

  useEffect(
    () => () => {
      if (ownsWakeIndicatorRef.current) {
        clearWakeIndicator()
      }
    },
    []
  )

  // The `composer.voice` hotkey toggles the conversation. Starting
  // with STT unconfigured lets the conversation surface its own "configure
  // speech-to-text" notice rather than silently no-opping.
  const toggleVoiceConversation = useCallback(() => {
    if (disabled) {
      return
    }

    if (voiceConversationActive) {
      setVoiceConversationActive(false)
      void conversation.end()
    } else {
      activateConversation()
    }
  }, [activateConversation, conversation, disabled, voiceConversationActive])

  useEffect(
    () => onComposerVoiceToggleRequest(toggled => toggled === target && toggleVoiceConversation()),
    [target, toggleVoiceConversation]
  )

  // The bindable `composer.dictate` action shares the mic button's callback,
  // including its recording/transcribing state machine. Ignore disabled
  // composers so an unavailable draft cannot acquire the microphone.
  useEffect(
    () => onComposerDictationRequest(requested => requested === target && !disabled && dictate()),
    [dictate, disabled, target]
  )

  useEffect(() => {
    if (target === 'main' && !disabled && takeVoiceConversationStart(voiceStartRequest) && !voiceConversationActive) {
      activateConversation()
    }
  }, [activateConversation, disabled, target, voiceConversationActive, voiceStartRequest])

  const resumeWakeIfPaused = useCallback(() => {
    if (!wakePausedRef.current) {
      return
    }

    wakePausedRef.current = false
    wakePauseBarrierRef.current = null
    // Reconcile, don't just resume: the wake word is a persistent setting, so
    // ending a voice chat must re-arm the listener whenever config says
    // enabled — including when the raw resume loses the mic-release race.
    void resumeWakeAfterVoice()
  }, [])

  // The ref is a request token (did WE issue wake.pause?), not an atom mirror —
  // it guards resumeWakeIfPaused from resuming a detector another surface owns.
  const pauseWakeForVoice = useCallback(() => {
    wakePausedRef.current = true

    const barrier = (async () => {
      try {
        await $gateway.get()?.request('wake.pause', {})
      } catch {
        // No wake listener / older backend — nothing held the mic.
      }
    })()

    wakePauseBarrierRef.current = barrier

    return barrier
  }, [])

  useEffect(() => {
    if (voiceConversationActive) {
      pauseWakeForVoice()
    } else {
      resumeWakeIfPaused()
    }
  }, [pauseWakeForVoice, resumeWakeIfPaused, voiceConversationActive])

  // 'Say "stop" to end the voice chat.' notice when the conversation starts.
  // Phrase comes from voice.stop_phrases (first entry) so a custom phrase
  // renders correctly; a null phrase (stop_phrases: []) shows no notice.
  useEffect(() => {
    if (!voiceConversationActive) {
      return
    }

    const phrase = $voiceStopPhrase.get()

    if (phrase) {
      notify({
        id: 'voice-stop-hint',
        kind: 'info',
        icon: 'mic',
        message: t.notifications.voice.sayStopToEnd(phrase)
      })
    }
  }, [t, voiceConversationActive])

  useEffect(() => resumeWakeIfPaused, [resumeWakeIfPaused])

  // Speech-output toggles are TTS warm-up / release signals. Entering a voice
  // conversation acquires this window's lease (pre-loads the engine so the
  // first spoken reply doesn't start with dead air); ending it releases the
  // lease, and the backend unloads resident local models once no surface holds
  // one. Fire-and-forget — the toggle never waits on or fails from this.
  useEffect(() => {
    void syncTtsLease(CONVERSATION_LEASE, voiceConversationActive && !liveEngineActive)
  }, [liveEngineActive, voiceConversationActive])

  useEffect(() => () => void syncTtsLease(CONVERSATION_LEASE, false), [])

  // "Read replies aloud" is the same signal, held for as long as the toggle is
  // on (it mirrors voice.auto_tts, so this also warms at startup when the
  // preference is already set).
  const autoSpeakReplies = useStore($autoSpeakReplies)

  useEffect(() => {
    void syncTtsLease(READ_ALOUD_LEASE, autoSpeakReplies)
  }, [autoSpeakReplies])

  // Explicit start/end for the on-screen conversation controls (the hotkey uses
  // the gated toggle above).
  const startConversation = activateConversation

  const endConversation = useCallback(() => {
    setVoiceConversationActive(false)
    void conversation.end()
  }, [conversation])

  const handleToggleAutoSpeak = useCallback(() => {
    void setAutoSpeakReplies(!$autoSpeakReplies.get()).catch(error =>
      notifyError(error, t.settings.config.autosaveFailed)
    )
  }, [t])

  useAutoSpeakReplies({
    conversationActive: voiceConversationActive,
    failureLabel: t.assistant.thread.readAloudFailed,
    markSpoken: consumePendingResponse,
    pendingReply: pendingResponse,
    sessionId,
    turnBubbles
  })

  return {
    conversation,
    dictate,
    endConversation,
    handleToggleAutoSpeak,
    startConversation,
    voiceActivityState,
    voiceConversationActive,
    voiceStatus
  }
}
