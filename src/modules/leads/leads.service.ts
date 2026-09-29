import type { Prisma } from '../../lib/prisma-client'
import { writeAuditLog } from '../../lib/audit'
import { HttpError, httpError } from '../../lib/http-error'
import { prisma } from '../../lib/prisma'
import type { AuthContext } from '../auth/session.service'
import { nextLeadCode } from './lead-code'
import { resolveCountryAssignment } from './leads.assignment'
import {
  allowedFieldsFor,
  asOptionalString,
  asString,
  assertCanManageLeadAssignment,
  assertCanViewLead,
  assigneeVisibilityWhere,
  computeLeadScore,
  FOLLOW_UP_CLOSED_STATUSES,
  formatWaitingTime,
  hasPermission,
  isValidEmail,
  isValidMobile,
  leadPoolScopeWhere,
  leadScopeWhere,
  myLeadsOwnerWhere,
  priorityRank,
  normalizePhone,
  parseBoolean,
  parseDateOnly,
  parseNonNegInt,
  parseScore,
  parseYear,
  profileCompletion,
  resolveMasterCode,
  throwIfInvalid,
  titleCaseName,
} from './leads.helpers'
import {
  PIPELINE_STATUSES,
  STATUS_MESSAGES,
  describeStatusChange,
  lostReasonRequiredFor,
  missingQualifiedData,
  remarksRequiredFor,
  resolveLeadStatus,
  type LeadStatusItem,
} from './lead-status'

type AuditMeta = { ipAddress?: string; userAgent?: string }

const leadInclude = {
  owner: { select: { id: true, fullName: true, teamId: true } },
  assignedCountryTeam: { select: { id: true, name: true, key: true } },
  createdBy: { select: { id: true, fullName: true } },
  updatedBy: { select: { id: true, fullName: true } },
} as const

type LeadRecord = Prisma.LeadGetPayload<{ include: typeof leadInclude }>

function daysAgoLabel(date: Date | null | undefined) {
  if (!date) return '—'
  const diffMs = Date.now() - date.getTime()
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (days <= 0) {
    const hours = Math.max(1, Math.floor(diffMs / (1000 * 60 * 60)))
    return `${hours}h ago`
  }
  if (days === 1) return 'Yesterday'
  return `${days} days ago`
}

function serializeLead(lead: LeadRecord) {
  const completion = profileCompletion(lead)
  return {
    id: lead.id,
    code: lead.code,
    name: lead.name,
    phone: lead.phone,
    phoneCountryCode: lead.phoneCountryCode,
    whatsapp: lead.whatsapp,
    whatsappSameAsPhone: lead.whatsappSameAsPhone,
    email: lead.email,
    dateOfBirth: lead.dateOfBirth ? lead.dateOfBirth.toISOString().slice(0, 10) : null,
    currentLocation: lead.currentLocation,
    country: lead.country,
    preferredCountryCode: lead.preferredCountryCode,
    preferredDegreeCode: lead.preferredDegreeCode,
    preferredCourse: lead.preferredCourse,
    preferredIntakeCode: lead.preferredIntakeCode,
    studyPurposeCode: lead.studyPurposeCode,
    studyPurposeOther: lead.studyPurposeOther,
    highestQualificationCode: lead.highestQualificationCode,
    institutionName: lead.institutionName,
    passingYear: lead.passingYear,
    resultCgpa: lead.resultCgpa,
    studyGapYears: lead.studyGapYears,
    englishTestCode: lead.englishTestCode,
    testStatusCode: lead.testStatusCode,
    overallScore: lead.overallScore,
    testDate: lead.testDate ? lead.testDate.toISOString().slice(0, 10) : null,
    listening: lead.listening,
    reading: lead.reading,
    writing: lead.writing,
    speaking: lead.speaking,
    estimatedBudgetCode: lead.estimatedBudgetCode,
    fundingSourceCode: lead.fundingSourceCode,
    financialReadinessCode: lead.financialReadinessCode,
    previouslyAppliedAbroad: lead.previouslyAppliedAbroad,
    previousVisaApplication: lead.previousVisaApplication,
    previousVisaRefusal: lead.previousVisaRefusal,
    prevVisaCountry: lead.prevVisaCountry,
    prevVisaType: lead.prevVisaType,
    prevVisaYear: lead.prevVisaYear,
    prevVisaResult: lead.prevVisaResult,
    refusalCountry: lead.refusalCountry,
    refusalYear: lead.refusalYear,
    refusalReason: lead.refusalReason,
    decisionTimelineCode: lead.decisionTimelineCode,
    decisionMakerCode: lead.decisionMakerCode,
    applicationReadinessCode: lead.applicationReadinessCode,
    studyIntentCode: lead.studyIntentCode,
    preferredContactMethodCode: lead.preferredContactMethodCode,
    preferredContactTimeCode: lead.preferredContactTimeCode,
    specificContactTime: lead.specificContactTime,
    source: lead.source,
    sourceCode: lead.sourceCode,
    sourceLocked: lead.sourceLocked,
    campaign: lead.campaign,
    utmSource: lead.utmSource,
    utmMedium: lead.utmMedium,
    utmCampaign: lead.utmCampaign,
    remarks: lead.remarks,
    notes: lead.notes,
    status: lead.status,
    statusCode: lead.statusCode,
    lostReasonCode: lead.lostReasonCode,
    academicFitCode: lead.academicFitCode,
    englishReadinessCode: lead.englishReadinessCode,
    countryIntakeFitCode: lead.countryIntakeFitCode,
    studyIntentQualCode: lead.studyIntentQualCode,
    qualificationResultCode: lead.qualificationResultCode,
    unqualifiedReasonCode: lead.unqualifiedReasonCode,
    unqualifiedRemarks: lead.unqualifiedRemarks,
    profileCompletion: completion.percent,
    completion: completion.sections,
    leadScore: lead.leadScore,
    priority: lead.priority,
    priorityCode: lead.priorityCode,
    priorityManual: lead.priorityManual,
    owner: lead.owner ? { id: lead.owner.id, name: lead.owner.fullName } : lead.ownerName ? { id: lead.ownerId, name: lead.ownerName } : null,
    assignedTeam: lead.assignedCountryTeam ? { id: lead.assignedCountryTeam.id, name: lead.assignedCountryTeam.name } : null,
    createdBy: lead.createdBy ? { id: lead.createdBy.id, name: lead.createdBy.fullName } : null,
    updatedBy: lead.updatedBy ? { id: lead.updatedBy.id, name: lead.updatedBy.fullName } : null,
    createdAt: lead.createdAt.toISOString(),
    updatedAt: lead.updatedAt.toISOString(),
  }
}

async function loadLeadStatusItems(): Promise<LeadStatusItem[]> {
  const rows = await prisma.masterDataItem.findMany({
    where: { categoryKey: 'LEAD_STATUS' },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  })
  return rows.map((row) => ({
    name: row.name,
    code: row.code,
    behaviorKey: row.behaviorKey,
    sortOrder: row.sortOrder,
    status: row.status,
  }))
}

function startOfUtcDay(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function addUtcDays(date: Date, days: number) {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

function percentChange(current: number, previous: number) {
  if (previous === 0) return current > 0 ? 100 : 0
  return Math.round(((current - previous) / previous) * 100)
}

function countByStatus(rows: Array<{ status: string; _count: { _all: number } }>) {
  const map = new Map<string, number>()
  for (const row of rows) {
    const key = row.status.trim().toLowerCase()
    map.set(key, (map.get(key) || 0) + row._count._all)
  }
  return map
}

function leadSubtitle(lead: LeadRecord) {
  const parts: string[] = []
  const test = lead.englishTestCode?.trim()
  if (test && lead.overallScore != null) {
    parts.push(`${test} ${lead.overallScore}`)
  } else if (test) {
    parts.push(test)
  }
  const course = lead.preferredCourse?.trim()
  const qualification = lead.highestQualificationCode?.trim()
  if (course) parts.push(course)
  else if (qualification) parts.push(qualification)
  return parts.join(' | ')
}

function listItem(lead: LeadRecord) {
  return {
    id: lead.id,
    code: lead.code,
    name: lead.name,
    phone: lead.phone || '—',
    email: lead.email || '—',
    subtitle: leadSubtitle(lead),
    country: lead.country || '—',
    source: lead.source || '—',
    owner: lead.owner?.fullName || lead.ownerName || '—',
    status: lead.status,
    priority: lead.priority || '—',
    score: String(lead.leadScore ?? 0),
    updated: daysAgoLabel(lead.updatedAt),
    createdAt: lead.createdAt.toISOString(),
  }
}

async function findDuplicate(phoneNormalized: string, excludeId?: string) {
  if (!phoneNormalized) return null
  return prisma.lead.findFirst({
    where: {
      phoneNormalized,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, code: true, name: true, status: true },
  })
}

export async function checkDuplicate(auth: AuthContext, input: { phone?: unknown }) {
  const phone = asString(input.phone)
  if (!phone || !isValidMobile(phone)) {
    throw httpError.validation({ phone: 'Please enter a valid phone number.' })
  }
  const existing = await findDuplicate(normalizePhone(phone))
  if (!existing) {
    return { duplicate: false as const }
  }
  const visible = await prisma.lead.findFirst({
    where: { id: existing.id, AND: [leadScopeWhere(auth)] },
    select: { id: true },
  })
  return {
    duplicate: true as const,
    existingLead: existing,
    canOpen: Boolean(visible) || hasPermission(auth.permissions, 'lead:view'),
  }
}

type ParsedLead = {
  name: string
  phone: string
  phoneNormalized: string
  phoneCountryCode: string | null
  whatsapp: string | null
  whatsappSameAsPhone: boolean
  email: string | null
  dateOfBirth: Date | null
  currentLocation: string | null
  preferredCountryCode: string | null
  country: string | null
  preferredDegreeCode: string | null
  preferredCourse: string | null
  preferredIntakeCode: string | null
  studyPurposeCode: string | null
  studyPurposeOther: string | null
  highestQualificationCode: string | null
  institutionName: string | null
  passingYear: number | null
  resultCgpa: string | null
  studyGapYears: number | null
  englishTestCode: string | null
  testStatusCode: string | null
  overallScore: number | null
  testDate: Date | null
  listening: number | null
  reading: number | null
  writing: number | null
  speaking: number | null
  estimatedBudgetCode: string | null
  fundingSourceCode: string | null
  financialReadinessCode: string | null
  previouslyAppliedAbroad: boolean | null
  previousVisaApplication: boolean | null
  previousVisaRefusal: boolean | null
  prevVisaCountry: string | null
  prevVisaType: string | null
  prevVisaYear: number | null
  prevVisaResult: string | null
  refusalCountry: string | null
  refusalYear: number | null
  refusalReason: string | null
  decisionTimelineCode: string | null
  decisionMakerCode: string | null
  applicationReadinessCode: string | null
  studyIntentCode: string | null
  preferredContactMethodCode: string | null
  preferredContactTimeCode: string | null
  specificContactTime: string | null
  sourceCode: string | null
  source: string | null
  campaign: string | null
  remarks: string | null
  notes: string | null
}

async function parseLeadInput(body: Record<string, unknown>, mode: 'create' | 'update'): Promise<ParsedLead> {
  const fields: Record<string, string> = {}
  const nameRaw = asString(body.name)
  if (mode === 'create' && (nameRaw.length < 2 || nameRaw.length > 100)) {
    fields.name = 'Full Name is required.'
  } else if (nameRaw && (nameRaw.length < 2 || nameRaw.length > 100)) {
    fields.name = 'Full Name is required.'
  }

  const phone = asString(body.phone)
  if (mode === 'create' && !isValidMobile(phone)) {
    fields.phone = 'Please enter a valid phone number.'
  } else if (phone && !isValidMobile(phone)) {
    fields.phone = 'Please enter a valid phone number.'
  }

  const email = asOptionalString(body.email, 200)?.toLowerCase() || null
  if (email && !isValidEmail(email)) {
    fields.email = 'Please enter a valid email address.'
  }

  const country = await resolveMasterCode('COUNTRY', body.preferredCountryCode, 'preferredCountryCode', fields, {
    required: mode === 'create',
    message: 'Please select a preferred country.',
  })
  const source = await resolveMasterCode('LEAD_SOURCE', body.sourceCode, 'sourceCode', fields, {
    required: mode === 'create',
    message: 'Please select a lead source.',
  })
  const degree = await resolveMasterCode('STUDY_LEVEL', body.preferredDegreeCode, 'preferredDegreeCode', fields)
  const intake = await resolveMasterCode('INTAKE', body.preferredIntakeCode, 'preferredIntakeCode', fields)
  if (intake?.extras && typeof intake.extras === 'object' && intake.extras !== null && 'startDate' in intake.extras) {
    const start = String((intake.extras as Record<string, string>).startDate || '')
    if (start && start < new Date().toISOString().slice(0, 10)) {
      fields.preferredIntakeCode = 'Please select a future intake.'
    }
  }
  const purpose = await resolveMasterCode('STUDY_PURPOSE', body.studyPurposeCode, 'studyPurposeCode', fields)
  const qualification = await resolveMasterCode('EDUCATION_LEVEL', body.highestQualificationCode, 'highestQualificationCode', fields)
  const englishTest = await resolveMasterCode('ENGLISH_TEST_TYPE', body.englishTestCode, 'englishTestCode', fields)
  const testStatus = await resolveMasterCode('TEST_STATUS', body.testStatusCode, 'testStatusCode', fields)
  const budget = await resolveMasterCode('BUDGET_RANGE', body.estimatedBudgetCode, 'estimatedBudgetCode', fields)
  if (fields.estimatedBudgetCode) fields.estimatedBudgetCode = 'Please select a valid budget range.'
  const funding = await resolveMasterCode('FUNDING_SOURCE', body.fundingSourceCode, 'fundingSourceCode', fields)
  const financial = await resolveMasterCode('FINANCIAL_READINESS', body.financialReadinessCode, 'financialReadinessCode', fields)
  const timeline = await resolveMasterCode('DECISION_TIMELINE', body.decisionTimelineCode, 'decisionTimelineCode', fields)
  const decisionMaker = await resolveMasterCode('DECISION_MAKER', body.decisionMakerCode, 'decisionMakerCode', fields)
  const appReady = await resolveMasterCode('APPLICATION_READINESS', body.applicationReadinessCode, 'applicationReadinessCode', fields)
  const studyIntent = await resolveMasterCode('STUDY_INTENT', body.studyIntentCode, 'studyIntentCode', fields)
  const contactMethod = await resolveMasterCode('CONTACT_METHOD', body.preferredContactMethodCode, 'preferredContactMethodCode', fields)
  const contactTime = await resolveMasterCode('CONTACT_TIME', body.preferredContactTimeCode, 'preferredContactTimeCode', fields)

  const whatsappSame = parseBoolean(body.whatsappSameAsPhone) === true
  let whatsapp = asOptionalString(body.whatsapp, 20)
  if (whatsappSame) whatsapp = phone || null
  if (whatsapp && !isValidMobile(whatsapp)) {
    fields.whatsapp = 'Please enter a valid phone number.'
  }

  const remarks = asOptionalString(body.remarks, 1000)
  const studyPurposeOther =
    purpose?.code === 'OTHER' ? asOptionalString(body.studyPurposeOther, 200) : null
  if (purpose?.code === 'OTHER' && !studyPurposeOther) {
    fields.studyPurposeOther = 'Please specify the study purpose.'
  }

  const previouslyAppliedAbroad = parseBoolean(body.previouslyAppliedAbroad)
  const previousVisaApplication = parseBoolean(body.previousVisaApplication)
  const previousVisaRefusal = parseBoolean(body.previousVisaRefusal)

  const parsed: ParsedLead = {
    name: titleCaseName(nameRaw),
    phone,
    phoneNormalized: phone ? normalizePhone(phone) : '',
    phoneCountryCode: asOptionalString(body.phoneCountryCode, 8),
    whatsapp: whatsapp ? normalizePhone(whatsapp) : null,
    whatsappSameAsPhone: whatsappSame,
    email,
    dateOfBirth: parseDateOnly(body.dateOfBirth, 'dateOfBirth', fields),
    currentLocation: asOptionalString(body.currentLocation, 120),
    preferredCountryCode: country?.code || null,
    country: country?.name || null,
    preferredDegreeCode: degree?.code || null,
    preferredCourse: asOptionalString(body.preferredCourse, 200),
    preferredIntakeCode: intake?.code || null,
    studyPurposeCode: purpose?.code || null,
    studyPurposeOther,
    highestQualificationCode: qualification?.code || null,
    institutionName: asOptionalString(body.institutionName, 200),
    passingYear: parseYear(body.passingYear, 'passingYear', fields),
    resultCgpa: asOptionalString(body.resultCgpa, 40),
    studyGapYears: parseNonNegInt(body.studyGapYears, 'studyGapYears', fields),
    englishTestCode: englishTest?.code || null,
    testStatusCode: testStatus?.code || null,
    overallScore: parseScore(body.overallScore, 'overallScore', fields),
    testDate: parseDateOnly(body.testDate, 'testDate', fields),
    listening: parseScore(body.listening, 'listening', fields),
    reading: parseScore(body.reading, 'reading', fields),
    writing: parseScore(body.writing, 'writing', fields),
    speaking: parseScore(body.speaking, 'speaking', fields),
    estimatedBudgetCode: budget?.code || null,
    fundingSourceCode: funding?.code || null,
    financialReadinessCode: financial?.code || null,
    previouslyAppliedAbroad,
    previousVisaApplication,
    previousVisaRefusal,
    prevVisaCountry: previousVisaApplication === true ? asOptionalString(body.prevVisaCountry, 80) : null,
    prevVisaType: previousVisaApplication === true ? asOptionalString(body.prevVisaType, 80) : null,
    prevVisaYear: previousVisaApplication === true ? parseYear(body.prevVisaYear, 'prevVisaYear', fields) : null,
    prevVisaResult: previousVisaApplication === true ? asOptionalString(body.prevVisaResult, 80) : null,
    refusalCountry: previousVisaRefusal === true ? asOptionalString(body.refusalCountry, 80) : null,
    refusalYear: previousVisaRefusal === true ? parseYear(body.refusalYear, 'refusalYear', fields) : null,
    refusalReason: previousVisaRefusal === true ? asOptionalString(body.refusalReason, 400) : null,
    decisionTimelineCode: timeline?.code || null,
    decisionMakerCode: decisionMaker?.code || null,
    applicationReadinessCode: appReady?.code || null,
    studyIntentCode: studyIntent?.code || null,
    preferredContactMethodCode: contactMethod?.code || null,
    preferredContactTimeCode: contactTime?.code || null,
    specificContactTime: contactTime?.code === 'SPECIFIC' ? asOptionalString(body.specificContactTime, 40) : null,
    sourceCode: source?.code || null,
    source: source?.name || null,
    campaign: asOptionalString(body.campaign, 160),
    remarks,
    notes: asOptionalString(body.notes, 1000),
  }

  if (parsed.testStatusCode === 'TAKEN' && parsed.overallScore == null && body.overallScore) {
    fields.overallScore = 'Please enter a valid test score.'
  }

  throwIfInvalid(fields)
  return parsed
}

async function metricsFor(data: ParsedLead, extra?: Partial<LeadRecord>) {
  const merged = { ...extra, ...data } as ParsedLead & Partial<LeadRecord>
  const completion = profileCompletion(merged)
  const scored = computeLeadScore(merged)
  return {
    profileCompletion: completion.percent,
    leadScore: scored.score,
    priority: extra?.priorityManual ? extra.priority : scored.priority,
    priorityCode: extra?.priorityManual ? extra.priorityCode : scored.priorityCode,
  }
}

export async function listLeads(
  auth: AuthContext,
  query: {
    search?: string
    page?: number
    limit?: number
    status?: string
    source?: string
    priority?: string
    country?: string
  },
) {
  const search = query.search?.trim()
  const page = Math.max(1, query.page || 1)
  const limit = Math.min(50, Math.max(10, query.limit || 10))
  const status = query.status?.trim()
  const source = query.source?.trim()
  const priority = query.priority?.trim()
  const country = query.country?.trim()
  const scope = leadScopeWhere(auth)
  const now = new Date()
  const last30 = addUtcDays(startOfUtcDay(now), -30)
  const prev30 = addUtcDays(last30, -30)

  const listWhere: Prisma.LeadWhereInput = {
    AND: [
      scope,
      status && status.toLowerCase() !== 'all' ? { status: { equals: status, mode: 'insensitive' } } : {},
      source ? { source: { contains: source, mode: 'insensitive' } } : {},
      priority ? { priority: { equals: priority, mode: 'insensitive' } } : {},
      country ? { country: { contains: country, mode: 'insensitive' } } : {},
      search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search, mode: 'insensitive' } },
              { code: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
              { country: { contains: search, mode: 'insensitive' } },
              { source: { contains: search, mode: 'insensitive' } },
              { ownerName: { contains: search, mode: 'insensitive' } },
              { status: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {},
    ],
  }

  const [total, rows, allCount, last30Count, prev30Count, statusCounts, statusLast30, statusPrev30] = await Promise.all([
    prisma.lead.count({ where: listWhere }),
    prisma.lead.findMany({
      where: listWhere,
      include: leadInclude,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.lead.count({ where: scope }),
    prisma.lead.count({ where: { AND: [scope, { createdAt: { gte: last30 } }] } }),
    prisma.lead.count({ where: { AND: [scope, { createdAt: { gte: prev30, lt: last30 } }] } }),
    prisma.lead.groupBy({ by: ['status'], where: scope, _count: { _all: true } }),
    prisma.lead.groupBy({
      by: ['status'],
      where: { AND: [scope, { createdAt: { gte: last30 } }] },
      _count: { _all: true },
    }),
    prisma.lead.groupBy({
      by: ['status'],
      where: { AND: [scope, { createdAt: { gte: prev30, lt: last30 } }] },
      _count: { _all: true },
    }),
  ])

  const currentMap = countByStatus(statusCounts)
  const lastMap = countByStatus(statusLast30)
  const prevMap = countByStatus(statusPrev30)

  return {
    items: rows.map(listItem),
    total,
    page,
    limit,
    summary: {
      total: allCount,
      change: percentChange(last30Count, prev30Count),
      statuses: PIPELINE_STATUSES.map((label) => ({
        key: label.toLowerCase().replace(/\s+/g, '-'),
        label,
        count: currentMap.get(label.toLowerCase()) || 0,
        change: percentChange(lastMap.get(label.toLowerCase()) || 0, prevMap.get(label.toLowerCase()) || 0),
      })),
    },
  }
}

export async function getLead(auth: AuthContext, id: string) {
  await assertCanViewLead(auth, id)
  await prisma.followUp.updateMany({
    where: {
      leadId: id,
      status: { in: ['Pending', 'Due Soon'] },
      dueAt: { lt: new Date() },
    },
    data: { status: 'Overdue' },
  })
  const [lead, nextFollowUp, statusItems] = await Promise.all([
    prisma.lead.findUniqueOrThrow({ where: { id }, include: leadInclude }),
    prisma.followUp.findFirst({
      where: {
        leadId: id,
        status: { notIn: [...FOLLOW_UP_CLOSED_STATUSES] },
      },
      orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
    }),
    loadLeadStatusItems(),
  ])
  return {
    lead: {
      ...serializeLead(lead),
      statusChange: describeStatusChange({
        lead,
        items: statusItems,
        canUpdate: hasPermission(auth.permissions, 'lead:update_status'),
        canOverride: hasPermission(auth.permissions, 'lead:override_status'),
      }),
      nextFollowUp: nextFollowUp
        ? {
            id: nextFollowUp.id,
            type: nextFollowUp.type,
            dueAt: nextFollowUp.dueAt ? nextFollowUp.dueAt.toISOString() : null,
            status: nextFollowUp.status,
            notes: nextFollowUp.notes,
            priority: nextFollowUp.priority,
            purpose: nextFollowUp.purpose,
            nextAction: nextFollowUp.nextAction,
            reminder: nextFollowUp.reminder,
            outcome: nextFollowUp.outcome,
          }
        : null,
    },
  }
}

export async function createLead(auth: AuthContext, body: Record<string, unknown>, meta: AuditMeta) {
  const parsed = await parseLeadInput(body, 'create')
  const duplicate = await findDuplicate(parsed.phoneNormalized)
  if (duplicate) {
    const createAnyway = body.createAnyway === true || body.createAnyway === 'true'
    if (!createAnyway || !hasPermission(auth.permissions, 'lead:create_duplicate')) {
      throw httpError.duplicateLead(duplicate)
    }
  }

  const assignment = await resolveCountryAssignment(parsed.preferredCountryCode)
  const newStatus = await prisma.masterDataItem.findUnique({
    where: { categoryKey_code: { categoryKey: 'LEAD_STATUS', code: 'NEW' } },
  })
  const metrics = await metricsFor(parsed)
  const code = await nextLeadCode()

  const lead = await prisma.$transaction(async (tx) => {
    const created = await tx.lead.create({
      data: {
        ...parsed,
        code,
        status: newStatus?.name || 'New',
        statusCode: newStatus?.code || 'NEW',
        ownerId: assignment.ownerId,
        ownerName: assignment.ownerName,
        assignedCountryTeamId: assignment.teamId,
        createdById: auth.user.id,
        updatedById: auth.user.id,
        sourceLocked: false,
        ...metrics,
      },
      include: leadInclude,
    })
    await tx.leadAssignment.create({
      data: {
        leadId: created.id,
        toOwnerId: assignment.ownerId,
        teamId: assignment.teamId,
        reason: assignment.ownerId ? 'Country-based assignment on create' : 'Entered lead pool',
        createdById: auth.user.id,
      },
    })
    await tx.activity.create({
      data: {
        type: 'NOTE',
        userId: auth.user.id,
        notes: `Lead created (${created.code})`,
        relatedName: created.name,
        relatedType: 'lead',
        relatedId: created.id,
        outcome: 'Created',
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    })
    await tx.leadStatusHistory.create({
      data: {
        leadId: created.id,
        previousStatus: null,
        previousStatusCode: null,
        newStatus: created.status,
        newStatusCode: created.statusCode || 'NEW',
        createdById: auth.user.id,
      },
    })
    return created
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'LEAD_CREATED',
    entityType: 'lead',
    entityId: lead.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { code: lead.code, country: lead.preferredCountryCode, source: lead.sourceCode, ownerId: lead.ownerId },
  })

  return { lead: serializeLead(lead), message: `Lead Created Successfully — Lead ID: ${lead.code}` }
}

function pickAllowed(body: Record<string, unknown>, auth: AuthContext, sourceLocked: boolean) {
  const allowed = allowedFieldsFor(auth)
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (!allowed.has(key)) continue
    if (sourceLocked && ['sourceCode', 'campaign', 'utmSource', 'utmMedium', 'utmCampaign'].includes(key)) continue
    next[key] = value
  }
  return next
}

export async function updateLead(auth: AuthContext, id: string, body: Record<string, unknown>, meta: AuditMeta) {
  const current = await assertCanViewLead(auth, id)
  const filtered = pickAllowed(body, auth, current.sourceLocked)
  const mergedBody = { ...serializeLead(await prisma.lead.findUniqueOrThrow({ where: { id }, include: leadInclude })), ...filtered }
  const parsed = await parseLeadInput(mergedBody, 'update')

  if (parsed.phoneNormalized && parsed.phoneNormalized !== current.phoneNormalized) {
    const duplicate = await findDuplicate(parsed.phoneNormalized, id)
    if (duplicate) throw httpError.duplicateLead(duplicate)
  }

  let ownerId = current.ownerId
  let ownerName = current.ownerName
  let assignedCountryTeamId = current.assignedCountryTeamId
  const countryChanged = parsed.preferredCountryCode && parsed.preferredCountryCode !== current.preferredCountryCode
  if (countryChanged) {
    const assignment = await resolveCountryAssignment(parsed.preferredCountryCode)
    ownerId = assignment.ownerId
    ownerName = assignment.ownerName
    assignedCountryTeamId = assignment.teamId
  }

  const metrics = await metricsFor(parsed, current)
  const lead = await prisma.$transaction(async (tx) => {
    const updated = await tx.lead.update({
      where: { id },
      data: {
        ...parsed,
        ownerId,
        ownerName,
        assignedCountryTeamId,
        updatedById: auth.user.id,
        ...metrics,
        priority: current.priorityManual ? current.priority : metrics.priority,
        priorityCode: current.priorityManual ? current.priorityCode : metrics.priorityCode,
      },
      include: leadInclude,
    })
    if (countryChanged) {
      await tx.leadAssignment.create({
        data: {
          leadId: id,
          fromOwnerId: current.ownerId,
          toOwnerId: ownerId,
          teamId: assignedCountryTeamId,
          reason: ownerId ? 'Preferred country changed' : 'Entered lead pool after country change',
          createdById: auth.user.id,
        },
      })
      await tx.activity.create({
        data: {
          type: 'NOTE',
          userId: auth.user.id,
          notes: ownerId ? 'Lead reassigned after country change' : 'Lead moved to Lead Pool after country change',
          relatedName: updated.name,
          relatedType: 'lead',
          relatedId: updated.id,
          outcome: 'Assigned',
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
      })
    }
    return updated
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'LEAD_UPDATED',
    entityType: 'lead',
    entityId: lead.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { code: lead.code },
  })

  return { lead: serializeLead(lead) }
}

export async function updateQualification(auth: AuthContext, id: string, body: Record<string, unknown>, meta: AuditMeta) {
  if (!hasPermission(auth.permissions, 'lead:qualify')) {
    throw httpError.accessDenied()
  }
  const current = await assertCanViewLead(auth, id)
  const fields: Record<string, string> = {}
  const academicFit = await resolveMasterCode('QUALIFICATION_FIT', body.academicFitCode, 'academicFitCode', fields)
  const englishReady = await resolveMasterCode('FINANCIAL_READINESS', body.englishReadinessCode, 'englishReadinessCode', fields)
  const countryFit = await resolveMasterCode('QUALIFICATION_FIT', body.countryIntakeFitCode, 'countryIntakeFitCode', fields)
  const intentQual = await resolveMasterCode('STUDY_INTENT', body.studyIntentQualCode, 'studyIntentQualCode', fields)
  const financial = await resolveMasterCode('FINANCIAL_READINESS', body.financialReadinessCode, 'financialReadinessCode', fields)
  const timeline = await resolveMasterCode('DECISION_TIMELINE', body.decisionTimelineCode, 'decisionTimelineCode', fields)
  const appReady = await resolveMasterCode('APPLICATION_READINESS', body.applicationReadinessCode, 'applicationReadinessCode', fields)
  const result = await resolveMasterCode('QUALIFICATION_RESULT', body.qualificationResultCode, 'qualificationResultCode', fields)
  let unqualifiedReason = null
  if (result?.code === 'UNQUALIFIED') {
    unqualifiedReason = await resolveMasterCode('UNQUALIFIED_REASON', body.unqualifiedReasonCode, 'unqualifiedReasonCode', fields, {
      required: true,
      message: 'Please provide a reason.',
    })
    if (unqualifiedReason?.code === 'OTHER' && !asString(body.unqualifiedRemarks)) {
      fields.unqualifiedRemarks = 'Please provide a reason.'
    }
  }
  throwIfInvalid(fields)

  const next = {
    academicFitCode: academicFit?.code || null,
    englishReadinessCode: englishReady?.code || null,
    countryIntakeFitCode: countryFit?.code || null,
    studyIntentQualCode: intentQual?.code || null,
    financialReadinessCode: financial?.code || current.financialReadinessCode,
    decisionTimelineCode: timeline?.code || current.decisionTimelineCode,
    applicationReadinessCode: appReady?.code || current.applicationReadinessCode,
    qualificationResultCode: result?.code || null,
    unqualifiedReasonCode: result?.code === 'UNQUALIFIED' ? unqualifiedReason?.code || null : null,
    unqualifiedRemarks: result?.code === 'UNQUALIFIED' ? asOptionalString(body.unqualifiedRemarks, 1000) : null,
  }
  const scored = computeLeadScore({ ...current, ...next })
  const completion = profileCompletion({ ...current, ...next })

  const lead = await prisma.$transaction(async (tx) => {
    const updated = await tx.lead.update({
      where: { id },
      data: {
        ...next,
        profileCompletion: completion.percent,
        leadScore: current.priorityManual ? current.leadScore : scored.score,
        priority: current.priorityManual ? current.priority : scored.priority,
        priorityCode: current.priorityManual ? current.priorityCode : scored.priorityCode,
        updatedById: auth.user.id,
      },
      include: leadInclude,
    })
    await tx.leadQualificationHistory.create({
      data: {
        leadId: id,
        result: next.qualificationResultCode,
        reason: next.unqualifiedReasonCode,
        snapshot: next,
        createdById: auth.user.id,
      },
    })
    return updated
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'LEAD_QUALIFIED',
    entityType: 'lead',
    entityId: lead.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { result: next.qualificationResultCode, reason: next.unqualifiedReasonCode },
  })

  return { lead: serializeLead(lead) }
}

export async function updatePriority(auth: AuthContext, id: string, body: Record<string, unknown>, meta: AuditMeta) {
  if (!hasPermission(auth.permissions, 'lead:override_priority')) {
    throw httpError.accessDenied()
  }
  await assertCanViewLead(auth, id)
  const fields: Record<string, string> = {}
  const item = await resolveMasterCode('LEAD_PRIORITY', body.priorityCode, 'priorityCode', fields, {
    required: true,
    message: 'Please select a valid priority.',
  })
  const reason = asString(body.priorityOverrideReason)
  if (!reason) fields.priorityOverrideReason = 'Please provide a reason.'
  throwIfInvalid(fields)

  const lead = await prisma.lead.update({
    where: { id },
    data: {
      priority: item!.name,
      priorityCode: item!.code,
      priorityManual: true,
      priorityOverrideReason: reason.slice(0, 400),
      updatedById: auth.user.id,
    },
    include: leadInclude,
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'LEAD_PRIORITY_OVERRIDE',
    entityType: 'lead',
    entityId: lead.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { priority: item!.code, reason },
  })

  return { lead: serializeLead(lead) }
}

export async function createLeadFollowUp(auth: AuthContext, id: string, body: Record<string, unknown>, meta: AuditMeta) {
  const { createFollowUp } = await import('../follow-ups/follow-ups.service')
  return createFollowUp(auth, { ...body, leadId: id }, meta)
}

export async function updateLeadStatus(auth: AuthContext, id: string, body: Record<string, unknown>, meta: AuditMeta) {
  if (!hasPermission(auth.permissions, 'lead:update_status')) {
    throw httpError.accessDenied(STATUS_MESSAGES.permission)
  }

  const currentLead = await assertCanViewLead(auth, id)
  const items = await loadLeadStatusItems()
  const current = resolveLeadStatus(currentLead, items)
  const fields: Record<string, string> = {}
  const statusCode = asString(body.statusCode)
  if (!statusCode) fields.statusCode = STATUS_MESSAGES.missing
  if (!current) fields.statusCode = fields.statusCode || STATUS_MESSAGES.missing
  throwIfInvalid(fields)

  const next = items.find((item) => item.code === statusCode && item.status === 'ACTIVE')
  if (!next?.code) {
    throw httpError.validation({ statusCode: STATUS_MESSAGES.missing })
  }
  if (next.code === current!.code) {
    throw httpError.validation({ statusCode: STATUS_MESSAGES.same }, STATUS_MESSAGES.same)
  }

  const canOverride = hasPermission(auth.permissions, 'lead:override_status')
  const overrideRequested = body.override === true || body.override === 'true'
  const overrideReason = asString(body.overrideReason)
  const allowed = describeStatusChange({
    lead: currentLead,
    items,
    canUpdate: true,
    canOverride,
  })
  const option = allowed.options.find((item) => item.code === next.code)
  if (!allowed.canUpdate) {
    throw httpError.validation({ statusCode: allowed.lockedReason || STATUS_MESSAGES.jump }, allowed.lockedReason || STATUS_MESSAGES.jump)
  }
  if (!option) {
    const gated = next.behaviorKey === 'converted'
      ? STATUS_MESSAGES.converted
      : next.behaviorKey === 'file_opening_pending'
        ? STATUS_MESSAGES.fileOpening
        : next.behaviorKey === 'file_opened'
          ? STATUS_MESSAGES.fileOpened
          : STATUS_MESSAGES.jump
    throw httpError.validation({ statusCode: gated }, gated)
  }
  if (option.requiresOverride && !overrideRequested) {
    throw httpError.validation({ statusCode: STATUS_MESSAGES.jump }, STATUS_MESSAGES.jump)
  }
  if (option.requiresOverride && !overrideReason) {
    throw httpError.validation({ overrideReason: STATUS_MESSAGES.override })
  }

  const remarks = asString(body.remarks)
  if (remarks.length > 1000) {
    fields.remarks = 'Remarks cannot exceed 1000 characters.'
  }
  if (remarksRequiredFor(next.behaviorKey) && !remarks) {
    fields.remarks = STATUS_MESSAGES.remarks
  }

  let lostReasonCode: string | null = null
  if (lostReasonRequiredFor(next.behaviorKey)) {
    const reason = await resolveMasterCode('LEAD_LOST_REASON', body.lostReasonCode, 'lostReasonCode', fields, {
      required: true,
      message: 'Please select a lost reason.',
    })
    lostReasonCode = reason?.code || null
  }

  if (next.code === 'QUALIFIED' && missingQualifiedData(currentLead)) {
    fields.statusCode = STATUS_MESSAGES.qualifiedData
  }
  throwIfInvalid(fields)

  try {
    const lead = await prisma.$transaction(async (tx) => {
      const updated = await tx.lead.update({
        where: { id },
        data: {
          status: next.name,
          statusCode: next.code,
          lostReasonCode,
          updatedById: auth.user.id,
        },
        include: leadInclude,
      })
      await tx.leadStatusHistory.create({
        data: {
          leadId: id,
          previousStatus: current!.name,
          previousStatusCode: current!.code,
          newStatus: next.name,
          newStatusCode: next.code!,
          remarks: remarks || null,
          lostReasonCode,
          isOverride: Boolean(option.requiresOverride),
          overrideReason: option.requiresOverride ? overrideReason : null,
          createdById: auth.user.id,
        },
      })
      await tx.activity.create({
        data: {
          type: 'NOTE',
          userId: auth.user.id,
          notes: `Status changed from ${current!.name} to ${next.name}${remarks ? `. ${remarks}` : ''}`,
          relatedName: updated.name,
          relatedType: 'lead',
          relatedId: updated.id,
          outcome: next.name,
          metadata: {
            previousStatus: current!.name,
            previousStatusCode: current!.code,
            newStatus: next.name,
            newStatusCode: next.code,
            remarks: remarks || null,
            lostReasonCode,
            isOverride: option.requiresOverride,
          },
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
      })
      return updated
    })

    await writeAuditLog({
      userId: auth.user.id,
      action: 'LEAD_STATUS_CHANGED',
      entityType: 'lead',
      entityId: lead.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: {
        from: current!.name,
        to: next.name,
        previousStatusCode: current!.code,
        newStatusCode: next.code,
        remarks: remarks || null,
        lostReasonCode,
        override: option.requiresOverride,
        overrideReason: option.requiresOverride ? overrideReason : null,
        relatedName: lead.name,
        name: lead.name,
      },
    })

    return getLead(auth, id)
  } catch (error) {
    if (error instanceof HttpError) throw error
    console.error(error)
    throw httpError.statusUpdateFailed()
  }
}

export async function listLeadStatusHistory(auth: AuthContext, id: string) {
  await assertCanViewLead(auth, id)
  const rows = await prisma.leadStatusHistory.findMany({
    where: { leadId: id },
    include: { createdBy: { select: { id: true, fullName: true } } },
    orderBy: { createdAt: 'desc' },
  })
  const reasonCodes = [...new Set(rows.map((row) => row.lostReasonCode).filter((code): code is string => Boolean(code)))]
  const reasons = reasonCodes.length
    ? await prisma.masterDataItem.findMany({
        where: { categoryKey: 'LEAD_LOST_REASON', code: { in: reasonCodes } },
        select: { code: true, name: true },
      })
    : []
  const reasonMap = new Map(reasons.map((item) => [item.code, item.name]))

  return {
    items: rows.map((row) => ({
      id: row.id,
      previousStatus: row.previousStatus,
      previousStatusCode: row.previousStatusCode,
      newStatus: row.newStatus,
      newStatusCode: row.newStatusCode,
      remarks: row.remarks,
      lostReasonCode: row.lostReasonCode,
      lostReason: row.lostReasonCode ? reasonMap.get(row.lostReasonCode) || row.lostReasonCode : null,
      isOverride: row.isOverride,
      overrideReason: row.overrideReason,
      updatedBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.fullName } : null,
      createdAt: row.createdAt.toISOString(),
    })),
  }
}

const ASSIGNEE_ROLE_KEYS = ['call_executive', 'counsellor'] as const
const ACTIVITY_TYPE_LABEL: Record<string, string> = {
  CALL: 'Call logged',
  MESSAGE: 'Message sent',
  MEETING: 'Meeting logged',
  EMAIL: 'Email sent',
  NOTE: 'Note added',
  FOLLOW_UP: 'Follow-up scheduled',
}

function parseIsoDate(value?: string, endOfDay = false) {
  const text = value?.trim()
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined
  return new Date(`${text}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`)
}

function openFollowUpWhere(): Prisma.FollowUpWhereInput {
  return { status: { notIn: [...FOLLOW_UP_CLOSED_STATUSES] } }
}

function followUpStatusLeadWhere(
  status: string | undefined,
  startToday: Date,
  startTomorrow: Date,
): Prisma.LeadWhereInput {
  const key = status?.trim().toLowerCase()
  const open = openFollowUpWhere()
  if (key === 'pending') return { followUps: { some: open } }
  if (key === 'today') {
    return { followUps: { some: { AND: [open, { dueAt: { gte: startToday, lt: startTomorrow } }] } } }
  }
  if (key === 'overdue') {
    return { followUps: { some: { AND: [open, { dueAt: { lt: startToday } }] } } }
  }
  return {}
}

function lastActivityLabel(activity: { type: string; notes: string | null; outcome: string | null }) {
  const notes = activity.notes?.trim()
  if (notes) return notes.length > 48 ? `${notes.slice(0, 45)}…` : notes
  if (activity.outcome?.trim()) return activity.outcome.trim()
  return ACTIVITY_TYPE_LABEL[activity.type] || 'Activity'
}

export async function listMyLeads(
  auth: AuthContext,
  query: {
    search?: string
    page?: number
    limit?: number
    status?: string
    source?: string
    priority?: string
    country?: string
    followUpStatus?: string
    sort?: string
    order?: string
  },
) {
  if (!hasPermission(auth.permissions, 'lead:view')) {
    throw httpError.accessDenied('You do not have permission to access this page.')
  }

  const search = query.search?.trim()
  const page = Math.max(1, query.page || 1)
  const limit = Math.min(50, Math.max(10, query.limit || 10))
  const status = query.status?.trim()
  const source = query.source?.trim()
  const priority = query.priority?.trim()
  const country = query.country?.trim()
  const followUpStatus = query.followUpStatus?.trim()
  const sort = query.sort?.trim().toLowerCase() === 'priority' ? 'priority' : 'assigned'
  const order = query.order?.trim().toLowerCase() === 'asc' ? 'asc' : 'desc'

  await prisma.followUp.updateMany({
    where: {
      status: { in: ['Pending', 'Due Soon'] },
      dueAt: { lt: new Date() },
      lead: myLeadsOwnerWhere(auth),
    },
    data: { status: 'Overdue' },
  })
  const ownerWhere = myLeadsOwnerWhere(auth)
  const now = new Date()
  const startToday = startOfUtcDay(now)
  const startTomorrow = addUtcDays(startToday, 1)
  const searchDigits = search ? search.replace(/\D/g, '') : ''

  const listWhere: Prisma.LeadWhereInput = {
    AND: [
      ownerWhere,
      status ? { status: { equals: status, mode: 'insensitive' } } : {},
      source ? { source: { contains: source, mode: 'insensitive' } } : {},
      priority ? { priority: { equals: priority, mode: 'insensitive' } } : {},
      country ? { country: { contains: country, mode: 'insensitive' } } : {},
      followUpStatusLeadWhere(followUpStatus, startToday, startTomorrow),
      search
        ? {
            OR: [
              { code: { contains: search, mode: 'insensitive' } },
              { name: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search, mode: 'insensitive' } },
              ...(searchDigits.length >= 3 ? [{ phoneNormalized: { contains: searchDigits } }] : []),
            ],
          }
        : {},
    ],
  }

  try {
    const matching = await prisma.lead.findMany({
      where: listWhere,
      select: { id: true, createdAt: true, priority: true },
    })

    const assignmentDates =
      matching.length === 0
        ? []
        : await prisma.leadAssignment.groupBy({
            by: ['leadId'],
            where: { leadId: { in: matching.map((lead) => lead.id) }, toOwnerId: auth.user.id },
            _max: { createdAt: true },
          })
    const assignedAt = new Map(
      assignmentDates.map((row) => [row.leadId, row._max.createdAt?.getTime() || 0]),
    )

    const direction = order === 'asc' ? 1 : -1
    matching.sort((a, b) => {
      if (sort === 'priority') {
        const diff = (priorityRank(a.priority) - priorityRank(b.priority)) * direction
        if (diff !== 0) return diff
      }
      const aTime = assignedAt.get(a.id) || a.createdAt.getTime()
      const bTime = assignedAt.get(b.id) || b.createdAt.getTime()
      return (aTime - bTime) * (sort === 'priority' ? -1 : direction)
    })

    const total = matching.length
    const pageIds = matching.slice((page - 1) * limit, page * limit).map((lead) => lead.id)
    const [rows, nextFollowUps, lastActivities, summary] = await Promise.all([
      pageIds.length
        ? prisma.lead.findMany({
            where: { id: { in: pageIds } },
            include: leadInclude,
          })
        : Promise.resolve([]),
      pageIds.length
        ? prisma.followUp.findMany({
            where: { leadId: { in: pageIds }, AND: [openFollowUpWhere()] },
            orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
          })
        : Promise.resolve([]),
      pageIds.length
        ? prisma.activity.findMany({
            where: { relatedType: 'lead', relatedId: { in: pageIds } },
            orderBy: { occurredAt: 'desc' },
          })
        : Promise.resolve([]),
      Promise.all([
        prisma.lead.count({ where: ownerWhere }),
        prisma.lead.count({
          where: { AND: [ownerWhere, { priority: { equals: 'High', mode: 'insensitive' } }] },
        }),
        prisma.followUp.count({ where: { AND: [openFollowUpWhere(), { lead: ownerWhere }] } }),
        prisma.followUp.count({
          where: {
            AND: [openFollowUpWhere(), { dueAt: { gte: startToday, lt: startTomorrow } }, { lead: ownerWhere }],
          },
        }),
        prisma.followUp.count({
          where: { AND: [openFollowUpWhere(), { dueAt: { lt: startToday } }, { lead: ownerWhere }] },
        }),
      ]).then(([totalAssigned, highPriority, pendingFollowUps, todayFollowUps, overdueFollowUps]) => ({
        totalAssigned,
        highPriority,
        pendingFollowUps,
        todayFollowUps,
        overdueFollowUps,
      })),
    ])

    const byId = new Map(rows.map((lead) => [lead.id, lead]))
    const nextByLead = new Map<string, (typeof nextFollowUps)[number]>()
    for (const followUp of nextFollowUps) {
      if (followUp.leadId && !nextByLead.has(followUp.leadId)) nextByLead.set(followUp.leadId, followUp)
    }
    const activityByLead = new Map<string, (typeof lastActivities)[number]>()
    for (const activity of lastActivities) {
      if (activity.relatedId && !activityByLead.has(activity.relatedId)) {
        activityByLead.set(activity.relatedId, activity)
      }
    }

    return {
      items: pageIds.flatMap((id) => {
        const lead = byId.get(id)
        if (!lead) return []
        const next = nextByLead.get(id)
        const activity = activityByLead.get(id)
        const assignedMs = assignedAt.get(id)
        return [
          {
            id: lead.id,
            code: lead.code,
            name: lead.name,
            phone: lead.phone || '—',
            country: lead.country || '—',
            status: lead.status,
            score: lead.leadScore ?? 0,
            priority: lead.priority || '—',
            nextFollowUpAt: next?.dueAt ? next.dueAt.toISOString() : null,
            lastActivity: activity ? lastActivityLabel(activity) : '—',
            lastActivityAt: activity ? activity.occurredAt.toISOString() : null,
            assignedAt: assignedMs ? new Date(assignedMs).toISOString() : lead.createdAt.toISOString(),
          },
        ]
      }),
      total,
      page,
      limit,
      summary,
    }
  } catch (error) {
    if (error instanceof HttpError) throw error
    console.error(error)
    throw search ? httpError.myLeadsSearchFailed() : httpError.myLeadsLoadFailed()
  }
}

export async function listLeadPool(
  auth: AuthContext,
  query: {
    search?: string
    page?: number
    limit?: number
    source?: string
    country?: string
    createdFrom?: string
    createdTo?: string
  },
) {
  if (!hasPermission(auth.permissions, 'lead:assign')) {
    throw httpError.accessDenied('You do not have permission to access the Lead Pool.')
  }

  try {
    const search = query.search?.trim()
    const page = Math.max(1, query.page || 1)
    const limit = Math.min(50, Math.max(10, query.limit || 10))
    const source = query.source?.trim()
    const country = query.country?.trim()
    const createdFrom = parseIsoDate(query.createdFrom)
    const createdTo = parseIsoDate(query.createdTo, true)

    const listWhere: Prisma.LeadWhereInput = {
      AND: [
        leadPoolScopeWhere(auth),
        source ? { source: { contains: source, mode: 'insensitive' } } : {},
        country ? { country: { contains: country, mode: 'insensitive' } } : {},
        createdFrom || createdTo
          ? {
              createdAt: {
                ...(createdFrom ? { gte: createdFrom } : {}),
                ...(createdTo ? { lte: createdTo } : {}),
              },
            }
          : {},
        search
          ? {
              OR: [
                { code: { contains: search, mode: 'insensitive' } },
                { name: { contains: search, mode: 'insensitive' } },
                { phone: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {},
      ],
    }

    const [total, rows] = await Promise.all([
      prisma.lead.count({ where: listWhere }),
      prisma.lead.findMany({
        where: listWhere,
        include: leadInclude,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ])

    return {
      items: rows.map((lead) => ({
        id: lead.id,
        code: lead.code,
        name: lead.name,
        phone: lead.phone || '—',
        country: lead.country || '—',
        source: lead.source || '—',
        assignedTeam: lead.assignedCountryTeam
          ? { id: lead.assignedCountryTeam.id, name: lead.assignedCountryTeam.name }
          : null,
        createdAt: lead.createdAt.toISOString(),
        waitingTime: formatWaitingTime(lead.createdAt),
      })),
      total,
      page,
      limit,
    }
  } catch (error) {
    if (error instanceof HttpError) throw error
    console.error(error)
    throw httpError.leadPoolLoadFailed()
  }
}

export async function listLeadAssignees(auth: AuthContext, query: { teamId?: string; search?: string }) {
  if (!hasPermission(auth.permissions, ['lead:assign', 'lead:reassign'])) {
    throw httpError.accessDenied()
  }

  const search = query.search?.trim()
  const teamId = query.teamId?.trim()
  const users = await prisma.user.findMany({
    where: {
      status: 'ACTIVE',
      AND: [
        assigneeVisibilityWhere(auth),
        { primaryRole: { key: { in: [...ASSIGNEE_ROLE_KEYS] } } },
        teamId ? { teamId } : {},
        search
          ? {
              OR: [
                { fullName: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {},
      ],
    },
    include: {
      primaryRole: { select: { key: true, name: true } },
      team: { select: { id: true, name: true } },
    },
    orderBy: { fullName: 'asc' },
  })

  return {
    items: users.map((user) => ({
      id: user.id,
      name: user.fullName,
      role: user.primaryRole ? { key: user.primaryRole.key, name: user.primaryRole.name } : null,
      team: user.team ? { id: user.team.id, name: user.team.name } : null,
    })),
  }
}

export async function assignLead(auth: AuthContext, id: string, body: Record<string, unknown>, meta: AuditMeta) {
  const { lead: current, canAssign, canReassign } = await assertCanManageLeadAssignment(auth, id)
  const isUnassigned = !current.ownerId
  if (isUnassigned && !canAssign) {
    throw httpError.accessDenied()
  }
  if (!isUnassigned && !canReassign) {
    throw httpError.accessDenied()
  }

  const ownerId = asString(body.ownerId)
  const fields: Record<string, string> = {}
  if (!ownerId) fields.ownerId = 'Please select a user to assign this lead.'
  throwIfInvalid(fields)
  if (ownerId === current.ownerId) {
    throw httpError.validation({ ownerId: 'This lead is already assigned to the selected user.' })
  }

  const assignee = await prisma.user.findFirst({
    where: {
      id: ownerId,
      status: 'ACTIVE',
      AND: [assigneeVisibilityWhere(auth)],
    },
    include: { team: { select: { id: true, name: true } } },
  })
  if (!assignee) {
    throw httpError.badRequest('The selected user cannot receive this lead.')
  }

  const reason =
    asOptionalString(body.reason, 400) ||
    (isUnassigned ? 'Assigned from Lead Pool' : 'Lead reassigned')
  const fromOwnerId = current.ownerId
  const fromOwnerName = current.ownerName
  const teamId = assignee.teamId || current.assignedCountryTeamId

  try {
    const lead = await prisma.$transaction(async (tx) => {
      const updated = await tx.lead.update({
        where: { id },
        data: {
          ownerId: assignee.id,
          ownerName: assignee.fullName,
          assignedCountryTeamId: teamId,
          updatedById: auth.user.id,
        },
        include: leadInclude,
      })
      await tx.leadAssignment.create({
        data: {
          leadId: id,
          fromOwnerId,
          toOwnerId: assignee.id,
          teamId,
          reason,
          createdById: auth.user.id,
        },
      })
      await tx.activity.create({
        data: {
          type: 'NOTE',
          userId: auth.user.id,
          notes: isUnassigned
            ? `Lead assigned to ${assignee.fullName}`
            : `Lead reassigned from ${fromOwnerName || 'Unassigned'} to ${assignee.fullName}`,
          relatedName: updated.name,
          relatedType: 'lead',
          relatedId: updated.id,
          outcome: 'Assigned',
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
      })
      return updated
    })

    await writeAuditLog({
      userId: auth.user.id,
      action: 'LEAD_ASSIGNED',
      entityType: 'lead',
      entityId: lead.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: {
        code: lead.code,
        fromOwnerId,
        toOwnerId: assignee.id,
        toOwnerName: assignee.fullName,
        reason,
        relatedName: lead.name,
        name: lead.name,
      },
    })

    return { lead: serializeLead(lead), message: isUnassigned ? 'Lead assigned successfully.' : 'Lead reassigned successfully.' }
  } catch (error) {
    if (error instanceof HttpError) throw error
    console.error(error)
    throw httpError.assignmentFailed()
  }
}

export async function listLeadAssignments(auth: AuthContext, id: string) {
  await assertCanViewLead(auth, id)
  const rows = await prisma.leadAssignment.findMany({
    where: { leadId: id },
    include: {
      fromOwner: { select: { id: true, fullName: true } },
      toOwner: { select: { id: true, fullName: true } },
      createdBy: { select: { id: true, fullName: true } },
    },
    orderBy: { createdAt: 'desc' },
  })

  return {
    items: rows.map((row) => ({
      id: row.id,
      fromOwner: row.fromOwner ? { id: row.fromOwner.id, name: row.fromOwner.fullName } : null,
      toOwner: row.toOwner ? { id: row.toOwner.id, name: row.toOwner.fullName } : null,
      reason: row.reason,
      assignedBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.fullName } : null,
      createdAt: row.createdAt.toISOString(),
    })),
  }
}
