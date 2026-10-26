import { writeAuditLog } from "../../lib/audit";
import { HttpError, httpError } from "../../lib/http-error";
import { prisma } from "../../lib/prisma";
import type { Prisma } from "../../lib/prisma-client";
import { config } from "../../config";
import { hasPermission } from "../auth/access";
import type { AuthContext } from "../auth/session.service";
import {
  isEmailConfigured,
  isEmailMockMode,
  isImapInboundConfigured,
  mailboxAddress,
} from "../email/email.client";
import {
  isMockMode as isWhatsAppMockMode,
  isWhatsAppConfigured,
} from "../whatsapp/whatsapp.client";
import {
  CURRENCIES,
  DATE_FORMATS,
  DEFAULT_WORKSPACE,
  TIMEZONES,
  WORKSPACE_ID,
  type WorkspaceSettings,
} from "./settings.constants";

const CACHE_MS = 15_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const NOT_READY =
  "Settings storage is not ready yet. In the campusly-crm-api folder run npm run generate, then npm run push.";

type WorkspaceRow = {
  name: string;
  supportEmail: string;
  timezone: string;
  currency: string;
  dateFormat: string;
  defaultFollowUpDays: number;
  leadCodePrefix: string;
  duplicateCheckEnabled: boolean;
  updatedAt: Date;
};

type PreferenceRow = {
  compactTables: boolean;
  updatedAt: Date;
};

type SettingsClient = {
  workspaceSetting: {
    findUnique: (args: { where: { id: string } }) => Promise<WorkspaceRow | null>;
    create: (args: { data: { id: string } }) => Promise<WorkspaceRow>;
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<WorkspaceRow>;
  };
  userPreference: {
    findUnique: (args: { where: { userId: string } }) => Promise<PreferenceRow | null>;
    upsert: (args: {
      where: { userId: string };
      create: { userId: string; compactTables: boolean };
      update: { compactTables: boolean };
    }) => Promise<PreferenceRow>;
  };
};

function settingsDb() {
  const client = prisma as unknown as Partial<SettingsClient>;
  if (!client.workspaceSetting || !client.userPreference) {
    throw new HttpError(503, NOT_READY, "SETTINGS_NOT_READY");
  }
  return client as SettingsClient;
}

function isMissingStorage(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = String((error as { code: unknown }).code);
  return code === "P2021" || code === "P2022";
}

function isUniqueConstraint(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code: unknown }).code === "P2002");
}

let cache: { value: WorkspaceSettings; at: number } | null = null;
let storageWarningLogged = false;

function clearCache() {
  cache = null;
}

function asText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function assertFresh(current: Date, updatedAt: unknown) {
  const raw = asText(updatedAt);
  const next = new Date(raw);
  if (!raw || Number.isNaN(next.getTime())) {
    throw httpError.validation(
      { updatedAt: "Reload settings before saving." },
      "Reload settings before saving.",
    );
  }
  if (Math.abs(current.getTime() - next.getTime()) > 1500) {
    throw httpError.conflict(
      "These settings were updated by someone else. Reload and try again.",
      "SETTINGS_CONFLICT",
    );
  }
}

function serialize(row: {
  name: string;
  supportEmail: string;
  timezone: string;
  currency: string;
  dateFormat: string;
  defaultFollowUpDays: number;
  leadCodePrefix: string;
  duplicateCheckEnabled: boolean;
  updatedAt: Date;
}): WorkspaceSettings {
  return {
    name: row.name,
    supportEmail: row.supportEmail,
    timezone: row.timezone,
    currency: row.currency,
    dateFormat: row.dateFormat,
    defaultFollowUpDays: row.defaultFollowUpDays,
    leadCodePrefix: row.leadCodePrefix,
    duplicateCheckEnabled: row.duplicateCheckEnabled,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadRow() {
  try {
    const db = settingsDb().workspaceSetting;
    const existing = await db.findUnique({ where: { id: WORKSPACE_ID } });
    if (existing) return existing;
    try {
      return await db.create({ data: { id: WORKSPACE_ID } });
    } catch (error) {
      // Another request inserted the singleton row between the read and the insert.
      if (!isUniqueConstraint(error)) throw error;
      const row = await db.findUnique({ where: { id: WORKSPACE_ID } });
      if (row) return row;
      throw error;
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (isMissingStorage(error)) throw new HttpError(503, NOT_READY, "SETTINGS_NOT_READY");
    throw error;
  }
}

export async function getWorkspaceSettings(): Promise<WorkspaceSettings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = serialize(await loadRow());
  cache = { value, at: Date.now() };
  return value;
}

export async function readWorkspaceSettings(): Promise<WorkspaceSettings> {
  try {
    return await getWorkspaceSettings();
  } catch (error) {
    if (!storageWarningLogged) {
      storageWarningLogged = true;
      console.error("[settings] workspace settings unavailable, using defaults", error);
    }
    return { ...DEFAULT_WORKSPACE, updatedAt: new Date(0).toISOString() };
  }
}

function diff(
  before: Record<string, Prisma.InputJsonValue>,
  after: Record<string, Prisma.InputJsonValue>,
) {
  const changes: Record<string, { from: Prisma.InputJsonValue; to: Prisma.InputJsonValue }> = {};
  for (const key of Object.keys(after)) {
    if (before[key] !== after[key]) {
      changes[key] = { from: before[key], to: after[key] };
    }
  }
  return changes;
}

function integrationState(configured: boolean, mock: boolean): "live" | "mock" | "off" {
  if (configured) return "live";
  if (mock) return "mock";
  return "off";
}

export async function getSettingsPage(auth: AuthContext) {
  const settings = await getWorkspaceSettings();
  const emailState = integrationState(isEmailConfigured(), isEmailMockMode());
  const whatsappState = integrationState(isWhatsAppConfigured(), isWhatsAppMockMode());
  const metaLive = Boolean(config.meta.pageAccessToken);

  return {
    canConfigure: hasPermission(auth.permissions, "settings:configure"),
    workspace: {
      name: settings.name,
      supportEmail: settings.supportEmail,
      timezone: settings.timezone,
      currency: settings.currency,
      dateFormat: settings.dateFormat,
      updatedAt: settings.updatedAt,
    },
    leads: {
      defaultFollowUpDays: settings.defaultFollowUpDays,
      leadCodePrefix: settings.leadCodePrefix,
      duplicateCheckEnabled: settings.duplicateCheckEnabled,
      updatedAt: settings.updatedAt,
    },
    options: {
      timezones: TIMEZONES,
      currencies: CURRENCIES,
      dateFormats: DATE_FORMATS,
    },
    integrations: {
      email: {
        state: emailState,
        fromAddress: mailboxAddress(),
        imap: isImapInboundConfigured(),
        detail:
          emailState === "live"
            ? "Outbound SMTP is connected. The sending mailbox stays in the server environment."
            : emailState === "mock"
              ? "SMTP is not configured. Outbound mail is logged locally and not delivered."
              : "SMTP is not configured.",
      },
      whatsapp: {
        state: whatsappState,
        defaultTemplate: config.whatsapp.defaultTemplate,
        detail:
          whatsappState === "live"
            ? "WhatsApp Cloud API credentials are present."
            : whatsappState === "mock"
              ? "No access token. The inbox can still be exercised in mock mode."
              : "WhatsApp is not configured.",
      },
      meta: {
        state: metaLive ? "live" : "mock",
        webhookPath: "/api/webhooks/meta",
        detail: metaLive
          ? "A page access token is configured, so Lead Ads can be fetched from Meta."
          : "No page access token. The webhook can still accept a normalized test payload.",
      },
    },
  };
}

export async function getWorkspaceBrand() {
  const settings = await readWorkspaceSettings();
  return {
    name: settings.name,
    supportEmail: settings.supportEmail,
    timezone: settings.timezone,
    currency: settings.currency,
    dateFormat: settings.dateFormat,
  };
}

export async function updateWorkspaceSettings(
  auth: AuthContext,
  body: Record<string, unknown>,
  meta: { ipAddress?: string; userAgent?: string },
) {
  const current = await loadRow();
  assertFresh(current.updatedAt, body.updatedAt);

  const fields: Record<string, string> = {};
  const name = asText(body.name);
  const supportEmail = asText(body.supportEmail).toLowerCase();
  const timezone = asText(body.timezone);
  const currency = asText(body.currency).toUpperCase();
  const dateFormat = asText(body.dateFormat);

  if (name.length < 2 || name.length > 80) fields.name = "Enter a workspace name between 2 and 80 characters.";
  if (!isEmail(supportEmail) || supportEmail.length > 120) fields.supportEmail = "Enter a valid support email.";
  if (!TIMEZONES.includes(timezone as (typeof TIMEZONES)[number])) fields.timezone = "Choose a supported timezone.";
  if (!CURRENCIES.includes(currency as (typeof CURRENCIES)[number])) fields.currency = "Choose a supported currency.";
  if (!DATE_FORMATS.includes(dateFormat as (typeof DATE_FORMATS)[number])) fields.dateFormat = "Choose a supported date format.";
  if (Object.keys(fields).length) throw httpError.validation(fields);

  const next = { name, supportEmail, timezone, currency, dateFormat };
  const changes = diff(
    {
      name: current.name,
      supportEmail: current.supportEmail,
      timezone: current.timezone,
      currency: current.currency,
      dateFormat: current.dateFormat,
    },
    next,
  );

  if (!Object.keys(changes).length) {
    return getSettingsPage(auth);
  }

  await settingsDb().workspaceSetting.update({
    where: { id: WORKSPACE_ID },
    data: { ...next, updatedById: auth.user.id },
  });
  clearCache();
  await writeAuditLog({
    userId: auth.user.id,
    action: "SETTINGS_WORKSPACE_UPDATED",
    entityType: "settings",
    entityId: WORKSPACE_ID,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { changes } as Prisma.InputJsonValue,
  });
  return getSettingsPage(auth);
}

export async function updateLeadSettings(
  auth: AuthContext,
  body: Record<string, unknown>,
  meta: { ipAddress?: string; userAgent?: string },
) {
  const current = await loadRow();
  assertFresh(current.updatedAt, body.updatedAt);

  const fields: Record<string, string> = {};
  const days = Number(body.defaultFollowUpDays);
  const leadCodePrefix = asText(body.leadCodePrefix).toUpperCase();
  const duplicateCheckEnabled = body.duplicateCheckEnabled === true;

  if (!Number.isInteger(days) || days < 1 || days > 30) {
    fields.defaultFollowUpDays = "Enter a whole number of days from 1 to 30.";
  }
  if (!/^[A-Z][A-Z0-9]{0,5}$/.test(leadCodePrefix)) {
    fields.leadCodePrefix = "Use 1–6 letters or numbers, starting with a letter.";
  }
  if (Object.keys(fields).length) throw httpError.validation(fields);

  const next = { defaultFollowUpDays: days, leadCodePrefix, duplicateCheckEnabled };
  const changes = diff(
    {
      defaultFollowUpDays: current.defaultFollowUpDays,
      leadCodePrefix: current.leadCodePrefix,
      duplicateCheckEnabled: current.duplicateCheckEnabled,
    },
    next,
  );

  if (!Object.keys(changes).length) {
    return getSettingsPage(auth);
  }

  await settingsDb().workspaceSetting.update({
    where: { id: WORKSPACE_ID },
    data: { ...next, updatedById: auth.user.id },
  });
  clearCache();
  await writeAuditLog({
    userId: auth.user.id,
    action: "SETTINGS_LEAD_POLICY_UPDATED",
    entityType: "settings",
    entityId: WORKSPACE_ID,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { changes } as Prisma.InputJsonValue,
  });
  return getSettingsPage(auth);
}

export async function getMyPreferences(userId: string) {
  let row: PreferenceRow | null = null;
  try {
    row = await settingsDb().userPreference.findUnique({ where: { userId } });
  } catch (error) {
    if (error instanceof HttpError || isMissingStorage(error)) {
      return { compactTables: false, updatedAt: null };
    }
    throw error;
  }
  return {
    compactTables: row?.compactTables ?? false,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

export async function updateMyPreferences(userId: string, body: Record<string, unknown>) {
  if (typeof body.compactTables !== "boolean") {
    throw httpError.validation({ compactTables: "Choose whether compact tables are on." });
  }
  const row = await settingsDb().userPreference.upsert({
    where: { userId },
    create: { userId, compactTables: body.compactTables },
    update: { compactTables: body.compactTables },
  });
  return {
    compactTables: row.compactTables,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function formatWithWorkspace(
  date: Date,
  settings: { timezone: string; dateFormat: string },
  withTime = false,
) {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: settings.timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).formatToParts(date);
  }
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
  const year = read("year");
  const month = read("month");
  const day = read("day");
  const monthShort = MONTHS[Math.max(0, Number(month) - 1)] || month;
  let datePart = `${day} ${monthShort} ${year}`;
  if (settings.dateFormat === "YYYY-MM-DD") datePart = `${year}-${month}-${day}`;
  else if (settings.dateFormat === "MM/DD/YYYY") datePart = `${month}/${day}/${year}`;
  else if (settings.dateFormat === "DD/MM/YYYY") datePart = `${day}/${month}/${year}`;
  if (!withTime) return datePart;
  return `${datePart}, ${read("hour")}:${read("minute").padStart(2, "0")} ${read("dayPeriod")}`.replace(/\s+/g, " ").trim();
}

export function formatDateOnly(date: Date, dateFormat: string) {
  const noon = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12));
  return formatWithWorkspace(noon, { timezone: "UTC", dateFormat }, false);
}

export async function formatWorkspaceDateTime(date = new Date()) {
  const settings = await readWorkspaceSettings();
  return formatWithWorkspace(date, settings, true);
}
