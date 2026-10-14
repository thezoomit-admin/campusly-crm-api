import type { ApplicationDocumentSource, ApplicationDocumentStatus, Prisma } from '../../lib/prisma-client'
import { writeAuditLog } from '../../lib/audit'
import { httpError } from '../../lib/http-error'
import { prisma } from '../../lib/prisma'
import { hasPermission } from '../auth/access'
import type { AuthContext } from '../auth/session.service'
import { assertCanViewLead } from '../leads/leads.helpers'
import { saveLeadDocument } from '../leads/leads.storage'
import { listLeadPaymentHistory } from '../payments/payments.service'

type AuditMeta = { ipAddress?: string; userAgent?: string }

const NOTE_MAX = 2000
const DOC_STATUSES = new Set<ApplicationDocumentStatus>(['PENDING', 'VERIFIED', 'REJECTED', 'ARCHIVED'])

function asString(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

async function nextDocumentCode(tx: Prisma.TransactionClient) {
  const row = await tx.documentSequence.upsert({
    where: { key: 'application_document' },
    create: { key: 'application_document', nextValue: 2 },
    update: { nextValue: { increment: 1 } },
  })
  return `ADOC-${String(row.nextValue - 1).padStart(4, '0')}`
}

async function loadApplicationForWorkspace(auth: AuthContext, applicationId: string) {
  if (!hasPermission(auth.permissions, 'lead:convert') && !hasPermission(auth.permissions, 'lead:view')) {
    throw httpError.accessDenied('You do not have permission to view applications.')
  }
  const application = await prisma.application.findUnique({
    where: { id: applicationId },
    select: {
      id: true,
      code: true,
      leadId: true,
      studentId: true,
      applicantName: true,
      university: true,
    },
  })
  if (!application) throw httpError.notFound('Application not found.')
  if (application.leadId) await assertCanViewLead(auth, application.leadId)
  return application
}

function serializeNote(row: {
  id: string
  body: string
  createdAt: Date
  createdBy: { id: string; fullName: string } | null
}) {
  return {
    id: row.id,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.fullName } : null,
  }
}

function serializeDocument(row: {
  id: string
  code: string
  title: string
  categoryCode: string
  typeCode: string
  status: ApplicationDocumentStatus
  source: ApplicationDocumentSource
  sourceDocumentId: string | null
  fileName: string | null
  mimeType: string | null
  fileSize: number | null
  remarks: string | null
  createdAt: Date
  updatedAt: Date
  createdBy: { id: string; fullName: string } | null
}) {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    categoryCode: row.categoryCode,
    typeCode: row.typeCode,
    status: row.status,
    source: row.source,
    sourceDocumentId: row.sourceDocumentId,
    fileName: row.fileName,
    mimeType: row.mimeType,
    fileSize: row.fileSize,
    remarks: row.remarks,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.fullName } : null,
  }
}

export async function listApplicationNotes(auth: AuthContext, applicationId: string) {
  await loadApplicationForWorkspace(auth, applicationId)
  const items = await prisma.applicationNote.findMany({
    where: { applicationId },
    include: { createdBy: { select: { id: true, fullName: true } } },
    orderBy: { createdAt: 'desc' },
  })
  return { items: items.map(serializeNote) }
}

export async function createApplicationNote(
  auth: AuthContext,
  applicationId: string,
  body: Record<string, unknown>,
  meta?: AuditMeta,
) {
  if (!hasPermission(auth.permissions, 'lead:convert') && !hasPermission(auth.permissions, 'lead:edit')) {
    throw httpError.accessDenied('You do not have permission to add application notes.')
  }
  const application = await loadApplicationForWorkspace(auth, applicationId)
  const text = asString(body.body || body.notes)
  if (!text) throw httpError.validation({ body: 'Note body is required.' })
  if (text.length > NOTE_MAX) {
    throw httpError.validation({ body: `Note must be at most ${NOTE_MAX} characters.` })
  }

  const created = await prisma.applicationNote.create({
    data: {
      applicationId,
      body: text,
      createdById: auth.user.id,
    },
    include: { createdBy: { select: { id: true, fullName: true } } },
  })

  await prisma.activity.create({
    data: {
      type: 'NOTE',
      userId: auth.user.id,
      notes: text.slice(0, 500),
      relatedName: application.applicantName,
      relatedType: 'application',
      relatedId: application.id,
      outcome: 'Application Note',
      metadata: {
        applicationCode: application.code,
        event: 'application_note_created',
      },
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
    },
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'APPLICATION_NOTE_CREATED',
    entityType: 'application',
    entityId: applicationId,
    ipAddress: meta?.ipAddress,
    userAgent: meta?.userAgent,
    metadata: { noteId: created.id, applicationCode: application.code },
  })

  return { note: serializeNote(created) }
}

export async function listApplicationDocuments(auth: AuthContext, applicationId: string) {
  await loadApplicationForWorkspace(auth, applicationId)
  const items = await prisma.applicationDocument.findMany({
    where: { applicationId, status: { not: 'ARCHIVED' } },
    include: { createdBy: { select: { id: true, fullName: true } } },
    orderBy: { createdAt: 'desc' },
  })
  return { items: items.map(serializeDocument) }
}

export async function uploadApplicationDocument(
  auth: AuthContext,
  applicationId: string,
  file: Express.Multer.File | undefined,
  body: Record<string, unknown>,
  meta?: AuditMeta,
) {
  if (!hasPermission(auth.permissions, 'document:upload') && !hasPermission(auth.permissions, 'lead:convert')) {
    throw httpError.accessDenied('You do not have permission to upload application documents.')
  }
  const application = await loadApplicationForWorkspace(auth, applicationId)
  if (!file) throw httpError.invalidUpload('Please select a document to upload.')
  if (!application.leadId) {
    throw httpError.validation({ leadId: 'Application must be linked to a lead to store documents.' })
  }

  const title = asString(body.title) || file.originalname || 'Application document'
  const categoryCode = asString(body.categoryCode) || 'APPLICATION'
  const typeCode = asString(body.typeCode) || 'OTHER'
  const remarks = asString(body.remarks) || null

  const saved = await saveLeadDocument(application.leadId, file, title)

  try {
    const created = await prisma.$transaction(async (tx) => {
      const code = await nextDocumentCode(tx)
      return tx.applicationDocument.create({
        data: {
          applicationId,
          code,
          title,
          categoryCode,
          typeCode,
          status: 'PENDING',
          source: 'UPLOAD',
          fileName: saved.fileName,
          mimeType: saved.mimeType,
          storageKey: saved.storageKey,
          fileSize: saved.fileSize,
          remarks,
          createdById: auth.user.id,
          updatedById: auth.user.id,
        },
        include: { createdBy: { select: { id: true, fullName: true } } },
      })
    })

    await prisma.activity.create({
      data: {
        type: 'NOTE',
        userId: auth.user.id,
        notes: `Application document uploaded: ${created.title}`,
        relatedName: application.applicantName,
        relatedType: 'application',
        relatedId: application.id,
        outcome: 'Document Uploaded',
        metadata: {
          applicationCode: application.code,
          documentId: created.id,
          documentCode: created.code,
          event: 'application_document_uploaded',
        },
        ipAddress: meta?.ipAddress,
        userAgent: meta?.userAgent,
      },
    })

    await writeAuditLog({
      userId: auth.user.id,
      action: 'APPLICATION_DOCUMENT_UPLOADED',
      entityType: 'application',
      entityId: applicationId,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
      metadata: {
        documentId: created.id,
        documentCode: created.code,
        applicationCode: application.code,
      },
    })

    return { document: serializeDocument(created) }
  } catch (error) {
    console.error('[applications] document upload failed:', error)
    throw httpError.invalidUpload('Unable to upload the document. Please try again.')
  }
}

export async function attachSharedDocumentToApplication(
  auth: AuthContext,
  applicationId: string,
  body: Record<string, unknown>,
  meta?: AuditMeta,
) {
  if (!hasPermission(auth.permissions, 'document:upload') && !hasPermission(auth.permissions, 'lead:convert')) {
    throw httpError.accessDenied('You do not have permission to attach shared documents.')
  }
  const application = await loadApplicationForWorkspace(auth, applicationId)
  if (!application.leadId) throw httpError.validation({ leadId: 'Application has no linked lead.' })

  const sourceDocumentId = asString(body.sourceDocumentId || body.leadDocumentId)
  if (!sourceDocumentId) {
    throw httpError.validation({ sourceDocumentId: 'Shared document id is required.' })
  }

  const leadDoc = await prisma.leadDocument.findFirst({
    where: { id: sourceDocumentId, leadId: application.leadId, archivedAt: null },
  })
  if (!leadDoc) throw httpError.notFound('Shared student document not found for this lead.')

  const already = await prisma.applicationDocument.findFirst({
    where: {
      applicationId,
      source: 'SHARED_LEAD_DOCUMENT',
      sourceDocumentId: leadDoc.id,
      status: { not: 'ARCHIVED' },
    },
  })
  if (already) {
    throw httpError.validation(
      { sourceDocumentId: 'This shared document is already attached to the application.' },
      'Document already attached.',
    )
  }

  const created = await prisma.$transaction(async (tx) => {
    const code = await nextDocumentCode(tx)
    return tx.applicationDocument.create({
      data: {
        applicationId,
        code,
        title: leadDoc.name,
        categoryCode: leadDoc.categoryCode,
        typeCode: leadDoc.typeCode,
        status: 'PENDING',
        source: 'SHARED_LEAD_DOCUMENT',
        sourceDocumentId: leadDoc.id,
        fileName: leadDoc.fileName,
        mimeType: leadDoc.mimeType,
        storageKey: leadDoc.storageKey,
        fileSize: leadDoc.fileSize,
        remarks: asString(body.remarks) || 'Attached from student shared documents.',
        createdById: auth.user.id,
        updatedById: auth.user.id,
      },
      include: { createdBy: { select: { id: true, fullName: true } } },
    })
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'APPLICATION_DOCUMENT_ATTACHED',
    entityType: 'application',
    entityId: applicationId,
    ipAddress: meta?.ipAddress,
    userAgent: meta?.userAgent,
    metadata: {
      documentId: created.id,
      sourceDocumentId: leadDoc.id,
      applicationCode: application.code,
    },
  })

  return { document: serializeDocument(created) }
}

export async function updateApplicationDocumentStatus(
  auth: AuthContext,
  applicationId: string,
  documentId: string,
  body: Record<string, unknown>,
  meta?: AuditMeta,
) {
  if (!hasPermission(auth.permissions, 'document:verify') && !hasPermission(auth.permissions, 'lead:convert')) {
    throw httpError.accessDenied('You do not have permission to update document status.')
  }
  await loadApplicationForWorkspace(auth, applicationId)

  const nextStatus = asString(body.status).toUpperCase() as ApplicationDocumentStatus
  if (!DOC_STATUSES.has(nextStatus)) {
    throw httpError.validation({ status: 'Invalid document status.' })
  }

  const existing = await prisma.applicationDocument.findFirst({
    where: { id: documentId, applicationId },
  })
  if (!existing) throw httpError.notFound('Application document not found.')

  const updated = await prisma.applicationDocument.update({
    where: { id: existing.id },
    data: {
      status: nextStatus,
      remarks: asString(body.remarks) || existing.remarks,
      updatedById: auth.user.id,
    },
    include: { createdBy: { select: { id: true, fullName: true } } },
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'APPLICATION_DOCUMENT_STATUS_UPDATED',
    entityType: 'application_document',
    entityId: documentId,
    ipAddress: meta?.ipAddress,
    userAgent: meta?.userAgent,
    metadata: { from: existing.status, to: nextStatus, applicationId },
  })

  return { document: serializeDocument(updated) }
}

export async function listApplicationActivities(auth: AuthContext, applicationId: string) {
  const application = await loadApplicationForWorkspace(auth, applicationId)

  const [direct, leadLinked] = await Promise.all([
    prisma.activity.findMany({
      where: { relatedType: 'application', relatedId: applicationId },
      include: { user: { select: { id: true, fullName: true } } },
      orderBy: { occurredAt: 'desc' },
      take: 50,
    }),
    application.leadId
      ? prisma.activity.findMany({
          where: {
            relatedType: 'lead',
            relatedId: application.leadId,
            OR: [
              { metadata: { path: ['applicationId'], equals: applicationId } },
              { metadata: { path: ['event'], equals: 'application_created' } },
            ],
          },
          include: { user: { select: { id: true, fullName: true } } },
          orderBy: { occurredAt: 'desc' },
          take: 30,
        })
      : Promise.resolve([]),
  ])

  const seen = new Set<string>()
  const items = [...direct, ...leadLinked]
    .filter((row) => {
      if (seen.has(row.id)) return false
      seen.add(row.id)
      return true
    })
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
    .slice(0, 50)
    .map((row) => ({
      id: row.id,
      type: row.type,
      outcome: row.outcome,
      notes: row.notes,
      occurredAt: row.occurredAt.toISOString(),
      relatedType: row.relatedType,
      relatedId: row.relatedId,
      user: row.user ? { id: row.user.id, name: row.user.fullName } : null,
    }))

  return { items }
}

export async function listApplicationPayments(auth: AuthContext, applicationId: string) {
  const application = await loadApplicationForWorkspace(auth, applicationId)
  if (!application.leadId) {
    return {
      scope: 'none' as const,
      message: 'No lead-linked payments for this application yet.',
      items: [],
    }
  }

  const canViewPayments =
    hasPermission(auth.permissions, 'payment:view') ||
    hasPermission(auth.permissions, 'service:view') ||
    hasPermission(auth.permissions, 'lead:convert')

  if (!canViewPayments) {
    throw httpError.accessDenied('You do not have permission to view payments.')
  }

  try {
    const history = await listLeadPaymentHistory(auth, application.leadId)
    return {
      scope: 'lead_package' as const,
      message:
        'Payments are currently tracked at the student/lead package level. Application-specific fee lines can be allocated later.',
      leadId: application.leadId,
      ...history,
    }
  } catch {
    const payments = await prisma.payment.findMany({
      where: { leadId: application.leadId },
      orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }],
      take: 50,
      select: {
        id: true,
        paymentNumber: true,
        amount: true,
        currency: true,
        status: true,
        methodName: true,
        paymentDate: true,
        createdAt: true,
      },
    })
    return {
      scope: 'lead_package' as const,
      message:
        'Payments are currently tracked at the student/lead package level. Application-specific fee lines can be allocated later.',
      leadId: application.leadId,
      items: payments.map((row) => ({
        id: row.id,
        paymentNumber: row.paymentNumber,
        amount: Number(row.amount).toFixed(2),
        currency: row.currency,
        status: row.status,
        methodName: row.methodName,
        paymentDate: row.paymentDate.toISOString().slice(0, 10),
        createdAt: row.createdAt.toISOString(),
      })),
    }
  }
}
