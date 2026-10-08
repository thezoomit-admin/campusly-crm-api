import type { ActivityType, Prisma } from '../../lib/prisma-client'
import { writeAuditLog } from '../../lib/audit'
import { httpError } from '../../lib/http-error'
import { prisma } from '../../lib/prisma'
import { hasPermission } from '../auth/access'
import type { AuthContext } from '../auth/session.service'
import {
  aggregatePerformance,
  buildOptions,
  detailSlices,
  drillRows,
  hasPerformanceActivity,
  historyPoints,
  ownerAt,
  rankEmployees,
  type DimensionFilters,
  type Fact,
  type LeadSnap,
  type Period,
  type Person,
  type Workload,
} from './performance.logic'
import { historyStart, resolvePerformanceRange } from './performance.range'
import {
  PERFORMANCE_MESSAGES,
  type KpiDefinition,
  type PerformanceDetailResponse,
  type PerformanceFilters,
  type PerformanceListResponse,
} from './performance.types'

const CONTACT_TYPES: ActivityType[] = ['CALL', 'MESSAGE', 'WHATSAPP', 'EMAIL', 'SMS']
const OPEN_FOLLOW_UP = new Set(['Pending', 'Due Soon', 'Overdue'])
const COMPLETED_FOLLOW_UP = new Set(['Completed', 'Done'])
const CONVERTED = new Set(['CONVERTED', 'FILE_OPENING_PENDING', 'FILE_OPENED'])
const LOST = new Set(['LOST', 'CLOSED', 'DUPLICATE', 'INVALID'])
const ACCEPTED_OFFER = new Set(['ACCEPTED', 'PAYMENT_PENDING', 'PARTIALLY_PAID', 'PAID'])
const CLOSED_LEAD = new Set(['lost', 'closed', 'converted', 'file opened', 'duplicate', 'invalid'])

const DEFAULT_KPIS: KpiDefinition[] = [
  { key: 'conversion_rate', name: 'Conversion Rate', target: 15, unit: 'percent', higherIsBetter: true, weight: 40, isActive: true, sortOrder: 1 },
  { key: 'follow_up_on_time', name: 'Follow-up On-time Rate', target: 85, unit: 'percent', higherIsBetter: true, weight: 30, isActive: true, sortOrder: 2 },
  { key: 'response_time', name: 'Average Response Time', target: 30, unit: 'minutes', higherIsBetter: false, weight: 15, isActive: true, sortOrder: 3 },
  { key: 'offer_acceptance', name: 'Offer Acceptance Rate', target: 50, unit: 'percent', higherIsBetter: true, weight: 15, isActive: true, sortOrder: 4 },
  { key: 'contact_rate', name: 'Contact Rate', target: 80, unit: 'percent', higherIsBetter: true, weight: 0, isActive: false, sortOrder: 5 },
  { key: 'collection', name: 'Collection', target: 50000, unit: 'currency', higherIsBetter: true, weight: 0, isActive: false, sortOrder: 6 },
]

const KPI_KEYS = new Set(DEFAULT_KPIS.map((item) => item.key))

function filtersOf(query: PerformanceFilters): DimensionFilters {
  const scoreMin = query.scoreMin == null || query.scoreMin === '' ? null : Number(query.scoreMin)
  const scoreMax = query.scoreMax == null || query.scoreMax === '' ? null : Number(query.scoreMax)
  if ((scoreMin != null && Number.isNaN(scoreMin)) || (scoreMax != null && Number.isNaN(scoreMax))) {
    throw httpError.badRequest(PERFORMANCE_MESSAGES.invalidRange)
  }
  return {
    country: query.country || undefined,
    source: query.source || undefined,
    campaignId: query.campaignId || undefined,
    status: query.status || undefined,
    priority: query.priority || undefined,
    scoreMin,
    scoreMax,
  }
}

function scopeWhere(auth: AuthContext): Prisma.UserWhereInput {
  const scope = auth.dataScopes.employee_performance ?? 'OWN'
  if (scope === 'ALL') return {}
  if (scope === 'DEPARTMENT' && auth.user.departmentId) return { departmentId: auth.user.departmentId }
  if (scope === 'TEAM' && auth.user.teamId) return { teamId: auth.user.teamId }
  return { id: auth.user.id }
}

async function loadPeople(auth: AuthContext, departmentId?: string) {
  const users = await prisma.user.findMany({
    where: {
      AND: [
        scopeWhere(auth),
        departmentId ? { departmentId } : {},
        { OR: [{ employee: { isNot: null } }, { id: auth.user.id }] },
      ],
    },
    select: {
      id: true,
      fullName: true,
      departmentId: true,
      department: { select: { id: true, name: true } },
      employee: { select: { id: true, employeeCode: true, fullName: true } },
      primaryRole: {
        select: {
          key: true,
          permissions: { select: { permission: { select: { resource: true, action: true } } } },
        },
      },
    },
    orderBy: { fullName: 'asc' },
  })

  return users.map((user): Person => {
    const grants = user.primaryRole?.permissions ?? []
    const canCollect =
      user.primaryRole?.key === 'admin' ||
      grants.some((grant) => grant.permission.resource === 'payment' && grant.permission.action === 'create')
    return {
      userId: user.id,
      employeeId: user.employee?.id ?? null,
      employeeCode: user.employee?.employeeCode ?? null,
      name: user.employee?.fullName || user.fullName,
      departmentId: user.department?.id ?? user.departmentId,
      departmentName: user.department?.name || '—',
      canCollect,
    }
  })
}

async function resolveAudience(auth: AuthContext, query: PerformanceFilters) {
  if (!hasPermission(auth.permissions, 'employee_performance:view')) {
    throw httpError.accessDenied(PERFORMANCE_MESSAGES.permission)
  }
  const scoped = await loadPeople(auth)
  if (query.userId && !scoped.some((person) => person.userId === query.userId)) {
    const exists = await prisma.user.findUnique({ where: { id: query.userId }, select: { id: true } })
    if (!exists) throw httpError.badRequest(PERFORMANCE_MESSAGES.invalidEmployee)
    throw httpError.accessDenied(PERFORMANCE_MESSAGES.permission)
  }
  let people = scoped
  if (query.departmentId) people = people.filter((person) => person.departmentId === query.departmentId)
  if (query.userId) {
    people = people.filter((person) => person.userId === query.userId)
    if (!people.length) throw httpError.badRequest(PERFORMANCE_MESSAGES.invalidEmployee)
  }
  return { people, scoped }
}

function leadSnap(row: {
  id: string
  code: string
  name: string
  country: string | null
  preferredCountryCode: string | null
  source: string | null
  sourceCode: string | null
  campaignId: string | null
  campaign: string | null
  status: string
  priority: string | null
  leadScore: number
  preferredCourse: string | null
}): LeadSnap {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    country: row.country || row.preferredCountryCode || '—',
    source: row.source || row.sourceCode || '—',
    campaignId: row.campaignId,
    campaign: row.campaign || '—',
    status: row.status,
    priority: row.priority || '',
    leadScore: row.leadScore,
    service: row.preferredCourse || row.campaign || '—',
  }
}

function buildPeriods(
  assignments: Array<{ leadId: string; toOwnerId: string | null; createdAt: Date }>,
  leads: Array<{ id: string; ownerId: string | null; createdAt: Date }>,
) {
  const grouped = new Map<string, Period[]>()
  const rows = [...assignments].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  for (const row of rows) {
    if (!row.toOwnerId) continue
    const list = grouped.get(row.leadId) || []
    const previous = list[list.length - 1]
    if (previous && previous.end == null) previous.end = row.createdAt
    list.push({ userId: row.toOwnerId, start: row.createdAt, end: null })
    grouped.set(row.leadId, list)
  }
  for (const lead of leads) {
    if (!grouped.has(lead.id) && lead.ownerId) {
      grouped.set(lead.id, [{ userId: lead.ownerId, start: lead.createdAt, end: null }])
    }
  }
  return grouped
}

function activityLabel(type: string, outcome: string | null) {
  const key = type.toUpperCase()
  if (key === 'COUNSELLING') return 'Counselling Completed'
  if (key === 'FOLLOW_UP') return 'Completed Follow-up'
  if (CONTACT_TYPES.includes(key as ActivityType)) return 'Contacted Lead'
  if ((outcome || '').toLowerCase().includes('qualif')) return 'Qualified Lead'
  return ''
}

function qualificationResult(value: string | null): 'QUALIFIED' | 'POTENTIAL' | 'UNQUALIFIED' | null {
  const key = (value || '').toUpperCase()
  if (key.includes('UNQUALIFIED')) return 'UNQUALIFIED'
  if (key.includes('POTENTIAL')) return 'POTENTIAL'
  if (key.includes('QUALIFIED')) return 'QUALIFIED'
  return null
}

async function loadBundle(people: Person[], from: Date, to: Date, now: Date) {
  const userIds = people.map((person) => person.userId)
  if (!userIds.length) {
    return { leads: new Map<string, LeadSnap>(), facts: [] as Fact[], workload: new Map<string, Workload>() }
  }

  const [assignmentsInRange, followUps, activities, statusRows, qualifications, offers, payments, ownedLeads, openFollowUps] = await Promise.all([
    prisma.leadAssignment.findMany({
      where: { toOwnerId: { in: userIds }, createdAt: { gte: from, lte: to } },
      select: { leadId: true, toOwnerId: true, createdAt: true },
    }),
    prisma.followUp.findMany({
      where: {
        OR: [{ ownerId: { in: userIds } }, { completedById: { in: userIds } }],
        AND: [{ OR: [{ dueAt: { gte: from, lte: to } }, { completedAt: { gte: from, lte: to } }, { cancelledAt: { gte: from, lte: to } }] }],
      },
      select: {
        id: true,
        leadId: true,
        ownerId: true,
        completedById: true,
        type: true,
        status: true,
        priority: true,
        dueAt: true,
        completedAt: true,
        cancelledAt: true,
        scheduleHistory: true,
      },
    }),
    prisma.activity.findMany({
      where: { userId: { in: userIds }, occurredAt: { gte: from, lte: to }, relatedType: 'lead', relatedId: { not: null } },
      select: { id: true, userId: true, type: true, occurredAt: true, outcome: true, relatedId: true },
    }),
    prisma.leadStatusHistory.findMany({
      where: { createdById: { in: userIds }, createdAt: { gte: from, lte: to } },
      select: { leadId: true, newStatus: true, newStatusCode: true, createdById: true, createdAt: true },
    }),
    prisma.leadQualificationHistory.findMany({
      where: { createdById: { in: userIds }, createdAt: { gte: from, lte: to } },
      select: { leadId: true, result: true, createdById: true, createdAt: true },
    }),
    prisma.serviceOffer.findMany({
      where: { createdById: { in: userIds }, createdAt: { gte: from, lte: to }, status: { not: 'CANCELLED' } },
      select: { id: true, leadId: true, status: true, createdById: true, createdAt: true },
    }),
    prisma.payment.findMany({
      where: {
        receivedById: { in: userIds },
        paymentDate: { gte: from, lte: to },
        status: { in: ['COMPLETED', 'PENDING'] },
      },
      select: { id: true, leadId: true, amount: true, status: true, receivedById: true, paymentDate: true, createdAt: true },
    }),
    prisma.lead.findMany({
      where: { ownerId: { in: userIds }, archivedAt: null },
      select: { id: true, code: true, name: true, ownerId: true, status: true, priority: true },
    }),
    prisma.followUp.findMany({
      where: { ownerId: { in: userIds }, status: { in: ['Pending', 'Due Soon', 'Overdue'] } },
      select: { id: true, leadId: true, ownerId: true, dueAt: true, status: true, contactName: true },
    }),
  ])

  const leadIds = new Set<string>()
  for (const row of assignmentsInRange) leadIds.add(row.leadId)
  for (const row of followUps) if (row.leadId) leadIds.add(row.leadId)
  for (const row of activities) if (row.relatedId) leadIds.add(row.relatedId)
  for (const row of statusRows) leadIds.add(row.leadId)
  for (const row of qualifications) leadIds.add(row.leadId)
  for (const row of offers) leadIds.add(row.leadId)
  for (const row of payments) leadIds.add(row.leadId)
  for (const row of ownedLeads) leadIds.add(row.id)

  const ids = [...leadIds]
  const [leadRows, allAssignments, files, contactActivities] = ids.length
    ? await Promise.all([
        prisma.lead.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            code: true,
            name: true,
            country: true,
            preferredCountryCode: true,
            source: true,
            sourceCode: true,
            campaignId: true,
            campaign: true,
            status: true,
            priority: true,
            leadScore: true,
            preferredCourse: true,
            ownerId: true,
            createdAt: true,
          },
        }),
        prisma.leadAssignment.findMany({
          where: { leadId: { in: ids } },
          select: { leadId: true, toOwnerId: true, createdAt: true },
        }),
        prisma.crmFile.findMany({ where: { leadId: { in: ids } }, select: { leadId: true } }),
        prisma.activity.findMany({
          where: {
            relatedType: 'lead',
            relatedId: { in: ids },
            userId: { in: userIds },
            type: { in: CONTACT_TYPES },
            occurredAt: { lte: to },
          },
          select: { userId: true, relatedId: true, occurredAt: true, outcome: true, type: true },
        }),
      ])
    : [[], [], [], []]

  const leads = new Map(leadRows.map((row) => [row.id, leadSnap(row)]))
  const periods = buildPeriods(allAssignments, leadRows)
  const fileLeads = new Set(files.map((row) => row.leadId))
  const facts: Fact[] = []
  const userSet = new Set(userIds)

  for (const row of assignmentsInRange) {
    if (!row.toOwnerId || !userSet.has(row.toOwnerId)) continue
    facts.push({ kind: 'assigned', at: row.createdAt, userId: row.toOwnerId, leadId: row.leadId })
  }

  const firstContact = new Map<string, Date>()
  const sortedContacts = [...contactActivities].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
  for (const row of sortedContacts) {
    if (!row.relatedId) continue
    const owner = ownerAt(periods.get(row.relatedId), row.occurredAt)
    if (owner !== row.userId) continue
    const key = `${row.relatedId}:${row.userId}`
    if (!firstContact.has(key)) firstContact.set(key, row.occurredAt)
    const outcome = (row.outcome || '').toLowerCase()
    const unreachable = outcome.includes('no answer') || outcome === 'busy'
    const period = (periods.get(row.relatedId) || []).find((item) => item.userId === row.userId && row.occurredAt >= item.start && (item.end == null || row.occurredAt < item.end))
    const isFirst = firstContact.get(key)?.getTime() === row.occurredAt.getTime()
    const responseMinutes = isFirst && period ? Math.max(0, Math.round((row.occurredAt.getTime() - period.start.getTime()) / 60000)) : null
    if (unreachable) {
      facts.push({ kind: 'unreachable', at: row.occurredAt, userId: row.userId, leadId: row.relatedId })
    } else {
      facts.push({ kind: 'contact', at: row.occurredAt, userId: row.userId, leadId: row.relatedId, responseMinutes })
    }
  }

  for (const row of followUps) {
    if (!row.leadId) continue
    const completed = COMPLETED_FOLLOW_UP.has(row.status)
    const actor = (completed ? row.completedById : null) || row.ownerId
    if (!actor || !userSet.has(actor)) continue
    const missed = row.status === 'Cancelled' && Boolean(row.cancelledAt && row.dueAt && row.cancelledAt > row.dueAt)
    if (row.status === 'Cancelled' && !missed) continue
    const overdue = !completed && !missed && Boolean(row.dueAt && row.dueAt < now && (row.status === 'Overdue' || OPEN_FOLLOW_UP.has(row.status)))
    const onTime = completed && Boolean(row.completedAt && row.dueAt && row.completedAt.getTime() <= row.dueAt.getTime())
    const dueInRange = Boolean(row.dueAt && row.dueAt >= from && row.dueAt <= to)
    const at = dueInRange ? row.dueAt : row.completedAt || row.cancelledAt || row.dueAt
    if (!at) continue
    const lead = leads.get(row.leadId)
    facts.push({
      kind: 'follow_up',
      at,
      userId: actor,
      leadId: row.leadId,
      followUpId: row.id,
      due: true,
      completed,
      onTime,
      overdue,
      missed,
      counselling: row.type.toLowerCase().includes('counsel'),
      rescheduled: Array.isArray(row.scheduleHistory) && row.scheduleHistory.length > 0,
      highPriority: (row.priority || lead?.priority || '').toLowerCase() === 'high',
    })
  }

  const counsellingLeads = new Set(facts.filter((fact) => fact.kind === 'follow_up' && fact.counselling).map((fact) => fact.kind === 'follow_up' ? `${fact.userId}:${fact.leadId}` : ''))

  for (const row of activities) {
    if (!row.relatedId) continue
    const label = activityLabel(row.type, row.outcome)
    if (label) facts.push({ kind: 'activity', at: row.occurredAt, userId: row.userId, leadId: row.relatedId, label })
    if (row.type === 'COUNSELLING' && !counsellingLeads.has(`${row.userId}:${row.relatedId}`)) {
      const owner = ownerAt(periods.get(row.relatedId), row.occurredAt)
      if (owner === row.userId) facts.push({ kind: 'counselling_completed', at: row.occurredAt, userId: row.userId, leadId: row.relatedId })
    }
  }

  for (const row of qualifications) {
    if (!row.createdById || !userSet.has(row.createdById)) continue
    const result = qualificationResult(row.result)
    if (!result) continue
    facts.push({ kind: 'qualification', at: row.createdAt, userId: row.createdById, leadId: row.leadId, result })
    facts.push({ kind: 'activity', at: row.createdAt, userId: row.createdById, leadId: row.leadId, label: 'Qualified Lead' })
  }

  const convertedLeads = new Set<string>()
  for (const row of [...statusRows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const code = (row.newStatusCode || row.newStatus || '').toUpperCase().replace(/\s+/g, '_')
    if (!row.createdById) continue
    if (CONVERTED.has(code) && !convertedLeads.has(row.leadId)) {
      convertedLeads.add(row.leadId)
      const period = (periods.get(row.leadId) || []).find((item) => row.createdAt >= item.start && (item.end == null || row.createdAt < item.end))
      const days = period ? Math.max(0, (row.createdAt.getTime() - period.start.getTime()) / 86400000) : null
      facts.push({
        kind: 'converted',
        at: row.createdAt,
        userId: row.createdById,
        leadId: row.leadId,
        days,
        fileOpened: fileLeads.has(row.leadId),
      })
      facts.push({ kind: 'activity', at: row.createdAt, userId: row.createdById, leadId: row.leadId, label: 'Converted Lead' })
    } else if (LOST.has(code)) {
      const owner = ownerAt(periods.get(row.leadId), row.createdAt)
      const userId = owner && userSet.has(owner) ? owner : row.createdById
      if (userSet.has(userId)) facts.push({ kind: 'lost', at: row.createdAt, userId, leadId: row.leadId })
    } else if (code === 'CONTACTED') {
      const owner = ownerAt(periods.get(row.leadId), row.createdAt)
      if (owner && owner === row.createdById) {
        facts.push({ kind: 'contact', at: row.createdAt, userId: row.createdById, leadId: row.leadId, responseMinutes: null })
      }
    }
  }

  for (const row of offers) {
    if (!row.createdById) continue
    const outcome = ACCEPTED_OFFER.has(row.status) ? 'accepted' : row.status === 'REJECTED' ? 'rejected' : 'pending'
    facts.push({ kind: 'offer', at: row.createdAt, userId: row.createdById, leadId: row.leadId, offerId: row.id, outcome })
  }

  const paymentLeads = new Set<string>()
  for (const row of payments) {
    const at = row.paymentDate || row.createdAt
    if (!paymentLeads.has(row.leadId)) {
      paymentLeads.add(row.leadId)
      const owner = ownerAt(periods.get(row.leadId), at)
      if (owner && userSet.has(owner)) facts.push({ kind: 'payment_initiated', at, userId: owner, leadId: row.leadId })
    }
    if (row.status === 'COMPLETED') {
      facts.push({ kind: 'collection', at, userId: row.receivedById, leadId: row.leadId, amount: Number(row.amount) })
    }
  }

  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const todayEnd = new Date(todayStart.getTime() + 86400000)
  const workload = new Map<string, Workload>()
  for (const person of people) {
    workload.set(person.userId, { activeLeads: 0, pendingFollowUps: 0, todaysFollowUps: 0, overdueFollowUps: 0, highPriorityLeads: 0, overdue: [] })
  }
  for (const lead of ownedLeads) {
    if (!lead.ownerId) continue
    const bucket = workload.get(lead.ownerId)
    if (!bucket) continue
    if (!CLOSED_LEAD.has(lead.status.toLowerCase())) bucket.activeLeads += 1
    if ((lead.priority || '').toLowerCase() === 'high' && !CLOSED_LEAD.has(lead.status.toLowerCase())) bucket.highPriorityLeads += 1
  }
  for (const row of openFollowUps) {
    if (!row.ownerId) continue
    const bucket = workload.get(row.ownerId)
    if (!bucket) continue
    bucket.pendingFollowUps += 1
    const overdue = row.status === 'Overdue' || Boolean(row.dueAt && row.dueAt < now)
    if (overdue) {
      bucket.overdueFollowUps += 1
      const lead = row.leadId ? leads.get(row.leadId) : undefined
      if (bucket.overdue.length < 50) {
        bucket.overdue.push({
          followUpId: row.id,
          leadId: row.leadId || '',
          leadCode: lead?.code || '—',
          leadName: lead?.name || row.contactName,
          dueAt: row.dueAt ? row.dueAt.toISOString() : null,
          status: row.status,
        })
      }
    }
    if (row.dueAt && row.dueAt >= todayStart && row.dueAt < todayEnd) bucket.todaysFollowUps += 1
  }

  return { leads, facts, workload }
}

function emptyMessage(summary: PerformanceListResponse['summary']) {
  return hasPerformanceActivity(summary) ? null : PERFORMANCE_MESSAGES.noData
}

export async function getPerformanceReport(auth: AuthContext, query: PerformanceFilters): Promise<PerformanceListResponse> {
  const range = resolvePerformanceRange(query.preset, query.from, query.to)
  const { people, scoped } = await resolveAudience(auth, query)
  const filters = filtersOf(query)
  const bundle = await loadBundle(people, range.from, range.to, new Date())
  const kpiConfig = await loadKpiConfig()
  const viewerCanSeeMoney = hasPermission(auth.permissions, 'payment:view')
  const aggregated = aggregatePerformance({
    people,
    leads: bundle.leads,
    facts: bundle.facts,
    from: range.from,
    to: range.to,
    filters,
    workload: bundle.workload,
    kpis: kpiConfig.kpis,
    overallScoreEnabled: kpiConfig.overallScoreEnabled,
    viewerCanSeeMoney,
  })
  const optionLeads = [...bundle.leads.values()]
  const options = buildOptions(scoped, optionLeads)
  return {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    preset: range.preset,
    message: emptyMessage(aggregated.summary),
    summary: aggregated.summary,
    employees: aggregated.rows.sort((a, b) => b.converted - a.converted || b.assigned - a.assigned || a.name.localeCompare(b.name)),
    ranking: rankEmployees(aggregated.rows, query.rankBy),
    kpis: aggregated.summaryKpis,
    overallScoreEnabled: kpiConfig.overallScoreEnabled,
    options,
  }
}

export async function getPerformanceDetail(auth: AuthContext, userId: string, query: PerformanceFilters): Promise<PerformanceDetailResponse> {
  const range = resolvePerformanceRange(query.preset, query.from, query.to)
  const { people } = await resolveAudience(auth, { ...query, userId })
  const person = people[0]
  if (!person) throw httpError.badRequest(PERFORMANCE_MESSAGES.invalidEmployee)
  const filters = filtersOf(query)
  const from = historyStart(range.to)
  const bundle = await loadBundle(people, from < range.from ? from : range.from, range.to, new Date())
  const kpiConfig = await loadKpiConfig()
  const viewerCanSeeMoney = hasPermission(auth.permissions, 'payment:view')
  const aggregated = aggregatePerformance({
    people,
    leads: bundle.leads,
    facts: bundle.facts,
    from: range.from,
    to: range.to,
    filters,
    workload: bundle.workload,
    kpis: kpiConfig.kpis,
    overallScoreEnabled: kpiConfig.overallScoreEnabled,
    viewerCanSeeMoney,
  })
  const row = aggregated.rows[0]
  if (!row) throw httpError.badRequest(PERFORMANCE_MESSAGES.calculation)
  const slices = detailSlices(aggregated.byUser.get(person.userId))
  return {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    preset: range.preset,
    message: row && hasPerformanceActivity(row) ? null : PERFORMANCE_MESSAGES.noData,
    employee: {
      userId: person.userId,
      employeeId: person.employeeId,
      employeeCode: person.employeeCode,
      name: person.name,
      departmentId: person.departmentId,
      departmentName: person.departmentName,
    },
    metrics: row,
    kpis: row.kpis,
    overallScoreEnabled: kpiConfig.overallScoreEnabled,
    statusBreakdown: slices.statusBreakdown,
    countries: slices.countries,
    sources: slices.sources,
    campaigns: slices.campaigns,
    history: historyPoints(bundle.facts, person.userId, bundle.leads, filters, range.to),
    recentActivity: slices.recentActivity,
    overdue: bundle.workload.get(person.userId)?.overdue ?? [],
  }
}

export async function getPerformanceDrill(auth: AuthContext, query: PerformanceFilters) {
  const metric = (query.metric || '').trim()
  if (!metric) throw httpError.badRequest(PERFORMANCE_MESSAGES.calculation)
  const range = resolvePerformanceRange(query.preset, query.from, query.to)
  const { people } = await resolveAudience(auth, query)
  const filters = filtersOf(query)
  const bundle = await loadBundle(people, range.from, range.to, new Date())
  return {
    metric,
    rows: drillRows(bundle.facts, bundle.leads, query.userId, metric, range.from, range.to, filters),
  }
}

function missingPerformanceTable(error: unknown) {
  const code = typeof error === 'object' && error != null && 'code' in error ? String(error.code) : ''
  const message = error instanceof Error ? error.message : ''
  return code === 'P2021' || code === 'P2010' || /performance_kpis|performance_settings|does not exist/i.test(message)
}

async function loadKpiConfig() {
  try {
    const [rows, setting] = await Promise.all([
      prisma.performanceKpi.findMany({ orderBy: { sortOrder: 'asc' } }),
      prisma.performanceSetting.findUnique({ where: { id: 'default' } }),
    ])
    if (!rows.length) {
      await prisma.performanceKpi.createMany({
        data: DEFAULT_KPIS.map((item) => ({ ...item, target: item.target })),
      })
      await prisma.performanceSetting.upsert({
        where: { id: 'default' },
        create: { id: 'default', overallScoreEnabled: true },
        update: {},
      })
      return { kpis: DEFAULT_KPIS, overallScoreEnabled: true }
    }
    return {
      overallScoreEnabled: setting?.overallScoreEnabled ?? true,
      kpis: rows.map((row): KpiDefinition => ({
        key: row.key,
        name: row.name,
        target: Number(row.target),
        unit: row.unit === 'minutes' || row.unit === 'currency' || row.unit === 'count' ? row.unit : 'percent',
        higherIsBetter: row.higherIsBetter,
        weight: row.weight,
        isActive: row.isActive,
        sortOrder: row.sortOrder,
      })),
    }
  } catch (error) {
    if (missingPerformanceTable(error)) {
      return { kpis: DEFAULT_KPIS, overallScoreEnabled: true }
    }
    console.error('[performance] KPI config unavailable:', error)
    throw httpError.badRequest(PERFORMANCE_MESSAGES.kpi)
  }
}

export async function getKpiConfiguration(auth: AuthContext) {
  if (!hasPermission(auth.permissions, 'employee_performance:view')) {
    throw httpError.accessDenied(PERFORMANCE_MESSAGES.permission)
  }
  return loadKpiConfig()
}

export async function updateKpiConfiguration(
  auth: AuthContext,
  body: { overallScoreEnabled?: boolean; kpis?: Array<Partial<KpiDefinition> & { key?: string }> },
  meta: { ipAddress?: string; userAgent?: string },
) {
  if (!hasPermission(auth.permissions, 'settings:configure')) {
    throw httpError.accessDenied(PERFORMANCE_MESSAGES.permission)
  }
  const incoming = Array.isArray(body.kpis) ? body.kpis : []
  if (!incoming.length) throw httpError.badRequest(PERFORMANCE_MESSAGES.kpi)
  const next = incoming.map((item, index) => {
    if (!item.key || !KPI_KEYS.has(item.key)) throw httpError.badRequest(PERFORMANCE_MESSAGES.kpi)
    const base = DEFAULT_KPIS.find((row) => row.key === item.key)!
    const target = Number(item.target)
    const weight = Number(item.weight)
    if (!Number.isFinite(target) || target < 0 || !Number.isFinite(weight) || weight < 0) {
      throw httpError.badRequest(PERFORMANCE_MESSAGES.kpi)
    }
    return {
      ...base,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : base.name,
      target,
      weight: Math.round(weight),
      isActive: item.isActive !== false,
      sortOrder: index + 1,
    }
  })
  const enabled = body.overallScoreEnabled !== false
  if (enabled) {
    const weight = next.filter((item) => item.isActive).reduce((sum, item) => sum + item.weight, 0)
    if (weight !== 100) throw httpError.badRequest('KPI weights must total 100%.')
  }
  await prisma.$transaction(async (tx) => {
    for (const item of next) {
      await tx.performanceKpi.upsert({
        where: { key: item.key },
        create: item,
        update: {
          name: item.name,
          target: item.target,
          weight: item.weight,
          isActive: item.isActive,
          sortOrder: item.sortOrder,
          higherIsBetter: item.higherIsBetter,
          unit: item.unit,
        },
      })
    }
    await tx.performanceSetting.upsert({
      where: { id: 'default' },
      create: { id: 'default', overallScoreEnabled: enabled, updatedById: auth.user.id },
      update: { overallScoreEnabled: enabled, updatedById: auth.user.id },
    })
  })
  await writeAuditLog({
    userId: auth.user.id,
    action: 'PERFORMANCE_KPI_UPDATED',
    entityType: 'performance_kpi',
    entityId: 'default',
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { overallScoreEnabled: enabled, kpis: next.map((item) => ({ key: item.key, target: item.target, weight: item.weight, isActive: item.isActive })) },
  })
  return loadKpiConfig()
}

export async function ensurePerformanceSetup() {
  const permission = await prisma.permission.findUnique({
    where: { resource_action: { resource: 'employee_performance', action: 'view' } },
  })
  const role = await prisma.role.findUnique({ where: { key: 'call_executive' }, select: { id: true } })
  if (permission && role) {
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
      create: { roleId: role.id, permissionId: permission.id },
      update: {},
    })
  }
}
