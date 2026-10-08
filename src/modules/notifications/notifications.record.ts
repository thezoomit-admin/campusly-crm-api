import type { Prisma } from "../../lib/prisma-client";
import { prisma } from "../../lib/prisma";
import { emitNotificationCreated } from "../../realtime/socket";

export type NotificationAction = {
  key: string;
  label: string;
  href?: string;
};

type NotificationRow = {
  id: string;
  title: string;
  body: string | null;
  link: string | null;
  type: string | null;
  eventType: string | null;
  kind: string;
  priority: string;
  status: string;
  leadId: string | null;
  followUpId: string | null;
  deliveryStatus: string;
  createdAt: Date;
  readAt: Date | null;
  archivedAt: Date | null;
  expiresAt: Date | null;
  scheduledAt: Date | null;
  sentAt: Date | null;
  payload: Prisma.JsonValue;
  actions: Prisma.JsonValue;
  channel: string;
  deliveries?: Array<{ channel: string; status: string; attempts: number; lastError: string | null; sentAt: Date | null }>;
  lead?: { id: string; code: string; name: string } | null;
  user?: { id: string; fullName: string } | null;
};

export function serializeNotification(row: NotificationRow) {
  const browser = (row.deliveries || []).some((item) => item.channel === "browser" && item.status === "Sent");
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    link: row.link,
    type: row.type,
    eventType: row.eventType || row.type,
    kind: row.kind || "system",
    priority: row.priority || "Normal",
    status: row.status,
    channel: row.channel,
    leadId: row.leadId,
    followUpId: row.followUpId,
    deliveryStatus: row.deliveryStatus,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt ? row.readAt.toISOString() : null,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    scheduledAt: row.scheduledAt ? row.scheduledAt.toISOString() : null,
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    payload: row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? row.payload : null,
    actions: Array.isArray(row.actions) ? row.actions : [],
    browser,
    lead: row.lead ? { id: row.lead.id, code: row.lead.code, name: row.lead.name } : null,
    recipientName: row.user?.fullName || null,
    deliveries: (row.deliveries || []).map((item) => ({
      channel: item.channel,
      status: item.status,
      attempts: item.attempts,
      lastError: item.lastError,
      sentAt: item.sentAt ? item.sentAt.toISOString() : null,
    })),
  };
}

export async function countUnreadNotifications(userId: string) {
  return prisma.notification.count({
    where: {
      userId,
      status: "Unread",
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });
}

function pushNotificationCreated(userId: string, row: NotificationRow) {
  void countUnreadNotifications(userId)
    .then((unreadCount) => {
      emitNotificationCreated(userId, {
        notification: serializeNotification(row),
        unreadCount,
      });
    })
    .catch((error) => {
      console.error("[socket] Failed to emit notification:created", error);
    });
}

const notificationInclude = {
  deliveries: true,
  lead: { select: { id: true, code: true, name: true } },
  user: { select: { id: true, fullName: true } },
} satisfies Prisma.NotificationInclude;

export async function createNotification(input: {
  userId: string;
  title: string;
  body?: string;
  link?: string;
  type?: string;
  eventType?: string;
  kind?: "system" | "reminder";
  priority?: string;
  leadId?: string | null;
  followUpId?: string | null;
  dedupeKey?: string;
  expiresAt?: Date | null;
  scheduledAt?: Date | null;
  payload?: Prisma.InputJsonValue;
  actions?: NotificationAction[];
  browser?: boolean;
}) {
  if (input.dedupeKey) {
    const existing = await prisma.notification.findUnique({
      where: { dedupeKey: input.dedupeKey },
      include: notificationInclude,
    });
    if (existing) return existing;
  }

  const now = new Date();
  const created = await prisma.notification.create({
    data: {
      userId: input.userId,
      title: input.title,
      body: input.body || null,
      link: input.link || null,
      type: input.type || input.eventType || "general",
      eventType: input.eventType || input.type || "general",
      kind: input.kind || "system",
      priority: input.priority || "Normal",
      channel: "in_app",
      status: "Unread",
      deliveryStatus: "Sent",
      leadId: input.leadId || null,
      followUpId: input.followUpId || null,
      dedupeKey: input.dedupeKey || null,
      expiresAt: input.expiresAt || null,
      scheduledAt: input.scheduledAt || null,
      sentAt: now,
      payload: input.payload,
      actions: input.actions || undefined,
      deliveries: {
        create: [
          { channel: "in_app", status: "Sent", attempts: 1, sentAt: now },
          ...(input.browser ? [{ channel: "browser", status: "Sent", attempts: 1, sentAt: now }] : []),
        ],
      },
    },
    include: notificationInclude,
  });

  pushNotificationCreated(input.userId, created);
  return created;
}

export async function deactivateFollowUpNotifications(followUpId: string) {
  const now = new Date();
  await prisma.followUp.updateMany({
    where: { id: followUpId, reminderStatus: { in: ["Pending", "Sent"] } },
    data: { reminderStatus: "Cancelled" },
  });
  await prisma.notification.updateMany({
    where: {
      followUpId,
      status: { not: "Archived" },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    data: { expiresAt: now },
  });
}
