# Curl commands for local server (port 3000)

Replace `YOUR_BYPASS` with `ADMIN_AUTH_BYPASS_CODE` from `.env` if using bypass; replace `WALLET` with a wallet address. Distribution/Full Tax require **x-year** (no default); date range is derived from that year.

## Health (no auth)

```bash
curl -s -w "\n%{http_code}\n" http://localhost:3000/health
```

## Distribution PDF (x-year required; no startDate/endDate in body)

```bash
curl -s -w "\n%{http_code}\n" -X POST http://localhost:3000/api/distributions/pdf \
  -H "Content-Type: application/json" \
  -H "x-wallet: WALLET" \
  -H "x-service: Distribution Report" \
  -H "x-year: 2025" \
  -H "X-Auth-Bypass: YOUR_BYPASS" \
  -d '{"wallet":"WALLET","includeStaked":false,"currency":"USD"}' \
  -o distribution.pdf
```

## Distribution CSV

```bash
curl -s -w "\n%{http_code}\n" -X POST http://localhost:3000/api/distributions/csv \
  -H "Content-Type: application/json" \
  -H "x-wallet: WALLET" \
  -H "x-service: Distribution Report" \
  -H "x-year: 2025" \
  -H "X-Auth-Bypass: YOUR_BYPASS" \
  -d '{"wallet":"WALLET","includeStaked":false}' \
  -o distribution.csv
```

## GET distributions (date range from x-year only; query params ignored)

```bash
curl -s -w "\n%{http_code}\n" "http://localhost:3000/api/distributions/WALLET" \
  -H "x-wallet: WALLET" \
  -H "x-service: Distribution Report" \
  -H "x-year: 2025" \
  -H "X-Auth-Bypass: YOUR_BYPASS"
```

## Missing x-year → 400

```bash
curl -s -w "\n%{http_code}\n" -X POST http://localhost:3000/api/distributions/pdf \
  -H "Content-Type: application/json" \
  -H "x-wallet: WALLET" \
  -H "x-service: Distribution Report" \
  -d '{"wallet":"WALLET"}'
# Expect: 400 + "Year is required (provide via query, body, or X-Year header)"
```

## Full tax report PDF (taxYear in body; x-year still required for auth)

```bash
curl -s -w "\n%{http_code}\n" -X POST http://localhost:3000/api/wallet-report/pdf \
  -H "Content-Type: application/json" \
  -H "x-wallet: WALLET" \
  -H "x-service: Full Tax Report" \
  -H "x-year: 2025" \
  -H "X-Auth-Bypass: YOUR_BYPASS" \
  -d '{"wallet":"WALLET","taxYear":2025,"currency":"USD"}' \
  -o full-tax.pdf
```

## Subscriptions (no auth)

```bash
curl -s -w "\n%{http_code}\n" "http://localhost:3000/api/subscriptions/WALLET"
```

## Run all tests (script)

```bash
# With bypass from .env
set -a && source .env && set +a && ./scripts/curl-test-local.sh

# Or pass bypass inline
ADMIN_AUTH_BYPASS_CODE=your_code ./scripts/curl-test-local.sh
```
