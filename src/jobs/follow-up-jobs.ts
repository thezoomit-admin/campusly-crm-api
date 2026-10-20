import { syncOverdueFollowUps } from './overdue-follow-ups'
import { dispatchDueReminders } from '../modules/notifications/notifications.scheduler'

/** Combined follow-up maintenance: reminder notifications first, then overdue status. */
export function startFollowUpJobs(intervalMs = 30 * 1000) {
  let running = false

  const tick = async () => {
    if (running) return
    running = true
    try {
      // Reminders must run before overdue sync. Otherwise a late tick marks the
      // follow-up Overdue and the old reminder query (Pending/Due Soon only) skipped it.
      const reminded = await dispatchDueReminders()
      if (reminded > 0) {
        console.log(`[follow-ups] Sent ${reminded} reminder notification(s)`)
      }
      const overdue = await syncOverdueFollowUps()
      if (overdue > 0) {
        console.log(`[follow-ups] Marked ${overdue} follow-up(s) as Overdue`)
      }
    } catch (error) {
      console.error('[follow-ups] Maintenance job failed:', error)
    } finally {
      running = false
    }
  }

  void tick()
  const timer = setInterval(() => void tick(), intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return timer
}
