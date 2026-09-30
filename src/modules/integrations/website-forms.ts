/** CRM-011 — supported website enquiry form types. */
export const WEBSITE_FORM_TYPES = [
  { code: 'FREE_CONSULTATION', name: 'Free Consultation', cta: 'Free Consultation' },
  { code: 'APPLY_NOW', name: 'Apply Now', cta: 'Apply Now' },
  { code: 'CONTACT_US', name: 'Contact Us', cta: 'Submit Enquiry' },
  { code: 'REQUEST_CALLBACK', name: 'Request Callback', cta: 'Request Callback' },
  { code: 'COUNTRY_SPECIFIC', name: 'Country Specific Form', cta: 'Talk to Expert' },
  { code: 'SCHOLARSHIP', name: 'Scholarship Assessment', cta: 'Get Assessment' },
  { code: 'LANDING_REGISTER', name: 'Landing Page Register', cta: 'Register Now' },
  { code: 'FLOATING_CALLBACK', name: 'Floating Callback Form', cta: 'Request Callback' },
] as const

export type WebsiteFormCode = (typeof WEBSITE_FORM_TYPES)[number]['code']

const FORM_ALIASES: Record<string, WebsiteFormCode> = {
  FREE_CONSULTATION: 'FREE_CONSULTATION',
  'FREE CONSULTATION': 'FREE_CONSULTATION',
  CONSULTATION: 'FREE_CONSULTATION',
  APPLY_NOW: 'APPLY_NOW',
  'APPLY NOW': 'APPLY_NOW',
  APPLY: 'APPLY_NOW',
  CONTACT_US: 'CONTACT_US',
  'CONTACT US': 'CONTACT_US',
  CONTACT: 'CONTACT_US',
  REQUEST_CALLBACK: 'REQUEST_CALLBACK',
  'REQUEST CALLBACK': 'REQUEST_CALLBACK',
  CALLBACK: 'REQUEST_CALLBACK',
  COUNTRY_SPECIFIC: 'COUNTRY_SPECIFIC',
  'COUNTRY SPECIFIC': 'COUNTRY_SPECIFIC',
  COUNTRY: 'COUNTRY_SPECIFIC',
  SCHOLARSHIP: 'SCHOLARSHIP',
  LANDING_REGISTER: 'LANDING_REGISTER',
  'LANDING REGISTER': 'LANDING_REGISTER',
  LANDING: 'LANDING_REGISTER',
  REGISTER_NOW: 'LANDING_REGISTER',
  'REGISTER NOW': 'LANDING_REGISTER',
  FLOATING_CALLBACK: 'FLOATING_CALLBACK',
  'FLOATING CALLBACK': 'FLOATING_CALLBACK',
  FLOATING: 'FLOATING_CALLBACK',
}

export function normalizeWebsiteFormName(value?: string | null): WebsiteFormCode | null {
  if (!value) return null
  const key = value.trim().replace(/[-]+/g, '_').replace(/\s+/g, ' ').toUpperCase()
  const compact = key.replace(/\s+/g, '_')
  return FORM_ALIASES[key] || FORM_ALIASES[compact] || null
}

export function websiteFormLabel(code?: string | null) {
  if (!code) return 'Website Form'
  const normalized = normalizeWebsiteFormName(code) || code
  const found = WEBSITE_FORM_TYPES.find((item) => item.code === normalized)
  return found?.name || code
}

export const WEBSITE_MESSAGES = {
  required: 'Please complete all required fields.',
  invalidPhone: 'Please enter a valid phone number.',
  invalidEmail: 'Please enter a valid email address.',
  failed: 'Unable to submit enquiry. Please try again later.',
  duplicate: 'Existing enquiry found. Our team will contact you shortly.',
  success: 'Thank you. Our team will contact you shortly.',
  unauthorized: 'Unauthorized webhook request.',
  rateLimited: 'Too many requests. Please try again later.',
} as const
