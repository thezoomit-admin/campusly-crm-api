import { prisma } from '../../lib/prisma'
import { httpError } from '../../lib/http-error'
import { hasPermission } from '../auth/access'
import type { AuthContext } from '../auth/session.service'

export async function createNotification(input: {
  userId: string
  title: string
  body?: string
  link?: string
  type?: string
  leadId?: string | null
  followUpId?: string | null
  dedupeKey?: string
  expiresAt?: Date | null
}) {
  if (input.dedupeKey) {
    const existing = await prisma.notification.findUnique({ where: { dedupeKey: input.dedupeKey } })
    if (existing) return existing
  }

  return prisma.notification.create({
    data: {
      userId: input.userId,
      title: input.title,
      body: input.body || null,
      link: input.link || null,
      type: input.type || 'general',
      channel: 'in_app',
      status: 'Unread',
      leadId: input.leadId || null,
      followUpId: input.followUpId || null,
      dedupeKey: input.dedupeKey || null,
      expiresAt: input.expiresAt || null,
    },
  })
}

export async function listNotifications(auth: AuthContext, query: { limit?: number; unreadOnly?: boolean }) {
  if (!hasPermission(auth.permissions, 'notification:view')) {
    throw httpError.accessDenied()
  }
  const limit = Math.min(50, Math.max(5, query.limit || 20))
  const where = {
    userId: auth.user.id,
    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    ...(query.unreadOnly ? { status: 'Unread' } : {}),
  }

  const [items, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    prisma.notification.count({
      where: {
        userId: auth.user.id,
        status: 'Unread',
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    }),
  ])

  return {
    items: items.map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      link: row.link,
      type: row.type,
      status: row.status,
      leadId: row.leadId,
      followUpId: row.followUpId,
      createdAt: row.createdAt.toISOString(),
      readAt: row.readAt ? row.readAt.toISOString() : null,
    })),
    unreadCount,
  }
}

export async function markNotificationRead(auth: AuthContext, id: string) {
  if (!hasPermission(auth.permissions, 'notification:view')) {
    throw httpError.accessDenied()
  }
  const row = await prisma.notification.findFirst({
    where: { id, userId: auth.user.id },
  })
  if (!row) throw httpError.notFound('Notification not found.')
  if (row.status === 'Read') return { notification: row }

  const updated = await prisma.notification.update({
    where: { id },
    data: { status: 'Read', readAt: new Date() },
  })
  return { notification: updated }
}

export async function markAllNotificationsRead(auth: AuthContext) {
  if (!hasPermission(auth.permissions, 'notification:view')) {
    throw httpError.accessDenied()
  }
  await prisma.notification.updateMany({
    where: { userId: auth.user.id, status: 'Unread' },
    data: { status: 'Read', readAt: new Date() },
  })
  return { ok: true }
}

export async function notifyCriticalPermissionChanges(input: {
  userIds: string[]
  actorName: string
  changes: Array<{ label: string; from: string; to: string }>
  roleName?: string
}) {
  const userIds = [...new Set(input.userIds.filter(Boolean))]
  if (userIds.length === 0 || input.changes.length === 0) return

  const shown = input.changes.slice(0, 8)
  const summary = shown.map((change) => `${change.label} changed from ${change.from} to ${change.to}`).join('; ')
  const extra = input.changes.length > shown.length ? ` and ${input.changes.length - shown.length} more` : ''
  const body = input.roleName
    ? `${input.actorName} changed the ${input.roleName} role: ${summary}${extra}.`
    : `${input.actorName} changed your permissions: ${summary}${extra}.`

  await Promise.all(
    userIds.map((userId) =>
      createNotification({
        userId,
        title: 'Critical permission change',
        body,
        type: 'permission_change',
      }).catch((error) => {
        console.error('Failed to send permission notification', error)
      }),
    ),
  )
}

/** Fire due follow-up reminders as in-app notifications. */
export async function dispatchDueReminders() {
  const now = new Date()
  const due = await prisma.followUp.findMany({
    where: {
      reminderStatus: 'Pending',
      reminderAt: { lte: now },
      status: { in: ['Pending', 'Due Soon', 'Overdue'] },
      ownerId: { not: null },
    },
    take: 100,
    include: { lead: { select: { id: true, name: true, code: true } } },
  })

  let sent = 0
  for (const followUp of due) {
    if (!followUp.ownerId) continue
    const minutesLabel = followUp.reminder?.replace(/Before/i, '').trim() || 'soon'
    const leadName = followUp.lead?.name || followUp.contactName
    const dedupeKey = `followup-reminder:${followUp.id}:${followUp.reminderAt?.toISOString() || ''}`

    await createNotification({
      userId: followUp.ownerId,
      title: 'Follow-up Reminder',
      body: `${followUp.type} with ${leadName} — ${minutesLabel}.`,
      link: followUp.leadId ? `/leads/${followUp.leadId}` : '/follow-ups',
      type: 'follow_up_reminder',
      leadId: followUp.leadId,
      followUpId: followUp.id,
      dedupeKey,
      expiresAt: new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000),
    })

    await prisma.followUp.update({
      where: { id: followUp.id },
      data: { reminderStatus: 'Sent' },
    })
    sent += 1
  }
  return sent
}
