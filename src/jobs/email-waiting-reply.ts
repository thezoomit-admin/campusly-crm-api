import { config } from '../config'
import { prisma } from '../lib/prisma'
import { createNotification } from '../modules/notifications/notifications.service'

/**
 * Reminds assignees when an outbound CRM email is still waiting for a student reply.
 * Targets WAITING_REPLY (and legacy REPLIED) threads with lastDirection=outgoing.
 */
export async function dispatchEmailWaitingReplyReminders() {
  const hours = config.email.waitingReplyHours
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000)
  const dayKey = new Date().toISOString().slice(0, 10)

  const threads = await prisma.emailThread.findMany({
    where: {
      status: { in: ['WAITING_REPLY', 'REPLIED'] },
      lastDirection: 'outgoing',
      lastMessageAt: { lte: cutoff },
      OR: [{ assignedUserId: { not: null } }, { lead: { is: { ownerId: { not: null } } } }],
    },
    take: 80,
    select: {
      id: true,
      subject: true,
      contactName: true,
      participantEmail: true,
      assignedUserId: true,
      lastMessageAt: true,
      leadId: true,
      lead: { select: { id: true, code: true, name: true, ownerId: true } },
    },
  })

  let sent = 0
  for (const thread of threads) {
    const userId = thread.lead?.ownerId || thread.assignedUserId
    if (!userId) continue

    const who = thread.lead
      ? `${thread.lead.code} — ${thread.lead.name}`
      : thread.contactName || thread.participantEmail
    const waitLabel = hours === 1 ? '1 hour' : `${hours} hours`

    const dedupeKey = `email-waiting-reply:${thread.id}:${dayKey}`
    const already = await prisma.notification.findUnique({ where: { dedupeKey }, select: { id: true } })
    if (already) continue

    await createNotification({
      userId,
      title: 'Waiting for email reply',
      body: `No reply from ${who} for ${waitLabel}${thread.subject ? ` — ${thread.subject}` : ''}.`,
      link: `/email?c=${thread.id}`,
      type: 'email_waiting_reply',
      leadId: thread.leadId,
      dedupeKey,
      expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    })
    sent += 1
  }

  return sent
}

export function startEmailWaitingReplyJob() {
  const intervalMs = config.email.waitingReplyPollMinutes * 60 * 1000
  let running = false

  const tick = async () => {
    if (running) return
    running = true
    try {
      const reminded = await dispatchEmailWaitingReplyReminders()
      if (reminded > 0) {
        console.log(`[email:waiting-reply] Sent ${reminded} reminder(s)`)
      }
    } catch (error) {
      console.error('[email:waiting-reply] Job failed:', error)
    } finally {
      running = false
    }
  }

  void tick()
  const timer = setInterval(() => void tick(), intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  console.log(
    `⏳ Email waiting-reply reminders started (every ${config.email.waitingReplyPollMinutes}m, after ${config.email.waitingReplyHours}h)`,
  )
  return timer
}
