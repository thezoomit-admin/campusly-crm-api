import { config } from '../../config'
import { writeAuditLog } from '../../lib/audit'
import { HttpError, httpError } from '../../lib/http-error'
import { prisma } from '../../lib/prisma'
import type { EmailThreadStatus, Prisma } from '../../lib/prisma-client'
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
import { createLeadDocumentFromEmailAttachment } from '../leads/leads.documents'
import { assignLead } from '../leads/leads.service'
import { createNotification } from '../notifications/notifications.service'
import { emitEmailInbound } from '../../realtime/socket'
import {
  EmailProviderError,
  isEmailConfigured,
  isEmailMockMode,
  isImapInboundConfigured,
  mailboxAddress,
  sendMailboxEmail,
} from './email.client'
import {
  ATTACHMENT_UPLOAD_ERROR,
  EMAIL_DOC_CATEGORIES,
  assertEmailAttachment,
  storeEmailAttachment,
} from './email.storage'

export const EMAIL_MESSAGES = {
  sendFailed: 'Unable to send email. Please try again.',
  attachmentFailed: 'Unable to upload attachment.',
  unavailable: 'Email conversation not found.',
  denied: 'You do not have permission to access this email.',
} as const

const LINK_CLAIM_MS = 60 * 1000

const STATUSES: EmailThreadStatus[] = ['NEW', 'ASSIGNED', 'PROCESSING', 'REPLIED', 'WAITING_REPLY', 'CLOSED']
const MANUAL_STATUSES: EmailThreadStatus[] = ['PROCESSING', 'WAITING_REPLY', 'CLOSED']

const DEFAULT_TEMPLATES: Array<{ code: string; name: string; subject: string; body: string; sortOrder: number }> = [
  {
    code: 'INITIAL_RESPONSE',
    name: 'Initial Response',
    subject: 'Thank you for your study enquiry',
    body: 'Dear {{studentName}},\n\nThank you for contacting us. We have received your enquiry and a counsellor will review it shortly.\n\nPlease reply to this email if you would like to share your preferred country, intake, or academic background.\n\nRegards,\n{{employeeName}}',
    sortOrder: 1,
  },
  {
    code: 'CONSULTATION_CONFIRMATION',
    name: 'Consultation Confirmation',
    subject: 'Your consultation is confirmed',
    body: 'Dear {{studentName}},\n\nThis is to confirm your consultation with our counselling team. Please reply if you need to change the time.\n\nRegards,\n{{employeeName}}',
    sortOrder: 2,
  },
  {
    code: 'DOCUMENT_REQUEST',
    name: 'Document Request',
    subject: 'Documents required for your application',
    body: 'Dear {{studentName}},\n\nPlease send the following documents so we can continue your application:\n\n- Passport\n- Academic certificate and transcript\n- IELTS or other English test result\n\nYou can reply to this email with the files attached.\n\nRegards,\n{{employeeName}}',
    sortOrder: 3,
  },
  {
    code: 'FOLLOW_UP_REMINDER',
    name: 'Follow-up Reminder',
    subject: 'Following up on your study enquiry',
    body: 'Dear {{studentName}},\n\nI am following up on your enquiry. Please let us know if you are still interested and if there is anything we should prepare before the next discussion.\n\nRegards,\n{{employeeName}}',
    sortOrder: 4,
  },
  {
    code: 'ADMISSION_UPDATE',
    name: 'Admission Update',
    subject: 'Update on your admission',
    body: 'Dear {{studentName}},\n\nHere is an update on your admission process. Please review the details below and reply if you have any questions.\n\nRegards,\n{{employeeName}}',
    sortOrder: 5,
  },
]

type AuditMeta = { ipAddress?: string; userAgent?: string }

export type InboundAttachment = {
  fileName?: string | null
  mimeType?: string | null
  contentBase64?: string | null
  url?: string | null
}

export type InboundEmailInput = {
  messageId?: string | null
  fromEmail: string
  fromName?: string | null
  toEmail?: string | null
  subject?: string | null
  text?: string | null
  html?: string | null
  inReplyTo?: string | null
  references?: string | null
  phone?: string | null
  eventAt?: Date | null
  attachments?: InboundAttachment[]
  /**
   * IMAP sync: only continue CRM conversations (we emailed this address first).
   * Skips cold/newsletter mail and only notifies on student replies.
   */
  conversationOnly?: boolean
}

const threadInclude = {
  lead: {
    select: {
      id: true,
      code: true,
      name: true,
      phone: true,
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

type ThreadRow = Prisma.EmailThreadGetPayload<{ include: typeof threadInclude }>

const messageInclude = {
  sentBy: { select: { id: true, fullName: true } },
  attachments: { orderBy: { createdAt: 'asc' as const } },
} as const

type MessageRow = Prisma.EmailMessageGetPayload<{ include: typeof messageInclude }>

function isUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

function htmlToText(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function textToHtml(text: string) {
  return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`
}

function cleanSubject(subject: string) {
  const stripped = subject.replace(/^(\s*(re|fw|fwd)\s*:\s*)+/i, '').trim()
  return stripped || subject.trim()
}

function displayNameFromEmail(email: string, name?: string | null) {
  const cleaned = (name || '').trim()
  if (cleaned && !cleaned.includes('@')) return titleCaseName(cleaned)
  const local = email.split('@')[0] || email
  return titleCaseName(local.replace(/[._-]+/g, ' '))
}

function parseAddress(value: string) {
  const match = value.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/)
  if (match) {
    return { name: match[1].trim() || null, email: match[2].trim().toLowerCase() }
  }
  return { name: null as string | null, email: value.trim().toLowerCase() }
}

function extractPhone(text: string | null | undefined) {
  if (!text) return null
  const match = text.match(/(?:\+|00)?\d[\d\s().-]{7,18}\d/)
  if (!match) return null
  const normalized = normalizePhone(match[0])
  return normalized.length >= 8 ? normalized : null
}

export function normalizeInboundBody(body: Record<string, unknown>): InboundEmailInput {
  const fromObj = body.from && typeof body.from === 'object' ? (body.from as Record<string, unknown>) : null
  const rawFrom =
    asString(fromObj?.email) ||
    asString(body.fromEmail) ||
    asString(body.senderEmail) ||
    asString(body.email) ||
    asString(body.from)
  const parsed = rawFrom ? parseAddress(rawFrom) : { name: null, email: '' }
  const fromName =
    asOptionalString(fromObj?.name, 120) ||
    asOptionalString(body.fromName, 120) ||
    asOptionalString(body.senderName, 120) ||
    asOptionalString(body.name, 120) ||
    parsed.name

  const rawAttachments = Array.isArray(body.attachments) ? body.attachments : []
  const attachments: InboundAttachment[] = rawAttachments
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .slice(0, 5)
    .map((item) => ({
      fileName: asOptionalString(item.fileName || item.filename || item.name, 180),
      mimeType: asOptionalString(item.mimeType || item.contentType || item.mime, 120),
      contentBase64: asOptionalString(item.contentBase64 || item.content, 14_000_000),
      url: asOptionalString(item.url, 2000),
    }))

  const eventRaw = asString(body.date) || asString(body.eventAt) || asString(body.receivedAt)
  const eventAt = eventRaw ? new Date(eventRaw) : null

  return {
    messageId: asOptionalString(body.messageId || body.externalId || body.providerMessageId, 500),
    fromEmail: parsed.email,
    fromName,
    toEmail: asOptionalString(body.toEmail || body.to, 200)?.toLowerCase() || null,
    subject: asOptionalString(body.subject, 300),
    text: asOptionalString(body.text || body.message || body.body || body.content, 20000),
    html: asOptionalString(body.html, 50000),
    inReplyTo: asOptionalString(body.inReplyTo || body.in_reply_to, 500),
    references: asOptionalString(body.references, 4000),
    phone: asOptionalString(body.phone || body.senderPhone, 40),
    eventAt: eventAt && !Number.isNaN(eventAt.getTime()) ? eventAt : null,
    attachments,
  }
}

function effectiveAssignee(row: ThreadRow) {
  if (row.lead) {
    return row.lead.ownerId ? { id: row.lead.ownerId, name: row.lead.ownerName || 'Assigned user' } : null
  }
  return row.assignedUser ? { id: row.assignedUser.id, name: row.assignedUser.fullName } : null
}

function serializeThread(row: ThreadRow) {
  return {
    id: row.id,
    participantEmail: row.participantEmail,
    contactName: row.contactName,
    displayName: row.lead?.name || row.contactName || row.participantEmail,
    subject: row.subject,
    status: row.status,
    unreadCount: row.unreadCount,
    lastMessageAt: row.lastMessageAt ? row.lastMessageAt.toISOString() : null,
    lastMessagePreview: row.lastMessagePreview,
    lastDirection: row.lastDirection,
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
    threadId: row.threadId,
    direction: row.direction as 'incoming' | 'outgoing',
    subject: row.subject,
    body: row.bodyText,
    fromEmail: row.fromEmail,
    fromName: row.fromName,
    toEmail: row.toEmail,
    deliveryStatus: row.deliveryStatus,
    errorMessage: row.errorMessage,
    templateCode: row.templateCode,
    sentAt: row.sentAt.toISOString(),
    sentBy: row.sentBy ? { id: row.sentBy.id, name: row.sentBy.fullName } : null,
    attachments: row.attachments.map((file) => ({
      id: file.id,
      url: file.url,
      mimeType: file.mimeType,
      fileName: file.fileName,
      size: file.fileSize,
      docCategory: file.docCategory,
    })),
  }
}

export function canManageEmail(auth: AuthContext) {
  return hasPermission(auth.permissions, ['lead:assign', 'communication:reprocess'])
}

function assertCanViewEmail(auth: AuthContext) {
  if (!hasPermission(auth.permissions, 'communication:view')) {
    throw httpError.accessDenied(EMAIL_MESSAGES.denied)
  }
}

function assertCanManage(auth: AuthContext) {
  if (!canManageEmail(auth)) throw httpError.accessDenied(EMAIL_MESSAGES.denied)
}

function threadAccessWhere(auth: AuthContext): Prisma.EmailThreadWhereInput {
  const leadScope = leadReadableWhere(auth)
  const linked: Prisma.EmailThreadWhereInput =
    Object.keys(leadScope).length === 0 ? { leadId: { not: null } } : { lead: { is: leadScope } }
  const unlinked: Prisma.EmailThreadWhereInput = canManageEmail(auth)
    ? { leadId: null }
    : { leadId: null, assignedUserId: auth.user.id }
  return { OR: [linked, unlinked] }
}

async function assertThreadAccess(auth: AuthContext, id: string) {
  assertCanViewEmail(auth)
  const row = await prisma.emailThread.findFirst({
    where: { id, AND: [threadAccessWhere(auth)] },
    include: threadInclude,
  })
  if (row) return row
  const exists = await prisma.emailThread.findUnique({ where: { id }, select: { id: true } })
  if (exists) throw httpError.accessDenied(EMAIL_MESSAGES.denied)
  throw httpError.notFound(EMAIL_MESSAGES.unavailable)
}

async function loadThread(id: string) {
  return prisma.emailThread.findUniqueOrThrow({ where: { id }, include: threadInclude })
}

async function createTimelineEntry(input: {
  leadId: string
  leadName: string
  userId: string
  outcome: string
  notes: string
  threadId: string
  messageId?: string
  occurredAt?: Date
}) {
  await prisma.activity.create({
    data: {
      type: 'EMAIL',
      userId: input.userId,
      relatedName: input.leadName,
      relatedType: 'lead',
      relatedId: input.leadId,
      outcome: input.outcome,
      notes: input.notes.slice(0, 4000),
      occurredAt: input.occurredAt || new Date(),
      metadata: {
        source: 'email',
        channel: 'EMAIL',
        threadId: input.threadId,
        messageId: input.messageId,
      } as Prisma.InputJsonValue,
    },
  })
}

async function notifyRecipients(input: {
  assigneeId: string | null
  title: string
  body: string
  type: string
  threadId: string
  leadId?: string | null
  dedupe: string
}) {
  const recipients = input.assigneeId ? [input.assigneeId] : (await findManagers()).map((manager) => manager.id)
  for (const userId of recipients) {
    await createNotification({
      userId,
      title: input.title,
      body: input.body,
      link: `/email?c=${input.threadId}`,
      type: input.type,
      leadId: input.leadId || null,
      dedupeKey: `email:${input.dedupe}:${userId}`,
    }).catch((error) => console.error('[email] notification failed:', error))
  }
}

async function matchLead(input: { email: string; phone?: string | null }) {
  const byEmail = await prisma.lead.findFirst({
    where: { email: { equals: input.email, mode: 'insensitive' } },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  if (byEmail) return byEmail.id

  if (input.phone && input.phone.length >= 8) {
    const suffix = input.phone.slice(-10)
    const byPhone = await prisma.lead.findFirst({
      where: {
        OR: [
          { phoneNormalized: input.phone },
          { phoneNormalized: { endsWith: suffix } },
          { phone: { contains: suffix } },
          { whatsapp: { contains: suffix } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })
    if (byPhone) return byPhone.id
  }
  return null
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

async function claimForLinking(threadId: string) {
  const claimed = await prisma.emailThread.updateMany({
    where: {
      id: threadId,
      leadId: null,
      OR: [{ linkingAt: null }, { linkingAt: { lt: new Date(Date.now() - LINK_CLAIM_MS) } }],
    },
    data: { linkingAt: new Date() },
  })
  return claimed.count === 1
}

async function linkThreadToLead(threadId: string, leadId: string, hadOutgoing: boolean) {
  const lead = await prisma.lead.findUniqueOrThrow({
    where: { id: leadId },
    select: { id: true, name: true, ownerId: true },
  })
  const status: EmailThreadStatus = lead.ownerId ? (hadOutgoing ? 'PROCESSING' : 'ASSIGNED') : 'NEW'
  await prisma.emailThread.update({
    where: { id: threadId },
    data: { leadId: lead.id, assignedUserId: lead.ownerId, linkingAt: null, status },
  })
  return lead
}

async function getOrCreateThread(email: string, contactName: string | null, subject: string | null) {
  const existing = await prisma.emailThread.findUnique({ where: { participantEmail: email } })
  if (existing) return { thread: existing, created: false }
  try {
    const thread = await prisma.emailThread.create({
      data: {
        participantEmail: email,
        contactName,
        subject: subject ? cleanSubject(subject) : null,
        status: 'NEW',
      },
    })
    return { thread, created: true }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const thread = await prisma.emailThread.findUniqueOrThrow({ where: { participantEmail: email } })
    return { thread, created: false }
  }
}

async function storeInboundFiles(threadId: string, files: InboundAttachment[]) {
  const stored: Array<{
    url: string
    mimeType: string
    fileName: string
    fileSize: number | null
    buffer?: Buffer
  }> = []
  let failed = false
  for (const file of files) {
    try {
      if (file.url) {
        stored.push({
          url: file.url,
          mimeType: file.mimeType || 'application/octet-stream',
          fileName: file.fileName || 'attachment',
          fileSize: null,
        })
        continue
      }
      if (!file.contentBase64) continue
      const buffer = Buffer.from(file.contentBase64, 'base64')
      const mime = file.mimeType || 'application/octet-stream'
      assertEmailAttachment({ mimetype: mime, size: buffer.length })
      const saved = await storeEmailAttachment({
        threadId,
        buffer,
        mimeType: mime,
        fileName: file.fileName,
      })
      stored.push({ ...saved, buffer })
    } catch (error) {
      failed = true
      console.error('[email] inbound attachment failed:', error)
    }
  }
  return { stored, failed }
}

async function recordCrmEmailCommunication(input: {
  leadId: string
  direction: 'incoming' | 'outgoing'
  subject: string
  message: string | null
  senderName: string | null
  senderEmail: string
  externalId: string
  eventAt?: Date
  formName?: string
}) {
  try {
    const existing = await prisma.communicationEvent.findUnique({
      where: { channel_externalId: { channel: 'EMAIL', externalId: input.externalId } },
      select: { id: true },
    })
    if (existing) {
      await prisma.emailMessage
        .updateMany({
          where: { id: input.externalId.replace(/^crm-email:/, ''), communicationEventId: null },
          data: { communicationEventId: existing.id },
        })
        .catch(() => undefined)
      return existing.id
    }

    const event = await prisma.communicationEvent.create({
      data: {
        channel: 'EMAIL',
        eventAt: input.eventAt || new Date(),
        senderName: input.senderName,
        senderEmail: input.senderEmail.toLowerCase(),
        subject: input.subject.slice(0, 300),
        message: (input.message || '').slice(0, 5000) || null,
        sourceCode: 'EMAIL_CRM',
        channelCode: 'EMAIL',
        direction: input.direction,
        externalId: input.externalId,
        formName: input.formName || 'CRM Email',
        processingStatus: 'PROCESSED',
        processedAt: new Date(),
        leadId: input.leadId,
        leadCreated: false,
      },
    })

    const messageId = input.externalId.startsWith('crm-email:')
      ? input.externalId.slice('crm-email:'.length)
      : null
    if (messageId) {
      await prisma.emailMessage
        .updateMany({
          where: { id: messageId, communicationEventId: null },
          data: { communicationEventId: event.id },
        })
        .catch(() => undefined)
    }
    return event.id
  } catch (error) {
    console.error('[email] recordCrmEmailCommunication failed:', error)
    return null
  }
}

async function copyAttachmentsToLeadDocuments(input: {
  leadId: string
  leadName: string
  messageId: string
  uploadedById: string
  files: Array<{
    buffer?: Buffer
    mimeType: string
    fileName: string
    category?: string | null
  }>
}) {
  let created = 0
  for (const file of input.files) {
    if (!file.buffer?.length) continue
    const result = await createLeadDocumentFromEmailAttachment({
      leadId: input.leadId,
      leadName: input.leadName,
      buffer: file.buffer,
      mimeType: file.mimeType,
      fileName: file.fileName,
      messageId: input.messageId,
      category: file.category,
      uploadedById: input.uploadedById,
    })
    if (result.created) created += 1
  }
  return created
}

/** Marks a previously sent CRM email as bounced (DSN / mailer-daemon). */
export async function markOutboundBounced(input: {
  providerMessageIds: string[]
  errorMessage?: string
  eventAt?: Date
}) {
  const ids = [...new Set(input.providerMessageIds.map((id) => id.trim()).filter(Boolean))]
  if (!ids.length) return { matched: false as const }

  const message = await prisma.emailMessage.findFirst({
    where: {
      direction: 'outgoing',
      providerMessageId: { in: ids },
      NOT: { deliveryStatus: 'bounced' },
    },
    include: {
      thread: {
        select: {
          id: true,
          assignedUserId: true,
          leadId: true,
          lead: { select: { id: true, name: true, code: true, ownerId: true } },
        },
      },
    },
    orderBy: { sentAt: 'desc' },
  })
  if (!message) return { matched: false as const }

  const errorMessage = (input.errorMessage || 'Delivery failed — bounce received from mail server.').slice(0, 500)
  await prisma.emailMessage.update({
    where: { id: message.id },
    data: { deliveryStatus: 'bounced', errorMessage },
  })

  const lead = message.thread.lead
  const assigneeId = lead?.ownerId || message.thread.assignedUserId
  if (lead) {
    const actorId = await resolveSystemActorId(lead.ownerId)
    await createTimelineEntry({
      leadId: lead.id,
      leadName: lead.name,
      userId: actorId,
      outcome: 'Email Bounced',
      notes: `${message.subject}\n${errorMessage}`.trim(),
      threadId: message.threadId,
      messageId: message.id,
      occurredAt: input.eventAt,
    })
  }

  await notifyRecipients({
    assigneeId,
    title: 'Email bounced',
    body: lead
      ? `${lead.code} — ${lead.name}: ${message.subject}`
      : `Bounce for: ${message.subject}`,
    type: 'email_bounced',
    threadId: message.threadId,
    leadId: lead?.id || null,
    dedupe: `bounce:${message.id}`,
  })

  emitEmailInbound({
    threadId: message.threadId,
    messageId: message.id,
    leadId: lead?.id || null,
    fromEmail: message.toEmail,
    preview: errorMessage,
  })

  return { matched: true as const, messageId: message.id, threadId: message.threadId, leadId: lead?.id || null }
}

function nextInboundStatus(assigneeId: string | null, hadOutgoing: boolean): EmailThreadStatus {
  if (!assigneeId) return 'NEW'
  return hadOutgoing ? 'PROCESSING' : 'ASSIGNED'
}

async function resolveLeadForInbound(input: {
  threadId: string
  fromEmail: string
  fromName: string | null
  text: string | null
  phone: string | null
  messageId: string
  providerMessageId: string
  eventAt: Date
  subject: string
}) {
  if (!(await claimForLinking(input.threadId))) return { leadId: null as string | null, viaHub: false }

  try {
    const matchedLeadId = await matchLead({ email: input.fromEmail, phone: input.phone })
    const shouldCreate = !matchedLeadId && config.email.autoCreateLead
    if (!matchedLeadId && !shouldCreate) return { leadId: null, viaHub: false }

    const result = await ingestCommunication({
      channel: 'EMAIL',
      leadId: matchedLeadId || undefined,
      senderName: input.fromName || displayNameFromEmail(input.fromEmail),
      senderEmail: input.fromEmail,
      senderPhone: matchedLeadId && input.phone ? input.phone : undefined,
      preferredCountryCode: shouldCreate ? await detectCountryCode(input.text) : undefined,
      subject: input.subject,
      message: input.text || undefined,
      externalId: input.providerMessageId,
      eventAt: input.eventAt,
      sourceCode: 'EMAIL',
    })

    const leadId = result.event.leadId || matchedLeadId
    if (!leadId) return { leadId: null, viaHub: false }

    await prisma.emailMessage.update({
      where: { id: input.messageId },
      data: { communicationEventId: result.event.id },
    })
    return { leadId, viaHub: true }
  } catch (error) {
    console.error('[email] lead resolution failed:', error)
    const fallback = await matchLead({ email: input.fromEmail, phone: input.phone }).catch(() => null)
    return { leadId: fallback, viaHub: false }
  } finally {
    await prisma.emailThread
      .updateMany({ where: { id: input.threadId, leadId: null }, data: { linkingAt: null } })
      .catch(() => undefined)
  }
}

export async function receiveInboundEmail(input: InboundEmailInput) {
  const fromEmail = input.fromEmail.trim().toLowerCase()
  if (!fromEmail || !isValidEmail(fromEmail)) {
    throw httpError.badRequest('Unable to identify the sender information.')
  }
  if (fromEmail === mailboxAddress()) {
    return { skipped: true as const, duplicate: false, threadId: null, messageId: null, leadId: null }
  }

  const providerMessageId = input.messageId?.trim() || null

  async function threadHasOutbound(threadId: string) {
    const count = await prisma.emailMessage.count({
      where: { threadId, direction: 'outgoing' },
    })
    return count > 0
  }

  async function isCrmConversationReply() {
    const emailedByUs = await prisma.emailMessage.findFirst({
      where: { direction: 'outgoing', toEmail: { equals: fromEmail, mode: 'insensitive' } },
      select: { id: true },
    })
    if (emailedByUs) return true

    const refIds = [input.inReplyTo, ...(input.references || '').split(/\s+/)]
      .map((value) => (value || '').trim())
      .filter(Boolean)
    if (!refIds.length) return false

    const related = await prisma.emailMessage.findFirst({
      where: { direction: 'outgoing', providerMessageId: { in: refIds } },
      select: { id: true },
    })
    return Boolean(related)
  }

  if (input.conversationOnly && !(await isCrmConversationReply())) {
    return { skipped: true as const, duplicate: false, threadId: null, messageId: null, leadId: null }
  }

  if (providerMessageId) {
    const duplicate = await prisma.emailMessage.findUnique({
      where: { providerMessageId },
      include: { thread: { select: { id: true, leadId: true, participantEmail: true } } },
    })
    if (duplicate) {
      const isConversation = await threadHasOutbound(duplicate.threadId)
      if (input.conversationOnly && !isConversation) {
        return {
          skipped: true as const,
          duplicate: true,
          threadId: duplicate.threadId,
          messageId: duplicate.id,
          leadId: duplicate.thread.leadId,
        }
      }

      let leadId = duplicate.thread.leadId
      if (!leadId && isConversation) {
        const matched = await matchLead({ email: duplicate.thread.participantEmail }).catch(() => null)
        if (matched) {
          await linkThreadToLead(duplicate.threadId, matched, true).catch(() => undefined)
          leadId = matched
        }
      }
      // Do not emit socket on duplicates — IMAP re-scans would refetch the UI in a loop.
      return {
        skipped: true as const,
        duplicate: true,
        threadId: duplicate.threadId,
        messageId: duplicate.id,
        leadId,
      }
    }
  }

  const text = (input.text || (input.html ? htmlToText(input.html) : '')).trim()
  const subject = (input.subject || '(no subject)').trim().slice(0, 300)
  const contactName = displayNameFromEmail(fromEmail, input.fromName)
  const eventAt = input.eventAt || new Date()
  const phone = input.phone ? normalizePhone(input.phone) : extractPhone(text)
  const { thread, created } = await getOrCreateThread(fromEmail, contactName, subject)
  const hadOutgoing = (await threadHasOutbound(thread.id)) || thread.lastDirection === 'outgoing'

  if (input.conversationOnly && !hadOutgoing) {
    return { skipped: true as const, duplicate: false, threadId: thread.id, messageId: null, leadId: thread.leadId }
  }

  const files = await storeInboundFiles(thread.id, input.attachments || [])

  let message
  try {
    message = await prisma.emailMessage.create({
      data: {
        threadId: thread.id,
        direction: 'incoming',
        subject,
        bodyText: text || null,
        fromEmail,
        fromName: contactName,
        toEmail: input.toEmail || mailboxAddress(),
        providerMessageId,
        inReplyTo: input.inReplyTo || null,
        referencesHeader: input.references || null,
        deliveryStatus: 'received',
        errorMessage: files.failed ? EMAIL_MESSAGES.attachmentFailed : null,
        sentAt: eventAt,
        attachments: {
          create: files.stored.map((file) => ({
            fileName: file.fileName,
            mimeType: file.mimeType,
            url: file.url,
            fileSize: file.fileSize,
          })),
        },
      },
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { skipped: true as const, duplicate: true, threadId: thread.id, messageId: null, leadId: null }
    }
    throw error
  }

  let leadId = thread.leadId
  let viaHub = false
  // IMAP conversation sync: never auto-create leads from random mailbox mail.
  if (!leadId && !input.conversationOnly) {
    const resolved = await resolveLeadForInbound({
      threadId: thread.id,
      fromEmail,
      fromName: contactName,
      text: text || null,
      phone,
      messageId: message.id,
      providerMessageId: providerMessageId || `email:${message.id}`,
      eventAt,
      subject,
    })
    if (resolved.leadId) {
      await linkThreadToLead(thread.id, resolved.leadId, hadOutgoing)
      leadId = resolved.leadId
      viaHub = resolved.viaHub
    }
  } else if (!leadId && input.conversationOnly) {
    const matched = await matchLead({ email: fromEmail, phone }).catch(() => null)
    if (matched) {
      await linkThreadToLead(thread.id, matched, hadOutgoing).catch(() => undefined)
      leadId = matched
    }
  }

  const lead = leadId
    ? await prisma.lead.findUnique({
        where: { id: leadId },
        select: { id: true, name: true, code: true, ownerId: true },
      })
    : null
  const assigneeId = lead ? lead.ownerId : thread.assignedUserId
  const preview = (text || subject).slice(0, 180)

  await prisma.emailThread.update({
    where: { id: thread.id },
    data: {
      unreadCount: { increment: 1 },
      lastMessageAt: eventAt,
      lastMessagePreview: preview,
      lastDirection: 'incoming',
      lastInboundMessageId: providerMessageId || message.id,
      status: nextInboundStatus(assigneeId, hadOutgoing),
      ...(thread.subject ? {} : { subject: cleanSubject(subject) }),
      ...(contactName && !thread.contactName ? { contactName } : {}),
      ...(lead ? { assignedUserId: lead.ownerId } : {}),
    },
  })

  if (lead) {
    const actorId = await resolveSystemActorId(lead.ownerId)
    await prisma.lead.update({ where: { id: lead.id }, data: { lastEnquiryAt: eventAt } }).catch(() => undefined)
    if (!viaHub) {
      await createTimelineEntry({
        leadId: lead.id,
        leadName: lead.name,
        userId: actorId,
        outcome: 'Email Received',
        notes: `${subject}\n${text}`.trim(),
        threadId: thread.id,
        messageId: message.id,
        occurredAt: eventAt,
      })
      await recordCrmEmailCommunication({
        leadId: lead.id,
        direction: 'incoming',
        subject,
        message: text || null,
        senderName: contactName,
        senderEmail: fromEmail,
        externalId: `crm-email:${message.id}`,
        eventAt,
        formName: 'Student reply',
      })
    }
    if (files.stored.length) {
      await createTimelineEntry({
        leadId: lead.id,
        leadName: lead.name,
        userId: actorId,
        outcome: 'Attachment Received',
        notes: files.stored.map((file) => file.fileName).join(', '),
        threadId: thread.id,
        messageId: message.id,
        occurredAt: eventAt,
      })
      await copyAttachmentsToLeadDocuments({
        leadId: lead.id,
        leadName: lead.name,
        messageId: message.id,
        uploadedById: actorId,
        files: files.stored.map((file) => ({
          buffer: file.buffer,
          mimeType: file.mimeType,
          fileName: file.fileName,
        })),
      })
    }
  }

  if (!viaHub) {
    const who = lead ? `${lead.code} — ${lead.name}` : contactName
    const base = { threadId: thread.id, leadId: lead?.id, assigneeId, dedupe: message.id }

    if (input.conversationOnly) {
      // Only notify for replies in conversations we started from the CRM.
      if (hadOutgoing) {
        await notifyRecipients({
          ...base,
          title: files.stored.length ? 'Attachment received' : 'Student replied to email',
          body: files.stored.length
            ? `${who} sent ${files.stored.map((file) => file.fileName).join(', ')}`
            : `${who}: ${preview}`,
          type: files.stored.length ? 'email_attachment' : 'email_student_reply',
        })
      }
    } else if (!lead && created) {
      await notifyRecipients({
        ...base,
        title: 'New Incoming Email',
        body: `Unidentified email from ${fromEmail} needs review. ${subject}`,
        type: 'new_email',
      })
    } else if (!assigneeId) {
      await notifyRecipients({
        ...base,
        title: 'New Incoming Email',
        body: `${who}: ${preview}`,
        type: 'email_pending_response',
      })
    } else if (files.stored.length) {
      await notifyRecipients({
        ...base,
        title: 'Attachment received',
        body: `${who} sent ${files.stored.map((file) => file.fileName).join(', ')}`,
        type: 'email_attachment',
      })
    } else if (hadOutgoing) {
      await notifyRecipients({
        ...base,
        title: 'Student replied to email',
        body: `${who}: ${preview}`,
        type: 'email_student_reply',
      })
    } else {
      await notifyRecipients({
        ...base,
        title: 'New Incoming Email',
        body: `Pending email response for ${who}: ${preview}`,
        type: 'email_pending_response',
      })
    }
  }

  emitEmailInbound({
    threadId: thread.id,
    messageId: message.id,
    leadId: leadId || null,
    fromEmail,
    preview,
  })

  return {
    skipped: false as const,
    duplicate: false,
    created,
    threadId: thread.id,
    messageId: message.id,
    leadId,
  }
}

export async function ensureEmailTemplates() {
  for (const template of DEFAULT_TEMPLATES) {
    await prisma.emailTemplate.upsert({
      where: { code: template.code },
      update: {},
      create: template,
    })
  }
}

export function getEmailSettings(auth: AuthContext) {
  assertCanViewEmail(auth)
  return {
    configured: isEmailConfigured(),
    mockMode: isEmailMockMode(),
    autoCreateLead: config.email.autoCreateLead,
    fromAddress: mailboxAddress(),
    canManage: canManageEmail(auth),
    inbound: {
      imap: isImapInboundConfigured(),
      imapHost: isImapInboundConfigured() ? config.email.imap.host : null,
      pollSeconds: config.email.imap.pollSeconds,
      webhook: Boolean(config.email.webhookSecret) || !config.isProduction,
    },
  }
}

export async function listTemplates(auth: AuthContext) {
  assertCanViewEmail(auth)
  await ensureEmailTemplates()
  const items = await prisma.emailTemplate.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
  })
  return {
    items: items.map((item) => ({
      id: item.id,
      code: item.code,
      name: item.name,
      subject: item.subject,
      body: item.body,
    })),
  }
}

export async function listThreads(
  auth: AuthContext,
  query: { search?: string; status?: string; assigned?: string; page?: number; limit?: number },
) {
  assertCanViewEmail(auth)
  const page = Math.max(1, query.page || 1)
  const limit = Math.min(100, Math.max(10, query.limit || 30))
  const access = threadAccessWhere(auth)
  const status = query.status?.toUpperCase() as EmailThreadStatus | undefined
  const search = query.search?.trim()

  let assignedFilter: Prisma.EmailThreadWhereInput = {}
  if (query.assigned === 'me') {
    assignedFilter = {
      OR: [{ lead: { is: { ownerId: auth.user.id } } }, { leadId: null, assignedUserId: auth.user.id }],
    }
  } else if (query.assigned === 'unassigned') {
    assignedFilter = { OR: [{ lead: { is: { ownerId: null } } }, { leadId: null, assignedUserId: null }] }
  } else if (query.assigned === 'unidentified') {
    assignedFilter = { leadId: null }
  }

  // Default inbox: only CRM conversations (we emailed) or linked leads — not random Gmail noise.
  // "Manual review" (unidentified) still lists lead-less threads for webhook convert.
  const conversationScope: Prisma.EmailThreadWhereInput =
    query.assigned === 'unidentified'
      ? {}
      : {
          OR: [{ messages: { some: { direction: 'outgoing' } } }, { leadId: { not: null } }],
        }

  const where: Prisma.EmailThreadWhereInput = {
    AND: [
      access,
      conversationScope,
      status && STATUSES.includes(status) ? { status } : {},
      assignedFilter,
      search
        ? {
            OR: [
              { participantEmail: { contains: search, mode: 'insensitive' } },
              { contactName: { contains: search, mode: 'insensitive' } },
              { subject: { contains: search, mode: 'insensitive' } },
              { lastMessagePreview: { contains: search, mode: 'insensitive' } },
              { lead: { is: { name: { contains: search, mode: 'insensitive' } } } },
              { lead: { is: { code: { contains: search, mode: 'insensitive' } } } },
            ],
          }
        : {},
    ],
  }

  const [total, rows, grouped, unread] = await Promise.all([
    prisma.emailThread.count({ where }),
    prisma.emailThread.findMany({
      where,
      include: threadInclude,
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.emailThread.groupBy({ by: ['status'], where: access, _count: { _all: true } }),
    prisma.emailThread.aggregate({ where: access, _sum: { unreadCount: true } }),
  ])

  const byStatus = Object.fromEntries(STATUSES.map((item) => [item, 0])) as Record<EmailThreadStatus, number>
  for (const row of grouped) byStatus[row.status] = row._count._all

  return {
    items: rows.map(serializeThread),
    total,
    page,
    limit,
    summary: { byStatus, unread: unread._sum.unreadCount || 0 },
  }
}

export async function getThread(auth: AuthContext, id: string) {
  const row = await assertThreadAccess(auth, id)
  return { thread: serializeThread(row) }
}

export async function listMessages(auth: AuthContext, id: string, query: { before?: string; limit?: number }) {
  await assertThreadAccess(auth, id)
  const limit = Math.min(200, Math.max(20, query.limit || 100))
  const before = query.before ? new Date(query.before) : null
  const rows = await prisma.emailMessage.findMany({
    where: {
      threadId: id,
      ...(before && !Number.isNaN(before.getTime()) ? { sentAt: { lt: before } } : {}),
    },
    include: messageInclude,
    orderBy: { sentAt: 'desc' },
    take: limit + 1,
  })
  const hasMore = rows.length > limit
  return { items: rows.slice(0, limit).reverse().map(serializeMessage), hasMore }
}

export async function markThreadRead(auth: AuthContext, id: string) {
  await assertThreadAccess(auth, id)
  await prisma.emailThread.update({ where: { id }, data: { unreadCount: 0 } })
  return { ok: true }
}

function replySubject(current: string | null, requested: string) {
  const value = requested.trim()
  if (value) return value.slice(0, 300)
  if (current) return `Re: ${cleanSubject(current)}`.slice(0, 300)
  return ''
}

export async function sendThreadMessage(
  auth: AuthContext,
  id: string,
  input: {
    to?: unknown
    subject?: unknown
    text?: unknown
    docCategory?: unknown
    templateCode?: unknown
    file?: Express.Multer.File | null
  },
  meta: AuditMeta,
) {
  const thread = await assertThreadAccess(auth, id)
  const to = asString(input.to).toLowerCase() || thread.participantEmail
  const subject = replySubject(thread.subject, asString(input.subject))
  const text = asString(input.text)
  const fields: Record<string, string> = {}
  if (!to || !isValidEmail(to)) fields.to = 'Please enter a valid email address.'
  if (to !== thread.participantEmail) fields.to = 'Replies stay on this email conversation.'
  if (!subject) fields.subject = 'Please enter a subject.'
  if (!text) fields.text = 'Please enter a message.'
  if (Object.keys(fields).length) throw httpError.validation(fields)

  const docCategory = asOptionalString(input.docCategory, 80)
  if (docCategory && !EMAIL_DOC_CATEGORIES.includes(docCategory as (typeof EMAIL_DOC_CATEGORIES)[number])) {
    throw httpError.validation({ docCategory: 'Please select a valid document type.' })
  }

  let stored: { url: string; mimeType: string; fileName: string; fileSize: number } | null = null
  if (input.file) {
    try {
      assertEmailAttachment(input.file)
      stored = await storeEmailAttachment({
        threadId: thread.id,
        buffer: input.file.buffer,
        mimeType: input.file.mimetype,
        fileName: input.file.originalname,
      })
    } catch (error) {
      if (error instanceof HttpError) throw new HttpError(error.status, EMAIL_MESSAGES.attachmentFailed, error.code)
      throw httpError.badRequest(EMAIL_MESSAGES.attachmentFailed, 'ATTACHMENT_FAILED')
    }
  }

  const priorIds = await prisma.emailMessage.findMany({
    where: { threadId: thread.id, providerMessageId: { not: null } },
    orderBy: { sentAt: 'desc' },
    take: 20,
    select: { providerMessageId: true },
  })
  const referenceIds = priorIds
    .map((row) => row.providerMessageId)
    .filter((value): value is string => Boolean(value))
    .reverse()
  const inReplyTo = thread.lastInboundMessageId || referenceIds[referenceIds.length - 1] || null
  const referencesHeader = [...new Set([...referenceIds, inReplyTo].filter(Boolean) as string[])].join(' ') || null

  let providerMessageId: string | null = null
  let failure: string | null = null
  try {
    providerMessageId = await sendMailboxEmail({
      to,
      subject,
      text,
      html: textToHtml(text),
      inReplyTo,
      references: referencesHeader,
      attachments: stored && input.file
        ? [{ filename: stored.fileName, content: input.file.buffer, contentType: stored.mimeType }]
        : [],
    })
  } catch (error) {
    failure = error instanceof EmailProviderError ? error.message : 'Provider request failed'
    console.error('[email] send failed:', error)
  }

  const now = new Date()
  const message = await prisma.emailMessage.create({
    data: {
      threadId: thread.id,
      direction: 'outgoing',
      subject,
      bodyText: text,
      fromEmail: mailboxAddress(),
      fromName: auth.user.fullName,
      toEmail: to,
      providerMessageId,
      inReplyTo,
      referencesHeader,
      deliveryStatus: failure ? 'failed' : 'sent',
      errorMessage: failure,
      sentById: auth.user.id,
      templateCode: asOptionalString(input.templateCode, 80),
      sentAt: now,
      attachments: stored
        ? {
            create: {
              fileName: stored.fileName,
              mimeType: stored.mimeType,
              url: stored.url,
              fileSize: stored.fileSize,
              docCategory,
            },
          }
        : undefined,
    },
    include: messageInclude,
  })

  if (!failure) {
    await prisma.emailThread.update({
      where: { id: thread.id },
      data: {
        subject: thread.subject || cleanSubject(subject),
        lastMessageAt: now,
        lastMessagePreview: text.slice(0, 180),
        lastDirection: 'outgoing',
        status: 'WAITING_REPLY',
        unreadCount: 0,
      },
    })

    if (thread.lead) {
      await createTimelineEntry({
        leadId: thread.lead.id,
        leadName: thread.lead.name,
        userId: auth.user.id,
        outcome: 'Email Sent',
        notes: `${subject}\n${text}`.trim(),
        threadId: thread.id,
        messageId: message.id,
      })
      if (stored) {
        await createTimelineEntry({
          leadId: thread.lead.id,
          leadName: thread.lead.name,
          userId: auth.user.id,
          outcome: 'Attachment Sent',
          notes: stored.fileName,
          threadId: thread.id,
          messageId: message.id,
        })
        if (input.file?.buffer) {
          await copyAttachmentsToLeadDocuments({
            leadId: thread.lead.id,
            leadName: thread.lead.name,
            messageId: message.id,
            uploadedById: auth.user.id,
            files: [
              {
                buffer: input.file.buffer,
                mimeType: stored.mimeType,
                fileName: stored.fileName,
                category: docCategory,
              },
            ],
          })
        }
      }
      await createTimelineEntry({
        leadId: thread.lead.id,
        leadName: thread.lead.name,
        userId: auth.user.id,
        outcome: 'Email Replied',
        notes: `Reply sent to ${to}`,
        threadId: thread.id,
        messageId: message.id,
      })
      await recordCrmEmailCommunication({
        leadId: thread.lead.id,
        direction: 'outgoing',
        subject,
        message: text,
        senderName: auth.user.fullName,
        senderEmail: mailboxAddress(),
        externalId: `crm-email:${message.id}`,
        eventAt: now,
        formName: 'CRM outbound',
      })
    }

    await writeAuditLog({
      userId: auth.user.id,
      action: 'EMAIL_SENT',
      entityType: 'email_thread',
      entityId: thread.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { messageId: message.id, leadId: thread.leadId, to },
    })
  }

  if (failure) {
    if (thread.lead) {
      await createTimelineEntry({
        leadId: thread.lead.id,
        leadName: thread.lead.name,
        userId: auth.user.id,
        outcome: 'Email Failed',
        notes: `${subject}\n${failure}`.trim(),
        threadId: thread.id,
        messageId: message.id,
      })
    }
    await notifyRecipients({
      assigneeId: thread.lead?.ownerId || thread.assignedUserId || auth.user.id,
      title: 'Email failed to send',
      body: thread.lead
        ? `${thread.lead.code} — ${thread.lead.name}: ${subject}`
        : `${subject} → ${to}`,
      type: 'email_failed',
      threadId: thread.id,
      leadId: thread.leadId,
      dedupe: `fail:${message.id}`,
    })
    throw new HttpError(502, EMAIL_MESSAGES.sendFailed, 'EMAIL_SEND_FAILED')
  }

  return { message: serializeMessage(message), thread: serializeThread(await loadThread(id)) }
}

export async function assignThread(auth: AuthContext, id: string, body: Record<string, unknown>, meta: AuditMeta) {
  assertCanManage(auth)
  const thread = await assertThreadAccess(auth, id)
  const userId = asString(body.userId)
  const reason = asOptionalString(body.reason, 400)
  if (!userId) throw httpError.validation({ userId: 'Please select an employee.' })

  let leadReassignedViaAssign = false
  if (thread.lead) {
    if (thread.lead.ownerId !== userId) {
      await assignLead(auth, thread.lead.id, { ownerId: userId, reason: reason || 'Lead reassigned from email' }, meta)
      leadReassignedViaAssign = true
    }
  } else {
    const assignee = await prisma.user.findFirst({
      where: { id: userId, status: 'ACTIVE', AND: [assigneeVisibilityWhere(auth)] },
      select: { id: true },
    })
    if (!assignee) throw httpError.badRequest('The selected user cannot receive this email.')
  }

  await prisma.emailThread.update({
    where: { id },
    data: {
      assignedUserId: userId,
      status: thread.status === 'NEW' ? 'ASSIGNED' : thread.status,
    },
  })

  const updated = await loadThread(id)
  const assigneeName = effectiveAssignee(updated)?.name || 'employee'

  // assignLead already writes the lead-reassigned activity; only log when that path did not run.
  if (updated.lead && !leadReassignedViaAssign) {
    await createTimelineEntry({
      leadId: updated.lead.id,
      leadName: updated.lead.name,
      userId: auth.user.id,
      outcome: 'Lead Reassigned',
      notes: `Lead reassigned to ${assigneeName}${reason ? ` — ${reason}` : ''}`,
      threadId: id,
    })
  }

  await createNotification({
    userId,
    title: 'Email assigned to you',
    body: `${serializeThread(updated).displayName} is now assigned to you.`,
    link: `/email?c=${id}`,
    type: 'email_assigned',
    leadId: updated.leadId,
    dedupeKey: `email-assign:${id}:${userId}:${Date.now()}`,
  }).catch(() => undefined)

  await writeAuditLog({
    userId: auth.user.id,
    action: 'EMAIL_THREAD_ASSIGNED',
    entityType: 'email_thread',
    entityId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { toUserId: userId, leadId: updated.leadId, reason },
  })

  return { thread: serializeThread(updated), message: 'Email assigned successfully.' }
}

export async function updateThreadStatus(
  auth: AuthContext,
  id: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  const thread = await assertThreadAccess(auth, id)
  const status = asString(body.status).toUpperCase() as EmailThreadStatus
  if (!MANUAL_STATUSES.includes(status)) {
    throw httpError.validation({ status: 'Please select a valid status.' })
  }
  if (status === thread.status) {
    return { thread: serializeThread(thread), message: 'Status unchanged.' }
  }

  await prisma.emailThread.update({
    where: { id },
    data: { status, ...(status === 'CLOSED' ? { unreadCount: 0 } : {}) },
  })

  if (thread.lead && status === 'CLOSED') {
    await createTimelineEntry({
      leadId: thread.lead.id,
      leadName: thread.lead.name,
      userId: auth.user.id,
      outcome: 'Email Closed',
      notes: 'Email conversation marked as closed',
      threadId: id,
    })
  }

  await writeAuditLog({
    userId: auth.user.id,
    action: 'EMAIL_THREAD_STATUS',
    entityType: 'email_thread',
    entityId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { from: thread.status, to: status, leadId: thread.leadId },
  })

  return { thread: serializeThread(await loadThread(id)), message: 'Email status updated.' }
}

export async function convertThread(
  auth: AuthContext,
  id: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  assertCanManage(auth)
  const thread = await assertThreadAccess(auth, id)
  if (thread.leadId) throw httpError.conflict('This email is already linked to a lead.')

  let leadId = asString(body.leadId)
  let leadCreated = false

  if (leadId) {
    await assertCanViewLead(auth, leadId)
    const existing = await prisma.emailThread.findFirst({
      where: { leadId, id: { not: id } },
      select: { id: true },
    })
    if (existing) {
      const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { email: true } })
      if (lead?.email && lead.email.toLowerCase() !== thread.participantEmail) {
        throw httpError.conflict('This lead is already linked to a different email conversation.')
      }
    }
  } else {
    const fields: Record<string, string> = {}
    const name = titleCaseName(asString(body.name)) || thread.contactName || ''
    if (!name) fields.name = 'Please enter the student name.'
    if (Object.keys(fields).length) throw httpError.validation(fields)

    const firstInbound = await prisma.emailMessage.findFirst({
      where: { threadId: id, direction: 'incoming' },
      orderBy: { sentAt: 'asc' },
      select: { bodyText: true, subject: true },
    })

    const result = await ingestCommunication({
      channel: 'EMAIL',
      senderName: name,
      senderEmail: thread.participantEmail,
      preferredCountryCode: asOptionalString(body.preferredCountryCode, 40) || undefined,
      subject: thread.subject || firstInbound?.subject || undefined,
      message: asOptionalString(body.notes, 2000) || firstInbound?.bodyText || undefined,
      externalId: `email-convert:${id}:${Date.now()}`,
      sourceCode: 'EMAIL',
    })
    if (!result.event.leadId) throw httpError.badRequest('Unable to create a lead from this email.')
    leadId = result.event.leadId
    leadCreated = result.event.leadCreated
  }

  const hadOutgoing = await prisma.emailMessage.count({ where: { threadId: id, direction: 'outgoing' } })
  const lead = await linkThreadToLead(id, leadId, hadOutgoing > 0)

  await createTimelineEntry({
    leadId: lead.id,
    leadName: lead.name,
    userId: auth.user.id,
    outcome: leadCreated ? 'Lead Created' : 'Email Linked',
    notes: leadCreated
      ? `Lead created from email ${thread.participantEmail}`
      : `Email conversation linked to this lead`,
    threadId: id,
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'EMAIL_THREAD_CONVERTED',
    entityType: 'email_thread',
    entityId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { leadId, leadCreated },
  })

  return {
    thread: serializeThread(await loadThread(id)),
    leadCreated,
    message: leadCreated ? 'Lead created from this email.' : 'Email linked to the lead.',
  }
}

export async function getLeadThreads(auth: AuthContext, leadId: string) {
  await assertCanViewLead(auth, leadId)
  assertCanViewEmail(auth)

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { id: true, name: true, email: true, ownerId: true },
  })
  if (!lead) throw httpError.notFound('Lead not found.')

  // Repair: link any mailbox thread for this student's address that lost its leadId.
  const email = lead.email?.trim().toLowerCase() || ''
  if (email && isValidEmail(email)) {
    const orphan = await prisma.emailThread.findFirst({
      where: { participantEmail: email, OR: [{ leadId: null }, { leadId: lead.id }] },
      select: { id: true, leadId: true, contactName: true, status: true },
    })
    if (orphan && !orphan.leadId) {
      await prisma.emailThread.update({
        where: { id: orphan.id },
        data: {
          leadId: lead.id,
          contactName: orphan.contactName || lead.name,
          assignedUserId: lead.ownerId,
          status: orphan.status === 'NEW' && lead.ownerId ? 'ASSIGNED' : orphan.status,
        },
      })
    }
  }

  const rows = await prisma.emailThread.findMany({
    where: { leadId },
    include: threadInclude,
    orderBy: { lastMessageAt: 'desc' },
  })
  return { items: rows.map(serializeThread) }
}

export async function startLeadThread(auth: AuthContext, leadId: string, meta: AuditMeta) {
  await assertCanViewLead(auth, leadId)
  assertCanViewEmail(auth)
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { id: true, name: true, email: true, ownerId: true },
  })
  if (!lead) throw httpError.notFound('Lead not found.')
  const email = lead.email?.trim().toLowerCase() || ''
  if (!email || !isValidEmail(email)) {
    throw httpError.validation({ email: 'Add an email address to this lead before sending.' })
  }

  const existing = await prisma.emailThread.findUnique({ where: { participantEmail: email } })
  if (existing?.leadId && existing.leadId !== lead.id) {
    throw httpError.conflict('This email address is already linked to another lead.')
  }

  const thread = existing
    ? await prisma.emailThread.update({
        where: { id: existing.id },
        data: {
          leadId: lead.id,
          contactName: existing.contactName || lead.name,
          assignedUserId: lead.ownerId,
          status: existing.status === 'NEW' && lead.ownerId ? 'ASSIGNED' : existing.status,
        },
      })
    : await prisma.emailThread.create({
        data: {
          participantEmail: email,
          contactName: lead.name,
          leadId: lead.id,
          assignedUserId: lead.ownerId,
          status: lead.ownerId ? 'ASSIGNED' : 'NEW',
        },
      })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'EMAIL_THREAD_STARTED',
    entityType: 'email_thread',
    entityId: thread.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { leadId: lead.id },
  })

  return { thread: serializeThread(await loadThread(thread.id)) }
}

export async function simulateInbound(auth: AuthContext, body: Record<string, unknown>) {
  if (config.isProduction) throw httpError.accessDenied(EMAIL_MESSAGES.denied)
  assertCanManage(auth)
  const result = await receiveInboundEmail(normalizeInboundBody(body))
  return { ...result, message: result.duplicate ? 'This email was already received.' : 'Test email received.' }
}
