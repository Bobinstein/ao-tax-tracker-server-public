#!/usr/bin/env node

/**
 * AR Tax Tracker Schema Initialization
 *
 * Creates the ar_tax_tracker keyspace and all required tables for:
 * - Unified transactions (raw and processed)
 * - Tax lots and disposals
 * - Bazar profiles
 * - Report caching
 * - Indexer state tracking
 *
 * Also creates DEX and Fiat tables in ao_price_data keyspace.
 *
 * Usage:
 *   node admin-utilities/init-ar-tracker-schema.js
 *   node admin-utilities/init-ar-tracker-schema.js --force  # Drop and recreate
 */

const cassandra = require("cassandra-driver");
const CONFIG = require("../config/database");

// ============================================================================
// AR TAX TRACKER SCHEMA (ar_tax_tracker keyspace)
// ============================================================================

const AR_TRACKER_SCHEMA = {
  // Keyspace creation
  keyspace: `
    CREATE KEYSPACE IF NOT EXISTS ar_tax_tracker
    WITH REPLICATION = {
      'class': 'SimpleStrategy',
      'replication_factor': 1
    };
  `,

  // Unified transactions originals - immutable, append-only raw transaction data
  unified_transactions_originals: `
    CREATE TABLE IF NOT EXISTS unified_transactions_originals (
      wallet_address TEXT,
      block_timestamp TIMESTAMP,
      tx_id TEXT,
      type TEXT,
      token_symbol TEXT,
      amount_units TEXT,
      amount_human DECIMAL,
      price_usd DECIMAL,
      value_usd DECIMAL,
      fee_ar DECIMAL,
      fee_usd DECIMAL,
      counterparty TEXT,
      source TEXT,
      input_token TEXT,
      output_token TEXT,
      input_amount DECIMAL,
      output_amount DECIMAL,
      proceeds_per_unit DECIMAL,
      proceeds_usd DECIMAL,
      is_staked BOOLEAN,
      tax_category TEXT,
      block_height INT,
      metadata TEXT,
      fetched_at TIMESTAMP,
      PRIMARY KEY ((wallet_address), block_timestamp, tx_id)
    ) WITH CLUSTERING ORDER BY (block_timestamp DESC, tx_id ASC);
  `,

  // Unified transactions - mutable processed data with cost basis calculations
  unified_transactions: `
    CREATE TABLE IF NOT EXISTS unified_transactions (
      wallet_address TEXT,
      block_timestamp TIMESTAMP,
      tx_id TEXT,
      type TEXT,
      token_symbol TEXT,
      token_process_id TEXT,
      amount_units TEXT,
      amount_human DECIMAL,
      price_usd DECIMAL,
      value_usd DECIMAL,
      fee_ar DECIMAL,
      fee_usd DECIMAL,
      counterparty TEXT,
      source TEXT,
      input_token TEXT,
      output_token TEXT,
      input_amount DECIMAL,
      output_amount DECIMAL,
      input_price_usd DECIMAL,
      input_value_usd DECIMAL,
      output_price_usd DECIMAL,
      output_value_usd DECIMAL,
      proceeds_per_unit DECIMAL,
      proceeds_usd DECIMAL,
      cost_basis_usd DECIMAL,
      gain_loss_usd DECIMAL,
      is_staked BOOLEAN,
      tax_category TEXT,
      block_height INT,
      metadata TEXT,
      PRIMARY KEY ((wallet_address), block_timestamp, tx_id)
    ) WITH CLUSTERING ORDER BY (block_timestamp DESC, tx_id ASC);
  `,

  // Tax lots - tracks acquisition cost basis
  tax_lots: `
    CREATE TABLE IF NOT EXISTS tax_lots (
      wallet_address TEXT,
      token_symbol TEXT,
      lot_id TEXT,
      acquisition_date TIMESTAMP,
      acquisition_tx_id TEXT,
      acquisition_type TEXT,
      original_quantity DECIMAL,
      remaining_quantity DECIMAL,
      cost_basis_per_unit DECIMAL,
      cost_basis_total DECIMAL,
      token_process_id TEXT,
      status TEXT,
      holding_period_start TIMESTAMP,
      notes TEXT,
      created_at TIMESTAMP,
      updated_at TIMESTAMP,
      PRIMARY KEY ((wallet_address, token_symbol), acquisition_date, lot_id)
    ) WITH CLUSTERING ORDER BY (acquisition_date ASC, lot_id ASC);
  `,

  // Tax lot originals - immutable snapshot for restoration
  tax_lot_originals: `
    CREATE TABLE IF NOT EXISTS tax_lot_originals (
      wallet_address TEXT,
      token_symbol TEXT,
      lot_id TEXT,
      acquisition_date TIMESTAMP,
      acquisition_tx_id TEXT,
      acquisition_type TEXT,
      original_quantity DECIMAL,
      cost_basis_per_unit DECIMAL,
      cost_basis_total DECIMAL,
      token_process_id TEXT,
      holding_period_start TIMESTAMP,
      notes TEXT,
      created_at TIMESTAMP,
      PRIMARY KEY ((wallet_address, token_symbol), lot_id)
    );
  `,

  // Disposals - tracks sales/transfers with lot matching
  disposals: `
    CREATE TABLE IF NOT EXISTS disposals (
      wallet_address TEXT,
      token_symbol TEXT,
      disposal_id TEXT,
      disposal_date TIMESTAMP,
      disposal_tx_id TEXT,
      disposal_type TEXT,
      quantity DECIMAL,
      proceeds_per_unit DECIMAL,
      proceeds_total DECIMAL,
      lots_used TEXT,
      cost_basis DECIMAL,
      gain_loss DECIMAL,
      is_long_term BOOLEAN,
      accounting_method TEXT,
      notes TEXT,
      created_at TIMESTAMP,
      PRIMARY KEY ((wallet_address, token_symbol), disposal_date, disposal_id)
    ) WITH CLUSTERING ORDER BY (disposal_date ASC, disposal_id ASC);
  `,

  // Holdings summary - quick lookups
  holdings_summary: `
    CREATE TABLE IF NOT EXISTS holdings_summary (
      wallet_address TEXT,
      token_symbol TEXT,
      total_quantity DECIMAL,
      average_cost_basis DECIMAL,
      total_cost_basis DECIMAL,
      last_acquisition_date TIMESTAMP,
      last_disposal_date TIMESTAMP,
      open_lots_count INT,
      updated_at TIMESTAMP,
      PRIMARY KEY (wallet_address, token_symbol)
    );
  `,

  // Bazar profiles - discovered profiles for wallets
  bazar_profiles: `
    CREATE TABLE IF NOT EXISTS bazar_profiles (
      profile_id TEXT,
      wallet_address TEXT,
      username TEXT,
      display_name TEXT,
      description TEXT,
      thumbnail TEXT,
      banner TEXT,
      version TEXT,
      asset_count INT,
      is_active BOOLEAN,
      discovered_at TIMESTAMP,
      last_synced_at TIMESTAMP,
      last_transaction_at TIMESTAMP,
      metadata TEXT,
      PRIMARY KEY (profile_id)
    );
  `,

  // Reverse lookup: wallet address to profiles (supports multiple profiles per wallet)
  bazar_profiles_by_wallet: `
    CREATE TABLE IF NOT EXISTS bazar_profiles_by_wallet (
      wallet_address TEXT,
      profile_id TEXT,
      username TEXT,
      is_active BOOLEAN,
      discovered_at TIMESTAMP,
      PRIMARY KEY (wallet_address, profile_id)
    );
  `,

  // Profile transactions - links profile transactions to parent wallet
  profile_transactions: `
    CREATE TABLE IF NOT EXISTS profile_transactions (
      profile_id TEXT,
      block_timestamp TIMESTAMP,
      tx_id TEXT,
      parent_wallet TEXT,
      type TEXT,
      token_symbol TEXT,
      amount_units TEXT,
      amount_human DECIMAL,
      price_usd DECIMAL,
      value_usd DECIMAL,
      counterparty TEXT,
      is_internal BOOLEAN,
      source TEXT,
      PRIMARY KEY ((profile_id), block_timestamp, tx_id)
    ) WITH CLUSTERING ORDER BY (block_timestamp DESC, tx_id ASC);
  `,

  // Report summary cache - pre-computed JSON summaries for fast PDF generation
  report_summary_cache: `
    CREATE TABLE IF NOT EXISTS report_summary_cache (
      user_id TEXT,
      tax_year INT,
      report_type TEXT,
      summary_json TEXT,
      transaction_count INT,
      total_income_usd DECIMAL,
      total_capital_gains_usd DECIMAL,
      total_capital_losses_usd DECIMAL,
      distribution_count INT,
      swap_count INT,
      wallets_included LIST<TEXT>,
      profiles_included LIST<TEXT>,
      last_transaction_at TIMESTAMP,
      generated_at TIMESTAMP,
      expires_at TIMESTAMP,
      version INT,
      PRIMARY KEY ((user_id, tax_year), report_type)
    );
  `,

  // Indexer state - tracks sync progress per wallet/source
  indexer_state: `
    CREATE TABLE IF NOT EXISTS indexer_state (
      wallet_address TEXT,
      source_type TEXT,
      last_indexed_block INT,
      last_indexed_timestamp TIMESTAMP,
      transaction_count INT,
      last_run_at TIMESTAMP,
      created_at TIMESTAMP,
      PRIMARY KEY (wallet_address, source_type)
    );
  `,

  // Registered wallet groups - admin-managed groups for batch indexing
  // Stores wallet groups that should be automatically indexed on cron schedule
  registered_wallet_groups: `
    CREATE TABLE IF NOT EXISTS registered_wallet_groups (
      group_id TEXT,
      group_name TEXT,
      wallets LIST<TEXT>,
      primary_wallet TEXT,
      status TEXT,
      auto_index BOOLEAN,
      index_interval_hours INT,
      last_indexed_at TIMESTAMP,
      last_index_status TEXT,
      last_index_error TEXT,
      transaction_count INT,
      created_at TIMESTAMP,
      updated_at TIMESTAMP,
      created_by TEXT,
      notes TEXT,
      PRIMARY KEY (group_id)
    );
  `,

  // Lookup: wallet address to group(s) - enables finding which groups a wallet belongs to
  wallet_to_groups: `
    CREATE TABLE IF NOT EXISTS wallet_to_groups (
      wallet_address TEXT,
      group_id TEXT,
      group_name TEXT,
      is_primary BOOLEAN,
      added_at TIMESTAMP,
      PRIMARY KEY (wallet_address, group_id)
    );
  `,

  // Token info cache
  token_info: `
    CREATE TABLE IF NOT EXISTS token_info (
      process_id TEXT,
      ticker TEXT,
      name TEXT,
      denomination INT,
      logo TEXT,
      total_supply TEXT,
      source TEXT,
      has_market BOOLEAN,
      last_known_price_usd DECIMAL,
      market_checked_at TIMESTAMP,
      fetched_at TIMESTAMP,
      error TEXT,
      PRIMARY KEY (process_id)
    );
  `,

  // Block height to timestamp mapping cache
  block_timestamps: `
    CREATE TABLE IF NOT EXISTS block_timestamps (
      block_height INT PRIMARY KEY,
      timestamp BIGINT,
      cached_at TIMESTAMP
    );
  `,

  // ─────────────────────────────────────────────────────────────────────────
  // PIXL Distribution Tracking Tables
  // ─────────────────────────────────────────────────────────────────────────

  // PIXL streak events - records each Calculate-Streak message from UCM
  // These are indexed from on-chain data to rebuild streak state
  pixl_streak_events: `
    CREATE TABLE IF NOT EXISTS pixl_streak_events (
      buyer_address TEXT,
      block_height INT,
      tx_id TEXT,
      block_timestamp TIMESTAMP,
      days_after INT,
      indexed_at TIMESTAMP,
      PRIMARY KEY ((buyer_address), block_height, tx_id)
    ) WITH CLUSTERING ORDER BY (block_height ASC, tx_id ASC);
  `,

  // PIXL reward distributions - calculated at each Run-Rewards block
  // Stores the actual distribution amount for each recipient
  pixl_distributions: `
    CREATE TABLE IF NOT EXISTS pixl_distributions (
      wallet_address TEXT,
      distribution_block INT,
      distribution_timestamp TIMESTAMP,
      run_rewards_tx_id TEXT,
      amount_units TEXT,
      amount_human DECIMAL,
      streak_days INT,
      streak_multiplier DECIMAL,
      total_pool_points DECIMAL,
      share_percentage DECIMAL,
      daily_reward_pool TEXT,
      price_usd DECIMAL,
      value_usd DECIMAL,
      verified BOOLEAN,
      indexed_at TIMESTAMP,
      PRIMARY KEY ((wallet_address), distribution_block)
    ) WITH CLUSTERING ORDER BY (distribution_block ASC);
  `,

  // PIXL distributions by block - allows fetching all distributions for a given Run-Rewards
  pixl_distributions_by_block: `
    CREATE TABLE IF NOT EXISTS pixl_distributions_by_block (
      distribution_block INT,
      wallet_address TEXT,
      amount_units TEXT,
      amount_human DECIMAL,
      streak_days INT,
      streak_multiplier DECIMAL,
      PRIMARY KEY ((distribution_block), wallet_address)
    );
  `,

  // PIXL indexer state - tracks progress of streak/distribution indexing
  pixl_indexer_state: `
    CREATE TABLE IF NOT EXISTS pixl_indexer_state (
      indexer_name TEXT PRIMARY KEY,
      last_indexed_block INT,
      last_indexed_timestamp TIMESTAMP,
      streak_events_indexed BIGINT,
      distributions_calculated BIGINT,
      unique_addresses_seen BIGINT,
      streak_state_json TEXT,
      last_run_at TIMESTAMP,
      status TEXT,
      error_message TEXT
    );
  `,

  // PIXL full streak state - persisted so we never drop data on low-memory servers
  pixl_streak_state: `
    CREATE TABLE IF NOT EXISTS pixl_streak_state (
      wallet_address TEXT PRIMARY KEY,
      days INT,
      last_height INT,
      updated_at TIMESTAMP
    );
  `,

  // Indexes for common queries
  indexes: [
    "CREATE INDEX IF NOT EXISTS idx_unified_tx_type ON unified_transactions (type);",
    "CREATE INDEX IF NOT EXISTS idx_unified_tx_token ON unified_transactions (token_symbol);",
    "CREATE INDEX IF NOT EXISTS idx_unified_tx_source ON unified_transactions (source);",
    "CREATE INDEX IF NOT EXISTS idx_unified_tx_category ON unified_transactions (tax_category);",
    "CREATE INDEX IF NOT EXISTS idx_tax_lots_status ON tax_lots (status);",
    "CREATE INDEX IF NOT EXISTS idx_bazar_profiles_wallet ON bazar_profiles (wallet_address);",
    "CREATE INDEX IF NOT EXISTS idx_bazar_profiles_username ON bazar_profiles (username);",
    "CREATE INDEX IF NOT EXISTS idx_profile_tx_parent ON profile_transactions (parent_wallet);",
    "CREATE INDEX IF NOT EXISTS idx_token_info_ticker ON token_info (ticker);",
    "CREATE INDEX IF NOT EXISTS idx_token_info_market ON token_info (has_market);",
    "CREATE INDEX IF NOT EXISTS idx_wallet_groups_status ON registered_wallet_groups (status);",
    "CREATE INDEX IF NOT EXISTS idx_wallet_groups_auto ON registered_wallet_groups (auto_index);",
    // PIXL distribution indexes
    "CREATE INDEX IF NOT EXISTS idx_pixl_distributions_block ON pixl_distributions (distribution_block);",
  ],
};

// ============================================================================
// DEX PRICE INDEXER SCHEMA (ao_price_data keyspace)
// ============================================================================

const DEX_SCHEMA = {
  // Individual DEX swaps
  dex_swaps: `
    CREATE TABLE IF NOT EXISTS dex_swaps (
      swap_date TEXT,
      block_timestamp BIGINT,
      tx_id TEXT,
      platform TEXT,
      pool_id TEXT,
      token_in TEXT,
      token_in_symbol TEXT,
      token_out TEXT,
      token_out_symbol TEXT,
      amount_in TEXT,
      amount_out TEXT,
      price_ratio DECIMAL,
      block_height INT,
      user_address TEXT,
      created_at TIMESTAMP,
      PRIMARY KEY ((swap_date), block_timestamp, tx_id)
    ) WITH CLUSTERING ORDER BY (block_timestamp ASC, tx_id ASC);
  `,

  // Token prices derived from swaps (forward-filled)
  dex_token_prices: `
    CREATE TABLE IF NOT EXISTS dex_token_prices (
      token_process_id TEXT,
      price_date TEXT,
      block_timestamp BIGINT,
      price_in_war DECIMAL,
      price_in_usdc DECIMAL,
      price_usd DECIMAL,
      source_tx_id TEXT,
      source_platform TEXT,
      paired_token TEXT,
      is_forward_filled BOOLEAN,
      created_at TIMESTAMP,
      PRIMARY KEY ((token_process_id), price_date, block_timestamp)
    ) WITH CLUSTERING ORDER BY (price_date DESC, block_timestamp DESC);
  `,

  // DEX indexer state
  dex_indexer_state: `
    CREATE TABLE IF NOT EXISTS dex_indexer_state (
      indexer_name TEXT PRIMARY KEY,
      last_indexed_block INT,
      last_indexed_timestamp BIGINT,
      last_run_at TIMESTAMP,
      total_swaps_indexed BIGINT,
      status TEXT
    );
  `,

  // Indexes
  indexes: [
    "CREATE INDEX IF NOT EXISTS idx_dex_swaps_token_in ON dex_swaps (token_in);",
    "CREATE INDEX IF NOT EXISTS idx_dex_swaps_token_out ON dex_swaps (token_out);",
  ],
};

// ============================================================================
// FIAT CONVERSION SCHEMA (ao_price_data keyspace)
// ============================================================================

const FIAT_SCHEMA = {
  // Daily exchange rates
  fiat_exchange_rates: `
    CREATE TABLE IF NOT EXISTS fiat_exchange_rates (
      rate_date TEXT,
      base_currency TEXT,
      target_currency TEXT,
      rate DECIMAL,
      created_at TIMESTAMP,
      PRIMARY KEY ((base_currency, target_currency), rate_date)
    ) WITH CLUSTERING ORDER BY (rate_date DESC);
  `,

  // Fiat indexer state
  fiat_indexer_state: `
    CREATE TABLE IF NOT EXISTS fiat_indexer_state (
      indexer_name TEXT PRIMARY KEY,
      last_indexed_date TEXT,
      last_run_at TIMESTAMP,
      total_rates_indexed BIGINT,
      status TEXT
    );
  `,
};

// ============================================================================
// MAIN INITIALIZATION FUNCTION
// ============================================================================

async function initializeArTrackerSchema(options = {}) {
  const { force = false } = options;

  console.log("🚀 AR Tax Tracker Schema Initialization");
  console.log("========================================\n");

  // Create client without keyspace first
  const clientConfig = {
    contactPoints: CONFIG.AR_TAX_TRACKER_DB.contactPoints,
    localDataCenter: CONFIG.AR_TAX_TRACKER_DB.localDataCenter,
    socketOptions: CONFIG.AR_TAX_TRACKER_DB.socketOptions,
  };

  const client = new cassandra.Client(clientConfig);

  try {
    await client.connect();
    console.log("✅ Connected to Cassandra cluster\n");

    // ========================================================================
    // PHASE 1: AR TAX TRACKER KEYSPACE
    // ========================================================================

    console.log("📦 Phase 1: AR Tax Tracker Keyspace (ar_tax_tracker)");
    console.log("─".repeat(50));

    if (force) {
      console.log("⚠️  Force mode: Dropping existing keyspace...");
      try {
        await client.execute("DROP KEYSPACE IF EXISTS ar_tax_tracker;");
        console.log("   Dropped ar_tax_tracker keyspace");
      } catch (error) {
        console.log(`   Note: ${error.message}`);
      }
    }

    // Create keyspace
    await client.execute(AR_TRACKER_SCHEMA.keyspace);
    console.log("✅ Created/verified ar_tax_tracker keyspace");

    // Use keyspace
    await client.execute("USE ar_tax_tracker;");

    // Create tables
    const arTrackerTables = [
      "unified_transactions_originals",
      "unified_transactions",
      "tax_lots",
      "tax_lot_originals",
      "disposals",
      "holdings_summary",
      "bazar_profiles",
      "bazar_profiles_by_wallet",
      "profile_transactions",
      "report_summary_cache",
      "indexer_state",
      "registered_wallet_groups",
      "wallet_to_groups",
      "token_info",
      "block_timestamps",
      // PIXL distribution tracking tables
      "pixl_streak_events",
      "pixl_distributions",
      "pixl_distributions_by_block",
      "pixl_indexer_state",
      "pixl_streak_state",
    ];

    for (const table of arTrackerTables) {
      try {
        await client.execute(AR_TRACKER_SCHEMA[table]);
        console.log(`   ✅ Created table: ${table}`);
      } catch (error) {
        console.log(`   ⚠️  Table ${table}: ${error.message.split("\n")[0]}`);
      }
    }

    // Create indexes
    console.log("\n   Creating indexes...");
    for (const indexQuery of AR_TRACKER_SCHEMA.indexes) {
      try {
        await client.execute(indexQuery);
      } catch (error) {
        // Ignore "already exists" errors
        if (!error.message.includes("already exists")) {
          console.log(`   ⚠️  Index: ${error.message.split("\n")[0]}`);
        }
      }
    }
    console.log("   ✅ Indexes created/verified");

    // ========================================================================
    // PHASE 2: DEX TABLES (ao_price_data keyspace)
    // ========================================================================

    console.log("\n📦 Phase 2: DEX Tables (ao_price_data keyspace)");
    console.log("─".repeat(50));

    // Switch to ao_price_data keyspace
    await client.execute("USE ao_price_data;");

    // Create DEX tables
    for (const [tableName, schema] of Object.entries(DEX_SCHEMA)) {
      if (tableName === "indexes") continue;
      try {
        await client.execute(schema);
        console.log(`   ✅ Created table: ${tableName}`);
      } catch (error) {
        console.log(
          `   ⚠️  Table ${tableName}: ${error.message.split("\n")[0]}`,
        );
      }
    }

    // Create DEX indexes
    for (const indexQuery of DEX_SCHEMA.indexes) {
      try {
        await client.execute(indexQuery);
      } catch (error) {
        if (!error.message.includes("already exists")) {
          console.log(`   ⚠️  Index: ${error.message.split("\n")[0]}`);
        }
      }
    }
    console.log("   ✅ DEX indexes created/verified");

    // ========================================================================
    // PHASE 3: FIAT TABLES (ao_price_data keyspace)
    // ========================================================================

    console.log(
      "\n📦 Phase 3: Fiat Conversion Tables (ao_price_data keyspace)",
    );
    console.log("─".repeat(50));

    // Create Fiat tables (already in ao_price_data)
    for (const [tableName, schema] of Object.entries(FIAT_SCHEMA)) {
      try {
        await client.execute(schema);
        console.log(`   ✅ Created table: ${tableName}`);
      } catch (error) {
        console.log(
          `   ⚠️  Table ${tableName}: ${error.message.split("\n")[0]}`,
        );
      }
    }

    // ========================================================================
    // SUMMARY
    // ========================================================================

    console.log("\n" + "=".repeat(50));
    console.log("SCHEMA INITIALIZATION COMPLETE");
    console.log("=".repeat(50));
    console.log("\nKeyspaces configured:");
    console.log("  • ar_tax_tracker - Wallet transactions, tax lots, reports");
    console.log("  • ao_price_data  - DEX swaps, token prices, fiat rates");
    console.log("\nNext steps:");
    console.log("  1. Run DEX price indexer to populate historical swap data");
    console.log("  2. Run fiat rate indexer to populate exchange rates");
    console.log("  3. Test wallet sync and report generation");
    console.log();
  } catch (error) {
    console.error("\n❌ Schema initialization failed:", error.message);
    console.error("\n🔍 Full error:", error);

    if (error.message.includes("ECONNREFUSED")) {
      console.log("\n💡 Cassandra may not be running. Try:");
      console.log("   systemctl status cassandra");
      console.log("   systemctl start cassandra");
    }

    process.exit(1);
  } finally {
    await client.shutdown();
    console.log("🔌 Connection closed");
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  initializeArTrackerSchema,
  AR_TRACKER_SCHEMA,
  DEX_SCHEMA,
  FIAT_SCHEMA,
};

// ============================================================================
// CLI ENTRY POINT
// ============================================================================

// Only run if executed directly (not imported)
if (require.main === module) {
  const args = process.argv.slice(2);
  const force = args.includes("--force") || args.includes("-f");

  if (force) {
    console.log(
      "⚠️  WARNING: Force mode will DROP and recreate the ar_tax_tracker keyspace!",
    );
    console.log("   This will DELETE ALL DATA in that keyspace.\n");
  }

  initializeArTrackerSchema({ force });
}
