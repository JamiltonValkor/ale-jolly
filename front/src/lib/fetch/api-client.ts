/**
 * API Client using native fetch
 * Next.js 16 compatible with automatic caching support
 */

import * as Sentry from '@sentry/nextjs'
import { sanitizeForSentry } from '@/lib/errors/error-handler'
import { withTraceHeaders } from '@/shared/observability/trace-context'

export class ApiError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public data?: unknown
  ) {
    super(`API Error: ${status} ${statusText}`)
    this.name = 'ApiError'
  }
}

export interface FetchOptions extends RequestInit {
  params?: Record<string, string | number | boolean>
  timeout?: number
}

/**
 * Build URL with query parameters
 */
function buildUrl(
  url: string,
  params?: Record<string, string | number | boolean>
): string {
  if (!params) return url

  const searchParams = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    searchParams.append(key, String(value))
  })

  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}${searchParams.toString()}`
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
 * Main API client
 */
class ApiClient {
  private baseUrl: string
  private defaultHeaders: HeadersInit

  constructor(baseUrl: string = '') {
    this.baseUrl = baseUrl || process.env.NEXT_PUBLIC_API_URL || ''
    this.defaultHeaders = {
      'Content-Type': 'application/json',
    }
  }

  /**
   * Set authorization token
   */
  setAuthToken(token: string | null) {
    if (token) {
      this.defaultHeaders = {
        ...this.defaultHeaders,
        Authorization: `Bearer ${token}`,
      }
    } else {
      const { Authorization: _Authorization, ...rest } = this
        .defaultHeaders as Record<string, string>
      this.defaultHeaders = rest
    }
  }

  /**
   * Generic request method
   */
  private async request<T>(
    endpoint: string,
    options: FetchOptions = {}
  ): Promise<T> {
    const { params, timeout, headers, ...fetchOptions } = options

    const url = buildUrl(`${this.baseUrl}${endpoint}`, params)
    const method = options.method || 'GET'

    return Sentry.startSpan(
      {
        name: `${method} ${endpoint}`,
        op: 'http.client',
        attributes: {
          'http.method': method,
          'http.url': endpoint,
          'http.client': 'apiClient',
        },
      },
      async span => {
        try {
          const response = await fetchWithTimeout(
            url,
            {
              ...fetchOptions,
              headers: withTraceHeaders({
                ...this.defaultHeaders,
                ...headers,
              }).headers,
            },
            timeout
          )

          // Handle non-OK responses
          if (!response.ok) {
            let errorData: unknown
            try {
              errorData = await response.json()
            } catch {
              errorData = await response.text()
            }

            throw new ApiError(response.status, response.statusText, errorData)
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
            return (await response.text()) as T
          }

          return await response.json()
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
              status_text:
                error instanceof ApiError ? error.statusText : undefined,
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

          // Re-throw ApiErrors
          if (error instanceof ApiError) {
            throw error
          }

          // Handle network errors
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
   * GET request
   */
  async get<T>(endpoint: string, options?: FetchOptions): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: 'GET',
    })
  }

  /**
   * POST request
   */
  async post<T>(
    endpoint: string,
    data?: unknown,
    options?: FetchOptions
  ): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  /**
   * PUT request
   */
  async put<T>(
    endpoint: string,
    data?: unknown,
    options?: FetchOptions
  ): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: 'PUT',
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  /**
   * PATCH request
   */
  async patch<T>(
    endpoint: string,
    data?: unknown,
    options?: FetchOptions
  ): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: 'PATCH',
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  /**
   * DELETE request
   */
  async delete<T>(endpoint: string, options?: FetchOptions): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: 'DELETE',
    })
  }
}

// Export singleton instance
export const apiClient = new ApiClient()

// Export class for custom instances
export default ApiClient
