import { Router } from 'express'
import { routeParam } from '../../lib/request'
import { requireAuth, requirePermission } from '../auth/require-auth.middleware'
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from './notifications.service'

export const notificationsRouter = Router()

notificationsRouter.use(requireAuth)

function queryNumber(value: unknown) {
  const num = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN
  return Number.isFinite(num) ? num : undefined
}

notificationsRouter.get('/', requirePermission('notification:view'), async (req, res, next) => {
  try {
    res.json(
      await listNotifications(req.auth!, {
        limit: queryNumber(req.query.limit),
        unreadOnly: req.query.unreadOnly === '1' || req.query.unreadOnly === 'true',
      }),
    )
  } catch (error) {
    next(error)
  }
})

notificationsRouter.post('/:id/read', requirePermission('notification:view'), async (req, res, next) => {
  try {
    res.json(await markNotificationRead(req.auth!, routeParam(req.params.id)))
  } catch (error) {
    next(error)
  }
})

notificationsRouter.post('/read-all', requirePermission('notification:view'), async (req, res, next) => {
  try {
    res.json(await markAllNotificationsRead(req.auth!))
  } catch (error) {
    next(error)
  }
})
