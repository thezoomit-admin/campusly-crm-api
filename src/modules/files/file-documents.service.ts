import type { FileDocumentStatus, Prisma } from '../../lib/prisma-client'
import { writeAuditLog } from '../../lib/audit'
import { HttpError, httpError } from '../../lib/http-error'
import { prisma } from '../../lib/prisma'
import { hasPermission } from '../auth/access'
import type { AuthContext } from '../auth/session.service'
import { isEmailConfigured, isEmailMockMode, sendMailboxEmail } from '../email/email.client'
import { createNotification } from '../notifications/notifications.service'
import { assertCanViewLead, asString, leadScopeWhere } from '../leads/leads.helpers'
import { isMockMode as isWhatsAppMock, isWhatsAppConfigured, sendWhatsApp } from '../whatsapp/whatsapp.client'
import { readFileDocumentAsset, saveFileDocumentAsset } from './file-documents.storage'

const SENSITIVE_TYPES = new Set(['PASSPORT', 'NID', 'BANK_STATEMENT', 'SPONSOR', 'FINANCIAL_CERTIFICATE'])
const APPLICATION_TYPES = new Set(['SOP', 'CV', 'RECOMMENDATION', 'APPLICATION_FORM', 'OFFER'])
const REQUEST_METHODS = new Set(['WHATSAPP', 'EMAIL', 'PHONE', 'IN_PERSON', 'OTHER'])

const FILE_TEMPLATE: Array<{
  categoryCode: string
  categoryName: string
  typeCode: string
  typeName: string
  isRequired: boolean
  isSensitive: boolean
  sortOrder: number
}> = [
  { categoryCode: 'PERSONAL', categoryName: 'Personal', typeCode: 'PASSPORT', typeName: 'Passport', isRequired: true, isSensitive: true, sortOrder: 1 },
  { categoryCode: 'PERSONAL', categoryName: 'Personal', typeCode: 'PHOTOGRAPH', typeName: 'Photograph', isRequired: true, isSensitive: false, sortOrder: 2 },
  { categoryCode: 'ACADEMIC', categoryName: 'Academic', typeCode: 'ACADEMIC_CERTIFICATE', typeName: 'Academic Certificate', isRequired: true, isSensitive: false, sortOrder: 3 },
  { categoryCode: 'ACADEMIC', categoryName: 'Academic', typeCode: 'TRANSCRIPT', typeName: 'Academic Transcript', isRequired: true, isSensitive: false, sortOrder: 4 },
  { categoryCode: 'PROFESSIONAL', categoryName: 'Professional', typeCode: 'CV_PROFESSIONAL', typeName: 'CV', isRequired: false, isSensitive: false, sortOrder: 5 },
  { categoryCode: 'LANGUAGE', categoryName: 'Language', typeCode: 'IELTS', typeName: 'English Test Result', isRequired: false, isSensitive: false, sortOrder: 6 },
]

const MASTER_ENSURE: Array<{ categoryKey: string; name: string; code: string; sortOrder: number; parentCode?: string }> = [
  { categoryKey: 'DOCUMENT_CATEGORY', name: 'Professional', code: 'PROFESSIONAL', sortOrder: 6 },
  { categoryKey: 'DOCUMENT_TYPE', name: 'Academic Certificate', code: 'ACADEMIC_CERTIFICATE', sortOrder: 21, parentCode: 'ACADEMIC' },
  { categoryKey: 'DOCUMENT_TYPE', name: 'CV', code: 'CV_PROFESSIONAL', sortOrder: 60, parentCode: 'PROFESSIONAL' },
  { categoryKey: 'DOCUMENT_TYPE', name: 'Experience Certificate', code: 'EXPERIENCE_CERTIFICATE', sortOrder: 61, parentCode: 'PROFESSIONAL' },
  { categoryKey: 'REJECTION_REASON', name: 'Blurry', code: 'BLURRY', sortOrder: 6 },
  { categoryKey: 'REJECTION_REASON', name: 'Wrong Document', code: 'WRONG_DOCUMENT', sortOrder: 7 },
  { categoryKey: 'REJECTION_REASON', name: 'Incorrect Information', code: 'INCORRECT_INFORMATION', sortOrder: 8 },
  { categoryKey: 'REJECTION_REASON', name: 'Missing Page', code: 'MISSING_PAGE', sortOrder: 9 },
  { categoryKey: 'REJECTION_REASON', name: 'Invalid Copy', code: 'INVALID_COPY', sortOrder: 10 },
  { categoryKey: 'REJECTION_REASON', name: 'Other', code: 'OTHER', sortOrder: 11 },
  { categoryKey: 'DOCUMENT_REQUEST_METHOD', name: 'WhatsApp', code: 'WHATSAPP', sortOrder: 1 },
  { categoryKey: 'DOCUMENT_REQUEST_METHOD', name: 'Email', code: 'EMAIL', sortOrder: 2 },
  { categoryKey: 'DOCUMENT_REQUEST_METHOD', name: 'Phone', code: 'PHONE', sortOrder: 3 },
  { categoryKey: 'DOCUMENT_REQUEST_METHOD', name: 'In Person', code: 'IN_PERSON', sortOrder: 4 },
  { categoryKey: 'DOCUMENT_REQUEST_METHOD', name: 'Other', code: 'OTHER', sortOrder: 5 },
]

type AuditMeta = { ipAddress?: string; userAgent?: string }
type UploadMode = 'create' | 'additional' | 'reupload'

const VERSION_INCLUDE = {
  assets: { orderBy: { createdAt: 'asc' as const } },
  uploadedBy: { select: { id: true, fullName: true } },
  verifiedBy: { select: { id: true, fullName: true } },
} satisfies Prisma.FileDocumentVersionInclude

function statusLabel(status: string) {
  switch (status) {
    case 'NOT_REQUESTED':
      return 'Not Requested'
    case 'REQUESTED':
      return 'Requested'
    case 'RECEIVED':
      return 'Received'
    case 'UNDER_REVIEW':
      return 'Under Review'
    case 'VERIFIED':
      return 'Verified'
    case 'REJECTED':
      return 'Rejected'
    case 'REUPLOAD_REQUIRED':
      return 'Re-upload Required'
    case 'ARCHIVED':
      return 'Archived'
    default:
      return status
  }
}

function reminderDays() {
  return Math.max(1, Number(process.env.DOCUMENT_EXPIRY_REMINDER_DAYS || 30) || 30)
}

function startOfToday() {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return today
}

function expiryState(expiryDate: Date | null | undefined) {
  if (!expiryDate) return 'NONE' as const
  const today = startOfToday()
  const expiry = new Date(expiryDate)
  expiry.setHours(0, 0, 0, 0)
  if (expiry < today) return 'EXPIRED' as const
  const soon = new Date(today)
  soon.setDate(soon.getDate() + reminderDays())
  if (expiry <= soon) return 'EXPIRING' as const
  return 'VALID' as const
}

function parseOptionalDate(value: unknown, field: string) {
  const raw = asString(value)
  if (!raw) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  const date = match
    ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    : new Date(raw)
  if (Number.isNaN(date.getTime())) {
    throw httpError.validation({ [field]: 'Valid date is required.' })
  }
  return date
}

function canAccessSensitive(auth: AuthContext) {
  return (
    hasPermission(auth.permissions, 'document:sensitive') ||
    hasPermission(auth.permissions, 'document:verify') ||
    auth.roles.some((role) => role.toLowerCase() === 'admin')
  )
}

function assertView(auth: AuthContext) {
  if (!hasPermission(auth.permissions, 'document:view') && !hasPermission(auth.permissions, 'lead:view')) {
    throw httpError.accessDenied('You are not authorized to access this document.')
  }
}

function assertUpload(auth: AuthContext) {
  if (!hasPermission(auth.permissions, 'document:upload')) {
    throw httpError.accessDenied('You are not authorized to access this document.')
  }
}

function assertVerify(auth: AuthContext) {
  if (!hasPermission(auth.permissions, 'document:verify')) {
    throw httpError.accessDenied('You are not authorized to access this document.')
  }
}

function assertDownload(auth: AuthContext) {
  if (
    !hasPermission(auth.permissions, 'document:download') &&
    !hasPermission(auth.permissions, 'document:view') &&
    !hasPermission(auth.permissions, 'document:upload')
  ) {
    throw httpError.accessDenied('You are not authorized to access this document.')
  }
}

function assertManage(auth: AuthContext) {
  if (!hasPermission(auth.permissions, 'document:delete') && !auth.roles.some((role) => role.toLowerCase() === 'admin')) {
    throw httpError.accessDenied('You are not authorized to access this document.')
  }
}

async function nextCode(tx: Prisma.TransactionClient, key: string, prefix: string) {
  const row = await tx.documentSequence.upsert({
    where: { key },
    create: { key, nextValue: 2 },
    update: { nextValue: { increment: 1 } },
  })
  return `${prefix}-${String(row.nextValue - 1).padStart(6, '0')}`
}

async function isFileOpenedLead(lead: { statusCode: string | null; status: string }) {
  if ((lead.statusCode || '').toUpperCase() === 'FILE_OPENED') return true
  if (!lead.statusCode && lead.status.trim().toLowerCase() === 'file opened') return true
  if (!lead.statusCode) return false
  const item = await prisma.masterDataItem.findFirst({
    where: { categoryKey: 'LEAD_STATUS', code: lead.statusCode },
    select: { behaviorKey: true },
  })
  return item?.behaviorKey === 'file_opened'
}

export async function ensureFileDocumentSetup() {
  const ruleCount = await prisma.documentChecklistRule.count({ where: { stage: 'FILE' } })
  if (ruleCount === 0) {
    await prisma.documentChecklistRule.createMany({
      data: FILE_TEMPLATE.map((row) => ({
        categoryCode: row.categoryCode,
        typeCode: row.typeCode,
        name: row.typeName,
        stage: 'FILE' as const,
        isRequired: row.isRequired,
        isSensitive: row.isSensitive,
        sortOrder: row.sortOrder,
        isActive: true,
      })),
    })
  }

  for (const item of MASTER_ENSURE) {
    const parent = item.parentCode
      ? await prisma.masterDataItem.findFirst({
          where: {
            categoryKey: item.categoryKey === 'DOCUMENT_TYPE' ? 'DOCUMENT_CATEGORY' : undefined,
            code: item.parentCode,
          },
          select: { id: true },
        })
      : null
    if (item.parentCode && !parent) continue
    await prisma.masterDataItem.upsert({
      where: { categoryKey_code: { categoryKey: item.categoryKey, code: item.code } },
      update: { status: 'ACTIVE' },
      create: {
        categoryKey: item.categoryKey,
        name: item.name,
        nameNormalized: item.name.trim().toLowerCase(),
        code: item.code,
        sortOrder: item.sortOrder,
        parentId: parent?.id ?? null,
        status: 'ACTIVE',
      },
    })
  }
}

async function loadTemplate() {
  await ensureFileDocumentSetup()
  const rules = await prisma.documentChecklistRule.findMany({
    where: { stage: 'FILE', isActive: true },
    orderBy: { sortOrder: 'asc' },
  })
  if (rules.length === 0) return FILE_TEMPLATE
  return rules.map((rule) => {
    const fallback = FILE_TEMPLATE.find((row) => row.typeCode === rule.typeCode)
    return {
      categoryCode: rule.categoryCode,
      categoryName: fallback?.categoryName || rule.categoryCode,
      typeCode: rule.typeCode,
      typeName: rule.name,
      isRequired: rule.isRequired,
      isSensitive: rule.isSensitive,
      sortOrder: rule.sortOrder,
    }
  })
}

async function recordActivity(input: {
  documentId: string
  action: Prisma.FileDocumentActivityCreateInput['action']
  userId?: string | null
  notes?: string | null
  metadata?: Prisma.InputJsonValue
}) {
  await prisma.fileDocumentActivity.create({
    data: {
      documentId: input.documentId,
      action: input.action,
      userId: input.userId || null,
      notes: input.notes || null,
      metadata: input.metadata,
    },
  })
}

async function recordLeadTimeline(input: {
  leadId: string
  leadName: string
  userId: string
  type: 'DOCUMENT_REQUEST' | 'OTHER'
  notes: string
  meta?: AuditMeta
  metadata?: Prisma.InputJsonValue
}) {
  await prisma.activity.create({
    data: {
      type: input.type,
      userId: input.userId,
      notes: input.notes,
      relatedName: input.leadName,
      relatedType: 'lead',
      relatedId: input.leadId,
      outcome: 'Document',
      metadata: input.metadata,
      ipAddress: input.meta?.ipAddress,
      userAgent: input.meta?.userAgent,
    },
  })
}

function latestVersion<T extends { isLatest: boolean; versionNumber: number; expiryDate: Date | null }>(versions: T[]) {
  return versions.find((row) => row.isLatest) || versions[0] || null
}

function isVersionExpired(version: { expiryDate: Date | null } | null) {
  return expiryState(version?.expiryDate) === 'EXPIRED'
}

async function refreshReadiness(fileId: string) {
  const [items, documents] = await Promise.all([
    prisma.fileChecklistItem.findMany({ where: { fileId, isActive: true, isRequired: true } }),
    prisma.fileDocument.findMany({
      where: { fileId, archivedAt: null },
      include: { versions: { where: { isLatest: true }, take: 1 } },
    }),
  ])
  const byType = new Map(documents.map((doc) => [doc.typeCode, doc]))
  let verified = 0
  for (const item of items) {
    const doc = byType.get(item.typeCode)
    const version = doc?.versions[0] || null
    if (doc?.status === 'VERIFIED' && !isVersionExpired(version)) verified += 1
  }
  const total = items.length
  const complete = total === 0 || verified === total
  await prisma.crmFile.update({
    where: { id: fileId },
    data: { documentReadiness: complete ? 'COMPLETE' : 'INCOMPLETE' },
  })
  return { verified, total, percent: total === 0 ? 100 : Math.round((verified / total) * 100) }
}

type VersionRow = Prisma.FileDocumentVersionGetPayload<{ include: typeof VERSION_INCLUDE }>

function serializeVersion(version: VersionRow) {
  return {
    id: version.id,
    versionNumber: version.versionNumber,
    isLatest: version.isLatest,
    documentDate: version.documentDate ? version.documentDate.toISOString().slice(0, 10) : null,
    expiryDate: version.expiryDate ? version.expiryDate.toISOString().slice(0, 10) : null,
    expiryStatus: expiryState(version.expiryDate),
    remarks: version.remarks,
    rejectionReasonCode: version.rejectionReasonCode,
    rejectionReasonName: version.rejectionReasonName,
    rejectionRemarks: version.rejectionRemarks,
    verifiedBy: version.verifiedBy ? { id: version.verifiedBy.id, name: version.verifiedBy.fullName } : null,
    verifiedAt: version.verifiedAt?.toISOString() || null,
    verificationRemarks: version.verificationRemarks,
    uploadedBy: version.uploadedBy ? { id: version.uploadedBy.id, name: version.uploadedBy.fullName } : null,
    uploadedByKind: version.uploadedByKind,
    uploadedAt: version.createdAt.toISOString(),
    assets: version.assets.map((asset) => ({
      id: asset.id,
      fileName: asset.fileName,
      label: asset.label,
      mimeType: asset.mimeType,
      fileSize: asset.fileSize,
      isPrimary: asset.isPrimary,
      createdAt: asset.createdAt.toISOString(),
    })),
  }
}

const DOCUMENT_INCLUDE = {
  versions: { orderBy: { versionNumber: 'desc' as const }, include: VERSION_INCLUDE },
  requests: {
    orderBy: { createdAt: 'desc' as const },
    include: { requestedBy: { select: { id: true, fullName: true } } },
  },
  activities: {
    orderBy: { createdAt: 'desc' as const },
    include: { user: { select: { id: true, fullName: true } } },
  },
} satisfies Prisma.FileDocumentInclude

type DocumentRow = Prisma.FileDocumentGetPayload<{ include: typeof DOCUMENT_INCLUDE }>

function serializeDocument(row: DocumentRow) {
  const latest = latestVersion(row.versions)
  const expired = row.status === 'VERIFIED' && isVersionExpired(latest)
  return {
    id: row.id,
    code: row.code,
    categoryCode: row.categoryCode,
    categoryName: row.categoryNameSnapshot,
    typeCode: row.typeCode,
    typeName: row.typeNameSnapshot,
    requirement: row.requirement,
    status: row.status,
    statusLabel: expired ? 'Expired' : statusLabel(row.status),
    expiryStatus: latest ? expiryState(latest.expiryDate) : 'NONE',
    archivedAt: row.archivedAt?.toISOString() || null,
    latestVersion: latest ? serializeVersion(latest as VersionRow) : null,
    versions: row.versions.map((version) => serializeVersion(version as VersionRow)),
    requests: row.requests.map((request) => ({
      id: request.id,
      code: request.code,
      method: request.method,
      dueDate: request.dueDate ? request.dueDate.toISOString().slice(0, 10) : null,
      remarks: request.remarks,
      status: request.status,
      requestedAt: request.createdAt.toISOString(),
      requestedBy: request.requestedBy ? { id: request.requestedBy.id, name: request.requestedBy.fullName } : null,
      activityId: request.activityId,
      communicationEventId: request.communicationEventId,
    })),
    activities: row.activities.map((activity) => ({
      id: activity.id,
      action: activity.action,
      notes: activity.notes,
      createdAt: activity.createdAt.toISOString(),
      user: activity.user ? { id: activity.user.id, name: activity.user.fullName } : null,
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

async function loadDocument(fileId: string, documentId: string) {
  const document = await prisma.fileDocument.findFirst({
    where: { id: documentId, fileId },
    include: DOCUMENT_INCLUDE,
  })
  if (!document) throw httpError.notFound('Document not found.')
  return document
}

function assertSensitive(auth: AuthContext, typeCode: string) {
  if (SENSITIVE_TYPES.has(typeCode) && !canAccessSensitive(auth)) {
    throw httpError.accessDenied('You are not authorized to access this document.')
  }
}

export async function openCrmFile(auth: AuthContext, leadId: string, meta?: AuditMeta) {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { id: true, code: true, name: true, ownerId: true, statusCode: true, status: true },
  })
  if (!lead) throw httpError.notFound('Lead not found.')

  const existing = await prisma.crmFile.findUnique({ where: { leadId } })
  if (existing) return existing

  const template = await loadTemplate()
  const file = await prisma.$transaction(async (tx) => {
    const code = await nextCode(tx, 'crm_file', 'FILE')
    const created = await tx.crmFile.create({
      data: {
        code,
        leadId: lead.id,
        studentName: lead.name,
        ownerId: lead.ownerId,
        status: 'OPEN',
        documentReadiness: 'INCOMPLETE',
        openedById: auth.user.id,
      },
    })
    for (const item of template) {
      const checklist = await tx.fileChecklistItem.create({
        data: {
          fileId: created.id,
          categoryCode: item.categoryCode,
          categoryName: item.categoryName,
          typeCode: item.typeCode,
          typeName: item.typeName,
          isRequired: item.isRequired,
          sortOrder: item.sortOrder,
        },
      })
      const docCode = await nextCode(tx, 'file_document', 'DOC')
      await tx.fileDocument.create({
        data: {
          code: docCode,
          fileId: created.id,
          checklistItemId: checklist.id,
          categoryCode: item.categoryCode,
          categoryNameSnapshot: item.categoryName,
          typeCode: item.typeCode,
          typeNameSnapshot: item.typeName,
          requirement: item.isRequired ? 'REQUIRED' : 'OPTIONAL',
          status: 'NOT_REQUESTED',
        },
      })
    }
    return created
  })

  await recordLeadTimeline({
    leadId: lead.id,
    leadName: lead.name,
    userId: auth.user.id,
    type: 'OTHER',
    notes: `File ${file.code} opened. Initial document checklist created.`,
    meta,
    metadata: { fileId: file.id, fileCode: file.code, event: 'file_opened' },
  })
  await writeAuditLog({
    userId: auth.user.id,
    action: 'FILE_OPENED',
    entityType: 'crm_file',
    entityId: file.id,
    ipAddress: meta?.ipAddress,
    userAgent: meta?.userAgent,
    metadata: { fileCode: file.code, leadId: lead.id, leadCode: lead.code },
  })
  try {
    const owner = lead.ownerId
      ? await prisma.user.findUnique({ where: { id: lead.ownerId }, select: { fullName: true } })
      : null
    const { dispatchCrmEvent } = await import('../notifications/notifications.service')
    await dispatchCrmEvent({
      eventType: 'file_opened',
      dedupeKey: `file-opened:${file.id}`,
      title: 'File Opened',
      body: `Lead: ${lead.name} — File ID: ${file.code} — Owner: ${owner?.fullName || '—'}`,
      link: `/leads/${lead.id}`,
      leadId: lead.id,
      ownerId: lead.ownerId,
      payload: { leadName: lead.name, leadCode: lead.code, fileCode: file.code, ownerName: owner?.fullName || null },
      actions: [{ key: 'open_file', label: 'Open File', href: `/leads/${lead.id}` }],
    })
  } catch (error) {
    console.error('[notifications] File opening notification failed:', error)
  }
  return file
}

async function fileContext(auth: AuthContext, leadId: string) {
  assertView(auth)
  const lead = await assertCanViewLead(auth, leadId)
  let file = await prisma.crmFile.findUnique({ where: { leadId } })
  if (!file && (await isFileOpenedLead(lead))) {
    try {
      file = await openCrmFile(auth, leadId)
    } catch (error) {
      file = await prisma.crmFile.findUnique({ where: { leadId } })
      if (!file) throw error
    }
  }
  return { lead, file }
}

function buildSummary(checklist: Array<{ typeCode: string; isRequired: boolean; isActive: boolean }>, documents: DocumentRow[]) {
  const activeItems = checklist.filter((item) => item.isActive)
  const activeDocs = documents.filter((doc) => !doc.archivedAt)
  const byType = new Map(activeDocs.map((doc) => [doc.typeCode, doc]))
  const required = activeItems.filter((item) => item.isRequired)
  let verifiedRequired = 0
  let missing = 0
  for (const item of required) {
    const doc = byType.get(item.typeCode)
    const latest = doc ? latestVersion(doc.versions) : null
    const verified = doc?.status === 'VERIFIED' && !isVersionExpired(latest)
    if (verified) verifiedRequired += 1
    if (!latest) missing += 1
  }
  const verified = activeDocs.filter((doc) => doc.status === 'VERIFIED' && !isVersionExpired(latestVersion(doc.versions))).length
  const rejected = activeDocs.filter((doc) => doc.status === 'REJECTED' || doc.status === 'REUPLOAD_REQUIRED').length
  const pending = activeItems.filter((item) => {
    const doc = byType.get(item.typeCode)
    if (!doc) return true
    return doc.status !== 'VERIFIED' && doc.status !== 'REJECTED' && doc.status !== 'REUPLOAD_REQUIRED' && doc.status !== 'ARCHIVED'
  }).length
  return {
    total: activeItems.length,
    verified,
    pending,
    rejected,
    required: required.length,
    requested: activeDocs.filter((doc) => doc.status === 'REQUESTED').length,
    received: activeDocs.filter((doc) => latestVersion(doc.versions)).length,
    underReview: activeDocs.filter((doc) => doc.status === 'UNDER_REVIEW').length,
    missing,
    completionPercent: required.length === 0 ? 100 : Math.round((verifiedRequired / required.length) * 100),
  }
}

export async function getFileWorkspace(auth: AuthContext, leadId: string, options?: { archived?: boolean }) {
  const { lead, file } = await fileContext(auth, leadId)
  if (!file) {
    return { available: false, file: null, summary: null, checklist: [], documents: [], catalog: [] }
  }

  await refreshReadiness(file.id)
  const [checklist, documents, catalog, reasons] = await Promise.all([
    prisma.fileChecklistItem.findMany({ where: { fileId: file.id }, orderBy: { sortOrder: 'asc' } }),
    prisma.fileDocument.findMany({
      where: { fileId: file.id, ...(options?.archived ? {} : { archivedAt: null }) },
      include: DOCUMENT_INCLUDE,
      orderBy: { createdAt: 'asc' },
    }),
    prisma.masterDataItem.findMany({
      where: { categoryKey: 'DOCUMENT_TYPE', status: 'ACTIVE' },
      include: { parent: { select: { code: true, name: true } } },
      orderBy: { sortOrder: 'asc' },
    }),
    listRejectionReasons(),
  ])

  const summary = buildSummary(checklist, documents)
  const visibleDocs = documents.filter((doc) => !SENSITIVE_TYPES.has(doc.typeCode) || canAccessSensitive(auth))

  return {
    available: true,
    file: {
      id: file.id,
      code: file.code,
      leadId: lead.id,
      leadCode: lead.code,
      studentName: file.studentName,
      status: file.status,
      documentReadiness: summary.completionPercent === 100 ? 'COMPLETE' : file.documentReadiness,
      openedAt: file.openedAt.toISOString(),
    },
    summary,
    checklist: checklist.map((item) => {
      const doc = documents.find((row) => row.typeCode === item.typeCode && !row.archivedAt)
      const latest = doc ? latestVersion(doc.versions) : null
      const completed = doc?.status === 'VERIFIED' && !isVersionExpired(latest)
      return {
        id: item.id,
        categoryCode: item.categoryCode,
        categoryName: item.categoryName,
        typeCode: item.typeCode,
        typeName: item.typeName,
        isRequired: item.isRequired,
        isActive: item.isActive,
        completed: Boolean(completed),
        documentId: doc?.id || null,
        status: doc ? (isVersionExpired(latest) && doc.status === 'VERIFIED' ? 'EXPIRED' : doc.status) : 'MISSING',
      }
    }),
    documents: visibleDocs.map(serializeDocument),
    rejectionReasons: reasons,
    catalog: catalog
      .filter((item) => item.parent?.code !== 'APPLICATION' && !APPLICATION_TYPES.has(item.code || ''))
      .map((item) => ({
        typeCode: item.code,
        typeName: item.name,
        categoryCode: item.parent?.code || 'OTHER',
        categoryName: item.parent?.name || 'Other',
      })),
  }
}

async function resolveCatalogType(typeCode: string) {
  const type = await prisma.masterDataItem.findFirst({
    where: { categoryKey: 'DOCUMENT_TYPE', code: typeCode, status: 'ACTIVE' },
    include: { parent: { select: { code: true, name: true } } },
  })
  if (!type) {
    throw httpError.validation({ typeCode: 'Document category is required.' }, 'Please select a document.')
  }
  if (type.parent?.code === 'APPLICATION' || APPLICATION_TYPES.has(type.code || '')) {
    throw httpError.validation(
      { typeCode: 'Application-specific documents are managed by a future Application System.' },
      'Application-specific documents are managed by a future Application System.',
    )
  }
  return {
    typeCode: type.code || typeCode,
    typeName: type.name,
    categoryCode: type.parent?.code || 'OTHER',
    categoryName: type.parent?.name || 'Other',
  }
}

export async function addChecklistItem(auth: AuthContext, leadId: string, body: Record<string, unknown>, meta: AuditMeta) {
  assertManage(auth)
  const { file } = await fileContext(auth, leadId)
  if (!file) throw httpError.validation({ file: 'File opening is required before documents can be managed.' })
  const typeCode = asString(body.typeCode).toUpperCase()
  if (!typeCode) throw httpError.validation({ typeCode: 'Please select a document.' })
  const optional = body.isRequired === false || body.isRequired === 'false'
  const metaType = await resolveCatalogType(typeCode)

  const existing = await prisma.fileChecklistItem.findUnique({
    where: { fileId_typeCode: { fileId: file.id, typeCode: metaType.typeCode } },
  })
  if (existing?.isActive) {
    throw new HttpError(409, 'A document of this type already exists.', 'DUPLICATE_DOCUMENT')
  }

  const item = existing
    ? await prisma.fileChecklistItem.update({
        where: { id: existing.id },
        data: { isActive: true, isRequired: !optional, typeName: metaType.typeName, categoryName: metaType.categoryName },
      })
    : await prisma.fileChecklistItem.create({
        data: {
          fileId: file.id,
          categoryCode: metaType.categoryCode,
          categoryName: metaType.categoryName,
          typeCode: metaType.typeCode,
          typeName: metaType.typeName,
          isRequired: !optional,
          sortOrder: 100,
          addedById: auth.user.id,
        },
      })

  const currentDoc = await prisma.fileDocument.findFirst({
    where: { fileId: file.id, typeCode: metaType.typeCode, archivedAt: null },
  })
  if (!currentDoc) {
    await prisma.$transaction(async (tx) => {
      const docCode = await nextCode(tx, 'file_document', 'DOC')
      await tx.fileDocument.create({
        data: {
          code: docCode,
          fileId: file.id,
          checklistItemId: item.id,
          categoryCode: metaType.categoryCode,
          categoryNameSnapshot: metaType.categoryName,
          typeCode: metaType.typeCode,
          typeNameSnapshot: metaType.typeName,
          requirement: optional ? 'OPTIONAL' : 'REQUIRED',
          status: 'NOT_REQUESTED',
        },
      })
    })
  } else {
    await prisma.fileDocument.update({
      where: { id: currentDoc.id },
      data: { checklistItemId: item.id, requirement: optional ? 'OPTIONAL' : 'REQUIRED' },
    })
  }

  await refreshReadiness(file.id)
  await writeAuditLog({
    userId: auth.user.id,
    action: 'FILE_CHECKLIST_UPDATED',
    entityType: 'crm_file',
    entityId: file.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { typeCode: metaType.typeCode, change: 'added' },
  })
  return getFileWorkspace(auth, leadId)
}

export async function updateChecklistItem(
  auth: AuthContext,
  leadId: string,
  itemId: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  assertManage(auth)
  const { file } = await fileContext(auth, leadId)
  if (!file) throw httpError.notFound('File not found.')
  const item = await prisma.fileChecklistItem.findFirst({ where: { id: itemId, fileId: file.id } })
  if (!item) throw httpError.notFound('Checklist item not found.')

  const remove = body.remove === true || body.remove === 'true'
  const data: Prisma.FileChecklistItemUpdateInput = {}
  if (remove) data.isActive = false
  if (body.isRequired === true || body.isRequired === 'true') data.isRequired = true
  if (body.isRequired === false || body.isRequired === 'false') data.isRequired = false
  const updated = await prisma.fileChecklistItem.update({ where: { id: item.id }, data })
  await prisma.fileDocument.updateMany({
    where: { fileId: file.id, typeCode: item.typeCode, archivedAt: null },
    data: { requirement: updated.isRequired ? 'REQUIRED' : 'OPTIONAL' },
  })
  await refreshReadiness(file.id)
  await writeAuditLog({
    userId: auth.user.id,
    action: 'FILE_CHECKLIST_UPDATED',
    entityType: 'crm_file',
    entityId: file.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { typeCode: item.typeCode, remove, isRequired: updated.isRequired },
  })
  return getFileWorkspace(auth, leadId)
}

async function createVersion(input: {
  tx: Prisma.TransactionClient
  documentId: string
  userId: string
  actorKind: 'EMPLOYEE' | 'STUDENT_PORTAL'
  file: Express.Multer.File
  label?: string
  documentDate: Date | null
  expiryDate: Date | null
  remarks: string
  primary: boolean
  storedFileId: string
}) {
  const previous = await input.tx.fileDocumentVersion.findFirst({
    where: { documentId: input.documentId },
    orderBy: { versionNumber: 'desc' },
  })
  if (previous) {
    await input.tx.fileDocumentVersion.updateMany({
      where: { documentId: input.documentId, isLatest: true },
      data: { isLatest: false },
    })
  }
  const stored = await saveFileDocumentAsset(input.storedFileId, input.file, input.file.originalname)
  const version = await input.tx.fileDocumentVersion.create({
    data: {
      documentId: input.documentId,
      versionNumber: (previous?.versionNumber || 0) + 1,
      isLatest: true,
      documentDate: input.documentDate,
      expiryDate: input.expiryDate,
      remarks: input.remarks || null,
      uploadedById: input.userId,
      uploadedByKind: input.actorKind,
      assets: {
        create: {
          fileName: stored.fileName,
          label: input.label || null,
          mimeType: stored.mimeType,
          storageKey: stored.storageKey,
          fileSize: stored.fileSize,
          isPrimary: true,
        },
      },
    },
  })
  return version
}

export async function uploadFileDocument(
  auth: AuthContext,
  leadId: string,
  file: Express.Multer.File | undefined,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  assertUpload(auth)
  if (!file) throw httpError.invalidUpload('Please select a document.')
  const { lead, file: crmFile } = await fileContext(auth, leadId)
  if (!crmFile) throw httpError.validation({ file: 'File opening is required before documents can be uploaded.' })

  const mode = (asString(body.mode) || 'create').toLowerCase() as UploadMode
  const typeCode = asString(body.typeCode).toUpperCase()
  const documentId = asString(body.documentId)
  const label = asString(body.label)
  const remarks = asString(body.remarks)
  const documentDate = parseOptionalDate(body.documentDate, 'documentDate')
  const expiryDate = parseOptionalDate(body.expiryDate, 'expiryDate')
  if (documentDate && expiryDate && expiryDate < documentDate) {
    throw httpError.validation({ expiryDate: 'Expiry date cannot be before document date.' })
  }
  const actorKind = asString(body.uploadedByKind).toUpperCase() === 'STUDENT_PORTAL' ? 'STUDENT_PORTAL' : 'EMPLOYEE'

  let document = documentId
    ? await prisma.fileDocument.findFirst({ where: { id: documentId, fileId: crmFile.id } })
    : await prisma.fileDocument.findFirst({ where: { fileId: crmFile.id, typeCode, archivedAt: null } })
  if (!document && typeCode) {
    const metaType = await resolveCatalogType(typeCode)
    const active = await prisma.fileDocument.findFirst({
      where: { fileId: crmFile.id, typeCode: metaType.typeCode, archivedAt: null },
    })
    if (active) {
      throw new HttpError(409, 'A document of this type already exists.', 'DUPLICATE_DOCUMENT')
    }
    document = await prisma.$transaction(async (tx) => {
      const docCode = await nextCode(tx, 'file_document', 'DOC')
      return tx.fileDocument.create({
        data: {
          code: docCode,
          fileId: crmFile.id,
          categoryCode: metaType.categoryCode,
          categoryNameSnapshot: metaType.categoryName,
          typeCode: metaType.typeCode,
          typeNameSnapshot: metaType.typeName,
          requirement: null,
          status: 'NOT_REQUESTED',
        },
      })
    })
  }
  if (!document) throw httpError.invalidUpload('Please select a document.')
  if (document.archivedAt) throw httpError.validation({ documentId: 'This document is archived.' })
  assertSensitive(auth, document.typeCode)

  const versionCount = await prisma.fileDocumentVersion.count({ where: { documentId: document.id } })
  const reupload = mode === 'reupload' || document.status === 'REUPLOAD_REQUIRED' || document.status === 'REJECTED'
  if (mode === 'additional') {
    if (!versionCount) throw httpError.validation({ mode: 'Upload the document before adding another file.' })
    if (document.status === 'REUPLOAD_REQUIRED' || document.status === 'REJECTED') {
      throw httpError.validation({ mode: 'Re-upload creates a new version.' })
    }
  } else if (versionCount > 0 && !reupload && mode !== 'create') {
    throw new HttpError(409, 'A document of this type already exists.', 'DUPLICATE_DOCUMENT')
  } else if (versionCount > 0 && !reupload && mode === 'create') {
    throw new HttpError(409, 'A document of this type already exists.', 'DUPLICATE_DOCUMENT')
  }

  try {
    const createdVersion = await prisma.$transaction(async (tx) => {
      if (mode === 'additional') {
        const latest = await tx.fileDocumentVersion.findFirst({
          where: { documentId: document!.id, isLatest: true },
          include: { assets: true },
        })
        if (!latest) throw httpError.validation({ mode: 'Upload the document before adding another file.' })
        const stored = await saveFileDocumentAsset(crmFile.id, file, file.originalname)
        const makePrimary = body.primary === true || body.primary === 'true' || latest.assets.length === 0
        if (makePrimary) {
          await tx.fileDocumentAsset.updateMany({ where: { versionId: latest.id }, data: { isPrimary: false } })
        }
        await tx.fileDocumentAsset.create({
          data: {
            versionId: latest.id,
            fileName: stored.fileName,
            label: label || null,
            mimeType: stored.mimeType,
            storageKey: stored.storageKey,
            fileSize: stored.fileSize,
            isPrimary: makePrimary,
          },
        })
        if (documentDate || expiryDate || remarks) {
          await tx.fileDocumentVersion.update({
            where: { id: latest.id },
            data: {
              documentDate: documentDate ?? undefined,
              expiryDate: expiryDate ?? undefined,
              remarks: remarks || undefined,
            },
          })
        }
        return latest
      }
      return createVersion({
        tx,
        documentId: document!.id,
        userId: auth.user.id,
        actorKind,
        file,
        label,
        documentDate,
        expiryDate,
        remarks,
        primary: true,
        storedFileId: crmFile.id,
      })
    })

    await prisma.fileDocument.update({ where: { id: document.id }, data: { status: 'RECEIVED' } })
    await prisma.fileDocumentRequest.updateMany({
      where: { documentId: document.id, status: 'OPEN' },
      data: { status: 'FULFILLED' },
    })
    await recordActivity({
      documentId: document.id,
      action: reupload && mode !== 'additional' ? 'REUPLOADED' : 'UPLOADED',
      userId: auth.user.id,
      notes: remarks || null,
      metadata: { versionId: createdVersion.id, mode },
    })
    await recordLeadTimeline({
      leadId: lead.id,
      leadName: lead.name,
      userId: auth.user.id,
      type: 'OTHER',
      notes: `${document.typeNameSnapshot} ${reupload && mode !== 'additional' ? 're-uploaded' : 'uploaded'}.`,
      meta,
      metadata: { fileId: crmFile.id, documentId: document.id, documentCode: document.code },
    })
    await writeAuditLog({
      userId: auth.user.id,
      action: 'FILE_DOCUMENT_UPLOADED',
      entityType: 'file_document',
      entityId: document.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { fileCode: crmFile.code, typeCode: document.typeCode, mode },
    })
    await refreshReadiness(crmFile.id)
    return { document: serializeDocument(await loadDocument(crmFile.id, document.id)) }
  } catch (error) {
    if (error instanceof HttpError) throw error
    console.error('[file-documents] upload failed:', error)
    throw httpError.invalidUpload('Unable to upload the document. Please try again.')
  }
}

export async function requestFileDocument(
  auth: AuthContext,
  leadId: string,
  documentId: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  assertUpload(auth)
  const { lead, file } = await fileContext(auth, leadId)
  if (!file) throw httpError.notFound('File not found.')
  const document = await loadDocument(file.id, documentId)
  if (document.archivedAt) throw httpError.validation({ documentId: 'This document is archived.' })
  const method = asString(body.method).toUpperCase()
  if (!REQUEST_METHODS.has(method)) {
    throw httpError.validation({ method: 'Request method is required.' })
  }
  const dueDate = parseOptionalDate(body.dueDate, 'dueDate')
  const remarks = asString(body.remarks)
  const message = remarks || `Please send your ${document.typeNameSnapshot}.`

  const activity = await prisma.activity.create({
    data: {
      type: 'DOCUMENT_REQUEST',
      userId: auth.user.id,
      notes: message,
      relatedName: lead.name,
      relatedType: 'lead',
      relatedId: lead.id,
      outcome: document.typeNameSnapshot,
      metadata: { fileId: file.id, fileCode: file.code, documentId: document.id, method },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
  })

  let communicationEventId: string | null = null
  let sendError: string | null = null
  if (method === 'EMAIL' && lead.email && (isEmailConfigured() || isEmailMockMode())) {
    try {
      const providerId = await sendMailboxEmail({
        to: lead.email,
        subject: `Document request: ${document.typeNameSnapshot}`,
        text: message,
        html: `<p>${message}</p>`,
      })
      const event = await prisma.communicationEvent.create({
        data: {
          channel: 'EMAIL',
          direction: 'outgoing',
          senderEmail: lead.email,
          subject: `Document request: ${document.typeNameSnapshot}`,
          message,
          leadId: lead.id,
          processingStatus: 'PROCESSED',
          externalId: providerId || `file-doc-${document.id}-${Date.now()}`,
          activityId: activity.id,
          processedAt: new Date(),
        },
      })
      communicationEventId = event.id
    } catch (error) {
      sendError = error instanceof Error ? error.message : 'Email send failed'
    }
  }
  if (method === 'WHATSAPP') {
    const to = (lead.whatsapp || lead.phone || '').replace(/\D/g, '')
    if (to && (isWhatsAppConfigured() || isWhatsAppMock())) {
      try {
        const providerId = await sendWhatsApp(to, { kind: 'text', text: message })
        const event = await prisma.communicationEvent.create({
          data: {
            channel: 'WHATSAPP',
            direction: 'outgoing',
            senderPhone: to,
            message,
            leadId: lead.id,
            processingStatus: 'PROCESSED',
            externalId: providerId || `file-doc-wa-${document.id}-${Date.now()}`,
            activityId: activity.id,
            processedAt: new Date(),
          },
        })
        communicationEventId = event.id
      } catch (error) {
        sendError = error instanceof Error ? error.message : 'WhatsApp send failed'
      }
    }
  }

  const request = await prisma.$transaction(async (tx) => {
    const code = await nextCode(tx, 'file_document_request', 'REQ')
    return tx.fileDocumentRequest.create({
      data: {
        code,
        documentId: document.id,
        requestedById: auth.user.id,
        dueDate,
        method: method as 'WHATSAPP' | 'EMAIL' | 'PHONE' | 'IN_PERSON' | 'OTHER',
        remarks: remarks || null,
        activityId: activity.id,
        communicationEventId,
      },
    })
  })

  if (document.status === 'NOT_REQUESTED') {
    await prisma.fileDocument.update({ where: { id: document.id }, data: { status: 'REQUESTED' } })
  }
  await recordActivity({
    documentId: document.id,
    action: 'REQUESTED',
    userId: auth.user.id,
    notes: remarks || null,
    metadata: { requestId: request.id, method, sendError },
  })
  await writeAuditLog({
    userId: auth.user.id,
    action: 'FILE_DOCUMENT_REQUESTED',
    entityType: 'file_document',
    entityId: document.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { requestCode: request.code, method, fileCode: file.code },
  })
  if (file.ownerId && file.ownerId !== auth.user.id) {
    await createNotification({
      userId: file.ownerId,
      title: `${document.typeNameSnapshot} requested`,
      body: message,
      link: `/leads/${lead.id}?tab=file-documents`,
      type: 'document_request',
      leadId: lead.id,
      dedupeKey: `file-doc-request:${request.id}`,
    })
  }
  return { request, document: serializeDocument(await loadDocument(file.id, document.id)) }
}

export async function reviewFileDocument(auth: AuthContext, leadId: string, documentId: string, meta: AuditMeta) {
  assertVerify(auth)
  const { lead, file } = await fileContext(auth, leadId)
  if (!file) throw httpError.notFound('File not found.')
  const document = await loadDocument(file.id, documentId)
  assertSensitive(auth, document.typeCode)
  const latest = latestVersion(document.versions)
  if (!latest) throw httpError.validation({ documentId: 'Please select a document.' })
  if (document.status !== 'RECEIVED' && document.status !== 'UNDER_REVIEW') {
    throw new HttpError(400, 'Unable to verify the document.', 'VERIFICATION_FAILED')
  }
  await prisma.fileDocument.update({ where: { id: document.id }, data: { status: 'UNDER_REVIEW' } })
  await recordActivity({
    documentId: document.id,
    action: 'REVIEW_STARTED',
    userId: auth.user.id,
  })
  await recordLeadTimeline({
    leadId: lead.id,
    leadName: lead.name,
    userId: auth.user.id,
    type: 'OTHER',
    notes: `${document.typeNameSnapshot} is under review.`,
    meta,
    metadata: { documentId: document.id, fileId: file.id },
  })
  await writeAuditLog({
    userId: auth.user.id,
    action: 'FILE_DOCUMENT_REVIEW_STARTED',
    entityType: 'file_document',
    entityId: document.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { fileCode: file.code, typeName: document.typeNameSnapshot },
  })
  return { document: serializeDocument(await loadDocument(file.id, document.id)) }
}

export async function verifyFileDocument(
  auth: AuthContext,
  leadId: string,
  documentId: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  assertVerify(auth)
  const { lead, file } = await fileContext(auth, leadId)
  if (!file) throw httpError.notFound('File not found.')
  const document = await loadDocument(file.id, documentId)
  assertSensitive(auth, document.typeCode)
  const latest = latestVersion(document.versions)
  if (!latest) throw new HttpError(400, 'Unable to verify the document.', 'VERIFICATION_FAILED')
  if (isVersionExpired(latest)) {
    throw httpError.validation({ expiryDate: 'This document has expired.' }, 'This document has expired.')
  }
  if (document.status !== 'RECEIVED' && document.status !== 'UNDER_REVIEW') {
    throw new HttpError(400, 'Unable to verify the document.', 'VERIFICATION_FAILED')
  }
  const remarks = asString(body.remarks)
  try {
    await prisma.fileDocumentVersion.update({
      where: { id: latest.id },
      data: {
        verifiedById: auth.user.id,
        verifiedAt: new Date(),
        verificationRemarks: remarks || null,
      },
    })
    await prisma.fileDocument.update({ where: { id: document.id }, data: { status: 'VERIFIED' } })
  } catch (error) {
    console.error('[file-documents] verify failed:', error)
    throw new HttpError(400, 'Unable to verify the document.', 'VERIFICATION_FAILED')
  }
  await recordActivity({
    documentId: document.id,
    action: 'VERIFIED',
    userId: auth.user.id,
    notes: remarks || null,
  })
  await recordLeadTimeline({
    leadId: lead.id,
    leadName: lead.name,
    userId: auth.user.id,
    type: 'OTHER',
    notes: `${document.typeNameSnapshot} verified.`,
    meta,
    metadata: { documentId: document.id, fileId: file.id },
  })
  await writeAuditLog({
    userId: auth.user.id,
    action: 'FILE_DOCUMENT_VERIFIED',
    entityType: 'file_document',
    entityId: document.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { fileCode: file.code, typeName: document.typeNameSnapshot },
  })
  await refreshReadiness(file.id)
  return { document: serializeDocument(await loadDocument(file.id, document.id)) }
}

export async function rejectFileDocument(
  auth: AuthContext,
  leadId: string,
  documentId: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  assertVerify(auth)
  const { lead, file } = await fileContext(auth, leadId)
  if (!file) throw httpError.notFound('File not found.')
  const document = await loadDocument(file.id, documentId)
  assertSensitive(auth, document.typeCode)
  const latest = latestVersion(document.versions)
  if (!latest) throw httpError.validation({ documentId: 'Please select a document.' })
  const reasonCode = asString(body.reasonCode || body.reason).toUpperCase()
  const reasonText = asString(body.reason)
  if (!reasonCode && !reasonText) {
    throw httpError.validation({ reason: 'Please provide a rejection reason.' }, 'Please provide a rejection reason.')
  }
  const master = reasonCode
    ? await prisma.masterDataItem.findFirst({
        where: { categoryKey: 'REJECTION_REASON', code: reasonCode, status: 'ACTIVE' },
      })
    : null
  if (!master && !reasonText) {
    throw httpError.validation({ reason: 'Please provide a rejection reason.' }, 'Please provide a rejection reason.')
  }
  const remarks = asString(body.remarks)
  await prisma.fileDocumentVersion.update({
    where: { id: latest.id },
    data: {
      rejectionReasonCode: master?.code || reasonCode || 'OTHER',
      rejectionReasonName: master?.name || reasonText,
      rejectionRemarks: remarks || null,
    },
  })
  await prisma.fileDocument.update({ where: { id: document.id }, data: { status: 'REUPLOAD_REQUIRED' } })
  await recordActivity({
    documentId: document.id,
    action: 'REJECTED',
    userId: auth.user.id,
    notes: remarks || master?.name || reasonText,
    metadata: { reason: master?.name || reasonText },
  })
  await recordLeadTimeline({
    leadId: lead.id,
    leadName: lead.name,
    userId: auth.user.id,
    type: 'OTHER',
    notes: `${document.typeNameSnapshot} rejected (${master?.name || reasonText}). Re-upload required.`,
    meta,
    metadata: { documentId: document.id, fileId: file.id },
  })
  await writeAuditLog({
    userId: auth.user.id,
    action: 'FILE_DOCUMENT_REJECTED',
    entityType: 'file_document',
    entityId: document.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { reason: master?.name || reasonText, fileCode: file.code },
  })
  await refreshReadiness(file.id)
  return { document: serializeDocument(await loadDocument(file.id, document.id)) }
}

export async function setPrimaryAsset(
  auth: AuthContext,
  leadId: string,
  documentId: string,
  assetId: string,
  meta: AuditMeta,
) {
  assertUpload(auth)
  const { file } = await fileContext(auth, leadId)
  if (!file) throw httpError.notFound('File not found.')
  const document = await loadDocument(file.id, documentId)
  const latest = latestVersion(document.versions)
  const asset = latest?.assets.find((item) => item.id === assetId)
  if (!latest || !asset) throw httpError.notFound('File not found.')
  await prisma.fileDocumentAsset.updateMany({ where: { versionId: latest.id }, data: { isPrimary: false } })
  await prisma.fileDocumentAsset.update({ where: { id: asset.id }, data: { isPrimary: true } })
  await recordActivity({
    documentId: document.id,
    action: 'PRIMARY_MARKED',
    userId: auth.user.id,
    notes: asset.fileName,
  })
  await writeAuditLog({
    userId: auth.user.id,
    action: 'FILE_DOCUMENT_PRIMARY_SET',
    entityType: 'file_document',
    entityId: document.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { assetId: asset.id, fileName: asset.fileName },
  })
  return { document: serializeDocument(await loadDocument(file.id, document.id)) }
}

export async function archiveFileDocument(auth: AuthContext, leadId: string, documentId: string, meta: AuditMeta) {
  assertManage(auth)
  const { lead, file } = await fileContext(auth, leadId)
  if (!file) throw httpError.notFound('File not found.')
  const document = await loadDocument(file.id, documentId)
  await prisma.fileDocument.update({
    where: { id: document.id },
    data: { status: 'ARCHIVED', archivedAt: new Date() },
  })
  await recordActivity({ documentId: document.id, action: 'ARCHIVED', userId: auth.user.id })
  await recordLeadTimeline({
    leadId: lead.id,
    leadName: lead.name,
    userId: auth.user.id,
    type: 'OTHER',
    notes: `${document.typeNameSnapshot} archived.`,
    meta,
    metadata: { documentId: document.id, fileId: file.id },
  })
  await writeAuditLog({
    userId: auth.user.id,
    action: 'FILE_DOCUMENT_ARCHIVED',
    entityType: 'file_document',
    entityId: document.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { fileCode: file.code, typeName: document.typeNameSnapshot },
  })
  await refreshReadiness(file.id)
  return { message: 'Document archived.', document: serializeDocument(await loadDocument(file.id, document.id)) }
}

export async function deleteFileDocument() {
  throw new HttpError(409, 'This document cannot be permanently deleted.', 'DELETE_RESTRICTED')
}

export async function getFileDocumentContent(
  auth: AuthContext,
  leadId: string,
  documentId: string,
  assetId: string | undefined,
  meta: AuditMeta & { mode: 'view' | 'download' },
) {
  if (meta.mode === 'download') {
    if (!hasPermission(auth.permissions, 'document:download')) {
      throw httpError.accessDenied('You are not authorized to access this document.')
    }
  } else {
    assertDownload(auth)
  }
  const { file } = await fileContext(auth, leadId)
  if (!file) throw httpError.notFound('File not found.')
  const document = await loadDocument(file.id, documentId)
  assertSensitive(auth, document.typeCode)
  const latest = latestVersion(document.versions)
  const asset = (assetId ? latest?.assets.find((item) => item.id === assetId) : null) || latest?.assets.find((item) => item.isPrimary) || latest?.assets[0]
  if (!asset) throw httpError.notFound('File not found.')
  const buffer = await readFileDocumentAsset(asset.storageKey)
  await recordActivity({
    documentId: document.id,
    action: meta.mode === 'download' ? 'DOWNLOADED' : 'VIEWED',
    userId: auth.user.id,
    notes: asset.fileName,
  })
  await writeAuditLog({
    userId: auth.user.id,
    action: meta.mode === 'download' ? 'FILE_DOCUMENT_DOWNLOADED' : 'FILE_DOCUMENT_VIEWED',
    entityType: 'file_document',
    entityId: document.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { assetId: asset.id, fileName: asset.fileName, fileCode: file.code },
  })
  return { buffer, fileName: asset.fileName, mimeType: asset.mimeType }
}

export async function listGlobalFileDocuments(
  auth: AuthContext,
  query: {
    search?: string
    categoryCode?: string
    typeCode?: string
    status?: string
    uploadedById?: string
    verifiedById?: string
    expiryStatus?: string
    dateFrom?: string
    dateTo?: string
    page?: number
    limit?: number
  },
) {
  assertView(auth)
  const page = Math.max(1, query.page || 1)
  const limit = Math.min(100, Math.max(5, query.limit || 20))
  const search = query.search?.trim().toLowerCase()
  const rows = await prisma.fileDocument.findMany({
    where: {
      archivedAt: null,
      ...(query.categoryCode ? { categoryCode: query.categoryCode.toUpperCase() } : {}),
      ...(query.typeCode ? { typeCode: query.typeCode.toUpperCase() } : {}),
      ...(query.status ? { status: query.status.toUpperCase() as FileDocumentStatus } : {}),
      file: { lead: leadScopeWhere(auth) },
    },
    include: {
      file: { select: { id: true, code: true, studentName: true, leadId: true, lead: { select: { code: true, name: true } } } },
      versions: {
        where: { isLatest: true },
        include: VERSION_INCLUDE,
        take: 1,
      },
    },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  })

  let items = rows.map((row) => {
    const latest = row.versions[0] || null
    const expired = expiryState(latest?.expiryDate)
    return {
      id: row.id,
      code: row.code,
      fileId: row.file.id,
      fileCode: row.file.code,
      leadId: row.file.leadId,
      leadCode: row.file.lead.code,
      owner: `${row.file.code} — ${row.file.studentName}`,
      leadName: row.file.lead.name,
      type: row.typeNameSnapshot,
      typeCode: row.typeCode,
      category: row.categoryNameSnapshot,
      categoryCode: row.categoryCode,
      uploadedBy: latest?.uploadedBy?.fullName || '—',
      uploadedById: latest?.uploadedById || null,
      verifiedBy: latest?.verifiedBy?.fullName || '—',
      verifiedById: latest?.verifiedById || null,
      status: expired === 'EXPIRED' && row.status === 'VERIFIED' ? 'Expired' : statusLabel(row.status),
      statusCode: row.status,
      expiryStatus: expired,
      updated: row.updatedAt.toISOString(),
      createdAt: latest?.createdAt.toISOString() || row.createdAt.toISOString(),
    }
  })

  if (!canAccessSensitive(auth)) {
    items = items.filter((row) => !SENSITIVE_TYPES.has(row.typeCode))
  }
  if (query.uploadedById) items = items.filter((row) => row.uploadedById === query.uploadedById)
  if (query.verifiedById) items = items.filter((row) => row.verifiedById === query.verifiedById)
  if (query.expiryStatus) {
    const wanted = query.expiryStatus.toUpperCase()
    items = items.filter((row) => row.expiryStatus === wanted)
  }
  if (query.dateFrom) {
    const from = new Date(query.dateFrom)
    if (!Number.isNaN(from.getTime())) items = items.filter((row) => new Date(row.createdAt) >= from)
  }
  if (query.dateTo) {
    const to = new Date(query.dateTo)
    if (!Number.isNaN(to.getTime())) items = items.filter((row) => new Date(row.createdAt) <= to)
  }
  if (search) {
    items = items.filter((row) =>
      [row.code, row.fileCode, row.leadCode, row.leadName, row.type, row.category, row.uploadedBy, row.verifiedBy, row.status]
        .join(' ')
        .toLowerCase()
        .includes(search),
    )
  }

  const total = items.length
  return { items: items.slice((page - 1) * limit, page * limit), total, page, limit }
}

export async function listRejectionReasons() {
  const rows = await prisma.masterDataItem.findMany({
    where: { categoryKey: 'REJECTION_REASON', status: 'ACTIVE' },
    orderBy: { sortOrder: 'asc' },
    select: { code: true, name: true },
  })
  return rows.map((row) => ({ code: row.code, name: row.name }))
}

export async function remindExpiringFileDocuments(days = reminderDays()) {
  const today = startOfToday()
  const until = new Date(today)
  until.setDate(until.getDate() + days)
  const versions = await prisma.fileDocumentVersion.findMany({
    where: { isLatest: true, expiryDate: { gte: today, lte: until } },
    include: {
      document: { include: { file: { select: { id: true, code: true, ownerId: true, leadId: true, studentName: true } } } },
    },
  })
  let sent = 0
  for (const version of versions) {
    const ownerId = version.document.file.ownerId
    if (!ownerId || !version.expiryDate) continue
    const name = version.document.typeNameSnapshot
    await createNotification({
      userId: ownerId,
      title: `${name} expires in ${days} days`,
      body: `${version.document.file.code} — ${name} expires on ${version.expiryDate.toISOString().slice(0, 10)}.`,
      link: `/leads/${version.document.file.leadId}?tab=file-documents`,
      type: 'document_expiring',
      leadId: version.document.file.leadId,
      dedupeKey: `file-doc-expiry:${version.id}:${days}`,
    })
    sent += 1
  }
  return sent
}
