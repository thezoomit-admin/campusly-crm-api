import { syncOverdueFollowUps } from './overdue-follow-ups'
import { dispatchDueReminders } from '../modules/notifications/notifications.service'

/** Combined follow-up maintenance: overdue status + reminder notifications. */
export function startFollowUpJobs(intervalMs = 2 * 60 * 1000) {
  let running = false

  const tick = async () => {
    if (running) return
    running = true
    try {
      const overdue = await syncOverdueFollowUps()
      if (overdue > 0) {
        console.log(`[follow-ups] Marked ${overdue} follow-up(s) as Overdue`)
      }
      const reminded = await dispatchDueReminders()
      if (reminded > 0) {
        console.log(`[follow-ups] Sent ${reminded} reminder notification(s)`)
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
