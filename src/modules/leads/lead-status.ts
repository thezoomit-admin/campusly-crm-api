export const PIPELINE_STATUSES = ['New', 'Contacted', 'Qualified', 'Counselling', 'Offered', 'Converted'] as const

export const CLOSED_ASSIGNMENT_STATUSES = [
  'Converted',
  'File Opening Pending',
  'File Opened',
  'Closed',
  'Lost',
  'Duplicate',
  'Invalid',
]

export const STATUS_MESSAGES = {
  missing: 'Please select a status.',
  same: 'The selected status is already active.',
  remarks: 'Please enter remarks before updating the status.',
  permission: 'You do not have permission to update the status.',
  failed: 'Unable to update the lead status. Please try again.',
  jump: 'This status change is not allowed. Complete the previous stages first.',
  override: 'Please provide a reason for this status override.',
  converted: 'Converted status is set from Lead Conversion, not from Change Status.',
  fileOpened: 'File Opened is set after File Opening is complete, not from Change Status.',
  fileOpening: 'File Opening Pending is set from File Opening, not from Change Status.',
  lockedFile: 'A lead with File Opened status can no longer be managed in the CRM lead workflow.',
  lockedTerminal: 'This lead is closed. Use Reopen Lead to return it to an active stage.',
  lockedConverted: 'Converted and File Opened leads cannot be closed or reopened here.',
  qualifiedData: 'Name, mobile, interested service, and qualification data are required before moving to Qualified.',
}

export const CLOSE_MESSAGES = {
  permission: 'You do not have permission to close or reopen this lead.',
  reason: 'Please select a reason before closing this lead.',
  remarksOther: 'Please provide remarks for the selected "Other" reason.',
  status: 'Please select Lost, Closed, Duplicate, or Invalid.',
  notAllowed: 'This lead cannot be closed from its current status.',
  failed: 'Unable to complete this action. Please try again.',
}

export const REOPEN_MESSAGES = {
  permission: 'You do not have permission to close or reopen this lead.',
  reason: 'Please provide a reopen reason.',
  followUp: 'Please select a new follow-up date.',
  owner: 'Please select an assigned employee.',
  notTerminal: 'Only Lost, Closed, Duplicate, or Invalid leads can be reopened.',
  notAllowed: 'Converted and File Opened leads cannot be closed or reopened here.',
  failed: 'Unable to complete this action. Please try again.',
}

const TERMINAL_BEHAVIORS = new Set(['lost', 'closed', 'duplicate', 'invalid'])
const PROCESS_GATED_BEHAVIORS = new Set(['converted', 'file_opening_pending', 'file_opened'])
const CLOSE_BLOCKED_BEHAVIORS = new Set(['converted', 'file_opening_pending', 'file_opened'])

const LEGACY_STATUS_CODE: Record<string, string> = {
  INTERESTED: 'QUALIFIED',
  OFFER_SENT: 'OFFERED',
}

const LEGACY_STATUS_NAME: Record<string, string> = {
  interested: 'QUALIFIED',
  'offer sent': 'OFFERED',
  'follow-up': 'CONTACTED',
  followup: 'CONTACTED',
}

export type LeadStatusItem = {
  name: string
  code: string | null
  behaviorKey: string | null
  sortOrder: number
  status: string
}

export type StatusOption = {
  code: string
  name: string
  behaviorKey: string | null
  remarksRequired: boolean
  lostReasonRequired: boolean
  closeReasonRequired: boolean
  reasonCategory: 'LEAD_LOST_REASON' | 'LEAD_CLOSE_REASON' | null
  requiresOverride: boolean
  processGated: boolean
}

export type ResolvedLeadStatus = {
  code: string
  name: string
  behaviorKey: string | null
  sortOrder: number
}

export type StatusChangeDescriptor = {
  canUpdate: boolean
  canClose: boolean
  canReopen: boolean
  locked: boolean
  lockedReason: string | null
  canOverride: boolean
  current: ResolvedLeadStatus | null
  options: StatusOption[]
  closeOptions: StatusOption[]
}

function activeItems(items: LeadStatusItem[]) {
  return items.filter((item) => item.status === 'ACTIVE' && item.code)
}

export function isTerminalBehavior(behaviorKey: string | null | undefined) {
  return Boolean(behaviorKey && TERMINAL_BEHAVIORS.has(behaviorKey))
}

export function isProcessGatedBehavior(behaviorKey: string | null | undefined) {
  return Boolean(behaviorKey && PROCESS_GATED_BEHAVIORS.has(behaviorKey))
}

export function isCloseBlockedBehavior(behaviorKey: string | null | undefined) {
  return Boolean(behaviorKey && CLOSE_BLOCKED_BEHAVIORS.has(behaviorKey))
}

export function remarksRequiredFor(behaviorKey: string | null | undefined) {
  return Boolean(behaviorKey && TERMINAL_BEHAVIORS.has(behaviorKey))
}

export function lostReasonRequiredFor(behaviorKey: string | null | undefined) {
  return behaviorKey === 'lost'
}

export function closeReasonRequiredFor(behaviorKey: string | null | undefined) {
  return behaviorKey === 'closed' || behaviorKey === 'duplicate' || behaviorKey === 'invalid'
}

export function reasonCategoryFor(behaviorKey: string | null | undefined): StatusOption['reasonCategory'] {
  if (behaviorKey === 'lost') return 'LEAD_LOST_REASON'
  if (behaviorKey === 'closed' || behaviorKey === 'duplicate' || behaviorKey === 'invalid') return 'LEAD_CLOSE_REASON'
  return null
}

export function isOtherReasonCode(code: string | null | undefined) {
  return (code || '').trim().toUpperCase() === 'OTHER'
}

function toResolved(item: LeadStatusItem): ResolvedLeadStatus {
  return {
    code: item.code || '',
    name: item.name,
    behaviorKey: item.behaviorKey,
    sortOrder: item.sortOrder,
  }
}

function toOption(item: LeadStatusItem, requiresOverride: boolean): StatusOption {
  return {
    code: item.code || '',
    name: item.name,
    behaviorKey: item.behaviorKey,
    remarksRequired: false,
    lostReasonRequired: lostReasonRequiredFor(item.behaviorKey),
    closeReasonRequired: closeReasonRequiredFor(item.behaviorKey),
    reasonCategory: reasonCategoryFor(item.behaviorKey),
    requiresOverride,
    processGated: isProcessGatedBehavior(item.behaviorKey),
  }
}

export function resolveLeadStatus(
  lead: { status: string; statusCode?: string | null },
  items: LeadStatusItem[],
): ResolvedLeadStatus | null {
  const byCode = new Map(
    items.filter((item) => item.code).map((item) => [item.code!.toUpperCase(), item]),
  )
  const byName = new Map(items.map((item) => [item.name.trim().toLowerCase(), item]))

  let code = (lead.statusCode || '').trim().toUpperCase()
  if (LEGACY_STATUS_CODE[code]) code = LEGACY_STATUS_CODE[code]
  if (code && byCode.has(code)) return toResolved(byCode.get(code)!)

  const nameKey = lead.status.trim().toLowerCase()
  const mappedCode = LEGACY_STATUS_NAME[nameKey]
  if (mappedCode && byCode.has(mappedCode)) return toResolved(byCode.get(mappedCode)!)
  const named = byName.get(nameKey)
  return named ? toResolved(named) : lead.status ? { code: code || nameKey.toUpperCase(), name: lead.status, behaviorKey: null, sortOrder: 0 } : null
}

function sequentialItems(items: LeadStatusItem[]) {
  return activeItems(items)
    .filter((item) => !isTerminalBehavior(item.behaviorKey))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
}

export function describeStatusChange(input: {
  lead: { status: string; statusCode?: string | null }
  items: LeadStatusItem[]
  canUpdate: boolean
  canOverride: boolean
  canClose?: boolean
  canReopen?: boolean
}): StatusChangeDescriptor {
  const current = resolveLeadStatus(input.lead, input.items)
  const lockedFile = current?.behaviorKey === 'file_opened'
  const lockedTerminal = isTerminalBehavior(current?.behaviorKey)
  const locked = lockedFile || lockedTerminal
  const lockedReason = lockedFile
    ? STATUS_MESSAGES.lockedFile
    : lockedTerminal
      ? STATUS_MESSAGES.lockedTerminal
      : null

  const closeBlocked = isCloseBlockedBehavior(current?.behaviorKey)
  const canClose =
    Boolean(input.canClose) && Boolean(current) && !locked && !closeBlocked && !isTerminalBehavior(current?.behaviorKey)
  const canReopen = Boolean(input.canReopen) && lockedTerminal && !lockedFile

  const closeOptions = canClose
    ? activeItems(input.items)
        .filter((item) => isTerminalBehavior(item.behaviorKey))
        .map((item) => toOption(item, false))
        .sort((a, b) => {
          const left = input.items.find((item) => item.code === a.code)?.sortOrder ?? 0
          const right = input.items.find((item) => item.code === b.code)?.sortOrder ?? 0
          return left - right
        })
    : []

  if (!input.canUpdate || locked || !current) {
    return {
      canUpdate: false,
      canClose,
      canReopen,
      locked,
      lockedReason,
      canOverride: false,
      current,
      options: [],
      closeOptions,
    }
  }

  const sequential = sequentialItems(input.items)
  const currentCode = current.code
  const currentIndex = sequential.findIndex((item) => item.code === currentCode)
  const nextSequential = currentIndex >= 0 ? sequential[currentIndex + 1] : undefined
  const options: StatusOption[] = []
  const seen = new Set<string>()

  function add(item: LeadStatusItem | undefined, requiresOverride: boolean) {
    if (!item?.code || item.code === currentCode || seen.has(item.code)) return
    if (isProcessGatedBehavior(item.behaviorKey)) return
    if (isTerminalBehavior(item.behaviorKey)) return
    seen.add(item.code)
    options.push(toOption(item, requiresOverride))
  }

  if (!isProcessGatedBehavior(current.behaviorKey)) {
    add(nextSequential, false)
  }

  if (input.canOverride && !isProcessGatedBehavior(current.behaviorKey)) {
    for (const item of sequential) {
      if (item.sortOrder > current.sortOrder) add(item, true)
    }
  }

  options.sort((a, b) => {
    const left = input.items.find((item) => item.code === a.code)?.sortOrder ?? 0
    const right = input.items.find((item) => item.code === b.code)?.sortOrder ?? 0
    return left - right
  })

  return {
    canUpdate: true,
    canClose,
    canReopen,
    locked: false,
    lockedReason: null,
    canOverride: input.canOverride,
    current,
    options,
    closeOptions,
  }
}

export function missingQualifiedData(lead: {
  name?: string | null
  phone?: string | null
  preferredCountryCode?: string | null
  preferredCourse?: string | null
  country?: string | null
  qualificationResultCode?: string | null
}) {
  const hasService = Boolean(lead.preferredCountryCode || lead.preferredCourse || lead.country)
  return !(lead.name?.trim() && lead.phone?.trim() && hasService && lead.qualificationResultCode?.trim())
}
