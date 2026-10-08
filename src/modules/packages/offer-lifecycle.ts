import type { Prisma, ServiceOfferStatus } from '../../lib/prisma-client'
import { httpError } from '../../lib/http-error'
import { prisma } from '../../lib/prisma'
import {
  isProcessGatedBehavior,
  isTerminalBehavior,
  resolveLeadStatus,
  type LeadStatusItem,
} from '../leads/lead-status'

export type AuditMeta = { ipAddress?: string; userAgent?: string }

export const LIFECYCLE_MESSAGES = {
  notFound: 'The requested service offer could not be found.',
  invalidTransition: 'This offer status change is not allowed.',
  permissionDenied: 'You do not have permission to modify this offer.',
  acceptedLocked: 'An accepted offer cannot be edited directly. Create a new version instead.',
  sentLocked: 'This offer has already been sent to the student. Create a new version to change it.',
  cancelReason: 'Please provide a reason for cancelling this offer.',
  paidReplace: 'The currently accepted offer has already received a payment and cannot be replaced.',
  deleteDenied: 'Only an unused draft can be deleted. Cancel the offer instead to keep its history.',
  paymentState: 'Payments can only be recorded against an accepted offer awaiting payment.',
  installmentPaid: 'This installment has already been paid.',
}

export const STATUS_LABEL: Record<ServiceOfferStatus, string> = {
  DRAFT: 'Draft',
  GENERATED: 'Generated',
  SENT: 'Sent',
  ACCEPTED: 'Accepted',
  PAYMENT_PENDING: 'Payment Pending',
  PARTIALLY_PAID: 'Partially Paid',
  PAID: 'Paid',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
}

const TRANSITIONS: Record<ServiceOfferStatus, readonly ServiceOfferStatus[]> = {
  DRAFT: ['GENERATED', 'CANCELLED'],
  GENERATED: ['SENT', 'CANCELLED'],
  SENT: ['ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED'],
  ACCEPTED: ['PAYMENT_PENDING', 'CANCELLED'],
  PAYMENT_PENDING: ['PARTIALLY_PAID', 'PAID', 'CANCELLED'],
  /** Payment cancel/reverse may move Paid / Partially Paid back toward Payment Pending. */
  PARTIALLY_PAID: ['PAID', 'PAYMENT_PENDING'],
  PAID: ['PARTIALLY_PAID', 'PAYMENT_PENDING'],
  REJECTED: [],
  EXPIRED: [],
  CANCELLED: [],
}

/** Statuses in which the offer is the Lead's accepted/active commercial agreement. */
export const ACTIVE_STATUSES: ServiceOfferStatus[] = ['ACCEPTED', 'PAYMENT_PENDING', 'PARTIALLY_PAID', 'PAID']
/** Statuses that are still being negotiated with the student. */
export const OPEN_STATUSES: ServiceOfferStatus[] = ['DRAFT', 'GENERATED', 'SENT']
/** Statuses from which a new version may be created. Draft/Generated are edited in place instead. */
export const REVISABLE_STATUSES: ServiceOfferStatus[] = ['SENT', 'REJECTED', 'EXPIRED', 'CANCELLED', 'ACCEPTED', 'PAYMENT_PENDING']

export function allowAcceptWithoutSending() {
  return process.env.SERVICE_OFFER_ALLOW_ACCEPT_WITHOUT_SENDING === 'true'
}

export function offerValidityDays() {
  const configured = Number(process.env.SERVICE_OFFER_VALIDITY_DAYS)
  return Number.isInteger(configured) && configured >= 0 ? configured : 14
}

export function allowedTransitions(from: ServiceOfferStatus): ServiceOfferStatus[] {
  const next = [...TRANSITIONS[from]]
  if (from === 'GENERATED' && allowAcceptWithoutSending()) next.push('ACCEPTED')
  return next
}

export function canTransition(from: ServiceOfferStatus, to: ServiceOfferStatus) {
  return allowedTransitions(from).includes(to)
}

type OfferRef = {
  id: string
  leadId: string
  status: ServiceOfferStatus
  offerVersion: number
  finalPayable: { toString(): string }
}

type TimelineInput = {
  offer: Pick<OfferRef, 'id' | 'leadId' | 'offerVersion' | 'finalPayable'>
  action: string
  actorId: string | null
  from?: ServiceOfferStatus | null
  to?: ServiceOfferStatus | null
  reason?: string | null
  extra?: Record<string, Prisma.InputJsonValue | null>
  meta?: AuditMeta
}

/** Lead Timeline entry: the activity feed lists audit rows whose entity is the Lead. */
export async function writeOfferTimeline(tx: Prisma.TransactionClient, input: TimelineInput) {
  await tx.auditLog.create({
    data: {
      userId: input.actorId,
      action: input.action,
      entityType: 'lead',
      entityId: input.offer.leadId,
      ipAddress: input.meta?.ipAddress,
      userAgent: input.meta?.userAgent,
      metadata: {
        offerId: input.offer.id,
        offerVersion: input.offer.offerVersion,
        finalPayable: Number(input.offer.finalPayable).toFixed(2),
        fromStatus: input.from ?? null,
        toStatus: input.to ?? null,
        from: input.from ? STATUS_LABEL[input.from] : null,
        to: input.to ? STATUS_LABEL[input.to] : null,
        reason: input.reason ?? null,
        ...input.extra,
      },
    },
  })
}

export async function recordInitialStatus(
  tx: Prisma.TransactionClient,
  offer: Pick<OfferRef, 'id' | 'leadId' | 'offerVersion' | 'finalPayable'>,
  actorId: string,
  action: string,
  meta?: AuditMeta,
  extra?: Record<string, Prisma.InputJsonValue | null>,
) {
  await tx.serviceOfferStatusHistory.create({
    data: { serviceOfferId: offer.id, fromStatus: null, toStatus: 'DRAFT', changedById: actorId },
  })
  await writeOfferTimeline(tx, { offer, action, actorId, to: 'DRAFT', meta, extra })
}

/**
 * The only way an offer's status may change. Enforces the lifecycle, guards against
 * concurrent changes, and writes both the offer status history and the Lead Timeline.
 */
export async function changeOfferStatus(
  tx: Prisma.TransactionClient,
  input: {
    offer: OfferRef
    to: ServiceOfferStatus
    actorId: string | null
    reason?: string | null
    data?: Prisma.ServiceOfferUncheckedUpdateManyInput
    meta?: AuditMeta
  },
) {
  const { offer, to, actorId } = input
  if (!canTransition(offer.status, to)) {
    throw httpError.conflict(LIFECYCLE_MESSAGES.invalidTransition, 'INVALID_OFFER_TRANSITION')
  }
  const updated = await tx.serviceOffer.updateMany({
    where: { id: offer.id, status: offer.status },
    data: { ...input.data, status: to, ...(actorId ? { updatedById: actorId } : {}) },
  })
  if (!updated.count) throw httpError.conflict(LIFECYCLE_MESSAGES.invalidTransition, 'INVALID_OFFER_TRANSITION')
  await tx.serviceOfferStatusHistory.create({
    data: { serviceOfferId: offer.id, fromStatus: offer.status, toStatus: to, reason: input.reason ?? null, changedById: actorId },
  })
  await writeOfferTimeline(tx, {
    offer,
    action: 'SERVICE_OFFER_STATUS_CHANGED',
    actorId,
    from: offer.status,
    to,
    reason: input.reason,
    meta: input.meta,
  })
  return { ...offer, status: to }
}

/** Serializes lifecycle changes per Lead so only one offer can become active at a time. */
export async function lockLead(tx: Prisma.TransactionClient, leadId: string) {
  await tx.$queryRaw`SELECT id FROM leads WHERE id = ${leadId}::uuid FOR UPDATE`
}

export async function nextOfferVersion(tx: Prisma.TransactionClient, leadId: string) {
  const latest = await tx.serviceOffer.aggregate({ where: { leadId }, _max: { offerVersion: true } })
  return (latest._max.offerVersion ?? 0) + 1
}

/**
 * Moves an accepted offer between Payment Pending, Partially Paid, and Paid.
 * Prefers completed Payment rows; falls back to installment PAID sums for legacy data.
 */
export async function syncOfferPaymentStatus(
  tx: Prisma.TransactionClient,
  offerId: string,
  actorId: string | null,
  meta?: AuditMeta,
) {
  const offer = await tx.serviceOffer.findUniqueOrThrow({
    where: { id: offerId },
    include: {
      installments: { select: { amount: true, status: true } },
      payments: { where: { status: 'COMPLETED' }, select: { amount: true } },
    },
  })
  if (!['PAYMENT_PENDING', 'PARTIALLY_PAID', 'PAID'].includes(offer.status)) return offer.status
  const total = Math.round(Number(offer.finalPayable) * 100)
  const paidFromPayments = offer.payments.reduce(
    (sum, item) => sum + Math.round(Number(item.amount) * 100),
    0,
  )
  const paidFromInstallments = offer.installments
    .filter((item) => item.status === 'PAID')
    .reduce((sum, item) => sum + Math.round(Number(item.amount) * 100), 0)
  const paid = offer.payments.length > 0 ? paidFromPayments : paidFromInstallments
  const target: ServiceOfferStatus = paid >= total ? 'PAID' : paid > 0 ? 'PARTIALLY_PAID' : 'PAYMENT_PENDING'
  if (target === offer.status) return offer.status
  await changeOfferStatus(tx, { offer, to: target, actorId, meta })
  return target
}

/**
 * Advances the lead pipeline from offer/payment events.
 * - OFFERED: when an offer is generated or sent (CRM status “a service/package offer has been made”).
 * - CONVERTED: when the first payment is recorded or a zero-value offer is accepted
 *   (acceptance alone does not convert — CRM-009; payment does).
 * Never moves backwards, and never touches File Opening / terminal statuses.
 */
export async function advanceLeadPipelineStatus(
  tx: Prisma.TransactionClient,
  input: {
    leadId: string
    actorId: string
    targetCode: 'OFFERED' | 'CONVERTED'
    remarks: string
    meta?: AuditMeta
  },
) {
  const rows = await tx.masterDataItem.findMany({
    where: { categoryKey: 'LEAD_STATUS' },
    select: { name: true, code: true, behaviorKey: true, sortOrder: true, status: true },
  })
  const items: LeadStatusItem[] = rows.map((row) => ({
    name: row.name,
    code: row.code,
    behaviorKey: row.behaviorKey,
    sortOrder: row.sortOrder,
    status: row.status,
  }))
  const lead = await tx.lead.findUniqueOrThrow({
    where: { id: input.leadId },
    select: { id: true, status: true, statusCode: true },
  })
  const current = resolveLeadStatus(lead, items)
  if (!current) return { changed: false as const }

  if (isTerminalBehavior(current.behaviorKey) || current.behaviorKey === 'file_opened') {
    return { changed: false as const }
  }
  if (input.targetCode === 'OFFERED' && isProcessGatedBehavior(current.behaviorKey)) {
    return { changed: false as const }
  }
  if (
    input.targetCode === 'CONVERTED' &&
    (current.behaviorKey === 'converted' ||
      current.behaviorKey === 'file_opening_pending' ||
      current.behaviorKey === 'file_opened')
  ) {
    return { changed: false as const }
  }

  const target = items.find((item) => item.code === input.targetCode && item.status === 'ACTIVE')
  if (!target?.code) return { changed: false as const }
  if (current.code === target.code) return { changed: false as const }
  if (input.targetCode === 'OFFERED' && current.sortOrder >= target.sortOrder) {
    return { changed: false as const }
  }

  await tx.lead.update({
    where: { id: input.leadId },
    data: { status: target.name, statusCode: target.code, updatedById: input.actorId },
  })
  await tx.leadStatusHistory.create({
    data: {
      leadId: input.leadId,
      previousStatus: current.name,
      previousStatusCode: current.code || null,
      newStatus: target.name,
      newStatusCode: target.code,
      remarks: input.remarks,
      isOverride: false,
      createdById: input.actorId,
    },
  })
  await tx.auditLog.create({
    data: {
      userId: input.actorId,
      action: 'LEAD_STATUS_CHANGED',
      entityType: 'Lead',
      entityId: input.leadId,
      ipAddress: input.meta?.ipAddress,
      userAgent: input.meta?.userAgent,
      metadata: {
        fromStatus: current.name,
        fromStatusCode: current.code,
        toStatus: target.name,
        toStatusCode: target.code,
        remarks: input.remarks,
        source: 'service_offer',
      },
    },
  })
  return { changed: true as const, from: current.name, to: target.name }
}

/** Expires Sent offers whose validity period has passed. Returns the number expired. */
export async function expireOverdueOffers(where: Prisma.ServiceOfferWhereInput = {}) {
  const due = await prisma.serviceOffer.findMany({
    where: { ...where, status: 'SENT', validUntil: { lt: new Date() } },
    select: { id: true, leadId: true, status: true, offerVersion: true, finalPayable: true },
    take: 200,
  })
  let expired = 0
  for (const offer of due) {
    try {
      await prisma.$transaction((tx) =>
        changeOfferStatus(tx, { offer, to: 'EXPIRED', actorId: null, reason: 'Validity period ended without acceptance' }),
      )
      expired += 1
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'INVALID_OFFER_TRANSITION')) throw error
    }
  }
  return expired
}

/** CRM-009 prerequisite (Rule-5): conversion requires an accepted offer but is never triggered by it. */
export async function hasAcceptedServiceOffer(leadId: string) {
  const count = await prisma.serviceOffer.count({ where: { leadId, status: { in: ACTIVE_STATUSES } } })
  return count > 0
}
