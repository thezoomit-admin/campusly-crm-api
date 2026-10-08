import type { Prisma } from '../../lib/prisma-client'
import { httpError } from '../../lib/http-error'
import { prisma } from '../../lib/prisma'
import { canReceiveLeadAssignment, hasPermission } from '../auth/access'
import type { AuthContext } from '../auth/session.service'

export const BASIC_FIELDS = new Set([
  'name',
  'phone',
  'phoneCountryCode',
  'whatsapp',
  'whatsappCountryCode',
  'whatsappSameAsPhone',
  'email',
  'dateOfBirth',
  'currentLocation',
  'preferredCountryCode',
  'preferredDegreeCode',
  'preferredCourse',
  'preferredIntakeCode',
  'studyPurposeCode',
  'studyPurposeOther',
  'highestQualificationCode',
  'institutionName',
  'passingYear',
  'resultCgpa',
  'studyGapYears',
  'decisionTimelineCode',
  'preferredContactMethodCode',
  'preferredContactTimeCode',
  'specificContactTime',
  'remarks',
  'notes',
])

export const QUALIFICATION_FIELDS = new Set([
  'englishTestCode',
  'testStatusCode',
  'overallScore',
  'testDate',
  'listening',
  'reading',
  'writing',
  'speaking',
  'estimatedBudgetCode',
  'fundingSourceCode',
  'financialReadinessCode',
  'previouslyAppliedAbroad',
  'previousVisaApplication',
  'previousVisaRefusal',
  'prevVisaCountry',
  'prevVisaType',
  'prevVisaYear',
  'prevVisaResult',
  'refusalCountry',
  'refusalYear',
  'refusalReason',
  'decisionMakerCode',
  'applicationReadinessCode',
  'studyIntentCode',
  'academicFitCode',
  'englishReadinessCode',
  'countryIntakeFitCode',
  'studyIntentQualCode',
  'qualificationResultCode',
  'unqualifiedReasonCode',
  'unqualifiedRemarks',
])

export const SOURCE_FIELDS = new Set(['sourceCode', 'campaign', 'utmSource', 'utmMedium', 'utmCampaign'])

export function asString(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

export function asOptionalString(value: unknown, max = 200) {
  const text = asString(value)
  return text ? text.slice(0, max) : null
}

export function parseBoolean(value: unknown) {
  if (value === true || value === 'true' || value === '1' || value === 'on') return true
  if (value === false || value === 'false' || value === '0' || value === 'off') return false
  return null
}

export function throwIfInvalid(fields: Record<string, string>) {
  if (Object.keys(fields).length > 0) {
    throw httpError.validation(fields)
  }
}

export function titleCaseName(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ')
}

export function normalizePhone(value: string, countryDialCode?: string | null) {
  let digits = value.replace(/\D/g, '')
  if (digits.startsWith('00')) digits = digits.slice(2)

  const dial = (countryDialCode || '').replace(/\D/g, '')
  if (dial) {
    if (digits.startsWith(dial)) return digits
    // Local numbers often keep a leading 0 (e.g. 017…).
    if (digits.startsWith('0')) digits = digits.slice(1)
    return `${dial}${digits}`
  }

  // Legacy Bangladesh heuristics when no country dial code is provided.
  if (digits.length === 11 && digits.startsWith('01')) digits = `880${digits}`
  if (digits.length === 10 && digits.startsWith('1')) digits = `880${digits}`
  return digits
}

export function isValidMobile(value: string) {
  const digits = value.replace(/\D/g, '')
  return digits.length >= 10 && digits.length <= 15
}

export function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

export function parseDateOnly(value: unknown, field: string, fields: Record<string, string>) {
  const text = asString(value)
  if (!text) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    fields[field] = 'Please enter a valid date.'
    return null
  }
  const date = new Date(`${text}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) {
    fields[field] = 'Please enter a valid date.'
    return null
  }
  return date
}

export function parseYear(value: unknown, field: string, fields: Record<string, string>) {
  const text = asString(value)
  if (!text) return null
  const year = Number(text)
  const current = new Date().getUTCFullYear()
  if (!Number.isInteger(year) || year < 1950 || year > current + 1) {
    fields[field] = 'Please select a valid year.'
    return null
  }
  return year
}

export function parseScore(value: unknown, field: string, fields: Record<string, string>) {
  const text = asString(value)
  if (text === '' && (value === undefined || value === null)) return null
  if (value === '' || value === null || value === undefined) return null
  const score = typeof value === 'number' ? value : Number(text)
  if (Number.isNaN(score) || score < 0 || score > 200) {
    fields[field] = 'Please enter a valid test score.'
    return null
  }
  return score
}

export function parseNonNegInt(value: unknown, field: string, fields: Record<string, string>) {
  const text = asString(value)
  if (!text && (value === undefined || value === null || value === '')) return null
  const num = Number(text || value)
  if (!Number.isInteger(num) || num < 0 || num > 40) {
    fields[field] = 'Please enter a valid value.'
    return null
  }
  return num
}

export async function resolveMasterCode(
  categoryKey: string,
  value: unknown,
  field: string,
  fields: Record<string, string>,
  options?: { required?: boolean; message?: string },
) {
  const code = asString(value)
  if (!code) {
    if (options?.required) {
      fields[field] = options.message || 'This field is required.'
    }
    return null
  }
  const item = await prisma.masterDataItem.findUnique({
    where: { categoryKey_code: { categoryKey, code } },
  })
  if (!item || item.status !== 'ACTIVE') {
    fields[field] = options?.message || 'Please select a valid option.'
    return null
  }
  return item
}

export function allowedFieldsFor(auth: AuthContext) {
  const role = auth.role.key
  const allowed = new Set<string>(BASIC_FIELDS)
  if (role === 'admin' || role === 'manager' || hasPermission(auth.permissions, 'lead:qualify')) {
    for (const key of QUALIFICATION_FIELDS) allowed.add(key)
  }
  if (role === 'admin' || role === 'manager') {
    for (const key of SOURCE_FIELDS) allowed.add(key)
  }
  if (hasPermission(auth.permissions, 'lead:override_priority')) {
    allowed.add('priorityCode')
    allowed.add('priorityOverrideReason')
  }
  return allowed
}

export function leadScopeWhere(auth: AuthContext): Prisma.LeadWhereInput {
  const scope = auth.dataScopes.lead ?? 'OWN'
  if (scope === 'ALL') return {}
  if (scope === 'DEPARTMENT' && auth.user.departmentId) {
    return {
      OR: [
        { owner: { departmentId: auth.user.departmentId } },
        { assignedCountryTeam: { departmentId: auth.user.departmentId } },
      ],
    }
  }
  if (scope === 'TEAM' && auth.user.teamId) {
    return {
      OR: [{ owner: { teamId: auth.user.teamId } }, { assignedCountryTeamId: auth.user.teamId }],
    }
  }
  return { ownerId: auth.user.id }
}

export const FOLLOW_UP_CLOSED_STATUSES = ['Done', 'Completed', 'Cancelled', 'Rescheduled'] as const
export const FOLLOW_UP_OPEN_STATUSES = ['Pending', 'Due Soon', 'Overdue'] as const

export function myLeadsOwnerWhere(auth: AuthContext): Prisma.LeadWhereInput {
  return { ownerId: auth.user.id }
}

export function priorityRank(priority?: string | null) {
  const key = (priority || '').trim().toLowerCase()
  if (key === 'high' || key === 'urgent') return 3
  if (key === 'medium') return 2
  if (key === 'low') return 1
  return 0
}

export function leadPoolScopeWhere(auth: AuthContext): Prisma.LeadWhereInput {
  const scope = auth.dataScopes.lead ?? 'OWN'
  if (scope === 'ALL') return { ownerId: null }
  if (scope === 'DEPARTMENT' && auth.user.departmentId) {
    return { ownerId: null, assignedCountryTeam: { departmentId: auth.user.departmentId } }
  }
  if (scope === 'TEAM' && auth.user.teamId) {
    return { ownerId: null, assignedCountryTeamId: auth.user.teamId }
  }
  return { id: { in: [] } }
}

export function leadReadableWhere(auth: AuthContext): Prisma.LeadWhereInput {
  const scope = leadScopeWhere(auth)
  // ALL already covers owned + pool. Putting `{}` inside OR makes Prisma match
  // nothing for that branch, so assigned leads would 404 on detail/view.
  if (Object.keys(scope).length === 0) return {}
  if (!hasPermission(auth.permissions, ['lead:assign', 'lead:reassign'])) {
    return scope
  }
  return { OR: [scope, leadPoolScopeWhere(auth)] }
}

export function formatWaitingTime(createdAt: Date, now = new Date()) {
  const diffMs = Math.max(0, now.getTime() - createdAt.getTime())
  const minutes = Math.floor(diffMs / 60000)
  if (minutes <= 1) return '1 Minute'
  if (minutes < 60) return `${minutes} Minutes`
  const hours = Math.floor(minutes / 60)
  if (hours === 1) return '1 Hour'
  if (hours < 24) return `${hours} Hours`
  const days = Math.floor(hours / 24)
  return days === 1 ? '1 Day' : `${days} Days`
}

export function assigneeVisibilityWhere(auth: AuthContext): Prisma.UserWhereInput {
  const scope = auth.dataScopes.lead ?? 'OWN'
  if (scope === 'ALL') return {}
  if (scope === 'DEPARTMENT' && auth.user.departmentId) {
    return { departmentId: auth.user.departmentId }
  }
  if (scope === 'TEAM' && auth.user.teamId) {
    return { teamId: auth.user.teamId }
  }
  return { id: auth.user.id }
}

/** ACTIVE user + Active/Probation employment (or no Employee record). CRM-027 Rule-5. */
export function leadEligibleAssigneeWhere(): Prisma.UserWhereInput {
  return {
    status: 'ACTIVE',
    OR: [
      { employee: { is: null } },
      { employee: { employmentStatus: { code: { in: ['ACTIVE', 'PROBATION'] } } } },
    ],
  }
}

export async function assertLeadEligibleAssignee(userId: string) {
  const user = await prisma.user.findFirst({
    where: {
      id: userId,
      AND: [leadEligibleAssigneeWhere()],
    },
    select: { id: true, fullName: true, teamId: true, status: true },
  })
  return user
}

export const WORKSPACE_ACCESS_DENIED = 'You do not have permission to access this lead\'s workspace.'

export async function findReadableLead(auth: AuthContext, leadId: string) {
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, AND: [leadReadableWhere(auth)] },
  })
  if (lead) return lead
  const exists = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true } })
  if (exists) throw httpError.accessDenied(WORKSPACE_ACCESS_DENIED)
  throw httpError.notFound('Lead not found.')
}

export async function assertCanViewLead(auth: AuthContext, leadId: string) {
  return findReadableLead(auth, leadId)
}

export async function assertCanManageLeadAssignment(auth: AuthContext, leadId: string) {
  const canAssign = hasPermission(auth.permissions, 'lead:assign')
  const canReassign = hasPermission(auth.permissions, 'lead:reassign')
  if (!canAssign && !canReassign) {
    throw httpError.accessDenied()
  }
  const lead = await findReadableLead(auth, leadId)
  return { lead, canAssign, canReassign }
}

export function profileCompletion(lead: {
  name: string
  phone: string | null
  email: string | null
  currentLocation: string | null
  preferredCountryCode: string | null
  preferredDegreeCode: string | null
  preferredIntakeCode: string | null
  highestQualificationCode: string | null
  institutionName: string | null
  englishTestCode: string | null
  testStatusCode: string | null
  estimatedBudgetCode: string | null
  financialReadinessCode: string | null
  previouslyAppliedAbroad: boolean | null
  previousVisaApplication: boolean | null
  previousVisaRefusal: boolean | null
  decisionTimelineCode: string | null
  studyIntentCode: string | null
}) {
  const sections = {
    personal: Boolean(lead.name && lead.phone),
    study: Boolean(lead.preferredCountryCode),
    academic: Boolean(lead.highestQualificationCode || lead.institutionName),
    english: Boolean(lead.englishTestCode),
    financial: Boolean(lead.estimatedBudgetCode || lead.financialReadinessCode),
    visa:
      lead.previouslyAppliedAbroad != null ||
      lead.previousVisaApplication != null ||
      lead.previousVisaRefusal != null,
    intent: Boolean(lead.decisionTimelineCode || lead.studyIntentCode),
  }
  const weights = {
    personal: 20,
    study: 20,
    academic: 15,
    english: 15,
    financial: 15,
    visa: 10,
    intent: 5,
  }
  const percent = (Object.keys(sections) as Array<keyof typeof sections>).reduce(
    (sum, key) => sum + (sections[key] ? weights[key] : 0),
    0,
  )
  return { percent, sections }
}

function hasValue(value: unknown) {
  if (value == null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (typeof value === 'number') return Number.isFinite(value)
  if (value instanceof Date) return !Number.isNaN(value.getTime())
  return false
}

function answered(value: boolean | null | undefined) {
  return value === true || value === false
}

function ratio(checks: boolean[]) {
  if (!checks.length) return 1
  return checks.filter(Boolean).length / checks.length
}

export type LeadScoreInput = {
  name?: string | null
  phone?: string | null
  email?: string | null
  dateOfBirth?: Date | string | null
  currentLocation?: string | null
  whatsapp?: string | null
  whatsappSameAsPhone?: boolean | null
  preferredCountryCode?: string | null
  preferredDegreeCode?: string | null
  preferredCourse?: string | null
  preferredIntakeCode?: string | null
  studyPurposeCode?: string | null
  studyPurposeOther?: string | null
  highestQualificationCode?: string | null
  institutionName?: string | null
  passingYear?: number | string | null
  resultCgpa?: string | null
  studyGapYears?: number | string | null
  englishTestCode?: string | null
  testStatusCode?: string | null
  overallScore?: number | string | null
  testDate?: Date | string | null
  listening?: number | string | null
  reading?: number | string | null
  writing?: number | string | null
  speaking?: number | string | null
  estimatedBudgetCode?: string | null
  fundingSourceCode?: string | null
  financialReadinessCode?: string | null
  previouslyAppliedAbroad?: boolean | null
  previousVisaApplication?: boolean | null
  previousVisaRefusal?: boolean | null
  prevVisaCountry?: string | null
  prevVisaType?: string | null
  prevVisaYear?: number | string | null
  prevVisaResult?: string | null
  refusalCountry?: string | null
  refusalYear?: number | string | null
  refusalReason?: string | null
  decisionTimelineCode?: string | null
  decisionMakerCode?: string | null
  applicationReadinessCode?: string | null
  studyIntentCode?: string | null
  preferredContactMethodCode?: string | null
  preferredContactTimeCode?: string | null
  specificContactTime?: string | null
  sourceCode?: string | null
  channelCode?: string | null
  campaign?: string | null
  campaignId?: string | null
  sourceDetails?: string | null
  externalLeadId?: string | null
  remarks?: string | null
  referralBy?: string | null
  referralDetails?: string | null
}

/**
 * Lead Score is how much of the student profile is filled.
 * Weights sum to 100. Conditional fields (test bands, visa details,
 * referral, specific contact time, "other" purpose) count only when they apply.
 * A fully answered profile is 100. Priority follows the score unless overridden.
 */
export function computeLeadScore(lead: LeadScoreInput) {
  const personal = ratio([
    hasValue(lead.name),
    hasValue(lead.phone),
    hasValue(lead.email),
    hasValue(lead.dateOfBirth),
    hasValue(lead.currentLocation),
    lead.whatsappSameAsPhone ? hasValue(lead.phone) : hasValue(lead.whatsapp),
  ])
  const study = ratio([
    hasValue(lead.preferredCountryCode),
    hasValue(lead.preferredDegreeCode),
    hasValue(lead.preferredCourse),
    hasValue(lead.preferredIntakeCode),
    hasValue(lead.studyPurposeCode) &&
      (lead.studyPurposeCode !== 'OTHER' || hasValue(lead.studyPurposeOther)),
  ])
  const academic = ratio([
    hasValue(lead.highestQualificationCode),
    hasValue(lead.institutionName),
    hasValue(lead.passingYear),
    hasValue(lead.resultCgpa),
    hasValue(lead.studyGapYears),
  ])
  const englishChecks = [hasValue(lead.englishTestCode), hasValue(lead.testStatusCode)]
  if (lead.testStatusCode === 'TAKEN') {
    englishChecks.push(
      hasValue(lead.overallScore),
      hasValue(lead.testDate),
      hasValue(lead.listening),
      hasValue(lead.reading),
      hasValue(lead.writing),
      hasValue(lead.speaking),
    )
  }
  const english = ratio(englishChecks)
  const financial = ratio([
    hasValue(lead.estimatedBudgetCode),
    hasValue(lead.fundingSourceCode),
    hasValue(lead.financialReadinessCode),
  ])
  const visaChecks = [
    answered(lead.previouslyAppliedAbroad),
    answered(lead.previousVisaApplication),
    answered(lead.previousVisaRefusal),
  ]
  if (lead.previousVisaApplication === true) {
    visaChecks.push(
      hasValue(lead.prevVisaCountry),
      hasValue(lead.prevVisaType),
      hasValue(lead.prevVisaYear),
      hasValue(lead.prevVisaResult),
    )
  }
  if (lead.previousVisaRefusal === true) {
    visaChecks.push(
      hasValue(lead.refusalCountry),
      hasValue(lead.refusalYear),
      hasValue(lead.refusalReason),
    )
  }
  const visa = ratio(visaChecks)
  const intent = ratio([
    hasValue(lead.decisionTimelineCode),
    hasValue(lead.decisionMakerCode),
    hasValue(lead.applicationReadinessCode),
    hasValue(lead.studyIntentCode),
  ])
  const contactChecks = [
    hasValue(lead.preferredContactMethodCode),
    hasValue(lead.preferredContactTimeCode),
  ]
  if (lead.preferredContactTimeCode === 'SPECIFIC') {
    contactChecks.push(hasValue(lead.specificContactTime))
  }
  const contact = ratio(contactChecks)
  const sourceChecks = [
    hasValue(lead.sourceCode),
    hasValue(lead.channelCode),
    hasValue(lead.campaignId) || hasValue(lead.campaign),
    hasValue(lead.sourceDetails),
    hasValue(lead.externalLeadId),
    hasValue(lead.remarks),
  ]
  if (lead.sourceCode === 'REFERRAL') {
    sourceChecks.push(hasValue(lead.referralBy), hasValue(lead.referralDetails))
  }
  const source = ratio(sourceChecks)

  const weights = {
    personal: 16,
    study: 16,
    academic: 14,
    english: 14,
    financial: 12,
    visa: 10,
    intent: 10,
    contact: 4,
    source: 4,
  }
  const raw =
    personal * weights.personal +
    study * weights.study +
    academic * weights.academic +
    english * weights.english +
    financial * weights.financial +
    visa * weights.visa +
    intent * weights.intent +
    contact * weights.contact +
    source * weights.source
  const score = Math.max(0, Math.min(100, Math.round(raw)))
  const priorityCode = score >= 75 ? 'HIGH' : score >= 45 ? 'MEDIUM' : 'LOW'
  const priority = priorityCode === 'HIGH' ? 'High' : priorityCode === 'MEDIUM' ? 'Medium' : 'Low'
  return { score, priorityCode, priority }
}

export function displayedLeadScore(
  lead: LeadScoreInput & {
    priorityManual?: boolean | null
    priority?: string | null
    priorityCode?: string | null
  },
) {
  const scored = computeLeadScore(lead)
  if (!lead.priorityManual) return scored
  return {
    score: scored.score,
    priority: lead.priority || scored.priority,
    priorityCode: lead.priorityCode || scored.priorityCode,
  }
}

/** Rewrite stored scores from current profile data without touching updated_at. */
export async function syncStoredLeadScores() {
  const leads = await prisma.lead.findMany({
    select: {
      id: true,
      priorityManual: true,
      leadScore: true,
      priority: true,
      priorityCode: true,
      name: true,
      phone: true,
      email: true,
      dateOfBirth: true,
      currentLocation: true,
      whatsapp: true,
      whatsappSameAsPhone: true,
      preferredCountryCode: true,
      preferredDegreeCode: true,
      preferredCourse: true,
      preferredIntakeCode: true,
      studyPurposeCode: true,
      studyPurposeOther: true,
      highestQualificationCode: true,
      institutionName: true,
      passingYear: true,
      resultCgpa: true,
      studyGapYears: true,
      englishTestCode: true,
      testStatusCode: true,
      overallScore: true,
      testDate: true,
      listening: true,
      reading: true,
      writing: true,
      speaking: true,
      estimatedBudgetCode: true,
      fundingSourceCode: true,
      financialReadinessCode: true,
      previouslyAppliedAbroad: true,
      previousVisaApplication: true,
      previousVisaRefusal: true,
      prevVisaCountry: true,
      prevVisaType: true,
      prevVisaYear: true,
      prevVisaResult: true,
      refusalCountry: true,
      refusalYear: true,
      refusalReason: true,
      decisionTimelineCode: true,
      decisionMakerCode: true,
      applicationReadinessCode: true,
      studyIntentCode: true,
      preferredContactMethodCode: true,
      preferredContactTimeCode: true,
      specificContactTime: true,
      sourceCode: true,
      channelCode: true,
      campaign: true,
      campaignId: true,
      sourceDetails: true,
      externalLeadId: true,
      remarks: true,
      referralBy: true,
      referralDetails: true,
    },
  })

  let updated = 0
  for (const lead of leads) {
    const scored = displayedLeadScore(lead)
    if (
      lead.leadScore === scored.score &&
      (lead.priority || null) === (scored.priority || null) &&
      (lead.priorityCode || null) === (scored.priorityCode || null)
    ) {
      continue
    }
    await prisma.$executeRaw`
      UPDATE leads
      SET lead_score = ${scored.score},
          priority = ${scored.priority},
          priority_code = ${scored.priorityCode}
      WHERE id = ${lead.id}::uuid
    `
    updated += 1
  }
  return updated
}

export { canReceiveLeadAssignment, hasPermission }
