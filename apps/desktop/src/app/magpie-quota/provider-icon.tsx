/**
 * Provider logo for the quota cards.
 *
 * The SVGs are vendored from magpie's own asset set (MIT) — the app does not
 * serve them over HTTP, so there is nothing to hotlink. A provider whose icon
 * file is missing (new vendor, upstream rename) falls back to a stable coloured
 * letter tile: the page must never render a broken-image box.
 */

import { useMemo } from 'react'

import { providerHue, providerInitial } from './format'

// `?url` keeps the 177 files as separate emitted assets instead of inlining
// ~860 KB of SVG text into the page bundle.
const ICON_URLS = import.meta.glob('../../assets/quota-icons/*.svg', {
  eager: true,
  import: 'default',
  query: '?url'
}) as Record<string, string>

const BY_NAME = new Map(
  Object.entries(ICON_URLS).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1).replace(/\.svg$/, ''), url])
)

export function iconUrl(icon: null | string | undefined): null | string {
  if (!icon) { return null }

  return BY_NAME.get(icon) ?? null
}

export function ProviderIcon({ icon, name, size = 28 }: { icon?: null | string; name: string; size?: number }) {
  const url = iconUrl(icon)
  const hue = useMemo(() => providerHue(name), [name])

  if (url) {
    return <img alt="" className="shrink-0" height={size} src={url} width={size} />
  }

  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-[6px] font-semibold text-white"
      style={{
        background: `hsl(${hue} 45% 45%)`,
        fontSize: Math.round(size * 0.44),
        height: size,
        width: size
      }}
    >
      {providerInitial(name)}
    </span>
  )
}
