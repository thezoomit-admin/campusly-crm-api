import type { PaymentTxnStatus, Prisma, ServiceOfferStatus } from '../../lib/prisma-client'
import { HttpError, httpError } from '../../lib/http-error'
import { prisma } from '../../lib/prisma'
import { writeAuditLog } from '../../lib/audit'
import { hasPermission } from '../auth/access'
import type { AuthContext } from '../auth/session.service'
import { assertCanViewLead } from '../leads/leads.helpers'
import { createSystemFollowUp, daysFromNow } from '../follow-ups/system-follow-up'
import {
  advanceLeadPipelineStatus,
  changeOfferStatus,
  lockLead,
  writeOfferTimeline,
  type AuditMeta,
} from '../packages/offer-lifecycle'
import {
  CONSULTANCY_NAME,
  COUNTING_STATUSES,
  DEFAULT_METHOD_CATALOG,
  DIGITAL_METHODS,
  METHODS_REQUIRE_DESCRIPTION,
  METHODS_REQUIRE_TXN,
  OFFER_PAYABLE_STATUSES,
  PAYMENT_MESSAGES,
} from './payments.constants'

type Fields = Record<string, string>

const userRef = { select: { id: true, fullName: true } }

function money(value: { toString(): string } | string | number) {
  return Number(value).toFixed(2)
}

function cents(value: { toString(): string } | string | number) {
  return Math.round(Number(value) * 100)
}

function fromCents(value: number) {
  return value / 100
}

function parseDateOnly(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!match) return null
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return Number.isNaN(date.getTime()) ? null : date
}

function formatDisplayDate(date: Date) {
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

async function nextDocumentNumber(tx: Prisma.TransactionClient, key: 'payment' | 'receipt', prefix: string) {
  const row = await tx.documentSequence.upsert({
    where: { key },
    create: { key, nextValue: 2 },
    update: { nextValue: { increment: 1 } },
  })
  const value = row.nextValue - 1
  return `${prefix}-${String(value).padStart(6, '0')}`
}

export async function sumCompletedPaidCents(tx: Prisma.TransactionClient | typeof prisma, offerId: string) {
  const rows = await tx.payment.findMany({
    where: { serviceOfferId: offerId, status: { in: [...COUNTING_STATUSES] } },
    select: { amount: true },
  })
  return rows.reduce((sum, row) => sum + cents(row.amount), 0)
}

export async function syncOfferPaymentFromPayments(
  tx: Prisma.TransactionClient,
  offerId: string,
  actorId: string | null,
  meta?: AuditMeta,
) {
  const offer = await tx.serviceOffer.findUniqueOrThrow({
    where: { id: offerId },
    select: {
      id: true,
      leadId: true,
      offerVersion: true,
      finalPayable: true,
      status: true,
    },
  })
  if (!['PAYMENT_PENDING', 'PARTIALLY_PAID', 'PAID', 'ACCEPTED'].includes(offer.status)) {
    return offer.status
  }
  const total = cents(offer.finalPayable)
  const paid = await sumCompletedPaidCents(tx, offerId)
  let target: ServiceOfferStatus
  if (paid <= 0) {
    target = offer.status === 'ACCEPTED' ? 'ACCEPTED' : 'PAYMENT_PENDING'
    if (offer.status === 'PAID' || offer.status === 'PARTIALLY_PAID') target = 'PAYMENT_PENDING'
  } else if (paid >= total) {
    target = 'PAID'
  } else {
    target = 'PARTIALLY_PAID'
  }
  if (target === offer.status) return offer.status
  if (offer.status === 'ACCEPTED' && target === 'PAYMENT_PENDING') return offer.status
  await changeOfferStatus(tx, {
    offer: { ...offer, finalPayable: offer.finalPayable },
    to: target,
    actorId,
    meta,
  })
  return target
}

async function resolvePaymentMethod(methodCodeRaw: unknown) {
  const code = typeof methodCodeRaw === 'string' ? methodCodeRaw.trim().toUpperCase() : ''
  if (!code) return null

  const item = await prisma.masterDataItem.findFirst({
    where: {
      categoryKey: 'PAYMENT_METHOD',
      OR: [{ code }, { name: { equals: code, mode: 'insensitive' } }],
      status: 'ACTIVE',
    },
    select: { code: true, name: true },
  })
  if (item?.code) return { code: item.code.toUpperCase(), name: item.name }

  const fallback = DEFAULT_METHOD_CATALOG.find((row) => row.code === code || row.name.toUpperCase() === code)
  return fallback || null
}

function validateMethodReference(methodCode: string, transactionRef: string | null, fields: Fields) {
  const ref = transactionRef?.trim() || ''
  if (METHODS_REQUIRE_TXN.has(methodCode) && !ref) {
    fields.transactionRef = PAYMENT_MESSAGES.transactionRequired
  }
  if (METHODS_REQUIRE_DESCRIPTION.has(methodCode) && !ref) {
    fields.transactionRef = 'Description is required for this payment method.'
  }
}

type AllocationInput = { installmentId?: string; offerItemId?: string; label?: string; amount: number }

async function applyOldestDueFirstAllocations(
  tx: Prisma.TransactionClient,
  input: {
    offerId: string
    paymentId: string
    paymentAmountCents: number
    actorId: string
    paidAt: Date
    manual?: AllocationInput[]
  },
) {
  if (input.manual && input.manual.length > 0) {
    const sum = input.manual.reduce((acc, row) => acc + cents(row.amount), 0)
    if (sum !== input.paymentAmountCents) {
      throw httpError.validation({ allocations: PAYMENT_MESSAGES.allocationMismatch }, PAYMENT_MESSAGES.allocationMismatch)
    }
    for (const row of input.manual) {
      await tx.paymentAllocation.create({
        data: {
          paymentId: input.paymentId,
          installmentId: row.installmentId || null,
          offerItemId: row.offerItemId || null,
          label: row.label?.trim() || 'Allocation',
          amount: money(row.amount),
        },
      })
      if (row.installmentId) {
        await refreshInstallmentFromAllocations(tx, row.installmentId, input.actorId, input.paidAt)
      }
    }
    return
  }

  const installments = await tx.serviceOfferInstallment.findMany({
    where: { serviceOfferId: input.offerId },
    orderBy: [{ dueDate: 'asc' }, { sequence: 'asc' }],
  })

  let remaining = input.paymentAmountCents
  for (const installment of installments) {
    if (remaining <= 0) break
    const allocated = await tx.paymentAllocation.aggregate({
      where: {
        installmentId: installment.id,
        payment: { status: { in: [...COUNTING_STATUSES] } },
      },
      _sum: { amount: true },
    })
    const already = cents(allocated._sum.amount || 0)
    const need = Math.max(0, cents(installment.amount) - already)
    if (need <= 0) continue
    const take = Math.min(remaining, need)
    await tx.paymentAllocation.create({
      data: {
        paymentId: input.paymentId,
        installmentId: installment.id,
        label: installment.purpose || `Installment ${installment.sequence}`,
        amount: money(fromCents(take)),
      },
    })
    await refreshInstallmentFromAllocations(tx, installment.id, input.actorId, input.paidAt)
    remaining -= take
  }

  if (remaining > 0) {
    await tx.paymentAllocation.create({
      data: {
        paymentId: input.paymentId,
        label: 'Offer payment',
        amount: money(fromCents(remaining)),
      },
    })
  }
}

async function refreshInstallmentFromAllocations(
  tx: Prisma.TransactionClient,
  installmentId: string,
  actorId: string,
  paidAt: Date,
) {
  const installment = await tx.serviceOfferInstallment.findUnique({ where: { id: installmentId } })
  if (!installment) return
  const allocated = await tx.paymentAllocation.aggregate({
    where: {
      installmentId,
      payment: { status: { in: [...COUNTING_STATUSES] } },
    },
    _sum: { amount: true },
  })
  const paid = cents(allocated._sum.amount || 0)
  const total = cents(installment.amount)
  if (paid >= total) {
    await tx.serviceOfferInstallment.update({
      where: { id: installmentId },
      data: { status: 'PAID', paidAt, paidById: actorId },
    })
  } else if (paid > 0) {
    await tx.serviceOfferInstallment.update({
      where: { id: installmentId },
      data: { status: 'PARTIAL', paidAt: null, paidById: null },
    })
  } else {
    await tx.serviceOfferInstallment.update({
      where: { id: installmentId },
      data: { status: 'PENDING', paidAt: null, paidById: null },
    })
  }
}

async function rebuildInstallmentsForOffer(tx: Prisma.TransactionClient, offerId: string, actorId: string) {
  const installments = await tx.serviceOfferInstallment.findMany({ where: { serviceOfferId: offerId } })
  const now = new Date()
  for (const item of installments) {
    await refreshInstallmentFromAllocations(tx, item.id, actorId, now)
  }
}

function serializePayment(
  row: Prisma.PaymentGetPayload<{
    include: {
      receivedBy: typeof userRef
      receipt: true
      lead: { select: { id: true; code: true; name: true } }
      serviceOffer: { select: { id: true; offerVersion: true; packageName: true; finalPayable: true; status: true } }
      allocations: true
      cancelledBy: typeof userRef
      reversedBy: typeof userRef
    }
  }>,
) {
  return {
    id: row.id,
    paymentNumber: row.paymentNumber,
    leadId: row.leadId,
    leadCode: row.lead.code,
    studentName: row.lead.name,
    serviceOfferId: row.serviceOfferId,
    offerVersion: row.serviceOffer.offerVersion,
    packageName: row.serviceOffer.packageName,
    offerStatus: row.serviceOffer.status,
    finalPayable: money(row.serviceOffer.finalPayable),
    amount: money(row.amount),
    currency: row.currency,
    methodCode: row.methodCode,
    methodName: row.methodName,
    transactionRef: row.transactionRef,
    paymentDate: row.paymentDate.toISOString().slice(0, 10),
    notes: row.notes,
    status: row.status,
    previousPaidAmount: money(row.previousPaidAmount),
    remainingDueAmount: money(row.remainingDueAmount),
    receivedBy: row.receivedBy,
    receipt: row.receipt
      ? {
          id: row.receipt.id,
          receiptNumber: row.receipt.receiptNumber,
          status: row.receipt.status,
          generatedAt: row.receipt.generatedAt.toISOString(),
        }
      : null,
    allocations: row.allocations.map((item) => ({
      id: item.id,
      installmentId: item.installmentId,
      offerItemId: item.offerItemId,
      label: item.label,
      amount: money(item.amount),
    })),
    cancelReason: row.cancelReason,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelledBy: row.cancelledBy,
    reverseReason: row.reverseReason,
    reversedAt: row.reversedAt?.toISOString() ?? null,
    reversedBy: row.reversedBy,
    createdAt: row.createdAt.toISOString(),
  }
}

const paymentInclude = {
  receivedBy: userRef,
  receipt: true,
  lead: { select: { id: true, code: true, name: true } },
  serviceOffer: {
    select: { id: true, offerVersion: true, packageName: true, finalPayable: true, status: true },
  },
  allocations: true,
  cancelledBy: userRef,
  reversedBy: userRef,
} satisfies Prisma.PaymentInclude

async function loadPayment(id: string) {
  return prisma.payment.findUnique({ where: { id }, include: paymentInclude })
}

async function buildReceiptSnapshot(
  payment: NonNullable<Awaited<ReturnType<typeof loadPayment>>>,
  receiptNumber: string,
) {
  return {
    consultancyName: CONSULTANCY_NAME,
    receiptNumber,
    paymentDate: formatDisplayDate(payment.paymentDate),
    studentName: payment.lead.name,
    leadCode: payment.lead.code,
    paymentFor: payment.serviceOffer.packageName || `Service Offer V${payment.serviceOffer.offerVersion}`,
    paymentAmount: money(payment.amount),
    paymentMethod: payment.methodName,
    transactionRef: payment.transactionRef,
    totalPayable: money(payment.serviceOffer.finalPayable),
    previouslyPaid: money(payment.previousPaidAmount),
    thisPayment: money(payment.amount),
    remainingDue: money(payment.remainingDueAmount),
    receivedBy: payment.receivedBy.fullName,
    paymentNumber: payment.paymentNumber,
    currency: payment.currency,
  }
}

export async function generateReceiptForPayment(
  auth: AuthContext,
  paymentId: string,
  meta: AuditMeta,
) {
  if (!hasPermission(auth.permissions, 'receipt:generate') && !hasPermission(auth.permissions, 'payment:create')) {
    throw httpError.accessDenied(PAYMENT_MESSAGES.permissionDenied)
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({
        where: { id: paymentId },
        include: paymentInclude,
      })
      if (!payment) throw httpError.notFound(PAYMENT_MESSAGES.notFound)
      await assertCanViewLead(auth, payment.leadId)
      if (payment.status !== 'COMPLETED' && payment.status !== 'PENDING') {
        throw new HttpError(409, PAYMENT_MESSAGES.receiptError, 'RECEIPT_NOT_ALLOWED')
      }
      if (payment.receipt) {
        return payment.receipt
      }
      const receiptNumber = await nextDocumentNumber(tx, 'receipt', 'RCP')
      const snapshot = await buildReceiptSnapshot(payment as NonNullable<Awaited<ReturnType<typeof loadPayment>>>, receiptNumber)
      return tx.receipt.create({
        data: {
          receiptNumber,
          paymentId: payment.id,
          status: 'GENERATED',
          snapshot,
          generatedById: auth.user.id,
        },
      })
    })

    await writeAuditLog({
      userId: auth.user.id,
      action: 'RECEIPT_GENERATED',
      entityType: 'payment',
      entityId: paymentId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { receiptNumber: result.receiptNumber },
    })

    const payment = await loadPayment(paymentId)
    return {
      receipt: {
        id: result.id,
        receiptNumber: result.receiptNumber,
        status: result.status,
        snapshot: result.snapshot,
        generatedAt: result.generatedAt.toISOString(),
      },
      payment: payment ? serializePayment(payment) : null,
      message: 'Receipt generated.',
    }
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(500, PAYMENT_MESSAGES.receiptError, 'RECEIPT_ERROR')
  }
}

export async function createOfferPayment(
  auth: AuthContext,
  leadId: string,
  offerId: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  if (!hasPermission(auth.permissions, 'payment:create')) {
    throw httpError.accessDenied(PAYMENT_MESSAGES.permissionDenied)
  }

  const lead = await assertCanViewLead(auth, leadId)
  const fields: Fields = {}
  const amountRaw = body.amount
  const amount =
    amountRaw === undefined || amountRaw === null || amountRaw === ''
      ? NaN
      : Number(amountRaw)
  if (amountRaw === undefined || amountRaw === null || amountRaw === '') {
    fields.amount = PAYMENT_MESSAGES.amountRequired
  } else if (!Number.isFinite(amount) || amount <= 0) {
    fields.amount = PAYMENT_MESSAGES.amountInvalid
  }

  const method = await resolvePaymentMethod(body.methodCode ?? body.method)
  if (!method) fields.methodCode = PAYMENT_MESSAGES.methodRequired

  const transactionRef =
    typeof body.transactionRef === 'string'
      ? body.transactionRef.trim()
      : typeof body.transactionId === 'string'
        ? body.transactionId.trim()
        : null
  if (method) validateMethodReference(method.code, transactionRef, fields)

  const paymentDate =
    parseDateOnly(body.paymentDate) ||
    (body.paymentDate == null || body.paymentDate === ''
      ? new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()))
      : null)
  if (!paymentDate) fields.paymentDate = 'Please select a valid payment date.'

  const notes = typeof body.notes === 'string' ? body.notes.trim() : ''
  if (notes.length > 500) fields.notes = 'Notes cannot exceed 500 characters.'

  const statusRaw = typeof body.status === 'string' ? body.status.trim().toUpperCase() : 'COMPLETED'
  const status = (['COMPLETED', 'PENDING', 'FAILED'].includes(statusRaw) ? statusRaw : 'COMPLETED') as PaymentTxnStatus

  const allowDuplicate = body.allowDuplicateTransaction === true && hasPermission(auth.permissions, 'payment:approve')
  const generateReceipt = body.generateReceipt === true || body.saveAndGenerateReceipt === true
  const createFollowUp = body.createFollowUp === true

  let manualAllocations: AllocationInput[] | undefined
  if (Array.isArray(body.allocations)) {
    manualAllocations = body.allocations.map((row) => {
      const item = row && typeof row === 'object' ? (row as Record<string, unknown>) : {}
      return {
        installmentId: typeof item.installmentId === 'string' ? item.installmentId : undefined,
        offerItemId: typeof item.offerItemId === 'string' ? item.offerItemId : undefined,
        label: typeof item.label === 'string' ? item.label : undefined,
        amount: Number(item.amount),
      }
    })
    if (manualAllocations.some((row) => !Number.isFinite(row.amount) || row.amount <= 0)) {
      fields.allocations = PAYMENT_MESSAGES.allocationMismatch
    }
  }

  if (Object.keys(fields).length) throw httpError.validation(fields)

  if (method && transactionRef && DIGITAL_METHODS.has(method.code) && !allowDuplicate) {
    const existing = await prisma.payment.findFirst({
      where: {
        methodCode: method.code,
        transactionRef,
        status: { in: ['COMPLETED', 'PENDING'] },
      },
      include: { lead: { select: { id: true, code: true, name: true } } },
    })
    if (existing) {
      throw new HttpError(409, PAYMENT_MESSAGES.duplicateTransaction, 'DUPLICATE_TRANSACTION', undefined, {
        existingPayment: {
          id: existing.id,
          paymentNumber: existing.paymentNumber,
          leadId: existing.leadId,
          leadCode: existing.lead.code,
          studentName: existing.lead.name,
          amount: money(existing.amount),
        },
      })
    }
  }

  try {
    const createdId = await prisma.$transaction(async (tx) => {
      await lockLead(tx, leadId)
      const offer = await tx.serviceOffer.findFirst({
        where: { id: offerId, leadId },
        select: {
          id: true,
          leadId: true,
          offerVersion: true,
          finalPayable: true,
          status: true,
          packageName: true,
        },
      })
      if (!offer) throw httpError.notFound(PAYMENT_MESSAGES.invalidOffer)
      if (!OFFER_PAYABLE_STATUSES.includes(offer.status as (typeof OFFER_PAYABLE_STATUSES)[number])) {
        throw new HttpError(409, PAYMENT_MESSAGES.invalidOffer, 'INVALID_OFFER')
      }

      if (offer.status === 'ACCEPTED') {
        await changeOfferStatus(tx, {
          offer,
          to: 'PAYMENT_PENDING',
          actorId: auth.user.id,
          meta,
        })
      }

      const previousPaidCents = await sumCompletedPaidCents(tx, offerId)
      const dueCents = Math.max(0, cents(offer.finalPayable) - previousPaidCents)
      const amountCents = cents(amount)
      if (status === 'COMPLETED' && amountCents > dueCents) {
        throw httpError.validation({ amount: PAYMENT_MESSAGES.amountExceeded }, PAYMENT_MESSAGES.amountExceeded)
      }

      const paymentNumber = await nextDocumentNumber(tx, 'payment', 'PAY')
      const countsTowardPaid = status === 'COMPLETED'
      const remainingDueCents = countsTowardPaid
        ? Math.max(0, dueCents - amountCents)
        : dueCents

      const payment = await tx.payment.create({
        data: {
          paymentNumber,
          leadId,
          serviceOfferId: offerId,
          amount: money(amount),
          methodCode: method!.code,
          methodName: method!.name,
          transactionRef: transactionRef || null,
          paymentDate: paymentDate!,
          notes: notes || null,
          status,
          previousPaidAmount: money(fromCents(previousPaidCents)),
          remainingDueAmount: money(fromCents(remainingDueCents)),
          receivedById: auth.user.id,
          createdById: auth.user.id,
        },
      })

      if (countsTowardPaid) {
        await applyOldestDueFirstAllocations(tx, {
          offerId,
          paymentId: payment.id,
          paymentAmountCents: amountCents,
          actorId: auth.user.id,
          paidAt: paymentDate!,
          manual: manualAllocations,
        })
      }

      const nextStatus = await syncOfferPaymentFromPayments(tx, offerId, auth.user.id, meta)

      let receiptNumber: string | null = null
      if (generateReceipt && (status === 'COMPLETED' || status === 'PENDING')) {
        receiptNumber = await nextDocumentNumber(tx, 'receipt', 'RCP')
        const loaded = await tx.payment.findUnique({
          where: { id: payment.id },
          include: paymentInclude,
        })
        if (loaded) {
          const snapshot = {
            consultancyName: CONSULTANCY_NAME,
            receiptNumber,
            paymentDate: formatDisplayDate(loaded.paymentDate),
            studentName: loaded.lead.name,
            leadCode: loaded.lead.code,
            paymentFor: loaded.serviceOffer.packageName || `Service Offer V${loaded.serviceOffer.offerVersion}`,
            paymentAmount: money(loaded.amount),
            paymentMethod: loaded.methodName,
            transactionRef: loaded.transactionRef,
            totalPayable: money(loaded.serviceOffer.finalPayable),
            previouslyPaid: money(loaded.previousPaidAmount),
            thisPayment: money(loaded.amount),
            remainingDue: money(loaded.remainingDueAmount),
            receivedBy: loaded.receivedBy.fullName,
            paymentNumber: loaded.paymentNumber,
            currency: loaded.currency,
          }
          await tx.receipt.create({
            data: {
              receiptNumber,
              paymentId: payment.id,
              status: 'GENERATED',
              snapshot,
              generatedById: auth.user.id,
            },
          })
        }
      }

      await writeOfferTimeline(tx, {
        offer,
        action: 'SERVICE_OFFER_PAYMENT_RECORDED',
        actorId: auth.user.id,
        meta,
        extra: {
          paymentId: payment.id,
          paymentNumber,
          amount: money(amount),
          method: method!.name,
          methodCode: method!.code,
          transactionRef: transactionRef || null,
          remainingDue: money(fromCents(remainingDueCents)),
          paymentStatus: status,
          offerPaymentStatus: nextStatus,
          receiptNumber,
        },
      })

      if (nextStatus === 'PAID') {
        await writeOfferTimeline(tx, {
          offer,
          action: 'SERVICE_OFFER_PAYMENT_COMPLETED',
          actorId: auth.user.id,
          meta,
          extra: {
            paymentId: payment.id,
            paymentNumber,
            message: 'Payment Completed',
          },
        })
      }

      if (countsTowardPaid && (nextStatus === 'PARTIALLY_PAID' || nextStatus === 'PAID')) {
        await advanceLeadPipelineStatus(tx, {
          leadId,
          actorId: auth.user.id,
          targetCode: 'CONVERTED',
          remarks:
            nextStatus === 'PAID'
              ? `Service offer V${offer.offerVersion} fully paid`
              : `First payment recorded on offer V${offer.offerVersion}`,
          meta,
        })
      }

      return { paymentId: payment.id, receiptNumber }
    })

    await writeAuditLog({
      userId: auth.user.id,
      action: 'PAYMENT_CREATED',
      entityType: 'payment',
      entityId: createdId.paymentId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: {
        leadId,
        offerId,
        amount: money(amount),
        method: method!.code,
        receiptNumber: createdId.receiptNumber,
      },
    })

    if (createdId.receiptNumber) {
      await writeAuditLog({
        userId: auth.user.id,
        action: 'RECEIPT_GENERATED',
        entityType: 'payment',
        entityId: createdId.paymentId,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        metadata: { receiptNumber: createdId.receiptNumber },
      })
    }

    const payment = await loadPayment(createdId.paymentId)
    const remainingDue = payment ? Number(payment.remainingDueAmount) : 0
    let followUpCreated = false
    if (createFollowUp && remainingDue > 0 && payment?.status === 'COMPLETED') {
      const dueAt = daysFromNow(3)
      const result = await createSystemFollowUp({
        leadId,
        contactName: lead.name,
        type: 'Payment Discussion',
        purpose: 'Payment Follow-up',
        nextAction: `Collect remaining due BDT ${money(remainingDue)}`,
        dueAt,
        priority: 'High',
        notes: `Payment Pending — Due Amount: BDT ${money(remainingDue)}`,
        ownerId: lead.ownerId,
        ownerName: lead.ownerName,
        reason: `payment_pending:${offerId}`,
        actorUserId: auth.user.id,
        meta,
      })
      followUpCreated = result.created
    }

    return {
      payment: payment ? serializePayment(payment) : null,
      receipt: payment?.receipt
        ? {
            id: payment.receipt.id,
            receiptNumber: payment.receipt.receiptNumber,
            status: payment.receipt.status,
            snapshot: null,
            generatedAt: payment.receipt.generatedAt.toISOString(),
          }
        : null,
      followUpOffered: remainingDue > 0 && payment?.status === 'COMPLETED',
      followUpCreated,
      message:
        generateReceipt && payment?.receipt
          ? 'Payment saved and receipt generated.'
          : 'Payment recorded.',
    }
  } catch (error) {
    if (error instanceof HttpError) throw error
    console.error(error)
    throw new HttpError(500, PAYMENT_MESSAGES.serverError, 'PAYMENT_SERVER_ERROR')
  }
}

export async function recordInstallmentAsPayment(
  auth: AuthContext,
  leadId: string,
  offerId: string,
  installmentId: string,
  meta: AuditMeta,
) {
  const installment = await prisma.serviceOfferInstallment.findFirst({
    where: { id: installmentId, serviceOfferId: offerId },
  })
  if (!installment) throw httpError.notFound('The requested installment could not be found.')
  if (installment.status === 'PAID') {
    throw new HttpError(409, 'This installment has already been paid.', 'INSTALLMENT_PAID')
  }

  const allocated = await prisma.paymentAllocation.aggregate({
    where: {
      installmentId,
      payment: { status: { in: [...COUNTING_STATUSES] } },
    },
    _sum: { amount: true },
  })
  const remaining = fromCents(Math.max(0, cents(installment.amount) - cents(allocated._sum.amount || 0)))
  if (remaining <= 0) {
    throw new HttpError(409, 'This installment has already been paid.', 'INSTALLMENT_PAID')
  }

  return createOfferPayment(
    auth,
    leadId,
    offerId,
    {
      amount: remaining,
      methodCode: 'CASH',
      paymentDate: new Date().toISOString().slice(0, 10),
      notes: `Installment ${installment.sequence}: ${installment.purpose}`,
      generateReceipt: true,
      allocations: [
        {
          installmentId: installment.id,
          label: installment.purpose,
          amount: remaining,
        },
      ],
    },
    meta,
  )
}

export async function cancelPayment(auth: AuthContext, paymentId: string, body: Record<string, unknown>, meta: AuditMeta) {
  if (!hasPermission(auth.permissions, 'payment:cancel')) {
    throw httpError.accessDenied(PAYMENT_MESSAGES.permissionDenied)
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!reason) throw httpError.validation({ reason: PAYMENT_MESSAGES.reasonRequired })

  try {
    await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({
        where: { id: paymentId },
        include: { serviceOffer: { select: { id: true, leadId: true, offerVersion: true, finalPayable: true, status: true } } },
      })
      if (!payment) throw httpError.notFound(PAYMENT_MESSAGES.notFound)
      await assertCanViewLead(auth, payment.leadId)
      await lockLead(tx, payment.leadId)
      if (payment.status !== 'COMPLETED' && payment.status !== 'PENDING') {
        throw new HttpError(409, PAYMENT_MESSAGES.cancelError, 'CANCEL_NOT_ALLOWED')
      }
      await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledById: auth.user.id,
          cancelReason: reason,
        },
      })
      await rebuildInstallmentsForOffer(tx, payment.serviceOfferId, auth.user.id)
      await syncOfferPaymentFromPayments(tx, payment.serviceOfferId, auth.user.id, meta)
      await writeOfferTimeline(tx, {
        offer: payment.serviceOffer,
        action: 'SERVICE_OFFER_PAYMENT_CANCELLED',
        actorId: auth.user.id,
        meta,
        extra: {
          paymentId: payment.id,
          paymentNumber: payment.paymentNumber,
          amount: money(payment.amount),
          reason,
        },
      })
    })
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(500, PAYMENT_MESSAGES.cancelError, 'CANCEL_ERROR')
  }

  await writeAuditLog({
    userId: auth.user.id,
    action: 'PAYMENT_CANCELLED',
    entityType: 'payment',
    entityId: paymentId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { reason },
  })

  const payment = await loadPayment(paymentId)
  return { payment: payment ? serializePayment(payment) : null, message: 'Payment cancelled.' }
}

export async function reversePayment(auth: AuthContext, paymentId: string, body: Record<string, unknown>, meta: AuditMeta) {
  if (!hasPermission(auth.permissions, 'payment:cancel') && !hasPermission(auth.permissions, 'payment:approve')) {
    throw httpError.accessDenied(PAYMENT_MESSAGES.permissionDenied)
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!reason) throw httpError.validation({ reason: PAYMENT_MESSAGES.reasonRequired })

  try {
    await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({
        where: { id: paymentId },
        include: { serviceOffer: { select: { id: true, leadId: true, offerVersion: true, finalPayable: true, status: true } } },
      })
      if (!payment) throw httpError.notFound(PAYMENT_MESSAGES.notFound)
      await assertCanViewLead(auth, payment.leadId)
      await lockLead(tx, payment.leadId)
      if (payment.status !== 'COMPLETED') {
        throw new HttpError(409, PAYMENT_MESSAGES.reverseError, 'REVERSE_NOT_ALLOWED')
      }
      await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: 'REVERSED',
          reversedAt: new Date(),
          reversedById: auth.user.id,
          reverseReason: reason,
        },
      })
      await rebuildInstallmentsForOffer(tx, payment.serviceOfferId, auth.user.id)
      await syncOfferPaymentFromPayments(tx, payment.serviceOfferId, auth.user.id, meta)
      await writeOfferTimeline(tx, {
        offer: payment.serviceOffer,
        action: 'SERVICE_OFFER_PAYMENT_REVERSED',
        actorId: auth.user.id,
        meta,
        extra: {
          paymentId: payment.id,
          paymentNumber: payment.paymentNumber,
          amount: money(payment.amount),
          reason,
        },
      })
    })
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(500, PAYMENT_MESSAGES.reverseError, 'REVERSE_ERROR')
  }

  await writeAuditLog({
    userId: auth.user.id,
    action: 'PAYMENT_REVERSED',
    entityType: 'payment',
    entityId: paymentId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { reason },
  })

  const payment = await loadPayment(paymentId)
  return { payment: payment ? serializePayment(payment) : null, message: 'Payment reversed.' }
}

export async function getPayment(auth: AuthContext, paymentId: string) {
  if (!hasPermission(auth.permissions, 'payment:view')) throw httpError.accessDenied()
  const payment = await loadPayment(paymentId)
  if (!payment) throw httpError.notFound(PAYMENT_MESSAGES.notFound)
  await assertCanViewLead(auth, payment.leadId)
  return { payment: serializePayment(payment) }
}

export async function getReceipt(auth: AuthContext, receiptId: string) {
  if (!hasPermission(auth.permissions, 'receipt:view') && !hasPermission(auth.permissions, 'payment:view')) {
    throw httpError.accessDenied()
  }
  const receipt = await prisma.receipt.findUnique({
    where: { id: receiptId },
    include: {
      payment: {
        include: { lead: { select: { id: true } } },
      },
      generatedBy: userRef,
    },
  })
  if (!receipt) throw httpError.notFound(PAYMENT_MESSAGES.receiptNotFound)
  await assertCanViewLead(auth, receipt.payment.leadId)
  return {
    receipt: {
      id: receipt.id,
      receiptNumber: receipt.receiptNumber,
      status: receipt.status,
      snapshot: receipt.snapshot,
      generatedAt: receipt.generatedAt.toISOString(),
      generatedBy: receipt.generatedBy,
      paymentId: receipt.paymentId,
      paymentNumber: receipt.payment.paymentNumber,
    },
  }
}

export async function listLeadPaymentHistory(auth: AuthContext, leadId: string) {
  if (!hasPermission(auth.permissions, 'payment:view') && !hasPermission(auth.permissions, 'service:view')) {
    throw httpError.accessDenied()
  }
  await assertCanViewLead(auth, leadId)

  const offers = await prisma.serviceOffer.findMany({
    where: { leadId, status: { in: [...OFFER_PAYABLE_STATUSES, 'PAID'] } },
    orderBy: { offerVersion: 'desc' },
    select: {
      id: true,
      offerVersion: true,
      packageName: true,
      status: true,
      finalPayable: true,
      installments: { orderBy: { sequence: 'asc' }, include: { paidBy: userRef } },
    },
  })

  const active =
    offers.find((offer) => offer.status === 'PARTIALLY_PAID' || offer.status === 'PAYMENT_PENDING') ||
    offers.find((offer) => offer.status === 'PAID') ||
    offers.find((offer) => offer.status === 'ACCEPTED') ||
    null

  const payments = await prisma.payment.findMany({
    where: { leadId },
    include: paymentInclude,
    orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }],
  })

  let finalPayable = 0
  let paidAmount = 0
  let dueAmount = 0
  let offerPaymentStatus: string | null = null
  if (active) {
    finalPayable = Number(active.finalPayable)
    paidAmount = fromCents(await sumCompletedPaidCents(prisma, active.id))
    dueAmount = Math.max(0, finalPayable - paidAmount)
    offerPaymentStatus =
      paidAmount <= 0 ? 'Unpaid' : paidAmount >= finalPayable ? 'Paid' : 'Partially Paid'
  }

  const canRecordPayment = hasPermission(auth.permissions, 'payment:create')
  const canCancelPayment = hasPermission(auth.permissions, 'payment:cancel')
  const canGenerateReceipt =
    hasPermission(auth.permissions, 'receipt:generate') || hasPermission(auth.permissions, 'payment:create')
  const canViewReceipt = hasPermission(auth.permissions, 'receipt:view') || hasPermission(auth.permissions, 'payment:view')

  return {
    summary: {
      finalPayable: money(finalPayable),
      paidAmount: money(paidAmount),
      dueAmount: money(dueAmount),
      currency: 'BDT' as const,
      paymentStatus: offerPaymentStatus,
      activeOffer: active
        ? {
            id: active.id,
            offerVersion: active.offerVersion,
            status: active.status,
            packageName: active.packageName,
          }
        : null,
    },
    permissions: {
      canRecordPayment: Boolean(canRecordPayment && active && OFFER_PAYABLE_STATUSES.includes(active.status as (typeof OFFER_PAYABLE_STATUSES)[number]) && dueAmount > 0),
      canCancelPayment,
      canGenerateReceipt,
      canViewReceipt,
    },
    payments: payments.map(serializePayment),
    // Legacy installment plan for offer panel compatibility
    items: (active?.installments || []).map((item) => ({
      id: item.id,
      offerId: active!.id,
      offerVersion: active!.offerVersion,
      packageName: active!.packageName,
      offerStatus: active!.status,
      sequence: item.sequence,
      purpose: item.purpose,
      amount: money(item.amount),
      dueDate: item.dueDate ? item.dueDate.toISOString().slice(0, 10) : null,
      status: item.status === 'PAID' ? ('PAID' as const) : item.status === 'PARTIAL' ? ('PARTIAL' as const) : ('PENDING' as const),
      paidAt: item.paidAt?.toISOString() ?? null,
      paidBy: item.paidBy,
      canRecord:
        canRecordPayment &&
        Boolean(active && OFFER_PAYABLE_STATUSES.includes(active.status as (typeof OFFER_PAYABLE_STATUSES)[number])) &&
        item.status !== 'PAID',
    })),
  }
}

export async function listPayments(
  auth: AuthContext,
  query: {
    search?: string
    methodCode?: string
    status?: string
    receivedById?: string
    packageName?: string
    dateFrom?: string
    dateTo?: string
    amountMin?: string
    amountMax?: string
    page?: number
    limit?: number
  },
) {
  if (!hasPermission(auth.permissions, 'payment:view')) throw httpError.accessDenied()

  const page = Math.max(1, query.page || 1)
  const limit = Math.min(100, Math.max(1, query.limit || 20))
  const where: Prisma.PaymentWhereInput = {}

  if (query.methodCode) where.methodCode = query.methodCode.toUpperCase()
  if (query.status) where.status = query.status.toUpperCase() as PaymentTxnStatus
  if (query.receivedById) where.receivedById = query.receivedById
  if (query.packageName) {
    where.serviceOffer = { packageName: { contains: query.packageName, mode: 'insensitive' } }
  }
  if (query.dateFrom || query.dateTo) {
    where.paymentDate = {}
    if (query.dateFrom) {
      const from = parseDateOnly(query.dateFrom)
      if (from) where.paymentDate.gte = from
    }
    if (query.dateTo) {
      const to = parseDateOnly(query.dateTo)
      if (to) where.paymentDate.lte = to
    }
  }
  if (query.amountMin || query.amountMax) {
    where.amount = {}
    if (query.amountMin && Number.isFinite(Number(query.amountMin))) where.amount.gte = Number(query.amountMin)
    if (query.amountMax && Number.isFinite(Number(query.amountMax))) where.amount.lte = Number(query.amountMax)
  }
  if (query.search?.trim()) {
    const search = query.search.trim()
    where.OR = [
      { paymentNumber: { contains: search, mode: 'insensitive' } },
      { transactionRef: { contains: search, mode: 'insensitive' } },
      { lead: { code: { contains: search, mode: 'insensitive' } } },
      { lead: { name: { contains: search, mode: 'insensitive' } } },
      { receipt: { receiptNumber: { contains: search, mode: 'insensitive' } } },
    ]
  }

  const [total, rows] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({
      where,
      include: paymentInclude,
      orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
  ])

  return {
    items: rows.map(serializePayment),
    total,
    page,
    limit,
  }
}

export async function paymentCollectionSummary(auth: AuthContext) {
  if (!hasPermission(auth.permissions, 'payment:view')) throw httpError.accessDenied()

  const now = new Date()
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

  const [todayRows, monthRows, completedCount, pendingTxnCount, partialOffers, pendingDueOffers, byEmployee] =
    await Promise.all([
      prisma.payment.findMany({
        where: { status: 'COMPLETED', paymentDate: { gte: startOfToday } },
        select: { amount: true },
      }),
      prisma.payment.findMany({
        where: { status: 'COMPLETED', paymentDate: { gte: startOfMonth } },
        select: { amount: true },
      }),
      prisma.payment.count({ where: { status: 'COMPLETED' } }),
      prisma.payment.count({ where: { status: 'PENDING' } }),
      prisma.serviceOffer.count({ where: { status: 'PARTIALLY_PAID' } }),
      prisma.serviceOffer.findMany({
        where: { status: { in: ['PAYMENT_PENDING', 'PARTIALLY_PAID'] } },
        select: { id: true, finalPayable: true },
      }),
      prisma.payment.groupBy({
        by: ['receivedById'],
        where: { status: 'COMPLETED', paymentDate: { gte: startOfMonth } },
        _sum: { amount: true },
      }),
    ])

  let pendingDueCents = 0
  for (const offer of pendingDueOffers) {
    const paid = await sumCompletedPaidCents(prisma, offer.id)
    pendingDueCents += Math.max(0, cents(offer.finalPayable) - paid)
  }

  const users = await prisma.user.findMany({
    where: { id: { in: byEmployee.map((row) => row.receivedById) } },
    select: { id: true, fullName: true },
  })
  const nameById = new Map(users.map((user) => [user.id, user.fullName]))

  return {
    todayCollection: money(todayRows.reduce((sum, row) => sum + Number(row.amount), 0)),
    monthCollection: money(monthRows.reduce((sum, row) => sum + Number(row.amount), 0)),
    pendingDue: money(fromCents(pendingDueCents)),
    partialPayments: partialOffers,
    completedPayments: completedCount,
    pendingTransactions: pendingTxnCount,
    currency: 'BDT' as const,
    byEmployee: byEmployee
      .map((row) => ({
        userId: row.receivedById,
        name: nameById.get(row.receivedById) || 'Unknown',
        amount: money(Number(row._sum.amount || 0)),
      }))
      .sort((a, b) => Number(b.amount) - Number(a.amount)),
  }
}

export async function listPaymentMethods() {
  const items = await prisma.masterDataItem.findMany({
    where: { categoryKey: 'PAYMENT_METHOD', status: 'ACTIVE' },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: { code: true, name: true },
  })
  if (items.length) {
    return {
      items: items.map((item) => ({
        code: (item.code || item.name).toUpperCase(),
        name: item.name,
        requiresTransaction: METHODS_REQUIRE_TXN.has((item.code || '').toUpperCase()),
        requiresDescription: METHODS_REQUIRE_DESCRIPTION.has((item.code || '').toUpperCase()),
      })),
    }
  }
  return {
    items: DEFAULT_METHOD_CATALOG.map((item) => ({
      ...item,
      requiresTransaction: METHODS_REQUIRE_TXN.has(item.code),
      requiresDescription: METHODS_REQUIRE_DESCRIPTION.has(item.code),
    })),
  }
}
