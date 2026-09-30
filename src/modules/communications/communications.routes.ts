import { Router } from 'express'
import { routeParam } from '../../lib/request'
import { requireAuth, requirePermission } from '../auth/require-auth.middleware'
import {
  getCommunication,
  listCommunications,
  listLeadCommunications,
  reprocessCommunication,
} from './communications.service'

export const communicationsRouter = Router()

communicationsRouter.use(requireAuth)

function queryString(value: unknown) {
  return typeof value === 'string' ? value.trim() : undefined
}

function queryInt(value: unknown) {
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

communicationsRouter.get('/', requirePermission('communication:view'), async (req, res, next) => {
  try {
    res.json(
      await listCommunications(req.auth!, {
        search: queryString(req.query.search),
        channel: queryString(req.query.channel),
        status: queryString(req.query.status),
        page: queryInt(req.query.page),
        limit: queryInt(req.query.limit),
      }),
    )
  } catch (error) {
    next(error)
  }
})

communicationsRouter.get('/lead/:leadId', requirePermission(['communication:view', 'lead:view']), async (req, res, next) => {
  try {
    res.json(await listLeadCommunications(req.auth!, routeParam(req.params.leadId)))
  } catch (error) {
    next(error)
  }
})

communicationsRouter.get('/:id', requirePermission('communication:view'), async (req, res, next) => {
  try {
    res.json(await getCommunication(req.auth!, routeParam(req.params.id)))
  } catch (error) {
    next(error)
  }
})

communicationsRouter.post('/:id/reprocess', requirePermission('communication:reprocess'), async (req, res, next) => {
  try {
    res.json(await reprocessCommunication(req.auth!, routeParam(req.params.id)))
  } catch (error) {
    next(error)
  }
})
