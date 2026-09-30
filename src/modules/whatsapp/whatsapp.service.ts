import { config } from '../../config'
import { writeAuditLog } from '../../lib/audit'
import { HttpError, httpError } from '../../lib/http-error'
import { prisma } from '../../lib/prisma'
import type {
  Prisma,
  WhatsAppConversationStatus,
  WhatsAppMessageType,
} from '../../lib/prisma-client'
import type { AuthContext } from '../auth/session.service'
import {
  findManagers,
  ingestCommunication,
  resolveSystemActorId,
} from '../communications/communications.service'
import {
  asOptionalString,
  asString,
  assertCanViewLead,
  assigneeVisibilityWhere,
  hasPermission,
  isValidEmail,
  leadReadableWhere,
  normalizePhone,
  titleCaseName,
} from '../leads/leads.helpers'
import { assignLead } from '../leads/leads.service'
import { createNotification } from '../notifications/notifications.service'
import {
  WhatsAppProviderError,
  downloadWhatsAppMedia,
  isMockMode,
  isWhatsAppConfigured,
  sendWhatsApp,
  type OutgoingPayload,
} from './whatsapp.client'
import {
  assertOutgoingAttachment,
  isMessageTypeEnabled,
  messageTypeForMime,
  storeWhatsAppAttachment,
} from './whatsapp.storage'

export const WHATSAPP_MESSAGES = {
  sendFailed: 'Unable to send WhatsApp message.',
  attachmentFailed: 'Unable to upload attachment.',
  unavailable: 'Conversation could not be loaded.',
  denied: 'You do not have permission to access this conversation.',
} as const

const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000
const LINK_CLAIM_MS = 60 * 1000

type AuditMeta = { ipAddress?: string; userAgent?: string }

type MetaMedia = { id?: string; link?: string; mime_type?: string; caption?: string; filename?: string }

export type MetaInboundMessage = {
  from: string
  id: string
  timestamp?: string
  type: string
  text?: { body?: string }
  image?: MetaMedia
  document?: MetaMedia
  video?: MetaMedia
  audio?: MetaMedia
  voice?: MetaMedia
  sticker?: MetaMedia
  button?: { text?: string }
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } }
  location?: { latitude?: number; longitude?: number; name?: string; address?: string }
}

export type MetaStatus = {
  id: string
  status: string
  errors?: Array<{ title?: string; message?: string }>
}

const conversationInclude = {
  lead: {
    select: {
      id: true,
      code: true,
      name: true,
      phone: true,
      whatsapp: true,
      email: true,
      country: true,
      preferredCountryCode: true,
      status: true,
      ownerId: true,
      ownerName: true,
    },
  },
  assignedUser: { select: { id: true, fullName: true } },
} as const

type ConversationRow = Prisma.WhatsAppConversationGetPayload<{ include: typeof conversationInclude }>

const messageInclude = { sentBy: { select: { id: true, fullName: true } } } as const
type MessageRow = Prisma.WhatsAppMessageGetPayload<{ include: typeof messageInclude }>

function displayPhone(waNumber: string) {
  return `+${waNumber}`
}

function replyWindow(lastInboundAt: Date | null) {
  if (!lastInboundAt) return { open: false, expiresAt: null as string | null }
  const expires = lastInboundAt.getTime() + REPLY_WINDOW_MS
  return { open: Date.now() < expires, expiresAt: new Date(expires).toISOString() }
}

function effectiveAssignee(row: ConversationRow) {
  if (row.lead) {
    return row.lead.ownerId ? { id: row.lead.ownerId, name: row.lead.ownerName || 'Assigned user' } : null
  }
  return row.assignedUser ? { id: row.assignedUser.id, name: row.assignedUser.fullName } : null
}

function serializeConversation(row: ConversationRow) {
  const window = replyWindow(row.lastInboundAt)
  return {
    id: row.id,
    waNumber: row.waNumber,
    phone: displayPhone(row.waNumber),
    contactName: row.contactName,
    displayName: row.lead?.name || row.contactName || displayPhone(row.waNumber),
    status: row.status,
    unreadCount: row.unreadCount,
    lastMessageAt: row.lastMessageAt ? row.lastMessageAt.toISOString() : null,
    lastMessagePreview: row.lastMessagePreview,
    lastDirection: row.lastDirection,
    lastInboundAt: row.lastInboundAt ? row.lastInboundAt.toISOString() : null,
    replyWindowOpen: window.open || isMockMode(),
    replyWindowExpiresAt: window.expiresAt,
    identified: Boolean(row.lead),
    lead: row.lead
      ? {
          id: row.lead.id,
          code: row.lead.code,
          name: row.lead.name,
          phone: row.lead.phone,
          email: row.lead.email,
          country: row.lead.country || row.lead.preferredCountryCode,
          status: row.lead.status,
        }
      : null,
    assignedUser: effectiveAssignee(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function serializeMessage(row: MessageRow) {
  return {
    id: row.id,
    conversationId: row.conversationId,
    direction: row.direction as 'incoming' | 'outgoing',
    type: row.type,
    body: row.body,
    deliveryStatus: row.deliveryStatus,
    errorMessage: row.errorMessage,
    sentAt: row.sentAt.toISOString(),
    sentBy: row.sentBy ? { id: row.sentBy.id, name: row.sentBy.fullName } : null,
    attachment: row.attachmentUrl
      ? {
          url: row.attachmentUrl,
          mimeType: row.attachmentMime,
          fileName: row.attachmentName,
          size: row.attachmentSize,
          docCategory: row.docCategory,
        }
      : null,
  }
}

function isUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

export function canManageWhatsApp(auth: AuthContext) {
  return hasPermission(auth.permissions, ['lead:assign', 'communication:reprocess'])
}

function assertCanViewWhatsApp(auth: AuthContext) {
  if (!hasPermission(auth.permissions, 'communication:view')) {
    throw httpError.accessDenied(WHATSAPP_MESSAGES.denied)
  }
}

function assertCanManage(auth: AuthContext) {
  if (!canManageWhatsApp(auth)) throw httpError.accessDenied(WHATSAPP_MESSAGES.denied)
}

/** Conversations follow Lead permissions; unidentified ones are visible to managers and their assignee. */
function conversationAccessWhere(auth: AuthContext): Prisma.WhatsAppConversationWhereInput {
  const leadScope = leadReadableWhere(auth)
  const linked: Prisma.WhatsAppConversationWhereInput =
    Object.keys(leadScope).length === 0 ? { leadId: { not: null } } : { lead: { is: leadScope } }
  const unlinked: Prisma.WhatsAppConversationWhereInput = canManageWhatsApp(auth)
    ? { leadId: null }
    : { leadId: null, assignedUserId: auth.user.id }
  return { OR: [linked, unlinked] }
}

async function assertConversationAccess(auth: AuthContext, id: string) {
  assertCanViewWhatsApp(auth)
  const row = await prisma.whatsAppConversation.findFirst({
    where: { id, AND: [conversationAccessWhere(auth)] },
    include: conversationInclude,
  })
  if (row) return row
  const exists = await prisma.whatsAppConversation.findUnique({ where: { id }, select: { id: true } })
  if (exists) throw httpError.accessDenied(WHATSAPP_MESSAGES.denied)
  throw httpError.notFound(WHATSAPP_MESSAGES.unavailable)
}

async function loadConversation(id: string) {
  return prisma.whatsAppConversation.findUniqueOrThrow({ where: { id }, include: conversationInclude })
}

function previewFor(type: WhatsAppMessageType, body: string | null, fileName?: string | null) {
  if (body?.trim()) return body.trim().slice(0, 160)
  const labels: Record<WhatsAppMessageType, string> = {
    TEXT: 'Message',
    IMAGE: '📷 Image',
    PDF: '📄 PDF',
    DOCUMENT: '📎 Document',
    VIDEO: '🎬 Video',
    VOICE: '🎤 Voice message',
    TEMPLATE: 'Template message',
  }
  return fileName ? `${labels[type]} · ${fileName}`.slice(0, 160) : labels[type]
}

async function createTimelineEntry(input: {
  leadId: string
  leadName: string
  userId: string
  outcome: string
  notes: string
  conversationId: string
  messageId?: string
  occurredAt?: Date
  extra?: Record<string, unknown>
}) {
  await prisma.activity.create({
    data: {
      type: 'WHATSAPP',
      userId: input.userId,
      relatedName: input.leadName,
      relatedType: 'lead',
      relatedId: input.leadId,
      outcome: input.outcome,
      notes: input.notes.slice(0, 4000),
      occurredAt: input.occurredAt || new Date(),
      metadata: {
        source: 'whatsapp',
        channel: 'WHATSAPP',
        conversationId: input.conversationId,
        messageId: input.messageId,
        ...(input.extra || {}),
      } as Prisma.InputJsonValue,
    },
  })
}

async function notifyRecipients(input: {
  assigneeId: string | null
  title: string
  body: string
  type: string
  conversationId: string
  leadId?: string | null
  dedupe: string
}) {
  const recipients = input.assigneeId ? [input.assigneeId] : (await findManagers()).map((m) => m.id)
  for (const userId of recipients) {
    await createNotification({
      userId,
      title: input.title,
      body: input.body,
      link: `/whatsapp?c=${input.conversationId}`,
      type: input.type,
      leadId: input.leadId || null,
      dedupeKey: `wa:${input.dedupe}:${userId}`,
    }).catch((error) => console.error('[whatsapp] notification failed:', error))
  }
}

/* ------------------------------------------------------------------ */
/* Lead matching & creation                                            */
/* ------------------------------------------------------------------ */

/** Matching priority: WhatsApp number, then phone number. */
async function matchLeadByNumber(waNumber: string) {
  const suffix = waNumber.slice(-10)
  const byWhatsApp = await prisma.lead.findFirst({
    where: {
      OR: [{ whatsapp: waNumber }, { whatsapp: `+${waNumber}` }, { whatsapp: { endsWith: suffix } }],
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  if (byWhatsApp) return byWhatsApp.id

  const byPhone = await prisma.lead.findFirst({
    where: {
      OR: [
        { phoneNormalized: waNumber },
        { phoneNormalized: { endsWith: suffix } },
        { phone: { endsWith: suffix } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  return byPhone?.id || null
}

const GREETING_ONLY =
  /^(hi+|hello+|hey+|hlw|helo|hii+|yo|salam|slm|assalamu?\s*alaikum|asalamualaikum|good\s*(morning|afternoon|evening|night)|ok(ay)?|thanks?|thank\s*you|\?+|\.+)[\s!.?,]*$/i

function hasUsefulInfo(text: string | null) {
  const value = (text || '').trim()
  if (value.length < 4) return false
  return !GREETING_ONLY.test(value)
}

async function detectCountryCode(text: string | null) {
  const value = (text || '').toLowerCase()
  if (!value) return undefined
  const countries = await prisma.masterDataItem.findMany({
    where: { categoryKey: 'COUNTRY', status: 'ACTIVE' },
    select: { code: true, name: true },
  })
  const match = countries
    .filter((item) => item.code && item.name)
    .sort((a, b) => b.name.length - a.name.length)
    .find((item) => new RegExp(`\\b${item.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(value))
  return match?.code || undefined
}

async function claimForLinking(conversationId: string) {
  const claimed = await prisma.whatsAppConversation.updateMany({
    where: {
      id: conversationId,
      leadId: null,
      OR: [{ linkingAt: null }, { linkingAt: { lt: new Date(Date.now() - LINK_CLAIM_MS) } }],
    },
    data: { linkingAt: new Date() },
  })
  return claimed.count === 1
}

async function linkConversationToLead(conversationId: string, leadId: string, hadOutgoing: boolean) {
  const lead = await prisma.lead.findUniqueOrThrow({
    where: { id: leadId },
    select: { id: true, name: true, ownerId: true },
  })
  const status: WhatsAppConversationStatus = lead.ownerId ? (hadOutgoing ? 'IN_PROGRESS' : 'ASSIGNED') : 'NEW'
  await prisma.whatsAppConversation.update({
    where: { id: conversationId },
    data: { leadId: lead.id, assignedUserId: lead.ownerId, linkingAt: null, status },
  })
  return lead
}

/**
 * Resolves a Lead for an unlinked conversation through the Communication Hub so that
 * duplicate check, New Lead Creation, and Country Rule assignment stay in one place.
 */
async function resolveLeadForInbound(input: {
  conversationId: string
  waNumber: string
  contactName: string | null
  text: string | null
  messageId: string
  providerMessageId: string
  eventAt: Date
}) {
  if (!(await claimForLinking(input.conversationId))) return { leadId: null, viaHub: false }

  try {
    const matchedLeadId = await matchLeadByNumber(input.waNumber)
    const shouldCreate = !matchedLeadId && config.whatsapp.autoCreateLead && hasUsefulInfo(input.text)
    if (!matchedLeadId && !shouldCreate) return { leadId: null, viaHub: false }

    const result = await ingestCommunication({
      channel: 'WHATSAPP',
      leadId: matchedLeadId || undefined,
      senderName: input.contactName || undefined,
      senderPhone: displayPhone(input.waNumber),
      whatsapp: displayPhone(input.waNumber),
      whatsappSameAsPhone: true,
      preferredCountryCode: shouldCreate ? await detectCountryCode(input.text) : undefined,
      message: input.text || undefined,
      externalId: input.providerMessageId,
      eventAt: input.eventAt,
      sourceCode: 'WHATSAPP',
    })

    const leadId = result.event.leadId || matchedLeadId
    if (!leadId) return { leadId: null, viaHub: false }

    await prisma.whatsAppMessage.update({
      where: { id: input.messageId },
      data: { communicationEventId: result.event.id },
    })
    return { leadId, viaHub: true }
  } catch (error) {
    console.error('[whatsapp] lead resolution failed:', error)
    const fallback = await matchLeadByNumber(input.waNumber).catch(() => null)
    return { leadId: fallback, viaHub: false }
  } finally {
    await prisma.whatsAppConversation
      .updateMany({ where: { id: input.conversationId, leadId: null }, data: { linkingAt: null } })
      .catch(() => undefined)
  }
}

/* ------------------------------------------------------------------ */
/* Incoming workflow                                                   */
/* ------------------------------------------------------------------ */

function inboundContent(msg: MetaInboundMessage): {
  type: WhatsAppMessageType
  text: string | null
  media: MetaMedia | null
} {
  const media = msg.image || msg.document || msg.video || msg.audio || msg.voice || msg.sticker || null
  switch (msg.type) {
    case 'text':
      return { type: 'TEXT', text: msg.text?.body || null, media: null }
    case 'image':
    case 'sticker':
      return { type: 'IMAGE', text: media?.caption || null, media }
    case 'document': {
      const mime = (media?.mime_type || '').toLowerCase()
      return { type: mime.includes('pdf') ? 'PDF' : 'DOCUMENT', text: media?.caption || null, media }
    }
    case 'video':
      return { type: 'VIDEO', text: media?.caption || null, media }
    case 'audio':
    case 'voice':
      return { type: 'VOICE', text: null, media }
    case 'button':
      return { type: 'TEXT', text: msg.button?.text || null, media: null }
    case 'interactive':
      return {
        type: 'TEXT',
        text: msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || null,
        media: null,
      }
    case 'location': {
      const loc = msg.location
      const label = [loc?.name, loc?.address].filter(Boolean).join(', ')
      return {
        type: 'TEXT',
        text: `📍 Location${label ? `: ${label}` : ''}${loc?.latitude != null ? ` (${loc.latitude}, ${loc.longitude})` : ''}`,
        media: null,
      }
    }
    default:
      return { type: 'TEXT', text: msg.text?.body || `[Unsupported message: ${msg.type}]`, media: null }
  }
}

async function getOrCreateConversation(waNumber: string, contactName: string | null) {
  const existing = await prisma.whatsAppConversation.findUnique({ where: { waNumber } })
  if (existing) return { conversation: existing, created: false }
  try {
    const conversation = await prisma.whatsAppConversation.create({
      data: { waNumber, contactName, status: 'NEW' },
    })
    return { conversation, created: true }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const conversation = await prisma.whatsAppConversation.findUniqueOrThrow({ where: { waNumber } })
    return { conversation, created: false }
  }
}

async function storeInboundMedia(conversationId: string, media: MetaMedia, type: WhatsAppMessageType) {
  if (!isMessageTypeEnabled(type)) return { stored: null, note: `${type.toLowerCase()} messages are disabled` }
  try {
    if (media.link) {
      return {
        stored: {
          url: media.link,
          mimeType: media.mime_type || 'application/octet-stream',
          fileName: media.filename || null,
          fileSize: null as number | null,
        },
        note: null,
      }
    }
    if (!media.id) return { stored: null, note: 'Media id missing' }
    const downloaded = await downloadWhatsAppMedia(media.id)
    if (!downloaded) return { stored: null, note: 'Media download unavailable (WhatsApp API not configured)' }
    const stored = await storeWhatsAppAttachment({
      conversationId,
      buffer: downloaded.buffer,
      mimeType: media.mime_type || downloaded.mimeType,
      fileName: media.filename,
    })
    return { stored, note: null }
  } catch (error) {
    console.error('[whatsapp] inbound media failed:', error)
    return { stored: null, note: WHATSAPP_MESSAGES.attachmentFailed }
  }
}

function nextInboundStatus(assigneeId: string | null, hadOutgoing: boolean): WhatsAppConversationStatus {
  if (!assigneeId) return 'NEW'
  return hadOutgoing ? 'WAITING_REPLY' : 'ASSIGNED'
}

export async function handleIncomingWhatsApp(msg: MetaInboundMessage, profileName?: string | null) {
  const waNumber = normalizePhone(asString(msg.from))
  if (!waNumber || waNumber.length < 8 || !msg.id) return { skipped: true as const }

  const duplicate = await prisma.whatsAppMessage.findUnique({ where: { providerMessageId: msg.id } })
  if (duplicate) return { skipped: true as const }

  const contactName = asOptionalString(profileName, 120)
  const eventAt = msg.timestamp ? new Date(Number(msg.timestamp) * 1000) : new Date()
  const { type, text, media } = inboundContent(msg)
  const { conversation, created } = await getOrCreateConversation(waNumber, contactName)
  const hadOutgoing = conversation.lastDirection === 'outgoing'

  const mediaResult = media ? await storeInboundMedia(conversation.id, media, type) : { stored: null, note: null }

  let message
  try {
    message = await prisma.whatsAppMessage.create({
      data: {
        conversationId: conversation.id,
        direction: 'incoming',
        type,
        body: text,
        providerMessageId: msg.id,
        deliveryStatus: 'received',
        errorMessage: mediaResult.note,
        attachmentUrl: mediaResult.stored?.url,
        attachmentMime: mediaResult.stored?.mimeType || media?.mime_type,
        attachmentName: mediaResult.stored?.fileName || media?.filename,
        attachmentSize: mediaResult.stored?.fileSize ?? undefined,
        sentAt: eventAt,
      },
    })
  } catch (error) {
    if (isUniqueViolation(error)) return { skipped: true as const }
    throw error
  }

  let leadId = conversation.leadId
  let viaHub = false
  if (!leadId) {
    const resolved = await resolveLeadForInbound({
      conversationId: conversation.id,
      waNumber,
      contactName: contactName || conversation.contactName,
      text,
      messageId: message.id,
      providerMessageId: msg.id,
      eventAt,
    })
    if (resolved.leadId) {
      await linkConversationToLead(conversation.id, resolved.leadId, hadOutgoing)
      leadId = resolved.leadId
      viaHub = resolved.viaHub
    }
  }

  const lead = leadId
    ? await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, name: true, code: true, ownerId: true } })
    : null
  const assigneeId = lead ? lead.ownerId : conversation.assignedUserId
  const preview = previewFor(type, text, mediaResult.stored?.fileName || media?.filename)

  await prisma.whatsAppConversation.update({
    where: { id: conversation.id },
    data: {
      unreadCount: { increment: 1 },
      lastMessageAt: eventAt,
      lastInboundAt: eventAt,
      lastMessagePreview: preview,
      lastDirection: 'incoming',
      status: nextInboundStatus(assigneeId, hadOutgoing),
      ...(contactName && !conversation.contactName ? { contactName } : {}),
      ...(lead ? { assignedUserId: lead.ownerId } : {}),
    },
  })

  if (lead) {
    const actorId = await resolveSystemActorId(lead.ownerId)
    await prisma.lead.update({ where: { id: lead.id }, data: { lastEnquiryAt: eventAt } }).catch(() => undefined)
    if (created || viaHub) {
      await createTimelineEntry({
        leadId: lead.id,
        leadName: lead.name,
        userId: actorId,
        outcome: 'Conversation Started',
        notes: `WhatsApp conversation started from ${displayPhone(waNumber)}`,
        conversationId: conversation.id,
        messageId: message.id,
        occurredAt: eventAt,
      })
    }
    if (!viaHub) {
      await createTimelineEntry({
        leadId: lead.id,
        leadName: lead.name,
        userId: actorId,
        outcome: 'Incoming Message',
        notes: text || preview,
        conversationId: conversation.id,
        messageId: message.id,
        occurredAt: eventAt,
      })
    }
    if (mediaResult.stored || media) {
      await createTimelineEntry({
        leadId: lead.id,
        leadName: lead.name,
        userId: actorId,
        outcome: 'Attachment Received',
        notes: `${preview}${mediaResult.stored?.url ? '' : ' (not stored)'}`,
        conversationId: conversation.id,
        messageId: message.id,
        occurredAt: eventAt,
        extra: { attachmentUrl: mediaResult.stored?.url },
      })
    }
  }

  // The Communication Hub already notifies on lead match/creation.
  if (!viaHub) {
    const who = lead ? `${lead.code} — ${lead.name}` : contactName || displayPhone(waNumber)
    const base = { conversationId: conversation.id, leadId: lead?.id, assigneeId, dedupe: message.id }
    if (!lead && created) {
      await notifyRecipients({
        ...base,
        title: 'New WhatsApp Conversation',
        body: `Unidentified conversation from ${who} needs review.`,
        type: 'whatsapp_new_conversation',
      })
    } else if (!assigneeId) {
      await notifyRecipients({
        ...base,
        title: 'Unassigned WhatsApp Conversation',
        body: `${who}: ${preview}`,
        type: 'whatsapp_unassigned',
      })
    } else if (media) {
      await notifyRecipients({
        ...base,
        title: 'WhatsApp Attachment Received',
        body: `${who} sent ${preview}`,
        type: 'whatsapp_attachment',
      })
    } else if (hadOutgoing) {
      await notifyRecipients({
        ...base,
        title: 'Student Replied on WhatsApp',
        body: `${who}: ${preview}`,
        type: 'whatsapp_student_reply',
      })
    } else {
      await notifyRecipients({
        ...base,
        title: 'New WhatsApp Message',
        body: `${who}: ${preview}`,
        type: 'new_whatsapp_message',
      })
    }
  }

  return { skipped: false as const, conversationId: conversation.id, messageId: message.id, leadId }
}

const STATUS_RANK: Record<string, number> = { failed: 0, pending: 1, sent: 2, delivered: 3, read: 4 }

export async function handleWhatsAppStatus(status: MetaStatus) {
  if (!status?.id || !status.status) return
  const row = await prisma.whatsAppMessage.findUnique({ where: { providerMessageId: status.id } })
  if (!row) return
  const next = status.status.toLowerCase()
  if (next !== 'failed' && (STATUS_RANK[next] ?? 0) <= (STATUS_RANK[row.deliveryStatus] ?? 0)) return
  await prisma.whatsAppMessage.update({
    where: { id: row.id },
    data: {
      deliveryStatus: next,
      ...(next === 'failed'
        ? { errorMessage: status.errors?.map((e) => e.message || e.title).filter(Boolean).join('; ') || 'Delivery failed' }
        : {}),
    },
  })
}

/* ------------------------------------------------------------------ */
/* Inbox & thread                                                      */
/* ------------------------------------------------------------------ */

const STATUSES: WhatsAppConversationStatus[] = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_REPLY', 'RESOLVED', 'CLOSED']

export function getWhatsAppSettings(auth: AuthContext) {
  assertCanViewWhatsApp(auth)
  return {
    configured: isWhatsAppConfigured(),
    mockMode: isMockMode(),
    autoCreateLead: config.whatsapp.autoCreateLead,
    allowVideo: config.whatsapp.allowVideo,
    allowVoice: config.whatsapp.allowVoice,
    defaultTemplate: config.whatsapp.defaultTemplate,
    canManage: canManageWhatsApp(auth),
  }
}

export async function listConversations(
  auth: AuthContext,
  query: { search?: string; status?: string; assigned?: string; page?: number; limit?: number },
) {
  assertCanViewWhatsApp(auth)
  const page = Math.max(1, query.page || 1)
  const limit = Math.min(100, Math.max(10, query.limit || 30))
  const access = conversationAccessWhere(auth)
  const status = query.status?.toUpperCase() as WhatsAppConversationStatus | undefined
  const search = query.search?.trim()
  const digits = search?.replace(/\D/g, '')

  let assignedFilter: Prisma.WhatsAppConversationWhereInput = {}
  if (query.assigned === 'me') {
    assignedFilter = {
      OR: [{ lead: { is: { ownerId: auth.user.id } } }, { leadId: null, assignedUserId: auth.user.id }],
    }
  } else if (query.assigned === 'unassigned') {
    assignedFilter = { OR: [{ lead: { is: { ownerId: null } } }, { leadId: null, assignedUserId: null }] }
  } else if (query.assigned === 'unidentified') {
    assignedFilter = { leadId: null }
  }

  const where: Prisma.WhatsAppConversationWhereInput = {
    AND: [
      access,
      status && STATUSES.includes(status) ? { status } : {},
      assignedFilter,
      search
        ? {
            OR: [
              { contactName: { contains: search, mode: 'insensitive' } },
              ...(digits && digits.length >= 3 ? [{ waNumber: { contains: digits } }] : []),
              { lastMessagePreview: { contains: search, mode: 'insensitive' } },
              { lead: { is: { name: { contains: search, mode: 'insensitive' } } } },
              { lead: { is: { code: { contains: search, mode: 'insensitive' } } } },
            ],
          }
        : {},
    ],
  }

  const [total, rows, grouped, unread] = await Promise.all([
    prisma.whatsAppConversation.count({ where }),
    prisma.whatsAppConversation.findMany({
      where,
      include: conversationInclude,
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.whatsAppConversation.groupBy({ by: ['status'], where: access, _count: { _all: true } }),
    prisma.whatsAppConversation.aggregate({ where: access, _sum: { unreadCount: true } }),
  ])

  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<WhatsAppConversationStatus, number>
  for (const row of grouped) byStatus[row.status] = row._count._all

  return {
    items: rows.map(serializeConversation),
    total,
    page,
    limit,
    summary: { byStatus, unread: unread._sum.unreadCount || 0 },
  }
}

export async function getConversation(auth: AuthContext, id: string) {
  const row = await assertConversationAccess(auth, id)
  return { conversation: serializeConversation(row) }
}

export async function listMessages(auth: AuthContext, id: string, query: { before?: string; limit?: number }) {
  await assertConversationAccess(auth, id)
  const limit = Math.min(200, Math.max(20, query.limit || 100))
  const before = query.before ? new Date(query.before) : null
  const rows = await prisma.whatsAppMessage.findMany({
    where: {
      conversationId: id,
      ...(before && !Number.isNaN(before.getTime()) ? { sentAt: { lt: before } } : {}),
    },
    include: messageInclude,
    orderBy: { sentAt: 'desc' },
    take: limit + 1,
  })
  const hasMore = rows.length > limit
  return { items: rows.slice(0, limit).reverse().map(serializeMessage), hasMore }
}

export async function markConversationRead(auth: AuthContext, id: string) {
  await assertConversationAccess(auth, id)
  await prisma.whatsAppConversation.update({ where: { id }, data: { unreadCount: 0 } })
  return { ok: true }
}

/* ------------------------------------------------------------------ */
/* Outgoing workflow                                                   */
/* ------------------------------------------------------------------ */

async function recordOutgoing(input: {
  auth: AuthContext
  conversation: ConversationRow
  type: WhatsAppMessageType
  body: string | null
  payloads: OutgoingPayload[]
  attachment?: { url: string; mimeType: string; fileName: string; fileSize: number } | null
  docCategory?: string | null
  meta?: AuditMeta
}) {
  const { auth, conversation } = input
  let providerMessageId: string | null = null
  let failure: string | null = null

  try {
    for (const payload of input.payloads) {
      providerMessageId = await sendWhatsApp(conversation.waNumber, payload)
    }
  } catch (error) {
    failure = error instanceof WhatsAppProviderError ? error.message : 'Provider request failed'
    console.error('[whatsapp] send failed:', error)
  }

  const now = new Date()
  const message = await prisma.whatsAppMessage.create({
    data: {
      conversationId: conversation.id,
      direction: 'outgoing',
      type: input.type,
      body: input.body,
      providerMessageId,
      deliveryStatus: failure ? 'failed' : 'sent',
      errorMessage: failure,
      sentById: auth.user.id,
      attachmentUrl: input.attachment?.url,
      attachmentMime: input.attachment?.mimeType,
      attachmentName: input.attachment?.fileName,
      attachmentSize: input.attachment?.fileSize,
      docCategory: input.docCategory || null,
      sentAt: now,
    },
    include: messageInclude,
  })

  if (failure) {
    throw new HttpError(502, WHATSAPP_MESSAGES.sendFailed, 'WHATSAPP_SEND_FAILED', undefined, {
      message: serializeMessage(message),
    })
  }

  const preview = previewFor(input.type, input.body, input.attachment?.fileName)
  await prisma.whatsAppConversation.update({
    where: { id: conversation.id },
    data: {
      lastMessageAt: now,
      lastMessagePreview: preview,
      lastDirection: 'outgoing',
      status: 'IN_PROGRESS',
      unreadCount: 0,
      ...(!conversation.leadId && !conversation.assignedUserId ? { assignedUserId: auth.user.id } : {}),
    },
  })

  if (conversation.lead) {
    await createTimelineEntry({
      leadId: conversation.lead.id,
      leadName: conversation.lead.name,
      userId: auth.user.id,
      outcome: input.attachment ? 'Attachment Sent' : 'Outgoing Message',
      notes: input.attachment
        ? `${input.docCategory ? `${input.docCategory}: ` : ''}${input.attachment.fileName}${input.body ? ` — ${input.body}` : ''}`
        : input.body || preview,
      conversationId: conversation.id,
      messageId: message.id,
      occurredAt: now,
      extra: input.attachment ? { attachmentUrl: input.attachment.url, docCategory: input.docCategory } : undefined,
    })
    await prisma.lead.update({
      where: { id: conversation.lead.id },
      data: { updatedById: auth.user.id, updatedAt: now },
    })
  }

  await writeAuditLog({
    userId: auth.user.id,
    action: 'WHATSAPP_MESSAGE_SENT',
    entityType: 'whatsapp_conversation',
    entityId: conversation.id,
    ipAddress: input.meta?.ipAddress,
    userAgent: input.meta?.userAgent,
    metadata: {
      messageId: message.id,
      type: input.type,
      leadId: conversation.leadId,
      attachment: input.attachment?.fileName || null,
    },
  })

  return serializeMessage(message)
}

export async function sendConversationMessage(
  auth: AuthContext,
  id: string,
  input: { text?: unknown; docCategory?: unknown; file?: Express.Multer.File | null },
  meta: AuditMeta,
) {
  const conversation = await assertConversationAccess(auth, id)
  const text = asOptionalString(input.text, 4096)
  const docCategory = asOptionalString(input.docCategory, 80)

  if (!text && !input.file) {
    throw httpError.validation({ text: 'Please type a message or attach a file.' })
  }
  if (!replyWindow(conversation.lastInboundAt).open && !isMockMode()) {
    throw httpError.badRequest(
      'The 24-hour WhatsApp reply window has closed. Send a template message to restart the conversation.',
      'WHATSAPP_WINDOW_CLOSED',
    )
  }

  if (!input.file) {
    const message = await recordOutgoing({
      auth,
      conversation,
      type: 'TEXT',
      body: text,
      payloads: [{ kind: 'text', text: text! }],
      meta,
    })
    return { message, conversation: serializeConversation(await loadConversation(id)) }
  }

  const type = assertOutgoingAttachment(input.file)
  const stored = await storeWhatsAppAttachment({
    conversationId: id,
    buffer: input.file.buffer,
    mimeType: input.file.mimetype,
    fileName: input.file.originalname,
  })

  const payloads: OutgoingPayload[] = []
  if (type === 'IMAGE') payloads.push({ kind: 'image', link: stored.url, caption: text || undefined })
  else if (type === 'VIDEO') payloads.push({ kind: 'video', link: stored.url, caption: text || undefined })
  else if (type === 'VOICE') {
    if (text) payloads.push({ kind: 'text', text })
    payloads.push({ kind: 'audio', link: stored.url })
  } else {
    payloads.push({ kind: 'document', link: stored.url, fileName: stored.fileName, caption: text || undefined })
  }

  const message = await recordOutgoing({
    auth,
    conversation,
    type,
    body: text,
    payloads,
    attachment: stored,
    docCategory,
    meta,
  })
  return { message, conversation: serializeConversation(await loadConversation(id)) }
}

export async function sendConversationTemplate(
  auth: AuthContext,
  id: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  const conversation = await assertConversationAccess(auth, id)
  const name = asOptionalString(body.templateName, 120) || config.whatsapp.defaultTemplate
  const language = asOptionalString(body.language, 20) || config.whatsapp.defaultTemplateLanguage
  const message = await recordOutgoing({
    auth,
    conversation,
    type: 'TEMPLATE',
    body: `Template: ${name}`,
    payloads: [{ kind: 'template', name, language }],
    meta,
  })
  return { message, conversation: serializeConversation(await loadConversation(id)) }
}

/* ------------------------------------------------------------------ */
/* Assignment, status, conversion                                      */
/* ------------------------------------------------------------------ */

export async function assignConversation(
  auth: AuthContext,
  id: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  assertCanManage(auth)
  const conversation = await assertConversationAccess(auth, id)
  const userId = asString(body.userId)
  const reason = asOptionalString(body.reason, 400)
  if (!userId) throw httpError.validation({ userId: 'Please select an employee.' })

  if (conversation.lead) {
    // Rule-4: conversation access follows the Lead owner.
    if (conversation.lead.ownerId !== userId) {
      await assignLead(auth, conversation.lead.id, { ownerId: userId, reason: reason || 'WhatsApp conversation assigned' }, meta)
    }
  } else {
    const assignee = await prisma.user.findFirst({
      where: { id: userId, status: 'ACTIVE', AND: [assigneeVisibilityWhere(auth)] },
      select: { id: true },
    })
    if (!assignee) throw httpError.badRequest('The selected user cannot receive this conversation.')
  }

  await prisma.whatsAppConversation.update({
    where: { id },
    data: {
      assignedUserId: userId,
      status: conversation.status === 'NEW' ? 'ASSIGNED' : conversation.status,
    },
  })

  const updated = await loadConversation(id)
  const assigneeName = effectiveAssignee(updated)?.name || 'employee'

  if (updated.lead) {
    await createTimelineEntry({
      leadId: updated.lead.id,
      leadName: updated.lead.name,
      userId: auth.user.id,
      outcome: 'Conversation Assigned',
      notes: `WhatsApp conversation assigned to ${assigneeName}${reason ? ` — ${reason}` : ''}`,
      conversationId: id,
    })
  }

  await createNotification({
    userId,
    title: 'WhatsApp Conversation Assigned',
    body: `${serializeConversation(updated).displayName} is now assigned to you.`,
    link: `/whatsapp?c=${id}`,
    type: 'whatsapp_assigned',
    leadId: updated.leadId,
    dedupeKey: `wa-assign:${id}:${userId}:${Date.now()}`,
  }).catch(() => undefined)

  await writeAuditLog({
    userId: auth.user.id,
    action: 'WHATSAPP_CONVERSATION_ASSIGNED',
    entityType: 'whatsapp_conversation',
    entityId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { toUserId: userId, leadId: updated.leadId, reason },
  })

  return { conversation: serializeConversation(updated), message: 'Conversation assigned successfully.' }
}

const MANUAL_STATUSES: WhatsAppConversationStatus[] = ['IN_PROGRESS', 'WAITING_REPLY', 'RESOLVED', 'CLOSED']

export async function updateConversationStatus(
  auth: AuthContext,
  id: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  const conversation = await assertConversationAccess(auth, id)
  const status = asString(body.status).toUpperCase() as WhatsAppConversationStatus
  if (!MANUAL_STATUSES.includes(status)) {
    throw httpError.validation({ status: 'Please select a valid status.' })
  }
  if (status === conversation.status) {
    return { conversation: serializeConversation(conversation), message: 'Status unchanged.' }
  }

  await prisma.whatsAppConversation.update({
    where: { id },
    data: { status, ...(status === 'RESOLVED' || status === 'CLOSED' ? { unreadCount: 0 } : {}) },
  })

  if (conversation.lead && (status === 'RESOLVED' || status === 'CLOSED')) {
    await createTimelineEntry({
      leadId: conversation.lead.id,
      leadName: conversation.lead.name,
      userId: auth.user.id,
      outcome: status === 'CLOSED' ? 'Conversation Closed' : 'Conversation Resolved',
      notes: `WhatsApp conversation marked as ${status === 'CLOSED' ? 'closed' : 'resolved'}`,
      conversationId: id,
    })
  }

  await writeAuditLog({
    userId: auth.user.id,
    action: 'WHATSAPP_CONVERSATION_STATUS',
    entityType: 'whatsapp_conversation',
    entityId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { from: conversation.status, to: status, leadId: conversation.leadId },
  })

  return { conversation: serializeConversation(await loadConversation(id)), message: 'Conversation status updated.' }
}

export async function convertConversation(
  auth: AuthContext,
  id: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  assertCanManage(auth)
  const conversation = await assertConversationAccess(auth, id)
  if (conversation.leadId) throw httpError.conflict('This conversation is already linked to a lead.')

  const hadOutgoing = await prisma.whatsAppMessage.count({ where: { conversationId: id, direction: 'outgoing' } })
  let leadId = asString(body.leadId)
  let leadCreated = false

  if (leadId) {
    await assertCanViewLead(auth, leadId)
  } else {
    const fields: Record<string, string> = {}
    const name = titleCaseName(asString(body.name))
    const email = asOptionalString(body.email, 200)?.toLowerCase() || null
    if (!name) fields.name = 'Please enter the student name.'
    if (email && !isValidEmail(email)) fields.email = 'Please enter a valid email address.'
    if (Object.keys(fields).length) throw httpError.validation(fields)

    const firstInbound = await prisma.whatsAppMessage.findFirst({
      where: { conversationId: id, direction: 'incoming', body: { not: null } },
      orderBy: { sentAt: 'asc' },
      select: { body: true },
    })

    const result = await ingestCommunication({
      channel: 'WHATSAPP',
      senderName: name,
      senderPhone: displayPhone(conversation.waNumber),
      senderEmail: email || undefined,
      whatsapp: displayPhone(conversation.waNumber),
      whatsappSameAsPhone: true,
      preferredCountryCode: asOptionalString(body.preferredCountryCode, 40) || undefined,
      message: asOptionalString(body.notes, 2000) || firstInbound?.body || undefined,
      externalId: `wa-convert:${id}:${Date.now()}`,
      sourceCode: 'WHATSAPP',
    })
    if (!result.event.leadId) throw httpError.badRequest('Unable to create a lead from this conversation.')
    leadId = result.event.leadId
    leadCreated = result.event.leadCreated
  }

  const lead = await linkConversationToLead(id, leadId, hadOutgoing > 0)
  const messageCount = await prisma.whatsAppMessage.count({ where: { conversationId: id } })

  await createTimelineEntry({
    leadId: lead.id,
    leadName: lead.name,
    userId: auth.user.id,
    outcome: 'Conversation Started',
    notes: `WhatsApp conversation ${displayPhone(conversation.waNumber)} linked to lead (${messageCount} message${messageCount === 1 ? '' : 's'})`,
    conversationId: id,
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'WHATSAPP_CONVERSATION_CONVERTED',
    entityType: 'whatsapp_conversation',
    entityId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { leadId: lead.id, leadCreated },
  })

  return {
    conversation: serializeConversation(await loadConversation(id)),
    leadCreated,
    message: leadCreated ? 'Lead created from WhatsApp conversation.' : 'Conversation linked to the existing lead.',
  }
}

/* ------------------------------------------------------------------ */
/* Lead workspace                                                      */
/* ------------------------------------------------------------------ */

export async function getLeadConversations(auth: AuthContext, leadId: string) {
  assertCanViewWhatsApp(auth)
  await assertCanViewLead(auth, leadId)
  const rows = await prisma.whatsAppConversation.findMany({
    where: { leadId },
    include: conversationInclude,
    orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }],
  })
  return { items: rows.map(serializeConversation) }
}

export async function startLeadConversation(auth: AuthContext, leadId: string, meta: AuditMeta) {
  assertCanViewWhatsApp(auth)
  const lead = await assertCanViewLead(auth, leadId)
  const raw = lead.whatsapp || lead.phoneNormalized || lead.phone
  const waNumber = raw ? normalizePhone(raw) : ''
  if (!waNumber || waNumber.length < 8) {
    throw httpError.badRequest('This lead has no WhatsApp number.')
  }

  const existing = await prisma.whatsAppConversation.findUnique({ where: { waNumber } })
  if (existing?.leadId && existing.leadId !== lead.id) {
    throw httpError.conflict('This WhatsApp number is already linked to another lead.')
  }

  let conversationId = existing?.id
  if (!existing) {
    try {
      const created = await prisma.whatsAppConversation.create({
        data: {
          waNumber,
          contactName: lead.name,
          leadId: lead.id,
          assignedUserId: lead.ownerId,
          status: lead.ownerId ? 'ASSIGNED' : 'NEW',
        },
      })
      conversationId = created.id
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      conversationId = (await prisma.whatsAppConversation.findUniqueOrThrow({ where: { waNumber } })).id
    }
    await createTimelineEntry({
      leadId: lead.id,
      leadName: lead.name,
      userId: auth.user.id,
      outcome: 'Conversation Started',
      notes: `WhatsApp conversation started with ${displayPhone(waNumber)}`,
      conversationId: conversationId!,
    })
  } else if (!existing.leadId) {
    await linkConversationToLead(existing.id, lead.id, existing.lastDirection === 'outgoing')
  }

  const result = await sendConversationTemplate(auth, conversationId!, {}, meta)
  return { ...result, message: 'WhatsApp conversation started.' }
}
