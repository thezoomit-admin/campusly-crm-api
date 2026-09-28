import cookieParser from 'cookie-parser'
import cors from 'cors'
import express from 'express'
import { config } from './config'
import { HttpError } from './lib/http-error'
import { attachSession } from './modules/auth/attach-session.middleware'
import { authRouter } from './modules/auth/auth.routes'
import { activitiesRouter } from './modules/activities/activities.routes'
import { auditRouter } from './modules/audit/audit.routes'
import { healthRouter } from './modules/health/health.routes'
import { employeesRouter } from './modules/employees/employees.routes'
import { masterDataRouter } from './modules/master-data/master-data.routes'
import { meRouter } from './modules/me/me.routes'
import { permissionsRouter } from './modules/permissions/permissions.routes'
import { rolesRouter } from './modules/roles/roles.routes'
import { searchRouter } from './modules/search/search.routes'
import { usersRouter } from './modules/users/users.routes'
import { leadsRouter } from './modules/leads/leads.routes'
import { pipelineRouter } from './modules/pipeline/pipeline.routes'

export function createApp() {
  const app = express()

  app.use(
    cors({
      origin: config.clientOrigins,
      credentials: true,
    }),
  )
  app.use(express.json())
  app.use(cookieParser())
  app.use(attachSession)

  app.use('/api/health', healthRouter)
  app.use('/api/auth', authRouter)
  app.use('/api/me', meRouter)
  app.use('/api/users', usersRouter)
  app.use('/api/employees', employeesRouter)
  app.use('/api/roles', rolesRouter)
  app.use('/api/permissions', permissionsRouter)
  app.use('/api/master-data', masterDataRouter)
  app.use('/api/audit-logs', auditRouter)
  app.use('/api/activities', activitiesRouter)
  app.use('/api/leads', leadsRouter)
  app.use('/api/pipeline', pipelineRouter)
  app.use('/api/search', searchRouter)

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found', path: req.path })
  })

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      res.status(error.status).json({
        error: error.message,
        code: error.code,
        ...(error.fields ? { fields: error.fields } : {}),
        ...(error.extra || {}),
      })
      return
    }

    if (error instanceof SyntaxError) {
      res.status(400).json({ error: 'Invalid request body.', code: 'INVALID_INPUT' })
      return
    }

    console.error(error)
    res.status(500).json({
      error: 'Unable to process the request. Please try again.',
      code: 'SERVER_ERROR',
    })
  })

  return app
}

const app = createApp()

export default app
