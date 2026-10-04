import type { Server as HttpServer } from 'node:http'
import { Server } from 'socket.io'
import { config, SESSION_COOKIE } from '../config'
import { loadAuthFromToken, type AuthContext } from '../modules/auth/session.service'

export const SOCKET_EVENTS = {
  notificationCreated: 'notification:created',
} as const

type NotificationCreatedPayload = {
  notification: {
    id: string
    title: string
    body: string | null
    link: string | null
    type: string | null
    status: string
    leadId: string | null
    followUpId: string | null
    createdAt: string
    readAt: string | null
  }
  unreadCount: number
}

let io: Server | null = null

function readCookie(cookieHeader: string | undefined, name: string) {
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq)
    if (key !== name) continue
    return decodeURIComponent(trimmed.slice(eq + 1))
  }
  return undefined
}

function userRoom(userId: string) {
  return `user:${userId}`
}

export function initSocket(httpServer: HttpServer) {
  if (io) return io

  io = new Server(httpServer, {
    path: '/socket.io',
    cors: {
      origin: config.clientOrigins,
      credentials: true,
    },
  })

  io.use(async (socket, next) => {
    try {
      const token = readCookie(socket.request.headers.cookie, SESSION_COOKIE)
      const auth = await loadAuthFromToken(token)
      if (!auth) {
        next(new Error('UNAUTHORIZED'))
        return
      }
      socket.data.auth = auth as AuthContext
      next()
    } catch (error) {
      console.error('[socket] auth failed:', error)
      next(new Error('UNAUTHORIZED'))
    }
  })

  io.on('connection', (socket) => {
    const auth = socket.data.auth as AuthContext | undefined
    if (!auth?.user?.id) {
      socket.disconnect(true)
      return
    }
    void socket.join(userRoom(auth.user.id))
  })

  return io
}

export function getIO() {
  return io
}

export function emitToUser(userId: string, event: string, payload: unknown) {
  if (!io || !userId) return
  io.to(userRoom(userId)).emit(event, payload)
}

export function emitNotificationCreated(userId: string, payload: NotificationCreatedPayload) {
  emitToUser(userId, SOCKET_EVENTS.notificationCreated, payload)
}
