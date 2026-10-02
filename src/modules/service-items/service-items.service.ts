import type { Prisma, RecordStatus } from '../../lib/prisma-client'
import { writeAuditLog } from '../../lib/audit'
import { httpError } from '../../lib/http-error'
import { prisma } from '../../lib/prisma'
import { hasPermission } from '../auth/access'
import type { AuthContext } from '../auth/session.service'

type AuditMeta = { ipAddress?: string; userAgent?: string }
type ServiceItemPayload = {
  name: string
  description: string | null
  defaultPrice: string
  categoryId: string
  countryIds: string[]
  status: RecordStatus
}

const includeRelations = {
  category: { select: { id: true, name: true, status: true } },
  countries: {
    include: { country: { select: { id: true, name: true, code: true, status: true } } },
    orderBy: { country: { name: 'asc' as const } },
  },
  createdBy: { select: { id: true, fullName: true } },
  updatedBy: { select: { id: true, fullName: true } },
} satisfies Prisma.ServiceItemInclude

type ServiceItemRow = Prisma.ServiceItemGetPayload<{ include: typeof includeRelations }>

function normalizeName(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en')
}

function cleanText(value: unknown) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
}

function cleanDescription(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function parseCountryIds(value: unknown, fields: Record<string, string>) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id.trim())) {
    fields.countryIds = 'Please select valid countries.'
    return []
  }
  return [...new Set(value.map((id) => String(id).trim()))]
}

function parsePrice(value: unknown, fields: Record<string, string>) {
  const raw = typeof value === 'number' || typeof value === 'string' ? String(value).trim() : ''
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    fields.defaultPrice = 'Please enter a valid price.'
    return ''
  }
  const amount = Number(raw)
  if (!Number.isFinite(amount) || amount <= 0 || amount > 999999999999.99) {
    fields.defaultPrice = 'Please enter a valid price.'
    return ''
  }
  return amount.toFixed(2)
}

function parseStatus(value: unknown, fields: Record<string, string>, fallback: RecordStatus = 'ACTIVE') {
  if (value === undefined) return fallback
  if (value !== 'ACTIVE' && value !== 'INACTIVE') {
    fields.status = 'Please select a valid status.'
    return fallback
  }
  return value
}

function serialize(row: ServiceItemRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    defaultPrice: row.defaultPrice.toString(),
    currency: 'BDT',
    status: row.status,
    category: row.category,
    countries: row.countries.map((entry) => entry.country),
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function isUniqueConflict(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

async function validateReferences(
  categoryId: string,
  countryIds: string[],
  fields: Record<string, string>,
  existing?: { categoryId: string; countryIds: Set<string> },
) {
  const ids = [...new Set([categoryId, ...countryIds].filter(Boolean))]
  const rows = ids.length
    ? await prisma.masterDataItem.findMany({
        where: { id: { in: ids } },
        select: { id: true, categoryKey: true, status: true },
      })
    : []
  const byId = new Map(rows.map((row) => [row.id, row]))
  const category = byId.get(categoryId)
  const mayKeepCategory = existing?.categoryId === categoryId
  if (!categoryId || !category || category.categoryKey !== 'SERVICE_CATEGORY' || (category.status !== 'ACTIVE' && !mayKeepCategory)) {
    fields.categoryId = 'Please select an active service category.'
  }
  if (
    countryIds.some((id) => {
      const country = byId.get(id)
      return !country || country.categoryKey !== 'COUNTRY' || (country.status !== 'ACTIVE' && !existing?.countryIds.has(id))
    })
  ) {
    fields.countryIds = 'One or more selected countries are not available.'
  }
}

async function parsePayload(
  body: Record<string, unknown>,
  current?: {
    name: string
    description: string | null
    defaultPrice: { toString(): string }
    categoryId: string
    status: RecordStatus
    countries: Array<{ countryId: string }>
  },
): Promise<ServiceItemPayload> {
  const fields: Record<string, string> = {}
  const name = body.name !== undefined ? cleanText(body.name) : current?.name || ''
  if (!name) fields.name = 'Service name is required.'
  else if (name.length < 2 || name.length > 100) fields.name = 'Service name must be between 2 and 100 characters.'

  const description =
    body.description !== undefined ? cleanDescription(body.description) || null : current?.description || null
  if (description && description.length > 1000) fields.description = 'Description must be 1000 characters or less.'

  const defaultPrice =
    body.defaultPrice !== undefined
      ? parsePrice(body.defaultPrice, fields)
      : current?.defaultPrice.toString() || parsePrice(undefined, fields)
  const categoryId = body.categoryId !== undefined ? cleanText(body.categoryId) : current?.categoryId || ''
  const countryIds =
    body.countryIds !== undefined
      ? parseCountryIds(body.countryIds, fields)
      : current?.countries.map((entry) => entry.countryId) || []
  const status = parseStatus(body.status, fields, current?.status)

  await validateReferences(categoryId, countryIds, fields, current
    ? { categoryId: current.categoryId, countryIds: new Set(current.countries.map((entry) => entry.countryId)) }
    : undefined)

  if (Object.keys(fields).length) {
    throw httpError.validation(fields)
  }
  return { name, description, defaultPrice, categoryId, countryIds, status }
}

export async function listServiceItems(
  auth: AuthContext,
  query: {
    search?: string
    status?: string
    categoryId?: string
    countryId?: string
    page?: number
    limit?: number
  },
) {
  if (!hasPermission(auth.permissions, 'service:view')) throw httpError.accessDenied()
  const page = Math.max(1, query.page || 1)
  const limit = Math.min(100, Math.max(10, query.limit || 10))
  const search = query.search?.trim()
  const status = query.status === 'ACTIVE' || query.status === 'INACTIVE' ? query.status : undefined
  const where: Prisma.ServiceItemWhereInput = {
    ...(status ? { status } : {}),
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    ...(query.countryId ? { countries: { some: { countryId: query.countryId } } } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { description: { contains: search, mode: 'insensitive' } },
            { category: { name: { contains: search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  }
  const [total, rows] = await Promise.all([
    prisma.serviceItem.count({ where }),
    prisma.serviceItem.findMany({
      where,
      include: includeRelations,
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
  ])
  return { items: rows.map(serialize), total, page, limit }
}

export async function getServiceItem(auth: AuthContext, id: string) {
  if (!hasPermission(auth.permissions, 'service:view')) throw httpError.accessDenied()
  const row = await prisma.serviceItem.findUnique({ where: { id }, include: includeRelations })
  if (!row) throw httpError.notFound('Service item not found.')
  return { serviceItem: serialize(row) }
}

export async function serviceItemOptions(auth: AuthContext, query: { categoryId?: string; countryId?: string }) {
  if (!hasPermission(auth.permissions, 'service:view')) throw httpError.accessDenied()
  const rows = await prisma.serviceItem.findMany({
    where: {
      status: 'ACTIVE',
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.countryId
        ? {
            OR: [
              { countries: { none: {} } },
              { countries: { some: { countryId: query.countryId } } },
            ],
          }
        : {}),
    },
    include: {
      category: { select: { id: true, name: true } },
      countries: { include: { country: { select: { id: true, name: true, code: true } } } },
    },
    orderBy: { name: 'asc' },
  })
  return {
    items: rows.map((row) => ({
      value: row.id,
      label: row.name,
      name: row.name,
      description: row.description,
      defaultPrice: row.defaultPrice.toString(),
      currency: 'BDT',
      category: row.category,
      countries: row.countries.map((entry) => entry.country),
    })),
  }
}

export async function serviceItemNameAvailability(
  auth: AuthContext,
  query: { name?: string; excludeId?: string },
) {
  if (!hasPermission(auth.permissions, 'service:view')) throw httpError.accessDenied()
  const name = cleanText(query.name)
  if (!name) return { available: true }
  const existing = await prisma.serviceItem.findFirst({
    where: {
      nameNormalized: normalizeName(name),
      ...(query.excludeId ? { id: { not: query.excludeId } } : {}),
    },
    select: { id: true },
  })
  return { available: !existing }
}

export async function createServiceItem(auth: AuthContext, body: Record<string, unknown>, meta: AuditMeta) {
  if (!hasPermission(auth.permissions, 'service:create')) {
    throw httpError.accessDenied('You do not have permission to manage service items.')
  }
  const input = await parsePayload(body)
  if (input.status === 'INACTIVE' && !hasPermission(auth.permissions, 'service:deactivate')) {
    throw httpError.accessDenied('You do not have permission to manage service item status.')
  }
  const nameNormalized = normalizeName(input.name)
  const duplicate = await prisma.serviceItem.findUnique({ where: { nameNormalized } })
  if (duplicate) throw httpError.conflict('A service item with this name already exists.', 'DUPLICATE_SERVICE_ITEM')

  try {
    const row = await prisma.serviceItem.create({
      data: {
        name: input.name,
        nameNormalized,
        description: input.description,
        defaultPrice: input.defaultPrice,
        categoryId: input.categoryId,
        status: input.status,
        createdById: auth.user.id,
        updatedById: auth.user.id,
        countries: { create: input.countryIds.map((countryId) => ({ countryId })) },
      },
      include: includeRelations,
    })
    await writeAuditLog({
      userId: auth.user.id,
      action: 'SERVICE_ITEM_CREATED',
      entityType: 'service_item',
      entityId: row.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { name: row.name, defaultPrice: row.defaultPrice.toString(), status: row.status },
    })
    return { serviceItem: serialize(row), message: 'Service item created successfully.' }
  } catch (error) {
    if (isUniqueConflict(error)) {
      throw httpError.conflict('A service item with this name already exists.', 'DUPLICATE_SERVICE_ITEM')
    }
    throw error
  }
}

export async function updateServiceItem(
  auth: AuthContext,
  id: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  if (!hasPermission(auth.permissions, 'service:edit')) {
    throw httpError.accessDenied('You do not have permission to manage service items.')
  }
  const current = await prisma.serviceItem.findUnique({
    where: { id },
    include: { countries: { select: { countryId: true } } },
  })
  if (!current) throw httpError.notFound('Service item not found.')
  const input = await parsePayload(body, current)
  if (input.status !== current.status && !hasPermission(auth.permissions, 'service:deactivate')) {
    throw httpError.accessDenied('You do not have permission to manage service item status.')
  }
  const nameNormalized = normalizeName(input.name)
  const duplicate = await prisma.serviceItem.findFirst({ where: { nameNormalized, id: { not: id } } })
  if (duplicate) throw httpError.conflict('A service item with this name already exists.', 'DUPLICATE_SERVICE_ITEM')

  try {
    const row = await prisma.$transaction(async (tx) => {
      await tx.serviceItemCountry.deleteMany({ where: { serviceItemId: id } })
      return tx.serviceItem.update({
        where: { id },
        data: {
          name: input.name,
          nameNormalized,
          description: input.description,
          defaultPrice: input.defaultPrice,
          categoryId: input.categoryId,
          status: input.status,
          updatedById: auth.user.id,
          countries: { create: input.countryIds.map((countryId) => ({ countryId })) },
        },
        include: includeRelations,
      })
    })
    await writeAuditLog({
      userId: auth.user.id,
      action: 'SERVICE_ITEM_UPDATED',
      entityType: 'service_item',
      entityId: row.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: {
        name: row.name,
        previousDefaultPrice: current.defaultPrice.toString(),
        defaultPrice: row.defaultPrice.toString(),
      },
    })
    return { serviceItem: serialize(row), message: 'Service item updated successfully.' }
  } catch (error) {
    if (isUniqueConflict(error)) {
      throw httpError.conflict('A service item with this name already exists.', 'DUPLICATE_SERVICE_ITEM')
    }
    throw error
  }
}

export async function updateServiceItemStatus(
  auth: AuthContext,
  id: string,
  value: unknown,
  meta: AuditMeta,
) {
  if (!hasPermission(auth.permissions, 'service:deactivate')) {
    throw httpError.accessDenied('You do not have permission to manage service items.')
  }
  if (value !== 'ACTIVE' && value !== 'INACTIVE') {
    throw httpError.validation({ status: 'Please select a valid status.' })
  }
  const current = await prisma.serviceItem.findUnique({ where: { id } })
  if (!current) throw httpError.notFound('Service item not found.')
  const row = await prisma.serviceItem.update({
    where: { id },
    data: { status: value, updatedById: auth.user.id },
    include: includeRelations,
  })
  await writeAuditLog({
    userId: auth.user.id,
    action: value === 'ACTIVE' ? 'SERVICE_ITEM_ACTIVATED' : 'SERVICE_ITEM_DEACTIVATED',
    entityType: 'service_item',
    entityId: row.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { name: row.name, previousStatus: current.status, status: row.status },
  })
  return { serviceItem: serialize(row), message: `Service item ${value === 'ACTIVE' ? 'activated' : 'deactivated'}.` }
}
