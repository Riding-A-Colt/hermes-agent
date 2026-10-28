import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getHermesConfigSchema } from '@/hermes'
import { useI18n } from '@/i18n'
import {
  activeScheme,
  newSchemeId,
  nextActiveAfterRemove,
  readVoiceChain,
  schemeSpeak,
  speechLimitForScheme,
  VOICE_CHAIN_KEY,
  voiceChainBlock,
  type VoiceChainScheme,
  type VoiceChainSpeak,
  type VoiceChainState
} from '@/lib/voice-chain'
import { $speechCharLimit } from '@/store/voice-prefs'
import type { HermesConfigRecord } from '@/types/hermes'

import { getNested, setConfigField } from './helpers'

/**
 * Settings → Voice → chained 的「搭配方案」编辑器。
 *
 * 一个方案就是一对提供方（识别 + 合成）+ 播报长度。选中哪条就写哪条：选中
 * 动作会同时落 `voice.chained`、`stt.provider`、`tts.provider`，因为后端
 * chained 引擎只认后两个键——方案只是它俩的命名包装。
 *
 * 只在 chained 模式下出现：gpt-live 的语音由 OpenAI 模型自己决定，这套选择
 * 对它没有意义。
 */
export function VoiceChainSchemes({
  config,
  onChange
}: {
  config: HermesConfigRecord
  onChange: (next: HermesConfigRecord) => void
}) {
  const { t } = useI18n()
  const c = t.settings.config
  const state = readVoiceChain(config)

  const { data: schemaResponse } = useQuery({
    queryKey: ['hermes-config-schema'],
    queryFn: () => getHermesConfigSchema(),
    staleTime: 5 * 60 * 1000
  })

  const schemaFields = schemaResponse?.fields ?? {}

  const options = useMemo(() => {
    const pick = (key: 'stt.provider' | 'tts.provider', current: string[]) => {
      const raw = schemaFields[key]?.options
      const listed = Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string') : []
      const merged = [...listed]

      for (const value of current) {
        if (value && !merged.includes(value)) {
          merged.push(value)
        }
      }

      return merged
    }

    return {
      stt: pick(
        'stt.provider',
        state.schemes.map(scheme => scheme.stt)
      ),
      tts: pick(
        'tts.provider',
        state.schemes.map(scheme => scheme.tts)
      )
    }
  }, [schemaFields, state.schemes])

  const write = (next: VoiceChainState, switchPair: boolean) => {
    let updated = setConfigField(config, VOICE_CHAIN_KEY, voiceChainBlock(next))

    if (switchPair) {
      const scheme = activeScheme(next)
      updated = setConfigField(setConfigField(updated, 'stt.provider', scheme.stt), 'tts.provider', scheme.tts)
    }

    // 播报预算立即跟随：下一次开口就按新的「摘要 / 全文」来。
    $speechCharLimit.set(speechLimitForScheme(next, next.active))

    onChange(updated)
  }

  const updateScheme = (id: string, patch: Partial<VoiceChainScheme>) => {
    const schemes = state.schemes.map(scheme => (scheme.id === id ? { ...scheme, ...patch } : scheme))
    const next: VoiceChainState = { ...state, schemes }

    // 改的如果是正在用的那条，提供方也要跟着落盘，否则下一次开口还是旧的。
    write(next, id === state.active && (patch.stt !== undefined || patch.tts !== undefined))
  }

  const addScheme = () => {
    const pair = activeScheme(state)
    const scheme: VoiceChainScheme = {
      id: newSchemeId(),
      label: `${pair.stt} + ${pair.tts}`,
      stt: pair.stt,
      tts: pair.tts,
      speak: schemeSpeak(pair) === 'summary' ? 'summary' : 'full'
    }

    write({ ...state, schemes: [...state.schemes, scheme] }, false)
  }

  const removeScheme = (id: string) => {
    const nextActive = nextActiveAfterRemove(state.schemes, state.active, id)
    const schemes = state.schemes.filter(scheme => scheme.id !== id)

    if (schemes.length === 0) {
      return
    }

    write({ ...state, active: nextActive || schemes[0].id, schemes }, id === state.active)
  }

  const mode = String(getNested(config, 'voice.voice_chat_mode') ?? 'chained')
  const sttEnabled = getNested(config, 'stt.enabled') !== false

  if (mode !== 'chained') {
    return null
  }

  return (
    <div className="grid gap-2 rounded-lg border border-(--ui-stroke-tertiary) p-3">
      <div className="grid gap-0.5">
        <div className="text-sm font-medium">{c.voiceChainTitle}</div>
        <p className="text-muted-foreground text-xs leading-relaxed">{c.voiceChainDesc}</p>
      </div>

      <div className="grid gap-2">
        {state.schemes.map(scheme => {
          const active = scheme.id === state.active
          const speak = schemeSpeak(scheme)

          return (
            <div
              className="grid gap-1.5 rounded-md bg-(--ui-bg-tertiary) px-2.5 py-2"
              key={scheme.id}
            >
              <div className="flex items-center gap-2">
                <input
                  aria-label={c.voiceChainActive}
                  checked={active}
                  className="accent-(--ui-accent)"
                  name="voice-chain-active"
                  onChange={() => write({ ...state, active: scheme.id }, true)}
                  type="radio"
                />
                <Input
                  aria-label={c.voiceChainLabel}
                  className="h-7 flex-1 text-xs"
                  onChange={event => updateScheme(scheme.id, { label: event.target.value })}
                  placeholder={c.voiceChainLabel}
                  value={scheme.label}
                />
                <Button
                  aria-label={c.voiceChainRemove}
                  className="h-7 px-2 text-xs"
                  disabled={state.schemes.length <= 1}
                  onClick={() => removeScheme(scheme.id)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  ×
                </Button>
              </div>

              <div className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-1.5">
                <Select
                  disabled={!sttEnabled}
                  onValueChange={value => updateScheme(scheme.id, { stt: value })}
                  value={scheme.stt}
                >
                  <SelectTrigger aria-label={c.voiceChainStt} className="h-7 w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {options.stt.map(name => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <span className="text-muted-foreground text-xs">→</span>

                <Select onValueChange={value => updateScheme(scheme.id, { tts: value })} value={scheme.tts}>
                  <SelectTrigger aria-label={c.voiceChainTts} className="h-7 w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {options.tts.map(name => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select
                  onValueChange={value => updateScheme(scheme.id, { speak: value as VoiceChainSpeak })}
                  value={speak}
                >
                  <SelectTrigger aria-label={c.voiceChainSpeak} className="h-7 w-fit text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="summary">{c.voiceChainSpeakSummary}</SelectItem>
                    <SelectItem value="full">{c.voiceChainSpeakFull}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )
        })}
      </div>

      <div className="flex items-center justify-between gap-2">
        <Button className="h-7 px-2 text-xs" onClick={addScheme} size="sm" type="button" variant="ghost">
          + {c.voiceChainAdd}
        </Button>
        <p className="text-muted-foreground text-right text-xs">{c.voiceChainSpeakHint(state.speakMaxChars)}</p>
      </div>
    </div>
  )
}
