#!/usr/bin/env node

/**
 * ARIO Distribution Indexer - Using Pre-computed Gateway State
 *
 * This version uses the gateway_state_by_epoch table built by ario_gateway_mainnet_indexer.js
 * instead of building state at query time. This reduces compute time and improves consistency.
 */

const { Client } = require("cassandra-driver");
const { ARIO } = require("@ar.io/sdk");

// Configuration
const ARIO_MAINNET_CONTRACT = "qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE";

// Initialize ARIO SDK
const ario = ARIO.mainnet();

// Cassandra client (will connect without keyspace first, then switch to keyspace)
const client = new Client({
  contactPoints: ["127.0.0.1"],
  localDataCenter: "datacenter1",
  // Don't set keyspace initially - we'll create it and switch to it in createSchema()
});

class ARIODistributionIndexerCassandra {
  constructor() {
    this.corruptedEpochs = [];
  }

  /**
   * Retry helper with exponential backoff
   * @param {Function} fn - Async function to retry
   * @param {number} maxRetries - Maximum number of retries (default: 3)
   * @param {number} baseDelayMs - Base delay in milliseconds (default: 1000)
   * @param {string} operationName - Name of operation for logging
   * @returns {Promise} Result of the function
   */
  async retryWithBackoff(
    fn,
    maxRetries = 3,
    baseDelayMs = 1000,
    operationName = "operation",
  ) {
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await fn();

        // Check if result is undefined (network error indicator)
        if (result === undefined || result === null) {
          throw new Error(`Network error: ${operationName} returned undefined`);
        }

        return result;
      } catch (error) {
        lastError = error;

        // Check if this is a network-related error
        const isNetworkError =
          error.message?.includes("network") ||
          error.message?.includes("timeout") ||
          error.message?.includes("ECONNRESET") ||
          error.message?.includes("ENOTFOUND") ||
          error.message?.includes("ETIMEDOUT") ||
          error.message?.includes("undefined") ||
          error.code === "ECONNRESET" ||
          error.code === "ETIMEDOUT" ||
          error.code === "ENOTFOUND";

        // If not a network error or we've exhausted retries, throw
        if (!isNetworkError || attempt === maxRetries) {
          throw error;
        }

        // Calculate delay with exponential backoff
        const delayMs = baseDelayMs * Math.pow(2, attempt);
        console.log(
          `   ⚠️  ${operationName} failed (attempt ${attempt + 1}/${
            maxRetries + 1
          }): ${error.message}`,
        );
        console.log(`   🔄 Retrying in ${delayMs}ms...`);

        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw lastError;
  }

  async initialize() {
    await client.connect();
    console.log("✅ Connected to Cassandra\n");

    await this.createSchema();
    await this.loadCorruptedEpochs();
  }

  async createSchema() {
    console.log("📝 Creating all required schemas...");

    try {
      // Create keyspace if it doesn't exist (must be done before USE)
      const createKeyspaceQuery = `
        CREATE KEYSPACE IF NOT EXISTS ario_distributions
        WITH REPLICATION = {
          'class': 'SimpleStrategy',
          'replication_factor': 1
        }
      `;
      await client.execute(createKeyspaceQuery);

      // Switch to the keyspace
      await client.execute("USE ario_distributions;");

      // Create ario_operator_rewards table
      const createOperatorRewardsQuery = `
        CREATE TABLE IF NOT EXISTS ario_operator_rewards (
          epoch_index bigint,
          gateway_address text,
          operator_wallet text,
          eligible_reward text,
          distributed_reward text,
          is_staked boolean,
          PRIMARY KEY (epoch_index, gateway_address)
        )
      `;
      await client.execute(createOperatorRewardsQuery);

      // Create ario_delegate_rewards table
      const createDelegateRewardsQuery = `
        CREATE TABLE IF NOT EXISTS ario_delegate_rewards (
          epoch_index bigint,
          gateway_address text,
          delegate_wallet text,
          eligible_reward text,
          distributed_reward text,
          is_staked boolean,
          PRIMARY KEY (epoch_index, gateway_address, delegate_wallet)
        )
      `;
      await client.execute(createDelegateRewardsQuery);

      // Create ario_epochs_processed table
      const createEpochsProcessedQuery = `
        CREATE TABLE IF NOT EXISTS ario_epochs_processed (
          epoch_index bigint PRIMARY KEY,
          is_corrupted boolean,
          note text,
          created_at text,
          distribution_timestamp bigint
        )
      `;
      await client.execute(createEpochsProcessedQuery);
      // Add distribution_timestamp to existing tables (no-op if already present)
      try {
        await client.execute(
          "ALTER TABLE ario_epochs_processed ADD distribution_timestamp bigint",
        );
      } catch (e) {
        if (!e.message?.includes("already exists")) throw e;
      }

      // Create indexes for efficient queries
      const indexes = [
        "CREATE INDEX IF NOT EXISTS ON ario_operator_rewards (operator_wallet);",
        "CREATE INDEX IF NOT EXISTS ON ario_operator_rewards (is_staked);",
        "CREATE INDEX IF NOT EXISTS ON ario_delegate_rewards (delegate_wallet);",
        "CREATE INDEX IF NOT EXISTS ON ario_delegate_rewards (is_staked);",
      ];

      for (const indexQuery of indexes) {
        try {
          await client.execute(indexQuery);
        } catch (error) {
          // Index might already exist, that's okay
          if (!error.message.includes("already exists")) {
            console.log(`   ⚠️  Warning creating index: ${error.message}`);
          }
        }
      }

      console.log("✅ Created all required tables\n");
    } catch (error) {
      console.error(`❌ Error creating schema: ${error.message}`);
      throw error;
    }
  }

  async loadCorruptedEpochs() {
    try {
      const query =
        "SELECT epoch_index, note FROM ario_epochs_processed WHERE is_corrupted = true ALLOW FILTERING";
      const result = await client.execute(query);
      this.corruptedEpochs = result.rows.map((row) => ({
        epochIndex: parseInt(row.epoch_index.toString()),
        note: row.note,
      }));

      if (this.corruptedEpochs.length > 0) {
        console.log(
          `⚠️  Found ${this.corruptedEpochs.length} corrupted epochs (will skip):`,
        );
        this.corruptedEpochs.forEach((e) => {
          console.log(`   - Epoch ${e.epochIndex}: ${e.note}`);
        });
        console.log("");
      }
    } catch (error) {
      console.log("   No corrupted epochs table found\n");
    }
  }

  /**
   * Get gateway state for a specific epoch using pre-computed state table
   * @param {number} epochIndex - The epoch index
   * @param {string} gatewayAddress - The gateway address
   * @returns {Object|null} Gateway state object or null if not found
   */
  async getGatewayStateForEpoch(epochIndex, gatewayAddress) {
    try {
      const query = `
        SELECT * FROM gateway_state_by_epoch 
        WHERE epoch_index = ? AND gateway_address = ?
      `;

      const result = await client.execute(query, [epochIndex, gatewayAddress], {
        prepare: true,
      });

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        autoStake: Boolean(row.auto_stake),
        label: row.label,
        fqdn: row.fqdn,
        port: row.port,
        protocol: row.protocol,
        minDelegatedStake: row.min_delegated_stake,
        delegateRewardShareRatio: row.delegate_reward_share_ratio,
        note: row.note,
        allowDelegatedStaking: Boolean(row.allow_delegated_staking),
        properties: row.properties,
        lastActionTxId: row.last_action_txid,
        lastActionTimestamp: row.last_action_timestamp,
        lastActionType: row.last_action_type,
      };
    } catch (error) {
      console.error(
        `❌ Error getting gateway state for ${gatewayAddress} at epoch ${epochIndex}:`,
        error.message,
      );
      return null;
    }
  }

  /**
   * Process a single epoch's distributions
   * @param {number} epochIndex - The epoch index to process
   * @returns {Object} Statistics about the processing
   */
  async processEpochDistributions(epochIndex) {
    console.log(`\n📊 Processing Epoch ${epochIndex}...`);

    try {
      // Check if epoch is already successfully processed (skip if so, but allow retry if corrupted)
      const checkProcessedQuery = `
        SELECT epoch_index, is_corrupted FROM ario_epochs_processed WHERE epoch_index = ?
      `;
      const checkProcessedResult = await client.execute(
        checkProcessedQuery,
        [epochIndex],
        { prepare: true },
      );

      if (checkProcessedResult.rows.length > 0) {
        const row = checkProcessedResult.rows[0];
        if (!row.is_corrupted) {
          // Already successfully processed - skip
          console.log(
            `   ✅ Epoch ${epochIndex} already processed successfully - skipping`,
          );
          return { processed: 0, skipped: 0, errors: 0 };
        } else {
          // Was marked as corrupted - allow retry
          console.log(
            `   🔄 Epoch ${epochIndex} was previously marked as corrupted - attempting reprocess`,
          );
        }
      }

      // Get distributions for this epoch with retry logic
      let distributions;
      try {
        distributions = await this.retryWithBackoff(
          () => ario.getDistributions({ epochIndex }),
          3, // maxRetries
          1000, // baseDelayMs
          `getDistributions(${epochIndex})`,
        );
      } catch (sdkError) {
        // SDK can fail with JSON parse errors for non-existent or corrupted epochs
        if (
          sdkError.message.includes("not valid JSON") ||
          sdkError.message.includes("undefined")
        ) {
          console.log(
            `   ⚠️  Epoch ${epochIndex} data unavailable (SDK error: ${sdkError.message})`,
          );
          console.log(
            `   ℹ️  This epoch may not exist or have corrupted data - marking as corrupted`,
          );

          // Mark as corrupted (UPDATE is an upsert in Cassandra)
          await client.execute(
            `UPDATE ario_epochs_processed 
             SET is_corrupted = ?, note = ?, created_at = ?
             WHERE epoch_index = ?`,
            [
              true,
              `SDK error: ${sdkError.message}`,
              new Date().toISOString(),
              epochIndex,
            ],
            { prepare: true },
          );
          return { processed: 0, skipped: 0, errors: 0 };
        }
        throw sdkError; // Re-throw other errors
      }

      if (!distributions || !distributions.rewards) {
        console.log(`   ⚠️  No distribution data for epoch ${epochIndex}`);
        return { processed: 0, skipped: 0, errors: 0 };
      }

      const { eligible, distributed } = distributions.rewards;
      const distributionTimestamp = distributions.distributedTimestamp;

      if (!distributionTimestamp) {
        console.log(`   ⚠️  Epoch ${epochIndex} has not been distributed yet`);
        return { processed: 0, skipped: 0, errors: 0 };
      }

      const distributionDate = new Date(distributionTimestamp)
        .toISOString()
        .split("T")[0];

      console.log(
        `   Distribution Timestamp: ${distributionTimestamp} (${distributionDate})`,
      );
      console.log(
        `   Total Distributed: ${distributions.totalDistributedRewards} mARIO`,
      );
      console.log(
        `   Eligible Gateways: ${distributions.totalEligibleGateways}`,
      );

      if (!distributed) {
        console.log(`   ⚠️  No distributed rewards for epoch ${epochIndex}`);
        return { processed: 0, skipped: 0, errors: 0 };
      }

      let processed = 0;
      let skipped = 0;
      let errors = 0;
      let operatorRewards = 0;
      let delegatorRewards = 0;

      // Process each wallet in distributed
      for (const [walletAddress, distributedAmount] of Object.entries(
        distributed,
      )) {
        try {
          // Find all eligible rewards for this wallet
          let eligibleAsOperator = 0;
          let eligibleAsDelegator = 0;
          let operatorGateway = null;
          let operatorAutoStake = false;

          // Check if they're a gateway operator
          if (eligible && eligible[walletAddress]) {
            eligibleAsOperator = eligible[walletAddress].operatorReward || 0;
            operatorGateway = walletAddress;

            // Get pre-computed gateway state for this epoch
            const gatewayState = await this.getGatewayStateForEpoch(
              epochIndex,
              walletAddress,
            );
            operatorAutoStake = gatewayState ? gatewayState.autoStake : true; // Default to staked if not found

            if (!gatewayState) {
              console.log(
                `   ⚠️  No state found for gateway ${walletAddress.substring(
                  0,
                  8,
                )}... at epoch ${epochIndex} - defaulting to staked`,
              );
            }
          }

          // Check if they're a delegator to any gateways
          const delegatorRewardsMap = new Map(); // gatewayAddress -> { amount, autoStake }
          if (eligible) {
            for (const [gatewayAddress, gatewayRewards] of Object.entries(
              eligible,
            )) {
              if (
                gatewayRewards.delegateRewards &&
                gatewayRewards.delegateRewards[walletAddress]
              ) {
                const amount = gatewayRewards.delegateRewards[walletAddress];

                // Get gateway state to determine if delegate rewards are staked
                // (Delegate rewards are always staked, but we check for consistency)
                const gatewayState = await this.getGatewayStateForEpoch(
                  epochIndex,
                  gatewayAddress,
                );

                delegatorRewardsMap.set(gatewayAddress, {
                  amount,
                  autoStake: true, // Delegate rewards are always staked
                });
                eligibleAsDelegator += amount;
              }
            }
          }

          const totalEligible = eligibleAsOperator + eligibleAsDelegator;

          if (totalEligible === 0) {
            console.log(
              `   ⚠️  ${walletAddress.substring(
                0,
                12,
              )}... has distributed ${distributedAmount} but 0 eligible (data inconsistency)`,
            );
            errors++;
            continue;
          }

          // Calculate slashing ratio
          const slashRatio = distributedAmount / totalEligible;

          // Calculate actual amounts (after slashing)
          const actualOperator = Math.floor(eligibleAsOperator * slashRatio);
          const actualDelegator = Math.floor(eligibleAsDelegator * slashRatio);

          // Check if operator reward already exists
          let operatorAlreadyExists = false;
          if (operatorGateway && actualOperator > 0) {
            const checkOperator = await client.execute(
              `SELECT gateway_address FROM ario_operator_rewards 
               WHERE epoch_index = ? 
               AND gateway_address = ?`,
              [epochIndex, operatorGateway],
              { prepare: true },
            );

            if (checkOperator.rows.length > 0) {
              operatorAlreadyExists = true;
            }
          }

          // Store operator reward (if any and not already exists)
          if (actualOperator > 0 && operatorGateway && !operatorAlreadyExists) {
            await client.execute(
              `INSERT INTO ario_operator_rewards (
                epoch_index, gateway_address, operator_wallet, eligible_reward, distributed_reward, is_staked
              ) VALUES (?, ?, ?, ?, ?, ?)`,
              [
                epochIndex,
                operatorGateway,
                operatorGateway, // operator_wallet is same as gateway_address for operators
                eligibleAsOperator.toString(),
                actualOperator.toString(),
                operatorAutoStake,
              ],
              { prepare: true },
            );
            operatorRewards++;
          }

          // Store delegator rewards for each gateway individually
          for (const [gatewayAddress, rewardData] of delegatorRewardsMap) {
            const { amount: eligibleAmount } = rewardData;
            const actualAmount = Math.floor(eligibleAmount * slashRatio);

            if (actualAmount > 0) {
              // Check if already exists
              const checkDelegator = await client.execute(
                `SELECT delegate_wallet FROM ario_delegate_rewards 
                 WHERE epoch_index = ? 
                 AND gateway_address = ? 
                 AND delegate_wallet = ?`,
                [epochIndex, gatewayAddress, walletAddress],
                { prepare: true },
              );

              if (checkDelegator.rows.length === 0) {
                await client.execute(
                  `INSERT INTO ario_delegate_rewards (
                    epoch_index, gateway_address, delegate_wallet, eligible_reward, distributed_reward, is_staked
                  ) VALUES (?, ?, ?, ?, ?, ?)`,
                  [
                    epochIndex,
                    gatewayAddress,
                    walletAddress,
                    eligibleAmount.toString(),
                    actualAmount.toString(),
                    true, // Delegate rewards are always staked
                  ],
                  { prepare: true },
                );
                delegatorRewards++;
              }
            }
          }

          processed++;

          if (processed % 10 === 0) {
            console.log(`   Processed ${processed} wallets...`);
          }
        } catch (error) {
          console.error(
            `   ❌ Error processing wallet ${walletAddress.substring(
              0,
              12,
            )}...:`,
            error.message,
          );
          errors++;
        }
      }

      // Mark epoch as processed (UPDATE is an upsert in Cassandra). Store actual distribution
      // timestamp so report generators can filter by calendar year correctly.
      await client.execute(
        `UPDATE ario_epochs_processed 
         SET is_corrupted = ?, note = ?, created_at = ?, distribution_timestamp = ?
         WHERE epoch_index = ?`,
        [
          false,
          `Processed successfully. ${operatorRewards} operator rewards, ${delegatorRewards} delegate rewards.`,
          new Date().toISOString(),
          distributionTimestamp,
          epochIndex,
        ],
        { prepare: true },
      );

      console.log(`\n   ✅ Epoch ${epochIndex} complete:`);
      console.log(`      Processed: ${processed}`);
      console.log(`      Skipped (duplicates): ${skipped}`);
      console.log(`      Errors: ${errors}`);
      console.log(`      Operator rewards stored: ${operatorRewards}`);
      console.log(`      Delegator rewards stored: ${delegatorRewards}`);

      return { processed, skipped, errors };
    } catch (error) {
      console.error(
        `   ❌ Error processing epoch ${epochIndex}:`,
        error.message,
      );

      // Mark as corrupted if it fails (UPDATE is an upsert in Cassandra)
      await client.execute(
        `UPDATE ario_epochs_processed 
         SET is_corrupted = ?, note = ?, created_at = ?
         WHERE epoch_index = ?`,
        [true, `Error: ${error.message}`, new Date().toISOString(), epochIndex],
        { prepare: true },
      );

      return { processed: 0, skipped: 0, errors: 1 };
    }
  }

  async shutdown() {
    await client.shutdown();
    console.log("\n🔌 Database connection closed");
  }
}

// Main execution method
async function run() {
  try {
    console.log("🚀 Starting ARIO Distribution Indexing...\n");
    console.log(
      "   Using pre-computed gateway state from gateway_state_by_epoch\n",
    );

    const indexer = new ARIODistributionIndexerCassandra();
    await indexer.initialize();

    // Get current epoch
    const currentEpoch = await indexer.retryWithBackoff(
      () => ario.getCurrentEpoch(),
      3,
      1000,
      "getCurrentEpoch()",
    );
    console.log(`📊 Current epoch: ${currentEpoch.epochIndex}\n`);

    let totalProcessed = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    // Process all epochs from 0 to current
    for (
      let epochIndex = 0;
      epochIndex <= currentEpoch.epochIndex;
      epochIndex++
    ) {
      const result = await indexer.processEpochDistributions(epochIndex);
      totalProcessed += result.processed;
      totalSkipped += result.skipped;
      totalErrors += result.errors;

      // Rate limiting between epochs
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    console.log(`\n${"=".repeat(80)}`);
    console.log(`✅ All epochs processed!`);
    console.log(`   Total Processed: ${totalProcessed}`);
    console.log(`   Total Skipped: ${totalSkipped}`);
    console.log(`   Total Errors: ${totalErrors}`);
    console.log(`${"=".repeat(80)}\n`);
  } catch (error) {
    console.error("❌ ARIO Distribution indexing failed:", error);
    throw error; // Re-throw to ensure proper exit code
  } finally {
    if (client) {
      await client.shutdown();
    }
  }
}

// Run the indexer
if (require.main === module) {
  // Graceful shutdown handling
  process.on("SIGINT", async () => {
    console.log("\n⚠️  Received SIGINT, shutting down gracefully...");
    try {
      await client.shutdown();
      console.log("✅ Database connection closed");
    } catch (error) {
      console.error("Error during shutdown:", error.message);
    }
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    console.log("\n⚠️  Received SIGTERM, shutting down gracefully...");
    try {
      await client.shutdown();
      console.log("✅ Database connection closed");
    } catch (error) {
      console.error("Error during shutdown:", error.message);
    }
    process.exit(0);
  });

  run()
    .then(() => {
      console.log("✅ ARIO indexing completed successfully!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("❌ Fatal error:", error);
      process.exit(1);
    });
}

module.exports = ARIODistributionIndexerCassandra;
