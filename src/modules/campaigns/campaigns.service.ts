import type { CampaignStatus, Prisma } from '../../lib/prisma-client'
import { writeAuditLog } from '../../lib/audit'
import { httpError } from '../../lib/http-error'
import { prisma } from '../../lib/prisma'
import { hasPermission } from '../auth/access'
import type { AuthContext } from '../auth/session.service'
import { ATTRIBUTION_MESSAGES, ensureLeadAttribution } from '../leads/lead-attribution'
import { asOptionalString, asString, leadScopeWhere, throwIfInvalid } from '../leads/leads.helpers'

type AuditMeta = { ipAddress?: string; userAgent?: string }

function serializeCampaign(
  row: Prisma.CampaignGetPayload<object> & {
    _count?: { leads: number; events: number }
  },
) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    sourceCode: row.sourceCode,
    channel: row.channel,
    status: row.status,
    startDate: row.startDate ? row.startDate.toISOString().slice(0, 10) : null,
    endDate: row.endDate ? row.endDate.toISOString().slice(0, 10) : null,
    budget: row.budget,
    utmSource: row.utmSource,
    utmMedium: row.utmMedium,
    utmCampaign: row.utmCampaign,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    leadsCount: row._count?.leads ?? 0,
    eventsCount: row._count?.events ?? 0,
  }
}

function parseDate(value: unknown, field: string, fields: Record<string, string>) {
  const text = asString(value)
  if (!text) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    fields[field] = 'Please enter a valid date.'
    return null
  }
  return new Date(`${text}T00:00:00.000Z`)
}

function parseBudget(value: unknown, fields: Record<string, string>) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) {
    fields.budget = 'Please enter a valid budget.'
    return null
  }
  return n
}

async function nextCampaignCode() {
  const rows = await prisma.$queryRaw<Array<{ max: number | bigint | null }>>`
    SELECT MAX(CAST(substring(code from 5) AS INTEGER)) AS max
    FROM campaigns
    WHERE code ~ '^CMP-[0-9]+$'
  `
  const current = Number(rows[0]?.max || 0)
  return `CMP-${String(current + 1).padStart(4, '0')}`
}

const STATUSES = new Set(['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'])
const CONVERTED = new Set(['CONVERTED', 'FILE_OPENING_PENDING', 'FILE_OPENED'])

async function activeMaster(categoryKey: string, code: string) {
  if (!code) return null
  const item = await prisma.masterDataItem.findUnique({
    where: { categoryKey_code: { categoryKey, code } },
  })
  if (!item || item.status !== 'ACTIVE') return null
  return item
}

async function assertCampaignIdentity(
  input: {
    name: string
    sourceCode: string
    channel: string
    excludeId?: string
    requireSource?: boolean
    validateChannel?: boolean
  },
  fields: Record<string, string>,
) {
  if (input.name.length < 2 || input.name.length > 150) {
    fields.name = input.name ? 'Campaign name must be between 2 and 150 characters.' : 'Campaign name is required.'
  }
  const requireSource = input.requireSource !== false
  const source = input.sourceCode ? await activeMaster('LEAD_SOURCE', input.sourceCode) : null
  if (requireSource && !input.sourceCode) fields.sourceCode = ATTRIBUTION_MESSAGES.sourceRequired
  else if (input.sourceCode && !source) fields.sourceCode = ATTRIBUTION_MESSAGES.sourceInvalid

  const validateChannel = input.validateChannel !== false
  if (validateChannel && requireSource && !input.channel) fields.channel = 'Channel is required.'
  else if (validateChannel && input.channel && source) {
    const channel = await activeMaster('LEAD_CHANNEL', input.channel)
    if (!channel || channel.parentId !== source.id) fields.channel = ATTRIBUTION_MESSAGES.channelInvalid
  } else if (validateChannel && input.channel && !source) {
    fields.channel = ATTRIBUTION_MESSAGES.channelInvalid
  }

  if (!fields.name && input.sourceCode) {
    const duplicate = await prisma.campaign.findFirst({
      where: {
        sourceCode: input.sourceCode,
        name: { equals: input.name, mode: 'insensitive' },
        ...(input.excludeId ? { id: { not: input.excludeId } } : {}),
      },
    })
    if (duplicate) fields.name = ATTRIBUTION_MESSAGES.duplicateCampaign
  }
}

export async function listCampaigns(
  auth: AuthContext,
  query: { search?: string; status?: string; page?: number; limit?: number },
) {
  if (!hasPermission(auth.permissions, 'campaign:view')) {
    throw httpError.accessDenied()
  }

  const page = Math.max(1, query.page || 1)
  const limit = Math.min(50, Math.max(10, query.limit || 10))
  const search = query.search?.trim()
  const status = query.status?.trim().toUpperCase()

  const where: Prisma.CampaignWhereInput = {
    AND: [
      status && STATUSES.has(status) ? { status: status as CampaignStatus } : {},
      search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { code: { contains: search, mode: 'insensitive' } },
              { sourceCode: { contains: search, mode: 'insensitive' } },
              { utmCampaign: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {},
    ],
  }

  const [total, rows] = await Promise.all([
    prisma.campaign.count({ where }),
    prisma.campaign.findMany({
      where,
      include: { _count: { select: { leads: true, events: true } } },
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ])

  return {
    items: rows.map(serializeCampaign),
    total,
    page,
    limit,
  }
}

export async function getCampaign(auth: AuthContext, id: string) {
  if (!hasPermission(auth.permissions, 'campaign:view')) {
    throw httpError.accessDenied()
  }
  const row = await prisma.campaign.findUnique({
    where: { id },
    include: { _count: { select: { leads: true, events: true } } },
  })
  if (!row) throw httpError.notFound('Campaign not found.')
  return { campaign: serializeCampaign(row) }
}

export async function createCampaign(auth: AuthContext, body: Record<string, unknown>, meta: AuditMeta) {
  if (!hasPermission(auth.permissions, 'campaign:manage')) {
    throw httpError.accessDenied()
  }

  await ensureLeadAttribution()
  const fields: Record<string, string> = {}
  const name = asString(body.name)
  const sourceCode = asOptionalString(body.sourceCode, 40)?.toUpperCase() || ''
  const channel = asOptionalString(body.channel, 40)?.toUpperCase() || ''
  await assertCampaignIdentity({ name, sourceCode, channel }, fields)

  const statusRaw = asString(body.status).toUpperCase() || 'ACTIVE'
  if (!STATUSES.has(statusRaw)) fields.status = 'Please select a valid status.'

  const startDate = parseDate(body.startDate, 'startDate', fields)
  if (!asString(body.startDate)) fields.startDate = 'Start date is required.'
  const endDate = parseDate(body.endDate, 'endDate', fields)
  if (startDate && endDate && endDate < startDate) {
    fields.endDate = ATTRIBUTION_MESSAGES.endBeforeStart
  }
  const description = asOptionalString(body.description, 1000)
  if (asString(body.description).length > 1000) fields.description = 'Description must be 1000 characters or less.'

  const budget = parseBudget(body.budget, fields)
  throwIfInvalid(fields)

  let code = asOptionalString(body.code, 40)?.toUpperCase() || (await nextCampaignCode())
  const existing = await prisma.campaign.findUnique({ where: { code } })
  if (existing) throw httpError.conflict('This campaign code already exists.')

  const campaign = await prisma.campaign.create({
    data: {
      code,
      name,
      description,
      sourceCode: sourceCode || null,
      channel: channel || null,
      status: statusRaw as CampaignStatus,
      startDate,
      endDate,
      budget,
      utmSource: asOptionalString(body.utmSource, 120),
      utmMedium: asOptionalString(body.utmMedium, 120),
      utmCampaign: asOptionalString(body.utmCampaign, 120),
      createdById: auth.user.id,
      updatedById: auth.user.id,
    },
    include: { _count: { select: { leads: true, events: true } } },
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'CAMPAIGN_CREATED',
    entityType: 'campaign',
    entityId: campaign.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { code: campaign.code, name: campaign.name },
  })

  return { campaign: serializeCampaign(campaign), message: 'Campaign created successfully.' }
}

export async function updateCampaign(
  auth: AuthContext,
  id: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  if (!hasPermission(auth.permissions, 'campaign:manage')) {
    throw httpError.accessDenied()
  }

  const current = await prisma.campaign.findUnique({ where: { id } })
  if (!current) throw httpError.notFound('Campaign not found.')

  await ensureLeadAttribution()
  const fields: Record<string, string> = {}
  const name = body.name !== undefined ? asString(body.name) : current.name
  const sourceCode =
    body.sourceCode !== undefined
      ? asOptionalString(body.sourceCode, 40)?.toUpperCase() || ''
      : current.sourceCode || ''
  const channel =
    body.channel !== undefined ? asOptionalString(body.channel, 40)?.toUpperCase() || '' : current.channel || ''
  await assertCampaignIdentity(
    {
      name,
      sourceCode,
      channel,
      excludeId: id,
      requireSource: Boolean(current.sourceCode || body.sourceCode !== undefined),
      validateChannel: body.channel !== undefined || body.sourceCode !== undefined,
    },
    fields,
  )

  const statusRaw =
    body.status !== undefined ? asString(body.status).toUpperCase() : current.status
  if (!STATUSES.has(statusRaw)) fields.status = 'Please select a valid status.'

  const startDate =
    body.startDate !== undefined ? parseDate(body.startDate, 'startDate', fields) : current.startDate
  if (!startDate) fields.startDate = 'Start date is required.'
  const endDate =
    body.endDate !== undefined ? parseDate(body.endDate, 'endDate', fields) : current.endDate
  if (startDate && endDate && endDate < startDate) {
    fields.endDate = ATTRIBUTION_MESSAGES.endBeforeStart
  }
  const description =
    body.description !== undefined ? asOptionalString(body.description, 1000) : current.description
  if (body.description !== undefined && asString(body.description).length > 1000) {
    fields.description = 'Description must be 1000 characters or less.'
  }

  const budget = body.budget !== undefined ? parseBudget(body.budget, fields) : current.budget
  throwIfInvalid(fields)

  const campaign = await prisma.campaign.update({
    where: { id },
    data: {
      name,
      description,
      sourceCode: sourceCode || null,
      channel: channel || null,
      status: statusRaw as CampaignStatus,
      startDate,
      endDate,
      budget,
      utmSource: body.utmSource !== undefined ? asOptionalString(body.utmSource, 120) : current.utmSource,
      utmMedium: body.utmMedium !== undefined ? asOptionalString(body.utmMedium, 120) : current.utmMedium,
      utmCampaign:
        body.utmCampaign !== undefined ? asOptionalString(body.utmCampaign, 120) : current.utmCampaign,
      updatedById: auth.user.id,
    },
    include: { _count: { select: { leads: true, events: true } } },
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'CAMPAIGN_UPDATED',
    entityType: 'campaign',
    entityId: campaign.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { code: campaign.code },
  })

  return { campaign: serializeCampaign(campaign), message: 'Campaign updated successfully.' }
}

export async function campaignOptions(auth: AuthContext, query: { sourceCode?: string } = {}) {
  if (
    !hasPermission(auth.permissions, 'campaign:view') &&
    !hasPermission(auth.permissions, 'lead:create') &&
    !hasPermission(auth.permissions, 'lead:edit') &&
    !hasPermission(auth.permissions, 'lead:change_source')
  ) {
    throw httpError.accessDenied()
  }
  const sourceCode = query.sourceCode?.trim().toUpperCase()
  const rows = await prisma.campaign.findMany({
    where: {
      status: 'ACTIVE',
      ...(sourceCode ? { sourceCode } : {}),
    },
    orderBy: { name: 'asc' },
    select: { id: true, code: true, name: true, sourceCode: true, channel: true },
  })
  return {
    items: rows.map((row) => ({
      value: row.id,
      label: `${row.code} — ${row.name}`,
      code: row.code,
      name: row.name,
      sourceCode: row.sourceCode,
      channel: row.channel,
    })),
  }
}

export async function attributionSummary(auth: AuthContext) {
  if (!hasPermission(auth.permissions, ['campaign:view', 'report:view', 'lead:view'])) {
    throw httpError.accessDenied()
  }
  await ensureLeadAttribution()
  const leads = await prisma.lead.findMany({
    where: leadScopeWhere(auth),
    select: {
      sourceCode: true,
      source: true,
      campaignId: true,
      campaign: true,
      statusCode: true,
    },
  })
  const sources = new Map<string, { code: string; label: string; total: number; converted: number }>()
  const campaigns = new Map<string, { id: string | null; label: string; total: number; converted: number }>()
  for (const lead of leads) {
    const converted = CONVERTED.has(lead.statusCode || '')
    const sourceKey = lead.sourceCode || 'OTHER'
    const sourceRow = sources.get(sourceKey) || {
      code: sourceKey,
      label: lead.source || sourceKey,
      total: 0,
      converted: 0,
    }
    sourceRow.total += 1
    if (converted) sourceRow.converted += 1
    if (lead.source) sourceRow.label = lead.source
    sources.set(sourceKey, sourceRow)

    const campaignKey = lead.campaignId || 'unmapped'
    const campaignRow = campaigns.get(campaignKey) || {
      id: lead.campaignId,
      label: lead.campaign || 'Unmapped',
      total: 0,
      converted: 0,
    }
    campaignRow.total += 1
    if (converted) campaignRow.converted += 1
    if (lead.campaign) campaignRow.label = lead.campaign
    campaigns.set(campaignKey, campaignRow)
  }
  const rate = (converted: number, total: number) => (total ? Math.round((converted / total) * 1000) / 10 : 0)
  const pack = <T extends { total: number; converted: number }>(rows: T[]) =>
    rows
      .map((row) => ({ ...row, conversionRate: rate(row.converted, row.total) }))
      .sort((a, b) => b.total - a.total)
  return {
    sources: pack([...sources.values()]),
    campaigns: pack([...campaigns.values()]),
  }
}
