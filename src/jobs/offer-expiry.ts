import { expireOverdueOffers } from '../modules/packages/offer-lifecycle'

/** Periodic expiry of Sent offers — listing a Lead's offers also expires them on read. */
export function startOfferExpiryJob(intervalMs = 15 * 60 * 1000) {
  let running = false

  const tick = async () => {
    if (running) return
    running = true
    try {
      const count = await expireOverdueOffers()
      if (count > 0) {
        console.log(`[service-offers] Marked ${count} offer(s) as Expired`)
      }
    } catch (error) {
      console.error('[service-offers] Expiry sync failed:', error)
    } finally {
      running = false
    }
  }

  void tick()
  const timer = setInterval(() => void tick(), intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return timer
}
