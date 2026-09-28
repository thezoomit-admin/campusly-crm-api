import { Router } from 'express'
import { requireAuth, requirePermission } from '../auth/require-auth.middleware'
import { createActivity, listActivityFeed, recordActivityExport } from './activities.service'
import { requestIp, requestUserAgent } from '../../lib/request'


export const activitiesRouter = Router()

activitiesRouter.use(requireAuth)

function queryString(value: unknown) {
  return typeof value === 'string' ? value.trim() : undefined
}

activitiesRouter.get('/', requirePermission('activity:view'), async (req, res, next) => {
  try {
    const data = await listActivityFeed(req.auth!, {
      from: queryString(req.query.from),
      to: queryString(req.query.to),
      search: queryString(req.query.search),
      category: queryString(req.query.category),
      userId: queryString(req.query.userId),
      relatedId: queryString(req.query.relatedId),
    })
    res.json(data)
  } catch (error) {
    next(error)
  }
})

activitiesRouter.post('/', requirePermission('activity:create'), async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const activity = await createActivity(
      req.auth!,
      {
        type: String(body.type || ''),
        relatedName: typeof body.relatedName === 'string' ? body.relatedName : undefined,
        relatedType: typeof body.relatedType === 'string' ? body.relatedType : undefined,
        relatedId: typeof body.relatedId === 'string' ? body.relatedId : undefined,
        durationMin: typeof body.durationMin === 'number' ? body.durationMin : body.durationMin == null ? null : Number(body.durationMin),
        outcome: typeof body.outcome === 'string' ? body.outcome : undefined,
        notes: typeof body.notes === 'string' ? body.notes : undefined,
        nextAction: typeof body.nextAction === 'string' ? body.nextAction : undefined,
        nextDate: typeof body.nextDate === 'string' ? body.nextDate : null,
        occurredAt: typeof body.occurredAt === 'string' ? body.occurredAt : undefined,
      },
      { ipAddress: requestIp(req), userAgent: requestUserAgent(req) },
    )
    res.status(201).json({ activity })
  } catch (error) {
    next(error)
  }
})

activitiesRouter.post('/export', requirePermission('activity:view'), async (req, res, next) => {
  try {
    const count = typeof req.body?.count === 'number' ? req.body.count : 0
    await recordActivityExport(req.auth!, {
      ipAddress: requestIp(req),
      userAgent: requestUserAgent(req),
      count,
    })
    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})
