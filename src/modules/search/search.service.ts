import type { Prisma } from '../../lib/prisma-client'
import { prisma } from '../../lib/prisma'
import { auditDirectoryScope, hasPermission, userDirectoryScope } from '../auth/access'
import type { AuthContext } from '../auth/session.service'
import { MASTER_DATA_CATEGORY_MAP } from '../master-data/master-data.catalog'

const LIMIT = 6

const MASTER_DATA_GROUP_SLUG: Record<string, string> = {
  'Lead Management': 'lead-management',
  'Lead Qualification': 'lead-qualification',
  'Lead Intent': 'lead-intent',
  Academic: 'academic',
  'Study Abroad': 'study-abroad',
  Service: 'service',
  Communication: 'communication',
  Employee: 'employee',
  Documents: 'documents',
  Payment: 'payment',
}

export type SearchHit = {
  id: string
  type: 'user' | 'employee' | 'role' | 'master-data' | 'activity' | 'audit'
  title: string
  subtitle: string
  href: string
  group: string
}

function contains(query: string): Prisma.StringFilter {
  return { contains: query, mode: 'insensitive' }
}

function userVisibility(auth: AuthContext): Prisma.UserWhereInput {
  const scope = userDirectoryScope(auth.role.key)
  if (scope === 'ALL') {
    return {}
  }
  if (scope === 'TEAM' && auth.user.teamId) {
    return { teamId: auth.user.teamId }
  }
  return { id: auth.user.id }
}

function employeeVisibility(auth: AuthContext): Prisma.EmployeeWhereInput {
  const scope = auth.dataScopes.employee_performance ?? 'OWN'
  if (scope === 'ALL') {
    return {}
  }
  if (scope === 'DEPARTMENT' && auth.user.departmentId) {
    return { departmentId: auth.user.departmentId }
  }
  if (scope === 'TEAM' && auth.user.teamId) {
    return { teamId: auth.user.teamId }
  }
  return { userId: auth.user.id }
}

function activityVisibility(auth: AuthContext): Prisma.ActivityWhereInput {
  const scope = auth.dataScopes.lead ?? 'OWN'
  if (scope === 'OWN') {
    return { userId: auth.user.id }
  }
  if (scope === 'TEAM' && auth.user.teamId) {
    return { user: { teamId: auth.user.teamId } }
  }
  if (scope === 'DEPARTMENT' && auth.user.departmentId) {
    return { user: { departmentId: auth.user.departmentId } }
  }
  return {}
}

function auditVisibility(auth: AuthContext): Prisma.AuditLogWhereInput {
  const scope = auditDirectoryScope(auth.role.key)
  if (scope === 'ALL') {
    return {}
  }
  if (scope === 'TEAM' && auth.user.teamId) {
    return { user: { teamId: auth.user.teamId } }
  }
  return { userId: auth.user.id }
}

function masterDataHref(categoryKey: string, query: string) {
  const category = MASTER_DATA_CATEGORY_MAP.get(categoryKey)
  const slug = category ? MASTER_DATA_GROUP_SLUG[category.group] || 'lead-management' : 'lead-management'
  return `/master-data/${slug}/${categoryKey}?q=${encodeURIComponent(query)}`
}

async function settled<T>(promise: Promise<T[]>): Promise<T[]> {
  try {
    return await promise
  } catch (error) {
    console.error(error)
    return []
  }
}

export async function globalSearch(auth: AuthContext, rawQuery: string): Promise<SearchHit[]> {
  const query = rawQuery.trim().slice(0, 80)
  if (!query) {
    return []
  }

  const permissions = auth.permissions
  const tasks: Array<Promise<SearchHit[]>> = []

  if (hasPermission(permissions, 'user:view')) {
    tasks.push(
      settled(
        prisma.user
          .findMany({
            where: {
              AND: [
                userVisibility(auth),
                {
                  OR: [
                    { fullName: contains(query) },
                    { email: contains(query) },
                    { username: contains(query) },
                    { mobile: { contains: query } },
                  ],
                },
              ],
            },
            select: {
              id: true,
              fullName: true,
              email: true,
              username: true,
              primaryRole: { select: { name: true } },
            },
            orderBy: { fullName: 'asc' },
            take: LIMIT,
          })
          .then((rows) =>
            rows.map((row) => ({
              id: `user:${row.id}`,
              type: 'user' as const,
              title: row.fullName,
              subtitle: [row.email, row.primaryRole?.name].filter(Boolean).join(' · '),
              href: `/users?q=${encodeURIComponent(row.email || row.fullName)}`,
              group: 'Users',
            })),
          ),
      ),
    )
  }

  if (hasPermission(permissions, 'employee:view')) {
    tasks.push(
      settled(
        prisma.employee
          .findMany({
            where: {
              AND: [
                employeeVisibility(auth),
                {
                  OR: [
                    { employeeCode: contains(query) },
                    { fullName: contains(query) },
                    { mobile: { contains: query } },
                    { officialEmail: contains(query) },
                    { designation: { name: contains(query) } },
                    { department: { name: contains(query) } },
                    { team: { name: contains(query) } },
                    { role: { name: contains(query) } },
                  ],
                },
              ],
            },
            select: {
              id: true,
              employeeCode: true,
              fullName: true,
              officialEmail: true,
              designation: { select: { name: true } },
              department: { select: { name: true } },
            },
            orderBy: { fullName: 'asc' },
            take: LIMIT,
          })
          .then((rows) =>
            rows.map((row) => ({
              id: `employee:${row.id}`,
              type: 'employee' as const,
              title: row.fullName,
              subtitle: [row.employeeCode, row.designation?.name, row.department?.name].filter(Boolean).join(' · '),
              href: `/employees/${row.id}`,
              group: 'Employees',
            })),
          ),
      ),
    )
  }

  if (hasPermission(permissions, 'role:view')) {
    tasks.push(
      settled(
        prisma.role
          .findMany({
            where: {
              OR: [{ name: contains(query) }, { key: contains(query) }, { description: contains(query) }],
            },
            select: { id: true, name: true, key: true, description: true },
            orderBy: { name: 'asc' },
            take: LIMIT,
          })
          .then((rows) =>
            rows.map((row) => ({
              id: `role:${row.id}`,
              type: 'role' as const,
              title: row.name,
              subtitle: row.description || row.key,
              href: `/roles?q=${encodeURIComponent(row.name)}`,
              group: 'Roles',
            })),
          ),
      ),
    )
  }

  if (hasPermission(permissions, 'master_data:view')) {
    tasks.push(
      settled(
        (async () => {
          const [items, departments, teams] = await Promise.all([
            prisma.masterDataItem.findMany({
              where: {
                OR: [{ name: contains(query) }, { code: contains(query) }],
              },
              select: { id: true, name: true, code: true, categoryKey: true },
              orderBy: { name: 'asc' },
              take: LIMIT,
            }),
            prisma.department.findMany({
              where: { OR: [{ name: contains(query) }, { key: contains(query) }] },
              select: { id: true, name: true, key: true },
              orderBy: { name: 'asc' },
              take: 3,
            }),
            prisma.team.findMany({
              where: { OR: [{ name: contains(query) }, { key: contains(query) }] },
              select: { id: true, name: true, key: true, department: { select: { name: true } } },
              orderBy: { name: 'asc' },
              take: 3,
            }),
          ])

          const hits: SearchHit[] = items.map((row) => {
            const category = MASTER_DATA_CATEGORY_MAP.get(row.categoryKey)
            return {
              id: `master:${row.id}`,
              type: 'master-data' as const,
              title: row.name,
              subtitle: [category?.name, row.code].filter(Boolean).join(' · '),
              href: masterDataHref(row.categoryKey, row.name),
              group: 'Master Data',
            }
          })

          for (const row of departments) {
            hits.push({
              id: `department:${row.id}`,
              type: 'master-data',
              title: row.name,
              subtitle: ['Department', row.key].filter(Boolean).join(' · '),
              href: masterDataHref('DEPARTMENT', row.name),
              group: 'Master Data',
            })
          }

          for (const row of teams) {
            hits.push({
              id: `team:${row.id}`,
              type: 'master-data',
              title: row.name,
              subtitle: ['Team', row.department.name, row.key].filter(Boolean).join(' · '),
              href: masterDataHref('TEAM', row.name),
              group: 'Master Data',
            })
          }

          return hits.slice(0, LIMIT + 2)
        })(),
      ),
    )
  }

  if (hasPermission(permissions, 'activity:view')) {
    tasks.push(
      settled(
        prisma.activity
          .findMany({
            where: {
              AND: [
                activityVisibility(auth),
                {
                  OR: [
                    { relatedName: contains(query) },
                    { notes: contains(query) },
                    { outcome: contains(query) },
                    { nextAction: contains(query) },
                  ],
                },
              ],
            },
            select: { id: true, type: true, relatedName: true, notes: true, outcome: true, occurredAt: true },
            orderBy: { occurredAt: 'desc' },
            take: LIMIT,
          })
          .then((rows) =>
            rows.map((row) => ({
              id: `activity:${row.id}`,
              type: 'activity' as const,
              title: row.relatedName || String(row.type).replace(/_/g, ' '),
              subtitle: [String(row.type).replace(/_/g, ' '), row.outcome || row.notes].filter(Boolean).join(' · '),
              href: `/activity-history?q=${encodeURIComponent(row.relatedName || query)}`,
              group: 'Activity',
            })),
          ),
      ),
    )
  }

  if (hasPermission(permissions, 'audit:view')) {
    tasks.push(
      settled(
        prisma.auditLog
          .findMany({
            where: {
              AND: [
                auditVisibility(auth),
                {
                  OR: [
                    { action: contains(query) },
                    { entityType: contains(query) },
                    { user: { fullName: contains(query) } },
                    { user: { email: contains(query) } },
                  ],
                },
              ],
            },
            select: {
              id: true,
              action: true,
              entityType: true,
              user: { select: { fullName: true } },
            },
            orderBy: { createdAt: 'desc' },
            take: LIMIT,
          })
          .then((rows) =>
            rows.map((row) => ({
              id: `audit:${row.id}`,
              type: 'audit' as const,
              title: row.action.replace(/_/g, ' '),
              subtitle: [row.entityType, row.user?.fullName].filter(Boolean).join(' · '),
              href: `/audit-logs?q=${encodeURIComponent(row.action)}`,
              group: 'Audit Log',
            })),
          ),
      ),
    )
  }

  const groups = await Promise.all(tasks)
  return groups.flat()
}
