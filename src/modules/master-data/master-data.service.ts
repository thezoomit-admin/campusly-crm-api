import type { Prisma, RecordStatus } from '../../lib/prisma-client'
import { writeAuditLog } from '../../lib/audit'
import { clearCatalogCache, getCatalogCache, setCatalogCache } from '../../lib/catalog-cache'
import { httpError } from '../../lib/http-error'
import { prisma } from '../../lib/prisma'
import type { AuthContext } from '../auth/session.service'
import { getMasterDataCategory, MASTER_DATA_CATEGORIES, type MasterDataCategory } from './master-data.catalog'

const ENTITY = 'master_data'
const BEHAVIOR_KEYS = new Set([
  'converted',
  'lost',
  'closed',
  'file_opening_pending',
  'file_opened',
  'duplicate',
  'invalid',
])
const SORT_FIELDS = new Set(['name', 'code', 'sortOrder', 'createdAt', 'status'])

type AuditMeta = { ipAddress?: string; userAgent?: string }

export type MasterDataQuery = {
  category: string
  search?: string
  status?: string
  parentId?: string
  createdFrom?: string
  createdTo?: string
  sortBy?: string
  sortDir?: string
}

type NamedUser = { id: string; fullName: string } | null

type ItemRecord = {
  id: string
  categoryKey: string
  name: string
  code: string | null
  description: string | null
  parentId: string | null
  parentName: string | null
  status: RecordStatus
  sortOrder: number
  isSystem: boolean
  behaviorKey: string | null
  extras: Record<string, unknown> | null
  usageCount: number
  createdAt: Date
  updatedAt: Date
  createdBy: NamedUser
  updatedBy: NamedUser
}

function categoryOrThrow(key: string) {
  const category = getMasterDataCategory(key)
  if (!category) {
    throw httpError.notFound('Master data category not found.')
  }
  return category
}

function slugify(value: string) {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
}

function normalizeName(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function parseStatus(value: unknown, fallback: RecordStatus = 'ACTIVE'): RecordStatus {
  return value === 'INACTIVE' ? 'INACTIVE' : value === 'ACTIVE' ? 'ACTIVE' : fallback
}

function parseSortOrder(value: unknown) {
  if (value == null || value === '') {
    return 0
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 9999) {
    throw httpError.invalidMasterData()
  }
  return parsed
}

function parseCode(value: unknown, policy: MasterDataCategory['codePolicy']) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) {
    if (policy === 'required') {
      throw httpError.invalidMasterDataCode()
    }
    return null
  }
  const code = slugify(raw)
  if (!/^[A-Z0-9][A-Z0-9_]{0,31}$/.test(code)) {
    throw httpError.invalidMasterDataCode()
  }
  return code
}

function parseBehaviorKey(value: unknown, extraFields: MasterDataCategory['extraFields']) {
  if (extraFields !== 'leadStatus') {
    return null
  }
  if (value == null || value === '') {
    return null
  }
  if (typeof value !== 'string' || !BEHAVIOR_KEYS.has(value)) {
    throw httpError.invalidMasterData()
  }
  return value
}

function parseExtras(input: Record<string, unknown>, extraFields: MasterDataCategory['extraFields']) {
  if (extraFields !== 'intake') {
    return null
  }
  const startDate = typeof input.startDate === 'string' ? input.startDate.trim() : ''
  const endDate = typeof input.endDate === 'string' ? input.endDate.trim() : ''
  if ((startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) || (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate))) {
    throw httpError.invalidMasterData()
  }
  if (startDate && endDate && startDate > endDate) {
    throw httpError.invalidMasterData()
  }
  return { startDate: startDate || null, endDate: endDate || null }
}

function asExtras(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

function dateRange(from?: string, to?: string): Prisma.DateTimeFilter | undefined {
  const range: Prisma.DateTimeFilter = {}
  if (from) {
    const start = new Date(`${from}T00:00:00.000Z`)
    if (Number.isNaN(start.getTime())) {
      throw httpError.invalidMasterData()
    }
    range.gte = start
  }
  if (to) {
    const end = new Date(`${to}T23:59:59.999Z`)
    if (Number.isNaN(end.getTime())) {
      throw httpError.invalidMasterData()
    }
    range.lte = end
  }
  return range.gte || range.lte ? range : undefined
}

function orderBy(sortBy?: string, sortDir?: string): Prisma.MasterDataItemOrderByWithRelationInput[] {
  const dir = sortDir === 'desc' ? 'desc' : 'asc'
  if (sortBy && SORT_FIELDS.has(sortBy)) {
    return [{ [sortBy]: dir } as Prisma.MasterDataItemOrderByWithRelationInput]
  }
  return [{ sortOrder: 'asc' }, { name: 'asc' }]
}

async function usageCount(category: MasterDataCategory, id: string) {
  if (category.storage === 'department') {
    const [users, teams] = await Promise.all([
      prisma.user.count({ where: { departmentId: id } }),
      prisma.team.count({ where: { departmentId: id } }),
    ])
    return users + teams + (await prisma.employee.count({ where: { departmentId: id } }))
  }
  if (category.storage === 'team') {
    const [users, employees] = await Promise.all([
      prisma.user.count({ where: { teamId: id } }),
      prisma.employee.count({ where: { teamId: id } }),
    ])
    return users + employees
  }
  const [children, employees] = await Promise.all([
    prisma.masterDataItem.count({ where: { parentId: id } }),
    prisma.employee.count({
      where: {
        OR: [{ designationId: id }, { employmentTypeId: id }, { employmentStatusId: id }],
      },
    }),
  ])
  return children + employees
}

async function resolveParent(category: MasterDataCategory, parentId: unknown, currentParentId?: string | null) {
  if (!category.parentCategoryKey) {
    return null
  }
  if (typeof parentId !== 'string' || !parentId) {
    throw httpError.invalidMasterDataParent()
  }
  const parentCategory = categoryOrThrow(category.parentCategoryKey)
  const parent = await getItemRecord(parentCategory, parentId)
  if (!parent) {
    throw httpError.invalidMasterDataParent()
  }
  if (parent.status === 'INACTIVE' && parent.id !== currentParentId) {
    throw httpError.inactiveMasterDataParent()
  }
  return parent
}

function toItem(input: {
  id: string
  categoryKey: string
  name: string
  code: string | null
  description: string | null
  parentId: string | null
  parentName: string | null
  status: RecordStatus
  sortOrder: number
  isSystem: boolean
  behaviorKey: string | null
  extras: unknown
  usageCount: number
  createdAt: Date
  updatedAt: Date
  createdBy: NamedUser
  updatedBy: NamedUser
}): ItemRecord {
  return {
    ...input,
    extras: asExtras(input.extras),
  }
}

async function getItemRecord(category: MasterDataCategory, id: string): Promise<ItemRecord | null> {
  if (category.storage === 'department') {
    const row = await prisma.department.findUnique({
      where: { id },
      include: { _count: { select: { users: true, teams: true, employees: true } } },
    })
    if (!row) {
      return null
    }
    return toItem({
      id: row.id,
      categoryKey: category.key,
      name: row.name,
      code: row.key,
      description: row.description,
      parentId: null,
      parentName: null,
      status: row.status,
      sortOrder: row.sortOrder,
      isSystem: false,
      behaviorKey: null,
      extras: null,
      usageCount: row._count.users + row._count.teams + row._count.employees,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      createdBy: null,
      updatedBy: null,
    })
  }

  if (category.storage === 'team') {
    const row = await prisma.team.findUnique({
      where: { id },
      include: { department: true, _count: { select: { users: true, employees: true } } },
    })
    if (!row) {
      return null
    }
    return toItem({
      id: row.id,
      categoryKey: category.key,
      name: row.name,
      code: row.key,
      description: row.description,
      parentId: row.departmentId,
      parentName: row.department.name,
      status: row.status,
      sortOrder: row.sortOrder,
      isSystem: false,
      behaviorKey: null,
      extras: null,
      usageCount: row._count.users + row._count.employees,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      createdBy: null,
      updatedBy: null,
    })
  }

  const row = await prisma.masterDataItem.findUnique({
    where: { id },
    include: {
      parent: true,
      createdBy: { select: { id: true, fullName: true } },
      updatedBy: { select: { id: true, fullName: true } },
      _count: {
        select: {
          children: true,
          designationEmployees: true,
          employmentTypeEmployees: true,
          employmentStatusEmployees: true,
        },
      },
    },
  })
  if (!row || row.categoryKey !== category.key) {
    return null
  }
  return toItem({
    id: row.id,
    categoryKey: row.categoryKey,
    name: row.name,
    code: row.code,
    description: row.description,
    parentId: row.parentId,
    parentName: row.parent?.name ?? null,
    status: row.status,
    sortOrder: row.sortOrder,
    isSystem: row.isSystem,
    behaviorKey: row.behaviorKey,
    extras: row.extras,
    usageCount:
      row._count.children +
      row._count.designationEmployees +
      row._count.employmentTypeEmployees +
      row._count.employmentStatusEmployees,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
  })
}

function isUniqueConflict(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

export async function listCategories() {
  const [genericCounts, departmentCount, teamCount] = await Promise.all([
    prisma.masterDataItem.groupBy({
      by: ['categoryKey'],
      _count: { _all: true },
    }),
    prisma.department.count(),
    prisma.team.count(),
  ])
  const countMap = new Map(genericCounts.map((row) => [row.categoryKey, row._count._all]))
  countMap.set('DEPARTMENT', departmentCount)
  countMap.set('TEAM', teamCount)

  const groups = new Map<
    string,
    Array<{
      key: string
      name: string
      recordCount: number
      parentCategoryKey?: string
      extraFields: MasterDataCategory['extraFields']
      codePolicy: MasterDataCategory['codePolicy']
    }>
  >()
  for (const category of MASTER_DATA_CATEGORIES) {
    const list = groups.get(category.group) || []
    list.push({
      key: category.key,
      name: category.name,
      recordCount: countMap.get(category.key) || 0,
      parentCategoryKey: category.parentCategoryKey,
      extraFields: category.extraFields,
      codePolicy: category.codePolicy,
    })
    groups.set(category.group, list)
  }

  return [...groups.entries()].map(([group, categories]) => ({ group, categories }))
}

export async function listItems(query: MasterDataQuery) {
  const category = categoryOrThrow(query.category)
  const createdAt = dateRange(query.createdFrom, query.createdTo)
  const status = query.status === 'ACTIVE' || query.status === 'INACTIVE' ? query.status : undefined
  const search = query.search?.trim()

  if (category.storage === 'department') {
    const rows = await prisma.department.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(createdAt ? { createdAt } : {}),
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { key: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: { _count: { select: { users: true, teams: true, employees: true } } },
      orderBy:
        query.sortBy === 'code'
          ? { key: query.sortDir === 'desc' ? 'desc' : 'asc' }
          : query.sortBy === 'createdAt'
            ? { createdAt: query.sortDir === 'desc' ? 'desc' : 'asc' }
            : query.sortBy === 'status'
              ? { status: query.sortDir === 'desc' ? 'desc' : 'asc' }
              : query.sortBy === 'name'
                ? { name: query.sortDir === 'desc' ? 'desc' : 'asc' }
                : [{ sortOrder: 'asc' }, { name: 'asc' }],
    })
    return rows.map((row) =>
      toItem({
        id: row.id,
        categoryKey: category.key,
        name: row.name,
        code: row.key,
        description: row.description,
        parentId: null,
        parentName: null,
        status: row.status,
        sortOrder: row.sortOrder,
        isSystem: false,
        behaviorKey: null,
        extras: null,
        usageCount: row._count.users + row._count.teams + row._count.employees,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        createdBy: null,
        updatedBy: null,
      }),
    )
  }

  if (category.storage === 'team') {
    const rows = await prisma.team.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(createdAt ? { createdAt } : {}),
        ...(query.parentId ? { departmentId: query.parentId } : {}),
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { key: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: { department: true, _count: { select: { users: true, employees: true } } },
      orderBy:
        query.sortBy === 'name'
          ? { name: query.sortDir === 'desc' ? 'desc' : 'asc' }
          : [{ sortOrder: 'asc' }, { name: 'asc' }],
    })
    return rows.map((row) =>
      toItem({
        id: row.id,
        categoryKey: category.key,
        name: row.name,
        code: row.key,
        description: row.description,
        parentId: row.departmentId,
        parentName: row.department.name,
        status: row.status,
        sortOrder: row.sortOrder,
        isSystem: false,
        behaviorKey: null,
        extras: null,
        usageCount: row._count.users + row._count.employees,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        createdBy: null,
        updatedBy: null,
      }),
    )
  }

  const rows = await prisma.masterDataItem.findMany({
    where: {
      categoryKey: category.key,
      ...(status ? { status } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(query.parentId ? { parentId: query.parentId } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { code: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    include: {
      parent: true,
      createdBy: { select: { id: true, fullName: true } },
      updatedBy: { select: { id: true, fullName: true } },
      _count: {
        select: {
          children: true,
          designationEmployees: true,
          employmentTypeEmployees: true,
          employmentStatusEmployees: true,
        },
      },
    },
    orderBy: orderBy(query.sortBy, query.sortDir),
  })

  return rows.map((row) =>
    toItem({
      id: row.id,
      categoryKey: row.categoryKey,
      name: row.name,
      code: row.code,
      description: row.description,
      parentId: row.parentId,
      parentName: row.parent?.name ?? null,
      status: row.status,
      sortOrder: row.sortOrder,
      isSystem: row.isSystem,
      behaviorKey: row.behaviorKey,
      extras: row.extras,
      usageCount:
      row._count.children +
      row._count.designationEmployees +
      row._count.employmentTypeEmployees +
      row._count.employmentStatusEmployees,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      createdBy: row.createdBy,
      updatedBy: row.updatedBy,
    }),
  )
}

export async function getItem(categoryKey: string, id: string) {
  const category = categoryOrThrow(categoryKey)
  const item = await getItemRecord(category, id)
  if (!item) {
    throw httpError.notFound('Master data not found.')
  }
  return item
}

export async function listOptions(query: { category: string; parentId?: string; includeId?: string }) {
  const category = categoryOrThrow(query.category)
  const cacheKey = `master-data:options:${category.key}:${query.parentId || ''}:${query.includeId || ''}`
  const cached = getCatalogCache<ItemRecord[]>(cacheKey)
  if (cached) {
    return cached
  }

  const items = await listItems({
    category: category.key,
    status: 'ACTIVE',
    parentId: query.parentId,
  })
  if (query.includeId && !items.some((item) => item.id === query.includeId)) {
    const extra = await getItemRecord(category, query.includeId)
    if (extra) {
      items.push(extra)
    }
  }
  setCatalogCache(cacheKey, items)
  return items
}

async function assertUniqueName(category: MasterDataCategory, name: string, excludeId?: string) {
  const nameNormalized = name.toLowerCase()
  if (category.storage === 'department') {
    const existing = await prisma.department.findFirst({
      where: { name: { equals: name, mode: 'insensitive' }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    })
    if (existing) {
      throw httpError.duplicateMasterData()
    }
    return
  }
  if (category.storage === 'team') {
    const existing = await prisma.team.findFirst({
      where: { name: { equals: name, mode: 'insensitive' }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    })
    if (existing) {
      throw httpError.duplicateMasterData()
    }
    return
  }
  const existing = await prisma.masterDataItem.findFirst({
    where: {
      categoryKey: category.key,
      nameNormalized,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
  })
  if (existing) {
    throw httpError.duplicateMasterData()
  }
}

async function assertUniqueCode(category: MasterDataCategory, code: string | null, excludeId?: string) {
  if (!code) {
    return
  }
  if (category.storage === 'department') {
    const existing = await prisma.department.findFirst({
      where: { key: code, ...(excludeId ? { id: { not: excludeId } } : {}) },
    })
    if (existing) {
      throw httpError.invalidMasterDataCode()
    }
    return
  }
  if (category.storage === 'team') {
    const existing = await prisma.team.findFirst({
      where: { key: code, ...(excludeId ? { id: { not: excludeId } } : {}) },
    })
    if (existing) {
      throw httpError.invalidMasterDataCode()
    }
    return
  }
  const existing = await prisma.masterDataItem.findFirst({
    where: {
      categoryKey: category.key,
      code,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
  })
  if (existing) {
    throw httpError.invalidMasterDataCode()
  }
}

function parseInput(category: MasterDataCategory, input: Record<string, unknown>, existing?: ItemRecord) {
  const name = normalizeName(input.name)
  if (!name) {
    throw httpError.missingMasterDataName()
  }
  const code = parseCode(input.code, category.codePolicy) || (category.storage !== 'generic' ? slugify(name) : null)
  if ((category.storage === 'department' || category.storage === 'team') && !code) {
    throw httpError.invalidMasterDataCode()
  }
  const extrasInput = {
    startDate: input.startDate ?? existing?.extras?.startDate,
    endDate: input.endDate ?? existing?.extras?.endDate,
  }
  const description =
    typeof input.description === 'string' ? input.description.trim() || null : (existing?.description ?? null)
  if (description && description.length > 100) {
    throw httpError.invalidMasterData()
  }
  return {
    name,
    code,
    description,
    status: parseStatus(input.status, existing?.status ?? 'ACTIVE'),
    sortOrder: input.sortOrder === undefined ? (existing?.sortOrder ?? 0) : parseSortOrder(input.sortOrder),
    parentId: input.parentId === undefined ? (existing?.parentId ?? null) : input.parentId,
    behaviorKey: parseBehaviorKey(
      input.behaviorKey === undefined ? existing?.behaviorKey : input.behaviorKey,
      category.extraFields,
    ),
    extras: parseExtras(extrasInput, category.extraFields),
  }
}

export async function createItem(
  auth: AuthContext,
  categoryKey: string,
  input: Record<string, unknown>,
  meta: AuditMeta,
  options?: { skipAudit?: boolean },
) {
  const category = categoryOrThrow(categoryKey)
  const parsed = parseInput(category, input)
  await assertUniqueName(category, parsed.name)
  await assertUniqueCode(category, parsed.code)
  const parent = await resolveParent(category, parsed.parentId)

  try {
    const created =
      category.storage === 'department'
        ? await prisma.department.create({
            data: {
              key: parsed.code!,
              name: parsed.name,
              description: parsed.description,
              status: parsed.status,
              sortOrder: parsed.sortOrder,
            },
          })
        : category.storage === 'team'
          ? await prisma.team.create({
              data: {
                key: parsed.code!,
                name: parsed.name,
                description: parsed.description,
                status: parsed.status,
                sortOrder: parsed.sortOrder,
                departmentId: parent!.id,
              },
            })
          : await prisma.masterDataItem.create({
              data: {
                categoryKey: category.key,
                name: parsed.name,
                nameNormalized: parsed.name.toLowerCase(),
                code: parsed.code,
                description: parsed.description,
                parentId: parent?.id ?? null,
                status: parsed.status,
                sortOrder: parsed.sortOrder,
                behaviorKey: parsed.behaviorKey,
                extras: parsed.extras === null ? undefined : (parsed.extras as Prisma.InputJsonValue),
                createdById: auth.user.id,
                updatedById: auth.user.id,
              },
            })

    clearCatalogCache('master-data')
    if (!options?.skipAudit) {
      await writeAuditLog({
        userId: auth.user.id,
        action: 'MASTER_DATA_CREATED',
        entityType: ENTITY,
        entityId: created.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        metadata: { categoryKey: category.key, name: parsed.name, code: parsed.code },
      })
    }
    return getItem(category.key, created.id)
  } catch (error) {
    if (isUniqueConflict(error)) {
      throw httpError.duplicateMasterData()
    }
    throw error
  }
}

export async function updateItem(
  auth: AuthContext,
  categoryKey: string,
  id: string,
  input: Record<string, unknown>,
  meta: AuditMeta,
) {
  const category = categoryOrThrow(categoryKey)
  const existing = await getItemRecord(category, id)
  if (!existing) {
    throw httpError.notFound('Master data not found.')
  }

  const parsed = parseInput(
    category,
    {
      name: input.name ?? existing.name,
      code: input.code === undefined ? existing.code : input.code,
      description: input.description === undefined ? existing.description : input.description,
      status: input.status === undefined ? existing.status : input.status,
      sortOrder: input.sortOrder === undefined ? existing.sortOrder : input.sortOrder,
      parentId: input.parentId === undefined ? existing.parentId : input.parentId,
      behaviorKey: input.behaviorKey === undefined ? existing.behaviorKey : input.behaviorKey,
      startDate: input.startDate === undefined ? existing.extras?.startDate : input.startDate,
      endDate: input.endDate === undefined ? existing.extras?.endDate : input.endDate,
    },
    existing,
  )
  if (existing.isSystem && parsed.code !== existing.code) {
    throw httpError.invalidMasterDataCode()
  }
  if (existing.isSystem && parsed.status === 'INACTIVE') {
    throw httpError.masterDataInUse()
  }
  await assertUniqueName(category, parsed.name, id)
  await assertUniqueCode(category, parsed.code, id)
  const parent = await resolveParent(category, parsed.parentId, existing.parentId)

  const changes: Record<string, { from: unknown; to: unknown }> = {}
  if (existing.name !== parsed.name) {
    changes.name = { from: existing.name, to: parsed.name }
  }
  if (existing.code !== parsed.code) {
    changes.code = { from: existing.code, to: parsed.code }
  }
  if (existing.status !== parsed.status) {
    changes.status = { from: existing.status, to: parsed.status }
  }
  if (existing.sortOrder !== parsed.sortOrder) {
    changes.sortOrder = { from: existing.sortOrder, to: parsed.sortOrder }
  }
  if ((existing.parentId || null) !== (parent?.id || null)) {
    changes.parent = { from: existing.parentName, to: parent?.name || null }
  }

  try {
    if (category.storage === 'department') {
      await prisma.department.update({
        where: { id },
        data: {
          key: parsed.code!,
          name: parsed.name,
          description: parsed.description,
          status: parsed.status,
          sortOrder: parsed.sortOrder,
        },
      })
    } else if (category.storage === 'team') {
      await prisma.team.update({
        where: { id },
        data: {
          key: parsed.code!,
          name: parsed.name,
          description: parsed.description,
          status: parsed.status,
          sortOrder: parsed.sortOrder,
          departmentId: parent!.id,
        },
      })
    } else {
      await prisma.masterDataItem.update({
        where: { id },
        data: {
          name: parsed.name,
          nameNormalized: parsed.name.toLowerCase(),
          code: parsed.code,
          description: parsed.description,
          parentId: parent?.id ?? null,
          status: parsed.status,
          sortOrder: parsed.sortOrder,
          behaviorKey: existing.isSystem ? existing.behaviorKey : parsed.behaviorKey,
          extras: parsed.extras === null ? undefined : (parsed.extras as Prisma.InputJsonValue),
          updatedById: auth.user.id,
        },
      })
    }
  } catch (error) {
    if (isUniqueConflict(error)) {
      throw httpError.duplicateMasterData()
    }
    throw error
  }

  clearCatalogCache('master-data')
  const action =
    existing.status !== parsed.status
      ? parsed.status === 'ACTIVE'
        ? 'MASTER_DATA_ACTIVATED'
        : 'MASTER_DATA_DEACTIVATED'
      : 'MASTER_DATA_UPDATED'
  await writeAuditLog({
    userId: auth.user.id,
    action,
    entityType: ENTITY,
    entityId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
      metadata: { categoryKey: category.key, name: parsed.name, changes } as Prisma.InputJsonValue,
  })
  return getItem(category.key, id)
}

export async function deleteItem(auth: AuthContext, categoryKey: string, id: string, meta: AuditMeta) {
  const category = categoryOrThrow(categoryKey)
  const existing = await getItemRecord(category, id)
  if (!existing) {
    throw httpError.notFound('Master data not found.')
  }
  if (existing.isSystem || existing.usageCount > 0 || (await usageCount(category, id)) > 0) {
    throw httpError.masterDataInUse()
  }

  if (category.storage === 'department') {
    await prisma.department.delete({ where: { id } })
  } else if (category.storage === 'team') {
    await prisma.team.delete({ where: { id } })
  } else {
    await prisma.masterDataItem.delete({ where: { id } })
  }

  clearCatalogCache('master-data')
  await writeAuditLog({
    userId: auth.user.id,
    action: 'MASTER_DATA_DELETED',
    entityType: ENTITY,
    entityId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { categoryKey: category.key, name: existing.name, code: existing.code },
  })
}

async function itemExists(category: MasterDataCategory, id: string) {
  if (category.storage === 'department') {
    const row = await prisma.department.findUnique({ where: { id }, select: { id: true } })
    return Boolean(row)
  }
  if (category.storage === 'team') {
    const row = await prisma.team.findUnique({ where: { id }, select: { id: true } })
    return Boolean(row)
  }
  const row = await prisma.masterDataItem.findUnique({
    where: { id },
    select: { id: true, categoryKey: true },
  })
  return Boolean(row && row.categoryKey === category.key)
}

export async function listHistory(categoryKey: string, id: string) {
  const category = categoryOrThrow(categoryKey)
  if (!(await itemExists(category, id))) {
    throw httpError.notFound('Master data not found.')
  }
  const logs = await prisma.auditLog.findMany({
    where: { entityType: ENTITY, entityId: id },
    select: {
      id: true,
      action: true,
      metadata: true,
      createdAt: true,
      user: {
        select: {
          id: true,
          fullName: true,
          email: true,
          primaryRole: { select: { name: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  return logs.map((log) => ({
    id: log.id,
    action: log.action,
    metadata: log.metadata,
    createdAt: log.createdAt,
    user: log.user
      ? {
          id: log.user.id,
          fullName: log.user.fullName,
          email: log.user.email,
          role: log.user.primaryRole?.name || null,
        }
      : null,
  }))
}

export async function listDepartmentsForUsers() {
  const departments = await prisma.department.findMany({
    where: { status: 'ACTIVE' },
    include: { teams: { where: { status: 'ACTIVE' }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] } },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  })
  return departments.map((item) => ({
    id: item.id,
    key: item.key,
    name: item.name,
    teams: item.teams.map((team) => ({ id: team.id, key: team.key, name: team.name })),
  }))
}

export async function listTeamsForUsers(departmentId?: string) {
  const teams = await prisma.team.findMany({
    where: {
      status: 'ACTIVE',
      ...(departmentId ? { departmentId } : {}),
    },
    include: { department: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  })
  return teams.map((item) => ({
    id: item.id,
    key: item.key,
    name: item.name,
    departmentId: item.departmentId,
    departmentName: item.department.name,
  }))
}

export { categoryOrThrow }
export type { AuditMeta, ItemRecord }
