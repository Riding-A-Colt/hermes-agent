/**
 * One provider card. Mirrors what magpie's own quota page shows — plan name,
 * every window with its used percentage, the absolute figure magpie already
 * formatted, reset time, projected run-out — minus the trend charts and pace
 * estimates, which this page deliberately does not draw.
 *
 * Copy is Chinese by design: this fork is used in Chinese, and routing a dozen
 * new strings through nine locale files buys nothing here.
 */

import { Button } from '@/components/ui/button'
import { Loader2, RefreshCw } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { barWidth, formatAmount, percentLabel, readAtLabel, resetLabel, runsOutLabel, todayUsage, windowHasNumbers } from './format'
import { ProviderIcon } from './provider-icon'
import type { MagpieProvider, MagpieWindow } from './store'

function WindowRow({ win, now }: { win: MagpieWindow; now: Date }) {
  const percent = percentLabel(win.used)
  const reset = resetLabel(win.resetsAt, now)
  const runsOut = runsOutLabel(win.runsOutAt, now)
  const numeric = windowHasNumbers(win)

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-[0.75rem] text-(--ui-text-secondary)">{win.name}</span>
        <span className="shrink-0 text-[0.75rem] font-medium tabular-nums text-(--ui-text-primary)">
          {percent ?? '—'}
        </span>
      </div>
      <div
        aria-hidden
        className="h-1.5 w-full overflow-hidden rounded-full bg-(--ui-bg-quaternary)"
        title={percent ? `已用 ${percent}` : undefined}
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-500',
            (win.used ?? 0) >= 90 ? 'bg-destructive' : 'bg-(--ui-accent)'
          )}
          style={{ width: barWidth(win.used) }}
        />
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 text-[0.6875rem] text-(--ui-text-tertiary)">
        {win.display ? <span className="tabular-nums">{win.display}</span> : null}
        {!numeric ? <span>无额度接口</span> : null}
        {reset ? <span>{reset}</span> : null}
      </div>
      {runsOut ? <div className="text-[0.6875rem] text-(--ui-text-tertiary)">{runsOut}</div> : null}
    </div>
  )
}

export function ProviderCard({
  failing,
  now,
  onRefresh,
  provider,
  refreshing
}: {
  failing?: string | null
  now: Date
  onRefresh: (provider: string) => void
  provider: MagpieProvider
  refreshing: boolean
}) {
  const windows = provider.windows ?? []
  const daily = todayUsage(provider, now)
  const readAt = readAtLabel(provider.readAt)

  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-lg border border-(--ui-stroke-tertiary) bg-white p-4 dark:bg-(--ui-bg-tertiary)">
      <header className="flex items-start gap-3">
        <ProviderIcon icon={provider.icon} name={provider.name} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h2 className="truncate text-[0.8125rem] font-semibold text-(--ui-text-primary)">{provider.name}</h2>
            {provider.plan ? (
              <span className="shrink-0 rounded-full bg-(--ui-bg-quaternary) px-1.5 py-0.5 text-[0.625rem] text-(--ui-text-tertiary)">
                {provider.plan}
              </span>
            ) : null}
          </div>
          {provider.user ? (
            <div className="truncate text-[0.6875rem] text-(--ui-text-tertiary)">{provider.user}</div>
          ) : null}
        </div>
        <Button
          aria-label={`刷新 ${provider.name}`}
          className="size-7 shrink-0 p-0"
          disabled={refreshing}
          onClick={() => onRefresh(provider.provider)}
          size="sm"
          title={readAt ? `刷新 · 上次读数 ${readAt}` : '刷新'}
          variant="ghost"
        >
          {refreshing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
        </Button>
      </header>

      {provider.balance ? (
        <div className="flex flex-col gap-1">
          <span className="text-[0.6875rem] text-(--ui-text-tertiary)">余额</span>
          <span className="text-xl font-semibold tabular-nums text-(--ui-text-primary)">{provider.balance}</span>
        </div>
      ) : null}

      {windows.length > 0 ? (
        <div className="flex flex-col gap-3">
          {windows.map(win => (
            <WindowRow key={win.name} now={now} win={win} />
          ))}
        </div>
      ) : provider.balance ? null : (
        <div className="text-[0.75rem] text-(--ui-text-tertiary)">无额度接口</div>
      )}

      {daily.length > 0 ? (
        <div className="flex flex-col gap-0.5 border-t border-(--ui-stroke-quaternary) pt-2 text-[0.6875rem] text-(--ui-text-tertiary)">
          {daily.map(entry => (
            <div className="flex justify-between gap-3" key={entry.label}>
              <span className="truncate">今日已用 · {entry.label}</span>
              <span className="shrink-0 tabular-nums">{formatAmount(entry.used)}</span>
            </div>
          ))}
        </div>
      ) : null}

      <footer className="mt-auto flex items-center justify-between gap-2 text-[0.6875rem] text-(--ui-text-tertiary)">
        <span>{readAt ? `读数 ${readAt}` : '尚未读取'}</span>
        {failing ? <span className="truncate text-destructive">刷新失败 · {failing}</span> : null}
      </footer>
    </section>
  )
}
