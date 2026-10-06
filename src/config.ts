import dotenv from 'dotenv'
import path from 'path'

dotenv.config({ path: path.join(process.cwd(), '.env') })
const nodeEnv = process.env.NODE_ENV || 'development'
dotenv.config({
  path: path.join(process.cwd(), `.env.${nodeEnv}`),
  override: true,
})

export const SESSION_COOKIE = 'crm_session'

function defaultClientOrigins() {
  if (process.env.CLIENT_ORIGIN) {
    return process.env.CLIENT_ORIGIN
  }

  if (nodeEnv === 'production') {
    return 'https://admin-educational-crm.vercel.app'
  }

  return 'http://localhost:5173'
}

function splitOrigins(value?: string) {
  return (value || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
}

export const config = {
  env: nodeEnv,
  port: Number(process.env.PORT) || 4000,
  clientOrigins: splitOrigins(defaultClientOrigins()),
  /** Public marketing-site origins allowed for website lead forms / CORS. */
  websiteOrigins: splitOrigins(process.env.WEBSITE_ORIGINS),
  /**
   * Shared secret for POST /api/webhooks/website.
   * Required in production. In development, requests are allowed when unset.
   */
  websiteWebhookSecret: (process.env.WEBSITE_WEBHOOK_SECRET || '').trim(),
  websiteWebhookRateLimitPerMinute: Number(process.env.WEBSITE_WEBHOOK_RATE_LIMIT) || 60,
  isProduction: nodeEnv === 'production',
  maxFailedLoginAttempts: Number(process.env.MAX_FAILED_LOGIN_ATTEMPTS) || 5,
  lockMinutes: Number(process.env.LOGIN_LOCK_MINUTES) || 15,
  sessionHours: Number(process.env.SESSION_HOURS) || 12,
  rememberMeDays: Number(process.env.REMEMBER_ME_DAYS) || 30,
  resetTokenHours: Number(process.env.RESET_TOKEN_HOURS) || 2,
  /** How long account-invite / set-password links remain valid. */
  inviteTokenHours: Number(process.env.INVITE_TOKEN_HOURS) || 72,
  /**
   * Public web app origin used in invite/reset emails.
   * Falls back to the first CLIENT_ORIGIN when unset.
   */
  appPublicUrl: (process.env.APP_PUBLIC_URL || splitOrigins(defaultClientOrigins())[0] || 'http://localhost:5173').replace(
    /\/$/,
    '',
  ),
  minPasswordLength: Number(process.env.MIN_PASSWORD_LENGTH) || 8,
  /**
   * WhatsApp Business (Meta Cloud API). When the access token or phone number id is missing,
   * outgoing messages run in mock mode outside production so the inbox can be tested locally.
   */
  whatsapp: {
    graphVersion: (process.env.WHATSAPP_GRAPH_VERSION || 'v21.0').trim(),
    phoneNumberId: (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim(),
    accessToken: (process.env.WHATSAPP_ACCESS_TOKEN || '').trim(),
    appSecret: (process.env.WHATSAPP_APP_SECRET || '').trim(),
    verifyToken: (process.env.WHATSAPP_VERIFY_TOKEN || '').trim(),
    autoCreateLead: (process.env.WHATSAPP_AUTO_CREATE_LEAD || 'true').trim().toLowerCase() !== 'false',
    allowVideo: (process.env.WHATSAPP_ALLOW_VIDEO || 'false').trim().toLowerCase() === 'true',
    allowVoice: (process.env.WHATSAPP_ALLOW_VOICE || 'false').trim().toLowerCase() === 'true',
    defaultTemplate: (process.env.WHATSAPP_DEFAULT_TEMPLATE || 'hello_world').trim(),
    defaultTemplateLanguage: (process.env.WHATSAPP_DEFAULT_TEMPLATE_LANGUAGE || 'en_US').trim(),
  },
  /**
   * Meta Lead Ads (Facebook + Instagram).
   * Page access token fetches leadgen details from the Graph API.
   * When it is missing, webhooks still accept a normalized lead payload and the CRM can receive test leads.
   */
  meta: {
    graphVersion: (process.env.META_GRAPH_VERSION || process.env.WHATSAPP_GRAPH_VERSION || 'v21.0').trim(),
    pageAccessToken: (process.env.META_PAGE_ACCESS_TOKEN || '').trim(),
    appSecret: (process.env.META_APP_SECRET || '').trim(),
    verifyToken: (process.env.META_VERIFY_TOKEN || '').trim(),
    webhookSecret: (process.env.META_WEBHOOK_SECRET || '').trim(),
  },
  /**
   * Official company mailbox.
   * - SMTP: outbound send
   * - IMAP: inbound sync of student replies (same mailbox credentials by default)
   * - Webhook: POST /api/webhooks/email for ESP inbound parse (SendGrid/Mailgun/etc.)
   */
  email: (() => {
    const smtpHost = (process.env.SMTP_HOST || '').trim()
    const smtpUser = (process.env.SMTP_USER || '').trim()
    const smtpPass = (process.env.SMTP_PASS || '').trim()
    const derivedImapHost =
      (process.env.IMAP_HOST || '').trim() ||
      (smtpHost === 'smtp.gmail.com'
        ? 'imap.gmail.com'
        : smtpHost === 'smtp.office365.com' || smtpHost === 'smtp-mail.outlook.com'
          ? 'outlook.office365.com'
          : '')
    const imapUser = (process.env.IMAP_USER || smtpUser).trim()
    const imapPass = (process.env.IMAP_PASS || smtpPass).trim()
    const imapEnabledEnv = (process.env.EMAIL_IMAP_ENABLED || '').trim().toLowerCase()
    const imapEnabled =
      imapEnabledEnv === 'false' || imapEnabledEnv === '0'
        ? false
        : Boolean(derivedImapHost && imapUser && imapPass)

    return {
      fromAddress: (process.env.EMAIL_FROM_ADDRESS || '').trim(),
      fromName: (process.env.EMAIL_FROM_NAME || 'Campusly').trim(),
      smtpHost,
      smtpPort: Number(process.env.SMTP_PORT) || 587,
      smtpUser,
      smtpPass,
      smtpSecure: (process.env.SMTP_SECURE || '').trim().toLowerCase() === 'true',
      webhookSecret: (process.env.EMAIL_WEBHOOK_SECRET || '').trim(),
      autoCreateLead: (process.env.EMAIL_AUTO_CREATE_LEAD || 'true').trim().toLowerCase() !== 'false',
      imap: {
        enabled: imapEnabled,
        host: derivedImapHost,
        port: Number(process.env.IMAP_PORT) || 993,
        secure: (process.env.IMAP_SECURE || 'true').trim().toLowerCase() !== 'false',
        user: imapUser,
        pass: imapPass,
        mailbox: (process.env.IMAP_MAILBOX || 'INBOX').trim() || 'INBOX',
        pollSeconds: Math.max(15, Number(process.env.EMAIL_IMAP_POLL_SECONDS) || 30),
      },
      /** Hours after outbound before a waiting-reply reminder fires. */
      waitingReplyHours: Math.max(1, Number(process.env.EMAIL_WAITING_REPLY_HOURS) || 24),
      waitingReplyPollMinutes: Math.max(5, Number(process.env.EMAIL_WAITING_REPLY_POLL_MINUTES) || 15),
    }
  })(),
}
