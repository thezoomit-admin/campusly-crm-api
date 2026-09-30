import type { NextFunction, Request, Response } from 'express'
import { config } from '../../config'
import { HttpError } from '../../lib/http-error'
import { WEBSITE_MESSAGES } from './website-forms'

const hits = new Map<string, number[]>()

function clientKey(req: Request) {
  const forwarded = req.headers['x-forwarded-for']
  const ip =
    (typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined) ||
    req.ip ||
    req.socket.remoteAddress ||
    'unknown'
  return ip
}

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

function assertRateLimit(req: Request) {
  const key = clientKey(req)
  const now = Date.now()
  const windowMs = 60_000
  const limit = config.websiteWebhookRateLimitPerMinute
  const recent = (hits.get(key) || []).filter((ts) => now - ts < windowMs)
  recent.push(now)
  hits.set(key, recent)
  if (recent.length > limit) {
    throw new HttpError(429, WEBSITE_MESSAGES.rateLimited, 'RATE_LIMITED')
  }
}

/**
 * Protects website lead-capture webhook with shared secret + basic rate limit.
 */
export function requireWebsiteWebhookAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    assertRateLimit(req)

    const secret = config.websiteWebhookSecret
    if (!secret) {
      if (config.isProduction) {
        throw new HttpError(401, WEBSITE_MESSAGES.unauthorized, 'WEBHOOK_UNAUTHORIZED')
      }
      next()
      return
    }

    const token = takeToken(req)
    if (!token || token !== secret) {
      throw new HttpError(401, WEBSITE_MESSAGES.unauthorized, 'WEBHOOK_UNAUTHORIZED')
    }
    next()
  } catch (error) {
    next(error)
  }
}
