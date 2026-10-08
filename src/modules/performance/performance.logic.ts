import { ratePercent } from '../follow-ups/follow-ups.utils'
import { inRange, monthKey, monthLabel } from './performance.range'
import type {
  ActivityItem,
  BreakdownRow,
  DrillRow,
  EmployeePerformanceRow,
  HistoryPoint,
  KpiDefinition,
  KpiResult,
  KpiStatus,
  OverdueItem,
  PerformanceMetrics,
  PerformanceOptions,
  RankRow,
  StatusCount,
} from './performance.types'

export type Person = {
  userId: string
  employeeId: string | null
  employeeCode: string | null
  name: string
  departmentId: string | null
  departmentName: string
  canCollect: boolean
}

export type LeadSnap = {
  id: string
  code: string
  name: string
  country: string
  source: string
  campaignId: string | null
  campaign: string
  status: string
  priority: string
  leadScore: number
  service: string
}

export type Period = { userId: string; start: Date; end: Date | null }

export type Workload = {
  activeLeads: number
  pendingFollowUps: number
  todaysFollowUps: number
  overdueFollowUps: number
  highPriorityLeads: number
  overdue: OverdueItem[]
}

export type Fact =
  | { kind: 'assigned'; at: Date; userId: string; leadId: string }
  | { kind: 'contact'; at: Date; userId: string; leadId: string; responseMinutes: number | null }
  | { kind: 'unreachable'; at: Date; userId: string; leadId: string }
  | {
      kind: 'follow_up'
      at: Date
      userId: string
      leadId: string
      followUpId: string
      due: boolean
      completed: boolean
      onTime: boolean
      overdue: boolean
      missed: boolean
      counselling: boolean
      rescheduled: boolean
      highPriority: boolean
    }
  | { kind: 'qualification'; at: Date; userId: string; leadId: string; result: 'QUALIFIED' | 'POTENTIAL' | 'UNQUALIFIED' }
  | { kind: 'counselling_completed'; at: Date; userId: string; leadId: string }
  | { kind: 'offer'; at: Date; userId: string; leadId: string; offerId: string; outcome: 'accepted' | 'rejected' | 'pending' }
  | { kind: 'payment_initiated'; at: Date; userId: string; leadId: string }
  | { kind: 'converted'; at: Date; userId: string; leadId: string; days: number | null; fileOpened: boolean }
  | { kind: 'lost'; at: Date; userId: string; leadId: string }
  | { kind: 'collection'; at: Date; userId: string; leadId: string; amount: number }
  | { kind: 'activity'; at: Date; userId: string; leadId: string; label: string }

export type DimensionFilters = {
  country?: string
  source?: string
  campaignId?: string
  status?: string
  priority?: string
  scoreMin?: number | null
  scoreMax?: number | null
}

const SET_KEYS = [
  'assigned',
  'contacted',
  'unreachable',
  'qualified',
  'potential',
  'unqualified',
  'converted',
  'lost',
  'paymentInitiated',
  'filesOpened',
  'highAssigned',
  'highContacted',
  'highFollowed',
  'highConverted',
  'followDue',
  'followCompleted',
  'followOnTime',
  'followOverdue',
  'followMissed',
  'counsellingScheduled',
  'counsellingCompleted',
  'counsellingMissed',
  'counsellingRescheduled',
  'offersAccepted',
  'offersRejected',
  'offersPending',
] as const

type SetKey = (typeof SET_KEYS)[number]

type Sets = Record<SetKey, Set<string>> & {
  responseMinutes: number[]
  conversionDays: number[]
  scores: number[]
  collection: number
  status: Map<string, Set<string>>
  country: Map<string, { assigned: Set<string>; converted: Set<string> }>
  source: Map<string, { assigned: Set<string>; converted: Set<string> }>
  campaign: Map<string, { assigned: Set<string>; converted: Set<string> }>
  activity: ActivityItem[]
}

const RANK_METRICS: Array<{ key: string; label: string; higherIsBetter: boolean; pick: (row: PerformanceMetrics) => number }> = [
  { key: 'conversion_rate', label: 'Conversion', higherIsBetter: true, pick: (row) => row.conversionRate },
  { key: 'follow_up_on_time', label: 'Follow-up On-time', higherIsBetter: true, pick: (row) => row.followUpOnTimeRate },
  { key: 'response_time', label: 'Response Time', higherIsBetter: false, pick: (row) => row.avgResponseMinutes },
  { key: 'offer_acceptance', label: 'Offer Acceptance', higherIsBetter: true, pick: (row) => row.offerAcceptanceRate },
  { key: 'collection', label: 'Collection', higherIsBetter: true, pick: (row) => row.collectionAmount },
  { key: 'overall', label: 'Overall KPI', higherIsBetter: true, pick: (row) => row.overallScore ?? 0 },
  { key: 'contact_rate', label: 'Contact Rate', higherIsBetter: true, pick: (row) => row.contactRate },
]

export function leadMatches(lead: LeadSnap | undefined, filters: DimensionFilters) {
  if (!lead) return false
  if (filters.country && filters.country !== 'all' && lead.country.toLowerCase() !== filters.country.toLowerCase()) return false
  if (filters.source && filters.source !== 'all' && lead.source.toLowerCase() !== filters.source.toLowerCase()) return false
  if (filters.campaignId && filters.campaignId !== 'all' && lead.campaignId !== filters.campaignId) return false
  if (filters.status && filters.status !== 'all' && lead.status.toLowerCase() !== filters.status.toLowerCase()) return false
  if (filters.priority && filters.priority !== 'all' && lead.priority.toLowerCase() !== filters.priority.toLowerCase()) return false
  if (filters.scoreMin != null && lead.leadScore < filters.scoreMin) return false
  if (filters.scoreMax != null && lead.leadScore > filters.scoreMax) return false
  return true
}

export function ownerAt(periods: Period[] | undefined, at: Date) {
  if (!periods?.length) return null
  for (const period of periods) {
    if (at.getTime() >= period.start.getTime() && (period.end == null || at.getTime() < period.end.getTime())) {
      return period.userId
    }
  }
  return null
}

export function kpiStatus(actual: number, target: number, higherIsBetter: boolean): KpiStatus {
  if (higherIsBetter) {
    if (actual > target) return 'Exceeded'
    if (actual >= target) return 'Achieved'
    return 'Below Target'
  }
  if (actual < target) return 'Exceeded'
  if (actual <= target) return 'Achieved'
  return 'Below Target'
}

function achievement(actual: number, target: number, higherIsBetter: boolean) {
  if (target <= 0) return actual <= 0 ? 100 : 0
  const ratio = higherIsBetter ? actual / target : actual <= 0 ? 1 : target / actual
  return Math.min(100, Math.max(0, ratio * 100))
}

export function scoreKpis(metrics: PerformanceMetrics, definitions: KpiDefinition[], enabled: boolean) {
  const kpis: KpiResult[] = definitions.map((definition) => {
    const actual = actualForKpi(definition.key, metrics)
    return { ...definition, actual, status: kpiStatus(actual, definition.target, definition.higherIsBetter) }
  })
  if (!enabled) return { kpis, overallScore: null as number | null }
  const active = kpis.filter((item) => item.isActive && item.weight > 0)
  const weight = active.reduce((sum, item) => sum + item.weight, 0)
  if (!active.length || weight <= 0) return { kpis, overallScore: null }
  const overall = active.reduce((sum, item) => sum + achievement(item.actual, item.target, item.higherIsBetter) * item.weight, 0) / weight
  return { kpis, overallScore: Math.round(overall) }
}

function actualForKpi(key: string, metrics: PerformanceMetrics) {
  if (key === 'conversion_rate') return metrics.conversionRate
  if (key === 'follow_up_on_time' || key === 'follow_up_completion') return metrics.followUpOnTimeRate
  if (key === 'response_time') return metrics.avgResponseMinutes
  if (key === 'offer_acceptance') return metrics.offerAcceptanceRate
  if (key === 'collection') return metrics.collectionAmount
  if (key === 'contact_rate') return metrics.contactRate
  return 0
}

function emptySets(): Sets {
  const sets = {
    responseMinutes: [] as number[],
    conversionDays: [] as number[],
    scores: [] as number[],
    collection: 0,
    status: new Map<string, Set<string>>(),
    country: new Map<string, { assigned: Set<string>; converted: Set<string> }>(),
    source: new Map<string, { assigned: Set<string>; converted: Set<string> }>(),
    campaign: new Map<string, { assigned: Set<string>; converted: Set<string> }>(),
    activity: [] as ActivityItem[],
  } as Sets
  for (const key of SET_KEYS) sets[key] = new Set()
  return sets
}

function groupOf(map: Map<string, { assigned: Set<string>; converted: Set<string> }>, label: string) {
  const current = map.get(label) || { assigned: new Set<string>(), converted: new Set<string>() }
  map.set(label, current)
  return current
}

function priorityCounts(sets: Sets, leads: Map<string, LeadSnap>) {
  let high = 0
  let medium = 0
  let low = 0
  for (const id of sets.assigned) {
    const priority = leads.get(id)?.priority.toLowerCase()
    if (priority === 'high') high += 1
    else if (priority === 'medium') medium += 1
    else if (priority === 'low') low += 1
  }
  return { high, medium, low }
}

function finalize(
  sets: Sets,
  leads: Map<string, LeadSnap>,
  workload: Workload | undefined,
  canCollect: boolean,
  definitions: KpiDefinition[],
  enabled: boolean,
): PerformanceMetrics {
  const assigned = sets.assigned.size
  const contacted = sets.contacted.size
  const qualified = sets.qualified.size
  const converted = sets.converted.size
  const offersCreated = sets.offersAccepted.size + sets.offersRejected.size + sets.offersPending.size
  const responseTotal = sets.responseMinutes.reduce((sum, value) => sum + value, 0)
  const conversionTotal = sets.conversionDays.reduce((sum, value) => sum + value, 0)
  const scoreTotal = sets.scores.reduce((sum, value) => sum + value, 0)
  const priority = priorityCounts(sets, leads)
  const metrics: PerformanceMetrics = {
    assigned,
    accepted: assigned,
    contacted,
    unreachable: sets.unreachable.size,
    contactRate: ratePercent(contacted, assigned),
    avgResponseMinutes: sets.responseMinutes.length ? Math.round(responseTotal / sets.responseMinutes.length) : 0,
    qualified,
    potential: sets.potential.size,
    unqualified: sets.unqualified.size,
    qualificationPending: [...sets.assigned].filter((id) => !sets.qualified.has(id) && !sets.potential.has(id) && !sets.unqualified.has(id) && !sets.converted.has(id) && !sets.lost.has(id)).length,
    qualificationRate: ratePercent(qualified, contacted),
    counsellingScheduled: sets.counsellingScheduled.size,
    counsellingCompleted: sets.counsellingCompleted.size,
    counsellingMissed: sets.counsellingMissed.size,
    counsellingRescheduled: sets.counsellingRescheduled.size,
    offersCreated,
    offersAccepted: sets.offersAccepted.size,
    offersRejected: sets.offersRejected.size,
    offersPending: sets.offersPending.size,
    offerAcceptanceRate: ratePercent(sets.offersAccepted.size, offersCreated),
    paymentInitiated: sets.paymentInitiated.size,
    converted,
    lost: sets.lost.size,
    conversionRate: ratePercent(converted, qualified),
    assignedToConversionRate: ratePercent(converted, assigned),
    qualifiedToConversionRate: ratePercent(converted, qualified),
    avgConversionDays: sets.conversionDays.length ? Math.round((conversionTotal / sets.conversionDays.length) * 10) / 10 : 0,
    followUpsDue: sets.followDue.size,
    followUpsCompleted: sets.followCompleted.size,
    followUpsOnTime: sets.followOnTime.size,
    followUpsOverdue: sets.followOverdue.size,
    followUpsMissed: sets.followMissed.size,
    followUpCompletionRate: ratePercent(sets.followCompleted.size, sets.followDue.size),
    followUpOnTimeRate: ratePercent(sets.followOnTime.size, sets.followDue.size),
    filesOpened: sets.filesOpened.size,
    fileOpeningRate: ratePercent(sets.filesOpened.size, converted),
    collectionAmount: canCollect ? Math.round(sets.collection) : 0,
    collectionVisible: canCollect,
    avgLeadScore: sets.scores.length ? Math.round(scoreTotal / sets.scores.length) : 0,
    highPriority: priority.high,
    mediumPriority: priority.medium,
    lowPriority: priority.low,
    highPriorityAssigned: priority.high,
    highPriorityContacted: sets.highContacted.size,
    highPriorityFollowedUp: sets.highFollowed.size,
    highPriorityConverted: sets.highConverted.size,
    highPriorityLeads: workload?.highPriorityLeads ?? 0,
    activeLeads: workload?.activeLeads ?? 0,
    pendingFollowUps: workload?.pendingFollowUps ?? 0,
    todaysFollowUps: workload?.todaysFollowUps ?? 0,
    overdueFollowUps: workload?.overdueFollowUps ?? 0,
    overallScore: null,
  }
  metrics.overallScore = scoreKpis(metrics, definitions, enabled).overallScore
  return metrics
}

function applyFact(sets: Sets, fact: Fact, lead: LeadSnap | undefined) {
  if (fact.kind === 'assigned') {
    sets.assigned.add(fact.leadId)
    if (!lead) return
    sets.scores.push(lead.leadScore)
    const status = sets.status.get(lead.status) || new Set<string>()
    status.add(fact.leadId)
    sets.status.set(lead.status, status)
    groupOf(sets.country, lead.country || '—').assigned.add(fact.leadId)
    groupOf(sets.source, lead.source || '—').assigned.add(fact.leadId)
    groupOf(sets.campaign, lead.campaign || '—').assigned.add(fact.leadId)
    if (lead.priority.toLowerCase() === 'high') sets.highAssigned.add(fact.leadId)
    return
  }
  if (fact.kind === 'contact') {
    sets.contacted.add(fact.leadId)
    sets.unreachable.delete(fact.leadId)
    if (fact.responseMinutes != null) sets.responseMinutes.push(fact.responseMinutes)
    if (lead?.priority.toLowerCase() === 'high') sets.highContacted.add(fact.leadId)
    return
  }
  if (fact.kind === 'unreachable') {
    if (!sets.contacted.has(fact.leadId)) sets.unreachable.add(fact.leadId)
    return
  }
  if (fact.kind === 'follow_up') {
    if (fact.due) sets.followDue.add(fact.followUpId)
    if (fact.completed) sets.followCompleted.add(fact.followUpId)
    if (fact.onTime) sets.followOnTime.add(fact.followUpId)
    if (fact.overdue) sets.followOverdue.add(fact.followUpId)
    if (fact.missed) sets.followMissed.add(fact.followUpId)
    if (fact.counselling && fact.due) sets.counsellingScheduled.add(fact.followUpId)
    if (fact.counselling && fact.completed) sets.counsellingCompleted.add(fact.followUpId)
    if (fact.counselling && (fact.missed || fact.overdue)) sets.counsellingMissed.add(fact.followUpId)
    if (fact.counselling && fact.rescheduled) sets.counsellingRescheduled.add(fact.followUpId)
    if (fact.highPriority && (fact.completed || fact.due)) sets.highFollowed.add(fact.leadId)
    return
  }
  if (fact.kind === 'qualification') {
    sets.qualified.delete(fact.leadId)
    sets.potential.delete(fact.leadId)
    sets.unqualified.delete(fact.leadId)
    if (fact.result === 'QUALIFIED') sets.qualified.add(fact.leadId)
    if (fact.result === 'POTENTIAL') sets.potential.add(fact.leadId)
    if (fact.result === 'UNQUALIFIED') sets.unqualified.add(fact.leadId)
    return
  }
  if (fact.kind === 'counselling_completed') {
    sets.counsellingCompleted.add(`activity:${fact.leadId}`)
    return
  }
  if (fact.kind === 'offer') {
    if (fact.outcome === 'accepted') sets.offersAccepted.add(fact.offerId)
    if (fact.outcome === 'rejected') sets.offersRejected.add(fact.offerId)
    if (fact.outcome === 'pending') sets.offersPending.add(fact.offerId)
    return
  }
  if (fact.kind === 'payment_initiated') {
    sets.paymentInitiated.add(fact.leadId)
    return
  }
  if (fact.kind === 'converted') {
    sets.converted.add(fact.leadId)
    if (fact.days != null) sets.conversionDays.push(fact.days)
    if (fact.fileOpened) sets.filesOpened.add(fact.leadId)
    if (lead?.priority.toLowerCase() === 'high') sets.highConverted.add(fact.leadId)
    if (lead) {
      groupOf(sets.country, lead.country || '—').converted.add(fact.leadId)
      groupOf(sets.source, lead.source || '—').converted.add(fact.leadId)
      groupOf(sets.campaign, lead.campaign || '—').converted.add(fact.leadId)
    }
    return
  }
  if (fact.kind === 'lost') {
    sets.lost.add(fact.leadId)
    return
  }
  if (fact.kind === 'collection') {
    sets.collection += fact.amount
    return
  }
  if (fact.kind === 'activity' && lead) {
    sets.activity.push({
      at: fact.at.toISOString(),
      label: fact.label,
      leadId: fact.leadId,
      leadCode: lead.code,
      leadName: lead.name,
    })
  }
}

function addInto(target: Sets, source: Sets) {
  for (const key of SET_KEYS) {
    for (const value of source[key]) target[key].add(value)
  }
  target.responseMinutes.push(...source.responseMinutes)
  target.conversionDays.push(...source.conversionDays)
  target.scores.push(...source.scores)
  target.collection += source.collection
  for (const [label, ids] of source.status) {
    const bucket = target.status.get(label) || new Set<string>()
    for (const id of ids) bucket.add(id)
    target.status.set(label, bucket)
  }
  mergeGroups(target.country, source.country)
  mergeGroups(target.source, source.source)
  mergeGroups(target.campaign, source.campaign)
  target.activity.push(...source.activity)
}

function mergeGroups(
  target: Map<string, { assigned: Set<string>; converted: Set<string> }>,
  source: Map<string, { assigned: Set<string>; converted: Set<string> }>,
) {
  for (const [label, value] of source) {
    const bucket = groupOf(target, label)
    for (const id of value.assigned) bucket.assigned.add(id)
    for (const id of value.converted) bucket.converted.add(id)
  }
}

function mergeWorkload(items: Workload[]): Workload {
  return items.reduce<Workload>(
    (acc, item) => ({
      activeLeads: acc.activeLeads + item.activeLeads,
      pendingFollowUps: acc.pendingFollowUps + item.pendingFollowUps,
      todaysFollowUps: acc.todaysFollowUps + item.todaysFollowUps,
      overdueFollowUps: acc.overdueFollowUps + item.overdueFollowUps,
      highPriorityLeads: acc.highPriorityLeads + item.highPriorityLeads,
      overdue: acc.overdue.concat(item.overdue),
    }),
    { activeLeads: 0, pendingFollowUps: 0, todaysFollowUps: 0, overdueFollowUps: 0, highPriorityLeads: 0, overdue: [] },
  )
}

export function aggregatePerformance(input: {
  people: Person[]
  leads: Map<string, LeadSnap>
  facts: Fact[]
  from: Date
  to: Date
  filters: DimensionFilters
  workload: Map<string, Workload>
  kpis: KpiDefinition[]
  overallScoreEnabled: boolean
  viewerCanSeeMoney: boolean
}) {
  const byUser = new Map<string, Sets>()
  for (const person of input.people) byUser.set(person.userId, emptySets())

  const ordered = [...input.facts].sort((a, b) => a.at.getTime() - b.at.getTime())
  for (const fact of ordered) {
    if (!inRange(fact.at, input.from, input.to)) continue
    const lead = input.leads.get(fact.leadId)
    if (!leadMatches(lead, input.filters)) continue
    const sets = byUser.get(fact.userId)
    if (!sets) continue
    applyFact(sets, fact, lead)
  }

  const rows: EmployeePerformanceRow[] = input.people.map((person) => {
    const sets = byUser.get(person.userId) || emptySets()
    const canCollect = person.canCollect && input.viewerCanSeeMoney
    const metrics = finalize(sets, input.leads, input.workload.get(person.userId), canCollect, input.kpis, input.overallScoreEnabled)
    return {
      userId: person.userId,
      employeeId: person.employeeId,
      employeeCode: person.employeeCode,
      name: person.name,
      departmentId: person.departmentId,
      departmentName: person.departmentName,
      ...metrics,
      kpis: scoreKpis(metrics, input.kpis, input.overallScoreEnabled).kpis,
    }
  })

  const totalSets = emptySets()
  for (const person of input.people) {
    const sets = byUser.get(person.userId)
    if (sets) addInto(totalSets, sets)
  }
  const teamCanCollect = input.viewerCanSeeMoney && input.people.some((person) => person.canCollect)
  const summary = finalize(totalSets, input.leads, mergeWorkload([...input.workload.values()]), teamCanCollect, input.kpis, input.overallScoreEnabled)

  return { rows, summary, summaryKpis: scoreKpis(summary, input.kpis, input.overallScoreEnabled).kpis, byUser }
}

export function breakdownRows(map: Map<string, { assigned: Set<string>; converted: Set<string> }>): BreakdownRow[] {
  return [...map.entries()]
    .map(([label, value]) => ({
      label,
      assigned: value.assigned.size,
      converted: value.converted.size,
      conversionRate: ratePercent(value.converted.size, value.assigned.size),
    }))
    .sort((a, b) => b.assigned - a.assigned || b.converted - a.converted)
}

export function statusRows(map: Map<string, Set<string>>): StatusCount[] {
  return [...map.entries()].map(([status, ids]) => ({ status, count: ids.size })).sort((a, b) => b.count - a.count)
}

export function historyPoints(facts: Fact[], userId: string, leads: Map<string, LeadSnap>, filters: DimensionFilters, to: Date): HistoryPoint[] {
  const keys: string[] = []
  for (let index = 5; index >= 0; index -= 1) {
    keys.push(monthKey(new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - index, 1))))
  }
  return keys.map((key) => {
    const [year, month] = key.split('-').map(Number)
    const from = new Date(Date.UTC(year, (month || 1) - 1, 1))
    const end = new Date(Date.UTC(year, month || 1, 0, 23, 59, 59, 999))
    const sets = emptySets()
    for (const fact of facts) {
      if (fact.userId !== userId || !inRange(fact.at, from, end)) continue
      const lead = leads.get(fact.leadId)
      if (!leadMatches(lead, filters)) continue
      applyFact(sets, fact, lead)
    }
    return {
      month: monthLabel(key),
      assigned: sets.assigned.size,
      converted: sets.converted.size,
      followUpOnTimeRate: ratePercent(sets.followOnTime.size, sets.followDue.size),
    }
  })
}

export function rankEmployees(rows: EmployeePerformanceRow[], rankBy: string | undefined) {
  const requested = (rankBy || 'conversion_rate').split(',').map((item) => item.trim()).filter(Boolean)
  return requested.flatMap((key) => {
    const metric = RANK_METRICS.find((item) => item.key === key)
    if (!metric) return []
    const sorted = [...rows]
      .filter((row) => metric.key !== 'collection' || row.collectionVisible)
      .sort((a, b) => {
        const delta = metric.pick(a) - metric.pick(b)
        return metric.higherIsBetter ? -delta : delta
      })
    let lastValue: number | null = null
    let lastRank = 0
    const ranked: RankRow[] = sorted.map((row, index) => {
      const value = metric.pick(row)
      if (lastValue == null || value !== lastValue) {
        lastRank = index + 1
        lastValue = value
      }
      return { userId: row.userId, name: row.name, value, rank: lastRank }
    })
    return [{ key: metric.key, label: metric.label, higherIsBetter: metric.higherIsBetter, rows: ranked }]
  })
}

export function buildOptions(people: Person[], leads: Iterable<LeadSnap>): PerformanceOptions {
  const countries = new Set<string>()
  const sources = new Set<string>()
  const statuses = new Set<string>()
  const priorities = new Set<string>()
  const campaigns = new Map<string, string>()
  for (const lead of leads) {
    if (lead.country && lead.country !== '—') countries.add(lead.country)
    if (lead.source && lead.source !== '—') sources.add(lead.source)
    if (lead.status) statuses.add(lead.status)
    if (lead.priority) priorities.add(lead.priority)
    if (lead.campaignId && lead.campaign) campaigns.set(lead.campaignId, lead.campaign)
  }
  const departments = new Map<string, string>()
  for (const person of people) {
    if (person.departmentId) departments.set(person.departmentId, person.departmentName)
  }
  return {
    employees: people.map((person) => ({
      userId: person.userId,
      name: person.name,
      departmentId: person.departmentId,
      departmentName: person.departmentName,
    })),
    departments: [...departments.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    countries: [...countries].sort(),
    sources: [...sources].sort(),
    campaigns: [...campaigns.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    statuses: [...statuses].sort(),
    priorities: [...priorities].sort(),
  }
}

export function drillRows(
  facts: Fact[],
  leads: Map<string, LeadSnap>,
  userId: string | undefined,
  metric: string,
  from: Date,
  to: Date,
  filters: DimensionFilters,
): DrillRow[] {
  const rows = new Map<string, DrillRow>()
  for (const fact of facts) {
    if (userId && fact.userId !== userId) continue
    if (!inRange(fact.at, from, to)) continue
    const lead = leads.get(fact.leadId)
    if (!lead || !leadMatches(lead, filters)) continue
    if (!matchesMetric(fact, metric, lead)) continue
    const key = fact.kind === 'follow_up' ? `fu:${fact.followUpId}` : `${metric}:${fact.leadId}`
    if (rows.has(key)) continue
    rows.set(key, {
      kind: fact.kind === 'follow_up' ? 'follow_up' : 'lead',
      id: fact.kind === 'follow_up' ? fact.followUpId : lead.id,
      leadId: lead.id,
      code: lead.code,
      name: lead.name,
      country: lead.country,
      source: lead.source,
      score: lead.leadScore,
      service: lead.service,
      status: lead.status,
      priority: lead.priority,
      date: fact.at.toISOString(),
    })
  }
  return [...rows.values()].sort((a, b) => (b.date || '').localeCompare(a.date || ''))
}

function matchesMetric(fact: Fact, metric: string, lead: LeadSnap) {
  if (metric === 'assigned' || metric === 'accepted') return fact.kind === 'assigned'
  if (metric === 'contacted') return fact.kind === 'contact'
  if (metric === 'qualified') return fact.kind === 'qualification' && fact.result === 'QUALIFIED'
  if (metric === 'converted') return fact.kind === 'converted'
  if (metric === 'lost') return fact.kind === 'lost'
  if (metric === 'overdue') return fact.kind === 'follow_up' && fact.overdue
  if (metric === 'high_priority') return fact.kind === 'assigned' && lead.priority.toLowerCase() === 'high'
  if (metric === 'offers') return fact.kind === 'offer'
  if (metric === 'files') return fact.kind === 'converted' && fact.fileOpened
  if (metric === 'counselling') return (fact.kind === 'follow_up' && fact.counselling) || fact.kind === 'counselling_completed'
  if (metric === 'follow_ups') return fact.kind === 'follow_up' && fact.due
  if (metric === 'collection') return fact.kind === 'collection'
  return false
}

export function detailSlices(sets: Sets | undefined) {
  if (!sets) {
    return {
      statusBreakdown: [] as StatusCount[],
      countries: [] as BreakdownRow[],
      sources: [] as BreakdownRow[],
      campaigns: [] as BreakdownRow[],
      recentActivity: [] as ActivityItem[],
    }
  }
  return {
    statusBreakdown: statusRows(sets.status),
    countries: breakdownRows(sets.country),
    sources: breakdownRows(sets.source),
    campaigns: breakdownRows(sets.campaign),
    recentActivity: [...sets.activity].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30),
  }
}

export function hasPerformanceActivity(metrics: PerformanceMetrics) {
  return (
    metrics.assigned +
      metrics.contacted +
      metrics.followUpsDue +
      metrics.qualified +
      metrics.converted +
      metrics.offersCreated +
      metrics.collectionAmount +
      metrics.activeLeads >
    0
  )
}
