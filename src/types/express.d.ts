import type { AuthContext } from '../modules/auth/session.service'

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext
      rawBody?: Buffer
    }
  }
}

export {}
