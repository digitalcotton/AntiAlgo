# 🔐 Railway Secrets Setup Guide

## What's the Difference?

| Feature | Variables | Secrets |
|---------|-----------|---------|
| **Visibility** | Shown in plaintext in UI | Hidden/masked in UI |
| **Logs** | Appears in build logs | Never logged |
| **Git** | Can accidentally be committed | Protected against commits |
| **Use Case** | Config values | Passwords, API keys, tokens |

---

## ✅ How to Add Secrets in Railway

### For Dashboard Project:

1. **Navigate to Railway Dashboard** → Your Dashboard Project
2. **Click "Secrets" tab** (not "Variables")
3. **Add new secret** by clicking the **"+"** button
4. **Enter the secret:**
   ```
   Name: VITE_DASHBOARD_PASSWORD
   Value: !Sinecurve1980!
   ```
5. **Press Enter to save**
6. **Repeat for API URL:**
   ```
   Name: VITE_API_URL
   Value: https://api.antialgo.ai
   ```

### For Backend Project:

If needed, add any secrets here too:
```
SUPABASE_URL=your_url
SUPABASE_KEY=your_key
OPENAI_API_KEY=your_key
JWT_SECRET=your_secret
```

---

## 🔒 Security Benefits

✅ **Encrypted at rest** on Railway servers  
✅ **Never appears in build logs**  
✅ **Masked in the UI** (shows as `***`)  
✅ **Only accessible to authorized team members**  
✅ **Rotatable without code changes**  

---

## 🚀 After Adding Secrets

Railway will **automatically trigger a rebuild** of your service with the new environment variables.

**Status to watch for:**
- ⏳ `Building` → Building with new secrets
- ✅ `ACTIVE` → Deployment successful with secrets loaded

---

## 📝 Notes

- Secrets are best for: **passwords, API keys, tokens, database credentials**
- Variables are best for: **URLs, environment names, feature flags**
- Both are injected at runtime, not baked into the Docker image
- Both are encrypted in transit and at rest

---

**After you add the secrets, your Dashboard should deploy and be ready to use!**
