# File Organization & Renaming Reference

## BEFORE vs AFTER Comparison

### Directory Structure Transformation

#### CURRENT STATE (❌ Problems)
```
TheTeam /                           ← Trailing space issue
├── curiosity-intelligence 1/        ← Version number
├── curiosity-website 2/             ← Version number
├── AgentCommsProtocol.md
├── AgentJonyIveYML.md               ← Root clutter
├── AgentSteveJobsYML.md             ← Root clutter
├── AgentWozniakYML.md               ← Root clutter
├── OrchestratorAgent.md             ← Root clutter
├── OutputSchema.md
├── README.md
├── schemas/
└── subagents/
    ├── JonyIve_DesignMemory.md
    ├── JonyIve_DesignSystemIntel.md
    ├── SteveJobs_*.md
    └── Wozniak_*.md
```

**Issues:**
- Trailing space in "TheTeam "
- Version numbers in folder names ("1", "2")
- Agent documentation scattered across root and subagents/
- No clear organization of strategic documents

---

#### RECOMMENDED STATE (✅ Fixed)
```
antialgo/                           ← Clean name
├── curiosity-intelligence/          ← No version
├── curiosity-website/               ← No version
├── README.md                        ← Main guide
├── DEPLOYMENT.md                    ← NEW - Deployment procedures
├── PROJECT_AUDIT_REPORT.md          ← NEW - Audit findings
├── ARCHITECTURE_OVERVIEW.md         ← NEW - System architecture
├── AUDIT_ACTION_CHECKLIST.md        ← NEW - Action items
│
├── schemas/
│   ├── HandoffSchema.md
│   └── OutputSchema.md
│
├── agents/                          ← NEW - Organized
│   ├── OrchestratorAgent.md
│   ├── AgentCommsProtocol.md
│   │
│   ├── JonyIve/                     ← Sub-directory
│   │   ├── JonyIve_DesignMemory.md
│   │   ├── JonyIve_DesignSystemIntel.md
│   │   ├── JonyIve_NarrativeSignal.md
│   │   └── JonyIve_PatternScout.md
│   │
│   ├── SteveJobs/                   ← Sub-directory
│   │   ├── SteveJobs_CompetitiveRecon.md
│   │   ├── SteveJobs_GTMStrategist.md
│   │   ├── SteveJobs_MarketIntel.md
│   │   └── SteveJobs_StrategyMemory.md
│   │
│   └── Wozniak/                     ← Sub-directory
│       ├── Wozniak_DependencyIntel.md
│       ├── Wozniak_EngineeringMemory.md
│       ├── Wozniak_SourceTriangulator.md
│       └── Wozniak_WebScout.md
│
├── outputs/                         ← Unchanged
│
└── .git/, .github/, etc.            ← Standard config
```

**Improvements:**
- ✅ Removed trailing space
- ✅ Removed version numbers
- ✅ Organized agents in dedicated folder
- ✅ Added missing documentation
- ✅ Cleaner root directory
- ✅ Logical hierarchy

---

## File Renaming Details

### API Client Files

#### 1. Dashboard API Client
**Current:** `curiosity-intelligence/dashboard/src/lib/api.ts`  
**Rename to:** `curiosity-intelligence/dashboard/src/lib/adminApi.ts`

**Reason:** Serves admin/internal dashboard, needs clear naming

**Files to Update (imports):**
```bash
# Find all files in dashboard/ that import from ./api
grep -r "from.*./api" curiosity-intelligence/dashboard/src/
grep -r "from.*./lib/api" curiosity-intelligence/dashboard/src/
grep -r "import.*api" curiosity-intelligence/dashboard/src/

# Update imports:
# FROM: import { ... } from '../lib/api'
# TO:   import { ... } from '../lib/adminApi'
```

**Find & Replace:**
```
find curiosity-intelligence/dashboard/src -name "*.ts" -o -name "*.tsx" | xargs sed -i "s|from ['\"]./api['\"]|from './adminApi'|g"
find curiosity-intelligence/dashboard/src -name "*.ts" -o -name "*.tsx" | xargs sed -i "s|from ['\"]../lib/api['\"]|from '../lib/adminApi'|g"
find curiosity-intelligence/dashboard/src -name "*.ts" -o -name "*.tsx" | xargs sed -i "s|from ['\"]../../lib/api['\"]|from '../../lib/adminApi'|g"
```

---

#### 2. Website API Client
**Current:** `curiosity-website/src/lib/api.ts`  
**Rename to:** `curiosity-website/src/lib/publicApi.ts`

**Reason:** Serves public/customer-facing website, different purpose from dashboard

**Files to Update (imports):**
```bash
grep -r "from.*./api" curiosity-website/src/
grep -r "from.*./lib/api" curiosity-website/src/
grep -r "import.*api" curiosity-website/src/
```

**Find & Replace:**
```
find curiosity-website/src -name "*.ts" -o -name "*.tsx" | xargs sed -i "s|from ['\"]./api['\"]|from './publicApi'|g"
find curiosity-website/src -name "*.ts" -o -name "*.tsx" | xargs sed -i "s|from ['\"]../lib/api['\"]|from '../lib/publicApi'|g"
find curiosity-website/src -name "*.ts" -o -name "*.tsx" | xargs sed -i "s|from ['\"]../../lib/api['\"]|from '../../lib/publicApi'|g"
```

---

### Directory Restructuring

#### Step 1: Remove Trailing Space from Main Directory
```bash
cd /Users/computersex2/Documents/DevelopmentProjects
# Careful: directory name has trailing space

# Check current state
ls -d "TheTeam " 2>/dev/null && echo "Found"

# Move directory
mv "TheTeam " "TheTeam-backup"
mv "TheTeam-backup" "TheTeam"

# Verify
ls -d "TheTeam" && echo "Renamed successfully"
```

---

#### Step 2: Remove Version Numbers from Service Directories
```bash
cd /Users/computersex2/Documents/DevelopmentProjects/TheTeam

# Rename backend
mkdir -p curiosity-intelligence || true
mv "curiosity-intelligence 1"/* curiosity-intelligence/ 2>/dev/null || true
rmdir "curiosity-intelligence 1" 2>/dev/null || true

# Rename frontend
mkdir -p curiosity-website || true
mv "curiosity-website 2"/* curiosity-website/ 2>/dev/null || true
rmdir "curiosity-website 2" 2>/dev/null || true

# Verify
ls -d curiosity-intelligence curiosity-website
```

---

#### Step 3: Reorganize Agent Documentation
```bash
cd /Users/computersex2/Documents/DevelopmentProjects/TheTeam

# Create new agents directory structure
mkdir -p agents/JonyIve
mkdir -p agents/SteveJobs
mkdir -p agents/Wozniak

# Move files (non-destructive copy first, then verify before delete)
cp subagents/JonyIve_*.md agents/JonyIve/
cp subagents/SteveJobs_*.md agents/SteveJobs/
cp subagents/Wozniak_*.md agents/Wozniak/

# Move root orchestrator files
cp OrchestratorAgent.md agents/
cp AgentCommsProtocol.md agents/

# Verify files exist before cleanup
ls -la agents/JonyIve/
ls -la agents/SteveJobs/
ls -la agents/Wozniak/
ls -la agents/*.md

# Clean up original files AFTER verifying
rm OrchestratorAgent.md AgentCommsProtocol.md AgentJonyIveYML.md AgentSteveJobsYML.md AgentWozniakYML.md
# Keep subagents/ directory as backup or symlink if needed
```

---

## Configuration Files to Create/Update

### 1. Create `railway.json`
**Location:** `curiosity-intelligence/railway.json`

```json
{
  "build": {
    "builder": "dockerfile"
  },
  "start": "uvicorn curiosity_intelligence.api.main:app --host 0.0.0.0 --port $PORT"
}
```

**Why:** Railway needs explicit instructions on how to start the Python app

---

### 2. Create `curiosity-website/.env.example`
**Location:** `curiosity-website/.env.example`

```env
# API Configuration
# For production, set to your Railway backend URL
# For local development, leave blank (uses vite proxy)
VITE_API_URL=https://api.antialgo.ai

# Optional
# VITE_LOG_LEVEL=debug
```

**Why:** Documents required environment variables for the website

---

### 3. Create `DEPLOYMENT.md` (at root)
**Location:** `DEPLOYMENT.md`

See [DEPLOYMENT.md template in AUDIT_ACTION_CHECKLIST.md](./AUDIT_ACTION_CHECKLIST.md)

**Why:** Documents deployment procedures for the team

---

## Git Workflow for Renaming

### Safe Multi-Step Approach

```bash
# Step 1: Create feature branch
git checkout -b refactor/clean-directory-structure

# Step 2: Stage all changes (use git mv to preserve history)
cd curiosity-intelligence
git mv "dashboard/src/lib/api.ts" "dashboard/src/lib/adminApi.ts"
cd ../curiosity-website
git mv "src/lib/api.ts" "src/lib/publicApi.ts"
cd ..

# Step 3: Update imports in all files
# (Use the find & replace commands above)

# Step 4: Verify no broken imports
npm run build  # in both frontend directories
python -m mypy curiosity_intelligence  # in backend

# Step 5: Commit changes
git add -A
git commit -m "refactor: Rename API client files for clarity

- dashboard/src/lib/api.ts → adminApi.ts
- website/src/lib/api.ts → publicApi.ts

Improves code clarity and prevents import mistakes.

Changes:
- Updated all imports across dashboard/
- Updated all imports across website/
- Verified TypeScript compilation
- Verified no breakage"

# Step 6: Create second commit for directory structure
git add -A
git commit -m "refactor: Fix directory naming and structure

Changes:
- Remove trailing space from workspace directory (TheTeam → TheTeam)
- Remove version numbers: 'curiosity-intelligence 1' → 'curiosity-intelligence'
- Remove version numbers: 'curiosity-website 2' → 'curiosity-website'
- Moved agent documentation to agents/ directory
- Created agents/{JonyIve,SteveJobs,Wozniak}/ subdirectories

This improves project maintainability and deployment compatibility."

# Step 7: Push and create PR
git push origin refactor/clean-directory-structure

# Step 8: Open PR for review on GitHub
# (Link: https://github.com/your-repo/pulls)

# Step 9: After review, merge
git checkout main
git pull origin main
git merge --ff-only refactor/clean-directory-structure

# Step 10: Delete branch
git branch -d refactor/clean-directory-structure
git push origin --delete refactor/clean-directory-structure
```

---

## Testing After Changes

### 1. Verify File Renames
```bash
# Check new files exist
ls -l curiosity-intelligence/dashboard/src/lib/adminApi.ts
ls -l curiosity-website/src/lib/publicApi.ts

# Check old files don't exist
! ls curiosity-intelligence/dashboard/src/lib/api.ts
! ls curiosity-website/src/lib/api.ts
```

### 2. Verify Import Resolution
```bash
# Dashboard build
cd curiosity-intelligence/dashboard
npm run build
cd ../../

# Website build
cd curiosity-website
npm run build
cd ..

# Backend type check
cd curiosity-intelligence
mypy curiosity_intelligence --ignore-missing-imports
cd ..
```

### 3. Verify Directory Structure
```bash
# Check directories renamed
ls -d curiosity-intelligence
ls -d curiosity-website

# Check sub-structure
ls -la curiosity-intelligence/dashboard/src/lib/adminApi.ts
ls -la curiosity-website/src/lib/publicApi.ts

# Check agent organization
ls -d agents/JonyIve
ls -d agents/SteveJobs
ls -d agents/Wozniak
```

### 4. Docker Compose Test
```bash
# Full integration test
docker-compose down
docker-compose up -d

# Wait for startup
sleep 30

# Check all services
curl http://localhost:8000/health
curl http://localhost:3000/  # dashboard
curl http://localhost:3002/  # website

# Check logs
docker-compose logs api
docker-compose logs dashboard
docker-compose logs postgres

# Cleanup
docker-compose down
```

---

## Rollback Procedure

If something goes wrong during renaming:

```bash
# Option 1: Undo last commit
git revert HEAD

# Option 2: Reset to previous state
git reset --hard <previous-commit-hash>

# Option 3: Create recovery branch
git checkout <previous-commit-hash> -b recovery/pre-rename-state
```

---

## Import Update Checklist

After renaming API files, verify all these files are updated:

### Dashboard (`curiosity-intelligence/dashboard/`)
```
src/
├── pages/           ← Check all .tsx files
├── components/      ← Check all .tsx files
├── lib/             ← Check for re-exports
├── main.tsx         ← Check
└── App.tsx          ← Check
```

Find & verify all imports:
```bash
grep -r "api" curiosity-intelligence/dashboard/src --include="*.ts" --include="*.tsx" | grep -E "import|from"
```

### Website (`curiosity-website/`)
```
src/
├── pages/           ← Check all .tsx files
├── components/      ← Check all .tsx files
├── lib/             ← Check for re-exports
├── main.tsx         ← Check
└── App.tsx          ← Check
```

Find & verify all imports:
```bash
grep -r "api" curiosity-website/src --include="*.ts" --include="*.tsx" | grep -E "import|from"
```

---

## Tools & Commands Reference

### Mass File Operations
```bash
# Find all TypeScript files importing api.ts
find . -name "*.ts" -o -name "*.tsx" | xargs grep -l "from.*api"

# Find and display all imports
grep -rn "import.*api" . --include="*.ts" --include="*.tsx"

# Safe rename with git history preservation
git mv old-name.ts new-name.ts
git add -A
git commit -m "refactor: rename old-name.ts to new-name.ts"
```

### Verification Commands
```bash
# Check no old files remain
find . -name "*.ts" -o -name "*.tsx" | xargs grep -l "lib/api\"" | head -20

# Build and type check
npm run build  # frontend
mypy . --ignore-missing-imports  # backend

# Test imports resolve
python -c "from curiosity_intelligence.api import main" 2>&1

# Full docker test
docker-compose up -d --build
```

---

## Summary of Changes Needed

| Change | Before | After | Impact | Effort |
|--------|--------|-------|--------|--------|
| Directory name | TheTeam  | TheTeam | Deployment tools | 30 min |
| Backend folder | curiosity-intel 1 | curiosity-intel | Clear naming | 30 min |
| Frontend folder | curiosity-web 2 | curiosity-web | Clear naming | 30 min |
| Dashboard API | api.ts | adminApi.ts | Less confusion | 1 hour |
| Website API | api.ts | publicApi.ts | Less confusion | 1 hour |
| Agents docs | Root + subagents/ | agents/ | Organized | 1 hour |
| Railway config | ❌ Missing | railway.json | Deployment ready | 30 min |
| Documentation | Incomplete | Complete | Team clarity | 2 hours |
| **TOTAL** | Messy | Clean | Professional | **~7 hours** |

---

**Ready to execute? Start with AUDIT_ACTION_CHECKLIST.md**
