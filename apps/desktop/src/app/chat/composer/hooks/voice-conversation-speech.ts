import type { RefObject } from 'react'

import { capSpeechText, cutSentences } from '@/lib/speech-text'
import type { SpeechStreamSession } from '@/lib/voice-playback'
import { currentSpeechLimit } from '@/store/voice-prefs'

export interface PendingVoiceResponse {
  id: string
  pending: boolean
  text: string
}

/** Per-turn speech bookkeeping owned by the composer hook. */
export interface VoiceSpeechState {
  /** Text pulled from the reply but not yet handed to the session (partial sentence). */
  pendingText: RefObject<string>
  /** Reply text as of the last feed — recognises the id rewrite on the sealing frame. */
  lastFoldedText: RefObject<string>
  /** The seal re-read loop is running for this turn. */
  sealing: RefObject<boolean>
  /** How many times the seal loop has re-read; capped so a stuck turn still finishes. */
  sealTries: RefObject<number>
}

/**
 * Push any new reply text into the live session; finish when complete.
 *
 * [lily] Diverges from the upstream shape on purpose:
 * - The same reply arrives under two ids (the streaming bubble is replaced by the
 *   real message on the sealing frame), so equality is loosened to "text keeps
 *   growing from what we last saw"; a strict id compare dropped the tail.
 * - Sentences are cut client-side and each is closed with a blank line: the server
 *   only splits on "ASCII period + space", so a Chinese reply would otherwise
 *   buffer the whole answer before synthesising.
 * - `capSpeechText` keeps the spoken part inside the configured budget.
 * - `pending` flips before the last characters land in the store, so the seal
 *   re-reads (up to 8×250 ms) and sends only what grew.
 */
export function feedVoiceConversationSpeech(
  speechSession: RefObject<SpeechStreamSession | null>,
  activeResponseId: RefObject<string | null>,
  responseId: string,
  pendingResponse: () => PendingVoiceResponse | null,
  spokenSourceLength: RefObject<number>,
  busy: RefObject<boolean>,
  state: VoiceSpeechState
) {
  const session = speechSession.current

  if (!session || activeResponseId.current !== responseId) {
    return
  }

  const response = pendingResponse()
  console.error(
    `[vsdiag] feed busy=${busy.current} resp=${response?.id ?? '-'} pending=${response?.pending} len=${response?.text?.length ?? 0}`
  )

  const { pendingText, lastFoldedText, sealing, sealTries } = state

  // 同一条回复，两种样子：还没换 id，或者 id 已被正式消息顶掉但文本接着长。
  // 后者是常态——流式气泡在封印那一帧被替换，严格 id 比较会把这之后的
  // 每一帧都判成「不是这条」，剩下的尾巴再也送不出去（实测末句停在一半）。
  const sameReply =
    response !== null &&
    (response.id === responseId || (lastFoldedText.current !== '' && response.text.startsWith(lastFoldedText.current)))

  if (sameReply) {
    lastFoldedText.current = response!.text

    // 摘要方案：只把开头一小段喂进语音会话，剩下的正文留在屏幕上。
    const budget = currentSpeechLimit()
    const speakable = budget > 0 ? capSpeechText(response!.text, budget) : response!.text
    const capped = budget > 0 && response!.text.length > speakable.length

    if (speakable.length > spokenSourceLength.current) {
      pendingText.current += speakable.slice(spokenSourceLength.current)
      spokenSourceLength.current = speakable.length
    }

    // 客户端先按句切开、每句补一个空行（见上面的说明）。
    const { sentences, rest } = cutSentences(pendingText.current, false)
    pendingText.current = rest

    for (const sentence of sentences) {
      session.append(`${sentence.trim()}\n\n`)
    }

    if (capped && pendingText.current.trim()) {
      // 预算用完了：剩下的尾巴现在就送出去，不再等这条回复收尾。
      session.append(`${pendingText.current.trim()}\n\n`)
      pendingText.current = ''
    }

    if (!response!.pending) {
      if (pendingText.current.trim()) {
        session.append(`${pendingText.current.trim()}\n\n`)
        pendingText.current = ''
      }

      // A sealed interim is a committed boundary even while its tool runs.
      // Keep the session open for the next bubble, but speak this tail now.
      if (busy.current) {
        session.flush?.()

        return
      }

      // `pending` 先翻 false、最后几个字后落进 store（与自动朗读同一个坑）。
      // 当场收流就是 243 字的回复只念到 230 字。重读到文本不再增长为止
      // （上限 8 次 / 每 250ms），每次只把新增的尾巴送出去。
      if (!sealing.current) {
        sealing.current = true

        const seal = () => {
          if (speechSession.current !== session || activeResponseId.current !== responseId) {
            return
          }

          const late = pendingResponse()
          let grew = false

          if (late && (late.id === responseId || late.text.startsWith(lastFoldedText.current))) {
            lastFoldedText.current = late.text
            const lateBudget = currentSpeechLimit()
            const lateSpeakable = lateBudget > 0 ? capSpeechText(late.text, lateBudget) : late.text

            if (lateSpeakable.length > spokenSourceLength.current) {
              console.error(`[vsdiag] seal+ ${spokenSourceLength.current}->${lateSpeakable.length}`)
              pendingText.current += lateSpeakable.slice(spokenSourceLength.current)
              spokenSourceLength.current = lateSpeakable.length
              grew = true
            }
          }

          const { sentences: lateSentences, rest: lateRest } = cutSentences(pendingText.current, false)
          pendingText.current = lateRest

          for (const sentence of lateSentences) {
            session.append(`${sentence.trim()}\n\n`)
          }

          if (grew && ++sealTries.current < 8) {
            window.setTimeout(seal, 250)

            return
          }

          if (pendingText.current.trim()) {
            session.append(`${pendingText.current.trim()}\n\n`)
            pendingText.current = ''
          }

          session.finish()
        }

        window.setTimeout(seal, 250)
      }
    }
  } else if (!busy.current) {
    // Reply consumed/vanished while we were speaking — close out the turn.
    // Whatever we had not handed over yet goes first: a very short reply
    // ("2。") never reaches a sentence boundary, so dropping the buffer
    // here is what left it silent.
    if (pendingText.current.trim()) {
      session.append(`${pendingText.current.trim()}\n\n`)
      pendingText.current = ''
    }

    session.finish()
  }
}
