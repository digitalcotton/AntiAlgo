# Curiosity Intelligence Engine

> **"The ingredients are commodity. The recipe is the moat."**

Cross-platform curiosity detection that transforms public data into proprietary signals.

---

## What This Does

```
Reddit + Stack Exchange + Google PAA + News
              ↓
    Semantic Matching (same question detection)
              ↓
    Cross-Platform Triangulation
              ↓
    Signal Detection (what's about to trend)
              ↓
    News Correlation (why it's happening)
              ↓
    Weekly Curiosity Intelligence Digest
```

---

## Quick Start

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Set environment variables
export OPENAI_API_KEY="sk-..."
export NEWSAPI_KEY="..."
export SUPABASE_URL="https://xxx.supabase.co"
export SUPABASE_KEY="..."
export REDDIT_CLIENT_ID="..."
export REDDIT_CLIENT_SECRET="..."

# 3. Run the pipeline
python -m curiosity_intelligence.pipeline --week 2026-W06
```

---

## Architecture

```
curiosity-intelligence/
├── README.md
├── requirements.txt
├── .env.example
│
├── curiosity_intelligence/
│   ├── __init__.py
│   ├── pipeline.py              # Main orchestrator
│   │
│   ├── ingestion/
│   │   ├── __init__.py
│   │   ├── reddit.py            # Reddit API client
│   │   ├── stackexchange.py     # Stack Exchange API
│   │   ├── google_paa.py        # AlsoAsked API
│   │   └── base.py              # Abstract ingester
│   │
│   ├── processing/
│   │   ├── __init__.py
│   │   ├── normalizer.py        # Question normalization
│   │   ├── embedder.py          # OpenAI embeddings
│   │   ├── clusterer.py         # HDBSCAN clustering
│   │   └── deduplicator.py      # Cross-platform dedup
│   │
│   ├── analysis/
│   │   ├── __init__.py
│   │   ├── signal_detector.py   # Signal scoring
│   │   ├── news_correlator.py   # News matching
│   │   └── weird_detector.py    # Unusual patterns
│   │
│   ├── output/
│   │   ├── __init__.py
│   │   ├── digest_generator.py  # Weekly digest
│   │   ├── signal_cards.py      # Share card images
│   │   └── email_renderer.py    # Email templates
│   │
│   └── database/
│       ├── __init__.py
│       ├── models.py            # SQLAlchemy models
│       ├── migrations/          # Schema migrations
│       └── queries.py           # Common queries
│
├── scripts/
│   ├── setup_db.py              # Initialize database
│   ├── backfill.py              # Historical data
│   └── test_apis.py             # Verify API access
│
└── tests/
    ├── test_normalizer.py
    ├── test_clusterer.py
    └── test_signal_detector.py
```

---

## Key Components

| Component | Tech | Purpose |
|-----------|------|---------|
| Embeddings | `text-embedding-3-small` | Semantic similarity |
| Vector DB | pgvector (Supabase) | Fast similarity search |
| Clustering | HDBSCAN | Group similar questions |
| Signal Score | Custom weighted | Detect trends |
| News | NewsAPI.org | Correlation |

---

## Signal Formula

```
Score = (Velocity × 0.35) + (CrossPlatform × 0.25) + 
        (Engagement × 0.20) + (Novelty × 0.20)
        + Weirdness Bonus (up to +20%)

IS_SIGNAL = Score ≥ 0.70
```

---

## Cost Estimate (Monthly)

| Component | Cost |
|-----------|------|
| OpenAI Embeddings (10K questions) | $0.03 |
| Supabase Pro | $25 |
| NewsAPI (free tier) | $0 |
| AlsoAsked (optional) | $49 |
| **Total MVP** | **~$25-75** |

---

## Infrastructure Stack

| Service | Provider | Cost | URL |
|---------|----------|------|-----|
| **Website** | Vercel | Free | `antialgo.ai` |
| **API** | Railway | $5/mo | `api.antialgo.ai` |
| **Database** | Supabase | Free | PostgreSQL + pgvector |
| **Email** | Resend | Free (3K/mo) | Transactional emails |
| **DNS/CDN** | Cloudflare | Free | DDoS protection, caching |

---

## Environment Variables

```bash
# Required
OPENAI_API_KEY=sk-...
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_KEY=eyJ...

# Reddit (for ingestion)
REDDIT_CLIENT_ID=...
REDDIT_CLIENT_SECRET=...
REDDIT_USER_AGENT=CuriosityIntelligence/1.0

# News correlation
NEWSAPI_KEY=...

# Email (Resend)
RESEND_API_KEY=re_...
FROM_EMAIL=AntiAlgo <hello@antialgo.ai>
SITE_URL=https://antialgo.ai

# Optional
ALSOASKED_API_KEY=...
```

---

## Next Steps

1. Run `scripts/setup_db.py` to create tables
2. Run `scripts/test_apis.py` to verify credentials
3. Run `python -m curiosity_intelligence.pipeline --test` for dry run
4. Schedule weekly cron: `0 2 * * 1` (Monday 2am)
