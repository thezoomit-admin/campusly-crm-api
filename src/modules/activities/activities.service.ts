import { writeAuditLog } from '../../lib/audit'
import { httpError } from '../../lib/http-error'
import type { Prisma } from '../../lib/prisma-client'
import { prisma } from '../../lib/prisma'

import type { AuthContext } from '../auth/session.service'
import {
  ACTIVITY_TYPE_LABELS,
  ACTIVITY_TYPES,
  type ActivityTypeValue,
} from './activities.constants'

export { ACTIVITY_TYPES }
export type { ActivityTypeValue }
export const FEED_CATEGORIES = [
  'call',
  'message',
  'meeting',
  'email',
  'counselling',
  'document',
  'status',
  'assignment',
  'payment',
  'file',
  'system',
] as const
export type FeedCategory = (typeof FEED_CATEGORIES)[number]

type UserScope = {
  userId?: string
  user?: Prisma.UserWhereInput
}

export type ActivityFeedItem = {
  id: string
  source: 'activity' | 'audit'
  category: FeedCategory
  action: string
  actionKey: string
  module: string
  details: string
  relatedName: string | null
  relatedType: string | null
  relatedId: string | null
  outcome: string | null
  durationMin: number | null
  nextAction: string | null
  status: string
  ipAddress: string | null
  userAgent: string | null
  occurredAt: Date
  user: { id: string; fullName: string; email: string; roleName: string | null; photoUrl: string | null } | null
  metadata: Record<string, unknown> | null
}

function scopeWhere(auth: AuthContext): UserScope {
  const scope = auth.dataScopes.lead ?? 'OWN'
  if (scope === 'OWN') {
    return { userId: auth.user.id }
  }
  if (scope === 'TEAM' && auth.user.teamId) {
    return { user: { teamId: auth.user.teamId } }
  }
  if (scope === 'DEPARTMENT' && auth.user.departmentId) {
    return { user: { departmentId: auth.user.departmentId } }
  }
  return {}
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

function stringify(value: unknown) {
  if (value === null || value === undefined || value === '') {
    return ''
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function humanize(value: string | null | undefined) {
  if (!value) {
    return 'System'
  }
  return value
    .replace(/[._-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function typeToCategory(type: ActivityTypeValue): FeedCategory {
  if (type === 'CALL') return 'call'
  if (type === 'MESSAGE' || type === 'WHATSAPP' || type === 'SMS') return 'message'
  if (type === 'MEETING') return 'meeting'
  if (type === 'EMAIL') return 'email'
  if (type === 'COUNSELLING') return 'counselling'
  if (type === 'DOCUMENT_REQUEST') return 'document'
  if (type === 'PAYMENT_DISCUSSION') return 'payment'
  return 'system'
}

function actionLabel(type: ActivityTypeValue) {
  return ACTIVITY_TYPE_LABELS[type] || humanize(type)
}

function activityDetails(row: {
  type: ActivityTypeValue
  relatedName: string | null
  durationMin: number | null
  outcome: string | null
  notes: string | null
  nextAction?: string | null
}) {
  const name = row.relatedName || 'contact'
  const label = actionLabel(row.type)
  if (row.type === 'CALL') {
    const bits = [`Called ${name}`]
    if (row.durationMin) bits.push(`${row.durationMin} min`)
    if (row.outcome) bits.push(row.outcome)
    return bits.join(' · ')
  }
  if (row.type === 'WHATSAPP' || row.type === 'MESSAGE') {
    return row.notes ? `WhatsApp with ${name}: ${row.notes}` : `WhatsApp with ${name}`
  }
  if (row.type === 'SMS') {
    return row.notes ? `SMS to ${name}: ${row.notes}` : `SMS to ${name}`
  }
  if (row.type === 'MEETING') {
    return row.notes ? `Meeting with ${name}: ${row.notes}` : `Meeting with ${name}`
  }
  if (row.type === 'EMAIL') {
    return row.notes ? `Email to ${name}: ${row.notes}` : `Email sent to ${name}`
  }
  if (row.type === 'COUNSELLING') {
    const bits = [`Counselling with ${name}`]
    if (row.outcome) bits.push(row.outcome)
    if (row.notes) bits.push(row.notes)
    return bits.join(' · ')
  }
  if (row.type === 'DOCUMENT_REQUEST') {
    return row.notes ? `Document request for ${name}: ${row.notes}` : `Document request for ${name}`
  }
  if (row.type === 'PAYMENT_DISCUSSION') {
    return row.notes ? `Payment discussion with ${name}: ${row.notes}` : `Payment discussion with ${name}`
  }
  if (row.type === 'SERVICE_DISCUSSION') {
    return row.notes ? `Service discussion with ${name}: ${row.notes}` : `Service discussion with ${name}`
  }
  if (row.type === 'FOLLOW_UP') {
    return row.notes ? `Follow-up with ${name}: ${row.notes}` : `Follow-up with ${name}`
  }
  if (row.nextAction) {
    return row.notes ? `${label} · ${name}: ${row.notes}` : `${label} · ${name} · Next: ${row.nextAction}`
  }
  return row.notes || `${label} on ${name}`
}

function classifyAudit(action: string, entityType: string | null): FeedCategory {
  const text = `${action} ${entityType || ''}`.toLowerCase()
  if (text.includes('document') || text.includes('verif')) return 'document'
  if (text.includes('payment') || text.includes('receipt') || text.includes('discount')) return 'payment'
  if (text.includes('assign')) return 'assignment'
  if (text.includes('status')) return 'status'
  if (text.includes('close') || text.includes('reopen') || text.includes('file')) return 'file'
  return 'system'
}

function auditActionLabel(category: FeedCategory, action: string) {
  if (category === 'document') return 'Document'
  if (category === 'payment') return 'Payment'
  if (category === 'assignment') return 'Assignment'
  if (category === 'status') return 'Status'
  if (category === 'file') return 'File'
  if (action.toLowerCase().includes('permission')) return 'Permission'
  if (action.toLowerCase().includes('role')) return 'User'
  if (action.toLowerCase().includes('master')) return 'Master Data'
  return humanize(action).split(' ')[0] || 'System'
}

function auditModule(category: FeedCategory, entityType: string | null) {
  if (category === 'document') return 'Documents'
  if (category === 'payment') return 'Payments'
  if (category === 'assignment') return 'Leads'
  if (category === 'status') return 'Leads'
  if (category === 'file') return 'Documents'
  if (entityType === 'user' || entityType === 'role' || entityType === 'permission') return 'Users & Roles'
  if (entityType === 'master_data' || entityType === 'MasterDataItem') return 'Master Data'
  if (entityType) return humanize(entityType)
  return 'System'
}

function auditDetails(action: string, entityType: string | null, entityId: string | null, metadata: Record<string, unknown> | null) {
  const related = stringify(metadata?.relatedName || metadata?.name || metadata?.fullName)
  const code = entityId
    ? `${(entityType || 'REC').replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase() || 'REC'}-${entityId.replace(/-/g, '').slice(-4).toUpperCase()}`
    : ''
  const from = stringify(metadata?.from ?? metadata?.previous ?? metadata?.before)
  const to = stringify(metadata?.to ?? metadata?.next ?? metadata?.after)
  if (from && to) {
    return `${humanize(action)}${related ? ` · ${related}` : ''}: ${from} → ${to}`
  }
  if (related) {
    return `${humanize(action)} · ${related}`
  }
  if (code) {
    return `${humanize(action)} ${code}`
  }
  return humanize(action)
}

function skipAuditAction(action: string) {
  return action.startsWith('ACTIVITY_') || action === 'LEAD_STATUS_CHANGED'
}

function inRange(date: Date, from?: Date, to?: Date) {
  if (from && date < from) return false
  if (to && date > to) return false
  return true
}

function percentChange(current: number, previous: number) {
  if (previous === 0) {
    return current === 0 ? 0 : 100
  }
  return Math.round(((current - previous) / previous) * 100)
}

function dailySeries(items: ActivityFeedItem[], from: Date, to: Date, category?: FeedCategory) {
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86400000) + 1)
  const buckets = Array.from({ length: Math.min(days, 14) }, () => 0)
  const span = Math.max(1, buckets.length - 1)
  for (const item of items) {
    if (category && item.category !== category) continue
    const ratio = (item.occurredAt.getTime() - from.getTime()) / Math.max(1, to.getTime() - from.getTime())
    const index = Math.min(buckets.length - 1, Math.max(0, Math.round(ratio * span)))
    buckets[index] += 1
  }
  return buckets
}

function countCategory(items: ActivityFeedItem[], category: FeedCategory) {
  return items.filter((item) => item.category === category).length
}

function parseOptionalBool(value: unknown) {
  return value === true || value === 'true' || value === 'Yes' || value === 'yes'
}

function followUpTypeFromActivity(type: ActivityTypeValue) {
  if (type === 'CALL') return 'Call'
  if (type === 'WHATSAPP' || type === 'MESSAGE') return 'WhatsApp'
  if (type === 'EMAIL') return 'Email'
  if (type === 'SMS') return 'SMS'
  if (type === 'COUNSELLING') return 'Counselling'
  if (type === 'MEETING') return 'Meeting'
  if (type === 'DOCUMENT_REQUEST') return 'Document Request'
  if (type === 'PAYMENT_DISCUSSION') return 'Payment Discussion'
  if (type === 'SERVICE_DISCUSSION') return 'Service Discussion'
  return 'Call'
}

const activityUserSelect = {
  id: true,
  fullName: true,
  email: true,
  photoUrl: true,
  primaryRole: { select: { name: true } },
} as const

function toUserDto(user: {
  id: string
  fullName: string
  email: string
  photoUrl?: string | null
  primaryRole?: { name: string } | null
} | null): ActivityFeedItem['user'] {
  if (!user) {
    return null
  }
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    roleName: user.primaryRole?.name ?? null,
    photoUrl: user.photoUrl ?? null,
  }
}

export async function listActivityFeed(
  auth: AuthContext,
  query: {
    from?: string
    to?: string
    search?: string
    category?: string
    userId?: string
    relatedId?: string
  },
) {
  const now = new Date()
  const to = query.to ? new Date(`${query.to}T23:59:59.999`) : now
  const defaultWindowMs = query.relatedId ? 365 * 86400000 : 6 * 86400000
  const from = query.from ? new Date(`${query.from}T00:00:00.000`) : new Date(to.getTime() - defaultWindowMs)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    throw httpError.badRequest('Please select a valid date range.', 'INVALID_DATE_RANGE')
  }

  const duration = to.getTime() - from.getTime()
  const prevTo = new Date(from.getTime() - 1)
  const prevFrom = new Date(prevTo.getTime() - duration)
  const scope = scopeWhere(auth)
  const userFilter = query.userId ? { userId: query.userId } : scope

  const relatedFilter = query.relatedId ? { relatedId: query.relatedId } : {}
  const auditRelatedFilter = query.relatedId ? { entityId: query.relatedId } : {}

  const [activities, audits] = await Promise.all([
    prisma.activity.findMany({
      where: {
        ...userFilter,
        ...relatedFilter,
        occurredAt: { gte: prevFrom, lte: to },
      },
      include: {
        user: { select: activityUserSelect },
      },
      orderBy: { occurredAt: 'desc' },
      take: 2000,
    }),
    prisma.auditLog.findMany({
      where: {
        ...userFilter,
        ...auditRelatedFilter,
        createdAt: { gte: prevFrom, lte: to },
      },
      include: {
        user: { select: activityUserSelect },
      },
      orderBy: { createdAt: 'desc' },
      take: 2000,
    }),
  ])

  const mappedActivities: ActivityFeedItem[] = activities.map((row) => ({
    id: `activity:${row.id}`,
    source: 'activity' as const,
    category: typeToCategory(row.type),
    action: actionLabel(row.type),
    actionKey: row.type,
    module: 'Communication',
    details: activityDetails(row),
    relatedName: row.relatedName,
    relatedType: row.relatedType,
    relatedId: row.relatedId,
    outcome: row.outcome,
    durationMin: row.durationMin,
    nextAction: row.nextAction,
    status: 'Completed',
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    occurredAt: row.occurredAt,
    user: toUserDto(row.user),
    metadata: asRecord(row.metadata),
  }))

  const mappedAudits: ActivityFeedItem[] = audits
    .filter((row) => !skipAuditAction(row.action))
    .map((row) => {
      const category = classifyAudit(row.action, row.entityType)
      const metadata = asRecord(row.metadata)
      return {
        id: `audit:${row.id}`,
        source: 'audit' as const,
        category,
        action: auditActionLabel(category, row.action),
        actionKey: row.action,
        module: auditModule(category, row.entityType),
        details: auditDetails(row.action, row.entityType, row.entityId, metadata),
        relatedName: stringify(metadata?.relatedName || metadata?.name || metadata?.fullName) || null,
        relatedType: row.entityType,
        relatedId: row.entityId,
        outcome: null,
        durationMin: null,
        nextAction: null,
        status: 'Completed',
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
        occurredAt: row.createdAt,
        user: toUserDto(row.user),
        metadata,
      }
    })

  const merged = [...mappedActivities, ...mappedAudits].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
  const current = merged.filter((item) => inRange(item.occurredAt, from, to))
  const previous = merged.filter((item) => inRange(item.occurredAt, prevFrom, prevTo))

  const search = query.search?.trim().toLowerCase() || ''
  const searched = search
    ? current.filter((item) =>
        [item.action, item.module, item.details, item.relatedName, item.ipAddress, item.user?.fullName, item.user?.email]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(search),
      )
    : current

  const category = FEED_CATEGORIES.includes(query.category as FeedCategory) ? (query.category as FeedCategory) : null
  const items = category ? searched.filter((item) => item.category === category) : searched

  const summaryFor = (key: FeedCategory) => ({
    value: countCategory(searched, key),
    change: percentChange(countCategory(searched, key), countCategory(previous, key)),
    series: dailySeries(searched, from, to, key),
  })

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    items,
    counts: {
      all: searched.length,
      call: countCategory(searched, 'call'),
      message: countCategory(searched, 'message'),
      meeting: countCategory(searched, 'meeting'),
      email: countCategory(searched, 'email'),
      counselling: countCategory(searched, 'counselling'),
      document: countCategory(searched, 'document'),
      status: countCategory(searched, 'status'),
      assignment: countCategory(searched, 'assignment'),
      payment: countCategory(searched, 'payment'),
      file: countCategory(searched, 'file'),
      system: countCategory(searched, 'system'),
    },
    summary: {
      call: summaryFor('call'),
      message: summaryFor('message'),
      meeting: summaryFor('meeting'),
      email: summaryFor('email'),
      counselling: summaryFor('counselling'),
      document: summaryFor('document'),
    },
  }
}

export async function createActivity(
  auth: AuthContext,
  input: {
    type: string
    relatedName?: string
    relatedType?: string
    relatedId?: string
    durationMin?: number | null
    outcome?: string
    notes?: string
    nextAction?: string
    nextDate?: string | null
    occurredAt?: string
    createNextFollowUp?: boolean | string
    nextFollowUpType?: string
    nextFollowUpPriority?: string
  },
  meta: { ipAddress?: string; userAgent?: string },
) {
  if (!ACTIVITY_TYPES.includes(input.type as ActivityTypeValue)) {
    throw httpError.validation({ type: 'Select a valid activity type.' })
  }
  const type = input.type as ActivityTypeValue
  const durationMin = input.durationMin === undefined || input.durationMin === null ? null : Number(input.durationMin)
  if (durationMin !== null && (Number.isNaN(durationMin) || durationMin < 0 || durationMin > 24 * 60)) {
    throw httpError.validation({ durationMin: 'Enter a valid duration in minutes.' })
  }

  const outcome = input.outcome?.trim() || null
  if (type === 'CALL' && outcome === 'Other' && !input.notes?.trim()) {
    throw httpError.validation({ notes: 'Please provide a reason.' }, 'Please provide a reason.')
  }

  const nextAction = input.nextAction?.trim() || null
  const nextDate = input.nextDate ? new Date(input.nextDate) : null
  if (input.nextDate && (!nextDate || Number.isNaN(nextDate.getTime()))) {
    throw httpError.validation({ nextDate: 'Please select a valid date.' }, 'Please select a valid date.')
  }

  const createNext = parseOptionalBool(input.createNextFollowUp)
  if (createNext) {
    if (!nextDate) {
      throw httpError.validation({ nextDate: 'Follow-up date is required.' }, 'Follow-up date is required.')
    }
    if (!nextAction) {
      throw httpError.validation({ nextAction: 'Please enter the next action.' }, 'Please enter the next action.')
    }
    if (input.relatedType !== 'lead' || !input.relatedId?.trim()) {
      throw httpError.validation({ relatedId: 'Lead is required to schedule the next follow-up.' })
    }
  }

  const row = await prisma.activity.create({
    data: {
      type,
      userId: auth.user.id,
      occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
      durationMin,
      outcome,
      notes: input.notes?.trim() || null,
      relatedName: input.relatedName?.trim() || null,
      relatedType: input.relatedType?.trim() || null,
      relatedId: input.relatedId?.trim() || null,
      nextAction,
      nextDate,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
    include: {
      user: { select: activityUserSelect },
    },
  })

  let nextFollowUp: { id: string } | null = null
  if (createNext && nextDate && input.relatedId) {
    const lead = await prisma.lead.findUnique({ where: { id: input.relatedId } })
    if (lead) {
      const followUp = await prisma.followUp.create({
        data: {
          leadId: lead.id,
          contactName: lead.name,
          type: input.nextFollowUpType?.trim() || followUpTypeFromActivity(type),
          dueAt: nextDate,
          priority: input.nextFollowUpPriority?.trim() || lead.priority || 'Medium',
          status: nextDate.getTime() < Date.now() ? 'Overdue' : 'Pending',
          purpose: type === 'COUNSELLING' ? 'Counselling' : 'Information Sharing',
          notes: input.notes?.trim() || null,
          nextAction,
          reminder: '30 Minutes Before',
          ownerId: lead.ownerId || auth.user.id,
          ownerName: lead.ownerName || auth.user.fullName,
          source: 'Manual',
          sourceReason: `Created from ${ACTIVITY_TYPE_LABELS[type]} activity`,
        },
      })
      nextFollowUp = { id: followUp.id }
      await writeAuditLog({
        userId: auth.user.id,
        action: 'FOLLOW_UP_CREATED',
        entityType: 'lead',
        entityId: lead.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        metadata: { followUpId: followUp.id, fromActivityId: row.id, type: followUp.type },
      })
    }
  }

  await writeAuditLog({
    userId: auth.user.id,
    action: 'ACTIVITY_CREATED',
    entityType: 'activity',
    entityId: row.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { type: row.type, relatedName: row.relatedName, nextFollowUpId: nextFollowUp?.id },
  })

  return { activity: row, nextFollowUp }
}

export async function recordActivityExport(
  auth: AuthContext,
  meta: { ipAddress?: string; userAgent?: string; count: number },
) {
  await writeAuditLog({
    userId: auth.user.id,
    action: 'ACTIVITY_EXPORTED',
    entityType: 'activity',
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { count: meta.count },
  })
}
