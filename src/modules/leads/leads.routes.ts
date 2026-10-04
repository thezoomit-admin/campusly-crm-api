import { Router } from 'express'
import multer from 'multer'
import { httpError } from '../../lib/http-error'
import { requestIp, requestUserAgent, routeParam } from '../../lib/request'
import { requireAuth, requirePermission } from '../auth/require-auth.middleware'
import {
  assignLead,
  checkDuplicate,
  closeLead,
  createLead,
  createLeadFollowUp,
  getLead,
  listLeadAssignees,
  listLeadAssignments,
  listLeadPool,
  listLeads,
  listLeadStatusHistory,
  listMyLeads,
  reopenLead,
  updateLead,
  updateLeadStatus,
  updatePriority,
  updateQualification,
} from './leads.service'
import { correctLeadCampaign, correctLeadSource, listAttributionChanges } from './lead-attribution'
import { deleteLeadDocument, getLeadDocumentFile, listLeadDocuments, uploadLeadDocument } from './leads.documents'
import { handoverLead } from './leads.handover'
import { MAX_LEAD_UPLOAD_BYTES } from './leads.storage'

export const leadsRouter = Router()

leadsRouter.use(requireAuth)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_LEAD_UPLOAD_BYTES },
})

function queryString(value: unknown) {
  return typeof value === 'string' ? value.trim() : undefined
}

function queryNumber(value: unknown) {
  const num = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN
  return Number.isFinite(num) ? num : undefined
}

function body(req: { body: unknown }) {
  return (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
}

leadsRouter.post('/duplicate-check', requirePermission('lead:create'), async (req, res, next) => {
  try {
    res.json(await checkDuplicate(req.auth!, body(req)))
  } catch (error) {
    next(error)
  }
})

leadsRouter.get('/', requirePermission('lead:view'), async (req, res, next) => {
  try {
    res.json(
      await listLeads(req.auth!, {
        search: queryString(req.query.search),
        page: queryNumber(req.query.page),
        limit: queryNumber(req.query.limit),
        status: queryString(req.query.status),
        source: queryString(req.query.source),
        priority: queryString(req.query.priority),
        country: queryString(req.query.country),
      }),
    )
  } catch (error) {
    next(error)
  }
})

leadsRouter.post('/', requirePermission('lead:create'), async (req, res, next) => {
  try {
    const result = await createLead(req.auth!, body(req), {
      ipAddress: requestIp(req),
      userAgent: requestUserAgent(req),
    })
    res.status(201).json(result)
  } catch (error) {
    next(error)
  }
})

leadsRouter.get(
  '/mine',
  requirePermission('lead:view', 'You do not have permission to access this page.'),
  async (req, res, next) => {
    try {
      res.json(
        await listMyLeads(req.auth!, {
          search: queryString(req.query.search),
          page: queryNumber(req.query.page),
          limit: queryNumber(req.query.limit),
          status: queryString(req.query.status),
          source: queryString(req.query.source),
          priority: queryString(req.query.priority),
          country: queryString(req.query.country),
          followUpStatus: queryString(req.query.followUpStatus),
          sort: queryString(req.query.sort),
          order: queryString(req.query.order),
        }),
      )
    } catch (error) {
      next(error)
    }
  },
)

leadsRouter.get(
  '/pool',
  requirePermission('lead:assign', 'You do not have permission to access the Lead Pool.'),
  async (req, res, next) => {
    try {
      res.json(
        await listLeadPool(req.auth!, {
          search: queryString(req.query.search),
          page: queryNumber(req.query.page),
          limit: queryNumber(req.query.limit),
          source: queryString(req.query.source),
          country: queryString(req.query.country),
          createdFrom: queryString(req.query.createdFrom),
          createdTo: queryString(req.query.createdTo),
        }),
      )
    } catch (error) {
      next(error)
    }
  },
)

leadsRouter.get('/assignees', requirePermission(['lead:assign', 'lead:reassign', 'lead:reopen', 'lead:handover']), async (req, res, next) => {
  try {
    res.json(
      await listLeadAssignees(req.auth!, {
        teamId: queryString(req.query.teamId),
        search: queryString(req.query.search),
        role: queryString(req.query.role),
      }),
    )
  } catch (error) {
    next(error)
  }
})

leadsRouter.get('/:id', requirePermission('lead:view'), async (req, res, next) => {
  try {
    res.json(await getLead(req.auth!, routeParam(req.params.id)))
  } catch (error) {
    next(error)
  }
})

leadsRouter.get('/:id/status-history', requirePermission('lead:view'), async (req, res, next) => {
  try {
    res.json(await listLeadStatusHistory(req.auth!, routeParam(req.params.id)))
  } catch (error) {
    next(error)
  }
})

leadsRouter.get('/:id/assignments', requirePermission('lead:view'), async (req, res, next) => {
  try {
    res.json(await listLeadAssignments(req.auth!, routeParam(req.params.id)))
  } catch (error) {
    next(error)
  }
})

leadsRouter.get('/:id/documents', requirePermission(['document:view', 'lead:view']), async (req, res, next) => {
  try {
    res.json(await listLeadDocuments(req.auth!, routeParam(req.params.id)))
  } catch (error) {
    next(error)
  }
})

leadsRouter.post(
  '/:id/documents',
  requirePermission('document:upload'),
  (req, res, next) => {
    upload.single('file')(req, res, (error: unknown) => {
      if (error) {
        next(
          httpError.invalidUpload(
            'The selected document could not be uploaded. Use a PDF, Word, or image file of 5 MB or less.',
          ),
        )
        return
      }
      next()
    })
  },
  async (req, res, next) => {
    try {
      const result = await uploadLeadDocument(req.auth!, routeParam(req.params.id), req.file, body(req), {
        ipAddress: requestIp(req),
        userAgent: requestUserAgent(req),
      })
      res.status(201).json(result)
    } catch (error) {
      next(error)
    }
  },
)

leadsRouter.get(
  '/:id/documents/:documentId',
  requirePermission(['document:download', 'document:view', 'document:upload']),
  async (req, res, next) => {
    try {
      const file = await getLeadDocumentFile(req.auth!, routeParam(req.params.id), routeParam(req.params.documentId))
      res.setHeader('Content-Type', file.mimeType)
      res.setHeader('Content-Disposition', `inline; filename="${file.fileName}"`)
      res.send(file.buffer)
    } catch (error) {
      next(error)
    }
  },
)

leadsRouter.delete(
  '/:id/documents/:documentId',
  requirePermission(['document:delete', 'document:upload']),
  async (req, res, next) => {
    try {
      res.json(
        await deleteLeadDocument(req.auth!, routeParam(req.params.id), routeParam(req.params.documentId), {
          ipAddress: requestIp(req),
          userAgent: requestUserAgent(req),
        }),
      )
    } catch (error) {
      next(error)
    }
  },
)

leadsRouter.post(
  '/:id/handover',
  requirePermission('lead:handover', 'You do not have permission to access this lead\'s workspace.'),
  async (req, res, next) => {
    try {
      res.json(
        await handoverLead(req.auth!, routeParam(req.params.id), body(req), {
          ipAddress: requestIp(req),
          userAgent: requestUserAgent(req),
        }),
      )
    } catch (error) {
      next(error)
    }
  },
)

leadsRouter.patch('/:id/assign', requirePermission(['lead:assign', 'lead:reassign']), async (req, res, next) => {
  try {
    res.json(
      await assignLead(req.auth!, routeParam(req.params.id), body(req), {
        ipAddress: requestIp(req),
        userAgent: requestUserAgent(req),
      }),
    )
  } catch (error) {
    next(error)
  }
})

leadsRouter.patch(
  '/:id/status',
  requirePermission('lead:update_status', 'You do not have permission to update the status.'),
  async (req, res, next) => {
    try {
      res.json(
        await updateLeadStatus(req.auth!, routeParam(req.params.id), body(req), {
          ipAddress: requestIp(req),
          userAgent: requestUserAgent(req),
        }),
      )
    } catch (error) {
      next(error)
    }
  },
)

leadsRouter.patch(
  '/:id/close',
  requirePermission('lead:close', 'You do not have permission to close or reopen this lead.'),
  async (req, res, next) => {
    try {
      res.json(
        await closeLead(req.auth!, routeParam(req.params.id), body(req), {
          ipAddress: requestIp(req),
          userAgent: requestUserAgent(req),
        }),
      )
    } catch (error) {
      next(error)
    }
  },
)

leadsRouter.patch(
  '/:id/reopen',
  requirePermission('lead:reopen', 'You do not have permission to close or reopen this lead.'),
  async (req, res, next) => {
    try {
      res.json(
        await reopenLead(req.auth!, routeParam(req.params.id), body(req), {
          ipAddress: requestIp(req),
          userAgent: requestUserAgent(req),
        }),
      )
    } catch (error) {
      next(error)
    }
  },
)

leadsRouter.get('/:id/attribution-changes', requirePermission('lead:view'), async (req, res, next) => {
  try {
    res.json(await listAttributionChanges(req.auth!, routeParam(req.params.id)))
  } catch (error) {
    next(error)
  }
})

leadsRouter.post('/:id/source-correction', requirePermission('lead:change_source', 'You are not authorized to change the lead source.'), async (req, res, next) => {
  try {
    res.json(
      await correctLeadSource(req.auth!, routeParam(req.params.id), body(req), {
        ipAddress: requestIp(req),
        userAgent: requestUserAgent(req),
      }),
    )
  } catch (error) {
    next(error)
  }
})

leadsRouter.post('/:id/campaign-correction', requirePermission(['lead:change_source', 'campaign:manage'], 'You are not authorized to change the lead source.'), async (req, res, next) => {
  try {
    res.json(
      await correctLeadCampaign(req.auth!, routeParam(req.params.id), body(req), {
        ipAddress: requestIp(req),
        userAgent: requestUserAgent(req),
      }),
    )
  } catch (error) {
    next(error)
  }
})

leadsRouter.patch('/:id', requirePermission('lead:edit'), async (req, res, next) => {
  try {
    res.json(
      await updateLead(req.auth!, routeParam(req.params.id), body(req), {
        ipAddress: requestIp(req),
        userAgent: requestUserAgent(req),
      }),
    )
  } catch (error) {
    next(error)
  }
})

leadsRouter.patch('/:id/qualification', requirePermission('lead:qualify'), async (req, res, next) => {
  try {
    res.json(
      await updateQualification(req.auth!, routeParam(req.params.id), body(req), {
        ipAddress: requestIp(req),
        userAgent: requestUserAgent(req),
      }),
    )
  } catch (error) {
    next(error)
  }
})

leadsRouter.patch('/:id/priority', requirePermission('lead:override_priority'), async (req, res, next) => {
  try {
    res.json(
      await updatePriority(req.auth!, routeParam(req.params.id), body(req), {
        ipAddress: requestIp(req),
        userAgent: requestUserAgent(req),
      }),
    )
  } catch (error) {
    next(error)
  }
})

leadsRouter.post('/:id/follow-ups', requirePermission('follow_up:create'), async (req, res, next) => {
  try {
    res.status(201).json(
      await createLeadFollowUp(req.auth!, routeParam(req.params.id), body(req), {
        ipAddress: requestIp(req),
        userAgent: requestUserAgent(req),
      }),
    )
  } catch (error) {
    next(error)
  }
})
