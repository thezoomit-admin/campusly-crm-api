import { Router } from 'express'
import { requestIp, requestUserAgent, routeParam } from '../../lib/request'
import { requireAuth, requirePermission } from '../auth/require-auth.middleware'
import {
  createRole,
  deleteRole,
  getRole,
  listRoleOptions,
  listRoles,
  setRolePermissions,
  updateRole,
  updateRoleStatus,
} from './roles.service'

export const rolesRouter = Router()

rolesRouter.use(requireAuth)

rolesRouter.get(
  '/options',
  requirePermission(['user:view', 'user:create', 'user:edit', 'role:view']),
  async (_req, res, next) => {
    try {
      res.json({ roles: await listRoleOptions() })
    } catch (error) {
      next(error)
    }
  },
)

rolesRouter.get('/', requirePermission('role:view'), async (req, res, next) => {
  try {
    const roles = await listRoles({
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      assignedUserCount: typeof req.query.assignedUserCount === 'string' ? req.query.assignedUserCount : undefined,
    })
    res.json({ roles })
  } catch (error) {
    next(error)
  }
})

rolesRouter.post('/', requirePermission('role:create'), async (req, res, next) => {
  try {
    const role = await createRole(req.auth!, req.body ?? {}, {
      ipAddress: requestIp(req),
      userAgent: requestUserAgent(req),
    })
    res.status(201).json({ role })
  } catch (error) {
    next(error)
  }
})

rolesRouter.get('/:id', requirePermission('role:view'), async (req, res, next) => {
  try {
    const role = await getRole(routeParam(req.params.id))
    res.json({ role })
  } catch (error) {
    next(error)
  }
})

rolesRouter.patch('/:id', requirePermission('role:edit'), async (req, res, next) => {
  try {
    const role = await updateRole(req.auth!, routeParam(req.params.id), req.body ?? {}, {
      ipAddress: requestIp(req),
      userAgent: requestUserAgent(req),
    })
    res.json({ role })
  } catch (error) {
    next(error)
  }
})

rolesRouter.post('/:id/status', requirePermission('role:edit'), async (req, res, next) => {
  try {
    const role = await updateRoleStatus(req.auth!, routeParam(req.params.id), req.body?.status, {
      ipAddress: requestIp(req),
      userAgent: requestUserAgent(req),
    })
    res.json({ role })
  } catch (error) {
    next(error)
  }
})

rolesRouter.delete('/:id', requirePermission('role:delete'), async (req, res, next) => {
  try {
    await deleteRole(req.auth!, routeParam(req.params.id), {
      ipAddress: requestIp(req),
      userAgent: requestUserAgent(req),
    })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

rolesRouter.put('/:id/permissions', requirePermission('permission:configure'), async (req, res, next) => {
  try {
    const role = await setRolePermissions(req.auth!, routeParam(req.params.id), req.body?.permissionIds, {
      ipAddress: requestIp(req),
      userAgent: requestUserAgent(req),
    })
    res.json({ role })
  } catch (error) {
    next(error)
  }
})
