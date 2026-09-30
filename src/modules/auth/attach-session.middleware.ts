import type { NextFunction, Request, Response } from 'express'
import { SESSION_COOKIE } from '../../config'
import { loadAuthFromToken } from './session.service'

/** Public auth routes that must not pay for a session DB round-trip. */
const SKIP_SESSION_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/health',
])

function shouldSkipSession(path: string) {
  if (SKIP_SESSION_PATHS.has(path)) return true
  if (path.startsWith('/api/webhooks/')) return true
  if (path.startsWith('/api/public/')) return true
  return false
}

export async function attachSession(req: Request, _res: Response, next: NextFunction) {
  if (shouldSkipSession(req.path)) {
    next()
    return
  }

  try {
    req.auth = (await loadAuthFromToken(req.cookies?.[SESSION_COOKIE])) ?? undefined
    next()
  } catch (error) {
    next(error)
  }
}
