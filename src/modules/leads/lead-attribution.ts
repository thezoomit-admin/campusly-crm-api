import type { CommunicationChannel, Prisma } from '../../lib/prisma-client'
import { writeAuditLog } from '../../lib/audit'
import { httpError } from '../../lib/http-error'
import { prisma } from '../../lib/prisma'
import { getMasterDataCategory, MASTER_DATA_SEEDS } from '../master-data/master-data.catalog'
import { hasPermission } from '../auth/access'
import type { AuthContext } from '../auth/session.service'
import { asOptionalString, asString, assertCanViewLead, throwIfInvalid } from './leads.helpers'

type Db = Prisma.TransactionClient | typeof prisma

export const ATTRIBUTION_MESSAGES = {
  sourceRequired: 'Lead source is required.',
  sourceInvalid: 'Selected lead source is not available.',
  campaignInactive: 'Selected campaign is not active.',
  endBeforeStart: 'Campaign end date cannot be before start date.',
  duplicateCampaign: 'A campaign with this name already exists for this source.',
  duplicateExternal: 'This external lead already exists in the CRM.',
  sourceMapping: 'Unable to map the lead source.',
  permission: 'You are not authorized to change the lead source.',
  server: 'Unable to process the request. Please try again.',
  channelInvalid: 'Selected channel is not available for this source.',
  referralBy: 'Referral by is required.',
  reasonRequired: 'Please provide a reason.',
} as const

export const CONVERTED_STATUS_CODES = ['CONVERTED', 'FILE_OPENING_PENDING', 'FILE_OPENED'] as const

/** Sources captured only by integrations. Hidden on the manual lead form. */
export const INTEGRATION_SOURCE_CODES = new Set([
  'WEBSITE',
  'META',
  'WHATSAPP',
  'EMAIL',
  'FACEBOOK_LEAD_ADS',
  'INSTAGRAM_LEAD_ADS',
])

export const COMMUNICATION_SOURCE: Record<CommunicationChannel, string> = {
  WEBSITE: 'WEBSITE',
  WHATSAPP: 'WHATSAPP',
  EMAIL: 'EMAIL',
  META_FACEBOOK: 'META',
  META_INSTAGRAM: 'META',
}

export const COMMUNICATION_CHANNEL: Record<CommunicationChannel, string> = {
  WEBSITE: 'WEBSITE_FORM',
  WHATSAPP: 'WHATSAPP_CONVERSATION',
  EMAIL: 'EMAIL_MESSAGE',
  META_FACEBOOK: 'FACEBOOK_LEAD_FORM',
  META_INSTAGRAM: 'INSTAGRAM_LEAD_FORM',
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type ResolvedAttribution = {
  sourceCode: string
  sourceLabel: string
  channelCode: string | null
  campaignId: string | null
  campaignName: string | null
  utmSource: string | null
  utmMedium: string | null
  utmCampaign: string | null
  utmContent: string | null
  utmTerm: string | null
  landingPageUrl: string | null
  externalLeadId: string | null
  sourceDetails: string | null
  referralBy: string | null
  referralDetails: string | null
  unmapped: boolean
}

type TouchInput = {
  leadId: string
  sourceCode?: string | null
  channelCode?: string | null
  campaignId?: string | null
  campaignName?: string | null
  externalLeadId?: string | null
  receivedAt: Date
  utmSource?: string | null
  utmMedium?: string | null
  utmCampaign?: string | null
  utmContent?: string | null
  utmTerm?: string | null
  metaLeadId?: string | null
  platform?: 'FACEBOOK' | 'INSTAGRAM' | null
  formType?: 'STUDY_ABROAD' | 'COUNTRY_SPECIFIC' | 'SCHOLARSHIP' | 'IELTS' | 'EVENT' | null
  metaCampaignId?: string | null
  adSetName?: string | null
  adName?: string | null
}

let ready: Promise<void> | null = null

export function ensureLeadAttribution() {
  if (!ready) {
    ready = setupLeadAttribution().catch((error) => {
      ready = null
      throw error
    })
  }
  return ready
}

async function setupLeadAttribution() {
  const sourceSeeds = MASTER_DATA_SEEDS.filter((item) => item.categoryKey === 'LEAD_SOURCE')
  const channelSeeds = MASTER_DATA_SEEDS.filter((item) => item.categoryKey === 'LEAD_CHANNEL')
  for (const item of [...sourceSeeds, ...channelSeeds]) {
    const category = getMasterDataCategory(item.categoryKey)
    const parent =
      category?.parentCategoryKey && item.parentCode
        ? await prisma.masterDataItem.findUnique({
            where: { categoryKey_code: { categoryKey: category.parentCategoryKey, code: item.parentCode } },
          })
        : null
    if (category?.parentCategoryKey && !parent) continue
    await prisma.masterDataItem.upsert({
      where: { categoryKey_code: { categoryKey: item.categoryKey, code: item.code } },
      update: {
        name: item.name,
        nameNormalized: item.name.trim().toLowerCase(),
        description: item.description || null,
        sortOrder: item.sortOrder,
        isSystem: Boolean(item.isSystem),
        parentId: parent?.id ?? null,
        status: 'ACTIVE',
      },
      create: {
        categoryKey: item.categoryKey,
        name: item.name,
        nameNormalized: item.name.trim().toLowerCase(),
        code: item.code,
        description: item.description || null,
        sortOrder: item.sortOrder,
        isSystem: Boolean(item.isSystem),
        parentId: parent?.id ?? null,
      },
    })
  }

  const permission = await prisma.permission.upsert({
    where: { resource_action: { resource: 'lead', action: 'change_source' } },
    update: {
      module: 'Lead Management',
      description: 'Correct a lead source or campaign after creation',
    },
    create: {
      module: 'Lead Management',
      resource: 'lead',
      action: 'change_source',
      description: 'Correct a lead source or campaign after creation',
    },
  })
  const admin = await prisma.role.findUnique({ where: { key: 'admin' } })
  if (admin) {
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: admin.id, permissionId: permission.id } },
      create: { roleId: admin.id, permissionId: permission.id },
      update: {},
    })
  }
}

export async function findActiveCampaign(input: {
  campaignId?: string | null
  campaignName?: string | null
  utmCampaign?: string | null
  sourceCode?: string | null
}) {
  if (input.campaignId) {
    if (!UUID_RE.test(input.campaignId)) return null
    const byId = await prisma.campaign.findUnique({ where: { id: input.campaignId } })
    return byId?.status === 'ACTIVE' ? byId : null
  }
  const name = (input.campaignName || input.utmCampaign || '').trim()
  if (!name) return null
  const rows = await prisma.campaign.findMany({
    where: {
      status: 'ACTIVE',
      OR: [
        { name: { equals: name, mode: 'insensitive' } },
        { code: { equals: name, mode: 'insensitive' } },
        { utmCampaign: { equals: name, mode: 'insensitive' } },
      ],
    },
    orderBy: { updatedAt: 'desc' },
    take: 10,
  })
  if (!rows.length) return null
  const source = input.sourceCode?.toUpperCase()
  if (source) {
    const same = rows.find((row) => (row.sourceCode || '').toUpperCase() === source)
    if (same) return same
  }
  return rows[0]
}

async function activeSource(code: string | null | undefined) {
  const normalized = (code || '').trim().toUpperCase()
  if (!normalized) return null
  const item = await prisma.masterDataItem.findUnique({
    where: { categoryKey_code: { categoryKey: 'LEAD_SOURCE', code: normalized } },
  })
  if (!item || item.status !== 'ACTIVE' || !item.code) return null
  return item
}

async function activeChannel(sourceId: string, code: string | null | undefined) {
  const normalized = (code || '').trim().toUpperCase()
  if (!normalized) return null
  const item = await prisma.masterDataItem.findUnique({
    where: { categoryKey_code: { categoryKey: 'LEAD_CHANNEL', code: normalized } },
  })
  if (!item || item.status !== 'ACTIVE' || item.parentId !== sourceId || !item.code) return null
  return item
}

export async function mapIncomingSource(code: string | null | undefined, details?: string | null) {
  const raw = (code || '').trim()
  const item = await activeSource(raw)
  if (item?.code) {
    return {
      sourceCode: item.code,
      sourceLabel: item.name,
      sourceId: item.id,
      unmapped: false,
      sourceDetails: asOptionalString(details, 500),
    }
  }
  const other = await activeSource('OTHER')
  const note = [raw && raw.toUpperCase() !== 'OTHER' ? `Unmapped source: ${raw}` : null, details?.trim() || null]
    .filter(Boolean)
    .join('. ')
    .slice(0, 500)
  return {
    sourceCode: other?.code || 'OTHER',
    sourceLabel: other?.name || 'Other',
    sourceId: other?.id || null,
    unmapped: true,
    sourceDetails: note || null,
  }
}

export async function resolveIncomingAttribution(input: {
  sourceCode?: string | null
  channelCode?: string | null
  campaignId?: string | null
  campaignName?: string | null
  utmSource?: string | null
  utmMedium?: string | null
  utmCampaign?: string | null
  utmContent?: string | null
  utmTerm?: string | null
  landingPageUrl?: string | null
  externalLeadId?: string | null
  sourceDetails?: string | null
}): Promise<ResolvedAttribution> {
  const mapped = await mapIncomingSource(input.sourceCode, input.sourceDetails)
  let channelCode = input.channelCode?.trim().toUpperCase() || null
  if (mapped.sourceId && channelCode) {
    const channel = await activeChannel(mapped.sourceId, channelCode)
    channelCode = channel?.code || (mapped.unmapped ? 'UNMAPPED' : null)
  }
  if (!channelCode && mapped.unmapped) channelCode = 'UNMAPPED'
  const campaign = await findActiveCampaign({
    campaignId: input.campaignId,
    campaignName: input.campaignName,
    utmCampaign: input.utmCampaign,
    sourceCode: mapped.sourceCode,
  })
  return {
    sourceCode: mapped.sourceCode,
    sourceLabel: mapped.sourceLabel,
    channelCode,
    campaignId: campaign?.id || null,
    campaignName: campaign?.name || asOptionalString(input.campaignName, 160),
    utmSource: asOptionalString(input.utmSource, 120),
    utmMedium: asOptionalString(input.utmMedium, 120),
    utmCampaign: asOptionalString(input.utmCampaign, 120),
    utmContent: asOptionalString(input.utmContent, 120),
    utmTerm: asOptionalString(input.utmTerm, 120),
    landingPageUrl: asOptionalString(input.landingPageUrl, 2000),
    externalLeadId: asOptionalString(input.externalLeadId, 200),
    sourceDetails: mapped.sourceDetails,
    referralBy: null,
    referralDetails: null,
    unmapped: mapped.unmapped,
  }
}

export function createAttributionData(resolved: ResolvedAttribution, receivedAt: Date, sourceLocked: boolean) {
  return {
    source: resolved.sourceLabel,
    sourceCode: resolved.sourceCode,
    channelCode: resolved.channelCode,
    sourceLocked,
    latestSource: resolved.sourceLabel,
    latestSourceCode: resolved.sourceCode,
    latestChannelCode: resolved.channelCode,
    campaign: resolved.campaignName,
    campaignId: resolved.campaignId,
    latestCampaign: resolved.campaignName,
    latestCampaignId: resolved.campaignId,
    utmSource: resolved.utmSource,
    utmMedium: resolved.utmMedium,
    utmCampaign: resolved.utmCampaign,
    utmContent: resolved.utmContent,
    utmTerm: resolved.utmTerm,
    landingPageUrl: resolved.landingPageUrl,
    externalLeadId: resolved.externalLeadId,
    sourceDetails: resolved.sourceDetails,
    referralBy: resolved.referralBy,
    referralDetails: resolved.referralDetails,
    firstTouchAt: receivedAt,
  }
}

export function repeatAttributionData(
  current: {
    externalLeadId?: string | null
    utmSource?: string | null
    utmMedium?: string | null
    utmCampaign?: string | null
    utmContent?: string | null
    utmTerm?: string | null
    landingPageUrl?: string | null
    sourceDetails?: string | null
  },
  resolved: ResolvedAttribution,
) {
  return {
    latestSource: resolved.sourceLabel,
    latestSourceCode: resolved.sourceCode,
    latestChannelCode: resolved.channelCode,
    ...(resolved.campaignName || resolved.campaignId
      ? { latestCampaign: resolved.campaignName, latestCampaignId: resolved.campaignId }
      : {}),
    ...(!current.externalLeadId && resolved.externalLeadId ? { externalLeadId: resolved.externalLeadId } : {}),
    ...(!current.utmSource && resolved.utmSource ? { utmSource: resolved.utmSource } : {}),
    ...(!current.utmMedium && resolved.utmMedium ? { utmMedium: resolved.utmMedium } : {}),
    ...(!current.utmCampaign && resolved.utmCampaign ? { utmCampaign: resolved.utmCampaign } : {}),
    ...(!current.utmContent && resolved.utmContent ? { utmContent: resolved.utmContent } : {}),
    ...(!current.utmTerm && resolved.utmTerm ? { utmTerm: resolved.utmTerm } : {}),
    ...(!current.landingPageUrl && resolved.landingPageUrl ? { landingPageUrl: resolved.landingPageUrl } : {}),
    ...(!current.sourceDetails && resolved.sourceDetails ? { sourceDetails: resolved.sourceDetails } : {}),
  }
}

export async function recordCampaignTouch(db: Db, input: TouchInput) {
  if (input.metaLeadId) {
    const byMeta = await db.leadCampaignTouch.findUnique({ where: { metaLeadId: input.metaLeadId } })
    if (byMeta) return byMeta
  }
  if (input.externalLeadId) {
    const byExternal = await db.leadCampaignTouch.findFirst({
      where: { leadId: input.leadId, externalLeadId: input.externalLeadId },
    })
    if (byExternal) {
      if (input.metaLeadId || input.platform) {
        return db.leadCampaignTouch.update({
          where: { id: byExternal.id },
          data: {
            metaLeadId: input.metaLeadId || undefined,
            platform: input.platform || undefined,
            formType: input.formType || undefined,
            adSetName: input.adSetName || undefined,
            adName: input.adName || undefined,
            metaCampaignId: input.metaCampaignId || undefined,
            campaignId: byExternal.campaignId || input.campaignId || undefined,
            campaignName: byExternal.campaignName || input.campaignName || undefined,
            channelCode: byExternal.channelCode || input.channelCode || undefined,
            sourceCode: byExternal.sourceCode || input.sourceCode || undefined,
          },
        })
      }
      return byExternal
    }
  }
  return db.leadCampaignTouch.create({
    data: {
      leadId: input.leadId,
      sourceCode: input.sourceCode || null,
      channelCode: input.channelCode || null,
      campaignId: input.campaignId || null,
      campaignName: input.campaignName || null,
      externalLeadId: input.externalLeadId || null,
      receivedAt: input.receivedAt,
      utmSource: input.utmSource || null,
      utmMedium: input.utmMedium || null,
      utmCampaign: input.utmCampaign || null,
      utmContent: input.utmContent || null,
      utmTerm: input.utmTerm || null,
      metaLeadId: input.metaLeadId || null,
      platform: input.platform || null,
      formType: input.formType || null,
      metaCampaignId: input.metaCampaignId || null,
      adSetName: input.adSetName || null,
      adName: input.adName || null,
    },
  })
}

export async function assertExternalLeadAvailable(externalLeadId: string | null, excludeLeadId?: string) {
  if (!externalLeadId) return
  const existing = await prisma.lead.findUnique({ where: { externalLeadId } })
  if (existing && existing.id !== excludeLeadId) {
    throw httpError.conflict(ATTRIBUTION_MESSAGES.duplicateExternal)
  }
}

export async function parseManualAttribution(body: Record<string, unknown>, fields: Record<string, string>) {
  const rawSource = asString(body.sourceCode).toUpperCase()
  if (!rawSource) {
    fields.sourceCode = ATTRIBUTION_MESSAGES.sourceRequired
    return null
  }
  if (INTEGRATION_SOURCE_CODES.has(rawSource)) {
    fields.sourceCode = ATTRIBUTION_MESSAGES.sourceInvalid
    return null
  }
  const source = await activeSource(rawSource)
  if (!source?.code) {
    fields.sourceCode = ATTRIBUTION_MESSAGES.sourceInvalid
    return null
  }

  const channelCount = await prisma.masterDataItem.count({
    where: { categoryKey: 'LEAD_CHANNEL', parentId: source.id, status: 'ACTIVE' },
  })
  const rawChannel = asString(body.channelCode).toUpperCase()
  let channelCode: string | null = null
  if (channelCount > 0 && !rawChannel) {
    fields.channelCode = ATTRIBUTION_MESSAGES.channelInvalid
  } else if (rawChannel) {
    const channel = await activeChannel(source.id, rawChannel)
    if (!channel?.code) fields.channelCode = ATTRIBUTION_MESSAGES.channelInvalid
    else channelCode = channel.code
  }

  const rawCampaignId = asString(body.campaignId)
  let campaignId: string | null = null
  let campaignName = asOptionalString(body.campaign, 160)
  if (rawCampaignId) {
    const campaign = await findActiveCampaign({ campaignId: rawCampaignId, sourceCode: source.code })
    if (!campaign || (campaign.sourceCode && campaign.sourceCode.toUpperCase() !== source.code)) {
      fields.campaignId = ATTRIBUTION_MESSAGES.campaignInactive
    } else {
      campaignId = campaign.id
      campaignName = campaign.name
    }
  }

  const referralBy = asOptionalString(body.referralBy, 150)
  const referralDetails = asOptionalString(body.referralDetails, 500)
  if (source.code === 'REFERRAL' && !referralBy) {
    fields.referralBy = ATTRIBUTION_MESSAGES.referralBy
  }

  const externalLeadId = asOptionalString(body.externalLeadId, 200)
  const sourceDetails = asOptionalString(body.sourceDetails, 500)

  if (Object.keys(fields).some((key) => ['sourceCode', 'channelCode', 'campaignId', 'referralBy'].includes(key))) {
    return null
  }

  const resolved: ResolvedAttribution = {
    sourceCode: source.code,
    sourceLabel: source.name,
    channelCode,
    campaignId,
    campaignName,
    utmSource: asOptionalString(body.utmSource, 120),
    utmMedium: asOptionalString(body.utmMedium, 120),
    utmCampaign: asOptionalString(body.utmCampaign, 120),
    utmContent: asOptionalString(body.utmContent, 120),
    utmTerm: asOptionalString(body.utmTerm, 120),
    landingPageUrl: asOptionalString(body.landingPageUrl, 2000),
    externalLeadId,
    sourceDetails,
    referralBy: source.code === 'REFERRAL' ? referralBy : null,
    referralDetails: source.code === 'REFERRAL' ? referralDetails : null,
    unmapped: false,
  }
  return resolved
}

async function requireReason(body: Record<string, unknown>, fields: Record<string, string>) {
  const reason = asString(body.reason)
  if (!reason) fields.reason = ATTRIBUTION_MESSAGES.reasonRequired
  if (reason.length > 500) fields.reason = 'Reason must be 500 characters or less.'
  return reason
}

export async function correctLeadSource(
  auth: AuthContext,
  leadId: string,
  body: Record<string, unknown>,
  meta: { ipAddress?: string; userAgent?: string },
) {
  await ensureLeadAttribution()
  if (!hasPermission(auth.permissions, 'lead:change_source')) {
    throw httpError.accessDenied(ATTRIBUTION_MESSAGES.permission)
  }
  const current = await assertCanViewLead(auth, leadId)
  const fields: Record<string, string> = {}
  const reason = await requireReason(body, fields)
  const rawSource = asString(body.sourceCode).toUpperCase()
  if (!rawSource) fields.sourceCode = ATTRIBUTION_MESSAGES.sourceRequired
  const source = rawSource ? await activeSource(rawSource) : null
  if (rawSource && !source?.code) fields.sourceCode = ATTRIBUTION_MESSAGES.sourceInvalid

  let channelCode = current.channelCode
  if (source && body.channelCode !== undefined) {
    const rawChannel = asString(body.channelCode).toUpperCase()
    if (rawChannel) {
      const channel = await activeChannel(source.id, rawChannel)
      if (!channel?.code) fields.channelCode = ATTRIBUTION_MESSAGES.channelInvalid
      else channelCode = channel.code
    }
  }
  const referralBy = asOptionalString(body.referralBy, 150)
  if (source?.code === 'REFERRAL' && !referralBy && !current.referralBy) {
    fields.referralBy = ATTRIBUTION_MESSAGES.referralBy
  }
  throwIfInvalid(fields)
  if (!source?.code) throw httpError.validation(fields)

  const previous = current.source || current.sourceCode || '—'
  const nextLabel = source.name
  const sameLatest = !current.latestSourceCode || current.latestSourceCode === current.sourceCode

  const lead = await prisma.$transaction(async (tx) => {
    const updated = await tx.lead.update({
      where: { id: leadId },
      data: {
        source: nextLabel,
        sourceCode: source.code,
        channelCode,
        ...(sameLatest
          ? { latestSource: nextLabel, latestSourceCode: source.code, latestChannelCode: channelCode }
          : {}),
        ...(source.code === 'REFERRAL'
          ? {
              referralBy: referralBy || current.referralBy,
              referralDetails: asOptionalString(body.referralDetails, 500) || current.referralDetails,
            }
          : {}),
        updatedById: auth.user.id,
      },
    })
    await tx.leadAttributionChange.create({
      data: {
        leadId,
        kind: 'SOURCE',
        previousValue: previous,
        nextValue: channelCode ? `${nextLabel} / ${channelCode}` : nextLabel,
        reason,
        changedById: auth.user.id,
      },
    })
    await tx.activity.create({
      data: {
        type: 'NOTE',
        userId: auth.user.id,
        relatedType: 'lead',
        relatedId: leadId,
        relatedName: updated.name,
        outcome: 'Source corrected',
        notes: `Lead source corrected from ${previous} to ${nextLabel}. Reason: ${reason}`,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    })
    return updated
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'SOURCE_CORRECTED',
    entityType: 'lead',
    entityId: leadId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { previous, next: nextLabel, channelCode, reason },
  })

  return { leadId: lead.id, message: 'Lead source updated.' }
}

export async function correctLeadCampaign(
  auth: AuthContext,
  leadId: string,
  body: Record<string, unknown>,
  meta: { ipAddress?: string; userAgent?: string },
) {
  await ensureLeadAttribution()
  if (!hasPermission(auth.permissions, 'lead:change_source') && !hasPermission(auth.permissions, 'campaign:manage')) {
    throw httpError.accessDenied(ATTRIBUTION_MESSAGES.permission)
  }
  const current = await assertCanViewLead(auth, leadId)
  const fields: Record<string, string> = {}
  const reason = await requireReason(body, fields)
  const rawId = asString(body.campaignId)
  if (!rawId) fields.campaignId = ATTRIBUTION_MESSAGES.campaignInactive
  const campaign = rawId ? await findActiveCampaign({ campaignId: rawId, sourceCode: current.sourceCode }) : null
  if (rawId && !campaign) fields.campaignId = ATTRIBUTION_MESSAGES.campaignInactive
  throwIfInvalid(fields)
  if (!campaign) throw httpError.validation({ campaignId: ATTRIBUTION_MESSAGES.campaignInactive })

  const previous = current.campaign || '—'
  const lead = await prisma.$transaction(async (tx) => {
    const updated = await tx.lead.update({
      where: { id: leadId },
      data: {
        campaign: campaign.name,
        campaignId: campaign.id,
        latestCampaign: campaign.name,
        latestCampaignId: campaign.id,
        updatedById: auth.user.id,
      },
    })
    await tx.leadAttributionChange.create({
      data: {
        leadId,
        kind: 'CAMPAIGN',
        previousValue: previous,
        nextValue: campaign.name,
        reason,
        changedById: auth.user.id,
      },
    })
    await tx.activity.create({
      data: {
        type: 'NOTE',
        userId: auth.user.id,
        relatedType: 'lead',
        relatedId: leadId,
        relatedName: updated.name,
        outcome: 'Campaign corrected',
        notes: `Campaign corrected from ${previous} to ${campaign.name}. Reason: ${reason}`,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    })
    return updated
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'CAMPAIGN_CORRECTED',
    entityType: 'lead',
    entityId: leadId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { previous, next: campaign.name, reason },
  })

  return { leadId: lead.id, message: 'Lead campaign updated.' }
}

export async function listAttributionChanges(auth: AuthContext, leadId: string) {
  await assertCanViewLead(auth, leadId)
  const rows = await prisma.leadAttributionChange.findMany({
    where: { leadId },
    orderBy: { createdAt: 'desc' },
    include: { changedBy: { select: { id: true, fullName: true } } },
  })
  return {
    items: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      previousValue: row.previousValue,
      nextValue: row.nextValue,
      reason: row.reason,
      changedBy: row.changedBy ? { id: row.changedBy.id, name: row.changedBy.fullName } : null,
      createdAt: row.createdAt.toISOString(),
    })),
  }
}
