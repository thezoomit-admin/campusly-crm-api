import type { PaymentTxnStatus, Prisma } from '../../lib/prisma-client'
import { HttpError } from '../../lib/http-error'
import { prisma } from '../../lib/prisma'
import type { AuthContext } from '../auth/session.service'
import { leadScopeWhere } from '../leads/leads.helpers'

const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000
const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
}
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const SOURCE_COLORS = ['#3b82f6', '#8b5cf6', '#22c55e', '#f59e0b', '#06b6d4']
const OTHER_COLOR = '#94a3b8'
const FUNNEL_COLORS = {
  total: '#3b82f6',
  contacted: '#60a5fa',
  qualified: '#8b5cf6',
  converted: '#22c55e',
  lost: '#f43f5e',
}
const CONVERTED_BEHAVIORS = new Set(['converted', 'file_opening_pending', 'file_opened'])
const TERMINAL_BEHAVIORS = new Set(['lost', 'closed', 'duplicate', 'invalid'])
const CONVERTED_CODES = new Set(['CONVERTED', 'FILE_OPENING_PENDING', 'FILE_OPENED'])
const PAYMENT_STATUSES = ['COMPLETED', 'PENDING', 'FAILED', 'CANCELLED', 'REVERSED'] as const
const FILE_OPEN_VALUES = new Set(['open', 'opened', 'active'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const LEGACY_CODE: Record<string, string> = {
  INTERESTED: 'QUALIFIED',
  OFFER_SENT: 'OFFERED',
}
const LEGACY_NAME: Record<string, string> = {
  interested: 'qualified',
  'offer sent': 'offered',
  'follow-up': 'contacted',
  followup: 'contacted',
}

export type ReportOverviewQuery = {
  datePreset?: string
  customFrom?: string
  customTo?: string
  employeeId?: string
  employeeScope?: string
  country?: string
  leadSource?: string
  service?: string
  fileStatus?: string
  paymentStatus?: string
}

type StatusMeta = {
  code: string
  name: string
  behaviorKey: string | null
  sortOrder: number
}

type Choice = { value: string; label: string }

type LeadSnapshot = {
  id: string
  status: string
  statusCode: string | null
  source: string | null
  sourceCode: string | null
  ownerId: string | null
  ownerName: string | null
  createdAt: Date
  owner: {
    id: string
    fullName: string
    primaryRole: { key: string } | null
    employee: { role: { key: string } | null } | null
  } | null
}

function dhakaParts(date: Date) {
  const bag = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Dhaka',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
    })
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  )
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    weekday: bag.weekday || 'Mon',
  }
}

function dhakaStart(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month - 1, day) - DHAKA_OFFSET_MS)
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000)
}

function parseDay(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const start = dhakaStart(year, month, day)
  const parts = dhakaParts(start)
  if (parts.year !== year || parts.month !== month || parts.day !== day) return null
  return start
}

function monthRange(year: number, month: number) {
  const nextMonth = month === 12 ? 1 : month + 1
  const nextYear = month === 12 ? year + 1 : year
  return {
    from: dhakaStart(year, month, 1),
    to: dhakaStart(nextYear, nextMonth, 1),
  }
}

function inRange(date: Date, from: Date, to: Date) {
  const time = date.getTime()
  return time >= from.getTime() && time < to.getTime()
}

function round1(value: number) {
  return Math.round(value * 10) / 10
}

function percentChange(current: number, previous: number) {
  if (previous === 0) return current === 0 ? 0 : 100
  return round1(((current - previous) / previous) * 100)
}

function rate(part: number, total: number) {
  if (total <= 0) return 0
  return round1((part / total) * 100)
}

function formatCount(value: number) {
  return Math.round(value).toLocaleString('en-US')
}

function formatMoney(amount: number) {
  return `৳ ${Math.round(amount).toLocaleString('en-US')}`
}

function formatRate(value: number) {
  return `${value.toFixed(1)}%`
}

function moneyAmount(value: { toString(): string } | null | undefined) {
  const amount = Number(value ?? 0)
  return Number.isFinite(amount) ? amount : 0
}

function andWhere(parts: Prisma.LeadWhereInput[]): Prisma.LeadWhereInput {
  const cleaned = parts.filter((part) => Object.keys(part).length > 0)
  if (cleaned.length === 0) return {}
  if (cleaned.length === 1) return cleaned[0]
  return { AND: cleaned }
}

function isUuid(value: string | undefined) {
  return Boolean(value && UUID_RE.test(value))
}

function knownPaymentStatus(value: string | undefined): PaymentTxnStatus | undefined {
  if (!value) return undefined
  const key = value.trim().toUpperCase()
  if (key === 'PAID') return 'COMPLETED'
  return (PAYMENT_STATUSES as readonly string[]).includes(key) ? (key as PaymentTxnStatus) : undefined
}

type PeriodWindow = {
  from: Date
  to: Date
  periodLabel: string
  comparisonLabel: string
  notice: string | null
  previous: { from: Date; to: Date }
  trendStart: Date
  trendEnd: Date
  trendKeys: string[]
}

function resolveWindow(query: ReportOverviewQuery, now = new Date()): PeriodWindow {
  const today = dhakaParts(now)
  const todayStart = dhakaStart(today.year, today.month, today.day)
  const preset = (query.datePreset || 'this_month').trim().toLowerCase()
  const currentMonth = monthRange(today.year, today.month)
  const trendEnd = currentMonth.to
  const trendStartDate = new Date(Date.UTC(today.year, today.month - 1 - 5, 1))
  const trendStart = dhakaStart(trendStartDate.getUTCFullYear(), trendStartDate.getUTCMonth() + 1, 1)
  const trendKeys: string[] = []
  for (let index = 0; index < 6; index += 1) {
    const cursor = new Date(Date.UTC(today.year, today.month - 1 - 5 + index, 1))
    const year = cursor.getUTCFullYear()
    const month = cursor.getUTCMonth() + 1
    trendKeys.push(`${year}-${String(month).padStart(2, '0')}`)
  }

  let from = currentMonth.from
  let to = currentMonth.to
  let periodLabel = 'This Month'
  let comparisonLabel = 'vs previous month'
  let notice: string | null = null
  let previous = previousCalendarMonth(from)

  if (preset === 'today') {
    from = todayStart
    to = addDays(todayStart, 1)
    periodLabel = 'Today'
    comparisonLabel = 'vs yesterday'
    previous = { from: addDays(from, -1), to: from }
  } else if (preset === 'yesterday') {
    from = addDays(todayStart, -1)
    to = todayStart
    periodLabel = 'Yesterday'
    comparisonLabel = 'vs previous day'
    previous = { from: addDays(from, -1), to: from }
  } else if (preset === 'this_week') {
    const offset = WEEKDAY_INDEX[today.weekday] ?? 0
    from = addDays(todayStart, -offset)
    to = addDays(from, 7)
    periodLabel = 'This Week'
    comparisonLabel = 'vs previous week'
    previous = { from: addDays(from, -7), to: from }
  } else if (preset === 'last_month') {
    const prev = previousCalendarMonth(currentMonth.from)
    from = prev.from
    to = prev.to
    periodLabel = 'Last Month'
    comparisonLabel = 'vs previous month'
    previous = previousCalendarMonth(from)
  } else if (preset === 'custom') {
    periodLabel = 'Custom Range'
    comparisonLabel = 'vs previous period'
    if (!query.customFrom || !query.customTo) {
      notice = 'Select a start and end date to load this range.'
      from = now
      to = now
      previous = { from: now, to: now }
    } else {
      const start = parseDay(query.customFrom)
      const end = parseDay(query.customTo)
      if (!start || !end || start.getTime() > end.getTime()) {
        throw new HttpError(400, 'Please select a valid date range.', 'INVALID_INPUT')
      }
      from = start
      to = addDays(end, 1)
      const length = to.getTime() - from.getTime()
      previous = { from: new Date(from.getTime() - length), to: from }
    }
  }

  return { from, to, periodLabel, comparisonLabel, notice, previous, trendStart, trendEnd, trendKeys }
}

function previousCalendarMonth(monthStart: Date) {
  const parts = dhakaParts(monthStart)
  const month = parts.month === 1 ? 12 : parts.month - 1
  const year = parts.month === 1 ? parts.year - 1 : parts.year
  return monthRange(year, month)
}

function monthKey(date: Date) {
  const parts = dhakaParts(date)
  return `${parts.year}-${String(parts.month).padStart(2, '0')}`
}

function monthLabel(key: string) {
  const month = Number(key.slice(5, 7))
  return MONTH_LABELS[month - 1] || key
}

function sharePercents(values: number[], total: number) {
  if (total <= 0) return values.map(() => 0)
  const rounded = values.map((value) => round1((value / total) * 100))
  const drift = round1(100 - rounded.reduce((sum, value) => sum + value, 0))
  let index = 0
  values.forEach((value, itemIndex) => {
    if (value > values[index]) index = itemIndex
  })
  rounded[index] = round1(rounded[index] + drift)
  return rounded
}

export async function getReportOverview(auth: AuthContext, query: ReportOverviewQuery) {
  const window = resolveWindow(query)
  const employeeId = query.employeeId && query.employeeId !== 'all' ? query.employeeId : undefined
  const countryCode = query.country && query.country !== 'all' ? query.country.trim() : undefined
  const sourceCode = query.leadSource && query.leadSource !== 'all' ? query.leadSource.trim() : undefined
  const serviceId = isUuid(query.service) ? query.service : undefined
  const fileStatus = query.fileStatus?.trim().toLowerCase()
  const paymentStatus = knownPaymentStatus(query.paymentStatus)

  const scope = auth.dataScopes.lead ?? 'OWN'
  const employeeDirectoryWhere: Prisma.EmployeeWhereInput = { userId: { not: null } }
  if (scope === 'OWN') employeeDirectoryWhere.userId = auth.user.id
  else if (scope === 'TEAM' && auth.user.teamId) employeeDirectoryWhere.teamId = auth.user.teamId
  else if (scope === 'DEPARTMENT' && auth.user.departmentId) {
    employeeDirectoryWhere.departmentId = auth.user.departmentId
  }

  const [catalog, serviceItems, employees, selectedEmployee] = await Promise.all([
    prisma.masterDataItem.findMany({
      where: {
        status: 'ACTIVE',
        categoryKey: { in: ['LEAD_STATUS', 'LEAD_SOURCE', 'COUNTRY'] },
      },
      select: { categoryKey: true, code: true, name: true, behaviorKey: true, sortOrder: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    prisma.serviceItem.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.employee.findMany({
      where: employeeDirectoryWhere,
      select: { userId: true, fullName: true },
      orderBy: { fullName: 'asc' },
      take: 500,
    }),
    isUuid(employeeId)
      ? prisma.employee.findFirst({
          where: { OR: [{ id: employeeId }, { userId: employeeId }] },
          select: { userId: true, teamId: true, departmentId: true },
        })
      : Promise.resolve(null),
  ])

  const statuses = catalog.filter((item) => item.categoryKey === 'LEAD_STATUS')
  const byCode = new Map<string, StatusMeta>()
  const byName = new Map<string, StatusMeta>()
  for (const item of statuses) {
    const meta: StatusMeta = {
      code: (item.code || '').toUpperCase(),
      name: item.name,
      behaviorKey: item.behaviorKey,
      sortOrder: item.sortOrder,
    }
    if (meta.code) byCode.set(meta.code, meta)
    byName.set(item.name.trim().toLowerCase(), meta)
  }
  const contactedOrder = byCode.get('CONTACTED')?.sortOrder ?? byName.get('contacted')?.sortOrder ?? 2
  const qualifiedOrder = byCode.get('QUALIFIED')?.sortOrder ?? byName.get('qualified')?.sortOrder ?? 3

  const sourceNameByCode = new Map<string, string>()
  const countryNameByCode = new Map<string, string>()
  for (const item of catalog) {
    if (!item.code) continue
    if (item.categoryKey === 'LEAD_SOURCE') sourceNameByCode.set(item.code.toUpperCase(), item.name)
    if (item.categoryKey === 'COUNTRY') countryNameByCode.set(item.code.toUpperCase(), item.name)
  }

  const dimensions = buildDimensionWhere({
    auth,
    employeeId,
    employeeScope: query.employeeScope,
    selectedEmployee,
    countryCode,
    countryName: countryCode ? countryNameByCode.get(countryCode.toUpperCase()) : undefined,
    sourceCode,
    sourceName: sourceCode ? sourceNameByCode.get(sourceCode.toUpperCase()) : undefined,
    serviceId,
    fileOpen: Boolean(fileStatus && FILE_OPEN_VALUES.has(fileStatus)),
    paymentStatus,
  })

  const fetchFrom = new Date(
    Math.min(window.trendStart.getTime(), window.from.getTime(), window.previous.from.getTime()),
  )
  const fetchTo = new Date(
    Math.max(window.trendEnd.getTime(), window.to.getTime(), window.previous.to.getTime()),
  )

  const [leads, filesOpened, filesOpenedPrevious, collection, collectionPrevious, overdueFollowUps, pendingFileDocs, pendingLeadDocs, recentPayments, recentFiles, recentFollowUps, recentDocuments] =
    await Promise.all([
      prisma.lead.findMany({
        where: andWhere([dimensions, { createdAt: { gte: fetchFrom, lt: fetchTo } }]),
        select: {
          id: true,
          status: true,
          statusCode: true,
          source: true,
          sourceCode: true,
          ownerId: true,
          ownerName: true,
          createdAt: true,
          owner: {
            select: {
              id: true,
              fullName: true,
              primaryRole: { select: { key: true } },
              employee: { select: { role: { select: { key: true } } } },
            },
          },
        },
      }),
      prisma.crmFile.count({
        where: { openedAt: { gte: window.from, lt: window.to }, lead: dimensions },
      }),
      prisma.crmFile.count({
        where: { openedAt: { gte: window.previous.from, lt: window.previous.to }, lead: dimensions },
      }),
      prisma.payment.aggregate({
        where: {
          status: 'COMPLETED',
          paymentDate: { gte: window.from, lt: window.to },
          lead: dimensions,
        },
        _sum: { amount: true },
      }),
      prisma.payment.aggregate({
        where: {
          status: 'COMPLETED',
          paymentDate: { gte: window.previous.from, lt: window.previous.to },
          lead: dimensions,
        },
        _sum: { amount: true },
      }),
      prisma.followUp.count({
        where: { status: 'Overdue', lead: dimensions },
      }),
      prisma.fileDocument.count({
        where: {
          archivedAt: null,
          status: 'UNDER_REVIEW',
          file: { lead: dimensions },
        },
      }),
      prisma.leadDocument.count({
        where: {
          status: 'PENDING',
          isLatest: true,
          archivedAt: null,
          lead: dimensions,
        },
      }),
      prisma.payment.findMany({
        where: {
          status: 'COMPLETED',
          paymentDate: { gte: fetchFrom, lt: fetchTo },
          lead: dimensions,
        },
        select: {
          paymentDate: true,
          createdAt: true,
          receivedBy: { select: { fullName: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 400,
      }),
      prisma.crmFile.findMany({
        where: { openedAt: { gte: fetchFrom, lt: fetchTo }, lead: dimensions },
        select: { openedAt: true, openedBy: { select: { fullName: true } } },
        orderBy: { openedAt: 'desc' },
        take: 400,
      }),
      prisma.followUp.findMany({
        where: { createdAt: { gte: fetchFrom, lt: fetchTo }, lead: dimensions },
        select: {
          createdAt: true,
          ownerName: true,
          owner: { select: { fullName: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 400,
      }),
      prisma.leadDocument.findMany({
        where: { createdAt: { gte: fetchFrom, lt: fetchTo }, lead: dimensions },
        select: { createdAt: true, uploadedBy: { select: { fullName: true } } },
        orderBy: { createdAt: 'desc' },
        take: 400,
      }),
    ])

  const periodLeads = leads.filter((lead) => inRange(lead.createdAt, window.from, window.to))
  const previousLeads = leads.filter((lead) => inRange(lead.createdAt, window.previous.from, window.previous.to))
  const history = await loadStatusHistory(periodLeads.map((lead) => lead.id))

  const periodStats = summarize(periodLeads, history, {
    byCode,
    byName,
    contactedOrder,
    qualifiedOrder,
  })
  const previousStats = summarize(previousLeads, new Map(), {
    byCode,
    byName,
    contactedOrder,
    qualifiedOrder,
  })

  const conversionRate = rate(periodStats.converted, periodStats.total)
  const previousRate = rate(previousStats.converted, previousStats.total)
  const collected = moneyAmount(collection._sum.amount)
  const collectedPrevious = moneyAmount(collectionPrevious._sum.amount)
  const sources = buildSources(periodLeads, sourceNameByCode)
  const people = buildPeople(periodLeads, previousLeads, {
    byCode,
    byName,
    contactedOrder,
    qualifiedOrder,
  })
  const trend = window.trendKeys.map((key) => {
    const rows = leads.filter((lead) => monthKey(lead.createdAt) === key)
    const stats = summarize(rows, new Map(), { byCode, byName, contactedOrder, qualifiedOrder })
    return { label: monthLabel(key), totalLeads: stats.total, convertedLeads: stats.converted }
  })

  const pendingDocuments = pendingFileDocs + pendingLeadDocs
  const topSource = sources[0]
  const insights = [
    {
      id: 'conversion',
      tone: conversionRate - previousRate >= 0 ? 'success' : 'warning',
      text:
        periodStats.total === 0
          ? 'No leads were created in this period.'
          : conversionRate === previousRate
            ? `Conversion rate is ${formatRate(conversionRate)} for this period.`
            : `Conversion rate ${conversionRate > previousRate ? 'increased' : 'decreased'} by ${Math.abs(round1(conversionRate - previousRate)).toFixed(1)} percentage points compared with the previous period.`,
    },
    {
      id: 'overdue',
      tone: overdueFollowUps > 0 ? 'warning' : 'success',
      text:
        overdueFollowUps > 0
          ? `Follow-ups are overdue for ${formatCount(overdueFollowUps)} ${overdueFollowUps === 1 ? 'record' : 'records'}. Prioritize counsellor callbacks today.`
          : 'No follow-ups are overdue right now.',
    },
    {
      id: 'source',
      tone: 'info' as const,
      text: topSource
        ? `${topSource.label} is the top source at ${topSource.percent}% of leads in this period.`
        : 'No lead source activity in this period.',
    },
    {
      id: 'collection',
      tone: collected - collectedPrevious >= 0 ? 'success' : 'warning',
      text:
        collected === collectedPrevious
          ? `Total collection is ${formatMoney(collected)} for this period.`
          : `Total collection is ${collected > collectedPrevious ? 'up' : 'down'} ${Math.abs(percentChange(collected, collectedPrevious))}% compared with the previous period.`,
    },
    {
      id: 'documents',
      tone: pendingDocuments > 0 ? 'warning' : 'success',
      text:
        pendingDocuments > 0
          ? `${formatCount(pendingDocuments)} ${pendingDocuments === 1 ? 'document is' : 'documents are'} pending verification.`
          : 'No documents are waiting for verification.',
    },
  ]

  return {
    comparisonLabel: window.comparisonLabel,
    periodLabel: window.periodLabel,
    notice: window.notice,
    kpis: [
      {
        key: 'total-leads',
        label: 'Total Leads',
        value: formatCount(periodStats.total),
        change: percentChange(periodStats.total, previousStats.total),
        tone: 'blue' as const,
      },
      {
        key: 'converted',
        label: 'Converted Leads',
        value: formatCount(periodStats.converted),
        change: percentChange(periodStats.converted, previousStats.converted),
        tone: 'green' as const,
      },
      {
        key: 'conversion-rate',
        label: 'Conversion Rate',
        value: formatRate(conversionRate),
        change: round1(conversionRate - previousRate),
        tone: 'purple' as const,
      },
      {
        key: 'files-opened',
        label: 'Files Opened',
        value: formatCount(filesOpened),
        change: percentChange(filesOpened, filesOpenedPrevious),
        tone: 'orange' as const,
      },
      {
        key: 'collection',
        label: 'Total Collection',
        value: formatMoney(collected),
        change: percentChange(collected, collectedPrevious),
        tone: 'rose' as const,
      },
    ],
    funnel: [
      stage('Total Leads', periodStats.total, periodStats.total, FUNNEL_COLORS.total),
      stage('Contacted', periodStats.contacted, periodStats.total, FUNNEL_COLORS.contacted),
      stage('Qualified', periodStats.qualified, periodStats.total, FUNNEL_COLORS.qualified),
      stage('Converted', periodStats.converted, periodStats.total, FUNNEL_COLORS.converted),
      stage('Lost', periodStats.lost, periodStats.total, FUNNEL_COLORS.lost),
    ],
    trend,
    sources,
    topCounsellors: people.counsellors,
    employeePerformance: people.employees,
    insights,
    recentReports: buildRecentReports({
      now: new Date(),
      leads,
      payments: recentPayments,
      files: recentFiles,
      followUps: recentFollowUps,
      documents: recentDocuments,
    }),
    options: {
      employees: employees
        .filter((employee): employee is { userId: string; fullName: string } => Boolean(employee.userId))
        .map((employee) => ({ value: employee.userId, label: employee.fullName })),
      countries: choices(catalog, 'COUNTRY'),
      leadSources: choices(catalog, 'LEAD_SOURCE'),
      services: serviceItems.map((item) => ({ value: item.id, label: item.name })),
      fileStatuses: [{ value: 'open', label: 'File Opened' }],
      paymentStatuses: [
        { value: 'COMPLETED', label: 'Paid' },
        { value: 'PENDING', label: 'Pending' },
        { value: 'FAILED', label: 'Failed' },
        { value: 'CANCELLED', label: 'Cancelled' },
        { value: 'REVERSED', label: 'Reversed' },
      ],
    },
  }
}

function choices(
  catalog: Array<{ categoryKey: string; code: string | null; name: string }>,
  categoryKey: string,
): Choice[] {
  return catalog
    .filter((item) => item.categoryKey === categoryKey && item.code)
    .map((item) => ({ value: item.code as string, label: item.name }))
}

function stage(label: string, value: number, total: number, color: string) {
  return { label, value, percent: rate(value, total), color }
}

function buildDimensionWhere(input: {
  auth: AuthContext
  employeeId?: string
  employeeScope?: string
  selectedEmployee: { userId: string | null; teamId: string | null; departmentId: string | null } | null
  countryCode?: string
  countryName?: string
  sourceCode?: string
  sourceName?: string
  serviceId?: string
  fileOpen: boolean
  paymentStatus?: PaymentTxnStatus
}): Prisma.LeadWhereInput {
  const parts: Prisma.LeadWhereInput[] = [{ archivedAt: null }, leadScopeWhere(input.auth)]
  const scope = (input.employeeScope || 'employee').toLowerCase()

  if (isUuid(input.employeeId)) {
    if (scope === 'team' && input.selectedEmployee?.teamId) {
      parts.push({ owner: { teamId: input.selectedEmployee.teamId } })
    } else if (scope === 'department' && input.selectedEmployee?.departmentId) {
      parts.push({ owner: { departmentId: input.selectedEmployee.departmentId } })
    } else if (input.selectedEmployee?.userId) {
      parts.push({ ownerId: input.selectedEmployee.userId })
    } else {
      parts.push({ ownerId: input.employeeId })
    }
  }

  if (input.countryCode) {
    const names = [input.countryCode, input.countryName].filter((value): value is string => Boolean(value))
    parts.push({
      OR: [
        { preferredCountryCode: { equals: input.countryCode, mode: 'insensitive' } },
        ...names.map((name) => ({ country: { equals: name, mode: 'insensitive' as const } })),
      ],
    })
  }

  if (input.sourceCode) {
    const names = [input.sourceCode, input.sourceName].filter((value): value is string => Boolean(value))
    parts.push({
      OR: [
        { sourceCode: { equals: input.sourceCode, mode: 'insensitive' } },
        ...names.map((name) => ({ source: { equals: name, mode: 'insensitive' as const } })),
      ],
    })
  }

  if (input.serviceId) {
    parts.push({ serviceOffers: { some: { items: { some: { serviceItemId: input.serviceId } } } } })
  }
  if (input.fileOpen) parts.push({ crmFile: { isNot: null } })
  if (input.paymentStatus) parts.push({ payments: { some: { status: input.paymentStatus } } })
  return andWhere(parts)
}

function resolveStatus(
  lead: { status: string; statusCode: string | null },
  byCode: Map<string, StatusMeta>,
  byName: Map<string, StatusMeta>,
): StatusMeta {
  const rawCode = (lead.statusCode || '').trim().toUpperCase()
  const code = LEGACY_CODE[rawCode] || rawCode
  const byCodeMatch = code ? byCode.get(code) : undefined
  if (byCodeMatch) return byCodeMatch
  const rawName = lead.status.trim().toLowerCase()
  const name = LEGACY_NAME[rawName] || rawName
  return byName.get(name) || { code: code || 'UNKNOWN', name: lead.status || 'Unknown', behaviorKey: null, sortOrder: 0 }
}

function isConverted(meta: StatusMeta) {
  return CONVERTED_BEHAVIORS.has(meta.behaviorKey || '') || CONVERTED_CODES.has(meta.code)
}

function reached(
  meta: StatusMeta,
  history: Set<string> | undefined,
  minOrder: number,
  byCode: Map<string, StatusMeta>,
  byName: Map<string, StatusMeta>,
) {
  if (isConverted(meta)) return true
  if (meta.sortOrder >= minOrder && !TERMINAL_BEHAVIORS.has(meta.behaviorKey || '')) return true
  if (!history) return false
  for (const token of history) {
    const item = byCode.get(token) || byName.get(token)
    if (!item || TERMINAL_BEHAVIORS.has(item.behaviorKey || '')) continue
    if (item.sortOrder >= minOrder || isConverted(item)) return true
  }
  return false
}

function summarize(
  rows: LeadSnapshot[],
  history: Map<string, Set<string>>,
  lookup: {
    byCode: Map<string, StatusMeta>
    byName: Map<string, StatusMeta>
    contactedOrder: number
    qualifiedOrder: number
  },
) {
  let contacted = 0
  let qualified = 0
  let converted = 0
  let lost = 0
  for (const lead of rows) {
    const meta = resolveStatus(lead, lookup.byCode, lookup.byName)
    const tokens = history.get(lead.id)
    if (reached(meta, tokens, lookup.contactedOrder, lookup.byCode, lookup.byName)) contacted += 1
    if (reached(meta, tokens, lookup.qualifiedOrder, lookup.byCode, lookup.byName)) qualified += 1
    if (isConverted(meta)) converted += 1
    if (meta.behaviorKey === 'lost' || meta.code === 'LOST') lost += 1
  }
  return { total: rows.length, contacted, qualified, converted, lost }
}

async function loadStatusHistory(ids: string[]) {
  const map = new Map<string, Set<string>>()
  const size = 2000
  for (let index = 0; index < ids.length; index += size) {
    const chunk = ids.slice(index, index + size)
    const rows = await prisma.leadStatusHistory.findMany({
      where: { leadId: { in: chunk } },
      distinct: ['leadId', 'newStatusCode'],
      select: { leadId: true, newStatusCode: true, newStatus: true },
    })
    for (const row of rows) {
      const tokens = map.get(row.leadId) ?? new Set<string>()
      if (row.newStatusCode) tokens.add(row.newStatusCode.trim().toUpperCase())
      if (row.newStatus) tokens.add(row.newStatus.trim().toLowerCase())
      map.set(row.leadId, tokens)
    }
  }
  return map
}

function buildSources(leads: LeadSnapshot[], sourceNameByCode: Map<string, string>) {
  const buckets = new Map<string, { label: string; value: number }>()
  for (const lead of leads) {
    const code = (lead.sourceCode || '').trim().toUpperCase()
    const name = (lead.source || '').trim()
    const key = code || name.toLowerCase() || 'UNKNOWN'
    const label = (code && sourceNameByCode.get(code)) || name || 'Unknown'
    const current = buckets.get(key) ?? { label, value: 0 }
    current.value += 1
    buckets.set(key, current)
  }
  const sorted = [...buckets.values()].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
  const visible = sorted.length > 6 ? sorted.slice(0, 5) : sorted.slice()
  if (sorted.length > 6) {
    visible.push({
      label: 'Others',
      value: sorted.slice(5).reduce((sum, item) => sum + item.value, 0),
    })
  }
  const total = leads.length
  const percents = sharePercents(
    visible.map((item) => item.value),
    total,
  )
  return visible.map((item, index) => ({
    label: item.label,
    value: item.value,
    percent: percents[index] ?? 0,
    color: item.label === 'Others' ? OTHER_COLOR : SOURCE_COLORS[index] || OTHER_COLOR,
  }))
}

function buildPeople(
  periodLeads: LeadSnapshot[],
  previousLeads: LeadSnapshot[],
  lookup: {
    byCode: Map<string, StatusMeta>
    byName: Map<string, StatusMeta>
    contactedOrder: number
    qualifiedOrder: number
  },
) {
  const rows = new Map<
    string,
    { id: string; name: string; roleKey: string; leads: number; converted: number; prevLeads: number; prevConverted: number }
  >()

  const ensure = (lead: LeadSnapshot) => {
    if (!lead.ownerId) return null
    const existing = rows.get(lead.ownerId)
    if (existing) return existing
    const roleKey = (lead.owner?.primaryRole?.key || lead.owner?.employee?.role?.key || '').toLowerCase()
    const created = {
      id: lead.ownerId,
      name: lead.owner?.fullName || lead.ownerName || 'Unassigned',
      roleKey,
      leads: 0,
      converted: 0,
      prevLeads: 0,
      prevConverted: 0,
    }
    rows.set(lead.ownerId, created)
    return created
  }

  for (const lead of periodLeads) {
    const row = ensure(lead)
    if (!row) continue
    row.leads += 1
    if (isConverted(resolveStatus(lead, lookup.byCode, lookup.byName))) row.converted += 1
  }
  for (const lead of previousLeads) {
    const row = ensure(lead)
    if (!row) continue
    row.prevLeads += 1
    if (isConverted(resolveStatus(lead, lookup.byCode, lookup.byName))) row.prevConverted += 1
  }

  const ranked = [...rows.values()]
    .filter((row) => row.leads > 0)
    .map((row) => {
      const currentRate = rate(row.converted, row.leads)
      const previousRate = rate(row.prevConverted, row.prevLeads)
      return {
        id: row.id,
        name: row.name,
        leads: row.leads,
        converted: row.converted,
        rate: currentRate,
        change: row.prevLeads > 0 ? round1(currentRate - previousRate) : 0,
        roleKey: row.roleKey,
      }
    })
    .sort((a, b) => b.converted - a.converted || b.rate - a.rate || b.leads - a.leads || a.name.localeCompare(b.name))

  const counsellors = ranked.filter((row) => row.roleKey === 'counsellor').slice(0, 5)
  const employees = ranked.filter((row) => row.roleKey !== 'counsellor').slice(0, 5)
  return {
    counsellors: counsellors.map(stripRole),
    employees: employees.map(stripRole),
  }
}

function stripRole(row: { id: string; name: string; leads: number; converted: number; rate: number; change: number }) {
  return {
    id: row.id,
    name: row.name,
    leads: row.leads,
    converted: row.converted,
    rate: row.rate,
    change: row.change,
  }
}

type ReportActivity = { at: Date; actor: string; periodAt?: Date }

const RECENT_REPORT_KINDS = [
  { id: 'lead-conversion', title: 'Lead & Conversion', format: 'PDF', tabId: 'lead-conversion' },
  { id: 'payment', title: 'Payment & Collection', format: 'Excel', tabId: 'payment' },
  { id: 'employee-performance', title: 'Employee Performance', format: 'CSV', tabId: 'employee-performance' },
  { id: 'follow-up', title: 'Follow-up & Activity', format: 'CSV', tabId: 'follow-up' },
  { id: 'service-file', title: 'Service & File', format: 'PDF', tabId: 'service-file' },
  { id: 'document', title: 'Document Status', format: 'PDF', tabId: 'document' },
] as const

function buildRecentReports(input: {
  now: Date
  leads: LeadSnapshot[]
  payments: Array<{ paymentDate: Date; createdAt: Date; receivedBy: { fullName: string } }>
  files: Array<{ openedAt: Date; openedBy: { fullName: string } | null }>
  followUps: Array<{ createdAt: Date; ownerName: string | null; owner: { fullName: string } | null }>
  documents: Array<{ createdAt: Date; uploadedBy: { fullName: string } | null }>
}) {
  const groups: Record<(typeof RECENT_REPORT_KINDS)[number]['id'], ReportActivity[]> = {
    'lead-conversion': input.leads.map((lead) => ({
      at: lead.createdAt,
      actor: lead.owner?.fullName || lead.ownerName || 'System',
    })),
    payment: input.payments.map((payment) => ({
      at: payment.createdAt,
      periodAt: payment.paymentDate,
      actor: payment.receivedBy.fullName || 'System',
    })),
    'employee-performance': input.leads
      .filter((lead) => lead.ownerId)
      .map((lead) => ({
        at: lead.createdAt,
        actor: lead.owner?.fullName || lead.ownerName || 'System',
      })),
    'follow-up': input.followUps.map((followUp) => ({
      at: followUp.createdAt,
      actor: followUp.owner?.fullName || followUp.ownerName || 'System',
    })),
    'service-file': input.files.map((file) => ({
      at: file.openedAt,
      actor: file.openedBy?.fullName || 'System',
    })),
    document: input.documents.map((document) => ({
      at: document.createdAt,
      actor: document.uploadedBy?.fullName || 'System',
    })),
  }

  const rows = RECENT_REPORT_KINDS.flatMap((kind) => {
    const latestByMonth = new Map<string, ReportActivity>()
    for (const activity of groups[kind.id]) {
      const key = monthKey(activity.periodAt || activity.at)
      const current = latestByMonth.get(key)
      if (!current || activity.at.getTime() > current.at.getTime()) latestByMonth.set(key, activity)
    }
    return [...latestByMonth.entries()].map(([key, activity]) => ({
      id: `${kind.id}:${key}`,
      name: `${kind.title} — ${monthLabel(key)} ${key.slice(0, 4)}`,
      dateRange: monthRangeLabel(key, input.now),
      generatedOn: formatGeneratedOn(activity.at),
      createdBy: activity.actor,
      format: kind.format,
      tabId: kind.tabId,
      sortAt: activity.at.getTime(),
    }))
  })

  return rows
    .sort((left, right) => right.sortAt - left.sortAt || left.name.localeCompare(right.name))
    .slice(0, 8)
    .map(({ sortAt: _sortAt, ...row }) => row)
}

function monthRangeLabel(key: string, now: Date) {
  const year = Number(key.slice(0, 4))
  const month = Number(key.slice(5, 7))
  const start = dhakaStart(year, month, 1)
  const nextMonth = month === 12 ? 1 : month + 1
  const nextYear = month === 12 ? year + 1 : year
  const monthEnd = addDays(dhakaStart(nextYear, nextMonth, 1), -1)
  const today = dhakaParts(now)
  const end = today.year === year && today.month === month && now.getTime() < monthEnd.getTime() ? now : monthEnd
  return `${formatDhaka(start, false)} – ${formatDhaka(end, true)}`
}

function formatGeneratedOn(date: Date) {
  const parts = dhakaFormatParts(date, true)
  return `${parts.month} ${parts.day}, ${parts.year} ${parts.hour}:${parts.minute} ${parts.dayPeriod}`
}

function formatDhaka(date: Date, withYear: boolean) {
  const parts = dhakaFormatParts(date, false)
  return withYear ? `${parts.month} ${parts.day}, ${parts.year}` : `${parts.month} ${parts.day}`
}

function dhakaFormatParts(date: Date, withTime: boolean) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Dhaka',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  }).formatToParts(date)
  const value = (type: string) => parts.find((part) => part.type === type)?.value || ''
  return {
    month: value('month'),
    day: value('day'),
    year: value('year'),
    hour: value('hour'),
    minute: value('minute'),
    dayPeriod: value('dayPeriod'),
  }
}
