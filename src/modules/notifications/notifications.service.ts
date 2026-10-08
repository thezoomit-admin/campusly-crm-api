import type { Prisma } from "../../lib/prisma-client";
import { httpError } from "../../lib/http-error";
import { prisma } from "../../lib/prisma";
import { hasPermission } from "../auth/access";
import type { AuthContext } from "../auth/session.service";
import {
  dispatchCrmEvent,
  ensureNotificationConfigs,
  recordNotificationConfigAudit,
} from "./notifications.dispatch";
import {
  countUnreadNotifications,
  createNotification,
  serializeNotification,
} from "./notifications.record";

export { createNotification, deactivateFollowUpNotifications } from "./notifications.record";
export { dispatchCrmEvent, ensureNotificationConfigs } from "./notifications.dispatch";

const TEAM_ROLES = new Set(["admin", "ceo", "manager"]);
const RECIPIENT_RULES = new Set(["owner", "owner_manager", "admin"]);
const PRIORITIES = new Set(["Normal", "Important", "Critical"]);

const listInclude = {
  deliveries: true,
  lead: { select: { id: true, code: true, name: true } },
  user: { select: { id: true, fullName: true } },
} satisfies Prisma.NotificationInclude;

function canViewTeam(auth: AuthContext) {
  return TEAM_ROLES.has(auth.role.key);
}

export async function listNotifications(
  auth: AuthContext,
  query: {
    limit?: number;
    unreadOnly?: boolean;
    scope?: string;
    status?: string;
    eventType?: string;
    priority?: string;
    leadId?: string;
    search?: string;
    from?: string;
    to?: string;
  },
) {
  if (!hasPermission(auth.permissions, "notification:view")) {
    throw httpError.accessDenied();
  }

  const limit = Math.min(100, Math.max(5, query.limit || 20));
  const scope = query.scope === "team" && canViewTeam(auth) ? "team" : "own";
  const filters: Prisma.NotificationWhereInput[] = [
    { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
  ];

  if (scope === "own") {
    filters.push({ userId: auth.user.id });
  } else if (auth.role.key === "manager") {
    const teammates = await prisma.user.findMany({
      where: { teamId: auth.user.teamId || "00000000-0000-0000-0000-000000000000", status: "ACTIVE" },
      select: { id: true },
    });
    filters.push({ userId: { in: teammates.map((row) => row.id) } });
  }

  if (query.unreadOnly) filters.push({ status: "Unread" });
  else if (query.status) filters.push({ status: query.status });
  if (query.eventType) filters.push({ eventType: query.eventType });
  if (query.priority) filters.push({ priority: query.priority });
  if (query.leadId) filters.push({ leadId: query.leadId });
  if (query.search) {
    filters.push({
      OR: [
        { title: { contains: query.search, mode: "insensitive" } },
        { body: { contains: query.search, mode: "insensitive" } },
      ],
    });
  }
  const from = query.from ? new Date(query.from) : null;
  const to = query.to ? new Date(query.to) : null;
  if (from && !Number.isNaN(from.getTime())) filters.push({ createdAt: { gte: from } });
  if (to && !Number.isNaN(to.getTime())) filters.push({ createdAt: { lte: to } });

  const where = { AND: filters };
  const [items, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      include: listInclude,
    }),
    countUnreadNotifications(auth.user.id),
  ]);

  return {
    items: items.map(serializeNotification),
    unreadCount,
    scope,
  };
}

export async function getNotification(auth: AuthContext, id: string) {
  if (!hasPermission(auth.permissions, "notification:view")) throw httpError.accessDenied();
  const row = await prisma.notification.findFirst({
    where: { id, ...(canViewTeam(auth) ? {} : { userId: auth.user.id }) },
    include: listInclude,
  });
  if (!row) throw httpError.notFound("Notification not found.");
  if (canViewTeam(auth) && auth.role.key === "manager" && row.userId !== auth.user.id) {
    const recipient = await prisma.user.findUnique({ where: { id: row.userId }, select: { teamId: true } });
    if (recipient?.teamId !== auth.user.teamId) throw httpError.notFound("Notification not found.");
  }
  return { notification: serializeNotification(row) };
}

export async function markNotificationRead(auth: AuthContext, id: string) {
  if (!hasPermission(auth.permissions, "notification:view")) throw httpError.accessDenied();
  const row = await prisma.notification.findFirst({ where: { id, userId: auth.user.id } });
  if (!row) throw httpError.notFound("Notification not found.");
  if (row.status === "Read" || row.status === "Archived") {
    return { notification: serializeNotification({ ...row, deliveries: [], lead: null, user: null }) };
  }
  const updated = await prisma.notification.update({
    where: { id },
    data: { status: "Read", readAt: new Date() },
    include: listInclude,
  });
  return { notification: serializeNotification(updated), unreadCount: await countUnreadNotifications(auth.user.id) };
}

export async function archiveNotification(auth: AuthContext, id: string) {
  if (!hasPermission(auth.permissions, "notification:view")) throw httpError.accessDenied();
  const row = await prisma.notification.findFirst({ where: { id, userId: auth.user.id } });
  if (!row) throw httpError.notFound("Notification not found.");
  const updated = await prisma.notification.update({
    where: { id },
    data: { status: "Archived", archivedAt: new Date(), readAt: row.readAt || new Date() },
    include: listInclude,
  });
  return { notification: serializeNotification(updated), unreadCount: await countUnreadNotifications(auth.user.id) };
}

export async function markAllNotificationsRead(auth: AuthContext) {
  if (!hasPermission(auth.permissions, "notification:view")) throw httpError.accessDenied();
  await prisma.notification.updateMany({
    where: { userId: auth.user.id, status: "Unread" },
    data: { status: "Read", readAt: new Date() },
  });
  return { ok: true, unreadCount: 0 };
}

export async function listNotificationPreferences(auth: AuthContext) {
  if (!hasPermission(auth.permissions, "notification:view")) throw httpError.accessDenied();
  await ensureNotificationConfigs();
  const [configs, prefs] = await Promise.all([
    prisma.notificationEventConfig.findMany({ orderBy: { label: "asc" } }),
    prisma.notificationPreference.findMany({ where: { userId: auth.user.id } }),
  ]);
  const prefByEvent = new Map(prefs.map((row) => [row.eventType, row]));
  return {
    items: configs.map((config) => {
      const pref = prefByEvent.get(config.eventType);
      return {
        eventType: config.eventType,
        label: config.label,
        mandatory: config.mandatory,
        enabled: config.enabled,
        priority: config.priority,
        channels: {
          inApp: config.inApp,
          email: config.email,
          whatsapp: config.whatsapp,
          browser: config.browser,
        },
        preference: {
          inApp: config.mandatory ? true : (pref?.inApp ?? true),
          email: config.mandatory ? config.email : (pref?.email ?? false),
          whatsapp: config.mandatory ? config.whatsapp : (pref?.whatsapp ?? false),
          browser: config.mandatory ? config.browser : (pref?.browser ?? false),
        },
      };
    }),
  };
}

export async function saveNotificationPreferences(
  auth: AuthContext,
  body: { items?: Array<{ eventType?: string; inApp?: boolean; email?: boolean; whatsapp?: boolean; browser?: boolean }> },
) {
  if (!hasPermission(auth.permissions, "notification:view")) {
    throw httpError.accessDenied("You are not authorized to manage this reminder.");
  }
  await ensureNotificationConfigs();
  const configs = await prisma.notificationEventConfig.findMany();
  const byType = new Map(configs.map((row) => [row.eventType, row]));
  const items = Array.isArray(body.items) ? body.items : [];

  for (const item of items) {
    const eventType = typeof item.eventType === "string" ? item.eventType : "";
    const config = byType.get(eventType);
    if (!config) continue;
    if (config.mandatory) continue;
    await prisma.notificationPreference.upsert({
      where: { userId_eventType: { userId: auth.user.id, eventType } },
      create: {
        userId: auth.user.id,
        eventType,
        inApp: item.inApp !== false,
        email: item.email === true && config.email,
        whatsapp: item.whatsapp === true && config.whatsapp,
        browser: item.browser === true && config.browser,
      },
      update: {
        inApp: item.inApp !== false,
        email: item.email === true && config.email,
        whatsapp: item.whatsapp === true && config.whatsapp,
        browser: item.browser === true && config.browser,
      },
    });
  }

  return listNotificationPreferences(auth);
}

export async function listNotificationConfig(auth: AuthContext) {
  if (!hasPermission(auth.permissions, "notification:configure")) throw httpError.accessDenied();
  await ensureNotificationConfigs();
  const rows = await prisma.notificationEventConfig.findMany({ orderBy: { label: "asc" } });
  return { items: rows };
}

export async function updateNotificationConfig(
  auth: AuthContext,
  eventType: string,
  body: Record<string, unknown>,
  meta: { ipAddress?: string; userAgent?: string },
) {
  if (!hasPermission(auth.permissions, "notification:configure")) throw httpError.accessDenied();
  await ensureNotificationConfigs();
  const current = await prisma.notificationEventConfig.findUnique({ where: { eventType } });
  if (!current) throw httpError.notFound("Notification configuration is invalid.");

  const data: Prisma.NotificationEventConfigUpdateInput = { updatedBy: { connect: { id: auth.user.id } } };
  if (typeof body.enabled === "boolean") data.enabled = body.enabled;
  if (typeof body.mandatory === "boolean") data.mandatory = body.mandatory;
  if (typeof body.inApp === "boolean") data.inApp = body.inApp;
  if (typeof body.email === "boolean") data.email = body.email;
  if (typeof body.whatsapp === "boolean") data.whatsapp = body.whatsapp;
  if (typeof body.browser === "boolean") data.browser = body.browser;
  if (typeof body.notifyPreviousOwner === "boolean") data.notifyPreviousOwner = body.notifyPreviousOwner;
  if (typeof body.priority === "string" && PRIORITIES.has(body.priority)) data.priority = body.priority;
  if (typeof body.recipientRule === "string" && RECIPIENT_RULES.has(body.recipientRule)) {
    data.recipientRule = body.recipientRule;
  }
  if (body.overdueAfterMinutes !== undefined) {
    const minutes = Number(body.overdueAfterMinutes);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 10080) {
      throw httpError.validation(
        { overdueAfterMinutes: "Notification configuration is invalid." },
        "Notification configuration is invalid.",
      );
    }
    data.overdueAfterMinutes = Math.round(minutes);
  }
  if (Array.isArray(body.statusAllowlist)) {
    data.statusAllowlist = body.statusAllowlist.filter((item): item is string => typeof item === "string");
  }
  if (body.mandatory === true) data.inApp = true;

  const updated = await prisma.notificationEventConfig.update({ where: { eventType }, data });
  await recordNotificationConfigAudit({
    userId: auth.user.id,
    eventType,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: JSON.parse(JSON.stringify({ before: current, after: updated })) as Record<string, unknown>,
  });
  return { item: updated };
}

export async function notifyCriticalPermissionChanges(input: {
  userIds: string[];
  actorName: string;
  changes: Array<{ label: string; from: string; to: string }>;
  roleName?: string;
}) {
  const userIds = [...new Set(input.userIds.filter(Boolean))];
  if (userIds.length === 0 || input.changes.length === 0) return;

  const shown = input.changes.slice(0, 8);
  const summary = shown.map((change) => `${change.label} changed from ${change.from} to ${change.to}`).join("; ");
  const extra = input.changes.length > shown.length ? ` and ${input.changes.length - shown.length} more` : "";
  const body = input.roleName
    ? `${input.actorName} changed the ${input.roleName} role: ${summary}${extra}.`
    : `${input.actorName} changed your permissions: ${summary}${extra}.`;

  await dispatchCrmEvent({
    eventType: "permission_change",
    dedupeKey: `permission-change:${userIds.slice().sort().join(",")}:${summary.slice(0, 80)}`,
    title: "Security / Permission Alert",
    body,
    explicitUserIds: userIds,
    kind: "system",
    link: "/roles",
  }).catch(async (error) => {
    console.error("Failed to send permission notification", error);
    await Promise.all(
      userIds.map((userId) =>
        createNotification({
          userId,
          title: "Security / Permission Alert",
          body,
          type: "permission_change",
          eventType: "permission_change",
          priority: "Critical",
          link: "/roles",
        }).catch(() => undefined),
      ),
    );
  });
}

