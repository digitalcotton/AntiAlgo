#!/bin/bash

# ═══════════════════════════════════════════════════════════════
# DEPLOYMENT VERIFICATION SCRIPT
# Run this before deployment to catch issues early
# ═══════════════════════════════════════════════════════════════

set -e  # Exit on any error

echo "🚀 Starting deployment verification..."
echo ""

# ─── Configuration ───────────────────────────────────────────

DASHBOARD_DIR="curiosity-intelligence 1/dashboard"
WEBSITE_DIR="curiosity-website 2"
BACKEND_URL="http://localhost:8000"
DASHBOARD_URL="http://localhost:3000"
WEBSITE_URL="http://localhost:3001"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ─── Helper Functions ────────────────────────────────────────

print_header() {
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "  $1"
  echo "═══════════════════════════════════════════════════════════════"
  echo ""
}

print_success() {
  echo -e "${GREEN}✅ $1${NC}"
}

print_error() {
  echo -e "${RED}❌ $1${NC}"
}

print_warning() {
  echo -e "${YELLOW}⚠️  $1${NC}"
}

print_info() {
  echo -e "ℹ️  $1"
}

check_command() {
  if ! command -v $1 &> /dev/null; then
    print_error "$1 is not installed"
    return 1
  fi
  print_success "$1 is installed"
  return 0
}

check_server() {
  local url=$1
  local name=$2
  
  if timeout 5 curl -s "$url" > /dev/null; then
    print_success "$name is running"
    return 0
  else
    print_warning "$name is not running on $url"
    return 1
  fi
}

# ─── Phase 1: Environment Check ──────────────────────────

print_header "Phase 1: Environment Check"

check_command "node" || exit 1
check_command "npm" || exit 1
check_command "git" || exit 1
check_command "docker" || exit 1

print_success "All required commands are installed"

# ─── Phase 2: Git Status ────────────────────────────────

print_header "Phase 2: Git Status"

if [ -z "$(git status --porcelain)" ]; then
  print_success "Git repository is clean"
else
  print_error "Git repository has uncommitted changes:"
  git status --short
  echo ""
  print_warning "Please commit changes before deploying"
fi

# ─── Phase 3: Dashboard Checks ──────────────────────────

print_header "Phase 3: Dashboard Verification"

cd "$DASHBOARD_DIR" || exit 1

print_info "Building dashboard..."
npm run build > /dev/null 2>&1 && print_success "Dashboard build successful" || print_error "Dashboard build failed"

print_info "Checking for TypeScript errors..."
npx tsc --noEmit 2> /tmp/tsc-errors.log && print_success "No TypeScript errors" || {
  print_error "TypeScript errors found:"
  cat /tmp/tsc-errors.log | head -10
}

print_info "Checking environment variables..."
if [ -f ".env" ]; then
  if grep -q "VITE_DASHBOARD_PASSWORD" .env; then
    PASS=$(grep "VITE_DASHBOARD_PASSWORD" .env | cut -d= -f2)
    if [ "$PASS" = "dashboard123" ]; then
      print_warning "Using default dashboard password"
    else
      print_success "Dashboard password is set"
    fi
  else
    print_warning ".env exists but VITE_DASHBOARD_PASSWORD not set"
  fi
else
  print_warning ".env not found (using defaults)"
fi

cd - > /dev/null

# ─── Phase 4: Website Checks ────────────────────────────

print_header "Phase 4: Website Verification"

cd "$WEBSITE_DIR" || exit 1

print_info "Building website..."
npm run build > /dev/null 2>&1 && print_success "Website build successful" || print_error "Website build failed"

print_info "Checking for TypeScript errors..."
npx tsc --noEmit 2> /tmp/tsc-errors.log && print_success "No TypeScript errors" || {
  print_error "TypeScript errors found:"
  cat /tmp/tsc-errors.log | head -10
}

cd - > /dev/null

# ─── Phase 5: Server Status ────────────────────────────

print_header "Phase 5: Server Status"

check_server "$BACKEND_URL" "Backend API" || print_warning "Start backend with: cd curiosity-intelligence\\ 1 && python -m uvicorn curiosity_intelligence.api.main:app --reload"
check_server "$DASHBOARD_URL" "Dashboard" || print_warning "Start dashboard with: cd \"curiosity-intelligence 1/dashboard\" && npm run dev"
check_server "$WEBSITE_URL" "Website" || print_warning "Start website with: cd \"curiosity-website 2\" && npm run dev -- --port 3001"

# ─── Phase 6: API Health ────────────────────────────────

print_header "Phase 6: API Health Checks"

if check_server "$BACKEND_URL/health" "Backend health"; then
  # Test key endpoints
  print_info "Testing API endpoints..."
  
  if timeout 5 curl -s "$BACKEND_URL/api/v1/signals?limit=1" > /dev/null; then
    print_success "GET /api/v1/signals works"
  else
    print_error "GET /api/v1/signals failed"
  fi
  
  if timeout 5 curl -s "$BACKEND_URL/api/v1/runs?limit=1" > /dev/null; then
    print_success "GET /api/v1/runs works"
  else
    print_error "GET /api/v1/runs failed"
  fi
  
  if timeout 5 curl -s "$BACKEND_URL/api/v1/tenants/usage" > /dev/null; then
    print_success "GET /api/v1/tenants/usage works"
  else
    print_error "GET /api/v1/tenants/usage failed"
  fi
fi

# ─── Summary ────────────────────────────────────────────

print_header "Deployment Verification Summary"

echo "✅ Ready to deploy when:"
echo "  1. All TypeScript errors are fixed"
echo "  2. All API endpoints are responding"
echo "  3. Git repository is clean"
echo "  4. Environment variables are set correctly"
echo ""
echo "📋 Next steps:"
echo "  1. Review DEPLOYMENT_QA_CHECKLIST.md"
echo "  2. Commit all changes: git add -A && git commit -m '...'"
echo "  3. Deploy to production"
echo ""
print_success "Deployment verification complete!"
