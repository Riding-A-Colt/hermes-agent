import { useStore } from '@nanostores/react'
import { useEffect, useRef } from 'react'

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

    if (ownedTurns.size > OWNED_TURNS_MAX) {
      ownedTurns.delete(ownedTurns.values().next().value!)
    }
  }

  return ownsAmbientCue(claimKey)
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
  markSpoken: () => void
  /** Latest assistant reply, or null; `pending` true while still streaming. */
  pendingReply: () => AutoSpeakReply | null
  /** Re-arm on session switch so opening a chat never reads its existing last reply. */
  sessionId: string | null | undefined
}

/** One read-aloud run: the live speech session plus how much text it already has. */
interface LiveSpeech {
  key: string
  session: null | SpeechStreamSession
  opening: boolean
  sent: number
  finished: boolean
  /** A seal is already scheduled for this run (see the pending→false re-read). */
  sealing: boolean
  /** Re-reads spent waiting for the text to settle before sealing. */
  sealTries: number
  cappedText: string
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
  sessionId
}: UseAutoSpeakReplies) {
  const enabled = useStore($autoSpeakReplies)
  // Wake on THIS composer's transcript: a tile subscribed to the primary's
  // would never fire on its own replies (and would fire on someone else's).
  const { $messages, connectionId, profile } = useComposerScope()
  const latest = useRef({ connectionId, conversationActive, failureLabel, markSpoken, pendingReply, profile })
  latest.current = { connectionId, conversationActive, failureLabel, markSpoken, pendingReply, profile }

  useEffect(() => {
    if (!enabled) {
      return undefined
    }

    // Don't read whatever reply already sits at the bottom when the toggle flips
    // on (or a chat opens) — consume it so only later replies are spoken.
    latest.current.markSpoken()

    let attemptSeq = 0
    let live: LiveSpeech | null = null

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
        return
      }

      live.key = reply.id
      live.cappedText = target

      if (target.length > live.sent) {
        console.error(`[asdiag] append ${live.sent}->${target.length}`)
        live.session.append(target.slice(live.sent))
        live.sent = target.length
      }

      if (budget > 0 && target.length >= budget) {
        latest.current.markSpoken()
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
              const lateTarget = budget > 0 ? capSpeechText(late.text, budget) : late.text

              if (lateTarget.length > slot.sent) {
                console.error(`[asdiag] seal+ ${slot.sent}->${lateTarget.length}`)
                slot.session.append(lateTarget.slice(slot.sent))
                slot.sent = lateTarget.length
                slot.cappedText = lateTarget
                grew = true
              }
            }

            // The store can keep growing for a beat after `pending` flips; seal
            // only once it settles, or the tail is cut again on a slow tick.
            if (grew && ++slot.sealTries < 8) {
              window.setTimeout(seal, 250)

              return
            }

            // Mark only now: `pendingReply()` returns null for an id already
            // marked spoken, so marking up front would blind the re-read above.
            latest.current.markSpoken()
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

        markSpoken()
        const marked = spokenReplyOf(sessionId)
        // 摘要方案（付费 API 音色默认）：只念开头一小段，长文留在屏幕上。
        const budget = currentSpeechLimit()
        const spokenText = budget > 0 ? capSpeechText(reply.text, budget) : reply.text

        markTurnRead(reply.turnKey, spokenText)

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
      if (!live && $voicePlayback.get().status !== 'idle') {
        console.error('[asdiag] hold: another clip playing')

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
        finished: false,
        sealing: false,
        sealTries: 0,
        cappedText: '',
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

              if (slot.cappedText) {
                void playSpeechText(slot.cappedText, {
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
