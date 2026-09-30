import { randomUUID } from 'node:crypto'
import type { CommunicationChannel, MetaFormType, MetaPlatform, Prisma } from '../../lib/prisma-client'
import { config } from '../../config'
import { httpError } from '../../lib/http-error'
import { prisma } from '../../lib/prisma'
import { hasPermission } from '../auth/access'
import { ROLE_DEFAULTS } from '../auth/permission-catalog'
import type { AuthContext } from '../auth/session.service'
import { ingestCommunication } from '../communications/communications.service'
import { recordCampaignTouch } from '../leads/lead-attribution'
import { assertCanViewLead, leadScopeWhere } from '../leads/leads.helpers'
import {
  CONVERTED_STATUS_CODES,
  META_FORM_TYPES,
  META_MESSAGES,
  formTypeLabel,
  platformLabel,
  channelCodeForPlatform,
  sourceCodeForPlatform,
  type MetaPlatformCode,
} from './meta-leads.constants'
import { parseMetaLeadPayload, type ParsedMetaLead } from './meta-leads.parse'

const metaInclude = {
  lead: {
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      statusCode: true,
      ownerId: true,
      ownerName: true,
      source: true,
      sourceCode: true,
      latestSource: true,
    },
  },
  campaign: { select: { id: true, code: true, name: true } },
} as const

type MetaRow = Prisma.MetaLeadGetPayload<{ include: typeof metaInclude }>

function eventDate(value: string | null) {
  if (!value) return new Date()
  const asNumber = Number(value)
  const date =
    Number.isFinite(asNumber) && asNumber > 1_000_000_000
      ? new Date(asNumber < 10_000_000_000 ? asNumber * 1000 : asNumber)
      : new Date(value)
  return Number.isNaN(date.getTime()) ? new Date() : date
}

function channelFor(platform: MetaPlatformCode): CommunicationChannel {
  return platform === 'INSTAGRAM' ? 'META_INSTAGRAM' : 'META_FACEBOOK'
}

function outcomeMessage(duplicate: boolean, pooled: boolean) {
  if (duplicate) return META_MESSAGES.duplicate
  if (pooled) return META_MESSAGES.pool
  return META_MESSAGES.received
}

export function serializeMetaLead(row: MetaRow) {
  return {
    id: row.id,
    platform: row.platform,
    platformLabel: platformLabel(row.platform),
    formType: row.formType,
    formLabel: formTypeLabel(row.formType),
    externalId: row.externalId,
    fullName: row.fullName,
    phone: row.phone,
    email: row.email,
    whatsapp: row.whatsapp,
    currentEducation: row.currentEducation,
    preferredCountryCode: row.preferredCountryCode,
    preferredIntake: row.preferredIntake,
    campaignName: row.campaignName,
    metaCampaignId: row.metaCampaignId,
    adSetName: row.adSetName,
    adName: row.adName,
    campaign: row.campaign,
    receivedAt: row.receivedAt.toISOString(),
    processingStatus: row.processingStatus,
    processingError: row.processingError,
    message: row.message,
    duplicate: row.duplicate,
    pooled: row.pooled,
    leadId: row.leadId,
    communicationEventId: row.communicationEventId,
    createdAt: row.createdAt.toISOString(),
    lead: row.lead,
  }
}

let setupPromise: Promise<void> | null = null

export function ensureMetaSetup() {
  if (!setupPromise) {
    setupPromise = setupMeta().catch((error) => {
      setupPromise = null
      throw error
    })
  }
  return setupPromise
}

async function setupMeta() {
  const sources = [
    { code: 'FACEBOOK_LEAD_ADS', name: 'Facebook Lead Ads', sortOrder: 10 },
    { code: 'INSTAGRAM_LEAD_ADS', name: 'Instagram Lead Ads', sortOrder: 11 },
  ]
  for (const item of sources) {
    await prisma.masterDataItem.upsert({
      where: { categoryKey_code: { categoryKey: 'LEAD_SOURCE', code: item.code } },
      update: {
        name: item.name,
        nameNormalized: item.name.toLowerCase(),
        sortOrder: item.sortOrder,
        isSystem: true,
        status: 'ACTIVE',
      },
      create: {
        categoryKey: 'LEAD_SOURCE',
        code: item.code,
        name: item.name,
        nameNormalized: item.name.toLowerCase(),
        sortOrder: item.sortOrder,
        isSystem: true,
        description: 'System-generated Meta Lead Ads source. Not editable by normal users.',
      },
    })
  }

  const existing = await prisma.role.findUnique({ where: { key: 'marketing_manager' } })
  if (existing) return
  const defaults = ROLE_DEFAULTS.marketing_manager
  const role = await prisma.role.create({
    data: {
      key: 'marketing_manager',
      name: defaults.name,
      description: defaults.description,
      status: 'ACTIVE',
    },
  })
  if (defaults.permissions === 'all') return
  const permissions = await prisma.permission.findMany({
    where: {
      OR: defaults.permissions.map((key) => {
        const [resource, action] = key.split(':')
        return { resource, action }
      }),
    },
  })
  if (!permissions.length) return
  await prisma.rolePermission.createMany({
    data: permissions.map((permission) => ({ roleId: role.id, permissionId: permission.id })),
    skipDuplicates: true,
  })
}

function assertCanViewMeta(auth: AuthContext) {
  if (!hasPermission(auth.permissions, ['communication:view', 'campaign:view', 'lead:view'])) {
    throw httpError.accessDenied(META_MESSAGES.denied)
  }
}

function metaScopeWhere(auth: AuthContext): Prisma.MetaLeadWhereInput {
  const scope = leadScopeWhere(auth)
  if (Object.keys(scope).length === 0) return {}
  return { lead: scope }
}

function listWhere(
  auth: AuthContext,
  query: {
    search?: string
    platform?: string
    formType?: string
    country?: string
    campaign?: string
    outcome?: string
  },
): Prisma.MetaLeadWhereInput {
  const search = query.search?.trim()
  const platform = query.platform?.trim().toUpperCase()
  const formType = query.formType?.trim().toUpperCase()
  const outcome = query.outcome?.trim().toLowerCase()
  return {
    AND: [
      metaScopeWhere(auth),
      platform === 'FACEBOOK' || platform === 'INSTAGRAM' ? { platform: platform as MetaPlatform } : {},
      META_FORM_TYPES.some((item) => item.value === formType) ? { formType: formType as MetaFormType } : {},
      query.country?.trim()
        ? { preferredCountryCode: { equals: query.country.trim(), mode: 'insensitive' } }
        : {},
      query.campaign?.trim()
        ? { campaignName: { contains: query.campaign.trim(), mode: 'insensitive' } }
        : {},
      outcome === 'duplicate' ? { duplicate: true } : {},
      outcome === 'pool' ? { pooled: true } : {},
      outcome === 'failed' ? { processingStatus: 'FAILED' } : {},
      outcome === 'created' ? { duplicate: false, pooled: false, processingStatus: 'PROCESSED' } : {},
      search
        ? {
            OR: [
              { fullName: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
              { campaignName: { contains: search, mode: 'insensitive' } },
              { adSetName: { contains: search, mode: 'insensitive' } },
              { adName: { contains: search, mode: 'insensitive' } },
              { lead: { code: { contains: search, mode: 'insensitive' } } },
              { lead: { name: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {},
    ],
  }
}

async function recordFailure(parsed: ParsedMetaLead, externalId: string, message: string) {
  const channel = channelFor(parsed.platform)
  const existingEvent = await prisma.communicationEvent.findUnique({
    where: { channel_externalId: { channel, externalId } },
  })
  const event =
    existingEvent ||
    (await prisma.communicationEvent.create({
      data: {
        channel,
        eventAt: eventDate(parsed.receivedAt),
        senderName: parsed.fullName,
        senderPhone: parsed.phone,
        senderPhoneNormalized: parsed.phoneNormalized,
        senderEmail: parsed.email,
        preferredCountryCode: parsed.preferredCountryCode,
        sourceCode: sourceCodeForPlatform(parsed.platform),
        campaignName: parsed.campaignName,
        formName: parsed.formLabel,
        externalId,
        rawPayload: parsed.rawPayload as Prisma.InputJsonValue,
        processingStatus: 'FAILED',
        processingError: message,
        highestQualificationCode: parsed.currentEducation,
        preferredIntakeCode: parsed.preferredIntake,
        whatsapp: parsed.whatsapp,
      },
    }))

  if (existingEvent && existingEvent.processingStatus !== 'FAILED') {
    await prisma.communicationEvent.update({
      where: { id: existingEvent.id },
      data: { processingStatus: 'FAILED', processingError: message },
    })
  }

  const saved = await upsertMetaRecord(parsed, {
    externalId,
    processingStatus: 'FAILED',
    processingError: message,
    message,
    duplicate: false,
    pooled: false,
    communicationEventId: event.id,
    leadId: event.leadId,
    campaignId: null,
  })
  return saved
}

async function upsertMetaRecord(
  parsed: ParsedMetaLead,
  extra: {
    externalId: string
    processingStatus: 'PENDING' | 'PROCESSING' | 'PROCESSED' | 'FAILED' | 'DUPLICATE'
    processingError?: string | null
    message: string
    duplicate: boolean
    pooled: boolean
    communicationEventId: string | null
    leadId: string | null
    campaignId: string | null
  },
) {
  const data = {
    platform: parsed.platform as MetaPlatform,
    formType: parsed.formType as MetaFormType,
    externalId: extra.externalId,
    fullName: parsed.fullName,
    phone: parsed.phone,
    phoneNormalized: parsed.phoneNormalized,
    email: parsed.email,
    whatsapp: parsed.whatsapp,
    currentEducation: parsed.currentEducation,
    preferredCountryCode: parsed.preferredCountryCode,
    preferredIntake: parsed.preferredIntake,
    campaignName: parsed.campaignName,
    metaCampaignId: parsed.metaCampaignId,
    adSetName: parsed.adSetName,
    adName: parsed.adName,
    campaignId: extra.campaignId,
    receivedAt: eventDate(parsed.receivedAt),
    processingStatus: extra.processingStatus,
    processingError: extra.processingError || null,
    message: extra.message,
    duplicate: extra.duplicate,
    pooled: extra.pooled,
    leadId: extra.leadId,
    communicationEventId: extra.communicationEventId,
    rawPayload: parsed.rawPayload as Prisma.InputJsonValue,
  }

  const existing = await prisma.metaLead.findUnique({
    where: { platform_externalId: { platform: parsed.platform, externalId: extra.externalId } },
  })
  if (existing) {
    return prisma.metaLead.update({
      where: { id: existing.id },
      data,
      include: metaInclude,
    })
  }
  return prisma.metaLead.create({ data, include: metaInclude })
}

async function attachCampaignTouch(row: MetaRow, parsed: ParsedMetaLead) {
  if (!row.leadId) return
  await recordCampaignTouch(prisma, {
    leadId: row.leadId,
    metaLeadId: row.id,
    platform: parsed.platform,
    formType: parsed.formType as MetaFormType,
    campaignName: parsed.campaignName,
    metaCampaignId: parsed.metaCampaignId,
    adSetName: parsed.adSetName,
    adName: parsed.adName,
    sourceCode: sourceCodeForPlatform(parsed.platform),
    channelCode: channelCodeForPlatform(parsed.platform),
    campaignId: row.campaignId,
    externalLeadId: row.externalId,
    receivedAt: row.receivedAt,
  })
}

export async function receiveMetaLead(body: Record<string, unknown>, fallbackPlatform: MetaPlatformCode = 'FACEBOOK') {
  await ensureMetaSetup()
  const parsed = parseMetaLeadPayload(body, fallbackPlatform)
  const externalId = parsed.externalId || `meta-${randomUUID()}`

  const prior = parsed.externalId
    ? await prisma.metaLead.findUnique({
        where: { platform_externalId: { platform: parsed.platform, externalId } },
        include: metaInclude,
      })
    : null
  if (prior && prior.processingStatus !== 'FAILED' && prior.processingStatus !== 'PENDING') {
    return {
      created: false,
      duplicate: prior.duplicate,
      pooled: prior.pooled,
      message: prior.message || outcomeMessage(prior.duplicate, prior.pooled),
      campaignMessage: parsed.hasCampaignData ? null : META_MESSAGES.campaignUnavailable,
      metaLead: serializeMetaLead(prior),
    }
  }

  if (!parsed.complete) {
    await recordFailure(parsed, externalId, META_MESSAGES.incomplete)
    throw httpError.badRequest(META_MESSAGES.incomplete)
  }

  if (prior?.communicationEventId) {
    await prisma.communicationEvent.update({
      where: { id: prior.communicationEventId },
      data: {
        processingStatus: 'PENDING',
        processingError: null,
        senderName: parsed.fullName,
        senderPhone: parsed.phone,
        senderPhoneNormalized: parsed.phoneNormalized,
        senderEmail: parsed.email,
        preferredCountryCode: parsed.preferredCountryCode,
        campaignName: parsed.campaignName,
        formName: parsed.formLabel,
        whatsapp: parsed.whatsapp,
        highestQualificationCode: parsed.currentEducation,
        preferredIntakeCode: parsed.preferredIntake,
        rawPayload: parsed.rawPayload as Prisma.InputJsonValue,
        sourceCode: sourceCodeForPlatform(parsed.platform),
      },
    })
  }

  try {
    const result = await ingestCommunication({
      channel: channelFor(parsed.platform),
      senderName: parsed.fullName || undefined,
      senderPhone: parsed.phone || undefined,
      senderEmail: parsed.email || undefined,
      preferredCountryCode: parsed.preferredCountryCode || undefined,
      whatsapp: parsed.whatsapp || undefined,
      highestQualificationCode: parsed.currentEducation || undefined,
      preferredIntakeCode: parsed.preferredIntake || undefined,
      campaign: parsed.campaignName || undefined,
      campaignId: parsed.crmCampaignId || undefined,
      utmCampaign: parsed.campaignName || undefined,
      utmSource: parsed.platform === 'INSTAGRAM' ? 'instagram' : 'facebook',
      utmMedium: 'lead_ad',
      sourceCode: sourceCodeForPlatform(parsed.platform),
      formName: parsed.formLabel,
      externalId,
      eventAt: eventDate(parsed.receivedAt).toISOString(),
      rawPayload: parsed.rawPayload,
    })

    const duplicate = !result.event.leadCreated
    const pooled = Boolean(result.event.leadCreated && result.event.lead && !result.event.lead.ownerId)
    const message = outcomeMessage(duplicate, pooled)
    const campaignMessage = parsed.hasCampaignData ? null : META_MESSAGES.campaignUnavailable
    const saved = await upsertMetaRecord(parsed, {
      externalId,
      processingStatus: duplicate ? 'DUPLICATE' : 'PROCESSED',
      message,
      duplicate,
      pooled,
      communicationEventId: result.event.id,
      leadId: result.event.leadId,
      campaignId: result.event.campaign?.id || parsed.crmCampaignId,
    })
    await attachCampaignTouch(saved, parsed)

    return {
      created: result.created && !duplicate,
      duplicate,
      pooled,
      message,
      campaignMessage,
      metaLead: serializeMetaLead(saved),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : META_MESSAGES.incomplete
    const channel = channelFor(parsed.platform)
    const event = await prisma.communicationEvent.findUnique({
      where: { channel_externalId: { channel, externalId } },
    })
    await upsertMetaRecord(parsed, {
      externalId,
      processingStatus: 'FAILED',
      processingError: message,
      message: message || META_MESSAGES.incomplete,
      duplicate: false,
      pooled: false,
      communicationEventId: event?.id || null,
      leadId: event?.leadId || null,
      campaignId: null,
    }).catch(() => undefined)
    throw error
  }
}

export function metaSettings() {
  return {
    mockMode: !config.meta.pageAccessToken,
    webhookPath: '/api/webhooks/meta',
    platforms: [
      { value: 'FACEBOOK', label: 'Facebook Lead Ads' },
      { value: 'INSTAGRAM', label: 'Instagram Lead Ads' },
    ],
    formTypes: META_FORM_TYPES,
  }
}

export async function listMetaLeads(
  auth: AuthContext,
  query: {
    search?: string
    platform?: string
    formType?: string
    country?: string
    campaign?: string
    outcome?: string
    page?: number
    limit?: number
  },
) {
  assertCanViewMeta(auth)
  await ensureMetaSetup()
  const page = Math.max(1, query.page || 1)
  const limit = Math.min(50, Math.max(10, query.limit || 10))
  const where = listWhere(auth, query)
  const [total, rows] = await Promise.all([
    prisma.metaLead.count({ where }),
    prisma.metaLead.findMany({
      where,
      include: metaInclude,
      orderBy: { receivedAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ])
  return { items: rows.map(serializeMetaLead), total, page, limit }
}

export async function getMetaLead(auth: AuthContext, id: string) {
  assertCanViewMeta(auth)
  const row = await prisma.metaLead.findUnique({ where: { id }, include: metaInclude })
  if (!row) throw httpError.notFound('Meta lead not found.')
  if (row.leadId) await assertCanViewLead(auth, row.leadId)
  else if (Object.keys(leadScopeWhere(auth)).length > 0) throw httpError.notFound('Meta lead not found.')
  return { metaLead: serializeMetaLead(row) }
}

export async function listLeadCampaignTouches(auth: AuthContext, leadId: string) {
  await assertCanViewLead(auth, leadId)
  const rows = await prisma.leadCampaignTouch.findMany({
    where: { leadId },
    orderBy: { receivedAt: 'desc' },
  })
  return {
    items: rows.map((row) => ({
      id: row.id,
      platform: row.platform,
      platformLabel: platformLabel(row.platform),
      formType: row.formType,
      formLabel: formTypeLabel(row.formType),
      campaignName: row.campaignName,
      metaCampaignId: row.metaCampaignId,
      adSetName: row.adSetName,
      adName: row.adName,
      sourceCode: row.sourceCode,
      channelCode: row.channelCode,
      receivedAt: row.receivedAt.toISOString(),
    })),
    total: rows.length,
  }
}

function rate(converted: number, total: number) {
  if (!total) return 0
  return Math.round((converted / total) * 1000) / 10
}

export async function metaPerformance(
  auth: AuthContext,
  query: { platform?: string; country?: string; campaign?: string },
) {
  assertCanViewMeta(auth)
  await ensureMetaSetup()
  const where = listWhere(auth, query)
  const rows = await prisma.metaLead.findMany({
    where: { AND: [where, { processingStatus: { in: ['PROCESSED', 'DUPLICATE'] } }, { leadId: { not: null } }] },
    select: {
      platform: true,
      campaignName: true,
      preferredCountryCode: true,
      leadId: true,
      lead: { select: { statusCode: true, preferredCountryCode: true } },
    },
  })

  const bucket = () => ({ generated: 0, contacted: 0, converted: 0, lost: 0 })
  const totals = bucket()
  const byPlatform = new Map<string, ReturnType<typeof bucket>>()
  const byCountry = new Map<string, ReturnType<typeof bucket>>()
  const byCampaign = new Map<string, ReturnType<typeof bucket>>()
  const seenTotals = new Set<string>()
  const seenPlatform = new Map<string, Set<string>>()
  const seenCountry = new Map<string, Set<string>>()
  const seenCampaign = new Map<string, Set<string>>()

  for (const row of rows) {
    const leadId = row.leadId
    if (!leadId) continue
    const status = row.lead?.statusCode || ''
    const contacted = Boolean(status && status !== 'NEW')
    const converted = (CONVERTED_STATUS_CODES as readonly string[]).includes(status)
    const lost = status === 'LOST'
    const apply = (target: ReturnType<typeof bucket>) => {
      target.generated += 1
      if (contacted) target.contacted += 1
      if (converted) target.converted += 1
      if (lost) target.lost += 1
    }
    const once = (seen: Map<string, Set<string>>, key: string, store: Map<string, ReturnType<typeof bucket>>) => {
      const ids = seen.get(key) || new Set<string>()
      if (ids.has(leadId)) return
      ids.add(leadId)
      seen.set(key, ids)
      const current = store.get(key) || bucket()
      apply(current)
      store.set(key, current)
    }
    if (!seenTotals.has(leadId)) {
      seenTotals.add(leadId)
      apply(totals)
    }
    once(seenPlatform, row.platform, byPlatform)
    once(seenCountry, row.lead?.preferredCountryCode || row.preferredCountryCode || 'Unspecified', byCountry)
    once(seenCampaign, row.campaignName || 'Unattributed', byCampaign)
  }

  const toItems = (map: Map<string, ReturnType<typeof bucket>>, labelFor?: (key: string) => string) =>
    [...map.entries()]
      .map(([key, value]) => ({
        key,
        label: labelFor ? labelFor(key) : key,
        ...value,
        conversionRate: rate(value.converted, value.generated),
      }))
      .sort((a, b) => b.generated - a.generated)

  return {
    totals: { ...totals, conversionRate: rate(totals.converted, totals.generated) },
    byPlatform: toItems(byPlatform, platformLabel),
    byCountry: toItems(byCountry),
    byCampaign: toItems(byCampaign),
  }
}
