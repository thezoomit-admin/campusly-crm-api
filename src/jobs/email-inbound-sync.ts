import { config } from '../config'
import { isImapInboundConfigured, syncImapInboundMailbox } from '../modules/email/email.imap'

/** Polls the company IMAP mailbox for new student replies. */
export function startEmailInboundSyncJob() {
  if (!isImapInboundConfigured()) {
    console.log('📭 Email IMAP inbound sync disabled (set IMAP_HOST / use Gmail SMTP credentials to enable)')
    return undefined
  }

  const intervalMs = config.email.imap.pollSeconds * 1000
  let running = false

  const tick = async () => {
    if (running) return
    running = true
    try {
      const result = await syncImapInboundMailbox()
      // Quiet by default: only log when something meaningful happened.
      if (result.ingested > 0) {
        console.log(
          `[email:imap] Ingested ${result.ingested} new message(s) (scanned ${result.processed}, dup ${result.duplicates}, skip ${result.skipped}, err ${result.errors})`,
        )
      } else if (result.errors > 0) {
        console.warn(
          `[email:imap] Sync finished with ${result.errors} error(s) (scanned ${result.processed}, dup ${result.duplicates}, skip ${result.skipped})`,
        )
      }
    } catch (error) {
      console.error('[email:imap] Sync job failed:', error instanceof Error ? error.message : error)
    } finally {
      running = false
    }
  }

  void tick()
  const timer = setInterval(() => void tick(), intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  console.log(`📥 Email IMAP inbound sync started (every ${config.email.imap.pollSeconds}s → ${config.email.imap.host})`)
  return timer
}
