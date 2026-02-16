# AntiAlgo.ai - Audit Action Checklist

## CRITICAL (Must Fix Before Deployment)

### [ ] Directory Naming Crisis
- [ ] Rename `curiosity-intelligence 1` → `curiosity-intelligence`
- [ ] Rename `curiosity-website 2` → `curiosity-website`
- [ ] Remove trailing space from `TheTeam ` → `TheTeam`
- [ ] Update all git references and CI/CD paths
- [ ] Test full build after renaming

### [ ] Missing Railway Configuration
- [ ] Create `curiosity-intelligence/railway.json`:
  ```json
  {
    "build": {
      "builder": "dockerfile"
    },
    "start": "uvicorn curiosity_intelligence.api.main:app --host 0.0.0.0 --port $PORT"
  }
  ```
- [ ] Test Railway deployment locally with `railway up`
- [ ] Verify startup logs contain "api_starting"

### [ ] API Client Naming Conflicts
- [ ] Rename `curiosity-intelligence/dashboard/src/lib/api.ts` → `adminApi.ts`
- [ ] Rename `curiosity-website/src/lib/api.ts` → `publicApi.ts`
- [ ] Find & replace all imports in dashboard/
- [ ] Find & replace all imports in website/
- [ ] Run tests to verify

---

## HIGH PRIORITY (This Sprint)

### [ ] Deployment Documentation
- [ ] Create `DEPLOYMENT.md` at repository root
  - [ ] Include backend deployment steps
  - [ ] Include website deployment steps
  - [ ] Include dashboard deployment strategy
  - [ ] Add troubleshooting section
  - [ ] Add rollback procedures

### [ ] Dashboard Production Deployment
- [ ] Choose deployment target:
  - [ ] Option A: Railway container (alongside API)
  - [ ] Option B: Vercel (+ API proxy configuration)
  - [ ] Option C: Self-hosted on Railway
- [ ] Add deployment configuration
- [ ] Test production build, health checks
- [ ] Secure with authentication (verify JWT works)

### [ ] Environment Configuration
- [ ] Create `curiosity-website/.env.example`:
  ```env
  # API Configuration
  VITE_API_URL=https://api.antialgo.ai
  
  # Optional for local dev
  # VITE_LOG_LEVEL=debug
  ```
- [ ] Create dashboard `.env.example` if missing in dashboard folder
- [ ] Document all required vars

### [ ] Code Organization
- [ ] Create `/agents` directory at root
- [ ] Move all agent spec files into organized structure:
  ```
  agents/
  ├── OrchestratorAgent.md
  ├── AgentCommsProtocol.md
  ├── JonyIve/
  │   ├── JonyIve_DesignMemory.md
  │   ├── JonyIve_DesignSystemIntel.md
  │   ├── JonyIve_NarrativeSignal.md
  │   └── JonyIve_PatternScout.md
  ├── SteveJobs/
  │   ├── SteveJobs_CompetitiveRecon.md
  │   ├── SteveJobs_GTMStrategist.md
  │   ├── SteveJobs_MarketIntel.md
  │   └── SteveJobs_StrategyMemory.md
  └── Wozniak/
      ├── Wozniak_DependencyIntel.md
      ├── Wozniak_EngineeringMemory.md
      ├── Wozniak_SourceTriangulator.md
      └── Wozniak_WebScout.md
  ```
- [ ] Update references in README.md
- [ ] Verify git commits with correct message

---

## MEDIUM PRIORITY (Next Sprint)

### [ ] Backend API Enhancement
- [ ] Document all endpoints in API specification
  - [ ] Use OpenAPI/Swagger format
  - [ ] Include request/response schemas
  - [ ] Include error codes and messages
- [ ] Add endpoint for dashboard authentication
- [ ] Implement role-based access control (RBAC)
- [ ] Add rate limiting for public endpoints

### [ ] Frontend Security
- [ ] Implement authentication UI in dashboard
- [ ] Add login page/modal
- [ ] Verify JWT token handling
- [ ] Test CORS with production domains
- [ ] Add error boundaries

### [ ] Deployment Automation
- [ ] Update CI/CD workflow for new folder names
- [ ] Add GitHub secrets for Railway/Vercel deployments
- [ ] Set up automatic deployments on main branch push
- [ ] Add staging environment configuration

### [ ] Monitoring & Observability
- [ ] Set up Sentry for error tracking
- [ ] Configure structured logging export
- [ ] Add dashboard for API metrics
- [ ] Document observability setup

---

## TESTING & VALIDATION

### [ ] Unit Testing
- [ ] Backend: `pytest tests/ -v`
- [ ] Dashboard: `npm test` (if jest configured)
- [ ] Website: `npm test` (if jest configured)
- [ ] Code coverage > 70%

### [ ] Integration Testing
- [ ] Backend + Postgres + Redis working together
- [ ] Dashboard connecting to backend API
- [ ] Website connecting to backend API
- [ ] Authentication flow working

### [ ] End-to-End Testing
- [ ] Subscribe flow works on website
- [ ] Newsletter generation completes
- [ ] Dashboard displays signals correctly
- [ ] API health check passes

### [ ] Deployment Testing
- [ ] Local docker-compose up -d works
- [ ] All containers start successfully
- [ ] API responds on :8000
- [ ] Dashboard responds on :3000
- [ ] Website responds on :3002
- [ ] Proxy routes working (vite proxy)

### [ ] Production-Like Testing
- [ ] Build Railway image locally and test
- [ ] Build website production bundle and test
- [ ] Verify all environment variables needed
- [ ] Test with production amounts of data
- [ ] Verify SSL/TLS certificates when deployed

---

## FILES TO CREATE

### `railway.json` (Copy to `curiosity-intelligence/`)
```json
{
  "build": {
    "builder": "dockerfile"
  },
  "start": "uvicorn curiosity_intelligence.api.main:app --host 0.0.0.0 --port $PORT"
}
```

### `DEPLOYMENT.md` (Copy to root)
```markdown
# Deployment Guide

## Prerequisites
- GitHub account with repository access
- Railway account for backend
- Vercel account for website
- Environment variables from team

## Backend Deployment (Railway)

### Initial Setup
1. Log in to [Railway.app](https://railway.app)
2. Create new project from GitHub repo
3. Select `curiosity-intelligence` service
4. Railway auto-detects Python + Dockerfile
5. Add environment variables (see .env.example)
6. Deploy

### Post-Deployment
- Check Railway logs: `railway logs`
- Test health endpoint: `curl https://<railway-url>/health`
- Monitor in Railway dashboard

## Frontend Deployment (Vercel)

### Initial Setup
1. Log in to [Vercel.com](https://vercel.com)
2. Import project from GitHub
3. Select `curiosity-website` root directory
4. Set build command: `npm run build`
5. Set output: `dist`
6. Add `VITE_API_URL` environment variable
7. Deploy

### Post-Deployment
- Test signup flow
- Verify API connectivity
- Check Vercel analytics

## Dashboard Deployment (TBD)
[Choose strategy and document]

## Monitoring
- Backend logs: Railway dashboard
- Frontend errors: Vercel analytics
- Application errors: Sentry (if configured)
- API health: Health check endpoint

## Rollback
- Railway: Use previous deployment
- Vercel: Select previous deployment
- Database: Use backups (if needed)

## Troubleshooting
[Add common issues and solutions]
```

### `curiosity-website/.env.example`
```env
# API Configuration
# Set to your Railway backend URL in production
# Leave blank for local dev (uses vite proxy)
VITE_API_URL=https://api.antialgo.ai

# Optional
# VITE_LOG_LEVEL=debug
```

---

## GIT COMMANDS TO EXECUTE

### Rename Directories (Preserve History)
```bash
cd /Users/computersex2/Documents/DevelopmentProjects

# Step 1: Fix main directory space
# This requires a bit of care since the directory has a space
cd "TheTeam "  # Note the space
cd ..

# Step 2: Rename services (use -f to force if needed)
mv "TheTeam /curiosity-intelligence 1" "TheTeam /curiosity-intelligence"
mv "TheTeam /curiosity-website 2" "TheTeam /curiosity-website"

# Step 3: Remove space from main folder name
mv "TheTeam " "TheTeam"

# Step 4: Commit changes
cd TheTeam
git add -A
git commit -m "refactor: Remove version numbers from directory names

- Rename 'curiosity-intelligence 1' → 'curiosity-intelligence'
- Rename 'curiosity-website 2' → 'curiosity-website'
- Remove trailing space from workspace directory

This improves project maintainability and deployment compatibility."

git push origin main
```

### Rename API Files
```bash
cd curiosity-intelligence/dashboard/src/lib
git mv api.ts adminApi.ts
cd ../../../..

cd curiosity-website/src/lib
git mv api.ts publicApi.ts
cd ../../../..

# Find and update all imports
grep -r "from.*api\.ts" --include="*.ts" --include="*.tsx"
# Manually update these files with new names

git add -A
git commit -m "refactor: Rename API client files for clarity

- dashboard/src/lib/api.ts → adminApi.ts
- website/src/lib/api.ts → publicApi.ts

Improves code clarity and prevents import mistakes."

git push origin main
```

---

## VERIFICATION CHECKLIST

### After Renaming Directories
- [ ] `git status` shows no unwanted changes
- [ ] CI/CD pipeline still runs
- [ ] All build steps pass
- [ ] No broken imports or references

### After Adding Railway Config
- [ ] `railway.json` exists at root of curiosity-intelligence/
- [ ] Syntax is valid JSON
- [ ] Start command runs uvicorn correctly
- [ ] Port matches Railway expectations ($PORT env var)

### After Renaming API Files
- [ ] TypeScript compiler shows no errors (`tsc`)
- [ ] No import resolution errors
- [ ] IDE finds all references correctly
- [ ] Tests pass (if any)

### After Creating Documentation
- [ ] DEPLOYMENT.md covers all three services
- [ ] All code examples are tested
- [ ] Links resolve correctly
- [ ] Markdown formatting is correct

---

## DEPLOYMENT READINESS SCORECARD

| Component | Before | After | Status |
|-----------|--------|-------|--------|
| File Structure | 3/10 | 9/10 | Need: Rename folders |
| Backend Ready | 7/10 | 10/10 | Need: Railway config |
| Frontend Ready | 9/10 | 10/10 | ✅ Almost there |
| Documentation | 5/10 | 9/10 | Need: DEPLOYMENT.md |
| **OVERALL** | 6/10 | 9.5/10 | Need: 4 items (2-3 hrs) |

---

## WEEKLY TRACKING

### Week 1: Critical Fixes
- [ ] Mon: Create railway.json, DEPLOYMENT.md
- [ ] Tue: Rename directories and test
- [ ] Wed: Rename API files and update imports
- [ ] Thu: Full test suite pass
- [ ] Fri: Merge to main, verify CI/CD

### Week 2: Deployment
- [ ] Mon: Deploy backend to Railway
- [ ] Tue: Deploy website to Vercel
- [ ] Wed: Deploy dashboard (TBD strategy)
- [ ] Thu: Production smoke tests
- [ ] Fri: Monitor, capture metrics

---

**Last Updated:** February 15, 2026  
**Owner:** Project Audit  
**Next Review:** After deployment sprint complete
