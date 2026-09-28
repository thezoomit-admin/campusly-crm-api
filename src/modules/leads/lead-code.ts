import { prisma } from '../../lib/prisma'

export async function nextLeadCode() {
  const rows = await prisma.$queryRaw<Array<{ max: number | bigint | null }>>`
    SELECT MAX(CAST(substring(code from 3) AS INTEGER)) AS max
    FROM leads
    WHERE code ~ '^L-[0-9]+$'
  `
  const current = Number(rows[0]?.max || 0)
  const next = current + 1
  return `L-${String(next).padStart(4, '0')}`
}
