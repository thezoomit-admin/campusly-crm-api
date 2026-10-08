import type { Prisma } from "../../lib/prisma-client";
import { writeAuditLog } from "../../lib/audit";
import { prisma } from "../../lib/prisma";
import {
  isEmailConfigured,
  isEmailMockMode,
  sendMailboxEmail,
} from "../email/email.client";
import {
  isMockMode as isWhatsAppMock,
  isWhatsAppConfigured,
  sendWhatsApp,
} from "../whatsapp/whatsapp.client";
import {
  NOTIFICATION_EVENTS,
  eventDefinition,
  type NotificationEventDefinition,
} from "./catalog";
import {
  createNotification,
  type NotificationAction,
} from "./notifications.record";

export type CrmNotificationInput = {
  eventType: string;
  dedupeKey: string;
  title: string;
  body: string;
  link?: string;
  kind?: "system" | "reminder";
  leadId?: string | null;
  followUpId?: string | null;
  ownerId?: string | null;
  previousOwnerId?: string | null;
  explicitUserIds?: string[];
  statusCode?: string | null;
  payload?: Record<string, unknown>;
  actions?: NotificationAction[];
  scheduledAt?: Date | null;
  expiresAt?: Date | null;
  actorUserId?: string | null;
};

const MAX_DELIVERY_ATTEMPTS = 3;

function asStringList(value: Prisma.JsonValue | null | undefined) {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string");
}

export async function ensureNotificationConfigs() {
  for (const event of NOTIFICATION_EVENTS) {
    await prisma.notificationEventConfig.upsert({
      where: { eventType: event.eventType },
      create: {
        eventType: event.eventType,
        label: event.label,
        description: event.description,
        enabled: event.enabled,
        mandatory: event.mandatory,
        priority: event.priority,
        inApp: event.inApp,
        email: event.email,
        whatsapp: event.whatsapp,
        browser: event.browser,
        recipientRule: event.recipientRule,
        notifyPreviousOwner: event.notifyPreviousOwner,
        overdueAfterMinutes: event.overdueAfterMinutes,
        statusAllowlist: event.statusAllowlist ?? undefined,
      },
      update: {},
    });
  }
}

async function loadConfig(
  eventType: string,
): Promise<NotificationEventDefinition | null> {
  const fallback = eventDefinition(eventType);
  const row = await prisma.notificationEventConfig.findUnique({
    where: { eventType },
  });
  if (!row && !fallback) return null;
  return {
    eventType,
    label: row?.label || fallback?.label || eventType,
    description: row?.description || fallback?.description || "",
    enabled: row?.enabled ?? fallback?.enabled ?? true,
    mandatory: row?.mandatory ?? fallback?.mandatory ?? false,
    priority: (row?.priority ||
      fallback?.priority ||
      "Normal") as NotificationEventDefinition["priority"],
    inApp: row?.inApp ?? fallback?.inApp ?? true,
    email: row?.email ?? fallback?.email ?? false,
    whatsapp: row?.whatsapp ?? fallback?.whatsapp ?? false,
    browser: row?.browser ?? fallback?.browser ?? false,
    recipientRule: (row?.recipientRule ||
      fallback?.recipientRule ||
      "owner") as NotificationEventDefinition["recipientRule"],
    notifyPreviousOwner:
      row?.notifyPreviousOwner ?? fallback?.notifyPreviousOwner ?? false,
    overdueAfterMinutes:
      row?.overdueAfterMinutes ?? fallback?.overdueAfterMinutes ?? 0,
    statusAllowlist:
      asStringList(row?.statusAllowlist) ?? fallback?.statusAllowlist ?? null,
  };
}

async function managerIdsForOwner(ownerId: string | null) {
  const owner = ownerId
    ? await prisma.user.findUnique({
        where: { id: ownerId },
        select: { teamId: true },
      })
    : null;
  const rows = await prisma.user.findMany({
    where: {
      status: "ACTIVE",
      primaryRole: {
        key: { in: owner?.teamId ? ["manager", "admin"] : ["manager"] },
      },
      ...(owner?.teamId ? { teamId: owner.teamId } : {}),
    },
    select: { id: true },
  });
  if (rows.length > 0) return rows.map((row) => row.id);
  const fallback = await prisma.user.findMany({
    where: { status: "ACTIVE", primaryRole: { key: "manager" } },
    select: { id: true },
  });
  return fallback.map((row) => row.id);
}

async function resolveRecipients(
  config: NotificationEventDefinition,
  input: CrmNotificationInput,
) {
  const ids = new Set<string>();
  for (const id of input.explicitUserIds || []) {
    if (id) ids.add(id);
  }

  let ownerId = input.ownerId || null;
  if (!ownerId && input.leadId && config.recipientRule !== "admin") {
    const lead = await prisma.lead.findUnique({
      where: { id: input.leadId },
      select: { ownerId: true },
    });
    ownerId = lead?.ownerId || null;
  }

  if (config.recipientRule === "admin" && ids.size === 0) {
    const admins = await prisma.user.findMany({
      where: {
        status: "ACTIVE",
        primaryRole: { key: { in: ["admin", "ceo"] } },
      },
      select: { id: true },
    });
    admins.forEach((row) => ids.add(row.id));
  } else if (config.recipientRule === "owner_manager") {
    if (ownerId) ids.add(ownerId);
    for (const id of await managerIdsForOwner(ownerId)) ids.add(id);
  } else if (ownerId) {
    ids.add(ownerId);
  }

  if (
    config.notifyPreviousOwner &&
    input.previousOwnerId &&
    input.previousOwnerId !== ownerId
  ) {
    ids.add(input.previousOwnerId);
  }

  return [...ids];
}

function channelsFor(
  config: NotificationEventDefinition,
  pref: {
    inApp: boolean;
    email: boolean;
    whatsapp: boolean;
    browser: boolean;
  } | null,
) {
  if (config.mandatory) {
    return {
      inApp: true,
      email: config.email,
      whatsapp: config.whatsapp,
      browser: config.browser,
    };
  }
  return {
    inApp: config.inApp && (pref?.inApp ?? true),
    email: config.email && (pref?.email ?? false),
    whatsapp: config.whatsapp && (pref?.whatsapp ?? false),
    browser: config.browser && (pref?.browser ?? false),
  };
}

async function deliverExternal(input: {
  notificationId: string;
  channel: "email" | "whatsapp";
  to: string;
  title: string;
  body: string;
}) {
  const delivery = await prisma.notificationDelivery.create({
    data: {
      notificationId: input.notificationId,
      channel: input.channel,
      status: "Pending",
      attempts: 0,
    },
  });
  await attemptDelivery(delivery.id, input);
}

async function attemptDelivery(
  deliveryId: string,
  input: {
    channel: "email" | "whatsapp";
    to: string;
    title: string;
    body: string;
  },
) {
  const current = await prisma.notificationDelivery.findUnique({
    where: { id: deliveryId },
  });
  if (
    !current ||
    current.status === "Sent" ||
    current.attempts >= MAX_DELIVERY_ATTEMPTS
  )
    return;

  try {
    if (input.channel === "email") {
      if (!isEmailConfigured() && !isEmailMockMode()) {
        throw new Error("Email is not configured.");
      }
      await sendMailboxEmail({
        to: input.to,
        subject: input.title,
        text: input.body,
        html: `<p>${input.body.replace(/</g, "&lt;")}</p>`,
      });
    } else {
      if (!isWhatsAppConfigured() && !isWhatsAppMock()) {
        throw new Error("WhatsApp is not configured.");
      }
      const digits = input.to.replace(/\D/g, "");
      if (digits.length < 8)
        throw new Error("Notification recipient is not available.");
      await sendWhatsApp(digits, {
        kind: "text",
        text: `${input.title}\n${input.body}`,
      });
    }
    await prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: {
        status: "Sent",
        attempts: { increment: 1 },
        sentAt: new Date(),
        lastError: null,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to send notification.";
    await prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: {
        status: "Failed",
        attempts: { increment: 1 },
        lastError: message.slice(0, 500),
      },
    });
    await prisma.notification.update({
      where: { id: current.notificationId },
      data: { deliveryStatus: "Failed" },
    });
    console.error(`[notifications] ${input.channel} delivery failed:`, message);
  }
}

export async function retryFailedDeliveries(limit = 20) {
  const due = await prisma.notificationDelivery.findMany({
    where: {
      status: { in: ["Pending", "Failed"] },
      attempts: { lt: MAX_DELIVERY_ATTEMPTS },
      channel: { in: ["email", "whatsapp"] },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    include: {
      notification: {
        select: {
          title: true,
          body: true,
          user: { select: { email: true, mobile: true } },
        },
      },
    },
  });

  for (const row of due) {
    const to =
      row.channel === "email"
        ? row.notification.user.email
        : row.notification.user.mobile;
    if (!to) continue;
    await attemptDelivery(row.id, {
      channel: row.channel === "whatsapp" ? "whatsapp" : "email",
      to,
      title: row.notification.title,
      body: row.notification.body || row.notification.title,
    });
  }
}

export async function dispatchCrmEvent(input: CrmNotificationInput) {
  await ensureNotificationConfigs();
  const config = await loadConfig(input.eventType);
  if (!config || !config.enabled) return [];

  if (input.eventType === "lead_status_updated") {
    const allow = config.statusAllowlist || [];
    if (
      allow.length === 0 ||
      !input.statusCode ||
      !allow.includes(input.statusCode)
    )
      return [];
  }

  const recipientIds = await resolveRecipients(config, input);
  if (recipientIds.length === 0) {
    console.error(
      "[notifications] Notification recipient is not available.",
      input.eventType,
      input.dedupeKey,
    );
    return [];
  }

  const users = await prisma.user.findMany({
    where: { id: { in: recipientIds }, status: "ACTIVE" },
    select: { id: true, email: true, mobile: true },
  });
  const created = [];

  for (const user of users) {
    const pref = await prisma.notificationPreference.findUnique({
      where: {
        userId_eventType: { userId: user.id, eventType: input.eventType },
      },
    });
    const channels = channelsFor(config, pref);
    if (
      !channels.inApp &&
      !channels.email &&
      !channels.whatsapp &&
      !channels.browser
    )
      continue;

    if (!channels.inApp && !config.mandatory) {
      // External-only still needs an internal record (requirement 39).
    }

    const row = await createNotification({
      userId: user.id,
      title: input.title,
      body: input.body,
      link: input.link,
      type: input.eventType,
      eventType: input.eventType,
      kind: input.kind || "system",
      priority: config.priority,
      leadId: input.leadId,
      followUpId: input.followUpId,
      dedupeKey: `${input.dedupeKey}:${user.id}`,
      expiresAt: input.expiresAt,
      scheduledAt: input.scheduledAt,
      payload: input.payload as Prisma.InputJsonValue | undefined,
      actions: input.actions,
      browser: channels.browser,
    });
    created.push(row);

    const sentChannels = new Set(
      (row.deliveries || []).map((item) => item.channel),
    );
    if (channels.email && user.email && !sentChannels.has("email")) {
      await deliverExternal({
        notificationId: row.id,
        channel: "email",
        to: user.email,
        title: input.title,
        body: input.body,
      });
    }
    if (channels.whatsapp && user.mobile && !sentChannels.has("whatsapp")) {
      await deliverExternal({
        notificationId: row.id,
        channel: "whatsapp",
        to: user.mobile,
        title: input.title,
        body: input.body,
      });
    }
  }

  return created;
}

export async function overdueDelayMinutes() {
  await ensureNotificationConfigs();
  const row = await prisma.notificationEventConfig.findUnique({
    where: { eventType: "follow_up_overdue" },
    select: { overdueAfterMinutes: true, enabled: true },
  });
  return {
    enabled: row?.enabled ?? true,
    minutes: row?.overdueAfterMinutes ?? 60,
  };
}

export async function recordNotificationConfigAudit(input: {
  userId: string;
  eventType: string;
  metadata: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}) {
  await writeAuditLog({
    userId: input.userId,
    action: "NOTIFICATION_CONFIG_UPDATED",
    entityType: "notification_event_config",
    entityId: input.eventType,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
    metadata: input.metadata as Prisma.InputJsonValue | undefined,
  });
}
