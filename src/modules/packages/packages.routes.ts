import { Router } from 'express'
import type { Request } from 'express'
import { requestIp, requestUserAgent, routeParam } from '../../lib/request'
import { requireAuth, requirePermission } from '../auth/require-auth.middleware'
import {
  createPackage,
  getPackage,
  listPackages,
  packageNameAvailability,
  packageOptions,
  updatePackage,
  updatePackageStatus,
} from './packages.service'

export const packagesRouter = Router()

packagesRouter.use(requireAuth)

function queryString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function queryInt(value: unknown) {
  const number = Number(value)
  return Number.isInteger(number) ? number : undefined
}

function body(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function auditMeta(req: Request) {
  return {
    ipAddress: requestIp(req),
    userAgent: requestUserAgent(req),
  }
}

const manageDenied = 'You do not have permission to manage packages.'

packagesRouter.get('/options', requirePermission('service:view'), async (req, res, next) => {
  try {
    res.json(
      await packageOptions(req.auth!, {
        preferredCountryCode: queryString(req.query.preferredCountryCode),
        countryId: queryString(req.query.countryId),
      }),
    )
  } catch (error) {
    next(error)
  }
})

packagesRouter.get('/name-availability', requirePermission('service:view'), async (req, res, next) => {
  try {
    res.json(
      await packageNameAvailability(req.auth!, {
        name: queryString(req.query.name),
        excludeId: queryString(req.query.excludeId),
      }),
    )
  } catch (error) {
    next(error)
  }
})

packagesRouter.get('/', requirePermission('service:view'), async (req, res, next) => {
  try {
    res.json(
      await listPackages(req.auth!, {
        search: queryString(req.query.search),
        status: queryString(req.query.status),
        countryId: queryString(req.query.countryId),
        serviceItemId: queryString(req.query.serviceItemId),
        page: queryInt(req.query.page),
        limit: queryInt(req.query.limit),
      }),
    )
  } catch (error) {
    next(error)
  }
})

packagesRouter.get('/:id', requirePermission('service:view'), async (req, res, next) => {
  try {
    res.json(await getPackage(req.auth!, routeParam(req.params.id)))
  } catch (error) {
    next(error)
  }
})

packagesRouter.post('/', requirePermission('service:configure', manageDenied), async (req, res, next) => {
  try {
    res.status(201).json(await createPackage(req.auth!, body(req.body), auditMeta(req)))
  } catch (error) {
    next(error)
  }
})

packagesRouter.patch('/:id', requirePermission('service:configure', manageDenied), async (req, res, next) => {
  try {
    res.json(await updatePackage(req.auth!, routeParam(req.params.id), body(req.body), auditMeta(req)))
  } catch (error) {
    next(error)
  }
})

packagesRouter.post('/:id/status', requirePermission('service:configure', manageDenied), async (req, res, next) => {
  try {
    res.json(await updatePackageStatus(req.auth!, routeParam(req.params.id), body(req.body).status, auditMeta(req)))
  } catch (error) {
    next(error)
  }
})
