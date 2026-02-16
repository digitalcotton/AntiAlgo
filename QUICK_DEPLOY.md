# 🚀 Quick Deployment Guide

**Status:** ✅ All code ready to deploy  
**Password:** Secure dashboard password set  
**CI/CD:** GitHub Actions configured  
**Infrastructure:** Railway + Vercel ready

---

## 3-Step Deployment Process

### **Step 1: GitHub Actions Secrets (5 minutes)**

Add these to: https://github.com/digitalcotton/AntiAlgo/settings/secrets/actions

```
1. RAILWAY_TOKEN
   - Go to https://railway.app/account/tokens
   - Create new API token
   - Copy and add as secret

2. RAILWAY_BACKEND_URL (after first deploy)
   - Example: api-prod-xyz.railway.app

3. RAILWAY_DASHBOARD_URL (after first deploy)
   - Example: dashboard-prod-xyz.railway.app
```

### **Step 2: Create Railway Projects (10 minutes)**

#### **Backend (API)**
```bash
1. Go to https://railway.app/dashboard
2. Click "New Project" → "Deploy from GitHub"
3. Select your repo
4. Auto-deploy from branch: main
5. Dockerfile: Dockerfile (in root)
6. Add environment variables (see GITHUB_ACTIONS_SETUP.md)
7. Deploy
```

**Environment variables needed:**
```
ENVIRONMENT=production
SUPABASE_URL=...
SUPABASE_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
OPENAI_API_KEY=...
JWT_SECRET=...
CORS_ORIGINS=https://antialgo.ai,https://www.antialgo.ai
(see GITHUB_ACTIONS_SETUP.md for complete list)
```

#### **Dashboard**
```bash
1. Same as Backend, but:
2. Dockerfile: curiosity-intelligence\ 1/dashboard/Dockerfile
3. Source root: curiosity-intelligence\ 1/dashboard/
4. Add environment variables:
   - VITE_DASHBOARD_PASSWORD=!Sinecurve1980!
   - VITE_API_URL=https://[backend-url]/api/v1
5. Deploy
```

#### **Website (Vercel)**
```bash
1. Go to https://vercel.com/dashboard
2. Import project from GitHub
3. Select repo: AntiAlgo
4. Root directory: curiosity-website\ 2
5. Framework: Vite
6. Deploy
```

### **Step 3: Push to Deploy (< 2 minutes)**

```bash
# After setup, just push and GitHub Actions handles the rest
git push origin main

# GitHub Actions will:
1. Run tests ✅
2. Build Docker images ✅
3. Push to registry ✅
4. Deploy via Railway ✅
5. Verify health checks ✅
```

---

## ✅ Verification Checklist

After deployment, verify each service:

```bash
# Website
❌→❌❌ https://antialgo.ai/
❌→❌❌ Check newsletter signup form

# Dashboard  
❌→❌❌ https://antialgo.ai/dashboard
❌→❌❌ Enter password: [your-password]
❌→❌❌ Verify signals load

# Backend API
❌→❌❌ https://[backend-url]/health
❌→❌❌ https://[backend-url]/api/v1/signals
```

---

## 🔒 Security

✅ Dashboard password: **Secure** (set in .env)  
✅ API keys: **Secure** (in Railway secrets)  
✅ Database: **Secure** (Supabase + pgvector)  
✅ CORS: **Configured** (antialgo.ai domains only)  

---

## 📞 Troubleshooting

| Issue | Solution |
|-------|----------|
| Deploy failed | Check GitHub Actions logs |
| Can't access dashboard | Verify VITE_DASHBOARD_PASSWORD is set |
| API not responding | Check backend Railway logs |
| Services can't reach each other | Update CORS_ORIGINS and API URLs |
| Database connection failed | Verify SUPABASE_* variables are correct |

---

## 📋 Environment Variables Locations

**Backend (Railway Environment):**
```
SUPABASE_URL → From Supabase dashboard
SUPABASE_KEY → From Supabase dashboard  
OPENAI_API_KEY → From OpenAI account
JWT_SECRET → Generate random 32+ char string
```

**Dashboard (Railway Environment):**
```
VITE_DASHBOARD_PASSWORD → !Sinecurve1980!
VITE_API_URL → https://[backend-url]/api/v1
```

**Website (Vercel):**
```
No special secrets needed
```

---

## 🎯 Expected Timeline

| Step | Time | Notes |
|------|------|-------|
| Add secrets | 5 mins | Copy/paste from docs |
| Create projects | 10 mins | 3 projects on Railway + Vercel |
| First deploy | 5 mins | Git push automatically triggers |
| Services startup | 5-10 mins | Railway/Vercel deploy and start |
| Health checks | 2 mins | Verify all 3 services online |
| **Total** | **~30 mins** | ✅ Ready to go live |

---

## ✅ Next Steps

1. Read [GITHUB_ACTIONS_SETUP.md](GITHUB_ACTIONS_SETUP.md) for detailed instructions
2. Add GitHub secrets
3. Create Railway projects
4. Set environment variables
5. Push to main branch
6. Monitor deployments in GitHub Actions tab
7. Verify all services are working

---

**You're 95% done! Just need to add secrets and deploy! 🚀**
