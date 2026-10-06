import { writeAuditLog } from '../../lib/audit'
import { httpError } from '../../lib/http-error'
import { prisma } from '../../lib/prisma'
import type { Prisma } from '../../lib/prisma-client'
import { hasPermission } from '../auth/access'
import type { AuthContext } from '../auth/session.service'
import { assertCanViewLead, asString } from './leads.helpers'

type AuditMeta = { ipAddress?: string; userAgent?: string }

const NOTE_MAX_LENGTH = 2000

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

export async function ensureLegacyNoteSeed(leadId: string) {
  const existing = await prisma.leadNote.count({ where: { leadId } })
  if (existing > 0) return

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: {
      notes: true,
      updatedById: true,
      createdById: true,
      updatedAt: true,
      createdAt: true,
    },
  })
  if (!lead) return
  const body = lead.notes?.trim()
  if (!body) return

  await prisma.leadNote.create({
    data: {
      leadId,
      body,
      createdById: lead.updatedById || lead.createdById || null,
      createdAt: lead.updatedAt || lead.createdAt || new Date(),
    },
  })
}

export async function listLeadNotes(auth: AuthContext, leadId: string) {
  await assertCanViewLead(auth, leadId)
  await ensureLegacyNoteSeed(leadId)

  const items = await prisma.leadNote.findMany({
    where: { leadId },
    include: { createdBy: { select: { id: true, fullName: true } } },
    orderBy: { createdAt: 'desc' },
  })

  return { items: items.map(serializeNote) }
}

export async function createLeadNote(
  auth: AuthContext,
  leadId: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  if (!hasPermission(auth.permissions, 'lead:edit')) {
    throw httpError.accessDenied()
  }
  const lead = await assertCanViewLead(auth, leadId)
  await ensureLegacyNoteSeed(leadId)

  const text = asString(body.body || body.notes)
  if (!text) {
    throw httpError.validation({ body: 'Note cannot be empty.' }, 'Note cannot be empty.')
  }
  if (text.length > NOTE_MAX_LENGTH) {
    throw httpError.validation(
      { body: `Note cannot exceed ${NOTE_MAX_LENGTH} characters.` },
      `Note cannot exceed ${NOTE_MAX_LENGTH} characters.`,
    )
  }

  const skipActivity = body.skipActivity === true

  const created = await prisma.$transaction(async (tx) => {
    const note = await tx.leadNote.create({
      data: {
        leadId,
        body: text,
        createdById: auth.user.id,
      },
      include: { createdBy: { select: { id: true, fullName: true } } },
    })

    await tx.lead.update({
      where: { id: leadId },
      data: {
        notes: text,
        updatedById: auth.user.id,
      },
    })

    if (!skipActivity) {
      await tx.activity.create({
        data: {
          type: 'NOTE',
          userId: auth.user.id,
          notes: text,
          relatedName: lead.name,
          relatedType: 'lead',
          relatedId: lead.id,
          outcome: 'Note added',
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
      })
    }

    return note
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'LEAD_NOTE_ADDED',
    entityType: 'lead',
    entityId: leadId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { noteId: created.id, leadCode: lead.code },
  })

  return { note: serializeNote(created) }
}

/** Append a note history row when lead.notes is changed via the edit form. */
export async function recordLeadNoteChange(
  tx: Prisma.TransactionClient,
  input: {
    leadId: string
    previousNotes: string | null
    nextNotes: string | null
    leadName: string
    actorUserId: string
    meta: AuditMeta
  },
) {
  const previous = input.previousNotes?.trim() || ''
  const next = input.nextNotes?.trim() || ''
  if (!next || next === previous) return null

  const note = await tx.leadNote.create({
    data: {
      leadId: input.leadId,
      body: next,
      createdById: input.actorUserId,
    },
  })

  await tx.activity.create({
    data: {
      type: 'NOTE',
      userId: input.actorUserId,
      notes: next,
      relatedName: input.leadName,
      relatedType: 'lead',
      relatedId: input.leadId,
      outcome: 'Note updated',
      ipAddress: input.meta.ipAddress,
      userAgent: input.meta.userAgent,
    },
  })

  return note
}
