import { prisma } from '../../lib/prisma'
import { canReceiveLeadAssignment } from '../auth/access'

export async function resolveCountryAssignment(countryCode: string | null, fallbackUser: { id: string; fullName: string }) {
  if (!countryCode) {
    return {
      ownerId: fallbackUser.id,
      ownerName: fallbackUser.fullName,
      teamId: null as string | null,
      teamName: null as string | null,
    }
  }

  const rule = await prisma.countryAssignmentRule.findUnique({
    where: { countryCode },
    include: {
      team: { include: { users: { where: { status: 'ACTIVE' }, select: { id: true, fullName: true, status: true } } } },
      defaultOwner: { select: { id: true, fullName: true, status: true } },
    },
  })

  if (!rule?.isActive) {
    return {
      ownerId: fallbackUser.id,
      ownerName: fallbackUser.fullName,
      teamId: null,
      teamName: null,
    }
  }

  if (rule.defaultOwner && canReceiveLeadAssignment(rule.defaultOwner.status)) {
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
      ownerId: fallbackUser.id,
      ownerName: fallbackUser.fullName,
      teamId: rule.teamId,
      teamName: rule.team.name,
    }
  }

  const counts = await prisma.lead.groupBy({
    by: ['ownerId'],
    where: { ownerId: { in: eligible.map((user) => user.id) }, status: { notIn: ['Converted', 'Closed', 'Lost'] } },
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
