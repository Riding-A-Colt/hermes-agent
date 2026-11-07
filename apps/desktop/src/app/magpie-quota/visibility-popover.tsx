/**
 * 「显示设置」popover — which connected providers the page lists.
 *
 * Not a dialog: four to ten rows, toggled and dismissed in one gesture, so a
 * floating panel anchored to the button is the right weight. Clicking outside
 * or pressing Escape closes it; the page keeps the state.
 */

import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'

import { ProviderIcon } from './provider-icon'
import type { MagpieProvider } from './store'

export function VisibilityPopover({
  hidden,
  onChange,
  providers
}: {
  hidden: string[]
  onChange: (hidden: string[]) => void
  providers: MagpieProvider[]
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) { return }

    const onPointer = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) { setOpen(false) }
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false) }
    }

    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)

    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const hiddenSet = new Set(hidden)

  const toggle = (provider: string, visible: boolean) => {
    const next = new Set(hiddenSet)

    if (visible) { next.delete(provider) } else { next.add(provider) }
    onChange([...next])
  }

  return (
    <div className="relative" ref={root}>
      <Button
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen(value => !value)}
        size="sm"
        variant="outline"
      >
        显示设置
      </Button>

      {open ? (
        <div
          className="absolute right-0 z-50 mt-1 w-60 rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-elevated) p-1.5 shadow-md"
          role="dialog"
        >
          <div className="flex flex-col gap-0.5">
            {providers.map(provider => (
              <label
                className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-(--chrome-action-hover)"
                key={provider.provider}
              >
                <Checkbox
                  checked={!hiddenSet.has(provider.provider)}
                  onCheckedChange={value => toggle(provider.provider, value === true)}
                />
                <ProviderIcon icon={provider.icon} name={provider.name} size={16} />
                <span className="truncate text-[0.75rem] text-(--ui-text-primary)">{provider.name}</span>
              </label>
            ))}
            {providers.length === 0 ? (
              <span className="px-1.5 py-1 text-[0.75rem] text-(--ui-text-tertiary)">还没有供应商</span>
            ) : null}
          </div>

          <div className="mt-1 flex items-center justify-between border-t border-(--ui-stroke-quaternary) pt-1.5">
            <Button onClick={() => onChange([])} size="xs" variant="ghost">
              全部显示
            </Button>
            <Button onClick={() => onChange(providers.map(p => p.provider))} size="xs" variant="ghost">
              全部隐藏
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
