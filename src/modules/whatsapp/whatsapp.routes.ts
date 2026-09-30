import { Router, type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import { httpError } from '../../lib/http-error'
import { requestIp, requestUserAgent, routeParam } from '../../lib/request'
import { requireAuth, requirePermission } from '../auth/require-auth.middleware'
import {
  WHATSAPP_MESSAGES,
  assignConversation,
  convertConversation,
  getConversation,
  getLeadConversations,
  getWhatsAppSettings,
  listConversations,
  listMessages,
  markConversationRead,
  sendConversationMessage,
  sendConversationTemplate,
  startLeadConversation,
  updateConversationStatus,
} from './whatsapp.service'
import { MAX_WHATSAPP_ATTACHMENT_BYTES } from './whatsapp.storage'

export const whatsappRouter = Router()

whatsappRouter.use(requireAuth)
whatsappRouter.use(requirePermission('communication:view', WHATSAPP_MESSAGES.denied))

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_WHATSAPP_ATTACHMENT_BYTES, files: 1 },
})

function acceptAttachment(req: Request, res: Response, next: NextFunction) {
  upload.single('file')(req, res, (error: unknown) => {
    if (error) {
      next(httpError.invalidUpload(WHATSAPP_MESSAGES.attachmentFailed))
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

whatsappRouter.get('/settings', (req, res, next) => {
  try {
    res.json(getWhatsAppSettings(req.auth!))
  } catch (error) {
    next(error)
  }
})

whatsappRouter.get('/conversations', async (req, res, next) => {
  try {
    res.json(
      await listConversations(req.auth!, {
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

whatsappRouter.get('/conversations/:id', async (req, res, next) => {
  try {
    res.json(await getConversation(req.auth!, routeParam(req.params.id)))
  } catch (error) {
    next(error)
  }
})

whatsappRouter.get('/conversations/:id/messages', async (req, res, next) => {
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

whatsappRouter.post('/conversations/:id/messages', acceptAttachment, async (req, res, next) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>
    res.status(201).json(
      await sendConversationMessage(
        req.auth!,
        routeParam(req.params.id),
        { text: body.text, docCategory: body.docCategory, file: req.file || null },
        meta(req),
      ),
    )
  } catch (error) {
    next(error)
  }
})

whatsappRouter.post('/conversations/:id/template', async (req, res, next) => {
  try {
    res.status(201).json(
      await sendConversationTemplate(req.auth!, routeParam(req.params.id), req.body || {}, meta(req)),
    )
  } catch (error) {
    next(error)
  }
})

whatsappRouter.post('/conversations/:id/read', async (req, res, next) => {
  try {
    res.json(await markConversationRead(req.auth!, routeParam(req.params.id)))
  } catch (error) {
    next(error)
  }
})

whatsappRouter.patch('/conversations/:id/assign', async (req, res, next) => {
  try {
    res.json(await assignConversation(req.auth!, routeParam(req.params.id), req.body || {}, meta(req)))
  } catch (error) {
    next(error)
  }
})

whatsappRouter.patch('/conversations/:id/status', async (req, res, next) => {
  try {
    res.json(await updateConversationStatus(req.auth!, routeParam(req.params.id), req.body || {}, meta(req)))
  } catch (error) {
    next(error)
  }
})

whatsappRouter.post('/conversations/:id/convert', async (req, res, next) => {
  try {
    res.json(await convertConversation(req.auth!, routeParam(req.params.id), req.body || {}, meta(req)))
  } catch (error) {
    next(error)
  }
})

whatsappRouter.get('/lead/:leadId', async (req, res, next) => {
  try {
    res.json(await getLeadConversations(req.auth!, routeParam(req.params.leadId)))
  } catch (error) {
    next(error)
  }
})

whatsappRouter.post('/lead/:leadId/start', async (req, res, next) => {
  try {
    res.status(201).json(await startLeadConversation(req.auth!, routeParam(req.params.leadId), meta(req)))
  } catch (error) {
    next(error)
  }
})
