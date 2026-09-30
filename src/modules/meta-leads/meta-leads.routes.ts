import { createHmac, timingSafeEqual } from 'node:crypto'
import { Router, type Request } from 'express'
import { config } from '../../config'
import { HttpError } from '../../lib/http-error'
import { routeParam } from '../../lib/request'
import { requireAuth, requirePermission } from '../auth/require-auth.middleware'
import { META_MESSAGES } from './meta-leads.constants'
import { fetchMetaLeadgen } from './meta-graph'
import { collectLeadgenRefs, isMetaPageWebhook } from './meta-leads.parse'
import {
  getMetaLead,
  listLeadCampaignTouches,
  listMetaLeads,
  metaPerformance,
  metaSettings,
  receiveMetaLead,
} from './meta-leads.service'
import type { MetaPlatformCode } from './meta-leads.constants'

export const metaLeadsRouter = Router()

metaLeadsRouter.use(requireAuth)
metaLeadsRouter.use(requirePermission(['communication:view', 'campaign:view', 'lead:view'], META_MESSAGES.denied))

function queryString(value: unknown) {
  return typeof value === 'string' ? value.trim() : undefined
}

function queryInt(value: unknown) {
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

metaLeadsRouter.get('/settings', async (_req, res, next) => {
  try {
    res.json(metaSettings())
  } catch (error) {
    next(error)
  }
})

metaLeadsRouter.get('/performance', async (req, res, next) => {
  try {
    res.json(
      await metaPerformance(req.auth!, {
        platform: queryString(req.query.platform),
        country: queryString(req.query.country),
        campaign: queryString(req.query.campaign),
      }),
    )
  } catch (error) {
    next(error)
  }
})

metaLeadsRouter.get('/lead/:leadId', async (req, res, next) => {
  try {
    res.json(await listLeadCampaignTouches(req.auth!, routeParam(req.params.leadId)))
  } catch (error) {
    next(error)
  }
})

metaLeadsRouter.get('/', async (req, res, next) => {
  try {
    res.json(
      await listMetaLeads(req.auth!, {
        search: queryString(req.query.search),
        platform: queryString(req.query.platform),
        formType: queryString(req.query.formType),
        country: queryString(req.query.country),
        campaign: queryString(req.query.campaign),
        outcome: queryString(req.query.outcome),
        page: queryInt(req.query.page),
        limit: queryInt(req.query.limit),
      }),
    )
  } catch (error) {
    next(error)
  }
})

metaLeadsRouter.get('/:id', async (req, res, next) => {
  try {
    res.json(await getMetaLead(req.auth!, routeParam(req.params.id)))
  } catch (error) {
    next(error)
  }
})

metaLeadsRouter.post('/receive', requirePermission('communication:reprocess', META_MESSAGES.denied), async (req, res, next) => {
  try {
    const result = await receiveMetaLead((req.body || {}) as Record<string, unknown>)
    res.status(result.created ? 201 : 200).json({ success: true, ...result })
  } catch (error) {
    next(error)
  }
})

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

function hasValidSignature(req: Request) {
  const secret = config.meta.appSecret
  if (!secret) return false
  const header = req.header('x-hub-signature-256') || ''
  if (!req.rawBody || !header.startsWith('sha256=')) return false
  const expected = `sha256=${createHmac('sha256', secret).update(req.rawBody).digest('hex')}`
  const a = Buffer.from(header)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function assertMetaWebhookAuth(req: Request) {
  const secret = config.meta.webhookSecret
  const appSecret = config.meta.appSecret
  if (!secret && !appSecret) {
    if (config.isProduction) throw new HttpError(401, 'Unauthorized', 'WEBHOOK_UNAUTHORIZED')
    return
  }
  const token = takeToken(req)
  if (secret && token === secret) return
  if (hasValidSignature(req)) return
  throw new HttpError(401, 'Unauthorized', 'WEBHOOK_UNAUTHORIZED')
}

export function verifyMetaWebhook(req: Request) {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']
  if (mode === 'subscribe' && config.meta.verifyToken && token === config.meta.verifyToken) {
    return typeof challenge === 'string' ? challenge : ''
  }
  return null
}

async function bodyForLeadgen(ref: { leadgenId: string; formId: string | null; adId: string | null; createdTime: string | null }) {
  const graph = await fetchMetaLeadgen(ref.leadgenId)
  if (graph) {
    return {
      ...graph,
      externalId: ref.leadgenId,
      form_id: ref.formId,
      ad_id: ref.adId,
      created_time: asCreated(graph.created_time) || ref.createdTime,
    }
  }
  return {
    externalId: ref.leadgenId,
    leadgen_id: ref.leadgenId,
    form_id: ref.formId,
    ad_id: ref.adId,
    created_time: ref.createdTime,
  }
}

function asCreated(value: unknown) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

export async function acceptMetaWebhook(body: Record<string, unknown>, fallbackPlatform: MetaPlatformCode) {
  if (isMetaPageWebhook(body)) {
    const refs = collectLeadgenRefs(body)
    if (!refs.length) {
      return { success: true, message: META_MESSAGES.received, results: [] as unknown[] }
    }
    const results = []
    for (const ref of refs) {
      const payload = await bodyForLeadgen(ref)
      try {
        const result = await receiveMetaLead(payload, fallbackPlatform)
        results.push({ success: true, ...result })
      } catch (error) {
        results.push({
          success: false,
          message: error instanceof Error ? error.message : META_MESSAGES.incomplete,
          externalId: ref.leadgenId,
        })
      }
    }
    const failed = results.some((item) => item.success === false)
    return {
      success: true,
      message: failed ? META_MESSAGES.incomplete : META_MESSAGES.received,
      results,
    }
  }

  return { success: true, ...(await receiveMetaLead(body, fallbackPlatform)) }
}
