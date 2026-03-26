#!/bin/bash
# Smoke test for 7Ei backend on Fly.io
# Usage: ./smoke-test.sh [BASE_URL]

BASE=${1:-https://7ei-backend.fly.dev}
PASS=0
FAIL=0

check() {
  local desc="$1" url="$2" expected="$3" method="${4:-GET}" body="$5"
  local args=(-s -o /tmp/smoke-resp -w "%{http_code}" -X "$method")
  [ -n "$body" ] && args+=(-H "Content-Type: application/json" -d "$body")
  local status=$(curl "${args[@]}" "$url")
  local resp=$(cat /tmp/smoke-resp 2>/dev/null)
  if [ "$status" = "$expected" ]; then
    echo "✅ $desc (HTTP $status)"
    PASS=$((PASS+1))
  else
    echo "❌ $desc — expected $expected, got $status"
    echo "   Response: $(echo "$resp" | head -c 200)"
    FAIL=$((FAIL+1))
  fi
}

echo "🔍 Smoke testing $BASE"
echo ""

check "Health endpoint" "$BASE/health" "200"
check "API health endpoint" "$BASE/api/health" "200"
check "Ready endpoint" "$BASE/ready" "200"
check "Create org" "$BASE/api/orgs" "201" "POST" '{"name":"Smoke Test Org","mission":"Testing"}'
check "List orgs" "$BASE/api/orgs" "200"
check "Agent templates" "$BASE/api/agent-templates" "200"
check "Skills list" "$BASE/api/skills" "200"
check "Cron presets" "$BASE/api/scheduled/presets" "200"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
