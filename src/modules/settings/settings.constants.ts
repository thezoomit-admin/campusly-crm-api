export const WORKSPACE_ID = "default";

export const TIMEZONES = [
  "Asia/Dhaka",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Singapore",
  "Europe/London",
  "America/New_York",
  "America/Toronto",
  "Australia/Sydney",
  "UTC",
] as const;

export const CURRENCIES = [
  "BDT",
  "USD",
  "GBP",
  "EUR",
  "AUD",
  "CAD",
  "INR",
  "AED",
] as const;

export const DATE_FORMATS = [
  "DD MMM YYYY",
  "DD/MM/YYYY",
  "MM/DD/YYYY",
  "YYYY-MM-DD",
] as const;

export const DEFAULT_WORKSPACE = {
  name: "EduConsult CRM",
  supportEmail: "support@campusly.com",
  timezone: "Asia/Dhaka",
  currency: "BDT",
  dateFormat: "DD MMM YYYY",
  defaultFollowUpDays: 1,
  leadCodePrefix: "L",
  duplicateCheckEnabled: true,
} as const;

export type WorkspaceSettings = {
  name: string;
  supportEmail: string;
  timezone: string;
  currency: string;
  dateFormat: string;
  defaultFollowUpDays: number;
  leadCodePrefix: string;
  duplicateCheckEnabled: boolean;
  updatedAt: string;
};
