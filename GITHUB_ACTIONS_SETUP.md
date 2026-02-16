# 🚀 GitHub Actions Secrets Setup

## Required Secrets for Deployment

Add these secrets to your GitHub repository: https://github.com/digitalcotton/AntiAlgo/settings/secrets/actions

### **Production Environment Secrets**

#### **Railway Deployment**

```
Name: RAILWAY_TOKEN
Value: <your-railway-api-token>

Instructions:
1. Go to https://railway.app/account/tokens
2. Create new API token
3. Copy and paste here
```

#### **Railway Service URLs**

```
Name: RAILWAY_BACKEND_URL
Value: your-backend-service.railway.app

Name: RAILWAY_DASHBOARD_URL
Value: your-dashboard-service.railway.app

Get these from Railway dashboard dashboard for each service
```

### **Backend Environment Variables**

These go into Railway project **Environment** tab:

```
# Required
ENVIRONMENT=production
PORT=8000
LOG_LEVEL=INFO

# Supabase Database
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=eyJ...your-anon-key...
SUPABASE_SERVICE_ROLE_KEY=eyJ...your-service-role-key...

# External APIs
OPENAI_API_KEY=sk-...your-openai-key...
REDDIT_CLIENT_ID=...
REDDIT_CLIENT_SECRET=...
REDDIT_USER_AGENT=CuriosityIntelligence/1.0
NEWSAPI_KEY=...

# Security
JWT_SECRET=your-random-secret-at-least-32-chars
SENTRY_DSN=https://...optional...

# CORS
CORS_ORIGINS=https://antialgo.ai,https://www.antialgo.ai

# Redis (Railway Postgres add-on or external)
REDIS_URL=redis://localhost:6379/0
```

### **Dashboard Environment Variables**

These go into Railway dashboard project **Environment** tab:

```
# Required
VITE_DASHBOARD_PASSWORD=!Sinecurve1980!
VITE_API_URL=/api/v1
```

### **Website (Vercel)**

No additional secrets needed - Vercel has built-in configuration.

---

## Setup Instructions

### Step 1: Create Railway Token

```bash
# Go to https://railway.app/account/tokens
# Click "Create"
# Copy the token

# Add to GitHub:
1. Go to repo Settings → Secrets and variables → Actions
2. Click "New repository secret"
3. Name: RAILWAY_TOKEN
4. Value: <paste token>
5. Click "Add secret"
```

### Step 2: Add Service URLs

After deploying to Railway:

```bash
1. Go to https://railway.app/dashboard
2. Click your project
3. For Backend service:
   - Copy the Railway URL
   - Add as RAILWAY_BACKEND_URL secret
4. For Dashboard service:
   - Copy the Railway URL  
   - Add as RAILWAY_DASHBOARD_URL secret
```

### Step 3: Configure Railway Projects

For **Backend** (API):

```bash
1. Create new Railway project
2. Connect GitHub repo
3. Select Dockerfile
4. Add environment variables from above
5. Deploy
```

For **Dashboard**:

```bash
1. Create new Railway project
2. Connect GitHub repo
3. Point to /curiosity-intelligence\ 1/dashboard/
4. Select Dockerfile
5. Add environment variables
6. Deploy
```

For **Website** (Vercel):

```bash
1. Go to https://vercel.com/dashboard
2. Import project from GitHub
3. Select /curiosity-website\ 2/ as root
4. Deploy
```

### Step 4: Connect Services

After deploying all services, update configuration:

**In Railway Backend environment:**
```
# Update CORS to point to your services
CORS_ORIGINS=https://antialgo.ai,https://www.antialgo.ai
```

**In Railway Dashboard environment:**
```
# Update API URL to point to backend
VITE_API_URL=https://your-backend-url.railway.app/api/v1
```

---

## Testing Deployment

After setup, test each service:

```bash
# Test Website
curl https://antialgo.ai/

# Test Dashboard
curl https://antialgo.ai/dashboard

# Test Backend
curl https://your-backend-url.railway.app/health

# Test Backend API
curl https://your-backend-url.railway.app/api/v1/signals
```

---

## Troubleshooting

### Deployment Fails
- Check GitHub Actions tab for error logs
- Verify all secrets are set correctly
- Check Railway project settings

### Services Can't Connect
- Verify CORS_ORIGINS in backend
- Check firewall/network settings
- Verify environment variables are set

### Password Not Working
- Verify VITE_DASHBOARD_PASSWORD is set correctly
- Clear browser cache and try again
- Check browser console for errors

---

## Next Steps

1. ✅ Copy this guide
2. ⬜ Add GitHub secrets
3. ⬜ Create Railway projects
4. ⬜ Deploy via git push
5. ⬜ Test all services
6. ⬜ Monitor for issues
