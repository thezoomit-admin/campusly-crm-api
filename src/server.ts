import { Server } from 'http'
import app from './app'
import { config } from './config'
import { startFollowUpJobs } from './jobs/follow-up-jobs'
import { prisma } from './lib/prisma'

const PORT = config.port
let server: Server | undefined
let followUpJobTimer: ReturnType<typeof setInterval> | undefined

const gracefulShutdown = (signal: string) => {
  console.log(`\n🛑 ${signal} received. Starting graceful shutdown...`)

  if (followUpJobTimer) {
    clearInterval(followUpJobTimer)
    followUpJobTimer = undefined
  }

  if (server) {
    server.close((err) => {
      if (err) {
        console.error('❌ Error during server shutdown:', err)
        process.exit(1)
      }

      console.log('✅ HTTP server closed successfully')

      prisma
        .$disconnect()
        .then(() => {
          console.log('✅ Database connection closed successfully')
          process.exit(0)
        })
        .catch((error) => {
          console.error('❌ Error closing database connection:', error)
          process.exit(1)
        })
    })
  } else {
    process.exit(0)
  }
}

const exitHandler = (error: Error, event: string) => {
  console.error(`❌ ${event}:`, error)
  gracefulShutdown(event)
}

process.on('uncaughtException', (error: Error) => {
  exitHandler(error, 'uncaughtException')
})

process.on('unhandledRejection', (reason: unknown) => {
  const error = reason instanceof Error ? reason : new Error(String(reason))
  exitHandler(error, 'unhandledRejection')
})

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

async function bootstrap() {
  try {
    await prisma.$connect()
    console.log('✅ Database connected successfully')

    server = app.listen(PORT, '0.0.0.0', () => {
      console.log('🚀 Campusly CRM API Started Successfully!')
      console.log(`📍 Server running on: http://localhost:${PORT}`)
      console.log(`🌍 Environment: ${config.env}`)
      console.log(`🔗 Health check: http://localhost:${PORT}/api/health`)
      console.log('─'.repeat(60))
      followUpJobTimer = startFollowUpJobs()
      console.log('⏱️  Follow-up jobs started (overdue + reminders, every 2 min)')
    })
  } catch (error) {
    console.error('❌ Failed to start server:', error)
    process.exit(1)
  }
}

void bootstrap()
