import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { Router, type Request } from 'express'
import { config } from '../../config'
import { asString } from '../leads/leads.helpers'
import {
  handleIncomingWhatsApp,
  handleWhatsAppStatus,
  type MetaInboundMessage,
  type MetaStatus,
} from './whatsapp.service'

/**
 * WhatsApp Business webhook (CRM-012).
 * GET  — Meta subscription verification (hub.challenge).
 * POST — Meta Cloud API payloads (messages + delivery statuses), or a flat
 *        `{ from, name, message, messageId }` body for testing and simple providers.
 */
export const whatsappWebhookRouter = Router()

whatsappWebhookRouter.get('/', (req, res) => {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']
  if (mode === 'subscribe' && config.whatsapp.verifyToken && token === config.whatsapp.verifyToken) {
    res.status(200).send(typeof challenge === 'string' ? challenge : '')
    return
  }
  res.sendStatus(403)
})

function hasValidSignature(req: Request) {
  const secret = config.whatsapp.appSecret
  if (!secret) return !config.isProduction
  const header = req.header('x-hub-signature-256') || ''
  if (!req.rawBody || !header.startsWith('sha256=')) return false
  const expected = `sha256=${createHmac('sha256', secret).update(req.rawBody).digest('hex')}`
  const a = Buffer.from(header)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

type MetaWebhookBody = {
  object?: string
  entry?: Array<{
    changes?: Array<{
      value?: {
        contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>
        messages?: MetaInboundMessage[]
        statuses?: MetaStatus[]
      }
    }>
  }>
}

function flatToMeta(body: Record<string, unknown>): { message: MetaInboundMessage; name: string | null } | null {
  const from = asString(body.from) || asString(body.phone) || asString(body.senderPhone)
  if (!from) return null
  const text = asString(body.message) || asString(body.body) || asString(body.text)
  const mediaUrl = asString(body.mediaUrl)
  const mime = asString(body.mimeType) || 'application/octet-stream'
  const id = asString(body.messageId) || asString(body.id) || `test.${randomUUID()}`

  if (mediaUrl) {
    const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'document'
    return {
      name: asString(body.name) || asString(body.senderName) || null,
      message: {
        from,
        id,
        type: kind,
        [kind]: { link: mediaUrl, mime_type: mime, caption: text || undefined, filename: asString(body.fileName) || undefined },
      } as MetaInboundMessage,
    }
  }

  return {
    name: asString(body.name) || asString(body.senderName) || null,
    message: { from, id, type: 'text', text: { body: text } },
  }
}

whatsappWebhookRouter.post('/', async (req, res) => {
  if (!hasValidSignature(req)) {
    res.status(401).json({ error: 'Invalid webhook signature.', code: 'WEBHOOK_UNAUTHORIZED' })
    return
  }

  const body = (req.body || {}) as MetaWebhookBody & Record<string, unknown>
  const results: unknown[] = []

  try {
    if (Array.isArray(body.entry)) {
      for (const entry of body.entry) {
        for (const change of entry.changes || []) {
          const value = change.value || {}
          const names = new Map((value.contacts || []).map((c) => [c.wa_id || '', c.profile?.name || null]))
          for (const message of value.messages || []) {
            try {
              results.push(await handleIncomingWhatsApp(message, names.get(message.from) ?? value.contacts?.[0]?.profile?.name))
            } catch (error) {
              console.error('[whatsapp] incoming message failed:', error)
            }
          }
          for (const status of value.statuses || []) {
            await handleWhatsAppStatus(status).catch((error) => console.error('[whatsapp] status failed:', error))
          }
        }
      }
    } else {
      const flat = flatToMeta(body)
      if (!flat) {
        res.status(400).json({ error: 'Unable to identify the sender information.', code: 'INVALID_INPUT' })
        return
      }
      results.push(await handleIncomingWhatsApp(flat.message, flat.name))
    }
  } catch (error) {
    console.error('[whatsapp] webhook failed:', error)
  }

  // Always 200 so Meta does not retry-storm; message ids make processing idempotent.
  res.status(200).json({ received: true, results })
})
