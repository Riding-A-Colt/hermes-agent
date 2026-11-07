/**
 * 订阅用量 — every provider connected to magpie, one card each.
 *
 * Opening the tab re-probes magpie once; reopening inside 60 s reuses that
 * snapshot instead of hammering the vendors again. The header always shows when
 * the *full* refresh happened, and each card carries its own last-read time, so
 * a single-provider refresh never masquerades as a page-wide one.
 *
 * magpie is reached through the backend proxy (the renderer may run on another
 * machine); this page never talks to 127.0.0.1:3425 itself.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Loader2, RefreshCw } from '@/lib/icons'

import { ageLabel } from './format'
import { ProviderCard } from './provider-card'
import {
  loadHiddenProviders,
  loadQuotas,
  type MagpieProvider,
  QUOTA_CACHE_MS,
  quotaCacheAt,
  readQuotaCache,
  refreshQuotas,
  saveHiddenProviders,
  visibleProviders,
  writeQuotaCache
} from './store'
import { VisibilityPopover } from './visibility-popover'

const TICK_MS = 30_000

function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)

  if (raw.includes('magpie_not_running')) { return 'magpie 没有运行' }

  if (raw.includes('magpie_timeout')) { return 'magpie 响应超时' }

  if (raw.includes('magpie_unreachable')) { return '连不上 magpie' }

  return raw.length > 160 ? `${raw.slice(0, 160)}…` : raw
}

export function MagpieQuotaView() {
  const cached = readQuotaCache()

  const [providers, setProviders] = useState<MagpieProvider[]>(() => cached?.data ?? [])
  const [fullAt, setFullAt] = useState<null | number>(() => (cached ? quotaCacheAt() : null))
  const [hidden, setHidden] = useState<string[]>(() => loadHiddenProviders())
  const [error, setError] = useState<null | string>(null)
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({})
  const [initialLoading, setInitialLoading] = useState(() => !cached)
  const [busyFull, setBusyFull] = useState(false)
  const [busyId, setBusyId] = useState<null | string>(null)
  const [now, setNow] = useState(() => new Date())

  // The mount effect runs once; StrictMode's double-invoke must not fire two
  // vendor probes, and a manual refresh in flight must not be duplicated either.
  const inFlight = useRef(false)

  const runFullRefresh = useCallback(async () => {
    if (inFlight.current) { return }
    inFlight.current = true
    setBusyFull(true)
    setError(null)
    setInitialLoading(false)

    try {
      const payload = await refreshQuotas()
      const at = Date.now()
      writeQuotaCache(payload, at)
      setProviders(payload.data)
      setFullAt(at)
      setCardErrors({})
    } catch (caught) {
      setError(describeError(caught))

      // Keep whatever is on screen: stale numbers labelled with their time beat
      // an empty page.
      if (providers.length === 0) {
        try {
          const payload = await loadQuotas()
          setProviders(payload.data)
          setFullAt(quotaCacheAt())
        } catch {
          // Nothing cached either — the error panel is the whole page.
        }
      }
    } finally {
      setBusyFull(false)
      inFlight.current = false
    }
  }, [providers.length])

  useEffect(() => {
    if (!cached) { void runFullRefresh() }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once by design
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), TICK_MS)

    return () => window.clearInterval(timer)
  }, [])

  const refreshOne = useCallback(async (provider: string) => {
    setBusyId(provider)
    setCardErrors(current => {
      const next = { ...current }
      delete next[provider]

      return next
    })

    try {
      const payload = await refreshQuotas(provider)
      writeQuotaCache(payload, quotaCacheAt() ?? Date.now())
      setProviders(payload.data)
    } catch (caught) {
      setCardErrors(current => ({ ...current, [provider]: describeError(caught) }))
    } finally {
      setBusyId(null)
    }
  }, [])

  const changeHidden = (next: string[]) => {
    setHidden(next)
    saveHiddenProviders(next)
  }

  const shown = visibleProviders(providers, hidden)
  const age = ageLabel(fullAt, now.getTime())
  const allHidden = providers.length > 0 && shown.length === 0

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-(--ui-stroke-tertiary) px-4 py-2.5">
        <div className="flex min-w-0 flex-col">
          <h1 className="text-[0.875rem] font-semibold text-(--ui-text-primary)">订阅用量</h1>
          <span className="text-[0.6875rem] text-(--ui-text-tertiary)">
            {busyFull
              ? '正在刷新…'
              : error
                ? `刷新失败 · ${error}`
                : fullAt
                  ? `全量刷新于 ${age}`
                  : '尚未刷新'}
          </span>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <VisibilityPopover hidden={hidden} onChange={changeHidden} providers={providers} />
          <Button disabled={busyFull} onClick={() => void runFullRefresh()} size="sm" variant="secondary">
            {busyFull ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            全部刷新
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {initialLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {[0, 1, 2, 3].map(index => (
              <div
                className="h-44 animate-pulse rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-tertiary)"
                key={index}
              />
            ))}
          </div>
        ) : error && providers.length === 0 ? (
          <div className="flex max-w-md flex-col items-start gap-2 rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-tertiary) p-4">
            <span className="text-[0.8125rem] font-medium text-(--ui-text-primary)">读不到额度</span>
            <span className="text-[0.75rem] text-(--ui-text-tertiary)">
              {error === 'magpie 没有运行'
                ? 'magpie 没有运行。在常驻机上打开它，然后重试。'
                : error}
            </span>
            <Button onClick={() => void runFullRefresh()} size="sm" variant="outline">
              重试
            </Button>
          </div>
        ) : providers.length === 0 ? (
          <div className="text-[0.8125rem] text-(--ui-text-tertiary)">magpie 里还没有接入任何供应商。</div>
        ) : allHidden ? (
          <div className="text-[0.8125rem] text-(--ui-text-tertiary)">所有供应商都被隐藏了，用「显示设置」恢复。</div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {shown.map(provider => (
              <ProviderCard
                failing={cardErrors[provider.provider] ?? null}
                key={provider.provider}
                now={now}
                onRefresh={providerId => void refreshOne(providerId)}
                provider={provider}
                refreshing={busyId === provider.provider}
              />
            ))}
          </div>
        )}

        <p className="mt-3 text-[0.6875rem] text-(--ui-text-tertiary)">
          数据来自 magpie；它只在打开面板、发请求或你点刷新时才向厂商查询，所以每张卡都标了自己的读数时间。
          {' '}
          {Math.round(QUOTA_CACHE_MS / 60_000)} 分钟内重复打开本页不会重新刷新。
        </p>
      </div>
    </div>
  )
}

export default MagpieQuotaView
