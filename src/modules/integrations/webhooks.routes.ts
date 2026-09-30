import { Router } from 'express'
import {
  ingestCommunication,
  normalizeWebhookBody,
} from '../communications/communications.service'
import type { CommunicationChannel } from '../../lib/prisma-client'

export const webhooksRouter = Router()

async function handleChannel(channel: CommunicationChannel, body: Record<string, unknown>) {
  return ingestCommunication(normalizeWebhookBody(channel, body || {}))
}

/**
 * Website form webhook (Apply Now, Contact, Consultation, etc.)
 * Body: { name, phone?, email?, country?, message?, formName?, campaign?, utm_*?, externalId? }
 */
webhooksRouter.post('/website', async (req, res, next) => {
  try {
    const result = await handleChannel('WEBSITE', req.body || {})
    res.status(result.created ? 201 : 200).json(result)
  } catch (error) {
    next(error)
  }
})

/**
 * WhatsApp provider webhook — routes through Communication Hub (CRM-010 / CRM-012).
 */
webhooksRouter.post('/whatsapp', async (req, res, next) => {
  try {
    const result = await handleChannel('WHATSAPP', req.body || {})
    res.status(result.created ? 201 : 200).json(result)
  } catch (error) {
    next(error)
  }
})

/**
 * Email provider webhook — routes through Communication Hub (CRM-010 / CRM-013).
 */
webhooksRouter.post('/email', async (req, res, next) => {
  try {
    const result = await handleChannel('EMAIL', req.body || {})
    res.status(result.created ? 201 : 200).json(result)
  } catch (error) {
    next(error)
  }
})

/**
 * Meta Lead Ads (Facebook) — normalized lead form payload.
 */
webhooksRouter.post('/meta/facebook', async (req, res, next) => {
  try {
    const result = await handleChannel('META_FACEBOOK', req.body || {})
    res.status(result.created ? 201 : 200).json(result)
  } catch (error) {
    next(error)
  }
})

/**
 * Meta Lead Ads (Instagram) — normalized lead form payload.
 */
webhooksRouter.post('/meta/instagram', async (req, res, next) => {
  try {
    const result = await handleChannel('META_INSTAGRAM', req.body || {})
    res.status(result.created ? 201 : 200).json(result)
  } catch (error) {
    next(error)
  }
})

/** Convenience alias for Meta lead forms when platform is in the body. */
webhooksRouter.post('/meta', async (req, res, next) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>
    const platform = String(body.platform || body.source || '').toLowerCase()
    const channel: CommunicationChannel =
      platform.includes('instagram') || platform.includes('ig') ? 'META_INSTAGRAM' : 'META_FACEBOOK'
    const result = await handleChannel(channel, body)
    res.status(result.created ? 201 : 200).json(result)
  } catch (error) {
    next(error)
  }
})
