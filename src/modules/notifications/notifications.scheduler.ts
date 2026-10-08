import { prisma } from "../../lib/prisma";
import { dispatchCrmEvent, overdueDelayMinutes, retryFailedDeliveries } from "./notifications.dispatch";

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

/** Fire advance reminders, due notices, and a single overdue notice per follow-up. */
export async function dispatchDueReminders() {
  const now = new Date();
  let sent = 0;

  const reminders = await prisma.followUp.findMany({
    where: {
      reminderStatus: "Pending",
      reminderAt: { lte: now },
      status: { in: ["Pending", "Due Soon"] },
      ownerId: { not: null },
    },
    take: 100,
    include: { lead: { select: { id: true, name: true, code: true, country: true } } },
  });

  for (const followUp of reminders) {
    if (!followUp.ownerId || !followUp.reminderAt) continue;
    const event = reminderEvent(followUp.type);
    const leadName = followUp.lead?.name || followUp.contactName;
    const leadId = followUp.leadId;
    await dispatchCrmEvent({
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
      expiresAt: followUp.dueAt,
      payload: {
        leadName,
        leadCode: followUp.lead?.code || null,
        country: followUp.lead?.country || null,
        followUpType: followUp.type,
        scheduledAt: followUp.dueAt?.toISOString() || null,
        reminder: followUp.reminder,
      },
      actions: [
        leadId ? { key: "open_lead", label: "Open Lead", href: `/leads/${leadId}` } : { key: "open_follow_up", label: "Open Follow-up", href: "/follow-ups" },
        { key: "open_follow_up", label: event.eventType === "meeting_reminder" ? "View Meeting" : "Open Follow-up", href: `/follow-ups?followUpId=${followUp.id}` },
      ],
    });
    await prisma.followUp.update({
      where: { id: followUp.id },
      data: { reminderStatus: "Sent" },
    });
    sent += 1;
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
    const leadName = followUp.lead?.name || followUp.contactName;
    await dispatchCrmEvent({
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
    await prisma.followUp.update({
      where: { id: followUp.id },
      data: { dueNotifiedAt: now },
    });
    sent += 1;
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
      const leadName = followUp.lead?.name || followUp.contactName;
      await dispatchCrmEvent({
        eventType: "follow_up_overdue",
        kind: "system",
        dedupeKey: `followup-overdue:${followUp.id}`,
        title: "Overdue Follow-up",
        body: `Lead: ${leadName} — Follow-up: ${followUp.type} — Due: ${timeLabel(followUp.dueAt)} — Status: Overdue`,
        link: `/follow-ups?followUpId=${followUp.id}&action=complete`,
        leadId: followUp.leadId,
        followUpId: followUp.id,
        ownerId: followUp.ownerId,
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
      await prisma.followUp.update({
        where: { id: followUp.id },
        data: { overdueNotifiedAt: now },
      });
      sent += 1;
    }
  }

  await retryFailedDeliveries();
  return sent;
}
