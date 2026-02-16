/**
 * API Client
 * Provides typed access to the Curiosity Intelligence backend API
 */

const BASE_URL = '/api/v1'

// ============================================
// TYPES
// ============================================

export interface Signal {
  id: number
  run_id: number
  week: string
  canonical_question: string
  final_score: number
  velocity_score: number
  cross_platform_score: number
  engagement_score: number
  novelty_score: number
  weirdness_bonus: number
  tier: string
  is_signal: boolean
  velocity_pct: number
  question_count: number
  platform_count: number
  platforms: string[]
  news_trigger?: Record<string, unknown>
  sample_questions: string[]
}

export interface SignalListResponse {
  signals: Signal[]
  total: number
  page: number
  per_page: number
}

export interface Run {
  id: number
  title: string
  status: string
  created_at: string
  updated_at: string
  signal_count: number
  avg_score: number
}

export interface RunListResponse {
  runs: Run[]
  total: number
}

export interface TenantUsage {
  runs: {
    used: number
    limit: number
  }
  questions_ingested: number
  signals_detected: number
}

// ============================================
// API HELPERS
// ============================================

async function fetchJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })

  if (!response.ok) {
    throw new Error(`API error: ${response.statusText}`)
  }

  return response.json() as Promise<T>
}

// ============================================
// SIGNALS API
// ============================================

export const signalsApi = {
  async list(options: {
    tier?: string
    week?: string
    page?: number
    per_page?: number
    search?: string
  }): Promise<SignalListResponse> {
    const searchParams = new URLSearchParams()
    
    if (options.tier) searchParams.append('tier', options.tier)
    if (options.week) searchParams.append('week', options.week)
    if (options.page) searchParams.append('page', String(options.page))
    if (options.per_page) searchParams.append('per_page', String(options.per_page))
    if (options.search) searchParams.append('search', options.search)
    
    const query = searchParams.toString()
    const url = `${BASE_URL}/signals${query ? `?${query}` : ''}`
    
    return fetchJson<SignalListResponse>(url)
  },

  async get(id: number): Promise<Signal> {
    return fetchJson<Signal>(`${BASE_URL}/signals/${id}`)
  },

  async getTrending(count: number): Promise<Signal[]> {
    const response = await fetchJson<{ signals: Signal[] }>(
      `${BASE_URL}/signals/trending?limit=${count}`
    )
    return response.signals
  },

  async getBreakouts(): Promise<Signal[]> {
    const response = await fetchJson<{ signals: Signal[] }>(
      `${BASE_URL}/signals/breakouts`
    )
    return response.signals
  },
}

// ============================================
// RUNS API
// ============================================

export const runsApi = {
  async list(options: { limit?: number } = {}): Promise<RunListResponse> {
    const searchParams = new URLSearchParams()
    if (options.limit) searchParams.append('limit', String(options.limit))
    
    const query = searchParams.toString()
    const url = `${BASE_URL}/runs${query ? `?${query}` : ''}`
    
    return fetchJson<RunListResponse>(url)
  },

  async get(id: number): Promise<Run> {
    return fetchJson<Run>(`${BASE_URL}/runs/${id}`)
  },

  async create(): Promise<Run> {
    return fetchJson<Run>(`${BASE_URL}/runs`, {
      method: 'POST',
    })
  },
}

// ============================================
// TENANTS API
// ============================================

export const tenantsApi = {
  async getUsage(): Promise<TenantUsage> {
    return fetchJson<TenantUsage>(`${BASE_URL}/tenants/usage`)
  },
}

// ============================================
// EXPERIMENTS API
// ============================================

export const experimentsApi = {
  async list(): Promise<Record<string, unknown>[]> {
    return fetchJson<Record<string, unknown>[]>(`${BASE_URL}/experiments`)
  },

  async get(id: number): Promise<Record<string, unknown>> {
    return fetchJson<Record<string, unknown>>(`${BASE_URL}/experiments/${id}`)
  },
}
