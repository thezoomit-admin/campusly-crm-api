import type { DataScope, Prisma, UserStatus } from '../../lib/prisma-client'
import { config } from '../../config'
import { writeAuditLog } from '../../lib/audit'
import { httpError } from '../../lib/http-error'
import { prisma } from '../../lib/prisma'
import { defaultScopesForRole, isCriticalPermission, permissionLabel, userDirectoryScope } from '../auth/access'
import { normalizeEmail, normalizeUsername } from '../auth/identifier'
import { hashPassword } from '../auth/password'
import { requestPasswordReset } from '../auth/password-reset.service'
import type { AuthContext } from '../auth/session.service'
import { revokeSession, revokeUserSessions } from '../auth/session.service'
import { notifyCriticalPermissionChanges } from '../notifications/notifications.service'
import { saveUserProfilePhoto } from './users.storage'

const userListInclude = {
  primaryRole: true,
  department: true,
  team: true,
} as const

const userDetailInclude = {
  primaryRole: true,
  department: true,
  team: true,
  dataScopes: true,
} as const

function parseMobile(value: unknown) {
  if (typeof value !== 'string') {
    return ''
  }
  return value.replace(/[\s()-]/g, '')
}

function isValidMobile(value: string) {
  return /^\+?[0-9]{10,15}$/.test(value)
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function rethrowUnique(error: unknown): never {
  if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') {
    const target = 'meta' in error ? JSON.stringify((error as { meta?: { target?: unknown } }).meta?.target) : ''
    if (target.includes('username')) {
      throw httpError.duplicateUsername()
    }
    if (target.includes('email')) {
      throw httpError.duplicateEmail()
    }
  }
  throw error
}

async function countActiveAdmins(excludeUserId?: string) {
  return prisma.user.count({
    where: {
      status: 'ACTIVE',
      ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
      primaryRole: { key: 'admin' },
    },
  })
}

async function assertNotLastAdmin(userId: string, nextStatus?: UserStatus, nextRoleId?: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { primaryRole: true },
  })

  if (user.primaryRole?.key !== 'admin' || user.status !== 'ACTIVE') {
    return
  }

  const remaining = await countActiveAdmins(userId)
  const leavingAdmin =
    (nextStatus && nextStatus !== 'ACTIVE') ||
    (nextRoleId && nextRoleId !== user.primaryRoleId)

  if (leavingAdmin && remaining < 1) {
    throw httpError.cannotRemoveAccess()
  }
}

function visibilityWhere(auth: AuthContext): Prisma.UserWhereInput {
  const scope = userDirectoryScope(auth.role.key)

  if (scope === 'ALL') {
    return {}
  }

  if (scope === 'TEAM' && auth.user.teamId) {
    return { teamId: auth.user.teamId }
  }

  return { id: auth.user.id }
}

function effectLabel(effect: string) {
  if (effect === 'ALLOW' || effect === 'ALLOWED') return 'Allowed'
  if (effect === 'DENY' || effect === 'DENIED') return 'Denied'
  if (effect === 'ROLE_DEFAULT') return 'Role default'
  return effect
}

async function assertCanViewUser(auth: AuthContext, userId: string) {
  if (userId === auth.user.id) {
    return
  }

  const visible = await prisma.user.findFirst({
    where: { id: userId, AND: [visibilityWhere(auth)] },
  })

  if (!visible) {
    throw httpError.accessDenied()
  }
}

async function resolveRole(roleId: unknown, { requireActive } = { requireActive: true }) {
  if (typeof roleId !== 'string' || !roleId) {
    throw httpError.roleMissing()
  }

  const role = await prisma.role.findUnique({ where: { id: roleId } })
  if (!role) {
    throw httpError.roleMissing()
  }
  if (requireActive && role.status !== 'ACTIVE') {
    throw httpError.badRequest('Please assign a role to the user.', 'ROLE_MISSING')
  }
  return role
}

async function resolveDepartment(departmentId: unknown) {
  if (departmentId == null || departmentId === '') {
    return null
  }
  if (typeof departmentId !== 'string') {
    throw httpError.badRequest('Invalid department.')
  }
  const department = await prisma.department.findUnique({ where: { id: departmentId } })
  if (!department || department.status !== 'ACTIVE') {
    throw httpError.badRequest('Department is not available.')
  }
  return department
}

async function resolveTeam(teamId: unknown, departmentId: string | null) {
  if (teamId == null || teamId === '') {
    return null
  }
  if (typeof teamId !== 'string') {
    throw httpError.badRequest('Invalid team.')
  }
  const team = await prisma.team.findUnique({ where: { id: teamId } })
  if (!team || team.status !== 'ACTIVE') {
    throw httpError.badRequest('Team is not available.')
  }
  if (departmentId && team.departmentId !== departmentId) {
    throw httpError.badRequest('Team must belong to the selected department.')
  }
  return team
}

function serializeUser(
  user: Prisma.UserGetPayload<{ include: typeof userDetailInclude }> | Prisma.UserGetPayload<{ include: typeof userListInclude }>,
  extra: Record<string, unknown> = {},
) {
  const detail = 'dataScopes' in user ? user : null

  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    username: user.username,
    mobile: user.mobile,
    status: user.status,
    role: user.primaryRole
      ? { id: user.primaryRole.id, key: user.primaryRole.key, name: user.primaryRole.name, status: user.primaryRole.status }
      : null,
    department: user.department ? { id: user.department.id, name: user.department.name } : null,
    team: user.team ? { id: user.team.id, name: user.team.name } : null,
    photoUrl: user.photoUrl,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    acceptsLeadAssignment: user.status === 'ACTIVE',
    inactiveOwnerLeadCount: 0,
    dataScopes: detail
      ? Object.fromEntries(detail.dataScopes.map((row) => [row.resource, row.scope]))
      : undefined,
    ...extra,
  }
}

export async function listUsers(
  auth: AuthContext,
  query: {
    search?: string
    roleId?: string
    departmentId?: string
    teamId?: string
    status?: string
  },
) {
  const where: Prisma.UserWhereInput = {
    AND: [
      visibilityWhere(auth),
      query.search
        ? {
            OR: [
              { fullName: { contains: query.search, mode: 'insensitive' } },
              { email: { contains: query.search, mode: 'insensitive' } },
              { username: { contains: query.search, mode: 'insensitive' } },
              { mobile: { contains: query.search } },
            ],
          }
        : {},
      query.roleId ? { primaryRoleId: query.roleId } : {},
      query.departmentId ? { departmentId: query.departmentId } : {},
      query.teamId ? { teamId: query.teamId } : {},
      query.status && ['ACTIVE', 'INACTIVE', 'SUSPENDED'].includes(query.status)
        ? { status: query.status as UserStatus }
        : {},
    ],
  }

  const users = await prisma.user.findMany({
    where,
    include: userListInclude,
    orderBy: { fullName: 'asc' },
  })

  return users.map((user) => serializeUser(user))
}

export async function getUser(auth: AuthContext, id: string) {
  await assertCanViewUser(auth, id)
  const user = await prisma.user.findUnique({
    where: { id },
    include: userDetailInclude,
  })
  if (!user) {
    throw httpError.notFound('User not found.')
  }
  return serializeUser(user)
}

async function applyUserPhoto(userId: string, photo?: Express.Multer.File) {
  if (!photo) {
    return null
  }
  const saved = await saveUserProfilePhoto(userId, photo)
  await prisma.user.update({
    where: { id: userId },
    data: { photoUrl: saved.url },
  })
  return saved.url
}

export async function createUser(
  auth: AuthContext,
  input: Record<string, unknown>,
  meta: { ipAddress?: string; userAgent?: string },
  photo?: Express.Multer.File,
) {
  const fullName = typeof input.fullName === 'string' ? input.fullName.trim() : ''
  const email = typeof input.email === 'string' ? normalizeEmail(input.email) : ''
  const username = typeof input.username === 'string' ? normalizeUsername(input.username) : ''
  const mobile = parseMobile(input.mobile)
  const password = typeof input.password === 'string' ? input.password : ''
  const status =
    input.status === 'INACTIVE' || input.status === 'SUSPENDED' ? (input.status as UserStatus) : 'ACTIVE'

  if (fullName.length < 2 || fullName.length > 100) {
    throw httpError.badRequest('Full name must be 2–100 characters.')
  }
  if (!isValidEmail(email)) {
    throw httpError.badRequest('Please enter a valid email.')
  }
  if (!isValidMobile(mobile)) {
    throw httpError.badRequest('Please enter a valid mobile number.')
  }
  if (!username) {
    throw httpError.badRequest('Username is required.')
  }
  if (password && password.length < config.minPasswordLength) {
    throw httpError.badRequest(`Password must be at least ${config.minPasswordLength} characters.`)
  }

  const role = await resolveRole(input.roleId)
  const department = await resolveDepartment(input.departmentId)
  const team = await resolveTeam(input.teamId, department?.id ?? null)
  const passwordHash = await hashPassword(
    password || randomTempPassword(),
  )

  try {
    const user = await prisma.user.create({
      data: {
        fullName,
        email,
        username,
        mobile,
        passwordHash,
        status,
        primaryRoleId: role.id,
        departmentId: department?.id ?? null,
        teamId: team?.id ?? null,
      },
      include: userDetailInclude,
    })

    const scopes = defaultScopesForRole(role.key)
    await prisma.userDataScope.createMany({
      data: Object.entries(scopes).map(([resource, scope]) => ({
        userId: user.id,
        resource,
        scope,
      })),
    })

    await prisma.roleHistory.create({
      data: {
        userId: user.id,
        toRoleId: role.id,
        changedById: auth.user.id,
      },
    })

    await applyUserPhoto(user.id, photo)

    await writeAuditLog({
      userId: auth.user.id,
      action: 'USER_CREATED',
      entityType: 'user',
      entityId: user.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { email, username, role: role.key },
    })

    let reset: Record<string, unknown> | undefined
    if (!password) {
      const requested = await requestPasswordReset({
        identifier: email,
        actorId: auth.user.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      })
      reset = requested.body
    }

    const created = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      include: userDetailInclude,
    })

    return { user: serializeUser(created), reset }
  } catch (error) {
    rethrowUnique(error)
  }
}

function randomTempPassword() {
  return `Tmp!${Math.random().toString(36).slice(2, 10)}A1`
}

export async function updateUser(
  auth: AuthContext,
  id: string,
  input: Record<string, unknown>,
  meta: { ipAddress?: string; userAgent?: string },
  photo?: Express.Multer.File,
) {
  const existing = await prisma.user.findUnique({
    where: { id },
    include: { primaryRole: true },
  })
  if (!existing) {
    throw httpError.notFound('User not found.')
  }

  const data: Prisma.UserUpdateInput = {}
  const changes: Record<string, unknown> = {}

  if (typeof input.fullName === 'string') {
    const fullName = input.fullName.trim()
    if (fullName.length < 2 || fullName.length > 100) {
      throw httpError.badRequest('Full name must be 2–100 characters.')
    }
    data.fullName = fullName
    changes.fullName = fullName
  }

  if (typeof input.email === 'string') {
    const email = normalizeEmail(input.email)
    if (!isValidEmail(email)) {
      throw httpError.badRequest('Please enter a valid email.')
    }
    data.email = email
    changes.email = email
  }

  if (typeof input.username === 'string') {
    const username = normalizeUsername(input.username)
    if (!username) {
      throw httpError.badRequest('Username is required.')
    }
    data.username = username
    changes.username = username
  }

  if (typeof input.mobile === 'string') {
    const mobile = parseMobile(input.mobile)
    if (!isValidMobile(mobile)) {
      throw httpError.badRequest('Please enter a valid mobile number.')
    }
    data.mobile = mobile
    changes.mobile = mobile
  }

  if (input.departmentId !== undefined) {
    const department = await resolveDepartment(input.departmentId)
    data.department = department ? { connect: { id: department.id } } : { disconnect: true }
    changes.departmentId = department?.id ?? null
  }

  if (input.teamId !== undefined) {
    const departmentId =
      input.departmentId === undefined
        ? existing.departmentId
        : typeof input.departmentId === 'string' && input.departmentId
          ? input.departmentId
          : null
    const team = await resolveTeam(input.teamId, departmentId)
    data.team = team ? { connect: { id: team.id } } : { disconnect: true }
    changes.teamId = team?.id ?? null
  }

  if (typeof input.roleId === 'string' && input.roleId !== existing.primaryRoleId) {
    if (id === auth.user.id && !auth.permissions.includes('permission:configure')) {
      throw httpError.accessDenied()
    }
    const role = await resolveRole(input.roleId)
    await assertNotLastAdmin(id, existing.status, role.id)
    data.primaryRole = { connect: { id: role.id } }
    changes.roleId = role.id

    await prisma.roleHistory.create({
      data: {
        userId: id,
        fromRoleId: existing.primaryRoleId,
        toRoleId: role.id,
        changedById: auth.user.id,
      },
    })

    const scopes = defaultScopesForRole(role.key)
    for (const [resource, scope] of Object.entries(scopes)) {
      await prisma.userDataScope.upsert({
        where: { userId_resource: { userId: id, resource } },
        update: { scope },
        create: { userId: id, resource, scope },
      })
    }

    await writeAuditLog({
      userId: auth.user.id,
      action: 'USER_ROLE_CHANGED',
      entityType: 'user',
      entityId: id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { from: existing.primaryRole?.key ?? null, to: role.key },
    })
  }

  try {
    await prisma.user.update({
      where: { id },
      data,
    })
    await applyUserPhoto(id, photo)

    const user = await prisma.user.findUniqueOrThrow({
      where: { id },
      include: userDetailInclude,
    })

    await writeAuditLog({
      userId: auth.user.id,
      action: 'USER_UPDATED',
      entityType: 'user',
      entityId: id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: changes as Prisma.InputJsonValue,
    })

    return serializeUser(user)
  } catch (error) {
    rethrowUnique(error)
  }
}

export async function updateUserPhoto(
  auth: AuthContext,
  id: string,
  file: Express.Multer.File | undefined,
  meta: { ipAddress?: string; userAgent?: string },
) {
  if (!file) {
    throw httpError.invalidUpload('Please select a profile photo.')
  }

  const existing = await prisma.user.findUnique({ where: { id } })
  if (!existing) {
    throw httpError.notFound('User not found.')
  }

  await applyUserPhoto(id, file)
  const user = await prisma.user.findUniqueOrThrow({
    where: { id },
    include: userDetailInclude,
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'USER_UPDATED',
    entityType: 'user',
    entityId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { photo: true },
  })

  return serializeUser(user)
}

export async function updateUserStatus(
  auth: AuthContext,
  id: string,
  status: UserStatus,
  meta: { ipAddress?: string; userAgent?: string },
) {
  if (!['ACTIVE', 'INACTIVE', 'SUSPENDED'].includes(status)) {
    throw httpError.badRequest('Invalid status.')
  }

  await assertNotLastAdmin(id, status)

  const user = await prisma.user.update({
    where: { id },
    data: { status },
    include: userDetailInclude,
  })

  if (status !== 'ACTIVE') {
    await revokeUserSessions(id)
  }

  await writeAuditLog({
    userId: auth.user.id,
    action: 'USER_STATUS_CHANGED',
    entityType: 'user',
    entityId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { status, acceptsLeadAssignment: status === 'ACTIVE' },
  })

  return serializeUser(user)
}

export async function listUserSessions(auth: AuthContext, id: string) {
  await assertCanViewUser(auth, id)
  const sessions = await prisma.session.findMany({
    where: { userId: id },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })

  return sessions.map((session) => ({
    id: session.id,
    ipAddress: session.ipAddress,
    userAgent: session.userAgent,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    expiresAt: session.expiresAt,
    revokedAt: session.revokedAt,
    current: session.id === auth.sessionId,
    active: !session.revokedAt && session.expiresAt > new Date(),
  }))
}

export async function forceLogoutSession(
  auth: AuthContext,
  userId: string,
  sessionId: string,
  meta: { ipAddress?: string; userAgent?: string },
) {
  const session = await prisma.session.findFirst({
    where: { id: sessionId, userId },
  })

  if (!session || session.revokedAt) {
    throw httpError.sessionError()
  }

  try {
    await revokeSession(session.id)
  } catch {
    throw httpError.sessionError()
  }

  await writeAuditLog({
    userId: auth.user.id,
    action: 'SESSION_TERMINATED',
    entityType: 'user',
    entityId: userId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { sessionId },
  })
}

export async function forceLogoutAll(
  auth: AuthContext,
  userId: string,
  meta: { ipAddress?: string; userAgent?: string },
) {
  await revokeUserSessions(userId)
  await writeAuditLog({
    userId: auth.user.id,
    action: 'SESSION_TERMINATED',
    entityType: 'user',
    entityId: userId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { all: true },
  })
}

export async function setUserOverrides(
  auth: AuthContext,
  userId: string,
  overrides: unknown,
  meta: { ipAddress?: string; userAgent?: string },
) {
  if (auth.user.id === userId) {
    throw httpError.accessDenied()
  }

  if (!Array.isArray(overrides)) {
    throw httpError.badRequest('Invalid permission override payload.')
  }

  const existing = await prisma.user.findUnique({
    where: { id: userId },
    include: { permissionOverrides: { include: { permission: true } } },
  })
  if (!existing) {
    throw httpError.notFound('User not found.')
  }

  const previous = new Map(existing.permissionOverrides.map((row) => [row.permissionId, row]))
  const nextRows: Array<{ permissionId: string; effect: 'ALLOW' | 'DENY'; resource: string; action: string }> = []

  for (const item of overrides) {
    if (!item || typeof item !== 'object') {
      continue
    }
    const row = item as { permissionId?: string; effect?: string }
    if (!row.permissionId || (row.effect !== 'ALLOW' && row.effect !== 'DENY')) {
      continue
    }
    const permission = await prisma.permission.findUnique({ where: { id: row.permissionId } })
    if (!permission) {
      throw httpError.invalidPermission()
    }
    nextRows.push({
      permissionId: permission.id,
      effect: row.effect,
      resource: permission.resource,
      action: permission.action,
    })
  }

  const historyChanges: Array<{ resource: string; action: string; from: string; to: string }> = []

  await prisma.$transaction(async (tx) => {
    await tx.userPermissionOverride.deleteMany({ where: { userId } })
    if (nextRows.length > 0) {
      await tx.userPermissionOverride.createMany({
        data: nextRows.map((row) => ({
          userId,
          permissionId: row.permissionId,
          effect: row.effect,
        })),
      })
    }

    for (const row of nextRows) {
      const previousEffect = previous.get(row.permissionId)?.effect ?? 'ROLE_DEFAULT'
      if (previousEffect !== row.effect) {
        await tx.permissionHistory.create({
          data: {
            userId,
            permissionId: row.permissionId,
            previousEffect: String(previousEffect),
            newEffect: row.effect,
            changedById: auth.user.id,
          },
        })
        historyChanges.push({
          resource: row.resource,
          action: row.action,
          from: String(previousEffect),
          to: row.effect,
        })
      }
    }

    for (const [permissionId, row] of previous) {
      if (nextRows.some((next) => next.permissionId === permissionId)) continue
      await tx.permissionHistory.create({
        data: {
          userId,
          permissionId,
          previousEffect: String(row.effect),
          newEffect: 'ROLE_DEFAULT',
          changedById: auth.user.id,
        },
      })
      historyChanges.push({
        resource: row.permission.resource,
        action: row.permission.action,
        from: String(row.effect),
        to: 'ROLE_DEFAULT',
      })
    }
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'USER_PERMISSION_OVERRIDE_CHANGED',
    entityType: 'user',
    entityId: userId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { overrides: nextRows },
  })

  const criticalChanges = historyChanges.filter((change) => isCriticalPermission(change.resource, change.action))
  if (criticalChanges.length > 0) {
    await notifyCriticalPermissionChanges({
      userIds: [userId],
      actorName: auth.user.fullName,
      changes: criticalChanges.map((change) => ({
        label: permissionLabel(change.resource, change.action),
        from: effectLabel(change.from),
        to: effectLabel(change.to),
      })),
    })
  }

  return getUser(auth, userId)
}

export async function setUserScopes(
  auth: AuthContext,
  userId: string,
  scopes: unknown,
  meta: { ipAddress?: string; userAgent?: string },
) {
  if (!scopes || typeof scopes !== 'object') {
    throw httpError.badRequest('Invalid data scope payload.')
  }

  const entries = Object.entries(scopes as Record<string, string>)
  const allowed: DataScope[] = ['OWN', 'TEAM', 'DEPARTMENT', 'ALL']

  for (const [resource, scope] of entries) {
    if (!allowed.includes(scope as DataScope)) {
      throw httpError.badRequest('Invalid data scope.')
    }
    await prisma.userDataScope.upsert({
      where: { userId_resource: { userId, resource } },
      update: { scope: scope as DataScope },
      create: { userId, resource, scope: scope as DataScope },
    })
  }

  await writeAuditLog({
    userId: auth.user.id,
    action: 'USER_DATA_SCOPE_CHANGED',
    entityType: 'user',
    entityId: userId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: scopes as Prisma.InputJsonValue,
  })

  return getUser(auth, userId)
}

export async function listUserActivity(auth: AuthContext, userId: string) {
  await assertCanViewUser(auth, userId)
  return prisma.auditLog.findMany({
    where: {
      OR: [{ userId }, { entityType: 'user', entityId: userId }],
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
}
