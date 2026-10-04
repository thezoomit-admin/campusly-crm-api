import { Router } from 'express'
import multer from 'multer'
import type { NextFunction, Request, Response } from 'express'
import { requireAuth } from '../auth/require-auth.middleware'
import { hasPermission } from '../auth/access'
import { httpError } from '../../lib/http-error'
import { requestIp, requestUserAgent } from '../../lib/request'
import { createItem, deleteItem, getItem, listCategories, listDepartmentsForUsers, listHistory, listItems, listOptions, listTeamsForUsers, updateItem } from './master-data.service'
import { getMasterDataCategory } from './master-data.catalog'
import { buildExport, importItems, parseImportFile } from './master-data.import'
import { writeAuditLog } from '../../lib/audit'
export const masterDataRouter = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })

masterDataRouter.use(requireAuth)

function requireMasterData(action: 'view' | 'create' | 'edit' | 'delete') {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!hasPermission(req.auth!.permissions, `master_data:${action}`)) {
      next(httpError.masterDataForbidden())
      return
    }
    next()
  }
}

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

masterDataRouter.get('/departments', async (req, res, next) => {
  try {
    if (
      !hasPermission(req.auth!.permissions, [
        'user:view',
        'master_data:view',
        'user:create',
        'user:edit',
        'employee:view',
        'employee:create',
        'employee:edit',
      ])
    ) {
      throw httpError.accessDenied()
    }
    res.json({ departments: await listDepartmentsForUsers() })
  } catch (error) {
    next(error)
  }
})

masterDataRouter.get('/teams', async (req, res, next) => {
  try {
    if (
      !hasPermission(req.auth!.permissions, [
        'user:view',
        'master_data:view',
        'user:create',
        'user:edit',
        'employee:view',
        'employee:create',
        'employee:edit',
      ])
    ) {
      throw httpError.accessDenied()
    }
    const departmentId = typeof req.query.departmentId === 'string' ? req.query.departmentId : undefined
    res.json({ teams: await listTeamsForUsers(departmentId) })
  } catch (error) {
    next(error)
  }
})

masterDataRouter.get('/options', async (req, res, next) => {
  try {
    const category = typeof req.query.category === 'string' ? req.query.category : ''
    if (!getMasterDataCategory(category)) {
      throw httpError.notFound('Master data category not found.')
    }
    const items = await listOptions({
      category,
      parentId: typeof req.query.parentId === 'string' ? req.query.parentId : undefined,
      includeId: typeof req.query.includeId === 'string' ? req.query.includeId : undefined,
    })
    res.json({
      items: items.map((item) => ({
        id: item.id,
        name: item.name,
        code: item.code,
        description: item.description,
        parentId: item.parentId,
        status: item.status,
        sortOrder: item.sortOrder,
        behaviorKey: item.behaviorKey,
        extras: item.extras,
      })),
    })
  } catch (error) {
    next(error)
  }
})

masterDataRouter.get('/categories', requireMasterData('view'), async (_req, res, next) => {
  try {
    res.json({ groups: await listCategories() })
  } catch (error) {
    next(error)
  }
})

masterDataRouter.get('/items/export', requireMasterData('view'), async (req, res, next) => {
  try {
    const category = typeof req.query.category === 'string' ? req.query.category : ''
    const format = req.query.format === 'xlsx' ? 'xlsx' : 'csv'
    const file = await buildExport(category, format)
    await writeAuditLog({
      userId: req.auth!.user.id,
      action: 'MASTER_DATA_EXPORTED',
      entityType: 'master_data',
      entityId: category,
      ipAddress: requestIp(req),
      userAgent: requestUserAgent(req),
      metadata: { categoryKey: category, format },
    })
    res.setHeader('Content-Type', file.contentType)
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`)
    res.send(file.buffer)
  } catch (error) {
    next(error)
  }
})

masterDataRouter.post(
  '/items/import',
  requireMasterData('create'),
  upload.single('file'),
  async (req, res, next) => {
    try {
      const categoryKey = typeof req.body?.category === 'string' ? req.body.category : ''
      const category = getMasterDataCategory(categoryKey)
      if (!category) {
        throw httpError.notFound('Master data category not found.')
      }
      if (!req.file?.buffer) {
        throw httpError.masterDataImportFailed()
      }
      const rows = await parseImportFile(req.file.originalname || 'import.csv', req.file.buffer)
      const result = await importItems(req.auth!, category, rows, auditMeta(req))
      res.json(result)
    } catch (error) {
      next(error)
    }
  },
)

masterDataRouter.get('/items', requireMasterData('view'), async (req, res, next) => {
  try {
    const category = typeof req.query.category === 'string' ? req.query.category : ''
    const items = await listItems({
      category,
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      parentId: typeof req.query.parentId === 'string' ? req.query.parentId : undefined,
      createdFrom: typeof req.query.createdFrom === 'string' ? req.query.createdFrom : undefined,
      createdTo: typeof req.query.createdTo === 'string' ? req.query.createdTo : undefined,
      sortBy: typeof req.query.sortBy === 'string' ? req.query.sortBy : undefined,
      sortDir: typeof req.query.sortDir === 'string' ? req.query.sortDir : undefined,
    })
    res.json({ items })
  } catch (error) {
    next(error)
  }
})

masterDataRouter.post('/items', requireMasterData('create'), async (req, res, next) => {
  try {
    const categoryKey = typeof req.body?.categoryKey === 'string' ? req.body.categoryKey : ''
    const item = await createItem(req.auth!, categoryKey, req.body ?? {}, auditMeta(req))
    res.status(201).json({ item })
  } catch (error) {
    next(error)
  }
})

masterDataRouter.get('/items/:id/history', requireMasterData('view'), async (req, res, next) => {
  try {
    const category = typeof req.query.category === 'string' ? req.query.category : ''
    res.json({ history: await listHistory(category, routeId(req) || '') })
  } catch (error) {
    next(error)
  }
})

masterDataRouter.get('/items/:id', requireMasterData('view'), async (req, res, next) => {
  try {
    const category = typeof req.query.category === 'string' ? req.query.category : ''
    res.json({ item: await getItem(category, routeId(req) || '') })
  } catch (error) {
    next(error)
  }
})

masterDataRouter.patch('/items/:id', requireMasterData('edit'), async (req, res, next) => {
  try {
    const categoryKey = typeof req.body?.categoryKey === 'string' ? req.body.categoryKey : ''
    const item = await updateItem(req.auth!, categoryKey, routeId(req) || '', req.body ?? {}, auditMeta(req))
    res.json({ item })
  } catch (error) {
    next(error)
  }
})

masterDataRouter.delete('/items/:id', requireMasterData('delete'), async (req, res, next) => {
  try {
    const category = typeof req.query.category === 'string' ? req.query.category : ''
    await deleteItem(req.auth!, category, routeId(req) || '', auditMeta(req))
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})
