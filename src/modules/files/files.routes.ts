import { Router, type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import { httpError } from '../../lib/http-error'
import { requestIp, requestUserAgent, routeParam } from '../../lib/request'
import { requireAuth, requirePermission } from '../auth/require-auth.middleware'
import { MAX_FILE_DOCUMENT_BYTES } from './file-documents.storage'
import {
  addChecklistItem,
  archiveFileDocument,
  deleteFileDocument,
  getFileDocumentContent,
  getFileWorkspace,
  listGlobalFileDocuments,
  rejectFileDocument,
  requestFileDocument,
  reviewFileDocument,
  setPrimaryAsset,
  updateChecklistItem,
  uploadFileDocument,
  verifyFileDocument,
} from './file-documents.service'

export const filesRouter = Router()

filesRouter.use(requireAuth)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_DOCUMENT_BYTES },
})

function queryString(value: unknown) {
  return typeof value === 'string' ? value.trim() : undefined
}

function body(req: { body: unknown }) {
  return (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
}

function audit(req: Request) {
  return { ipAddress: requestIp(req), userAgent: requestUserAgent(req) }
}

function uploadSingle(req: Request, res: Response, next: NextFunction) {
  upload.single('file')(req, res, (error: unknown) => {
    if (!error) {
      next()
      return
    }
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: string }).code) : ''
    if (code === 'LIMIT_FILE_SIZE') {
      next(httpError.invalidUpload('The uploaded file exceeds the maximum allowed size.'))
      return
    }
    next(httpError.invalidUpload('The selected file is invalid.'))
  })
}

filesRouter.get('/documents', requirePermission(['document:view', 'lead:view']), async (req, res, next) => {
  try {
    res.json(
      await listGlobalFileDocuments(req.auth!, {
        search: queryString(req.query.search),
        categoryCode: queryString(req.query.categoryCode),
        typeCode: queryString(req.query.typeCode),
        status: queryString(req.query.status),
        uploadedById: queryString(req.query.uploadedById),
        verifiedById: queryString(req.query.verifiedById),
        expiryStatus: queryString(req.query.expiryStatus),
        dateFrom: queryString(req.query.dateFrom),
        dateTo: queryString(req.query.dateTo),
        page: Number(req.query.page) || 1,
        limit: Number(req.query.limit) || 20,
      }),
    )
  } catch (error) {
    next(error)
  }
})

filesRouter.get('/lead/:leadId', requirePermission(['document:view', 'lead:view']), async (req, res, next) => {
  try {
    res.json(
      await getFileWorkspace(req.auth!, routeParam(req.params.leadId), {
        archived: req.query.archived === '1' || req.query.archived === 'true',
      }),
    )
  } catch (error) {
    next(error)
  }
})

filesRouter.post('/lead/:leadId/checklist', requirePermission('document:delete'), async (req, res, next) => {
  try {
    res.status(201).json(await addChecklistItem(req.auth!, routeParam(req.params.leadId), body(req), audit(req)))
  } catch (error) {
    next(error)
  }
})

filesRouter.patch('/lead/:leadId/checklist/:itemId', requirePermission('document:delete'), async (req, res, next) => {
  try {
    res.json(
      await updateChecklistItem(req.auth!, routeParam(req.params.leadId), routeParam(req.params.itemId), body(req), audit(req)),
    )
  } catch (error) {
    next(error)
  }
})

filesRouter.post('/lead/:leadId/documents', requirePermission('document:upload'), uploadSingle, async (req, res, next) => {
  try {
    res.status(201).json(
      await uploadFileDocument(req.auth!, routeParam(req.params.leadId), req.file, body(req), audit(req)),
    )
  } catch (error) {
    next(error)
  }
})

filesRouter.post('/lead/:leadId/documents/:documentId/request', requirePermission('document:upload'), async (req, res, next) => {
  try {
    res.status(201).json(
      await requestFileDocument(req.auth!, routeParam(req.params.leadId), routeParam(req.params.documentId), body(req), audit(req)),
    )
  } catch (error) {
    next(error)
  }
})

filesRouter.post('/lead/:leadId/documents/:documentId/review', requirePermission('document:verify'), async (req, res, next) => {
  try {
    res.json(await reviewFileDocument(req.auth!, routeParam(req.params.leadId), routeParam(req.params.documentId), audit(req)))
  } catch (error) {
    next(error)
  }
})

filesRouter.post('/lead/:leadId/documents/:documentId/verify', requirePermission('document:verify'), async (req, res, next) => {
  try {
    res.json(
      await verifyFileDocument(
        req.auth!,
        routeParam(req.params.leadId),
        routeParam(req.params.documentId),
        body(req),
        audit(req),
      ),
    )
  } catch (error) {
    next(error)
  }
})

filesRouter.post('/lead/:leadId/documents/:documentId/reject', requirePermission('document:verify'), async (req, res, next) => {
  try {
    res.json(
      await rejectFileDocument(
        req.auth!,
        routeParam(req.params.leadId),
        routeParam(req.params.documentId),
        body(req),
        audit(req),
      ),
    )
  } catch (error) {
    next(error)
  }
})

filesRouter.post(
  '/lead/:leadId/documents/:documentId/assets/:assetId/primary',
  requirePermission('document:upload'),
  async (req, res, next) => {
    try {
      res.json(
        await setPrimaryAsset(
          req.auth!,
          routeParam(req.params.leadId),
          routeParam(req.params.documentId),
          routeParam(req.params.assetId),
          audit(req),
        ),
      )
    } catch (error) {
      next(error)
    }
  },
)

filesRouter.post('/lead/:leadId/documents/:documentId/archive', requirePermission('document:delete'), async (req, res, next) => {
  try {
    res.json(await archiveFileDocument(req.auth!, routeParam(req.params.leadId), routeParam(req.params.documentId), audit(req)))
  } catch (error) {
    next(error)
  }
})

filesRouter.delete('/lead/:leadId/documents/:documentId', requirePermission('document:delete'), async (req, res, next) => {
  try {
    await deleteFileDocument()
  } catch (error) {
    next(error)
  }
})

filesRouter.get(
  '/lead/:leadId/documents/:documentId/content',
  requirePermission(['document:download', 'document:view', 'document:upload']),
  async (req, res, next) => {
    try {
      const download = req.query.download === '1' || req.query.download === 'true'
      const asset = await getFileDocumentContent(
        req.auth!,
        routeParam(req.params.leadId),
        routeParam(req.params.documentId),
        queryString(req.query.assetId),
        { ...audit(req), mode: download ? 'download' : 'view' },
      )
      res.setHeader('Content-Type', asset.mimeType)
      res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${asset.fileName.replace(/"/g, '')}"`)
      res.send(asset.buffer)
    } catch (error) {
      next(error)
    }
  },
)
