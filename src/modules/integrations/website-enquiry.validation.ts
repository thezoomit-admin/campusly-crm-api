import { httpError } from '../../lib/http-error'
import {
  asOptionalString,
  asString,
  isValidEmail,
  isValidMobile,
  normalizePhone,
  titleCaseName,
} from '../leads/leads.helpers'
import { normalizeWebsiteFormName, WEBSITE_MESSAGES } from './website-forms'

export type WebsiteEnquiryNormalized = {
  senderName: string
  senderPhone: string
  phoneNormalized: string
  phoneCountryCode: string | null
  senderEmail: string | null
  whatsapp: string | null
  whatsappSameAsPhone: boolean
  preferredCountryCode: string
  currentLocation: string | null
  highestQualificationCode: string | null
  preferredIntakeCode: string | null
  preferredDegreeCode: string | null
  message: string | null
  formName: string | null
  campaign: string | null
  campaignId: string | null
  utmSource: string | null
  utmMedium: string | null
  utmCampaign: string | null
  utmContent: string | null
  utmTerm: string | null
  landingPageUrl: string | null
  externalId: string | null
  eventAt: string | null
}

function asBool(value: unknown) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    return v === 'true' || v === '1' || v === 'yes' || v === 'on'
  }
  return false
}

/**
 * CRM-011 website form validation — phone + name + preferred country required.
 */
export function validateWebsiteEnquiry(body: Record<string, unknown>): WebsiteEnquiryNormalized {
  const fields: Record<string, string> = {}

  const rawName = asString(body.name) || asString(body.senderName) || asString(body.full_name)
  const name = titleCaseName(rawName.trim())
  if (!name || name.length < 2 || name.length > 100) {
    fields.name = WEBSITE_MESSAGES.required
  }

  const rawPhone = asString(body.phone) || asString(body.senderPhone) || asString(body.from)
  if (!rawPhone || !isValidMobile(rawPhone)) {
    fields.phone = WEBSITE_MESSAGES.invalidPhone
  }
  const phoneNormalized = rawPhone ? normalizePhone(rawPhone) : ''
  if (rawPhone && phoneNormalized.length < 10) {
    fields.phone = WEBSITE_MESSAGES.invalidPhone
  }

  const preferredCountryCode = (
    asString(body.preferredCountryCode) ||
    asString(body.country) ||
    asString(body.preferred_country) ||
    asString(body.preferredCountry)
  )
    .trim()
    .toUpperCase()
  if (!preferredCountryCode) {
    fields.preferredCountryCode = WEBSITE_MESSAGES.required
  }

  const emailRaw = asOptionalString(body.email, 200) || asOptionalString(body.senderEmail, 200)
  const senderEmail = emailRaw ? emailRaw.toLowerCase() : null
  if (senderEmail && !isValidEmail(senderEmail)) {
    fields.email = WEBSITE_MESSAGES.invalidEmail
  }

  const messageRaw = asOptionalString(body.message, 5000) || asOptionalString(body.body, 5000)
  const message = messageRaw ? messageRaw.slice(0, 1000) : null

  if (Object.keys(fields).length) {
    const messageText =
      fields.phone && !fields.name && !fields.preferredCountryCode && !fields.email
        ? WEBSITE_MESSAGES.invalidPhone
        : fields.email && !fields.name && !fields.phone && !fields.preferredCountryCode
          ? WEBSITE_MESSAGES.invalidEmail
          : WEBSITE_MESSAGES.required
    throw httpError.validation(fields, messageText)
  }

  const whatsappSameAsPhone = asBool(body.whatsappSameAsPhone ?? body.whatsapp_same_as_phone)
  const rawWhatsapp =
    asOptionalString(body.whatsapp, 40) || asOptionalString(body.whatsappNumber, 40) || null
  let whatsapp: string | null = null
  if (whatsappSameAsPhone) {
    whatsapp = phoneNormalized
  } else if (rawWhatsapp) {
    if (!isValidMobile(rawWhatsapp)) {
      throw httpError.validation({ whatsapp: WEBSITE_MESSAGES.invalidPhone }, WEBSITE_MESSAGES.invalidPhone)
    }
    whatsapp = normalizePhone(rawWhatsapp)
  }

  const formName =
    normalizeWebsiteFormName(
      asString(body.formName) || asString(body.form_name) || asString(body.form),
    ) ||
    asOptionalString(body.formName, 120) ||
    asOptionalString(body.form_name, 120) ||
    null

  const education =
    asOptionalString(body.currentEducation, 40) ||
    asOptionalString(body.highestQualificationCode, 40) ||
    asOptionalString(body.educationLevel, 40) ||
    null

  const studyLevel =
    asOptionalString(body.studyLevel, 40) ||
    asOptionalString(body.preferredDegreeCode, 40) ||
    asOptionalString(body.preferred_degree, 40) ||
    null

  return {
    senderName: name!,
    senderPhone: rawPhone.trim(),
    phoneNormalized,
    phoneCountryCode: asOptionalString(body.phoneCountryCode, 8)?.toUpperCase() || null,
    senderEmail,
    whatsapp,
    whatsappSameAsPhone,
    preferredCountryCode,
    currentLocation: asOptionalString(body.currentLocation, 120) || asOptionalString(body.location, 120),
    highestQualificationCode: education?.toUpperCase() || null,
    preferredIntakeCode:
      asOptionalString(body.preferredIntakeCode, 40)?.toUpperCase() ||
      asOptionalString(body.intake, 40)?.toUpperCase() ||
      null,
    preferredDegreeCode: studyLevel?.toUpperCase() || null,
    message,
    formName,
    campaign: asOptionalString(body.campaign, 160) || asOptionalString(body.campaign_name, 160),
    campaignId: asOptionalString(body.campaignId, 80),
    utmSource: asOptionalString(body.utmSource, 120) || asOptionalString(body.utm_source, 120),
    utmMedium: asOptionalString(body.utmMedium, 120) || asOptionalString(body.utm_medium, 120),
    utmCampaign: asOptionalString(body.utmCampaign, 120) || asOptionalString(body.utm_campaign, 120),
    utmContent: asOptionalString(body.utmContent, 120) || asOptionalString(body.utm_content, 120),
    utmTerm: asOptionalString(body.utmTerm, 120) || asOptionalString(body.utm_term, 120),
    landingPageUrl:
      asOptionalString(body.landingPageUrl, 2000) ||
      asOptionalString(body.landing_page_url, 2000) ||
      asOptionalString(body.landingPage, 2000) ||
      asOptionalString(body.pageUrl, 2000),
    externalId:
      asOptionalString(body.externalId, 200) ||
      asOptionalString(body.id, 200) ||
      asOptionalString(body.submissionId, 200),
    eventAt: asOptionalString(body.eventAt, 40) || asOptionalString(body.occurredAt, 40),
  }
}
