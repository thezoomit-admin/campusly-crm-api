import { Router } from 'express'
import type { Request } from 'express'
import { requestIp, requestUserAgent, routeParam } from '../../lib/request'
import { requireAuth, requirePermission } from '../auth/require-auth.middleware'
import {
  acceptLeadServiceOffer,
  cancelLeadServiceOffer,
  deleteLeadServiceOffer,
  generateLeadServiceOffer,
  listLeadPayments,
  listLeadServiceOffers,
  recordOfferInstallmentPayment,
  rejectLeadServiceOffer,
  reviseLeadServiceOffer,
  saveLeadServiceOffer,
  sendLeadServiceOffer,
  serviceOfferContext,
} from './service-offers.service'

export const serviceOffersRouter = Router({ mergeParams: true })

serviceOffersRouter.use(requireAuth)

const offerDenied = 'You do not have permission to modify this offer.'

function body(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function auditMeta(req: Request) {
  return {
    ipAddress: requestIp(req),
    userAgent: requestUserAgent(req),
  }
}

function leadId(req: Request) {
  return routeParam(req.params.leadId)
}

function offerId(req: Request) {
  return routeParam(req.params.offerId)
}

serviceOffersRouter.get('/', requirePermission('service:view'), async (req, res, next) => {
  try {
    res.json(await listLeadServiceOffers(req.auth!, leadId(req)))
  } catch (error) {
    next(error)
  }
})

serviceOffersRouter.get('/context', requirePermission('service:view'), async (req, res, next) => {
  try {
    res.json(await serviceOfferContext(req.auth!, leadId(req)))
  } catch (error) {
    next(error)
  }
})

serviceOffersRouter.get('/payments', requirePermission(['payment:view', 'service:view']), async (req, res, next) => {
  try {
    res.json(await listLeadPayments(req.auth!, leadId(req)))
  } catch (error) {
    next(error)
  }
})

serviceOffersRouter.post('/', requirePermission('service:offer', offerDenied), async (req, res, next) => {
  try {
    res.status(201).json(await saveLeadServiceOffer(req.auth!, leadId(req), null, body(req.body), auditMeta(req)))
  } catch (error) {
    next(error)
  }
})

serviceOffersRouter.patch('/:offerId', requirePermission('service:offer', offerDenied), async (req, res, next) => {
  try {
    res.json(await saveLeadServiceOffer(req.auth!, leadId(req), offerId(req), body(req.body), auditMeta(req)))
  } catch (error) {
    next(error)
  }
})

serviceOffersRouter.post('/:offerId/generate', requirePermission('service:offer', offerDenied), async (req, res, next) => {
  try {
    res.json(await generateLeadServiceOffer(req.auth!, leadId(req), offerId(req), auditMeta(req)))
  } catch (error) {
    next(error)
  }
})

serviceOffersRouter.post('/:offerId/send', requirePermission('service:offer', offerDenied), async (req, res, next) => {
  try {
    res.json(await sendLeadServiceOffer(req.auth!, leadId(req), offerId(req), auditMeta(req)))
  } catch (error) {
    next(error)
  }
})

serviceOffersRouter.post('/:offerId/accept', requirePermission('service:offer', offerDenied), async (req, res, next) => {
  try {
    res.json(await acceptLeadServiceOffer(req.auth!, leadId(req), offerId(req), auditMeta(req)))
  } catch (error) {
    next(error)
  }
})

serviceOffersRouter.post('/:offerId/reject', requirePermission('service:offer', offerDenied), async (req, res, next) => {
  try {
    res.json(await rejectLeadServiceOffer(req.auth!, leadId(req), offerId(req), body(req.body), auditMeta(req)))
  } catch (error) {
    next(error)
  }
})

serviceOffersRouter.post('/:offerId/cancel', requirePermission('service:offer', offerDenied), async (req, res, next) => {
  try {
    res.json(await cancelLeadServiceOffer(req.auth!, leadId(req), offerId(req), body(req.body), auditMeta(req)))
  } catch (error) {
    next(error)
  }
})

serviceOffersRouter.post('/:offerId/revise', requirePermission('service:offer', offerDenied), async (req, res, next) => {
  try {
    res.status(201).json(await reviseLeadServiceOffer(req.auth!, leadId(req), offerId(req), body(req.body), auditMeta(req)))
  } catch (error) {
    next(error)
  }
})

serviceOffersRouter.post(
  '/:offerId/installments/:installmentId/pay',
  requirePermission('payment:create', offerDenied),
  async (req, res, next) => {
    try {
      res.json(
        await recordOfferInstallmentPayment(
          req.auth!,
          leadId(req),
          offerId(req),
          routeParam(req.params.installmentId),
          auditMeta(req),
        ),
      )
    } catch (error) {
      next(error)
    }
  },
)

serviceOffersRouter.delete('/:offerId', requirePermission('service:offer', offerDenied), async (req, res, next) => {
  try {
    res.json(await deleteLeadServiceOffer(req.auth!, leadId(req), offerId(req), auditMeta(req)))
  } catch (error) {
    next(error)
  }
})
