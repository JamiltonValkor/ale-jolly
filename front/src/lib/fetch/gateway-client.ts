/**
 * Gateway API Client
 *
 * Unified client for all API calls through the Gateway.
 * Automatically injects auth token and X-Business-Id on EVERY request.
 *
 * Best practice for Next.js App Router:
 * - Token is fetched dynamically per request
 * - Business ID is read from localStorage (Zustand persist)
 * - Works in both Server Components and Client Components
 * - Handles token refresh automatically
 */

import { getSession } from 'next-auth/react'
import { auth } from '@/auth'
import * as Sentry from '@sentry/nextjs'
import type { ExtendedSession } from '@/types/auth'
import { sanitizeForSentry } from '@/lib/errors/error-handler'
import { getE2EGatewayMockResponse } from './e2e-gateway-mocks'
import { withTraceHeaders } from '@/shared/observability/trace-context'
import { isE2eHarnessAccessToken } from '@/lib/auth/e2e-harness-token'

/**
 * Get the selected business ID from localStorage (Zustand persist)
 * Only works on client-side
 */
function getSelectedBusinessId(): string | null {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const stored = localStorage.getItem('business-store')
    if (!stored) return null

    const parsed = JSON.parse(stored)
    return parsed?.state?.selectedBusiness?.business_id || null
  } catch {
    return null
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public data?: unknown,
    public retryAfterSeconds?: number
  ) {
    super(`API Error: ${status} ${statusText}`)
    this.name = 'ApiError'
  }
}

function responseRetryAfter(response: Response): number | undefined {
  const header = response.headers.get('Retry-After')?.trim()
  if (!header) return undefined
  if (/^\d+$/.test(header)) {
    const seconds = Number(header)
    return Number.isSafeInteger(seconds) ? seconds : undefined
  }
  const timestamp = Date.parse(header)
  return Number.isFinite(timestamp)
    ? Math.max(0, Math.ceil((timestamp - Date.now()) / 1000))
    : undefined
}

export interface FetchOptions extends Omit<RequestInit, 'body'> {
  params?: Record<string, string | number | boolean>
  timeout?: number
  body?: unknown
  skipBusinessIdHeader?: boolean
}

const GATEWAY_URL =
  typeof window === 'undefined'
    ? process.env.GATEWAY_URL ||
      process.env.NEXT_PUBLIC_GATEWAY_URL ||
      'http://localhost:8765'
    : process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:8765'

/**
 * Optional local computer-support backend for hybrid debug. When set, only
 * `/api/support/**` and `/api/checklist/**` calls bypass the gateway and hit
 * the local FastAPI process; every other endpoint keeps using the gateway.
 * Unset in every deployed environment.
 */
const SUPPORT_BACKEND_URL = (
  typeof window === 'undefined'
    ? process.env.SUPPORT_BACKEND_URL ||
      process.env.NEXT_PUBLIC_SUPPORT_BACKEND_URL ||
      ''
    : process.env.NEXT_PUBLIC_SUPPORT_BACKEND_URL || ''
).replace(/\/+$/, '')

const SUPPORT_ENDPOINT_PATTERN = /^\/api\/(support|checklist)(\/|$)/

function resolveBaseUrl(endpoint: string): string {
  if (SUPPORT_BACKEND_URL && SUPPORT_ENDPOINT_PATTERN.test(endpoint)) {
    return SUPPORT_BACKEND_URL
  }
  return GATEWAY_URL
}

/**
 * Token cache for client-side requests
 * Reduces multiple getSession() calls to 1 per 5 seconds
 */
let tokenCache: { value: string | null; expires: number } | null = null

/**
 * Pending promise for deduplication
 * Prevents multiple concurrent getSession() calls
 */
let pendingTokenPromise: Promise<string | null> | null = null

/**
 * Clear token cache (call on logout)
 */
export function clearTokenCache(): void {
  tokenCache = null
  pendingTokenPromise = null
}

/**
 * Get auth token with caching and deduplication
 * Works in both server and client contexts
 *
 * Client-side:
 * - Caches token for 5 seconds to avoid repeated calls
 * - Deduplicates concurrent requests (5 simultaneous calls = 1 getSession())
 * Server-side: Always fetches fresh token (no caching)
 */
async function getAuthToken(): Promise<string | null> {
  try {
    // Server-side (RSC, Server Actions, API Routes) - always fetch fresh
    if (typeof window === 'undefined') {
      const session = (await auth()) as ExtendedSession | null
      return session?.accessToken || null
    }

    // Client-side: Check cache first (fast path)
    if (tokenCache && Date.now() < tokenCache.expires) {
      return tokenCache.value
    }

    // Deduplication: If there's already a pending request, wait for it
    if (pendingTokenPromise) {
      return pendingTokenPromise
    }

    // Create new promise for this request (other concurrent calls will share it)
    pendingTokenPromise = (async () => {
      try {
        // Fetch fresh session
        const session = (await getSession()) as ExtendedSession | null

        // Check for token errors - emit event for useSessionGuard
        if (
          session?.error === 'RefreshAccessTokenError' ||
          session?.error === 'RefreshTokenExpired'
        ) {
          if (process.env.NODE_ENV === 'development') {
          }

          // Emit event for useSessionGuard to capture
          window.dispatchEvent(
            new CustomEvent('auth:session-error', {
              detail: { error: session.error },
            })
          )

          return null
        }

        // Cache the token based on actual expiration time
        const BUFFER_MS = 30_000 // Refresh 30s before expiry
        const MAX_CACHE_MS = 5 * 60_000 // Max 5 minutes cache

        const expiresAt = session?.expiresAt
        let cacheExpires: number

        if (expiresAt) {
          // Use token expiration minus buffer
          const timeUntilExpiry = expiresAt - Date.now() - BUFFER_MS
          cacheExpires =
            Date.now() + Math.min(Math.max(timeUntilExpiry, 0), MAX_CACHE_MS)
        } else {
          // Fallback to 5 seconds if no expiresAt
          cacheExpires = Date.now() + 5000
        }

        tokenCache = {
          value: session?.accessToken || null,
          expires: cacheExpires,
        }

        return tokenCache.value
      } finally {
        // Clear pending promise when done (success or error)
        pendingTokenPromise = null
      }
    })()

    return pendingTokenPromise
  } catch {
    pendingTokenPromise = null
    return null
  }
}

/**
 * Build URL with query parameters
 */
function buildUrl(
  endpoint: string,
  params?: Record<string, string | number | boolean>
): string {
  const url = `${resolveBaseUrl(endpoint)}${endpoint}`

  if (!params) return url

  const searchParams = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      searchParams.append(key, String(value))
    }
  })

  const queryString = searchParams.toString()
  if (!queryString) return url

  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}${queryString}`
}

/**
 * Fetch with timeout support
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeout = 30000
): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    return response
  } catch (error) {
    clearTimeout(timeoutId)
    throw error
  }
}

/**
 * Main request function
 * Gets token dynamically on each request
 */
async function request<T>(
  endpoint: string,
  options: FetchOptions = {}
): Promise<T> {
  const {
    params,
    timeout,
    body,
    skipBusinessIdHeader = false,
    headers: customHeaders,
    ...fetchOptions
  } = options

  const url = buildUrl(endpoint, params)
  const method = options.method || 'GET'
  const traceSeed = withTraceHeaders(customHeaders)

  const spanResult = Sentry.startSpan(
    {
      name: `${method} ${endpoint}`,
      op: 'http.client',
      attributes: {
        'http.method': method,
        'http.url': endpoint,
        'http.client': 'gatewayClient',
      },
    },
    async span => {
      // Helper to execute request with a given token
      function executeRequest(
        token: string | null,
        attempt = 1
      ): Promise<Response> {
        const isFormData = body instanceof FormData
        const headers = withTraceHeaders(traceSeed.headers, { attempt }).headers
        if (!isFormData && !headers.has('content-type')) {
          headers.set('content-type', 'application/json')
        }

        if (token) {
          headers.set('authorization', `Bearer ${token}`)
        }

        const businessId = getSelectedBusinessId()
        if (businessId && !skipBusinessIdHeader) {
          headers.set('x-business-id', businessId)
        }

        const serializedBody = isFormData
          ? (body as FormData)
          : body
            ? JSON.stringify(body)
            : undefined

        return fetchWithTimeout(
          url,
          {
            ...fetchOptions,
            credentials: options.credentials ?? 'omit',
            headers,
            body: serializedBody,
          },
          timeout
        )
      }

      try {
        // 1. Get token and make request
        const token = await getAuthToken()
        const e2eMock =
          process.env.NODE_ENV !== 'production' &&
          isE2eHarnessAccessToken(token)
            ? getE2EGatewayMockResponse({
                endpoint,
                method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
                selectedBusinessId: getSelectedBusinessId(),
              })
            : undefined
        if (e2eMock !== undefined) return e2eMock as T

        let response = await executeRequest(token)

        // 2. On 401 → invalidate cache, get fresh token, retry ONCE
        if (response.status === 401) {
          tokenCache = null
          const freshToken = await getAuthToken()

          // Only retry if we got a different token
          if (freshToken && freshToken !== token) {
            response = await executeRequest(freshToken, 2)
          }
        }

        // Handle non-OK responses
        if (!response.ok) {
          let errorData: unknown
          // Read body as text first (can only be read once)
          const text = await response.text()
          try {
            // Try to parse as JSON
            errorData = JSON.parse(text)
          } catch {
            // If JSON parsing fails, use text as-is
            errorData =
              text || `Error ${response.status}: ${response.statusText}`
          }

          throw new ApiError(
            response.status,
            response.statusText,
            errorData,
            responseRetryAfter(response)
          )
        }

        span.setStatus({ code: 1, message: 'ok' })
        span.setAttribute('http.status_code', response.status)

        // Breadcrumb for successful request
        Sentry.addBreadcrumb({
          category: 'http',
          type: 'http',
          message: `${method} ${endpoint}`,
          data: {
            url: endpoint,
            method,
            status_code: response.status,
          },
          level: 'info',
        })

        // Handle empty responses
        const contentType = response.headers.get('content-type')
        if (!contentType || !contentType.includes('application/json')) {
          const text = await response.text()
          return (text || null) as T
        }

        const json = await response.json()
        return json
      } catch (error) {
        span.setStatus({
          code: 2,
          message: error instanceof Error ? error.message : 'unknown',
        })

        // Breadcrumb for failed request
        Sentry.addBreadcrumb({
          category: 'http',
          type: 'http',
          message: `${method} ${endpoint} FAILED`,
          data: {
            url: endpoint,
            method,
            status_code: error instanceof ApiError ? error.status : undefined,
            error_type:
              error instanceof ApiError ? 'api_error' : 'network_error',
          },
          level: 'error',
        })

        // Capture in Sentry with enriched context
        Sentry.captureException(error, {
          tags: {
            api_endpoint: endpoint,
            http_method: method,
            error_type:
              error instanceof ApiError ? 'api_error' : 'network_error',
          },
          extra: {
            url,
            params: options.params,
            status: error instanceof ApiError ? error.status : undefined,
            response_data:
              error instanceof ApiError
                ? sanitizeForSentry(error.data)
                : undefined,
          },
          level:
            error instanceof ApiError && error.status >= 500
              ? 'error'
              : 'warning',
        })

        if (error instanceof ApiError) {
          throw error
        }

        if (error instanceof Error) {
          if (error.name === 'AbortError') {
            throw new Error('Request timeout')
          }
          throw error
        }

        throw new Error('Unknown error occurred')
      }
    }
  )
  return spanResult
}

/**
 * Like `request<T>` but returns both the parsed body and the response Headers.
 * Use when consumers need to read response headers (e.g. `ETag` for
 * optimistic concurrency on PATCH /api/strategy/plan/:planId).
 *
 * Mirrors `request<T>`'s auth/retry/sentry pipeline. Kept as a separate
 * function (not a wrapper) to avoid touching the heavily-used core path.
 */
async function requestWithMetaInternal<T>(
  endpoint: string,
  options: FetchOptions = {}
): Promise<{ data: T; headers: Headers }> {
  const {
    params,
    timeout,
    body,
    skipBusinessIdHeader = false,
    headers: customHeaders,
    ...fetchOptions
  } = options

  const url = buildUrl(endpoint, params)
  const method = options.method || 'GET'
  const traceSeed = withTraceHeaders(customHeaders)

  return Sentry.startSpan(
    {
      name: `${method} ${endpoint}`,
      op: 'http.client',
      attributes: {
        'http.method': method,
        'http.url': endpoint,
        'http.client': 'gatewayClient',
      },
    },
    async span => {
      function executeRequest(
        token: string | null,
        attempt = 1
      ): Promise<Response> {
        const isFormData = body instanceof FormData
        const headers = withTraceHeaders(traceSeed.headers, { attempt }).headers
        if (!isFormData && !headers.has('content-type')) {
          headers.set('content-type', 'application/json')
        }

        if (token) {
          headers.set('authorization', `Bearer ${token}`)
        }

        const businessId = getSelectedBusinessId()
        if (businessId && !skipBusinessIdHeader) {
          headers.set('x-business-id', businessId)
        }

        const serializedBody = isFormData
          ? (body as FormData)
          : body
            ? JSON.stringify(body)
            : undefined

        return fetchWithTimeout(
          url,
          {
            ...fetchOptions,
            credentials: options.credentials ?? 'omit',
            headers,
            body: serializedBody,
          },
          timeout
        )
      }

      try {
        const token = await getAuthToken()
        const e2eMock =
          process.env.NODE_ENV !== 'production' &&
          isE2eHarnessAccessToken(token)
            ? getE2EGatewayMockResponse({
                endpoint,
                method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
                selectedBusinessId: getSelectedBusinessId(),
              })
            : undefined
        if (e2eMock !== undefined) {
          return { data: e2eMock as T, headers: new Headers() }
        }

        let response = await executeRequest(token)

        if (response.status === 401) {
          tokenCache = null
          const freshToken = await getAuthToken()
          if (freshToken && freshToken !== token) {
            response = await executeRequest(freshToken, 2)
          }
        }

        if (!response.ok) {
          let errorData: unknown
          const text = await response.text()
          try {
            errorData = JSON.parse(text)
          } catch {
            errorData =
              text || `Error ${response.status}: ${response.statusText}`
          }
          throw new ApiError(
            response.status,
            response.statusText,
            errorData,
            responseRetryAfter(response)
          )
        }

        span.setStatus({ code: 1, message: 'ok' })
        span.setAttribute('http.status_code', response.status)

        Sentry.addBreadcrumb({
          category: 'http',
          type: 'http',
          message: `${method} ${endpoint}`,
          data: {
            url: endpoint,
            method,
            status_code: response.status,
          },
          level: 'info',
        })

        const responseHeaders = response.headers
        const contentType = response.headers.get('content-type')
        let data: T
        if (!contentType || !contentType.includes('application/json')) {
          const text = await response.text()
          data = (text || null) as T
        } else {
          data = (await response.json()) as T
        }
        return { data, headers: responseHeaders }
      } catch (error) {
        span.setStatus({
          code: 2,
          message: error instanceof Error ? error.message : 'unknown',
        })

        Sentry.addBreadcrumb({
          category: 'http',
          type: 'http',
          message: `${method} ${endpoint} FAILED`,
          data: {
            url: endpoint,
            method,
            status_code: error instanceof ApiError ? error.status : undefined,
            error_type:
              error instanceof ApiError ? 'api_error' : 'network_error',
          },
          level: 'error',
        })

        Sentry.captureException(error, {
          tags: {
            api_endpoint: endpoint,
            http_method: method,
            error_type:
              error instanceof ApiError ? 'api_error' : 'network_error',
          },
          extra: {
            url,
            params: options.params,
            status: error instanceof ApiError ? error.status : undefined,
            response_data:
              error instanceof ApiError
                ? sanitizeForSentry(error.data)
                : undefined,
          },
          level:
            error instanceof ApiError && error.status >= 500
              ? 'error'
              : 'warning',
        })

        if (error instanceof ApiError) {
          throw error
        }

        if (error instanceof Error) {
          if (error.name === 'AbortError') {
            throw new Error('Request timeout')
          }
          throw error
        }

        throw new Error('Unknown error occurred')
      }
    }
  )
}

/**
 * Gateway Client
 * All API calls through the Gateway with automatic auth
 */
export const gatewayClient = {
  /**
   * GET request
   */
  async get<T>(
    endpoint: string,
    options?: Omit<FetchOptions, 'body'>
  ): Promise<T> {
    return request<T>(endpoint, { ...options, method: 'GET' })
  },
  /**
   * POST request
   */
  async post<T>(
    endpoint: string,
    data?: unknown,
    options?: Omit<FetchOptions, 'body'>
  ): Promise<T> {
    return request<T>(endpoint, { ...options, method: 'POST', body: data })
  },

  /**
   * PUT request
   */
  async put<T>(
    endpoint: string,
    data?: unknown,
    options?: Omit<FetchOptions, 'body'>
  ): Promise<T> {
    return request<T>(endpoint, { ...options, method: 'PUT', body: data })
  },

  /**
   * PATCH request
   */
  async patch<T>(
    endpoint: string,
    data?: unknown,
    options?: Omit<FetchOptions, 'body'>
  ): Promise<T> {
    return request<T>(endpoint, { ...options, method: 'PATCH', body: data })
  },

  /**
   * DELETE request
   */
  async delete<T>(
    endpoint: string,
    options?: Omit<FetchOptions, 'body'>
  ): Promise<T> {
    return request<T>(endpoint, { ...options, method: 'DELETE' })
  },

  /**
   * GET with response metadata (headers). Use when the consumer needs
   * to read response headers — e.g. `ETag` for optimistic concurrency.
   */
  async getWithMeta<T>(
    endpoint: string,
    options?: Omit<FetchOptions, 'body'>
  ): Promise<{ data: T; headers: Headers }> {
    return requestWithMetaInternal<T>(endpoint, { ...options, method: 'GET' })
  },

  /**
   * PATCH with response metadata (headers). Same purpose as `getWithMeta`.
   */
  async patchWithMeta<T>(
    endpoint: string,
    data?: unknown,
    options?: Omit<FetchOptions, 'body'>
  ): Promise<{ data: T; headers: Headers }> {
    return requestWithMetaInternal<T>(endpoint, {
      ...options,
      method: 'PATCH',
      body: data,
    })
  },
}

export default gatewayClient
