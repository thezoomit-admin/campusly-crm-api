import type { NextFunction, Request, Response } from 'express'
import { hasPermission } from './access'

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.auth?.user) {
    res.status(401).json({
      error: 'Authentication required',
      code: 'UNAUTHENTICATED',
    })
    return
  }

  next()
}

export function requirePermission(required: string | string[], message?: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth?.user) {
      res.status(401).json({
        error: 'Authentication required',
        code: 'UNAUTHENTICATED',
      })
      return
    }

    if (!hasPermission(req.auth.permissions, required)) {
      res.status(403).json({
        error: message || 'You do not have permission to perform this action.',
        code: 'ACCESS_DENIED',
      })
      return
    }

    next()
  }
}
