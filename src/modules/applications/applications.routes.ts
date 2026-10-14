import { Router, type Request } from 'express'
import multer from 'multer'
import { requestIp, requestUserAgent, routeParam } from '../../lib/request'
import { requireAuth, requirePermission } from '../auth/require-auth.middleware'
import {
  createApplicationFromLead,
  getApplication,
  getStudent,
  listApplications,
  listLeadApplications,
  listStudents,
  updateApplicationStatus,
} from './applications.service'
import {
  attachSharedDocumentToApplication,
  createApplicationNote,
  listApplicationActivities,
  listApplicationDocuments,
  listApplicationNotes,
  listApplicationPayments,
  updateApplicationDocumentStatus,
  uploadApplicationDocument,
} from './applications.workspace'

export const applicationsRouter = Router()

applicationsRouter.use(requireAuth)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
})

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
          studentId: queryString(req.query.studentId),
          counsellorId: queryString(req.query.counsellorId),
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
  '/students/:id',
  requirePermission(['lead:convert', 'lead:view']),
  async (req, res, next) => {
    try {
      res.json(await getStudent(req.auth!, routeParam(req.params.id)))
    } catch (error) {
      next(error)
    }
  },
)

applicationsRouter.get(
  '/:id/notes',
  requirePermission(['lead:convert', 'lead:view']),
  async (req, res, next) => {
    try {
      res.json(await listApplicationNotes(req.auth!, routeParam(req.params.id)))
    } catch (error) {
      next(error)
    }
  },
)

applicationsRouter.post(
  '/:id/notes',
  requirePermission(['lead:convert', 'lead:edit']),
  async (req, res, next) => {
    try {
      res.status(201).json(
        await createApplicationNote(
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

applicationsRouter.get(
  '/:id/documents',
  requirePermission(['lead:convert', 'lead:view']),
  async (req, res, next) => {
    try {
      res.json(await listApplicationDocuments(req.auth!, routeParam(req.params.id)))
    } catch (error) {
      next(error)
    }
  },
)

applicationsRouter.post(
  '/:id/documents',
  requirePermission(['lead:convert', 'document:upload']),
  (req, res, next) => {
    upload.single('file')(req, res, (error: unknown) => {
      if (error) {
        next(error)
        return
      }
      void (async () => {
        try {
          res.status(201).json(
            await uploadApplicationDocument(
              req.auth!,
              routeParam(req.params.id),
              req.file,
              body(req),
              audit(req),
            ),
          )
        } catch (err) {
          next(err)
        }
      })()
    })
  },
)

applicationsRouter.post(
  '/:id/documents/attach-shared',
  requirePermission(['lead:convert', 'document:upload']),
  async (req, res, next) => {
    try {
      res.status(201).json(
        await attachSharedDocumentToApplication(
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

applicationsRouter.patch(
  '/:id/documents/:documentId/status',
  requirePermission(['lead:convert', 'document:verify']),
  async (req, res, next) => {
    try {
      res.json(
        await updateApplicationDocumentStatus(
          req.auth!,
          routeParam(req.params.id),
          routeParam(req.params.documentId),
          body(req),
          audit(req),
        ),
      )
    } catch (error) {
      next(error)
    }
  },
)

applicationsRouter.get(
  '/:id/activities',
  requirePermission(['lead:convert', 'lead:view']),
  async (req, res, next) => {
    try {
      res.json(await listApplicationActivities(req.auth!, routeParam(req.params.id)))
    } catch (error) {
      next(error)
    }
  },
)

applicationsRouter.get(
  '/:id/payments',
  requirePermission(['lead:convert', 'payment:view', 'service:view']),
  async (req, res, next) => {
    try {
      res.json(await listApplicationPayments(req.auth!, routeParam(req.params.id)))
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
