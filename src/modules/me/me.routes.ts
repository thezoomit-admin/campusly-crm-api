import { Router, type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import { prisma } from '../../lib/prisma'
import { httpError } from '../../lib/http-error'
import { requestIp, requestUserAgent } from '../../lib/request'
import { listActivityFeed } from '../activities/activities.service'
import { serializeAuth } from '../auth/auth.service'
import { requireAuth } from '../auth/require-auth.middleware'
import { refreshAuthContext } from '../auth/session.service'
import { updateOwnProfile } from '../users/users.service'
import { MAX_USER_PHOTO_BYTES } from '../users/users.storage'

export const meRouter = Router()

meRouter.use(requireAuth)

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

function queryString(value: unknown) {
  return typeof value === 'string' ? value.trim() : undefined
}

meRouter.get('/', (req, res) => {
  res.json(serializeAuth(req.auth!))
})

meRouter.patch('/', acceptPhoto, async (req, res, next) => {
  try {
    await updateOwnProfile(
      req.auth!,
      (req.body ?? {}) as Record<string, unknown>,
      {
        ipAddress: requestIp(req),
        userAgent: requestUserAgent(req),
      },
      req.file,
    )
    const nextAuth = await refreshAuthContext(req.auth!.sessionId)
    if (!nextAuth) {
      res.status(401).json({
        error: 'Authentication required',
        code: 'UNAUTHENTICATED',
      })
      return
    }
    res.json(serializeAuth(nextAuth))
  } catch (error) {
    next(error)
  }
})

meRouter.get('/permissions', async (req, res, next) => {
  try {
    const granted = new Set(req.auth!.permissions)
    const rows = await prisma.permission.findMany({
      orderBy: [{ module: 'asc' }, { resource: 'asc' }, { action: 'asc' }],
    })
    const permissions = rows
      .map((row) => ({
        id: row.id,
        key: `${row.resource}:${row.action}`,
        module: row.module,
        resource: row.resource,
        action: row.action,
        description: row.description,
      }))
      .filter((row) => granted.has(row.key))

    res.json({
      role: req.auth!.role,
      dataScopes: req.auth!.dataScopes,
      permissions,
    })
  } catch (error) {
    next(error)
  }
})

meRouter.get('/activity', async (req, res, next) => {
  try {
    const from = queryString(req.query.from)
    const data = await listActivityFeed(req.auth!, {
      from: from || defaultActivityFrom(),
      to: queryString(req.query.to),
      search: queryString(req.query.search),
      category: queryString(req.query.category),
      userId: req.auth!.user.id,
      compare: false,
      take: 5000,
    })
    res.json(data)
  } catch (error) {
    next(error)
  }
})

function defaultActivityFrom() {
  const from = new Date()
  from.setDate(from.getDate() - 364)
  const year = from.getFullYear()
  const month = String(from.getMonth() + 1).padStart(2, '0')
  const day = String(from.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
