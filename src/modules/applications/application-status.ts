export const APPLICATION_STATUSES = [
  'Draft',
  'Documents Pending',
  'Under Review',
  'Submitted',
  'Offer Received',
  'Visa Processing',
  'Enrolled',
  'Rejected',
  'Withdrawn',
] as const

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number]

export const APPLICATION_STATUS_TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  Draft: ['Documents Pending', 'Withdrawn'],
  'Documents Pending': ['Under Review', 'Withdrawn'],
  'Under Review': ['Submitted', 'Documents Pending', 'Rejected', 'Withdrawn'],
  Submitted: ['Offer Received', 'Rejected', 'Withdrawn'],
  'Offer Received': ['Visa Processing', 'Rejected', 'Withdrawn'],
  'Visa Processing': ['Enrolled', 'Rejected', 'Withdrawn'],
  Enrolled: [],
  Rejected: [],
  Withdrawn: [],
}

export function isApplicationStatus(value: string): value is ApplicationStatus {
  return (APPLICATION_STATUSES as readonly string[]).includes(value)
}

export function allowedApplicationTransitions(status: string): ApplicationStatus[] {
  if (!isApplicationStatus(status)) return []
  return APPLICATION_STATUS_TRANSITIONS[status]
}

/** Lead statuses that may create university applications. */
export const CONVERTIBLE_LEAD_STATUS_CODES = new Set([
  'CONVERTED',
  'FILE_OPENING_PENDING',
  'FILE_OPENED',
])

export const CONVERTIBLE_LEAD_BEHAVIORS = new Set([
  'converted',
  'file_opening_pending',
  'file_opened',
])

export function isConvertibleLeadStatus(input: {
  status?: string | null
  statusCode?: string | null
  behaviorKey?: string | null
}) {
  const code = (input.statusCode || '').trim().toUpperCase()
  if (code && CONVERTIBLE_LEAD_STATUS_CODES.has(code)) return true
  if (input.behaviorKey && CONVERTIBLE_LEAD_BEHAVIORS.has(input.behaviorKey)) return true
  const name = (input.status || '').trim().toLowerCase()
  return (
    name === 'converted' ||
    name === 'file opening pending' ||
    name === 'file opened'
  )
}
