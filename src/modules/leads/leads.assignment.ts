import { prisma } from '../../lib/prisma'
import { canReceiveLeadAssignment } from '../auth/access'
import { CLOSED_ASSIGNMENT_STATUSES } from './lead-status'
import { leadEligibleAssigneeWhere } from './leads.helpers'

export type CountryAssignmentResult = {
  ownerId: string | null
  ownerName: string | null
  teamId: string | null
  teamName: string | null
}

const UNASSIGNED: CountryAssignmentResult = {
  ownerId: null,
  ownerName: null,
  teamId: null,
  teamName: null,
}

export async function resolveCountryAssignment(countryCode: string | null): Promise<CountryAssignmentResult> {
  if (!countryCode) return UNASSIGNED

  const rule = await prisma.countryAssignmentRule.findUnique({
    where: { countryCode },
    include: {
      team: {
        include: {
          users: {
            where: leadEligibleAssigneeWhere(),
            select: { id: true, fullName: true, status: true },
          },
        },
      },
      defaultOwner: {
        select: {
          id: true,
          fullName: true,
          status: true,
          employee: { select: { employmentStatus: { select: { code: true } } } },
        },
      },
    },
  })

  if (!rule?.isActive) return UNASSIGNED

  const defaultEligible =
    rule.defaultOwner &&
    canReceiveLeadAssignment(rule.defaultOwner.status) &&
    (!rule.defaultOwner.employee ||
      rule.defaultOwner.employee.employmentStatus.code === 'ACTIVE' ||
      rule.defaultOwner.employee.employmentStatus.code === 'PROBATION')

  if (defaultEligible && rule.defaultOwner) {
    return {
      ownerId: rule.defaultOwner.id,
      ownerName: rule.defaultOwner.fullName,
      teamId: rule.teamId,
      teamName: rule.team.name,
    }
  }

  const eligible = rule.team.users.filter((user) => canReceiveLeadAssignment(user.status))
  if (eligible.length === 0) {
    return {
      ownerId: null,
      ownerName: null,
      teamId: rule.teamId,
      teamName: rule.team.name,
    }
  }

  const counts = await prisma.lead.groupBy({
    by: ['ownerId'],
    where: {
      ownerId: { in: eligible.map((user) => user.id) },
      status: { notIn: [...CLOSED_ASSIGNMENT_STATUSES] },
    },
    _count: { _all: true },
  })
  const countMap = new Map(counts.map((row) => [row.ownerId, row._count._all]))
  eligible.sort((a, b) => (countMap.get(a.id) || 0) - (countMap.get(b.id) || 0))
  const owner = eligible[0]

  return {
    ownerId: owner.id,
    ownerName: owner.fullName,
    teamId: rule.teamId,
    teamName: rule.team.name,
  }
}
