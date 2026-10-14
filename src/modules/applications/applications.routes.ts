import { Router, type Request } from 'express'
import { requestIp, requestUserAgent, routeParam } from '../../lib/request'
import { requireAuth, requirePermission } from '../auth/require-auth.middleware'
import {
  createApplicationFromLead,
  getApplication,
  listApplications,
  listLeadApplications,
  listStudents,
  updateApplicationStatus,
} from './applications.service'

export const applicationsRouter = Router()

applicationsRouter.use(requireAuth)

function queryString(value: unknown) {
  return typeof value === 'string' ? value.trim() : undefined
}

function body(req: { body: unknown }) {
  return (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
}

function audit(req: Request) {
  return {
    ipAddress: requestIp(req),
    userAgent: requestUserAgent(req),
  }
}

applicationsRouter.get(
  '/',
  requirePermission(['lead:convert', 'lead:view']),
  async (req, res, next) => {
    try {
      res.json(
        await listApplications(req.auth!, {
          search: queryString(req.query.search),
          leadId: queryString(req.query.leadId),
          status: queryString(req.query.status),
          page: Number(req.query.page) || 1,
          limit: Number(req.query.limit) || 20,
        }),
      )
    } catch (error) {
      next(error)
    }
  },
)

applicationsRouter.get(
  '/students',
  requirePermission(['lead:convert', 'lead:view']),
  async (req, res, next) => {
    try {
      res.json(
        await listStudents(req.auth!, {
          search: queryString(req.query.search),
          page: Number(req.query.page) || 1,
          limit: Number(req.query.limit) || 20,
        }),
      )
    } catch (error) {
      next(error)
    }
  },
)

applicationsRouter.get(
  '/:id',
  requirePermission(['lead:convert', 'lead:view']),
  async (req, res, next) => {
    try {
      res.json(await getApplication(req.auth!, routeParam(req.params.id)))
    } catch (error) {
      next(error)
    }
  },
)

applicationsRouter.patch(
  '/:id/status',
  requirePermission('lead:convert'),
  async (req, res, next) => {
    try {
      res.json(
        await updateApplicationStatus(
          req.auth!,
          routeParam(req.params.id),
          body(req),
          audit(req),
        ),
      )
    } catch (error) {
      next(error)
    }
  },
)

export const leadApplicationsRouter = Router({ mergeParams: true })

leadApplicationsRouter.use(requireAuth)

function leadIdParam(req: Request) {
  return routeParam((req.params as Record<string, string | undefined>).leadId)
}

leadApplicationsRouter.get('/', async (req, res, next) => {
  try {
    res.json(await listLeadApplications(req.auth!, leadIdParam(req)))
  } catch (error) {
    next(error)
  }
})

leadApplicationsRouter.post('/', requirePermission('lead:convert'), async (req, res, next) => {
  try {
    res.status(201).json(
      await createApplicationFromLead(
        req.auth!,
        leadIdParam(req),
        body(req),
        audit(req),
      ),
    )
  } catch (error) {
    next(error)
  }
})
