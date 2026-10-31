# ARIO Gateway Actions Indexing

This document describes the hybrid approach to tracking ARIO gateway actions over time for accurate reward classification.

## Overview

We use a **hybrid approach** that combines:

1. **Initial Snapshot** (`gateway_states` table) - The exact state of all gateways at the testnet-to-mainnet crossover
2. **Gateway Actions** (`gateway_actions` table) - Individual actions (`Join-Network` and `Update-Gateway-Settings`) that occur after mainnet launch

This allows us to build the exact gateway state for any specific epoch by starting from the snapshot and then applying actions chronologically.

## Architecture

### Database Schema

**`gateway_states` table (Initial Snapshot):**

```sql
CREATE TABLE gateway_states (
  gateway_address text PRIMARY KEY,
  observer_address text,
  operator_stake text,
  port text,
  protocol text,
  min_delegated_stake text,
  fqdn text,
  delegate_reward_share_ratio text,
  note text,
  auto_stake boolean,
  allow_delegated_staking boolean,
  label text,
  properties text,
  start_timestamp text,
  status text,
  -- ... other fields
)
```

**`gateway_actions` table (Individual Actions):**

```sql
CREATE TABLE gateway_actions (
  transaction_id text,
  block_height bigint,
  timestamp bigint,
  gateway_address text,
  action text,
  auto_stake boolean,
  label text,
  fqdn text,
  port text,
  protocol text,
  min_delegated_stake text,
  delegate_reward_share_ratio text,
  note text,
  allow_delegated_staking boolean,
  properties text,
  PRIMARY KEY (transaction_id)
)
```

### Key Components

1. **`ario_gateway_mainnet_indexer.js`** - Indexes gateway actions from mainnet
2. **`query-gateway-actions.js`** - Query and analyze indexed actions
3. **`build-gateway-state.js`** - Build gateway state for any specific epoch

## How It Works

### 1. Action Indexing

The indexer searches for transactions where:

- **Recipient**: ARIO mainnet contract (`agYcCFJtrMG6cqMuZfskIkFTGvUPddICmtQSBIoPdiA`)
- **Action**: `Join-Network` or `Update-Gateway-Settings`
- **No block limits** - indexes all historical actions
- **Pagination** - processes all results

### 2. State Building

For any given epoch (block height), we can:

1. Query all actions up to that block height
2. Group by gateway address
3. Apply actions chronologically to build the state
4. Determine if rewards should be liquid or staked based on `Auto-Stake` setting

### 3. Action Processing

**Join-Network Actions:**

- Initialize gateway state with all provided settings
- Set `Auto-Stake` value for future reward classification

**Update-Gateway-Settings Actions:**

- Update only the settings that are provided
- Preserve existing settings for unspecified values
- Update `Auto-Stake` if provided

## Usage

### Index Gateway Actions

```bash
# Run the mainnet indexer
node src/indexers/ario_gateway_mainnet_indexer.js
```

### Query Actions

```bash
# Show all actions statistics
node scripts/query-gateway-actions.js

# Query specific gateway
node scripts/query-gateway-actions.js <gateway_address>
```

### Build State for Epoch

```bash
# Build state for specific block height
node scripts/build-gateway-state.js <block_height>

# Build state and show specific gateway
node scripts/build-gateway-state.js <block_height> <gateway_address>
```

## Integration with Distribution Classification

The ARIO distribution indexer can now:

1. **Query gateway state** for the distribution block height
2. **Determine reward type** based on `Auto-Stake` setting:
   - `Auto-Stake: true` → **Staked rewards**
   - `Auto-Stake: false` → **Liquid rewards**
   - `Auto-Stake: null` → **Unknown** (handle appropriately)

## Benefits

1. **Historical Accuracy** - Can determine exact gateway state for any epoch
2. **Real-time Updates** - New actions are indexed as they occur
3. **Flexible Querying** - Can build state for any point in time
4. **Audit Trail** - Complete history of all gateway changes
5. **Performance** - No need to query testnet transactions

## Data Flow

```
Mainnet Transactions
        ↓
GraphQL Query (ARIO contract recipient)
        ↓
Action Processing (Join-Network, Update-Gateway-Settings)
        ↓
Database Storage (gateway_actions table)
        ↓
State Building (for specific epoch)
        ↓
Reward Classification (liquid vs staked)
```

## Example State Building

For block height 1,500,000:

1. Query all actions where `block_height <= 1500000`
2. Group by `gateway_address`
3. Sort by `block_height` within each group
4. Apply actions chronologically:
   - First `Join-Network` sets initial state
   - Subsequent `Update-Gateway-Settings` updates specific fields
5. Final state shows `Auto-Stake` setting at that epoch

This approach provides the most accurate and flexible method for determining ARIO reward classifications based on the actual gateway settings at the time of distribution.
