import { PrismaClient } from './prisma-client'

const globalForPrisma = globalThis as { prisma?: PrismaClient }

/** Neon pooler / cold-start latency often exceeds Prisma's 5s transaction defaults. */
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    transactionOptions: {
      maxWait: 10_000,
      timeout: 30_000,
    },
  })

globalForPrisma.prisma = prisma

/** Retry $connect for Neon wake-ups and flaky DNS (P1001). */
export async function ensureDbConnected(retries = 5, delayMs = 2000) {
  let lastError: unknown
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await prisma.$connect()
      await prisma.$queryRaw`SELECT 1`
      return
    } catch (error) {
      lastError = error
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code)
          : ''
      console.warn(
        `Database connect attempt ${attempt}/${retries} failed${code ? ` (${code})` : ''}. Retrying…`,
      )
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt))
      }
    }
  }
  throw lastError
}
