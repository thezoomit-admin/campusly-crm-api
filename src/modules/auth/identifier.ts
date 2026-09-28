export const USERNAME_MIN_LENGTH = 3
export const USERNAME_MAX_LENGTH = 30
export const EMAIL_MAX_LENGTH = 254
export const EMAIL_LOCAL_MAX_LENGTH = 64

const EMAIL_PATTERN = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}$/
const USERNAME_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/

export function normalizeIdentifier(identifier: string) {
  return identifier.trim()
}

export function isEmailIdentifier(identifier: string) {
  return identifier.includes('@')
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

export function normalizeUsername(username: string) {
  return username.trim().toLowerCase()
}

export function emailValidationError(value: string): string | null {
  const email = normalizeEmail(value)
  if (!email) return 'Enter a valid email'
  if (email.length > EMAIL_MAX_LENGTH) return 'Email must be 254 characters or fewer'
  const at = email.lastIndexOf('@')
  const local = at === -1 ? '' : email.slice(0, at)
  if (local.length > EMAIL_LOCAL_MAX_LENGTH) return 'Enter a valid email'
  if (email.includes('..') || !EMAIL_PATTERN.test(email)) return 'Enter a valid email'
  return null
}

export function usernameValidationError(value: string): string | null {
  const username = normalizeUsername(value)
  if (!username) return 'Enter a valid username'
  if (username.length < USERNAME_MIN_LENGTH) {
    return `Username must be at least ${USERNAME_MIN_LENGTH} characters`
  }
  if (username.length > USERNAME_MAX_LENGTH) {
    return `Username must be ${USERNAME_MAX_LENGTH} characters or fewer`
  }
  if (/\s/.test(value)) return 'Username cannot contain spaces'
  if (username.includes('@')) return 'Enter a valid username'
  if (/[._-]{2,}/.test(username) || !USERNAME_PATTERN.test(username)) {
    return 'Username can only use letters, numbers, dot, hyphen, and underscore'
  }
  return null
}

export function loginIdentifierValidationError(value: string): string | null {
  const identifier = normalizeIdentifier(value)
  if (!identifier) return 'Enter email or username'
  return isEmailIdentifier(identifier) ? emailValidationError(identifier) : usernameValidationError(identifier)
}

export function isValidEmail(value: string) {
  return emailValidationError(value) === null
}

export function isValidUsername(value: string) {
  return usernameValidationError(value) === null
}
