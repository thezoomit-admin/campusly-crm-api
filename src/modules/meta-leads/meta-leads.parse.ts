import { asOptionalString, asString, isValidEmail, normalizePhone } from '../leads/leads.helpers'
import {
  formTypeLabel,
  type MetaFormTypeCode,
  type MetaPlatformCode,
} from './meta-leads.constants'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type ParsedMetaLead = {
  platform: MetaPlatformCode
  formType: MetaFormTypeCode
  formLabel: string
  externalId: string | null
  fullName: string | null
  phone: string | null
  phoneNormalized: string | null
  email: string | null
  whatsapp: string | null
  currentEducation: string | null
  preferredCountryCode: string | null
  preferredIntake: string | null
  campaignName: string | null
  metaCampaignId: string | null
  crmCampaignId: string | null
  adSetName: string | null
  adName: string | null
  receivedAt: string | null
  hasCampaignData: boolean
  complete: boolean
  rawPayload: Record<string, unknown>
}

function fieldMap(body: Record<string, unknown>) {
  const mapped: Record<string, string> = {}
  const rows = body.field_data
  if (!Array.isArray(rows)) return mapped
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    const name = asString(record.name).toLowerCase()
    const values = record.values
    const value = Array.isArray(values) ? asString(values[0]) : asString(values)
    if (name && value) mapped[name] = value
  }
  return mapped
}

function pick(body: Record<string, unknown>, fields: Record<string, string>, keys: string[]) {
  for (const key of keys) {
    const direct = asString(body[key])
    if (direct) return direct
    const fromFields = fields[key.toLowerCase()]
    if (fromFields) return fromFields
  }
  return ''
}

export function parseFormType(value: string): MetaFormTypeCode {
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (!key) return 'STUDY_ABROAD'
  if (key.includes('scholarship')) return 'SCHOLARSHIP'
  if (key.includes('ielts') || key.includes('language')) return 'IELTS'
  if (key.includes('event') || key.includes('webinar') || key.includes('fair')) return 'EVENT'
  if (key.includes('country')) return 'COUNTRY_SPECIFIC'
  if (key === 'study_abroad' || key.includes('consult')) return 'STUDY_ABROAD'
  if (
    key === 'study_abroad' ||
    key === 'country_specific' ||
    key === 'scholarship' ||
    key === 'ielts' ||
    key === 'event'
  ) {
    return key.toUpperCase() as MetaFormTypeCode
  }
  return 'STUDY_ABROAD'
}

export function parsePlatform(value: string, fallback: MetaPlatformCode = 'FACEBOOK'): MetaPlatformCode {
  const key = value.trim().toLowerCase()
  if (!key) return fallback
  if (key.includes('instagram') || key === 'ig' || key === 'ig_ads') return 'INSTAGRAM'
  if (key.includes('facebook') || key === 'fb' || key === 'fb_ads') return 'FACEBOOK'
  return fallback
}

export function parseMetaLeadPayload(
  body: Record<string, unknown>,
  fallbackPlatform: MetaPlatformCode = 'FACEBOOK',
): ParsedMetaLead {
  const fields = fieldMap(body)
  const platform = parsePlatform(
    pick(body, fields, ['platform', 'source', 'publisher_platform']),
    fallbackPlatform,
  )
  const formRaw = pick(body, fields, ['formType', 'form_type', 'formName', 'form_name', 'form'])
  const formType = parseFormType(formRaw)
  const fullName = asOptionalString(pick(body, fields, ['fullName', 'full_name', 'name', 'senderName']), 120)
  const phone = asOptionalString(
    pick(body, fields, ['phone', 'phone_number', 'phoneNumber', 'senderPhone', 'mobile', 'mobile_number']),
    40,
  )
  const phoneNormalized = phone ? normalizePhone(phone) : null
  const emailRaw = asOptionalString(pick(body, fields, ['email', 'senderEmail', 'email_address']), 200)
  const email = emailRaw ? emailRaw.toLowerCase() : null
  const whatsapp = asOptionalString(
    pick(body, fields, ['whatsapp', 'whatsappNumber', 'whatsapp_number', 'whatsappNumber']),
    40,
  )
  const campaignIdRaw = pick(body, fields, ['metaCampaignId', 'campaign_id', 'campaignId'])
  const crmCampaignId = UUID_RE.test(campaignIdRaw) ? campaignIdRaw : null
  const metaCampaignId = campaignIdRaw && !crmCampaignId ? campaignIdRaw : asOptionalString(body.metaCampaignId, 80)
  const campaignName = asOptionalString(
    pick(body, fields, ['campaign', 'campaignName', 'campaign_name']),
    160,
  )
  const adSetName = asOptionalString(pick(body, fields, ['adSetName', 'adset_name', 'ad_set_name', 'adsetName']), 160)
  const adName = asOptionalString(
    pick(body, fields, ['adName', 'ad_name', 'advertisementName', 'advertisement_name', 'adName']),
    160,
  )
  const externalId = asOptionalString(
    pick(body, fields, ['externalId', 'leadgen_id', 'leadgenId', 'submissionId', 'id']),
    200,
  )
  const hasCampaignData = Boolean(campaignName || metaCampaignId || crmCampaignId || adSetName || adName)
  const emailOk = !email || isValidEmail(email)
  const phoneOk = Boolean(phoneNormalized && phoneNormalized.length >= 8)
  const complete = Boolean(fullName && phoneOk && emailOk)

  return {
    platform,
    formType,
    formLabel: formTypeLabel(formType),
    externalId,
    fullName,
    phone,
    phoneNormalized: phoneOk ? phoneNormalized : null,
    email: emailOk ? email : null,
    whatsapp: whatsapp ? normalizePhone(whatsapp) : null,
    currentEducation: asOptionalString(
      pick(body, fields, ['currentEducation', 'current_education', 'education', 'highestQualificationCode']),
      80,
    ),
    preferredCountryCode: asOptionalString(
      pick(body, fields, ['preferredCountryCode', 'preferred_country', 'preferredCountry', 'country']),
      40,
    )?.toUpperCase() || null,
    preferredIntake: asOptionalString(
      pick(body, fields, ['preferredIntake', 'preferredIntakeCode', 'preferred_intake', 'intake']),
      40,
    ),
    campaignName,
    metaCampaignId,
    crmCampaignId,
    adSetName,
    adName,
    receivedAt: asOptionalString(pick(body, fields, ['eventAt', 'created_time', 'receivedAt', 'dateReceived']), 40),
    hasCampaignData,
    complete,
    rawPayload: {
      ...body,
      _crm: {
        platform,
        formType,
        formLabel: formTypeLabel(formType),
        adSetName,
        adName,
        metaCampaignId,
        campaignName,
      },
    },
  }
}

export function isMetaPageWebhook(body: Record<string, unknown>) {
  return body.object === 'page' && Array.isArray(body.entry)
}

export type LeadgenRef = {
  leadgenId: string
  formId: string | null
  adId: string | null
  pageId: string | null
  createdTime: string | null
}

export function collectLeadgenRefs(body: Record<string, unknown>): LeadgenRef[] {
  const refs: LeadgenRef[] = []
  const entries = Array.isArray(body.entry) ? body.entry : []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const changes = Array.isArray((entry as Record<string, unknown>).changes)
      ? ((entry as Record<string, unknown>).changes as unknown[])
      : []
    for (const change of changes) {
      if (!change || typeof change !== 'object') continue
      const record = change as Record<string, unknown>
      if (asString(record.field) && asString(record.field) !== 'leadgen') continue
      const value = record.value
      if (!value || typeof value !== 'object') continue
      const lead = value as Record<string, unknown>
      const leadgenId = asString(lead.leadgen_id) || asString(lead.leadgenId)
      if (!leadgenId) continue
      refs.push({
        leadgenId,
        formId: asString(lead.form_id) || null,
        adId: asString(lead.ad_id) || null,
        pageId: asString(lead.page_id) || null,
        createdTime: asString(lead.created_time) || null,
      })
    }
  }
  return refs
}
