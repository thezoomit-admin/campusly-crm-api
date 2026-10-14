import type { Prisma } from '../../lib/prisma-client'
import { writeAuditLog } from '../../lib/audit'
import { httpError } from '../../lib/http-error'
import { prisma } from '../../lib/prisma'
import { hasPermission } from '../auth/access'
import type { AuthContext } from '../auth/session.service'
import { openCrmFile } from '../files/file-documents.service'
import { assertCanViewLead } from '../leads/leads.helpers'
import {
  allowedApplicationTransitions,
  isApplicationStatus,
  isConvertibleLeadStatus,
  type ApplicationStatus,
} from './application-status'

type AuditMeta = { ipAddress?: string; userAgent?: string }

const APP_INCLUDE = {
  lead: { select: { id: true, code: true, name: true, status: true, statusCode: true } },
  student: { select: { id: true, studentCode: true, name: true, status: true } },
  counsellor: { select: { id: true, fullName: true } },
  createdBy: { select: { id: true, fullName: true } },
  statusHistory: {
    orderBy: { createdAt: 'desc' as const },
    take: 20,
    include: { createdBy: { select: { id: true, fullName: true } } },
  },
} satisfies Prisma.ApplicationInclude

function asString(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

async function nextSequenceCode(tx: Prisma.TransactionClient, key: string, prefix: string, width = 4) {
  const row = await tx.documentSequence.upsert({
    where: { key },
    create: { key, nextValue: 2 },
    update: { nextValue: { increment: 1 } },
  })
  return `${prefix}-${String(row.nextValue - 1).padStart(width, '0')}`
}

function serializeApplication(row: Prisma.ApplicationGetPayload<{ include: typeof APP_INCLUDE }>) {
  return {
    id: row.id,
    code: row.code,
    leadId: row.leadId,
    studentId: row.studentId,
    applicantName: row.applicantName,
    countryCode: row.countryCode,
    countryName: row.countryName,
    university: row.university,
    program: row.program,
    intake: row.intake,
    counsellorName: row.counsellorName || row.counsellor?.fullName || null,
    counsellorId: row.counsellorId,
    status: row.status,
    remarks: row.remarks,
    submittedAt: row.submittedAt ? row.submittedAt.toISOString().slice(0, 10) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lead: row.lead
      ? { id: row.lead.id, code: row.lead.code, name: row.lead.name, status: row.lead.status }
      : null,
    student: row.student
      ? {
          id: row.student.id,
          studentCode: row.student.studentCode,
          name: row.student.name,
          status: row.student.status,
        }
      : null,
    createdBy: row.createdBy
      ? { id: row.createdBy.id, name: row.createdBy.fullName }
      : null,
    allowedTransitions: allowedApplicationTransitions(row.status),
    statusHistory: row.statusHistory.map((item) => ({
      id: item.id,
      previousStatus: item.previousStatus,
      newStatus: item.newStatus,
      remarks: item.remarks,
      createdAt: item.createdAt.toISOString(),
      createdBy: item.createdBy
        ? { id: item.createdBy.id, name: item.createdBy.fullName }
        : null,
    })),
  }
}

function listItem(row: {
  id: string
  code: string
  applicantName: string
  university: string | null
  program: string | null
  intake: string | null
  counsellorName: string | null
  status: string
  submittedAt: Date | null
  countryName: string | null
  leadId: string | null
  lead?: { id: string; code: string; name: string } | null
  student?: { id: string; studentCode: string } | null
}) {
  return {
    id: row.id,
    code: row.code,
    applicant: row.applicantName,
    university: row.university || '—',
    program: row.program || '—',
    intake: row.intake || '—',
    counsellor: row.counsellorName || '—',
    status: row.status,
    country: row.countryName || '—',
    submitted: row.submittedAt ? row.submittedAt.toISOString().slice(0, 10) : '—',
    leadId: row.leadId,
    leadCode: row.lead?.code || null,
    leadName: row.lead?.name || null,
    studentId: row.student?.id || null,
    studentCode: row.student?.studentCode || null,
  }
}

async function resolveLeadBehavior(lead: { status: string; statusCode: string | null }) {
  if (!lead.statusCode) return null
  const item = await prisma.masterDataItem.findFirst({
    where: { categoryKey: 'LEAD_STATUS', code: lead.statusCode },
    select: { behaviorKey: true },
  })
  return item?.behaviorKey || null
}

async function ensureStudentForLead(
  tx: Prisma.TransactionClient,
  lead: {
    id: string
    name: string
    phone: string | null
    email: string | null
    country: string | null
    preferredCountryCode: string | null
    preferredCourse: string | null
    ownerId: string | null
    ownerName: string | null
  },
  countryName: string | null,
  program: string | null,
) {
  const existing = await tx.student.findUnique({ where: { leadId: lead.id } })
  if (existing) {
    return tx.student.update({
      where: { id: existing.id },
      data: {
        name: lead.name,
        phone: lead.phone,
        email: lead.email,
        destination: countryName || lead.country || existing.destination,
        program: program || lead.preferredCourse || existing.program,
        counsellorId: lead.ownerId,
        counsellorName: lead.ownerName,
        status: existing.status === 'Completed' ? existing.status : 'Active',
      },
    })
  }

  const studentCode = await nextSequenceCode(tx, 'student', 'STU', 4)
  return tx.student.create({
    data: {
      leadId: lead.id,
      studentCode,
      name: lead.name,
      phone: lead.phone,
      email: lead.email,
      destination: countryName || lead.country,
      program: program || lead.preferredCourse,
      counsellorId: lead.ownerId,
      counsellorName: lead.ownerName,
      status: 'Active',
    },
  })
}

export async function listApplications(
  auth: AuthContext,
  query: { search?: string; leadId?: string; status?: string; page?: number; limit?: number },
) {
  if (!hasPermission(auth.permissions, 'lead:convert') && !hasPermission(auth.permissions, 'lead:view')) {
    throw httpError.accessDenied('You do not have permission to view applications.')
  }

  const page = Math.max(1, query.page || 1)
  const limit = Math.min(100, Math.max(1, query.limit || 20))
  const search = query.search?.trim()

  const where: Prisma.ApplicationWhereInput = {
    ...(query.leadId ? { leadId: query.leadId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(search
      ? {
          OR: [
            { code: { contains: search, mode: 'insensitive' } },
            { applicantName: { contains: search, mode: 'insensitive' } },
            { university: { contains: search, mode: 'insensitive' } },
            { program: { contains: search, mode: 'insensitive' } },
            { counsellorName: { contains: search, mode: 'insensitive' } },
            { status: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  }

  const [total, rows] = await Promise.all([
    prisma.application.count({ where }),
    prisma.application.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        lead: { select: { id: true, code: true, name: true } },
        student: { select: { id: true, studentCode: true } },
      },
    }),
  ])

  return {
    items: rows.map(listItem),
    total,
    page,
    limit,
  }
}

export async function listLeadApplications(auth: AuthContext, leadId: string) {
  await assertCanViewLead(auth, leadId)
  const rows = await prisma.application.findMany({
    where: { leadId },
    orderBy: { createdAt: 'desc' },
    include: {
      lead: { select: { id: true, code: true, name: true } },
      student: { select: { id: true, studentCode: true } },
    },
  })
  return { items: rows.map(listItem), total: rows.length }
}

export async function getApplication(auth: AuthContext, id: string) {
  if (!hasPermission(auth.permissions, 'lead:convert') && !hasPermission(auth.permissions, 'lead:view')) {
    throw httpError.accessDenied('You do not have permission to view applications.')
  }
  const row = await prisma.application.findUnique({
    where: { id },
    include: APP_INCLUDE,
  })
  if (!row) throw httpError.notFound('Application not found.')
  if (row.leadId) await assertCanViewLead(auth, row.leadId)
  return { application: serializeApplication(row) }
}

export async function createApplicationFromLead(
  auth: AuthContext,
  leadId: string,
  body: Record<string, unknown>,
  meta?: AuditMeta,
) {
  if (!hasPermission(auth.permissions, 'lead:convert')) {
    throw httpError.accessDenied('You do not have permission to create applications.')
  }

  await assertCanViewLead(auth, leadId)
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: {
      id: true,
      code: true,
      name: true,
      phone: true,
      email: true,
      country: true,
      preferredCountryCode: true,
      preferredCourse: true,
      preferredIntakeCode: true,
      ownerId: true,
      ownerName: true,
      status: true,
      statusCode: true,
    },
  })
  if (!lead) throw httpError.notFound('Lead not found.')

  const behaviorKey = await resolveLeadBehavior(lead)
  if (!isConvertibleLeadStatus({ ...lead, behaviorKey })) {
    throw httpError.validation(
      { leadId: 'Create an application only after the lead is Converted.' },
      'Create an application only after the lead is Converted.',
    )
  }

  const university = asString(body.university)
  const program = asString(body.program) || lead.preferredCourse || ''
  const intake = asString(body.intake) || lead.preferredIntakeCode || ''
  const countryCode = asString(body.countryCode) || lead.preferredCountryCode || ''
  const countryName = asString(body.countryName) || lead.country || ''
  const remarks = asString(body.remarks)
  const initialStatusRaw = asString(body.status) || 'Documents Pending'
  const initialStatus: ApplicationStatus = isApplicationStatus(initialStatusRaw)
    ? initialStatusRaw
    : 'Documents Pending'

  const fields: Record<string, string> = {}
  if (!university) fields.university = 'University is required.'
  if (!program) fields.program = 'Program / course is required.'
  if (!intake) fields.intake = 'Intake is required.'
  if (Object.keys(fields).length) throw httpError.validation(fields)

  const created = await prisma.$transaction(async (tx) => {
    const student = await ensureStudentForLead(tx, lead, countryName || null, program || null)
    const code = await nextSequenceCode(tx, 'application', 'APP', 4)
    const application = await tx.application.create({
      data: {
        code,
        leadId: lead.id,
        studentId: student.id,
        applicantName: lead.name,
        countryCode: countryCode || null,
        countryName: countryName || null,
        university,
        program,
        intake,
        counsellorId: lead.ownerId,
        counsellorName: lead.ownerName,
        status: initialStatus,
        remarks: remarks || null,
        createdById: auth.user.id,
        updatedById: auth.user.id,
        submittedAt: initialStatus === 'Submitted' ? new Date() : null,
      },
    })
    await tx.applicationStatusHistory.create({
      data: {
        applicationId: application.id,
        previousStatus: null,
        newStatus: initialStatus,
        remarks: remarks || 'Application created from converted lead.',
        createdById: auth.user.id,
      },
    })
    await tx.activity.create({
      data: {
        type: 'NOTE',
        userId: auth.user.id,
        notes: `Application ${code} created for ${university} (${program}, ${intake}).`,
        relatedName: lead.name,
        relatedType: 'lead',
        relatedId: lead.id,
        outcome: 'Application Created',
        metadata: {
          applicationId: application.id,
          applicationCode: code,
          studentId: student.id,
          studentCode: student.studentCode,
          event: 'application_created',
        },
        ipAddress: meta?.ipAddress,
        userAgent: meta?.userAgent,
      },
    })
    return { application, student }
  })

  try {
    await openCrmFile(auth, lead.id, meta)
  } catch (error) {
    console.error('[applications] Opening CRM file after application create failed:', error)
  }

  await writeAuditLog({
    userId: auth.user.id,
    action: 'APPLICATION_CREATED',
    entityType: 'application',
    entityId: created.application.id,
    ipAddress: meta?.ipAddress,
    userAgent: meta?.userAgent,
    metadata: {
      applicationCode: created.application.code,
      leadId: lead.id,
      leadCode: lead.code,
      studentId: created.student.id,
      studentCode: created.student.studentCode,
    },
  })

  const full = await prisma.application.findUniqueOrThrow({
    where: { id: created.application.id },
    include: APP_INCLUDE,
  })
  return { application: serializeApplication(full) }
}

export async function updateApplicationStatus(
  auth: AuthContext,
  id: string,
  body: Record<string, unknown>,
  meta?: AuditMeta,
) {
  if (!hasPermission(auth.permissions, 'lead:convert')) {
    throw httpError.accessDenied('You do not have permission to update applications.')
  }

  const existing = await prisma.application.findUnique({
    where: { id },
    include: { lead: { select: { id: true, name: true, code: true } } },
  })
  if (!existing) throw httpError.notFound('Application not found.')

  const nextStatus = asString(body.status)
  const remarks = asString(body.remarks)
  if (!isApplicationStatus(nextStatus)) {
    throw httpError.validation({ status: 'Please select a valid application status.' })
  }
  if (nextStatus === existing.status) {
    throw httpError.validation({ status: 'The selected status is already active.' })
  }
  const allowed = allowedApplicationTransitions(existing.status)
  if (!allowed.includes(nextStatus)) {
    throw httpError.validation(
      { status: `Cannot move from ${existing.status} to ${nextStatus}.` },
      `Cannot move from ${existing.status} to ${nextStatus}.`,
    )
  }

  await prisma.$transaction(async (tx) => {
    await tx.application.update({
      where: { id },
      data: {
        status: nextStatus,
        remarks: remarks || existing.remarks,
        updatedById: auth.user.id,
        submittedAt:
          nextStatus === 'Submitted' && !existing.submittedAt
            ? new Date()
            : existing.submittedAt,
      },
    })
    await tx.applicationStatusHistory.create({
      data: {
        applicationId: id,
        previousStatus: existing.status,
        newStatus: nextStatus,
        remarks: remarks || null,
        createdById: auth.user.id,
      },
    })

    if (existing.studentId && nextStatus === 'Enrolled') {
      await tx.student.update({
        where: { id: existing.studentId },
        data: { status: 'Active', enrolledAt: new Date() },
      })
    }

    if (existing.leadId) {
      await tx.activity.create({
        data: {
          type: 'NOTE',
          userId: auth.user.id,
          notes: `Application ${existing.code} status changed from ${existing.status} to ${nextStatus}${
            remarks ? `. ${remarks}` : ''
          }`,
          relatedName: existing.lead?.name || existing.applicantName,
          relatedType: 'lead',
          relatedId: existing.leadId,
          outcome: nextStatus,
          metadata: {
            applicationId: existing.id,
            applicationCode: existing.code,
            previousStatus: existing.status,
            newStatus: nextStatus,
            event: 'application_status_changed',
          },
          ipAddress: meta?.ipAddress,
          userAgent: meta?.userAgent,
        },
      })
    }
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'APPLICATION_STATUS_CHANGED',
    entityType: 'application',
    entityId: id,
    ipAddress: meta?.ipAddress,
    userAgent: meta?.userAgent,
    metadata: {
      from: existing.status,
      to: nextStatus,
      applicationCode: existing.code,
      leadId: existing.leadId,
    },
  })

  const full = await prisma.application.findUniqueOrThrow({
    where: { id },
    include: APP_INCLUDE,
  })
  return { application: serializeApplication(full) }
}

export async function listStudents(
  auth: AuthContext,
  query: { search?: string; page?: number; limit?: number },
) {
  if (!hasPermission(auth.permissions, 'lead:convert') && !hasPermission(auth.permissions, 'lead:view')) {
    throw httpError.accessDenied('You do not have permission to view students.')
  }

  const page = Math.max(1, query.page || 1)
  const limit = Math.min(100, Math.max(1, query.limit || 20))
  const search = query.search?.trim()

  const where: Prisma.StudentWhereInput = search
    ? {
        OR: [
          { studentCode: { contains: search, mode: 'insensitive' } },
          { name: { contains: search, mode: 'insensitive' } },
          { destination: { contains: search, mode: 'insensitive' } },
          { program: { contains: search, mode: 'insensitive' } },
          { counsellorName: { contains: search, mode: 'insensitive' } },
          { status: { contains: search, mode: 'insensitive' } },
        ],
      }
    : {}

  const [total, rows] = await Promise.all([
    prisma.student.count({ where }),
    prisma.student.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        lead: { select: { id: true, code: true } },
        _count: { select: { applications: true } },
      },
    }),
  ])

  return {
    items: rows.map((row) => ({
      id: row.id,
      studentId: row.studentCode,
      name: row.name,
      destination: row.destination || '—',
      program: row.program || '—',
      counsellor: row.counsellorName || '—',
      status: row.status,
      enrolled: row.enrolledAt
        ? row.enrolledAt.toLocaleString('en-US', {
            month: 'short',
            year: 'numeric',
            timeZone: 'UTC',
          })
        : '—',
      leadId: row.leadId,
      leadCode: row.lead?.code || null,
      applicationsCount: row._count.applications,
    })),
    total,
    page,
    limit,
  }
}
