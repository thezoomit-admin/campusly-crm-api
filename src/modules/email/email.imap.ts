import { ImapFlow } from 'imapflow'
import { simpleParser, type Attachment, type ParsedMail } from 'mailparser'
import { config } from '../../config'
import { prisma } from '../../lib/prisma'
import { isImapInboundConfigured, mailboxAddress } from './email.client'
import { markOutboundBounced, receiveInboundEmail, type InboundAttachment } from './email.service'

export { isImapInboundConfigured }

const MAX_ATTACHMENTS = 5
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
/** Recovery window for student replies Gmail may have auto-marked read. */
const LOOKBACK_MS = 72 * 60 * 60 * 1000
const MAX_RECENT_FETCH = 30
const MAX_UNSEEN_FETCH = 20

/** UIDs already handled this process — stops 72h lookback from re-parsing every poll. */
const handledUids = new Map<string, number>()

function handledKey(uid: number) {
  return `${config.email.imap.mailbox}:${uid}`
}

function rememberHandled(uid: number) {
  const now = Date.now()
  handledUids.set(handledKey(uid), now)
  if (handledUids.size > 2000) {
    const cutoff = now - LOOKBACK_MS - 60_000
    for (const [key, at] of handledUids) {
      if (at < cutoff) handledUids.delete(key)
    }
  }
}

function wasHandled(uid: number) {
  const at = handledUids.get(handledKey(uid))
  if (!at) return false
  if (Date.now() - at > LOOKBACK_MS + 60_000) {
    handledUids.delete(handledKey(uid))
    return false
  }
  return true
}

function isNoreplyAddress(email: string) {
  const local = email.split('@')[0] || ''
  return /no[-_]?reply|mailer-daemon|notifications?/i.test(local)
}

function isBounceSender(email: string) {
  const local = email.split('@')[0] || ''
  return /mailer-daemon|postmaster|mail-daemon/i.test(local)
}

function looksLikeBounceSubject(subject: string | null | undefined) {
  return /delivery status notification|undeliverable|mail delivery failed|returned mail|failure notice|delivery failure/i.test(
    (subject || '').toLowerCase(),
  )
}

function looksLikeBounce(parsed: ParsedMail, fromEmail: string) {
  if (isBounceSender(fromEmail)) return true
  return looksLikeBounceSubject(parsed.subject)
}

function bounceErrorText(parsed: ParsedMail) {
  const text = (parsed.text || '').replace(/\s+/g, ' ').trim()
  if (text) return text.slice(0, 400)
  return 'Delivery failed — bounce received from mail server.'
}

function addressEmail(value: ParsedMail['from'] | ParsedMail['to']): string | null {
  if (!value) return null
  const list = Array.isArray(value) ? value : [value]
  for (const entry of list) {
    const addr = entry.value?.[0]?.address
    if (addr) return addr.toLowerCase()
  }
  return null
}

function addressName(value: ParsedMail['from']): string | null {
  if (!value) return null
  const list = Array.isArray(value) ? value : [value]
  return list[0]?.value?.[0]?.name?.trim() || null
}

function normalizeMessageId(value?: string | null) {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.startsWith('<') ? trimmed : `<${trimmed}>`
}

function referenceIds(parsed: ParsedMail): string[] {
  const ids: string[] = []
  const inReplyTo = normalizeMessageId(
    typeof parsed.inReplyTo === 'string'
      ? parsed.inReplyTo
      : Array.isArray(parsed.inReplyTo)
        ? parsed.inReplyTo[0]
        : null,
  )
  if (inReplyTo) ids.push(inReplyTo)

  if (Array.isArray(parsed.references)) {
    for (const item of parsed.references) {
      const id = normalizeMessageId(item)
      if (id) ids.push(id)
    }
  } else if (typeof parsed.references === 'string') {
    for (const part of parsed.references.split(/\s+/)) {
      const id = normalizeMessageId(part)
      if (id) ids.push(id)
    }
  }
  return [...new Set(ids)]
}

function attachmentPayload(files: Attachment[] | undefined): InboundAttachment[] {
  if (!files?.length) return []
  return files
    .filter((file) => !file.related && file.content && file.content.length > 0 && file.content.length <= MAX_ATTACHMENT_BYTES)
    .slice(0, MAX_ATTACHMENTS)
    .map((file) => ({
      fileName: file.filename || 'attachment',
      mimeType: file.contentType || 'application/octet-stream',
      contentBase64: Buffer.from(file.content).toString('base64'),
    }))
}

/** Only student replies to mail we sent from the CRM. */
async function shouldIngestSender(fromEmail: string, parsed: ParsedMail): Promise<boolean> {
  if (fromEmail === mailboxAddress()) return false
  if (isNoreplyAddress(fromEmail)) return false

  const knownOutbound = await prisma.emailMessage.findFirst({
    where: { direction: 'outgoing', toEmail: { equals: fromEmail, mode: 'insensitive' } },
    select: { id: true },
  })
  if (knownOutbound) return true

  const refs = referenceIds(parsed)
  if (refs.length) {
    const related = await prisma.emailMessage.findFirst({
      where: { direction: 'outgoing', providerMessageId: { in: refs } },
      select: { id: true },
    })
    if (related) return true
  }

  return false
}

async function ingestParsedMail(parsed: ParsedMail) {
  const fromEmail = addressEmail(parsed.from)
  if (!fromEmail) return { skipped: true as const, reason: 'no-from' as const, fromEmail: null }

  const ours = mailboxAddress()
  if (fromEmail === ours) return { skipped: true as const, reason: 'own-mailbox' as const, fromEmail }

  const refs = referenceIds(parsed)

  if (looksLikeBounce(parsed, fromEmail) && refs.length) {
    const bounce = await markOutboundBounced({
      providerMessageIds: refs,
      errorMessage: bounceErrorText(parsed),
      eventAt: parsed.date && !Number.isNaN(parsed.date.getTime()) ? parsed.date : new Date(),
    })
    if (bounce.matched) {
      return {
        skipped: false as const,
        bounced: true as const,
        fromEmail,
        reason: 'bounced' as const,
        threadId: bounce.threadId,
        messageId: bounce.messageId,
        leadId: bounce.leadId,
      }
    }
  }

  if (!(await shouldIngestSender(fromEmail, parsed))) {
    return { skipped: true as const, reason: 'filtered' as const, fromEmail }
  }

  const result = await receiveInboundEmail({
    messageId: normalizeMessageId(parsed.messageId),
    fromEmail,
    fromName: addressName(parsed.from),
    toEmail: addressEmail(parsed.to) || ours,
    subject: parsed.subject || '(no subject)',
    text: parsed.text || null,
    html: typeof parsed.html === 'string' ? parsed.html : null,
    inReplyTo: refs[0] || null,
    references: refs.length ? refs.join(' ') : null,
    eventAt: parsed.date && !Number.isNaN(parsed.date.getTime()) ? parsed.date : new Date(),
    attachments: attachmentPayload(parsed.attachments),
    conversationOnly: true,
  })
  return {
    ...result,
    fromEmail,
    reason: result.skipped ? ('duplicate' in result && result.duplicate ? 'duplicate' : 'skipped') : 'ingested',
  }
}

function createImapClient() {
  const client = new ImapFlow({
    host: config.email.imap.host,
    port: config.email.imap.port,
    secure: config.email.imap.secure,
    auth: {
      user: config.email.imap.user,
      pass: config.email.imap.pass,
    },
    logger: false,
    emitLogs: false,
    socketTimeout: 90_000,
    greetingTimeout: 30_000,
    connectionTimeout: 30_000,
  })

  client.on('error', (error) => {
    console.error('[email:imap] Client error:', error instanceof Error ? error.message : error)
  })

  return client
}

async function markSeen(client: ImapFlow, uid: number) {
  await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }).catch(() => undefined)
}

/**
 * Unseen first (new mail). Recent window only for UIDs not yet handled in-process
 * (covers Gmail auto-read student replies without re-scanning forever).
 */
async function collectCandidateUids(client: ImapFlow): Promise<number[]> {
  const since = new Date(Date.now() - LOOKBACK_MS)
  const [unseenRaw, recentRaw] = await Promise.all([
    client.search({ seen: false }, { uid: true }),
    client.search({ since }, { uid: true }),
  ])

  const unseen = (Array.isArray(unseenRaw) ? unseenRaw : []).filter((uid) => !wasHandled(uid))
  const recent = (Array.isArray(recentRaw) ? recentRaw : []).filter((uid) => !wasHandled(uid))

  const unseenSet = new Set(unseen)
  const prioritized = [
    ...unseen.sort((a, b) => b - a).slice(0, MAX_UNSEEN_FETCH),
    ...recent
      .filter((uid) => !unseenSet.has(uid))
      .sort((a, b) => b - a)
      .slice(0, MAX_RECENT_FETCH),
  ]

  return prioritized
}

async function messageIdAlreadyStored(messageId: string | null) {
  if (!messageId) return false
  const existing = await prisma.emailMessage.findUnique({
    where: { providerMessageId: messageId },
    select: { id: true },
  })
  return Boolean(existing)
}

/**
 * Polls the company mailbox for new/recent messages and ingests them
 * through the same path as POST /api/webhooks/email.
 * SMTP stays for outbound; IMAP is receive-only.
 */
export async function syncImapInboundMailbox(): Promise<{
  processed: number
  ingested: number
  duplicates: number
  skipped: number
  errors: number
  cached: number
}> {
  if (!isImapInboundConfigured()) {
    return { processed: 0, ingested: 0, duplicates: 0, skipped: 0, errors: 0, cached: 0 }
  }

  const client = createImapClient()
  let processed = 0
  let ingested = 0
  let duplicates = 0
  let skipped = 0
  let errors = 0
  let cached = 0

  try {
    await client.connect()
    const lock = await client.getMailboxLock(config.email.imap.mailbox)
    try {
      const uids = await collectCandidateUids(client)
      if (!uids.length) {
        return { processed: 0, ingested: 0, duplicates: 0, skipped: 0, errors: 0, cached: 0 }
      }

      for (const uid of uids) {
        if (wasHandled(uid)) {
          cached += 1
          continue
        }

        processed += 1
        try {
          // Light pass: envelope only — skip known Message-IDs and obvious noreply noise.
          const meta = await client.fetchOne(uid, { uid: true, envelope: true }, { uid: true })
          if (!meta) {
            skipped += 1
            rememberHandled(uid)
            await markSeen(client, uid)
            continue
          }

          const envelopeId = normalizeMessageId(
            typeof meta.envelope?.messageId === 'string' ? meta.envelope.messageId : null,
          )
          const envelopeFrom = (meta.envelope?.from?.[0]?.address || '').toLowerCase()
          const envelopeSubject = meta.envelope?.subject || ''

          if (await messageIdAlreadyStored(envelopeId)) {
            duplicates += 1
            rememberHandled(uid)
            await markSeen(client, uid)
            continue
          }

          const maybeBounce =
            (envelopeFrom && isBounceSender(envelopeFrom)) || looksLikeBounceSubject(envelopeSubject)
          if (envelopeFrom && isNoreplyAddress(envelopeFrom) && !maybeBounce) {
            skipped += 1
            rememberHandled(uid)
            await markSeen(client, uid)
            continue
          }

          const full = await client.fetchOne(uid, { uid: true, source: true }, { uid: true })
          if (!full || !full.source) {
            skipped += 1
            rememberHandled(uid)
            await markSeen(client, uid)
            continue
          }

          const parsed = await simpleParser(full.source)
          const result = await ingestParsedMail(parsed)
          const from = result.fromEmail || envelopeFrom || 'unknown'
          const subject = (parsed.subject || envelopeSubject || '').slice(0, 80)

          rememberHandled(uid)
          await markSeen(client, uid)

          if ('duplicate' in result && result.duplicate) {
            duplicates += 1
          } else if ('bounced' in result && result.bounced) {
            ingested += 1
            console.log(
              `[email:imap] bounce uid=${uid} thread=${'threadId' in result ? result.threadId : '?'} | ${subject}`,
            )
          } else if (result.skipped) {
            skipped += 1
          } else {
            ingested += 1
            console.log(
              `[email:imap] ingested uid=${uid} thread=${'threadId' in result ? result.threadId : '?'} from=${from} | ${subject}`,
            )
          }
        } catch (error) {
          errors += 1
          console.error(`[email:imap] Failed to ingest UID ${uid}:`, error instanceof Error ? error.message : error)
        }
      }
    } finally {
      lock.release()
    }
  } finally {
    try {
      if (client.usable) await client.logout()
      else client.close()
    } catch {
      try {
        client.close()
      } catch {
        /* ignore */
      }
    }
  }

  return { processed, ingested, duplicates, skipped, errors, cached }
}
