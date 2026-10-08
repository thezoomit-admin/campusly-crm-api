import { Router } from 'express'
import type { Request } from 'express'
import { requestIp, requestUserAgent, routeParam } from '../../lib/request'
import { requireAuth, requirePermission } from '../auth/require-auth.middleware'
import {
  cancelPayment,
  createOfferPayment,
  generateReceiptForPayment,
  getPayment,
  getReceipt,
  listLeadPaymentHistory,
  listPaymentMethods,
  listPayments,
  paymentCollectionSummary,
  reversePayment,
} from './payments.service'

export const paymentsRouter = Router()

paymentsRouter.use(requireAuth)

function body(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function auditMeta(req: Request) {
  return {
    ipAddress: requestIp(req),
    userAgent: requestUserAgent(req),
  }
}

function queryString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function queryNumber(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

paymentsRouter.get('/methods', requirePermission(['payment:view', 'payment:create']), async (_req, res, next) => {
  try {
    res.json(await listPaymentMethods())
  } catch (error) {
    next(error)
  }
})

paymentsRouter.get('/summary', requirePermission('payment:view'), async (req, res, next) => {
  try {
    res.json(await paymentCollectionSummary(req.auth!))
  } catch (error) {
    next(error)
  }
})

paymentsRouter.get('/', requirePermission('payment:view'), async (req, res, next) => {
  try {
    res.json(
      await listPayments(req.auth!, {
        search: queryString(req.query.search),
        methodCode: queryString(req.query.methodCode),
        status: queryString(req.query.status),
        receivedById: queryString(req.query.receivedById),
        packageName: queryString(req.query.packageName),
        dateFrom: queryString(req.query.dateFrom),
        dateTo: queryString(req.query.dateTo),
        amountMin: queryString(req.query.amountMin),
        amountMax: queryString(req.query.amountMax),
        page: queryNumber(req.query.page),
        limit: queryNumber(req.query.limit),
      }),
    )
  } catch (error) {
    next(error)
  }
})

paymentsRouter.get('/:paymentId', requirePermission('payment:view'), async (req, res, next) => {
  try {
    res.json(await getPayment(req.auth!, routeParam(req.params.paymentId)))
  } catch (error) {
    next(error)
  }
})

paymentsRouter.post('/:paymentId/cancel', requirePermission('payment:cancel'), async (req, res, next) => {
  try {
    res.json(await cancelPayment(req.auth!, routeParam(req.params.paymentId), body(req.body), auditMeta(req)))
  } catch (error) {
    next(error)
  }
})

paymentsRouter.post('/:paymentId/reverse', requirePermission(['payment:cancel', 'payment:approve']), async (req, res, next) => {
  try {
    res.json(await reversePayment(req.auth!, routeParam(req.params.paymentId), body(req.body), auditMeta(req)))
  } catch (error) {
    next(error)
  }
})

paymentsRouter.post(
  '/:paymentId/receipt',
  requirePermission(['receipt:generate', 'payment:create']),
  async (req, res, next) => {
    try {
      res.status(201).json(await generateReceiptForPayment(req.auth!, routeParam(req.params.paymentId), auditMeta(req)))
    } catch (error) {
      next(error)
    }
  },
)

export const receiptsRouter = Router()

receiptsRouter.use(requireAuth)

receiptsRouter.get('/:receiptId', requirePermission(['receipt:view', 'payment:view']), async (req, res, next) => {
  try {
    res.json(await getReceipt(req.auth!, routeParam(req.params.receiptId)))
  } catch (error) {
    next(error)
  }
})

export const leadPaymentsRouter = Router({ mergeParams: true })

leadPaymentsRouter.use(requireAuth)

leadPaymentsRouter.get('/', requirePermission(['payment:view', 'service:view']), async (req, res, next) => {
  try {
    res.json(await listLeadPaymentHistory(req.auth!, routeParam(req.params.leadId)))
  } catch (error) {
    next(error)
  }
})

leadPaymentsRouter.post(
  '/offers/:offerId',
  requirePermission('payment:create'),
  async (req, res, next) => {
    try {
      res.status(201).json(
        await createOfferPayment(
          req.auth!,
          routeParam(req.params.leadId),
          routeParam(req.params.offerId),
          body(req.body),
          auditMeta(req),
        ),
      )
    } catch (error) {
      next(error)
    }
  },
)
