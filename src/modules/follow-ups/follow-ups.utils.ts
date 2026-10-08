/** Minutes before dueAt for each reminder option. null = no reminder. */
export function reminderOffsetMinutes(reminder: string | null | undefined): number | null {
  const key = (reminder || '').trim().toLowerCase()
  if (!key || key === 'no reminder') return null
  if (key === 'at the time' || key.includes('at the time')) return 0
  if (key.startsWith('5 ')) return 5
  if (key.includes('15')) return 15
  if (key.includes('30')) return 30
  if (key.includes('1 hour') || key.includes('1hour')) return 60
  if (key.includes('1 day') || key.includes('1day')) return 24 * 60
  return null
}

export function computeReminderAt(
  dueAt: Date | null | undefined,
  reminder: string | null | undefined,
): Date | null {
  if (!dueAt) return null
  const offset = reminderOffsetMinutes(reminder)
  if (offset === null) return null
  return new Date(dueAt.getTime() - offset * 60 * 1000)
}

export function ratePercent(numerator: number, denominator: number) {
  if (denominator <= 0) return 0
  return Math.round((numerator / denominator) * 1000) / 10
}
