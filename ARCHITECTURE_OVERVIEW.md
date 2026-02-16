# AntiAlgo.ai - Architecture & Deployment Overview

## System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          ANTIALGO.AI SYSTEM                                 │
└─────────────────────────────────────────────────────────────────────────────┘

                              EXTERNAL SERVICES
                         ┌──────────────────────┐
                         │   OpenAI API         │
                         │  (embeddings, LLM)   │
                         └──────────────────────┘
                                    │
                                    │ OPENAI_API_KEY
                                    │
              ┌─────────────────────┼─────────────────────┐
              │                     │                     │
              ▼                     ▼                     ▼
         ┌─────────────┐    ┌──────────────┐    ┌──────────────────┐
         │ Supabase    │    │  Resend      │    │ Data Ingestion   │
         │ (Postgres   │    │  (Email)     │    │ (Reddit, News,   │
         │  + pgvector)│    │              │    │  StackExchange)  │
         └─────────────┘    └──────────────┘    └──────────────────┘
              │
              │
              ▼
    ┌──────────────────────────────────────────────┐
    │        CURIOSITY INTELLIGENCE BACKEND        │
    │              (Railway Deployment)            │
    │                                              │
    │  Port: 8000                                  │
    │  Framework: FastAPI + Uvicorn               │
    │                                              │
    │  ┌────────────────────────────────────────┐ │
    │  │  API Routes (/api/v1)                 │ │
    │  │                                        │ │
    │  │  • /signals      → Signal detection   │ │
    │  │  • /subscribers  → Newsletter mgmt    │ │
    │  │  • /runs         → Pipeline history   │ │
    │  │  • /experiments  → A/B testing        │ │
    │  │  • /health       → Health check       │ │
    │  │  • /docs         → OpenAPI            │ │
    │  └────────────────────────────────────────┘ │
    │                                              │
    │  ┌────────────────────────────────────────┐ │
    │  │  Internal Services                    │ │
    │  │                                        │ │
    │  │  • News Correlator                    │ │
    │  │  • Signal Detector                    │ │
    │  │  • Email Service                      │ │
    │  │  • Observability (logs, metrics)      │ │
    │  └────────────────────────────────────────┘ │
    │                                              │
    │  Dependencies:                               │
    │  • Redis (caching, job queue)               │
    │  • Postgres + pgvector (embeddings)         │
    │                                              │
    │  CORS Origins:                               │
    │  • localhost:3000 (dashboard dev)            │
    │  • localhost:3002 (website dev)              │
    │  • https://antialgo.ai (prod)                │
    │  • https://anti-algo.vercel.app (prod)       │
    └──────────────────────────────────────────────┘
              ▲                          ▲
              │ HTTP/REST               │ HTTP/REST
              │ /api/v1                 │ /api/v1
              │                         │
    ┌─────────┴─────────────────────────┴──────────┐
    │                                              │
    │                                              │
    ▼                                              ▼
┌──────────────────────────────────┐  ┌──────────────────────────────────┐
│  DASHBOARD - ADMIN INTERFACE     │  │  WEBSITE - PUBLIC LANDING PAGE   │
│         (Internal Only)          │  │    (Vercel Deployment)           │
│                                  │  │                                  │
│  Port: 3000 (dev)               │  │  Port: 3002 (dev)               │
│  Technology: React + Vite        │  │  Technology: React + Vite        │
│  Deployment: TBD (Railway/self)  │  │  Deployment: Vercel             │
│                                  │  │                                  │
│  Purpose:                        │  │  Purpose:                        │
│  • View detected signals         │  │  • Marketing page                │
│  • Analyze trends               │  │  • Newsletter signup              │
│  • View run history             │  │  • Referral tracking              │
│  • Access internal metrics      │  │  • Social proof                   │
│                                  │  │                                  │
│  Authentication:                │  │  Authentication:                 │
│  • Uses backend JWT             │  │  • Email list (via Resend)       │
│  • Role-based access (RBAC)     │  │  • No auth required              │
│                                  │  │                                  │
│  API Client: adminApi.ts         │  │  API Client: publicApi.ts        │
│  Endpoints: /api/v1/signals      │  │  Endpoints: /api/v1/subscribers  │
│            /api/v1/runs         │  │             /api/v1/referrals    │
│            /api/v1/experiments  │  │                                  │
└──────────────────────────────────┘  └──────────────────────────────────┘
```

---

## Deployment Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│                     PRODUCTION DEPLOYMENT                             │
└───────────────────────────────────────────────────────────────────────┘

  GITHUB MAIN BRANCH
           │
           ├──────────────────────────┬──────────────────────────┐
           │                          │                          │
           ▼                          ▼                          ▼
  ┌─────────────────┐      ┌──────────────────┐      ┌──────────────────┐
  │  CI/CD Pipeline │      │  CI/CD Pipeline  │      │  CI/CD Pipeline  │
  │  (Linux)        │      │  (Linux)         │      │  (Linux)         │
  │                 │      │                  │      │                  │
  │ GitHub Actions  │      │ GitHub Actions   │      │ GitHub Actions   │
  │  (workflow)     │      │  (workflow)      │      │  (workflow)      │
  └────────┬────────┘      └────────┬─────────┘      └────────┬─────────┘
           │                        │                         │
           │ Build                  │ Build                   │ Build
           │ Lint                   │ Type Check              │ Test
           │ Test                   ▼                         │
           │                 ┌─────────────┐                 │
           ▼                 │   Docker    │                 ▼
  ┌──────────────────┐       │   Registry  │         ┌──────────────┐
  │   pytest         │       │   (GHCR)    │         │   Coverage   │
  │   coverage       │       │             │         │   Report     │
  │   mypy           │       │  API Image  │         │   Codecov    │
  │   ruff           │       └──────┬──────┘         └──────┬───────┘
  └────────┬─────────┘              │                       │
           │                        │                       │
           └────────┬───────────────┼───────────────────────┘
                    │               │
                    ▼               ▼
           ✅ All Checks Pass? Deploy!
                    │
                    ├─────────────────────────────┬──────────────────────┐
                    │                             │                      │
                    ▼                             ▼                      ▼
        ┌─────────────────────┐      ┌──────────────────────┐  ┌────────────────┐
        │  RAILWAY PLATFORM   │      │  VERCEL PLATFORM     │  │ DASHBOARD TBD  │
        │  (Backend Deploy)   │      │  (Website Deploy)    │  │ (TBD Strategy) │
        │                     │      │                      │  │                │
        │ Detects: Python     │      │ Detects: Node.js     │  │ Options:       │
        │ Framework: FastAPI  │      │ Framework: Vite      │  │ • Railway      │
        │                     │      │                      │  │ • Vercel       │
        │ Build: Docker       │      │ Build: npm run build │  │ • Self-hosted  │
        │ Runtime: Gunicorn   │      │ Output: /dist        │  └────────────────┘
        │ Port: $PORT env     │      │ Rewrites: SPA mode   │
        │                     │      │                      │
        │ Auto-scaled         │      │ Edge CDN             │
        │ Health checks ✓     │      │ Zero-downtime deploy │
        │                     │      │                      │
        │ URL:                │      │ URL:                 │
        │ https://api...      │      │ https://antialgo.ai  │
        │ .railway.app        │      │ (+ Vercel domains)   │
        └─────────────────────┘      └──────────────────────┘

                    ▲
                    │
            ┌───────┴─────────┐
            │                 │
            ▼                 ▼
  ┌──────────────────┐  ┌──────────────────┐
  │  Monitoring      │  │  Error Tracking  │
  │                  │  │                  │
  │ • Railway logs   │  │ • Sentry (?)     │
  │ • Vercel build   │  │ • Application    │
  │ • Health checks  │  │   logs           │
  │ • Metrics        │  │                  │
  └──────────────────┘  └──────────────────┘
```

---

## Data Flow Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                        DATA PIPELINE                                 │
└──────────────────────────────────────────────────────────────────────┘

INGESTION
┌─────────────────────────────────────────┐
│  Data Sources (daily scrape)            │
│                                         │
│  • Reddit API  → Questions              │
│  • StackExch   → Programming Q&A        │
│  • NewsAPI     → News articles          │
│  • Google PAA  → People also ask        │
└────────────┬────────────────────────────┘
             ▼
    ┌──────────────────────────┐
    │  Raw Data (unstructured) │
    │  Normalize & filter      │
    └────────┬─────────────────┘
             ▼
    ┌──────────────────────────────────┐
    │  Embedding Generation            │
    │  (OpenAI text-embedding-3-small) │
    │                                  │
    │  Store in Supabase pgvector      │
    └────────┬───────────────────────┘
             ▼
PROCESSING
┌────────────────────────────────────────────┐
│  Semantic Matching                         │
│  "How do I X?" ≈ "Best practices for X?"   │
└────────┬───────────────────────────────────┘
         ▼
┌────────────────────────────────────────────┐
│  Cross-Platform Triangulation              │
│  Signal = same question on multiple sources│
└────────┬───────────────────────────────────┘
         ▼
┌─────────────────────────────────────────┐
│  Signal Detection & Scoring             │
│                                         │
│  • Velocity score (growth rate)         │
│  • Cross-platform score (platforms)     │
│  • Engagement score (comments/upvotes)  │
│  • Novelty score (new vs. recurring)    │
│  • Weirdness bonus (anomalies)          │
│                                         │
│  Threshold: 0.70 = SIGNAL               │
└────────┬────────────────────────────────┘
         ▼
┌────────────────────────────────────────────┐
│  News Correlation (why is this trending?)  │
│  Match signals to news events              │
└────────┬───────────────────────────────────┘
         ▼
OUTPUT
┌─────────────────────────────┐
│  Curiosity Intelligence     │
│  (signals + news + context) │
│                             │
│  Tier 1: High confidence    │
│  Tier 2: Medium confidence  │
│  Tier 3: Interesting edge   │
└────────┬──────────────────┘
         ▼
┌─────────────────────────────┐
│  Newsletter Generation      │
│  (MJML → HTML → Email)      │
│                             │
│  Sent via Resend API        │
└────────┬──────────────────┘
         ▼
    ┌──────────────────┐
    │  Subscriber List │
    │  (Postgres)      │
    └──────────────────┘
         ▼
    ┌──────────────────┐
    │  Email Logs      │
    │  (Analytics)     │
    └──────────────────┘
```

---

## Database Schema Overview

```
Supabase (PostgreSQL + pgvector)

┌────────────────────────────────┐
│         Runs (pipeline)        │ ← Execution history
│                                │
│ id (PK)                        │
│ week                           │
│ status (running/complete)      │
│ signal_count                   │
│ avg_score                      │
│ created_at                     │
└────────────────────────────────┘

┌─────────────────────────────────────────┐
│            Signals (detected)           │ ← Main output
│                                         │
│ id (PK)                                 │
│ run_id (FK → Runs)                      │
│ week                                    │
│ canonical_question                      │
│ embedding (pgvector)                    │
│ velocity_score                          │
│ cross_platform_score                    │
│ novelty_score                           │
│ final_score                             │
│ tier (1/2/3)                            │
│ platforms (json)                        │
│ sample_questions (text[])               │
│ news_trigger (json)                     │
└─────────────────────────────────────────┘

┌────────────────────────────────┐
│      Subscribers (list)        │ ← Email subscribers
│                                │
│ id (PK)                        │
│ email                          │
│ name                           │
│ subscribed_at                  │
│ status (active/unsubscribed)   │
│ referral_code                  │
│ referred_by (FK)               │
└────────────────────────────────┘

┌────────────────────────────────┐
│      Predictions (test)        │ ← A/B test variants
│                                │
│ id (PK)                        │
│ experiment_name                │
│ user_cohort                    │
│ variant                        │
│ created_at                     │
└────────────────────────────────┘

```

---

## Environment Variables Matrix

```
┌──────────────────────────────────────────────────────────┐
│                  ENVIRONMENT VARIABLES                   │
└──────────────────────────────────────────────────────────┘

DEVELOPMENT (Local docker-compose)
├── ENVIRONMENT=development
├── LOG_LEVEL=INFO
├── PORT=8000
├── CORS_ORIGINS=http://localhost:3000,http://localhost:3001,http://localhost:3002
├── REDIS_URL=redis://redis:6379/0
└── [All required secrets from .env]

STAGING (Railway test instance)
├── ENVIRONMENT=staging
├── LOG_LEVEL=DEBUG
├── PORT=$PORT (Railway env var)
├── CORS_ORIGINS=https://staging.antialgo.ai
├── DATABASE_URL=$DATABASE_URL (Railway managed)
└── REDIS_URL=$REDIS_URL (Railway managed)

PRODUCTION (Railway main instance)
├── ENVIRONMENT=production
├── LOG_LEVEL=WARN
├── PORT=$PORT (Railway env var)
├── CORS_ORIGINS=https://antialgo.ai,https://www.antialgo.ai
├── DATABASE_URL=$DATABASE_URL (Supabase)
├── REDIS_URL=$REDIS_URL (Railway Redis)
└── [All required secrets from Railway secrets]

REQUIRED SECRETS (all environments)
├── OPENAI_API_KEY → text-embedding-3-small, gpt-4o
├── SUPABASE_URL → https://xxx.supabase.co
├── SUPABASE_KEY → anon key for RLS
├── SUPABASE_SERVICE_ROLE_KEY → write access
├── REDDIT_CLIENT_ID → API access
├── REDDIT_CLIENT_SECRET → API access
├── NEWSAPI_KEY → news ingestion
├── RESEND_API_KEY → email service
├── JWT_SECRET → authentication
└── [Others in .env.example]

FRONTEND (Browser env, prefixed VITE_)
├── VITE_API_URL=[optional] → Backend API URL
│                            (default: /api/v1 via proxy)
└── [None required for basic functionality]
```

---

## CI/CD Pipeline Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                    GITHUB ACTIONS WORKFLOW                       │
│                         (ci.yml)                                 │
└──────────────────────────────────────────────────────────────────┘

TRIGGER: Push to main or PR to main

┌─────────────────────────────────────────────┐
│           JOB: Lint & Test (Python)         │
│              (Ubuntu Latest)                │
├─────────────────────────────────────────────┤
│  1. Checkout code                           │
│  2. Set up Python 3.11                      │
│  3. Install dependencies + dev tools        │
│  4. Lint: ruff check .                      │
│  5. Type check: mypy curiosity_intelligence │
│  6. Start Redis service (docker)            │
│  7. Run tests: pytest tests/ -v             │
│  8. Generate coverage report                │
│  9. Upload to Codecov                       │
│                                             │
│  Status: PASS/FAIL blocks deployment        │
└───────┬────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────┐
│       JOB: Build Dashboard (Node.js)       │
│              (Ubuntu Latest)                │
├─────────────────────────────────────────────┤
│  1. Checkout code                           │
│  2. Set up Node.js (latest LTS)             │
│  3. npm install in dashboard/               │
│  4. npm run build                           │
│  5. Verify /dist directory                  │
│                                             │
│  Status: PASS/FAIL blocks deployment        │
└───────┬────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────┐
│       JOB: Build API Image (Docker)         │
│          (Ubuntu Latest)                    │
├─────────────────────────────────────────────┤
│  1. Checkout code                           │
│  2. Set up Docker buildx                    │
│  3. Build multi-stage Docker image          │
│  4. Push to GHCR registry                   │
│     (only on main branch)                   │
│                                             │
│  Image tagged: main, latest, commit-sha     │
│  Status: PASS/FAIL blocks deployment        │
└───────┬────────────────────────────────────┘
        │
        └─ All jobs pass? ✓
                │
                ▼
        ┌──────────────────┐
        │  APPROVAL GATE   │
        │ (Manual trigger? │
        │   or auto)       │
        └────────┬─────────┘
                │
                ▼
        ┌──────────────────────────────┐
        │  DEPLOY TO PRODUCTION        │
        │                              │
        │  • Railway API deployment    │
        │  • Vercel website deploy     │
        │  • Database migrations       │
        │  • DNS/routes update         │
        └──────────────────────────────┘
```

---

## Network & CORS Configuration

```
┌───────────────────────────────────────────────────────────────┐
│              CORS CONFIGURATION                               │
│            (Cross-Origin Resource Sharing)                    │
└───────────────────────────────────────────────────────────────┘

DEVELOPMENT (Local)
┌─────────────────────────────────────────────────────────────┐
│ API @ localhost:8000 accepts requests from:                 │
│                                                             │
│ • localhost:3000  (dashboard dev)                           │
│ • localhost:3001  (optional)                                │
│ • localhost:3002  (website dev)                             │
│                                                             │
│ Note: Vite proxy at each frontend routes                    │
│       /api → localhost:8000 transparently                   │
└─────────────────────────────────────────────────────────────┘

PRODUCTION
┌──────────────────────────────────────────────────────────────┐
│ API @ https://api.antialgo.ai accepts requests from:         │
│                                                              │
│ • https://antialgo.ai (primary domain)                       │
│ • https://www.antialgo.ai (with-www)                         │
│ • https://anti-algo.vercel.app (Vercel preview)             │
│                                                              │
│ Note: No wildcard (*) - explicit whitelist only             │
└──────────────────────────────────────────────────────────────┘

CORS HEADERS SET BY API
├── Access-Control-Allow-Origin: [allowed origin]
├── Access-Control-Allow-Methods: GET, POST, OPTIONS
├── Access-Control-Allow-Headers: Content-Type, Authorization
├── Access-Control-Max-Age: 600 seconds
└── Access-Control-Allow-Credentials: false (cookies not used)
```

---

## Monitoring & Observability Endpoints

```
HEALTH & DIAGNOSTICS

/health                    GET    Health status
                                 Returns 200 if ready to serve

/docs                      GET    OpenAPI specification
                                 Interactive Swagger UI

/redoc                     GET    Alternative API documentation
                                 ReDoc format

INTERNAL ENDPOINTS (Monitoring)
├── /_internal/logs         GET    Structured application logs
├── /_internal/metrics      GET    Prometheus/OpenTelemetry metrics
├── /_internal/traces       GET    Request tracing (if configured)
└── /_internal/healthdb     GET    Database connectivity check

OBSERVABILITY STACK
├── Logging: structlog (structured, JSON format)
├── Metrics: (TBD - Prometheus? CloudWatch?)
├── Tracing: (TBD - Jaeger? DataDog?)
├── Error tracking: Sentry (if $SENTRY_DSN set)
└── Log aggregation: (TBD - CloudWatch? ELK? Datadog?)
```

---

## Recommended Improvements (Phase 2)

```
INFRASTRUCTURE
├── [ ] Load balancing / auto-scaling
├── [ ] Database connection pooling
├── [ ] Redis clustering for HA
├── [ ] Multi-region deployment strategy
└── [ ] CDN for static assets

OBSERVABILITY
├── [ ] Metrics collection (Prometheus)
├── [ ] Distributed tracing (Jaeger)
├── [ ] Error tracking (Sentry setup)
├── [ ] Log aggregation service
└── [ ] Custom dashboards (Grafana)

SECURITY
├── [ ] API rate limiting
├── [ ] Request validation/sanitization
├── [ ] Database encryption at rest
├── [ ] SSL/TLS certificate renewal automation
├── [ ] Secrets rotation strategy
└── [ ] OWASP compliance audit

PERFORMANCE
├── [ ] Database query optimization
├── [ ] Caching strategy refinement
├── [ ] API response compression
├── [ ] Frontend code splitting
└── [ ] Image optimization

TESTING
├── [ ] End-to-end testing (Cypress/Playwright)
├── [ ] Load testing (K6/JMeter)
├── [ ] Security testing (OWASP ZAP)
├── [ ] Chaos engineering experiments
└── [ ] Disaster recovery drills
```

---

**Last Updated:** February 15, 2026  
**Architecture Version:** 1.0  
**Status:** Ready for Phase 1 deployment
