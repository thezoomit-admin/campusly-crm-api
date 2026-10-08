import { randomUUID } from 'node:crypto'
import type { LeadDocument, LeadDocumentActivityAction, LeadDocumentStatus, Prisma } from '../../lib/prisma-client'
import { writeAuditLog } from '../../lib/audit'
import { HttpError, httpError } from '../../lib/http-error'
import { prisma } from '../../lib/prisma'
import { hasPermission } from '../auth/access'
import type { AuthContext } from '../auth/session.service'
import { createNotification } from '../notifications/notifications.service'
import { assertCanViewLead, asString } from './leads.helpers'
import {
  destroyLeadStoredUpload,
  MAX_LEAD_UPLOAD_BYTES,
  readLeadStoredFile,
  saveLeadDocument,
} from './leads.storage'

const LEAD_DOC_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])

const SENSITIVE_TYPE_CODES = new Set([
  'PASSPORT',
  'NID',
  'BANK_STATEMENT',
  'SPONSOR',
  'FINANCIAL_CERTIFICATE',
])

const DEFAULT_CHECKLIST: Array<{
  categoryCode: string
  typeCode: string
  name: string
  isSensitive: boolean
  sortOrder: number
}> = [
  { categoryCode: 'PERSONAL', typeCode: 'PASSPORT', name: 'Passport', isSensitive: true, sortOrder: 1 },
  { categoryCode: 'LANGUAGE', typeCode: 'IELTS', name: 'IELTS', isSensitive: false, sortOrder: 2 },
  { categoryCode: 'ACADEMIC', typeCode: 'TRANSCRIPT', name: 'Academic Transcript', isSensitive: false, sortOrder: 3 },
  { categoryCode: 'FINANCIAL', typeCode: 'BANK_STATEMENT', name: 'Bank Statement', isSensitive: true, sortOrder: 4 },
]

const DOCUMENT_INCLUDE = {
  uploadedBy: { select: { id: true, fullName: true } },
  verifiedBy: { select: { id: true, fullName: true } },
} as const

type AuditMeta = { ipAddress?: string; userAgent?: string }
type DocumentRow = LeadDocument & {
  uploadedBy: { id: string; fullName: string } | null
  verifiedBy: { id: string; fullName: string } | null
}

type DuplicateAction = 'replace' | 'new_version'

function statusLabel(status: LeadDocumentStatus) {
  switch (status) {
    case 'PENDING':
      return 'Pending'
    case 'VERIFIED':
      return 'Verified'
    case 'REJECTED':
      return 'Rejected'
    case 'EXPIRED':
      return 'Expired'
    case 'REPLACED':
      return 'Replaced'
    default:
      return status
  }
}

function parseOptionalDate(value: unknown, field: string) {
  const raw = asString(value)
  if (!raw) return null
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) {
    throw httpError.validation({ [field]: 'Valid date is required.' })
  }
  return date
}

function isSensitiveType(typeCode: string, explicit?: boolean) {
  if (typeof explicit === 'boolean') return explicit
  return SENSITIVE_TYPE_CODES.has(typeCode.toUpperCase())
}

function canAccessSensitive(auth: AuthContext) {
  return (
    hasPermission(auth.permissions, 'document:sensitive') ||
    hasPermission(auth.permissions, 'document:verify') ||
    auth.roles.some((role) => role.toLowerCase() === 'admin')
  )
}

function assertDocumentViewPermission(auth: AuthContext) {
  if (!hasPermission(auth.permissions, 'document:view') && !hasPermission(auth.permissions, 'lead:view')) {
    throw httpError.accessDenied('You are not authorized to access this document.')
  }
}

function assertCanAccessDocumentContent(auth: AuthContext, document: { isSensitive: boolean }) {
  if (document.isSensitive && !canAccessSensitive(auth)) {
    throw httpError.accessDenied('You are not authorized to access this document.')
  }
}

const BUILTIN_DOCUMENT_TYPES: Record<string, { name: string; categoryCode: string }> = {
  PASSPORT: { name: 'Passport', categoryCode: 'PERSONAL' },
  NID: { name: 'NID', categoryCode: 'PERSONAL' },
  BIRTH_CERTIFICATE: { name: 'Birth Certificate', categoryCode: 'PERSONAL' },
  PHOTOGRAPH: { name: 'Photograph', categoryCode: 'PERSONAL' },
  SSC_CERTIFICATE: { name: 'SSC Certificate', categoryCode: 'ACADEMIC' },
  SSC_TRANSCRIPT: { name: 'SSC Transcript', categoryCode: 'ACADEMIC' },
  HSC_CERTIFICATE: { name: 'HSC Certificate', categoryCode: 'ACADEMIC' },
  HSC_TRANSCRIPT: { name: 'HSC Transcript', categoryCode: 'ACADEMIC' },
  DIPLOMA_CERTIFICATE: { name: 'Diploma Certificate', categoryCode: 'ACADEMIC' },
  BACHELOR_CERTIFICATE: { name: 'Bachelor Certificate', categoryCode: 'ACADEMIC' },
  BACHELOR_TRANSCRIPT: { name: 'Bachelor Transcript', categoryCode: 'ACADEMIC' },
  MASTER_CERTIFICATE: { name: 'Master Certificate', categoryCode: 'ACADEMIC' },
  MASTER_TRANSCRIPT: { name: 'Master Transcript', categoryCode: 'ACADEMIC' },
  TRANSCRIPT: { name: 'Academic Transcript', categoryCode: 'ACADEMIC' },
  DEGREE: { name: 'Degree Certificate', categoryCode: 'ACADEMIC' },
  IELTS: { name: 'IELTS', categoryCode: 'LANGUAGE' },
  TOEFL: { name: 'TOEFL', categoryCode: 'LANGUAGE' },
  PTE: { name: 'PTE', categoryCode: 'LANGUAGE' },
  OTHER_LANGUAGE: { name: 'Other Language Certificate', categoryCode: 'LANGUAGE' },
  BANK_STATEMENT: { name: 'Bank Statement', categoryCode: 'FINANCIAL' },
  SPONSOR: { name: 'Sponsor Document', categoryCode: 'FINANCIAL' },
  FINANCIAL_CERTIFICATE: { name: 'Financial Certificate', categoryCode: 'FINANCIAL' },
  SOP: { name: 'SOP', categoryCode: 'APPLICATION' },
  CV: { name: 'CV', categoryCode: 'APPLICATION' },
  RECOMMENDATION: { name: 'Recommendation Letter', categoryCode: 'APPLICATION' },
  APPLICATION_FORM: { name: 'Application Form', categoryCode: 'APPLICATION' },
  OFFER: { name: 'Offer Letter', categoryCode: 'APPLICATION' },
  OTHER: { name: 'Other Document', categoryCode: 'OTHER' },
}

const BUILTIN_CATEGORIES: Record<string, string> = {
  PERSONAL: 'Personal Documents',
  ACADEMIC: 'Academic Documents',
  LANGUAGE: 'Language Documents',
  FINANCIAL: 'Financial Documents',
  APPLICATION: 'Application Documents',
  OTHER: 'Other',
}

async function resolveTypeMeta(categoryCode: string, typeCode: string) {
  const [category, type] = await Promise.all([
    prisma.masterDataItem.findFirst({
      where: { categoryKey: 'DOCUMENT_CATEGORY', code: categoryCode, status: 'ACTIVE' },
      select: { id: true, code: true, name: true },
    }),
    prisma.masterDataItem.findFirst({
      where: { categoryKey: 'DOCUMENT_TYPE', code: typeCode, status: 'ACTIVE' },
      select: { id: true, code: true, name: true, parentId: true, parent: { select: { code: true } } },
    }),
  ])

  const builtinType = BUILTIN_DOCUMENT_TYPES[typeCode]
  const builtinCategoryName = BUILTIN_CATEGORIES[categoryCode]

  if (!category && !builtinCategoryName) {
    throw httpError.validation({ categoryCode: 'Document category is required.' }, 'Document category is required.')
  }
  if (!type && !builtinType) {
    throw httpError.validation({ typeCode: 'Document category is required.' }, 'Document category is required.')
  }
  if (type?.parentId && type.parent?.code && type.parent.code !== (category?.code || categoryCode)) {
    throw httpError.validation({ typeCode: 'Document type does not belong to the selected category.' })
  }
  if (builtinType && builtinType.categoryCode !== categoryCode) {
    throw httpError.validation({ typeCode: 'Document type does not belong to the selected category.' })
  }

  return {
    category: category || { id: '', code: categoryCode, name: builtinCategoryName || categoryCode },
    type: type || { id: '', code: typeCode, name: builtinType!.name, parentId: null, parent: null },
  }
}

export async function ensureDocumentChecklistRules() {
  const count = await prisma.documentChecklistRule.count({ where: { stage: 'LEAD' } })
  if (count === 0) {
    await prisma.documentChecklistRule.createMany({
      data: DEFAULT_CHECKLIST.map((row) => ({
        ...row,
        stage: 'LEAD' as const,
        isRequired: true,
        isActive: true,
      })),
    })
  }

  // Backfill legacy attachment rows created before CRM-025 metadata existed.
  await prisma.$executeRaw`
    UPDATE lead_documents
    SET name = file_name
    WHERE (name IS NULL OR name = '')
  `.catch(() => undefined)
}

async function recordDocumentActivity(input: {
  documentId: string
  action: LeadDocumentActivityAction
  userId?: string | null
  notes?: string
  metadata?: Prisma.InputJsonValue
}) {
  await prisma.leadDocumentActivity.create({
    data: {
      documentId: input.documentId,
      action: input.action,
      userId: input.userId || null,
      notes: input.notes || null,
      metadata: input.metadata,
    },
  })
}

async function notifyLeadOwner(input: {
  leadId: string
  ownerId: string | null | undefined
  actorId: string
  title: string
  body: string
  type: string
  dedupeKey?: string
}) {
  if (!input.ownerId || input.ownerId === input.actorId) return
  await createNotification({
    userId: input.ownerId,
    title: input.title,
    body: input.body,
    link: `/leads/${input.leadId}?tab=attachments`,
    type: input.type,
    leadId: input.leadId,
    dedupeKey: input.dedupeKey,
  }).catch(() => undefined)
}

function serializeDocument(row: DocumentRow) {
  return {
    id: row.id,
    leadId: row.leadId,
    documentGroupId: row.documentGroupId,
    categoryCode: row.categoryCode,
    typeCode: row.typeCode,
    name: row.name?.trim() || row.fileName,
    fileName: row.fileName,
    mimeType: row.mimeType,
    fileSize: row.fileSize,
    versionNumber: row.versionNumber,
    isLatest: row.isLatest,
    status: row.status,
    statusLabel: statusLabel(row.status),
    documentDate: row.documentDate ? row.documentDate.toISOString().slice(0, 10) : null,
    expiryDate: row.expiryDate ? row.expiryDate.toISOString().slice(0, 10) : null,
    remarks: row.remarks,
    isSensitive: row.isSensitive,
    verificationRemarks: row.verificationRemarks,
    rejectionReason: row.rejectionReason,
    verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    uploadedBy: row.uploadedBy ? { id: row.uploadedBy.id, name: row.uploadedBy.fullName } : null,
    verifiedBy: row.verifiedBy ? { id: row.verifiedBy.id, name: row.verifiedBy.fullName } : null,
  }
}

async function loadDocument(leadId: string, documentId: string, includeArchived = false) {
  const document = await prisma.leadDocument.findFirst({
    where: {
      id: documentId,
      leadId,
      ...(includeArchived ? {} : { archivedAt: null }),
    },
    include: DOCUMENT_INCLUDE,
  })
  if (!document) {
    throw httpError.notFound('Document not found.')
  }
  return document
}

export async function listLeadDocuments(
  auth: AuthContext,
  leadId: string,
  query: { archived?: boolean; includeHistory?: boolean } = {},
) {
  await assertCanViewLead(auth, leadId)
  assertDocumentViewPermission(auth)
  await ensureDocumentChecklistRules()

  const archived = Boolean(query.archived)
  const includeHistory = Boolean(query.includeHistory)

  const items = await prisma.leadDocument.findMany({
    where: {
      leadId,
      archivedAt: archived ? { not: null } : null,
      ...(includeHistory || archived ? {} : { isLatest: true }),
    },
    include: DOCUMENT_INCLUDE,
    orderBy: [{ createdAt: 'desc' }],
  })

  return {
    items: items.map((row) => ({
      ...serializeDocument(row),
      canPreview: !row.isSensitive || canAccessSensitive(auth),
    })),
  }
}

export async function getLeadDocumentChecklist(auth: AuthContext, leadId: string) {
  await assertCanViewLead(auth, leadId)
  assertDocumentViewPermission(auth)
  await ensureDocumentChecklistRules()

  const [rules, documents] = await Promise.all([
    prisma.documentChecklistRule.findMany({
      where: { stage: 'LEAD', isActive: true, isRequired: true },
      orderBy: { sortOrder: 'asc' },
    }),
    prisma.leadDocument.findMany({
      where: { leadId, isLatest: true, archivedAt: null },
      include: DOCUMENT_INCLUDE,
    }),
  ])

  const byType = new Map(documents.map((doc) => [doc.typeCode, doc]))
  const items = rules.map((rule) => {
    const doc = byType.get(rule.typeCode)
    let checklistStatus: 'Missing' | 'Pending' | 'Verified' | 'Rejected' | 'Expired' = 'Missing'
    if (doc) {
      if (doc.status === 'VERIFIED') checklistStatus = 'Verified'
      else if (doc.status === 'REJECTED') checklistStatus = 'Rejected'
      else if (doc.status === 'EXPIRED') checklistStatus = 'Expired'
      else checklistStatus = 'Pending'
    }
    return {
      typeCode: rule.typeCode,
      categoryCode: rule.categoryCode,
      name: rule.name,
      isRequired: rule.isRequired,
      isSensitive: rule.isSensitive,
      checklistStatus,
      completed: checklistStatus === 'Verified',
      document: doc ? serializeDocument(doc) : null,
    }
  })

  const totalRequired = items.length
  const completedRequired = items.filter((item) => item.completed).length
  const completionPercent = totalRequired === 0 ? 100 : Math.round((completedRequired / totalRequired) * 100)

  return {
    items,
    totalRequired,
    completedRequired,
    completionPercent,
    missingCount: items.filter((item) => item.checklistStatus === 'Missing').length,
  }
}

export async function uploadLeadDocument(
  auth: AuthContext,
  leadId: string,
  file: Express.Multer.File | undefined,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  if (!hasPermission(auth.permissions, 'document:upload')) {
    throw httpError.accessDenied()
  }
  const lead = await assertCanViewLead(auth, leadId)
  if (!file) {
    throw httpError.invalidUpload('Please select a document to upload.')
  }

  const categoryCode = (asString(body.categoryCode) || asString(body.category) || 'OTHER').toUpperCase()
  const typeCode = (asString(body.typeCode) || asString(body.documentType) || 'OTHER').toUpperCase()
  if (!categoryCode) {
    throw httpError.validation({ categoryCode: 'Document category is required.' }, 'Document category is required.')
  }
  if (!typeCode) {
    throw httpError.validation({ typeCode: 'Document category is required.' }, 'Document category is required.')
  }

  const typeMeta = await resolveTypeMeta(categoryCode, typeCode)
  let name = asString(body.name) || asString(body.documentName) || typeMeta.type.name
  if (name.length < 2 || name.length > 150) {
    throw httpError.validation({ name: 'Document name must be 2–150 characters.' })
  }

  const remarks = asString(body.remarks)
  if (remarks && remarks.length > 500) {
    throw httpError.validation({ remarks: 'Remarks cannot exceed 500 characters.' })
  }

  const documentDate = parseOptionalDate(body.documentDate, 'documentDate')
  const expiryDate = parseOptionalDate(body.expiryDate, 'expiryDate')
  if (documentDate && expiryDate && expiryDate < documentDate) {
    throw httpError.validation({ expiryDate: 'Expiry date cannot be before document date.' }, 'Expiry date cannot be before document date.')
  }

  const duplicateAction = (asString(body.duplicateAction) || asString(body.action) || '').toLowerCase() as DuplicateAction | ''
  const existing = await prisma.leadDocument.findFirst({
    where: { leadId, typeCode, isLatest: true, archivedAt: null },
    include: DOCUMENT_INCLUDE,
  })

  if (existing && duplicateAction !== 'replace' && duplicateAction !== 'new_version') {
    throw new HttpError(409, 'This document already exists.', 'DUPLICATE_DOCUMENT', undefined, {
      message: `${typeMeta.type.name} document already exists.`,
      document: serializeDocument(existing),
      actions: ['replace', 'new_version', 'cancel'],
    })
  }

  // Preserve original upload file name for storage metadata display of the binary.
  const originalFileName = file.originalname || name
  const saved = await saveLeadDocument(leadId, file, originalFileName)

  try {
    if (existing && (duplicateAction === 'replace' || duplicateAction === 'new_version')) {
      const nextVersion = existing.versionNumber + 1
      const created = await prisma.$transaction(async (tx) => {
        await tx.leadDocument.update({
          where: { id: existing.id },
          data: { isLatest: false, status: 'REPLACED' },
        })
        return tx.leadDocument.create({
          data: {
            leadId,
            documentGroupId: existing.documentGroupId,
            categoryCode,
            typeCode,
            name,
            fileName: saved.fileName,
            mimeType: saved.mimeType,
            storageKey: saved.storageKey,
            fileSize: saved.fileSize,
            versionNumber: nextVersion,
            isLatest: true,
            status: 'PENDING',
            documentDate,
            expiryDate,
            remarks: remarks || null,
            isSensitive: isSensitiveType(typeCode),
            uploadedById: auth.user.id,
          },
          include: DOCUMENT_INCLUDE,
        })
      })

      if (duplicateAction === 'replace') {
        await destroyLeadStoredUpload(existing.storageKey).catch(() => undefined)
      }

      await recordDocumentActivity({
        documentId: created.id,
        action: duplicateAction === 'replace' ? 'REPLACED' : 'UPLOADED',
        userId: auth.user.id,
        notes:
          duplicateAction === 'replace'
            ? `Replaced version ${existing.versionNumber} with version ${created.versionNumber}`
            : `Uploaded version ${created.versionNumber}`,
        metadata: { previousDocumentId: existing.id, duplicateAction },
      })

      await prisma.activity.create({
        data: {
          type: 'NOTE',
          userId: auth.user.id,
          notes: `Document ${duplicateAction === 'replace' ? 'replaced' : 'version uploaded'}: ${created.name}`,
          relatedName: lead.name,
          relatedType: 'lead',
          relatedId: lead.id,
          outcome: 'Document uploaded',
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
      })

      await writeAuditLog({
        userId: auth.user.id,
        action: 'LEAD_DOCUMENT_UPLOADED',
        entityType: 'lead',
        entityId: leadId,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        metadata: {
          fileName: created.fileName,
          documentId: created.id,
          leadCode: lead.code,
          typeCode,
          versionNumber: created.versionNumber,
          duplicateAction,
        },
      })

      await notifyLeadOwner({
        leadId,
        ownerId: lead.ownerId,
        actorId: auth.user.id,
        title: 'Document uploaded',
        body: `${created.name} was uploaded for ${lead.name}.`,
        type: 'document_uploaded',
      })

      return { document: serializeDocument(created) }
    }

    const created = await prisma.leadDocument.create({
      data: {
        leadId,
        documentGroupId: randomUUID(),
        categoryCode,
        typeCode,
        name,
        fileName: saved.fileName,
        mimeType: saved.mimeType,
        storageKey: saved.storageKey,
        fileSize: saved.fileSize,
        versionNumber: 1,
        isLatest: true,
        status: 'PENDING',
        documentDate,
        expiryDate,
        remarks: remarks || null,
        isSensitive: isSensitiveType(typeCode),
        uploadedById: auth.user.id,
      },
      include: DOCUMENT_INCLUDE,
    })

    await recordDocumentActivity({
      documentId: created.id,
      action: 'UPLOADED',
      userId: auth.user.id,
      notes: `Uploaded ${created.name}`,
    })

    await prisma.activity.create({
      data: {
        type: 'NOTE',
        userId: auth.user.id,
        notes: `Document uploaded: ${created.name}`,
        relatedName: lead.name,
        relatedType: 'lead',
        relatedId: lead.id,
        outcome: 'Document uploaded',
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    })

    await writeAuditLog({
      userId: auth.user.id,
      action: 'LEAD_DOCUMENT_UPLOADED',
      entityType: 'lead',
      entityId: leadId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: {
        fileName: created.fileName,
        documentId: created.id,
        leadCode: lead.code,
        typeCode,
        versionNumber: 1,
      },
    })

    await notifyLeadOwner({
      leadId,
      ownerId: lead.ownerId,
      actorId: auth.user.id,
      title: 'Document uploaded',
      body: `${created.name} was uploaded for ${lead.name}.`,
      type: 'document_uploaded',
    })

    return { document: serializeDocument(created) }
  } catch (error) {
    await destroyLeadStoredUpload(saved.storageKey).catch(() => undefined)
    if (error instanceof HttpError) throw error
    console.error('[documents] upload failed:', error)
    throw httpError.invalidUpload('Unable to upload the document. Please try again.')
  }
}

export async function verifyLeadDocument(
  auth: AuthContext,
  leadId: string,
  documentId: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  if (!hasPermission(auth.permissions, 'document:verify')) {
    throw httpError.accessDenied('You are not authorized to access this document.')
  }
  const lead = await assertCanViewLead(auth, leadId)
  const document = await loadDocument(leadId, documentId)
  assertCanAccessDocumentContent(auth, document)

  if (document.status === 'VERIFIED') {
    return { document: serializeDocument(document) }
  }
  if (!document.isLatest) {
    throw httpError.validation({}, 'Unable to verify the document.')
  }

  const remarks = asString(body.remarks) || asString(body.verificationRemarks)
  const updated = await prisma.leadDocument.update({
    where: { id: document.id },
    data: {
      status: 'VERIFIED',
      verifiedById: auth.user.id,
      verifiedAt: new Date(),
      verificationRemarks: remarks || null,
      rejectionReason: null,
    },
    include: DOCUMENT_INCLUDE,
  })

  await recordDocumentActivity({
    documentId: updated.id,
    action: 'VERIFIED',
    userId: auth.user.id,
    notes: remarks || 'Document verified',
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'LEAD_DOCUMENT_VERIFIED',
    entityType: 'lead',
    entityId: leadId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { documentId: updated.id, typeCode: updated.typeCode, leadCode: lead.code },
  })

  if (document.uploadedById && document.uploadedById !== auth.user.id) {
    await createNotification({
      userId: document.uploadedById,
      title: 'Document verified',
      body: `${updated.name} for ${lead.name} was verified.`,
      link: `/leads/${leadId}?tab=attachments`,
      type: 'document_verified',
      leadId,
    }).catch(() => undefined)
  }

  return { document: serializeDocument(updated) }
}

export async function rejectLeadDocument(
  auth: AuthContext,
  leadId: string,
  documentId: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  if (!hasPermission(auth.permissions, 'document:verify')) {
    throw httpError.accessDenied('You are not authorized to access this document.')
  }
  const lead = await assertCanViewLead(auth, leadId)
  const document = await loadDocument(leadId, documentId)
  assertCanAccessDocumentContent(auth, document)

  const reason = asString(body.reason) || asString(body.rejectionReason) || asString(body.remarks)
  if (!reason) {
    throw httpError.validation({ reason: 'Please provide a reason for rejection.' }, 'Please provide a reason for rejection.')
  }

  const updated = await prisma.leadDocument.update({
    where: { id: document.id },
    data: {
      status: 'REJECTED',
      rejectionReason: reason,
      verifiedById: auth.user.id,
      verifiedAt: new Date(),
      verificationRemarks: reason,
    },
    include: DOCUMENT_INCLUDE,
  })

  await recordDocumentActivity({
    documentId: updated.id,
    action: 'REJECTED',
    userId: auth.user.id,
    notes: reason,
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'LEAD_DOCUMENT_REJECTED',
    entityType: 'lead',
    entityId: leadId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { documentId: updated.id, typeCode: updated.typeCode, reason, leadCode: lead.code },
  })

  if (document.uploadedById && document.uploadedById !== auth.user.id) {
    await createNotification({
      userId: document.uploadedById,
      title: 'Document rejected',
      body: `${updated.name} for ${lead.name} was rejected: ${reason}`,
      link: `/leads/${leadId}?tab=attachments`,
      type: 'document_rejected',
      leadId,
    }).catch(() => undefined)
  }

  await notifyLeadOwner({
    leadId,
    ownerId: lead.ownerId,
    actorId: auth.user.id,
    title: 'Document rejected',
    body: `${updated.name} was rejected for ${lead.name}.`,
    type: 'document_rejected',
  })

  return { document: serializeDocument(updated) }
}

export async function archiveLeadDocument(auth: AuthContext, leadId: string, documentId: string, meta: AuditMeta) {
  if (!hasPermission(auth.permissions, 'document:delete')) {
    throw httpError.accessDenied('You are not authorized to access this document.')
  }
  const lead = await assertCanViewLead(auth, leadId)
  const document = await loadDocument(leadId, documentId)
  assertCanAccessDocumentContent(auth, document)

  const updated = await prisma.leadDocument.update({
    where: { id: document.id },
    data: { archivedAt: new Date(), isLatest: false },
    include: DOCUMENT_INCLUDE,
  })

  await recordDocumentActivity({
    documentId: updated.id,
    action: 'ARCHIVED',
    userId: auth.user.id,
    notes: `Archived ${updated.name}`,
  })

  await prisma.activity.create({
    data: {
      type: 'NOTE',
      userId: auth.user.id,
      notes: `Document archived: ${document.name || document.fileName}`,
      relatedName: lead.name,
      relatedType: 'lead',
      relatedId: lead.id,
      outcome: 'Document archived',
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'LEAD_DOCUMENT_ARCHIVED',
    entityType: 'lead',
    entityId: leadId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { fileName: document.fileName, documentId: document.id, leadCode: lead.code },
  })

  return { message: 'Document archived.', document: serializeDocument(updated) }
}

/** Soft-archive (CRM-025). Kept name for route compatibility. */
export async function deleteLeadDocument(auth: AuthContext, leadId: string, documentId: string, meta: AuditMeta) {
  return archiveLeadDocument(auth, leadId, documentId, meta)
}

export async function getLeadDocumentHistory(auth: AuthContext, leadId: string, documentId: string) {
  await assertCanViewLead(auth, leadId)
  assertDocumentViewPermission(auth)
  const document = await loadDocument(leadId, documentId, true)
  assertCanAccessDocumentContent(auth, document)

  const [versions, activities] = await Promise.all([
    prisma.leadDocument.findMany({
      where: { leadId, documentGroupId: document.documentGroupId },
      include: DOCUMENT_INCLUDE,
      orderBy: { versionNumber: 'desc' },
    }),
    prisma.leadDocumentActivity.findMany({
      where: {
        document: { documentGroupId: document.documentGroupId, leadId },
      },
      include: { user: { select: { id: true, fullName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
  ])

  return {
    document: serializeDocument(document),
    versions: versions.map(serializeDocument),
    activities: activities.map((row) => ({
      id: row.id,
      action: row.action,
      notes: row.notes,
      metadata: row.metadata,
      createdAt: row.createdAt.toISOString(),
      user: row.user ? { id: row.user.id, name: row.user.fullName } : null,
    })),
  }
}

export async function getLeadDocumentFile(
  auth: AuthContext,
  leadId: string,
  documentId: string,
  meta: AuditMeta & { mode?: 'view' | 'download' } = {},
) {
  await assertCanViewLead(auth, leadId)
  const mode = meta.mode || 'view'
  if (mode === 'download') {
    if (!hasPermission(auth.permissions, 'document:download')) {
      throw httpError.accessDenied('You are not authorized to access this document.')
    }
  } else if (
    !hasPermission(auth.permissions, 'document:download') &&
    !hasPermission(auth.permissions, 'document:view') &&
    !hasPermission(auth.permissions, 'document:upload')
  ) {
    throw httpError.accessDenied('You are not authorized to access this document.')
  }

  const document = await loadDocument(leadId, documentId, true)
  assertCanAccessDocumentContent(auth, document)

  const buffer = await readLeadStoredFile(document.storageKey)

  await recordDocumentActivity({
    documentId: document.id,
    action: mode === 'download' ? 'DOWNLOADED' : 'VIEWED',
    userId: auth.user.id,
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: mode === 'download' ? 'LEAD_DOCUMENT_DOWNLOADED' : 'LEAD_DOCUMENT_VIEWED',
    entityType: 'lead',
    entityId: leadId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { documentId: document.id, fileName: document.fileName, mode },
  })

  return { buffer, fileName: document.fileName, mimeType: document.mimeType }
}

export async function listGlobalLeadDocuments(
  auth: AuthContext,
  query: {
    search?: string
    categoryCode?: string
    status?: string
    uploadedById?: string
    dateFrom?: string
    dateTo?: string
    verified?: string
    expired?: string
    missing?: string
    page?: number
    limit?: number
  },
) {
  assertDocumentViewPermission(auth)
  await ensureDocumentChecklistRules()

  const page = Math.max(1, query.page || 1)
  const limit = Math.min(100, Math.max(5, query.limit || 20))
  const search = query.search?.trim().toLowerCase()

  const where: Prisma.LeadDocumentWhereInput = {
    isLatest: true,
    archivedAt: null,
    ...(query.categoryCode ? { categoryCode: query.categoryCode.toUpperCase() } : {}),
    ...(query.status ? { status: query.status.toUpperCase() as LeadDocumentStatus } : {}),
    ...(query.uploadedById ? { uploadedById: query.uploadedById } : {}),
    ...(query.verified === 'true' ? { status: 'VERIFIED' } : {}),
    ...(query.verified === 'false' ? { status: { in: ['PENDING', 'REJECTED'] } } : {}),
    ...(query.expired === 'true' ? { status: 'EXPIRED' } : {}),
    ...(query.dateFrom || query.dateTo
      ? {
          createdAt: {
            ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
            ...(query.dateTo ? { lte: new Date(query.dateTo) } : {}),
          },
        }
      : {}),
    lead: {},
  }

  const rows = await prisma.leadDocument.findMany({
    where,
    include: {
      ...DOCUMENT_INCLUDE,
      lead: { select: { id: true, code: true, name: true, ownerId: true } },
    },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  })

  let items = rows.map((row) => ({
    id: row.id,
    leadId: row.lead.id,
    leadCode: row.lead.code,
    owner: `${row.lead.code} — ${row.lead.name}`,
    leadName: row.lead.name,
    type: row.name || row.fileName,
    typeCode: row.typeCode,
    category: row.categoryCode,
    uploadedBy: row.uploadedBy?.fullName || '—',
    status: statusLabel(row.status),
    statusCode: row.status,
    updated: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  }))

  if (search) {
    items = items.filter((row) =>
      [row.owner, row.leadCode, row.leadName, row.type, row.category, row.uploadedBy, row.status, row.typeCode]
        .join(' ')
        .toLowerCase()
        .includes(search),
    )
  }

  if (query.missing === 'true') {
    const checklist = await prisma.documentChecklistRule.findMany({
      where: { stage: 'LEAD', isActive: true, isRequired: true },
    })
    const leadIds = [...new Set(rows.map((row) => row.leadId))]
    const missingLeadIds = new Set<string>()
    for (const leadId of leadIds) {
      const types = new Set(rows.filter((row) => row.leadId === leadId).map((row) => row.typeCode))
      if (checklist.some((rule) => !types.has(rule.typeCode))) missingLeadIds.add(leadId)
    }
    items = items.filter((row) => missingLeadIds.has(row.leadId))
  }

  const total = items.length
  const paged = items.slice((page - 1) * limit, page * limit)
  return { items: paged, total, page, limit }
}

export async function expireLeadDocuments() {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const due = await prisma.leadDocument.findMany({
    where: {
      isLatest: true,
      archivedAt: null,
      expiryDate: { lt: today },
      status: { in: ['PENDING', 'VERIFIED'] },
    },
    include: { lead: { select: { id: true, name: true, ownerId: true, code: true } } },
    take: 200,
  })

  if (due.length === 0) return 0
  const result = await prisma.leadDocument.updateMany({
    where: { id: { in: due.map((doc) => doc.id) } },
    data: { status: 'EXPIRED' },
  })
  return result.count
}

export async function remindExpiringLeadDocuments(daysAhead = 30) {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + daysAhead)

  const docs = await prisma.leadDocument.findMany({
    where: {
      isLatest: true,
      archivedAt: null,
      status: { in: ['PENDING', 'VERIFIED'] },
      expiryDate: { gte: start, lte: end },
    },
    include: { lead: { select: { id: true, name: true, ownerId: true } } },
    take: 200,
  })

  let sent = 0
  for (const doc of docs) {
    if (!doc.lead.ownerId || !doc.expiryDate) continue
    const days = Math.ceil((doc.expiryDate.getTime() - start.getTime()) / (24 * 60 * 60 * 1000))
    await createNotification({
      userId: doc.lead.ownerId,
      title: 'Document Expiry Reminder',
      body: `${doc.name || doc.fileName} of ${doc.lead.name} will expire in ${days} day(s).`,
      link: `/leads/${doc.lead.id}?tab=attachments`,
      type: 'document_expiring',
      leadId: doc.lead.id,
      dedupeKey: `doc-expiry-${doc.id}-${doc.expiryDate.toISOString().slice(0, 10)}`,
    }).catch(() => undefined)
    sent += 1
  }
  return sent
}

/**
 * Copies an email attachment into Lead Documents (system/inbound path — no auth upload permission).
 */
export async function createLeadDocumentFromEmailAttachment(input: {
  leadId: string
  leadName: string
  buffer: Buffer
  mimeType: string
  fileName: string
  messageId: string
  category?: string | null
  uploadedById: string
}) {
  const mime = (input.mimeType || '').toLowerCase().split(';')[0].trim()
  if (!LEAD_DOC_MIME_TYPES.has(mime) || input.buffer.length > MAX_LEAD_UPLOAD_BYTES || input.buffer.length <= 0) {
    return { created: false as const, skipped: true as const, reason: 'unsupported' as const }
  }

  const baseName = (input.fileName || 'attachment').replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 120)
  const categoryPart = input.category?.trim() ? ` · ${input.category.trim()}` : ''
  const displayName = `[Email${categoryPart} · ${input.messageId.slice(0, 8)}] ${baseName}`.slice(0, 200)

  const existing = await prisma.leadDocument.findFirst({
    where: { leadId: input.leadId, fileName: displayName, isLatest: true, archivedAt: null },
    select: { id: true },
  })
  if (existing) {
    return { created: false as const, skipped: false as const, documentId: existing.id }
  }

  const fakeFile = {
    buffer: input.buffer,
    mimetype: mime,
    size: input.buffer.length,
    originalname: baseName,
  } as Express.Multer.File

  let saved
  try {
    saved = await saveLeadDocument(input.leadId, fakeFile, displayName)
  } catch (error) {
    console.error('[email→docs] lead document save failed:', error)
    return { created: false as const, skipped: true as const, reason: 'upload_failed' as const }
  }

  const created = await prisma.leadDocument.create({
    data: {
      leadId: input.leadId,
      documentGroupId: randomUUID(),
      categoryCode: 'OTHER',
      typeCode: 'OTHER',
      name: displayName.slice(0, 150),
      fileName: saved.fileName,
      mimeType: saved.mimeType,
      storageKey: saved.storageKey,
      fileSize: saved.fileSize,
      versionNumber: 1,
      isLatest: true,
      status: 'PENDING',
      isSensitive: false,
      uploadedById: input.uploadedById,
    },
  })

  await recordDocumentActivity({
    documentId: created.id,
    action: 'UPLOADED',
    userId: input.uploadedById,
    notes: `Document from email${input.category ? ` (${input.category})` : ''}`,
    metadata: { source: 'email', messageId: input.messageId },
  }).catch(() => undefined)

  await prisma.activity
    .create({
      data: {
        type: 'NOTE',
        userId: input.uploadedById,
        notes: `Document from email${input.category ? ` (${input.category})` : ''}: ${created.fileName}`,
        relatedName: input.leadName,
        relatedType: 'lead',
        relatedId: input.leadId,
        outcome: 'Document from email',
        metadata: {
          source: 'email',
          messageId: input.messageId,
          category: input.category || null,
          documentId: created.id,
        },
      },
    })
    .catch(() => undefined)

  return { created: true as const, skipped: false as const, documentId: created.id }
}
