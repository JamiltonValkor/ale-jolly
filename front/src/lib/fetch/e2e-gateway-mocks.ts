type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

interface MockContext {
  endpoint: string
  method: HttpMethod
  selectedBusinessId: string | null
}

const now = () => new Date().toISOString()

const tiktokWhatsAppE2eEnabled =
  process.env.NEXT_PUBLIC_TIKTOK_ADS_FEATURES?.split(',').some(
    feature => feature.trim().toLowerCase() === 'whatsapp'
  )

function mockBusiness(selectedBusinessId: string | null) {
  return {
    business_id: selectedBusinessId ?? '00000000-0000-4000-8000-000000000001',
    business_name: 'E2E Business',
    industry: 'retail',
    completion_status: 'complete',
    created_at: now(),
    is_selected: true,
    email: 'e2e@saleads.test',
    country: 'CO',
    city: 'Bogota',
    currency: 'USD',
    logo_url: null,
    website_url: 'https://example.com',
  }
}

function mockSubscription() {
  return {
    user_id: 'e2e-user-1',
    subscription_tier: 'business',
    subscription_status: 'active',
    billing_interval: 'monthly',
    current_period_start: now(),
    current_period_end: now(),
    trial_ends_at: null,
    cancel_at: null,
    quota_usage: {
      campaigns_used: 2,
      campaigns_limit: 50,
      businesses_used: 1,
      businesses_limit: 10,
      images_used: 0,
      images_limit: 500,
      credits_used: 0,
      credits_limit: 5000,
    },
    amount: 0,
    currency: 'USD',
  }
}

function mockCreditBalance() {
  return {
    user_id: 'e2e-user-1',
    total_balance: 5000,
    monthly: {
      allocated: 5000,
      used: 0,
      remaining: 5000,
      resets_at: now(),
    },
    purchased: {
      balance: 0,
      never_expires: true,
    },
    is_unlimited: false,
    welcome_credits_granted: true,
    lifetime: {
      purchased: 0,
      spent: 0,
      bonus: 5000,
    },
    current_month: {
      spent: 0,
      period_start: now(),
      period_end: now(),
    },
  }
}

function mockOnboardingStatus() {
  return {
    success: true,
    data: {
      show_onboarding: true,
      current_step: 1,
      completed_count: 0,
      is_complete: false,
      steps: {
        platform_connected: false,
        platform_configured: false,
        brief_generated: false,
        strategy_launched: false,
      },
      platform: 'meta',
      journey: {
        id: 'e2e-journey-1',
        status: 'in_progress',
        started_at: now(),
        completed_at: null,
      },
    },
  }
}

function mockWorldCupCredits() {
  return {
    success: true,
    data: {
      availableCredits: 0,
      activeGrants: [],
      lastKnownCreditsBalance: 5000,
      syncedAt: now(),
    },
  }
}

/**
 * Specs that run a stateful stub gateway (e.g. account-plan) list endpoints
 * here so they reach it over HTTP instead of these fixed fixtures.
 */
const PASSTHROUGH_KEY = 'e2e-gateway-passthrough'
function passesThrough(endpoint: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    return (window.localStorage.getItem(PASSTHROUGH_KEY) ?? '')
      .split(',')
      .some(
        prefix =>
          !!prefix && (endpoint === prefix || endpoint.startsWith(`${prefix}/`))
      )
  } catch {
    return false
  }
}

export function getE2EGatewayMockResponse({
  endpoint,
  method,
  selectedBusinessId,
}: MockContext): unknown | undefined {
  if (passesThrough(endpoint)) return undefined
  if (method === 'GET' && endpoint === '/api/businesses') {
    const business = mockBusiness(selectedBusinessId)
    return {
      businesses: [business],
      selected_business_id: business.business_id,
      quota: {
        tier: 'business',
        max_businesses: 10,
        current_count: 1,
        remaining: 9,
        can_create_more: true,
      },
    }
  }

  if (method === 'GET' && endpoint === '/api/businesses/selected') {
    return {
      business: mockBusiness(selectedBusinessId),
      auto_selected: false,
    }
  }

  if (method === 'GET' && endpoint === '/api/subscription/current') {
    return mockSubscription()
  }

  if (method === 'GET' && endpoint === '/api/subscription/plans') {
    return {
      plans: [
        {
          tier: 'business',
          name: 'Business',
          price_monthly: 0,
          price_yearly: 0,
          max_campaigns: 50,
          max_businesses: 10,
          features: ['E2E local plan'],
        },
      ],
    }
  }

  if (method === 'GET' && endpoint === '/api/subscription/credits/balance') {
    return {
      success: true,
      balance: mockCreditBalance(),
    }
  }

  if (method === 'GET' && endpoint === '/api/subscription/credits/packs') {
    return { success: true, packs: [] }
  }

  if (method === 'GET' && endpoint === '/api/subscription/credits/costs') {
    return {
      success: true,
      costs: {
        junior: { credits: 23, name: 'Junior', description: 'Draft quality' },
        mid: { credits: 60, name: 'Mid', description: 'Standard quality' },
        senior: { credits: 106, name: 'Senior', description: 'Ultra quality' },
      },
    }
  }

  if (
    method === 'GET' &&
    endpoint === '/api/onboarding/questionnaire/status/account'
  ) {
    return {
      completed: true,
      version: 'e2e',
      exempt: false,
      needs_confirmation: false,
      updated_at: now(),
    }
  }

  if (
    method === 'GET' &&
    endpoint.startsWith('/api/onboarding/questionnaire/status/business/')
  ) {
    return {
      completed: true,
      version: 'e2e',
      exempt: false,
      revenue_answered: true,
    }
  }

  if (method === 'GET' && endpoint === '/api/onboarding/status') {
    if (selectedBusinessId === 'biz-test-tiktok-whatsapp') {
      return {
        success: true,
        data: {
          show_onboarding: false,
          current_step: null,
          completed_count: 4,
          is_complete: true,
          steps: {
            platform_connected: true,
            platform_configured: true,
            brief_generated: true,
            strategy_launched: true,
          },
          platform: 'tiktok',
        },
      }
    }
    return mockOnboardingStatus()
  }

  if (
    method === 'GET' &&
    /^\/api\/campaigns\/business\/[^/]+\/metrics$/.test(endpoint)
  ) {
    return {
      success: true,
      data: {
        business_id: selectedBusinessId ?? 'e2e-business',
        period: '30d',
        date_from: now(),
        date_to: now(),
        total_campaigns: 3,
        metrics: {
          spend: { value: 1240, currency: 'USD', change_pct: 12 },
          results: { value: 84, change_pct: 9 },
          reach: { value: 18200, change_pct: 18 },
          roas: { value: 3.4, change_pct: 6 },
        },
      },
    }
  }

  if (
    method === 'GET' &&
    /^\/api\/campaigns\/business\/[^/]+$/.test(endpoint)
  ) {
    return {
      success: true,
      data: [],
      pagination: { total: 0, limit: 50, offset: 0 },
      status_counts: { ACTIVE: 0, PAUSED: 0, DELETED: 0, DRAFT: 0 },
    }
  }

  if (method === 'GET' && endpoint === '/api/strategy/plan/library') {
    return {
      data: [],
      pagination: { total: 0, limit: 100, offset: 0 },
      status_counts: {
        draft: 0,
        active: 0,
        paused: 0,
        completed: 0,
        cancelled: 0,
      },
    }
  }

  if (method === 'GET' && endpoint === '/api/integration/platforms') {
    if (selectedBusinessId === 'biz-test-tiktok-whatsapp') {
      return {
        platforms: {
          meta: { connected: false, configured: false },
          tiktok: { connected: true, configured: true },
          google_ads: { connected: false, configured: false },
        },
        connectedCount: 1,
      }
    }
    return {
      platforms: {
        meta: {
          connected: true,
          configured: true,
          tokenExpired: false,
          connectedAt: now(),
          assets: {
            page: { connected: true, configured: true, name: 'E2E Page' },
            ad_account: {
              connected: true,
              configured: true,
              name: 'E2E Ad Account',
            },
            pixel: { connected: true, configured: true, name: 'E2E Pixel' },
            instagram: {
              connected: true,
              configured: true,
              name: 'E2E Instagram',
            },
            whatsapp: {
              connected: true,
              configured: true,
              name: 'E2E WhatsApp',
            },
            website: { connected: true, configured: true, name: 'E2E Website' },
          },
        },
        tiktok: {
          connected: tiktokWhatsAppE2eEnabled,
          configured: tiktokWhatsAppE2eEnabled,
        },
        google_ads: { connected: false, configured: false },
      },
      connectedCount: tiktokWhatsAppE2eEnabled ? 2 : 1,
    }
  }

  if (
    method === 'GET' &&
    endpoint === '/api/user-profile/account-manager/status'
  ) {
    return {
      success: true,
      data: {
        activated: false,
        activated_source: null,
        should_show_prompt: false,
        should_show_reminder: false,
        has_active_code: false,
        email_masked: 'e2e@saleads.test',
        last_sent_at: null,
      },
    }
  }

  if (
    method === 'POST' &&
    endpoint === '/api/user-profile/account-manager/send-code'
  ) {
    return {
      success: true,
      data: {
        status: 'sent',
        template_code: 'E2E-ACCOUNT-MANAGER',
        email_masked: 'e2e@saleads.test',
        attempts: 1,
      },
    }
  }

  if (
    method === 'POST' &&
    endpoint === '/api/user-profile/account-manager/acknowledge'
  ) {
    return {
      success: true,
      data: { acknowledged: true },
    }
  }

  if (method === 'POST' && endpoint === '/api/notifications/firebase-token') {
    return { success: true }
  }

  if (method === 'GET' && endpoint === '/api/strategy/world-cup/matches') {
    return {
      success: true,
      data: {
        fetchedAt: now(),
        matches: [],
      },
    }
  }

  if (
    method === 'GET' &&
    endpoint === '/api/strategy/world-cup/temporary-credits'
  ) {
    return mockWorldCupCredits()
  }

  if (
    method === 'POST' &&
    endpoint === '/api/strategy/world-cup/temporary-credits/sync'
  ) {
    return mockWorldCupCredits()
  }

  return undefined
}
