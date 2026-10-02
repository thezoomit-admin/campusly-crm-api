import { Router } from 'express'
import type { Request } from 'express'
import { requestIp, requestUserAgent, routeParam } from '../../lib/request'
import { requireAuth, requirePermission } from '../auth/require-auth.middleware'
import {
  createServiceItem,
  getServiceItem,
  listServiceItems,
  serviceItemNameAvailability,
  serviceItemOptions,
  updateServiceItem,
  updateServiceItemStatus,
} from './service-items.service'

export const serviceItemsRouter = Router()

serviceItemsRouter.use(requireAuth)

function queryString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function queryInt(value: unknown) {
  const number = Number(value)
  return Number.isInteger(number) ? number : undefined
}

function body(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function auditMeta(req: Request) {
  return {
    ipAddress: requestIp(req),
    userAgent: requestUserAgent(req),
  }
}

serviceItemsRouter.get('/options', requirePermission('service:view'), async (req, res, next) => {
  try {
    res.json(
      await serviceItemOptions(req.auth!, {
        categoryId: queryString(req.query.categoryId),
        countryId: queryString(req.query.countryId),
      }),
    )
  } catch (error) {
    next(error)
  }
})

serviceItemsRouter.get('/name-availability', requirePermission('service:view'), async (req, res, next) => {
  try {
    res.json(
      await serviceItemNameAvailability(req.auth!, {
        name: queryString(req.query.name),
        excludeId: queryString(req.query.excludeId),
      }),
    )
  } catch (error) {
    next(error)
  }
})

serviceItemsRouter.get('/', requirePermission('service:view'), async (req, res, next) => {
  try {
    res.json(
      await listServiceItems(req.auth!, {
        search: queryString(req.query.search),
        status: queryString(req.query.status),
        categoryId: queryString(req.query.categoryId),
        countryId: queryString(req.query.countryId),
        page: queryInt(req.query.page),
        limit: queryInt(req.query.limit),
      }),
    )
  } catch (error) {
    next(error)
  }
})

serviceItemsRouter.get('/:id', requirePermission('service:view'), async (req, res, next) => {
  try {
    res.json(await getServiceItem(req.auth!, routeParam(req.params.id)))
  } catch (error) {
    next(error)
  }
})

serviceItemsRouter.post('/', requirePermission('service:create'), async (req, res, next) => {
  try {
    res.status(201).json(await createServiceItem(req.auth!, body(req.body), auditMeta(req)))
  } catch (error) {
    next(error)
  }
})

serviceItemsRouter.patch('/:id', requirePermission('service:edit'), async (req, res, next) => {
  try {
    res.json(await updateServiceItem(req.auth!, routeParam(req.params.id), body(req.body), auditMeta(req)))
  } catch (error) {
    next(error)
  }
})

serviceItemsRouter.post('/:id/status', requirePermission('service:deactivate'), async (req, res, next) => {
  try {
    res.json(
      await updateServiceItemStatus(
        req.auth!,
        routeParam(req.params.id),
        body(req.body).status,
        auditMeta(req),
      ),
    )
  } catch (error) {
    next(error)
  }
})
