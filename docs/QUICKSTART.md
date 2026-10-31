# Quick Start Guide

## Prerequisites

- Node.js 18+ recommended
- Yarn (or npm)
- Cassandra 4.x running locally or remotely

## Installation

```bash
git clone https://github.com/Bobinstein/ao-tax-tracker-server-public.git
cd ao-tax-tracker-server-public

yarn install

cp env.example .env
# Set at least ADMIN_AUTH_BYPASS_CODE for local ops testing
```

## First Run

```bash
yarn start
```

You should see the server listening on `http://localhost:3000`. Cassandra keyspaces/tables are created on startup.

## Test the API

### 1. Health Check (no auth)

```bash
curl http://localhost:3000/health
```

### 2. Distribution PDF (auth required)

Protected routes need wallet/service/year headers, plus a subscription **or** admin bypass.

```bash
# Replace YOUR_BYPASS and WALLET
curl -X POST http://localhost:3000/api/distributions/pdf \
  -H "Content-Type: application/json" \
  -H "X-Wallet: WALLET" \
  -H "X-Service: Distribution Report" \
  -H "X-Year: 2025" \
  -H "X-Auth-Bypass: YOUR_BYPASS" \
  -d '{"wallet":"WALLET","includeStaked":false,"currency":"USD"}' \
  --output report.pdf
```

**Note:** The report date range is derived from `X-Year` (not from body `startDate`/`endDate`).

More examples: [scripts/CURL-TEST-COMMANDS.md](../scripts/CURL-TEST-COMMANDS.md).

### 3. Trigger Data Updates

Job endpoints are also authorized. With admin bypass, still send `X-Year` when the route uses `isAuthorized`:

```bash
curl -X POST http://localhost:3000/api/jobs/update-all \
  -H "X-Auth-Bypass: YOUR_BYPASS" \
  -H "X-Year: 2025" \
  -H "X-Wallet: WALLET" \
  -H "X-Service: Distribution Report"
```

Or run indexers from the CLI (no HTTP auth):

```bash
yarn update-distributions
yarn update-prices
yarn update-all
```

First `update-distributions` downloads AO/PI CSVs from Arweave into `data/` (gitignored).

## Common Issues

### Port 3000 in use

```bash
PORT=4000 yarn start
```

### Cannot connect to Cassandra

```bash
cqlsh -e "DESCRIBE KEYSPACES"
```

Ensure Cassandra is reachable at the host in `config/database.js` / env overrides.

### 401 / 403 / Missing year

Most API routes require `X-Wallet`, `X-Service`, and `X-Year`, or a matching `X-Auth-Bypass` (bypass still requires `X-Year` on `isAuthorized` routes).

### No distribution data

```bash
yarn update-all
```

## Development Mode

```bash
yarn dev
```

## Production

See [DEPLOYMENT.md](DEPLOYMENT.md) and [HETZNER_DEPLOYMENT_GUIDE.md](HETZNER_DEPLOYMENT_GUIDE.md). Prefer the built-in cron scheduler over external crontab unless you have a specific reason to run jobs out-of-process.

## Next Steps

- [README.md](../README.md) — API overview
- [scripts/CURL-TEST-COMMANDS.md](../scripts/CURL-TEST-COMMANDS.md) — curl recipes
- [CRON_INFO.md](CRON_INFO.md) — built-in scheduler
- Configure Stripe / `MESSAGE_KEY_FILE` only if you need paid checkout flows
