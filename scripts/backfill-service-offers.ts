import path from 'path'
import dotenv from 'dotenv'
import { PrismaClient } from '../generated/prisma/index'

const root = path.join(__dirname, '..')
dotenv.config({ path: path.join(root, '.env') })
dotenv.config({ path: path.join(root, `.env.${process.env.NODE_ENV || 'development'}`), override: true })

const prisma = new PrismaClient()

/**
 * Offers created before CRM-018 stored only a package price in `final_price`.
 * They are converted to Generated offers whose package price equals that agreed price,
 * so the amount the student was quoted stays the same.
 */
async function main() {
  const legacy = await prisma.serviceOffer.findMany({
    where: { grossTotal: 0, finalPayable: { gt: 0 } },
    include: { items: true, sourceVersion: { select: { price: true } } },
  })

  for (const offer of legacy) {
    const agreed = offer.finalPayable
    await prisma.$transaction(async (tx) => {
      await tx.serviceOfferItem.deleteMany({ where: { serviceOfferId: offer.id, selected: false } })
      for (const item of offer.items.filter((entry) => entry.selected)) {
        await tx.serviceOfferItem.update({
          where: { id: item.id },
          data: {
            kind: 'PACKAGE_INCLUDED',
            defaultPrice: item.defaultPrice ?? item.offeredPrice,
            quantity: 1,
            discountAmount: 0,
            lineTotal: 0,
          },
        })
      }
      await tx.serviceOffer.update({
        where: { id: offer.id },
        data: {
          status: 'GENERATED',
          generatedAt: offer.generatedAt ?? offer.updatedAt,
          generatedById: offer.generatedById ?? offer.createdById,
          packageDefaultPrice: offer.packageDefaultPrice ?? offer.sourceVersion?.price ?? agreed,
          packagePrice: offer.packagePrice ?? agreed,
          grossTotal: agreed,
          subtotal: agreed,
          lineDiscountTotal: 0,
          overallDiscountAmount: 0,
          finalPayable: agreed,
        },
      })
    })
  }

  console.log(`Backfilled ${legacy.length} service offer(s).`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
