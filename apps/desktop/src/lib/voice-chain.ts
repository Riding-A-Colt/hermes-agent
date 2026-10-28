/**
 * chained 语音的「搭配方案」——一对 STT/TTS 提供方，外加播报长度。
 *
 * 后端跑 chained 引擎时只认 `stt.provider` / `tts.provider` 两个键，方案不是
 * 新的运行时开关：选中一条方案 = 把这两个键一起写下去。方案本身存在
 * `voice.chained` 里，只为了让设置页和语音按钮的下拉框有话可说、能一键切换。
 *
 * 播报长度同理：`speak: summary` 时，语音只念开头一小段（`speakMaxChars`，
 * 默认 50 字），剩下的正文留在屏幕上。付费云端 TTS 默认摘要，本地/命令型
 * 默认全文——五十字中文的音频已经够像 GPT-Live 的一次简短回应了，再长就是
 * 在念文档。
 */

export type VoiceChainSpeak = 'full' | 'summary'

export interface VoiceChainScheme {
  /** 稳定标识；改标签不会断开 active 的指向。 */
  id: string
  label: string
  /** 缺席时按 TTS 类型推导，见 defaultSpeakFor。 */
  speak?: VoiceChainSpeak
  stt: string
  tts: string
}

export interface VoiceChainState {
  active: string
  schemes: VoiceChainScheme[]
  speakMaxChars: number
}

export const DEFAULT_SPEAK_MAX_CHARS = 50

/** Config path for the whole chain block. */
export const VOICE_CHAIN_KEY = 'voice.chained'

/**
 * 按「是否花 API 的钱」分类。付费云端默认只播摘要；edge/piper/kittentts/
 * neutts 以及所有命令型 provider（kokoro、asuka 这类本地脚本）默认全文。
 */
export const PAID_API_TTS: readonly string[] = [
  'deepinfra',
  'elevenlabs',
  'gemini',
  'minimax',
  'mistral',
  'openai',
  'xai'
]

export function defaultSpeakFor(tts: string): VoiceChainSpeak {
  return PAID_API_TTS.includes(tts.trim().toLowerCase()) ? 'summary' : 'full'
}

/** 8 位小写字母数字，够短、够不撞，也不会像 uuid 那样把 config 撑丑。 */
export function newSchemeId(): string {
  return Math.random().toString(36).slice(2, 10)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

function nested(config: unknown, path: readonly string[]): unknown {
  let cur: unknown = config

  for (const part of path) {
    if (!isRecord(cur) || !Object.prototype.hasOwnProperty.call(cur, part)) {
      return undefined
    }

    cur = cur[part]
  }

  return cur
}

function asScheme(raw: unknown): null | VoiceChainScheme {
  if (!isRecord(raw)) {
    return null
  }

  const stt = text(raw.stt)
  const tts = text(raw.tts)
  const id = text(raw.id)

  if (!id || !stt || !tts) {
    return null
  }

  const speak = raw.speak === 'summary' || raw.speak === 'full' ? raw.speak : undefined

  return {
    id,
    label: text(raw.label) || `${stt} + ${tts}`,
    stt,
    tts,
    ...(speak ? { speak } : {})
  }
}

/** The provider pair the runtime is actually using right now. */
export function currentPair(config: unknown): { stt: string; tts: string } {
  // Backend defaults: STT → local, TTS → edge.
  return {
    stt: text(nested(config, ['stt', 'provider'])) || 'local',
    tts: text(nested(config, ['tts', 'provider'])) || 'edge'
  }
}

function seededScheme(config: unknown): VoiceChainScheme {
  const pair = currentPair(config)

  return {
    id: 'current',
    label: `${pair.stt} + ${pair.tts}`,
    speak: defaultSpeakFor(pair.tts),
    ...pair
  }
}

/**
 * Parse `voice.chained`. Never writes: a profile that has never opened the
 * picker gets one scheme derived from the live provider keys, so the settings
 * block and the composer menu always have something to show (and switching to
 * it persists the block in full).
 */
export function readVoiceChain(config: unknown): VoiceChainState {
  const block = nested(config, ['voice', 'chained'])
  const rawSchemes = isRecord(block) && Array.isArray(block.schemes) ? block.schemes : []
  const schemes = rawSchemes.map(asScheme).filter((scheme): scheme is VoiceChainScheme => scheme !== null)

  const list = schemes.length > 0 ? schemes : [seededScheme(config)]
  const storedActive = isRecord(block) ? text(block.active) : ''
  const active = list.some(scheme => scheme.id === storedActive) ? storedActive : list[0].id

  const rawMax = isRecord(block) ? block.speak_max_chars : undefined
  const max = typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax > 0 ? Math.round(rawMax) : DEFAULT_SPEAK_MAX_CHARS

  return { active, schemes: list, speakMaxChars: max }
}

export function activeScheme(state: VoiceChainState): VoiceChainScheme {
  return state.schemes.find(scheme => scheme.id === state.active) ?? state.schemes[0]
}

/** The scheme's effective speak mode (stored value else the TTS-type default). */
export function schemeSpeak(scheme: VoiceChainScheme): VoiceChainSpeak {
  return scheme.speak ?? defaultSpeakFor(scheme.tts)
}

/** `voice.chained` as it should be persisted for this state. */
export function voiceChainBlock(state: VoiceChainState): Record<string, unknown> {
  return {
    active: state.active,
    schemes: state.schemes.map(scheme => ({
      id: scheme.id,
      label: scheme.label,
      stt: scheme.stt,
      tts: scheme.tts,
      speak: schemeSpeak(scheme)
    })),
    speak_max_chars: state.speakMaxChars
  }
}

/**
 * Config patch for switching to a scheme: the chain block plus the two keys the
 * backend actually reads. One PUT, so the pair can never land half-applied.
 */
export function schemeSwitchPatch(state: VoiceChainState, schemeId: string): Record<string, unknown> {
  const scheme = state.schemes.find(entry => entry.id === schemeId) ?? activeScheme(state)

  return {
    stt: { provider: scheme.stt },
    tts: { provider: scheme.tts },
    voice: { chained: voiceChainBlock({ ...state, active: scheme.id, schemes: state.schemes }) }
  }
}

/** After deleting `removedId`: the scheme that should be active, or '' when none are left. */
export function nextActiveAfterRemove(schemes: readonly VoiceChainScheme[], activeId: string, removedId: string): string {
  if (activeId !== removedId) {
    return activeId
  }

  const remaining = schemes.filter(scheme => scheme.id !== removedId)

  return remaining[0]?.id ?? ''
}

/**
 * Character budget for the next spoken reply: 0 = read the whole text.
 * Only chained mode bounds anything — gpt-live's own voice model decides.
 */
export function speechLimitFor(config: unknown): number {
  const mode = text(nested(config, ['voice', 'voice_chat_mode'])) || 'chained'

  if (mode !== 'chained') {
    return 0
  }

  return speechLimitForScheme(readVoiceChain(config), null)
}

/** 预算的纯状态版：给已经拿到 `voice.chained` 的调用方用（切换方案后立即生效，
 *  不必等下一次 config 拉取）。`schemeId` 为 null 时取当前 active。 */
export function speechLimitForScheme(state: VoiceChainState, schemeId: null | string): number {
  const scheme = schemeId ? (state.schemes.find(entry => entry.id === schemeId) ?? activeScheme(state)) : activeScheme(state)

  return schemeSpeak(scheme) === 'summary' ? state.speakMaxChars : 0
}
