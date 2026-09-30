import { Router, type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import { httpError } from '../../lib/http-error'
import { requestIp, requestUserAgent, routeParam } from '../../lib/request'
import { requireAuth, requirePermission } from '../auth/require-auth.middleware'
import {
  EMAIL_MESSAGES,
  assignThread,
  convertThread,
  getEmailSettings,
  getLeadThreads,
  getThread,
  listMessages,
  listTemplates,
  listThreads,
  markThreadRead,
  sendThreadMessage,
  simulateInbound,
  startLeadThread,
  updateThreadStatus,
} from './email.service'
import { MAX_EMAIL_ATTACHMENT_BYTES } from './email.storage'

export const emailRouter = Router()

emailRouter.use(requireAuth)
emailRouter.use(requirePermission('communication:view', EMAIL_MESSAGES.denied))

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_EMAIL_ATTACHMENT_BYTES, files: 1 },
})

function acceptAttachment(req: Request, res: Response, next: NextFunction) {
  upload.single('file')(req, res, (error: unknown) => {
    if (error) {
      next(httpError.invalidUpload(EMAIL_MESSAGES.attachmentFailed))
      return
    }
    next()
  })
}

function meta(req: Request) {
  return { ipAddress: requestIp(req), userAgent: requestUserAgent(req) }
}

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

emailRouter.get('/settings', (req, res, next) => {
  try {
    res.json(getEmailSettings(req.auth!))
  } catch (error) {
    next(error)
  }
})

emailRouter.get('/templates', async (req, res, next) => {
  try {
    res.json(await listTemplates(req.auth!))
  } catch (error) {
    next(error)
  }
})

emailRouter.get('/threads', async (req, res, next) => {
  try {
    res.json(
      await listThreads(req.auth!, {
        search: queryString(req.query.search),
        status: queryString(req.query.status),
        assigned: queryString(req.query.assigned),
        page: queryInt(req.query.page),
        limit: queryInt(req.query.limit),
      }),
    )
  } catch (error) {
    next(error)
  }
})

emailRouter.get('/threads/:id', async (req, res, next) => {
  try {
    res.json(await getThread(req.auth!, routeParam(req.params.id)))
  } catch (error) {
    next(error)
  }
})

emailRouter.get('/threads/:id/messages', async (req, res, next) => {
  try {
    res.json(
      await listMessages(req.auth!, routeParam(req.params.id), {
        before: queryString(req.query.before),
        limit: queryInt(req.query.limit),
      }),
    )
  } catch (error) {
    next(error)
  }
})

emailRouter.post('/threads/:id/messages', acceptAttachment, async (req, res, next) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>
    res.status(201).json(
      await sendThreadMessage(
        req.auth!,
        routeParam(req.params.id),
        {
          to: body.to,
          subject: body.subject,
          text: body.text,
          docCategory: body.docCategory,
          templateCode: body.templateCode,
          file: req.file || null,
        },
        meta(req),
      ),
    )
  } catch (error) {
    next(error)
  }
})

emailRouter.post('/threads/:id/read', async (req, res, next) => {
  try {
    res.json(await markThreadRead(req.auth!, routeParam(req.params.id)))
  } catch (error) {
    next(error)
  }
})

emailRouter.patch('/threads/:id/assign', async (req, res, next) => {
  try {
    res.json(await assignThread(req.auth!, routeParam(req.params.id), req.body || {}, meta(req)))
  } catch (error) {
    next(error)
  }
})

emailRouter.patch('/threads/:id/status', async (req, res, next) => {
  try {
    res.json(await updateThreadStatus(req.auth!, routeParam(req.params.id), req.body || {}, meta(req)))
  } catch (error) {
    next(error)
  }
})

emailRouter.post('/threads/:id/convert', async (req, res, next) => {
  try {
    res.json(await convertThread(req.auth!, routeParam(req.params.id), req.body || {}, meta(req)))
  } catch (error) {
    next(error)
  }
})

emailRouter.post('/simulate', async (req, res, next) => {
  try {
    res.status(201).json(await simulateInbound(req.auth!, req.body || {}))
  } catch (error) {
    next(error)
  }
})

emailRouter.get('/lead/:leadId', async (req, res, next) => {
  try {
    res.json(await getLeadThreads(req.auth!, routeParam(req.params.leadId)))
  } catch (error) {
    next(error)
  }
})

emailRouter.post('/lead/:leadId/start', async (req, res, next) => {
  try {
    res.status(201).json(await startLeadThread(req.auth!, routeParam(req.params.leadId), meta(req)))
  } catch (error) {
    next(error)
  }
})
