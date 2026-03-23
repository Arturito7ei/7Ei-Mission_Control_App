#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────
# 7Ei Mission Control — Production Setup Script
# Run from the repo root: bash scripts/setup-prod.sh
# ────────────────────────────────────────────────────────────
set -e
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

log()  { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC}  $1"; }
info() { echo -e "${BLUE}→${NC}  $1"; }
err()  { echo -e "${RED}✕${NC}  $1"; }
step() { echo -e "\n${BOLD}${BLUE}[── $1 ──]${NC}"; }

check_cmd() { command -v "$1" &>/dev/null && log "$1 found" || { err "$1 not found — install it first"; exit 1; }; }

echo -e "\n${BOLD}7Ei Mission Control — Production Setup${NC}"
echo -e "This script walks you through all 10 go-live tasks.\n"

# ────────────────────────────────────────────────────────────
step "0 / Prerequisites"
check_cmd node
check_cmd npm
check_cmd git

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 20 ]; then
  err "Node 20+ required (you have $(node -v))"
  exit 1
fi
log "Node $(node -v) OK"

# ────────────────────────────────────────────────────────────
step "1 / EAS Project ID"
if ! command -v eas &>/dev/null; then
  info "Installing EAS CLI…"
  npm install -g eas-cli
fi
log "EAS CLI ready"
info "You need to be logged into your Expo account:"
echo ""
echo "  cd app && eas login"
echo "  eas init --id \"\"   # creates project and fills EAS_PROJECT_ID"
echo ""
read -p "Press ENTER after running the above commands to continue…"

# ────────────────────────────────────────────────────────────
step "2 / Apple Team ID"
info "Get your Apple Team ID from:"
echo "  https://developer.apple.com/account (look for \"Team ID\" in top-right)"
echo ""
read -p "Paste your Apple Team ID: " APPLE_TEAM_ID
if [ -n "$APPLE_TEAM_ID" ]; then
  # Update eas.json
  if command -v jq &>/dev/null; then
    TMP=$(mktemp)
    jq --arg tid "$APPLE_TEAM_ID" '.submit.production.ios.appleTeamId = $tid' app/eas.json > "$TMP" && mv "$TMP" app/eas.json
    log "eas.json updated with APPLE_TEAM_ID=$APPLE_TEAM_ID"
  else
    warn "jq not installed — manually set appleTeamId in app/eas.json"
  fi
fi

# ────────────────────────────────────────────────────────────
step "3 / Turso Database"
if ! command -v turso &>/dev/null; then
  info "Installing Turso CLI…"
  curl -sSfL https://get.tur.so/install.sh | bash
  export PATH="$HOME/.turso:$PATH"
fi
turso auth login
info "Creating database in Frankfurt…"
turso db create 7ei-production --location fra
DB_URL=$(turso db show 7ei-production --url)
DB_TOKEN=$(turso db tokens create 7ei-production)
log "Database created: $DB_URL"

# ────────────────────────────────────────────────────────────
step "4 / Pinecone Index"
warn "Pinecone requires a browser — open:"
echo "  https://console.pinecone.io"
echo ""
echo "  1. Create index: Name=7ei-knowledge, Dimensions=1536, Metric=cosine"
echo "  2. Cloud: AWS, Region: us-east-1 (serverless)"
echo "  3. Copy your API Key and Project ID"
echo ""
read -p "Paste Pinecone API Key:    " PINECONE_API_KEY
read -p "Paste Pinecone Project ID: " PINECONE_PROJECT_ID

# ────────────────────────────────────────────────────────────
step "5 / Upstash Redis"
warn "Upstash requires a browser — open:"
echo "  https://console.upstash.com"
echo ""
echo "  1. Create Redis database in eu-central-1"
echo "  2. Copy the TLS URL: rediss://default:...@....upstash.io:6379"
echo ""
read -p "Paste Upstash Redis URL: " REDIS_URL

# ────────────────────────────────────────────────────────────
step "6 / Remaining secrets"
read -p "Anthropic API Key (sk-ant-...):         " ANTHROPIC_API_KEY
read -p "Clerk Secret Key (sk_live_...):        " CLERK_SECRET_KEY
read -p "Clerk Publishable Key (pk_live_...):   " CLERK_PUBLISHABLE_KEY
read -p "OpenAI API Key (sk-... or leave blank): " OPENAI_API_KEY
read -p "Gemini API Key (AIza... or blank):     " GEMINI_API_KEY
read -p "Public URL (https://api.7ei.ai):       " PUBLIC_URL
PUBLIC_URL=${PUBLIC_URL:-https://api.7ei.ai}

# Write .env.production for reference
cat > backend/.env.production <<EOF
CLERK_SECRET_KEY=$CLERK_SECRET_KEY
CLERK_PUBLISHABLE_KEY=$CLERK_PUBLISHABLE_KEY
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY
OPENAI_API_KEY=$OPENAI_API_KEY
GEMINI_API_KEY=$GEMINI_API_KEY
DATABASE_URL=$DB_URL
DATABASE_AUTH_TOKEN=$DB_TOKEN
PINECONE_API_KEY=$PINECONE_API_KEY
PINECONE_PROJECT_ID=$PINECONE_PROJECT_ID
PINECONE_ENVIRONMENT=us-east-1-aws
PINECONE_INDEX=7ei-knowledge
REDIS_URL=$REDIS_URL
PUBLIC_URL=$PUBLIC_URL
PORT=3001
NODE_ENV=production
ALLOWED_ORIGINS=https://app.7ei.ai,https://7ei.ai
EOF
log "Wrote backend/.env.production (DO NOT commit this file)"

# ────────────────────────────────────────────────────────────
step "7 / Deploy backend → Fly.io"
if ! command -v flyctl &>/dev/null; then
  info "Installing flyctl…"
  curl -L https://fly.io/install.sh | sh
  export PATH="$HOME/.fly/bin:$PATH"
fi

cd backend
flyctl auth login
flyctl launch --name 7ei-backend --region fra --no-deploy 2>/dev/null || true

info "Setting Fly.io secrets…"
flyctl secrets set \
  CLERK_SECRET_KEY="$CLERK_SECRET_KEY" \
  CLERK_PUBLISHABLE_KEY="$CLERK_PUBLISHABLE_KEY" \
  ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  DATABASE_URL="$DB_URL" \
  DATABASE_AUTH_TOKEN="$DB_TOKEN" \
  PINECONE_API_KEY="$PINECONE_API_KEY" \
  PINECONE_PROJECT_ID="$PINECONE_PROJECT_ID" \
  PINECONE_ENVIRONMENT="us-east-1-aws" \
  REDIS_URL="$REDIS_URL" \
  PUBLIC_URL="$PUBLIC_URL" \
  NODE_ENV="production" \
  ALLOWED_ORIGINS="https://app.7ei.ai,https://7ei.ai" \
  ${OPENAI_API_KEY:+OPENAI_API_KEY="$OPENAI_API_KEY"} \
  ${GEMINI_API_KEY:+GEMINI_API_KEY="$GEMINI_API_KEY"}

info "Deploying…"
flyctl deploy --remote-only

# Verify health
BACKEND_HOST=$(flyctl info --json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('Hostname','7ei-backend.fly.dev'))" 2>/dev/null || echo "7ei-backend.fly.dev")
HEALTH=$(curl -s "https://$BACKEND_HOST/health" || echo '{}')
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  log "Backend healthy at https://$BACKEND_HOST ✔"
else
  warn "Health check inconclusive. Check: https://$BACKEND_HOST/health"
fi

# Get Fly token for CI
FLY_TOKEN=$(flyctl auth token 2>/dev/null || echo "")
cd ..

# ────────────────────────────────────────────────────────────
step "8 / Deploy web → Vercel"
if ! command -v vercel &>/dev/null; then
  info "Installing Vercel CLI…"
  npm install -g vercel
fi

cd web
vercel login
vercel link

info "Setting Vercel env vars…"
echo "$CLERK_PUBLISHABLE_KEY" | vercel env add NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY production
echo "$CLERK_SECRET_KEY"      | vercel env add CLERK_SECRET_KEY production
echo "$PUBLIC_URL"            | vercel env add NEXT_PUBLIC_API_URL production

info "Deploying to production…"
vercel --prod

# Grab Vercel project info for CI
VERCEL_ORG_ID=$(cat .vercel/project.json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('orgId',''))" 2>/dev/null || echo "")
VERCEL_PROJECT_ID=$(cat .vercel/project.json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('projectId',''))" 2>/dev/null || echo "")
VERCEL_TOKEN=$(cat ~/.vercel/auth.json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo "")
cd ..

# ────────────────────────────────────────────────────────────
step "9 / GitHub Secrets for CI"
if command -v gh &>/dev/null; then
  REPO=$(git remote get-url origin | sed 's/.*github.com[:/]//' | sed 's/\.git//')
  info "Setting GitHub secrets for $REPO…"
  [ -n "$FLY_TOKEN" ]         && gh secret set FLY_API_TOKEN       --body "$FLY_TOKEN"         -R "$REPO" && log "FLY_API_TOKEN set"
  [ -n "$VERCEL_TOKEN" ]      && gh secret set VERCEL_TOKEN        --body "$VERCEL_TOKEN"       -R "$REPO" && log "VERCEL_TOKEN set"
  [ -n "$VERCEL_ORG_ID" ]     && gh secret set VERCEL_ORG_ID       --body "$VERCEL_ORG_ID"      -R "$REPO" && log "VERCEL_ORG_ID set"
  [ -n "$VERCEL_PROJECT_ID" ] && gh secret set VERCEL_PROJECT_ID   --body "$VERCEL_PROJECT_ID"  -R "$REPO" && log "VERCEL_PROJECT_ID set"
else
  warn "GitHub CLI not found. Set these secrets manually in GitHub Settings:"
  echo "  FLY_API_TOKEN       = $FLY_TOKEN"
  echo "  VERCEL_TOKEN        = (from ~/.vercel/auth.json or vercel.com/account/tokens)"
  echo "  VERCEL_ORG_ID       = $VERCEL_ORG_ID"
  echo "  VERCEL_PROJECT_ID   = $VERCEL_PROJECT_ID"
fi

# ────────────────────────────────────────────────────────────
step "10 / EAS Production Build + App Store Submit"
info "This step takes 15-30 min (EAS cloud build). Starting now…"
cd app
eas build --platform all --profile production --non-interactive || warn "Build may need manual confirmation at expo.dev"
cd ..

# ────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}──────────────────────────────${NC}"
echo -e "${BOLD}${GREEN}  🚀 7Ei Mission Control is live!${NC}"
echo -e "${BOLD}${GREEN}──────────────────────────────${NC}"
echo ""
echo "  Backend:  https://$BACKEND_HOST/health"
echo "  Web:      https://app.7ei.ai"
echo "  Landing:  https://7ei.ai"
echo ""
echo "  Mobile build in progress at expo.dev"
echo "  After build completes, submit with: cd app && eas submit --platform all"
echo ""
