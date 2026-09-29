export const ACTIVITY_TYPES = [
  'CALL',
  'WHATSAPP',
  'EMAIL',
  'SMS',
  'COUNSELLING',
  'MEETING',
  'DOCUMENT_REQUEST',
  'PAYMENT_DISCUSSION',
  'SERVICE_DISCUSSION',
  'MESSAGE',
  'NOTE',
  'FOLLOW_UP',
  'OTHER',
] as const

export type ActivityTypeValue = (typeof ACTIVITY_TYPES)[number]

export const ACTIVITY_TYPE_LABELS: Record<ActivityTypeValue, string> = {
  CALL: 'Call',
  WHATSAPP: 'WhatsApp',
  EMAIL: 'Email',
  SMS: 'SMS',
  COUNSELLING: 'Counselling',
  MEETING: 'Meeting',
  DOCUMENT_REQUEST: 'Document Request',
  PAYMENT_DISCUSSION: 'Payment Discussion',
  SERVICE_DISCUSSION: 'Service Discussion',
  MESSAGE: 'Message',
  NOTE: 'Note',
  FOLLOW_UP: 'Follow-up',
  OTHER: 'Other',
}

/** Spec activity types shown in Log Activity UI (excludes legacy MESSAGE / system FOLLOW_UP). */
export const ACTIVITY_TYPE_OPTIONS = [
  { value: 'CALL', label: 'Call' },
  { value: 'WHATSAPP', label: 'WhatsApp' },
  { value: 'EMAIL', label: 'Email' },
  { value: 'SMS', label: 'SMS' },
  { value: 'COUNSELLING', label: 'Counselling' },
  { value: 'MEETING', label: 'Meeting' },
  { value: 'DOCUMENT_REQUEST', label: 'Document Request' },
  { value: 'PAYMENT_DISCUSSION', label: 'Payment Discussion' },
  { value: 'SERVICE_DISCUSSION', label: 'Service Discussion' },
  { value: 'OTHER', label: 'Other' },
] as const

export const CALL_OUTCOMES = [
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

export const COUNSELLING_OUTCOMES = [
  'Scheduled',
  'Completed',
  'Rescheduled',
  'Cancelled',
  'No Show',
] as const

export const GENERIC_ACTIVITY_OUTCOMES = [
  'Completed',
  'Interested',
  'Not Interested',
  'Information Requested',
  'Follow-up Required',
  'Other',
] as const
