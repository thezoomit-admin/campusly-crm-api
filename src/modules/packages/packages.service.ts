import type { PackageItemInclusion, Prisma, RecordStatus } from '../../lib/prisma-client'
import { writeAuditLog } from '../../lib/audit'
import { HttpError, httpError } from '../../lib/http-error'
import { prisma } from '../../lib/prisma'
import { hasPermission } from '../auth/access'
import type { AuthContext } from '../auth/session.service'

type AuditMeta = { ipAddress?: string; userAgent?: string }

type ServiceLine = {
  serviceItemId: string
  inclusion: PackageItemInclusion
  unitPrice: string
  serviceName: string
  sortOrder: number
}

const versionInclude = {
  items: {
    include: { serviceItem: { select: { id: true, name: true, status: true } } },
    orderBy: { sortOrder: 'asc' as const },
  },
  createdBy: { select: { id: true, fullName: true } },
} satisfies Prisma.PackageVersionInclude

const includeRelations = {
  country: { select: { id: true, name: true, code: true, status: true } },
  currentVersion: { include: versionInclude },
  createdBy: { select: { id: true, fullName: true } },
  updatedBy: { select: { id: true, fullName: true } },
} satisfies Prisma.PackageInclude

type PackageRow = Prisma.PackageGetPayload<{ include: typeof includeRelations }>
type VersionRow = Prisma.PackageVersionGetPayload<{ include: typeof versionInclude }>

function normalizeName(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en')
}

function cleanText(value: unknown) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
}

function cleanDescription(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function money(value: { toString(): string } | string | number) {
  return Number(value).toFixed(2)
}

function isUniqueConflict(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

function rethrowSave(error: unknown): never {
  if (error instanceof HttpError) throw error
  if (isUniqueConflict(error)) {
    throw httpError.conflict('A package with this name already exists.', 'DUPLICATE_PACKAGE')
  }
  throw new HttpError(500, 'Unable to save the package. Please try again.', 'PACKAGE_SAVE_FAILED')
}

function assertManage(auth: AuthContext) {
  if (!hasPermission(auth.permissions, 'service:configure')) {
    throw httpError.accessDenied('You do not have permission to manage packages.')
  }
}

function parsePrice(value: unknown, fields: Record<string, string>) {
  const raw = typeof value === 'number' || typeof value === 'string' ? String(value).trim() : ''
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    fields.price = 'Please enter a valid price.'
    return ''
  }
  const amount = Number(raw)
  if (!Number.isFinite(amount) || amount <= 0 || amount > 999999999999.99) {
    fields.price = 'Please enter a valid price.'
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

function catalogSignature(price: string, services: Array<{ serviceItemId: string; inclusion: string }>) {
  const lines = services
    .map((item) => `${item.serviceItemId}:${item.inclusion}`)
    .sort()
    .join('|')
  return `${money(price)}|${lines}`
}

function totals(price: string, lines: ServiceLine[]) {
  const individualTotal = lines
    .filter((line) => line.inclusion === 'INCLUDED')
    .reduce((sum, line) => sum + Number(line.unitPrice), 0)
    .toFixed(2)
  const saving = (Number(individualTotal) - Number(price)).toFixed(2)
  return { individualTotal, saving }
}

function serializeVersion(version: VersionRow) {
  return {
    id: version.id,
    versionNumber: version.versionNumber,
    price: money(version.price),
    individualTotal: money(version.individualTotal),
    saving: money(version.saving),
    currency: 'BDT' as const,
    createdAt: version.createdAt.toISOString(),
    createdBy: version.createdBy,
    items: version.items.map((item) => ({
      id: item.id,
      serviceItemId: item.serviceItemId,
      serviceName: item.serviceItem.name,
      serviceStatus: item.serviceItem.status,
      inclusion: item.inclusion,
      unitPrice: money(item.unitPrice),
      sortOrder: item.sortOrder,
    })),
  }
}

function serialize(row: PackageRow, versions?: VersionRow[]) {
  const current = row.currentVersion ? serializeVersion(row.currentVersion) : null
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    country: row.country,
    price: current?.price || '0.00',
    individualTotal: current?.individualTotal || '0.00',
    saving: current?.saving || '0.00',
    currency: 'BDT' as const,
    versionNumber: current?.versionNumber || 0,
    services: current?.items || [],
    ...(versions ? { versions: versions.map(serializeVersion) } : {}),
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

async function parseServices(value: unknown, fields: Record<string, string>) {
  if (!Array.isArray(value) || value.length === 0) {
    fields.services = 'Please select at least one service.'
    return []
  }
  const parsed: Array<{ serviceItemId: string; inclusion: PackageItemInclusion }> = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      fields.services = 'Please select at least one service.'
      return []
    }
    const record = entry as Record<string, unknown>
    const serviceItemId = cleanText(record.serviceItemId)
    const inclusion = record.inclusion === 'OPTIONAL' ? 'OPTIONAL' : record.inclusion === 'INCLUDED' ? 'INCLUDED' : ''
    if (!serviceItemId || !inclusion) {
      fields.services = 'Please select at least one service.'
      return []
    }
    if (seen.has(serviceItemId)) {
      fields.services = 'Each service can only be added once.'
      return []
    }
    seen.add(serviceItemId)
    parsed.push({ serviceItemId, inclusion })
  }
  if (!parsed.some((item) => item.inclusion === 'INCLUDED')) {
    fields.services = 'Please select at least one service.'
    return []
  }
  const rows = await prisma.serviceItem.findMany({
    where: { id: { in: parsed.map((item) => item.serviceItemId) } },
    select: { id: true, name: true, status: true, defaultPrice: true },
  })
  const byId = new Map(rows.map((row) => [row.id, row]))
  if (parsed.some((item) => !byId.has(item.serviceItemId) || byId.get(item.serviceItemId)?.status !== 'ACTIVE')) {
    fields.services = 'Only active services can be added to a package.'
    return []
  }
  return parsed.map((item, index) => {
    const service = byId.get(item.serviceItemId)!
    return {
      serviceItemId: item.serviceItemId,
      inclusion: item.inclusion,
      unitPrice: money(service.defaultPrice),
      serviceName: service.name,
      sortOrder: index,
    }
  })
}

async function parseCountry(value: unknown, fields: Record<string, string>, currentCountryId?: string | null) {
  if (value === undefined) return currentCountryId ?? null
  if (value === null || value === '') return null
  const countryId = cleanText(value)
  if (!countryId) return null
  const country = await prisma.masterDataItem.findUnique({
    where: { id: countryId },
    select: { id: true, categoryKey: true, status: true },
  })
  const mayKeep = currentCountryId === countryId
  if (!country || country.categoryKey !== 'COUNTRY' || (country.status !== 'ACTIVE' && !mayKeep)) {
    fields.countryId = 'Please select an active country.'
    return null
  }
  return countryId
}

async function parsePayload(
  body: Record<string, unknown>,
  current?: {
    name: string
    description: string | null
    countryId: string | null
    status: RecordStatus
    currentVersion: {
      price: { toString(): string }
      items: Array<{ serviceItemId: string; inclusion: PackageItemInclusion; unitPrice: { toString(): string }; serviceItem: { name: string } }>
    } | null
  },
) {
  const fields: Record<string, string> = {}
  const name = body.name !== undefined ? cleanText(body.name) : current?.name || ''
  if (!name) fields.name = 'Package name is required.'
  else if (name.length < 2 || name.length > 100) fields.name = 'Package name must be between 2 and 100 characters.'

  const description =
    body.description !== undefined ? cleanDescription(body.description) || null : current?.description || null
  if (description && description.length > 1000) fields.description = 'Description must be 1000 characters or less.'

  const price =
    body.price !== undefined
      ? parsePrice(body.price, fields)
      : current?.currentVersion
        ? money(current.currentVersion.price)
        : parsePrice(undefined, fields)
  const countryId = await parseCountry(
    body.countryId,
    fields,
    current?.countryId,
  )
  const status = parseStatus(body.status, fields, current?.status)
  const services =
    body.services !== undefined
      ? await parseServices(body.services, fields)
      : current?.currentVersion?.items.map((item, index) => ({
          serviceItemId: item.serviceItemId,
          inclusion: item.inclusion,
          unitPrice: money(item.unitPrice),
          serviceName: item.serviceItem.name,
          sortOrder: index,
        })) || (fields.services = 'Please select at least one service.', [])

  if (Object.keys(fields).length) throw httpError.validation(fields)
  const priced = totals(price, services)
  return { name, description, countryId, status, price, services, ...priced }
}

async function loadPackage(id: string) {
  return prisma.package.findUnique({
    where: { id },
    include: {
      ...includeRelations,
      currentVersion: {
        include: {
          ...versionInclude,
          items: {
            include: { serviceItem: { select: { id: true, name: true, status: true } } },
            orderBy: { sortOrder: 'asc' },
          },
        },
      },
    },
  })
}

export async function listPackages(
  auth: AuthContext,
  query: {
    search?: string
    status?: string
    countryId?: string
    serviceItemId?: string
    page?: number
    limit?: number
  },
) {
  if (!hasPermission(auth.permissions, 'service:view')) throw httpError.accessDenied()
  const page = Math.max(1, query.page || 1)
  const limit = Math.min(100, Math.max(10, query.limit || 10))
  const search = query.search?.trim()
  const status = query.status === 'ACTIVE' || query.status === 'INACTIVE' ? query.status : undefined
  const where: Prisma.PackageWhereInput = {
    ...(status ? { status } : {}),
    ...(query.countryId ? { countryId: query.countryId } : {}),
    ...(query.serviceItemId
      ? {
          currentVersion: {
            items: { some: { serviceItemId: query.serviceItemId, inclusion: 'INCLUDED' } },
          },
        }
      : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { description: { contains: search, mode: 'insensitive' } },
            { country: { name: { contains: search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  }
  const [total, rows] = await Promise.all([
    prisma.package.count({ where }),
    prisma.package.findMany({
      where,
      include: includeRelations,
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
  ])
  return { items: rows.map((row) => serialize(row)), total, page, limit }
}

export async function getPackage(auth: AuthContext, id: string) {
  if (!hasPermission(auth.permissions, 'service:view')) throw httpError.accessDenied()
  const row = await prisma.package.findUnique({
    where: { id },
    include: {
      ...includeRelations,
      versions: { include: versionInclude, orderBy: { versionNumber: 'desc' } },
    },
  })
  if (!row) throw httpError.notFound('Package not found.')
  return { package: serialize(row, row.versions) }
}

export async function packageOptions(
  auth: AuthContext,
  query: { preferredCountryCode?: string; countryId?: string },
) {
  if (!hasPermission(auth.permissions, 'service:view')) throw httpError.accessDenied()
  let countryId = query.countryId
  if (!countryId && query.preferredCountryCode) {
    const country = await prisma.masterDataItem.findFirst({
      where: { categoryKey: 'COUNTRY', code: query.preferredCountryCode },
      select: { id: true },
    })
    if (!country) return { items: [] }
    countryId = country.id
  }
  const rows = await prisma.package.findMany({
    where: {
      status: 'ACTIVE',
      ...(countryId ? { OR: [{ countryId }, { countryId: null }] } : {}),
    },
    include: includeRelations,
    orderBy: { name: 'asc' },
  })
  const ranked = countryId
    ? [...rows].sort((left, right) => {
        const leftRank = left.countryId === countryId ? 0 : 1
        const rightRank = right.countryId === countryId ? 0 : 1
        if (leftRank !== rightRank) return leftRank - rightRank
        return left.name.localeCompare(right.name)
      })
    : rows
  return {
    items: ranked.map((row) => {
      const serialized = serialize(row)
      return {
        value: row.id,
        label: row.name,
        name: row.name,
        description: row.description,
        country: row.country,
        price: serialized.price,
        individualTotal: serialized.individualTotal,
        saving: serialized.saving,
        currency: 'BDT' as const,
        versionNumber: serialized.versionNumber,
        services: serialized.services,
      }
    }),
  }
}

export async function packageNameAvailability(auth: AuthContext, query: { name?: string; excludeId?: string }) {
  if (!hasPermission(auth.permissions, 'service:view')) throw httpError.accessDenied()
  const name = cleanText(query.name)
  if (!name) return { available: true }
  const existing = await prisma.package.findFirst({
    where: {
      nameNormalized: normalizeName(name),
      ...(query.excludeId ? { id: { not: query.excludeId } } : {}),
    },
    select: { id: true },
  })
  return { available: !existing }
}

export async function createPackage(auth: AuthContext, body: Record<string, unknown>, meta: AuditMeta) {
  assertManage(auth)
  const input = await parsePayload(body)
  const nameNormalized = normalizeName(input.name)
  const duplicate = await prisma.package.findUnique({ where: { nameNormalized } })
  if (duplicate) throw httpError.conflict('A package with this name already exists.', 'DUPLICATE_PACKAGE')

  try {
    const id = await prisma.$transaction(async (tx) => {
      const created = await tx.package.create({
        data: {
          name: input.name,
          nameNormalized,
          description: input.description,
          countryId: input.countryId,
          status: input.status,
          createdById: auth.user.id,
          updatedById: auth.user.id,
        },
      })
      const version = await tx.packageVersion.create({
        data: {
          packageId: created.id,
          versionNumber: 1,
          price: input.price,
          individualTotal: input.individualTotal,
          saving: input.saving,
          createdById: auth.user.id,
          items: {
            create: input.services.map((line) => ({
              serviceItemId: line.serviceItemId,
              inclusion: line.inclusion,
              unitPrice: line.unitPrice,
              sortOrder: line.sortOrder,
            })),
          },
        },
      })
      await tx.package.update({
        where: { id: created.id },
        data: { currentVersionId: version.id },
      })
      return created.id
    })
    const row = await loadPackage(id)
    if (!row) throw new HttpError(500, 'Unable to save the package. Please try again.', 'PACKAGE_SAVE_FAILED')
    await writeAuditLog({
      userId: auth.user.id,
      action: 'PACKAGE_CREATED',
      entityType: 'package',
      entityId: row.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { name: row.name, price: input.price, versionNumber: 1, status: row.status },
    })
    return { package: serialize(row), message: 'Package created successfully.' }
  } catch (error) {
    rethrowSave(error)
  }
}

export async function updatePackage(auth: AuthContext, id: string, body: Record<string, unknown>, meta: AuditMeta) {
  assertManage(auth)
  const current = await prisma.package.findUnique({
    where: { id },
    include: {
      currentVersion: {
        include: {
          items: {
            include: { serviceItem: { select: { name: true } } },
            orderBy: { sortOrder: 'asc' },
          },
        },
      },
    },
  })
  if (!current) throw httpError.notFound('Package not found.')
  const input = await parsePayload(body, current)
  const nameNormalized = normalizeName(input.name)
  const duplicate = await prisma.package.findFirst({ where: { nameNormalized, id: { not: id } } })
  if (duplicate) throw httpError.conflict('A package with this name already exists.', 'DUPLICATE_PACKAGE')

  const previousSignature = current.currentVersion
    ? catalogSignature(
        money(current.currentVersion.price),
        current.currentVersion.items.map((item) => ({
          serviceItemId: item.serviceItemId,
          inclusion: item.inclusion,
        })),
      )
    : ''
  const nextSignature = catalogSignature(input.price, input.services)
  const versioned = previousSignature !== nextSignature

  try {
    await prisma.$transaction(async (tx) => {
      let currentVersionId = current.currentVersionId
      let versionNumber = current.currentVersion?.versionNumber || 0
      if (versioned) {
        versionNumber += 1
        const version = await tx.packageVersion.create({
          data: {
            packageId: id,
            versionNumber,
            price: input.price,
            individualTotal: input.individualTotal,
            saving: input.saving,
            createdById: auth.user.id,
            items: {
              create: input.services.map((line) => ({
                serviceItemId: line.serviceItemId,
                inclusion: line.inclusion,
                unitPrice: line.unitPrice,
                sortOrder: line.sortOrder,
              })),
            },
          },
        })
        currentVersionId = version.id
      }
      await tx.package.update({
        where: { id },
        data: {
          name: input.name,
          nameNormalized,
          description: input.description,
          countryId: input.countryId,
          status: input.status,
          currentVersionId,
          updatedById: auth.user.id,
        },
      })
    })
    const row = await loadPackage(id)
    if (!row) throw new HttpError(500, 'Unable to save the package. Please try again.', 'PACKAGE_SAVE_FAILED')
    await writeAuditLog({
      userId: auth.user.id,
      action: versioned ? 'PACKAGE_VERSION_CREATED' : 'PACKAGE_UPDATED',
      entityType: 'package',
      entityId: row.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: {
        name: row.name,
        versioned,
        versionNumber: row.currentVersion?.versionNumber,
        price: input.price,
      },
    })
    return {
      package: serialize(row),
      message: versioned ? 'Package version created. Existing offers are unchanged.' : 'Package updated successfully.',
    }
  } catch (error) {
    rethrowSave(error)
  }
}

export async function updatePackageStatus(auth: AuthContext, id: string, value: unknown, meta: AuditMeta) {
  assertManage(auth)
  if (value !== 'ACTIVE' && value !== 'INACTIVE') {
    throw httpError.validation({ status: 'Please select a valid status.' })
  }
  const current = await prisma.package.findUnique({ where: { id } })
  if (!current) throw httpError.notFound('Package not found.')
  await prisma.package.update({
    where: { id },
    data: { status: value, updatedById: auth.user.id },
  })
  const row = await loadPackage(id)
  if (!row) throw httpError.notFound('Package not found.')
  await writeAuditLog({
    userId: auth.user.id,
    action: value === 'ACTIVE' ? 'PACKAGE_ACTIVATED' : 'PACKAGE_DEACTIVATED',
    entityType: 'package',
    entityId: row.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { name: row.name, previousStatus: current.status, status: row.status },
  })
  return { package: serialize(row), message: `Package ${value === 'ACTIVE' ? 'activated' : 'deactivated'}.` }
}
