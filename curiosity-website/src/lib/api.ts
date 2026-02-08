/**
 * Public API client — no auth required for these endpoints.
 * Talks to the curiosity-intelligence FastAPI backend.
 */

// Use environment variable in production, relative path in development (for vite proxy)
const API_BASE = import.meta.env.VITE_API_URL 
  ? `${import.meta.env.VITE_API_URL}/api/v1`
  : '/api/v1'

async function fetchPublic<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(err.error || err.detail || `HTTP ${response.status}`)
  }

  return response.json()
}

// ─── Subscriber Types ────────────────────────────────────

export interface SubscribeRequest {
  email: string
  name?: string
  source?: string
  referral_code?: string  // who referred them
}

export interface SubscribeResponse {
  message: string
  status: 'pending_confirmation' | 'already_subscribed'
}

export interface ConfirmResponse {
  message: string
  referral_code: string  // their unique referral code
}

export interface SubscriberCount {
  count: number
  goal: number
}

export interface ReferralStats {
  referral_code: string
  referral_count: number
  name: string | null
  unlocked_tiers: string[]
}

// ─── Signal Types ────────────────────────────────────────

export interface TrendingSignal {
  id: number
  canonical_question: string
  final_score: number
  velocity_pct: number
  tier: string
  question_count: number
  platform_count: number
}

export interface EditorialSignal extends TrendingSignal {
  editorial_take: string  // Steve Jobs one-liner
}

export interface Prediction {
  prediction_text: string
  confidence: string
  week: string
  grade_display: string
  grade_explanation: string
}

// ─── Newsletter Archive ──────────────────────────────────

export interface NewsletterMeta {
  week: string
  issue_number: number
  generated_at: string
  stats: {
    total_signals: number
    questions_analyzed: number
    platforms_monitored: number
  }
}

// ─── API Methods ─────────────────────────────────────────

export const subscriberApi = {
  /** Subscribe with double opt-in — email service handles confirmation */
  subscribe: (data: SubscribeRequest) =>
    fetchPublic<SubscribeResponse>('/subscribers/subscribe', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  /** Confirm email (double opt-in) */
  confirm: (token: string) =>
    fetchPublic<ConfirmResponse>(`/subscribers/confirm/${token}`),

  /** Unsubscribe */
  unsubscribe: (token: string) =>
    fetchPublic<{ message: string }>('/subscribers/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),

  /** Get live subscriber count (for social proof) */
  count: () =>
    fetchPublic<SubscriberCount>('/subscribers/count'),

  /** Get referral stats for a referral code */
  referralStats: (code: string) =>
    fetchPublic<ReferralStats>(`/subscribers/referral/${code}`),
}

export const signalApi = {
  /** Get trending signals (public, top 5) */
  trending: (limit = 5) =>
    fetchPublic<{ trending: TrendingSignal[] }>(`/subscribers/trending?limit=${limit}`),

  /** Get editorial takes on trending signals (referral-gated) */
  editorial: (referralCode?: string) =>
    fetchPublic<{ editorial: EditorialSignal[] }>(
      `/subscribers/editorial${referralCode ? `?ref=${referralCode}` : ''}`
    ),
}

export const predictionApi = {
  /** Get latest graded prediction (for "last week we said" section) */
  latest: () =>
    fetchPublic<{ prediction: Prediction | null }>('/subscribers/prediction/latest'),
}

export const archiveApi = {
  /** Get newsletter HTML for a week */
  get: (week: string) =>
    fetchPublic<{ html: string; meta: NewsletterMeta }>(`/subscribers/newsletter/${week}`),
}

