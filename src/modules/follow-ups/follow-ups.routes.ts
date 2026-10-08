import { Router } from 'express'
import { requestIp, requestUserAgent, routeParam } from '../../lib/request'
import { requireAuth, requirePermission } from '../auth/require-auth.middleware'
import {
  cancelFollowUp,
  completeFollowUp,
  createFollowUp,
  getFollowUp,
  listFollowUps,
  listLeadFollowUps,
  rescheduleFollowUp,
  updateFollowUpReminder,
} from './follow-ups.service'

export const followUpsRouter = Router()

followUpsRouter.use(requireAuth)

function queryString(value: unknown) {
  return typeof value === 'string' ? value.trim() : undefined
}

function body(req: { body: unknown }) {
  return (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
}

followUpsRouter.get('/', requirePermission('follow_up:view'), async (req, res, next) => {
  try {
    res.json(
      await listFollowUps(req.auth!, {
        search: queryString(req.query.search),
        leadId: queryString(req.query.leadId),
        status: queryString(req.query.status),
      }),
    )
  } catch (error) {
    next(error)
  }
})

followUpsRouter.get('/lead/:leadId', requirePermission('follow_up:view'), async (req, res, next) => {
  try {
    res.json(await listLeadFollowUps(req.auth!, routeParam(req.params.leadId)))
  } catch (error) {
    next(error)
  }
})

followUpsRouter.post('/', requirePermission('follow_up:create'), async (req, res, next) => {
  try {
    res.status(201).json(
      await createFollowUp(req.auth!, body(req), {
        ipAddress: requestIp(req),
        userAgent: requestUserAgent(req),
      }),
    )
  } catch (error) {
    next(error)
  }
})

followUpsRouter.get('/:id', requirePermission('follow_up:view'), async (req, res, next) => {
  try {
    res.json(await getFollowUp(req.auth!, routeParam(req.params.id)))
  } catch (error) {
    next(error)
  }
})

followUpsRouter.post('/:id/reminder', requirePermission('follow_up:edit'), async (req, res, next) => {
  try {
    res.json(await updateFollowUpReminder(req.auth!, routeParam(req.params.id), body(req)))
  } catch (error) {
    next(error)
  }
})

followUpsRouter.post('/:id/complete', requirePermission('follow_up:edit'), async (req, res, next) => {
  try {
    res.json(
      await completeFollowUp(req.auth!, routeParam(req.params.id), body(req), {
        ipAddress: requestIp(req),
        userAgent: requestUserAgent(req),
      }),
    )
  } catch (error) {
    next(error)
  }
})

followUpsRouter.post('/:id/reschedule', requirePermission('follow_up:edit'), async (req, res, next) => {
  try {
    res.json(
      await rescheduleFollowUp(req.auth!, routeParam(req.params.id), body(req), {
        ipAddress: requestIp(req),
        userAgent: requestUserAgent(req),
      }),
    )
  } catch (error) {
    next(error)
  }
})

followUpsRouter.post('/:id/cancel', requirePermission('follow_up:edit'), async (req, res, next) => {
  try {
    res.json(
      await cancelFollowUp(req.auth!, routeParam(req.params.id), body(req), {
        ipAddress: requestIp(req),
        userAgent: requestUserAgent(req),
      }),
    )
  } catch (error) {
    next(error)
  }
})
