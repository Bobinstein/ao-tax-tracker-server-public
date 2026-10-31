/**
 * DistributionService
 *
 * Fetches taxable token distributions from the existing server Cassandra databases.
 * Supports AO, PI, and ARIO distributions which constitute taxable income events.
 *
 * Database Keyspaces:
 * - ao_distributions: AO token distribution records from CSV files
 * - pi_distributions: PI token distribution records from CSV files
 * - ario_distributions: ARIO epoch-based operator and delegate rewards
 *
 * Each distribution represents taxable income at the fair market value
 * on the date of receipt.
 *
 * ARIO distribution timestamps are fetched via the ARIO SDK for accuracy,
 * matching the server implementation.
 *
 * @module services/DistributionService
 */

const cassandra = require("cassandra-driver");
const axios = require("axios");

// Import ARIO SDK for epoch timestamp fetching
let ARIO;
try {
  ARIO = require("@ar.io/sdk").ARIO;
} catch (error) {
  console.warn(
    "⚠️ @ar.io/sdk not available - ARIO distribution timestamps will be estimated",
  );
  ARIO = null;
}

/**
 * Remote server config for optional testing against a running API
 * (API_BASE_URL + ADMIN_AUTH_BYPASS_CODE from env — never hardcode secrets).
 */
function getRemoteServerConfig() {
  const baseUrl = (process.env.API_BASE_URL || "http://localhost:3000").replace(
    /\/$/,
    "",
  );
  const authBypass = (process.env.ADMIN_AUTH_BYPASS_CODE || "").trim();
  return { baseUrl, authBypass };
}

/**
 * Token decimals for amount conversion
 */
const TOKEN_DECIMALS = {
  AO: 12,
  PI: 12,
  ARIO: 6,
  PIXL: 6,
};

/**
 * Keyspace configurations
 */
const KEYSPACES = {
  AO: "ao_distributions",
  PI: "pi_distributions",
  ARIO: "ario_distributions",
  PIXL: "ar_tax_tracker", // PIXL distributions stored in ar_tax_tracker keyspace
};

class DistributionService {
  /**
   * Create a new DistributionService instance
   * @param {Object} options - Configuration options
   * @param {boolean} options.verbose - Enable verbose logging
   * @param {boolean} options.useRemoteServer - Use remote production server for distribution data (testing bypass)
   */
  constructor(options = {}) {
    this.verbose = options.verbose || false;
    this.useRemoteServer = options.useRemoteServer || false;
    this.clients = {};
    this.isConnected = false;
    this.ario = null;
    this.epochTimestampCache = new Map(); // epochIndex -> { timestamp, date }

    if (this.useRemoteServer && this.verbose) {
      console.log(
        "🌐 DistributionService configured to use REMOTE SERVER for data",
      );
    }
  }

  /**
   * Connect to all distribution keyspaces
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.isConnected) return;

    try {
      // Connect to each keyspace
      for (const [token, keyspace] of Object.entries(KEYSPACES)) {
        this.clients[token] = new cassandra.Client({
          contactPoints: ["localhost"],
          localDataCenter: "datacenter1",
          keyspace: keyspace,
        });
        await this.clients[token].connect();
        if (this.verbose) {
          console.log(`✅ Connected to ${keyspace}`);
        }
      }

      // Initialize ARIO SDK for epoch timestamp fetching
      if (ARIO) {
        try {
          this.ario = ARIO.mainnet();
          if (this.verbose) {
            console.log("✅ ARIO SDK initialized for epoch timestamp fetching");
          }
        } catch (error) {
          console.warn(`⚠️ Failed to initialize ARIO SDK: ${error.message}`);
        }
      }

      this.isConnected = true;
      console.log("✅ DistributionService connected to all keyspaces");
    } catch (error) {
      console.error("❌ DistributionService connection failed:", error.message);
      // Don't throw - allow graceful degradation if some keyspaces don't exist
    }
  }

  /**
   * Disconnect from all keyspaces
   * @returns {Promise<void>}
   */
  async disconnect() {
    for (const client of Object.values(this.clients)) {
      if (client) {
        await client.shutdown();
      }
    }
    this.isConnected = false;
    if (this.verbose) {
      console.log("✅ DistributionService disconnected");
    }
  }

  /**
   * Convert raw units to human-readable amount
   * @param {string|number} units - Raw amount in smallest units
   * @param {string} token - Token symbol (AO, PI, ARIO)
   * @returns {number} Human-readable amount
   */
  convertToHuman(units, token) {
    const decimals = TOKEN_DECIMALS[token] || 12;
    const rawUnits = BigInt(units || 0);
    // Use floating point division for display
    return Number(rawUnits) / Math.pow(10, decimals);
  }

  /**
   * Fetch actual distribution timestamp for an ARIO epoch using the SDK
   *
   * Note: Some ARIO epochs may have missing data due to AO infrastructure issues.
   * When the contract completes an epoch, it should submit a data item to Arweave,
   * but sometimes this fails. We handle these errors gracefully by falling back
   * to timestamp estimation.
   *
   * @param {number} epochIndex - The epoch index
   * @returns {Promise<{timestamp: number, date: string, estimated: boolean}>}
   */
  async getEpochDistributionTimestamp(epochIndex) {
    // Check cache first
    if (this.epochTimestampCache.has(epochIndex)) {
      return this.epochTimestampCache.get(epochIndex);
    }

    if (!this.ario) {
      // Fallback to estimation if SDK not available
      const timestamp = this.estimateEpochTimestamp(epochIndex);
      const date = new Date(timestamp * 1000).toISOString().split("T")[0];
      const result = { timestamp, date, estimated: true };
      this.epochTimestampCache.set(epochIndex, result);
      return result;
    }

    try {
      // Attempt to fetch from ARIO SDK with timeout protection
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error("SDK request timeout")), 10000);
      });

      const distributions = await Promise.race([
        this.ario.getDistributions({ epochIndex }),
        timeoutPromise,
      ]);

      if (distributions && distributions.distributedTimestamp) {
        const timestamp = Math.floor(distributions.distributedTimestamp / 1000); // Convert ms to seconds
        const date = new Date(distributions.distributedTimestamp)
          .toISOString()
          .split("T")[0];
        const result = { timestamp, date, estimated: false };
        this.epochTimestampCache.set(epochIndex, result);
        return result;
      }

      // Data exists but no timestamp - might be incomplete epoch data
      if (this.verbose) {
        console.warn(
          `⚠️ Epoch ${epochIndex} has incomplete distribution data, using estimation`,
        );
      }
    } catch (error) {
      // Common errors:
      // - Network timeouts
      // - Missing epoch data (data item not submitted to Arweave)
      // - AO infrastructure issues
      // - Contract state not available
      if (this.verbose) {
        console.warn(
          `⚠️ Could not fetch epoch ${epochIndex} timestamp: ${error.message} - using estimation`,
        );
      }

      // Track failed epochs for potential retry or reporting
      if (!this.failedEpochFetches) {
        this.failedEpochFetches = new Set();
      }
      this.failedEpochFetches.add(epochIndex);
    }

    // Fallback to estimation when SDK fails or returns incomplete data
    const timestamp = this.estimateEpochTimestamp(epochIndex);
    const date = new Date(timestamp * 1000).toISOString().split("T")[0];
    const result = { timestamp, date, estimated: true };
    this.epochTimestampCache.set(epochIndex, result);
    return result;
  }

  /**
   * Get list of epochs that failed to fetch from SDK
   * Useful for debugging and reporting
   * @returns {Array<number>} Array of epoch indices that failed
   */
  getFailedEpochFetches() {
    return this.failedEpochFetches ? Array.from(this.failedEpochFetches) : [];
  }

  /**
   * Fetch AO distributions for a wallet address
   * @param {string} walletAddress - Wallet address to query
   * @param {Object} options - Query options
   * @param {number} options.minTimestamp - Minimum timestamp (Unix seconds)
   * @param {number} options.maxTimestamp - Maximum timestamp (Unix seconds)
   * @returns {Promise<Array>} Array of AO distribution records
   */
  async fetchAODistributions(walletAddress, options = {}) {
    if (!this.clients.AO) {
      if (this.verbose)
        console.log("⚠️ AO distributions keyspace not available");
      return [];
    }

    try {
      const query = `
        SELECT address, txid, source_txid, from_process, target_process,
               amount_units, ao_amount_units, date, full_date, block_height
        FROM distributions
        WHERE address = ?
      `;

      const result = await this.clients.AO.execute(query, [walletAddress], {
        prepare: true,
      });

      const distributions = result.rows.map((row) => {
        // Use ao_amount_units as primary (matching server implementation)
        const amountUnits = row.ao_amount_units || row.amount_units;
        return {
          type: "DISTRIBUTION",
          token: "AO",
          walletAddress: row.address,
          txId: row.txid,
          sourceTxId: row.source_txid,
          fromProcess: row.from_process,
          targetProcess: row.target_process,
          amountUnits: amountUnits,
          amountHuman: this.convertToHuman(amountUnits, "AO"),
          date: row.date,
          timestamp: row.full_date
            ? new Date(row.full_date).getTime() / 1000
            : null,
          blockHeight: row.block_height ? parseInt(row.block_height) : null,
          source: "ao_distribution",
          taxCategory: "INCOME",
          isTaxableEvent: true,
          distributionType: "AIRDROP", // AO distributions are airdrops
        };
      });

      // Filter by timestamp if provided
      let filtered = distributions;
      if (options.minTimestamp) {
        filtered = filtered.filter(
          (d) => !d.timestamp || d.timestamp >= options.minTimestamp,
        );
      }
      if (options.maxTimestamp) {
        filtered = filtered.filter(
          (d) => !d.timestamp || d.timestamp <= options.maxTimestamp,
        );
      }

      if (this.verbose) {
        console.log(
          `   📦 Found ${
            filtered.length
          } AO distributions for ${walletAddress.substring(0, 8)}...`,
        );
      }

      return filtered;
    } catch (error) {
      console.error(`❌ Error fetching AO distributions: ${error.message}`);
      return [];
    }
  }

  /**
   * Fetch PI distributions for a wallet address
   * @param {string} walletAddress - Wallet address to query
   * @param {Object} options - Query options
   * @param {number} options.minTimestamp - Minimum timestamp (Unix seconds)
   * @param {number} options.maxTimestamp - Maximum timestamp (Unix seconds)
   * @returns {Promise<Array>} Array of PI distribution records
   */
  async fetchPIDistributions(walletAddress, options = {}) {
    if (!this.clients.PI) {
      if (this.verbose)
        console.log("⚠️ PI distributions keyspace not available");
      return [];
    }

    try {
      const query = `
        SELECT address, txid, source_txid, from_process, target_process,
               amount_units, pi_amount_units, original_balance, date, full_date, block_height
        FROM distributions
        WHERE address = ?
      `;

      const result = await this.clients.PI.execute(query, [walletAddress], {
        prepare: true,
      });

      const distributions = result.rows.map((row) => {
        // Use pi_amount_units as primary (matching server implementation)
        const amountUnits = row.pi_amount_units || row.amount_units;
        return {
          type: "DISTRIBUTION",
          token: "PI",
          walletAddress: row.address,
          txId: row.txid,
          sourceTxId: row.source_txid,
          fromProcess: row.from_process,
          targetProcess: row.target_process,
          amountUnits: amountUnits,
          amountHuman: this.convertToHuman(amountUnits, "PI"),
          originalBalance: row.original_balance,
          date: row.date,
          timestamp: row.full_date
            ? new Date(row.full_date).getTime() / 1000
            : null,
          blockHeight: row.block_height ? parseInt(row.block_height) : null,
          source: "pi_distribution",
          taxCategory: "INCOME",
          isTaxableEvent: true,
          distributionType: "AIRDROP", // PI distributions are airdrops
        };
      });

      // Filter by timestamp if provided
      let filtered = distributions;
      if (options.minTimestamp) {
        filtered = filtered.filter(
          (d) => !d.timestamp || d.timestamp >= options.minTimestamp,
        );
      }
      if (options.maxTimestamp) {
        filtered = filtered.filter(
          (d) => !d.timestamp || d.timestamp <= options.maxTimestamp,
        );
      }

      if (this.verbose) {
        console.log(
          `   📦 Found ${
            filtered.length
          } PI distributions for ${walletAddress.substring(0, 8)}...`,
        );
      }

      return filtered;
    } catch (error) {
      console.error(`❌ Error fetching PI distributions: ${error.message}`);
      return [];
    }
  }

  /**
   * Fetch ARIO operator rewards for a wallet address
   * @param {string} walletAddress - Wallet address (operator_wallet) to query
   * @param {Object} options - Query options
   * @returns {Promise<Array>} Array of ARIO operator reward records
   */
  async fetchARIOOperatorRewards(walletAddress, options = {}) {
    if (!this.clients.ARIO) {
      if (this.verbose)
        console.log("⚠️ ARIO distributions keyspace not available");
      return [];
    }

    try {
      // Query operator rewards where distributed_reward > 0
      const query = `
        SELECT epoch_index, gateway_address, operator_wallet, eligible_reward,
               distributed_reward, is_staked
        FROM ario_operator_rewards
        WHERE operator_wallet = ?
        ALLOW FILTERING
      `;

      const result = await this.clients.ARIO.execute(query, [walletAddress], {
        prepare: true,
      });

      const rewards = [];
      for (const row of result.rows) {
        // Handle is_staked: could be boolean, null, or string (matching server)
        const isStakedRaw = row.is_staked;
        const isStaked =
          isStakedRaw === true ||
          isStakedRaw === "true" ||
          (typeof isStakedRaw === "string" &&
            isStakedRaw.toLowerCase() === "true");

        const distributed = BigInt(row.distributed_reward || 0);
        if (distributed <= 0) continue; // Skip zero rewards, but include staked

        // Fetch actual epoch timestamp via SDK
        const epochIndex = Number(row.epoch_index);
        const epochData = await this.getEpochDistributionTimestamp(epochIndex);

        rewards.push({
          type: "DISTRIBUTION",
          token: "ARIO",
          walletAddress: row.operator_wallet,
          epochIndex: epochIndex,
          gatewayAddress: row.gateway_address,
          amountUnits: row.distributed_reward,
          amountHuman: this.convertToHuman(row.distributed_reward, "ARIO"),
          eligibleReward: row.eligible_reward,
          isStaked: isStaked,
          timestamp: epochData.timestamp,
          date: epochData.date,
          timestampEstimated: epochData.estimated || false,
          source: "ario_operator_reward",
          // Staked rewards are deferred income (not immediately taxable)
          taxCategory: isStaked ? "DEFERRED_INCOME" : "INCOME",
          isTaxableEvent: !isStaked,
          rewardType: "OPERATOR",
          distributionType: isStaked
            ? "STAKED_STAKING_REWARD"
            : "STAKING_REWARD",
        });
      }

      const liquidCount = rewards.filter((r) => !r.isStaked).length;
      const stakedCount = rewards.filter((r) => r.isStaked).length;

      if (this.verbose) {
        console.log(
          `   📦 Found ${rewards.length} ARIO operator rewards for ${walletAddress.substring(0, 8)}... (${liquidCount} liquid, ${stakedCount} staked)`,
        );
      }

      return rewards;
    } catch (error) {
      console.error(
        `❌ Error fetching ARIO operator rewards: ${error.message}`,
      );
      return [];
    }
  }

  /**
   * Fetch ARIO delegate rewards for a wallet address
   * @param {string} walletAddress - Wallet address (delegate_wallet) to query
   * @param {Object} options - Query options
   * @returns {Promise<Array>} Array of ARIO delegate reward records
   */
  async fetchARIODelegateRewards(walletAddress, options = {}) {
    if (!this.clients.ARIO) {
      if (this.verbose)
        console.log("⚠️ ARIO distributions keyspace not available");
      return [];
    }

    try {
      // Query delegate rewards where distributed_reward > 0
      const query = `
        SELECT epoch_index, gateway_address, delegate_wallet, eligible_reward,
               distributed_reward, is_staked
        FROM ario_delegate_rewards
        WHERE delegate_wallet = ?
        ALLOW FILTERING
      `;

      const result = await this.clients.ARIO.execute(query, [walletAddress], {
        prepare: true,
      });

      const rewards = [];
      for (const row of result.rows) {
        // Handle is_staked: could be boolean, null, or string (matching server)
        const isStakedRaw = row.is_staked;
        const isStaked =
          isStakedRaw === true ||
          isStakedRaw === "true" ||
          (typeof isStakedRaw === "string" &&
            isStakedRaw.toLowerCase() === "true");

        const distributed = BigInt(row.distributed_reward || 0);
        if (distributed <= 0) continue; // Skip zero rewards, but include staked

        // Fetch actual epoch timestamp via SDK
        const epochIndex = Number(row.epoch_index);
        const epochData = await this.getEpochDistributionTimestamp(epochIndex);

        rewards.push({
          type: "DISTRIBUTION",
          token: "ARIO",
          walletAddress: row.delegate_wallet,
          epochIndex: epochIndex,
          gatewayAddress: row.gateway_address,
          amountUnits: row.distributed_reward,
          amountHuman: this.convertToHuman(row.distributed_reward, "ARIO"),
          eligibleReward: row.eligible_reward,
          isStaked: isStaked,
          timestamp: epochData.timestamp,
          date: epochData.date,
          timestampEstimated: epochData.estimated || false,
          source: "ario_delegate_reward",
          // Staked rewards are deferred income (not immediately taxable)
          taxCategory: isStaked ? "DEFERRED_INCOME" : "INCOME",
          isTaxableEvent: !isStaked,
          rewardType: "DELEGATE",
          distributionType: isStaked
            ? "STAKED_STAKING_REWARD"
            : "STAKING_REWARD",
        });
      }

      const liquidCount = rewards.filter((r) => !r.isStaked).length;
      const stakedCount = rewards.filter((r) => r.isStaked).length;

      if (this.verbose) {
        console.log(
          `   📦 Found ${rewards.length} ARIO delegate rewards for ${walletAddress.substring(0, 8)}... (${liquidCount} liquid, ${stakedCount} staked)`,
        );
      }

      return rewards;
    } catch (error) {
      console.error(
        `❌ Error fetching ARIO delegate rewards: ${error.message}`,
      );
      return [];
    }
  }

  /**
   * Fetch PIXL distributions for a wallet address
   * PIXL distributions are calculated from streak rewards on the Bazar marketplace
   * @param {string} walletAddress - Wallet address to query
   * @param {Object} options - Query options
   * @param {number} options.minTimestamp - Minimum timestamp (Unix seconds)
   * @param {number} options.maxTimestamp - Maximum timestamp (Unix seconds)
   * @returns {Promise<Array>} Array of PIXL distribution records
   */
  async fetchPIXLDistributions(walletAddress, options = {}) {
    if (!this.clients.PIXL) {
      if (this.verbose)
        console.log("⚠️ PIXL distributions table not available");
      return [];
    }

    try {
      const query = `
        SELECT wallet_address, distribution_block, distribution_timestamp,
               run_rewards_tx_id, amount_units, amount_human,
               streak_days, streak_multiplier, share_percentage,
               daily_reward_pool, price_usd, value_usd
        FROM pixl_distributions
        WHERE wallet_address = ?
      `;

      const result = await this.clients.PIXL.execute(query, [walletAddress], {
        prepare: true,
      });

      const distributions = result.rows.map((row) => {
        const timestamp = row.distribution_timestamp
          ? new Date(row.distribution_timestamp).getTime() / 1000
          : null;

        return {
          type: "DISTRIBUTION",
          token: "PIXL",
          walletAddress: row.wallet_address,
          txId: row.run_rewards_tx_id,
          blockHeight: row.distribution_block,
          amountUnits: row.amount_units,
          amountHuman:
            parseFloat(row.amount_human) ||
            this.convertToHuman(row.amount_units, "PIXL"),
          timestamp: timestamp,
          date: timestamp
            ? new Date(timestamp * 1000).toISOString().split("T")[0]
            : null,
          streakDays: row.streak_days,
          streakMultiplier: parseFloat(row.streak_multiplier),
          sharePercentage: parseFloat(row.share_percentage),
          dailyRewardPool: row.daily_reward_pool,
          priceUSD: row.price_usd ? parseFloat(row.price_usd) : null,
          valueUSD: row.value_usd ? parseFloat(row.value_usd) : null,
          source: "pixl_streak_reward",
          taxCategory: "INCOME",
          isTaxableEvent: true,
          distributionType: "STAKING_REWARD", // Streak rewards are similar to staking rewards
          rewardType: "STREAK",
        };
      });

      // Filter by timestamp if provided
      let filtered = distributions;
      if (options.minTimestamp) {
        filtered = filtered.filter(
          (d) => !d.timestamp || d.timestamp >= options.minTimestamp,
        );
      }
      if (options.maxTimestamp) {
        filtered = filtered.filter(
          (d) => !d.timestamp || d.timestamp <= options.maxTimestamp,
        );
      }

      if (this.verbose) {
        console.log(
          `   📦 Found ${
            filtered.length
          } PIXL distributions for ${walletAddress.substring(0, 8)}...`,
        );
      }

      return filtered;
    } catch (error) {
      // Table might not exist yet if indexer hasn't run
      if (error.message.includes("unconfigured table")) {
        if (this.verbose) {
          console.log("   ⚠️ PIXL distributions table not yet created");
        }
        return [];
      }
      console.error(`❌ Error fetching PIXL distributions: ${error.message}`);
      return [];
    }
  }

  /**
   * Estimate Unix timestamp from ARIO epoch index (fallback if SDK unavailable)
   * ARIO epochs are approximately 24 hours each, starting around Aug 8, 2024
   * @param {number} epochIndex - The epoch index
   * @returns {number} Estimated Unix timestamp (seconds)
   */
  estimateEpochTimestamp(epochIndex) {
    // Epoch 0 started approximately at 2024-08-08 00:00:00 UTC
    const EPOCH_0_TIMESTAMP = 1723075200;
    const EPOCH_DURATION_SECONDS = 24 * 60 * 60; // 24 hours
    return EPOCH_0_TIMESTAMP + epochIndex * EPOCH_DURATION_SECONDS;
  }

  /**
   * Convert epoch index to date string (YYYY-MM-DD) - fallback method
   * @param {number} epochIndex - The epoch index
   * @returns {string} Date string
   */
  epochToDateString(epochIndex) {
    const timestamp = this.estimateEpochTimestamp(epochIndex);
    return new Date(timestamp * 1000).toISOString().split("T")[0];
  }

  /**
   * Fetch all distributions for a wallet address across all token types
   * @param {string} walletAddress - Wallet address to query
   * @param {Object} options - Query options
   * @param {number} options.minTimestamp - Minimum timestamp (Unix seconds)
   * @param {number} options.maxTimestamp - Maximum timestamp (Unix seconds)
   * @returns {Promise<Array>} Combined array of all distribution records
   */
  async fetchAllDistributions(walletAddress, options = {}) {
    await this.connect();

    const [
      aoDistributions,
      piDistributions,
      arioOperatorRewards,
      arioDelegateRewards,
      pixlDistributions,
    ] = await Promise.all([
      this.fetchAODistributions(walletAddress, options),
      this.fetchPIDistributions(walletAddress, options),
      this.fetchARIOOperatorRewards(walletAddress, options),
      this.fetchARIODelegateRewards(walletAddress, options),
      this.fetchPIXLDistributions(walletAddress, options),
    ]);

    const allDistributions = [
      ...aoDistributions,
      ...piDistributions,
      ...arioOperatorRewards,
      ...arioDelegateRewards,
      ...pixlDistributions,
    ];

    // Sort by timestamp (oldest first)
    allDistributions.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    // Mark ARIO distributions that used estimated timestamps
    const arioDistributions = [...arioOperatorRewards, ...arioDelegateRewards];
    const estimatedCount = arioDistributions.filter(
      (d) => d.timestampEstimated,
    ).length;

    if (this.verbose) {
      console.log(
        `   📊 Total distributions for ${walletAddress.substring(0, 8)}...: ${
          allDistributions.length
        }`,
      );
      console.log(
        `      AO: ${aoDistributions.length}, PI: ${piDistributions.length}, ` +
          `ARIO: ${arioOperatorRewards.length + arioDelegateRewards.length}, ` +
          `PIXL: ${pixlDistributions.length}`,
      );
      if (estimatedCount > 0) {
        console.log(
          `      ⚠️ ${estimatedCount} ARIO distributions used estimated timestamps`,
        );
      }
    }

    return allDistributions;
  }

  /**
   * Fetch distributions for multiple wallet addresses
   * @param {Array<string>} walletAddresses - Array of wallet addresses
   * @param {Object} options - Query options
   * @returns {Promise<Array>} Combined array of all distributions for all wallets
   */
  async fetchDistributionsForWallets(walletAddresses, options = {}) {
    // Use remote server if configured
    if (this.useRemoteServer) {
      return this.fetchDistributionsFromRemoteServer(walletAddresses, options);
    }

    await this.connect();

    console.log(
      `\n📦 Fetching distributions for ${walletAddresses.length} wallets...`,
    );

    const allDistributions = [];

    for (const wallet of walletAddresses) {
      const distributions = await this.fetchAllDistributions(wallet, options);
      allDistributions.push(...distributions);
    }

    // Sort by timestamp (oldest first)
    allDistributions.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    console.log(`   Total distributions found: ${allDistributions.length}`);

    // Summary by token
    const byToken = {};
    allDistributions.forEach((d) => {
      byToken[d.token] = (byToken[d.token] || 0) + 1;
    });
    console.log("   By token:", byToken);

    // Report on estimated timestamps
    const estimatedTimestamps = allDistributions.filter(
      (d) => d.timestampEstimated,
    );
    if (estimatedTimestamps.length > 0) {
      console.log(
        `   ⚠️ ${estimatedTimestamps.length} ARIO distributions used estimated timestamps`,
      );
    }

    // Report on failed epoch fetches
    const failedEpochs = this.getFailedEpochFetches();
    if (failedEpochs.length > 0) {
      console.log(
        `   ⚠️ Failed to fetch data for ${
          failedEpochs.length
        } ARIO epochs: ${failedEpochs.slice(0, 10).join(", ")}${
          failedEpochs.length > 10 ? "..." : ""
        }`,
      );
      console.log(
        `      This is typically due to AO infrastructure issues (epoch data not properly submitted to Arweave)`,
      );
    }

    return allDistributions;
  }

  /**
   * Fetch distributions from remote production server (testing bypass)
   * @param {string[]} walletAddresses - Array of wallet addresses
   * @param {Object} options - Query options including minTimestamp/maxTimestamp
   * @returns {Promise<Array>} Array of distribution records with price data
   */
  async fetchDistributionsFromRemoteServer(walletAddresses, options = {}) {
    const remote = getRemoteServerConfig();
    if (!remote.authBypass) {
      throw new Error(
        "ADMIN_AUTH_BYPASS_CODE is required when useRemoteServer is enabled",
      );
    }

    console.log(
      `\n🌐 Fetching distributions from REMOTE SERVER for ${walletAddresses.length} wallets...`,
    );
    console.log(`   Server: ${remote.baseUrl}`);

    const allDistributions = [];

    // Calculate date range from timestamps
    let startDate = "2024-01-01";
    let endDate = new Date().toISOString().split("T")[0];

    if (options.minTimestamp) {
      startDate = new Date(options.minTimestamp * 1000)
        .toISOString()
        .split("T")[0];
    }
    if (options.maxTimestamp) {
      endDate = new Date(options.maxTimestamp * 1000)
        .toISOString()
        .split("T")[0];
    }

    console.log(`   Date range: ${startDate} to ${endDate}`);

    for (const wallet of walletAddresses) {
      try {
        console.log(
          `   📥 Fetching distributions for ${wallet.substring(0, 12)}...`,
        );

        // Fetch CSV from remote server - include staked to show separately
        const response = await axios.post(
          `${remote.baseUrl}/api/distributions/csv`,
          {
            wallet,
            startDate,
            endDate,
            includeStaked: true, // Include staked distributions for separate tracking
          },
          {
            headers: {
              "Content-Type": "application/json",
              "X-Auth-Bypass": remote.authBypass,
              "X-Service": "Distribution Report",
            },
            timeout: 300000, // 5 minutes timeout (staked distributions can be slow)
          },
        );

        // Parse CSV response - includes both liquid and staked
        const distributions = this.parseRemoteCSV(response.data, wallet);
        allDistributions.push(...distributions);

        const liquidCount = distributions.filter((d) => !d.isStaked).length;
        const stakedCount = distributions.filter((d) => d.isStaked).length;
        console.log(
          `      ✅ Found ${distributions.length} distributions (${liquidCount} liquid, ${stakedCount} staked)`,
        );
      } catch (error) {
        if (error.response && error.response.status === 404) {
          console.log(
            `      ⚠️ No distributions found for ${wallet.substring(0, 12)}...`,
          );
        } else {
          console.error(
            `      ❌ Error fetching for ${wallet.substring(0, 12)}...: ${
              error.message
            }`,
          );
        }
      }
    }

    // Sort by timestamp (oldest first)
    allDistributions.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    // Separate liquid and staked for reporting
    const liquidDistributions = allDistributions.filter((d) => !d.isStaked);
    const stakedDistributions = allDistributions.filter((d) => d.isStaked);

    console.log(
      `   📦 Total distributions from remote: ${allDistributions.length}`,
    );
    console.log(`      💧 Liquid (taxable): ${liquidDistributions.length}`);
    console.log(`      🔒 Staked (deferred): ${stakedDistributions.length}`);

    // Summary by token (liquid only)
    const byTokenLiquid = {};
    liquidDistributions.forEach((d) => {
      byTokenLiquid[d.token] = (byTokenLiquid[d.token] || 0) + 1;
    });
    console.log("   Liquid by token:", byTokenLiquid);

    // Summary by token (staked)
    if (stakedDistributions.length > 0) {
      const byTokenStaked = {};
      stakedDistributions.forEach((d) => {
        byTokenStaked[d.token] = (byTokenStaked[d.token] || 0) + 1;
      });
      console.log("   Staked by token:", byTokenStaked);
    }

    return allDistributions;
  }

  /**
   * Parse CSV response from remote server into distribution objects
   * CSV format: Distribution Date,Token,Distribution Amount,Token Price (USD),Distribution Value (USD),Liquid/Staked
   * @param {string} csvData - Raw CSV data from server
   * @param {string} walletAddress - The wallet address these distributions belong to
   * @returns {Array} Array of distribution objects
   */
  parseRemoteCSV(csvData, walletAddress) {
    const distributions = [];
    const lines = csvData.trim().split("\n");

    // Skip header line
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // Parse CSV line (handle potential commas in values)
      const parts = line.split(",");
      if (parts.length < 6) continue;

      const [dateStr, token, amountStr, priceStr, valueStr, stakingStatus] =
        parts;

      // Skip if essential data is missing
      if (!dateStr || !token || token === "Token") continue; // Skip header-like rows

      // Parse values
      const amountHuman = parseFloat(amountStr) || 0;
      const priceUSD =
        priceStr && priceStr !== "N/A"
          ? parseFloat(priceStr.replace("$", ""))
          : null;
      const valueUSD =
        valueStr && valueStr !== "N/A"
          ? parseFloat(valueStr.replace("$", ""))
          : null;
      const isLiquid = stakingStatus
        ? stakingStatus.toLowerCase().includes("liquid")
        : true;
      const isStaked = !isLiquid;

      // Convert date to timestamp
      const date = new Date(dateStr + "T12:00:00Z");
      const timestamp = date.getTime() / 1000;

      // Convert human amount back to units for consistency
      const decimals = TOKEN_DECIMALS[token] || 12;
      const amountUnits = Math.floor(
        amountHuman * Math.pow(10, decimals),
      ).toString();

      distributions.push({
        type: "DISTRIBUTION",
        token: token,
        walletAddress: walletAddress,
        txId: `remote-${token}-${dateStr}-${i}`, // Generate placeholder txId
        sourceTxId: null,
        fromProcess: "remote-server",
        targetProcess: null,
        amountUnits: amountUnits,
        amountHuman: amountHuman,
        date: dateStr,
        timestamp: timestamp,
        priceUSD: priceUSD,
        valueUSD: valueUSD || amountHuman * (priceUSD || 0),
        priceSource: "remote-server",
        source: "remote_distribution",
        // Staked distributions are deferred income (not immediately taxable)
        taxCategory: isStaked ? "DEFERRED_INCOME" : "INCOME",
        isTaxableEvent: !isStaked, // Only liquid distributions are immediately taxable
        isStaked: isStaked,
        distributionType: isStaked ? "STAKED_AIRDROP" : "AIRDROP",
        isRemoteData: true, // Flag to indicate this came from remote server
      });
    }

    return distributions;
  }

  /**
   * Enrich distributions with price data
   * @param {Array} distributions - Array of distribution records
   * @param {Object} priceService - PriceService instance for USD valuation
   * @returns {Promise<Array>} Distributions with price and value data
   */
  async enrichDistributionsWithPrices(distributions, priceService) {
    if (!priceService) return distributions;

    console.log(
      `   💰 Enriching ${distributions.length} distributions with prices...`,
    );

    let enrichedCount = 0;
    let alreadyHadPrice = 0;
    let totalValue = 0;

    for (const dist of distributions) {
      // If distribution already has price data (e.g., from remote server), keep it
      if (
        dist.priceUSD !== null &&
        dist.priceUSD !== undefined &&
        dist.priceUSD > 0
      ) {
        alreadyHadPrice++;
        totalValue += dist.valueUSD || 0;
        continue;
      }

      if (dist.date) {
        const priceData = await priceService.getPriceWithSource(
          dist.token,
          dist.date,
        );
        if (priceData && priceData.price !== null) {
          dist.priceUSD = priceData.price;
          dist.priceSource = priceData.source;
          dist.valueUSD = dist.amountHuman * priceData.price;
          totalValue += dist.valueUSD;
          enrichedCount++;
        } else {
          // Only set to null if not already set
          if (dist.priceUSD === undefined) {
            dist.priceUSD = null;
            dist.priceSource = null;
            dist.valueUSD = 0;
          }
        }
      }
    }

    console.log(
      `   📊 Price data: ${alreadyHadPrice} already had prices, ${enrichedCount} enriched from local DB`,
    );

    console.log(
      `   ✅ Enriched ${enrichedCount}/${distributions.length} distributions with prices`,
    );
    console.log(`   💵 Total distribution value: $${totalValue.toFixed(2)}`);

    return distributions;
  }

  /**
   * Get distribution summary for tax reporting
   * @param {Array} distributions - Array of distribution records
   * @param {Object} priceService - PriceService instance for USD valuation
   * @returns {Promise<Object>} Summary with totals and USD values
   */
  async getDistributionSummary(distributions, priceService = null) {
    const summary = {
      totalDistributions: distributions.length,
      byToken: {},
      byType: {},
      totalValueUSD: 0,
    };

    for (const dist of distributions) {
      // By token
      if (!summary.byToken[dist.token]) {
        summary.byToken[dist.token] = {
          count: 0,
          totalAmount: 0,
          totalValueUSD: 0,
        };
      }
      summary.byToken[dist.token].count++;
      summary.byToken[dist.token].totalAmount += dist.amountHuman;

      // By distribution type
      const distType = dist.distributionType || "UNKNOWN";
      if (!summary.byType[distType]) {
        summary.byType[distType] = {
          count: 0,
          totalValueUSD: 0,
        };
      }
      summary.byType[distType].count++;

      // Get USD value if price service available
      if (priceService && dist.date && !dist.valueUSD) {
        const price = await priceService.getPrice(dist.token, dist.date);
        if (price) {
          dist.priceUSD = price;
          dist.valueUSD = dist.amountHuman * price;
        }
      }

      // Add to totals
      if (dist.valueUSD) {
        summary.byToken[dist.token].totalValueUSD += dist.valueUSD;
        summary.byType[distType].totalValueUSD += dist.valueUSD;
        summary.totalValueUSD += dist.valueUSD;
      }
    }

    return summary;
  }
}

module.exports = { DistributionService, TOKEN_DECIMALS, KEYSPACES };
