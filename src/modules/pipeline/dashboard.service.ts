import { prisma } from "../../lib/prisma";
import { syncOverdueFollowUps } from "../../jobs/overdue-follow-ups";
import { ratePercent } from "../follow-ups/follow-ups.utils";

const SOURCE_COLORS = [
  "#38bdf8",
  "#34d399",
  "#818cf8",
  "#fb7185",
  "#f43f5e",
  "#fbbf24",
  "#22d3ee",
  "#a78bfa",
];
const CLOSED_APPLICATION_STATUSES = [
  "Draft",
  "Lost",
  "Rejected",
  "Cancelled",
  "Withdrawn",
];
const OPEN_FOLLOW_UP_STATUSES = ["Pending", "Due Soon", "Overdue"];
const PAID_STATUSES = ["COMPLETED"] as const;

const COUNTRY_FLAGS: Record<string, string> = {
  canada: "🇨🇦",
  uk: "🇬🇧",
  "united kingdom": "🇬🇧",
  australia: "🇦🇺",
  usa: "🇺🇸",
  "united states": "🇺🇸",
  germany: "🇩🇪",
  malaysia: "🇲🇾",
};

function startOfUtcDay(date = new Date()) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function addUtcDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function percentChange(current: number, previous: number) {
  if (previous === 0) {
    return current > 0 ? 100 : 0;
  }
  return Math.round(((current - previous) / previous) * 100);
}

function parseMoney(value: string) {
  const amount = Number(String(value).replace(/[^\d.]/g, ""));
  return Number.isFinite(amount) ? amount : 0;
}

function formatMoney(amount: number) {
  return `৳ ${Math.round(amount).toLocaleString("en-IN")}`;
}

function daysAgoLabel(date: Date | null | undefined) {
  if (!date) return "—";
  const diffMs = Date.now() - date.getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days <= 0) {
    const hours = Math.max(1, Math.floor(diffMs / (1000 * 60 * 60)));
    return `${hours}h ago`;
  }
  if (days === 1) return "Yesterday";
  return `${days} days ago`;
}

function formatDue(date: Date | null | undefined) {
  if (!date) return "No due date";
  const day = date.toISOString().slice(0, 10);
  const time = date.toISOString().slice(11, 16);
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = addUtcDays(startOfUtcDay(), 1).toISOString().slice(0, 10);
  if (day === today) return `Today, ${time}`;
  if (day === tomorrow) return `Tomorrow, ${time}`;
  return `${day} ${time}`;
}

function countryFlag(country: string | null | undefined) {
  if (!country) return "";
  return COUNTRY_FLAGS[country.trim().toLowerCase()] || "";
}

function followUpVisual(type: string, status: string, priority: string | null) {
  const key = type.toLowerCase();
  let icon: "phone" | "mail" | "users" | "clock" | "file" | "card" = "clock";
  if (key.includes("call") || key.includes("whatsapp")) icon = "phone";
  else if (key.includes("email") || key.includes("mail")) icon = "mail";
  else if (key.includes("counsel")) icon = "users";
  else if (key.includes("document")) icon = "file";
  else if (key.includes("payment")) icon = "card";

  let tone: "rose" | "blue" | "purple" | "orange" | "green" = "blue";
  if (status === "Overdue" || priority === "High") tone = "rose";
  else if (key.includes("counsel")) tone = "purple";
  else if (priority === "Medium" || status === "Due Soon") tone = "orange";
  else if (priority === "Low" || status === "Done" || status === "Completed")
    tone = "green";

  return { icon, tone };
}

function utcDayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

export async function getDashboardOverview(year: number, month: number) {
  await syncOverdueFollowUps();
  const now = new Date();
  const last30 = addUtcDays(startOfUtcDay(now), -30);
  const prev30 = addUtcDays(last30, -30);
  const last7 = addUtcDays(startOfUtcDay(now), -6);
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 1));

  const [
    leadTotal,
    leadsLast30,
    leadsPrev30,
    activeApplications,
    applicationsLast30,
    applicationsPrev30,
    studentTotal,
    studentsLast30,
    studentsPrev30,
    pendingFollowUps,
    overdueFollowUps,
    dueTodayFollowUps,
    completedTodayFollowUps,
    dueInRange,
    completedInRange,
    onTimeCandidates,
    followUpsLast30,
    followUpsPrev30,
    paidPayments,
    paymentsLast30,
    paymentsPrev30,
    sourceRows,
    trendRows,
    recentLeadRows,
    upcomingFollowUpRows,
    monthFollowUps,
    monthApplications,
    monthPayments,
    monthMeetings,
  ] = await Promise.all([
    prisma.lead.count(),
    prisma.lead.count({ where: { createdAt: { gte: last30 } } }),
    prisma.lead.count({ where: { createdAt: { gte: prev30, lt: last30 } } }),
    prisma.application.count({
      where: { status: { notIn: CLOSED_APPLICATION_STATUSES } },
    }),
    prisma.application.count({
      where: {
        createdAt: { gte: last30 },
        status: { notIn: CLOSED_APPLICATION_STATUSES },
      },
    }),
    prisma.application.count({
      where: {
        createdAt: { gte: prev30, lt: last30 },
        status: { notIn: CLOSED_APPLICATION_STATUSES },
      },
    }),
    prisma.student.count(),
    prisma.student.count({ where: { createdAt: { gte: last30 } } }),
    prisma.student.count({ where: { createdAt: { gte: prev30, lt: last30 } } }),
    prisma.followUp.count({
      where: { status: { in: OPEN_FOLLOW_UP_STATUSES } },
    }),
    prisma.followUp.count({
      where: {
        OR: [
          { status: "Overdue" },
          {
            AND: [
              { status: { in: ["Pending", "Due Soon"] } },
              { dueAt: { lt: startOfUtcDay(now) } },
            ],
          },
        ],
      },
    }),
    prisma.followUp.count({
      where: {
        status: { in: OPEN_FOLLOW_UP_STATUSES },
        dueAt: {
          gte: startOfUtcDay(now),
          lt: addUtcDays(startOfUtcDay(now), 1),
        },
      },
    }),
    prisma.followUp.count({
      where: {
        status: { in: ["Completed", "Done"] },
        completedAt: {
          gte: startOfUtcDay(now),
          lt: addUtcDays(startOfUtcDay(now), 1),
        },
      },
    }),
    prisma.followUp.count({
      where: {
        dueAt: { gte: last30, lt: addUtcDays(startOfUtcDay(now), 1) },
        status: { notIn: ["Cancelled", "Rescheduled"] },
      },
    }),
    prisma.followUp.count({
      where: {
        dueAt: { gte: last30, lt: addUtcDays(startOfUtcDay(now), 1) },
        status: { in: ["Completed", "Done"] },
      },
    }),
    prisma.followUp.findMany({
      where: {
        dueAt: { gte: last30, lt: addUtcDays(startOfUtcDay(now), 1) },
        status: { in: ["Completed", "Done"] },
        completedAt: { not: null },
      },
      select: { dueAt: true, completedAt: true },
    }),
    prisma.followUp.count({
      where: {
        createdAt: { gte: last30 },
        status: { in: OPEN_FOLLOW_UP_STATUSES },
      },
    }),
    prisma.followUp.count({
      where: {
        createdAt: { gte: prev30, lt: last30 },
        status: { in: OPEN_FOLLOW_UP_STATUSES },
      },
    }),
    prisma.payment.findMany({
      where: { status: { in: [...PAID_STATUSES] } },
      select: { amount: true },
    }),
    prisma.payment.findMany({
      where: { status: { in: [...PAID_STATUSES] }, paymentDate: { gte: last30 } },
      select: { amount: true },
    }),
    prisma.payment.findMany({
      where: {
        status: { in: [...PAID_STATUSES] },
        paymentDate: { gte: prev30, lt: last30 },
      },
      select: { amount: true },
    }),
    prisma.lead.groupBy({
      by: ["source"],
      where: { createdAt: { gte: last30 } },
      _count: { _all: true },
      orderBy: { _count: { source: "desc" } },
    }),
    prisma.lead.findMany({
      where: { createdAt: { gte: last7 } },
      select: { createdAt: true },
    }),
    prisma.lead.findMany({
      orderBy: { createdAt: "desc" },
      take: 6,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        country: true,
        source: true,
        status: true,
        createdAt: true,
      },
    }),
    prisma.followUp.findMany({
      where: { status: { in: OPEN_FOLLOW_UP_STATUSES } },
      orderBy: { dueAt: "asc" },
      take: 6,
    }),
    prisma.followUp.findMany({
      where: { dueAt: { gte: monthStart, lt: monthEnd } },
      select: { dueAt: true },
    }),
    prisma.application.findMany({
      where: { submittedAt: { gte: monthStart, lt: monthEnd } },
      select: { submittedAt: true },
    }),
    prisma.payment.findMany({
      where: { paymentDate: { gte: monthStart, lt: monthEnd } },
      select: { paymentDate: true },
    }),
    prisma.activity.findMany({
      where: { type: "MEETING", occurredAt: { gte: monthStart, lt: monthEnd } },
      select: { occurredAt: true },
    }),
  ]);

  const revenueTotal = paidPayments.reduce(
    (sum, row) => sum + Number(row.amount),
    0,
  );
  const revenueLast30 = paymentsLast30.reduce(
    (sum, row) => sum + Number(row.amount),
    0,
  );
  const revenuePrev30 = paymentsPrev30.reduce(
    (sum, row) => sum + Number(row.amount),
    0,
  );
  const onTimeInRange = onTimeCandidates.filter(
    (row) =>
      row.completedAt &&
      row.dueAt &&
      row.completedAt.getTime() <= row.dueAt.getTime(),
  ).length;
  const completionRate = ratePercent(completedInRange, dueInRange);
  const onTimeRate = ratePercent(onTimeInRange, dueInRange);

  const sourceTotal = sourceRows.reduce((sum, row) => sum + row._count._all, 0);
  const leadSources = sourceRows.map((row, index) => {
    const value = row._count._all;
    return {
      label: row.source?.trim() || "Others",
      value,
      percent: sourceTotal ? Math.round((value / sourceTotal) * 100) : 0,
      color: SOURCE_COLORS[index % SOURCE_COLORS.length],
    };
  });

  const trendCounts = new Map<string, number>();
  for (const row of trendRows) {
    const key = utcDayKey(row.createdAt);
    trendCounts.set(key, (trendCounts.get(key) || 0) + 1);
  }

  const leadTrend = Array.from({ length: 7 }, (_, index) => {
    const date = addUtcDays(last7, index);
    return {
      label: date.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }),
      value: trendCounts.get(utcDayKey(date)) || 0,
    };
  });

  const calendar: Record<string, string[]> = {};
  function mark(date: Date | null | undefined, kind: string) {
    if (!date) return;
    const day = String(date.getUTCDate());
    const current = calendar[day] || [];
    if (!current.includes(kind)) current.push(kind);
    calendar[day] = current;
  }
  for (const row of monthFollowUps) mark(row.dueAt, "followup");
  for (const row of monthMeetings) mark(row.occurredAt, "meeting");
  for (const row of monthApplications) mark(row.submittedAt, "application");
  for (const row of monthPayments) mark(row.paymentDate, "payment");

  return {
    stats: [
      {
        key: "leads",
        label: "Total Leads",
        value: String(leadTotal),
        change: percentChange(leadsLast30, leadsPrev30),
        tone: "blue" as const,
        icon: "users" as const,
      },
      {
        key: "applications",
        label: "Active Applications",
        value: String(activeApplications),
        change: percentChange(applicationsLast30, applicationsPrev30),
        tone: "green" as const,
        icon: "calendar" as const,
      },
      {
        key: "students",
        label: "Converted Students",
        value: String(studentTotal),
        change: percentChange(studentsLast30, studentsPrev30),
        tone: "purple" as const,
        icon: "graduate" as const,
      },
      {
        key: "revenue",
        label: "Total Revenue",
        value: formatMoney(revenueTotal),
        change: percentChange(revenueLast30, revenuePrev30),
        tone: "orange" as const,
        icon: "revenue" as const,
      },
      {
        key: "followups",
        label: "Pending Follow-ups",
        value: String(pendingFollowUps),
        change: percentChange(followUpsLast30, followUpsPrev30),
        tone: "rose" as const,
        icon: "phone" as const,
      },
    ],
    followUpMetrics: {
      overdue: overdueFollowUps,
      dueToday: dueTodayFollowUps,
      completedToday: completedTodayFollowUps,
      pending: pendingFollowUps,
      completionRate,
      onTimeRate,
      dueInRange,
      completedInRange,
      onTimeInRange,
    },
    leadSources,
    leadTrend,
    recentLeads: recentLeadRows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email || row.phone || "—",
      country: row.country || "—",
      flag: countryFlag(row.country),
      source: row.source || "—",
      status: row.status,
      created: daysAgoLabel(row.createdAt),
    })),
    upcomingFollowUps: upcomingFollowUpRows.map((row) => {
      const visual = followUpVisual(row.type, row.status, row.priority);
      return {
        id: row.id,
        title: `${row.type} with ${row.contactName}`,
        detail: [formatDue(row.dueAt), row.ownerName, row.priority]
          .filter(Boolean)
          .join("  •  "),
        tone: visual.tone,
        icon: visual.icon,
      };
    }),
    calendarEvents: calendar,
  };
}

export async function getReportMetrics() {
  const now = new Date();
  const last30 = addUtcDays(startOfUtcDay(now), -30);
  const prev30 = addUtcDays(last30, -30);

  const [
    leads,
    leadsLast30,
    leadsPrev30,
    applications,
    applicationsLast30,
    applicationsPrev30,
    followUps,
    followUpsLast30,
    followUpsPrev30,
    payments,
    paymentsLast30,
    paymentsPrev30,
  ] = await Promise.all([
    prisma.lead.count(),
    prisma.lead.count({ where: { createdAt: { gte: last30 } } }),
    prisma.lead.count({ where: { createdAt: { gte: prev30, lt: last30 } } }),
    prisma.application.count(),
    prisma.application.count({ where: { createdAt: { gte: last30 } } }),
    prisma.application.count({
      where: { createdAt: { gte: prev30, lt: last30 } },
    }),
    prisma.followUp.count({
      where: { status: { in: OPEN_FOLLOW_UP_STATUSES } },
    }),
    prisma.followUp.count({ where: { createdAt: { gte: last30 } } }),
    prisma.followUp.count({
      where: { createdAt: { gte: prev30, lt: last30 } },
    }),
    prisma.payment.count({ where: { status: "COMPLETED" } }),
    prisma.payment.count({
      where: { status: "COMPLETED", paymentDate: { gte: last30 } },
    }),
    prisma.payment.count({
      where: { status: "COMPLETED", paymentDate: { gte: prev30, lt: last30 } },
    }),
  ]);

  const formatChange = (current: number, previous: number) => {
    const change = percentChange(current, previous);
    return `${change >= 0 ? "+" : ""}${change}%`;
  };

  return [
    {
      id: "metric-leads",
      metric: "Total leads",
      period: "All time",
      value: String(leads),
      change: formatChange(leadsLast30, leadsPrev30),
      owner: "Counselling",
      status: "Active",
    },
    {
      id: "metric-apps",
      metric: "Applications submitted",
      period: "All time",
      value: String(applications),
      change: formatChange(applicationsLast30, applicationsPrev30),
      owner: "Operations",
      status: "Active",
    },
    {
      id: "metric-followups",
      metric: "Open follow-ups",
      period: "Current",
      value: String(followUps),
      change: formatChange(followUpsLast30, followUpsPrev30),
      owner: "Call Center",
      status: followUps > 0 ? "Due Soon" : "Active",
    },
    {
      id: "metric-payments",
      metric: "Paid invoices",
      period: "All time",
      value: String(payments),
      change: formatChange(paymentsLast30, paymentsPrev30),
      owner: "Sales",
      status: "Active",
    },
  ];
}
