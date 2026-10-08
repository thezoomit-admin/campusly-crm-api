import { Router, type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import type { UserStatus } from '../../lib/prisma-client'
import { writeAuditLog } from '../../lib/audit'
import { httpError } from '../../lib/http-error'
import { requestIp, requestUserAgent, routeParam } from '../../lib/request'
import { respondWithExport } from '../../lib/xlsx-export'
import { requestPasswordReset, sendAccountInvite } from '../auth/password-reset.service'
import { requireAuth, requirePermission } from '../auth/require-auth.middleware'
import {
  adminChangeUserPassword,
  createUser,
  exportUsersTable,
  forceLogoutAll,
  forceLogoutSession,
  getUser,
  getUserPhoto,
  listUserActivity,
  listUserSessions,
  listUsers,
  setUserOverrides,
  setUserScopes,
  updateUser,
  updateUserPhoto,
  updateUserStatus,
} from './users.service'
import { MAX_USER_PHOTO_BYTES } from './users.storage'

export const usersRouter = Router()

usersRouter.use(requireAuth)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_USER_PHOTO_BYTES, files: 1 },
})

function acceptPhoto(req: Request, res: Response, next: NextFunction) {
  upload.single('photo')(req, res, (error: unknown) => {
    if (error) {
      next(httpError.invalidUpload('The selected photo could not be uploaded. Use a JPG, PNG, or WEBP file of 5 MB or less.'))
      return
    }
    next()
  })
}

usersRouter.get('/', requirePermission('user:view'), async (req, res, next) => {
  try {
    const users = await listUsers(req.auth!, {
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      roleId: typeof req.query.roleId === 'string' ? req.query.roleId : undefined,
      departmentId: typeof req.query.departmentId === 'string' ? req.query.departmentId : undefined,
      teamId: typeof req.query.teamId === 'string' ? req.query.teamId : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
    })
    res.json({ users })
  } catch (error) {
    next(error)
  }
})

usersRouter.get('/export', requirePermission('user:view'), async (req, res, next) => {
  try {
    const table = await exportUsersTable(req.auth!, {
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      roleId: typeof req.query.roleId === 'string' ? req.query.roleId : undefined,
      departmentId: typeof req.query.departmentId === 'string' ? req.query.departmentId : undefined,
      teamId: typeof req.query.teamId === 'string' ? req.query.teamId : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
    })
    await writeAuditLog({
      userId: req.auth!.user.id,
      action: 'USERS_EXPORTED',
      entityType: 'user',
      ipAddress: requestIp(req),
      userAgent: requestUserAgent(req),
      metadata: {
        format: req.query.format === 'json' ? 'json' : 'xlsx',
        count: table.rows.length,
      },
    })
    await respondWithExport(res, req.query.format, table)
  } catch (error) {
    next(error)
  }
})

usersRouter.post('/', requirePermission('user:create'), acceptPhoto, async (req, res, next) => {
  try {
    const result = await createUser(
      req.auth!,
      req.body ?? {},
      {
        ipAddress: requestIp(req),
        userAgent: requestUserAgent(req),
      },
      req.file,
    )
    res.status(201).json(result)
  } catch (error) {
    next(error)
  }
})

usersRouter.get('/:id', requirePermission('user:view'), async (req, res, next) => {
  try {
    const user = await getUser(req.auth!, routeParam(req.params.id))
    res.json({ user })
  } catch (error) {
    next(error)
  }
})

usersRouter.patch('/:id', requirePermission('user:edit'), acceptPhoto, async (req, res, next) => {
  try {
    const result = await updateUser(
      req.auth!,
      routeParam(req.params.id),
      req.body ?? {},
      {
        ipAddress: requestIp(req),
        userAgent: requestUserAgent(req),
      },
      req.file,
    )
    res.json(result)
  } catch (error) {
    next(error)
  }
})

usersRouter.post('/:id/photo', requirePermission('user:edit'), acceptPhoto, async (req, res, next) => {
  try {
    const user = await updateUserPhoto(req.auth!, routeParam(req.params.id), req.file, {
      ipAddress: requestIp(req),
      userAgent: requestUserAgent(req),
    })
    res.json({ user })
  } catch (error) {
    next(error)
  }
})

usersRouter.get('/:id/photo', requireAuth, async (req, res, next) => {
  try {
    const file = await getUserPhoto(req.auth!, routeParam(req.params.id))
    res.setHeader('Content-Type', file.contentType)
    res.setHeader('Cache-Control', 'private, no-cache, must-revalidate')
    res.setHeader('Content-Disposition', `inline; filename="${file.fileName}"`)
    res.send(file.buffer)
  } catch (error) {
    next(error)
  }
})

usersRouter.post('/:id/status', requirePermission(['user:edit', 'user:configure']), async (req, res, next) => {
  try {
    const status = req.body?.status as UserStatus
    const user = await updateUserStatus(req.auth!, routeParam(req.params.id), status, {
      ipAddress: requestIp(req),
      userAgent: requestUserAgent(req),
    })
    res.json({ user })
  } catch (error) {
    next(error)
  }
})

usersRouter.get('/:id/sessions', requirePermission(['user:view', 'user:configure']), async (req, res, next) => {
  try {
    const sessions = await listUserSessions(req.auth!, routeParam(req.params.id))
    res.json({ sessions })
  } catch (error) {
    next(error)
  }
})

usersRouter.post(
  '/:id/sessions/:sessionId/revoke',
  requirePermission('user:configure'),
  async (req, res, next) => {
    try {
      await forceLogoutSession(req.auth!, routeParam(req.params.id), routeParam(req.params.sessionId), {
        ipAddress: requestIp(req),
        userAgent: requestUserAgent(req),
      })
      res.status(204).end()
    } catch (error) {
      next(error)
    }
  },
)

usersRouter.post('/:id/force-logout', requirePermission('user:configure'), async (req, res, next) => {
  try {
    await forceLogoutAll(req.auth!, routeParam(req.params.id), {
      ipAddress: requestIp(req),
      userAgent: requestUserAgent(req),
    })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

usersRouter.post('/:id/password-reset', requirePermission('user:configure'), async (req, res, next) => {
  try {
    const user = await getUser(req.auth!, routeParam(req.params.id))
    const result =
      user.status === 'INVITED'
        ? await sendAccountInvite({
            userId: user.id,
            actorId: req.auth!.user.id,
            ipAddress: requestIp(req),
            userAgent: requestUserAgent(req),
            resent: true,
          })
        : await requestPasswordReset({
            identifier: user.email,
            actorId: req.auth!.user.id,
            ipAddress: requestIp(req),
            userAgent: requestUserAgent(req),
          })
    res.json(result.body)
  } catch (error) {
    next(error)
  }
})

usersRouter.post('/:id/change-password', requirePermission('user:configure'), async (req, res, next) => {
  try {
    const result = await adminChangeUserPassword(
      req.auth!,
      routeParam(req.params.id),
      {
        currentPassword: req.body?.currentPassword,
        newPassword: req.body?.newPassword,
        confirmPassword: req.body?.confirmPassword,
      },
      {
        ipAddress: requestIp(req),
        userAgent: requestUserAgent(req),
      },
    )
    res.json(result)
  } catch (error) {
    next(error)
  }
})

usersRouter.post('/:id/resend-invite', requirePermission('user:configure'), async (req, res, next) => {
  try {
    const user = await getUser(req.auth!, routeParam(req.params.id))
    const result = await sendAccountInvite({
      userId: user.id,
      actorId: req.auth!.user.id,
      ipAddress: requestIp(req),
      userAgent: requestUserAgent(req),
      resent: true,
    })
    res.json(result.body)
  } catch (error) {
    next(error)
  }
})

usersRouter.put('/:id/overrides', requirePermission('permission:configure'), async (req, res, next) => {
  try {
    if (req.auth!.user.id === routeParam(req.params.id)) {
      next(httpError.accessDenied())
      return
    }
    const user = await setUserOverrides(req.auth!, routeParam(req.params.id), req.body?.overrides, {
      ipAddress: requestIp(req),
      userAgent: requestUserAgent(req),
    })
    res.json({ user })
  } catch (error) {
    next(error)
  }
})

usersRouter.put('/:id/scopes', requirePermission('permission:configure'), async (req, res, next) => {
  try {
    const user = await setUserScopes(req.auth!, routeParam(req.params.id), req.body?.scopes, {
      ipAddress: requestIp(req),
      userAgent: requestUserAgent(req),
    })
    res.json({ user })
  } catch (error) {
    next(error)
  }
})

usersRouter.get('/:id/activity', requirePermission(['user:view', 'audit:view']), async (req, res, next) => {
  try {
    const activity = await listUserActivity(req.auth!, routeParam(req.params.id))
    res.json({ activity })
  } catch (error) {
    next(error)
  }
})
