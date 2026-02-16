# 🚀 Complete Deployment Playbook

## Overview

This document provides step-by-step instructions for deploying the Curiosity Intelligence platform to production.

**Timeline:** 2-3 hours  
**Risk Level:** Medium  
**Rollback Time:** 15 minutes  

## Pre-Deployment (30 mins)

### 1. Verification

```bash
# Run verification script
bash scripts/verify-deployment.sh
```

Expected output: ✅ All checks passing

### 2. Review Changes

```bash
# See all uncommitted changes
git status

# Review changes
git diff

# Ensure no secrets or hardcoded values
grep -r "password" --include="*.ts" --include="*.tsx" src/
grep -r "secret" --include="*.ts" --include="*.tsx" src/
```

### 3. Create Deployment Branch

```bash
# Create release branch
git checkout -b release/v1.0.0

# Add all changes
git add -A

# Commit with clear message
git commit -m "feat: deployment-ready configuration

- Add dashboard password protection
- Clean up file structure and naming
- Add comprehensive API tests
- Add deployment documentation
- Fix lib folder organization
- Add clear service labeling"

# Push to repository
git push origin release/v1.0.0
```

## Website Deployment (Vercel) - 20 mins

### Step 1: Final Build Test

```bash
cd "curiosity-website 2"
npm run build

# Verify build succeeds and no errors appear
```

Expected: Build succeeds, bundle size reasonable (~150KB)

### Step 2: Deploy to Vercel

```bash
# If using Vercel CLI
vercel --prod

# Or push to main branch and let CI/CD deploy automatically
git push origin main
```

Monitor deployment at: https://vercel.com/dashboard

### Step 3: Verify Deployment

```bash
# Wait for deployment to complete (2-3 mins)

# Check website loads
curl https://antialgo.ai

# Verify key pages
curl https://antialgo.ai/
curl https://antialgo.ai/newsletter/week-1
```

Expected: All pages return 200 status

### Step 4: Post-Deployment Checks

- [ ] Visit https://antialgo.ai/ in browser
- [ ] Test newsletter signup form
- [ ] Check console for JS errors
- [ ] Verify analytics tracking
- [ ] Check mobile responsiveness

## Dashboard Deployment (Railway) - 40 mins

### Step 1: Prepare Docker Image

```bash
cd "curiosity-intelligence 1/dashboard"

# Build Docker image
docker build -t curiosity-dashboard:latest -t curiosity-dashboard:v1.0.0 .

# Verify image builds successfully
docker images | grep curiosity-dashboard
```

### Step 2: Configure Environment Variables

In Railway Dashboard:

1. Go to your project
2. Select the Dashboard service  
3. Set environment variables:
   ```
   VITE_DASHBOARD_PASSWORD=<strong-password>
   VITE_API_URL=/api/v1
   ```
4. Save and trigger rebuild

Test locally first:
```bash
docker run -p 3000:3000 \
  -e VITE_DASHBOARD_PASSWORD="strong-password" \
  curiosity-dashboard:latest
```

### Step 3: Deploy to Railway

**Option A: Using Railway CLI**

```bash
railroad up
```

**Option B: Using Railway Dashboard**

1. Commit changes to git
2. Push to repository
3. Railway detects push and auto-deploys

Monitor at: https://railway.app/project/your-project

### Step 4: Verify Deployment

```bash
# Wait for deployment (5-10 mins)

# Check service health
curl https://antialgo.ai/dashboard

# Verify authentication works
# Visit in browser and test login
```

### Step 5: Post-Deployment Checks

- [ ] Visit https://antialgo.ai/dashboard
- [ ] Enter dashboard password
- [ ] Verify signals load
- [ ] Verify runs load  
- [ ] Check console for errors
- [ ] Test logout
- [ ] Test re-login

## Backend Deployment (Railway) - 30 mins

### Step 1: Build Backend Docker Image

```bash
cd "curiosity-intelligence 1"

docker build -t curiosity-api:latest -t curiosity-api:v1.0.0 .

# Verify build
docker images | grep curiosity-api
```

### Step 2: Test Locally

```bash
docker run -p 8000:8000 \
  -e DATABASE_URL="..." \
  -e ENVIRONMENT="production" \
  curiosity-api:latest
```

Verify: http://localhost:8000/health returns {"status": "ok"}

### Step 3: Deploy Backend

```bash
# Commit Docker configuration
git add Dockerfile docker-compose.yml
git commit -m "chore: update docker configuration for deployment"
git push origin main
```

Railway automatically deploys on push.

### Step 4: Verify Backend

```bash
# Get backend URL from Railway dashboard
BACKEND_URL="https://your-backend.railway.app"

# Test endpoints
curl $BACKEND_URL/health
curl $BACKEND_URL/api/v1/signals?limit=1
curl $BACKEND_URL/api/v1/runs?limit=1
curl $BACKEND_URL/api/v1/tenants/usage
```

Expected: All return 200 with JSON data

## Integration Testing (20 mins)

### Test Dashboard ↔ Backend Connection

```bash
# In browser, visit dashboard
# https://antialgo.ai/dashboard

# Enter password and verify:
# 1. Dashboard loads
# 2. Signals appear
# 3. Runs appear
# 4. Stats load
# 5. No console errors
```

### Test All Key Flows

```bash
# Dashboard
✅ Login with password
✅ View signals
✅ View runs
✅ Filter signals
✅ Create new run
✅ Logout

# Website
✅ Landing page loads
✅ Newsletter signup works
✅ Thank you page appears
✅ No console errors
```

### Monitor Error Tracking

Check error tracking service (Sentry):
- No new errors in last 30 mins
- All errors are expected

## Monitoring (Ongoing)

### First Hour

- [ ] Monitor error tracking dashboard
- [ ] Check API response times
- [ ] Monitor database performance
- [ ] Watch server logs

### First Day

- [ ] No critical errors reported
- [ ] Normal user activity
- [ ] Response times stable
- [ ] Database queries performant

### Alerts

Set up alerts for:
- [ ] Error rate > 1%
- [ ] Response time > 2 seconds
- [ ] Database queries > 5 seconds
- [ ] Server memory > 80%
- [ ] Server CPU > 80%

## Rollback Procedure (If Needed)

### Dashboard Rollback

```bash
# In Railway Dashboard
# 1. Go to Dashboard service
# 2. Select "Deployments" tab
# 3. Click "Rollback" on previous deployment
# 4. Confirm

# Or manually deploy previous version
git revert HEAD
git push origin main
```

Expected: Service reverts to previous state in 5-10 minutes

### Website Rollback

```bash
# In Vercel Dashboard
# 1. Go to Deployments
# 2. Click "Rollback" on previous deployment
# 3. Confirm
```

Expected: Site reverts to previous state in 2-3 minutes

### Backend Rollback

```bash
# In Railway Backend service
# Click "Rollback" on previous deployment
```

## Post-Deployment Checklist

- [ ] All services accessible
- [ ] No console errors
- [ ] API responding normally
- [ ] Database connected
- [ ] Monitoring alerts working
- [ ] Team notified of deployment
- [ ] Documentation updated
- [ ] No rollback required
- [ ] Changes committed to git

## Sign-Off

| Component | Deployed By | Status | Time |
|-----------|------------|--------|------|
| Website | ________ | ✓ | __:__ |
| Dashboard | ________ | ✓ | __:__ |
| Backend | ________ | ✓ | __:__ |

**Deployment Start:** __:__  
**Deployment End:** __:__  
**Total Time:** ______ mins  

## Contact & Escalation

**On-Call Engineer:** ________________  
**Slack Channel:** #deployment  
**Status Page:** https://status.domain.com  

If critical issues arise:
1. Notify team in Slack
2. Gather error logs
3. Check monitoring dashboard
4. Decide: Fix or Rollback
5. Execute decision
6. Post-mortem after resolution

---

✅ **Deployment Complete!**

Good luck! 🚀
