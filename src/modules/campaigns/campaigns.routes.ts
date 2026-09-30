import { Router } from 'express'
import { requestIp, requestUserAgent, routeParam } from '../../lib/request'
import { requireAuth, requirePermission } from '../auth/require-auth.middleware'
import {
  attributionSummary,
  campaignOptions,
  createCampaign,
  getCampaign,
  listCampaigns,
  updateCampaign,
} from './campaigns.service'

export const campaignsRouter = Router()

campaignsRouter.use(requireAuth)

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

function body(req: { body: unknown }) {
  return (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
}

campaignsRouter.get('/options', requirePermission(['campaign:view', 'lead:create', 'lead:edit', 'lead:change_source']), async (req, res, next) => {
  try {
    res.json(await campaignOptions(req.auth!, { sourceCode: queryString(req.query.sourceCode) }))
  } catch (error) {
    next(error)
  }
})

campaignsRouter.get('/performance', requirePermission(['campaign:view', 'report:view', 'lead:view']), async (req, res, next) => {
  try {
    res.json(await attributionSummary(req.auth!))
  } catch (error) {
    next(error)
  }
})

campaignsRouter.get('/', requirePermission('campaign:view'), async (req, res, next) => {
  try {
    res.json(
      await listCampaigns(req.auth!, {
        search: queryString(req.query.search),
        status: queryString(req.query.status),
        page: queryInt(req.query.page),
        limit: queryInt(req.query.limit),
      }),
    )
  } catch (error) {
    next(error)
  }
})

campaignsRouter.get('/:id', requirePermission('campaign:view'), async (req, res, next) => {
  try {
    res.json(await getCampaign(req.auth!, routeParam(req.params.id)))
  } catch (error) {
    next(error)
  }
})

campaignsRouter.post('/', requirePermission('campaign:manage'), async (req, res, next) => {
  try {
    res.status(201).json(
      await createCampaign(req.auth!, body(req), {
        ipAddress: requestIp(req),
        userAgent: requestUserAgent(req),
      }),
    )
  } catch (error) {
    next(error)
  }
})

campaignsRouter.patch('/:id', requirePermission('campaign:manage'), async (req, res, next) => {
  try {
    res.json(
      await updateCampaign(req.auth!, routeParam(req.params.id), body(req), {
        ipAddress: requestIp(req),
        userAgent: requestUserAgent(req),
      }),
    )
  } catch (error) {
    next(error)
  }
})
