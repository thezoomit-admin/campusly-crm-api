import { prisma } from '../../lib/prisma'
import { readWorkspaceSettings } from '../settings/settings.service'

export async function nextLeadCode() {
  const { leadCodePrefix } = await readWorkspaceSettings()
  const prefix = /^[A-Z][A-Z0-9]{0,5}$/.test(leadCodePrefix) ? leadCodePrefix : 'L'
  const pattern = `^${prefix}-[0-9]+$`
  const start = prefix.length + 2
  const rows = await prisma.$queryRaw<Array<{ max: number | bigint | null }>>`
    SELECT MAX(CAST(substring(code from CAST(${start} AS INTEGER)) AS INTEGER)) AS max
    FROM leads
    WHERE code ~ ${pattern}
  `
  const current = Number(rows[0]?.max || 0)
  const next = current + 1
  return `${prefix}-${String(next).padStart(4, '0')}`
}
