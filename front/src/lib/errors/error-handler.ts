/**
 * User-Friendly Error Handler
 *
 * Centralizes error handling to show friendly messages to users
 * instead of raw technical errors from the backend.
 *
 * IMPORTANT: Never show raw backend errors to users.
 * Always use this handler to get user-friendly messages.
 *
 * Support email: support@saleads.ai
 */

import { ApiError } from '@/lib/fetch/gateway-client'

export interface FriendlyError {
  /** User-friendly title */
  title: string
  /** User-friendly description */
  message: string
  /** Error code for support reference */
  code: string
  /** Whether to show "contact support" message */
  showSupport: boolean
  /** Original error (for logging only, never show to user) */
  originalError?: unknown
}

/**
 * Error categories for different HTTP status codes
 */
export type ErrorCategory =
  | 'network'
  | 'authentication'
  | 'authorization'
  | 'not_found'
  | 'validation'
  | 'conflict'
  | 'rate_limit'
  | 'server'
  | 'timeout'
  | 'unknown'

/**
 * Get error category from HTTP status code
 */
export function getErrorCategory(status: number): ErrorCategory {
  if (status === 401) return 'authentication'
  if (status === 403) return 'authorization'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 422 || status === 400) return 'validation'
  if (status === 429) return 'rate_limit'
  if (status >= 500) return 'server'
  return 'unknown'
}

/**
 * Default friendly messages for each error category
 * These are fallbacks - use translations in components
 */
const DEFAULT_MESSAGES: Record<
  ErrorCategory,
  { title: string; message: string; showSupport: boolean }
> = {
  network: {
    title: 'Connection problem',
    message:
      'We could not connect to the server. Please check your internet connection and try again.',
    showSupport: false,
  },
  authentication: {
    title: 'Session expired',
    message: 'Your session has expired. Please log in again to continue.',
    showSupport: false,
  },
  authorization: {
    title: 'Access denied',
    message: "You don't have permission to perform this action.",
    showSupport: false,
  },
  not_found: {
    title: 'Not found',
    message:
      'The resource you are looking for does not exist or is no longer available.',
    showSupport: false,
  },
  validation: {
    title: 'Invalid data',
    message:
      'The information provided is not valid. Please review and try again.',
    showSupport: false,
  },
  conflict: {
    title: 'Conflict',
    message:
      'This action could not be completed due to a conflict. The resource may have been modified.',
    showSupport: false,
  },
  rate_limit: {
    title: 'Too many requests',
    message:
      'You have made too many requests. Please wait a moment and try again.',
    showSupport: false,
  },
  server: {
    title: 'Server error',
    message:
      'We are experiencing technical difficulties. Our team has been notified.',
    showSupport: true,
  },
  timeout: {
    title: 'Request timeout',
    message: 'The request took too long to complete. Please try again.',
    showSupport: false,
  },
  unknown: {
    title: 'Unexpected error',
    message: 'An unexpected error occurred. Please try again.',
    showSupport: true,
  },
}

/**
 * Support contact information
 */
export const SUPPORT_EMAIL = 'support@saleads.ai'
export const SUPPORT_MESSAGE = `If the problem persists, contact our support team at ${SUPPORT_EMAIL}`

/**
 * Generate a unique error code for support reference
 */
function generateErrorCode(category: ErrorCategory, status?: number): string {
  const timestamp = Date.now().toString(36).toUpperCase()
  const categoryCode = category.substring(0, 3).toUpperCase()
  const statusCode = status ? status.toString() : 'XXX'
  return `SA-${categoryCode}-${statusCode}-${timestamp}`
}

/**
 * Convert any error to a user-friendly error object
 *
 * @param error - The original error (ApiError, Error, or unknown)
 * @param context - Optional context for better error messages
 * @returns FriendlyError object with user-safe messages
 *
 * @example
 * ```ts
 * try {
 *   await api.fetchData()
 * } catch (error) {
 *   const friendly = toFriendlyError(error)
 *   toast.error(friendly.title, { description: friendly.message })
 * }
 * ```
 */
export function toFriendlyError(
  error: unknown,
  context?: string
): FriendlyError {
  // Handle ApiError (from gateway-client)
  if (error instanceof ApiError) {
    const category = getErrorCategory(error.status)
    const defaults = DEFAULT_MESSAGES[category]
    const code = generateErrorCode(category, error.status)

    return {
      title: defaults.title,
      message: defaults.message,
      code,
      showSupport: defaults.showSupport,
      originalError: error,
    }
  }

  // Handle timeout errors
  if (error instanceof Error && error.message === 'Request timeout') {
    const defaults = DEFAULT_MESSAGES.timeout
    return {
      title: defaults.title,
      message: defaults.message,
      code: generateErrorCode('timeout'),
      showSupport: defaults.showSupport,
      originalError: error,
    }
  }

  // Handle network errors (fetch failed)
  if (error instanceof TypeError && error.message.includes('fetch')) {
    const defaults = DEFAULT_MESSAGES.network
    return {
      title: defaults.title,
      message: defaults.message,
      code: generateErrorCode('network'),
      showSupport: defaults.showSupport,
      originalError: error,
    }
  }

  // Handle generic errors
  if (error instanceof Error) {
    // Check for common network-related messages
    const networkPatterns = [
      'network',
      'connection',
      'offline',
      'dns',
      'socket',
    ]
    const isNetworkError = networkPatterns.some(pattern =>
      error.message.toLowerCase().includes(pattern)
    )

    if (isNetworkError) {
      const defaults = DEFAULT_MESSAGES.network
      return {
        title: defaults.title,
        message: defaults.message,
        code: generateErrorCode('network'),
        showSupport: defaults.showSupport,
        originalError: error,
      }
    }
  }

  // Unknown error - use generic message
  const defaults = DEFAULT_MESSAGES.unknown
  return {
    title: defaults.title,
    message: context ? `${defaults.message} (${context})` : defaults.message,
    code: generateErrorCode('unknown'),
    showSupport: defaults.showSupport,
    originalError: error,
  }
}

/**
 * Get friendly error messages using translations
 *
 * @param error - The original error
 * @param t - Translation function from next-intl
 * @returns FriendlyError with translated messages
 *
 * @example
 * ```ts
 * const t = useTranslations('common.errors')
 * try {
 *   await api.fetchData()
 * } catch (error) {
 *   const friendly = toFriendlyErrorWithTranslations(error, t)
 *   toast.error(friendly.title, { description: friendly.message })
 * }
 * ```
 */
export function toFriendlyErrorWithTranslations(
  error: unknown,
  t: (key: string, values?: Record<string, string>) => string
): FriendlyError {
  const friendly = toFriendlyError(error)

  // Get error category
  let category: ErrorCategory = 'unknown'
  if (error instanceof ApiError) {
    category = getErrorCategory(error.status)
  } else if (error instanceof Error && error.message === 'Request timeout') {
    category = 'timeout'
  } else if (error instanceof TypeError && error.message.includes('fetch')) {
    category = 'network'
  }

  // Try to get translated messages
  try {
    const title = t(`${category}.title`)
    const message = t(`${category}.message`)

    return {
      ...friendly,
      title: title || friendly.title,
      message: message || friendly.message,
    }
  } catch {
    // If translation fails, return default messages
    return friendly
  }
}

/**
 * Check if error requires user to re-authenticate
 */
export function requiresReauth(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status === 401
  }
  return false
}

/**
 * Check if error is a network/connectivity issue
 */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return true
  }
  if (error instanceof Error) {
    const networkPatterns = ['network', 'connection', 'offline']
    return networkPatterns.some(pattern =>
      error.message.toLowerCase().includes(pattern)
    )
  }
  return false
}

/**
 * Check if error is a server error (5xx)
 */
export function isServerError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status >= 500
  }
  return false
}

/**
 * Log error for debugging (only in development)
 * NEVER show this to users
 */
export function logError(_error: unknown, _context?: string): void {
  if (process.env.NODE_ENV === 'development') {
  }
}

/**
 * Sanitize data before sending to Sentry.
 * Only strips credentials/tokens that could leak in error responses.
 * User data (email, user_id, business_id) is kept for traceability.
 *
 * @param data - Raw data from API error response
 * @param maxLength - Maximum string length (default 2048)
 * @returns Sanitized data safe for Sentry
 */
export function sanitizeForSentry(data: unknown, maxLength = 2048): unknown {
  if (data === null || data === undefined) return undefined

  if (typeof data === 'string') {
    return data.length > maxLength
      ? data.substring(0, maxLength) + '...[truncated]'
      : data
  }

  if (typeof data !== 'object') return data

  if (Array.isArray(data)) {
    const serialized = JSON.stringify(data)
    if (serialized.length > 8192) {
      return { _truncated: true, _size: serialized.length, _count: data.length }
    }
    return data
  }

  const CREDENTIAL_KEYS = new Set([
    'password',
    'token',
    'access_token',
    'refresh_token',
    'upload_token',
    'secret',
    'api_key',
    'authorization',
    'cookie',
  ])

  const sanitized: Record<string, unknown> = {}
  const entries = Object.entries(data as Record<string, unknown>)

  for (const [key, value] of entries) {
    if (CREDENTIAL_KEYS.has(key.toLowerCase())) {
      sanitized[key] = '[FILTERED]'
    } else if (typeof value === 'string' && value.length > maxLength) {
      sanitized[key] = value.substring(0, maxLength) + '...[truncated]'
    } else {
      sanitized[key] = value
    }
  }

  const serialized = JSON.stringify(sanitized)
  if (serialized.length > 8192) {
    return {
      _truncated: true,
      _size: serialized.length,
      _keys: Object.keys(sanitized),
    }
  }

  return sanitized
}

const errorHandler = {
  toFriendlyError,
  toFriendlyErrorWithTranslations,
  requiresReauth,
  isNetworkError,
  isServerError,
  logError,
  sanitizeForSentry,
  SUPPORT_EMAIL,
  SUPPORT_MESSAGE,
}

export default errorHandler
