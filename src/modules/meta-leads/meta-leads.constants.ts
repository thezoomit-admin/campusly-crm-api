export const META_MESSAGES = {
  incomplete: 'Unable to process Meta Lead.',
  duplicate: 'Existing Lead found.',
  pool: 'Lead moved to Lead Pool.',
  campaignUnavailable: 'Campaign information not available.',
  received: 'Meta Lead received.',
  denied: 'You do not have permission to view Meta leads.',
} as const

export const META_FORM_TYPES = [
  { value: 'STUDY_ABROAD', label: 'Study Abroad Consultation' },
  { value: 'COUNTRY_SPECIFIC', label: 'Country Specific Campaign' },
  { value: 'SCHOLARSHIP', label: 'Scholarship Campaign' },
  { value: 'IELTS', label: 'IELTS Campaign' },
  { value: 'EVENT', label: 'Event Registration' },
] as const

export type MetaFormTypeCode = (typeof META_FORM_TYPES)[number]['value']
export type MetaPlatformCode = 'FACEBOOK' | 'INSTAGRAM'

export const CONVERTED_STATUS_CODES = ['CONVERTED', 'FILE_OPENING_PENDING', 'FILE_OPENED'] as const

export function formTypeLabel(code: string | null | undefined) {
  return META_FORM_TYPES.find((item) => item.value === code)?.label || code || 'Study Abroad Consultation'
}

export function platformLabel(platform: string | null | undefined) {
  if (platform === 'INSTAGRAM') return 'Instagram'
  if (platform === 'FACEBOOK') return 'Facebook'
  return 'Other'
}

export function sourceCodeForPlatform(_platform: MetaPlatformCode) {
  return 'META'
}

export function channelCodeForPlatform(platform: MetaPlatformCode) {
  return platform === 'INSTAGRAM' ? 'INSTAGRAM_LEAD_FORM' : 'FACEBOOK_LEAD_FORM'
}
