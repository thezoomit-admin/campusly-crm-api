import type { CommunicationChannel, CommunicationStatus, Prisma } from '../../lib/prisma-client'
import { writeAuditLog } from '../../lib/audit'
import { httpError } from '../../lib/http-error'
import { prisma } from '../../lib/prisma'
import { hasPermission } from '../auth/access'
import type { AuthContext } from '../auth/session.service'
import { createNotification } from '../notifications/notifications.service'
import { nextLeadCode } from '../leads/lead-code'
import {
  COMMUNICATION_CHANNEL,
  COMMUNICATION_SOURCE,
  createAttributionData,
  ensureLeadAttribution,
  findActiveCampaign,
  recordCampaignTouch,
  repeatAttributionData,
  resolveIncomingAttribution,
} from '../leads/lead-attribution'
import { resolveCountryAssignment } from '../leads/leads.assignment'
import { createSystemFollowUp, daysFromNow } from '../follow-ups/system-follow-up'
import { websiteFormLabel } from '../integrations/website-forms'
import {
  asOptionalString,
  asString,
  assertCanViewLead,
  isValidEmail,
  leadScopeWhere,
  normalizePhone,
  titleCaseName,
} from '../leads/leads.helpers'

export type IngestInput = {
  channel: CommunicationChannel
  senderName?: string
  senderPhone?: string
  senderEmail?: string
  preferredCountryCode?: string
  subject?: string
  message?: string
  sourceCode?: string
  channelCode?: string
  campaign?: string
  campaignId?: string
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  utmContent?: string
  utmTerm?: string
  landingPageUrl?: string
  phoneCountryCode?: string
  whatsapp?: string
  whatsappSameAsPhone?: boolean
  currentLocation?: string
  highestQualificationCode?: string
  preferredIntakeCode?: string
  preferredDegreeCode?: string
  direction?: string
  externalId?: string
  formName?: string
  eventAt?: string | Date
  leadId?: string
  rawPayload?: Record<string, unknown>
}

const CHANNEL_SOURCE = COMMUNICATION_SOURCE

function isMetaChannel(channel: CommunicationChannel) {
  return channel === 'META_FACEBOOK' || channel === 'META_INSTAGRAM'
}

function metaPlatformLabel(channel: CommunicationChannel) {
  return channel === 'META_INSTAGRAM' ? 'Instagram' : 'Facebook'
}

function readMetaAds(raw: Prisma.JsonValue | null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { adSetName: null as string | null, adName: null as string | null, formLabel: null as string | null }
  }
  const body = raw as Record<string, unknown>
  const nested =
    body._crm && typeof body._crm === 'object' && !Array.isArray(body._crm)
      ? (body._crm as Record<string, unknown>)
      : body
  return {
    adSetName: asString(nested.adSetName) || asString(nested.adset_name) || null,
    adName: asString(nested.adName) || asString(nested.ad_name) || asString(nested.advertisementName) || null,
    formLabel: asString(nested.formLabel) || null,
  }
}

const CHANNEL_ACTIVITY: Record<CommunicationChannel, 'WHATSAPP' | 'EMAIL' | 'MESSAGE' | 'NOTE'> = {
  WEBSITE: 'MESSAGE',
  WHATSAPP: 'WHATSAPP',
  EMAIL: 'EMAIL',
  META_FACEBOOK: 'NOTE',
  META_INSTAGRAM: 'NOTE',
}

const TIMELINE_LABEL: Record<CommunicationChannel, string> = {
  WEBSITE: 'Website enquiry received',
  WHATSAPP: 'WhatsApp message received',
  EMAIL: 'Email received',
  META_FACEBOOK: 'Facebook Lead Form submitted',
  META_INSTAGRAM: 'Instagram Lead Form submitted',
}

const NOTIFY_TYPE: Record<CommunicationChannel, string> = {
  WEBSITE: 'new_website_enquiry',
  WHATSAPP: 'new_whatsapp_message',
  EMAIL: 'new_email',
  META_FACEBOOK: 'new_meta_lead',
  META_INSTAGRAM: 'new_meta_lead',
}

function serializeEvent(
  event: Prisma.CommunicationEventGetPayload<{
    include: {
      lead: { select: { id: true; code: true; name: true; ownerId: true; ownerName: true; status: true } }
      campaign: { select: { id: true; code: true; name: true } }
    }
  }>,
) {
  return {
    id: event.id,
    channel: event.channel,
    eventAt: event.eventAt.toISOString(),
    senderName: event.senderName,
    senderPhone: event.senderPhone,
    senderEmail: event.senderEmail,
    preferredCountryCode: event.preferredCountryCode,
    subject: event.subject,
    message: event.message,
    sourceCode: event.sourceCode,
    campaignName: event.campaignName,
    campaign: event.campaign
      ? { id: event.campaign.id, code: event.campaign.code, name: event.campaign.name }
      : null,
    utmSource: event.utmSource,
    utmMedium: event.utmMedium,
    utmCampaign: event.utmCampaign,
    landingPageUrl: event.landingPageUrl,
    phoneCountryCode: event.phoneCountryCode,
    whatsapp: event.whatsapp,
    whatsappSameAsPhone: event.whatsappSameAsPhone,
    currentLocation: event.currentLocation,
    highestQualificationCode: event.highestQualificationCode,
    preferredIntakeCode: event.preferredIntakeCode,
    preferredDegreeCode: event.preferredDegreeCode,
    direction: event.direction,
    externalId: event.externalId,
    formName: event.formName,
    processingStatus: event.processingStatus,
    processingError: event.processingError,
    leadId: event.leadId,
    leadCreated: event.leadCreated,
    activityId: event.activityId,
    processedAt: event.processedAt ? event.processedAt.toISOString() : null,
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
    lead: event.lead
      ? {
          id: event.lead.id,
          code: event.lead.code,
          name: event.lead.name,
          ownerId: event.lead.ownerId,
          ownerName: event.lead.ownerName,
          status: event.lead.status,
        }
      : null,
  }
}

const eventInclude = {
  lead: { select: { id: true, code: true, name: true, ownerId: true, ownerName: true, status: true } },
  campaign: { select: { id: true, code: true, name: true } },
} as const

export async function resolveSystemActorId(preferUserId?: string | null) {
  if (preferUserId) return preferUserId
  const admin = await prisma.user.findFirst({
    where: { primaryRole: { key: 'admin' }, status: 'ACTIVE' },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })
  if (admin) return admin.id
  const any = await prisma.user.findFirst({
    where: { status: 'ACTIVE' },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })
  if (!any) throw httpError.badRequest('No active user available to attribute communication activity.')
  return any.id
}

export async function findManagers() {
  return prisma.user.findMany({
    where: {
      status: 'ACTIVE',
      primaryRole: { key: { in: ['manager', 'admin', 'ceo'] } },
    },
    select: { id: true },
  })
}

function phoneMatchesLead(
  phoneNormalized: string | null | undefined,
  lead: { phoneNormalized?: string | null; phone?: string | null; whatsapp?: string | null },
) {
  if (!phoneNormalized || phoneNormalized.length < 8) return false
  const suffix = phoneNormalized.slice(-10)
  if (lead.phoneNormalized === phoneNormalized) return true
  if (lead.phoneNormalized && lead.phoneNormalized.endsWith(suffix)) return true
  if (phoneNormalized.endsWith((lead.phoneNormalized || '').slice(-10)) && (lead.phoneNormalized || '').length >= 8) {
    return true
  }
  if (lead.phone && lead.phone.includes(suffix)) return true
  if (lead.whatsapp && lead.whatsapp.includes(suffix)) return true
  return false
}

async function resolvePrimaryLead(lead: { id: string; duplicateOfLeadId: string | null }) {
  let current = lead
  for (let i = 0; i < 5; i += 1) {
    if (!current.duplicateOfLeadId) return current
    const parent = await prisma.lead.findUnique({
      where: { id: current.duplicateOfLeadId },
      select: { id: true, duplicateOfLeadId: true },
    })
    if (!parent) return current
    current = parent
  }
  return current
}

async function matchExistingLead(input: {
  leadId?: string | null
  phoneNormalized?: string | null
  email?: string | null
  externalLeadId?: string | null
}) {
  if (input.externalLeadId) {
    const byExternal = await prisma.lead.findUnique({ where: { externalLeadId: input.externalLeadId } })
    if (byExternal && !byExternal.archivedAt) return byExternal
  }
  if (input.leadId) {
    const byId = await prisma.lead.findUnique({ where: { id: input.leadId } })
    if (byId && !byId.archivedAt) return byId
  }

  if (input.phoneNormalized && input.phoneNormalized.length >= 8) {
    const suffix = input.phoneNormalized.slice(-10)
    const byPhone = await prisma.lead.findFirst({
      where: {
        archivedAt: null,
        OR: [
          { phoneNormalized: input.phoneNormalized },
          { phoneNormalized: { endsWith: suffix } },
          { phone: { contains: suffix } },
          { whatsapp: { contains: suffix } },
        ],
      },
      orderBy: { createdAt: 'asc' },
    })
    if (byPhone) return byPhone
  }

  if (input.email) {
    const byEmail = await prisma.lead.findFirst({
      where: { archivedAt: null, email: { equals: input.email, mode: 'insensitive' } },
      orderBy: { createdAt: 'asc' },
    })
    if (byEmail) return byEmail
  }

  return null
}

async function resolveCampaign(input: {
  campaignId?: string | null
  campaignName?: string | null
  utmCampaign?: string | null
  sourceCode?: string | null
}) {
  return findActiveCampaign(input)
}

async function resolveCountry(code: string | null) {
  if (!code) return { code: null as string | null, name: null as string | null }
  const item = await prisma.masterDataItem.findFirst({
    where: {
      categoryKey: 'COUNTRY',
      OR: [{ code: { equals: code, mode: 'insensitive' } }, { name: { equals: code, mode: 'insensitive' } }],
      status: 'ACTIVE',
    },
  })
  return { code: item?.code || code.toUpperCase(), name: item?.name || code }
}

async function resolveMasterCode(categoryKey: string, code: string | null | undefined) {
  if (!code) return null
  const item = await prisma.masterDataItem.findFirst({
    where: {
      categoryKey,
      status: 'ACTIVE',
      OR: [
        { code: { equals: code, mode: 'insensitive' } },
        { name: { equals: code, mode: 'insensitive' } },
      ],
    },
  })
  return item?.code || code.toUpperCase()
}

function formatEnquiryTimeline(opts: {
  channel: CommunicationChannel
  name: string
  countryName: string | null
  formName: string | null
  eventAt: Date
  leadCreated: boolean
}) {
  if (isMetaChannel(opts.channel)) {
    const form = opts.formName ? ` — Form: ${opts.formName}` : ''
    return `Meta Lead Received — Name: ${opts.name} — Platform: ${metaPlatformLabel(opts.channel)}${form}`
  }
  if (opts.channel !== 'WEBSITE') {
    return opts.leadCreated
      ? `${TIMELINE_LABEL[opts.channel]} — new lead created`
      : TIMELINE_LABEL[opts.channel]
  }
  const time = opts.eventAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const country = opts.countryName || 'N/A'
  const form = websiteFormLabel(opts.formName)
  return `Website Enquiry Received — Name: ${opts.name} — Country: ${country} — Source: Website — Form: ${form} — Time: ${time}`
}

function fillIfEmpty<T>(current: T | null | undefined, next: T | null | undefined): T | undefined {
  if (current !== null && current !== undefined && current !== '') return undefined
  if (next === null || next === undefined || next === '') return undefined
  return next
}

function channelNotifyTitle(channel: CommunicationChannel, leadCreated: boolean) {
  if (isMetaChannel(channel)) return 'New Meta Lead Received'
  if (leadCreated) return 'New Lead Created'
  if (channel === 'WHATSAPP') return 'New WhatsApp Message'
  if (channel === 'EMAIL') return 'New Email'
  if (channel === 'WEBSITE') return 'New Website Enquiry'
  return 'New Meta Lead'
}

async function notifyCommunication(opts: {
  leadId: string
  leadCode: string
  leadName: string
  ownerId: string | null
  channel: CommunicationChannel
  leadCreated: boolean
  assigned: boolean
}) {
  const recipients = new Set<string>()
  if (opts.ownerId) recipients.add(opts.ownerId)
  else {
    for (const manager of await findManagers()) recipients.add(manager.id)
  }

  const link = `/leads/${opts.leadId}`
  const body = opts.leadCreated
    ? `Lead ${opts.leadCode} (${opts.leadName}) was created from ${opts.channel.replace('_', ' ').toLowerCase()}.`
    : `New ${opts.channel.replace(/_/g, ' ').toLowerCase()} communication for ${opts.leadCode} (${opts.leadName}).`

  for (const userId of recipients) {
    await createNotification({
      userId,
      title: channelNotifyTitle(opts.channel, opts.leadCreated),
      body,
      link,
      type: opts.leadCreated ? 'new_lead_created' : NOTIFY_TYPE[opts.channel],
      leadId: opts.leadId,
      dedupeKey: `comm:${opts.leadId}:${opts.channel}:${Date.now()}:${userId}`,
    })
  }

  if (opts.assigned && opts.ownerId) {
    await createNotification({
      userId: opts.ownerId,
      title: isMetaChannel(opts.channel) ? 'Lead Assigned' : 'Assignment Completed',
      body: `Lead ${opts.leadCode} has been assigned to you.`,
      link,
      type: 'assignment_completed',
      leadId: opts.leadId,
      dedupeKey: `assign-comm:${opts.leadId}:${opts.ownerId}`,
    })
  }
}

async function processEvent(eventId: string) {
  const event = await prisma.communicationEvent.findUnique({ where: { id: eventId } })
  if (!event) throw httpError.notFound('Communication not found.')

  if (event.processingStatus === 'PROCESSED' || event.processingStatus === 'DUPLICATE') {
    throw httpError.conflict('Communication has already been processed.')
  }

  await prisma.communicationEvent.update({
    where: { id: eventId },
    data: { processingStatus: 'PROCESSING', processingError: null },
  })

  try {
    if (isMetaChannel(event.channel) && (!event.senderName?.trim() || !event.senderPhoneNormalized)) {
      throw httpError.badRequest('Unable to process Meta Lead.')
    }

    if (!event.senderPhoneNormalized && !event.senderEmail) {
      throw httpError.badRequest(
        isMetaChannel(event.channel) ? 'Unable to process Meta Lead.' : 'Unable to identify the sender information.',
      )
    }

    await ensureLeadAttribution()
    const sourceCode = event.sourceCode || CHANNEL_SOURCE[event.channel]
    const channelCode = event.channelCode || COMMUNICATION_CHANNEL[event.channel]
    const attribution = await resolveIncomingAttribution({
      sourceCode,
      channelCode,
      campaignId: event.campaignId,
      campaignName: event.campaignName,
      utmSource: event.utmSource,
      utmMedium: event.utmMedium,
      utmCampaign: event.utmCampaign,
      utmContent: event.utmContent,
      utmTerm: event.utmTerm,
      landingPageUrl: event.landingPageUrl,
      externalLeadId: event.externalId,
    })
    const matched = await matchExistingLead({
      leadId: event.leadId,
      phoneNormalized: event.senderPhoneNormalized,
      email: event.senderEmail,
      externalLeadId: attribution.externalLeadId,
    })

    const matchedByExplicitId = Boolean(event.leadId && matched && matched.id === event.leadId)
    const matchedByExternal = Boolean(
      attribution.externalLeadId && matched?.externalLeadId && matched.externalLeadId === attribution.externalLeadId,
    )
    const phoneMatched = Boolean(matched && phoneMatchesLead(event.senderPhoneNormalized, matched))
    // Inbound phone matches create a new lead (flagged duplicate). Explicit link / same external id still update.
    const createAsPhoneDuplicate = Boolean(matched && phoneMatched && !matchedByExplicitId && !matchedByExternal)
    const shouldUpdateExisting = Boolean(matched && !createAsPhoneDuplicate)

    const country = await resolveCountry(event.preferredCountryCode)
    const actorId = await resolveSystemActorId(matched?.ownerId || matched?.createdById)
    const enquiryAt = event.eventAt || new Date()

    const educationCode = await resolveMasterCode('EDUCATION_LEVEL', event.highestQualificationCode)
    const intakeCode = await resolveMasterCode('INTAKE', event.preferredIntakeCode)
    const degreeCode = await resolveMasterCode('STUDY_LEVEL', event.preferredDegreeCode)

    const whatsappSameAsPhone =
      event.whatsappSameAsPhone ??
      (event.channel === 'WHATSAPP' ||
        Boolean(event.whatsapp && event.senderPhoneNormalized && event.whatsapp === event.senderPhoneNormalized))
    const whatsappValue =
      event.whatsapp ||
      (event.channel === 'WHATSAPP' ? event.senderPhoneNormalized : null) ||
      (whatsappSameAsPhone ? event.senderPhoneNormalized : null)

    let leadId = shouldUpdateExisting ? matched?.id || null : null
    let leadCreated = false
    let createdAsDuplicate = false
    let assignedNow = false
    let enteredPool = false
    let leadCode = shouldUpdateExisting ? matched?.code || '' : ''
    let leadName = shouldUpdateExisting ? matched?.name || '' : ''
    let ownerId = shouldUpdateExisting ? matched?.ownerId || null : null

    if (shouldUpdateExisting && matched) {
      await prisma.lead.update({
        where: { id: matched.id },
        data: {
          updatedAt: new Date(),
          lastEnquiryAt: enquiryAt,
          ...repeatAttributionData(matched, attribution),
          ...(fillIfEmpty(matched.email, event.senderEmail) !== undefined
            ? { email: event.senderEmail }
            : {}),
          ...(fillIfEmpty(matched.phone, event.senderPhone) !== undefined
            ? {
                phone: event.senderPhone,
                phoneNormalized: event.senderPhoneNormalized,
              }
            : {}),
          ...(fillIfEmpty(matched.phoneCountryCode, event.phoneCountryCode) !== undefined
            ? { phoneCountryCode: event.phoneCountryCode }
            : {}),
          ...(fillIfEmpty(matched.whatsapp, whatsappValue) !== undefined
            ? { whatsapp: whatsappValue, whatsappSameAsPhone: Boolean(whatsappSameAsPhone) }
            : {}),
          ...(fillIfEmpty(matched.currentLocation, event.currentLocation) !== undefined
            ? { currentLocation: event.currentLocation }
            : {}),
          ...(fillIfEmpty(matched.preferredCountryCode, country.code) !== undefined
            ? { preferredCountryCode: country.code, country: country.name }
            : {}),
          ...(fillIfEmpty(matched.highestQualificationCode, educationCode) !== undefined
            ? { highestQualificationCode: educationCode }
            : {}),
          ...(fillIfEmpty(matched.preferredIntakeCode, intakeCode) !== undefined
            ? { preferredIntakeCode: intakeCode }
            : {}),
          ...(fillIfEmpty(matched.preferredDegreeCode, degreeCode) !== undefined
            ? { preferredDegreeCode: degreeCode }
            : {}),
          ...(fillIfEmpty(matched.landingPageUrl, event.landingPageUrl) !== undefined
            ? { landingPageUrl: event.landingPageUrl }
            : {}),
          ...(fillIfEmpty(matched.remarks, event.message ? event.message.slice(0, 1000) : null) !== undefined
            ? { remarks: event.message!.slice(0, 1000) }
            : {}),
          ...(matched.sourceCode
            ? {}
            : {
                sourceCode: attribution.sourceCode,
                source: attribution.sourceLabel,
                channelCode: attribution.channelCode,
                sourceLocked: true,
              }),
        },
      })
      await recordCampaignTouch(prisma, {
        leadId: matched.id,
        sourceCode: attribution.sourceCode,
        channelCode: attribution.channelCode,
        campaignId: attribution.campaignId,
        campaignName: attribution.campaignName,
        externalLeadId: attribution.externalLeadId,
        receivedAt: enquiryAt,
        utmSource: attribution.utmSource,
        utmMedium: attribution.utmMedium,
        utmCampaign: attribution.utmCampaign,
        utmContent: attribution.utmContent,
        utmTerm: attribution.utmTerm,
      })
    } else {
      const duplicateOf =
        createAsPhoneDuplicate && matched ? await resolvePrimaryLead(matched) : null
      const assignment = await resolveCountryAssignment(country.code)
      const newStatus = await prisma.masterDataItem.findUnique({
        where: { categoryKey_code: { categoryKey: 'LEAD_STATUS', code: 'NEW' } },
      })
      const code = await nextLeadCode()
      const name =
        titleCaseName(event.senderName || '') ||
        event.senderEmail ||
        event.senderPhone ||
        'Unknown Lead'

      const created = await prisma.$transaction(async (tx) => {
        const lead = await tx.lead.create({
          data: {
            code,
            name,
            phone: event.senderPhone,
            phoneNormalized: event.senderPhoneNormalized,
            phoneCountryCode: event.phoneCountryCode,
            email: event.senderEmail,
            preferredCountryCode: country.code,
            country: country.name,
            currentLocation: event.currentLocation,
            highestQualificationCode: educationCode,
            preferredIntakeCode: intakeCode,
            preferredDegreeCode: degreeCode,
            ...createAttributionData(attribution, enquiryAt, true),
            landingPageUrl: attribution.landingPageUrl || event.landingPageUrl,
            remarks: event.message ? event.message.slice(0, 1000) : null,
            status: newStatus?.name || 'New',
            statusCode: newStatus?.code || 'NEW',
            ownerId: assignment.ownerId,
            ownerName: assignment.ownerName,
            assignedCountryTeamId: assignment.teamId,
            createdById: actorId,
            updatedById: actorId,
            sourceLocked: true,
            whatsappSameAsPhone: Boolean(whatsappSameAsPhone),
            whatsapp: whatsappValue,
            lastEnquiryAt: enquiryAt,
            isDuplicate: Boolean(duplicateOf),
            duplicateOfLeadId: duplicateOf?.id || null,
          },
        })

        await tx.leadAssignment.create({
          data: {
            leadId: lead.id,
            toOwnerId: assignment.ownerId,
            teamId: assignment.teamId,
            kind: assignment.ownerId ? 'REASSIGN' : 'POOL_ASSIGN',
            reason: assignment.ownerId
              ? 'Country-based assignment from Communication Hub'
              : 'Entered lead pool from Communication Hub',
            createdById: actorId,
          },
        })

        await tx.leadStatusHistory.create({
          data: {
            leadId: lead.id,
            previousStatus: null,
            previousStatusCode: null,
            newStatus: lead.status,
            newStatusCode: lead.statusCode || 'NEW',
            createdById: actorId,
          },
        })

        await recordCampaignTouch(tx, {
          leadId: lead.id,
          sourceCode: attribution.sourceCode,
          channelCode: attribution.channelCode,
          campaignId: attribution.campaignId,
          campaignName: attribution.campaignName,
          externalLeadId: attribution.externalLeadId,
          receivedAt: enquiryAt,
          utmSource: attribution.utmSource,
          utmMedium: attribution.utmMedium,
          utmCampaign: attribution.utmCampaign,
          utmContent: attribution.utmContent,
          utmTerm: attribution.utmTerm,
        })

        return lead
      })

      leadId = created.id
      leadCreated = true
      createdAsDuplicate = Boolean(duplicateOf)
      assignedNow = Boolean(assignment.ownerId)
      enteredPool = !assignment.ownerId
      leadCode = created.code
      leadName = created.name
      ownerId = created.ownerId

      if (assignedNow && ownerId) {
        try {
          await createSystemFollowUp({
            leadId: created.id,
            contactName: created.name,
            type: 'Call',
            purpose: 'Initial Contact',
            nextAction: 'Make first contact call',
            dueAt: daysFromNow(1),
            priority: 'Medium',
            ownerId,
            ownerName: created.ownerName,
            reason: isMetaChannel(event.channel)
              ? 'Meta Lead Assigned — First Follow-up'
              : event.channel === 'WEBSITE'
                ? 'Website Lead Assigned — First Follow-up'
                : `${TIMELINE_LABEL[event.channel]} — First Follow-up`,
            actorUserId: actorId,
          })
        } catch (error) {
          console.error('[communications] Auto follow-up on assign failed:', error)
        }
      }
    }

    if (!leadId) throw httpError.badRequest('Unable to process the communication.')

    const direction = event.direction === 'outgoing' ? 'Outgoing' : 'Incoming'
    const notes =
      event.message ||
      event.subject ||
      `${direction} ${TIMELINE_LABEL[event.channel]}${event.formName ? ` (${websiteFormLabel(event.formName)})` : ''}`

    const timelineNotes = [
      formatEnquiryTimeline({
        channel: event.channel,
        name: leadName,
        countryName: country.name,
        formName: event.formName,
        eventAt: enquiryAt,
        leadCreated,
      }),
      attribution.campaignName ? `Campaign: ${attribution.campaignName}` : null,
      attribution.unmapped ? 'Source: Other / Unmapped' : null,
    ]
      .filter(Boolean)
      .join(' — ')

    const activity = await prisma.activity.create({
      data: {
        type: CHANNEL_ACTIVITY[event.channel],
        userId: ownerId || actorId,
        relatedName: leadName,
        relatedType: 'lead',
        relatedId: leadId,
        outcome: leadCreated
          ? createdAsDuplicate
            ? 'Duplicate Lead Created'
            : 'Lead Created'
          : 'Lead Updated',
        notes,
        occurredAt: enquiryAt,
        metadata: {
          source: 'communication_hub',
          channel: event.channel,
          direction: event.direction,
          communicationEventId: event.id,
          formName: event.formName,
          subject: event.subject,
          landingPageUrl: event.landingPageUrl,
          duplicate: createdAsDuplicate || !leadCreated,
          createdAsDuplicate,
        },
      },
    })

    await prisma.activity.create({
      data: {
        type: 'NOTE',
        userId: ownerId || actorId,
        relatedName: leadName,
        relatedType: 'lead',
        relatedId: leadId,
        outcome: 'Timeline',
        notes: timelineNotes,
        occurredAt: enquiryAt,
        metadata: {
          source: 'communication_hub',
          communicationEventId: event.id,
          timeline: true,
          channel: event.channel,
          formName: event.formName,
        },
      },
    })

    const metaAds = isMetaChannel(event.channel) ? readMetaAds(event.rawPayload) : null
    if (metaAds && leadCreated) {
      await prisma.activity.create({
        data: {
          type: 'NOTE',
          userId: actorId,
          relatedName: leadName,
          relatedType: 'lead',
          relatedId: leadId,
          outcome: 'Lead Created',
          notes: event.channel === 'META_INSTAGRAM' ? 'Instagram Lead Created' : 'Facebook Lead Created',
          occurredAt: enquiryAt,
          metadata: { source: 'communication_hub', communicationEventId: event.id, timeline: true },
        },
      })
    }
    if (metaAds && (event.campaignName || metaAds.adSetName || metaAds.adName)) {
      await prisma.activity.create({
        data: {
          type: 'NOTE',
          userId: actorId,
          relatedName: leadName,
          relatedType: 'lead',
          relatedId: leadId,
          outcome: 'Campaign',
          notes: `Campaign Information Added — Campaign: ${event.campaignName || 'N/A'} — Ad Set: ${metaAds.adSetName || 'N/A'} — Advertisement: ${metaAds.adName || 'N/A'}`,
          occurredAt: enquiryAt,
          metadata: { source: 'communication_hub', communicationEventId: event.id, timeline: true },
        },
      })
    }

    if (assignedNow && ownerId) {
      const assigneeName =
        (await prisma.user.findUnique({ where: { id: ownerId }, select: { fullName: true } }))?.fullName ||
        'Call Executive'
      await prisma.activity.create({
        data: {
          type: 'NOTE',
          userId: actorId,
          relatedName: leadName,
          relatedType: 'lead',
          relatedId: leadId,
          outcome: 'Assigned',
          notes: isMetaChannel(event.channel) ? `Lead Assigned — ${assigneeName}` : `Lead assigned to ${assigneeName}`,
          occurredAt: new Date(),
          metadata: { source: 'communication_hub', communicationEventId: event.id, timeline: true },
        },
      })
      if (isMetaChannel(event.channel)) {
        await prisma.activity.create({
          data: {
            type: 'NOTE',
            userId: actorId,
            relatedName: leadName,
            relatedType: 'lead',
            relatedId: leadId,
            outcome: 'Follow-up',
            notes: 'Employee Follow-up Started',
            occurredAt: new Date(),
            metadata: { source: 'communication_hub', communicationEventId: event.id, timeline: true },
          },
        })
        await createNotification({
          userId: ownerId,
          title: 'Follow-up Pending',
          body: `Follow-up is pending for ${leadCode} (${leadName}).`,
          link: `/leads/${leadId}`,
          type: 'follow_up_pending',
          leadId,
          dedupeKey: `meta-follow-up:${event.id}:${ownerId}`,
        }).catch(() => undefined)
      }
    }

    if (enteredPool) {
      await prisma.activity.create({
        data: {
          type: 'NOTE',
          userId: actorId,
          relatedName: leadName,
          relatedType: 'lead',
          relatedId: leadId,
          outcome: 'Lead Pool',
          notes: isMetaChannel(event.channel)
            ? 'Lead Waiting in Lead Pool'
            : 'Lead entered Lead Pool — no matching country assignee available',
          occurredAt: new Date(),
          metadata: { source: 'communication_hub', communicationEventId: event.id, timeline: true },
        },
      })
    }

    const finalStatus: CommunicationStatus = leadCreated ? 'PROCESSED' : 'DUPLICATE'

    const updated = await prisma.communicationEvent.update({
      where: { id: event.id },
      data: {
        processingStatus: finalStatus,
        leadId,
        leadCreated,
        activityId: activity.id,
        campaignId: attribution.campaignId || event.campaignId,
        campaignName: attribution.campaignName || event.campaignName,
        sourceCode,
        processedAt: new Date(),
        processingError: null,
      },
      include: eventInclude,
    })

    await writeAuditLog({
      userId: actorId,
      action: leadCreated ? 'COMMUNICATION_LEAD_CREATED' : 'COMMUNICATION_LEAD_UPDATED',
      entityType: 'communication_event',
      entityId: event.id,
      metadata: {
        channel: event.channel,
        leadId,
        leadCreated,
        status: finalStatus,
      },
    })

    await notifyCommunication({
      leadId,
      leadCode,
      leadName,
      ownerId,
      channel: event.channel,
      leadCreated,
      assigned: assignedNow,
    })

    if (!isMetaChannel(event.channel)) {
      await createNotification({
        userId: ownerId || (await findManagers())[0]?.id || actorId,
        title: 'New Communication Received',
        body: `${TIMELINE_LABEL[event.channel]} for ${leadCode}.`,
        link: `/leads/${leadId}`,
        type: 'new_communication_received',
        leadId,
        dedupeKey: `comm-received:${event.id}`,
      }).catch(() => undefined)
    }

    if (enteredPool) {
      for (const manager of await findManagers()) {
        await createNotification({
          userId: manager.id,
          title: isMetaChannel(event.channel) ? 'Lead Waiting in Lead Pool' : 'Lead Entered Pool',
          body: isMetaChannel(event.channel)
            ? `${leadCode} (${leadName}) is waiting in the Lead Pool.`
            : `${leadCode} (${leadName}) entered the Lead Pool from a website enquiry.`,
          link: `/leads/pool`,
          type: 'lead_pool_entered',
          leadId,
          dedupeKey: `lead-pool:${event.id}:${manager.id}`,
        }).catch(() => undefined)
      }
    }

    return serializeEvent(updated)
  } catch (error) {
    const message =
      error && typeof error === 'object' && 'message' in error
        ? String((error as { message: unknown }).message)
        : 'Unable to process the communication.'

    await prisma.communicationEvent.update({
      where: { id: eventId },
      data: {
        processingStatus: 'FAILED',
        processingError: message.slice(0, 2000),
      },
    })

    throw error
  }
}

export async function ingestCommunication(input: IngestInput) {
  await ensureLeadAttribution()
  const channel = input.channel
  const senderPhone = asOptionalString(input.senderPhone, 40)
  const phoneNormalized = senderPhone ? normalizePhone(senderPhone) : null
  const senderEmailRaw = asOptionalString(input.senderEmail, 200)
  const senderEmail = senderEmailRaw ? senderEmailRaw.toLowerCase() : null
  if (senderEmail && !isValidEmail(senderEmail)) {
    throw httpError.badRequest('Unable to identify the sender information.')
  }

  const externalId = asOptionalString(input.externalId, 200)
  if (externalId) {
    const existing = await prisma.communicationEvent.findUnique({
      where: { channel_externalId: { channel, externalId } },
      include: eventInclude,
    })
    if (existing) {
      if (existing.processingStatus === 'FAILED' || existing.processingStatus === 'PENDING') {
        return { event: await processEvent(existing.id), created: false, reprocessed: true }
      }
      return { event: serializeEvent(existing), created: false, reprocessed: false }
    }
  }

  const sourceCode = asOptionalString(input.sourceCode, 40)?.toUpperCase() || CHANNEL_SOURCE[channel]
  const campaign = await resolveCampaign({
    campaignId: asOptionalString(input.campaignId, 80),
    campaignName: asOptionalString(input.campaign, 160),
    utmCampaign: asOptionalString(input.utmCampaign, 160),
    sourceCode,
  })

  const whatsappRaw = asOptionalString(input.whatsapp, 40)
  const whatsappNormalized = whatsappRaw ? normalizePhone(whatsappRaw) : null
  const whatsappSameAsPhone =
    typeof input.whatsappSameAsPhone === 'boolean'
      ? input.whatsappSameAsPhone
      : Boolean(whatsappNormalized && phoneNormalized && whatsappNormalized === phoneNormalized)

  const event = await prisma.communicationEvent.create({
    data: {
      channel,
      eventAt: input.eventAt ? new Date(input.eventAt) : new Date(),
      senderName: asOptionalString(input.senderName, 120),
      senderPhone,
      senderPhoneNormalized: phoneNormalized,
      senderEmail,
      preferredCountryCode: asOptionalString(input.preferredCountryCode, 40)?.toUpperCase() || null,
      subject: asOptionalString(input.subject, 300),
      message: asOptionalString(input.message, 5000),
      sourceCode,
      channelCode: asOptionalString(input.channelCode, 40)?.toUpperCase() || COMMUNICATION_CHANNEL[channel],
      campaignName: campaign?.name || asOptionalString(input.campaign, 160),
      campaignId: campaign?.id || null,
      utmSource: asOptionalString(input.utmSource, 120) || campaign?.utmSource || null,
      utmMedium: asOptionalString(input.utmMedium, 120) || campaign?.utmMedium || null,
      utmCampaign: asOptionalString(input.utmCampaign, 120) || campaign?.utmCampaign || null,
      utmContent: asOptionalString(input.utmContent, 120),
      utmTerm: asOptionalString(input.utmTerm, 120),
      landingPageUrl: asOptionalString(input.landingPageUrl, 2000),
      phoneCountryCode: asOptionalString(input.phoneCountryCode, 8)?.toUpperCase() || null,
      whatsapp: whatsappNormalized,
      whatsappSameAsPhone,
      currentLocation: asOptionalString(input.currentLocation, 120),
      highestQualificationCode: asOptionalString(input.highestQualificationCode, 40)?.toUpperCase() || null,
      preferredIntakeCode: asOptionalString(input.preferredIntakeCode, 40)?.toUpperCase() || null,
      preferredDegreeCode: asOptionalString(input.preferredDegreeCode, 40)?.toUpperCase() || null,
      direction: asString(input.direction).toLowerCase() === 'outgoing' ? 'outgoing' : 'incoming',
      externalId,
      formName: asOptionalString(input.formName, 120),
      rawPayload: (input.rawPayload as Prisma.InputJsonValue) || undefined,
      processingStatus: 'PENDING',
      leadId: asOptionalString(input.leadId, 80),
    },
  })

  const processed = await processEvent(event.id)
  return { event: processed, created: true, reprocessed: false }
}

export async function listCommunications(
  auth: AuthContext,
  query: {
    search?: string
    channel?: string
    status?: string
    page?: number
    limit?: number
  },
) {
  if (!hasPermission(auth.permissions, 'communication:view')) {
    throw httpError.accessDenied('You do not have permission to access this communication.')
  }

  const page = Math.max(1, query.page || 1)
  const limit = Math.min(50, Math.max(10, query.limit || 10))
  const search = query.search?.trim()
  const channel = query.channel?.trim().toUpperCase()
  const status = query.status?.trim().toUpperCase()
  const leadScope = leadScopeWhere(auth)

  const where: Prisma.CommunicationEventWhereInput = {
    AND: [
      channel ? { channel: channel as CommunicationChannel } : {},
      status ? { processingStatus: status as CommunicationStatus } : {},
      search
        ? {
            OR: [
              { senderName: { contains: search, mode: 'insensitive' } },
              { senderPhone: { contains: search, mode: 'insensitive' } },
              { senderEmail: { contains: search, mode: 'insensitive' } },
              { subject: { contains: search, mode: 'insensitive' } },
              { message: { contains: search, mode: 'insensitive' } },
              { campaignName: { contains: search, mode: 'insensitive' } },
              { lead: { code: { contains: search, mode: 'insensitive' } } },
              { lead: { name: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {},
      {
        OR: [{ leadId: null }, { lead: leadScope }],
      },
    ],
  }

  const [total, rows, pending, failed, processed] = await Promise.all([
    prisma.communicationEvent.count({ where }),
    prisma.communicationEvent.findMany({
      where,
      include: eventInclude,
      orderBy: { eventAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.communicationEvent.count({
      where: { AND: [where, { processingStatus: 'PENDING' }] },
    }),
    prisma.communicationEvent.count({
      where: { AND: [where, { processingStatus: 'FAILED' }] },
    }),
    prisma.communicationEvent.count({
      where: { AND: [where, { processingStatus: { in: ['PROCESSED', 'DUPLICATE'] } }] },
    }),
  ])

  return {
    items: rows.map(serializeEvent),
    total,
    page,
    limit,
    summary: { pending, failed, processed },
  }
}

export async function getCommunication(auth: AuthContext, id: string) {
  if (!hasPermission(auth.permissions, 'communication:view')) {
    throw httpError.accessDenied('You do not have permission to access this communication.')
  }
  const event = await prisma.communicationEvent.findUnique({
    where: { id },
    include: eventInclude,
  })
  if (!event) throw httpError.notFound('Communication not found.')
  if (event.leadId) {
    await assertCanViewLead(auth, event.leadId)
  }
  return { event: serializeEvent(event) }
}

export async function listLeadCommunications(auth: AuthContext, leadId: string) {
  await assertCanViewLead(auth, leadId)
  if (!hasPermission(auth.permissions, 'communication:view') && !hasPermission(auth.permissions, 'lead:view')) {
    throw httpError.accessDenied('You do not have permission to access this communication.')
  }
  const rows = await prisma.communicationEvent.findMany({
    where: { leadId },
    include: eventInclude,
    orderBy: { eventAt: 'desc' },
  })

  const emailEventIds = rows.filter((row) => row.channel === 'EMAIL').map((row) => row.id)
  const crmMessageIds = rows
    .map((row) => (row.externalId?.startsWith('crm-email:') ? row.externalId.slice('crm-email:'.length) : null))
    .filter((id): id is string => Boolean(id))

  const linkedMessages =
    emailEventIds.length || crmMessageIds.length
      ? await prisma.emailMessage.findMany({
          where: {
            OR: [
              ...(emailEventIds.length ? [{ communicationEventId: { in: emailEventIds } }] : []),
              ...(crmMessageIds.length ? [{ id: { in: crmMessageIds } }] : []),
            ],
          },
          select: { id: true, threadId: true, communicationEventId: true },
        })
      : []

  const threadByEventId = new Map<string, string>()
  const threadByMessageId = new Map<string, string>()
  for (const message of linkedMessages) {
    threadByMessageId.set(message.id, message.threadId)
    if (message.communicationEventId) threadByEventId.set(message.communicationEventId, message.threadId)
  }

  const hubItems = rows.map((row) => {
    const serialized = serializeEvent(row)
    const threadId =
      threadByEventId.get(row.id) ||
      (row.externalId?.startsWith('crm-email:')
        ? threadByMessageId.get(row.externalId.slice('crm-email:'.length))
        : undefined) ||
      null
    return { ...serialized, threadId }
  })
  const linkedEventIds = new Set(rows.map((row) => row.id))
  const hubExternalIds = new Set(rows.map((row) => row.externalId).filter(Boolean) as string[])

  const emailMessages = await prisma.emailMessage.findMany({
    where: { thread: { leadId } },
    orderBy: { sentAt: 'desc' },
    take: 200,
    select: {
      id: true,
      direction: true,
      subject: true,
      bodyText: true,
      fromEmail: true,
      fromName: true,
      toEmail: true,
      sentAt: true,
      communicationEventId: true,
      deliveryStatus: true,
      threadId: true,
    },
  })

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { id: true, code: true, name: true, ownerId: true, ownerName: true, status: true },
  })

  const synthetic = emailMessages
    .filter((message) => {
      if (message.communicationEventId && linkedEventIds.has(message.communicationEventId)) return false
      if (hubExternalIds.has(`crm-email:${message.id}`)) return false
      if (hubExternalIds.has(message.id)) return false
      return true
    })
    .map((message) => {
      const outgoing = message.direction === 'outgoing'
      const bounced = message.deliveryStatus === 'bounced' || message.deliveryStatus === 'failed'
      return {
        id: `email:${message.id}`,
        channel: 'EMAIL' as const,
        eventAt: message.sentAt.toISOString(),
        senderName: message.fromName,
        senderPhone: null,
        senderEmail: message.fromEmail,
        preferredCountryCode: null,
        subject: message.subject,
        message: message.bodyText,
        sourceCode: 'EMAIL_CRM',
        campaignName: null,
        campaign: null,
        utmSource: null,
        utmMedium: null,
        utmCampaign: null,
        landingPageUrl: null,
        phoneCountryCode: null,
        whatsapp: null,
        whatsappSameAsPhone: null,
        currentLocation: null,
        highestQualificationCode: null,
        preferredIntakeCode: null,
        preferredDegreeCode: null,
        direction: outgoing ? 'outgoing' : 'incoming',
        externalId: `crm-email:${message.id}`,
        formName: bounced
          ? outgoing
            ? 'CRM outbound (failed)'
            : 'Email'
          : outgoing
            ? 'CRM outbound'
            : 'Student reply',
        processingStatus: 'PROCESSED' as const,
        processingError: null,
        leadId,
        leadCreated: false,
        activityId: null,
        processedAt: message.sentAt.toISOString(),
        createdAt: message.sentAt.toISOString(),
        updatedAt: message.sentAt.toISOString(),
        lead: lead
          ? {
              id: lead.id,
              code: lead.code,
              name: lead.name,
              ownerId: lead.ownerId,
              ownerName: lead.ownerName,
              status: lead.status,
            }
          : null,
        threadId: message.threadId,
      }
    })

  const items = [...hubItems, ...synthetic].sort(
    (a, b) => new Date(b.eventAt).getTime() - new Date(a.eventAt).getTime(),
  )

  return { items, total: items.length }
}

export async function reprocessCommunication(auth: AuthContext, id: string) {
  if (!hasPermission(auth.permissions, 'communication:reprocess')) {
    throw httpError.accessDenied('You do not have permission to access this communication.')
  }
  const event = await prisma.communicationEvent.findUnique({ where: { id } })
  if (!event) throw httpError.notFound('Communication not found.')
  if (event.processingStatus === 'PROCESSED' || event.processingStatus === 'DUPLICATE') {
    throw httpError.conflict('Communication has already been processed.')
  }
  await prisma.communicationEvent.update({
    where: { id },
    data: { processingStatus: 'PENDING', processingError: null },
  })
  const processed = await processEvent(id)
  return { event: processed, message: 'Communication reprocessed successfully.' }
}

export function normalizeWebhookBody(
  channel: CommunicationChannel,
  body: Record<string, unknown>,
): IngestInput {
  const phone = asString(body.phone) || asString(body.senderPhone) || asString(body.from)
  const email = asString(body.email) || asString(body.senderEmail)
  const name = asString(body.name) || asString(body.senderName) || asString(body.full_name)
  const message =
    asString(body.message) || asString(body.body) || asString(body.content) || asString(body.notes)
  const subject = asString(body.subject)
  const country =
    asString(body.preferredCountryCode) ||
    asString(body.country) ||
    asString(body.preferred_country) ||
    asString(body.preferredCountry)
  const sameAsPhone =
    body.whatsappSameAsPhone === true ||
    body.whatsapp_same_as_phone === true ||
    String(body.whatsappSameAsPhone || '').toLowerCase() === 'true'

  return {
    channel,
    senderName: name || undefined,
    senderPhone: phone || undefined,
    senderEmail: email || undefined,
    preferredCountryCode: country || undefined,
    subject: subject || undefined,
    message: message || undefined,
    sourceCode: asString(body.sourceCode) || undefined,
    campaign: asString(body.campaign) || asString(body.campaign_name) || undefined,
    campaignId: asString(body.campaignId) || undefined,
    utmSource: asString(body.utmSource) || asString(body.utm_source) || undefined,
    utmMedium: asString(body.utmMedium) || asString(body.utm_medium) || undefined,
    utmCampaign: asString(body.utmCampaign) || asString(body.utm_campaign) || undefined,
    landingPageUrl:
      asString(body.landingPageUrl) ||
      asString(body.landing_page_url) ||
      asString(body.landingPage) ||
      asString(body.pageUrl) ||
      undefined,
    phoneCountryCode: asString(body.phoneCountryCode) || undefined,
    whatsapp: asString(body.whatsapp) || asString(body.whatsappNumber) || undefined,
    whatsappSameAsPhone: sameAsPhone,
    currentLocation: asString(body.currentLocation) || asString(body.location) || undefined,
    highestQualificationCode:
      asString(body.highestQualificationCode) ||
      asString(body.currentEducation) ||
      asString(body.educationLevel) ||
      undefined,
    preferredIntakeCode: asString(body.preferredIntakeCode) || asString(body.intake) || undefined,
    preferredDegreeCode:
      asString(body.preferredDegreeCode) || asString(body.studyLevel) || asString(body.preferred_degree) || undefined,
    direction: asString(body.direction) || 'incoming',
    externalId:
      asString(body.externalId) ||
      asString(body.id) ||
      asString(body.messageId) ||
      asString(body.submissionId) ||
      undefined,
    formName: asString(body.formName) || asString(body.form_name) || asString(body.form) || undefined,
    eventAt: asString(body.eventAt) || asString(body.occurredAt) || asString(body.created_time) || undefined,
    leadId: asString(body.leadId) || undefined,
    rawPayload: body,
  }
}
