import {
  expireLeadDocuments,
  remindExpiringLeadDocuments,
} from '../modules/leads/leads.documents'
import { remindExpiringFileDocuments } from '../modules/files/file-documents.service'

/** Mark expired lead documents and send configurable expiry reminders. */
export function startDocumentExpiryJob(intervalMs = 60 * 60 * 1000) {
  let running = false
  const reminderDays = Math.max(1, Number(process.env.DOCUMENT_EXPIRY_REMINDER_DAYS || 30) || 30)

  const tick = async () => {
    if (running) return
    running = true
    try {
      const expired = await expireLeadDocuments()
      if (expired > 0) {
        console.log(`[documents] Marked ${expired} document(s) as Expired`)
      }
      const reminded = await remindExpiringLeadDocuments(reminderDays)
      const fileReminded = await remindExpiringFileDocuments(reminderDays)
      if (reminded + fileReminded > 0) {
        console.log(`[documents] Sent ${reminded + fileReminded} expiry reminder(s)`)
      }
    } catch (error) {
      console.error('[documents] Expiry sync failed:', error)
    } finally {
      running = false
    }
  }

  void tick()
  const timer = setInterval(() => void tick(), intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return timer
}
