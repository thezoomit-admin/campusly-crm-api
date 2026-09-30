import { Router } from 'express'
import { ingestCommunication } from '../communications/communications.service'
import { HttpError, httpError } from '../../lib/http-error'
import { prisma } from '../../lib/prisma'
import { requireWebsiteWebhookAuth } from './webhook-auth.middleware'
import { requireEmailWebhookAuth } from '../email/email.webhook-auth'
import { normalizeInboundBody, receiveInboundEmail } from '../email/email.service'
import { validateWebsiteEnquiry } from './website-enquiry.validation'
import { WEBSITE_MESSAGES } from './website-forms'
import { acceptMetaWebhook, assertMetaWebhookAuth, verifyMetaWebhook } from '../meta-leads/meta-leads.routes'
import type { MetaPlatformCode } from '../meta-leads/meta-leads.constants'

export const webhooksRouter = Router()

async function assertActiveCountry(code: string) {
  const country = await prisma.masterDataItem.findFirst({
    where: {
      categoryKey: 'COUNTRY',
      status: 'ACTIVE',
      OR: [
        { code: { equals: code, mode: 'insensitive' } },
        { name: { equals: code, mode: 'insensitive' } },
      ],
    },
    select: { code: true },
  })
  if (!country?.code) {
    throw httpError.validation(
      { preferredCountryCode: 'Please select a valid preferred country.' },
      WEBSITE_MESSAGES.required,
    )
  }
  return country.code
}

/**
 * Website form webhook (CRM-011) — Apply Now, Contact, Consultation, Callback, etc.
 * Auth: X-Webhook-Key / X-Api-Key / Bearer <WEBSITE_WEBHOOK_SECRET>
 */
webhooksRouter.post('/website', requireWebsiteWebhookAuth, async (req, res, next) => {
  try {
    const normalized = validateWebsiteEnquiry((req.body || {}) as Record<string, unknown>)
    const preferredCountryCode = await assertActiveCountry(normalized.preferredCountryCode)
    const result = await ingestCommunication({
      channel: 'WEBSITE',
      senderName: normalized.senderName,
      senderPhone: normalized.senderPhone,
      senderEmail: normalized.senderEmail || undefined,
      preferredCountryCode,
      message: normalized.message || undefined,
      campaign: normalized.campaign || undefined,
      campaignId: normalized.campaignId || undefined,
      utmSource: normalized.utmSource || undefined,
      utmMedium: normalized.utmMedium || undefined,
      utmCampaign: normalized.utmCampaign || undefined,
      utmContent: normalized.utmContent || undefined,
      utmTerm: normalized.utmTerm || undefined,
      landingPageUrl: normalized.landingPageUrl || undefined,
      phoneCountryCode: normalized.phoneCountryCode || undefined,
      whatsapp: normalized.whatsapp || undefined,
      whatsappSameAsPhone: normalized.whatsappSameAsPhone,
      currentLocation: normalized.currentLocation || undefined,
      highestQualificationCode: normalized.highestQualificationCode || undefined,
      preferredIntakeCode: normalized.preferredIntakeCode || undefined,
      preferredDegreeCode: normalized.preferredDegreeCode || undefined,
      formName: normalized.formName || undefined,
      externalId: normalized.externalId || undefined,
      eventAt: normalized.eventAt || undefined,
      sourceCode: 'WEBSITE',
      rawPayload: (req.body || {}) as Record<string, unknown>,
    })

    const duplicate = !result.event.leadCreated
    res.status(result.created ? 201 : 200).json({
      success: true,
      message: duplicate ? WEBSITE_MESSAGES.duplicate : WEBSITE_MESSAGES.success,
      duplicate,
      enquiryId: result.event.id,
      status: result.event.processingStatus,
      reprocessed: result.reprocessed,
    })
  } catch (error) {
    if (error instanceof HttpError) {
      next(error)
      return
    }
    console.error('[webhooks/website]', error)
    next(new HttpError(500, WEBSITE_MESSAGES.failed, 'WEBSITE_SUBMIT_FAILED'))
  }
})

/**
 * Company mailbox inbound webhook (CRM-013).
 * Auth: X-Webhook-Key / X-Api-Key / Bearer <EMAIL_WEBHOOK_SECRET>
 */
webhooksRouter.post('/email', requireEmailWebhookAuth, async (req, res, next) => {
  try {
    const result = await receiveInboundEmail(normalizeInboundBody((req.body || {}) as Record<string, unknown>))
    res.status(result.skipped ? 200 : 201).json({
      success: true,
      duplicate: result.duplicate,
      threadId: result.threadId,
      messageId: result.messageId,
      leadId: result.leadId,
    })
  } catch (error) {
    next(error)
  }
})

function metaWebhookGet(req: Parameters<typeof verifyMetaWebhook>[0], res: { status: (code: number) => { send: (body: string) => void }; sendStatus: (code: number) => void }) {
  const challenge = verifyMetaWebhook(req)
  if (challenge !== null) {
    res.status(200).send(challenge)
    return
  }
  res.sendStatus(403)
}

async function metaWebhookPost(
  req: Parameters<typeof assertMetaWebhookAuth>[0],
  res: { status: (code: number) => { json: (body: unknown) => void } },
  next: (error?: unknown) => void,
  platform: MetaPlatformCode,
) {
  try {
    assertMetaWebhookAuth(req)
    const result = await acceptMetaWebhook((req.body || {}) as Record<string, unknown>, platform)
    const created = 'created' in result && result.created === true
    res.status(created ? 201 : 200).json(result)
  } catch (error) {
    next(error)
  }
}

/** Meta Lead Ads subscription verification. */
webhooksRouter.get('/meta', (req, res) => metaWebhookGet(req, res))
webhooksRouter.get('/meta/facebook', (req, res) => metaWebhookGet(req, res))
webhooksRouter.get('/meta/instagram', (req, res) => metaWebhookGet(req, res))

/** Facebook Lead Ads — normalized payload or Meta page leadgen webhook. */
webhooksRouter.post('/meta/facebook', async (req, res, next) => {
  await metaWebhookPost(req, res, next, 'FACEBOOK')
})

/** Instagram Lead Ads — normalized payload or Meta page leadgen webhook. */
webhooksRouter.post('/meta/instagram', async (req, res, next) => {
  await metaWebhookPost(req, res, next, 'INSTAGRAM')
})

/** Meta lead forms. Platform is taken from the body when present. */
webhooksRouter.post('/meta', async (req, res, next) => {
  const body = (req.body || {}) as Record<string, unknown>
  const platform = String(body.platform || body.source || '').toLowerCase()
  const fallback: MetaPlatformCode = platform.includes('instagram') || platform.includes('ig') ? 'INSTAGRAM' : 'FACEBOOK'
  await metaWebhookPost(req, res, next, fallback)
})
