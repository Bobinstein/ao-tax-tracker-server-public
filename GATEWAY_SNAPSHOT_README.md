# Gateway Snapshot Import

This document describes the new approach to handling gateway states for ARIO distribution classification.

## Overview

Instead of querying testnet transactions to build gateway states, we now use a snapshot of the exact gateway states at the time of the testnet-to-mainnet crossover. This provides the definitive state of all gateways and their `Auto-Stake` settings at the critical moment.

## Files

### Core Files

- `import-gateway-snapshot.js` - Imports the gateway snapshot JSON into the database
- `query-gateway-states.js` - Query and analyze gateway states
- `recreate-gateway-table.js` - Utility to recreate the gateway_states table
- `cleanup-testnet-files.js` - Removes old testnet-related files

### Data

- `data/gateway-snapshot_1738271904625.json` - The gateway snapshot containing 295 gateways

## Database Schema

The `gateway_states` table in the `ario_distributions` keyspace contains:

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
  failed_consecutive_epochs text,
  observed_epoch_count text,
  passed_consecutive_epochs text,
  total_epoch_count text,
  prescribed_epoch_count text,
  passed_epoch_count text,
  failed_epoch_count text,
  composite_weight text,
  observer_reward_ratio_weight text,
  normalized_composite_weight text,
  tenure_weight text,
  gateway_reward_ratio_weight text,
  stake_weight text,
  snapshot_timestamp text
);
```

## Key Statistics

From the imported snapshot:

- **Total gateways**: 295
- **Auto-Stake enabled**: 117 gateways (39.7%)
- **Auto-Stake disabled**: 178 gateways (60.3%)
- **Status joined**: 278 gateways (94.2%)
- **Status leaving**: 17 gateways (5.8%)

## Usage

### Import Gateway Snapshot

```bash
node import-gateway-snapshot.js
```

### Query Gateway States

```bash
# Show all statistics
node query-gateway-states.js

# Query specific gateway
node query-gateway-states.js <gateway_address>
```

### Recreate Table

```bash
node recreate-gateway-table.js
```

## Integration with ARIO Distribution Indexer

The gateway states can now be used by the ARIO distribution indexer to determine if rewards should be classified as liquid or staked based on the gateway's `Auto-Stake` setting at the time of distribution.

### Key Fields for Classification

- `gateway_address` - Primary key to identify the gateway
- `auto_stake` - Boolean indicating if rewards should be staked (true) or liquid (false)
- `status` - Gateway status (joined/leaving) at the time of crossover

## Benefits

1. **Accuracy**: Uses the exact state at the critical moment of crossover
2. **Performance**: No need to query and process testnet transactions
3. **Reliability**: Eliminates dependency on testnet data availability
4. **Simplicity**: Single source of truth for gateway states

## Migration from Testnet Approach

The old testnet-based approach has been completely replaced:

- Removed all testnet query files
- Removed testnet indexer files
- Replaced with snapshot-based approach
- All gateway states are now stored in a single table

This approach provides a clean, reliable foundation for determining ARIO reward classifications based on gateway settings at the time of the testnet-to-mainnet transition.
