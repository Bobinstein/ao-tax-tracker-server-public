# Individual Job Endpoints

This document describes the individual job endpoints that allow you to run specific indexers and fetchers independently via API calls.

## Authentication

These routes use `isAuthorized`. Provide either:

1. A valid subscription (`X-Wallet`, `X-Service`, `X-Year`), or
2. Admin bypass: `X-Auth-Bypass: <ADMIN_AUTH_BYPASS_CODE>` **and** `X-Year` (still required by middleware)

Example headers for local ops:

```
X-Auth-Bypass: YOUR_BYPASS
X-Year: 2025
X-Wallet: YOUR_WALLET
X-Service: Distribution Report
```

## Distribution Indexers

### AO Distribution Indexer

- **Endpoint**: `POST /api/jobs/ao-distributions`
- **Description**: Runs the AO distribution indexer to process AO token distributions
- **File**: `src/indexers/ao_distribution_indexer_cassandra.js`

```bash
curl -X POST http://localhost:3000/api/jobs/ao-distributions \
  -H "X-Auth-Bypass: YOUR_BYPASS" -H "X-Year: 2025" -H "X-Wallet: YOUR_WALLET" -H "X-Service: Distribution Report"
```

### PI Distribution Indexer

- **Endpoint**: `POST /api/jobs/pi-distributions`
- **Description**: Runs the PI distribution indexer to process PI token distributions
- **File**: `src/indexers/pi_distribution_indexer_cassandra.js`

```bash
curl -X POST http://localhost:3000/api/jobs/pi-distributions \
  -H "X-Auth-Bypass: YOUR_BYPASS" -H "X-Year: 2025" -H "X-Wallet: YOUR_WALLET" -H "X-Service: Distribution Report"
```

### ARIO Distribution Indexer

- **Endpoint**: `POST /api/jobs/ario-distributions`
- **Description**: Runs the ARIO distribution indexer to process ARIO token distributions
- **File**: `src/indexers/ario_distribution_indexer_cassandra.js`

```bash
curl -X POST http://localhost:3000/api/jobs/ario-distributions \
  -H "X-Auth-Bypass: YOUR_BYPASS" -H "X-Year: 2025" -H "X-Wallet: YOUR_WALLET" -H "X-Service: Distribution Report"
```

### ARIO Gateway Mainnet Indexer

- **Endpoint**: `POST /api/jobs/ario-gateway-mainnet`
- **Description**: Runs the ARIO gateway mainnet indexer to track gateway actions
- **File**: `src/indexers/ario_gateway_mainnet_indexer.js`

```bash
curl -X POST http://localhost:3000/api/jobs/ario-gateway-mainnet \
  -H "X-Auth-Bypass: YOUR_BYPASS" -H "X-Year: 2025" -H "X-Wallet: YOUR_WALLET" -H "X-Service: Distribution Report"
```

## Price Fetchers

### AO Price Fetcher

- **Endpoint**: `POST /api/jobs/ao-prices`
- **Description**: Fetches AO token prices from CoinGecko and Permaswap
- **File**: `src/fetchers/ao_price_fetcher.js`

```bash
curl -X POST http://localhost:3000/api/jobs/ao-prices \
  -H "X-Auth-Bypass: YOUR_BYPASS" -H "X-Year: 2025" -H "X-Wallet: YOUR_WALLET" -H "X-Service: Distribution Report"
```

### ARIO Price Fetcher

- **Endpoint**: `POST /api/jobs/ario-prices`
- **Description**: Fetches ARIO token prices from CoinGecko and Permaswap
- **File**: `src/fetchers/ario_price_fetcher.js`

```bash
curl -X POST http://localhost:3000/api/jobs/ario-prices \
  -H "X-Auth-Bypass: YOUR_BYPASS" -H "X-Year: 2025" -H "X-Wallet: YOUR_WALLET" -H "X-Service: Distribution Report"
```

### PI Price Fetcher

- **Endpoint**: `POST /api/jobs/pi-prices`
- **Description**: Fetches PI token prices from Permaswap
- **File**: `src/fetchers/pi_price_fetcher.js`

```bash
curl -X POST http://localhost:3000/api/jobs/pi-prices \
  -H "X-Auth-Bypass: YOUR_BYPASS" -H "X-Year: 2025" -H "X-Wallet: YOUR_WALLET" -H "X-Service: Distribution Report"
```

### AR Price Fetcher

- **Endpoint**: `POST /api/jobs/ar-prices`
- **Description**: Fetches AR token prices from CoinGecko
- **File**: `src/fetchers/ar_price_fetcher.js`

```bash
curl -X POST http://localhost:3000/api/jobs/ar-prices \
  -H "X-Auth-Bypass: YOUR_BYPASS" -H "X-Year: 2025" -H "X-Wallet: YOUR_WALLET" -H "X-Service: Distribution Report"
```

## Response Format

All endpoints return a JSON response with the following format:

### Success Response

```json
{
  "success": true,
  "message": "Job completed successfully",
  "output": "Console output from the job execution"
}
```

### Error Response

```json
{
  "error": "Job failed",
  "message": "Error description",
  "output": "Console output (if any)",
  "errorOutput": "Error output (if any)"
}
```

## Job Status Tracking

All individual jobs are tracked in the job status system. You can check the status of any job using:

```bash
curl -X GET http://localhost:3000/api/status \
  -H "X-Auth-Bypass: YOUR_BYPASS" -H "X-Year: 2025" -H "X-Wallet: YOUR_WALLET" -H "X-Service: Distribution Report"
```

The status will show:

- `idle`: Job not running
- `running`: Job currently executing
- `completed`: Job finished successfully
- `error`: Job failed

## Usage Examples

### Run all distribution indexers individually:

```bash
# AO distributions
curl -X POST http://localhost:3000/api/jobs/ao-distributions \
  -H "X-Auth-Bypass: YOUR_BYPASS" -H "X-Year: 2025" -H "X-Wallet: YOUR_WALLET" -H "X-Service: Distribution Report"

# PI distributions
curl -X POST http://localhost:3000/api/jobs/pi-distributions \
  -H "X-Auth-Bypass: YOUR_BYPASS" -H "X-Year: 2025" -H "X-Wallet: YOUR_WALLET" -H "X-Service: Distribution Report"

# ARIO distributions
curl -X POST http://localhost:3000/api/jobs/ario-distributions \
  -H "X-Auth-Bypass: YOUR_BYPASS" -H "X-Year: 2025" -H "X-Wallet: YOUR_WALLET" -H "X-Service: Distribution Report"
```

### Run all price fetchers individually:

```bash
# AO prices
curl -X POST http://localhost:3000/api/jobs/ao-prices \
  -H "X-Auth-Bypass: YOUR_BYPASS" -H "X-Year: 2025" -H "X-Wallet: YOUR_WALLET" -H "X-Service: Distribution Report"

# ARIO prices
curl -X POST http://localhost:3000/api/jobs/ario-prices \
  -H "X-Auth-Bypass: YOUR_BYPASS" -H "X-Year: 2025" -H "X-Wallet: YOUR_WALLET" -H "X-Service: Distribution Report"

# PI prices
curl -X POST http://localhost:3000/api/jobs/pi-prices \
  -H "X-Auth-Bypass: YOUR_BYPASS" -H "X-Year: 2025" -H "X-Wallet: YOUR_WALLET" -H "X-Service: Distribution Report"

# AR prices
curl -X POST http://localhost:3000/api/jobs/ar-prices \
  -H "X-Auth-Bypass: YOUR_BYPASS" -H "X-Year: 2025" -H "X-Wallet: YOUR_WALLET" -H "X-Service: Distribution Report"
```

### Run gateway indexer:

```bash
# ARIO gateway mainnet indexer
curl -X POST http://localhost:3000/api/jobs/ario-gateway-mainnet \
  -H "X-Auth-Bypass: YOUR_BYPASS" -H "X-Year: 2025" -H "X-Wallet: YOUR_WALLET" -H "X-Service: Distribution Report"
```

## Benefits

- **Granular Control**: Run only the specific indexers/fetchers you need
- **Debugging**: Easier to debug individual components
- **Flexibility**: Mix and match different jobs as needed
- **Monitoring**: Track status of individual jobs separately
- **Efficiency**: Avoid running unnecessary jobs when only specific data needs updating
