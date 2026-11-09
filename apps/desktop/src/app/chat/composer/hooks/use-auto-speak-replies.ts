import { useStore } from '@nanostores/react'
import { useEffect, useRef } from 'react'

import { type SpeechBubble, takeQueue } from '@/lib/speech-queue'
import { capSpeechText } from '@/lib/speech-text'
import { releaseUnplayedSpokenReply, spokenReplyOf, spokenSegmentKey } from '@/lib/spoken-reply'
import { playSpeechText, startSpeechStream } from '@/lib/voice-playback'
import type { SpeechStreamSession } from '@/lib/voice-playback'
import { ownsAmbientCue } from '@/store/ambient'
import { notifyError } from '@/store/notifications'
import { $voicePlayback } from '@/store/voice-playback'
import { $autoSpeakReplies, currentSpeechLimit } from '@/store/voice-prefs'

import { useComposerScope } from '../scope'

interface AutoSpeakReply {
  id: string
  pending: boolean
  text: string
  /** Text that identifies this message within its turn: the bubble's last text
   *  part. Hydration folds a tool-call turn into one bubble whose full text
   *  changes, but whose last text part is still this message. Defaults to `text`. */
  segmentText?: string
  /** Survives the live-id rewrite. Absent callers still speak; they just cannot join an in-flight play. */
  turnKey?: string
  /** Characters of this message already spoken; `text` is the remainder. */
  charsBefore?: number
}

// Turns this window speaks for. The window that wins a turn's first message
// voices every later message of that turn, so a second, idle window cannot
// start the final reply over the first window's progress update.
const OWNED_TURNS_MAX = 64
const ownedTurns = new Set<string>()

async function claimSpeech(turnKey: string | undefined, claimKey: string): Promise<boolean> {
  if (turnKey && !ownedTurns.has(turnKey)) {
    if (!(await ownsAmbientCue(`speak:turn:${turnKey}`))) {
      return false
    }

    ownedTurns.add(turnKey)
    console.error(`[asdiag] cue claim turn "${turnKey.slice(-18)}"`)

    if (ownedTurns.size > OWNED_TURNS_MAX) {
      ownedTurns.delete(ownedTurns.values().next().value!)
    }
  }

  const owns = await ownsAmbientCue(claimKey)

  if (owns) {
    console.error(`[asdiag] cue claim "${claimKey.slice(-30)}"`)
  }

  return owns
}

export function clearOwnedSpeechTurnsForTests(): void {
  ownedTurns.clear()
}

// Turns this window has already started reading aloud. The streaming session and
// the sealed re-read both claim by text hash, and that hash changes as the text
// grows — so when the spoken anchor fails to migrate across the hydration id
// rewrite, the sealed pass saw "unspoken" and read the whole reply again (heard
// twice, 2026-11-07). One pass per turn is the invariant; release on a failed
// start so a retry can still speak.
const readTurns = new Map<string, string>()
const READ_TURNS_MAX = 64

/** 同一轮里这段文字已经念过（或它是已念内容的开头）就别再开口。 */
function turnAlreadyRead(turnKey: string | undefined, text: string): boolean {
  const done = turnKey ? readTurns.get(turnKey) : undefined

  if (!done || !text) {
    return false
  }

  return text.startsWith(done) || done.startsWith(text)
}

function markTurnRead(turnKey: string | undefined, text: string): void {
  if (!turnKey || !text) {
    return
  }

  readTurns.set(turnKey, text)

  if (readTurns.size > READ_TURNS_MAX) {
    readTurns.delete(readTurns.keys().next().value!)
  }
}

function releaseTurnRead(turnKey: string | undefined): void {
  if (turnKey) {
    readTurns.delete(turnKey)
  }
}

export function clearReadTurnsForTests(): void {
  readTurns.clear()
}

interface UseAutoSpeakReplies {
  conversationActive: boolean
  failureLabel: string
  /** Mark the current last reply spoken — shared dedupe with the conversation consumer. */
  markSpoken: (replyId?: string, chars?: number) => void
  /** Latest assistant reply, or null; `pending` true while still streaming. */
  pendingReply: () => AutoSpeakReply | null
  /** 这一轮的助手气泡（按顺序，含流式中的那条）——朗读的范围由它决定，不由拼接文本决定。 */
  turnBubbles?: () => SpeechBubble[]
  /** Re-arm on session switch so opening a chat never reads its existing last reply. */
  sessionId: string | null | undefined
}

/** One read-aloud run: the live speech session plus how much text it already has. */
interface LiveSpeech {
  key: string
  session: null | SpeechStreamSession
  opening: boolean
  sent: number
  /** 摘要预算（budget）口径下，本回合已经送出去的累计字数 */
  total: number
  finished: boolean
  /** A seal is already scheduled for this run (see the pending→false re-read). */
  sealing: boolean
  /** Re-reads spent waiting for the text to settle before sealing. */
  sealTries: number
  cappedText: string
  /** Characters of the bubble that were already spoken before this run. */
  charsBefore: number
  marked: ReturnType<typeof spokenReplyOf>
}

/**
 * Pure-TTS auto-speak: when `voice.auto_tts` is on, read assistant replies aloud —
 * no dictation, no conversation loop. A streaming provider is fed while the reply
 * is still generating, so speech overlaps generation instead of waiting for the
 * last token; everything else falls back to reading the finished text once. Stays
 * off while a full voice conversation runs (it speaks replies itself) and never
 * overlaps clips: a reply landing mid-playback is held and spoken on the
 * playback-idle edge. Always reads the latest reply, so a backlog collapses to the
 * newest.
 */
export function useAutoSpeakReplies({
  conversationActive,
  failureLabel,
  markSpoken,
  pendingReply,
  sessionId,
  turnBubbles
}: UseAutoSpeakReplies) {
  const enabled = useStore($autoSpeakReplies)
  // Wake on THIS composer's transcript: a tile subscribed to the primary's
  // would never fire on its own replies (and would fire on someone else's).
  const { $messages, connectionId, profile } = useComposerScope()

  const latest = useRef({
    connectionId,
    conversationActive,
    failureLabel,
    markSpoken,
    pendingReply,
    profile,
    turnBubbles
  })

  latest.current = {
    connectionId,
    conversationActive,
    failureLabel,
    markSpoken,
    pendingReply,
    profile,
    turnBubbles
  }

  useEffect(() => {
    if (!enabled) {
      return undefined
    }

    // Don't read whatever reply already sits at the bottom when the toggle flips
    // on (or a chat opens) — consume it so only later replies are spoken.
    latest.current.markSpoken()

    let attemptSeq = 0
    let live: LiveSpeech | null = null
    let holdTimer: number | null = null


    const stopLive = (finish: boolean) => {
      if (!live) {
        return
      }

      if (finish && live.session && !live.finished) {
        live.finished = true
        live.session.finish()
      }

      live = null
    }

    /** Push whatever text exists right now; finish once nothing more will be spoken. */
    const feed = () => {
      const reply = latest.current.pendingReply()

      if (!live || !reply || !live.session || live.finished) {
        return
      }

      // 摘要方案（付费 API 音色默认）：只念开头一小段，长文留在屏幕上。
      const budget = currentSpeechLimit()
      const target = budget > 0 ? capSpeechText(reply.text, budget) : reply.text

      // The streaming row is swapped for the final message id the moment the
      // turn seals, while the text it carries is the same reply only longer.
      // Treating that id change as "a different message" dropped the reply's
      // last few characters — the spoken audio ended mid-word.
      if (reply.id !== live.key && live.sent > 0 && !target.startsWith(live.cappedText)) {
        // A different bubble: text resumed after a tool call. Returning here
        // dropped it — the session for the previous bubble closed a beat later
        // and no event was left to retry, so the second segment never played
        // (heard only part one, 2026-11-07). Close this pass and let the new
        // bubble open its own.
        const previous = live

        // No mark here: during streaming the bubble id is still the transient
        // one, so an id-based mark cannot resolve and the fallback would mark
        // whatever is last — the new bubble — and silence it.
        previous.finished = true
        previous.sealing = true
        previous.session?.finish()
        live = null
        speakLatest()

        return
      }

      live.key = reply.id
      live.cappedText = target

      // 文本被折叠、重切之后起点会往前挪，长度甚至会比已送字数短——那就从头扫，
      // 靠「已念窗口」把念过的部分挡掉，而不是拿一个错位的偏移去切。
      if (target.length < live.sent) {
        live.sent = 0
      }

      // 队列是唯一取料通道：不管有没有摘要预算，都不再按「整段拼接文本的偏移」
      // 切片——今天所有重复都来自那条路径（2026-11-08）。预算只决定送到哪里收口。
      const bubbles = latest.current.turnBubbles?.() ?? [{ sealed: !reply.pending, text: reply.text }]
      const items = takeQueue(sessionId, bubbles)

      live.sent = target.length

      let remaining = budget > 0 ? Math.max(0, budget - live.total) : Number.POSITIVE_INFINITY

      for (const item of items) {
        let chunk = item.chunk

        if (remaining < chunk.length) {
          chunk = chunk.slice(0, Math.max(0, remaining))
        }

        if (!chunk) {
          continue
        }

        console.error(`[asdiag] append send=${chunk.length}`)
        live.session.append(chunk)
        live.total += chunk.length
        remaining -= chunk.length
      }

      if (budget > 0 && live.total >= budget) {
        latest.current.markSpoken(reply.id, live.charsBefore + reply.text.length)
        live.marked = spokenReplyOf(sessionId)
        live.finished = true
        live.sealing = true
        live.session.finish()

        return
      }

      if (!reply.pending) {
        // `pending` flips before the reply's final text part reaches the store;
        // sealing on this tick sent text that stopped mid-sentence and the
        // spoken audio lost its last clause. Re-read once the store settles.
        if (!live.sealing) {
          live.sealing = true
          const slot = live

          const seal = () => {
            if (live !== slot || !slot.session || slot.finished) {
              return
            }

            const late = latest.current.pendingReply()
            let grew = false

            if (late && (late.id === slot.key || late.text.startsWith(slot.cappedText))) {
              if (!late.text.trim()) {
                return
              }

              const items = takeQueue(sessionId, latest.current.turnBubbles?.() ?? [{ sealed: true, text: late.text }])

              for (const item of items) {
                console.error(`[asdiag] seal+ send=${item.chunk.length}`)
                slot.session.append(item.chunk)
              }

              grew = true
            }

            // The store can keep growing for a beat after `pending` flips; seal
            // only once it settles, or the tail is cut again on a slow tick.
            if (grew && ++slot.sealTries < 8) {
              window.setTimeout(seal, 250)

              return
            }

            // Mark only now: `pendingReply()` returns null for an id already
            // marked spoken, so marking up front would blind the re-read above.
            latest.current.markSpoken(slot.key, slot.charsBefore + slot.cappedText.length)
            slot.marked = spokenReplyOf(sessionId)
            slot.finished = true
            slot.session.finish()
          }

          window.setTimeout(seal, 250)
        }

        return
      }
    }

    /** Read a finished reply once through the non-streaming path. */
    const speakSealed = (reply: AutoSpeakReply, segmentKey: null | string, claimKey: string) => {
      const attempt = ++attemptSeq
      const { connectionId, failureLabel, markSpoken, profile } = latest.current

      void claimSpeech(reply.turnKey, claimKey).then(owns => {
        if (attempt !== attemptSeq) {
          return
        }

        if (!owns) {
          // Another window owns this turn, or this message was already voiced.
          console.debug('[auto-speak] claim already taken', claimKey)

          return
        }

        markSpoken(reply.id, (reply.charsBefore ?? 0) + reply.text.length)
        const marked = spokenReplyOf(sessionId)
        // 摘要方案（付费 API 音色默认）：只念开头一小段，长文留在屏幕上。
        const budget = currentSpeechLimit()

        const sealItems =
          budget > 0
            ? [{ chunk: capSpeechText(reply.text, budget), key: 'budget' }]
            : takeQueue(sessionId, latest.current.turnBubbles?.() ?? [{ sealed: true, text: reply.text }])

        markTurnRead(reply.turnKey, sealItems.map(item => item.chunk).join(''))

        const spokenText = sealItems.map(item => item.chunk).join('')

        // 整段都已经念过：不再开口。封口这条路的重复全落在这里。
        if (!spokenText.trim()) {
          console.error('[asdiag] seal replay suppressed')

          return
        }

        console.error(
          `[asdiag] seal tq chunks=${sealItems.length} heads=[${sealItems
            .slice(0, 4)
            .map(item => item.chunk.slice(0, 6))
            .join('|')}]`
        )

        // 差分探针：五句只剩四句合成、无发送记录的第二遍，来自 playSpeechText 旁路
        // （2026-11-09 12:55 实测）。给每个调用点独立标记，找到凶手为止。
        console.error(`[asdiag] seal play len=${spokenText.length} "${spokenText.slice(0, 12)}…"`)

        void playSpeechText(spokenText, {
          connectionId,
          messageId: reply.id,
          profile,
          source: 'read-aloud',
          ...(segmentKey ? { turnKey: segmentKey } : {})
        }).then(
          started => {
            if (!started && attempt === attemptSeq) {
              releaseUnplayedSpokenReply(sessionId, marked)
            }
          },
          error => {
            if (attempt === attemptSeq) {
              releaseUnplayedSpokenReply(sessionId, marked)
              notifyError(error, failureLabel)
            }
          }
        )
      })
    }

    const speakLatest = () => {
      const { conversationActive, pendingReply } = latest.current

      if (conversationActive) {
        return
      }

      const reply = pendingReply()

      if (!reply || !reply.text.trim()) {
        return
      }

      // A different message than the one being read: drop the old run. Before it
      // has spoken anything the id may simply have been rewritten under us, so
      // let feed() adopt the new one instead of killing the session.
      if (live && live.key !== reply.id && live.sent > 0) {
        stopLive(true)
      }

      // Another clip is playing (previous reply, manual playback): hold this one.
      // Poll instead of waiting for the idle event — when the player was already
      // mid-clip the transition that follows does not re-run this, and the reply
      // was stranded unspoken (only part one heard, 2026-11-07).
      if (!live && $voicePlayback.get().status !== 'idle') {
        console.error('[asdiag] hold: another clip playing')

        if (holdTimer === null) {
          holdTimer = window.setTimeout(() => {
            holdTimer = null
            console.error('[asdiag] retry')
            speakLatest()
          }, 500)
        }

        return
      }

      // Only one window voices a turn when the same chat is open in several:
      // the turn's owner (see claimSpeech), then once per message. Keys are the
      // turn and its message text, not the row id: hydration rewrites the row
      // id, and a second claim would start a second clip.
      const segmentKey = reply.turnKey ? spokenSegmentKey(reply.turnKey, reply.segmentText ?? reply.text) : null
      const claimKey = `speak:${segmentKey ?? reply.id}`

      // Sealed reply: nothing left to stream, read it once.
      if (!reply.pending && !live) {
        if (turnAlreadyRead(reply.turnKey, reply.text)) {
          return
        }

        speakSealed(reply, segmentKey, claimKey)

        return
      }

      if (live) {
        feed()

        return
      }

      // Streaming reply: open the speech session on the first delta, then keep feeding it.
      const attempt = ++attemptSeq

      const slot: LiveSpeech = {
        key: reply.id,
        session: null,
        opening: true,
        sent: 0,
        total: 0,
        finished: false,
        sealing: false,
        sealTries: 0,
        cappedText: '',
        charsBefore: reply.charsBefore ?? 0,
        marked: null
      }

      live = slot

      const { connectionId, failureLabel, markSpoken, profile } = latest.current

      void claimSpeech(reply.turnKey, claimKey).then(async owns => {
        if (attempt !== attemptSeq || live !== slot) {
          return
        }

        if (!owns) {
          console.error('[asdiag] claim refused')
          live = null

          return
        }

        markTurnRead(reply.turnKey, reply.text)

        const session = await startSpeechStream({
          connectionId,
          messageId: reply.id,
          profile,
          source: 'read-aloud',
          ...(segmentKey ? { turnKey: segmentKey } : {})
        })

        if (attempt !== attemptSeq || live !== slot) {
          session?.finish()

          return
        }

        console.error(`[asdiag] session opened=${Boolean(session)}`)

        if (!session) {
          // No streaming backend/provider: read it once when the turn seals.
          releaseTurnRead(reply.turnKey)
          live = null
          const done = pendingReply()

          if (done && !done.pending && done.id === reply.id) {
            speakSealed(done, segmentKey, claimKey)
          } else {
            releaseUnplayedSpokenReply(sessionId, slot.marked)
          }

          return
        }

        slot.session = session
        slot.opening = false
        feed()

        void session.done.then(
          outcome => {
            console.error(`[asdiag] done=${outcome} sent=${slot.sent} capped=${slot.cappedText.length}`)

            if (live === slot) {
              live = null
            }

            if (outcome === 'fallback') {
              releaseUnplayedSpokenReply(sessionId, slot.marked)

              const fallbackText = takeQueue(
                sessionId,
                latest.current.turnBubbles?.() ?? [{ sealed: true, text: slot.cappedText }]
              )
                .map(item => item.chunk)
                .join('')

              if (fallbackText.trim()) {
                console.error(`[asdiag] fallback play len=${fallbackText.length} "${fallbackText.slice(0, 12)}…"`)

                void playSpeechText(fallbackText, {
                  connectionId,
                  messageId: slot.key,
                  profile,
                  source: 'read-aloud',
                  ...(segmentKey ? { turnKey: segmentKey } : {})
                }).catch(error => notifyError(error, failureLabel))
              }
            }
          },
          error => {
            if (live === slot) {
              live = null
            }

            releaseTurnRead(reply.turnKey)
            releaseUnplayedSpokenReply(sessionId, slot.marked)
            notifyError(error, failureLabel)
          }
        )
      })
    }

    // Re-check on a reply completing ($messages) and on the prior clip ending
    // ($voicePlayback → idle), which frees us to read the next held reply.
    const stops = [$messages.subscribe(speakLatest), $voicePlayback.listen(speakLatest)]

    return () => {
      attemptSeq += 1
      stopLive(false)
      stops.forEach(f => f())
    }
  }, [$messages, enabled, sessionId])
}
