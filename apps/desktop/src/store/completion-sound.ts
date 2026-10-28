import { atom } from 'nanostores'

import { persistStore } from '@/lib/persist-store'
import { persistString, storedString } from '@/lib/storage'

const STORAGE_KEY = 'hermes.desktop.completionSoundVariantId'

export const DEFAULT_COMPLETION_SOUND_VARIANT_ID = 1

// "None": variant 0 disables the turn-end cue but stays a selectable settings value.
export const NO_COMPLETION_SOUND_VARIANT_ID = 0

// Range mirrors COMPLETION_SOUND_VARIANTS in lib/completion-sound.ts (0 = no
// sound). Validating by range (not membership) keeps this store free of a
// dependency on the lib, which imports the atom back — a membership check would
// close that cycle.
const VARIANT_COUNT = 14

export function resolveCompletionSoundVariantId(variantId: number): number {
  return Number.isInteger(variantId) && variantId >= 0 && variantId <= VARIANT_COUNT
    ? variantId
    : DEFAULT_COMPLETION_SOUND_VARIANT_ID
}

function load(): number {
  const stored = storedString(STORAGE_KEY)

  return stored ? resolveCompletionSoundVariantId(Number.parseInt(stored, 10)) : DEFAULT_COMPLETION_SOUND_VARIANT_ID
}

export const $completionSoundVariantId = atom(load())

persistStore(
  $completionSoundVariantId,
  (id, options) => persistString(STORAGE_KEY, String(id), options),
  DEFAULT_COMPLETION_SOUND_VARIANT_ID
)

export function setCompletionSoundVariantId(variantId: number) {
  $completionSoundVariantId.set(resolveCompletionSoundVariantId(variantId))
}

// ── Volume ───────────────────────────────────────────────────────────────────
// Multiplier on the stock master gain. 1 = the level shipped before this
// setting existed; 2 = four times the power (+12 dB), still under the clip
// ceiling because every preset peaks near 0.07 before the master stage.
const VOLUME_KEY = 'hermes.desktop.completionSoundVolume'

export const MIN_COMPLETION_SOUND_VOLUME = 0
export const MAX_COMPLETION_SOUND_VOLUME = 2
export const DEFAULT_COMPLETION_SOUND_VOLUME = 1

export function resolveCompletionSoundVolume(volume: number): number {
  return Number.isFinite(volume)
    ? Math.min(MAX_COMPLETION_SOUND_VOLUME, Math.max(MIN_COMPLETION_SOUND_VOLUME, volume))
    : DEFAULT_COMPLETION_SOUND_VOLUME
}

function loadVolume(): number {
  const stored = storedString(VOLUME_KEY)

  return stored ? resolveCompletionSoundVolume(Number.parseFloat(stored)) : DEFAULT_COMPLETION_SOUND_VOLUME
}

export const $completionSoundVolume = atom(loadVolume())

$completionSoundVolume.subscribe(volume => persistString(VOLUME_KEY, String(volume)))

export function setCompletionSoundVolume(volume: number) {
  $completionSoundVolume.set(resolveCompletionSoundVolume(volume))
}
