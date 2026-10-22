import type { Prisma } from '../../lib/prisma-client'
import { writeAuditLog } from '../../lib/audit'
import { HttpError, httpError } from '../../lib/http-error'
import { prisma } from '../../lib/prisma'
import type { AuthContext } from '../auth/session.service'
import { canReceiveLeadAssignment, hasPermission } from '../auth/access'
import {
  type LeadStatusItem,
  resolveLeadStatus,
} from './lead-status'
import {
  displayedLeadScore,
  FOLLOW_UP_CLOSED_STATUSES,
  WORKSPACE_ACCESS_DENIED,
  asString,
  assertCanViewLead,
  resolveMasterCode,
} from './leads.helpers'
type AuditMeta = { ipAddress?: string; userAgent?: string }

export const HANDOVER_MESSAGES = {
  permission: WORKSPACE_ACCESS_DENIED,
  failed: 'Unable to assign the lead to the selected Counsellor. Please try again.',
  counsellor: 'Select a counsellor.',
  notQualified: 'Only a Qualified lead can be handed over to a Counsellor.',
  same: 'This lead is already assigned to the selected Counsellor.',
  conflict: 'This lead changed before the handover completed. Refresh and try again.',
  note: 'Handover note is invalid.',
  tooLong: 'Cannot exceed 500 characters.',
  requirement: 'Enter what the student is looking for.',
  country: 'Select a preferred country.',
  summary: 'Enter the initial conversation summary.',
}

const NOTE_LIMIT = 500

type HandoverNoteInput = {
  studentRequirement: string | null
  preferredCountryCode: string | null
  preferredCountry: string | null
  preferredIntakeCode: string | null
  preferredIntake: string | null
  academicBackground: string | null
  conversationSummary: string | null
  importantConcern: string | null
}

function noteText(value: unknown, field: string, fields: Record<string, string>) {
  if (value == null || value === '') return null
  if (typeof value !== 'string') {
    fields[field] = 'Enter text only.'
    return null
  }
  const text = value.trim()
  if (!text) return null
  if (text.length > NOTE_LIMIT) {
    fields[field] = HANDOVER_MESSAGES.tooLong
    return null
  }
  return text
}

function isQualified(status: { code: string; name: string; behaviorKey: string | null } | null) {
  if (!status) return false
  if (status.behaviorKey === 'qualified') return true
  return status.code.toUpperCase() === 'QUALIFIED' || status.name.trim().toLowerCase() === 'qualified'
}

function counsellingStatus(items: LeadStatusItem[]) {
  return items.find(
    (item) =>
      item.status === 'ACTIVE' &&
      item.code &&
      (item.behaviorKey === 'counselling' || item.code.toUpperCase() === 'COUNSELLING' || item.name.trim().toLowerCase() === 'counselling'),
  )
}

async function loadLeadStatusItems(): Promise<LeadStatusItem[]> {
  const rows = await prisma.masterDataItem.findMany({
    where: { categoryKey: 'LEAD_STATUS' },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  })
  return rows.map((row) => ({
    name: row.name,
    code: row.code,
    behaviorKey: row.behaviorKey,
    sortOrder: row.sortOrder,
    status: row.status,
  }))
}

async function parseHandoverNote(body: Record<string, unknown>, fields: Record<string, string>): Promise<HandoverNoteInput> {
  const raw = body.note
  if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) {
    fields.note = HANDOVER_MESSAGES.note
  }
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const studentRequirement = noteText(source.studentRequirement, 'studentRequirement', fields)
  const conversationSummary = noteText(source.conversationSummary, 'conversationSummary', fields)
  if (!studentRequirement && !fields.studentRequirement) {
    fields.studentRequirement = HANDOVER_MESSAGES.requirement
  }
  if (!conversationSummary && !fields.conversationSummary) {
    fields.conversationSummary = HANDOVER_MESSAGES.summary
  }
  const country = await resolveMasterCode('COUNTRY', source.preferredCountryCode, 'preferredCountryCode', fields, {
    required: true,
    message: HANDOVER_MESSAGES.country,
  })
  const intake = await resolveMasterCode('INTAKE', source.preferredIntakeCode, 'preferredIntakeCode', fields)
  return {
    studentRequirement,
    preferredCountryCode: country?.code || null,
    preferredCountry: country?.name || null,
    preferredIntakeCode: intake?.code || null,
    preferredIntake: intake?.name || null,
    academicBackground: noteText(source.academicBackground, 'academicBackground', fields),
    conversationSummary,
    importantConcern: noteText(source.importantConcern, 'importantConcern', fields),
  }
}

function handoverReason(note: HandoverNoteInput, counsellorName: string) {
  const summary = [note.studentRequirement, note.conversationSummary, note.importantConcern].filter(Boolean).join(' · ')
  const text = summary ? `Handed over to ${counsellorName}. ${summary}` : `Handed over to ${counsellorName}`
  return text.slice(0, 400)
}

export async function handoverLead(auth: AuthContext, id: string, body: Record<string, unknown>, meta: AuditMeta) {
  if (!hasPermission(auth.permissions, 'lead:handover')) {
    throw httpError.accessDenied(HANDOVER_MESSAGES.permission)
  }

  const current = await assertCanViewLead(auth, id)
  const items = await loadLeadStatusItems()
  const status = resolveLeadStatus(current, items)
  const fields: Record<string, string> = {}
  if (!isQualified(status)) {
    fields.statusCode = HANDOVER_MESSAGES.notQualified
  }

  const counsellorId = asString(body.counsellorId)
  if (!counsellorId) fields.counsellorId = HANDOVER_MESSAGES.counsellor
  if (counsellorId && counsellorId === current.ownerId) {
    fields.counsellorId = HANDOVER_MESSAGES.same
  }

  const note = await parseHandoverNote(body, fields)
  if (Object.keys(fields).length > 0) {
    const message = fields.statusCode || fields.counsellorId || fields.note || Object.values(fields)[0] || HANDOVER_MESSAGES.failed
    throw httpError.validation(fields, message)
  }

  const counselling = counsellingStatus(items)
  if (!counselling?.code) {
    throw httpError.handoverFailed()
  }

  const counsellor = await prisma.user.findFirst({
    where: {
      id: counsellorId,
      primaryRole: { key: 'counsellor' },
      AND: [
        {
          status: 'ACTIVE',
          OR: [
            { employee: { is: null } },
            { employee: { employmentStatus: { code: { in: ['ACTIVE', 'PROBATION'] } } } },
          ],
        },
      ],
    },
    include: { team: { select: { id: true, name: true } }, primaryRole: { select: { key: true } } },
  })
  if (!counsellor || !canReceiveLeadAssignment(counsellor.status)) {
    throw httpError.badRequest(HANDOVER_MESSAGES.failed, 'LEAD_HANDOVER_FAILED')
  }

  const fromOwnerId = current.ownerId
  const fromOwnerName = current.ownerName
  const teamId = counsellor.teamId || current.assignedCountryTeamId
  const reason = handoverReason(note, counsellor.fullName)
  const scored = displayedLeadScore(current)
  const handoverNote: Prisma.InputJsonObject = {
    ...note,
    snapshot: {
      profileCompletion: current.profileCompletion,
      leadScore: scored.score,
      priority: scored.priority,
      priorityCode: scored.priorityCode,
      qualificationResultCode: current.qualificationResultCode,
    },
  }

  let assignmentId = ''
  try {
    const lead = await prisma.$transaction(async (tx) => {
      const claimed = await tx.lead.updateMany({
        where: {
          id,
          statusCode: current.statusCode,
          ownerId: current.ownerId,
          profileCompletion: current.profileCompletion,
          leadScore: current.leadScore,
          priorityCode: current.priorityCode,
          qualificationResultCode: current.qualificationResultCode,
        },
        data: {
          ownerId: counsellor.id,
          ownerName: counsellor.fullName,
          assignedCountryTeamId: teamId,
          status: counselling.name,
          statusCode: counselling.code,
          updatedById: auth.user.id,
        },
      })
      if (claimed.count !== 1) {
        throw new HttpError(409, HANDOVER_MESSAGES.conflict, 'LEAD_HANDOVER_CONFLICT')
      }

      const assignment = await tx.leadAssignment.create({
        data: {
          leadId: id,
          fromOwnerId,
          toOwnerId: counsellor.id,
          teamId,
          kind: 'HANDOVER',
          reason,
          handoverNote,
          createdById: auth.user.id,
        },
      })
      assignmentId = assignment.id

      await tx.leadStatusHistory.create({
        data: {
          leadId: id,
          previousStatus: status?.name || current.status,
          previousStatusCode: status?.code || current.statusCode,
          newStatus: counselling.name,
          newStatusCode: counselling.code!,
          remarks: reason,
          createdById: auth.user.id,
        },
      })

      await tx.activity.create({
        data: {
          type: 'NOTE',
          userId: auth.user.id,
          notes: `Lead handed over from ${fromOwnerName || 'Unassigned'} to ${counsellor.fullName}`,
          relatedName: current.name,
          relatedType: 'lead',
          relatedId: id,
          outcome: 'Handed over',
          metadata: {
            action: 'handover',
            fromOwnerId,
            fromOwnerName,
            toOwnerId: counsellor.id,
            toOwnerName: counsellor.fullName,
            assignmentId: assignment.id,
          },
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
      })

      await tx.followUp.updateMany({
        where: {
          leadId: id,
          status: { notIn: [...FOLLOW_UP_CLOSED_STATUSES] },
          ...(fromOwnerId ? { ownerId: fromOwnerId } : {}),
        },
        data: { ownerId: counsellor.id, ownerName: counsellor.fullName },
      })

      return tx.lead.findUniqueOrThrow({ where: { id } })
    })

    await writeAuditLog({
      userId: auth.user.id,
      action: 'LEAD_HANDED_OVER',
      entityType: 'lead',
      entityId: lead.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: {
        code: lead.code,
        from: fromOwnerName || 'Unassigned',
        to: counsellor.fullName,
        fromOwnerId,
        toOwnerId: counsellor.id,
        toOwnerName: counsellor.fullName,
        assignmentId,
        reason,
        relatedName: lead.name,
        name: lead.name,
        profileCompletion: current.profileCompletion,
        leadScore: scored.score,
        priority: scored.priority,
        qualificationResultCode: current.qualificationResultCode,
      },
    })

    try {
      const { createSystemFollowUp, daysFromNow } = await import('../follow-ups/system-follow-up')
      await createSystemFollowUp({
        leadId: lead.id,
        contactName: lead.name,
        type: 'Counselling',
        purpose: 'Counselling',
        nextAction: 'Start counselling session',
        dueAt: daysFromNow(1),
        priority: lead.priority || 'Medium',
        ownerId: counsellor.id,
        ownerName: counsellor.fullName,
        notes: note.importantConcern || note.conversationSummary,
        reason: `Lead Handover — ${assignmentId}`,
        actorUserId: auth.user.id,
        meta,
      })
      const { createNotification } = await import('../notifications/notifications.service')
      await createNotification({
        userId: counsellor.id,
        title: 'Lead handed over to you',
        body: `${lead.code} — ${lead.name} is ready for counselling.`,
        link: `/leads/${lead.id}`,
        type: 'lead_handover',
        leadId: lead.id,
        dedupeKey: `lead-handover:${assignmentId}`,
      })
    } catch (error) {
      console.error('[leads] Handover notification or follow-up failed:', error)
    }

    return {
      message: 'Lead handed over successfully.',
      leadId: lead.id,
      ownerId: counsellor.id,
    }
  } catch (error) {
    if (error instanceof HttpError) throw error
    console.error(error)
    throw httpError.handoverFailed()
  }
}
