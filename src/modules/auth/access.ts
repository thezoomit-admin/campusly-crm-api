import type { DataScope, OverrideEffect } from '../../lib/prisma-client'
import { ROLE_DEFAULTS, SCOPE_RESOURCES, permissionKey } from './permission-catalog'

export type PermissionGrant = {
  resource: string
  action: string
}

export type ScopeMap = Record<string, DataScope>

export function toPermissionKey(item: PermissionGrant) {
  return permissionKey(item.resource, item.action)
}

export function mergePermissions(
  rolePermissions: PermissionGrant[],
  overrides: Array<PermissionGrant & { effect: OverrideEffect }>,
) {
  const allowed = new Set(rolePermissions.map(toPermissionKey))

  for (const override of overrides) {
    const key = toPermissionKey(override)
    if (override.effect === 'ALLOW') {
      allowed.add(key)
    } else {
      allowed.delete(key)
    }
  }

  return [...allowed]
}

export function defaultScopesForRole(roleKey: string): ScopeMap {
  const defaults = ROLE_DEFAULTS[roleKey]?.scopes
  return {
    lead: defaults?.lead ?? 'OWN',
    document: defaults?.document ?? defaults?.lead ?? 'OWN',
    employee_performance: defaults?.employee_performance ?? defaults?.lead ?? 'OWN',
  }
}

export function mergeScopes(roleKey: string, stored: Array<{ resource: string; scope: DataScope }>): ScopeMap {
  const merged = defaultScopesForRole(roleKey)

  for (const row of stored) {
    merged[row.resource] = row.scope
  }

  if (!stored.some((row) => row.resource === 'document')) {
    merged.document = merged.lead
  }

  if (!stored.some((row) => row.resource === 'employee_performance')) {
    merged.employee_performance = merged.lead
  }

  return merged
}

export function hasPermission(permissions: string[], required: string | string[]) {
  const needed = Array.isArray(required) ? required : [required]
  return needed.some((item) => permissions.includes(item))
}

/** CRM User account must be ACTIVE to receive leads. */
export function canReceiveLeadAssignment(status: string) {
  return status === 'ACTIVE'
}

/** Employment statuses allowed for new lead assignment (CRM-027 Rule-5). */
export const LEAD_ELIGIBLE_EMPLOYMENT_STATUSES = new Set(['ACTIVE', 'PROBATION'])

export function isEmploymentStatusLeadEligible(code: string | null | undefined) {
  return Boolean(code && LEAD_ELIGIBLE_EMPLOYMENT_STATUSES.has(code))
}

/**
 * Users without an Employee record remain eligible (legacy).
 * Linked Employees must be Active/Probation — Inactive/Resigned/Terminated/On Leave are excluded.
 */
export function canUserReceiveLeadByEmployment(employeeStatusCode: string | null | undefined, hasEmployee: boolean) {
  if (!hasEmployee) {
    return true
  }
  return isEmploymentStatusLeadEligible(employeeStatusCode)
}

/** Employment statuses that should disable the linked CRM login. */
export const CRM_DISABLE_EMPLOYMENT_STATUSES = new Set(['INACTIVE', 'RESIGNED', 'TERMINATED'])

export function shouldDisableCrmForEmploymentStatus(code: string | null | undefined) {
  return Boolean(code && CRM_DISABLE_EMPLOYMENT_STATUSES.has(code))
}

export type DirectoryScope = 'OWN' | 'TEAM' | 'ALL'

/** CRM-026 access matrix. Independent of lead data scope. */
const USER_DIRECTORY_SCOPE: Record<string, DirectoryScope> = {
  admin: 'ALL',
  ceo: 'ALL',
  manager: 'TEAM',
}

/** View Audit: Admin/CEO all, Manager team, Counsellor and Call Executive own. */
const AUDIT_DIRECTORY_SCOPE: Record<string, DirectoryScope> = {
  admin: 'ALL',
  ceo: 'ALL',
  manager: 'TEAM',
  counsellor: 'OWN',
  call_executive: 'OWN',
}

export function userDirectoryScope(roleKey: string): DirectoryScope {
  return USER_DIRECTORY_SCOPE[roleKey] ?? 'OWN'
}

export function auditDirectoryScope(roleKey: string): DirectoryScope {
  return AUDIT_DIRECTORY_SCOPE[roleKey] ?? 'OWN'
}

const CRITICAL_ACTIONS = new Set([
  'delete',
  'export',
  'download',
  'import',
  'configure',
  'convert',
  'cancel',
  'approve',
  'generate',
])

export function isCriticalPermission(resource: string, action: string) {
  return resource === 'payment' || resource === 'receipt' || CRITICAL_ACTIONS.has(action)
}

export function permissionLabel(resource: string, action: string) {
  const title = (value: string) =>
    value
      .split('_')
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')
  return `${title(resource)} ${title(action)}`
}

export const SCOPE_RESOURCE_LIST = SCOPE_RESOURCES
