export class HttpError extends Error {
  status: number
  code: string
  fields?: Record<string, string>
  extra?: Record<string, unknown>

  constructor(status: number, message: string, code: string, fields?: Record<string, string>, extra?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.code = code
    this.fields = fields
    this.extra = extra
  }
}

export const httpError = {
  accessDenied(message = 'You do not have permission to perform this action.') {
    return new HttpError(403, message, 'ACCESS_DENIED')
  },
  statusUpdateFailed() {
    return new HttpError(500, 'Unable to update the lead status. Please try again.', 'STATUS_UPDATE_FAILED')
  },
  leadPoolLoadFailed() {
    return new HttpError(500, 'Unable to load Lead Pool. Please try again.', 'LEAD_POOL_LOAD_FAILED')
  },
  myLeadsLoadFailed() {
    return new HttpError(500, 'Unable to load your leads. Please try again.', 'MY_LEADS_LOAD_FAILED')
  },
  myLeadsSearchFailed() {
    return new HttpError(500, 'Unable to complete the search. Please try again.', 'MY_LEADS_SEARCH_FAILED')
  },
  assignmentFailed() {
    return new HttpError(500, 'Unable to assign the selected lead. Please try again.', 'LEAD_ASSIGNMENT_FAILED')
  },
  unauthenticated() {
    return new HttpError(401, 'Authentication required', 'UNAUTHENTICATED')
  },
  notFound(message = 'Not found') {
    return new HttpError(404, message, 'NOT_FOUND')
  },
  duplicateUsername() {
    return new HttpError(409, 'This username is already in use.', 'DUPLICATE_USERNAME')
  },
  duplicateEmail() {
    return new HttpError(409, 'This email is already in use.', 'DUPLICATE_EMAIL')
  },
  duplicateLead(existingLead: { id: string; code: string; name: string; status: string }) {
    return new HttpError(409, 'Similar lead already exists.', 'DUPLICATE_LEAD', undefined, { existingLead })
  },
  duplicateEmployeeEmail() {
    return new HttpError(409, 'This official email is already registered to an employee.', 'DUPLICATE_EMPLOYEE_EMAIL')
  },
  duplicateEmployeeCode() {
    return new HttpError(409, 'This employee ID is already in use.', 'DUPLICATE_EMPLOYEE_CODE')
  },
  validation(fields: Record<string, string>, message = 'Please correct the highlighted fields.') {
    return new HttpError(400, message, 'VALIDATION_ERROR', fields)
  },
  invalidUpload(message = 'The selected file could not be uploaded.') {
    return new HttpError(400, message, 'INVALID_UPLOAD')
  },
  roleMissing() {
    return new HttpError(400, 'Please assign a role to the user.', 'ROLE_MISSING')
  },
  invalidPermission() {
    return new HttpError(400, 'The selected permission is not available.', 'INVALID_PERMISSION')
  },
  roleInUse() {
    return new HttpError(409, 'This role is currently assigned to users.', 'ROLE_IN_USE')
  },
  cannotRemoveAccess() {
    return new HttpError(
      409,
      'At least one authorized administrator must retain system access.',
      'CANNOT_REMOVE_ACCESS',
    )
  },
  sessionError() {
    return new HttpError(400, 'Unable to terminate the selected session.', 'SESSION_ERROR')
  },
  serverError() {
    return new HttpError(500, 'Unable to process the request. Please try again.', 'SERVER_ERROR')
  },
  badRequest(message: string, code = 'INVALID_INPUT') {
    return new HttpError(400, message, code)
  },
  masterDataForbidden() {
    return new HttpError(403, 'You are not authorized to manage master data.', 'MASTER_DATA_FORBIDDEN')
  },
  missingMasterDataName() {
    return new HttpError(400, 'Name is required.', 'MISSING_MASTER_DATA_NAME')
  },
  duplicateMasterData() {
    return new HttpError(409, 'This value already exists.', 'DUPLICATE_MASTER_DATA')
  },
  masterDataInUse() {
    return new HttpError(409, 'This value is already being used and cannot be deleted.', 'MASTER_DATA_IN_USE')
  },
  invalidMasterDataCode() {
    return new HttpError(400, 'Please enter a valid unique code.', 'INVALID_MASTER_DATA_CODE')
  },
  invalidMasterDataParent() {
    return new HttpError(400, 'Selected parent value is not available.', 'INVALID_MASTER_DATA_PARENT')
  },
  inactiveMasterDataParent() {
    return new HttpError(400, 'The selected parent is inactive.', 'INACTIVE_MASTER_DATA_PARENT')
  },
  invalidMasterData() {
    return new HttpError(400, 'One or more records contain invalid data.', 'INVALID_MASTER_DATA')
  },
  masterDataImportFailed() {
    return new HttpError(400, 'Unable to import the selected data.', 'MASTER_DATA_IMPORT_FAILED')
  },
  duplicateMasterDataImport() {
    return new HttpError(400, 'Duplicate values were found in the imported file.', 'DUPLICATE_MASTER_DATA_IMPORT')
  },
}
