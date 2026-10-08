import { httpError } from '../../lib/http-error'
import { PERFORMANCE_MESSAGES, type DatePreset } from './performance.types'

const PRESETS = new Set<DatePreset>([
  'today',
  'yesterday',
  'this_week',
  'this_month',
  'last_month',
  'this_quarter',
  'custom',
])

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function endOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999))
}

function addUtcDays(date: Date, days: number) {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

export function resolvePerformanceRange(presetRaw?: string, fromRaw?: string, toRaw?: string, now = new Date()) {
  const preset = (presetRaw || 'this_month').trim().toLowerCase() as DatePreset
  if (!PRESETS.has(preset)) {
    throw httpError.badRequest(PERFORMANCE_MESSAGES.invalidRange)
  }

  if (preset === 'custom') {
    if (!fromRaw || !toRaw) throw httpError.badRequest(PERFORMANCE_MESSAGES.invalidRange)
    const from = new Date(`${fromRaw.slice(0, 10)}T00:00:00.000Z`)
    const to = new Date(`${toRaw.slice(0, 10)}T23:59:59.999Z`)
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
      throw httpError.badRequest(PERFORMANCE_MESSAGES.invalidRange)
    }
    return { preset, from, to }
  }

  const today = startOfUtcDay(now)
  if (preset === 'today') return { preset, from: today, to: endOfUtcDay(today) }
  if (preset === 'yesterday') {
    const day = addUtcDays(today, -1)
    return { preset, from: day, to: endOfUtcDay(day) }
  }
  if (preset === 'this_week') {
    const weekday = today.getUTCDay()
    const mondayOffset = weekday === 0 ? 6 : weekday - 1
    const from = addUtcDays(today, -mondayOffset)
    return { preset, from, to: endOfUtcDay(now) }
  }
  if (preset === 'last_month') {
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    const to = endOfUtcDay(addUtcDays(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), -1))
    return { preset, from, to }
  }
  if (preset === 'this_quarter') {
    const quarterMonth = Math.floor(now.getUTCMonth() / 3) * 3
    return {
      preset,
      from: new Date(Date.UTC(now.getUTCFullYear(), quarterMonth, 1)),
      to: endOfUtcDay(now),
    }
  }

  return {
    preset: 'this_month' as const,
    from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    to: endOfUtcDay(now),
  }
}

export function historyStart(to: Date) {
  return new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - 5, 1))
}

export function monthKey(date: Date) {
  return date.toISOString().slice(0, 7)
}

export function monthLabel(key: string) {
  const [year, month] = key.split('-').map(Number)
  return new Date(Date.UTC(year, (month || 1) - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

export function inRange(date: Date | null | undefined, from: Date, to: Date) {
  if (!date) return false
  const time = date.getTime()
  return time >= from.getTime() && time <= to.getTime()
}
