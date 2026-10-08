import { Router } from 'express'
import { httpError } from '../../lib/http-error'
import { routeParam } from '../../lib/request'
import { requireAuth, requirePermission } from '../auth/require-auth.middleware'
import { PERFORMANCE_MESSAGES, type PerformanceFilters } from './performance.types'
import {
  getKpiConfiguration,
  getPerformanceDetail,
  getPerformanceDrill,
  getPerformanceReport,
  updateKpiConfiguration,
} from './performance.service'

export const performanceRouter = Router()

performanceRouter.use(requireAuth)
performanceRouter.use(requirePermission('employee_performance:view', PERFORMANCE_MESSAGES.permission))

function queryOf(query: Record<string, unknown>): PerformanceFilters {
  const read = (key: string) => (typeof query[key] === 'string' ? query[key].trim() : undefined)
  return {
    preset: read('preset'),
    from: read('from'),
    to: read('to'),
    departmentId: read('departmentId'),
    userId: read('userId'),
    country: read('country'),
    source: read('source'),
    campaignId: read('campaignId'),
    status: read('status'),
    priority: read('priority'),
    scoreMin: read('scoreMin'),
    scoreMax: read('scoreMax'),
    rankBy: read('rankBy'),
    metric: read('metric'),
  }
}

performanceRouter.get('/', async (req, res, next) => {
  try {
    res.json(await getPerformanceReport(req.auth!, queryOf(req.query as Record<string, unknown>)))
  } catch (error) {
    next(error)
  }
})

performanceRouter.get('/kpis', async (req, res, next) => {
  try {
    res.json(await getKpiConfiguration(req.auth!))
  } catch (error) {
    next(error)
  }
})

performanceRouter.put('/kpis', async (req, res, next) => {
  try {
    const config = await updateKpiConfiguration(req.auth!, req.body ?? {}, {
      ipAddress: req.ip,
      userAgent: req.get('user-agent') || undefined,
    })
    res.json(config)
  } catch (error) {
    next(error)
  }
})

performanceRouter.get('/drill', async (req, res, next) => {
  try {
    res.json(await getPerformanceDrill(req.auth!, queryOf(req.query as Record<string, unknown>)))
  } catch (error) {
    next(error)
  }
})

performanceRouter.get('/:userId', async (req, res, next) => {
  try {
    const userId = routeParam(req.params.userId)
    if (!userId) throw httpError.badRequest(PERFORMANCE_MESSAGES.invalidEmployee)
    res.json(await getPerformanceDetail(req.auth!, userId, queryOf(req.query as Record<string, unknown>)))
  } catch (error) {
    next(error)
  }
})
