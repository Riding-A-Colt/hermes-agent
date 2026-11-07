/**
 * Data + formatting for the 订阅用量 page.
 *
 * Everything here is a thin read of the backend's magpie proxy: the backend
 * forwards magpie's own payload verbatim, so no number is recomputed locally.
 * What we do own is presentation (percent, reset phrasing) and two pieces of
 * local state — the 60 s open-cache and the hidden-provider list.
 */

import { hermesApi, profileScoped } from '@/api/client'

export interface MagpieWindow {
  name: string
  used?: null | number
  remaining?: null | number
  resetsAt?: null | string
  /** Pre-formatted used/limit, e.g. "1071.96 / 3200". Absent for %-only plans. */
  display?: null | string
  amount?: null | number
  limit?: null | number
  unit?: null | string
  runsOutAt?: null | string
  runsOut?: null | number
}

export interface MagpieDaily {
  since: string
  days: { day: string; used: number }[]
  window: string
}

export interface MagpieProvider {
  provider: string
  name: string
  icon?: null | string
  plan?: null | string
  user?: null | string
  kind?: null | string
  windows?: MagpieWindow[] | null
  readAt?: null | string
  balance?: null | string
  balanceTrend?: unknown
  daily?: MagpieDaily | null
  moreDaily?: MagpieDaily[] | null
}

export interface MagpieQuotaPayload {
  data: MagpieProvider[]
}

export const QUOTA_CACHE_MS = 600_000

/** Opening the tab within this window reuses the snapshot instead of re-probing. */
let cache: { at: number; payload: MagpieQuotaPayload } | null = null

export function readQuotaCache(now = Date.now()): MagpieQuotaPayload | null {
  if (!cache || now - cache.at > QUOTA_CACHE_MS) { return null }

  return cache.payload
}

export function writeQuotaCache(payload: MagpieQuotaPayload, at = Date.now()): MagpieQuotaPayload {
  cache = { at, payload }

  return payload
}

export function clearQuotaCache(): void {
  cache = null
}

export function quotaCacheAt(): null | number {
  return cache?.at ?? null
}

/** Cached snapshot read — never touches a vendor. */
export function loadQuotas(): Promise<MagpieQuotaPayload> {
  return hermesApi<MagpieQuotaPayload>({ ...profileScoped(), path: '/api/magpie/quotas' })
}

/** Re-probe every provider (no argument) or a single one. Slow: hits vendors. */
export async function refreshQuotas(provider?: string): Promise<MagpieQuotaPayload> {
  const query = provider ? `?provider=${encodeURIComponent(provider)}` : ''

  return hermesApi<MagpieQuotaPayload>({
    ...profileScoped(),
    body: {},
    method: 'POST',
    path: `/api/magpie/quotas/refresh${query}`
  })
}

// ── hidden providers ───────────────────────────────────────────────────────
// The list stores what the user HID, not what they show: a provider connected
// later is visible by default without touching any stored state.
const HIDDEN_KEY = ['hermes', 'magpie-quota', 'hidden'].join('.')

export function loadHiddenProviders(): string[] {
  try {
    const raw = window.localStorage.getItem(HIDDEN_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []

    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

export function saveHiddenProviders(hidden: string[]): void {
  try {
    window.localStorage.setItem(HIDDEN_KEY, JSON.stringify([...new Set(hidden)]))
  } catch {
    // A read-only localStorage (private window, quota) must not break the page.
  }
}

export function visibleProviders(providers: MagpieProvider[], hidden: string[]): MagpieProvider[] {
  const hiddenSet = new Set(hidden)

  return providers.filter(provider => !hiddenSet.has(provider.provider))
}
