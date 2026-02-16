# Curiosity Dashboard API Client

## Overview

This directory contains the type-safe API client for the Curiosity Intelligence dashboard frontend.

### Files

- **api.ts** - Main API client with typed methods for:
  - Signals API - Fetch trending signals, breakouts, and search
  - Runs API - Create and manage pipeline runs
  - Tenants API - Usage and quota information
  - Experiments API - Experiment management

## Usage

```typescript
import { signalsApi, runsApi, tenantsApi } from '@/lib/api'

// Get trending signals
const trending = await signalsApi.getTrending(5)

// List signals with filtering
const signals = await signalsApi.list({
  tier: 'breakout',
  page: 1,
  per_page: 20,
})

// Get tenant usage
const usage = await tenantsApi.getUsage()
```

## Environment Variables

See `.env.example` for available configuration.

## API Server

The dashboard connects to the backend API running at `http://localhost:8000/api/v1`.

This is configured via the Vite proxy in `vite.config.ts`.
