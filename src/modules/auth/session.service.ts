import { createHash, randomBytes } from 'node:crypto'
import type { DataScope, OverrideEffect } from '../../lib/prisma-client'
import { config, SESSION_COOKIE } from '../../config'
import { prisma } from '../../lib/prisma'
import { mergePermissions, mergeScopes, type ScopeMap } from './access'

export type AuthUser = {
  id: string
  fullName: string
  email: string
  username: string
  mobile: string
  photoUrl?: string | null
  status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED'
  departmentId: string | null
  teamId: string | null
  primaryRoleId: string
}

export type AuthContext = {
  sessionId: string
  user: AuthUser
  role: {
    id: string
    key: string
    name: string
  }
  roles: string[]
  permissions: string[]
  dataScopes: ScopeMap
  dataScope: ScopeMap
}

const userAuthInclude = {
  primaryRole: {
    include: {
      permissions: { include: { permission: true } },
    },
  },
  permissionOverrides: { include: { permission: true } },
  dataScopes: true,
} as const

export function hashSessionToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

export function createSessionToken() {
  return randomBytes(32).toString('base64url')
}

export function sessionDurationMs(rememberMe: boolean) {
  if (rememberMe) {
    return config.rememberMeDays * 24 * 60 * 60 * 1000
  }

  return config.sessionHours * 60 * 60 * 1000
}

export function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.isProduction,
    path: '/',
    maxAge,
  }
}

export function clearCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.isProduction,
    path: '/',
  }
}

export function buildAuthContext(input: {
  sessionId: string
  user: {
    id: string
    fullName: string
    email: string
    username: string
    mobile: string
    photoUrl?: string | null
    status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED'
    departmentId: string | null
    teamId: string | null
    primaryRoleId: string | null
    primaryRole: {
      id: string
      key: string
      name: string
      permissions: Array<{ permission: { resource: string; action: string } }>
    }
    permissionOverrides: Array<{
      effect: OverrideEffect
      permission: { resource: string; action: string }
    }>
    dataScopes: Array<{ resource: string; scope: DataScope }>
  }
}): AuthContext {
  const permissions = mergePermissions(
    input.user.primaryRole.permissions.map((entry) => entry.permission),
    input.user.permissionOverrides.map((entry) => ({
      ...entry.permission,
      effect: entry.effect,
    })),
  )
  const dataScopes = mergeScopes(input.user.primaryRole.key, input.user.dataScopes)

  return {
    sessionId: input.sessionId,
    user: {
      id: input.user.id,
      fullName: input.user.fullName,
      email: input.user.email,
      username: input.user.username,
      mobile: input.user.mobile,
      photoUrl: input.user.photoUrl ?? null,
      status: input.user.status,
      departmentId: input.user.departmentId,
      teamId: input.user.teamId,
      primaryRoleId: input.user.primaryRoleId ?? input.user.primaryRole.id,
    },
    role: {
      id: input.user.primaryRole.id,
      key: input.user.primaryRole.key,
      name: input.user.primaryRole.name,
    },
    roles: [input.user.primaryRole.key],
    permissions,
    dataScopes,
    dataScope: dataScopes,
  }
}

export async function createSession(input: {
  userId: string
  rememberMe: boolean
  ipAddress?: string
  userAgent?: string
}) {
  const token = createSessionToken()
  const maxAge = sessionDurationMs(input.rememberMe)
  const expiresAt = new Date(Date.now() + maxAge)

  const session = await prisma.session.create({
    data: {
      userId: input.userId,
      tokenHash: hashSessionToken(token),
      expiresAt,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      lastActiveAt: new Date(),
    },
  })

  return { token, maxAge, cookieName: SESSION_COOKIE, sessionId: session.id }
}

export async function loadAuthFromToken(token: string | undefined): Promise<AuthContext | null> {
  if (!token) {
    return null
  }

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    relationLoadStrategy: 'join',
    include: {
      user: { include: userAuthInclude },
    },
  })

  if (!session || session.revokedAt || session.expiresAt <= new Date()) {
    return null
  }

  if (!session.user.primaryRole || session.user.status !== 'ACTIVE' || session.user.primaryRole.status !== 'ACTIVE') {
    return null
  }

  if (Date.now() - session.lastActiveAt.getTime() > 60_000) {
    await prisma.session.update({
      where: { id: session.id },
      data: { lastActiveAt: new Date() },
    })
  }

  return buildAuthContext({
    sessionId: session.id,
    user: { ...session.user, primaryRole: session.user.primaryRole },
  })
}

export async function revokeSession(sessionId: string) {
  await prisma.session.update({
    where: { id: sessionId },
    data: { revokedAt: new Date() },
  })
}

/** Light logout path: revoke by cookie token without loading the auth graph. */
export async function revokeSessionByToken(token: string | undefined) {
  if (!token) {
    return null
  }

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    select: { id: true, userId: true, revokedAt: true },
  })

  if (!session || session.revokedAt) {
    return null
  }

  await prisma.session.update({
    where: { id: session.id },
    data: { revokedAt: new Date() },
  })

  return session
}

export async function revokeUserSessions(userId: string, exceptSessionId?: string) {
  await prisma.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date() },
  })
}

export { userAuthInclude }
