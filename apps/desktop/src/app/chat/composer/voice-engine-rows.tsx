import { useStore } from '@nanostores/react'
import { useQueryClient } from '@tanstack/react-query'

import { HERMES_CONFIG_KEY, useHermesConfigRecord } from '@/app/hooks/use-config-record'
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  dropdownMenuRow
} from '@/components/ui/dropdown-menu'
import { saveHermesConfigRecord } from '@/hermes'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { clearVoiceClientConfigCache } from '@/lib/voice-client-direct'
import { readVoiceChain, schemeSpeak, schemeSwitchPatch, speechLimitForScheme } from '@/lib/voice-chain'
import { notifyError } from '@/store/notifications'
import { $voiceLiveStatus, selectedVoiceChatMode, setVoiceChatMode } from '@/store/voice-live'
import { setSpeechCharLimit } from '@/store/voice-prefs'

/**
 * Which engine the next voice conversation mounts: the chained
 * speech-to-text → Hermes → speech loop, or GPT-Live delegating to Hermes.
 *
 * Radio rows, not a toggle: the user is choosing between two named things and
 * the checked row tells them which one the next press starts. Rendered inside
 * whichever menu the layout has room for (the folded voice menu, or the
 * right-click menu on the start button), so the same rows appear in both.
 * Hidden while the backend has not answered or predates the mode, so we never
 * offer a switch the gateway would refuse with 4002.
 */
export function VoiceEngineRows({ disabled }: { disabled: boolean }) {
  const { t } = useI18n()
  const c = t.composer
  const status = useStore($voiceLiveStatus)

  if (status === null) {
    return null
  }

  const liveAvailable = status.available

  return (
    <>
      <DropdownMenuLabel>{c.voiceEngine}</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        onValueChange={value => {
          if (value !== 'chained' && value !== 'gpt-live') {
            return
          }

          triggerHaptic('open')
          setVoiceChatMode(value).catch(error => notifyError(error, c.voiceEngineChangeFailed))
        }}
        value={selectedVoiceChatMode(status)}
      >
        <DropdownMenuRadioItem className={dropdownMenuRow} disabled={disabled} value="chained">
          {c.voiceEngineChained}
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem className={dropdownMenuRow} disabled={disabled || !liveAvailable} value="gpt-live">
          <span className="flex min-w-0 flex-col">
            <span>{c.voiceEngineLive}</span>
            {liveAvailable ? null : (
              <span className="text-muted-foreground truncate text-xs">
                {status.reason ?? c.voiceEngineLiveNeedsKey}
              </span>
            )}
          </span>
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
      <VoiceChainRows disabled={disabled} />
    </>
  )
}

/**
 * chained 的「语音搭配」单选组：在引擎组下面，只在 chained 被选中时出现。
 * gpt-live 的声音由 OpenAI 模型决定，这里对它没有任何意义。
 *
 * 选中一条 = 一次 PUT 写三样东西（voice.chained.active + 两个 provider 键），
 * 然后清掉 client-direct 的 60 秒配置缓存——不然下一句还在用旧提供方。
 */
export function VoiceChainRows({ disabled }: { disabled: boolean }) {
  const { t } = useI18n()
  const c = t.composer
  const status = useStore($voiceLiveStatus)
  const { data: config } = useHermesConfigRecord()
  const queryClient = useQueryClient()

  const chained = selectedVoiceChatMode(status) === 'chained'
  const chain = config ? readVoiceChain(config) : null

  if (!chained || !chain || chain.schemes.length === 0) {
    return null
  }

  const choose = (schemeId: string) => {
    triggerHaptic('open')
    // 下一句就按新方案播报，不等 config 重新拉一遍。
    setSpeechCharLimit(speechLimitForScheme(chain, schemeId))

    void saveHermesConfigRecord(schemeSwitchPatch(chain, schemeId))
      .then(() => {
        clearVoiceClientConfigCache()

        return queryClient.invalidateQueries({ queryKey: HERMES_CONFIG_KEY })
      })
      .catch(error => notifyError(error, c.voiceChainChangeFailed))
  }

  return (
    <>
      <DropdownMenuLabel>{c.voiceChain}</DropdownMenuLabel>
      <DropdownMenuRadioGroup onValueChange={choose} value={chain.active}>
        {chain.schemes.map(scheme => (
          <DropdownMenuRadioItem className={dropdownMenuRow} disabled={disabled} key={scheme.id} value={scheme.id}>
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{scheme.label}</span>
              <span className="text-muted-foreground truncate text-xs">
                {scheme.stt} → {scheme.tts}
                {schemeSpeak(scheme) === 'summary' ? ` · ${t.settings.config.voiceChainSpeakSummary}` : ''}
              </span>
            </span>
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  )
}

/** Short engine name for tooltips, or null until the backend has answered. */
export function useVoiceEngineName(): null | string {
  const { t } = useI18n()
  const status = useStore($voiceLiveStatus)

  if (status === null) {
    return null
  }

  return selectedVoiceChatMode(status) === 'gpt-live'
    ? t.composer.voiceEngineLiveShort
    : t.composer.voiceEngineChainedShort
}
