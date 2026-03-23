#!/usr/bin/env bash
# Run: bash scripts/check-secrets.sh
# Checks all required environment variables are set on Fly.io
set -e
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✕${NC} $1 — MISSING"; MISSING=$((MISSING+1)); }
warn() { echo -e "  ${YELLOW}∘${NC} $1 — optional"; }

MISSING=0

echo ""
echo "7Ei Backend — Fly.io Secrets Check"
echo ""

SECRETS=$(flyctl secrets list --app 7ei-backend 2>/dev/null | awk '{print $1}' || echo "")

has() { echo "$SECRETS" | grep -q "^$1$" && ok "$1" || fail "$1"; }
opt() { echo "$SECRETS" | grep -q "^$1$" && ok "$1" || warn "$1"; }

echo "Required:"
has CLERK_SECRET_KEY
has ANTHROPIC_API_KEY
has DATABASE_URL
has DATABASE_AUTH_TOKEN
has PUBLIC_URL

echo ""
echo "Recommended:"
opt PINECONE_API_KEY
opt PINECONE_PROJECT_ID
opt REDIS_URL

echo ""
echo "Optional (extra LLM providers):"
opt OPENAI_API_KEY
opt GEMINI_API_KEY

echo ""
if [ "$MISSING" -gt 0 ]; then
  echo -e "${RED}✕ $MISSING required secret(s) missing. Run: flyctl secrets set KEY=value${NC}"
  exit 1
else
  echo -e "${GREEN}✓ All required secrets present.${NC}"
  echo ""
  echo "Verifying health endpoint…"
  curl -s https://7ei-backend.fly.dev/health | python3 -c "import sys,json; d=json.load(sys.stdin); print('  ✓ Backend v'+d['version']+' healthy' if d.get('status')=='ok' else '  ✕ Unhealthy')"
fi
echo ""
