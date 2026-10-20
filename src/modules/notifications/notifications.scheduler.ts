import { prisma } from "../../lib/prisma";
import { dispatchCrmEvent, overdueDelayMinutes, retryFailedDeliveries } from "./notifications.dispatch";
import { pushNotificationCreated } from "./notifications.record";

/** Keep reminder notifications visible after the due instant (late ticks / "At the time"). */
const REMINDER_VISIBILITY_MS = 24 * 60 * 60 * 1000;

function whenLabel(date: Date | null) {
  if (!date) return "—";
  return date.toLocaleString("en-US", {
    timeZone: "Asia/Dhaka",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function timeLabel(date: Date | null) {
  if (!date) return "—";
  return date.toLocaleString("en-US", {
    timeZone: "Asia/Dhaka",
    hour: "numeric",
    minute: "2-digit",
  });
}

function reminderEvent(type: string) {
  if (type === "Counselling") {
    return { eventType: "counselling_reminder", title: "Counselling Reminder" };
  }
  if (type === "Meeting") {
    return { eventType: "meeting_reminder", title: "Meeting Reminder" };
  }
  return { eventType: "follow_up_reminder", title: "Follow-up Reminder" };
}

function reminderExpiresAt(dueAt: Date | null, now: Date) {
  const base = dueAt && dueAt.getTime() > now.getTime() ? dueAt.getTime() : now.getTime();
  return new Date(base + REMINDER_VISIBILITY_MS);
}

const REMINDER_EVENT_TYPES = [
  "meeting_reminder",
  "counselling_reminder",
  "follow_up_reminder",
] as const;

/** Re-open reminders that were marked Sent without an actual notification row. */
async function healOrphanReminderStatus() {
  const candidates = await prisma.followUp.findMany({
    where: {
      reminderStatus: "Sent",
      reminderAt: { not: null },
      status: { in: ["Pending", "Due Soon", "Overdue"] },
      ownerId: { not: null },
    },
    take: 50,
    select: { id: true },
  });

  for (const row of candidates) {
    const count = await prisma.notification.count({
      where: {
        followUpId: row.id,
        OR: [
          { eventType: { in: [...REMINDER_EVENT_TYPES] } },
          { type: { in: [...REMINDER_EVENT_TYPES] } },
        ],
      },
    });
    if (count === 0) {
      await prisma.followUp.update({
        where: { id: row.id },
        data: { reminderStatus: "Pending" },
      });
      console.warn(
        "[follow-ups] Reset orphan Sent reminder (no notification found):",
        row.id,
      );
    }
  }
}

/**
 * Older rows used expiresAt = dueAt, so the bell hid them at meeting time.
 * Extend visibility and re-push unread reminders to connected owners.
 */
async function healShortLivedReminderNotifications(now: Date) {
  const shortLived = await prisma.notification.findMany({
    where: {
      status: "Unread",
      kind: "reminder",
      expiresAt: { not: null, lte: new Date(now.getTime() + 2 * 60 * 60 * 1000) },
    },
    take: 50,
    include: {
      deliveries: true,
      lead: { select: { id: true, code: true, name: true } },
      user: { select: { id: true, fullName: true } },
    },
  });

  for (const row of shortLived) {
    const nextExpiry = new Date(now.getTime() + REMINDER_VISIBILITY_MS);
    if (row.expiresAt && row.expiresAt.getTime() >= nextExpiry.getTime()) continue;
    const updated = await prisma.notification.update({
      where: { id: row.id },
      data: { expiresAt: nextExpiry },
      include: {
        deliveries: true,
        lead: { select: { id: true, code: true, name: true } },
        user: { select: { id: true, fullName: true } },
      },
    });
    pushNotificationCreated(updated.userId, updated);
  }
}

/** Fire advance reminders, due notices, and a single overdue notice per follow-up. */
export async function dispatchDueReminders() {
  const now = new Date();
  let sent = 0;

  await healOrphanReminderStatus();
  await healShortLivedReminderNotifications(now);

  // Include Overdue: overdue sync may run first, or the API may have been down
  // through the reminder window — still deliver Pending reminders.
  const reminders = await prisma.followUp.findMany({
    where: {
      reminderStatus: "Pending",
      reminderAt: { lte: now },
      status: { in: ["Pending", "Due Soon", "Overdue"] },
      ownerId: { not: null },
    },
    take: 100,
    include: { lead: { select: { id: true, name: true, code: true, country: true } } },
  });

  for (const followUp of reminders) {
    if (!followUp.ownerId || !followUp.reminderAt) continue;
    try {
      const event = reminderEvent(followUp.type);
      const leadName = followUp.lead?.name || followUp.contactName;
      const leadId = followUp.leadId;
      const created = await dispatchCrmEvent({
        eventType: event.eventType,
        kind: "reminder",
        dedupeKey: `${event.eventType}:${followUp.id}:${followUp.reminderAt.toISOString()}`,
        title: event.title,
        body:
          event.eventType === "follow_up_reminder"
            ? `Lead: ${leadName} — Follow-up Type: ${followUp.type} — Scheduled: ${timeLabel(followUp.dueAt)}`
            : `Lead: ${leadName} — Date: ${whenLabel(followUp.dueAt)} — Time: ${timeLabel(followUp.dueAt)}`,
        link: leadId ? `/leads/${leadId}` : "/follow-ups",
        leadId,
        followUpId: followUp.id,
        ownerId: followUp.ownerId,
        scheduledAt: followUp.reminderAt,
        expiresAt: reminderExpiresAt(followUp.dueAt, now),
        payload: {
          leadName,
          leadCode: followUp.lead?.code || null,
          country: followUp.lead?.country || null,
          followUpType: followUp.type,
          scheduledAt: followUp.dueAt?.toISOString() || null,
          reminder: followUp.reminder,
        },
        actions: [
          leadId
            ? { key: "open_lead", label: "Open Lead", href: `/leads/${leadId}` }
            : { key: "open_follow_up", label: "Open Follow-up", href: "/follow-ups" },
          {
            key: "open_follow_up",
            label: event.eventType === "meeting_reminder" ? "View Meeting" : "Open Follow-up",
            href: `/follow-ups?followUpId=${followUp.id}`,
          },
        ],
      });

      if (!created.length) {
        console.error(
          "[follow-ups] Reminder dispatch produced no notifications; will retry.",
          followUp.id,
          event.eventType,
          followUp.ownerId,
        );
        continue;
      }

      await prisma.followUp.update({
        where: { id: followUp.id },
        data: { reminderStatus: "Sent" },
      });
      sent += 1;
    } catch (error) {
      console.error("[follow-ups] Reminder dispatch failed; will retry.", followUp.id, error);
    }
  }

  const dueRows = await prisma.followUp.findMany({
    where: {
      dueNotifiedAt: null,
      dueAt: { lte: now },
      status: { in: ["Pending", "Due Soon", "Overdue"] },
      ownerId: { not: null },
    },
    take: 100,
    include: { lead: { select: { id: true, name: true, code: true } } },
  });

  for (const followUp of dueRows) {
    if (!followUp.ownerId || !followUp.dueAt) continue;
    try {
      const leadName = followUp.lead?.name || followUp.contactName;
      const created = await dispatchCrmEvent({
        eventType: "follow_up_due",
        kind: "system",
        dedupeKey: `followup-due:${followUp.id}`,
        title: "Follow-up Due",
        body: `Lead: ${leadName} — Follow-up Type: ${followUp.type} — Scheduled: ${timeLabel(followUp.dueAt)}`,
        link: `/follow-ups?followUpId=${followUp.id}&action=complete`,
        leadId: followUp.leadId,
        followUpId: followUp.id,
        ownerId: followUp.ownerId,
        scheduledAt: followUp.dueAt,
        expiresAt: reminderExpiresAt(followUp.dueAt, now),
        payload: {
          leadName,
          leadCode: followUp.lead?.code || null,
          followUpType: followUp.type,
          scheduledAt: followUp.dueAt.toISOString(),
        },
        actions: [
          { key: "complete", label: "Complete", href: `/follow-ups?followUpId=${followUp.id}&action=complete` },
          { key: "reschedule", label: "Reschedule", href: `/follow-ups?followUpId=${followUp.id}&action=reschedule` },
          ...(followUp.leadId ? [{ key: "open_lead", label: "Open Lead", href: `/leads/${followUp.leadId}` }] : []),
        ],
      });

      if (!created.length) {
        console.error(
          "[follow-ups] Due notice produced no notifications; will retry.",
          followUp.id,
        );
        continue;
      }

      await prisma.followUp.update({
        where: { id: followUp.id },
        data: { dueNotifiedAt: now },
      });
      sent += 1;
    } catch (error) {
      console.error("[follow-ups] Due notice failed; will retry.", followUp.id, error);
    }
  }

  const policy = await overdueDelayMinutes();
  if (policy.enabled) {
    const cutoff = new Date(now.getTime() - policy.minutes * 60 * 1000);
    const overdueRows = await prisma.followUp.findMany({
      where: {
        overdueNotifiedAt: null,
        status: "Overdue",
        dueAt: { lte: cutoff },
        ownerId: { not: null },
      },
      take: 100,
      include: { lead: { select: { id: true, name: true, code: true } } },
    });

    for (const followUp of overdueRows) {
      if (!followUp.ownerId || !followUp.dueAt) continue;
      try {
        const leadName = followUp.lead?.name || followUp.contactName;
        const created = await dispatchCrmEvent({
          eventType: "follow_up_overdue",
          kind: "system",
          dedupeKey: `followup-overdue:${followUp.id}`,
          title: "Overdue Follow-up",
          body: `Lead: ${leadName} — Follow-up: ${followUp.type} — Due: ${timeLabel(followUp.dueAt)} — Status: Overdue`,
          link: `/follow-ups?followUpId=${followUp.id}&action=complete`,
          leadId: followUp.leadId,
          followUpId: followUp.id,
          ownerId: followUp.ownerId,
          expiresAt: reminderExpiresAt(followUp.dueAt, now),
          payload: {
            leadName,
            leadCode: followUp.lead?.code || null,
            followUpType: followUp.type,
            dueAt: followUp.dueAt.toISOString(),
            status: "Overdue",
          },
          actions: [
            { key: "complete", label: "Complete", href: `/follow-ups?followUpId=${followUp.id}&action=complete` },
            { key: "reschedule", label: "Reschedule", href: `/follow-ups?followUpId=${followUp.id}&action=reschedule` },
          ],
        });

        if (!created.length) {
          console.error(
            "[follow-ups] Overdue notice produced no notifications; will retry.",
            followUp.id,
          );
          continue;
        }

        await prisma.followUp.update({
          where: { id: followUp.id },
          data: { overdueNotifiedAt: now },
        });
        sent += 1;
      } catch (error) {
        console.error("[follow-ups] Overdue notice failed; will retry.", followUp.id, error);
      }
    }
  }

  await retryFailedDeliveries();
  return sent;
}
