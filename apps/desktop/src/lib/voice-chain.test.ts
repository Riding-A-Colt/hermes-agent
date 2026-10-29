import { describe, expect, it } from 'vitest'

import {
  activeScheme,
  DEFAULT_SPEAK_MAX_CHARS,
  defaultSpeakFor,
  nextActiveAfterRemove,
  readVoiceChain,
  schemeSpeak,
  schemeSwitchPatch,
  speechLimitFor,
  voiceChainBlock,
  type VoiceChainScheme
} from './voice-chain'

const config = (voice: Record<string, unknown> = {}, stt = 'local-paraformer', tts = 'kokoro') => ({
  voice,
  stt: { provider: stt },
  tts: { provider: tts }
})

const schemes: VoiceChainScheme[] = [
  { id: 'a', label: 'A', stt: 'local-paraformer', tts: 'asuka', speak: 'summary' },
  { id: 'b', label: 'B', stt: 'local-paraformer', tts: 'kokoro', speak: 'full' }
]

describe('readVoiceChain', () => {
  it('seeds one scheme from the live provider keys when nothing is stored', () => {
    const chain = readVoiceChain(config())

    expect(chain.schemes).toHaveLength(1)
    expect(chain.schemes[0]).toMatchObject({ stt: 'local-paraformer', tts: 'kokoro', speak: 'full' })
    expect(chain.active).toBe(chain.schemes[0].id)
    expect(chain.speakMaxChars).toBe(DEFAULT_SPEAK_MAX_CHARS)
  })

  it('reads a stored block and keeps a valid active pointer', () => {
    const chain = readVoiceChain(config({ chained: { active: 'b', schemes, speak_max_chars: 30 } }))

    expect(chain.schemes).toHaveLength(2)
    expect(chain.active).toBe('b')
    expect(chain.speakMaxChars).toBe(30)
  })

  it('falls back to the first scheme when the stored active id is gone', () => {
    const chain = readVoiceChain(config({ chained: { active: 'missing', schemes } }))

    expect(chain.active).toBe('a')
  })

  it('drops malformed schemes instead of rendering half a row', () => {
    const chain = readVoiceChain(
      config({ chained: { schemes: [{ id: 'x', stt: 'a' }, 'nope', { id: 'y', stt: 'a', tts: 'b' }] } })
    )

    expect(chain.schemes.map(scheme => scheme.id)).toEqual(['y'])
  })
})

describe('speak mode', () => {
  it('defaults paid API voices to summary and local voices to full text', () => {
    expect(defaultSpeakFor('openai')).toBe('summary')
    expect(defaultSpeakFor('ELEVENLABS')).toBe('summary')
    expect(defaultSpeakFor('kokoro')).toBe('full')
    expect(defaultSpeakFor('asuka')).toBe('full')
    expect(defaultSpeakFor('edge')).toBe('full')
  })

  it('honours an explicit scheme value over the type default', () => {
    expect(schemeSpeak({ id: 'x', label: 'x', stt: 'a', tts: 'openai', speak: 'full' })).toBe('full')
  })

  it('only bounds speech in chained mode', () => {
    const summaryOnly = config({ chained: { active: 'a', schemes }, voice_chat_mode: 'chained' })

    expect(speechLimitFor(summaryOnly)).toBe(DEFAULT_SPEAK_MAX_CHARS)

    expect(speechLimitFor({ ...summaryOnly, voice: { ...summaryOnly.voice, voice_chat_mode: 'gpt-live' } })).toBe(0)
  })

  it('returns 0 (read everything) for a full-text scheme', () => {
    const full = config({ chained: { active: 'b', schemes } })

    expect(speechLimitFor(full)).toBe(0)
  })
})

describe('writes', () => {
  it('switch patch carries the pair plus the chain block in one record', () => {
    const state = readVoiceChain(config({ chained: { active: 'a', schemes } }))
    const patch = schemeSwitchPatch(state, 'b')

    expect(patch).toMatchObject({
      stt: { provider: 'local-paraformer' },
      tts: { provider: 'kokoro' },
      voice: { chained: { active: 'b' } }
    })
    expect((patch.voice as { chained: { schemes: unknown[] } }).chained.schemes).toHaveLength(2)
  })

  it('persisted block materializes the effective speak mode', () => {
    const state = readVoiceChain(config({ chained: { active: 'a', schemes: [{ id: 'a', label: 'A', stt: 'x', tts: 'openai' }] } }))
    const block = voiceChainBlock(state) as { schemes: Array<{ speak: string }> }

    expect(block.schemes[0].speak).toBe('summary')
  })

  it('picks a surviving scheme when the active one is deleted', () => {
    expect(nextActiveAfterRemove(schemes, 'a', 'a')).toBe('b')
    expect(nextActiveAfterRemove(schemes, 'b', 'a')).toBe('b')
    expect(nextActiveAfterRemove([schemes[0]], 'a', 'a')).toBe('')
  })
})

describe('activeScheme', () => {
  it('resolves the active row', () => {
    expect(activeScheme({ active: 'b', schemes, speakMaxChars: 50 }).id).toBe('b')
  })
})
