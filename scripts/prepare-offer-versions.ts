import path from 'path'
import dotenv from 'dotenv'
import { PrismaClient } from '../generated/prisma/index'

const root = path.join(__dirname, '..')
dotenv.config({ path: path.join(root, '.env') })
dotenv.config({ path: path.join(root, `.env.${process.env.NODE_ENV || 'development'}`), override: true })

const prisma = new PrismaClient()

/**
 * CRM-020 adds a unique (lead_id, offer_version) constraint. Existing leads may already
 * hold several offers, so they are numbered V1, V2, … by creation time before `db push`
 * creates the constraint. Safe to run more than once.
 */
async function main() {
  await prisma.$executeRawUnsafe(
    'ALTER TABLE service_offers ADD COLUMN IF NOT EXISTS offer_version integer NOT NULL DEFAULT 1',
  )
  const updated = await prisma.$executeRawUnsafe(`
    UPDATE service_offers AS offer
    SET offer_version = numbered.version
    FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY lead_id ORDER BY created_at, id)::int AS version
      FROM service_offers
    ) AS numbered
    WHERE offer.id = numbered.id AND offer.offer_version <> numbered.version
  `)
  console.log(`Numbered ${updated} service offer version(s). Now run: npm run push`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
