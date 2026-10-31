# ARIO Gateway Indexing Integration

## ✅ Integration Complete!

The ARIO gateway action indexers have been successfully integrated into the AO Tax Tracker Server.

## What Was Added

### 1. Indexer Files

**Location:** `src/indexers/`

- **`ario_gateway_mainnet_indexer.js`** - Indexes gateway actions from AR.IO mainnet
  - Process ID: `qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE`
  - Coverage: Feb 2025 - Present
  - Supports date range filtering
  - **Runs automatically daily**; can also be run for a date range CLI backfill

Historical bootstrap can also use the gateway snapshot import flow described in `GATEWAY_SNAPSHOT_README.md`.

### 2. Database Schema

**Keyspace:** `ario_gateway_history`
**Table:** `gateway_actions`

**Primary Key:** `((network, gateway_address), block_height, tx_id)`

**Fields:**
- `tx_id`, `block_height`, `block_timestamp`, `date`
- `network` (testnet/mainnet)
- `action` (Join-Network, Update-Gateway-Settings, etc.)
- `gateway_address`, `from_address`
- `operator_stake`, `label`, `fqdn`, `port`, `protocol`
- `allow_delegated_staking`, `delegate_reward_share_ratio`
- **`auto_stake`** - Critical for distribution calculations
- `min_delegated_stake`, `note`, `properties`
- `observer_address`, `quantity`, `target`
- `all_tags` (JSON), `created_at`

### 3. API Endpoints

#### New Job Endpoint

**`POST /api/jobs/index-ario-testnet`**

Triggers the testnet indexer (one-time use for historical data).

**Response:**
```json
{
  "message": "ARIO gateway testnet indexer started",
  "status": "running",
  "note": "This is a one-time job for historical testnet data",
  "timestamp": "2025-10-08T12:00:00.000Z"
}
```

#### Updated Endpoints

**`POST /api/jobs/update-all`**

Now includes ARIO gateway mainnet indexing (yesterday + today).

### 4. Automated Daily Updates

The built-in cron job (1:00 AM UTC) now runs:

1. AO distribution indexer
2. PI distribution indexer
3. **ARIO gateway mainnet indexer** (yesterday + today)
4. CoinGecko price fetcher
5. Permaswap price scraper

### 5. Documentation Updates

- **README.md** - Added ARIO gateway section with usage examples
- **server.js** - Updated startup messages and API info
- **ARIO_GATEWAY_INTEGRATION.md** - This file

## Usage

### Initial Setup

Prefer importing a gateway snapshot (see [GATEWAY_SNAPSHOT_README.md](../GATEWAY_SNAPSHOT_README.md)) or backfilling mainnet actions for the dates you need:

```bash
node src/indexers/ario_gateway_mainnet_indexer.js 2025-01-01 2025-03-01
```

An `index-ario-testnet` HTTP job may still exist for legacy setups; the standalone testnet indexer script is not shipped in this public tree. Use mainnet indexing + snapshots for new deployments.

### Daily Operations

The mainnet indexer runs automatically every day at 1:00 AM UTC. No manual intervention required.

**What it does:**
- Fetches gateway actions from yesterday and today
- Checks for duplicates (skips if already indexed)
- Stores new actions in Cassandra

### Manual Mainnet Indexing

If you need to index a specific date range:

```bash
node src/indexers/ario_gateway_mainnet_indexer.js 2025-10-01 2025-10-09
```

**Date Format:** YYYY-MM-DD

## State Reconstruction

The indexed data enables accurate reconstruction of any gateway's state at any point in time.

### Example: Determining `autoStake` Setting

```javascript
// Query all actions for a gateway up to a specific block height
const actions = await client.execute(
  `SELECT * FROM gateway_actions 
   WHERE network = 'mainnet' 
   AND gateway_address = ? 
   AND block_height <= ?
   ORDER BY block_height ASC`,
  [gatewayAddress, targetBlockHeight],
  { prepare: true }
);

// Find the most recent autoStake setting
let autoStake = null;
for (let i = actions.rows.length - 1; i >= 0; i--) {
  if (actions.rows[i].auto_stake !== null) {
    autoStake = actions.rows[i].auto_stake === 'true';
    break;
  }
}

// If no explicit setting found, use network default
if (autoStake === null) {
  // Mainnet default: true (launched Feb 20, 2025)
  // Testnet default: changed from false to true on Nov 26, 2024
  autoStake = true; // For mainnet
}
```

## Actions Tracked

1. **Join-Network** - Gateway joins the network
2. **Update-Gateway-Settings** - Gateway updates settings (including `autoStake`)
3. **Leave-Network** - Gateway leaves the network
4. **Increase-Operator-Stake** - Gateway increases stake
5. **Decrease-Operator-Stake** - Gateway decreases stake
6. **Increase-Delegate-Stake** - Delegate increases stake
7. **Decrease-Delegate-Stake** - Delegate decreases stake
8. **Delegate-Stake** - Delegate stakes to gateway
9. **Undelegate-Stake** - Delegate unstakes from gateway

## Important Dates

- **Testnet Launch:** June 17, 2024
- **autoStake Default Change (Testnet):** Nov 26, 2024 (false → true)
- **Mainnet Launch:** Feb 20, 2025, Block 1613554
- **Mainnet autoStake Default:** true (from launch)

## Performance

### Testnet Indexer
- Total actions: 7,867
- Errors: 6 (0.08%)
- Duration: ~5-10 minutes

### Mainnet Indexer
- Total actions: 9,585 (as of Oct 9, 2025)
- Errors: 0
- Duration: ~10-15 minutes (full history)
- Daily incremental: ~30 seconds

### Daily Cron Job
- Indexes yesterday + today only
- Typical duration: 30-60 seconds
- Duplicate detection prevents re-indexing

## Verification

Test the integration with a known gateway:

```bash
# Create a test query script
cat > test_gateway_query.js << 'SCRIPT'
const cassandra = require('cassandra-driver');

async function testQuery() {
  const client = new cassandra.Client({
    contactPoints: ['localhost'],
    localDataCenter: 'datacenter1',
    keyspace: 'ario_gateway_history',
  });

  await client.connect();

  const result = await client.execute(
    "SELECT * FROM gateway_actions WHERE network = 'mainnet' AND gateway_address = ? ORDER BY block_height ASC",
    ['uzESID1JQp8m4RO7YjfVZ8eWtRsSrxLp1SilTj7psB8'],
    { prepare: true }
  );

  console.log(`Found ${result.rows.length} actions`);
  result.rows.forEach(row => {
    console.log(`${row.date} - ${row.action} - autoStake: ${row.auto_stake || 'NOT SET'}`);
  });

  await client.shutdown();
}

testQuery();
SCRIPT

node test_gateway_query.js
```

**Expected Output:**
```
Found 2 actions
2025-02-20 - Join-Network - autoStake: true
2025-02-24 - Update-Gateway-Settings - autoStake: false
```

## Next Steps

1. ✅ **Integration Complete** - Mainnet indexer + cron
2. ✅ **Automated Updates** - Daily cron job configured
3. ✅ **Documentation** - README and guides updated
4. ✅ **Snapshot / backfill path** - Prefer snapshot import or mainnet date-range CLI
5. ⏳ **State reconstruction helpers** - For ARIO distribution calculator edge cases

## Key Files

1. `server.js` - Cron + job endpoints for gateway indexing
2. `README.md` - Gateway overview
3. `src/indexers/ario_gateway_mainnet_indexer.js` - Mainnet indexer
4. `GATEWAY_SNAPSHOT_README.md` / `admin-utilities/import-gateway-snapshot.js`
5. `docs/ARIO_GATEWAY_INTEGRATION.md` - This file

## Deployment Checklist

When deploying to a fresh VPS:

- [ ] Install dependencies (`yarn install`)
- [ ] Copy `env.example` → `.env` and configure secrets
- [ ] Configure Cassandra connection
- [ ] Start server (`yarn start` or use PM2)
- [ ] Import gateway snapshot and/or backfill mainnet actions for needed dates
- [ ] Wait for first daily cron (1 AM UTC) or trigger `update-all` with auth headers / CLI
- [ ] Verify mainnet gateway actions are present

---

**Last Updated:** October 31, 2026
