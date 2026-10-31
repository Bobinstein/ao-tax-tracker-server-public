# Deployment Guide

## ✅ Complete Database Recreation from Fresh VPS

Yes! You can clone this repo into a fresh VPS with Cassandra installed, run the indexers, and it will **completely recreate your database** including all distribution and price data.

## Prerequisites

- Ubuntu/Debian VPS (or similar)
- Cassandra 4.x installed and running
- Node.js 14+ installed
- Yarn package manager
- Git

## Step-by-Step Deployment

### 1. Install Cassandra

```bash
# Add Cassandra repository
echo "deb https://debian.cassandra.apache.org 40x main" | sudo tee /etc/apt/sources.list.d/cassandra.sources.list
curl https://downloads.apache.org/cassandra/KEYS | sudo apt-key add -

# Install Cassandra
sudo apt update
sudo apt install cassandra

# Start Cassandra
sudo systemctl start cassandra
sudo systemctl enable cassandra

# Verify it's running
sudo systemctl status cassandra
cqlsh -e "DESCRIBE KEYSPACES"
```

### 2. Install Node.js and Yarn

```bash
# Install Node.js 18.x
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Install Yarn
npm install -g yarn

# Verify installations
node --version
yarn --version
```

### 3. Clone the Repository

```bash
cd /opt  # or wherever you want to deploy
git clone https://github.com/Bobinstein/ao-tax-tracker-server-public.git ao-tax-tracker-server
cd ao-tax-tracker-server
```


### 4. Install Dependencies

```bash
yarn install
```

### 5. Create Cassandra Keyspaces

The server **automatically creates all keyspaces and tables on startup**. However, you can manually create keyspaces if needed:

```bash
# Core distribution keyspaces
cqlsh -e "CREATE KEYSPACE IF NOT EXISTS ao_distributions WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};"
cqlsh -e "CREATE KEYSPACE IF NOT EXISTS pi_distributions WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};"
cqlsh -e "CREATE KEYSPACE IF NOT EXISTS ao_price_data WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};"

# AR Tracker keyspace (for full wallet tax reports)
cqlsh -e "CREATE KEYSPACE IF NOT EXISTS ar_tax_tracker WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};"

# Subscription cache (for authorization)
cqlsh -e "CREATE KEYSPACE IF NOT EXISTS subscription_cache WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};"
```

**Note:** On server startup, the schema initialization runs automatically and creates all necessary tables.

### 6. Run Initial Data Load

This will populate your database with all distribution and price data:

```bash
# Option A: Run everything at once (recommended for first deployment)
yarn update-all

# Option B: Run step-by-step
yarn update-distributions  # Indexes AO & PI distributions from CSV files
yarn update-prices          # Fetches price data from CoinGecko & Permaswap
```

**Expected Time:**

- Distribution indexing: ~10-30 minutes (depends on CSV count)
- Price fetching: ~5-10 minutes

### 7. Verify Data

```bash
# Check AO distributions
cqlsh -e "SELECT COUNT(*) FROM ao_distributions.distributions;"

# Check PI distributions
cqlsh -e "SELECT COUNT(*) FROM pi_distributions.distributions;"

# Check price data
cqlsh -e "SELECT COUNT(*) FROM ao_price_data.daily_prices;"
```

### 8. Start the API Server

```bash
# Development mode (with auto-reload)
yarn dev

# Production mode
yarn start

# Or use PM2 for production
npm install -g pm2
pm2 start server.js --name ao-tax-tracker-server
pm2 save
pm2 startup  # Follow the instructions to enable auto-start on boot
```

### 9. Test the API

```bash
# Health check
curl http://localhost:3000/health

# Get API info
curl http://localhost:3000/

# Test price endpoint (requires authorization)
curl -H "X-Wallet: YOUR_WALLET" "http://localhost:3000/api/prices/AO?startDate=2025-10-01&endDate=2025-10-08"

# Test DEX price endpoint (public)
curl "http://localhost:3000/api/dex-prices/TOKEN_PROCESS_ID/2025-01-15"

# Test fiat conversion (public)
curl "http://localhost:3000/api/fiat-conversion/100/EUR/2025-01-15"

# Test job status
curl http://localhost:3000/api/status
```

## Automatic Updates (Built-in Cron)

**GOOD NEWS:** The API now includes **built-in cron scheduling**! 🎉

When you start the server, it automatically schedules:

| Schedule | Job | Description |
|----------|-----|-------------|
| Daily 1:00 AM UTC | Distribution & Price Update | AO/PI/ARIO distributions + price data |
| Hourly at :00 | DEX Price Indexer | Indexes new DEX swaps for token prices |
| Daily 2:00 AM UTC | Fiat Rate Indexer | Updates USD→fiat exchange rates |

- No external cron setup required - works as long as the server is running
- Updates run in the background without interrupting API requests

**What runs automatically:**

1. AO distribution indexer
2. PI distribution indexer
3. ARIO distribution indexer
4. CoinGecko price fetcher
5. Permaswap price scraper
6. DEX price indexer (hourly)
7. Fiat exchange rate indexer (daily)

## Manual Cron Setup (Optional)

While built-in cron is enabled by default, you can still set up system-level cron jobs if you prefer external scheduling or want backup jobs.

### Option 1: System Cron (Recommended)

```bash
# Edit crontab
crontab -e

# Add these lines (adjust paths as needed):

# Update all data daily at 2 AM
0 2 * * * cd /opt/ao-tax-tracker-server && /usr/bin/yarn update-all >> /var/log/ao-tax-tracker-server.log 2>&1

# Or separate jobs:
# Update distributions at 2 AM
0 2 * * * cd /opt/ao-tax-tracker-server && /usr/bin/yarn update-distributions >> /var/log/ao-distributions.log 2>&1

# Update prices at 3 AM
0 3 * * * cd /opt/ao-tax-tracker-server && /usr/bin/yarn update-prices >> /var/log/ao-prices.log 2>&1
```

### Option 2: PM2 Cron

```bash
# Install PM2 if not already installed
npm install -g pm2

# Schedule update-all job
pm2 start jobs/update-all.js --name ao-update-all --cron "0 2 * * *" --no-autorestart

# View scheduled jobs
pm2 list
```

### Option 3: API Trigger Endpoints

You can also trigger updates via API endpoints (useful for external schedulers):

```bash
# Trigger distribution update
curl -X POST http://localhost:3000/api/jobs/update-distributions

# Trigger price update
curl -X POST http://localhost:3000/api/jobs/update-prices

# Trigger full update
curl -X POST http://localhost:3000/api/jobs/update-all
```

**Note:** These endpoints return immediately and run jobs in the background.

## What Gets Recreated

When you run the initial data load, the following will be populated:

### ✅ Distribution Data

- **AO distributions**: All CSV files in `data/AO_csvs/` (~36 files)
- **PI distributions**: All CSV files in `data/PI_csvs/` (~602 files)
- **ARIO distributions**: Gateway reward distributions
- **Date range**: February 2025 - present
- **Total records**: Millions of distribution records

### ✅ Price Data

- **CoinGecko prices**: AO, ARIO (June 2025 - present)
- **Permaswap-AO prices**: Current pool reserve prices (August 2025 - present)
- **Permaswap-GQL prices**: Historical swap data (February 2025 - present)
- **DEX prices**: Indexed from Permaswap, Botega, Bazar UCM swaps
- **All tokens**: AO, PI, ARIO, AR, and DEX-traded tokens

### ✅ AR Tracker Data (for Full Wallet Tax Reports)

- **Keyspace**: `ar_tax_tracker`
- **Tables**: unified_transactions, tax_lots, disposals, holdings_summary, etc.
- **Features**: 
  - Full transaction history sync
  - Cost basis tracking (FIFO/LIFO/HIFO)
  - Capital gains/loss calculation
  - Multi-currency support (USD, EUR, GBP, etc.)
  - PDF and CSV report generation

### ✅ DEX Price Index

- **Keyspace**: `ao_price_data`
- **Tables**: dex_swaps, dex_token_prices, dex_indexer_state
- **Sources**: Permaswap, Botega, Bazar UCM
- **Records**: ~94,000+ historical token prices

### ✅ Fiat Exchange Rates

- **Keyspace**: `ao_price_data`
- **Tables**: fiat_exchange_rates, fiat_indexer_state
- **Currencies**: EUR, GBP, JPY, AUD, CAD, CHF, CNY, INR, KRW, BRL, MXN, SGD, HKD, NZD, SEK, NOK, DKK
- **Records**: ~48,000+ historical rates

### ✅ Data Integrity Features

- **Corrupted Epoch Detection**: Automatically detects and reports data loss for ARIO epochs 13, 14, 15
- **Smart Gap Detection**: Uses epoch 12 and 16 presence to infer corrupted epochs in between
- **PDF Footnotes**: Generates explanatory footnotes about data loss in distribution reports
- **Database Metadata**: Stores corrupted epoch information in `ario_distributions.epoch_metadata`

## Data Flow on Fresh Deployment

```
1. Clone repo (includes CSV files in data/)
   ↓
2. Run yarn update-distributions
   ↓
   - Reads CSV files from data/AO_csvs/ and data/PI_csvs/
   - Creates Cassandra tables if they don't exist
   - Parses and inserts all distribution records
   - Checks Arweave for any NEW CSVs since last update
   - Downloads and processes new CSVs (if any)
   ↓
3. Run yarn update-prices
   ↓
   - Fetches CoinGecko historical prices (AO, ARIO)
   - Fetches Permaswap current prices (AO, PI, ARIO)
   - Stores all price data in Cassandra
   ↓
4. Database is now fully populated!
```

## Incremental Updates (After Initial Load)

Once deployed, the cron jobs will:

1. **Check for new distribution CSVs** on Arweave
2. **Download and process** any new CSVs
3. **Fetch latest prices** from CoinGecko and Permaswap
4. **Store new data** in Cassandra

The indexers are smart enough to:

- Skip already-processed CSVs
- Only fetch new price data
- Handle duplicates gracefully (Cassandra primary keys)

## Production Recommendations

### 1. Reverse Proxy (Nginx)

```nginx
server {
    listen 80;
    server_name api.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### 2. SSL/HTTPS

```bash
# Install Certbot
sudo apt install certbot python3-certbot-nginx

# Get SSL certificate
sudo certbot --nginx -d api.yourdomain.com
```

### 3. Firewall

```bash
# Allow SSH, HTTP, HTTPS
sudo ufw allow ssh
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

### 4. Monitoring

```bash
# PM2 monitoring
pm2 monit

# View logs
pm2 logs ao-tax-tracker-server

# Cassandra monitoring
nodetool status
```

### 5. Backups

**Option A: Cassandra Snapshots (built-in)**

```bash
# Backup Cassandra data
nodetool snapshot ao_distributions
nodetool snapshot pi_distributions
nodetool snapshot ao_price_data
nodetool snapshot ar_tax_tracker

# Snapshots are stored in:
# /var/lib/cassandra/data/<keyspace>/<table>/snapshots/
```

**Option B: Parquet Export (portable, analyzable)**

```bash
# Full backup to Parquet files
node admin-utilities/backup-to-parquet.js

# Backup specific keyspace
node admin-utilities/backup-to-parquet.js --keyspace ar_tax_tracker

# Test with limited rows first
node admin-utilities/backup-to-parquet.js --limit 1000
```

Parquet exports are stored in `backups/YYYY-MM-DD_HHMMSS/` with a manifest file.

## Troubleshooting

### Issue: Cassandra connection refused

```bash
# Check if Cassandra is running
sudo systemctl status cassandra

# Check logs
sudo tail -f /var/log/cassandra/system.log

# Restart Cassandra
sudo systemctl restart cassandra
```

### Issue: Out of memory during indexing

```bash
# Increase Node.js memory limit
NODE_OPTIONS="--max-old-space-size=4096" yarn update-distributions
```

### Issue: CSV files not found

```bash
# Verify CSV files exist
ls -la data/AO_csvs/
ls -la data/PI_csvs/

# Check indexer paths
grep CSV_DIR src/indexers/*.js
```

### Issue: Cron jobs not running

```bash
# Check cron logs
grep CRON /var/log/syslog

# Verify crontab
crontab -l

# Test cron command manually
cd /opt/ao-tax-tracker-server && /usr/bin/yarn update-all
```

## Scaling Considerations

### For High Traffic

1. **Load Balancer**: Use multiple API instances behind nginx/HAProxy
2. **Cassandra Cluster**: Scale Cassandra horizontally with multiple nodes
3. **Caching**: Add Redis for frequently accessed data
4. **Rate Limiting**: Implement rate limiting in nginx or Express

### For Large Datasets

1. **Batch Size**: Adjust `batchSize` in indexer configs
2. **Connection Pools**: Tune Cassandra connection pool settings
3. **Pagination**: Use pagination for large API responses

## Environment Variables

Copy `env.example` and configure:

```bash
cp env.example .env
```

Important variables (see `env.example` for the full set):

```bash
PORT=3000
API_BASE_URL=http://localhost:3000

# Cassandra (optional overrides)
CASSANDRA_HOST=localhost
CASSANDRA_DATACENTER=datacenter1

# Optional API / payments
COINGECKO_API_KEY=your-coingecko-api-key
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Authorization
PAYMENT_PROCESS_ID=your-payment-process-id    # AO process for subscription checks
ADMIN_AUTH_BYPASS_CODE=your-strong-random-secret

# Message signing (for AO Manual-Subscribe / Stripe flow)
MESSAGE_KEY_FILE=./path/to/wallet.json
```

**Security Notes:**
- Never commit `.env` to version control
- Use a long, unique value for `ADMIN_AUTH_BYPASS_CODE` in any shared or production environment
- Keep `MESSAGE_KEY_FILE` and Stripe secrets offline and out of git

## AR Tracker: Full Wallet Tax Reports

The server includes a complete tax report system for Arweave/AO wallets.

### Features

- **Transaction Sync**: Fetches all wallet transactions from L1 Arweave and AO
- **DEX Support**: Tracks swaps on Permaswap, Botega, and Bazar UCM
- **Cost Basis**: Automatic FIFO/LIFO/HIFO calculation
- **Multi-Currency**: Convert reports to EUR, GBP, JPY, etc.
- **PDF Reports**: Comprehensive tax reports with executive summary
- **CSV Export**: Transaction lists, capital gains, income, Form 8949

### API Endpoints

```bash
# Sync wallet transactions
POST /api/wallet/sync
Body: { "wallet": "ADDRESS", "fullHistory": true }

# Generate PDF report
POST /api/wallet-report/pdf
Body: { "wallet": "ADDRESS", "taxYear": 2025, "currency": "USD" }

# Generate CSV report
POST /api/wallet-report/csv
Body: { "wallet": "ADDRESS", "taxYear": 2025, "reportType": "capital_gains" }

# Get DEX token price
GET /api/dex-prices/TOKEN_PROCESS_ID/2025-01-15

# Convert USD to fiat
GET /api/fiat-conversion/100/EUR/2025-01-15
```

### Initial DEX Index Population

For a fresh deployment, run the full DEX indexer to backfill historical prices:

```bash
# Via API
curl -X POST http://localhost:3000/api/jobs/dex-price-indexer -d '{"incremental": false}'

# Or wait for hourly cron to incrementally build the index
```

---

## Summary

### ✅ Yes, Complete Database Recreation

1. Clone repo → Contains all CSV files
2. Install dependencies → `yarn install`
3. Create keyspaces → CQL commands
4. Run indexers → `yarn update-all`
5. Start API → `yarn start` or PM2

**Result:** Fully populated database with all distribution and price data!

### ✅ Yes, Cron Jobs ARE Automatic!

The server includes **built-in cron scheduling**:

- ✅ Automatic daily updates at 1:00 AM UTC
- ✅ No external cron setup required
- ✅ Works as long as server is running
- ✅ Optional: Add system cron as backup

### ✅ Code Integrity Verified

All indexer and fetcher code is **identical** to the original, except:

- CSV paths updated to use `data/` directory
- All functionality preserved
- No logic changes

---

**Ready to Deploy!** 🚀

The repository is completely self-contained and production-ready. Just follow the steps above, and you'll have a fully functional API with complete historical data.
