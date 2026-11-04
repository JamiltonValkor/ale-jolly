/**
 * Multi-Business Architecture Types
 *
 * Types for managing multiple businesses per user,
 * including quota management and subscription tiers.
 */

// ============================================
// Subscription Tiers
// ============================================

export type SubscriptionTier = 'trial' | 'pro' | 'business' | 'agency'

export const TIER_LIMITS: Record<
  SubscriptionTier,
  { maxBusinesses: number; maxCampaigns: number }
> = {
  trial: { maxBusinesses: 1, maxCampaigns: 5 },
  pro: { maxBusinesses: 3, maxCampaigns: 20 },
  business: { maxBusinesses: 10, maxCampaigns: 50 },
  agency: { maxBusinesses: 25, maxCampaigns: 100 },
}

// ============================================
// Business Types
// ============================================

export type BusinessCompletionStatus = 'incomplete' | 'complete'

export type BusinessOfferingType = 'products' | 'services' | 'both'

export interface Business {
  business_id: string
  business_name: string
  industry: string | null
  completion_status: BusinessCompletionStatus
  created_at: string
  is_selected: boolean
  email?: string
  country?: string
  city?: string
  currency?: string
  logo_url?: string | null
  website_url?: string
  /**
   * Offering type persisted during the Mi Negocio wizard.
   * Backend may not expose this yet — see `docs/specs/PENDIENTES-my-business.md` §3.
   * When absent, consumers should fall back to `'products'`.
   */
  offering_type?: BusinessOfferingType | null
  product_categories?: string[]
  service_categories?: string[]
  /**
   * AI-generated insights list returned by `GET /businesses/selected`
   * (spec BE §3.1). Always nullable — may be null before prefill completes.
   */
  mini_diagnostic?: string[] | null
}

export interface BusinessWithDetails extends Business {
  user_id: string
  updated_at: string
  deleted_at: string | null
}

// ============================================
// Quota Types
// ============================================

export interface QuotaInfo {
  tier: SubscriptionTier
  max_businesses: number
  current_count: number
  remaining: number
  can_create_more: boolean
}

// ============================================
// API Response Types
// ============================================

export interface BusinessListResponse {
  businesses: Business[]
  selected_business_id: string | null
  quota: QuotaInfo
}

export interface SelectedBusinessResponse {
  business: Business
  auto_selected: boolean
}

export interface CreateBusinessRequest {
  business_name: string
}

export interface CreateBusinessResponse {
  success: boolean
  message: string
  business: Business
}

export interface SelectBusinessResponse {
  success: boolean
  message: string
  business: Business
}

export interface DeleteBusinessResponse {
  success: boolean
  message: string
}

// ============================================
// Error Types
// ============================================

export type BusinessErrorCode =
  | 'NO_BUSINESS_SELECTED'
  | 'BUSINESS_LIMIT_REACHED'
  | 'ACCESS_DENIED'
  | 'NO_BUSINESSES'
  | 'BUSINESS_NOT_FOUND'
  | 'INVALID_BUSINESS_NAME'

export interface BusinessLimitError {
  error: 'BUSINESS_LIMIT_REACHED'
  message: string
  quota: {
    tier: string
    limit: number
    current: number
  }
  upgrade_required: true
}

export interface BusinessError {
  error: BusinessErrorCode
  message: string
  quota?: {
    tier: string
    limit: number
    current: number
  }
  upgrade_required?: boolean
}

// ============================================
// Store State Types
// ============================================

export interface BusinessStoreState {
  // Business data
  businesses: Business[]
  selectedBusiness: Business | null
  quota: QuotaInfo | null

  // Loading states
  isLoadingBusinesses: boolean
  isSelectingBusiness: boolean
  isCreatingBusiness: boolean
  isDeletingBusiness: boolean

  // Error states
  error: string | null

  // Initialization
  hasInitialized: boolean
}

export interface BusinessStoreActions {
  // Data fetching
  loadBusinesses: () => Promise<void>
  getSelectedBusiness: () => Promise<Business | null>

  // Business management
  selectBusiness: (businessId: string) => Promise<boolean>
  createBusiness: (name: string) => Promise<Business | null>
  deleteBusiness: (businessId: string) => Promise<boolean>

  // State management
  setSelectedBusiness: (business: Business | null) => void
  clearError: () => void
  reset: () => void
}

export type BusinessStore = BusinessStoreState & BusinessStoreActions

// ============================================
// Component Props Types
// ============================================

export interface BusinessSelectorProps {
  className?: string
  onBusinessChange?: (business: Business) => void
}

export interface BusinessCreationModalProps {
  isOpen: boolean
  onClose: () => void
  onSuccess?: (business: Business) => void
}

export interface QuotaLimitModalProps {
  isOpen: boolean
  onClose: () => void
  quota: QuotaInfo
  onUpgrade?: () => void
}

export interface BusinessManagementPageProps {
  businesses: Business[]
  quota: QuotaInfo
  selectedBusinessId: string | null
}

// ============================================
// Utility Types
// ============================================

export function isBusinessLimitError(
  error: unknown
): error is BusinessLimitError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'error' in error &&
    (error as BusinessLimitError).error === 'BUSINESS_LIMIT_REACHED'
  )
}

export function getBusinessDisplayName(business: Business | null): string {
  if (!business) return 'Select Business'
  return business.business_name
}

export function getBusinessInitials(business: Business | null): string {
  if (!business) return '?'
  const words = business.business_name.split(' ')
  if (words.length >= 2) {
    return `${words[0][0]}${words[1][0]}`.toUpperCase()
  }
  return business.business_name.substring(0, 2).toUpperCase()
}
