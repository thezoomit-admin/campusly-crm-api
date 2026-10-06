import { writeAuditLog } from '../../lib/audit'
import { httpError } from '../../lib/http-error'
import { prisma } from '../../lib/prisma'
import { hasPermission } from '../auth/access'
import type { AuthContext } from '../auth/session.service'
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
  'image/webp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])

type AuditMeta = { ipAddress?: string; userAgent?: string }

function serializeDocument(row: {
  id: string
  fileName: string
  mimeType: string
  fileSize: number
  createdAt: Date
  uploadedBy: { id: string; fullName: string } | null
}) {
  return {
    id: row.id,
    fileName: row.fileName,
    mimeType: row.mimeType,
    fileSize: row.fileSize,
    createdAt: row.createdAt.toISOString(),
    uploadedBy: row.uploadedBy ? { id: row.uploadedBy.id, name: row.uploadedBy.fullName } : null,
  }
}

export async function listLeadDocuments(auth: AuthContext, leadId: string) {
  await assertCanViewLead(auth, leadId)
  if (!hasPermission(auth.permissions, 'document:view') && !hasPermission(auth.permissions, 'lead:view')) {
    throw httpError.accessDenied()
  }

  const items = await prisma.leadDocument.findMany({
    where: { leadId },
    include: { uploadedBy: { select: { id: true, fullName: true } } },
    orderBy: { createdAt: 'desc' },
  })

  return { items: items.map(serializeDocument) }
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

  const fileName = asString(body.fileName)
  if (!fileName) {
    throw httpError.validation({ fileName: 'File name is required.' }, 'File name is required.')
  }
  if (fileName.length > 200) {
    throw httpError.validation({ fileName: 'File name cannot exceed 200 characters.' })
  }

  const saved = await saveLeadDocument(leadId, file, fileName)
  const created = await prisma.leadDocument.create({
    data: {
      leadId,
      fileName: saved.fileName,
      mimeType: saved.mimeType,
      storageKey: saved.storageKey,
      fileSize: saved.fileSize,
      uploadedById: auth.user.id,
    },
    include: { uploadedBy: { select: { id: true, fullName: true } } },
  })

  await prisma.activity.create({
    data: {
      type: 'NOTE',
      userId: auth.user.id,
      notes: `Document uploaded: ${created.fileName}`,
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
    metadata: { fileName: created.fileName, documentId: created.id, leadCode: lead.code },
  })

  return { document: serializeDocument(created) }
}

export async function deleteLeadDocument(auth: AuthContext, leadId: string, documentId: string, meta: AuditMeta) {
  if (!hasPermission(auth.permissions, 'document:delete') && !hasPermission(auth.permissions, 'document:upload')) {
    throw httpError.accessDenied()
  }
  const lead = await assertCanViewLead(auth, leadId)
  const document = await prisma.leadDocument.findFirst({
    where: { id: documentId, leadId },
  })
  if (!document) {
    throw httpError.notFound('Document not found.')
  }

  await prisma.leadDocument.delete({ where: { id: document.id } })
  await destroyLeadStoredUpload(document.storageKey)

  await prisma.activity.create({
    data: {
      type: 'NOTE',
      userId: auth.user.id,
      notes: `Document deleted: ${document.fileName}`,
      relatedName: lead.name,
      relatedType: 'lead',
      relatedId: lead.id,
      outcome: 'Document deleted',
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'LEAD_DOCUMENT_DELETED',
    entityType: 'lead',
    entityId: leadId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { fileName: document.fileName, documentId: document.id, leadCode: lead.code },
  })

  return { message: 'Document deleted.' }
}

export async function getLeadDocumentFile(auth: AuthContext, leadId: string, documentId: string) {
  await assertCanViewLead(auth, leadId)
  if (
    !hasPermission(auth.permissions, 'document:download') &&
    !hasPermission(auth.permissions, 'document:view') &&
    !hasPermission(auth.permissions, 'document:upload')
  ) {
    throw httpError.accessDenied()
  }

  const document = await prisma.leadDocument.findFirst({
    where: { id: documentId, leadId },
  })
  if (!document) {
    throw httpError.notFound('Document not found.')
  }

  const buffer = await readLeadStoredFile(document.storageKey)
  return { buffer, fileName: document.fileName, mimeType: document.mimeType }
}

/**
 * Copies an email attachment into Lead Documents (system/inbound path — no auth upload permission).
 * Skips unsupported types/sizes and dedupes by display file name.
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
    where: { leadId: input.leadId, fileName: displayName },
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
      fileName: saved.fileName,
      mimeType: saved.mimeType,
      storageKey: saved.storageKey,
      fileSize: saved.fileSize,
      uploadedById: input.uploadedById,
    },
  })

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
