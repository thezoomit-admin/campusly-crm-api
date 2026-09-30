import type { NextFunction, Request, Response } from 'express'
import { config } from '../../config'
import { HttpError } from '../../lib/http-error'

function takeToken(req: Request) {
  const headerKey =
    (typeof req.headers['x-webhook-key'] === 'string' && req.headers['x-webhook-key']) ||
    (typeof req.headers['x-api-key'] === 'string' && req.headers['x-api-key']) ||
    ''
  if (headerKey.trim()) return headerKey.trim()
  const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization.trim() : ''
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  return ''
}

/** Shared secret for the company mailbox inbound webhook. Open in development when unset. */
export function requireEmailWebhookAuth(req: Request, _res: Response, next: NextFunction) {
  const secret = config.email.webhookSecret
  if (!secret) {
    if (config.isProduction) {
      next(new HttpError(401, 'Email webhook is not authorized.', 'WEBHOOK_UNAUTHORIZED'))
      return
    }
    next()
    return
  }
  const token = takeToken(req)
  if (!token || token !== secret) {
    next(new HttpError(401, 'Email webhook is not authorized.', 'WEBHOOK_UNAUTHORIZED'))
    return
  }
  next()
}
