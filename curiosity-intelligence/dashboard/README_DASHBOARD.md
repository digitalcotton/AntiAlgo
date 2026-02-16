# Curiosity Intelligence Dashboard

## Overview

**Service Name:** Dashboard  
**Alias:** antialgo.ai/dashboard  
**URL:** http://localhost:3000 (local) / https://antialgo.ai/dashboard (production)  
**Purpose:** Analytics and monitoring for signal detection pipeline  
**Type:** React + Vite + Tailwind  
**Access:** Password protected

## Features

✅ Signal monitoring and trending  
✅ Pipeline run history and details  
✅ Usage analytics and quotas  
✅ Experiment management  
✅ Real-time metrics  
✅ Advanced filtering and search  

## Running Locally

```bash
cd "curiosity-intelligence 1/dashboard"
npm run dev
```

Visit: http://localhost:3000/

### Default Credentials

- **Username:** (none - password only)
- **Password:** `dashboard123` (set in `VITE_DASHBOARD_PASSWORD` environment variable)

⚠️ **Change this in production!**

## Folder Structure

```
dashboard/
├── src/
│   ├── contexts/
│   │   └── AuthContext.tsx          # Authentication context
│   ├── pages/
│   │   ├── Dashboard.tsx            # Main dashboard
│   │   ├── Signals.tsx              # Signals list
│   │   ├── SignalDetail.tsx         # Signal details
│   │   ├── Runs.tsx                 # Pipeline runs
│   │   ├── RunDetail.tsx            # Run details
│   │   ├── Experiments.tsx          # Experiments
│   │   ├── Settings.tsx             # Settings
│   │   └── Login.tsx                # Password login
│   ├── lib/
│   │   └── api.ts                   # API client (typed)
│   ├── components/
│   │   └── Layout.tsx               # Sidebar navigation
│   └── App.tsx                      # Application router
├── .env.example                     # Environment variables template
└── package.json
```

## API Endpoints

The dashboard connects to the backend API running at: `http://localhost:8000/api/v1`

### Key Endpoints

- `GET /signals` - List signals
- `GET /signals/:id` - Get signal details
- `GET /signals/trending` - Get trending signals
- `GET /runs` - List pipeline runs
- `GET /runs/:id` - Get run details
- `POST /runs` - Create new run
- `GET /tenants/usage` - Get usage analytics

See `src/lib/api.ts` for full API documentation.

## Deployment

- **Production URL:** https://antialgo.ai/dashboard
- **Deployed to:** Railway (Docker)
- **Config:** `Dockerfile` + `docker-compose.yml`

## Environment Variables

See `.env.example` for required variables:

```env
VITE_DASHBOARD_PASSWORD=strong-password-here
VITE_API_URL=/api/v1
```

## NOT This Service

❌ This is NOT the website/landing page  
❌ This is NOT for public signup  
❌ This is NOT for newsletter management  

See `/curiosity-website 2/` for the Website.

## Testing

### Run Integration Tests

```bash
npm run test
```

This runs comprehensive API integration tests to verify all endpoints are working.

## Known Issues

- Password stored in localStorage (consider token-based auth for production)
- No audit logging of dashboard access
- No role-based access control (all authenticated users see everything)

See `audit-summary.txt` for full issue list and recommendations.
