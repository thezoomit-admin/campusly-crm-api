export const FOLLOW_UP_TYPES = [
  'Call',
  'WhatsApp',
  'Email',
  'SMS',
  'Counselling',
  'Meeting',
  'Document Request',
  'Payment Discussion',
  'Service Discussion',
  'Other',
] as const

export const FOLLOW_UP_PRIORITIES = ['High', 'Medium', 'Low'] as const

export const FOLLOW_UP_PURPOSES = [
  'Initial Contact',
  'Information Sharing',
  'Counselling',
  'University Discussion',
  'Course Discussion',
  'Service Discussion',
  'Service Charge Discussion',
  'Payment Follow-up',
  'Document Collection',
  'Visa Discussion',
  'Application Update',
  'Offer Discussion',
  'Other',
] as const

export const FOLLOW_UP_REMINDERS = [
  'No Reminder',
  'At the time',
  '5 Minutes Before',
  '15 Minutes Before',
  '30 Minutes Before',
  '1 Hour Before',
  '1 Day Before',
] as const

export const FOLLOW_UP_OUTCOMES = [
  'Connected',
  'No Answer',
  'Busy',
  'Call Back Requested',
  'Interested',
  'Not Interested',
  'Information Requested',
  'Counselling Scheduled',
  'Payment Discussed',
  'Documents Requested',
  'Other',
] as const

export type ScheduleHistoryEntry = {
  previousDueAt: string | null
  newDueAt: string | null
  reason: string
  at: string
  byId: string
  byName: string
}
