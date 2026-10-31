# Admin Utilities

This directory contains utility scripts for managing the database tables. Use these scripts when you need to clear data, refresh it with correct information, or manage the AR Tracker system.

## AR Tracker Utilities

### `init-ar-tracker-schema.js`

Initializes the AR Tracker database schema. This is automatically run on server start, but can be run manually if needed.

**Creates:**
- `ar_tax_tracker` keyspace with 13 tables (unified_transactions, tax_lots, disposals, etc.)
- DEX price tables in `ao_price_data` (dex_swaps, dex_token_prices, dex_indexer_state)
- Fiat conversion tables in `ao_price_data` (fiat_exchange_rates, fiat_indexer_state)

```bash
node admin-utilities/init-ar-tracker-schema.js
```

**Note:** The server automatically initializes this schema on startup, so manual execution is only needed for debugging or fresh installations.

### `backup-to-parquet.js`

Exports Cassandra database tables to Parquet format for backup and data analysis.

```bash
# Full backup (all keyspaces)
node admin-utilities/backup-to-parquet.js

# Test with limited rows
node admin-utilities/backup-to-parquet.js --limit 100

# Backup specific keyspace
node admin-utilities/backup-to-parquet.js --keyspace ar_tax_tracker

# Backup specific table
node admin-utilities/backup-to-parquet.js --keyspace ao_price_data --table dex_token_prices
```

**Output:**
- Creates timestamped directory: `backups/YYYY-MM-DD_HHMMSS/`
- One Parquet file per table: `keyspace__tablename.parquet`
- Manifest file: `backup_manifest.json` with record counts and metadata

### `diagnose-cassandra.js`

Diagnostic tool for troubleshooting Cassandra connection and schema issues.

```bash
node admin-utilities/diagnose-cassandra.js
```

**Checks:**
- Connection to Cassandra cluster
- Keyspace existence and configuration
- Table schemas and record counts
- Index status

---

## Price Data Utilities

### `clear-ao-prices.js`

Clears all AO price data from the `daily_prices` table.

```bash
node admin-utilities/clear-ao-prices.js
```

### `clear-ario-prices.js`

Clears all ARIO price data from the `daily_prices` table.
**Important**: Use this after fixing the ARIO pool process ID to ensure correct data.

```bash
node admin-utilities/clear-ario-prices.js
```

### `clear-pi-prices.js`

Clears all PI price data from the `daily_prices` table.

```bash
node admin-utilities/clear-pi-prices.js
```

### `clear-ar-prices.js`

Clears all AR price data from the `daily_prices` table.
**Important**: AR prices are needed for wAR conversion in AO/ARIO price calculations.

```bash
node admin-utilities/clear-ar-prices.js
```

### `clear-all-prices.js`

Clears ALL price data (AR, AO, ARIO, PI) from the `daily_prices` table.
**Warning**: This deletes all price data!

```bash
node admin-utilities/clear-all-prices.js
```

## Gateway Data Utilities

### `import-gateway-snapshot.js`

Imports the gateway snapshot data into the `gateway_states` table in the `ario_distributions` keyspace.
This provides the initial state for the hybrid gateway state system.

```bash
node admin-utilities/import-gateway-snapshot.js
```

### `reset-gateway-data.js`

Clears all gateway actions and states, then imports the gateway snapshot to establish a clean baseline.
Use this when you need to start fresh with gateway data or when gateway actions have become corrupted.

**WARNING**: This will delete all gateway actions and states!

```bash
node admin-utilities/reset-gateway-data.js
```

### `import-missing-pi-prices.js`

Manually imports PI prices for dates when the pool didn't exist yet (early August 2025).
This is needed because the PI price fetcher can only get prices from when the pool was created.

```bash
# Import missing prices (will skip if they already exist)
node admin-utilities/import-missing-pi-prices.js

# Overwrite existing prices if they exist
node admin-utilities/import-missing-pi-prices.js --overwrite
```

## Distribution Data Utilities

### `clear-ao-distributions.js`

Clears all AO distribution data from the `ao_distributions` table.

```bash
node admin-utilities/clear-ao-distributions.js
```

### `clear-ario-distributions.js`

Clears all ARIO distribution data from the `distributions` and `epoch_metadata` tables.
**Important**: This preserves gateway states and actions data.

```bash
node admin-utilities/clear-ario-distributions.js
```

### `clear-pi-distributions.js`

Clears all PI distribution data from the `pi_distributions` table.

```bash
node admin-utilities/clear-pi-distributions.js
```

## Usage Examples

### After fixing ARIO pool process ID:

```bash
# Clear the incorrect ARIO price data
node admin-utilities/clear-ario-prices.js

# Run the price update job to get correct data
node jobs/update-prices.js
```

### Setting up gateway states:

```bash
# Option 1: Fresh start (clears existing data first)
node admin-utilities/reset-gateway-data.js

# Option 2: Just import snapshot (if no existing data)
node admin-utilities/import-gateway-snapshot.js

# Run the gateway actions indexer to get historical actions
node src/indexers/ario_gateway_mainnet_indexer.js
```

### Complete data refresh:

```bash
# Clear all price data
node admin-utilities/clear-all-prices.js

# Clear all distribution data
node admin-utilities/clear-ao-distributions.js
node admin-utilities/clear-ario-distributions.js
node admin-utilities/clear-pi-distributions.js

# Import gateway snapshot
node admin-utilities/import-gateway-snapshot.js

# Run all update jobs
node jobs/update-prices.js
node jobs/update-distributions.js
```

## Safety Notes

- All scripts show a count of existing records before clearing
- Scripts will not run if no data exists to clear
- Always run the appropriate update jobs after clearing data
- Consider backing up important data before running clear operations
