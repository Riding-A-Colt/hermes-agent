import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $voicePlayback } from '@/store/voice-playback'

import { startSpeechChain, stopVoicePlayback } from './voice-playback'

// 语音链的契约（用户原话）：
//   1. 本地音色边生成边念；
//   2. 整段念完，不能到 3/4 就断；
//   3. 「正在准备音频」只出现在最开始一次，中途中不再弹。

const spoken: string[] = []

vi.mock('@/hermes', () => ({
  getApiRequestConnection: () => null,
  getApiRequestProfile: () => null,
  speakText: (text: string) => {
    spoken.push(text)

    return Promise.resolve({ data_url: `data:audio/wav;base64,${text.length}` })
  }
}))

vi.mock('@/api/canonical-protocol', () => ({ openGatewaySocket: vi.fn() }))
vi.mock('@/lib/voice-client-direct', () => ({
  directTtsConfig: vi.fn(async () => null),
  synthesizeSpeechClientDirect: vi.fn()
}))

class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = []
  src: string

  constructor(src: string) {
    super()
    this.src = src
    FakeAudio.instances.push(this)
  }

  play = vi.fn(async () => undefined)
  pause = vi.fn()
  load = vi.fn()
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** 逐个给音频发 ended，直到 done 落定（最多 40 步）。 */
async function playAll(done: Promise<string>) {
  let settled: string | null = null
  void done.then(outcome => {
    settled = outcome
  })

  let ended = 0

  for (let step = 0; step < 40 && settled === null; step += 1) {
    const next = FakeAudio.instances[ended]

    if (next) {
      next.dispatchEvent(new Event('ended'))
      ended += 1
    }

    await sleep(40)
  }

  return settled
}

describe('startSpeechChain', () => {
  beforeEach(() => {
    spoken.length = 0
    FakeAudio.instances = []
    vi.stubGlobal('Audio', FakeAudio)
    $voicePlayback.set({ audioElement: null, messageId: null, sequence: 0, source: null, status: 'idle' })
  })

  afterEach(() => {
    stopVoicePlayback()
    vi.unstubAllGlobals()
  })

  it('plays every sentence it was given, in order', async () => {
    const chain = startSpeechChain({ source: 'voice-conversation', syncOnly: true })

    chain.append('第一句。')
    chain.append('第二句。')
    chain.append('第三句。')
    chain.finish()

    const outcome = await playAll(chain.done)

    expect(outcome).toBe('done')
    expect(spoken).toEqual(['第一句。', '第二句。', '第三句。'])
    expect(FakeAudio.instances).toHaveLength(3)
  })

  it('enters preparing exactly once and never goes back to it', async () => {
    const statuses: string[] = []
    const unsubscribe = $voicePlayback.subscribe(state => {
      const last = statuses[statuses.length - 1]

      if (state.status !== last) {
        statuses.push(state.status)
      }
    })

    const chain = startSpeechChain({ source: 'voice-conversation', syncOnly: true })

    chain.append('第一句。')
    await sleep(60)
    chain.append('第二句。')
    chain.finish()
    await playAll(chain.done)
    unsubscribe()

    // subscribe 会先回调一次当前值，去掉它才看得到变化序列。
    const transitions = statuses.slice(1)

    expect(transitions.filter(status => status === 'preparing')).toHaveLength(1)
    expect(transitions[0]).toBe('preparing')
    expect(transitions[transitions.length - 1]).toBe('idle')
  })

  it('keeps the tail: a sentence appended right before finish still plays', async () => {
    const chain = startSpeechChain({ source: 'voice-conversation', syncOnly: true })

    chain.append('开头。')
    await sleep(60)
    chain.append('尾巴在这里。')
    chain.finish()

    await playAll(chain.done)

    expect(spoken).toContain('尾巴在这里。')
  })

  it('stops every queued clip when playback is interrupted', async () => {
    const chain = startSpeechChain({ source: 'voice-conversation', syncOnly: true })

    chain.append('第一句。')
    chain.append('第二句。')
    chain.append('第三句。')
    await sleep(60)
    stopVoicePlayback()

    const outcome = await playAll(chain.done)

    expect(outcome).toBe('fallback')
    expect(spoken).not.toContain('第三句。')
  })
})
