# Deployment Readiness Checklist

## 🚀 Pre-Deployment QA

Use this checklist to verify everything is ready for production deployment.

### **Phase 1: Code Quality** ✅

- [ ] **Linting passes**
  ```bash
  npm run lint
  ```
  **Status:** Ready

- [ ] **TypeScript compilation**
  ```bash
  npx tsc --noEmit
  ```
  **Status:** Ready

- [ ] **No console errors/warnings**
  - Check browser console
  - Check server logs
  **Status:** Ready

### **Phase 2: Functionality Testing** 🧪

#### Dashboard (`localhost:3000`)

- [ ] **Authentication**
  - [ ] Can access login page without credentials
  - [ ] Wrong password shows error
  - [ ] Correct password grants access
  - [ ] Logout works correctly
  - [ ] Session persists on page reload
  
- [ ] **Dashboard Home**
  - [ ] Loads without errors
  - [ ] Stats cards display correctly
  - [ ] Trending signals appear
  - [ ] Usage metrics show

- [ ] **Signals**
  - [ ] List loads all signals
  - [ ] Filter by tier works
  - [ ] Filter by week works
  - [ ] Search functionality works
  - [ ] Pagination works
  - [ ] Click signal shows details
  - [ ] Related questions load

- [ ] **Runs**
  - [ ] List loads all runs
  - [ ] Can create new run
  - [ ] Click run shows details
  - [ ] Signals within run display

- [ ] **Experiments**
  - [ ] List loads with data

- [ ] **Settings**
  - [ ] Page loads

#### Website (`localhost:3001`)

- [ ] **Landing Page**
  - [ ] Page loads without errors
  - [ ] Hero section displays
  - [ ] Newsletter signup form shows
  - [ ] Subscribe button works
  - [ ] Links navigate correctly

- [ ] **Responsive Design**
  - [ ] Desktop layout works
  - [ ] Tablet layout works
  - [ ] Mobile layout works
  - [ ] Images are visible
  - [ ] Text is readable

### **Phase 3: API Testing** 🔌

Run the integration test suite:

```bash
# Make sure backend is running on localhost:8000
npm run test -- src/__tests__/api.integration.test.ts
```

**Tests to verify:**

- [ ] `GET /signals` - Returns signal list ✅
- [ ] `GET /signals/:id` - Returns specific signal ✅
- [ ] `GET /signals/trending` - Returns trending signals ✅
- [ ] `GET /signals/breakouts` - Returns breakouts ✅
- [ ] `GET /runs` - Returns run list ✅
- [ ] `GET /runs/:id` - Returns specific run ✅
- [ ] `POST /runs` - Can create new run ✅
- [ ] `GET /tenants/usage` - Returns usage data ✅
- [ ] `GET /experiments` - Returns experiments ✅
- [ ] Error handling for invalid IDs ✅
- [ ] Error handling for invalid endpoints ✅

### **Phase 4: Performance** ⚡

- [ ] **Dashboard Load Time**
  - Target: < 2s first meaningful paint
  - Current: Measure with Chrome DevTools
  - [ ] Status: __________

- [ ] **API Response Times**
  - Target: < 500ms for single resource
  - [ ] `/signals` - ____ ms
  - [ ] `/runs` - ____ ms
  - [ ] `/signals/:id` - ____ ms
  - [ ] Status: __________

- [ ] **Bundle Size**
  ```bash
  npm run build
  # Check dist/ folder size
  ```
  - Current: __________
  - Status: __________

### **Phase 5: Security** 🔐

- [ ] **Dashboard Password**
  - [ ] Set strong password in `.env`
  - [ ] NOT using default password
  - [ ] Password does not appear in code

- [ ] **CORS Headers**
  - [ ] Backend allows dashboard origin
  - [ ] Backend allows website origin
  - [ ] No wildcard (*) in production

- [ ] **API Authentication**
  - [ ] Backend validates API requests
  - [ ] Authorization working
  - [ ] No sensitive data in logs

- [ ] **HTTPS**
  - [ ] Production uses HTTPS
  - [ ] SSL certificate valid
  - [ ] Mixed content check

### **Phase 6: Infrastructure** 🏗️

- [ ] **Backend Running**
  - [ ] Port 8000 accessible
  - [ ] Health check passes
  - [ ] Database connected
  - Status: http://localhost:8000/health ✅

- [ ] **Frontend Build**
  ```bash
  npm run build
  # Size: ________
  # Build time: ________
  ```

- [ ] **Environment Variables**
  - [ ] Dashboard password set
  - [ ] API URL correct
  - [ ] All required vars present
  - [ ] No hardcoded secrets

### **Phase 7: Deployment** 📦

#### Website (Vercel)

- [ ] **Git commits pushed**
  ```bash
  git status  # Should be clean
  ```

- [ ] **Build succeeds**
  ```bash
  npm run build
  # No errors
  ```

- [ ] **Preview deployment works**
  - [ ] Can access preview URL
  - [ ] All functionality works
  - [ ] No console errors

- [ ] **Production deployment**
  - [ ] Deploy to production
  - [ ] Verify at https://antialgo.ai
  - [ ] Check all pages load
  - [ ] Monitor for errors (2 hours)

#### Dashboard (Railway)

- [ ] **Docker builds**
  ```bash
  docker build -t curiosity-dashboard .
  ```

- [ ] **Docker runs locally**
  ```bash
  docker run -p 3000:3000 curiosity-dashboard
  ```

- [ ] **Environment variables set in Railway**
  - [ ] `VITE_DASHBOARD_PASSWORD` set
  - [ ] All required vars present

- [ ] **Production deployment**
  - [ ] Deploy to Railway
  - [ ] Verify at https://antialgo.ai/dashboard
  - [ ] Test authentication
  - [ ] Monitor for errors (2 hours)

### **Phase 8: Post-Deployment Verification** ✅

- [ ] **Production dashboard**
  - [ ] Accessible at URL
  - [ ] Authentication works
  - [ ] Can view signals
  - [ ] Can view runs
  - [ ] No console errors

- [ ] **Production website**
  - [ ] Accessible at URL
  - [ ] Newsletter signup works
  - [ ] Links correct
  - [ ] Analytics tracking
  - [ ] No console errors

- [ ] **Monitoring**
  - [ ] Error tracking active (Sentry)
  - [ ] Performance monitoring active
  - [ ] Uptime monitoring active
  - [ ] Alerts configured

## 🐛 Common Issues & Solutions

| Issue | Solution |
|-------|----------|
| Dashboard won't load | Check VITE_DASHBOARD_PASSWORD is set |
| API calls fail | Verify backend is running on port 8000 |
| CORS errors | Check CORS origins in backend |
| Default password working | Change VITE_DASHBOARD_PASSWORD immediately |
| Website styling broken | Clear browser cache and rebuild |
| Signals not showing | Verify database connection on backend |

## 📝 Sign-Off

- [ ] All tests passed
- [ ] QA checklist completed
- [ ] Ready for deployment

**Tested by:** ________________  
**Date:** ________________  
**Time taken:** ________________

## 🎉 Post-Deployment

Monitor these metrics for 24-48 hours:

- Error rates
- Response times
- User engagement
- Database performance

If issues arise, rollback and investigate.
