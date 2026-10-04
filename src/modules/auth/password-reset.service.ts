import { createHash, randomBytes } from 'node:crypto'
import { config } from '../../config'
import { writeAuditLog } from '../../lib/audit'
import { HttpError } from '../../lib/http-error'
import { prisma } from '../../lib/prisma'
import type { PasswordTokenPurpose, User } from '../../lib/prisma-client'
import { EmailProviderError, isEmailMockMode } from '../email/email.client'
import { buildAuthActionPath, sendAuthActionEmail } from './auth-mail'
import { isEmailIdentifier, normalizeEmail, normalizeIdentifier, normalizeUsername } from './identifier'
import { hashPassword } from './password'

function hashResetToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

const GENERIC_RESET_MESSAGE = 'If an account exists, password reset instructions have been sent.'
const INVITE_SENT_MESSAGE = 'A secure setup link has been sent to the official email address.'
const INVITE_RESENT_MESSAGE = 'Invite email has been resent.'

function hoursForPurpose(purpose: PasswordTokenPurpose) {
  return purpose === 'INVITE' ? config.inviteTokenHours : config.resetTokenHours
}

function kindForPurpose(purpose: PasswordTokenPurpose) {
  return purpose === 'INVITE' ? ('invite' as const) : ('reset' as const)
}

async function invalidateOpenTokens(userId: string, purpose: PasswordTokenPurpose) {
  await prisma.passwordResetToken.updateMany({
    where: {
      userId,
      purpose,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { usedAt: new Date() },
  })
}

async function issueToken(userId: string, purpose: PasswordTokenPurpose) {
  await invalidateOpenTokens(userId, purpose)

  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + hoursForPurpose(purpose) * 60 * 60 * 1000)

  await prisma.passwordResetToken.create({
    data: {
      userId,
      purpose,
      tokenHash: hashResetToken(token),
      expiresAt,
    },
  })

  return token
}

function publicDevFields(token: string, purpose: PasswordTokenPurpose) {
  if (config.isProduction && !isEmailMockMode()) {
    return {}
  }

  const path = buildAuthActionPath(token, kindForPurpose(purpose))
  return {
    devResetToken: token,
    devResetPath: path,
    setupPath: path,
  }
}

async function deliverTokenEmail(user: Pick<User, 'id' | 'email' | 'fullName'>, purpose: PasswordTokenPurpose) {
  const token = await issueToken(user.id, purpose)
  const delivery = await sendAuthActionEmail({
    to: user.email,
    fullName: user.fullName,
    token,
    kind: kindForPurpose(purpose),
    expiresHours: hoursForPurpose(purpose),
  })

  return {
    token,
    setupPath: delivery.actionPath,
    mocked: delivery.mocked,
  }
}

export async function sendAccountInvite(input: {
  userId: string
  actorId?: string | null
  ipAddress?: string
  userAgent?: string
  resent?: boolean
}) {
  const user = await prisma.user.findUnique({ where: { id: input.userId } })
  if (!user) {
    throw new HttpError(404, 'User not found.', 'USER_NOT_FOUND')
  }
  if (user.status === 'SUSPENDED') {
    throw new HttpError(403, 'This user account has been suspended.', 'ACCOUNT_SUSPENDED')
  }
  if (user.status !== 'INVITED') {
    throw new HttpError(400, 'Only invited accounts can receive a setup invite.', 'INVITE_NOT_ALLOWED')
  }

  try {
    const delivered = await deliverTokenEmail(user, 'INVITE')

    await writeAuditLog({
      userId: input.actorId ?? user.id,
      action: input.resent ? 'ACCOUNT_INVITE_RESENT' : 'ACCOUNT_INVITE_SENT',
      entityType: 'user',
      entityId: user.id,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      metadata: { email: user.email, mocked: delivered.mocked },
    })

    return {
      ok: true as const,
      body: {
        message: input.resent ? INVITE_RESENT_MESSAGE : INVITE_SENT_MESSAGE,
        inviteSent: true as const,
        email: user.email,
        ...publicDevFields(delivered.token, 'INVITE'),
      },
    }
  } catch (error) {
    if (error instanceof EmailProviderError) {
      throw new HttpError(
        502,
        'Unable to send the account invite email. Check SMTP settings and try again.',
        'INVITE_EMAIL_FAILED',
      )
    }
    throw error
  }
}

export async function requestPasswordReset(input: {
  identifier: unknown
  actorId?: string | null
  ipAddress?: string
  userAgent?: string
}) {
  const identifier = typeof input.identifier === 'string' ? normalizeIdentifier(input.identifier) : ''

  if (!identifier) {
    return {
      ok: true as const,
      body: { message: GENERIC_RESET_MESSAGE },
    }
  }

  const user = isEmailIdentifier(identifier)
    ? await prisma.user.findUnique({ where: { email: normalizeEmail(identifier) } })
    : await prisma.user.findUnique({ where: { username: normalizeUsername(identifier) } })

  if (!user || user.status === 'SUSPENDED' || user.status === 'INACTIVE') {
    await writeAuditLog({
      action: 'PASSWORD_RESET_REQUESTED',
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      metadata: { result: 'ignored' },
    })
    return {
      ok: true as const,
      body: { message: GENERIC_RESET_MESSAGE },
    }
  }

  if (user.status === 'INVITED') {
    try {
      const invited = await sendAccountInvite({
        userId: user.id,
        actorId: input.actorId,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        resent: true,
      })
      return {
        ok: true as const,
        body: {
          message: input.actorId ? invited.body.message : GENERIC_RESET_MESSAGE,
          inviteSent: true as const,
          ...('devResetPath' in invited.body
            ? { devResetPath: invited.body.devResetPath, setupPath: invited.body.setupPath }
            : {}),
        },
      }
    } catch (error) {
      if (input.actorId) {
        throw error
      }
      return {
        ok: true as const,
        body: { message: GENERIC_RESET_MESSAGE },
      }
    }
  }

  try {
    const delivered = await deliverTokenEmail(user, 'RESET')

    await writeAuditLog({
      userId: input.actorId ?? user.id,
      action: 'PASSWORD_RESET_REQUESTED',
      entityType: 'user',
      entityId: user.id,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      metadata: { mocked: delivered.mocked },
    })

    return {
      ok: true as const,
      body: {
        message: GENERIC_RESET_MESSAGE,
        ...publicDevFields(delivered.token, 'RESET'),
      },
    }
  } catch (error) {
    if (error instanceof EmailProviderError) {
      // Public forgot-password stays generic; admin-triggered paths surface this via HttpError.
      if (input.actorId) {
        throw new HttpError(
          502,
          'Unable to send the password reset email. Check SMTP settings and try again.',
          'RESET_EMAIL_FAILED',
        )
      }
      await writeAuditLog({
        userId: user.id,
        action: 'PASSWORD_RESET_REQUESTED',
        entityType: 'user',
        entityId: user.id,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        metadata: { result: 'email_failed' },
      })
      return {
        ok: true as const,
        body: { message: GENERIC_RESET_MESSAGE },
      }
    }
    throw error
  }
}

export async function completePasswordReset(input: {
  token: unknown
  password: unknown
  ipAddress?: string
  userAgent?: string
}) {
  const token = typeof input.token === 'string' ? input.token.trim() : ''
  const password = typeof input.password === 'string' ? input.password : ''

  if (!token || password.length < config.minPasswordLength) {
    return {
      ok: false as const,
      status: 400,
      body: {
        error: `Password must be at least ${config.minPasswordLength} characters.`,
        code: 'INVALID_INPUT',
      },
    }
  }

  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashResetToken(token) },
    include: { user: true },
  })

  if (!record || record.usedAt || record.expiresAt <= new Date()) {
    return {
      ok: false as const,
      status: 400,
      body: { error: 'This link is invalid or has expired.', code: 'INVALID_RESET_TOKEN' },
    }
  }

  if (record.user.status === 'SUSPENDED') {
    return {
      ok: false as const,
      status: 403,
      body: { error: 'This user account has been suspended.', code: 'ACCOUNT_SUSPENDED' },
    }
  }

  if (record.purpose === 'INVITE' && record.user.status !== 'INVITED') {
    return {
      ok: false as const,
      status: 400,
      body: { error: 'This invite link is no longer valid.', code: 'INVALID_INVITE_TOKEN' },
    }
  }

  if (record.purpose === 'RESET' && record.user.status === 'INVITED') {
    return {
      ok: false as const,
      status: 400,
      body: {
        error: 'This account still needs to accept its invite. Request a new setup link.',
        code: 'INVITE_REQUIRED',
      },
    }
  }

  const activatingInvite = record.purpose === 'INVITE' || record.user.status === 'INVITED'
  const passwordHash = await hashPassword(password)

  await prisma.$transaction([
    prisma.user.update({
      where: { id: record.userId },
      data: {
        passwordHash,
        failedLoginAttempts: 0,
        lockedUntil: null,
        ...(activatingInvite ? { status: 'ACTIVE' as const } : {}),
      },
    }),
    prisma.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
    prisma.passwordResetToken.updateMany({
      where: {
        userId: record.userId,
        usedAt: null,
        id: { not: record.id },
      },
      data: { usedAt: new Date() },
    }),
    prisma.session.updateMany({
      where: { userId: record.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ])

  await writeAuditLog({
    userId: record.userId,
    action: activatingInvite ? 'ACCOUNT_INVITE_ACCEPTED' : 'PASSWORD_RESET_COMPLETED',
    entityType: 'user',
    entityId: record.userId,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
    metadata: { purpose: record.purpose },
  })

  return {
    ok: true as const,
    body: {
      message: activatingInvite
        ? 'Password set successfully. You can sign in now.'
        : 'Password has been reset. Please sign in.',
      activated: activatingInvite,
    },
  }
}

export async function changePassword(input: {
  userId: string
  currentPassword: unknown
  newPassword: unknown
  ipAddress?: string
  userAgent?: string
}) {
  const currentPassword = typeof input.currentPassword === 'string' ? input.currentPassword : ''
  const newPassword = typeof input.newPassword === 'string' ? input.newPassword : ''

  if (newPassword.length < config.minPasswordLength) {
    return {
      ok: false as const,
      status: 400,
      body: {
        error: `Password must be at least ${config.minPasswordLength} characters.`,
        code: 'INVALID_INPUT',
      },
    }
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id: input.userId } })
  const { verifyPassword } = await import('./password')
  const matches = await verifyPassword(user.passwordHash, currentPassword)

  if (!matches) {
    return {
      ok: false as const,
      status: 400,
      body: { error: 'Current password is incorrect.', code: 'INVALID_PASSWORD' },
    }
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(newPassword) },
  })

  await writeAuditLog({
    userId: user.id,
    action: 'PASSWORD_CHANGED',
    entityType: 'user',
    entityId: user.id,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  })

  return {
    ok: true as const,
    body: { message: 'Password updated.' },
  }
}
