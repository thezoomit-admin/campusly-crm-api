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
  lockedTerminal: 'This lead is closed. An authorized user can reopen it separately.',
  qualifiedData: 'Name, mobile, interested service, and qualification data are required before moving to Qualified.',
}

const TERMINAL_BEHAVIORS = new Set(['lost', 'closed', 'duplicate', 'invalid'])
const PROCESS_GATED_BEHAVIORS = new Set(['converted', 'file_opening_pending', 'file_opened'])
const REMARKS_BEHAVIORS = new Set(['lost', 'closed', 'duplicate', 'invalid'])

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
  locked: boolean
  lockedReason: string | null
  canOverride: boolean
  current: ResolvedLeadStatus | null
  options: StatusOption[]
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

export function remarksRequiredFor(behaviorKey: string | null | undefined) {
  return Boolean(behaviorKey && REMARKS_BEHAVIORS.has(behaviorKey))
}

export function lostReasonRequiredFor(behaviorKey: string | null | undefined) {
  return behaviorKey === 'lost'
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
    remarksRequired: remarksRequiredFor(item.behaviorKey),
    lostReasonRequired: lostReasonRequiredFor(item.behaviorKey),
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

  if (!input.canUpdate || locked || !current) {
    return {
      canUpdate: false,
      locked,
      lockedReason,
      canOverride: false,
      current,
      options: [],
    }
  }

  const sequential = sequentialItems(input.items)
  const currentCode = current.code
  const currentIndex = sequential.findIndex((item) => item.code === currentCode)
  const nextSequential = currentIndex >= 0 ? sequential[currentIndex + 1] : undefined
  const terminals = activeItems(input.items).filter((item) => isTerminalBehavior(item.behaviorKey))
  const options: StatusOption[] = []
  const seen = new Set<string>()

  function add(item: LeadStatusItem | undefined, requiresOverride: boolean) {
    if (!item?.code || item.code === currentCode || seen.has(item.code)) return
    if (isProcessGatedBehavior(item.behaviorKey)) return
    seen.add(item.code)
    options.push(toOption(item, requiresOverride))
  }

  if (!isProcessGatedBehavior(current.behaviorKey)) {
    add(nextSequential, false)
  }

  for (const item of terminals) add(item, false)

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
    locked: false,
    lockedReason: null,
    canOverride: input.canOverride,
    current,
    options,
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
