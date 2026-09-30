import type { AuthContext } from '../auth/session.service'
import { hasPermission } from '../auth/access'
import { httpError } from '../../lib/http-error'
import { prisma } from '../../lib/prisma'
import { ratePercent } from '../follow-ups/follow-ups.utils'

function startOfUtcDay(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function addUtcDays(date: Date, days: number) {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

/** Manager/CEO employee follow-up performance (DASH-003). */
export async function getFollowUpPerformance(
  auth: AuthContext,
  query: { from?: string; to?: string; ownerId?: string },
) {
  if (!hasPermission(auth.permissions, 'follow_up:view')) {
    throw httpError.accessDenied()
  }

  const now = new Date()
  const to = query.to ? new Date(`${query.to}T23:59:59.999Z`) : now
  const from = query.from ? new Date(`${query.from}T00:00:00.000Z`) : addUtcDays(startOfUtcDay(now), -30)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    throw httpError.badRequest('Please select a valid date range.')
  }

  const scope = auth.dataScopes.lead ?? 'OWN'
  const ownerFilter =
    query.ownerId && (scope === 'ALL' || scope === 'TEAM' || scope === 'DEPARTMENT')
      ? { ownerId: query.ownerId }
      : scope === 'OWN'
        ? { ownerId: auth.user.id }
        : {}

  const rows = await prisma.followUp.findMany({
    where: {
      ...ownerFilter,
      dueAt: { gte: from, lte: to },
      status: { notIn: ['Cancelled', 'Rescheduled'] },
    },
    select: {
      ownerId: true,
      ownerName: true,
      status: true,
      dueAt: true,
      completedAt: true,
    },
  })

  type Agg = {
    ownerId: string | null
    ownerName: string
    due: number
    completed: number
    onTime: number
    overdue: number
  }

  const byOwner = new Map<string, Agg>()
  for (const row of rows) {
    const key = row.ownerId || 'unassigned'
    const current = byOwner.get(key) || {
      ownerId: row.ownerId,
      ownerName: row.ownerName || 'Unassigned',
      due: 0,
      completed: 0,
      onTime: 0,
      overdue: 0,
    }
    current.due += 1
    if (row.status === 'Completed' || row.status === 'Done') {
      current.completed += 1
      if (row.completedAt && row.dueAt && row.completedAt.getTime() <= row.dueAt.getTime()) {
        current.onTime += 1
      }
    } else if (
      row.status === 'Overdue' ||
      (row.dueAt && row.dueAt < now && row.status !== 'Completed' && row.status !== 'Done')
    ) {
      current.overdue += 1
    }
    byOwner.set(key, current)
  }

  const employees = [...byOwner.values()]
    .map((row) => ({
      ownerId: row.ownerId,
      ownerName: row.ownerName,
      due: row.due,
      completed: row.completed,
      onTime: row.onTime,
      overdue: row.overdue,
      completionRate: ratePercent(row.completed, row.due),
      onTimeRate: ratePercent(row.onTime, row.due),
    }))
    .sort((a, b) => b.due - a.due)

  const totals = employees.reduce(
    (acc, row) => {
      acc.due += row.due
      acc.completed += row.completed
      acc.onTime += row.onTime
      acc.overdue += row.overdue
      return acc
    },
    { due: 0, completed: 0, onTime: 0, overdue: 0 },
  )

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    summary: {
      ...totals,
      completionRate: ratePercent(totals.completed, totals.due),
      onTimeRate: ratePercent(totals.onTime, totals.due),
    },
    employees,
  }
}
