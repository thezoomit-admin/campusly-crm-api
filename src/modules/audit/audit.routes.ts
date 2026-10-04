import { Router } from 'express'
import type { Prisma } from '../../lib/prisma-client'
import { prisma } from '../../lib/prisma'
import { auditDirectoryScope } from '../auth/access'
import { requireAuth, requirePermission } from '../auth/require-auth.middleware'

export const auditRouter = Router()

auditRouter.use(requireAuth, requirePermission('audit:view'))

auditRouter.get('/', async (req, res, next) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : ''
    const scope = auditDirectoryScope(req.auth!.role.key)
    const where: Prisma.AuditLogWhereInput = {}

    if (scope === 'TEAM' && req.auth!.user.teamId) {
      where.user = { teamId: req.auth!.user.teamId }
    } else if (scope !== 'ALL') {
      where.userId = req.auth!.user.id
    }

    if (search) {
      where.OR = [
        { action: { contains: search, mode: 'insensitive' } },
        { entityType: { contains: search, mode: 'insensitive' } },
      ]
    }

    const logs = await prisma.auditLog.findMany({
      where,
      include: {
        user: { select: { id: true, fullName: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })

    res.json({
      logs: logs.map((log) => ({
        id: log.id,
        action: log.action,
        entityType: log.entityType,
        entityId: log.entityId,
        metadata: log.metadata,
        ipAddress: log.ipAddress,
        userAgent: log.userAgent,
        createdAt: log.createdAt,
        user: log.user,
      })),
    })
  } catch (error) {
    next(error)
  }
})
