import { writeAuditLog } from '../../lib/audit'
import { httpError } from '../../lib/http-error'
import { prisma } from '../../lib/prisma'
import type { Prisma } from '../../lib/prisma-client'
import { hasPermission } from '../auth/access'
import type { AuthContext } from '../auth/session.service'
import { assertCanViewLead, asString } from './leads.helpers'

type AuditMeta = { ipAddress?: string; userAgent?: string }

const NOTE_MAX_LENGTH = 2000
/** Each lead can keep at most this many pinned notes. */
const NOTE_PIN_LIMIT = 3
const EDITED_AFTER_MS = 1000
const MODERATOR_ROLES = new Set(['admin', 'manager'])
const BROAD_LEAD_SCOPES = new Set(['TEAM', 'DEPARTMENT', 'ALL'])

type NoteRow = {
  id: string
  body: string
  createdAt: Date
  updatedAt: Date
  pinnedAt: Date | null
  createdById: string | null
  createdBy: { id: string; fullName: string } | null
}

const noteInclude = {
  createdBy: { select: { id: true, fullName: true } },
} as const

function noteWasEdited(row: { createdAt: Date; updatedAt: Date }) {
  return row.updatedAt.getTime() - row.createdAt.getTime() > EDITED_AFTER_MS
}

function canModerateLeadNotes(auth: AuthContext) {
  if (MODERATOR_ROLES.has(auth.role.key) || auth.roles.some((key) => MODERATOR_ROLES.has(key))) {
    return true
  }
  const scope = auth.dataScopes.lead || auth.dataScope.lead
  return BROAD_LEAD_SCOPES.has(scope)
}

function notePermissions(auth: AuthContext, createdById: string | null) {
  const canWrite = hasPermission(auth.permissions, 'lead:edit')
  const isAuthor = createdById != null && createdById === auth.user.id
  const canChange = canWrite && (isAuthor || canModerateLeadNotes(auth))
  return {
    edit: canChange,
    pin: canWrite,
    delete: canChange,
  }
}

function serializeNote(auth: AuthContext, row: NoteRow) {
  return {
    id: row.id,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    pinnedAt: row.pinnedAt ? row.pinnedAt.toISOString() : null,
    edited: noteWasEdited(row),
    createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.fullName } : null,
    permissions: notePermissions(auth, row.createdById),
  }
}

function parseNoteBody(value: unknown) {
  const text = asString(value)
  if (!text) {
    throw httpError.validation({ body: 'Note cannot be empty.' }, 'Note cannot be empty.')
  }
  if (text.length > NOTE_MAX_LENGTH) {
    throw httpError.validation(
      { body: `Note cannot exceed ${NOTE_MAX_LENGTH} characters.` },
      `Note cannot exceed ${NOTE_MAX_LENGTH} characters.`,
    )
  }
  return text
}

function assertCanChangeNote(auth: AuthContext, createdById: string | null) {
  if (!hasPermission(auth.permissions, 'lead:edit')) {
    throw httpError.accessDenied()
  }
  const isAuthor = createdById != null && createdById === auth.user.id
  if (isAuthor || canModerateLeadNotes(auth)) return
  throw httpError.accessDenied('You can only edit or delete your own notes.')
}

function assertCanPinNote(auth: AuthContext) {
  if (!hasPermission(auth.permissions, 'lead:edit')) {
    throw httpError.accessDenied()
  }
}

async function loadLivingNote(leadId: string, noteId: string) {
  const note = await prisma.leadNote.findFirst({
    where: { id: noteId, leadId, deletedAt: null },
    include: noteInclude,
  })
  if (!note) throw httpError.notFound('Note not found.')
  return note
}

function latestLivingNote(tx: Prisma.TransactionClient, leadId: string) {
  return tx.leadNote.findFirst({
    where: { leadId, deletedAt: null },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, body: true },
  })
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

  const stampedAt = lead.updatedAt || lead.createdAt || new Date()
  await prisma.leadNote.create({
    data: {
      leadId,
      body,
      createdById: lead.updatedById || lead.createdById || null,
      createdAt: stampedAt,
      updatedAt: stampedAt,
    },
  })
}

export async function listLeadNotes(auth: AuthContext, leadId: string) {
  await assertCanViewLead(auth, leadId)
  await ensureLegacyNoteSeed(leadId)

  const items = await prisma.leadNote.findMany({
    where: { leadId, deletedAt: null },
    include: noteInclude,
    orderBy: [
      { pinnedAt: { sort: 'desc', nulls: 'last' } },
      { createdAt: 'desc' },
      { id: 'desc' },
    ],
  })

  return { items: items.map((item) => serializeNote(auth, item)) }
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

  const text = parseNoteBody(body.body || body.notes)
  const skipActivity = body.skipActivity === true

  const created = await prisma.$transaction(async (tx) => {
    const note = await tx.leadNote.create({
      data: {
        leadId,
        body: text,
        createdById: auth.user.id,
      },
      include: noteInclude,
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

  return { note: serializeNote(auth, created) }
}

export async function updateLeadNote(
  auth: AuthContext,
  leadId: string,
  noteId: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  const lead = await assertCanViewLead(auth, leadId)
  const note = await loadLivingNote(leadId, noteId)
  assertCanChangeNote(auth, note.createdById)

  const text = parseNoteBody(body.body)
  if (text === note.body.trim()) {
    return { note: serializeNote(auth, note) }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const latest = await latestLivingNote(tx, leadId)
    const saved = await tx.leadNote.update({
      where: { id: note.id },
      data: { body: text, updatedAt: new Date() },
      include: noteInclude,
    })
    if (latest?.id === note.id) {
      await tx.lead.update({
        where: { id: leadId },
        data: { notes: text, updatedById: auth.user.id },
      })
    }
    await tx.activity.create({
      data: {
        type: 'NOTE',
        userId: auth.user.id,
        notes: text,
        relatedName: lead.name,
        relatedType: 'lead',
        relatedId: lead.id,
        outcome: 'Note edited',
        metadata: { noteId: note.id, action: 'NOTE_EDITED' },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    })
    return saved
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'LEAD_NOTE_UPDATED',
    entityType: 'lead',
    entityId: leadId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: {
      noteId: note.id,
      leadCode: lead.code,
      previousBody: note.body,
      nextBody: text,
    },
  })

  return { note: serializeNote(auth, updated) }
}

export async function setLeadNotePin(
  auth: AuthContext,
  leadId: string,
  noteId: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  const lead = await assertCanViewLead(auth, leadId)
  const note = await loadLivingNote(leadId, noteId)
  assertCanPinNote(auth)

  if (typeof body.pinned !== 'boolean') {
    throw httpError.validation(
      { pinned: 'Choose whether to pin or unpin this note.' },
      'Choose whether to pin or unpin this note.',
    )
  }

  const pinned = body.pinned
  if (Boolean(note.pinnedAt) === pinned) {
    return { note: serializeNote(auth, note) }
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (pinned) {
      const pinnedCount = await tx.leadNote.count({
        where: {
          leadId,
          deletedAt: null,
          pinnedAt: { not: null },
          id: { not: note.id },
        },
      })
      if (pinnedCount >= NOTE_PIN_LIMIT) {
        throw httpError.validation(
          {
            pinned: `Unpin a note before pinning another. Each lead can have up to ${NOTE_PIN_LIMIT} pinned notes.`,
          },
          `Each lead can have up to ${NOTE_PIN_LIMIT} pinned notes.`,
        )
      }
    }

    return tx.leadNote.update({
      where: { id: note.id },
      data: { pinnedAt: pinned ? new Date() : null },
      include: noteInclude,
    })
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: pinned ? 'LEAD_NOTE_PINNED' : 'LEAD_NOTE_UNPINNED',
    entityType: 'lead',
    entityId: leadId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { noteId: note.id, leadCode: lead.code, pinned },
  })

  return { note: serializeNote(auth, updated) }
}

export async function deleteLeadNote(
  auth: AuthContext,
  leadId: string,
  noteId: string,
  meta: AuditMeta,
) {
  const lead = await assertCanViewLead(auth, leadId)
  const note = await loadLivingNote(leadId, noteId)
  assertCanChangeNote(auth, note.createdById)

  await prisma.$transaction(async (tx) => {
    const latest = await latestLivingNote(tx, leadId)
    await tx.leadNote.update({
      where: { id: note.id },
      data: { deletedAt: new Date(), pinnedAt: null },
    })

    if (latest?.id === note.id) {
      const previous = await tx.leadNote.findFirst({
        where: { leadId, deletedAt: null, id: { not: note.id } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { body: true },
      })
      await tx.lead.update({
        where: { id: leadId },
        data: {
          notes: previous?.body?.trim() ? previous.body : null,
          updatedById: auth.user.id,
        },
      })
    }

    await tx.activity.create({
      data: {
        type: 'NOTE',
        userId: auth.user.id,
        notes: note.body,
        relatedName: lead.name,
        relatedType: 'lead',
        relatedId: lead.id,
        outcome: 'Note removed',
        metadata: { noteId: note.id, action: 'NOTE_REMOVED' },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    })
  })

  await writeAuditLog({
    userId: auth.user.id,
    action: 'LEAD_NOTE_DELETED',
    entityType: 'lead',
    entityId: leadId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: {
      noteId: note.id,
      leadCode: lead.code,
      previousBody: note.body,
    },
  })

  return { message: 'Note deleted.' }
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
      outcome: 'Note edited',
      ipAddress: input.meta.ipAddress,
      userAgent: input.meta.userAgent,
    },
  })

  return note
}
