import { describe, expect, it } from 'vitest'

import { barWidth, percentLabel, providerHue, providerInitial, readAtLabel, resetLabel, runsOutLabel, todayUsage } from './format'
import { type MagpieProvider, visibleProviders } from './store'

const NOW = new Date('2026-11-07T17:00:00+08:00')

describe('quota formatting', () => {
  it('keeps whole percentages clean and rounds the rest to one decimal', () => {
    expect(percentLabel(34)).toBe('34%')
    expect(percentLabel(34.7943416)).toBe('34.8%')
    expect(percentLabel(0)).toBe('0%')
    expect(percentLabel(undefined)).toBeNull()
  })

  it('clamps a runaway percentage instead of overflowing the bar', () => {
    expect(barWidth(140)).toBe('100%')
    expect(barWidth(-3)).toBe('0%')
  })

  it('phrases a reset relative to today, and drops the phrase once passed', () => {
    expect(resetLabel('2026-11-07T20:22:02+08:00', NOW)).toBe('今天 20:22 · 3 小时后')
    expect(resetLabel('2026-11-09T08:00:00+08:00', NOW)).toBe('11月9日 08:00 · 39 小时后')
    expect(resetLabel('2026-11-06T08:00:00+08:00', NOW)).toBe('即将重置')
    expect(resetLabel(null, NOW)).toBeNull()
  })

  it('only projects a run-out that is still ahead', () => {
    expect(runsOutLabel('2026-11-09T13:27:25Z', NOW)).toBe('预计 11月9日 21:27 见底')
    expect(runsOutLabel('2026-11-01T00:00:00+08:00', NOW)).toBeNull()
  })

  it('reads the clock off the provider payload', () => {
    expect(readAtLabel('2026-11-07T17:08:35.030413+08:00')).toBe('17:08')
    expect(readAtLabel(undefined)).toBeNull()
  })

  it('collects today from every daily series the provider reports', () => {
    const provider = {
      moreDaily: [
        { days: [{ day: '2026-11-07', used: 65.44 }], since: '2026-11-06', window: 'Extra credits' },
        { days: [{ day: '2026-11-06', used: 18.21 }], since: '2026-11-06', window: 'Credits' }
      ],
      daily: { days: [], since: '2026-11-06', window: 'Credits' },
      name: 'WorkBuddy',
      provider: 'workbuddy'
    } as MagpieProvider

    expect(todayUsage(provider, NOW)).toEqual([{ label: 'Extra credits', used: 65.44 }])
  })

  it('falls back to a stable initial + hue when the icon file is missing', () => {
    expect(providerInitial('WorkBuddy')).toBe('W')
    expect(providerInitial('  火山引擎')).toBe('火')
    expect(providerInitial('')).toBe('?')
    expect(providerHue('workbuddy')).toBe(providerHue('workbuddy'))
  })
})

describe('provider visibility', () => {
  const providers = [
    { name: 'WorkBuddy', provider: 'workbuddy' },
    { name: 'DeepSeek', provider: 'deepseek' }
  ] as MagpieProvider[]

  it('hides only what the user unchecked; a new provider stays visible', () => {
    expect(visibleProviders(providers, ['deepseek']).map(p => p.provider)).toEqual(['workbuddy'])
    expect(visibleProviders(providers, []).map(p => p.provider)).toEqual(['workbuddy', 'deepseek'])
    expect(visibleProviders([...providers, { name: 'New', provider: 'new' } as MagpieProvider], ['deepseek'])).toHaveLength(2)
  })
})
