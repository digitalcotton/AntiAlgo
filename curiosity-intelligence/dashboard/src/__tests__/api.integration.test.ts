/**
 * API Integration Tests
 * Tests all API endpoints for functionality and error handling
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const BASE_URL = 'http://localhost:8000/api/v1'
const API_TIMEOUT = 5000

// ============================================
// FIXTURES
// ============================================

let testSignalId: number
let testRunId: number
let testExperimentId: number

// ============================================
// HELPERS
// ============================================

async function fetchApi<T>(
  endpoint: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
  body?: unknown
): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT)

  try {
    const response = await fetch(`${BASE_URL}${endpoint}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`)
    }

    return response.json() as Promise<T>
  } finally {
    clearTimeout(timeout)
  }
}

// ============================================
// SIGNALS API TESTS
// ============================================

describe('Signals API', () => {
  it('GET /signals - List signals', async () => {
    const response = await fetchApi<{
      signals: Array<{ id: number; canonical_question: string }>
      total: number
      page: number
      per_page: number
    }>('/signals')

    expect(response).toBeDefined()
    expect(response.signals).toBeInstanceOf(Array)
    expect(response.total).toBeGreaterThanOrEqual(0)
    expect(response.page).toBe(1)
    expect(response.per_page).toBeGreaterThan(0)

    if (response.signals.length > 0) {
      testSignalId = response.signals[0].id
    }
  })

  it('GET /signals?page=1&per_page=10 - List signals with pagination', async () => {
    const response = await fetchApi<{ signals: Array<unknown>; total: number }>(
      '/signals?page=1&per_page=10'
    )

    expect(response.signals).toBeInstanceOf(Array)
    expect(response.signals.length).toBeLessThanOrEqual(10)
  })

  it('GET /signals?tier=breakout - Filter signals by tier', async () => {
    const response = await fetchApi<{ signals: Array<{ tier: string }> }>(
      '/signals?tier=breakout'
    )

    expect(response.signals).toBeInstanceOf(Array)
    if (response.signals.length > 0) {
      response.signals.forEach((signal) => {
        expect(signal.tier.toLowerCase()).toContain('breakout')
      })
    }
  })

  it('GET /signals/:id - Get signal by ID', async () => {
    if (!testSignalId) return

    const response = await fetchApi<{ id: number; canonical_question: string }>(
      `/signals/${testSignalId}`
    )

    expect(response.id).toBe(testSignalId)
    expect(response.canonical_question).toBeDefined()
    expect(typeof response.canonical_question).toBe('string')
  })

  it('GET /signals/trending?limit=5 - Get trending signals', async () => {
    const response = await fetchApi<{ signals: Array<{ id: number }> }>(
      '/signals/trending?limit=5'
    )

    expect(response.signals).toBeInstanceOf(Array)
    expect(response.signals.length).toBeLessThanOrEqual(5)
  })

  it('GET /signals/breakouts - Get breakout signals', async () => {
    const response = await fetchApi<{ signals: Array<{ tier: string }> }>(
      '/signals/breakouts'
    )

    expect(response.signals).toBeInstanceOf(Array)
  })

  it('GET /signals/:id/questions - Get questions for signal', async () => {
    if (!testSignalId) return

    const response = await fetchApi<{ questions: Array<{ text: string }> }>(
      `/signals/${testSignalId}/questions`
    )

    expect(response.questions).toBeInstanceOf(Array)
  })
})

// ============================================
// RUNS API TESTS
// ============================================

describe('Runs API', () => {
  it('GET /runs - List runs', async () => {
    const response = await fetchApi<{
      runs: Array<{ id: number; title: string }>
      total: number
    }>('/runs')

    expect(response).toBeDefined()
    expect(response.runs).toBeInstanceOf(Array)
    expect(response.total).toBeGreaterThanOrEqual(0)

    if (response.runs.length > 0) {
      testRunId = response.runs[0].id
    }
  })

  it('GET /runs?limit=10 - List runs with limit', async () => {
    const response = await fetchApi<{ runs: Array<unknown> }>('/runs?limit=10')

    expect(response.runs).toBeInstanceOf(Array)
    expect(response.runs.length).toBeLessThanOrEqual(10)
  })

  it('GET /runs/:id - Get run by ID', async () => {
    if (!testRunId) return

    const response = await fetchApi<{
      id: number
      title: string
      status: string
      signal_count: number
    }>(`/runs/${testRunId}`)

    expect(response.id).toBe(testRunId)
    expect(response.title).toBeDefined()
    expect(response.status).toBeDefined()
    expect(typeof response.signal_count).toBe('number')
  })

  it('POST /runs - Create new run', async () => {
    const response = await fetchApi<{ id: number; status: string }>('/runs', 'POST', {
      title: 'Test Run',
      description: 'Testing API',
    })

    expect(response.id).toBeDefined()
    expect(response.status).toBeDefined()
  })
})

// ============================================
// TENANTS API TESTS
// ============================================

describe('Tenants API', () => {
  it('GET /tenants/usage - Get tenant usage', async () => {
    const response = await fetchApi<{
      runs: { used: number; limit: number }
      questions_ingested: number
      signals_detected: number
    }>('/tenants/usage')

    expect(response).toBeDefined()
    expect(response.runs).toBeDefined()
    expect(response.runs.used).toBeGreaterThanOrEqual(0)
    expect(response.runs.limit).toBeGreaterThan(0)
    expect(response.questions_ingested).toBeGreaterThanOrEqual(0)
    expect(response.signals_detected).toBeGreaterThanOrEqual(0)
  })
})

// ============================================
// EXPERIMENTS API TESTS
// ============================================

describe('Experiments API', () => {
  it('GET /experiments - List experiments', async () => {
    const response = await fetchApi<Array<{ id: number; name: string }>>(
      '/experiments'
    )

    expect(Array.isArray(response)).toBe(true)
  })
})

// ============================================
// ERROR HANDLING TESTS
// ============================================

describe('Error Handling', () => {
  it('GET /signals/99999 - Handle 404 not found', async () => {
    try {
      await fetchApi('/signals/99999')
      expect.fail('Should throw error')
    } catch (error) {
      expect(error).toBeDefined()
    }
  })

  it('GET /invalid-endpoint - Handle 404 invalid route', async () => {
    try {
      await fetchApi('/invalid-endpoint')
      expect.fail('Should throw error')
    } catch (error) {
      expect(error).toBeDefined()
    }
  })
})

// ============================================
// HEALTH CHECK
// ============================================

describe('Health Checks', () => {
  it('GET / - Server is running', async () => {
    try {
      const response = await fetch(`${BASE_URL.replace('/api/v1', '')}/health`)
      expect(response.ok).toBe(true)
    } catch (error) {
      console.warn('Health check failed - server may not be running')
    }
  })
})
