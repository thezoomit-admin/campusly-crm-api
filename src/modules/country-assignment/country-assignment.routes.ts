import { Router } from 'express'
import type { Request } from 'express'
import { requireAuth, requirePermission } from '../auth/require-auth.middleware'
import { requestIp, requestUserAgent } from '../../lib/request'
import {
  createCountryAssignmentRule,
  deactivateCountryAssignmentRule,
  getCountryAssignmentFormOptions,
  listCountryAssignmentRules,
  updateCountryAssignmentRule,
} from './country-assignment.service'

export const countryAssignmentRouter = Router()

countryAssignmentRouter.use(requireAuth)

function routeId(req: Request) {
  const value = req.params.id
  return Array.isArray(value) ? value[0] : value
}

function auditMeta(req: Request) {
  return {
    ipAddress: requestIp(req),
    userAgent: requestUserAgent(req),
  }
}

countryAssignmentRouter.get(
  '/',
  requirePermission('country_assignment:view'),
  async (req, res, next) => {
    try {
      const search = typeof req.query.search === 'string' ? req.query.search : undefined
      const isActive = typeof req.query.isActive === 'string' ? req.query.isActive : undefined
      res.json(await listCountryAssignmentRules({ search, isActive }))
    } catch (error) {
      next(error)
    }
  },
)

countryAssignmentRouter.get(
  '/form-options',
  requirePermission(['country_assignment:view', 'country_assignment:manage']),
  async (req, res, next) => {
    try {
      const teamId = typeof req.query.teamId === 'string' ? req.query.teamId : undefined
      res.json(await getCountryAssignmentFormOptions(teamId))
    } catch (error) {
      next(error)
    }
  },
)

countryAssignmentRouter.post(
  '/',
  requirePermission('country_assignment:manage'),
  async (req, res, next) => {
    try {
      const rule = await createCountryAssignmentRule(req.auth!, req.body ?? {}, auditMeta(req))
      res.status(201).json({ rule, message: 'Country assignment rule created.' })
    } catch (error) {
      next(error)
    }
  },
)

countryAssignmentRouter.patch(
  '/:id',
  requirePermission('country_assignment:manage'),
  async (req, res, next) => {
    try {
      const rule = await updateCountryAssignmentRule(
        req.auth!,
        routeId(req) || '',
        req.body ?? {},
        auditMeta(req),
      )
      res.json({ rule, message: 'Country assignment rule updated.' })
    } catch (error) {
      next(error)
    }
  },
)

countryAssignmentRouter.delete(
  '/:id',
  requirePermission('country_assignment:manage'),
  async (req, res, next) => {
    try {
      const rule = await deactivateCountryAssignmentRule(
        req.auth!,
        routeId(req) || '',
        auditMeta(req),
      )
      res.json({ rule, message: 'Country assignment rule deactivated.' })
    } catch (error) {
      next(error)
    }
  },
)
