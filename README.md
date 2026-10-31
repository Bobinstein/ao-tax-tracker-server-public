# AO Tax Tracker Server

HTTP API server for comprehensive tax tracking in the Arweave/AO ecosystem. Supports passive distribution income tracking (AO, PI, ARIO) and full wallet tax report generation with cost basis calculations.

## Features

### Distribution Tracking (Passive Income)
- 📊 **Distribution Tracking**: Index and query AO, PI, and ARIO token distributions
- 🔐 **ARIO Gateway State**: Track all gateway actions (testnet + mainnet) for accurate state reconstruction
- 💰 **Price Data**: Fetch and store historical prices from CoinGecko and Permaswap
- 📄 **PDF Generation**: Generate detailed distribution reports with USD valuations and data integrity notes
- ⚠️ **Data Loss Detection**: Automatically detect and report corrupted epochs (13, 14, 15) with explanatory footnotes

### AR Wallet Tax Reports (Full Transaction History)
- 📜 **Complete Wallet History**: Fetch and index all transactions (L1 AR, AO tokens, DEX swaps, distributions)
- 💵 **Cost Basis Calculation**: FIFO/LIFO/HIFO accounting methods for capital gains tracking
- 🔄 **DEX Price Indexing**: Index 3.5M+ swap transactions across Permaswap, Botega, and Bazar UCM
- 🌍 **Multi-Currency Support**: Convert USD values to 30+ fiat currencies at historical rates
- 📊 **Tax Lot Tracking**: Track acquisition lots, disposals, and holding periods
- 📄 **Tax Report Generation**: Generate comprehensive PDF/CSV tax reports

### Common Features
- 🔄 **Auto-updating**: Built-in cron scheduler (daily at 1 AM UTC) + manual triggers
- 🔐 **Authorization Ready**: Built-in authorization middleware (configurable)
- 🗄️ **Auto Schema**: Database schema auto-initialized on server start

## Installation

```bash
git clone https://github.com/Bobinstein/ao-tax-tracker-server-public.git
cd ao-tax-tracker-server-public

# Install dependencies
yarn install
# Or: npm install

# Configure environment (optional but recommended)
cp env.example .env
```

Requires a running Cassandra instance (default `localhost`). Schema/keyspaces are created automatically on server start.

## Configuration

Copy `env.example` → `.env`. Common variables:

| Variable | Purpose |
| -------- | ------- |
| `PORT` | HTTP port (default `3000`) |
| `API_BASE_URL` | Base URL for admin scripts / remote calls |
| `COINGECKO_API_KEY` | Optional; better rate limits for prices |
| `ADMIN_AUTH_BYPASS_CODE` | Ops bypass for `X-Auth-Bypass` (use a strong secret) |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Optional Stripe payments |
| `MESSAGE_KEY_FILE` | Optional Arweave/AO signing wallet (path or JSON) |
| `PAYMENT_PROCESS_ID` | Optional AO payment process override |

Database defaults live in `config/database.js` (Cassandra host: `localhost`).

**Keyspaces:**

| Keyspace             | Purpose                                                |
| -------------------- | ------------------------------------------------------ |
| `ao_price_data`      | Token prices, DEX swaps, DEX token prices, fiat rates  |
| `ao_distributions`   | AO token distributions                                 |
| `pi_distributions`   | PI token distributions                                 |
| `ario_distributions` | ARIO distributions + gateway actions                   |
| `ar_tax_tracker`     | Unified transactions, tax lots, disposals, reports     |
| `subscription_cache` | Paid-subscription authorization cache                  |

## CSV Data

AO/PI distribution CSVs are **downloaded at runtime** into `data/AO_csvs/` and `data/PI_csvs/` (gitignored). They are not shipped in the public repo.

See [data/README.md](data/README.md) for layout and bootstrap notes.

## Usage

### Start the Server

```bash
# Production
yarn start

# Development (with auto-reload)
yarn dev
```

Server runs on `http://localhost:3000` by default. Set `PORT` environment variable to change.

**Built-in Automation:**

- The server includes an internal cron scheduler:
  - **Daily at 1:00 AM UTC**: AO/PI distribution indexing, ARIO gateway actions, price updates
  - **Hourly at :00**: DEX price indexer (incremental)
  - **Daily at 2:00 AM UTC**: Fiat rate indexer
- No external cron setup required - the updates run as long as the server is running
- Manual triggers are still available via API endpoints if needed

**Auto Schema Initialization:**

- On server start, all required database tables are automatically created if they don't exist
- No manual schema setup required for new deployments

**ARIO gateway indexing:**

The mainnet gateway indexer runs on the built-in daily schedule. For a backfill or manual range:

```bash
node src/indexers/ario_gateway_mainnet_indexer.js 2025-10-01 2025-10-09
```

See [docs/ARIO_GATEWAY_INTEGRATION.md](docs/ARIO_GATEWAY_INTEGRATION.md) and [GATEWAY_SNAPSHOT_README.md](GATEWAY_SNAPSHOT_README.md) for snapshot import options.

### Manual Data Updates

```bash
# Update distributions only
yarn update-distributions

# Update prices only
yarn update-prices

# Update everything
yarn update-all
```

## API Endpoints

### Health & Info

#### `GET /health`

Health check endpoint

**Response:**

```json
{
  "status": "ok",
  "timestamp": "2025-10-08T12:00:00.000Z",
  "uptime": 123.45
}
```

#### `GET /`

API information and available endpoints

### Distributions

#### `POST /api/distributions/pdf`

Generate PDF report for wallet distributions. **Date range is derived from `X-Year`** (client `startDate`/`endDate` are ignored).

**Headers (required):** `X-Wallet`, `X-Service: Distribution Report`, `X-Year` — plus a valid subscription **or** `X-Auth-Bypass`.

**Request Body:**

```json
{
  "wallet": "7waR8v4STuwwcWw3l75CeAjeGHOwYb_p6vXL9K-WoKU",
  "includeStaked": false,
  "currency": "USD"
}
```

**Parameters:**

- `wallet` (required): Wallet address
- `includeStaked` (optional): Include staked ARIO distributions (default: false)
- `currency` (optional): Fiat currency for valuations (default: USD)

**Response:** PDF file download

**Features:**

- Combined AO, PI, and ARIO distributions
- USD (or other fiat) valuations with forward-fill pricing
- Transaction details and totals
- Data integrity notes for corrupted epochs (13, 14, 15)
- Optional staked ARIO inclusion

Ready-to-run examples: [scripts/CURL-TEST-COMMANDS.md](scripts/CURL-TEST-COMMANDS.md).

#### `GET /api/distributions/:wallet`

Get distribution data for a wallet. Date range comes from `X-Year` (query date params ignored).

**Example:**

```
GET /api/distributions/7waR8v4STuwwcWw3l75CeAjeGHOwYb_p6vXL9K-WoKU
Headers: X-Wallet, X-Service: Distribution Report, X-Year: 2025
```

**Response:**

```json
{
  "wallet": "7waR8v4STuwwcWw3l75CeAjeGHOwYb_p6vXL9K-WoKU",
  "startDate": "2025-01-01",
  "endDate": "2025-10-08",
  "distributions": {
    "ao": [...],
    "pi": [...]
  },
  "counts": {
    "ao": 42,
    "pi": 67,
    "total": 109
  }
}
```

### Prices

#### `GET /api/prices/:token`

Get price data for a token

**Path Parameters:**

- `token`: Token symbol (AO, PI, or ARIO)

**Query Parameters (optional):**

- `startDate`: Filter by start date (YYYY-MM-DD)
- `endDate`: Filter by end date (YYYY-MM-DD)
- `source`: Filter by data source (coingecko, permaswap-AO, permaswap-GQL)

**Example:**

```
GET /api/prices/AO?startDate=2025-01-01&endDate=2025-10-08&source=coingecko
```

**Response:**

```json
{
  "token": "AO",
  "count": 130,
  "prices": [
    {
      "date": "2025-10-08",
      "price_usd": 6.476829,
      "source": "permaswap-GQL",
      "market_cap_usd": null,
      "total_volume_usd": null
    }
  ]
}
```

#### `GET /api/prices/:token/:date`

Get price for a specific token and date

**Path Parameters:**

- `token`: Token symbol (AO, PI, or ARIO)
- `date`: Date (YYYY-MM-DD)

**Query Parameters (optional):**

- `source`: Filter by data source

**Example:**

```
GET /api/prices/PI/2025-10-08
```

**Response:**

```json
{
  "token": "PI",
  "date": "2025-10-08",
  "prices": [
    {
      "price_usd": 0.292525,
      "source": "permaswap-GQL",
      "market_cap_usd": null,
      "total_volume_usd": null
    }
  ]
}
```

### Background Jobs

All job endpoints return immediately and run in the background.

#### `POST /api/jobs/update-distributions`

Trigger distribution indexing update

**Response:**

```json
{
  "message": "Distribution update job started",
  "status": "running",
  "timestamp": "2025-10-08T12:00:00.000Z"
}
```

#### `POST /api/jobs/update-prices`

Trigger price data update

**Response:**

```json
{
  "message": "Price update job started",
  "status": "running",
  "timestamp": "2025-10-08T12:00:00.000Z"
}
```

#### `POST /api/jobs/update-all`

Trigger full update (distributions + ARIO gateway + prices)

**Response:**

```json
{
  "message": "Full update job started",
  "status": "running",
  "timestamp": "2025-10-08T12:00:00.000Z"
}
```

#### `POST /api/jobs/index-ario-testnet`

Trigger ARIO gateway testnet indexer (one-time use for historical data)

**Response:**

```json
{
  "message": "ARIO gateway testnet indexer started",
  "status": "running",
  "note": "This is a one-time job for historical testnet data",
  "timestamp": "2025-10-08T12:00:00.000Z"
}
```

**Note:** This endpoint indexes all gateway actions from the AR.IO testnet (June 2024 - Feb 2025). It only needs to be run once during initial setup. The mainnet indexer runs automatically daily.

#### `POST /api/jobs/dex-price-indexer`

Trigger DEX price indexer to index swap transactions

**Request Body:**

```json
{
  "incremental": true
}
```

**Parameters:**

- `incremental` (optional): If true, only indexes new swaps since last run. If false, runs full historical index (default: true)

**Response:**

```json
{
  "message": "DEX price indexer started (incremental mode)",
  "status": "running",
  "timestamp": "2025-10-08T12:00:00.000Z"
}
```

#### `POST /api/jobs/fiat-rate-indexer`

Trigger fiat exchange rate indexer

**Request Body:**

```json
{
  "incremental": true
}
```

**Parameters:**

- `incremental` (optional): If true, only indexes new rates since last run. If false, runs full historical index (default: true)

**Response:**

```json
{
  "message": "Fiat rate indexer started",
  "status": "running",
  "timestamp": "2025-10-08T12:00:00.000Z"
}
```

### AR Wallet Tax Reports

#### `POST /api/wallet/sync`

Sync wallet transactions from all sources (L1, AO tokens, DEX swaps, distributions)

**Request Body:**

```json
{
  "wallet": "cF0H0SKdJGBhvqwGNZxEDg-g8QXjNkOmSBeT8HpFHe0",
  "fullHistory": false
}
```

**Parameters:**

- `wallet` (required): Wallet address to sync
- `fullHistory` (optional): If true, re-fetches all history. If false, incremental sync (default: false)

**Response:**

```json
{
  "status": "started",
  "message": "Wallet sync started",
  "wallet": "cF0H0SKdJGBhvqwGNZxEDg-g8QXjNkOmSBeT8HpFHe0"
}
```

#### `GET /api/wallet/transactions/:wallet`

Get cached transactions for a wallet

**Query Parameters:**

- `taxYear` (optional): Filter by tax year
- `type` (optional): Filter by transaction type (DEX_SWAP, TRANSFER, etc.)

**Response:**

```json
{
  "wallet": "cF0H0SKdJGBhvqwGNZxEDg-g8QXjNkOmSBeT8HpFHe0",
  "transactions": [...],
  "count": 1500
}
```

#### `POST /api/wallet-report/pdf`

Generate comprehensive tax report PDF

**Request Body:**

```json
{
  "wallet": "cF0H0SKdJGBhvqwGNZxEDg-g8QXjNkOmSBeT8HpFHe0",
  "taxYear": 2025,
  "accountingMethod": "FIFO",
  "currency": "USD"
}
```

**Parameters:**

- `wallet` (required): Wallet address
- `taxYear` (required): Tax year (e.g., 2025)
- `accountingMethod` (optional): FIFO, LIFO, or HIFO (default: FIFO)
- `currency` (optional): Output currency (default: USD)

**Response:** PDF file download

#### `POST /api/wallet-report/csv`

Generate CSV tax reports

**Request Body:**

```json
{
  "wallet": "cF0H0SKdJGBhvqwGNZxEDg-g8QXjNkOmSBeT8HpFHe0",
  "taxYear": 2025,
  "reportType": "all",
  "currency": "USD"
}
```

**Parameters:**

- `wallet` (required): Wallet address
- `taxYear` (required): Tax year (e.g., 2025)
- `reportType` (optional): Type of report to generate
  - `transactions` - All taxable transactions
  - `capital_gains` - Capital gains/losses report
  - `income` - Income events (distributions, airdrops)
  - `form8949` - IRS Form 8949 format
  - `all` - Generate all reports (returns JSON summary)
- `currency` (optional): Output currency (default: USD)

**Response:**

- Single report type: CSV file download
- `all` report type: JSON with summaries for each report

#### `GET /api/wallet-report/summary/:wallet/:taxYear`

Get tax report summary JSON

**Response:**

```json
{
  "wallet": "cF0H0SKdJGBhvqwGNZxEDg-g8QXjNkOmSBeT8HpFHe0",
  "taxYear": 2025,
  "totalIncome": 5432.10,
  "totalCapitalGains": 1234.56,
  "totalCapitalLosses": 234.56,
  "netGainLoss": 1000.00,
  "transactionCount": 1500
}
```

### DEX Prices

#### `GET /api/dex-prices/:token`

Get current DEX price for a token

**Path Parameters:**

- `token`: Token process ID

**Response:**

```json
{
  "token": "xU9zFkq3X2ZQ6olwNVvr1vUWIjc3kXTWr7xKQD6dh10",
  "date": "2025-10-08",
  "priceUSD": 6.47,
  "source": "dex_index"
}
```

#### `GET /api/dex-prices/:token/:date`

Get historical DEX price for a token

**Path Parameters:**

- `token`: Token process ID
- `date`: Date (YYYY-MM-DD)

### Fiat Conversion

#### `GET /api/fiat-conversion/:amount/:currency/:date`

Convert USD to another fiat currency at historical rate

**Path Parameters:**

- `amount`: USD amount to convert
- `currency`: Target currency code (EUR, GBP, JPY, etc.)
- `date` (optional): Date for historical rate (defaults to today)

**Example:**

```
GET /api/fiat-conversion/100/EUR/2025-06-15
```

**Response:**

```json
{
  "usdAmount": 100,
  "currency": "EUR",
  "date": "2025-06-15",
  "convertedAmount": 86.87,
  "exchangeRate": 0.8687
}
```

## ARIO Gateway State Tracking

The server includes indexers for tracking all gateway-related actions from both AR.IO testnet and mainnet:

### Database

- **Keyspace:** `ario_gateway_history`
- **Table:** `gateway_actions`
- **Actions Tracked:**
  - Join-Network
  - Update-Gateway-Settings (including `autoStake` changes)
  - Leave-Network
  - Increase/Decrease-Operator-Stake
  - Delegate/Undelegate-Stake

### Usage

**Daily updates (automatic):** the mainnet gateway indexer runs with the built-in daily job (1 AM UTC).

**Manual mainnet update:**

```bash
node src/indexers/ario_gateway_mainnet_indexer.js 2025-10-01 2025-10-09
```

### State Reconstruction

The indexed data allows reconstruction of any gateway's state (including `autoStake` setting) at any point in time. This is crucial for accurate ARIO distribution calculations, as gateway rewards are only auto-staked when the gateway's `autoStake` setting is `true`.

## Data Integrity & Corrupted Epochs

The system automatically detects and reports data loss for specific ARIO epochs that were corrupted during the testnet-to-mainnet migration.

### Corrupted Epochs (13, 14, 15)

During the AR.IO network's transition from testnet to mainnet in March 2025, epochs 13, 14, and 15 experienced data corruption. The system handles this gracefully:

**Detection Logic:**

- Checks if a wallet has distributions for both epoch 12 and epoch 16
- If both exist, infers that corrupted epochs 13-15 are present in between
- No actual data exists for these epochs due to corruption

**PDF Reporting:**

- **Summary Section**: Shows "Total ARIO (Liquid)\*" with asterisk when gap detected
- **Footnote**: Displays "\* The data for epochs 13, 14, 15 is lost to time, completely unrecoverable. An unfortunate and ironic quirk of technology as new as AO. These epochs were corrupted during the testnet-to-mainnet migration and no distribution data exists."

**Database Storage:**

- Corrupted epoch metadata stored in `ario_distributions.epoch_metadata` table
- Status: `corrupted`
- Note: Full explanation of data loss

This ensures users are informed about data gaps while maintaining accurate reporting for all other epochs.

## Authorization

Protected routes use `isAuthorized` in `src/utils/auth.js`. Callers must provide:

| Header | Purpose |
| ------ | ------- |
| `X-Wallet` | Wallet being authorized |
| `X-Service` | e.g. `Distribution Report` or `Full Tax Report` |
| `X-Year` | Tax/subscription year (required; drives distribution date range) |
| `X-Auth-Bypass` | Optional; must match `ADMIN_AUTH_BYPASS_CODE` to skip subscription checks |

Without bypass, authorization checks the AO payment process / Cassandra `subscription_cache` for an active subscription matching wallet + service + year. Full Tax Report subscriptions also authorize Distribution Report for that year.

Admin-only routes use `isAdmin` (bypass code only). Prefer a strong random bypass in any non-local environment; never commit real values.

See [scripts/CURL-TEST-COMMANDS.md](scripts/CURL-TEST-COMMANDS.md) for full examples.

## Price Data Sources

The API supports multiple price data sources with automatic prioritization:

1. **coingecko**: CoinGecko API (AO, ARIO only)
2. **permaswap-AO**: Direct from AO pool reserves (current prices)
3. **permaswap-GQL**: Historical swap transactions via Arweave GraphQL

### Price Forward-Fill

If no price exists for a specific date, the API automatically uses the most recent prior price (forward-fill logic).

## Project Structure

```
ao-tax-tracker-server/
├── config/                      # Cassandra + AR Tracker constants
├── data/                        # Runtime CSV dirs (gitignored) + gateway snapshot
├── src/
│   ├── indexers/                # AO/PI/ARIO/PIXL/DEX indexers
│   ├── fetchers/                # Price fetchers + ar-tracker fetchers
│   ├── services/                # PDF/CSV, Stripe, AR Tracker tax services
│   ├── models/ar-tracker/       # Transaction / lot models
│   ├── middleware/              # Honeypot / scanner traps
│   └── utils/auth.js            # Subscription + admin bypass middleware
├── admin-utilities/             # Schema, backups, clears, diagnostics
├── jobs/                        # CLI update-distributions / prices / all
├── scripts/                     # Ops helpers + curl examples
├── docs/                        # Deployment and integration guides
├── env.example
├── server.js
└── package.json
```

## Development

```bash
# Install dependencies
yarn install

# Start development server with auto-reload
yarn dev

# Run manual updates
yarn update-all
```

## Production Deployment

1. Install dependencies: `yarn install --production`
2. Copy `env.example` → `.env` and set secrets (`ADMIN_AUTH_BYPASS_CODE`, Stripe, wallet, etc.)
3. Start server: `yarn start` (built-in cron handles daily/hourly jobs)
4. Optional: reverse proxy / systemd / PM2 — see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) and [docs/HETZNER_DEPLOYMENT_GUIDE.md](docs/HETZNER_DEPLOYMENT_GUIDE.md)

External cron is optional; prefer the built-in scheduler unless you intentionally run jobs out-of-process.

## Error Handling

The API includes comprehensive error handling:

- 400: Bad request (missing/invalid parameters)
- 403: Forbidden (authorization failed)
- 404: Not found (no data for requested resource)
- 500: Internal server error (with error message)

## License

MIT
