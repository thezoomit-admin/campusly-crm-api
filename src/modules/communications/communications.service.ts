import type { CommunicationChannel, CommunicationStatus, Prisma } from '../../lib/prisma-client'
import { writeAuditLog } from '../../lib/audit'
import { httpError } from '../../lib/http-error'
import { prisma } from '../../lib/prisma'
import { hasPermission } from '../auth/access'
import type { AuthContext } from '../auth/session.service'
import { createNotification } from '../notifications/notifications.service'
import { nextLeadCode } from '../leads/lead-code'
import { resolveCountryAssignment } from '../leads/leads.assignment'
import {
  asOptionalString,
  asString,
  assertCanViewLead,
  isValidEmail,
  leadScopeWhere,
  normalizePhone,
  titleCaseName,
} from '../leads/leads.helpers'

type IngestInput = {
  channel: CommunicationChannel
  senderName?: string
  senderPhone?: string
  senderEmail?: string
  preferredCountryCode?: string
  subject?: string
  message?: string
  sourceCode?: string
  campaign?: string
  campaignId?: string
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  direction?: string
  externalId?: string
  formName?: string
  eventAt?: string | Date
  leadId?: string
  rawPayload?: Record<string, unknown>
}

const CHANNEL_SOURCE: Record<CommunicationChannel, string> = {
  WEBSITE: 'WEBSITE',
  WHATSAPP: 'WHATSAPP',
  EMAIL: 'EMAIL',
  META_FACEBOOK: 'META',
  META_INSTAGRAM: 'META',
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

async function resolveSystemActorId(preferUserId?: string | null) {
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

async function findManagers() {
  return prisma.user.findMany({
    where: {
      status: 'ACTIVE',
      primaryRole: { key: { in: ['manager', 'admin', 'ceo'] } },
    },
    select: { id: true },
  })
}

async function matchExistingLead(input: {
  leadId?: string | null
  phoneNormalized?: string | null
  email?: string | null
}) {
  if (input.leadId) {
    const byId = await prisma.lead.findUnique({ where: { id: input.leadId } })
    if (byId) return byId
  }

  if (input.phoneNormalized && input.phoneNormalized.length >= 8) {
    const suffix = input.phoneNormalized.slice(-10)
    const byPhone = await prisma.lead.findFirst({
      where: {
        OR: [
          { phoneNormalized: input.phoneNormalized },
          { phoneNormalized: { endsWith: suffix } },
          { phone: { contains: suffix } },
          { whatsapp: { contains: suffix } },
        ],
      },
      orderBy: { createdAt: 'desc' },
    })
    if (byPhone) return byPhone
  }

  if (input.email) {
    const byEmail = await prisma.lead.findFirst({
      where: { email: { equals: input.email, mode: 'insensitive' } },
      orderBy: { createdAt: 'desc' },
    })
    if (byEmail) return byEmail
  }

  return null
}

async function resolveCampaign(input: {
  campaignId?: string | null
  campaignName?: string | null
  utmCampaign?: string | null
}) {
  if (input.campaignId) {
    const byId = await prisma.campaign.findUnique({ where: { id: input.campaignId } })
    if (byId) return byId
  }
  const name = input.campaignName || input.utmCampaign
  if (!name) return null
  return prisma.campaign.findFirst({
    where: {
      OR: [
        { name: { equals: name, mode: 'insensitive' } },
        { code: { equals: name, mode: 'insensitive' } },
        { utmCampaign: { equals: name, mode: 'insensitive' } },
      ],
      status: { in: ['ACTIVE', 'PAUSED', 'COMPLETED'] },
    },
    orderBy: { updatedAt: 'desc' },
  })
}

async function resolveSourceLabel(code: string | null) {
  if (!code) return null
  const item = await prisma.masterDataItem.findUnique({
    where: { categoryKey_code: { categoryKey: 'LEAD_SOURCE', code } },
  })
  return item?.name || code
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

function channelNotifyTitle(channel: CommunicationChannel, leadCreated: boolean) {
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
      title: 'Assignment Completed',
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
    if (!event.senderPhoneNormalized && !event.senderEmail) {
      throw httpError.badRequest('Unable to identify the sender information.')
    }

    const matched = await matchExistingLead({
      leadId: event.leadId,
      phoneNormalized: event.senderPhoneNormalized,
      email: event.senderEmail,
    })

    const campaign = await resolveCampaign({
      campaignId: event.campaignId,
      campaignName: event.campaignName,
      utmCampaign: event.utmCampaign,
    })

    const sourceCode = event.sourceCode || CHANNEL_SOURCE[event.channel]
    const sourceLabel = await resolveSourceLabel(sourceCode)
    const country = await resolveCountry(event.preferredCountryCode)
    const actorId = await resolveSystemActorId(matched?.ownerId || matched?.createdById)

    let leadId = matched?.id || null
    let leadCreated = false
    let assignedNow = false
    let leadCode = matched?.code || ''
    let leadName = matched?.name || ''
    let ownerId = matched?.ownerId || null

    if (matched) {
      await prisma.lead.update({
        where: { id: matched.id },
        data: {
          updatedAt: new Date(),
          ...(matched.email || !event.senderEmail ? {} : { email: event.senderEmail }),
          ...(matched.phone || !event.senderPhone
            ? {}
            : {
                phone: event.senderPhone,
                phoneNormalized: event.senderPhoneNormalized,
              }),
          ...(matched.sourceLocked || matched.sourceCode
            ? {}
            : { sourceCode, source: sourceLabel }),
          ...(matched.campaignId || !campaign
            ? matched.campaign || !event.campaignName
              ? {}
              : { campaign: event.campaignName }
            : {
                campaignId: campaign.id,
                campaign: campaign.name,
                utmSource: event.utmSource || campaign.utmSource,
                utmMedium: event.utmMedium || campaign.utmMedium,
                utmCampaign: event.utmCampaign || campaign.utmCampaign,
              }),
        },
      })
    } else {
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
            email: event.senderEmail,
            preferredCountryCode: country.code,
            country: country.name,
            sourceCode,
            source: sourceLabel,
            campaign: campaign?.name || event.campaignName,
            campaignId: campaign?.id || null,
            utmSource: event.utmSource || campaign?.utmSource || null,
            utmMedium: event.utmMedium || campaign?.utmMedium || null,
            utmCampaign: event.utmCampaign || campaign?.utmCampaign || null,
            remarks: event.message ? event.message.slice(0, 1000) : null,
            status: newStatus?.name || 'New',
            statusCode: newStatus?.code || 'NEW',
            ownerId: assignment.ownerId,
            ownerName: assignment.ownerName,
            assignedCountryTeamId: assignment.teamId,
            createdById: actorId,
            updatedById: actorId,
            sourceLocked: true,
            whatsappSameAsPhone: event.channel === 'WHATSAPP',
            whatsapp: event.channel === 'WHATSAPP' ? event.senderPhoneNormalized : null,
          },
        })

        await tx.leadAssignment.create({
          data: {
            leadId: lead.id,
            toOwnerId: assignment.ownerId,
            teamId: assignment.teamId,
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

        return lead
      })

      leadId = created.id
      leadCreated = true
      assignedNow = Boolean(assignment.ownerId)
      leadCode = created.code
      leadName = created.name
      ownerId = created.ownerId
    }

    if (!leadId) throw httpError.badRequest('Unable to process the communication.')

    const direction = event.direction === 'outgoing' ? 'Outgoing' : 'Incoming'
    const notes =
      event.message ||
      event.subject ||
      `${direction} ${TIMELINE_LABEL[event.channel]}${event.formName ? ` (${event.formName})` : ''}`

    const activity = await prisma.activity.create({
      data: {
        type: CHANNEL_ACTIVITY[event.channel],
        userId: ownerId || actorId,
        relatedName: leadName,
        relatedType: 'lead',
        relatedId: leadId,
        outcome: leadCreated ? 'Lead Created' : 'Lead Updated',
        notes,
        occurredAt: event.eventAt,
        metadata: {
          source: 'communication_hub',
          channel: event.channel,
          direction: event.direction,
          communicationEventId: event.id,
          formName: event.formName,
          subject: event.subject,
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
        notes: leadCreated
          ? `${TIMELINE_LABEL[event.channel]} — new lead created`
          : TIMELINE_LABEL[event.channel],
        occurredAt: event.eventAt,
        metadata: {
          source: 'communication_hub',
          communicationEventId: event.id,
          timeline: true,
        },
      },
    })

    if (assignedNow && ownerId) {
      await prisma.activity.create({
        data: {
          type: 'NOTE',
          userId: actorId,
          relatedName: leadName,
          relatedType: 'lead',
          relatedId: leadId,
          outcome: 'Assigned',
          notes: `Lead assigned to ${(await prisma.user.findUnique({ where: { id: ownerId }, select: { fullName: true } }))?.fullName || 'Call Executive'}`,
          occurredAt: new Date(),
          metadata: { source: 'communication_hub', communicationEventId: event.id },
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
        campaignId: campaign?.id || event.campaignId,
        campaignName: campaign?.name || event.campaignName,
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

    await createNotification({
      userId: ownerId || (await findManagers())[0]?.id || actorId,
      title: 'New Communication Received',
      body: `${TIMELINE_LABEL[event.channel]} for ${leadCode}.`,
      link: `/leads/${leadId}`,
      type: 'new_communication_received',
      leadId,
      dedupeKey: `comm-received:${event.id}`,
    }).catch(() => undefined)

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

  const campaign = await resolveCampaign({
    campaignId: asOptionalString(input.campaignId, 80),
    campaignName: asOptionalString(input.campaign, 160),
    utmCampaign: asOptionalString(input.utmCampaign, 160),
  })

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
      sourceCode: asOptionalString(input.sourceCode, 40)?.toUpperCase() || CHANNEL_SOURCE[channel],
      campaignName: campaign?.name || asOptionalString(input.campaign, 160),
      campaignId: campaign?.id || null,
      utmSource: asOptionalString(input.utmSource, 120) || campaign?.utmSource || null,
      utmMedium: asOptionalString(input.utmMedium, 120) || campaign?.utmMedium || null,
      utmCampaign: asOptionalString(input.utmCampaign, 120) || campaign?.utmCampaign || null,
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
  return { items: rows.map(serializeEvent), total: rows.length }
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
    asString(body.preferred_country)

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
    direction: asString(body.direction) || 'incoming',
    externalId: asString(body.externalId) || asString(body.id) || asString(body.messageId) || undefined,
    formName: asString(body.formName) || asString(body.form_name) || asString(body.form) || undefined,
    eventAt: asString(body.eventAt) || asString(body.occurredAt) || asString(body.created_time) || undefined,
    leadId: asString(body.leadId) || undefined,
    rawPayload: body,
  }
}
