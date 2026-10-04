import type { Prisma, RecordStatus } from '../../lib/prisma-client'
import { writeAuditLog } from '../../lib/audit'
import { httpError } from '../../lib/http-error'
import { prisma } from '../../lib/prisma'
import { isCriticalPermission, permissionLabel } from '../auth/access'
import { revokeUserSessions, type AuthContext } from '../auth/session.service'
import { notifyCriticalPermissionChanges } from '../notifications/notifications.service'

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
}

export async function listRoles(query: { search?: string; status?: string; assignedUserCount?: string }) {
  const where: Prisma.RoleWhereInput = {
    AND: [
      query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {},
      query.status === 'ACTIVE' || query.status === 'INACTIVE' ? { status: query.status } : {},
    ],
  }

  const roles = await prisma.role.findMany({
    where,
    include: {
      _count: { select: { users: true } },
      permissions: { include: { permission: true } },
    },
    orderBy: { name: 'asc' },
  })

  const parsedCount = query.assignedUserCount?.trim()
  const userCount =
    parsedCount !== undefined && parsedCount !== '' && Number.isInteger(Number(parsedCount)) && Number(parsedCount) >= 0
      ? Number(parsedCount)
      : null

  return roles
    .map((role) => ({
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description,
      status: role.status,
      isSystem: role.isSystem,
      assignedUserCount: role._count.users,
      permissions: role.permissions.map((row) => `${row.permission.resource}:${row.permission.action}`),
      permissionIds: role.permissions.map((row) => row.permissionId),
    }))
    .filter((role) => userCount === null || role.assignedUserCount === userCount)
}

/** Lightweight role list for filters/assign dropdowns — no permission matrix. */
export async function listRoleOptions() {
  const roles = await prisma.role.findMany({
    select: { id: true, key: true, name: true, status: true },
    orderBy: { name: 'asc' },
  })
  return roles
}

async function revokeSessionsForRole(roleId: string) {
  const members = await prisma.user.findMany({
    where: { primaryRoleId: roleId },
    select: { id: true },
  })
  await Promise.all(members.map((member) => revokeUserSessions(member.id)))
}

export async function getRole(id: string) {
  const role = await prisma.role.findUnique({
    where: { id },
    include: {
      _count: { select: { users: true } },
      permissions: { include: { permission: true } },
    },
  })

  if (!role) {
    throw httpError.notFound('Role not found.')
  }

  return {
    id: role.id,
    key: role.key,
    name: role.name,
    description: role.description,
    status: role.status,
    isSystem: role.isSystem,
    assignedUserCount: role._count.users,
    permissions: role.permissions.map((row) => ({
      id: row.permission.id,
      key: `${row.permission.resource}:${row.permission.action}`,
      module: row.permission.module,
      resource: row.permission.resource,
      action: row.permission.action,
    })),
  }
}

export async function createRole(
  auth: AuthContext,
  input: Record<string, unknown>,
  meta: { ipAddress?: string; userAgent?: string },
) {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  const status: RecordStatus = input.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE'

  if (!name) {
    throw httpError.badRequest('Role name is required.')
  }

  const key = slugify(name) || `role_${Date.now()}`
  const exists = await prisma.role.findUnique({ where: { key } })
  if (exists) {
    throw httpError.badRequest('A role with this name already exists.')
  }

  const role = await prisma.role.create({
    data: { key, name, description: description || null, status },
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'ROLE_CREATED',
    entityType: 'role',
    entityId: role.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { name },
  })

  return getRole(role.id)
}

export async function updateRole(
  auth: AuthContext,
  id: string,
  input: Record<string, unknown>,
  meta: { ipAddress?: string; userAgent?: string },
) {
  const existing = await prisma.role.findUnique({ where: { id } })
  if (!existing) {
    throw httpError.notFound('Role not found.')
  }

  if (existing.isSystem && input.status === 'INACTIVE') {
    throw httpError.cannotRemoveAccess()
  }

  const role = await prisma.role.update({
    where: { id },
    data: {
      name: typeof input.name === 'string' ? input.name.trim() : undefined,
      description: typeof input.description === 'string' ? input.description.trim() : undefined,
      status: input.status === 'ACTIVE' || input.status === 'INACTIVE' ? input.status : undefined,
    },
  })

  if (role.status === 'INACTIVE' && existing.status !== 'INACTIVE') {
    await revokeSessionsForRole(id)
  }

  await writeAuditLog({
    userId: auth.user.id,
    action: 'ROLE_UPDATED',
    entityType: 'role',
    entityId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { name: role.name, status: role.status },
  })

  return getRole(id)
}

export async function updateRoleStatus(
  auth: AuthContext,
  id: string,
  status: unknown,
  meta: { ipAddress?: string; userAgent?: string },
) {
  if (status !== 'ACTIVE' && status !== 'INACTIVE') {
    throw httpError.badRequest('Invalid status.')
  }

  const existing = await prisma.role.findUnique({ where: { id } })
  if (!existing) {
    throw httpError.notFound('Role not found.')
  }

  if (existing.isSystem && status === 'INACTIVE') {
    throw httpError.cannotRemoveAccess()
  }

  const role = await prisma.role.update({
    where: { id },
    data: { status },
  })

  if (status === 'INACTIVE') {
    await revokeSessionsForRole(id)
  }

  await writeAuditLog({
    userId: auth.user.id,
    action: 'ROLE_STATUS_CHANGED',
    entityType: 'role',
    entityId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { name: role.name, status: role.status },
  })

  return getRole(id)
}

export async function deleteRole(
  auth: AuthContext,
  id: string,
  meta: { ipAddress?: string; userAgent?: string },
) {
  const role = await prisma.role.findUnique({
    where: { id },
    include: { _count: { select: { users: true } } },
  })

  if (!role) {
    throw httpError.notFound('Role not found.')
  }

  if (role.isSystem) {
    throw httpError.cannotRemoveAccess()
  }

  if (role._count.users > 0) {
    throw httpError.roleInUse(role._count.users)
  }

  await prisma.role.delete({ where: { id } })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'ROLE_DELETED',
    entityType: 'role',
    entityId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  })
}

const CRITICAL_ADMIN_PERMISSIONS = ['user:configure', 'role:configure', 'permission:configure']

export async function setRolePermissions(
  auth: AuthContext,
  id: string,
  permissionIds: unknown,
  meta: { ipAddress?: string; userAgent?: string },
) {
  if (!Array.isArray(permissionIds)) {
    throw httpError.badRequest('Invalid permission payload.')
  }

  const role = await prisma.role.findUnique({
    where: { id },
    include: { permissions: { include: { permission: true } } },
  })
  if (!role) {
    throw httpError.notFound('Role not found.')
  }

  const permissions = await prisma.permission.findMany({
    where: { id: { in: permissionIds.filter((item): item is string => typeof item === 'string') } },
  })

  if (permissions.length !== permissionIds.length) {
    throw httpError.invalidPermission()
  }

  if (role.key === 'admin') {
    const nextKeys = new Set(permissions.map((item) => `${item.resource}:${item.action}`))
    if (CRITICAL_ADMIN_PERMISSIONS.some((key) => !nextKeys.has(key))) {
      throw httpError.cannotRemoveAccess()
    }
  }

  const previous = new Map(role.permissions.map((row) => [row.permissionId, `${row.permission.resource}:${row.permission.action}`]))
  const nextIds = new Set(permissions.map((item) => item.id))
  const criticalChanges: Array<{ label: string; from: string; to: string }> = []

  await prisma.$transaction(async (tx) => {
    await tx.rolePermission.deleteMany({ where: { roleId: id } })
    await tx.rolePermission.createMany({
      data: permissions.map((item) => ({ roleId: id, permissionId: item.id })),
    })

    for (const permission of permissions) {
      if (!previous.has(permission.id)) {
        await tx.permissionHistory.create({
          data: {
            roleId: id,
            permissionId: permission.id,
            previousEffect: 'DENIED',
            newEffect: 'ALLOWED',
            changedById: auth.user.id,
          },
        })
        if (isCriticalPermission(permission.resource, permission.action)) {
          criticalChanges.push({
            label: permissionLabel(permission.resource, permission.action),
            from: 'Denied',
            to: 'Allowed',
          })
        }
      }
    }

    for (const [permissionId, key] of previous) {
      if (!nextIds.has(permissionId)) {
        await tx.permissionHistory.create({
          data: {
            roleId: id,
            permissionId,
            previousEffect: 'ALLOWED',
            newEffect: 'DENIED',
            changedById: auth.user.id,
          },
        })
        const [resource, action] = key.split(':')
        if (resource && action && isCriticalPermission(resource, action)) {
          criticalChanges.push({
            label: permissionLabel(resource, action),
            from: 'Allowed',
            to: 'Denied',
          })
        }
      }
    }
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'ROLE_PERMISSIONS_CHANGED',
    entityType: 'role',
    entityId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { permissionCount: permissions.length },
  })

  if (criticalChanges.length > 0) {
    const members = await prisma.user.findMany({
      where: { primaryRoleId: id, NOT: { id: auth.user.id } },
      select: { id: true },
    })
    await notifyCriticalPermissionChanges({
      userIds: members.map((member) => member.id),
      actorName: auth.user.fullName,
      roleName: role.name,
      changes: criticalChanges,
    })
  }

  return getRole(id)
}
