import { randomUUID } from 'node:crypto'
import { config } from '../../config'

export type OutgoingPayload =
  | { kind: 'text'; text: string }
  | { kind: 'image'; link: string; caption?: string }
  | { kind: 'video'; link: string; caption?: string }
  | { kind: 'audio'; link: string }
  | { kind: 'document'; link: string; fileName?: string; caption?: string }
  | { kind: 'template'; name: string; language: string }

export class WhatsAppProviderError extends Error {}

export function isWhatsAppConfigured() {
  return Boolean(config.whatsapp.accessToken && config.whatsapp.phoneNumberId)
}

export function isMockMode() {
  return !isWhatsAppConfigured() && !config.isProduction
}

function graphUrl(path: string) {
  return `https://graph.facebook.com/${config.whatsapp.graphVersion}/${path}`
}

function toProviderBody(to: string, payload: OutgoingPayload) {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to }
  switch (payload.kind) {
    case 'text':
      return { ...base, type: 'text', text: { preview_url: true, body: payload.text } }
    case 'image':
      return { ...base, type: 'image', image: { link: payload.link, caption: payload.caption } }
    case 'video':
      return { ...base, type: 'video', video: { link: payload.link, caption: payload.caption } }
    case 'audio':
      return { ...base, type: 'audio', audio: { link: payload.link } }
    case 'document':
      return {
        ...base,
        type: 'document',
        document: { link: payload.link, filename: payload.fileName, caption: payload.caption },
      }
    case 'template':
      return {
        ...base,
        type: 'template',
        template: { name: payload.name, language: { code: payload.language } },
      }
  }
}

/** Returns the provider message id (wamid). */
export async function sendWhatsApp(to: string, payload: OutgoingPayload): Promise<string> {
  if (!isWhatsAppConfigured()) {
    if (isMockMode()) {
      console.info(`[whatsapp:mock] -> ${to}`, JSON.stringify(payload))
      return `mock.${randomUUID()}`
    }
    throw new WhatsAppProviderError('WhatsApp Business API is not configured.')
  }

  const response = await fetch(graphUrl(`${config.whatsapp.phoneNumberId}/messages`), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.whatsapp.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(toProviderBody(to, payload)),
  })

  const json = (await response.json().catch(() => ({}))) as {
    messages?: Array<{ id: string }>
    error?: { message?: string; code?: number }
  }
  if (!response.ok || !json.messages?.[0]?.id) {
    throw new WhatsAppProviderError(json.error?.message || `WhatsApp API responded with ${response.status}`)
  }
  return json.messages[0].id
}

/** Downloads inbound media by its WhatsApp media id. */
export async function downloadWhatsAppMedia(mediaId: string) {
  if (!isWhatsAppConfigured()) return null

  const metaRes = await fetch(graphUrl(mediaId), {
    headers: { Authorization: `Bearer ${config.whatsapp.accessToken}` },
  })
  if (!metaRes.ok) throw new WhatsAppProviderError(`Media lookup failed (${metaRes.status})`)
  const meta = (await metaRes.json()) as { url?: string; mime_type?: string; file_size?: number }
  if (!meta.url) throw new WhatsAppProviderError('Media URL missing.')

  const fileRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${config.whatsapp.accessToken}` },
  })
  if (!fileRes.ok) throw new WhatsAppProviderError(`Media download failed (${fileRes.status})`)
  const buffer = Buffer.from(await fileRes.arrayBuffer())
  return { buffer, mimeType: meta.mime_type || fileRes.headers.get('content-type') || 'application/octet-stream' }
}
