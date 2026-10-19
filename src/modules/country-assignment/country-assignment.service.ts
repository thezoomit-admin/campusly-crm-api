import { prisma } from '../../lib/prisma'
import { writeAuditLog } from '../../lib/audit'
import { httpError } from '../../lib/http-error'
import type { AuthContext } from '../auth/session.service'
import { canReceiveLeadAssignment } from '../auth/access'
import { asOptionalString, asString, leadEligibleAssigneeWhere } from '../leads/leads.helpers'

type AuditMeta = { ipAddress?: string; userAgent?: string }

export type CountryAssignmentRuleRecord = {
  id: string
  countryCode: string
  countryName: string | null
  teamId: string
  teamName: string
  teamKey: string
  defaultOwnerId: string | null
  defaultOwnerName: string | null
  isActive: boolean
  createdAt: string
  updatedAt: string
}

function asBoolean(value: unknown, fallback: boolean) {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

async function resolveCountryName(countryCode: string) {
  const item = await prisma.masterDataItem.findUnique({
    where: { categoryKey_code: { categoryKey: 'COUNTRY', code: countryCode } },
    select: { name: true, status: true },
  })
  return item
}

function serialize(rule: {
  id: string
  countryCode: string
  teamId: string
  defaultOwnerId: string | null
  isActive: boolean
  createdAt: Date
  updatedAt: Date
  team: { id: string; name: string; key: string }
  defaultOwner: { id: string; fullName: string } | null
  countryName?: string | null
}): CountryAssignmentRuleRecord {
  return {
    id: rule.id,
    countryCode: rule.countryCode,
    countryName: rule.countryName ?? null,
    teamId: rule.teamId,
    teamName: rule.team.name,
    teamKey: rule.team.key,
    defaultOwnerId: rule.defaultOwnerId,
    defaultOwnerName: rule.defaultOwner?.fullName || null,
    isActive: rule.isActive,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  }
}

const ruleInclude = {
  team: { select: { id: true, name: true, key: true } },
  defaultOwner: { select: { id: true, fullName: true } },
} as const

async function withCountryNames<T extends { countryCode: string }>(rows: T[]) {
  const codes = [...new Set(rows.map((row) => row.countryCode))]
  const countries = codes.length
    ? await prisma.masterDataItem.findMany({
        where: { categoryKey: 'COUNTRY', code: { in: codes } },
        select: { code: true, name: true },
      })
    : []
  const nameByCode = new Map(countries.map((item) => [item.code, item.name]))
  return rows.map((row) => ({ ...row, countryName: nameByCode.get(row.countryCode) || null }))
}

export async function listCountryAssignmentRules(query: {
  search?: string
  isActive?: string
}) {
  const search = query.search?.trim()
  const activeFilter =
    query.isActive === 'true' ? true : query.isActive === 'false' ? false : undefined

  const rows = await prisma.countryAssignmentRule.findMany({
    where: {
      ...(activeFilter === undefined ? {} : { isActive: activeFilter }),
      ...(search
        ? {
            OR: [
              { countryCode: { contains: search, mode: 'insensitive' } },
              { team: { name: { contains: search, mode: 'insensitive' } } },
              { defaultOwner: { fullName: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    },
    include: ruleInclude,
    orderBy: [{ countryCode: 'asc' }],
  })

  const withNames = await withCountryNames(rows)
  return { items: withNames.map(serialize) }
}

export async function getCountryAssignmentFormOptions(teamId?: string) {
  const [countries, teams, owners] = await Promise.all([
    prisma.masterDataItem.findMany({
      where: { categoryKey: 'COUNTRY', status: 'ACTIVE' },
      select: { code: true, name: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    prisma.team.findMany({
      where: { status: 'ACTIVE' },
      select: {
        id: true,
        key: true,
        name: true,
        department: { select: { id: true, name: true } },
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    teamId
      ? prisma.user.findMany({
          where: {
            teamId,
            AND: [leadEligibleAssigneeWhere()],
          },
          select: {
            id: true,
            fullName: true,
            status: true,
            primaryRole: { select: { key: true, name: true } },
          },
          orderBy: { fullName: 'asc' },
        })
      : Promise.resolve([]),
  ])

  return {
    countries: countries
      .filter((item) => Boolean(item.code))
      .map((item) => ({ value: item.code!, label: item.name })),
    teams: teams.map((team) => ({
      value: team.id,
      label: team.name,
      key: team.key,
      departmentName: team.department.name,
    })),
    owners: owners
      .filter((user) => canReceiveLeadAssignment(user.status))
      .map((user) => ({
        value: user.id,
        label: user.fullName,
        role: user.primaryRole?.name || null,
      })),
  }
}

async function assertValidTeam(teamId: string) {
  const team = await prisma.team.findFirst({
    where: { id: teamId, status: 'ACTIVE' },
    select: { id: true, name: true, key: true },
  })
  if (!team) {
    throw httpError.validation({ teamId: 'Please select an active team.' })
  }
  return team
}

async function assertValidCountry(countryCode: string) {
  const country = await resolveCountryName(countryCode)
  if (!country || country.status !== 'ACTIVE') {
    throw httpError.validation({
      countryCode: 'Please select a valid active preferred country.',
    })
  }
  return country
}

async function assertValidDefaultOwner(defaultOwnerId: string | null, teamId: string) {
  if (!defaultOwnerId) return null

  const owner = await prisma.user.findFirst({
    where: {
      id: defaultOwnerId,
      teamId,
      AND: [leadEligibleAssigneeWhere()],
    },
    select: {
      id: true,
      fullName: true,
      status: true,
    },
  })

  if (!owner || !canReceiveLeadAssignment(owner.status)) {
    throw httpError.validation({
      defaultOwnerId:
        'Default owner must be an active eligible member of the selected team.',
    })
  }

  return owner
}

function parseRuleBody(body: Record<string, unknown>, mode: 'create' | 'update') {
  const fields: Record<string, string> = {}
  const countryCode = asString(body.countryCode).toUpperCase()
  const teamId = asString(body.teamId)
  const defaultOwnerRaw = asOptionalString(body.defaultOwnerId, 80)
  const defaultOwnerId = defaultOwnerRaw || null
  const isActive = asBoolean(body.isActive, true)

  if (mode === 'create' && !countryCode) {
    fields.countryCode = 'Please select a preferred country.'
  }
  if (!teamId) fields.teamId = 'Please select a team.'

  if (Object.keys(fields).length > 0) {
    throw httpError.validation(fields)
  }

  return { countryCode, teamId, defaultOwnerId, isActive }
}

export async function createCountryAssignmentRule(
  auth: AuthContext,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  const parsed = parseRuleBody(body, 'create')
  await assertValidCountry(parsed.countryCode)
  await assertValidTeam(parsed.teamId)
  await assertValidDefaultOwner(parsed.defaultOwnerId, parsed.teamId)

  const existing = await prisma.countryAssignmentRule.findUnique({
    where: { countryCode: parsed.countryCode },
    select: { id: true },
  })
  if (existing) {
    throw httpError.validation({
      countryCode: 'An assignment rule already exists for this country.',
    })
  }

  const created = await prisma.countryAssignmentRule.create({
    data: {
      countryCode: parsed.countryCode,
      teamId: parsed.teamId,
      defaultOwnerId: parsed.defaultOwnerId,
      isActive: parsed.isActive,
    },
    include: ruleInclude,
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'COUNTRY_ASSIGNMENT_RULE_CREATE',
    entityType: 'CountryAssignmentRule',
    entityId: created.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: {
      countryCode: created.countryCode,
      teamId: created.teamId,
      defaultOwnerId: created.defaultOwnerId,
      isActive: created.isActive,
    },
  })

  const [withName] = await withCountryNames([created])
  return serialize(withName)
}

export async function updateCountryAssignmentRule(
  auth: AuthContext,
  id: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  const current = await prisma.countryAssignmentRule.findUnique({
    where: { id },
    include: ruleInclude,
  })
  if (!current) {
    throw httpError.notFound('Country assignment rule not found.')
  }

  const countryCode =
    body.countryCode !== undefined
      ? asString(body.countryCode).toUpperCase()
      : current.countryCode
  const teamId = body.teamId !== undefined ? asString(body.teamId) : current.teamId
  const defaultOwnerId =
    body.defaultOwnerId !== undefined
      ? asOptionalString(body.defaultOwnerId, 80) || null
      : current.defaultOwnerId
  const isActive =
    body.isActive !== undefined ? asBoolean(body.isActive, current.isActive) : current.isActive

  if (!countryCode) {
    throw httpError.validation({ countryCode: 'Please select a preferred country.' })
  }
  if (!teamId) {
    throw httpError.validation({ teamId: 'Please select a team.' })
  }

  await assertValidCountry(countryCode)
  await assertValidTeam(teamId)
  await assertValidDefaultOwner(defaultOwnerId, teamId)

  if (countryCode !== current.countryCode) {
    const conflict = await prisma.countryAssignmentRule.findUnique({
      where: { countryCode },
      select: { id: true },
    })
    if (conflict && conflict.id !== id) {
      throw httpError.validation({
        countryCode: 'An assignment rule already exists for this country.',
      })
    }
  }

  const updated = await prisma.countryAssignmentRule.update({
    where: { id },
    data: {
      countryCode,
      teamId,
      defaultOwnerId,
      isActive,
    },
    include: ruleInclude,
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'COUNTRY_ASSIGNMENT_RULE_UPDATE',
    entityType: 'CountryAssignmentRule',
    entityId: updated.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: {
      before: {
        countryCode: current.countryCode,
        teamId: current.teamId,
        defaultOwnerId: current.defaultOwnerId,
        isActive: current.isActive,
      },
      after: {
        countryCode: updated.countryCode,
        teamId: updated.teamId,
        defaultOwnerId: updated.defaultOwnerId,
        isActive: updated.isActive,
      },
    },
  })

  const [withName] = await withCountryNames([updated])
  return serialize(withName)
}

export async function deactivateCountryAssignmentRule(
  auth: AuthContext,
  id: string,
  meta: AuditMeta,
) {
  const current = await prisma.countryAssignmentRule.findUnique({
    where: { id },
    include: ruleInclude,
  })
  if (!current) {
    throw httpError.notFound('Country assignment rule not found.')
  }

  const updated = await prisma.countryAssignmentRule.update({
    where: { id },
    data: { isActive: false },
    include: ruleInclude,
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'COUNTRY_ASSIGNMENT_RULE_DEACTIVATE',
    entityType: 'CountryAssignmentRule',
    entityId: updated.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: {
      countryCode: updated.countryCode,
      teamId: updated.teamId,
      previousIsActive: current.isActive,
    },
  })

  const [withName] = await withCountryNames([updated])
  return serialize(withName)
}
