/**
 * Presentation helpers for the 订阅用量 page. Kept separate from the
 * components so the phrasing rules (which number goes where, when a reset is
 * "今天") are testable without a DOM.
 */

import type { MagpieProvider, MagpieWindow } from './store'

const DAY_MS = 86_400_000

function toDate(iso: null | string | undefined): Date | null {
  if (!iso) { return null }

  const date = new Date(iso)

  return Number.isNaN(date.getTime()) ? null : date
}

/** "0.7%" — one decimal at most; integer plans stay clean ("34%"). */
export function percentLabel(used: null | number | undefined): null | string {
  if (typeof used !== 'number' || !Number.isFinite(used)) { return null }
  const clamped = Math.min(100, Math.max(0, used))
  const rounded = Math.round(clamped * 10) / 10

  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`
}

export function barWidth(used: null | number | undefined): string {
  if (typeof used !== 'number' || !Number.isFinite(used)) { return '0%' }

  return `${Math.min(100, Math.max(0, used))}%`
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function clock(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function dayLabel(date: Date, now: Date): string {
  if (sameDay(date, now)) { return '今天' }

  if (sameDay(date, new Date(now.getTime() + DAY_MS))) { return '明天' }

  return `${date.getMonth() + 1}月${date.getDate()}日`
}

function hoursUntil(date: Date, now: Date): number {
  return Math.round((date.getTime() - now.getTime()) / 3_600_000)
}

/** "11月9日 08:00 · 39 小时后" (and just "刚刚" once it has passed). */
export function resetLabel(iso: null | string | undefined, now = new Date()): null | string {
  const date = toDate(iso)

  if (!date) { return null }

  const hours = hoursUntil(date, now)

  if (hours <= 0) { return '即将重置' }
  const relative = hours < 48 ? ` · ${hours} 小时后` : ''

  return `${dayLabel(date, now)} ${clock(date)}${relative}`
}

/** "预计 11月9日 13:27 见底" — only when the projection is still ahead. */
export function runsOutLabel(iso: null | string | undefined, now = new Date()): null | string {
  const date = toDate(iso)

  if (!date || date.getTime() <= now.getTime()) { return null }

  return `预计 ${dayLabel(date, now)} ${clock(date)} 见底`
}

/** "17:08" — the provider's own last read. */
export function readAtLabel(iso: null | string | undefined): null | string {
  const date = toDate(iso)

  return date ? clock(date) : null
}

/** "刚刚" / "3 分钟前" / "2 小时前" — age of the page's last full refresh. */
export function ageLabel(at: null | number | undefined, now = Date.now()): null | string {
  if (!at) { return null }
  const minutes = Math.floor((now - at) / 60_000)

  if (minutes < 1) { return '刚刚' }

  if (minutes < 60) { return `${minutes} 分钟前` }
  const hours = Math.floor(minutes / 60)

  return hours < 24 ? `${hours} 小时前` : `${Math.floor(hours / 24)} 天前`
}

/** Today's spend per window, from magpie's own daily series. */
export function todayUsage(provider: MagpieProvider, now = new Date()): { label: string; used: number }[] {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const series = [provider.daily, ...(provider.moreDaily ?? [])].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))

  return series.flatMap(entry => {
    const day = entry.days?.find(candidate => candidate.day === today)

    return day && typeof day.used === 'number' ? [{ label: entry.window, used: day.used }] : []
  })
}

export function formatAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

/** Letter shown in the fallback tile when no icon file matches. */
export function providerInitial(name: string): string {
  const cleaned = name.trim()

  if (!cleaned) { return '?' }
  const first = cleaned[0]!

  return /[a-z]/i.test(first) ? first.toUpperCase() : first
}

/** Colour for the fallback tile — stable per provider id. */
export function providerHue(provider: string): number {
  let hash = 0

  for (const char of provider) { hash = (hash * 31 + char.charCodeAt(0)) % 360 }

  return hash
}

/** A window without any numbers is a probe gap, not a zero. */
export function windowHasNumbers(win: MagpieWindow): boolean {
  return typeof win.used === 'number' || Boolean(win.display) || typeof win.limit === 'number'
}
