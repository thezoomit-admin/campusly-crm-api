import { randomUUID } from 'node:crypto'
import nodemailer from 'nodemailer'
import { config } from '../../config'

export class EmailProviderError extends Error {}

export type OutboundAttachment = {
  filename: string
  content: Buffer
  contentType: string
}

export type OutboundEmail = {
  to: string
  subject: string
  text: string
  html: string
  inReplyTo?: string | null
  references?: string | null
  attachments?: OutboundAttachment[]
}

export function isEmailConfigured() {
  return Boolean(config.email.smtpHost && (config.email.fromAddress || config.email.smtpUser))
}

export function isEmailMockMode() {
  return !isEmailConfigured() && !config.isProduction
}

/** True when IMAP credentials are present and inbound sync is enabled. */
export function isImapInboundConfigured() {
  return Boolean(config.email.imap.enabled && config.email.imap.host && config.email.imap.user && config.email.imap.pass)
}

export function mailboxAddress() {
  return (config.email.fromAddress || config.email.smtpUser || 'enquiry@campusly.local').toLowerCase()
}

function messageId() {
  const domain = mailboxAddress().split('@')[1] || 'campusly.local'
  return `<${randomUUID()}@${domain}>`
}

/** Sends through the company mailbox. Returns the RFC Message-ID. */
export async function sendMailboxEmail(input: OutboundEmail): Promise<string> {
  const fromAddress = mailboxAddress()
  const id = messageId()

  if (!isEmailConfigured()) {
    if (isEmailMockMode()) {
      console.info(`[email:mock] ${fromAddress} -> ${input.to} | ${input.subject}`)
      return id
    }
    throw new EmailProviderError('Company email is not configured.')
  }

  const transport = nodemailer.createTransport({
    host: config.email.smtpHost,
    port: config.email.smtpPort,
    secure: config.email.smtpSecure || config.email.smtpPort === 465,
    auth: config.email.smtpUser
      ? { user: config.email.smtpUser, pass: config.email.smtpPass }
      : undefined,
  })

  try {
    const info = await transport.sendMail({
      from: config.email.fromName ? `"${config.email.fromName}" <${fromAddress}>` : fromAddress,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      messageId: id,
      inReplyTo: input.inReplyTo || undefined,
      references: input.references || undefined,
      attachments: (input.attachments || []).map((file) => ({
        filename: file.filename,
        content: file.content,
        contentType: file.contentType,
      })),
    })
    // Prefer provider-assigned id (Gmail may rewrite Message-ID) so replies can thread.
    const accepted = typeof info.messageId === 'string' && info.messageId.trim() ? info.messageId.trim() : id
    return accepted.startsWith('<') ? accepted : `<${accepted}>`
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'SMTP request failed'
    throw new EmailProviderError(detail)
  }
}
