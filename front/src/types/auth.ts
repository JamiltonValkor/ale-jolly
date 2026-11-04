/**
 * Authentication Types
 *
 * Types for Auth.js (NextAuth.js v5) integration with Keycloak
 */

/**
 * User from Keycloak
 */
export interface User {
  id: string
  email: string
  name: string
  firstName?: string
  lastName?: string
  avatar?: string
  emailVerified?: boolean
  roles?: string[]
  permissions?: string[]
}

/**
 * Extended JWT with Keycloak tokens
 */
export interface ExtendedJWT {
  accessToken?: string
  refreshToken?: string
  idToken?: string // Required for front-channel logout
  expiresAt?: number
  error?: string
  sub?: string
  name?: string
  email?: string
  picture?: string
  roles?: string[]
}

/**
 * Extended Session with user and tokens
 */
export interface ExtendedSession {
  user: User
  expires: string // Required by next-auth Session type
  accessToken?: string
  idToken?: string // Required for front-channel logout
  error?: string
  expiresAt?: number
}

/**
 * Keycloak Profile from token
 */
export interface KeycloakProfile {
  sub: string
  email_verified?: boolean
  name?: string
  preferred_username?: string
  given_name?: string
  family_name?: string
  email?: string
  picture?: string
  realm_access?: {
    roles?: string[]
  }
  resource_access?: Record<string, { roles?: string[] }>
}

/**
 * Auth State for Zustand Store
 */
export interface AuthState {
  user: User | null
  isLoading: boolean
  setUser: (user: User | null) => void
  clearUser: () => void
  updateUser: (updates: Partial<User>) => void
}

/**
 * Login Credentials
 */
export interface LoginCredentials {
  email: string
  password: string
}

/**
 * Action Response for auth operations
 */
export interface AuthActionResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  message?: string
}
