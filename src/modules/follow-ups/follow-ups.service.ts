import type { Prisma } from '../../lib/prisma-client'
import { writeAuditLog } from '../../lib/audit'
import { httpError } from '../../lib/http-error'
import { prisma } from '../../lib/prisma'
import { hasPermission } from '../auth/access'
import type { AuthContext } from '../auth/session.service'
import {
  asOptionalString,
  asString,
  assertCanViewLead,
  FOLLOW_UP_CLOSED_STATUSES,
  leadReadableWhere,
} from '../leads/leads.helpers'
import {
  FOLLOW_UP_OUTCOMES,
  FOLLOW_UP_PRIORITIES,
  FOLLOW_UP_PURPOSES,
  FOLLOW_UP_REMINDERS,
  FOLLOW_UP_TYPES,
  type ScheduleHistoryEntry,
} from './follow-ups.constants'
import { computeReminderAt } from './follow-ups.utils'

export type AuditMeta = { ipAddress?: string; userAgent?: string }

function parseDueAt(value: unknown): Date | null {
  const text = asString(value)
  if (!text) return null
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? null : date
}

function requireDueAt(value: unknown): Date {
  const date = parseDueAt(value)
  if (!date) {
    throw httpError.validation({ dueAt: 'Follow-up date is required.' }, 'Follow-up date is required.')
  }
  return date
}

function normalizePriority(value: unknown, fallback = 'Medium') {
  const text = asString(value) || fallback
  const match = FOLLOW_UP_PRIORITIES.find((item) => item.toLowerCase() === text.toLowerCase())
  return match || fallback
}

function normalizeType(value: unknown) {
  const text = asString(value) || 'Call'
  const match = FOLLOW_UP_TYPES.find((item) => item.toLowerCase() === text.toLowerCase())
  return match || text.slice(0, 80)
}

function normalizePurpose(value: unknown) {
  const text = asString(value)
  if (!text) return null
  const match = FOLLOW_UP_PURPOSES.find((item) => item.toLowerCase() === text.toLowerCase())
  return match || text.slice(0, 120)
}

function normalizeReminder(value: unknown) {
  const text = asString(value)
  if (!text) return 'No Reminder'
  const match = FOLLOW_UP_REMINDERS.find((item) => item.toLowerCase() === text.toLowerCase())
  return match || 'No Reminder'
}

function normalizeOutcome(value: unknown) {
  const text = asString(value)
  if (!text) return null
  const match = FOLLOW_UP_OUTCOMES.find((item) => item.toLowerCase() === text.toLowerCase())
  return match || text.slice(0, 120)
}

function asHistory(value: unknown): ScheduleHistoryEntry[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is ScheduleHistoryEntry => Boolean(item) && typeof item === 'object')
}

function formatDueLabel(date: Date | null | undefined) {
  if (!date) return '—'
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function serializeFollowUp(row: {
  id: string
  contactName: string
  leadId: string | null
  type: string
  ownerName: string | null
  ownerId: string | null
  dueAt: Date | null
  priority: string | null
  status: string
  purpose: string | null
  purposeOther: string | null
  notes: string | null
  nextAction: string | null
  reminder: string | null
  outcome: string | null
  completedAt: Date | null
  completedById: string | null
  completedByName: string | null
  cancelledAt: Date | null
  cancelledById: string | null
  cancelledByName: string | null
  cancelReason: string | null
  source: string | null
  sourceReason: string | null
  scheduleHistory: Prisma.JsonValue
  createdAt: Date
  updatedAt: Date
  lead?: { id: string; code: string; name: string } | null
}) {
  return {
    id: row.id,
    contact: row.contactName,
    contactName: row.contactName,
    leadId: row.leadId,
    lead: row.lead
      ? { id: row.lead.id, code: row.lead.code, name: row.lead.name }
      : null,
    type: row.type,
    owner: row.ownerName || '—',
    ownerName: row.ownerName,
    ownerId: row.ownerId,
    due: formatDueLabel(row.dueAt),
    dueAt: row.dueAt ? row.dueAt.toISOString() : null,
    priority: row.priority || 'Medium',
    status: row.status,
    purpose: row.purpose,
    purposeOther: row.purposeOther,
    notes: row.notes,
    nextAction: row.nextAction,
    reminder: row.reminder || 'No Reminder',
    outcome: row.outcome,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    completedById: row.completedById,
    completedByName: row.completedByName,
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
    cancelledByName: row.cancelledByName,
    cancelReason: row.cancelReason,
    source: row.source || 'Manual',
    sourceReason: row.sourceReason,
    scheduleHistory: asHistory(row.scheduleHistory),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

async function markOverdueForWhere(where: Prisma.FollowUpWhereInput) {
  const now = new Date()
  await prisma.followUp.updateMany({
    where: {
      AND: [
        where,
        { status: { in: ['Pending', 'Due Soon'] } },
        { dueAt: { lt: now } },
      ],
    },
    data: { status: 'Overdue' },
  })
}

async function assertCanAccessFollowUp(auth: AuthContext, id: string) {
  const followUp = await prisma.followUp.findUnique({
    where: { id },
    include: { lead: { select: { id: true, code: true, name: true } } },
  })
  if (!followUp) throw httpError.notFound('Follow-up not found.')
  if (followUp.leadId) {
    await assertCanViewLead(auth, followUp.leadId)
  } else if (!hasPermission(auth.permissions, 'follow_up:view')) {
    throw httpError.accessDenied()
  }
  return followUp
}

async function createScheduledActivity(
  auth: AuthContext,
  input: {
    leadId: string
    leadName: string
    type: string
    dueAt: Date | null
    notes?: string | null
    outcome?: string
    nextAction?: string | null
    meta: AuditMeta
  },
) {
  await prisma.activity.create({
    data: {
      type: 'FOLLOW_UP',
      userId: auth.user.id,
      notes: input.notes || `Follow-up (${input.type})`,
      relatedName: input.leadName,
      relatedType: 'lead',
      relatedId: input.leadId,
      outcome: input.outcome || 'Scheduled',
      nextAction: input.nextAction || input.type,
      nextDate: input.dueAt,
      ipAddress: input.meta.ipAddress,
      userAgent: input.meta.userAgent,
    },
  })
}

export async function listFollowUps(
  auth: AuthContext,
  query: { search?: string; leadId?: string; status?: string },
) {
  if (!hasPermission(auth.permissions, 'follow_up:view')) {
    throw httpError.accessDenied()
  }

  const leadScope = leadReadableWhere(auth)
  const where: Prisma.FollowUpWhereInput = {
    AND: [
      query.leadId ? { leadId: query.leadId } : {},
      {
        OR: [{ leadId: null }, { lead: leadScope }],
      },
      query.status ? { status: query.status } : {},
    ],
  }

  await markOverdueForWhere(where)

  const rows = await prisma.followUp.findMany({
    where,
    include: { lead: { select: { id: true, code: true, name: true } } },
    orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
  })

  const search = query.search?.trim().toLowerCase()
  const items = rows
    .map((row) => serializeFollowUp(row))
    .filter((row) => {
      if (!search) return true
      return [row.contact, row.type, row.owner, row.priority, row.status, row.purpose, row.nextAction, row.lead?.code]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(search)
    })

  return { items, total: items.length }
}

export async function listLeadFollowUps(auth: AuthContext, leadId: string) {
  await assertCanViewLead(auth, leadId)
  await markOverdueForWhere({ leadId })
  const rows = await prisma.followUp.findMany({
    where: { leadId },
    include: { lead: { select: { id: true, code: true, name: true } } },
    orderBy: [{ dueAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
  })
  return { items: rows.map((row) => serializeFollowUp(row)), total: rows.length }
}

export async function createFollowUp(auth: AuthContext, body: Record<string, unknown>, meta: AuditMeta) {
  if (!hasPermission(auth.permissions, 'follow_up:create')) {
    throw httpError.accessDenied()
  }

  const leadId = asString(body.leadId)
  if (!leadId) {
    throw httpError.validation({ leadId: 'Lead is required.' }, 'Lead is required.')
  }

  const lead = await assertCanViewLead(auth, leadId)
  const dueAt = requireDueAt(body.dueAt)
  const type = normalizeType(body.type)
  const purpose = normalizePurpose(body.purpose)
  const purposeOther =
    purpose === 'Other' ? asOptionalString(body.purposeOther, 500) : null
  if (purpose === 'Other' && !purposeOther) {
    throw httpError.validation({ purposeOther: 'Please provide a reason.' }, 'Please provide a reason.')
  }

  const nextAction = asOptionalString(body.nextAction, 500)
  if (!nextAction) {
    throw httpError.validation({ nextAction: 'Please enter the next action.' }, 'Please enter the next action.')
  }

  const reminder = normalizeReminder(body.reminder)
  const reminderAt = computeReminderAt(dueAt, reminder)

  const followUp = await prisma.followUp.create({
    data: {
      leadId: lead.id,
      contactName: lead.name,
      type,
      dueAt,
      priority: normalizePriority(body.priority, lead.priority || 'Medium'),
      status: dueAt.getTime() < Date.now() ? 'Overdue' : 'Pending',
      purpose,
      purposeOther,
      notes: asOptionalString(body.notes, 1000),
      nextAction,
      reminder,
      reminderAt,
      reminderStatus: reminderAt ? 'Pending' : 'Skipped',
      ownerId: lead.ownerId || auth.user.id,
      ownerName: lead.ownerName || auth.user.fullName,
      source: asOptionalString(body.source, 40) || 'Manual',
      sourceReason: asOptionalString(body.sourceReason, 200),
    },
    include: { lead: { select: { id: true, code: true, name: true } } },
  })

  await createScheduledActivity(auth, {
    leadId: lead.id,
    leadName: lead.name,
    type,
    dueAt,
    notes: `Follow-up scheduled (${type}) — ${nextAction}`,
    nextAction,
    meta,
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'FOLLOW_UP_CREATED',
    entityType: 'lead',
    entityId: lead.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { followUpId: followUp.id, type, purpose, nextAction },
  })

  return { followUp: serializeFollowUp(followUp) }
}

export async function completeFollowUp(
  auth: AuthContext,
  id: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  if (!hasPermission(auth.permissions, 'follow_up:edit')) {
    throw httpError.accessDenied()
  }

  const current = await assertCanAccessFollowUp(auth, id)
  if (FOLLOW_UP_CLOSED_STATUSES.includes(current.status as (typeof FOLLOW_UP_CLOSED_STATUSES)[number])) {
    throw httpError.badRequest('This follow-up is already closed.', 'FOLLOW_UP_CLOSED')
  }

  const outcome = normalizeOutcome(body.outcome)
  if (!outcome) {
    throw httpError.validation({ outcome: 'Please select a follow-up outcome.' }, 'Please select a follow-up outcome.')
  }

  const nextAction = asOptionalString(body.nextAction, 500)
  if (!nextAction) {
    throw httpError.validation({ nextAction: 'Please enter the next action.' }, 'Please enter the next action.')
  }

  const notes = asOptionalString(body.notes, 1000)
  const createNext =
    body.createNextFollowUp === true ||
    body.createNextFollowUp === 'true' ||
    body.createNextFollowUp === 'Yes' ||
    body.createNextFollowUp === 'yes'

  const completed = await prisma.followUp.update({
    where: { id: current.id },
    data: {
      status: 'Completed',
      outcome,
      notes: notes ?? current.notes,
      nextAction,
      completedAt: new Date(),
      completedById: auth.user.id,
      completedByName: auth.user.fullName,
    },
    include: { lead: { select: { id: true, code: true, name: true } } },
  })

  if (current.leadId) {
    await prisma.activity.create({
      data: {
        type: 'FOLLOW_UP',
        userId: auth.user.id,
        notes: notes || `Follow-up completed (${current.type})`,
        relatedName: current.contactName,
        relatedType: 'lead',
        relatedId: current.leadId,
        outcome,
        nextAction,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    })
  }

  let nextFollowUp = null
  if (createNext) {
    if (!current.leadId) {
      throw httpError.badRequest('Cannot schedule next follow-up without a lead.')
    }
    const nextDueAt = requireDueAt(body.nextDueAt)
    const nextType = normalizeType(body.nextType || current.type)
    const nextReminder = normalizeReminder(body.nextReminder || current.reminder)
    const nextReminderAt = computeReminderAt(nextDueAt, nextReminder)
    const created = await prisma.followUp.create({
      data: {
        leadId: current.leadId,
        contactName: current.contactName,
        type: nextType,
        dueAt: nextDueAt,
        priority: normalizePriority(body.nextPriority || current.priority),
        status: nextDueAt.getTime() < Date.now() ? 'Overdue' : 'Pending',
        purpose: normalizePurpose(body.nextPurpose || current.purpose),
        purposeOther: current.purposeOther,
        notes: asOptionalString(body.nextNotes, 1000),
        nextAction,
        reminder: nextReminder,
        reminderAt: nextReminderAt,
        reminderStatus: nextReminderAt ? 'Pending' : 'Skipped',
        ownerId: current.ownerId || auth.user.id,
        ownerName: current.ownerName || auth.user.fullName,
        source: 'Manual',
        sourceReason: 'Created on completion',
      },
      include: { lead: { select: { id: true, code: true, name: true } } },
    })
    nextFollowUp = serializeFollowUp(created)
    await createScheduledActivity(auth, {
      leadId: current.leadId,
      leadName: current.contactName,
      type: nextType,
      dueAt: nextDueAt,
      notes: `Next follow-up scheduled (${nextType})`,
      nextAction,
      meta,
    })
  }

  await writeAuditLog({
    userId: auth.user.id,
    action: 'FOLLOW_UP_COMPLETED',
    entityType: 'lead',
    entityId: current.leadId || current.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: {
      followUpId: current.id,
      outcome,
      nextAction,
      nextFollowUpId: nextFollowUp?.id,
    },
  })

  return { followUp: serializeFollowUp(completed), nextFollowUp }
}

export async function rescheduleFollowUp(
  auth: AuthContext,
  id: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  if (!hasPermission(auth.permissions, 'follow_up:edit')) {
    throw httpError.accessDenied()
  }

  const current = await assertCanAccessFollowUp(auth, id)
  if (FOLLOW_UP_CLOSED_STATUSES.includes(current.status as (typeof FOLLOW_UP_CLOSED_STATUSES)[number])) {
    throw httpError.badRequest('This follow-up is already closed.', 'FOLLOW_UP_CLOSED')
  }

  const newDueAt = requireDueAt(body.dueAt)
  const reason = asOptionalString(body.reason, 1000)
  if (!reason) {
    throw httpError.validation({ reason: 'Please provide a reason.' }, 'Please provide a reason.')
  }

  const historyEntry: ScheduleHistoryEntry = {
    previousDueAt: current.dueAt ? current.dueAt.toISOString() : null,
    newDueAt: newDueAt.toISOString(),
    reason,
    at: new Date().toISOString(),
    byId: auth.user.id,
    byName: auth.user.fullName,
  }

  const previousHistory = asHistory(current.scheduleHistory)

  const rescheduled = await prisma.followUp.update({
    where: { id: current.id },
    data: {
      status: 'Rescheduled',
      scheduleHistory: [...previousHistory, historyEntry] as Prisma.InputJsonValue,
    },
    include: { lead: { select: { id: true, code: true, name: true } } },
  })

  if (!current.leadId) {
    throw httpError.badRequest('Cannot reschedule a follow-up without a lead.')
  }

  const createdReminderAt = computeReminderAt(newDueAt, current.reminder)
  const created = await prisma.followUp.create({
    data: {
      leadId: current.leadId,
      contactName: current.contactName,
      type: current.type,
      dueAt: newDueAt,
      priority: current.priority,
      status: newDueAt.getTime() < Date.now() ? 'Overdue' : 'Pending',
      purpose: current.purpose,
      purposeOther: current.purposeOther,
      notes: current.notes,
      nextAction: current.nextAction,
      reminder: current.reminder,
      reminderAt: createdReminderAt,
      reminderStatus: createdReminderAt ? 'Pending' : 'Skipped',
      ownerId: current.ownerId,
      ownerName: current.ownerName,
      source: 'Manual',
      sourceReason: `Rescheduled from ${formatDueLabel(current.dueAt)}`,
      scheduleHistory: [...previousHistory, historyEntry] as Prisma.InputJsonValue,
    },
    include: { lead: { select: { id: true, code: true, name: true } } },
  })

  await createScheduledActivity(auth, {
    leadId: current.leadId,
    leadName: current.contactName,
    type: current.type,
    dueAt: newDueAt,
    notes: `Follow-up rescheduled — ${reason}`,
    outcome: 'Rescheduled',
    nextAction: current.nextAction,
    meta,
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'FOLLOW_UP_RESCHEDULED',
    entityType: 'lead',
    entityId: current.leadId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: {
      previousFollowUpId: current.id,
      followUpId: created.id,
      reason,
      previousDueAt: historyEntry.previousDueAt,
      newDueAt: historyEntry.newDueAt,
    },
  })

  return {
    followUp: serializeFollowUp(rescheduled),
    nextFollowUp: serializeFollowUp(created),
  }
}

export async function cancelFollowUp(
  auth: AuthContext,
  id: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  if (!hasPermission(auth.permissions, 'follow_up:edit')) {
    throw httpError.accessDenied()
  }

  const current = await assertCanAccessFollowUp(auth, id)
  if (FOLLOW_UP_CLOSED_STATUSES.includes(current.status as (typeof FOLLOW_UP_CLOSED_STATUSES)[number])) {
    throw httpError.badRequest('This follow-up is already closed.', 'FOLLOW_UP_CLOSED')
  }

  const reason = asOptionalString(body.reason, 1000)
  if (!reason) {
    throw httpError.validation({ reason: 'Please provide a reason.' }, 'Please provide a reason.')
  }

  const cancelled = await prisma.followUp.update({
    where: { id: current.id },
    data: {
      status: 'Cancelled',
      cancelReason: reason,
      cancelledAt: new Date(),
      cancelledById: auth.user.id,
      cancelledByName: auth.user.fullName,
    },
    include: { lead: { select: { id: true, code: true, name: true } } },
  })

  if (current.leadId) {
    await prisma.activity.create({
      data: {
        type: 'FOLLOW_UP',
        userId: auth.user.id,
        notes: `Follow-up cancelled — ${reason}`,
        relatedName: current.contactName,
        relatedType: 'lead',
        relatedId: current.leadId,
        outcome: 'Cancelled',
        nextAction: current.nextAction,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    })
  }

  await writeAuditLog({
    userId: auth.user.id,
    action: 'FOLLOW_UP_CANCELLED',
    entityType: 'lead',
    entityId: current.leadId || current.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { followUpId: current.id, reason },
  })

  return { followUp: serializeFollowUp(cancelled) }
}
