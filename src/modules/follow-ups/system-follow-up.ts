import { prisma } from '../../lib/prisma'
import { writeAuditLog } from '../../lib/audit'
import { computeReminderAt } from './follow-ups.utils'

export type SystemFollowUpInput = {
  leadId: string
  contactName: string
  type: string
  purpose?: string
  nextAction: string
  dueAt: Date
  priority?: string
  notes?: string | null
  ownerId?: string | null
  ownerName?: string | null
  reminder?: string
  reason: string
  actorUserId?: string | null
  meta?: { ipAddress?: string; userAgent?: string }
}

/**
 * Creates a system follow-up if no open follow-up with the same sourceReason exists for the lead.
 */
export async function createSystemFollowUp(input: SystemFollowUpInput) {
  const existing = await prisma.followUp.findFirst({
    where: {
      leadId: input.leadId,
      source: 'System',
      sourceReason: input.reason,
      status: { in: ['Pending', 'Due Soon', 'Overdue'] },
    },
  })
  if (existing) return { followUp: existing, created: false }

  const reminder = input.reminder || '30 Minutes Before'
  const reminderAt = computeReminderAt(input.dueAt, reminder)

  const followUp = await prisma.followUp.create({
    data: {
      leadId: input.leadId,
      contactName: input.contactName,
      type: input.type,
      purpose: input.purpose || 'Initial Contact',
      nextAction: input.nextAction,
      dueAt: input.dueAt,
      priority: input.priority || 'Medium',
      notes: input.notes || null,
      status: input.dueAt.getTime() < Date.now() ? 'Overdue' : 'Pending',
      ownerId: input.ownerId || null,
      ownerName: input.ownerName || null,
      reminder,
      reminderAt,
      reminderStatus: reminderAt ? 'Pending' : 'Skipped',
      source: 'System',
      sourceReason: input.reason,
    },
  })

  if (input.actorUserId) {
    await prisma.activity.create({
      data: {
        type: 'FOLLOW_UP',
        userId: input.actorUserId,
        notes: `Created By: System — Reason: ${input.reason}`,
        relatedName: input.contactName,
        relatedType: 'lead',
        relatedId: input.leadId,
        outcome: 'Scheduled',
        nextAction: input.nextAction,
        nextDate: input.dueAt,
        ipAddress: input.meta?.ipAddress,
        userAgent: input.meta?.userAgent,
      },
    })
    await writeAuditLog({
      userId: input.actorUserId,
      action: 'FOLLOW_UP_CREATED',
      entityType: 'lead',
      entityId: input.leadId,
      ipAddress: input.meta?.ipAddress,
      userAgent: input.meta?.userAgent,
      metadata: {
        followUpId: followUp.id,
        source: 'System',
        reason: input.reason,
        type: followUp.type,
      },
    })
  }

  return { followUp, created: true }
}

export function daysFromNow(days: number, from = new Date()) {
  const date = new Date(from)
  date.setDate(date.getDate() + days)
  date.setMinutes(0, 0, 0)
  if (date.getHours() < 10) date.setHours(10)
  return date
}
