export const PAYMENT_MESSAGES = {
  amountRequired: 'Payment amount is required.',
  amountInvalid: 'Please enter a valid payment amount.',
  amountExceeded: 'Payment amount cannot exceed the current due amount.',
  methodRequired: 'Please select a payment method.',
  transactionRequired: 'Transaction ID is required for this payment method.',
  duplicateTransaction: 'This transaction number has already been used.',
  invalidOffer: 'Payment cannot be added to this service offer.',
  cancelError: 'Unable to cancel this payment.',
  reverseError: 'Unable to reverse this payment.',
  receiptError: 'Unable to generate receipt.',
  serverError: 'Unable to process the payment. Please try again.',
  notFound: 'The requested payment could not be found.',
  receiptNotFound: 'The requested receipt could not be found.',
  cannotEdit: 'A completed payment cannot be edited. Cancel or reverse it, then record a new payment.',
  cannotDelete: 'Payments cannot be deleted. Cancel or reverse to preserve history.',
  reasonRequired: 'Please provide a reason.',
  allocationMismatch: 'Sum of allocations must equal the payment amount.',
  permissionDenied: 'You do not have permission to perform this payment action.',
} as const

/** Methods that require a transaction / reference number. */
export const METHODS_REQUIRE_TXN = new Set(['BKASH', 'NAGAD', 'BANK', 'CARD', 'ONLINE'])

/** Methods that require a free-text description in the reference field. */
export const METHODS_REQUIRE_DESCRIPTION = new Set(['OTHER'])

/** Digital methods that trigger duplicate-transaction checks. */
export const DIGITAL_METHODS = new Set(['BKASH', 'NAGAD', 'BANK', 'CARD', 'ONLINE'])

export const COUNTING_STATUSES = ['COMPLETED'] as const

export const OFFER_PAYABLE_STATUSES = ['ACCEPTED', 'PAYMENT_PENDING', 'PARTIALLY_PAID'] as const

export const DEFAULT_METHOD_CATALOG: Array<{ code: string; name: string }> = [
  { code: 'CASH', name: 'Cash' },
  { code: 'BKASH', name: 'bKash' },
  { code: 'NAGAD', name: 'Nagad' },
  { code: 'BANK', name: 'Bank Transfer' },
  { code: 'CARD', name: 'Card' },
  { code: 'OTHER', name: 'Other' },
]

export const CONSULTANCY_NAME =
  (process.env.CONSULTANCY_NAME || process.env.COMPANY_NAME || 'Education Consultancy').trim()
