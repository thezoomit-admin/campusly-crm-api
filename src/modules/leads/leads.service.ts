import type { Prisma } from "../../lib/prisma-client";
import { writeAuditLog } from "../../lib/audit";
import { HttpError, httpError } from "../../lib/http-error";
import { prisma } from "../../lib/prisma";
import {
  EXPORT_ROW_CAP,
  exportCell,
  exportFileStamp,
  formatExportDateTime,
  type TabularExport,
} from "../../lib/xlsx-export";
import type { AuthContext } from "../auth/session.service";
import {
  assertExternalLeadAvailable,
  ensureLeadAttribution,
  parseManualAttribution,
  recordCampaignTouch,
} from "./lead-attribution";
import { nextLeadCode } from "./lead-code";
import { resolveCountryAssignment } from "./leads.assignment";
import { ensureLegacyNoteSeed, recordLeadNoteChange } from "./leads.notes";
import {
  allowedFieldsFor,
  asOptionalString,
  asString,
  assertCanManageLeadAssignment,
  assertCanViewLead,
  assigneeVisibilityWhere,
  leadEligibleAssigneeWhere,
  computeLeadScore,
  displayedLeadScore,
  FOLLOW_UP_CLOSED_STATUSES,
  formatWaitingTime,
  hasPermission,
  isValidEmail,
  isValidMobile,
  leadPoolScopeWhere,
  leadScopeWhere,
  myLeadsOwnerWhere,
  priorityRank,
  normalizePhone,
  parseBoolean,
  parseDateOnly,
  parseNonNegInt,
  parseScore,
  parseYear,
  profileCompletion,
  resolveMasterCode,
  throwIfInvalid,
  titleCaseName,
} from "./leads.helpers";
import {
  CLOSE_MESSAGES,
  CLOSED_PIPELINE_STATUS_CODES,
  CLOSED_PIPELINE_STATUS_NAMES,
  PIPELINE_STATUSES,
  REOPEN_MESSAGES,
  STATUS_MESSAGES,
  describeStatusChange,
  isCloseBlockedBehavior,
  isOtherReasonCode,
  isProcessGatedBehavior,
  isTerminalBehavior,
  lostReasonRequiredFor,
  missingQualifiedData,
  reasonCategoryFor,
  resolveLeadStatus,
  type LeadStatusItem,
} from "./lead-status";

function closedLeadsWhere(): Prisma.LeadWhereInput {
  return {
    OR: [
      { statusCode: { in: [...CLOSED_PIPELINE_STATUS_CODES] } },
      { status: { in: [...CLOSED_PIPELINE_STATUS_NAMES] } },
    ],
  };
}

function activePipelineLeadsWhere(): Prisma.LeadWhereInput {
  return { NOT: closedLeadsWhere() };
}

type AuditMeta = { ipAddress?: string; userAgent?: string };

const leadInclude = {
  owner: { select: { id: true, fullName: true, teamId: true, photoUrl: true, updatedAt: true } },
  assignedCountryTeam: { select: { id: true, name: true, key: true } },
  createdBy: { select: { id: true, fullName: true } },
  updatedBy: { select: { id: true, fullName: true } },
  duplicateOf: { select: { id: true, code: true, name: true, status: true } },
} as const;

type LeadRecord = Prisma.LeadGetPayload<{ include: typeof leadInclude }>;

function versionedUserPhotoUrl(
  photoUrl: string | null | undefined,
  updatedAt?: Date | null,
) {
  if (!photoUrl) {
    return null;
  }
  if (!photoUrl.startsWith("/")) {
    return photoUrl;
  }
  const version = updatedAt ? new Date(updatedAt).getTime() : Date.now();
  const parsed = new URL(photoUrl, "http://local.invalid");
  parsed.searchParams.set("v", String(version));
  return `${parsed.pathname}?${parsed.searchParams.toString()}`;
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

function serializeLead(
  lead: LeadRecord,
  options?: { hasPhoneDuplicate?: boolean },
) {
  const completion = profileCompletion(lead);
  const scored = displayedLeadScore(lead);
  return {
    id: lead.id,
    code: lead.code,
    name: lead.name,
    phone: lead.phone,
    phoneCountryCode: lead.phoneCountryCode,
    whatsapp: lead.whatsapp,
    whatsappCountryCode: lead.whatsappCountryCode,
    whatsappSameAsPhone: lead.whatsappSameAsPhone,
    email: lead.email,
    dateOfBirth: lead.dateOfBirth
      ? lead.dateOfBirth.toISOString().slice(0, 10)
      : null,
    currentLocation: lead.currentLocation,
    country: lead.country,
    preferredCountryCode: lead.preferredCountryCode,
    preferredDegreeCode: lead.preferredDegreeCode,
    preferredCourse: lead.preferredCourse,
    preferredIntakeCode: lead.preferredIntakeCode,
    studyPurposeCode: lead.studyPurposeCode,
    studyPurposeOther: lead.studyPurposeOther,
    highestQualificationCode: lead.highestQualificationCode,
    institutionName: lead.institutionName,
    passingYear: lead.passingYear,
    resultCgpa: lead.resultCgpa,
    studyGapYears: lead.studyGapYears,
    englishTestCode: lead.englishTestCode,
    testStatusCode: lead.testStatusCode,
    overallScore: lead.overallScore,
    testDate: lead.testDate ? lead.testDate.toISOString().slice(0, 10) : null,
    listening: lead.listening,
    reading: lead.reading,
    writing: lead.writing,
    speaking: lead.speaking,
    estimatedBudgetCode: lead.estimatedBudgetCode,
    fundingSourceCode: lead.fundingSourceCode,
    financialReadinessCode: lead.financialReadinessCode,
    previouslyAppliedAbroad: lead.previouslyAppliedAbroad,
    previousVisaApplication: lead.previousVisaApplication,
    previousVisaRefusal: lead.previousVisaRefusal,
    prevVisaCountry: lead.prevVisaCountry,
    prevVisaType: lead.prevVisaType,
    prevVisaYear: lead.prevVisaYear,
    prevVisaResult: lead.prevVisaResult,
    refusalCountry: lead.refusalCountry,
    refusalYear: lead.refusalYear,
    refusalReason: lead.refusalReason,
    decisionTimelineCode: lead.decisionTimelineCode,
    decisionMakerCode: lead.decisionMakerCode,
    applicationReadinessCode: lead.applicationReadinessCode,
    studyIntentCode: lead.studyIntentCode,
    preferredContactMethodCode: lead.preferredContactMethodCode,
    preferredContactTimeCode: lead.preferredContactTimeCode,
    specificContactTime: lead.specificContactTime,
    source: lead.source,
    sourceCode: lead.sourceCode,
    channelCode: lead.channelCode,
    sourceLocked: lead.sourceLocked,
    latestSource: lead.latestSource,
    latestSourceCode: lead.latestSourceCode,
    latestChannelCode: lead.latestChannelCode,
    campaign: lead.campaign,
    campaignId: lead.campaignId,
    latestCampaign: lead.latestCampaign,
    latestCampaignId: lead.latestCampaignId,
    utmSource: lead.utmSource,
    utmMedium: lead.utmMedium,
    utmCampaign: lead.utmCampaign,
    utmContent: lead.utmContent,
    utmTerm: lead.utmTerm,
    landingPageUrl: lead.landingPageUrl,
    externalLeadId: lead.externalLeadId,
    sourceDetails: lead.sourceDetails,
    referralBy: lead.referralBy,
    referralDetails: lead.referralDetails,
    firstTouchAt: lead.firstTouchAt ? lead.firstTouchAt.toISOString() : null,
    lastEnquiryAt: lead.lastEnquiryAt ? lead.lastEnquiryAt.toISOString() : null,
    remarks: lead.remarks,
    notes: lead.notes,
    status: lead.status,
    statusCode: lead.statusCode,
    lostReasonCode: lead.lostReasonCode,
    closeReasonCode: lead.closeReasonCode,
    academicFitCode: lead.academicFitCode,
    englishReadinessCode: lead.englishReadinessCode,
    countryIntakeFitCode: lead.countryIntakeFitCode,
    studyIntentQualCode: lead.studyIntentQualCode,
    qualificationResultCode: lead.qualificationResultCode,
    unqualifiedReasonCode: lead.unqualifiedReasonCode,
    unqualifiedRemarks: lead.unqualifiedRemarks,
    profileCompletion: completion.percent,
    completion: completion.sections,
    leadScore: scored.score,
    priority: scored.priority,
    priorityCode: scored.priorityCode,
    priorityManual: lead.priorityManual,
    priorityOverrideReason: lead.priorityOverrideReason,
    owner: lead.owner
      ? {
          id: lead.owner.id,
          name: lead.owner.fullName,
          photoUrl: versionedUserPhotoUrl(lead.owner.photoUrl, lead.owner.updatedAt),
        }
      : lead.ownerName
        ? { id: lead.ownerId, name: lead.ownerName, photoUrl: null }
        : null,
    assignedTeam: lead.assignedCountryTeam
      ? { id: lead.assignedCountryTeam.id, name: lead.assignedCountryTeam.name }
      : null,
    createdBy: lead.createdBy
      ? { id: lead.createdBy.id, name: lead.createdBy.fullName }
      : null,
    updatedBy: lead.updatedBy
      ? { id: lead.updatedBy.id, name: lead.updatedBy.fullName }
      : null,
    isDuplicate: lead.isDuplicate,
    hasPhoneDuplicate: Boolean(options?.hasPhoneDuplicate),
    duplicateOfLeadId: lead.duplicateOfLeadId,
    duplicateOf: lead.duplicateOf
      ? {
          id: lead.duplicateOf.id,
          code: lead.duplicateOf.code,
          name: lead.duplicateOf.name,
          status: lead.duplicateOf.status,
        }
      : null,
    archivedAt: lead.archivedAt ? lead.archivedAt.toISOString() : null,
    createdAt: lead.createdAt.toISOString(),
    updatedAt: lead.updatedAt.toISOString(),
  };
}

async function loadLeadStatusItems(): Promise<LeadStatusItem[]> {
  const rows = await prisma.masterDataItem.findMany({
    where: { categoryKey: "LEAD_STATUS" },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  return rows.map((row) => ({
    name: row.name,
    code: row.code,
    behaviorKey: row.behaviorKey,
    sortOrder: row.sortOrder,
    status: row.status,
  }));
}

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
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100);
}

function countByStatus(
  rows: Array<{ status: string; _count: { _all: number } }>,
) {
  const map = new Map<string, number>();
  for (const row of rows) {
    const key = row.status.trim().toLowerCase();
    map.set(key, (map.get(key) || 0) + row._count._all);
  }
  return map;
}

function leadSubtitle(lead: LeadRecord) {
  const parts: string[] = [];
  const test = lead.englishTestCode?.trim();
  if (test && lead.overallScore != null) {
    parts.push(`${test} ${lead.overallScore}`);
  } else if (test) {
    parts.push(test);
  }
  const course = lead.preferredCourse?.trim();
  const qualification = lead.highestQualificationCode?.trim();
  if (course) parts.push(course);
  else if (qualification) parts.push(qualification);
  return parts.join(" | ");
}

function listItem(
  lead: LeadRecord,
  nextFollowUpAt: string | null = null,
  hasPhoneDuplicate = false,
) {
  const scored = displayedLeadScore(lead);
  return {
    id: lead.id,
    code: lead.code,
    name: lead.name,
    phone: lead.phone || "—",
    email: lead.email || "—",
    subtitle: leadSubtitle(lead),
    country: lead.country || "—",
    source: lead.source || "—",
    owner: lead.owner?.fullName || lead.ownerName || "—",
    status: lead.status,
    priority: scored.priority || "—",
    score: String(scored.score),
    nextFollowUpAt,
    updated: daysAgoLabel(lead.updatedAt),
    createdAt: lead.createdAt.toISOString(),
    isDuplicate: lead.isDuplicate,
    hasPhoneDuplicate,
    duplicateOfLeadId: lead.duplicateOfLeadId,
    duplicateOf: lead.duplicateOf
      ? {
          id: lead.duplicateOf.id,
          code: lead.duplicateOf.code,
          name: lead.duplicateOf.name,
        }
      : null,
  };
}

async function findDuplicate(phoneNormalized: string, excludeId?: string) {
  if (!phoneNormalized) return null;
  return prisma.lead.findFirst({
    where: {
      phoneNormalized,
      archivedAt: null,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, code: true, name: true, status: true },
  });
}

async function sharedPhoneNormalizedSet(
  phones: Array<string | null | undefined>,
): Promise<Set<string>> {
  const unique = [
    ...new Set(
      phones
        .map((phone) => (typeof phone === "string" ? phone.trim() : ""))
        .filter(Boolean),
    ),
  ];
  if (!unique.length) return new Set();
  const grouped = await prisma.lead.groupBy({
    by: ["phoneNormalized"],
    where: { archivedAt: null, phoneNormalized: { in: unique } },
    _count: { _all: true },
  });
  return new Set(
    grouped
      .filter((row) => row._count._all > 1 && row.phoneNormalized)
      .map((row) => row.phoneNormalized)
      .filter((phone): phone is string => Boolean(phone)),
  );
}

async function duplicatePhoneNormalizedList(): Promise<string[]> {
  const grouped = await prisma.lead.groupBy({
    by: ["phoneNormalized"],
    where: { archivedAt: null, phoneNormalized: { not: "" } },
    _count: { _all: true },
    having: {
      phoneNormalized: {
        _count: { gt: 1 },
      },
    },
  });
  return grouped
    .map((row) => row.phoneNormalized)
    .filter((phone): phone is string => Boolean(phone));
}

export async function checkDuplicate(
  auth: AuthContext,
  input: { phone?: unknown },
) {
  const phone = asString(input.phone);
  if (!phone || !isValidMobile(phone)) {
    throw httpError.validation({ phone: "Please enter a valid phone number." });
  }
  const existing = await findDuplicate(normalizePhone(phone));
  if (!existing) {
    return { duplicate: false as const };
  }
  const visible = await prisma.lead.findFirst({
    where: { id: existing.id, AND: [leadScopeWhere(auth)] },
    select: { id: true },
  });
  return {
    duplicate: true as const,
    existingLead: existing,
    canOpen: Boolean(visible) || hasPermission(auth.permissions, "lead:view"),
  };
}

type ParsedLead = {
  name: string;
  phone: string;
  phoneNormalized: string;
  phoneCountryCode: string | null;
  whatsapp: string | null;
  whatsappCountryCode: string | null;
  whatsappSameAsPhone: boolean;
  email: string | null;
  dateOfBirth: Date | null;
  currentLocation: string | null;
  preferredCountryCode: string | null;
  country: string | null;
  preferredDegreeCode: string | null;
  preferredCourse: string | null;
  preferredIntakeCode: string | null;
  studyPurposeCode: string | null;
  studyPurposeOther: string | null;
  highestQualificationCode: string | null;
  institutionName: string | null;
  passingYear: number | null;
  resultCgpa: string | null;
  studyGapYears: number | null;
  englishTestCode: string | null;
  testStatusCode: string | null;
  overallScore: number | null;
  testDate: Date | null;
  listening: number | null;
  reading: number | null;
  writing: number | null;
  speaking: number | null;
  estimatedBudgetCode: string | null;
  fundingSourceCode: string | null;
  financialReadinessCode: string | null;
  previouslyAppliedAbroad: boolean | null;
  previousVisaApplication: boolean | null;
  previousVisaRefusal: boolean | null;
  prevVisaCountry: string | null;
  prevVisaType: string | null;
  prevVisaYear: number | null;
  prevVisaResult: string | null;
  refusalCountry: string | null;
  refusalYear: number | null;
  refusalReason: string | null;
  decisionTimelineCode: string | null;
  decisionMakerCode: string | null;
  applicationReadinessCode: string | null;
  studyIntentCode: string | null;
  preferredContactMethodCode: string | null;
  preferredContactTimeCode: string | null;
  specificContactTime: string | null;
  sourceCode: string | null;
  source: string | null;
  channelCode: string | null;
  campaign: string | null;
  campaignId: string | null;
  latestSource: string | null;
  latestSourceCode: string | null;
  latestChannelCode: string | null;
  latestCampaign: string | null;
  latestCampaignId: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  landingPageUrl: string | null;
  externalLeadId: string | null;
  sourceDetails: string | null;
  referralBy: string | null;
  referralDetails: string | null;
  firstTouchAt: Date | null;
  remarks: string | null;
  notes: string | null;
};

async function parseLeadInput(
  body: Record<string, unknown>,
  mode: "create" | "update",
): Promise<ParsedLead> {
  const fields: Record<string, string> = {};
  const nameRaw = asString(body.name);
  if (mode === "create" && (nameRaw.length < 2 || nameRaw.length > 100)) {
    fields.name = "Full Name is required.";
  } else if (nameRaw && (nameRaw.length < 2 || nameRaw.length > 100)) {
    fields.name = "Full Name is required.";
  }

  const phone = asString(body.phone);
  if (mode === "create" && !isValidMobile(phone)) {
    fields.phone = "Please enter a valid phone number.";
  } else if (phone && !isValidMobile(phone)) {
    fields.phone = "Please enter a valid phone number.";
  }

  const email = asOptionalString(body.email, 200)?.toLowerCase() || null;
  if (email && !isValidEmail(email)) {
    fields.email = "Please enter a valid email address.";
  }

  const country = await resolveMasterCode(
    "COUNTRY",
    body.preferredCountryCode,
    "preferredCountryCode",
    fields,
    {
      required: mode === "create",
      message: "Please select a preferred country.",
    },
  );
  const manualAttribution =
    mode === "create" ? await parseManualAttribution(body, fields) : null;
  const source =
    mode === "create"
      ? null
      : await resolveMasterCode(
          "LEAD_SOURCE",
          body.sourceCode,
          "sourceCode",
          fields,
        );
  const degree = await resolveMasterCode(
    "STUDY_LEVEL",
    body.preferredDegreeCode,
    "preferredDegreeCode",
    fields,
  );
  const intake = await resolveMasterCode(
    "INTAKE",
    body.preferredIntakeCode,
    "preferredIntakeCode",
    fields,
  );
  if (
    intake?.extras &&
    typeof intake.extras === "object" &&
    intake.extras !== null &&
    "startDate" in intake.extras
  ) {
    const start = String(
      (intake.extras as Record<string, string>).startDate || "",
    );
    if (start && start < new Date().toISOString().slice(0, 10)) {
      fields.preferredIntakeCode = "Please select a future intake.";
    }
  }
  const purpose = await resolveMasterCode(
    "STUDY_PURPOSE",
    body.studyPurposeCode,
    "studyPurposeCode",
    fields,
  );
  const qualification = await resolveMasterCode(
    "EDUCATION_LEVEL",
    body.highestQualificationCode,
    "highestQualificationCode",
    fields,
  );
  const englishTest = await resolveMasterCode(
    "ENGLISH_TEST_TYPE",
    body.englishTestCode,
    "englishTestCode",
    fields,
  );
  const testStatus = await resolveMasterCode(
    "TEST_STATUS",
    body.testStatusCode,
    "testStatusCode",
    fields,
  );
  const budget = await resolveMasterCode(
    "BUDGET_RANGE",
    body.estimatedBudgetCode,
    "estimatedBudgetCode",
    fields,
  );
  if (fields.estimatedBudgetCode)
    fields.estimatedBudgetCode = "Please select a valid budget range.";
  const funding = await resolveMasterCode(
    "FUNDING_SOURCE",
    body.fundingSourceCode,
    "fundingSourceCode",
    fields,
  );
  const financial = await resolveMasterCode(
    "FINANCIAL_READINESS",
    body.financialReadinessCode,
    "financialReadinessCode",
    fields,
  );
  const timeline = await resolveMasterCode(
    "DECISION_TIMELINE",
    body.decisionTimelineCode,
    "decisionTimelineCode",
    fields,
  );
  const decisionMaker = await resolveMasterCode(
    "DECISION_MAKER",
    body.decisionMakerCode,
    "decisionMakerCode",
    fields,
  );
  const appReady = await resolveMasterCode(
    "APPLICATION_READINESS",
    body.applicationReadinessCode,
    "applicationReadinessCode",
    fields,
  );
  const studyIntent = await resolveMasterCode(
    "STUDY_INTENT",
    body.studyIntentCode,
    "studyIntentCode",
    fields,
  );
  const contactMethod = await resolveMasterCode(
    "CONTACT_METHOD",
    body.preferredContactMethodCode,
    "preferredContactMethodCode",
    fields,
  );
  const contactTime = await resolveMasterCode(
    "CONTACT_TIME",
    body.preferredContactTimeCode,
    "preferredContactTimeCode",
    fields,
  );

  const whatsappSame = parseBoolean(body.whatsappSameAsPhone) === true;
  const phoneCountryCode = asOptionalString(body.phoneCountryCode, 8);
  let whatsapp = asOptionalString(body.whatsapp, 20);
  let whatsappCountryCode = asOptionalString(body.whatsappCountryCode, 8);
  if (whatsappSame) {
    whatsapp = phone || null;
    whatsappCountryCode = phoneCountryCode;
  }
  if (whatsapp && !isValidMobile(whatsapp)) {
    fields.whatsapp = "Please enter a valid phone number.";
  }

  const remarks = asOptionalString(body.remarks, 1000);
  const studyPurposeOther =
    purpose?.code === "OTHER"
      ? asOptionalString(body.studyPurposeOther, 200)
      : null;
  if (purpose?.code === "OTHER" && !studyPurposeOther) {
    fields.studyPurposeOther = "Please specify the study purpose.";
  }

  const previouslyAppliedAbroad = parseBoolean(body.previouslyAppliedAbroad);
  const previousVisaApplication = parseBoolean(body.previousVisaApplication);
  const previousVisaRefusal = parseBoolean(body.previousVisaRefusal);

  const parsed: ParsedLead = {
    name: titleCaseName(nameRaw),
    phone,
    phoneNormalized: phone ? normalizePhone(phone, phoneCountryCode) : "",
    phoneCountryCode,
    whatsapp: whatsapp ? normalizePhone(whatsapp, whatsappCountryCode) : null,
    whatsappCountryCode: whatsapp ? whatsappCountryCode : null,
    whatsappSameAsPhone: whatsappSame,
    email,
    dateOfBirth: parseDateOnly(body.dateOfBirth, "dateOfBirth", fields),
    currentLocation: asOptionalString(body.currentLocation, 120),
    preferredCountryCode: country?.code || null,
    country: country?.name || null,
    preferredDegreeCode: degree?.code || null,
    preferredCourse: asOptionalString(body.preferredCourse, 200),
    preferredIntakeCode: intake?.code || null,
    studyPurposeCode: purpose?.code || null,
    studyPurposeOther,
    highestQualificationCode: qualification?.code || null,
    institutionName: asOptionalString(body.institutionName, 200),
    passingYear: parseYear(body.passingYear, "passingYear", fields),
    resultCgpa: asOptionalString(body.resultCgpa, 40),
    studyGapYears: parseNonNegInt(body.studyGapYears, "studyGapYears", fields),
    englishTestCode: englishTest?.code || null,
    testStatusCode: testStatus?.code || null,
    overallScore: parseScore(body.overallScore, "overallScore", fields),
    testDate: parseDateOnly(body.testDate, "testDate", fields),
    listening: parseScore(body.listening, "listening", fields),
    reading: parseScore(body.reading, "reading", fields),
    writing: parseScore(body.writing, "writing", fields),
    speaking: parseScore(body.speaking, "speaking", fields),
    estimatedBudgetCode: budget?.code || null,
    fundingSourceCode: funding?.code || null,
    financialReadinessCode: financial?.code || null,
    previouslyAppliedAbroad,
    previousVisaApplication,
    previousVisaRefusal,
    prevVisaCountry:
      previousVisaApplication === true
        ? asOptionalString(body.prevVisaCountry, 80)
        : null,
    prevVisaType:
      previousVisaApplication === true
        ? asOptionalString(body.prevVisaType, 80)
        : null,
    prevVisaYear:
      previousVisaApplication === true
        ? parseYear(body.prevVisaYear, "prevVisaYear", fields)
        : null,
    prevVisaResult:
      previousVisaApplication === true
        ? asOptionalString(body.prevVisaResult, 80)
        : null,
    refusalCountry:
      previousVisaRefusal === true
        ? asOptionalString(body.refusalCountry, 80)
        : null,
    refusalYear:
      previousVisaRefusal === true
        ? parseYear(body.refusalYear, "refusalYear", fields)
        : null,
    refusalReason:
      previousVisaRefusal === true
        ? asOptionalString(body.refusalReason, 400)
        : null,
    decisionTimelineCode: timeline?.code || null,
    decisionMakerCode: decisionMaker?.code || null,
    applicationReadinessCode: appReady?.code || null,
    studyIntentCode: studyIntent?.code || null,
    preferredContactMethodCode: contactMethod?.code || null,
    preferredContactTimeCode: contactTime?.code || null,
    specificContactTime:
      contactTime?.code === "SPECIFIC"
        ? asOptionalString(body.specificContactTime, 40)
        : null,
    sourceCode:
      mode === "create"
        ? manualAttribution?.sourceCode || null
        : source?.code || null,
    source:
      mode === "create"
        ? manualAttribution?.sourceLabel || null
        : source?.name || null,
    channelCode:
      mode === "create"
        ? manualAttribution?.channelCode || null
        : asOptionalString(body.channelCode, 40),
    campaign:
      mode === "create"
        ? manualAttribution?.campaignName || null
        : asOptionalString(body.campaign, 160),
    campaignId:
      mode === "create"
        ? manualAttribution?.campaignId || null
        : asOptionalString(body.campaignId, 80),
    latestSource:
      mode === "create"
        ? manualAttribution?.sourceLabel || null
        : asOptionalString(body.latestSource, 120),
    latestSourceCode:
      mode === "create"
        ? manualAttribution?.sourceCode || null
        : asOptionalString(body.latestSourceCode, 40),
    latestChannelCode:
      mode === "create"
        ? manualAttribution?.channelCode || null
        : asOptionalString(body.latestChannelCode, 40),
    latestCampaign:
      mode === "create"
        ? manualAttribution?.campaignName || null
        : asOptionalString(body.latestCampaign, 160),
    latestCampaignId:
      mode === "create"
        ? manualAttribution?.campaignId || null
        : asOptionalString(body.latestCampaignId, 80),
    utmSource:
      mode === "create"
        ? manualAttribution?.utmSource || null
        : asOptionalString(body.utmSource, 120),
    utmMedium:
      mode === "create"
        ? manualAttribution?.utmMedium || null
        : asOptionalString(body.utmMedium, 120),
    utmCampaign:
      mode === "create"
        ? manualAttribution?.utmCampaign || null
        : asOptionalString(body.utmCampaign, 120),
    utmContent:
      mode === "create"
        ? manualAttribution?.utmContent || null
        : asOptionalString(body.utmContent, 120),
    utmTerm:
      mode === "create"
        ? manualAttribution?.utmTerm || null
        : asOptionalString(body.utmTerm, 120),
    landingPageUrl:
      mode === "create"
        ? manualAttribution?.landingPageUrl || null
        : asOptionalString(body.landingPageUrl, 2000),
    externalLeadId:
      mode === "create"
        ? manualAttribution?.externalLeadId || null
        : asOptionalString(body.externalLeadId, 200),
    sourceDetails:
      mode === "create"
        ? manualAttribution?.sourceDetails || null
        : asOptionalString(body.sourceDetails, 500),
    referralBy:
      mode === "create"
        ? manualAttribution?.referralBy || null
        : asOptionalString(body.referralBy, 150),
    referralDetails:
      mode === "create"
        ? manualAttribution?.referralDetails || null
        : asOptionalString(body.referralDetails, 500),
    firstTouchAt:
      mode === "create"
        ? manualAttribution
          ? new Date()
          : null
        : body.firstTouchAt
          ? new Date(String(body.firstTouchAt))
          : null,
    remarks,
    notes: asOptionalString(body.notes, 1000),
  };

  if (
    parsed.testStatusCode === "TAKEN" &&
    parsed.overallScore == null &&
    body.overallScore
  ) {
    fields.overallScore = "Please enter a valid test score.";
  }

  throwIfInvalid(fields);
  return parsed;
}

async function metricsFor(data: ParsedLead, extra?: Partial<LeadRecord>) {
  const merged = { ...extra, ...data } as ParsedLead & Partial<LeadRecord>;
  const completion = profileCompletion(merged);
  const scored = computeLeadScore(merged);
  return {
    profileCompletion: completion.percent,
    leadScore: scored.score,
    priority: extra?.priorityManual ? extra.priority : scored.priority,
    priorityCode: extra?.priorityManual
      ? extra.priorityCode
      : scored.priorityCode,
  };
}

async function hydrateLeadRows(
  rows: LeadRecord[],
  duplicatesOnly: boolean,
  duplicatePhones: string[] | null,
) {
  const leadIds = rows.map((lead) => lead.id);
  const [nextFollowUps, sharedPhones] = await Promise.all([
    leadIds.length
      ? prisma.followUp.findMany({
          where: { leadId: { in: leadIds }, AND: [openFollowUpWhere()] },
          orderBy: [
            { dueAt: { sort: "asc", nulls: "last" } },
            { createdAt: "desc" },
          ],
        })
      : Promise.resolve([]),
    duplicatesOnly
      ? Promise.resolve(new Set(duplicatePhones || []))
      : sharedPhoneNormalizedSet(rows.map((lead) => lead.phoneNormalized)),
  ]);
  const nextByLead = new Map<string, (typeof nextFollowUps)[number]>();
  for (const followUp of nextFollowUps) {
    if (followUp.leadId && !nextByLead.has(followUp.leadId))
      nextByLead.set(followUp.leadId, followUp);
  }

  return rows.map((lead) => {
    const next = nextByLead.get(lead.id);
    const hasPhoneDuplicate = Boolean(
      lead.phoneNormalized && sharedPhones.has(lead.phoneNormalized),
    );
    return listItem(
      lead,
      next?.dueAt ? next.dueAt.toISOString() : null,
      hasPhoneDuplicate,
    );
  });
}

type LeadListFilters = {
  search?: string;
  status?: string;
  source?: string;
  priority?: string;
  country?: string;
  duplicatesOnly?: boolean;
};

async function leadListFilter(auth: AuthContext, query: LeadListFilters) {
  const search = query.search?.trim();
  const status = query.status?.trim();
  const source = query.source?.trim();
  const priority = query.priority?.trim();
  const country = query.country?.trim();
  const duplicatesOnly = query.duplicatesOnly === true;
  const scope = leadScopeWhere(auth);
  const duplicatePhones = duplicatesOnly
    ? await duplicatePhoneNormalizedList()
    : null;
  const statusKey = status?.toLowerCase() || "all";
  const isClosedTab = statusKey === "closed";
  const isAllTab = !status || statusKey === "all";
  const statusFilter: Prisma.LeadWhereInput = isClosedTab
    ? closedLeadsWhere()
    : isAllTab
      ? activePipelineLeadsWhere()
      : { status: { equals: status, mode: "insensitive" } };

  const listWhere: Prisma.LeadWhereInput = {
    AND: [
      scope,
      { archivedAt: null },
      statusFilter,
      source ? { source: { contains: source, mode: "insensitive" } } : {},
      priority ? { priority: { equals: priority, mode: "insensitive" } } : {},
      country ? { country: { contains: country, mode: "insensitive" } } : {},
      duplicatesOnly
        ? duplicatePhones && duplicatePhones.length
          ? { phoneNormalized: { in: duplicatePhones } }
          : { id: { in: [] } }
        : {},
      search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { phone: { contains: search, mode: "insensitive" } },
              { code: { contains: search, mode: "insensitive" } },
              { email: { contains: search, mode: "insensitive" } },
              { country: { contains: search, mode: "insensitive" } },
              { source: { contains: search, mode: "insensitive" } },
              { ownerName: { contains: search, mode: "insensitive" } },
              { status: { contains: search, mode: "insensitive" } },
            ],
          }
        : {},
    ],
  };

  const orderBy: Prisma.LeadOrderByWithRelationInput[] = duplicatesOnly
    ? [{ phoneNormalized: "asc" }, { createdAt: "asc" }]
    : [{ createdAt: "desc" }];

  return { listWhere, orderBy, duplicatesOnly, duplicatePhones };
}

export async function listLeads(
  auth: AuthContext,
  query: LeadListFilters & {
    page?: number;
    limit?: number;
  },
) {
  const page = Math.max(1, query.page || 1);
  const limit = Math.min(50, Math.max(10, query.limit || 10));
  const { listWhere, orderBy, duplicatesOnly, duplicatePhones } =
    await leadListFilter(auth, query);
  const scope = leadScopeWhere(auth);
  const now = new Date();
  const last30 = addUtcDays(startOfUtcDay(now), -30);
  const prev30 = addUtcDays(last30, -30);

  const activeScope: Prisma.LeadWhereInput = {
    AND: [scope, { archivedAt: null }, activePipelineLeadsWhere()],
  };
  const closedScope: Prisma.LeadWhereInput = {
    AND: [scope, { archivedAt: null }, closedLeadsWhere()],
  };

  const [
    total,
    rows,
    allCount,
    last30Count,
    prev30Count,
    statusCounts,
    statusLast30,
    statusPrev30,
    closedCount,
    closedLast30,
    closedPrev30,
  ] = await Promise.all([
    prisma.lead.count({ where: listWhere }),
    prisma.lead.findMany({
      where: listWhere,
      include: leadInclude,
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.lead.count({ where: activeScope }),
    prisma.lead.count({
      where: { AND: [activeScope, { createdAt: { gte: last30 } }] },
    }),
    prisma.lead.count({
      where: { AND: [activeScope, { createdAt: { gte: prev30, lt: last30 } }] },
    }),
    prisma.lead.groupBy({
      by: ["status"],
      where: activeScope,
      _count: { _all: true },
    }),
    prisma.lead.groupBy({
      by: ["status"],
      where: { AND: [activeScope, { createdAt: { gte: last30 } }] },
      _count: { _all: true },
    }),
    prisma.lead.groupBy({
      by: ["status"],
      where: { AND: [activeScope, { createdAt: { gte: prev30, lt: last30 } }] },
      _count: { _all: true },
    }),
    prisma.lead.count({ where: closedScope }),
    prisma.lead.count({
      where: { AND: [closedScope, { createdAt: { gte: last30 } }] },
    }),
    prisma.lead.count({
      where: { AND: [closedScope, { createdAt: { gte: prev30, lt: last30 } }] },
    }),
  ]);

  const currentMap = countByStatus(statusCounts);
  const lastMap = countByStatus(statusLast30);
  const prevMap = countByStatus(statusPrev30);
  const items = await hydrateLeadRows(rows, duplicatesOnly, duplicatePhones);

  return {
    items,
    total,
    page,
    limit,
    summary: {
      total: allCount,
      change: percentChange(last30Count, prev30Count),
      statuses: [
        ...PIPELINE_STATUSES.map((label) => ({
          key: label.toLowerCase().replace(/\s+/g, "-"),
          label,
          count: currentMap.get(label.toLowerCase()) || 0,
          change: percentChange(
            lastMap.get(label.toLowerCase()) || 0,
            prevMap.get(label.toLowerCase()) || 0,
          ),
        })),
        {
          key: "closed",
          label: "Closed",
          count: closedCount,
          change: percentChange(closedLast30, closedPrev30),
        },
      ],
    },
  };
}

export async function exportLeadRows(
  auth: AuthContext,
  query: LeadListFilters,
): Promise<TabularExport> {
  const { listWhere, orderBy, duplicatesOnly, duplicatePhones } =
    await leadListFilter(auth, query);
  const total = await prisma.lead.count({ where: listWhere });
  if (total > EXPORT_ROW_CAP) {
    throw httpError.badRequest(
      `Export is limited to ${EXPORT_ROW_CAP} leads. Narrow the filters and try again.`,
    );
  }

  const rows = await prisma.lead.findMany({
    where: listWhere,
    include: leadInclude,
    orderBy,
  });
  const items = await hydrateLeadRows(rows, duplicatesOnly, duplicatePhones);

  return {
    title: "Leads",
    fileName: `leads-${exportFileStamp()}.xlsx`,
    columns: [
      { header: "Code", key: "code", width: 16 },
      { header: "Name", key: "name", width: 28 },
      { header: "Phone", key: "phone", width: 18 },
      { header: "Email", key: "email", width: 32 },
      { header: "Country", key: "country", width: 18 },
      { header: "Source", key: "source", width: 16 },
      { header: "Status", key: "status", width: 16 },
      { header: "Priority", key: "priority", width: 14 },
      { header: "Follow-up", key: "followUp", width: 22 },
      { header: "Assigned To", key: "owner", width: 22 },
      { header: "Created On", key: "createdOn", width: 22 },
    ],
    rows: items.map((item) => ({
      code: exportCell(item.code),
      name: exportCell(item.name),
      phone: exportCell(item.phone),
      email: exportCell(item.email),
      country: exportCell(item.country),
      source: exportCell(item.source),
      status: exportCell(item.status),
      priority: exportCell(item.priority),
      followUp: formatExportDateTime(item.nextFollowUpAt),
      owner: exportCell(item.owner),
      createdOn: formatExportDateTime(item.createdAt),
    })),
  };
}

export async function getLead(auth: AuthContext, id: string) {
  await assertCanViewLead(auth, id);
  await prisma.followUp.updateMany({
    where: {
      leadId: id,
      status: { in: ["Pending", "Due Soon"] },
      dueAt: { lt: new Date() },
    },
    data: { status: "Overdue" },
  });
  const [lead, nextFollowUp, statusItems] = await Promise.all([
    prisma.lead.findUniqueOrThrow({ where: { id }, include: leadInclude }),
    prisma.followUp.findFirst({
      where: {
        leadId: id,
        status: { notIn: [...FOLLOW_UP_CLOSED_STATUSES] },
      },
      orderBy: [
        { dueAt: { sort: "asc", nulls: "last" } },
        { createdAt: "desc" },
      ],
    }),
    loadLeadStatusItems(),
  ]);
  const hasPhoneDuplicate = lead.phoneNormalized
    ? Boolean(await findDuplicate(lead.phoneNormalized, lead.id))
    : false;
  return {
    lead: {
      ...serializeLead(lead, { hasPhoneDuplicate }),
      statusChange: describeStatusChange({
        lead,
        items: statusItems,
        canUpdate: hasPermission(auth.permissions, "lead:update_status"),
        canOverride: hasPermission(auth.permissions, "lead:override_status"),
        canClose: hasPermission(auth.permissions, "lead:close"),
        canReopen: hasPermission(auth.permissions, "lead:reopen"),
      }),
      nextFollowUp: nextFollowUp
        ? {
            id: nextFollowUp.id,
            type: nextFollowUp.type,
            dueAt: nextFollowUp.dueAt ? nextFollowUp.dueAt.toISOString() : null,
            status: nextFollowUp.status,
            notes: nextFollowUp.notes,
            priority: nextFollowUp.priority,
            purpose: nextFollowUp.purpose,
            nextAction: nextFollowUp.nextAction,
            reminder: nextFollowUp.reminder,
            outcome: nextFollowUp.outcome,
          }
        : null,
    },
  };
}

export async function createLead(
  auth: AuthContext,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  await ensureLeadAttribution();
  const parsed = await parseLeadInput(body, "create");
  await assertExternalLeadAvailable(parsed.externalLeadId);
  const duplicate = await findDuplicate(parsed.phoneNormalized);
  let createAsDuplicateOf: string | null = null;
  if (duplicate) {
    const createAnyway =
      body.createAnyway === true || body.createAnyway === "true";
    if (
      !createAnyway ||
      !hasPermission(auth.permissions, "lead:create_duplicate")
    ) {
      throw httpError.duplicateLead(duplicate);
    }
    createAsDuplicateOf = duplicate.id;
  }

  const assignment = await resolveCountryAssignment(
    parsed.preferredCountryCode,
  );
  const newStatus = await prisma.masterDataItem.findUnique({
    where: { categoryKey_code: { categoryKey: "LEAD_STATUS", code: "NEW" } },
  });
  const metrics = await metricsFor(parsed);
  const code = await nextLeadCode();

  const lead = await prisma.$transaction(async (tx) => {
    const created = await tx.lead.create({
      data: {
        ...parsed,
        code,
        status: newStatus?.name || "New",
        statusCode: newStatus?.code || "NEW",
        ownerId: assignment.ownerId,
        ownerName: assignment.ownerName,
        assignedCountryTeamId: assignment.teamId,
        createdById: auth.user.id,
        updatedById: auth.user.id,
        sourceLocked: false,
        isDuplicate: Boolean(createAsDuplicateOf),
        duplicateOfLeadId: createAsDuplicateOf,
        ...metrics,
      },
      include: leadInclude,
    });
    await recordCampaignTouch(tx, {
      leadId: created.id,
      sourceCode: created.sourceCode,
      channelCode: created.channelCode,
      campaignId: created.campaignId,
      campaignName: created.campaign,
      externalLeadId: created.externalLeadId,
      receivedAt: created.firstTouchAt || created.createdAt,
      utmSource: created.utmSource,
      utmMedium: created.utmMedium,
      utmCampaign: created.utmCampaign,
      utmContent: created.utmContent,
      utmTerm: created.utmTerm,
    });
    await tx.leadAssignment.create({
      data: {
        leadId: created.id,
        toOwnerId: assignment.ownerId,
        teamId: assignment.teamId,
        kind: assignment.ownerId ? "REASSIGN" : "POOL_ASSIGN",
        reason: assignment.ownerId
          ? "Country-based assignment on create"
          : "Entered lead pool",
        createdById: auth.user.id,
      },
    });
    await tx.activity.create({
      data: {
        type: "NOTE",
        userId: auth.user.id,
        notes: `Lead created (${created.code})`,
        relatedName: created.name,
        relatedType: "lead",
        relatedId: created.id,
        outcome: "Created",
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    });
    await tx.leadStatusHistory.create({
      data: {
        leadId: created.id,
        previousStatus: null,
        previousStatusCode: null,
        newStatus: created.status,
        newStatusCode: created.statusCode || "NEW",
        createdById: auth.user.id,
      },
    });
    const initialNotes = created.notes?.trim();
    if (initialNotes) {
      await tx.leadNote.create({
        data: {
          leadId: created.id,
          body: initialNotes,
          createdById: auth.user.id,
        },
      });
    }
    return created;
  });

  await writeAuditLog({
    userId: auth.user.id,
    action: "LEAD_CREATED",
    entityType: "lead",
    entityId: lead.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: {
      code: lead.code,
      country: lead.preferredCountryCode,
      source: lead.sourceCode,
      ownerId: lead.ownerId,
      isDuplicate: lead.isDuplicate,
      duplicateOfLeadId: lead.duplicateOfLeadId,
    },
  });

  return {
    lead: serializeLead(lead),
    message: `Lead Created Successfully — Lead ID: ${lead.code}`,
  };
}

const PRESERVED_ATTRIBUTION = new Set([
  "sourceCode",
  "source",
  "channelCode",
  "campaign",
  "campaignId",
  "latestSource",
  "latestSourceCode",
  "latestChannelCode",
  "latestCampaign",
  "latestCampaignId",
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "utmContent",
  "utmTerm",
  "landingPageUrl",
  "externalLeadId",
  "sourceDetails",
  "referralBy",
  "referralDetails",
  "firstTouchAt",
]);

function pickAllowed(body: Record<string, unknown>, auth: AuthContext) {
  const allowed = allowedFieldsFor(auth);
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (PRESERVED_ATTRIBUTION.has(key)) continue;
    if (!allowed.has(key)) continue;
    next[key] = value;
  }
  return next;
}

export async function updateLead(
  auth: AuthContext,
  id: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  const current = await assertCanViewLead(auth, id);
  const filtered = pickAllowed(body, auth);
  const mergedBody = {
    ...serializeLead(
      await prisma.lead.findUniqueOrThrow({
        where: { id },
        include: leadInclude,
      }),
    ),
    ...filtered,
  };
  const parsed = await parseLeadInput(mergedBody, "update");

  if (
    parsed.phoneNormalized &&
    parsed.phoneNormalized !== current.phoneNormalized
  ) {
    const duplicate = await findDuplicate(parsed.phoneNormalized, id);
    if (duplicate) throw httpError.duplicateLead(duplicate);
  }

  let ownerId = current.ownerId;
  let ownerName = current.ownerName;
  let assignedCountryTeamId = current.assignedCountryTeamId;
  const countryChanged =
    parsed.preferredCountryCode &&
    parsed.preferredCountryCode !== current.preferredCountryCode;
  if (countryChanged) {
    const assignment = await resolveCountryAssignment(
      parsed.preferredCountryCode,
    );
    ownerId = assignment.ownerId;
    ownerName = assignment.ownerName;
    assignedCountryTeamId = assignment.teamId;
  }

  const metrics = await metricsFor(parsed, current);
  const leadData: Partial<ParsedLead> = { ...parsed };
  for (const key of PRESERVED_ATTRIBUTION) {
    delete leadData[key as keyof ParsedLead];
  }
  const notesChanged =
    (parsed.notes?.trim() || "") !== (current.notes?.trim() || "");
  if (notesChanged) {
    await ensureLegacyNoteSeed(id);
  }
  const lead = await prisma.$transaction(async (tx) => {
    const updated = await tx.lead.update({
      where: { id },
      data: {
        ...leadData,
        ownerId,
        ownerName,
        assignedCountryTeamId,
        updatedById: auth.user.id,
        ...metrics,
        priority: current.priorityManual ? current.priority : metrics.priority,
        priorityCode: current.priorityManual
          ? current.priorityCode
          : metrics.priorityCode,
      },
      include: leadInclude,
    });
    await recordLeadNoteChange(tx, {
      leadId: id,
      previousNotes: current.notes,
      nextNotes: parsed.notes,
      leadName: updated.name,
      actorUserId: auth.user.id,
      meta,
    });
    if (countryChanged) {
      await tx.leadAssignment.create({
        data: {
          leadId: id,
          fromOwnerId: current.ownerId,
          toOwnerId: ownerId,
          teamId: assignedCountryTeamId,
          reason: ownerId
            ? "Preferred country changed"
            : "Entered lead pool after country change",
          createdById: auth.user.id,
        },
      });
      await tx.activity.create({
        data: {
          type: "NOTE",
          userId: auth.user.id,
          notes: ownerId
            ? "Lead reassigned after country change"
            : "Lead moved to Lead Pool after country change",
          relatedName: updated.name,
          relatedType: "lead",
          relatedId: updated.id,
          outcome: "Assigned",
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
      });
    }
    return updated;
  });

  await writeAuditLog({
    userId: auth.user.id,
    action: "LEAD_UPDATED",
    entityType: "lead",
    entityId: lead.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { code: lead.code },
  });

  return { lead: serializeLead(lead) };
}

export async function updateQualification(
  auth: AuthContext,
  id: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  if (!hasPermission(auth.permissions, "lead:qualify")) {
    throw httpError.accessDenied();
  }
  const current = await assertCanViewLead(auth, id);
  const fields: Record<string, string> = {};
  const academicFit = await resolveMasterCode(
    "QUALIFICATION_FIT",
    body.academicFitCode,
    "academicFitCode",
    fields,
  );
  const englishReady = await resolveMasterCode(
    "FINANCIAL_READINESS",
    body.englishReadinessCode,
    "englishReadinessCode",
    fields,
  );
  const countryFit = await resolveMasterCode(
    "QUALIFICATION_FIT",
    body.countryIntakeFitCode,
    "countryIntakeFitCode",
    fields,
  );
  const intentQual = await resolveMasterCode(
    "STUDY_INTENT",
    body.studyIntentQualCode,
    "studyIntentQualCode",
    fields,
  );
  const financial = await resolveMasterCode(
    "FINANCIAL_READINESS",
    body.financialReadinessCode,
    "financialReadinessCode",
    fields,
  );
  const timeline = await resolveMasterCode(
    "DECISION_TIMELINE",
    body.decisionTimelineCode,
    "decisionTimelineCode",
    fields,
  );
  const appReady = await resolveMasterCode(
    "APPLICATION_READINESS",
    body.applicationReadinessCode,
    "applicationReadinessCode",
    fields,
  );
  const result = await resolveMasterCode(
    "QUALIFICATION_RESULT",
    body.qualificationResultCode,
    "qualificationResultCode",
    fields,
    {
      required: true,
      message: "Select a qualification result.",
    },
  );
  let unqualifiedReason = null;
  if (result?.code === "QUALIFIED") {
    if (!academicFit?.code)
      fields.academicFitCode =
        "Academic Fit is required when marking Qualified.";
    if (!financial?.code)
      fields.financialReadinessCode =
        "Financial Readiness is required when marking Qualified.";
    if (!englishReady?.code)
      fields.englishReadinessCode =
        "English Readiness is required when marking Qualified.";
    if (!intentQual?.code)
      fields.studyIntentQualCode =
        "Study Intent is required when marking Qualified.";
  }
  if (result?.code === "UNQUALIFIED") {
    unqualifiedReason = await resolveMasterCode(
      "UNQUALIFIED_REASON",
      body.unqualifiedReasonCode,
      "unqualifiedReasonCode",
      fields,
      {
        required: true,
        message: "Please provide a reason.",
      },
    );
    if (
      unqualifiedReason?.code === "OTHER" &&
      !asString(body.unqualifiedRemarks)
    ) {
      fields.unqualifiedRemarks = "Please provide a reason.";
    }
  }
  throwIfInvalid(fields);

  const next = {
    academicFitCode: academicFit?.code || null,
    englishReadinessCode: englishReady?.code || null,
    countryIntakeFitCode: countryFit?.code || null,
    studyIntentQualCode: intentQual?.code || null,
    financialReadinessCode: financial?.code || current.financialReadinessCode,
    decisionTimelineCode: timeline?.code || current.decisionTimelineCode,
    applicationReadinessCode:
      appReady?.code || current.applicationReadinessCode,
    qualificationResultCode: result?.code || null,
    unqualifiedReasonCode:
      result?.code === "UNQUALIFIED" ? unqualifiedReason?.code || null : null,
    unqualifiedRemarks:
      result?.code === "UNQUALIFIED"
        ? asOptionalString(body.unqualifiedRemarks, 1000)
        : null,
  };
  const scored = computeLeadScore({ ...current, ...next });
  const completion = profileCompletion({ ...current, ...next });

  const previousResult = current.qualificationResultCode;
  const lead = await prisma.$transaction(async (tx) => {
    const updated = await tx.lead.update({
      where: { id },
      data: {
        ...next,
        profileCompletion: completion.percent,
        leadScore: scored.score,
        priority: current.priorityManual ? current.priority : scored.priority,
        priorityCode: current.priorityManual
          ? current.priorityCode
          : scored.priorityCode,
        updatedById: auth.user.id,
      },
      include: leadInclude,
    });
    await tx.leadQualificationHistory.create({
      data: {
        leadId: id,
        result: next.qualificationResultCode,
        reason: next.unqualifiedReasonCode,
        snapshot: next,
        createdById: auth.user.id,
      },
    });
    const resultName = result!.name;
    const notes = previousResult
      ? `Qualification updated to ${resultName}`
      : `Qualification set to ${resultName}`;
    await tx.activity.create({
      data: {
        type: "NOTE",
        userId: auth.user.id,
        notes: next.unqualifiedReasonCode
          ? `${notes}. Reason: ${next.unqualifiedReasonCode}${next.unqualifiedRemarks ? ` — ${next.unqualifiedRemarks}` : ""}`
          : notes,
        relatedName: updated.name,
        relatedType: "lead",
        relatedId: updated.id,
        outcome: resultName,
        metadata: {
          previousResult,
          result: next.qualificationResultCode,
          reason: next.unqualifiedReasonCode,
          remarks: next.unqualifiedRemarks,
        },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    });
    return updated;
  });

  await writeAuditLog({
    userId: auth.user.id,
    action: "LEAD_QUALIFIED",
    entityType: "lead",
    entityId: lead.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: {
      result: next.qualificationResultCode,
      reason: next.unqualifiedReasonCode,
      previousResult,
      relatedName: lead.name,
    },
  });

  return { lead: serializeLead(lead) };
}

export async function updatePriority(
  auth: AuthContext,
  id: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  if (!hasPermission(auth.permissions, "lead:override_priority")) {
    throw httpError.accessDenied();
  }
  await assertCanViewLead(auth, id);
  const fields: Record<string, string> = {};
  const item = await resolveMasterCode(
    "LEAD_PRIORITY",
    body.priorityCode,
    "priorityCode",
    fields,
    {
      required: true,
      message: "Please select a valid priority.",
    },
  );
  const reason = asString(body.priorityOverrideReason);
  if (!reason) fields.priorityOverrideReason = "Please provide a reason.";
  throwIfInvalid(fields);

  const lead = await prisma.lead.update({
    where: { id },
    data: {
      priority: item!.name,
      priorityCode: item!.code,
      priorityManual: true,
      priorityOverrideReason: reason.slice(0, 400),
      updatedById: auth.user.id,
    },
    include: leadInclude,
  });

  await writeAuditLog({
    userId: auth.user.id,
    action: "LEAD_PRIORITY_OVERRIDE",
    entityType: "lead",
    entityId: lead.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { priority: item!.code, reason },
  });

  return { lead: serializeLead(lead) };
}

export async function createLeadFollowUp(
  auth: AuthContext,
  id: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  const { createFollowUp } = await import("../follow-ups/follow-ups.service");
  return createFollowUp(auth, { ...body, leadId: id }, meta);
}

export async function updateLeadStatus(
  auth: AuthContext,
  id: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  if (!hasPermission(auth.permissions, "lead:update_status")) {
    throw httpError.accessDenied(STATUS_MESSAGES.permission);
  }

  const currentLead = await assertCanViewLead(auth, id);
  const items = await loadLeadStatusItems();
  const current = resolveLeadStatus(currentLead, items);
  const fields: Record<string, string> = {};
  const statusCode = asString(body.statusCode);
  if (!statusCode) fields.statusCode = STATUS_MESSAGES.missing;
  if (!current)
    fields.statusCode = fields.statusCode || STATUS_MESSAGES.missing;
  throwIfInvalid(fields);

  const next = items.find(
    (item) => item.code === statusCode && item.status === "ACTIVE",
  );
  if (!next?.code) {
    throw httpError.validation({ statusCode: STATUS_MESSAGES.missing });
  }
  if (next.code === current!.code) {
    throw httpError.validation(
      { statusCode: STATUS_MESSAGES.same },
      STATUS_MESSAGES.same,
    );
  }

  const canOverride = hasPermission(auth.permissions, "lead:override_status");
  const overrideRequested = body.override === true || body.override === "true";
  const overrideReason = asString(body.overrideReason);
  const allowed = describeStatusChange({
    lead: currentLead,
    items,
    canUpdate: true,
    canOverride,
  });
  const option = allowed.options.find((item) => item.code === next.code);
  if (!allowed.canUpdate) {
    throw httpError.validation(
      { statusCode: allowed.lockedReason || STATUS_MESSAGES.jump },
      allowed.lockedReason || STATUS_MESSAGES.jump,
    );
  }
  if (!option) {
    const gated =
      next.behaviorKey === "converted"
        ? STATUS_MESSAGES.converted
        : next.behaviorKey === "file_opening_pending"
          ? STATUS_MESSAGES.fileOpening
          : next.behaviorKey === "file_opened"
            ? STATUS_MESSAGES.fileOpened
            : STATUS_MESSAGES.jump;
    throw httpError.validation({ statusCode: gated }, gated);
  }
  if (option.requiresOverride && !overrideRequested) {
    throw httpError.validation(
      { statusCode: STATUS_MESSAGES.jump },
      STATUS_MESSAGES.jump,
    );
  }
  if (option.requiresOverride && !overrideReason) {
    throw httpError.validation({ overrideReason: STATUS_MESSAGES.override });
  }

  const remarks = asString(body.remarks);
  if (remarks.length > 1000) {
    fields.remarks = "Remarks cannot exceed 1000 characters.";
  }

  if (next.code === "QUALIFIED" && missingQualifiedData(currentLead)) {
    fields.statusCode = STATUS_MESSAGES.qualifiedData;
  }
  throwIfInvalid(fields);

  try {
    const lead = await prisma.$transaction(async (tx) => {
      const updated = await tx.lead.update({
        where: { id },
        data: {
          status: next.name,
          statusCode: next.code,
          updatedById: auth.user.id,
        },
        include: leadInclude,
      });
      await tx.leadStatusHistory.create({
        data: {
          leadId: id,
          previousStatus: current!.name,
          previousStatusCode: current!.code,
          newStatus: next.name,
          newStatusCode: next.code!,
          remarks: remarks || null,
          isOverride: Boolean(option.requiresOverride),
          overrideReason: option.requiresOverride ? overrideReason : null,
          createdById: auth.user.id,
        },
      });
      await tx.activity.create({
        data: {
          type: "NOTE",
          userId: auth.user.id,
          notes: `Status changed from ${current!.name} to ${next.name}${remarks ? `. ${remarks}` : ""}`,
          relatedName: updated.name,
          relatedType: "lead",
          relatedId: updated.id,
          outcome: next.name,
          metadata: {
            previousStatus: current!.name,
            previousStatusCode: current!.code,
            newStatus: next.name,
            newStatusCode: next.code,
            remarks: remarks || null,
            isOverride: option.requiresOverride,
          },
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
      });
      return updated;
    });

    if (next.behaviorKey === "file_opened") {
      try {
        const { openCrmFile } = await import("../files/file-documents.service");
        await openCrmFile(auth, id, meta);
      } catch (error) {
        console.error("[files] File opening after status change failed:", error);
      }
    }

    await writeAuditLog({
      userId: auth.user.id,
      action: "LEAD_STATUS_CHANGED",
      entityType: "lead",
      entityId: lead.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: {
        from: current!.name,
        to: next.name,
        previousStatusCode: current!.code,
        newStatusCode: next.code,
        remarks: remarks || null,
        override: option.requiresOverride,
        overrideReason: option.requiresOverride ? overrideReason : null,
        relatedName: lead.name,
        name: lead.name,
      },
    });

    return getLead(auth, id);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error(error);
    throw httpError.statusUpdateFailed();
  }
}

export async function closeLead(
  auth: AuthContext,
  id: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  if (!hasPermission(auth.permissions, "lead:close")) {
    throw httpError.accessDenied(CLOSE_MESSAGES.permission);
  }

  const currentLead = await assertCanViewLead(auth, id);
  const items = await loadLeadStatusItems();
  const current = resolveLeadStatus(currentLead, items);
  if (!current) {
    throw httpError.validation(
      { statusCode: CLOSE_MESSAGES.status },
      CLOSE_MESSAGES.status,
    );
  }
  if (isCloseBlockedBehavior(current.behaviorKey)) {
    throw httpError.validation(
      { statusCode: STATUS_MESSAGES.lockedConverted },
      STATUS_MESSAGES.lockedConverted,
    );
  }
  if (isTerminalBehavior(current.behaviorKey)) {
    throw httpError.validation(
      { statusCode: CLOSE_MESSAGES.notAllowed },
      CLOSE_MESSAGES.notAllowed,
    );
  }

  const fields: Record<string, string> = {};
  const statusCode = asString(body.statusCode);
  if (!statusCode) fields.statusCode = CLOSE_MESSAGES.status;

  const next = items.find(
    (item) => item.code === statusCode && item.status === "ACTIVE",
  );
  if (!next?.code || !isTerminalBehavior(next.behaviorKey)) {
    fields.statusCode = CLOSE_MESSAGES.status;
  }
  throwIfInvalid(fields);

  const remarks = asString(body.remarks);
  if (remarks.length > 1000) {
    fields.remarks = "Remarks cannot exceed 1000 characters.";
  }

  let lostReasonCode: string | null = null;
  let closeReasonCode: string | null = null;
  const reasonCategory = reasonCategoryFor(next!.behaviorKey);
  const reasonValue =
    body.reasonCode ?? body.lostReasonCode ?? body.closeReasonCode;

  if (reasonCategory) {
    const reason = await resolveMasterCode(
      reasonCategory,
      reasonValue,
      "reasonCode",
      fields,
      {
        required: true,
        message: CLOSE_MESSAGES.reason,
      },
    );
    if (lostReasonRequiredFor(next!.behaviorKey)) {
      lostReasonCode = reason?.code || null;
    } else {
      closeReasonCode = reason?.code || null;
    }
    if (isOtherReasonCode(reason?.code) && !remarks) {
      fields.remarks = CLOSE_MESSAGES.remarksOther;
    }
  }

  throwIfInvalid(fields);

  try {
    const lead = await prisma.$transaction(async (tx) => {
      const updated = await tx.lead.update({
        where: { id },
        data: {
          status: next!.name,
          statusCode: next!.code,
          lostReasonCode,
          closeReasonCode,
          updatedById: auth.user.id,
        },
        include: leadInclude,
      });
      await tx.leadStatusHistory.create({
        data: {
          leadId: id,
          previousStatus: current.name,
          previousStatusCode: current.code,
          newStatus: next!.name,
          newStatusCode: next!.code!,
          remarks: remarks || null,
          lostReasonCode,
          closeReasonCode,
          createdById: auth.user.id,
        },
      });
      const reasonLabel = lostReasonCode || closeReasonCode;
      await tx.activity.create({
        data: {
          type: "NOTE",
          userId: auth.user.id,
          notes: `Lead closed as ${next!.name}${reasonLabel ? ` (${reasonLabel})` : ""}${remarks ? `. ${remarks}` : ""}`,
          relatedName: updated.name,
          relatedType: "lead",
          relatedId: updated.id,
          outcome: next!.name,
          metadata: {
            action: "close",
            previousStatus: current.name,
            previousStatusCode: current.code,
            newStatus: next!.name,
            newStatusCode: next!.code,
            remarks: remarks || null,
            lostReasonCode,
            closeReasonCode,
          },
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
      });
      return updated;
    });

    await writeAuditLog({
      userId: auth.user.id,
      action: "LEAD_CLOSED",
      entityType: "lead",
      entityId: lead.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: {
        from: current.name,
        to: next!.name,
        previousStatusCode: current.code,
        newStatusCode: next!.code,
        remarks: remarks || null,
        lostReasonCode,
        closeReasonCode,
        relatedName: lead.name,
        name: lead.name,
      },
    });

    return getLead(auth, id);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error(error);
    throw httpError.badRequest(CLOSE_MESSAGES.failed, "LEAD_CLOSE_FAILED");
  }
}

async function resolveReopenTargetStatus(
  leadId: string,
  items: LeadStatusItem[],
) {
  const history = await prisma.leadStatusHistory.findMany({
    where: { leadId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  for (const row of history) {
    const previous = resolveLeadStatus(
      { status: row.previousStatus || "", statusCode: row.previousStatusCode },
      items,
    );
    if (
      previous?.code &&
      !isTerminalBehavior(previous.behaviorKey) &&
      !isCloseBlockedBehavior(previous.behaviorKey) &&
      !isProcessGatedBehavior(previous.behaviorKey)
    ) {
      const active = items.find(
        (item) => item.code === previous.code && item.status === "ACTIVE",
      );
      if (active?.code) return active;
    }
  }

  const contacted = items.find(
    (item) => item.code === "CONTACTED" && item.status === "ACTIVE",
  );
  if (contacted) return contacted;
  const neu = items.find(
    (item) => item.code === "NEW" && item.status === "ACTIVE",
  );
  if (neu) return neu;
  return null;
}

export async function reopenLead(
  auth: AuthContext,
  id: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  if (!hasPermission(auth.permissions, "lead:reopen")) {
    throw httpError.accessDenied(REOPEN_MESSAGES.permission);
  }

  const currentLead = await assertCanViewLead(auth, id);
  const items = await loadLeadStatusItems();
  const current = resolveLeadStatus(currentLead, items);
  if (!current || !isTerminalBehavior(current.behaviorKey)) {
    throw httpError.validation(
      { statusCode: REOPEN_MESSAGES.notTerminal },
      REOPEN_MESSAGES.notTerminal,
    );
  }
  if (isCloseBlockedBehavior(current.behaviorKey)) {
    throw httpError.validation(
      { statusCode: REOPEN_MESSAGES.notAllowed },
      REOPEN_MESSAGES.notAllowed,
    );
  }

  const fields: Record<string, string> = {};
  const reopenReason = asString(body.reopenReason);
  if (!reopenReason) fields.reopenReason = REOPEN_MESSAGES.reason;
  if (reopenReason.length > 1000)
    fields.reopenReason = "Reopen reason cannot exceed 1000 characters.";

  const followUpRaw = asString(body.followUpDate || body.dueAt);
  let followUpDate: Date | null = null;
  if (!followUpRaw) {
    fields.followUpDate = REOPEN_MESSAGES.followUp;
  } else {
    const parsed = new Date(followUpRaw);
    if (Number.isNaN(parsed.getTime())) {
      fields.followUpDate = REOPEN_MESSAGES.followUp;
    } else {
      followUpDate = parsed;
    }
  }

  const ownerId = asString(body.ownerId);
  if (!ownerId) fields.ownerId = REOPEN_MESSAGES.owner;
  throwIfInvalid(fields);

  const assignee = await prisma.user.findFirst({
    where: {
      id: ownerId,
      AND: [leadEligibleAssigneeWhere(), assigneeVisibilityWhere(auth)],
    },
    include: { team: { select: { id: true, name: true } } },
  });
  if (!assignee) {
    throw httpError.validation(
      { ownerId: REOPEN_MESSAGES.owner },
      REOPEN_MESSAGES.owner,
    );
  }

  const next = await resolveReopenTargetStatus(id, items);
  if (!next?.code) {
    throw httpError.badRequest(REOPEN_MESSAGES.failed, "LEAD_REOPEN_FAILED");
  }

  const fromOwnerId = currentLead.ownerId;
  const fromOwnerName = currentLead.ownerName;
  const teamId = assignee.teamId || currentLead.assignedCountryTeamId;
  const ownerChanged = assignee.id !== currentLead.ownerId;

  try {
    const lead = await prisma.$transaction(async (tx) => {
      const updated = await tx.lead.update({
        where: { id },
        data: {
          status: next.name,
          statusCode: next.code,
          lostReasonCode: null,
          closeReasonCode: null,
          ownerId: assignee.id,
          ownerName: assignee.fullName,
          assignedCountryTeamId: teamId,
          updatedById: auth.user.id,
        },
        include: leadInclude,
      });

      if (ownerChanged) {
        await tx.leadAssignment.create({
          data: {
            leadId: id,
            fromOwnerId,
            toOwnerId: assignee.id,
            teamId,
            kind: "REOPEN",
            reason: `Reopened — ${reopenReason}`.slice(0, 400),
            createdById: auth.user.id,
          },
        });
      }

      await tx.leadStatusHistory.create({
        data: {
          leadId: id,
          previousStatus: current.name,
          previousStatusCode: current.code,
          newStatus: next.name,
          newStatusCode: next.code!,
          remarks: reopenReason,
          createdById: auth.user.id,
        },
      });

      await tx.activity.create({
        data: {
          type: "NOTE",
          userId: auth.user.id,
          notes: `Lead reopened from ${current.name} to ${next.name}. ${reopenReason}`,
          relatedName: updated.name,
          relatedType: "lead",
          relatedId: updated.id,
          outcome: "Reopened",
          metadata: {
            action: "reopen",
            previousStatus: current.name,
            previousStatusCode: current.code,
            newStatus: next.name,
            newStatusCode: next.code,
            reopenReason,
            followUpDate: followUpDate!.toISOString(),
            ownerId: assignee.id,
            ownerName: assignee.fullName,
          },
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
      });

      return updated;
    });

    try {
      const { createSystemFollowUp } =
        await import("../follow-ups/system-follow-up");
      await createSystemFollowUp({
        leadId: lead.id,
        contactName: lead.name,
        type: "Call",
        purpose: "Reopened Lead Follow-up",
        nextAction: "Contact reopened lead",
        dueAt: followUpDate!,
        priority: lead.priority || "Medium",
        ownerId: assignee.id,
        ownerName: assignee.fullName,
        notes: reopenReason,
        reason: `Lead Reopened — ${lead.id.slice(0, 8)} — ${followUpDate!.toISOString()}`,
        actorUserId: auth.user.id,
        meta,
      });
    } catch (error) {
      console.error("[follow-ups] Follow-up on reopen failed:", error);
    }

    await writeAuditLog({
      userId: auth.user.id,
      action: "LEAD_REOPENED",
      entityType: "lead",
      entityId: lead.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: {
        from: current.name,
        to: next.name,
        previousStatusCode: current.code,
        newStatusCode: next.code,
        reopenReason,
        followUpDate: followUpDate!.toISOString(),
        fromOwnerId,
        fromOwnerName,
        toOwnerId: assignee.id,
        toOwnerName: assignee.fullName,
        relatedName: lead.name,
        name: lead.name,
      },
    });

    return getLead(auth, id);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error(error);
    throw httpError.badRequest(REOPEN_MESSAGES.failed, "LEAD_REOPEN_FAILED");
  }
}

export async function listLeadStatusHistory(auth: AuthContext, id: string) {
  await assertCanViewLead(auth, id);
  const rows = await prisma.leadStatusHistory.findMany({
    where: { leadId: id },
    include: { createdBy: { select: { id: true, fullName: true } } },
    orderBy: { createdAt: "desc" },
  });
  const lostCodes = [
    ...new Set(
      rows
        .map((row) => row.lostReasonCode)
        .filter((code): code is string => Boolean(code)),
    ),
  ];
  const closeCodes = [
    ...new Set(
      rows
        .map((row) => row.closeReasonCode)
        .filter((code): code is string => Boolean(code)),
    ),
  ];
  const [lostReasons, closeReasons] = await Promise.all([
    lostCodes.length
      ? prisma.masterDataItem.findMany({
          where: { categoryKey: "LEAD_LOST_REASON", code: { in: lostCodes } },
          select: { code: true, name: true },
        })
      : Promise.resolve([]),
    closeCodes.length
      ? prisma.masterDataItem.findMany({
          where: { categoryKey: "LEAD_CLOSE_REASON", code: { in: closeCodes } },
          select: { code: true, name: true },
        })
      : Promise.resolve([]),
  ]);
  const lostMap = new Map(lostReasons.map((item) => [item.code, item.name]));
  const closeMap = new Map(closeReasons.map((item) => [item.code, item.name]));

  return {
    items: rows.map((row) => ({
      id: row.id,
      previousStatus: row.previousStatus,
      previousStatusCode: row.previousStatusCode,
      newStatus: row.newStatus,
      newStatusCode: row.newStatusCode,
      remarks: row.remarks,
      lostReasonCode: row.lostReasonCode,
      lostReason: row.lostReasonCode
        ? lostMap.get(row.lostReasonCode) || row.lostReasonCode
        : null,
      closeReasonCode: row.closeReasonCode,
      closeReason: row.closeReasonCode
        ? closeMap.get(row.closeReasonCode) || row.closeReasonCode
        : null,
      isOverride: row.isOverride,
      overrideReason: row.overrideReason,
      updatedBy: row.createdBy
        ? { id: row.createdBy.id, name: row.createdBy.fullName }
        : null,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

const ASSIGNEE_ROLE_KEYS = ["call_executive", "counsellor"] as const;
const ACTIVITY_TYPE_LABEL: Record<string, string> = {
  CALL: "Call logged",
  MESSAGE: "Message sent",
  MEETING: "Meeting logged",
  EMAIL: "Email sent",
  NOTE: "Note added",
  FOLLOW_UP: "Follow-up scheduled",
};

function parseIsoDate(value?: string, endOfDay = false) {
  const text = value?.trim();
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
  return new Date(`${text}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
}

function openFollowUpWhere(): Prisma.FollowUpWhereInput {
  return { status: { notIn: [...FOLLOW_UP_CLOSED_STATUSES] } };
}

function followUpStatusLeadWhere(
  status: string | undefined,
  startToday: Date,
  startTomorrow: Date,
): Prisma.LeadWhereInput {
  const key = status?.trim().toLowerCase();
  const open = openFollowUpWhere();
  if (key === "pending") return { followUps: { some: open } };
  if (key === "today") {
    return {
      followUps: {
        some: {
          AND: [open, { dueAt: { gte: startToday, lt: startTomorrow } }],
        },
      },
    };
  }
  if (key === "overdue") {
    return {
      followUps: { some: { AND: [open, { dueAt: { lt: startToday } }] } },
    };
  }
  return {};
}

function lastActivityLabel(activity: {
  type: string;
  notes: string | null;
  outcome: string | null;
}) {
  const notes = activity.notes?.trim();
  if (notes) return notes.length > 48 ? `${notes.slice(0, 45)}…` : notes;
  if (activity.outcome?.trim()) return activity.outcome.trim();
  return ACTIVITY_TYPE_LABEL[activity.type] || "Activity";
}

export async function listMyLeads(
  auth: AuthContext,
  query: {
    search?: string;
    page?: number;
    limit?: number;
    status?: string;
    source?: string;
    priority?: string;
    country?: string;
    followUpStatus?: string;
    sort?: string;
    order?: string;
  },
) {
  if (!hasPermission(auth.permissions, "lead:view")) {
    throw httpError.accessDenied(
      "You do not have permission to access this page.",
    );
  }

  const search = query.search?.trim();
  const page = Math.max(1, query.page || 1);
  const limit = Math.min(50, Math.max(10, query.limit || 10));
  const status = query.status?.trim();
  const source = query.source?.trim();
  const priority = query.priority?.trim();
  const country = query.country?.trim();
  const followUpStatus = query.followUpStatus?.trim();
  const sort =
    query.sort?.trim().toLowerCase() === "priority" ? "priority" : "assigned";
  const order = query.order?.trim().toLowerCase() === "asc" ? "asc" : "desc";

  await prisma.followUp.updateMany({
    where: {
      status: { in: ["Pending", "Due Soon"] },
      dueAt: { lt: new Date() },
      lead: myLeadsOwnerWhere(auth),
    },
    data: { status: "Overdue" },
  });
  const ownerWhere = myLeadsOwnerWhere(auth);
  const now = new Date();
  const startToday = startOfUtcDay(now);
  const startTomorrow = addUtcDays(startToday, 1);
  const searchDigits = search ? search.replace(/\D/g, "") : "";

  const listWhere: Prisma.LeadWhereInput = {
    AND: [
      ownerWhere,
      { archivedAt: null },
      status ? { status: { equals: status, mode: "insensitive" } } : {},
      source ? { source: { contains: source, mode: "insensitive" } } : {},
      priority ? { priority: { equals: priority, mode: "insensitive" } } : {},
      country ? { country: { contains: country, mode: "insensitive" } } : {},
      followUpStatusLeadWhere(followUpStatus, startToday, startTomorrow),
      search
        ? {
            OR: [
              { code: { contains: search, mode: "insensitive" } },
              { name: { contains: search, mode: "insensitive" } },
              { phone: { contains: search, mode: "insensitive" } },
              ...(searchDigits.length >= 3
                ? [{ phoneNormalized: { contains: searchDigits } }]
                : []),
            ],
          }
        : {},
    ],
  };

  try {
    const matching = await prisma.lead.findMany({
      where: listWhere,
      select: { id: true, createdAt: true, priority: true },
    });

    const assignmentDates =
      matching.length === 0
        ? []
        : await prisma.leadAssignment.groupBy({
            by: ["leadId"],
            where: {
              leadId: { in: matching.map((lead) => lead.id) },
              toOwnerId: auth.user.id,
            },
            _max: { createdAt: true },
          });
    const assignedAt = new Map(
      assignmentDates.map((row) => [
        row.leadId,
        row._max.createdAt?.getTime() || 0,
      ]),
    );

    const direction = order === "asc" ? 1 : -1;
    matching.sort((a, b) => {
      if (sort === "priority") {
        const diff =
          (priorityRank(a.priority) - priorityRank(b.priority)) * direction;
        if (diff !== 0) return diff;
      }
      const aTime = assignedAt.get(a.id) || a.createdAt.getTime();
      const bTime = assignedAt.get(b.id) || b.createdAt.getTime();
      return (aTime - bTime) * (sort === "priority" ? -1 : direction);
    });

    const total = matching.length;
    const pageIds = matching
      .slice((page - 1) * limit, page * limit)
      .map((lead) => lead.id);
    const [rows, nextFollowUps, lastActivities, summary] = await Promise.all([
      pageIds.length
        ? prisma.lead.findMany({
            where: { id: { in: pageIds } },
            include: leadInclude,
          })
        : Promise.resolve([]),
      pageIds.length
        ? prisma.followUp.findMany({
            where: { leadId: { in: pageIds }, AND: [openFollowUpWhere()] },
            orderBy: [
              { dueAt: { sort: "asc", nulls: "last" } },
              { createdAt: "desc" },
            ],
          })
        : Promise.resolve([]),
      pageIds.length
        ? prisma.activity.findMany({
            where: { relatedType: "lead", relatedId: { in: pageIds } },
            orderBy: { occurredAt: "desc" },
          })
        : Promise.resolve([]),
      Promise.all([
        prisma.lead.count({
          where: { AND: [ownerWhere, { archivedAt: null }] },
        }),
        prisma.lead.count({
          where: {
            AND: [
              ownerWhere,
              { archivedAt: null },
              { priority: { equals: "High", mode: "insensitive" } },
            ],
          },
        }),
        prisma.followUp.count({
          where: {
            AND: [
              openFollowUpWhere(),
              { lead: { AND: [ownerWhere, { archivedAt: null }] } },
            ],
          },
        }),
        prisma.followUp.count({
          where: {
            AND: [
              openFollowUpWhere(),
              { dueAt: { gte: startToday, lt: startTomorrow } },
              { lead: { AND: [ownerWhere, { archivedAt: null }] } },
            ],
          },
        }),
        prisma.followUp.count({
          where: {
            AND: [
              openFollowUpWhere(),
              { dueAt: { lt: startToday } },
              { lead: { AND: [ownerWhere, { archivedAt: null }] } },
            ],
          },
        }),
      ]).then(
        ([
          totalAssigned,
          highPriority,
          pendingFollowUps,
          todayFollowUps,
          overdueFollowUps,
        ]) => ({
          totalAssigned,
          highPriority,
          pendingFollowUps,
          todayFollowUps,
          overdueFollowUps,
        }),
      ),
    ]);

    const byId = new Map(rows.map((lead) => [lead.id, lead]));
    const nextByLead = new Map<string, (typeof nextFollowUps)[number]>();
    for (const followUp of nextFollowUps) {
      if (followUp.leadId && !nextByLead.has(followUp.leadId))
        nextByLead.set(followUp.leadId, followUp);
    }
    const activityByLead = new Map<string, (typeof lastActivities)[number]>();
    for (const activity of lastActivities) {
      if (activity.relatedId && !activityByLead.has(activity.relatedId)) {
        activityByLead.set(activity.relatedId, activity);
      }
    }
    const sharedPhones = await sharedPhoneNormalizedSet(
      rows.map((lead) => lead.phoneNormalized),
    );

    return {
      items: pageIds.flatMap((id) => {
        const lead = byId.get(id);
        if (!lead) return [];
        const next = nextByLead.get(id);
        const activity = activityByLead.get(id);
        const assignedMs = assignedAt.get(id);
        const scored = displayedLeadScore(lead);
        return [
          {
            id: lead.id,
            code: lead.code,
            name: lead.name,
            phone: lead.phone || "—",
            country: lead.country || "—",
            status: lead.status,
            score: scored.score,
            priority: scored.priority || "—",
            nextFollowUpAt: next?.dueAt ? next.dueAt.toISOString() : null,
            lastActivity: activity ? lastActivityLabel(activity) : "—",
            lastActivityAt: activity ? activity.occurredAt.toISOString() : null,
            assignedAt: assignedMs
              ? new Date(assignedMs).toISOString()
              : lead.createdAt.toISOString(),
            isDuplicate: lead.isDuplicate,
            hasPhoneDuplicate: Boolean(
              lead.phoneNormalized && sharedPhones.has(lead.phoneNormalized),
            ),
            duplicateOfLeadId: lead.duplicateOfLeadId,
            duplicateOf: lead.duplicateOf
              ? {
                  id: lead.duplicateOf.id,
                  code: lead.duplicateOf.code,
                  name: lead.duplicateOf.name,
                }
              : null,
          },
        ];
      }),
      total,
      page,
      limit,
      summary,
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error(error);
    throw search
      ? httpError.myLeadsSearchFailed()
      : httpError.myLeadsLoadFailed();
  }
}

export async function listLeadPool(
  auth: AuthContext,
  query: {
    search?: string;
    page?: number;
    limit?: number;
    source?: string;
    country?: string;
    createdFrom?: string;
    createdTo?: string;
  },
) {
  if (!hasPermission(auth.permissions, "lead:assign")) {
    throw httpError.accessDenied(
      "You do not have permission to access the Lead Pool.",
    );
  }

  try {
    const search = query.search?.trim();
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(50, Math.max(10, query.limit || 10));
    const source = query.source?.trim();
    const country = query.country?.trim();
    const createdFrom = parseIsoDate(query.createdFrom);
    const createdTo = parseIsoDate(query.createdTo, true);

    const listWhere: Prisma.LeadWhereInput = {
      AND: [
        leadPoolScopeWhere(auth),
        { archivedAt: null },
        source ? { source: { contains: source, mode: "insensitive" } } : {},
        country ? { country: { contains: country, mode: "insensitive" } } : {},
        createdFrom || createdTo
          ? {
              createdAt: {
                ...(createdFrom ? { gte: createdFrom } : {}),
                ...(createdTo ? { lte: createdTo } : {}),
              },
            }
          : {},
        search
          ? {
              OR: [
                { code: { contains: search, mode: "insensitive" } },
                { name: { contains: search, mode: "insensitive" } },
                { phone: { contains: search, mode: "insensitive" } },
              ],
            }
          : {},
      ],
    };

    const [total, rows] = await Promise.all([
      prisma.lead.count({ where: listWhere }),
      prisma.lead.findMany({
        where: listWhere,
        include: leadInclude,
        orderBy: { createdAt: "asc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const sharedPhones = await sharedPhoneNormalizedSet(
      rows.map((lead) => lead.phoneNormalized),
    );

    return {
      items: rows.map((lead) => ({
        id: lead.id,
        code: lead.code,
        name: lead.name,
        phone: lead.phone || "—",
        country: lead.country || "—",
        source: lead.source || "—",
        assignedTeam: lead.assignedCountryTeam
          ? {
              id: lead.assignedCountryTeam.id,
              name: lead.assignedCountryTeam.name,
            }
          : null,
        createdAt: lead.createdAt.toISOString(),
        waitingTime: formatWaitingTime(lead.createdAt),
        isDuplicate: lead.isDuplicate,
        hasPhoneDuplicate: Boolean(
          lead.phoneNormalized && sharedPhones.has(lead.phoneNormalized),
        ),
        duplicateOfLeadId: lead.duplicateOfLeadId,
        duplicateOf: lead.duplicateOf
          ? {
              id: lead.duplicateOf.id,
              code: lead.duplicateOf.code,
              name: lead.duplicateOf.name,
            }
          : null,
      })),
      total,
      page,
      limit,
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error(error);
    throw httpError.leadPoolLoadFailed();
  }
}

export async function listLeadAssignees(
  auth: AuthContext,
  query: { teamId?: string; search?: string; role?: string },
) {
  if (
    !hasPermission(auth.permissions, [
      "lead:assign",
      "lead:reassign",
      "lead:reopen",
      "lead:handover",
    ])
  ) {
    throw httpError.accessDenied();
  }

  const search = query.search?.trim();
  const teamId = query.teamId?.trim();
  const role =
    query.role === "counsellor" || query.role === "call_executive"
      ? query.role
      : undefined;
  const users = await prisma.user.findMany({
    where: {
      AND: [
        leadEligibleAssigneeWhere(),
        role === "counsellor" ? {} : assigneeVisibilityWhere(auth),
        role
          ? { primaryRole: { key: role } }
          : { primaryRole: { key: { in: [...ASSIGNEE_ROLE_KEYS] } } },
        teamId ? { teamId } : {},
        search
          ? {
              OR: [
                { fullName: { contains: search, mode: "insensitive" } },
                { email: { contains: search, mode: "insensitive" } },
              ],
            }
          : {},
      ],
    },
    include: {
      primaryRole: { select: { key: true, name: true } },
      team: { select: { id: true, name: true } },
    },
    orderBy: { fullName: "asc" },
  });

  return {
    items: users.map((user) => ({
      id: user.id,
      name: user.fullName,
      role: user.primaryRole
        ? { key: user.primaryRole.key, name: user.primaryRole.name }
        : null,
      team: user.team ? { id: user.team.id, name: user.team.name } : null,
    })),
  };
}

export async function assignLead(
  auth: AuthContext,
  id: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  const {
    lead: current,
    canAssign,
    canReassign,
  } = await assertCanManageLeadAssignment(auth, id);
  const isUnassigned = !current.ownerId;
  if (isUnassigned && !canAssign) {
    throw httpError.accessDenied();
  }
  if (!isUnassigned && !canReassign) {
    throw httpError.accessDenied();
  }

  const ownerId = asString(body.ownerId);
  const fields: Record<string, string> = {};
  if (!ownerId) fields.ownerId = "Please select a user to assign this lead.";
  throwIfInvalid(fields);
  if (ownerId === current.ownerId) {
    throw httpError.validation({
      ownerId: "This lead is already assigned to the selected user.",
    });
  }

  const assignee = await prisma.user.findFirst({
    where: {
      id: ownerId,
      AND: [leadEligibleAssigneeWhere(), assigneeVisibilityWhere(auth)],
    },
    include: { team: { select: { id: true, name: true } } },
  });
  if (!assignee) {
    throw httpError.badRequest("The selected user cannot receive this lead.");
  }

  const reason =
    asOptionalString(body.reason, 400) ||
    (isUnassigned ? "Assigned from Lead Pool" : "Lead reassigned");
  const fromOwnerId = current.ownerId;
  const fromOwnerName = current.ownerName;
  const teamId = assignee.teamId || current.assignedCountryTeamId;

  try {
    const lead = await prisma.$transaction(async (tx) => {
      const updated = await tx.lead.update({
        where: { id },
        data: {
          ownerId: assignee.id,
          ownerName: assignee.fullName,
          assignedCountryTeamId: teamId,
          updatedById: auth.user.id,
        },
        include: leadInclude,
      });
      await tx.leadAssignment.create({
        data: {
          leadId: id,
          fromOwnerId,
          toOwnerId: assignee.id,
          teamId,
          reason,
          createdById: auth.user.id,
        },
      });
      await tx.activity.create({
        data: {
          type: "NOTE",
          userId: auth.user.id,
          notes: isUnassigned
            ? `Lead assigned to ${assignee.fullName}`
            : `Lead reassigned from ${fromOwnerName || "Unassigned"} to ${assignee.fullName}`,
          relatedName: updated.name,
          relatedType: "lead",
          relatedId: updated.id,
          outcome: "Assigned",
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
      });
      return updated;
    });

    await writeAuditLog({
      userId: auth.user.id,
      action: "LEAD_ASSIGNED",
      entityType: "lead",
      entityId: lead.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: {
        code: lead.code,
        fromOwnerId,
        toOwnerId: assignee.id,
        toOwnerName: assignee.fullName,
        reason,
        relatedName: lead.name,
        name: lead.name,
      },
    });

    // Auto first follow-up on assignment (CRM-005 Rule-18)
    try {
      const { createSystemFollowUp, daysFromNow } =
        await import("../follow-ups/system-follow-up");
      await createSystemFollowUp({
        leadId: lead.id,
        contactName: lead.name,
        type: "Call",
        purpose: "Initial Contact",
        nextAction: "Make first contact call",
        dueAt: daysFromNow(1),
        priority: lead.priority || "Medium",
        ownerId: assignee.id,
        ownerName: assignee.fullName,
        reason: isUnassigned
          ? "Lead Assigned — First Follow-up"
          : "Lead Reassigned — First Follow-up",
        actorUserId: auth.user.id,
        meta,
      });
      const { createNotification } =
        await import("../notifications/notifications.service");
      await createNotification({
        userId: assignee.id,
        title: isUnassigned ? "New Lead Assigned" : "Lead Reassigned to You",
        body: `${lead.code} — ${lead.name} is now assigned to you.`,
        link: `/leads/${lead.id}`,
        type: "lead_assigned",
        leadId: lead.id,
        dedupeKey: `lead-assigned:${lead.id}:${assignee.id}:${Date.now()}`,
      });
    } catch (error) {
      console.error("[follow-ups] Auto follow-up on assign failed:", error);
    }

    return {
      lead: serializeLead(lead),
      message: isUnassigned
        ? "Lead assigned successfully."
        : "Lead reassigned successfully.",
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error(error);
    throw httpError.assignmentFailed();
  }
}

export async function listLeadAssignments(auth: AuthContext, id: string) {
  await assertCanViewLead(auth, id);
  const rows = await prisma.leadAssignment.findMany({
    where: { leadId: id },
    include: {
      fromOwner: { select: { id: true, fullName: true } },
      toOwner: { select: { id: true, fullName: true } },
      createdBy: { select: { id: true, fullName: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return {
    items: rows.map((row) => ({
      id: row.id,
      fromOwner: row.fromOwner
        ? { id: row.fromOwner.id, name: row.fromOwner.fullName }
        : null,
      toOwner: row.toOwner
        ? { id: row.toOwner.id, name: row.toOwner.fullName }
        : null,
      kind: row.kind,
      reason: row.reason,
      handoverNote: row.handoverNote,
      assignedBy: row.createdBy
        ? { id: row.createdBy.id, name: row.createdBy.fullName }
        : null,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

type DuplicateReviewAction = "keep" | "cancel_duplicate" | "archive" | "delete";

export async function reviewDuplicateLead(
  auth: AuthContext,
  id: string,
  body: Record<string, unknown>,
  meta: AuditMeta,
) {
  if (!hasPermission(auth.permissions, "lead:manage_duplicate")) {
    throw httpError.accessDenied(
      "You do not have permission to review duplicate leads.",
    );
  }

  const action = asString(body.action).toLowerCase() as DuplicateReviewAction;
  if (!["keep", "cancel_duplicate", "archive", "delete"].includes(action)) {
    throw httpError.badRequest(
      "Please choose a valid duplicate review action.",
    );
  }

  const current = await assertCanViewLead(auth, id);

  if (
    action === "delete" &&
    !hasPermission(auth.permissions, "lead:delete") &&
    !(
      current.isDuplicate &&
      hasPermission(auth.permissions, "lead:manage_duplicate")
    )
  ) {
    throw httpError.accessDenied("You do not have permission to delete leads.");
  }

  if (action === "keep") {
    const lead = await prisma.lead.update({
      where: { id },
      data: {
        isDuplicate: false,
        duplicateOfLeadId: null,
        updatedById: auth.user.id,
      },
      include: leadInclude,
    });
    await writeAuditLog({
      userId: auth.user.id,
      action: "LEAD_DUPLICATE_KEEP",
      entityType: "lead",
      entityId: id,
      metadata: { previousDuplicateOfLeadId: current.duplicateOfLeadId },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    return {
      lead: serializeLead(lead),
      message: "Lead kept. Duplicate flag cleared.",
    };
  }

  if (action === "cancel_duplicate") {
    if (!current.isDuplicate && !current.duplicateOfLeadId) {
      throw httpError.badRequest("This lead is not marked as a duplicate.");
    }
    const items = await loadLeadStatusItems();
    const duplicateStatus = items.find(
      (item) => item.code === "DUPLICATE" && item.status === "ACTIVE",
    );
    if (!duplicateStatus) {
      throw httpError.badRequest(
        "Duplicate status is not configured in master data.",
      );
    }
    const currentStatus = resolveLeadStatus(current, items);

    const lead = await prisma.$transaction(async (tx) => {
      const updated = await tx.lead.update({
        where: { id },
        data: {
          status: duplicateStatus.name,
          statusCode: duplicateStatus.code,
          closeReasonCode: "DUPLICATE",
          isDuplicate: true,
          updatedById: auth.user.id,
        },
        include: leadInclude,
      });
      await tx.leadStatusHistory.create({
        data: {
          leadId: id,
          previousStatus: currentStatus?.name || current.status,
          previousStatusCode: currentStatus?.code || current.statusCode,
          newStatus: duplicateStatus.name,
          newStatusCode: duplicateStatus.code!,
          remarks: "Marked as duplicate during admin review.",
          closeReasonCode: "DUPLICATE",
          createdById: auth.user.id,
        },
      });
      await tx.followUp.updateMany({
        where: {
          leadId: id,
          status: { notIn: [...FOLLOW_UP_CLOSED_STATUSES] },
        },
        data: { status: "Cancelled" },
      });
      return updated;
    });

    await writeAuditLog({
      userId: auth.user.id,
      action: "LEAD_DUPLICATE_CANCEL",
      entityType: "lead",
      entityId: id,
      metadata: { duplicateOfLeadId: current.duplicateOfLeadId },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    return {
      lead: serializeLead(lead),
      message: "Lead cancelled as duplicate.",
    };
  }

  if (action === "archive") {
    const lead = await prisma.lead.update({
      where: { id },
      data: {
        archivedAt: new Date(),
        updatedById: auth.user.id,
      },
      include: leadInclude,
    });
    await writeAuditLog({
      userId: auth.user.id,
      action: "LEAD_ARCHIVE",
      entityType: "lead",
      entityId: id,
      metadata: {
        isDuplicate: current.isDuplicate,
        duplicateOfLeadId: current.duplicateOfLeadId,
      },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    return {
      lead: serializeLead(lead),
      message: "Lead archived and removed from the active list.",
    };
  }

  // delete
  const offers = await prisma.serviceOffer.count({ where: { leadId: id } });
  if (offers > 0) {
    throw httpError.conflict(
      "This lead has service offers. Archive it instead of deleting.",
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.leadDocument.deleteMany({ where: { leadId: id } });
    await tx.leadNote.deleteMany({ where: { leadId: id } });
    await tx.followUp.deleteMany({ where: { leadId: id } });
    await tx.leadAssignment.deleteMany({ where: { leadId: id } });
    await tx.leadStatusHistory.deleteMany({ where: { leadId: id } });
    await tx.leadQualificationHistory.deleteMany({ where: { leadId: id } });
    await tx.leadCampaignTouch.deleteMany({ where: { leadId: id } });
    await tx.leadAttributionChange.deleteMany({ where: { leadId: id } });
    await tx.notification.deleteMany({ where: { leadId: id } });
    await tx.communicationEvent.updateMany({
      where: { leadId: id },
      data: { leadId: null },
    });
    await tx.metaLead.updateMany({
      where: { leadId: id },
      data: { leadId: null },
    });
    await tx.whatsAppConversation.updateMany({
      where: { leadId: id },
      data: { leadId: null },
    });
    await tx.emailThread.updateMany({
      where: { leadId: id },
      data: { leadId: null },
    });
    await tx.activity.deleteMany({
      where: { relatedType: "lead", relatedId: id },
    });
    await tx.lead.updateMany({
      where: { duplicateOfLeadId: id },
      data: { duplicateOfLeadId: null },
    });
    await tx.lead.delete({ where: { id } });
  });

  await writeAuditLog({
    userId: auth.user.id,
    action: "LEAD_DELETE",
    entityType: "lead",
    entityId: id,
    metadata: {
      code: current.code,
      name: current.name,
      isDuplicate: current.isDuplicate,
      duplicateOfLeadId: current.duplicateOfLeadId,
    },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });

  return { message: "Lead deleted permanently." };
}
