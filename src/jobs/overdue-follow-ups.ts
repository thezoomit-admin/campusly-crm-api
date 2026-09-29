import { prisma } from '../lib/prisma'

export async function syncOverdueFollowUps() {
  const result = await prisma.followUp.updateMany({
    where: {
      status: { in: ['Pending', 'Due Soon'] },
      dueAt: { lt: new Date() },
    },
    data: { status: 'Overdue' },
  })
  return result.count
}

/** Periodic overdue sync — request-time sync still runs on dashboard/list. */
export function startOverdueFollowUpJob(intervalMs = 5 * 60 * 1000) {
  let running = false

  const tick = async () => {
    if (running) return
    running = true
    try {
      const count = await syncOverdueFollowUps()
      if (count > 0) {
        console.log(`[follow-ups] Marked ${count} follow-up(s) as Overdue`)
      }
    } catch (error) {
      console.error('[follow-ups] Overdue sync failed:', error)
    } finally {
      running = false
    }
  }

  void tick()
  const timer = setInterval(() => void tick(), intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return timer
}
