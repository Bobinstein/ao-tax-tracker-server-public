# Quick Start Guide

## Prerequisites

- Node.js (v14 or higher)
- Yarn package manager
- Cassandra database (local or remote)
- Existing keyspaces: `ao_price_data`, `ao_distributions`, `pi_distributions`

## Installation

```bash
# 1. Navigate to the project directory
cd ao-tax-tracker-server

# 2. Install dependencies
yarn install

# 3. (Optional) Copy env.example and configure
cp env.example .env
# Edit .env with your custom settings
```

## First Run

```bash
# Start the server
yarn start
```

You should see:

```
🚀 AO Tax Tracker Server Server
📡 Listening on http://localhost:3000
🏥 Health check: http://localhost:3000/health
📚 API info: http://localhost:3000/
```

## Test the API

### 1. Health Check

```bash
curl http://localhost:3000/health
```

Expected response:

```json
{
  "status": "ok",
  "timestamp": "2025-10-08T12:00:00.000Z",
  "uptime": 5.123
}
```

### 2. Get API Info

```bash
curl http://localhost:3000/
```

### 3. Generate a PDF Report

```bash
# Basic PDF with liquid distributions only
curl -X POST http://localhost:3000/api/distributions/pdf \
  -H "Content-Type: application/json" \
  -d '{
    "wallet": "SBB-pCi_TZatV-ucWo_FVYZX_fsXwPms5WXZIKxsiuc",
    "startDate": "2025-09-01",
    "endDate": "2025-10-08"
  }' \
  --output report.pdf

# PDF with staked ARIO distributions included
curl -X POST http://localhost:3000/api/distributions/pdf \
  -H "Content-Type: application/json" \
  -d '{
    "wallet": "SBB-pCi_TZatV-ucWo_FVYZX_fsXwPms5WXZIKxsiuc",
    "startDate": "2025-09-01",
    "endDate": "2025-10-08",
    "includeStaked": true
  }' \
  --output report-with-staked.pdf
```

**PDF Features:**

- Combined AO, PI, and ARIO distributions
- USD valuations with forward-fill pricing
- Data integrity notes for corrupted epochs (13, 14, 15)
- Optional staked ARIO inclusion

### 4. Get Distribution Data

```bash
curl "http://localhost:3000/api/distributions/SBB-pCi_TZatV-ucWo_FVYZX_fsXwPms5WXZIKxsiuc?startDate=2025-09-01&endDate=2025-10-08"
```

### 5. Get Price Data

```bash
# Get all AO prices
curl "http://localhost:3000/api/prices/AO"

# Get AO prices for a date range
curl "http://localhost:3000/api/prices/AO?startDate=2025-10-01&endDate=2025-10-08"

# Get PI price for a specific date
curl "http://localhost:3000/api/prices/PI/2025-10-08"
```

### 6. Trigger Data Updates

```bash
# Update distributions
curl -X POST http://localhost:3000/api/jobs/update-distributions

# Update prices
curl -X POST http://localhost:3000/api/jobs/update-prices

# Update everything
curl -X POST http://localhost:3000/api/jobs/update-all
```

## Common Issues

### Server won't start

**Issue:** Port 3000 already in use

**Solution:** Set a different port

```bash
PORT=4000 yarn start
```

### Cannot connect to Cassandra

**Issue:** Connection refused or timeout

**Solution:** Check that Cassandra is running

```bash
cqlsh -e "DESCRIBE KEYSPACES"
```

Verify keyspaces exist:

- `ao_price_data`
- `ao_distributions`
- `pi_distributions`

### No data returned

**Issue:** Empty results from API

**Solution:** Run the update jobs first

```bash
yarn update-all
```

This will:

1. Index AO distributions
2. Index PI distributions
3. Fetch CoinGecko prices
4. Fetch Permaswap prices

## Development Mode

For development with auto-reload on file changes:

```bash
yarn dev
```

## Production Deployment

```bash
# Install production dependencies only
yarn install --production

# Start server (consider using PM2 or systemd)
yarn start
```

### Using PM2

```bash
# Install PM2 globally
npm install -g pm2

# Start the server with PM2
pm2 start server.js --name ao-tax-tracker-server

# View logs
pm2 logs ao-tax-tracker-server

# Restart
pm2 restart ao-tax-tracker-server

# Stop
pm2 stop ao-tax-tracker-server
```

### Setup Cron Jobs

Add to your crontab (`crontab -e`):

```cron
# Update all data daily at 2 AM
0 2 * * * cd /path/to/ao-tax-tracker-server && /usr/bin/yarn update-all >> /var/log/ao-tax-tracker-server.log 2>&1
```

## Next Steps

- Read the full [README.md](README.md) for detailed API documentation
- Implement custom authorization in `src/utils/auth.js`
- Configure environment variables for your deployment
- Set up monitoring and logging
- Add reverse proxy (nginx/Apache) for production

## Support

For issues or questions, refer to the main documentation or check the code comments in:

- `server.js` - Main API endpoints
- `src/services/wallet_distribution_pdf_generator.js` - PDF generation
- `src/fetchers/` - Price data fetching
- `src/indexers/` - Distribution indexing
