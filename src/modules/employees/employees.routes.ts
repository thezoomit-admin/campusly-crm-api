import { Router } from 'express'
import multer from 'multer'
import { writeAuditLog } from '../../lib/audit'
import { httpError } from '../../lib/http-error'
import { requestIp, requestUserAgent, routeParam } from '../../lib/request'
import { respondWithExport } from '../../lib/xlsx-export'
import { requireAuth, requirePermission } from '../auth/require-auth.middleware'
import {
  createEmployee,
  deleteEmployeeDocument,
  getEmployee,
  getEmployeeDocumentFile,
  getEmployeePerformanceSummary,
  getEmployeePhoto,
  listEmployeeAuditLogs,
  listEmployeeOptions,
  listEmployees,
  exportEmployeesTable,
  updateEmployee,
  updateEmployeePhoto,
  updateEmployeeStatus,
  uploadEmployeeDocument,
  type EmployeeUploads,
} from './employees.service'
import { DOCUMENT_FIELD_MAP, MAX_UPLOAD_BYTES } from './employees.storage'

export const employeesRouter = Router()

employeesRouter.use(requireAuth)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 12 },
})

const createUpload = upload.fields([
  { name: 'photo', maxCount: 1 },
  ...Object.keys(DOCUMENT_FIELD_MAP).map((name) => ({ name, maxCount: name === 'documentOther' ? 3 : 1 })),
])

function queryString(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

function asUploads(files: Express.Request['files']): EmployeeUploads {
  if (!files || Array.isArray(files)) {
    return {}
  }
  return files
}

employeesRouter.get('/', requirePermission('employee:view'), async (req, res, next) => {
  try {
    const employees = await listEmployees(req.auth!, {
      search: queryString(req.query.search),
      departmentId: queryString(req.query.departmentId),
      teamId: queryString(req.query.teamId),
      designationId: queryString(req.query.designationId),
      roleId: queryString(req.query.roleId),
      employmentTypeId: queryString(req.query.employmentTypeId),
      employmentStatusId: queryString(req.query.employmentStatusId),
      reportingManagerId: queryString(req.query.reportingManagerId),
      joiningFrom: queryString(req.query.joiningFrom),
      joiningTo: queryString(req.query.joiningTo),
    })
    res.json({ employees })
  } catch (error) {
    next(error)
  }
})

employeesRouter.get('/options', requirePermission(['employee:view', 'employee:create', 'employee:edit']), async (req, res, next) => {
  try {
    res.json(await listEmployeeOptions(req.auth!))
  } catch (error) {
    next(error)
  }
})

employeesRouter.get('/export', requirePermission('employee:view'), async (req, res, next) => {
  try {
    const table = await exportEmployeesTable(req.auth!, {
      search: queryString(req.query.search),
      departmentId: queryString(req.query.departmentId),
      teamId: queryString(req.query.teamId),
      designationId: queryString(req.query.designationId),
      roleId: queryString(req.query.roleId),
      employmentTypeId: queryString(req.query.employmentTypeId),
      employmentStatusId: queryString(req.query.employmentStatusId),
      reportingManagerId: queryString(req.query.reportingManagerId),
      joiningFrom: queryString(req.query.joiningFrom),
      joiningTo: queryString(req.query.joiningTo),
    })
    await writeAuditLog({
      userId: req.auth!.user.id,
      action: 'EMPLOYEES_EXPORTED',
      entityType: 'employee',
      ipAddress: requestIp(req),
      userAgent: requestUserAgent(req),
      metadata: {
        format: req.query.format === 'json' ? 'json' : 'xlsx',
        count: table.rows.length,
      },
    })
    await respondWithExport(res, req.query.format, table)
  } catch (error) {
    next(error)
  }
})

employeesRouter.post(
  '/',
  requirePermission('employee:create'),
  (req, res, next) => {
    createUpload(req, res, (error: unknown) => {
      if (error) {
        next(httpError.invalidUpload('One or more files could not be uploaded. Use files of 5 MB or less.'))
        return
      }
      next()
    })
  },
  async (req, res, next) => {
    try {
      const result = await createEmployee(req.auth!, req.body ?? {}, asUploads(req.files), {
        ipAddress: requestIp(req),
        userAgent: requestUserAgent(req),
      })
      res.status(201).json(result)
    } catch (error) {
      next(error)
    }
  },
)

employeesRouter.post(
  '/:id/documents',
  requirePermission('employee_document:manage'),
  (req, res, next) => {
    createUpload(req, res, (error: unknown) => {
      if (error) {
        next(httpError.invalidUpload('The selected document could not be uploaded. Use a PDF, Word, or image file of 5 MB or less.'))
        return
      }
      next()
    })
  },
  async (req, res, next) => {
    try {
      const employee = await uploadEmployeeDocument(req.auth!, routeParam(req.params.id), asUploads(req.files), {
        ipAddress: requestIp(req),
        userAgent: requestUserAgent(req),
      })
      res.json({ employee })
    } catch (error) {
      next(error)
    }
  },
)

employeesRouter.delete('/:id/documents/:documentId', requirePermission('employee_document:manage'), async (req, res, next) => {
  try {
    const employee = await deleteEmployeeDocument(req.auth!, routeParam(req.params.id), routeParam(req.params.documentId), {
      ipAddress: requestIp(req),
      userAgent: requestUserAgent(req),
    })
    res.json({ employee })
  } catch (error) {
    next(error)
  }
})

employeesRouter.post(
  '/:id/photo',
  requirePermission('employee:edit'),
  (req, res, next) => {
    upload.single('photo')(req, res, (error: unknown) => {
      if (error) {
        next(httpError.invalidUpload('The selected photo could not be uploaded. Use a JPG, PNG, or WEBP file of 5 MB or less.'))
        return
      }
      next()
    })
  },
  async (req, res, next) => {
    try {
      const employee = await updateEmployeePhoto(req.auth!, routeParam(req.params.id), req.file, {
        ipAddress: requestIp(req),
        userAgent: requestUserAgent(req),
      })
      res.json({ employee })
    } catch (error) {
      next(error)
    }
  },
)

employeesRouter.get('/:id/photo', requirePermission('employee:view'), async (req, res, next) => {
  try {
    const file = await getEmployeePhoto(req.auth!, routeParam(req.params.id))
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Disposition', `inline; filename="${file.fileName}"`)
    res.send(file.buffer)
  } catch (error) {
    next(error)
  }
})

employeesRouter.get(
  '/:id/documents/:documentId',
  requirePermission(['employee_document:view', 'employee:view']),
  async (req, res, next) => {
    try {
      const file = await getEmployeeDocumentFile(req.auth!, routeParam(req.params.id), routeParam(req.params.documentId))
      res.setHeader('Content-Type', file.mimeType)
      res.setHeader('Content-Disposition', `inline; filename="${file.fileName}"`)
      res.send(file.buffer)
    } catch (error) {
      next(error)
    }
  },
)

employeesRouter.get(
  '/:id/audit-logs',
  requirePermission(['audit:view', 'employee:view', 'employee:edit']),
  async (req, res, next) => {
    try {
      const logs = await listEmployeeAuditLogs(req.auth!, routeParam(req.params.id))
      res.json({ logs })
    } catch (error) {
      next(error)
    }
  },
)

employeesRouter.get(
  '/:id/performance',
  requirePermission('employee_performance:view'),
  async (req, res, next) => {
    try {
      const performance = await getEmployeePerformanceSummary(req.auth!, routeParam(req.params.id))
      res.json({ performance })
    } catch (error) {
      next(error)
    }
  },
)

employeesRouter.get('/:id', requirePermission('employee:view'), async (req, res, next) => {
  try {
    const employee = await getEmployee(req.auth!, routeParam(req.params.id))
    res.json({ employee })
  } catch (error) {
    next(error)
  }
})

employeesRouter.patch(
  '/:id',
  requirePermission('employee:edit'),
  (req, res, next) => {
    createUpload(req, res, (error: unknown) => {
      if (error) {
        next(httpError.invalidUpload('One or more files could not be uploaded. Use files of 5 MB or less.'))
        return
      }
      next()
    })
  },
  async (req, res, next) => {
    try {
      const result = await updateEmployee(req.auth!, routeParam(req.params.id), req.body ?? {}, asUploads(req.files), {
        ipAddress: requestIp(req),
        userAgent: requestUserAgent(req),
      })
      res.json(result)
    } catch (error) {
      next(error)
    }
  },
)

employeesRouter.post('/:id/status', requirePermission('employee:edit'), async (req, res, next) => {
  try {
    const employee = await updateEmployeeStatus(req.auth!, routeParam(req.params.id), req.body ?? {}, {
      ipAddress: requestIp(req),
      userAgent: requestUserAgent(req),
    })
    res.json({ employee })
  } catch (error) {
    next(error)
  }
})
