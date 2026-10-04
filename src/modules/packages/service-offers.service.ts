import type { DiscountType, OfferLineKind, Prisma, ServiceOfferStatus } from '../../lib/prisma-client'
import { HttpError, httpError } from '../../lib/http-error'
import { prisma } from '../../lib/prisma'
import { hasPermission } from '../auth/access'
import type { AuthContext } from '../auth/session.service'
import { createSystemFollowUp, daysFromNow } from '../follow-ups/system-follow-up'
import { assertCanViewLead } from '../leads/leads.helpers'
import { calculateOffer, type CalculatorDiscount } from './offer-calculator'
import {
  ACTIVE_STATUSES,
  LIFECYCLE_MESSAGES,
  OPEN_STATUSES,
  REVISABLE_STATUSES,
  allowedTransitions,
  changeOfferStatus,
  expireOverdueOffers,
  lockLead,
  nextOfferVersion,
  offerValidityDays,
  recordInitialStatus,
  syncOfferPaymentStatus,
  writeOfferTimeline,
  type AuditMeta,
} from './offer-lifecycle'

type Fields = Record<string, string>

const MAX_AMOUNT = 999999999999.99
const MAX_QUANTITY = 9999
const EDITABLE_LINE_KINDS = ['PACKAGE_OPTIONAL', 'SERVICE', 'ADDITIONAL', 'CUSTOM_SERVICE', 'CUSTOM_CHARGE'] as const
const CUSTOM_LINE_KINDS = new Set<OfferLineKind>(['CUSTOM_SERVICE', 'CUSTOM_CHARGE'])
const CATALOG_LINE_KINDS = new Set<OfferLineKind>(['SERVICE', 'ADDITIONAL'])

export const MESSAGES = {
  noService: 'Please add at least one service before saving the offer.',
  invalidQuantity: 'Quantity must be at least 1.',
  discountExceedsSubtotal: 'Discount value cannot exceed the subtotal.',
  discountExceedsLine: 'Discount value cannot exceed the line total.',
  discountReason: 'Please provide a reason for the applied discount.',
  priceOverride: 'You are not authorized to change the service price.',
  inactive: 'This service or package is currently inactive.',
  permissionDenied: 'You do not have permission to create or modify this offer.',
  saveFailed: 'Unable to save the service offer. Please try again.',
  calculation: 'Unable to calculate the final payable amount.',
  discountDenied: 'You do not have permission to apply discounts.',
  customDenied: 'You do not have permission to add custom services or charges.',
  closedLocked: 'This offer is closed. Create a new version to change it.',
  reviseDenied: 'A new version can only be created from an offer that has been sent or closed.',
}

function lockedMessage(status: ServiceOfferStatus) {
  if (ACTIVE_STATUSES.includes(status)) return LIFECYCLE_MESSAGES.acceptedLocked
  if (status === 'SENT') return LIFECYCLE_MESSAGES.sentLocked
  return MESSAGES.closedLocked
}

export function discountLimitPercent() {
  const configured = Number(process.env.SERVICE_OFFER_DISCOUNT_LIMIT_PERCENT)
  return Number.isFinite(configured) && configured >= 0 && configured <= 100 ? configured : 10
}

const userRef = { select: { id: true, fullName: true } }

const offerInclude = {
  items: { orderBy: { sortOrder: 'asc' as const } },
  installments: { orderBy: { sequence: 'asc' as const }, include: { paidBy: userRef } },
  generatedBy: userRef,
  createdBy: userRef,
  updatedBy: userRef,
  sentBy: userRef,
  acceptedBy: userRef,
  cancelledBy: userRef,
  revisedFrom: { select: { id: true, offerVersion: true } },
  statusHistory: { orderBy: { createdAt: 'asc' as const }, include: { changedBy: userRef } },
} satisfies Prisma.ServiceOfferInclude

type OfferRow = Prisma.ServiceOfferGetPayload<{ include: typeof offerInclude }>

function money(value: { toString(): string } | string | number) {
  return Number(value).toFixed(2)
}

function moneyOrNull(value: { toString(): string } | null | undefined) {
  return value == null ? null : money(value)
}

function serialize(row: OfferRow) {
  const finalPayable = Number(row.finalPayable)
  const initialPayment = row.initialPayment == null ? null : Number(row.initialPayment)
  const paid = row.installments
    .filter((item) => item.status === 'PAID')
    .reduce((sum, item) => sum + Math.round(Number(item.amount) * 100), 0)
  return {
    id: row.id,
    leadId: row.leadId,
    status: row.status,
    offerVersion: row.offerVersion,
    revisedFrom: row.revisedFrom,
    allowedTransitions: allowedTransitions(row.status),
    revisable: REVISABLE_STATUSES.includes(row.status),
    sourcePackageId: row.sourcePackageId,
    sourcePackageVersionId: row.sourcePackageVersionId,
    packageName: row.packageName,
    versionNumber: row.versionNumber,
    packageDefaultPrice: moneyOrNull(row.packageDefaultPrice),
    packagePrice: moneyOrNull(row.packagePrice),
    individualTotal: money(row.individualTotal),
    saving: money(row.saving),
    fileOpeningDefault: moneyOrNull(row.fileOpeningDefault),
    fileOpeningCharge: money(row.fileOpeningCharge),
    grossTotal: money(row.grossTotal),
    lineDiscountTotal: money(row.lineDiscountTotal),
    subtotal: money(row.subtotal),
    overallDiscountType: row.overallDiscountType,
    overallDiscountValue: moneyOrNull(row.overallDiscountValue),
    overallDiscountAmount: money(row.overallDiscountAmount),
    overallDiscountReason: row.overallDiscountReason,
    finalPayable: money(finalPayable),
    expectedDealValue: money(row.expectedDealValue ?? finalPayable),
    initialPayment: initialPayment == null ? null : money(initialPayment),
    remainingAfterInitial: money(finalPayable - (initialPayment ?? 0)),
    paidAmount: money(paid / 100),
    dueAmount: money((Math.round(finalPayable * 100) - paid) / 100),
    currency: 'BDT' as const,
    items: row.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      serviceItemId: item.serviceItemId,
      serviceName: item.serviceName,
      remarks: item.remarks,
      defaultPrice: moneyOrNull(item.defaultPrice),
      offeredPrice: money(item.offeredPrice),
      quantity: item.quantity,
      discountType: item.discountType,
      discountValue: moneyOrNull(item.discountValue),
      discountAmount: money(item.discountAmount),
      discountReason: item.discountReason,
      lineTotal: money(item.lineTotal),
      sortOrder: item.sortOrder,
    })),
    installments: row.installments.map((item) => ({
      id: item.id,
      sequence: item.sequence,
      amount: money(item.amount),
      purpose: item.purpose,
      dueDate: item.dueDate ? item.dueDate.toISOString().slice(0, 10) : null,
      status: item.status,
      paidAt: item.paidAt?.toISOString() ?? null,
      paidBy: item.paidBy,
    })),
    statusHistory: row.statusHistory.map((entry) => ({
      id: entry.id,
      fromStatus: entry.fromStatus,
      toStatus: entry.toStatus,
      reason: entry.reason,
      changedBy: entry.changedBy,
      createdAt: entry.createdAt.toISOString(),
    })),
    generatedAt: row.generatedAt?.toISOString() ?? null,
    generatedBy: row.generatedBy,
    sentAt: row.sentAt?.toISOString() ?? null,
    sentBy: row.sentBy,
    validUntil: row.validUntil?.toISOString() ?? null,
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    acceptedBy: row.acceptedBy,
    acceptedSnapshot: row.acceptedSnapshot,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    rejectionReason: row.rejectionReason,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelledBy: row.cancelledBy,
    cancelReason: row.cancelReason,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** Returns undefined when empty, NaN when malformed, otherwise the amount. */
function readAmount(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const raw = typeof value === 'number' || typeof value === 'string' ? String(value).trim() : ''
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return Number.NaN
  const amount = Number(raw)
  return amount <= MAX_AMOUNT ? amount : Number.NaN
}

function readText(value: unknown, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function samePrice(left: number, right: number) {
  return Math.round(left * 100) === Math.round(right * 100)
}

type DiscountInput = { discount: CalculatorDiscount; type: DiscountType | null; reason: string | null }

type DiscountKeys = { type: string; value: string; reason: string }

/** `keys` name the body properties; `fieldKeys` name the matching validation error keys. */
function readDiscount(
  source: Record<string, unknown>,
  keys: DiscountKeys,
  fieldKeys: DiscountKeys,
  fields: Fields,
): DiscountInput {
  const value = readAmount(source[keys.value])
  if (value === undefined || value === 0) return { discount: null, type: null, reason: null }
  const typeRaw = source[keys.type]
  const type: DiscountType = typeRaw === 'PERCENTAGE' ? 'PERCENTAGE' : 'AMOUNT'
  if (typeRaw !== undefined && typeRaw !== null && typeRaw !== 'AMOUNT' && typeRaw !== 'PERCENTAGE') {
    fields[fieldKeys.type] = 'Please choose Amount or Percentage.'
  }
  if (Number.isNaN(value)) {
    fields[fieldKeys.value] = 'Please enter a valid discount.'
    return { discount: null, type: null, reason: null }
  }
  if (type === 'PERCENTAGE' && value > 100) {
    fields[fieldKeys.value] = 'A percentage discount cannot exceed 100%.'
  }
  const reason = readText(source[keys.reason], 500)
  if (!reason) fields[fieldKeys.reason] = MESSAGES.discountReason
  return { discount: { type, value }, type, reason: reason || null }
}

const LINE_DISCOUNT_KEYS: DiscountKeys = { type: 'discountType', value: 'discountValue', reason: 'discountReason' }
const OVERALL_DISCOUNT_KEYS: DiscountKeys = {
  type: 'overallDiscountType',
  value: 'overallDiscountValue',
  reason: 'overallDiscountReason',
}

async function countryFileOpeningDefault(preferredCountryCode: string | null) {
  if (!preferredCountryCode) return null
  const country = await prisma.masterDataItem.findFirst({
    where: { categoryKey: 'COUNTRY', code: preferredCountryCode },
    select: { id: true, name: true, extras: true },
  })
  if (!country) return null
  const extras = asRecord(country.extras)
  const amount = readAmount(extras?.fileOpeningCharge)
  return {
    countryId: country.id,
    countryName: country.name,
    amount: amount === undefined || Number.isNaN(amount) ? null : amount,
  }
}

function assertCanOffer(auth: AuthContext) {
  if (!hasPermission(auth.permissions, 'service:offer')) throw httpError.accessDenied(MESSAGES.permissionDenied)
}

export async function listLeadServiceOffers(auth: AuthContext, leadId: string) {
  if (!hasPermission(auth.permissions, 'service:view')) throw httpError.accessDenied()
  await assertCanViewLead(auth, leadId)
  await expireOverdueOffers({ leadId })
  const rows = await prisma.serviceOffer.findMany({
    where: { leadId },
    include: offerInclude,
    orderBy: [{ offerVersion: 'desc' }, { createdAt: 'desc' }],
  })
  return { offers: rows.map(serialize) }
}

export async function serviceOfferContext(auth: AuthContext, leadId: string) {
  if (!hasPermission(auth.permissions, 'service:view')) throw httpError.accessDenied()
  const lead = await assertCanViewLead(auth, leadId)
  const fileOpening = await countryFileOpeningDefault(lead.preferredCountryCode)
  return {
    lead: {
      id: lead.id,
      name: lead.name,
      preferredCountryCode: lead.preferredCountryCode,
      preferredCountryName: fileOpening?.countryName ?? null,
    },
    fileOpeningChargeDefault: fileOpening?.amount == null ? '0.00' : money(fileOpening.amount),
    discountLimitPercent: discountLimitPercent(),
    permissions: {
      canOffer: hasPermission(auth.permissions, 'service:offer'),
      canDiscount: hasPermission(auth.permissions, 'service:discount'),
      canApproveDiscount: hasPermission(auth.permissions, 'service:discount_approve'),
      canOverridePrice: hasPermission(auth.permissions, 'service:price_override'),
      canCustomCharge: hasPermission(auth.permissions, 'service:custom_charge'),
      canRecordPayment: hasPermission(auth.permissions, 'payment:create'),
    },
  }
}

type PackageSnapshot = {
  packageId: string
  versionId: string
  packageName: string
  versionNumber: number
  defaultPrice: number
  items: Array<{
    serviceItemId: string
    serviceName: string
    inclusion: 'INCLUDED' | 'OPTIONAL'
    unitPrice: number
    sortOrder: number
  }>
}

const versionInclude = {
  items: {
    include: { serviceItem: { select: { id: true, name: true } } },
    orderBy: { sortOrder: 'asc' as const },
  },
} satisfies Prisma.PackageVersionInclude

async function resolvePackage(
  packageId: string,
  lead: { preferredCountryCode: string | null },
  existing: ExistingOffer | null,
  fields: Fields,
): Promise<PackageSnapshot | null> {
  const keepsSnapshot = existing?.sourcePackageId === packageId && existing.sourcePackageVersionId
  if (keepsSnapshot) {
    const version = await prisma.packageVersion.findUnique({
      where: { id: existing.sourcePackageVersionId! },
      include: versionInclude,
    })
    if (version) {
      const names = new Map(existing.items.map((item) => [item.serviceItemId, item.serviceName]))
      return {
        packageId,
        versionId: version.id,
        packageName: existing.packageName || '',
        versionNumber: version.versionNumber,
        defaultPrice: Number(existing.packageDefaultPrice ?? version.price),
        items: version.items.map((item) => ({
          serviceItemId: item.serviceItemId,
          serviceName: names.get(item.serviceItemId) || item.serviceItem.name,
          inclusion: item.inclusion,
          unitPrice: Number(item.unitPrice),
          sortOrder: item.sortOrder,
        })),
      }
    }
  }

  const source = await prisma.package.findUnique({
    where: { id: packageId },
    include: { country: { select: { code: true } }, currentVersion: { include: versionInclude } },
  })
  if (!source || !source.currentVersion) {
    fields.packageId = 'Package not found.'
    return null
  }
  if (source.status !== 'ACTIVE') {
    throw new HttpError(400, MESSAGES.inactive, 'INACTIVE_PACKAGE', { packageId: MESSAGES.inactive })
  }
  if (source.country?.code && lead.preferredCountryCode && source.country.code !== lead.preferredCountryCode) {
    fields.packageId = "This package is not available for the lead's preferred country."
    return null
  }
  const version = source.currentVersion
  return {
    packageId: source.id,
    versionId: version.id,
    packageName: source.name,
    versionNumber: version.versionNumber,
    defaultPrice: Number(version.price),
    items: version.items.map((item) => ({
      serviceItemId: item.serviceItemId,
      serviceName: item.serviceItem.name,
      inclusion: item.inclusion,
      unitPrice: Number(item.unitPrice),
      sortOrder: item.sortOrder,
    })),
  }
}

type ExistingOffer = Prisma.ServiceOfferGetPayload<{ include: { items: true } }>

type PreparedLine = {
  /** Position in the submitted `lines` array; null for package included lines. */
  inputIndex: number | null
  kind: OfferLineKind
  serviceItemId: string | null
  serviceName: string
  remarks: string | null
  inclusion: 'INCLUDED' | 'OPTIONAL' | null
  defaultPrice: number | null
  offeredPrice: number
  quantity: number
  discount: DiscountInput
}

async function prepareOffer(auth: AuthContext, lead: LeadRow, body: Record<string, unknown>, existing: ExistingOffer | null) {
  const fields: Fields = {}
  const canDiscount = hasPermission(auth.permissions, 'service:discount')
  const canOverride = hasPermission(auth.permissions, 'service:price_override')
  const canCustom = hasPermission(auth.permissions, 'service:custom_charge')

  const packageId = readText(body.packageId, 64)
  const snapshot = packageId ? await resolvePackage(packageId, lead, existing, fields) : null

  let packagePrice: number | null = null
  if (snapshot) {
    const requested = readAmount(body.packagePrice)
    if (requested !== undefined && Number.isNaN(requested)) {
      fields.packagePrice = 'Please enter a valid price.'
    } else {
      packagePrice = requested ?? snapshot.defaultPrice
      if (!samePrice(packagePrice, snapshot.defaultPrice) && !canOverride) {
        throw httpError.accessDenied(MESSAGES.priceOverride)
      }
    }
  }

  const prepared: PreparedLine[] = []
  for (const item of snapshot?.items.filter((entry) => entry.inclusion === 'INCLUDED') ?? []) {
    prepared.push({
      inputIndex: null,
      kind: 'PACKAGE_INCLUDED',
      serviceItemId: item.serviceItemId,
      serviceName: item.serviceName,
      remarks: null,
      inclusion: 'INCLUDED',
      defaultPrice: item.unitPrice,
      offeredPrice: item.unitPrice,
      quantity: 1,
      discount: { discount: null, type: null, reason: null },
    })
  }

  const rawLines = body.lines === undefined ? [] : body.lines
  if (!Array.isArray(rawLines)) throw httpError.validation({ lines: MESSAGES.noService }, MESSAGES.noService)

  const existingCatalog = new Map(
    (existing?.items ?? [])
      .filter((item) => item.serviceItemId && CATALOG_LINE_KINDS.has(item.kind))
      .map((item) => [item.serviceItemId!, item]),
  )
  const catalogIds = rawLines
    .map((entry) => asRecord(entry))
    .filter((entry) => entry && CATALOG_LINE_KINDS.has(entry.kind as OfferLineKind))
    .map((entry) => readText(entry!.serviceItemId, 64))
    .filter((id) => id && !existingCatalog.has(id))
  const catalogRows = catalogIds.length
    ? await prisma.serviceItem.findMany({
        where: { id: { in: catalogIds } },
        select: { id: true, name: true, status: true, defaultPrice: true },
      })
    : []
  const catalog = new Map(catalogRows.map((row) => [row.id, row]))
  const optionalItems = new Map(
    (snapshot?.items ?? []).filter((item) => item.inclusion === 'OPTIONAL').map((item) => [item.serviceItemId, item]),
  )

  rawLines.forEach((entry, index) => {
    const key = `lines.${index}`
    const line = asRecord(entry)
    if (!line) {
      fields[key] = 'This line is invalid.'
      return
    }
    const kind = line.kind as OfferLineKind
    if (!(EDITABLE_LINE_KINDS as readonly string[]).includes(kind)) {
      fields[key] = 'This line is invalid.'
      return
    }

    let serviceItemId: string | null = null
    let serviceName = ''
    let defaultPrice: number | null = null
    let inclusion: 'OPTIONAL' | null = null

    if (CUSTOM_LINE_KINDS.has(kind)) {
      if (!canCustom) throw httpError.accessDenied(MESSAGES.customDenied)
      serviceName = readText(line.name, 160)
      if (!serviceName) fields[`${key}.name`] = 'Name is required.'
    } else if (kind === 'PACKAGE_OPTIONAL') {
      serviceItemId = readText(line.serviceItemId, 64)
      const optional = optionalItems.get(serviceItemId)
      if (!optional) {
        fields[key] = 'This optional service is not part of the selected package.'
        return
      }
      serviceName = optional.serviceName
      defaultPrice = optional.unitPrice
      inclusion = 'OPTIONAL'
    } else {
      serviceItemId = readText(line.serviceItemId, 64)
      const kept = existingCatalog.get(serviceItemId)
      if (kept) {
        serviceName = kept.serviceName
        defaultPrice = kept.defaultPrice == null ? Number(kept.offeredPrice) : Number(kept.defaultPrice)
      } else {
        const row = catalog.get(serviceItemId)
        if (!row) {
          fields[key] = 'Service item not found.'
          return
        }
        if (row.status !== 'ACTIVE') {
          throw new HttpError(400, MESSAGES.inactive, 'INACTIVE_SERVICE', { [key]: MESSAGES.inactive })
        }
        serviceName = row.name
        defaultPrice = Number(row.defaultPrice)
      }
    }

    const priceInput = readAmount(CUSTOM_LINE_KINDS.has(kind) ? (line.amount ?? line.offeredPrice) : line.offeredPrice)
    let offeredPrice = 0
    if (CUSTOM_LINE_KINDS.has(kind)) {
      if (priceInput === undefined || Number.isNaN(priceInput) || priceInput <= 0) {
        fields[`${key}.amount`] = 'Please enter a valid amount.'
      } else {
        offeredPrice = priceInput
      }
    } else if (priceInput !== undefined && Number.isNaN(priceInput)) {
      fields[`${key}.offeredPrice`] = 'Please enter a valid price.'
    } else {
      offeredPrice = priceInput ?? defaultPrice ?? 0
      if (defaultPrice != null && !samePrice(offeredPrice, defaultPrice) && !canOverride) {
        throw httpError.accessDenied(MESSAGES.priceOverride)
      }
    }

    const quantityRaw = line.quantity === undefined || line.quantity === null || line.quantity === '' ? 1 : Number(line.quantity)
    if (!Number.isInteger(quantityRaw) || quantityRaw < 1 || quantityRaw > MAX_QUANTITY) {
      fields[`${key}.quantity`] = MESSAGES.invalidQuantity
    }

    const discount = readDiscount(
      line,
      LINE_DISCOUNT_KEYS,
      { type: `${key}.discountType`, value: `${key}.discountValue`, reason: `${key}.discountReason` },
      fields,
    )
    if (discount.discount && !canDiscount) throw httpError.accessDenied(MESSAGES.discountDenied)

    prepared.push({
      inputIndex: index,
      kind,
      serviceItemId,
      serviceName,
      remarks: readText(line.remarks, 500) || null,
      inclusion,
      defaultPrice,
      offeredPrice,
      quantity: Number.isInteger(quantityRaw) ? quantityRaw : 1,
      discount,
    })
  })

  const seen = new Set<string>()
  for (const line of prepared) {
    if (!line.serviceItemId) continue
    if (seen.has(line.serviceItemId)) {
      fields[line.inputIndex == null ? 'lines' : `lines.${line.inputIndex}`] = 'This service is already on the offer.'
    }
    seen.add(line.serviceItemId)
  }

  if (!prepared.some((line) => line.kind !== 'CUSTOM_CHARGE')) {
    throw httpError.validation({ ...fields, lines: MESSAGES.noService }, MESSAGES.noService)
  }

  const fileOpening = await countryFileOpeningDefault(lead.preferredCountryCode)
  const fileOpeningInput = readAmount(body.fileOpeningCharge)
  let fileOpeningCharge = 0
  if (fileOpeningInput !== undefined && Number.isNaN(fileOpeningInput)) {
    fields.fileOpeningCharge = 'Please enter a valid amount.'
  } else {
    fileOpeningCharge =
      fileOpeningInput ?? (existing ? Number(existing.fileOpeningCharge) : (fileOpening?.amount ?? 0))
  }

  const overall = readDiscount(body, OVERALL_DISCOUNT_KEYS, OVERALL_DISCOUNT_KEYS, fields)
  if (overall.discount && !canDiscount) throw httpError.accessDenied(MESSAGES.discountDenied)

  if (Object.keys(fields).length) throw httpError.validation(fields)

  let totals: ReturnType<typeof calculateOffer>
  try {
    totals = calculateOffer({
      packagePrice,
      fileOpeningCharge,
      overallDiscount: overall.discount,
      lines: prepared.map((line) => ({
        countsTowardTotal: line.kind !== 'PACKAGE_INCLUDED',
        price: line.offeredPrice,
        quantity: line.quantity,
        discount: line.discount.discount,
      })),
    })
  } catch {
    throw new HttpError(500, MESSAGES.calculation, 'CALCULATION_ERROR')
  }

  totals.lines.forEach((line, position) => {
    const inputIndex = prepared[position].inputIndex
    if (line.discountExceedsTotal && inputIndex != null) {
      fields[`lines.${inputIndex}.discountValue`] = MESSAGES.discountExceedsLine
    }
  })
  if (totals.overallDiscountExceedsSubtotal) fields.overallDiscountValue = MESSAGES.discountExceedsSubtotal
  if (Object.keys(fields).length) {
    throw httpError.validation(
      fields,
      totals.overallDiscountExceedsSubtotal ? MESSAGES.discountExceedsSubtotal : MESSAGES.discountExceedsLine,
    )
  }

  const limit = discountLimitPercent()
  const totalDiscount = totals.lineDiscountTotal + totals.overallDiscountAmount
  if (totalDiscount > 0 && totals.discountPercentOfGross > limit + 1e-9) {
    if (!hasPermission(auth.permissions, 'service:discount_approve')) {
      throw httpError.accessDenied(
        `The total discount exceeds your allowed limit of ${limit}%. A Manager must apply a higher discount.`,
      )
    }
  }

  const expectedDealInput = readAmount(body.expectedDealValue)
  if (expectedDealInput !== undefined && Number.isNaN(expectedDealInput)) {
    fields.expectedDealValue = 'Please enter a valid amount.'
  }
  const initialInput = readAmount(body.initialPayment)
  if (initialInput !== undefined) {
    if (Number.isNaN(initialInput)) fields.initialPayment = 'Please enter a valid amount.'
    else if (initialInput > totals.finalPayable) fields.initialPayment = 'Initial payment cannot exceed the final payable amount.'
  }

  const installments: Array<{ sequence: number; amount: number; purpose: string; dueDate: Date | null }> = []
  const rawInstallments = body.installments === undefined || body.installments === null ? [] : body.installments
  if (!Array.isArray(rawInstallments)) {
    fields.installments = 'The payment plan is invalid.'
  } else {
    rawInstallments.forEach((entry, index) => {
      const key = `installments.${index}`
      const row = asRecord(entry)
      if (!row) {
        fields[key] = 'This installment is invalid.'
        return
      }
      const amount = readAmount(row.amount)
      if (amount === undefined || Number.isNaN(amount) || amount <= 0) fields[`${key}.amount`] = 'Please enter a valid amount.'
      const purpose = readText(row.purpose, 160)
      if (!purpose) fields[`${key}.purpose`] = 'Purpose is required.'
      const dueText = readText(row.dueDate, 10)
      let dueDate: Date | null = null
      if (dueText) {
        dueDate = /^\d{4}-\d{2}-\d{2}$/.test(dueText) ? new Date(`${dueText}T00:00:00.000Z`) : null
        if (!dueDate || Number.isNaN(dueDate.getTime())) fields[`${key}.dueDate`] = 'Please enter a valid date.'
      }
      installments.push({ sequence: index + 1, amount: amount && !Number.isNaN(amount) ? amount : 0, purpose, dueDate })
    })
    const sumPaisa = installments.reduce((sum, item) => sum + Math.round(item.amount * 100), 0)
    if (installments.length && sumPaisa !== Math.round(totals.finalPayable * 100)) {
      fields.installments = 'The installment total must equal the final payable amount.'
    }
  }
  if (Object.keys(fields).length) throw httpError.validation(fields)

  const includedTotal = (snapshot?.items ?? [])
    .filter((item) => item.inclusion === 'INCLUDED')
    .reduce((sum, item) => sum + Math.round(item.unitPrice * 100), 0)

  const offerData = {
    sourcePackageId: snapshot?.packageId ?? null,
    sourcePackageVersionId: snapshot?.versionId ?? null,
    packageName: snapshot?.packageName ?? null,
    versionNumber: snapshot?.versionNumber ?? null,
    packageDefaultPrice: snapshot ? money(snapshot.defaultPrice) : null,
    packagePrice: packagePrice == null ? null : money(packagePrice),
    individualTotal: money(includedTotal / 100),
    saving: snapshot && packagePrice != null ? money((includedTotal - Math.round(packagePrice * 100)) / 100) : '0.00',
    fileOpeningDefault: fileOpening?.amount == null ? null : money(fileOpening.amount),
    fileOpeningCharge: money(fileOpeningCharge),
    grossTotal: money(totals.grossTotal),
    lineDiscountTotal: money(totals.lineDiscountTotal),
    subtotal: money(totals.subtotal),
    overallDiscountType: overall.type,
    overallDiscountValue: overall.discount ? money(overall.discount.value) : null,
    overallDiscountAmount: money(totals.overallDiscountAmount),
    overallDiscountReason: overall.reason,
    finalPayable: money(totals.finalPayable),
    expectedDealValue: expectedDealInput === undefined ? null : money(expectedDealInput),
    initialPayment: initialInput === undefined ? null : money(initialInput),
  }
  const itemsData = prepared.map((line, index) => ({
    kind: line.kind,
    serviceItemId: line.serviceItemId,
    serviceName: line.serviceName,
    remarks: line.remarks,
    inclusion: line.inclusion,
    selected: true,
    defaultPrice: line.defaultPrice == null ? null : money(line.defaultPrice),
    offeredPrice: money(line.offeredPrice),
    quantity: line.quantity,
    discountType: line.discount.type,
    discountValue: line.discount.discount ? money(line.discount.discount.value) : null,
    discountAmount: money(totals.lines[index].discountAmount),
    discountReason: line.discount.reason,
    lineTotal: money(totals.lines[index].lineTotal),
    sortOrder: index,
  }))
  const installmentsData = installments.map((item) => ({
    sequence: item.sequence,
    amount: money(item.amount),
    purpose: item.purpose,
    dueDate: item.dueDate,
  }))

  return { offerData, itemsData, installmentsData, totals }
}

type LeadRow = Awaited<ReturnType<typeof assertCanViewLead>>

const offerRefSelect = { id: true, leadId: true, status: true, offerVersion: true, finalPayable: true } as const

async function findOfferRef(leadId: string, offerId: string) {
  const offer = await prisma.serviceOffer.findFirst({ where: { id: offerId, leadId }, select: offerRefSelect })
  if (!offer) throw httpError.notFound(LIFECYCLE_MESSAGES.notFound)
  return offer
}

async function loadOffer(offerId: string) {
  return serialize(await prisma.serviceOffer.findUniqueOrThrow({ where: { id: offerId }, include: offerInclude }))
}

function offerSummary(offerData: Awaited<ReturnType<typeof prepareOffer>>['offerData']) {
  return {
    packageName: offerData.packageName,
    subtotal: offerData.subtotal,
    lineDiscountTotal: offerData.lineDiscountTotal,
    overallDiscountAmount: offerData.overallDiscountAmount,
  }
}

async function generate(auth: AuthContext, lead: LeadRow, offerId: string, meta: AuditMeta) {
  const offer = await findOfferRef(lead.id, offerId)
  await prisma.$transaction((tx) =>
    changeOfferStatus(tx, {
      offer,
      to: 'GENERATED',
      actorId: auth.user.id,
      meta,
      data: { generatedAt: new Date(), generatedById: auth.user.id },
    }),
  )
  const row = await prisma.serviceOffer.findUniqueOrThrow({ where: { id: offerId }, include: offerInclude })
  try {
    await createSystemFollowUp({
      leadId: lead.id,
      contactName: lead.name,
      type: 'Call',
      purpose: 'Service Charge Discussion',
      nextAction: 'Follow up on the service offer',
      dueAt: daysFromNow(2),
      priority: lead.priority || 'Medium',
      ownerId: lead.ownerId || auth.user.id,
      ownerName: lead.ownerName || auth.user.fullName,
      notes: `Service offer generated — Final payable BDT ${money(row.finalPayable)}`,
      reason: `Service Offered — ${row.id}`,
      actorUserId: auth.user.id,
      meta,
    })
  } catch (error) {
    console.error('Service offer follow-up could not be created', error)
  }
  return row
}

export async function saveLeadServiceOffer(
  auth: AuthContext,
  leadId: string,
  offerId: string | null,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  assertCanOffer(auth)
  const lead = await assertCanViewLead(auth, leadId)
  const existing = offerId
    ? await prisma.serviceOffer.findFirst({ where: { id: offerId, leadId }, include: { items: true } })
    : null
  if (offerId && !existing) throw httpError.notFound(LIFECYCLE_MESSAGES.notFound)
  if (existing && existing.status !== 'DRAFT' && existing.status !== 'GENERATED') {
    throw httpError.conflict(lockedMessage(existing.status), 'OFFER_LOCKED')
  }

  const { offerData, itemsData, installmentsData } = await prepareOffer(auth, lead, body, existing)

  let savedId: string
  try {
    savedId = await prisma.$transaction(async (tx) => {
      await lockLead(tx, leadId)
      if (existing) {
        const updated = await tx.serviceOffer.updateMany({
          where: { id: existing.id, status: existing.status },
          data: { ...offerData, updatedById: auth.user.id },
        })
        if (!updated.count) throw httpError.conflict(LIFECYCLE_MESSAGES.invalidTransition, 'INVALID_OFFER_TRANSITION')
        await tx.serviceOfferItem.deleteMany({ where: { serviceOfferId: existing.id } })
        await tx.serviceOfferInstallment.deleteMany({ where: { serviceOfferId: existing.id } })
        await tx.serviceOfferItem.createMany({ data: itemsData.map((item) => ({ ...item, serviceOfferId: existing.id })) })
        await tx.serviceOfferInstallment.createMany({
          data: installmentsData.map((item) => ({ ...item, serviceOfferId: existing.id })),
        })
        await writeOfferTimeline(tx, {
          offer: { ...existing, finalPayable: offerData.finalPayable },
          action: 'SERVICE_OFFER_UPDATED',
          actorId: auth.user.id,
          meta,
          extra: { ...offerSummary(offerData), previousFinalPayable: money(existing.finalPayable) },
        })
        return existing.id
      }
      const created = await tx.serviceOffer.create({
        data: {
          ...offerData,
          leadId,
          status: 'DRAFT',
          offerVersion: await nextOfferVersion(tx, leadId),
          createdById: auth.user.id,
          updatedById: auth.user.id,
          items: { create: itemsData },
          installments: { create: installmentsData },
        },
        select: offerRefSelect,
      })
      await recordInitialStatus(tx, created, auth.user.id, 'SERVICE_OFFER_CREATED', meta, offerSummary(offerData))
      return created.id
    })
  } catch (error) {
    if (error instanceof HttpError) throw error
    console.error('Service offer save failed', error)
    throw new HttpError(500, MESSAGES.saveFailed, 'OFFER_SAVE_FAILED')
  }

  if (body.generate === true && (!existing || existing.status === 'DRAFT')) {
    const row = await generate(auth, lead, savedId, meta)
    return { offer: serialize(row), message: 'Service offer generated.' }
  }
  const message = !existing ? 'Draft offer saved.' : existing.status === 'DRAFT' ? 'Draft offer updated.' : 'Offer updated.'
  return { offer: await loadOffer(savedId), message }
}

export async function generateLeadServiceOffer(auth: AuthContext, leadId: string, offerId: string, meta: AuditMeta) {
  assertCanOffer(auth)
  const lead = await assertCanViewLead(auth, leadId)
  const row = await generate(auth, lead, offerId, meta)
  return { offer: serialize(row), message: 'Service offer generated.' }
}

/** Revision: the source offer is kept untouched and the change becomes the next Offer Version. */
export async function reviseLeadServiceOffer(
  auth: AuthContext,
  leadId: string,
  offerId: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  assertCanOffer(auth)
  const lead = await assertCanViewLead(auth, leadId)
  const source = await prisma.serviceOffer.findFirst({ where: { id: offerId, leadId }, include: { items: true } })
  if (!source) throw httpError.notFound(LIFECYCLE_MESSAGES.notFound)
  if (!REVISABLE_STATUSES.includes(source.status)) throw httpError.conflict(MESSAGES.reviseDenied, 'OFFER_NOT_REVISABLE')
  const open = await prisma.serviceOffer.findFirst({
    where: { leadId, id: { not: source.id }, status: { in: OPEN_STATUSES } },
    select: { offerVersion: true },
  })
  if (open) {
    throw httpError.conflict(
      `Offer V${open.offerVersion} is still open. Send, cancel, or finish it before creating a new version.`,
      'OPEN_OFFER_EXISTS',
    )
  }

  const { offerData, itemsData, installmentsData } = await prepareOffer(auth, lead, body, source)
  const reason = readText(body.revisionReason, 500) || null

  let created: { id: string; offerVersion: number }
  try {
    created = await prisma.$transaction(async (tx) => {
      await lockLead(tx, leadId)
      const current = await tx.serviceOffer.findUniqueOrThrow({ where: { id: source.id }, select: offerRefSelect })
      if (!REVISABLE_STATUSES.includes(current.status)) {
        throw httpError.conflict(LIFECYCLE_MESSAGES.invalidTransition, 'INVALID_OFFER_TRANSITION')
      }
      const offerVersion = await nextOfferVersion(tx, leadId)
      const row = await tx.serviceOffer.create({
        data: {
          ...offerData,
          leadId,
          status: 'DRAFT',
          offerVersion,
          revisedFromId: source.id,
          createdById: auth.user.id,
          updatedById: auth.user.id,
          items: { create: itemsData },
          installments: { create: installmentsData },
        },
        select: offerRefSelect,
      })
      await recordInitialStatus(tx, row, auth.user.id, 'SERVICE_OFFER_REVISED', meta, {
        ...offerSummary(offerData),
        revisedFromId: source.id,
        revisedFromVersion: source.offerVersion,
        previousFinalPayable: money(source.finalPayable),
        reason,
      })
      if (current.status === 'SENT') {
        const rejectionReason = reason
          ? `Student requested changes: ${reason}`
          : `Student requested changes — replaced by Offer V${offerVersion}`
        await changeOfferStatus(tx, {
          offer: current,
          to: 'REJECTED',
          actorId: auth.user.id,
          reason: rejectionReason,
          data: { rejectedAt: new Date(), rejectionReason },
          meta,
        })
      }
      return row
    })
  } catch (error) {
    if (error instanceof HttpError) throw error
    console.error('Service offer revision failed', error)
    throw new HttpError(500, MESSAGES.saveFailed, 'OFFER_SAVE_FAILED')
  }

  if (body.generate === true) {
    const row = await generate(auth, lead, created.id, meta)
    return { offer: serialize(row), message: `Offer V${created.offerVersion} generated.` }
  }
  return { offer: await loadOffer(created.id), message: `Offer V${created.offerVersion} saved as a draft.` }
}

async function transition(
  auth: AuthContext,
  leadId: string,
  offerId: string,
  to: ServiceOfferStatus,
  meta: AuditMeta,
  options: { reason?: string | null; data?: (now: Date) => Prisma.ServiceOfferUncheckedUpdateManyInput },
) {
  assertCanOffer(auth)
  await assertCanViewLead(auth, leadId)
  const offer = await findOfferRef(leadId, offerId)
  await prisma.$transaction(async (tx) => {
    await lockLead(tx, leadId)
    await changeOfferStatus(tx, {
      offer,
      to,
      actorId: auth.user.id,
      reason: options.reason,
      data: options.data?.(new Date()),
      meta,
    })
  })
  return loadOffer(offerId)
}

export async function sendLeadServiceOffer(auth: AuthContext, leadId: string, offerId: string, meta: AuditMeta) {
  const days = offerValidityDays()
  const offer = await transition(auth, leadId, offerId, 'SENT', meta, {
    data: (now) => ({
      sentAt: now,
      sentById: auth.user.id,
      validUntil: days ? new Date(now.getTime() + days * 86400000) : null,
    }),
  })
  return { offer, message: 'Offer marked as sent to the student.' }
}

export async function rejectLeadServiceOffer(
  auth: AuthContext,
  leadId: string,
  offerId: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  const reason = readText(body.reason, 500) || null
  const offer = await transition(auth, leadId, offerId, 'REJECTED', meta, {
    reason,
    data: (now) => ({ rejectedAt: now, rejectionReason: reason }),
  })
  return { offer, message: 'Offer marked as rejected.' }
}

export async function cancelLeadServiceOffer(
  auth: AuthContext,
  leadId: string,
  offerId: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  const reason = readText(body.reason, 500)
  if (!reason) throw httpError.validation({ reason: LIFECYCLE_MESSAGES.cancelReason }, LIFECYCLE_MESSAGES.cancelReason)
  const offer = await transition(auth, leadId, offerId, 'CANCELLED', meta, {
    reason,
    data: (now) => ({ cancelledAt: now, cancelledById: auth.user.id, cancelReason: reason }),
  })
  return { offer, message: 'Offer cancelled.' }
}

export async function acceptLeadServiceOffer(auth: AuthContext, leadId: string, offerId: string, meta: AuditMeta) {
  assertCanOffer(auth)
  await assertCanViewLead(auth, leadId)
  await prisma.$transaction(async (tx) => {
    await lockLead(tx, leadId)
    const offer = await tx.serviceOffer.findFirst({
      where: { id: offerId, leadId },
      include: { items: { orderBy: { sortOrder: 'asc' } }, installments: { select: { id: true } } },
    })
    if (!offer) throw httpError.notFound(LIFECYCLE_MESSAGES.notFound)
    if (!allowedTransitions(offer.status).includes('ACCEPTED')) {
      throw httpError.conflict(LIFECYCLE_MESSAGES.invalidTransition, 'INVALID_OFFER_TRANSITION')
    }

    const others = await tx.serviceOffer.findMany({
      where: { leadId, id: { not: offer.id }, status: { in: ACTIVE_STATUSES } },
      select: offerRefSelect,
    })
    if (others.some((other) => other.status === 'PARTIALLY_PAID' || other.status === 'PAID')) {
      throw httpError.conflict(LIFECYCLE_MESSAGES.paidReplace, 'ACTIVE_OFFER_PAID')
    }
    const now = new Date()
    for (const other of others) {
      const reason = `Superseded by Offer V${offer.offerVersion}`
      await changeOfferStatus(tx, {
        offer: other,
        to: 'CANCELLED',
        actorId: auth.user.id,
        reason,
        data: { cancelledAt: now, cancelledById: auth.user.id, cancelReason: reason },
        meta,
      })
    }

    const accepted = await changeOfferStatus(tx, {
      offer,
      to: 'ACCEPTED',
      actorId: auth.user.id,
      meta,
      data: {
        acceptedAt: now,
        acceptedById: auth.user.id,
        acceptedSnapshot: {
          offerVersion: offer.offerVersion,
          totalAmount: money(offer.finalPayable),
          currency: 'BDT',
          acceptedAt: now.toISOString(),
          acceptedBy: { id: auth.user.id, fullName: auth.user.fullName },
          packageName: offer.packageName,
          services: offer.items.map((item) => ({
            serviceItemId: item.serviceItemId,
            serviceName: item.serviceName,
            kind: item.kind,
            quantity: item.quantity,
            lineTotal: money(item.lineTotal),
          })),
        },
      },
    })

    if (Number(offer.finalPayable) > 0) {
      if (!offer.installments.length) {
        await tx.serviceOfferInstallment.create({
          data: { serviceOfferId: offer.id, sequence: 1, amount: money(offer.finalPayable), purpose: 'Full payment' },
        })
      }
      await changeOfferStatus(tx, { offer: accepted, to: 'PAYMENT_PENDING', actorId: auth.user.id, meta })
    }
  })
  return { offer: await loadOffer(offerId), message: 'Offer marked as accepted.' }
}

export async function recordOfferInstallmentPayment(
  auth: AuthContext,
  leadId: string,
  offerId: string,
  installmentId: string,
  meta: AuditMeta,
) {
  if (!hasPermission(auth.permissions, 'payment:create')) throw httpError.accessDenied(LIFECYCLE_MESSAGES.permissionDenied)
  await assertCanViewLead(auth, leadId)
  await prisma.$transaction(async (tx) => {
    await lockLead(tx, leadId)
    const offer = await tx.serviceOffer.findFirst({ where: { id: offerId, leadId }, select: offerRefSelect })
    if (!offer) throw httpError.notFound(LIFECYCLE_MESSAGES.notFound)
    if (offer.status !== 'PAYMENT_PENDING' && offer.status !== 'PARTIALLY_PAID') {
      throw httpError.conflict(LIFECYCLE_MESSAGES.paymentState, 'OFFER_NOT_PAYABLE')
    }
    const installment = await tx.serviceOfferInstallment.findFirst({ where: { id: installmentId, serviceOfferId: offerId } })
    if (!installment) throw httpError.notFound('The requested installment could not be found.')
    if (installment.status === 'PAID') throw httpError.conflict(LIFECYCLE_MESSAGES.installmentPaid, 'INSTALLMENT_PAID')
    await tx.serviceOfferInstallment.update({
      where: { id: installment.id },
      data: { status: 'PAID', paidAt: new Date(), paidById: auth.user.id },
    })
    await writeOfferTimeline(tx, {
      offer,
      action: 'SERVICE_OFFER_PAYMENT_RECORDED',
      actorId: auth.user.id,
      meta,
      extra: { installmentSequence: installment.sequence, amount: money(installment.amount), purpose: installment.purpose },
    })
    await syncOfferPaymentStatus(tx, offerId, auth.user.id, meta)
  })
  return { offer: await loadOffer(offerId), message: 'Payment recorded.' }
}

/** Only an unused draft (never generated, not a revision, latest version) may be removed. */
export async function deleteLeadServiceOffer(auth: AuthContext, leadId: string, offerId: string, meta: AuditMeta) {
  assertCanOffer(auth)
  await assertCanViewLead(auth, leadId)
  const existing = await prisma.serviceOffer.findFirst({
    where: { id: offerId, leadId },
    select: { ...offerRefSelect, revisedFromId: true, generatedAt: true },
  })
  if (!existing) throw httpError.notFound(LIFECYCLE_MESSAGES.notFound)
  if (existing.status !== 'DRAFT' || existing.revisedFromId || existing.generatedAt) {
    throw httpError.conflict(LIFECYCLE_MESSAGES.deleteDenied, 'OFFER_NOT_DELETABLE')
  }
  await prisma.$transaction(async (tx) => {
    await lockLead(tx, leadId)
    if ((await nextOfferVersion(tx, leadId)) !== existing.offerVersion + 1) {
      throw httpError.conflict(LIFECYCLE_MESSAGES.deleteDenied, 'OFFER_NOT_DELETABLE')
    }
    const deleted = await tx.serviceOffer.deleteMany({ where: { id: offerId, status: 'DRAFT' } })
    if (!deleted.count) throw httpError.conflict(LIFECYCLE_MESSAGES.deleteDenied, 'OFFER_NOT_DELETABLE')
    await writeOfferTimeline(tx, { offer: existing, action: 'SERVICE_OFFER_DELETED', actorId: auth.user.id, meta, from: 'DRAFT' })
  })
  return { message: 'Draft offer deleted.' }
}
