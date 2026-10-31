#!/usr/bin/env bash
# Test curl commands for local server (port 3000).
# Usage:
#   With subscription auth:  ./scripts/curl-test-local.sh
#   With admin bypass:       ADMIN_AUTH_BYPASS_CODE=your_code ./scripts/curl-test-local.sh
# Or source .env first:      set -a && source .env && set +a && ./scripts/curl-test-local.sh
#
# Standalone copy-paste examples (replace YOUR_BYPASS and WALLET if needed):
#   curl -s -w "\n%{http_code}\n" http://localhost:3000/health
#   curl -s -w "\n%{http_code}\n" -X POST http://localhost:3000/api/distributions/pdf \
#     -H "Content-Type: application/json" -H "x-wallet: WALLET" -H "x-service: Distribution Report" \
#     -H "x-year: 2025" -H "X-Auth-Bypass: YOUR_BYPASS" \
#     -d '{"wallet":"WALLET","includeStaked":false}' -o report.pdf
#   curl -s -X POST http://localhost:3000/api/distributions/pdf -H "Content-Type: application/json" \
#     -H "x-wallet: WALLET" -H "x-service: Distribution Report" -H "x-year: 2025" \
#     -d '{"wallet":"WALLET"}'   # missing x-year → 400

BASE="http://localhost:3000"
BYPASS="${ADMIN_AUTH_BYPASS_CODE:-}"
WALLET="${TEST_WALLET:-SBB-pCi_TZatV-ucWo_FVYZX_fsXwPms5WXZIKxsiuc}"
YEAR="${TEST_YEAR:-2025}"
# When BYPASS is set, add -H "X-Auth-Bypass: $BYPASS" to auth requests (e.g. export from .env)
BYPASS_HDR=""
[[ -n "$BYPASS" ]] && BYPASS_HDR="-H X-Auth-Bypass: $BYPASS"

echo "=== 1. Health check (no auth) ==="
curl -s -o /dev/null -w "%{http_code}" "$BASE/health" && echo " OK" || echo " fail"

echo ""
echo "=== 2. Distribution PDF (requires x-year; date range from year, not body) ==="
curl -s -w "\nHTTP %{http_code}\n" -X POST "$BASE/api/distributions/pdf" \
  -H "Content-Type: application/json" \
  -H "x-wallet: $WALLET" \
  -H "x-service: Distribution Report" \
  -H "x-year: $YEAR" \
  $BYPASS_HDR \
  -d "{\"wallet\": \"$WALLET\", \"includeStaked\": false, \"currency\": \"USD\"}" \
  -o /tmp/distribution-test.pdf

echo ""
echo "=== 3. Distribution CSV (same: x-year required, no startDate/endDate) ==="
curl -s -w "\nHTTP %{http_code}\n" -X POST "$BASE/api/distributions/csv" \
  -H "Content-Type: application/json" \
  -H "x-wallet: $WALLET" \
  -H "x-service: Distribution Report" \
  -H "x-year: $YEAR" \
  $BYPASS_HDR \
  -d "{\"wallet\": \"$WALLET\", \"includeStaked\": false}" \
  -o /tmp/distribution-test.csv

echo ""
echo "=== 4. GET distributions for wallet (date range from x-year only) ==="
curl -s -w "\nHTTP %{http_code}\n" -X GET "$BASE/api/distributions/$WALLET" \
  -H "x-wallet: $WALLET" \
  -H "x-service: Distribution Report" \
  -H "x-year: $YEAR" \
  $BYPASS_HDR | head -c 500
echo "..."

echo ""
echo "=== 5. Missing x-year (should 400) ==="
curl -s -w "\nHTTP %{http_code}\n" -X POST "$BASE/api/distributions/pdf" \
  -H "Content-Type: application/json" \
  -H "x-wallet: $WALLET" \
  -H "x-service: Distribution Report" \
  -d "{\"wallet\": \"$WALLET\"}"

echo ""
echo "=== 6. Full tax report PDF (taxYear in body; x-year required for auth) ==="
curl -s -w "\nHTTP %{http_code}\n" -X POST "$BASE/api/wallet-report/pdf" \
  -H "Content-Type: application/json" \
  -H "x-wallet: $WALLET" \
  -H "x-service: Full Tax Report" \
  -H "x-year: $YEAR" \
  $BYPASS_HDR \
  -d "{\"wallet\": \"$WALLET\", \"taxYear\": $YEAR, \"currency\": \"USD\"}" \
  -o /tmp/full-tax-test.pdf

echo ""
echo "=== 7. Subscriptions (no auth) ==="
curl -s -w "\nHTTP %{http_code}\n" "$BASE/api/subscriptions/$WALLET" | head -c 400
echo "..."
