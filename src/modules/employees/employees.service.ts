import { randomUUID } from "node:crypto";
import type { Prisma, UserStatus } from "../../lib/prisma-client";
import { writeAuditLog } from "../../lib/audit";
import { httpError } from "../../lib/http-error";
import { prisma } from "../../lib/prisma";
import {
  exportCell,
  exportFileStamp,
  formatExportDate,
  type TabularExport,
} from "../../lib/xlsx-export";
import {
  defaultScopesForRole,
  hasPermission,
  shouldDisableCrmForEmploymentStatus,
} from "../auth/access";
import { normalizeEmail, normalizeUsername } from "../auth/identifier";
import { hashPassword } from "../auth/password";
import { sendAccountInvite } from "../auth/password-reset.service";
import type { AuthContext } from "../auth/session.service";
import { getFollowUpPerformance } from "../pipeline/follow-up-performance.service";
import {
  destroyStoredUpload,
  DOCUMENT_FIELD_MAP,
  readEmployeeFile,
  removeEmployeeFiles,
  saveDocuments,
  saveProfilePhoto,
  type DocumentFieldName,
} from "./employees.storage";

const ENTITY = "employee";

const employeeInclude = {
  designation: true,
  employmentType: true,
  employmentStatus: true,
  department: true,
  team: true,
  role: true,
  reportingManager: {
    select: { id: true, fullName: true, employeeCode: true },
  },
  user: { select: { id: true, status: true, username: true } },
  documents: { orderBy: { createdAt: "asc" } },
} as const;

type AuditMeta = { ipAddress?: string; userAgent?: string };
type EmployeeRecord = Prisma.EmployeeGetPayload<{
  include: typeof employeeInclude;
}>;

export type EmployeeListQuery = {
  search?: string;
  departmentId?: string;
  teamId?: string;
  designationId?: string;
  roleId?: string;
  employmentTypeId?: string;
  employmentStatusId?: string;
  reportingManagerId?: string;
  joiningFrom?: string;
  joiningTo?: string;
};

const GENDERS = new Set(["MALE", "FEMALE", "OTHER"]);
const MARITAL_STATUSES = new Set([
  "SINGLE",
  "MARRIED",
  "DIVORCED",
  "WIDOWED",
  "OTHER",
]);
const USER_STATUSES = new Set(["ACTIVE", "INACTIVE", "SUSPENDED", "INVITED"]);

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function asOptionalString(value: unknown, max = 200) {
  const text = asString(value);
  return text ? text.slice(0, max) : null;
}

function parseBoolean(value: unknown) {
  if (value === true || value === "true" || value === "1" || value === "on") {
    return true;
  }
  return false;
}

function parseGender(value: unknown, fields: Record<string, string>) {
  const text = asString(value).toUpperCase();
  if (!text) {
    return null;
  }
  if (!GENDERS.has(text)) {
    fields.gender = "Please select a valid gender.";
    return null;
  }
  return text as "MALE" | "FEMALE" | "OTHER";
}

function parseMaritalStatus(value: unknown, fields: Record<string, string>) {
  const text = asString(value).toUpperCase();
  if (!text) {
    return null;
  }
  if (!MARITAL_STATUSES.has(text)) {
    fields.maritalStatus = "Please select a valid marital status.";
    return null;
  }
  return text as "SINGLE" | "MARRIED" | "DIVORCED" | "WIDOWED" | "OTHER";
}

function parseUserStatus(value: unknown, fields: Record<string, string>) {
  const text = asString(value).toUpperCase() || "ACTIVE";
  if (!USER_STATUSES.has(text)) {
    fields.userStatus = "Please select a valid account status.";
    return "ACTIVE" as UserStatus;
  }
  return text as UserStatus;
}

function throwIfInvalid(fields: Record<string, string>) {
  if (Object.keys(fields).length > 0) {
    throw httpError.validation(fields);
  }
}

function parseMobile(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/[\s()-]/g, "");
}

function isValidMobile(value: string) {
  return /^\+?[0-9]{10,15}$/.test(value);
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function parseDateOnly(
  value: unknown,
  label: string,
  required = true,
  fields?: Record<string, string>,
  key?: string,
) {
  if (value == null || value === "") {
    if (required) {
      if (fields && key) {
        fields[key] = `${label} is required.`;
        return null;
      }
      throw httpError.badRequest(`${label} is required.`);
    }
    return null;
  }
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    if (fields && key) {
      fields[key] = `Please enter a valid ${label.toLowerCase()}.`;
      return null;
    }
    throw httpError.badRequest(`Please enter a valid ${label.toLowerCase()}.`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    if (fields && key) {
      fields[key] = `Please enter a valid ${label.toLowerCase()}.`;
      return null;
    }
    throw httpError.badRequest(`Please enter a valid ${label.toLowerCase()}.`);
  }
  return date;
}

function dateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

function crmAccess(user: { status: string } | null) {
  if (!user) {
    return "NONE";
  }
  if (user.status === "ACTIVE") {
    return "ENABLED";
  }
  if (user.status === "INVITED") {
    return "INVITED";
  }
  return "DISABLED";
}

function rethrowUnique(error: unknown): never {
  if (
    typeof error === "object" &&
    error &&
    "code" in error &&
    error.code === "P2002"
  ) {
    const target =
      "meta" in error
        ? JSON.stringify(
            (error as { meta?: { target?: unknown } }).meta?.target,
          )
        : "";
    if (target.includes("username")) {
      throw httpError.duplicateUsername();
    }
    if (target.includes("email") && !target.includes("official")) {
      throw httpError.duplicateEmail();
    }
    if (target.includes("official_email") || target.includes("officialEmail")) {
      throw httpError.duplicateEmployeeEmail();
    }
    if (target.includes("employee_code") || target.includes("employeeCode")) {
      throw httpError.duplicateEmployeeCode();
    }
  }
  throw error;
}

function visibilityWhere(auth: AuthContext): Prisma.EmployeeWhereInput {
  const scope = auth.dataScopes.employee_performance ?? "OWN";

  if (scope === "ALL") {
    return {};
  }

  if (scope === "DEPARTMENT" && auth.user.departmentId) {
    return { departmentId: auth.user.departmentId };
  }

  if (scope === "TEAM" && auth.user.teamId) {
    return { teamId: auth.user.teamId };
  }

  return { userId: auth.user.id };
}

async function assertCanViewEmployee(auth: AuthContext, employeeId: string) {
  const visible = await prisma.employee.findFirst({
    where: { id: employeeId, AND: [visibilityWhere(auth)] },
    select: { id: true },
  });
  if (!visible) {
    throw httpError.notFound("Employee not found.");
  }
}

async function resolveMasterData(
  categoryKey: string,
  id: unknown,
  label: string,
  required = true,
) {
  if (id == null || id === "") {
    if (required) {
      throw httpError.badRequest(`${label} is required.`);
    }
    return null;
  }
  if (typeof id !== "string") {
    throw httpError.badRequest(`${label} is not available.`);
  }
  const item = await prisma.masterDataItem.findUnique({ where: { id } });
  if (!item || item.categoryKey !== categoryKey || item.status !== "ACTIVE") {
    throw httpError.badRequest(`${label} is not available.`);
  }
  return item;
}

async function resolveDepartment(departmentId: unknown) {
  if (typeof departmentId !== "string" || !departmentId) {
    throw httpError.badRequest("Department is required.");
  }
  const department = await prisma.department.findUnique({
    where: { id: departmentId },
  });
  if (!department || department.status !== "ACTIVE") {
    throw httpError.badRequest("Department is not available.");
  }
  return department;
}

async function resolveTeam(teamId: unknown, departmentId: string) {
  if (teamId == null || teamId === "") {
    return null;
  }
  if (typeof teamId !== "string") {
    throw httpError.badRequest("Team is not available.");
  }
  const team = await prisma.team.findUnique({ where: { id: teamId } });
  if (!team || team.status !== "ACTIVE") {
    throw httpError.badRequest("Team is not available.");
  }
  if (team.departmentId !== departmentId) {
    throw httpError.badRequest("Team must belong to the selected department.");
  }
  return team;
}

async function resolveRole(roleId: unknown) {
  if (roleId == null || roleId === "") {
    return null;
  }
  if (typeof roleId !== "string") {
    throw httpError.badRequest("Role is not available.");
  }
  const role = await prisma.role.findUnique({ where: { id: roleId } });
  if (!role || role.status !== "ACTIVE") {
    throw httpError.badRequest("Role is not available.");
  }
  return role;
}

async function resolveManager(
  managerId: unknown,
  options: { currentId?: string; existingManagerId?: string | null } = {},
) {
  if (managerId == null || managerId === "") {
    return null;
  }
  if (typeof managerId !== "string") {
    throw httpError.badRequest("Reporting manager is not available.");
  }
  if (options.currentId && managerId === options.currentId) {
    throw httpError.badRequest("An employee cannot report to themselves.");
  }
  const keepExisting = Boolean(
    options.existingManagerId && managerId === options.existingManagerId,
  );
  const manager = await prisma.employee.findFirst({
    where: {
      id: managerId,
      ...(keepExisting ? {} : { employmentStatus: { code: "ACTIVE" } }),
    },
    select: { id: true },
  });
  if (!manager) {
    throw httpError.badRequest("Reporting manager is not available.");
  }
  return manager;
}

async function employmentStatusByCode(code: string) {
  const item = await prisma.masterDataItem.findFirst({
    where: { categoryKey: "EMPLOYMENT_STATUS", code },
    orderBy: { status: "asc" },
  });
  if (!item) {
    throw httpError.badRequest("Employment status is not available.");
  }
  return item;
}

function canViewSensitiveEmployee(
  auth: AuthContext,
  employeeUserId: string | null,
) {
  if (hasPermission(auth.permissions, "employee:sensitive")) {
    return true;
  }
  return Boolean(employeeUserId && employeeUserId === auth.user.id);
}

function canViewEmployeeDocuments(
  auth: AuthContext,
  employeeUserId: string | null,
) {
  if (hasPermission(auth.permissions, "employee_document:view")) {
    return true;
  }
  return Boolean(employeeUserId && employeeUserId === auth.user.id);
}

export function canManageEmployeeDocuments(auth: AuthContext) {
  return hasPermission(auth.permissions, "employee_document:manage");
}

async function syncCrmAccountForEmploymentStatus(
  employee: { userId: string | null },
  statusCode: string | null | undefined,
) {
  if (!employee.userId) {
    return { crmDisabled: false, crmRestored: false };
  }

  if (shouldDisableCrmForEmploymentStatus(statusCode)) {
    const updated = await prisma.user.updateMany({
      where: { id: employee.userId, status: { in: ["ACTIVE", "INVITED"] } },
      data: { status: "INACTIVE" },
    });
    return { crmDisabled: updated.count > 0, crmRestored: false };
  }

  if (
    statusCode === "ACTIVE" ||
    statusCode === "PROBATION" ||
    statusCode === "ON_LEAVE"
  ) {
    const updated = await prisma.user.updateMany({
      where: { id: employee.userId, status: "INACTIVE" },
      data: { status: "ACTIVE" },
    });
    return { crmDisabled: false, crmRestored: updated.count > 0 };
  }

  return { crmDisabled: false, crmRestored: false };
}

async function nextEmployeeCode() {
  const last = await prisma.employee.findFirst({
    where: { employeeCode: { startsWith: "EMP-" } },
    orderBy: { employeeCode: "desc" },
    select: { employeeCode: true },
  });
  const match = last?.employeeCode.match(/^EMP-(\d+)$/);
  const next = (match ? Number(match[1]) : 0) + 1;
  return `EMP-${String(next).padStart(4, "0")}`;
}

function namedRef(item: { id: string; name: string } | null) {
  return item ? { id: item.id, name: item.name } : null;
}

function serializeEmployee(employee: EmployeeRecord, auth?: AuthContext) {
  const showSensitive = auth
    ? canViewSensitiveEmployee(auth, employee.userId)
    : true;
  const showDocuments = auth
    ? canViewEmployeeDocuments(auth, employee.userId)
    : true;

  return {
    id: employee.id,
    employeeCode: employee.employeeCode,
    fullName: employee.fullName,
    mobile: employee.mobile,
    officialEmail: employee.officialEmail,
    photoUrl: employee.photoUrl,
    gender: employee.gender,
    dateOfBirth: employee.dateOfBirth ? dateOnly(employee.dateOfBirth) : null,
    nationality: employee.nationality,
    identityNumber: showSensitive ? employee.identityNumber : null,
    maritalStatus: employee.maritalStatus,
    personalEmail: employee.personalEmail,
    presentAddress: employee.presentAddress,
    permanentAddress: employee.permanentAddress,
    emergencyName: showSensitive ? employee.emergencyName : null,
    emergencyRelationship: showSensitive
      ? employee.emergencyRelationship
      : null,
    emergencyMobile: showSensitive ? employee.emergencyMobile : null,
    emergencyAddress: showSensitive ? employee.emergencyAddress : null,
    documents: showDocuments
      ? employee.documents.map((item) => ({
          id: item.id,
          type: item.type,
          fileName: item.fileName,
          mimeType: item.mimeType,
          fileSize: item.fileSize,
        }))
      : [],
    canViewDocuments: showDocuments,
    canManageDocuments: auth ? canManageEmployeeDocuments(auth) : false,
    canViewSensitive: showSensitive,
    designation: namedRef(employee.designation),
    department: namedRef(employee.department),
    team: namedRef(employee.team),
    role: employee.role
      ? {
          id: employee.role.id,
          name: employee.role.name,
          key: employee.role.key,
        }
      : null,
    employmentType: namedRef(employee.employmentType),
    employmentStatus: employee.employmentStatus
      ? {
          id: employee.employmentStatus.id,
          name: employee.employmentStatus.name,
          code: employee.employmentStatus.code,
        }
      : null,
    reportingManager: employee.reportingManager
      ? {
          id: employee.reportingManager.id,
          fullName: employee.reportingManager.fullName,
          employeeCode: employee.reportingManager.employeeCode,
        }
      : null,
    joiningDate: dateOnly(employee.joiningDate),
    resignationDate: employee.resignationDate
      ? dateOnly(employee.resignationDate)
      : null,
    terminationDate: employee.terminationDate
      ? dateOnly(employee.terminationDate)
      : null,
    terminationReason: showSensitive ? employee.terminationReason : null,
    terminationRemarks: showSensitive ? employee.terminationRemarks : null,
    rejoiningDate: employee.rejoiningDate
      ? dateOnly(employee.rejoiningDate)
      : null,
    crmAccess: crmAccess(employee.user),
    user: employee.user,
    createdAt: employee.createdAt,
    updatedAt: employee.updatedAt,
  };
}

function searchWhere(search?: string): Prisma.EmployeeWhereInput {
  const query = search?.trim();
  if (!query) {
    return {};
  }
  return {
    OR: [
      { employeeCode: { contains: query, mode: "insensitive" } },
      { fullName: { contains: query, mode: "insensitive" } },
      { mobile: { contains: query } },
      { officialEmail: { contains: query, mode: "insensitive" } },
      { designation: { name: { contains: query, mode: "insensitive" } } },
      { department: { name: { contains: query, mode: "insensitive" } } },
      { team: { name: { contains: query, mode: "insensitive" } } },
      { role: { name: { contains: query, mode: "insensitive" } } },
    ],
  };
}

function listWhere(
  auth: AuthContext,
  query: EmployeeListQuery,
): Prisma.EmployeeWhereInput {
  const joiningFrom = query.joiningFrom
    ? parseDateOnly(query.joiningFrom, "Joining date from", false)
    : null;
  const joiningTo = query.joiningTo
    ? parseDateOnly(query.joiningTo, "Joining date to", false)
    : null;

  return {
    AND: [
      visibilityWhere(auth),
      searchWhere(query.search),
      query.departmentId ? { departmentId: query.departmentId } : {},
      query.teamId ? { teamId: query.teamId } : {},
      query.designationId ? { designationId: query.designationId } : {},
      query.roleId ? { roleId: query.roleId } : {},
      query.employmentTypeId
        ? { employmentTypeId: query.employmentTypeId }
        : {},
      query.employmentStatusId
        ? { employmentStatusId: query.employmentStatusId }
        : {},
      query.reportingManagerId
        ? { reportingManagerId: query.reportingManagerId }
        : {},
      joiningFrom || joiningTo
        ? {
            joiningDate: {
              ...(joiningFrom ? { gte: joiningFrom } : {}),
              ...(joiningTo ? { lte: joiningTo } : {}),
            },
          }
        : {},
    ],
  };
}

export async function listEmployees(
  auth: AuthContext,
  query: EmployeeListQuery,
) {
  const employees = await prisma.employee.findMany({
    where: listWhere(auth, query),
    include: employeeInclude,
    orderBy: [{ fullName: "asc" }, { employeeCode: "asc" }],
  });
  return employees.map((employee) => serializeEmployee(employee, auth));
}

const CRM_ACCESS_LABEL: Record<string, string> = {
  ENABLED: "Enabled",
  INVITED: "Invited",
  DISABLED: "Disabled",
};

export async function exportEmployeesTable(
  auth: AuthContext,
  query: EmployeeListQuery,
): Promise<TabularExport> {
  const employees = await listEmployees(auth, query);
  return {
    title: "Employees",
    fileName: `employees-${exportFileStamp()}.xlsx`,
    columns: [
      { header: "Name", key: "name", width: 28 },
      { header: "Email", key: "email", width: 32 },
      { header: "Mobile", key: "mobile", width: 18 },
      { header: "Employee ID", key: "employeeId", width: 16 },
      { header: "Designation", key: "designation", width: 22 },
      { header: "Department", key: "department", width: 22 },
      { header: "Team", key: "team", width: 18 },
      { header: "Employment Type", key: "employmentType", width: 20 },
      { header: "Reporting Manager", key: "manager", width: 24 },
      { header: "Joining Date", key: "joiningDate", width: 16 },
      { header: "Status", key: "status", width: 16 },
      { header: "CRM Access", key: "crmAccess", width: 14 },
    ],
    rows: employees.map((employee) => ({
      name: exportCell(employee.fullName),
      email: exportCell(employee.officialEmail),
      mobile: exportCell(employee.mobile),
      employeeId: exportCell(employee.employeeCode),
      designation: exportCell(employee.designation?.name),
      department: exportCell(employee.department?.name),
      team: exportCell(employee.team?.name),
      employmentType: exportCell(employee.employmentType?.name),
      manager: exportCell(employee.reportingManager?.fullName),
      joiningDate: formatExportDate(employee.joiningDate),
      status: exportCell(employee.employmentStatus?.name),
      crmAccess: CRM_ACCESS_LABEL[employee.crmAccess] || "No access",
    })),
  };
}

export async function getEmployee(auth: AuthContext, id: string) {
  await assertCanViewEmployee(auth, id);
  const employee = await prisma.employee.findUnique({
    where: { id },
    include: employeeInclude,
  });
  if (!employee) {
    throw httpError.notFound("Employee not found.");
  }
  return serializeEmployee(employee, auth);
}

export async function listEmployeeOptions(auth: AuthContext) {
  const [
    departments,
    designations,
    employmentTypes,
    employmentStatuses,
    roles,
    managers,
  ] = await Promise.all([
    prisma.department.findMany({
      where: { status: "ACTIVE" },
      include: {
        teams: {
          where: { status: "ACTIVE" },
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        },
      },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    prisma.masterDataItem.findMany({
      where: { categoryKey: "DESIGNATION", status: "ACTIVE" },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    prisma.masterDataItem.findMany({
      where: { categoryKey: "EMPLOYMENT_TYPE", status: "ACTIVE" },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    prisma.masterDataItem.findMany({
      where: { categoryKey: "EMPLOYMENT_STATUS", status: "ACTIVE" },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    prisma.role.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, key: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.employee.findMany({
      where: {
        AND: [visibilityWhere(auth), { employmentStatus: { code: "ACTIVE" } }],
      },
      select: { id: true, fullName: true, employeeCode: true },
      orderBy: { fullName: "asc" },
    }),
  ]);

  return {
    departments: departments.map((item) => ({
      id: item.id,
      name: item.name,
      teams: item.teams.map((team) => ({ id: team.id, name: team.name })),
    })),
    designations: designations.map((item) => ({
      id: item.id,
      name: item.name,
      code: item.code,
    })),
    employmentTypes: employmentTypes.map((item) => ({
      id: item.id,
      name: item.name,
      code: item.code,
    })),
    employmentStatuses: employmentStatuses.map((item) => ({
      id: item.id,
      name: item.name,
      code: item.code,
    })),
    roles,
    managers,
    nextEmployeeCode: await nextEmployeeCode(),
  };
}

function randomTempPassword() {
  return `Tmp!${Math.random().toString(36).slice(2, 10)}A1`;
}

export type EmployeeUploads = Partial<
  Record<"photo" | DocumentFieldName, Express.Multer.File[]>
>;

async function parseCreateInput(
  input: Record<string, unknown>,
  options: {
    currentId?: string;
    existingUser?: boolean;
    existingManagerId?: string | null;
  } = {},
) {
  const fields: Record<string, string> = {};
  const fullName = asString(input.fullName);
  const mobile = parseMobile(input.mobile);
  const officialEmail =
    typeof input.officialEmail === "string"
      ? normalizeEmail(input.officialEmail)
      : "";
  const personalEmailRaw = asString(input.personalEmail);
  const personalEmail = personalEmailRaw
    ? normalizeEmail(personalEmailRaw)
    : null;
  const joiningDate = parseDateOnly(
    input.joiningDate,
    "Joining date",
    true,
    fields,
    "joiningDate",
  );
  const dateOfBirth = parseDateOnly(
    input.dateOfBirth,
    "Date of birth",
    false,
    fields,
    "dateOfBirth",
  );
  const gender = parseGender(input.gender, fields);
  const maritalStatus = parseMaritalStatus(input.maritalStatus, fields);
  const createCrmAccount =
    options.existingUser || parseBoolean(input.createCrmAccount);
  const username = normalizeUsername(asString(input.username));
  const userStatus = parseUserStatus(input.userStatus, fields);

  if (fullName.length < 2 || fullName.length > 100) {
    fields.fullName = "Employee name must be 2–100 characters.";
  }
  if (!isValidMobile(mobile)) {
    fields.mobile = "Please enter a valid personal mobile number.";
  }
  if (!isValidEmail(officialEmail)) {
    fields.officialEmail = "Please enter a valid official email.";
  }
  if (personalEmail && !isValidEmail(personalEmail)) {
    fields.personalEmail = "Please enter a valid personal email.";
  }
  if (dateOfBirth && dateOfBirth > new Date()) {
    fields.dateOfBirth = "Date of birth cannot be in the future.";
  }

  const emergencyName = asOptionalString(input.emergencyName, 100);
  const emergencyRelationship = asOptionalString(
    input.emergencyRelationship,
    80,
  );
  const emergencyMobile = parseMobile(input.emergencyMobile);
  const emergencyAddress = asOptionalString(input.emergencyAddress, 500);
  const hasEmergency = Boolean(
    emergencyName ||
    emergencyRelationship ||
    emergencyMobile ||
    emergencyAddress,
  );
  if (hasEmergency) {
    if (!emergencyName) {
      fields.emergencyName =
        "Emergency contact name is required when emergency details are provided.";
    }
    if (emergencyMobile && !isValidMobile(emergencyMobile)) {
      fields.emergencyMobile = "Please enter a valid emergency mobile number.";
    }
    if (!emergencyMobile) {
      fields.emergencyMobile =
        "Emergency mobile is required when emergency details are provided.";
    }
  }

  if (createCrmAccount) {
    if (!username) {
      fields.username = "Username is required to create a CRM account.";
    }
    if (!asString(input.roleId)) {
      fields.roleId = "Role is required to create a CRM account.";
    }
  }

  const [
    designation,
    department,
    employmentType,
    employmentStatus,
    role,
    reportingManager,
  ] = await Promise.all([
    resolveMasterData("DESIGNATION", input.designationId, "Designation").catch(
      () => {
        fields.designationId = "Designation is required.";
        return null;
      },
    ),
    resolveDepartment(input.departmentId).catch(() => {
      fields.departmentId = "Department is required.";
      return null;
    }),
    resolveMasterData(
      "EMPLOYMENT_TYPE",
      input.employmentTypeId,
      "Employment type",
    ).catch(() => {
      fields.employmentTypeId = "Employment type is required.";
      return null;
    }),
    resolveMasterData(
      "EMPLOYMENT_STATUS",
      input.employmentStatusId,
      "Employment status",
    ).catch(() => {
      fields.employmentStatusId = "Employment status is required.";
      return null;
    }),
    createCrmAccount
      ? resolveRole(input.roleId).catch(() => {
          fields.roleId = "Please assign a valid role.";
          return null;
        })
      : Promise.resolve(null),
    resolveManager(input.reportingManagerId, {
      currentId: options.currentId,
      existingManagerId: options.existingManagerId,
    }).catch(() => {
      fields.reportingManagerId = "Reporting manager is not available.";
      return null;
    }),
  ]);
  const team = department
    ? await resolveTeam(input.teamId, department.id).catch(() => {
        fields.teamId = "Team must belong to the selected department.";
        return null;
      })
    : null;

  if (createCrmAccount && !role) {
    fields.roleId =
      fields.roleId || "Role is required to create a CRM account.";
  }

  throwIfInvalid(fields);

  return {
    fullName,
    gender,
    dateOfBirth,
    nationality: asOptionalString(input.nationality, 80),
    identityNumber: asOptionalString(input.identityNumber, 50),
    maritalStatus,
    mobile,
    personalEmail,
    officialEmail,
    presentAddress: asOptionalString(input.presentAddress, 500),
    permanentAddress: asOptionalString(input.permanentAddress, 500),
    joiningDate: joiningDate!,
    designationId: designation!.id,
    departmentId: department!.id,
    teamId: team?.id ?? null,
    roleId: role?.id ?? null,
    employmentTypeId: employmentType!.id,
    employmentStatusId: employmentStatus!.id,
    reportingManagerId: reportingManager?.id ?? null,
    emergencyName,
    emergencyRelationship,
    emergencyMobile: hasEmergency ? emergencyMobile : null,
    emergencyAddress,
    createCrmAccount,
    username,
    userStatus,
    role,
    department,
    team,
  };
}

export async function createEmployee(
  auth: AuthContext,
  input: Record<string, unknown>,
  uploads: EmployeeUploads = {},
  meta: AuditMeta,
) {
  const data = await parseCreateInput(input);
  const employeeId = randomUUID();
  let createdUserId: string | null = null;
  let reset: Record<string, unknown> | undefined;

  try {
    if (data.createCrmAccount && data.role) {
      const passwordHash = await hashPassword(randomTempPassword());
      const user = await prisma.user.create({
        data: {
          fullName: data.fullName,
          email: data.officialEmail,
          username: data.username,
          mobile: data.mobile,
          passwordHash,
          status: "INVITED",
          primaryRoleId: data.role.id,
          departmentId: data.departmentId,
          teamId: data.teamId,
        },
      });
      createdUserId = user.id;
      const scopes = defaultScopesForRole(data.role.key);
      await prisma.userDataScope.createMany({
        data: Object.entries(scopes).map(([resource, scope]) => ({
          userId: user.id,
          resource,
          scope,
        })),
      });
      await prisma.roleHistory.create({
        data: {
          userId: user.id,
          toRoleId: data.role.id,
          changedById: auth.user.id,
        },
      });
      const invited = await sendAccountInvite({
        userId: user.id,
        actorId: auth.user.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      reset = invited.body;
    }

    const photo = uploads.photo?.[0];
    const photoFile = photo ? await saveProfilePhoto(employeeId, photo) : null;
    const documents = await saveDocuments(employeeId, uploads);

    const {
      createCrmAccount: _createCrmAccount,
      username: _username,
      userStatus: _userStatus,
      role: _role,
      department: _department,
      team: _team,
      ...employeeData
    } = data;
    const employee = await prisma.employee.create({
      data: {
        id: employeeId,
        ...employeeData,
        photoUrl: photoFile ? photoFile.url : null,
        userId: createdUserId,
        employeeCode: await nextEmployeeCode(),
        documents: {
          create: documents.map((item) => ({
            type: item.type,
            fileName: item.fileName,
            mimeType: item.mimeType,
            storageKey: item.storageKey,
            fileSize: item.fileSize,
          })),
        },
      },
      include: employeeInclude,
    });

    await writeAuditLog({
      userId: auth.user.id,
      action: "EMPLOYEE_CREATED",
      entityType: ENTITY,
      entityId: employee.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: {
        employeeCode: employee.employeeCode,
        officialEmail: employee.officialEmail,
        crmAccount: Boolean(createdUserId),
      },
    });

    return { employee: serializeEmployee(employee, auth), reset };
  } catch (error) {
    await removeEmployeeFiles(employeeId);
    if (createdUserId) {
      await prisma.user
        .delete({ where: { id: createdUserId } })
        .catch(() => undefined);
    }
    rethrowUnique(error);
  }
}

export async function updateEmployee(
  auth: AuthContext,
  id: string,
  input: Record<string, unknown>,
  uploads: EmployeeUploads = {},
  meta: AuditMeta,
) {
  await assertCanViewEmployee(auth, id);
  const current = await prisma.employee.findUnique({
    where: { id },
    include: employeeInclude,
  });
  if (!current) {
    throw httpError.notFound("Employee not found.");
  }

  const data = await parseCreateInput(input, {
    currentId: id,
    existingUser: Boolean(current.userId),
    existingManagerId: current.reportingManagerId,
  });
  let createdUserId: string | null = null;
  let reset: Record<string, unknown> | undefined;

  try {
    if (!current.userId && data.createCrmAccount && data.role) {
      const passwordHash = await hashPassword(randomTempPassword());
      const user = await prisma.user.create({
        data: {
          fullName: data.fullName,
          email: data.officialEmail,
          username: data.username,
          mobile: data.mobile,
          passwordHash,
          status: "INVITED",
          primaryRoleId: data.role.id,
          departmentId: data.departmentId,
          teamId: data.teamId,
        },
      });
      createdUserId = user.id;
      const scopes = defaultScopesForRole(data.role.key);
      await prisma.userDataScope.createMany({
        data: Object.entries(scopes).map(([resource, scope]) => ({
          userId: user.id,
          resource,
          scope,
        })),
      });
      await prisma.roleHistory.create({
        data: {
          userId: user.id,
          toRoleId: data.role.id,
          changedById: auth.user.id,
        },
      });
      const invited = await sendAccountInvite({
        userId: user.id,
        actorId: auth.user.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      reset = invited.body;
    } else if (current.userId && data.role) {
      const nextStatus =
        current.user?.status === "INVITED" && data.userStatus === "ACTIVE"
          ? "INVITED"
          : data.userStatus;
      const nextEmail = normalizeEmail(data.officialEmail);
      const emailChanged = nextEmail !== normalizeEmail(current.officialEmail);
      if (emailChanged && current.user?.status !== "INVITED") {
        throw httpError.badRequest(
          "Official email can only be changed while the CRM account is still invited.",
        );
      }
      await prisma.user.update({
        where: { id: current.userId },
        data: {
          fullName: data.fullName,
          email: nextEmail,
          username: data.username,
          mobile: data.mobile,
          status: nextStatus,
          primaryRoleId: data.role.id,
          departmentId: data.departmentId,
          teamId: data.teamId,
        },
      });
      if (current.roleId !== data.role.id) {
        await prisma.roleHistory.create({
          data: {
            userId: current.userId,
            fromRoleId: current.roleId,
            toRoleId: data.role.id,
            changedById: auth.user.id,
          },
        });
      }
    }

    const photo = uploads.photo?.[0];
    const photoFile = photo ? await saveProfilePhoto(id, photo) : null;
    const documents = await saveDocuments(id, uploads);

    const {
      createCrmAccount: _createCrmAccount,
      username: _username,
      userStatus: _userStatus,
      role: _role,
      department: _department,
      team: _team,
      ...employeeData
    } = data;
    const employee = await prisma.employee.update({
      where: { id },
      data: {
        ...employeeData,
        ...(photoFile ? { photoUrl: photoFile.url } : {}),
        ...(createdUserId ? { userId: createdUserId } : {}),
        documents: documents.length
          ? {
              create: documents.map((item) => ({
                type: item.type,
                fileName: item.fileName,
                mimeType: item.mimeType,
                storageKey: item.storageKey,
                fileSize: item.fileSize,
              })),
            }
          : undefined,
      },
      include: employeeInclude,
    });

    const invitedEmailChanged =
      Boolean(current.userId) &&
      current.user?.status === "INVITED" &&
      normalizeEmail(data.officialEmail) !==
        normalizeEmail(current.officialEmail);
    if (invitedEmailChanged && current.userId) {
      const invited = await sendAccountInvite({
        userId: current.userId,
        actorId: auth.user.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        resent: true,
      });
      reset = invited.body;
    }

    await writeAuditLog({
      userId: auth.user.id,
      action: "EMPLOYEE_UPDATED",
      entityType: ENTITY,
      entityId: employee.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: {
        employeeCode: employee.employeeCode,
        crmAccount: Boolean(employee.userId),
      },
    });
    return { employee: serializeEmployee(employee, auth), reset };
  } catch (error) {
    if (createdUserId) {
      await prisma.user
        .delete({ where: { id: createdUserId } })
        .catch(() => undefined);
    }
    rethrowUnique(error);
  }
}

export async function updateEmployeeStatus(
  auth: AuthContext,
  id: string,
  input: Record<string, unknown>,
  meta: AuditMeta,
) {
  await assertCanViewEmployee(auth, id);
  const fields: Record<string, string> = {};
  const quickStatus = asString(input.status).toUpperCase();
  const status =
    quickStatus === "ACTIVE" || quickStatus === "INACTIVE"
      ? await employmentStatusByCode(quickStatus)
      : await resolveMasterData(
          "EMPLOYMENT_STATUS",
          input.employmentStatusId,
          "Employment status",
        );

  if (!status) {
    throw httpError.badRequest("Employment status is required.");
  }

  const current = await prisma.employee.findUnique({
    where: { id },
    include: { employmentStatus: true },
  });
  if (!current) {
    throw httpError.notFound("Employee not found.");
  }

  const statusCode = (status.code || "").toUpperCase();
  const previousCode = (current.employmentStatus.code || "").toUpperCase();
  const wasAway = ["RESIGNED", "TERMINATED", "INACTIVE"].includes(previousCode);
  const isRejoining =
    wasAway && (statusCode === "ACTIVE" || statusCode === "PROBATION");

  const resignationDate = parseDateOnly(
    input.resignationDate,
    "Resignation date",
    false,
    fields,
    "resignationDate",
  );
  const terminationDate = parseDateOnly(
    input.terminationDate,
    "Termination date",
    false,
    fields,
    "terminationDate",
  );
  const rejoiningDate = parseDateOnly(
    input.rejoiningDate,
    "Rejoining date",
    false,
    fields,
    "rejoiningDate",
  );
  const terminationReason = asOptionalString(input.terminationReason, 200);
  const terminationRemarks = asOptionalString(input.terminationRemarks, 1000);

  if (
    statusCode === "RESIGNED" &&
    !resignationDate &&
    !current.resignationDate
  ) {
    fields.resignationDate =
      "Resignation date is required when status is Resigned.";
  }
  if (statusCode === "TERMINATED") {
    if (!terminationDate && !current.terminationDate) {
      fields.terminationDate =
        "Termination date is required when status is Terminated.";
    }
    if (!terminationReason && !current.terminationReason) {
      fields.terminationReason =
        "Termination reason is required when status is Terminated.";
    }
  }
  if (isRejoining && !rejoiningDate) {
    fields.rejoiningDate =
      "Rejoining date is required when reactivating a previous employee.";
  }
  throwIfInvalid(fields);

  const data: Prisma.EmployeeUpdateInput = {
    employmentStatus: { connect: { id: status.id } },
  };

  if (statusCode === "RESIGNED") {
    data.resignationDate = resignationDate || current.resignationDate;
    data.terminationDate = null;
    data.terminationReason = null;
    data.terminationRemarks = null;
  } else if (statusCode === "TERMINATED") {
    data.terminationDate = terminationDate || current.terminationDate;
    data.terminationReason = terminationReason || current.terminationReason;
    data.terminationRemarks = terminationRemarks ?? current.terminationRemarks;
    data.resignationDate = null;
  } else if (isRejoining) {
    data.rejoiningDate = rejoiningDate;
  }

  const employee = await prisma.employee.update({
    where: { id },
    data,
    include: employeeInclude,
  });

  const crmSync = await syncCrmAccountForEmploymentStatus(employee, statusCode);
  const refreshed = await prisma.employee.findUnique({
    where: { id },
    include: employeeInclude,
  });

  await writeAuditLog({
    userId: auth.user.id,
    action: "EMPLOYEE_STATUS_CHANGED",
    entityType: ENTITY,
    entityId: employee.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: {
      employeeCode: employee.employeeCode,
      fromStatus: current.employmentStatus.name,
      toStatus: employee.employmentStatus.name,
      fromStatusCode: previousCode,
      toStatusCode: statusCode,
      resignationDate: employee.resignationDate
        ? dateOnly(employee.resignationDate)
        : null,
      terminationDate: employee.terminationDate
        ? dateOnly(employee.terminationDate)
        : null,
      rejoiningDate: employee.rejoiningDate
        ? dateOnly(employee.rejoiningDate)
        : null,
      crmDisabled: crmSync.crmDisabled,
      crmRestored: crmSync.crmRestored,
    },
  });
  return serializeEmployee(refreshed ?? employee, auth);
}

export async function updateEmployeePhoto(
  auth: AuthContext,
  id: string,
  file: Express.Multer.File | undefined,
  meta: AuditMeta,
) {
  await assertCanViewEmployee(auth, id);
  if (!file) {
    throw httpError.invalidUpload("Please select a profile photo.");
  }

  const current = await prisma.employee.findUnique({
    where: { id },
    select: { id: true, employeeCode: true },
  });
  if (!current) {
    throw httpError.notFound("Employee not found.");
  }

  const photoFile = await saveProfilePhoto(id, file);
  const employee = await prisma.employee.update({
    where: { id },
    data: { photoUrl: photoFile.url },
    include: employeeInclude,
  });
  await writeAuditLog({
    userId: auth.user.id,
    action: "EMPLOYEE_PHOTO_UPDATED",
    entityType: ENTITY,
    entityId: employee.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { employeeCode: employee.employeeCode },
  });
  return serializeEmployee(employee, auth);
}

export async function getEmployeePhoto(auth: AuthContext, id: string) {
  await assertCanViewEmployee(auth, id);
  const employee = await prisma.employee.findUnique({
    where: { id },
    select: { id: true, photoUrl: true },
  });
  if (!employee?.photoUrl) {
    throw httpError.notFound("Profile photo not found.");
  }
  const buffer = await readEmployeeFile(employee.id, employee.photoUrl);
  return { buffer, fileName: employee.photoUrl };
}

export async function getEmployeeDocumentFile(
  auth: AuthContext,
  employeeId: string,
  documentId: string,
) {
  await assertCanViewEmployee(auth, employeeId);
  const owner = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { userId: true },
  });
  if (!owner) {
    throw httpError.notFound("Employee not found.");
  }
  if (!canViewEmployeeDocuments(auth, owner.userId)) {
    throw httpError.accessDenied();
  }
  const document = await prisma.employeeDocument.findFirst({
    where: { id: documentId, employeeId },
  });
  if (!document) {
    throw httpError.notFound("Document not found.");
  }
  const buffer = await readEmployeeFile(employeeId, document.storageKey);
  return { buffer, fileName: document.fileName, mimeType: document.mimeType };
}

export async function uploadEmployeeDocument(
  auth: AuthContext,
  id: string,
  uploads: EmployeeUploads,
  meta: AuditMeta,
) {
  if (!canManageEmployeeDocuments(auth)) {
    throw httpError.accessDenied();
  }
  await assertCanViewEmployee(auth, id);
  const current = await prisma.employee.findUnique({
    where: { id },
    select: { id: true, employeeCode: true },
  });
  if (!current) {
    throw httpError.notFound("Employee not found.");
  }

  const selected: Partial<Record<DocumentFieldName, Express.Multer.File[]>> =
    {};
  for (const key of Object.keys(DOCUMENT_FIELD_MAP) as DocumentFieldName[]) {
    const file = uploads[key]?.[0];
    if (file) {
      selected[key] = [file];
      break;
    }
  }

  const saved = await saveDocuments(id, selected);
  const item = saved[0];
  if (!item) {
    throw httpError.invalidUpload("Please select a document to upload.");
  }

  const existing = await prisma.employeeDocument.findMany({
    where: { employeeId: id, type: item.type },
  });

  const employee = await prisma.employee.update({
    where: { id },
    data: {
      documents: {
        create: {
          type: item.type,
          fileName: item.fileName,
          mimeType: item.mimeType,
          storageKey: item.storageKey,
          fileSize: item.fileSize,
        },
      },
    },
    include: employeeInclude,
  });

  await Promise.all(
    existing.map(async (doc) => {
      await destroyStoredUpload(doc.storageKey);
      await prisma.employeeDocument
        .delete({ where: { id: doc.id } })
        .catch(() => undefined);
    }),
  );

  await writeAuditLog({
    userId: auth.user.id,
    action: "EMPLOYEE_DOCUMENT_UPLOADED",
    entityType: ENTITY,
    entityId: employee.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: {
      employeeCode: employee.employeeCode,
      type: item.type,
      fileName: item.fileName,
    },
  });

  const refreshed = await prisma.employee.findUnique({
    where: { id },
    include: employeeInclude,
  });
  return serializeEmployee(refreshed ?? employee, auth);
}

export async function deleteEmployeeDocument(
  auth: AuthContext,
  employeeId: string,
  documentId: string,
  meta: AuditMeta,
) {
  if (!canManageEmployeeDocuments(auth)) {
    throw httpError.accessDenied();
  }
  await assertCanViewEmployee(auth, employeeId);
  const document = await prisma.employeeDocument.findFirst({
    where: { id: documentId, employeeId },
  });
  if (!document) {
    throw httpError.notFound("Document not found.");
  }

  await destroyStoredUpload(document.storageKey);
  await prisma.employeeDocument.delete({ where: { id: document.id } });

  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    include: employeeInclude,
  });
  if (!employee) {
    throw httpError.notFound("Employee not found.");
  }

  await writeAuditLog({
    userId: auth.user.id,
    action: "EMPLOYEE_DOCUMENT_DELETED",
    entityType: ENTITY,
    entityId: employee.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: {
      employeeCode: employee.employeeCode,
      type: document.type,
      fileName: document.fileName,
    },
  });
  return serializeEmployee(employee, auth);
}

export async function listEmployeeAuditLogs(
  auth: AuthContext,
  employeeId: string,
) {
  await assertCanViewEmployee(auth, employeeId);
  if (
    !hasPermission(auth.permissions, [
      "audit:view",
      "employee:edit",
      "employee:view",
    ])
  ) {
    throw httpError.accessDenied();
  }

  const logs = await prisma.auditLog.findMany({
    where: { entityType: ENTITY, entityId: employeeId },
    include: { user: { select: { id: true, fullName: true, email: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return logs.map((log) => ({
    id: log.id,
    action: log.action,
    entityType: log.entityType,
    entityId: log.entityId,
    metadata: log.metadata,
    createdAt: log.createdAt,
    user: log.user,
  }));
}

export async function getEmployeePerformanceSummary(
  auth: AuthContext,
  employeeId: string,
) {
  await assertCanViewEmployee(auth, employeeId);
  if (!hasPermission(auth.permissions, "employee_performance:view")) {
    throw httpError.accessDenied();
  }

  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      id: true,
      employeeCode: true,
      fullName: true,
      userId: true,
    },
  });
  if (!employee) {
    throw httpError.notFound("Employee not found.");
  }

  if (!employee.userId) {
    return {
      employee: {
        id: employee.id,
        employeeCode: employee.employeeCode,
        fullName: employee.fullName,
        userId: null,
      },
      available: false,
      message:
        "This employee has no CRM account, so performance metrics are not available yet.",
      summary: null,
      row: null,
    };
  }

  const performance = await getFollowUpPerformance(auth, {
    ownerId: employee.userId,
  });
  const row =
    performance.employees.find((item) => item.ownerId === employee.userId) ||
    null;

  return {
    employee: {
      id: employee.id,
      employeeCode: employee.employeeCode,
      fullName: employee.fullName,
      userId: employee.userId,
    },
    available: true,
    from: performance.from,
    to: performance.to,
    summary: row
      ? {
          due: row.due,
          completed: row.completed,
          onTime: row.onTime,
          overdue: row.overdue,
          completionRate: row.completionRate,
          onTimeRate: row.onTimeRate,
        }
      : {
          due: 0,
          completed: 0,
          onTime: 0,
          overdue: 0,
          completionRate: 0,
          onTimeRate: 0,
        },
    row,
  };
}
