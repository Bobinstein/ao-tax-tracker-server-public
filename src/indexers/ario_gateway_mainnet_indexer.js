#!/usr/bin/env node

/**
 * ARIO Gateway Mainnet Indexer
 *
 * This indexer:
 * 1. Imports testnet snapshot as initial state (epoch 0)
 * 2. Queries all mainnet gateway actions via GraphQL
 * 3. Verifies actions using Pushed-For + Action tag method with fallback strategy
 * 4. Builds and stores gateway state for each epoch
 *
 * State Logic:
 * - Gateway state is locked at the start of each epoch
 * - Epoch N state = Epoch N-1 state + valid actions between epoch N-1 start and epoch N start
 * - This pre-computes state, reducing query-time computation
 */

const { Client } = require("cassandra-driver");
const axios = require("axios");
const { ARIO } = require("@ar.io/sdk");
const fs = require("fs");
const path = require("path");

// Configuration
const ARIO_MAINNET_CONTRACT = "qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE";
const GOLDSKY_ENDPOINT = "https://arweave-search.goldsky.com/graphql";

// Database configuration
const client = new Client({
  contactPoints: ["127.0.0.1"],
  localDataCenter: "datacenter1",
  keyspace: "ario_distributions",
});

// Initialize ARIO SDK
const ario = ARIO.mainnet();

class GatewayStateIndexer {
  constructor() {
    this.gatewayState = new Map(); // gateway_address -> state object
    this.allActions = []; // All mainnet gateway actions
    this.lastIndexedEpoch = null; // Track last indexed epoch
    this.isFirstRun = false; // Track if this is initial setup
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
    operationName = "operation"
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
          }): ${error.message}`
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
    await this.detectLastIndexedEpoch();
  }

  async createSchema() {
    console.log("📝 Creating all required schemas...");

    // Create gateway_states table (for snapshot data)
    const createGatewayStatesQuery = `
      CREATE TABLE IF NOT EXISTS gateway_states (
        gateway_address text PRIMARY KEY,
        auto_stake boolean,
        label text,
        fqdn text,
        port text,
        protocol text,
        min_delegated_stake text,
        delegate_reward_share_ratio text,
        note text,
        allow_delegated_staking boolean,
        properties text
      )
    `;
    await client.execute(createGatewayStatesQuery);

    // Create gateway_state_by_epoch table (for pre-computed state)
    const createStateByEpochQuery = `
      CREATE TABLE IF NOT EXISTS gateway_state_by_epoch (
        epoch_index bigint,
        gateway_address text,
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
        last_action_txid text,
        last_action_timestamp text,
        last_action_type text,
        PRIMARY KEY (epoch_index, gateway_address)
      )
    `;
    await client.execute(createStateByEpochQuery);

    console.log("✅ Created all required tables\n");
  }

  async detectLastIndexedEpoch() {
    console.log("🔍 Detecting last indexed epoch...");

    try {
      const query =
        "SELECT MAX(epoch_index) as max_epoch FROM gateway_state_by_epoch";
      const result = await client.execute(query);
      const maxEpoch = result.rows[0]?.max_epoch;

      if (maxEpoch !== null && maxEpoch !== undefined) {
        this.lastIndexedEpoch = parseInt(maxEpoch.toString());
        console.log(`   ✅ Last indexed epoch: ${this.lastIndexedEpoch}\n`);
      } else {
        this.lastIndexedEpoch = null;
        this.isFirstRun = true;
        console.log("   📭 No indexed epochs found - this is the first run\n");
      }
    } catch (error) {
      // Table might not exist yet, that's okay
      this.lastIndexedEpoch = null;
      this.isFirstRun = true;
      console.log("   📭 No indexed epochs found - this is the first run\n");
    }
  }

  async importSnapshotIfNeeded() {
    // Check if snapshot is already imported
    const checkQuery = "SELECT COUNT(*) as count FROM gateway_states";
    const checkResult = await client.execute(checkQuery);
    const count = parseInt(checkResult.rows[0].count.toString());

    if (count > 0) {
      console.log(`✅ Snapshot already imported (${count} gateways)`);
      console.log(
        "   Skipping snapshot import - will load from gateway_states table\n"
      );
      return false;
    }

    console.log("📥 Snapshot table is empty - importing from JSON file...");
    console.log("");

    try {
      // Find the snapshot file
      // From: ao-tax-tracker-server/src/indexers/
      // To:   ao-tax-tracker-server/data/
      const snapshotDir = path.join(__dirname, "..", "..", "data");
      console.log(`   Looking for snapshot files in: ${snapshotDir}`);

      const files = fs
        .readdirSync(snapshotDir)
        .filter((f) => f.startsWith("gateway-snapshot_") && f.endsWith(".json"))
        .sort()
        .reverse(); // Get most recent

      if (files.length === 0) {
        throw new Error(
          `No snapshot file found in ${snapshotDir}. ` +
            `Please place a gateway-snapshot_*.json file there.`
        );
      }

      const snapshotFile = path.join(snapshotDir, files[0]);
      console.log(`   Found snapshot file: ${files[0]}`);
      console.log(`   Reading snapshot: ${files[0]}`);

      const snapshotData = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
      console.log(`   Loaded ${snapshotData.length} gateways from file\n`);

      // Insert all gateways into database
      let importCount = 0;
      const insertQuery = `
        INSERT INTO gateway_states (
          gateway_address, auto_stake, label, fqdn, port, protocol,
          min_delegated_stake, delegate_reward_share_ratio, note,
          allow_delegated_staking, properties
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      for (const gateway of snapshotData) {
        await client.execute(
          insertQuery,
          [
            gateway.gatewayAddress,
            Boolean(gateway.settings?.autoStake ?? true),
            gateway.settings?.label || null,
            gateway.settings?.fqdn || null,
            gateway.settings?.port?.toString() || null,
            gateway.settings?.protocol || null,
            gateway.settings?.minDelegatedStake?.toString() || null,
            gateway.settings?.delegateRewardShareRatio?.toString() || null,
            gateway.settings?.note || null,
            Boolean(gateway.settings?.allowDelegatedStaking ?? false),
            gateway.settings?.properties || null,
          ],
          { prepare: true }
        );
        importCount++;

        // Progress indicator for large imports
        if (importCount % 50 === 0) {
          process.stdout.write(
            `   Importing... ${importCount}/${snapshotData.length}\r`
          );
        }
      }

      console.log(
        `   ✅ Imported ${importCount} gateways from snapshot file\n`
      );
      return true;
    } catch (error) {
      console.error(`❌ Error importing snapshot: ${error.message}`);
      throw error;
    }
  }

  async loadSnapshot() {
    console.log("=".repeat(80));
    console.log("📥 Step 1: Loading initial state");
    console.log("=".repeat(80));
    console.log("");

    if (this.lastIndexedEpoch !== null) {
      // Resume from last indexed epoch
      console.log(
        `   Loading state from epoch ${this.lastIndexedEpoch} (resuming)...`
      );
      await this.loadStateFromEpoch(this.lastIndexedEpoch);
    } else {
      // First run - load from snapshot
      console.log("   Loading state from snapshot (epoch 0)...\n");

      const query = "SELECT * FROM gateway_states";
      const result = await client.execute(query);

      let count = 0;
      for (const row of result.rows) {
        this.gatewayState.set(row.gateway_address, {
          autoStake: row.auto_stake !== null ? Boolean(row.auto_stake) : true,
          label: row.label || null,
          fqdn: row.fqdn || null,
          port: row.port || null,
          protocol: row.protocol || null,
          minDelegatedStake: row.min_delegated_stake || null,
          delegateRewardShareRatio: row.delegate_reward_share_ratio || null,
          note: row.note || null,
          allowDelegatedStaking:
            row.allow_delegated_staking !== null
              ? Boolean(row.allow_delegated_staking)
              : false,
          properties: row.properties || null,
          lastActionTxId: "snapshot",
          lastActionTimestamp: "0",
          lastActionType: "snapshot",
        });
        count++;
      }

      console.log(`✅ Loaded ${count} gateways from snapshot`);
      console.log(`   This represents our initial state (epoch 0)\n`);
    }
  }

  async loadStateFromEpoch(epochIndex) {
    const query = "SELECT * FROM gateway_state_by_epoch WHERE epoch_index = ?";
    const result = await client.execute(query, [epochIndex], {
      prepare: true,
    });

    let count = 0;
    for (const row of result.rows) {
      this.gatewayState.set(row.gateway_address, {
        autoStake: row.auto_stake !== null ? Boolean(row.auto_stake) : true,
        label: row.label || null,
        fqdn: row.fqdn || null,
        port: row.port || null,
        protocol: row.protocol || null,
        minDelegatedStake: row.min_delegated_stake || null,
        delegateRewardShareRatio: row.delegate_reward_share_ratio || null,
        note: row.note || null,
        allowDelegatedStaking:
          row.allow_delegated_staking !== null
            ? Boolean(row.allow_delegated_staking)
            : false,
        properties: row.properties || null,
        lastActionTxId: row.last_action_txid || null,
        lastActionTimestamp: row.last_action_timestamp || null,
        lastActionType: row.last_action_type || null,
      });
      count++;
    }

    console.log(`✅ Loaded ${count} gateways from epoch ${epochIndex} state`);
    console.log(`   Continuing from where we left off\n`);
  }

  async fetchAllActions() {
    console.log("=".repeat(80));
    console.log("📥 Step 2: Fetching mainnet gateway actions");
    console.log("=".repeat(80));
    console.log("");
    console.log("   Fetching only:");
    console.log("   - Join-Network (new gateways with initial settings)");
    console.log(
      "   - Update-Gateway-Settings (setting changes including autoStake)\n"
    );

    let cursor = null;
    let totalActions = 0;

    do {
      // Only fetch Join-Network and Update-Gateway-Settings
      // We don't fetch Leave-Network because leaving gateways won't appear in distributions
      const query = `
        query GetActions($cursor: String) {
          transactions(
            first: 100
            after: $cursor
            recipients: ["${ARIO_MAINNET_CONTRACT}"]
            tags: [
              { name: "Data-Protocol", values: ["ao"] },
              { name: "Type", values: ["Message"] },
              { name: "Action", values: ["Join-Network", "Update-Gateway-Settings"] }
            ]
            sort: HEIGHT_ASC
          ) {
            pageInfo { hasNextPage }
            edges {
              cursor
              node {
                id
                owner { address }
                tags { name value }
                block { height timestamp }
              }
            }
          }
        }
      `;

      try {
        const response = await axios.post(GOLDSKY_ENDPOINT, {
          query,
          variables: { cursor },
        });

        const data = response.data?.data?.transactions;
        if (!data || !data.edges || data.edges.length === 0) break;

        for (const edge of data.edges) {
          const node = edge.node;
          const actionTag = node.tags.find((t) => t.name === "Action");
          const autoStakeTag = node.tags.find((t) => t.name === "Auto-Stake");

          this.allActions.push({
            txId: node.id,
            gatewayAddress: node.owner.address,
            action: actionTag.value,
            blockHeight: node.block.height,
            timestamp: node.block.timestamp * 1000, // Convert to milliseconds
            autoStake:
              autoStakeTag?.value === "true"
                ? true
                : autoStakeTag?.value === "false"
                ? false
                : null,
            tags: node.tags,
          });
          totalActions++;
        }

        cursor =
          data.pageInfo?.hasNextPage && data.edges.length > 0
            ? data.edges[data.edges.length - 1].cursor
            : null;

        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error) {
        console.error(`❌ Error fetching actions: ${error.message}`);
        break;
      }
    } while (cursor);

    console.log(`✅ Fetched ${totalActions} gateway actions\n`);
  }

  async fetchNoticesForActions(actionTxIds) {
    // Query for notices by specific Pushed-For values
    // This is much more efficient and accurate than fetching all notices
    if (actionTxIds.length === 0) {
      return new Map();
    }

    const notices = new Map();

    // Batch queries in groups of 50 TxIDs to avoid query size limits
    const batchSize = 50;
    for (let i = 0; i < actionTxIds.length; i += batchSize) {
      const batch = actionTxIds.slice(i, i + batchSize);

      const query = `
        query {
          transactions(
            tags: [
              { name: "Data-Protocol", values: ["ao"] },
              { name: "Type", values: ["Message"] },
              { name: "Pushed-For", values: ${JSON.stringify(batch)} }
            ]
            first: 100
            sort: HEIGHT_ASC
          ) {
            edges {
              node {
                id
                recipient
                tags { name value }
                block { height timestamp }
              }
            }
          }
        }
      `;

      try {
        const response = await axios.post(GOLDSKY_ENDPOINT, { query });
        const edges = response.data?.data?.transactions?.edges || [];

        for (const edge of edges) {
          const node = edge.node;
          const actionTag = node.tags.find((t) => t.name === "Action");
          const pushedForTag = node.tags.find((t) => t.name === "Pushed-For");
          const errorTag = node.tags.find((t) => t.name === "Error");

          // Only store notices (messages with Action tags ending in -Notice)
          if (actionTag && actionTag.value.endsWith("-Notice")) {
            const noticeInfo = {
              txId: node.id,
              recipient: node.recipient,
              action: actionTag.value,
              pushedFor: pushedForTag?.value || null,
              error: errorTag?.value || null,
              isFailure: actionTag.value.startsWith("Invalid-"),
              blockHeight: node.block.height,
              timestamp: node.block.timestamp * 1000,
            };

            // Index by pushedFor
            if (pushedForTag?.value) {
              notices.set(pushedForTag.value, noticeInfo);
            }
          }
        }

        // Rate limiting between batches
        if (i + batchSize < actionTxIds.length) {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      } catch (error) {
        console.error(
          `   ⚠️  Error fetching notices for batch: ${error.message}`
        );
      }
    }

    return notices;
  }

  async verifyAction(action, notices, epochIndex, previousEpochState) {
    // Find matching notice by Pushed-For tag
    const notice = notices.get(action.txId);

    if (!notice) {
      // No notice found - use fallback verification strategy
      return await this.fallbackVerification(
        action,
        epochIndex,
        previousEpochState
      );
    }

    // Check if action failed
    if (notice.isFailure) {
      return {
        verified: true,
        status: "failed",
        reason: notice.error || "Action failed",
        noticeTxId: notice.txId,
      };
    }

    // Success!
    return {
      verified: true,
      status: "success",
      noticeTxId: notice.txId,
    };
  }

  async fallbackVerification(action, epochIndex, previousEpochState) {
    // For Join-Network actions
    if (action.action === "Join-Network") {
      // Check if gateway already exists in previous epoch state
      if (previousEpochState && previousEpochState.has(action.gatewayAddress)) {
        return {
          verified: false,
          status: "failed",
          reason: "gateway_already_exists_in_previous_epoch",
          treatAsSuccess: false,
        };
      }

      // Check if gateway has rewards in next 3 epochs
      let hasRewards = false;
      for (let i = epochIndex + 1; i <= epochIndex + 3 && i <= 255; i++) {
        try {
          const epochData = await this.retryWithBackoff(
            () => ario.getEpoch({ epochIndex: i }),
            2, // maxRetries (fewer retries for fallback checks)
            500, // baseDelayMs (shorter delay)
            `getEpoch(${i}) for reward check`
          );
          if (epochData?.distributions?.rewards?.[action.gatewayAddress]) {
            hasRewards = true;
            break;
          }
        } catch (error) {
          // Epoch data not available after retries, continue to next epoch
          // This is expected for future epochs that haven't been distributed yet
        }
      }

      if (hasRewards) {
        return {
          verified: false,
          status: "success",
          reason: "has_rewards_in_next_3_epochs",
          treatAsSuccess: true,
        };
      }

      // Cannot determine - default to pass (conservative)
      return {
        verified: false,
        status: "unknown",
        reason: "no_notice_no_rewards_found",
        treatAsSuccess: true,
      };
    }

    // For Update-Gateway-Settings actions
    if (action.action === "Update-Gateway-Settings") {
      // Check if gateway exists in previous epoch state
      const previousState = previousEpochState?.get(action.gatewayAddress);
      if (!previousState) {
        // Gateway doesn't exist - this update is invalid
        return {
          verified: false,
          status: "failed",
          reason: "gateway_not_in_previous_epoch_state",
          treatAsSuccess: false,
        };
      }

      // Check if autoStake is unchanged
      const previousAutoStake = previousState.autoStake;
      const newAutoStake =
        action.autoStake !== null ? action.autoStake : previousAutoStake; // If not specified, assume unchanged

      if (previousAutoStake === newAutoStake) {
        // AutoStake unchanged - can disregard (doesn't affect calculations)
        return {
          verified: false,
          status: "failed",
          reason: "autostake_unchanged_no_impact",
          treatAsSuccess: false,
        };
      }

      // AutoStake changed - flag for further evaluation
      return await this.furtherEvaluation(action, previousState);
    }

    // Unknown action type - default to pass
    return {
      verified: false,
      status: "unknown",
      reason: "unknown_action_type",
      treatAsSuccess: true,
    };
  }

  async furtherEvaluation(action, previousState) {
    try {
      // Get current gateway state from contract
      const currentGateway = await ario.getGateway({
        address: action.gatewayAddress,
      });

      if (!currentGateway) {
        // Gateway doesn't exist in contract - update likely failed
        return {
          verified: false,
          status: "failed",
          reason: "gateway_not_in_current_contract",
          treatAsSuccess: false,
        };
      }

      // Work backwards: check if current state matches what this update would produce
      const expectedAutoStake =
        action.autoStake !== null ? action.autoStake : previousState.autoStake;

      if (currentGateway.settings.autoStake === expectedAutoStake) {
        // Current state matches expected - update likely succeeded
        return {
          verified: false,
          status: "success",
          reason: "current_contract_state_matches_expected",
          treatAsSuccess: true,
        };
      } else {
        // Current state doesn't match - update may have failed or been overridden
        // Default to pass (conservative) but log for review
        return {
          verified: false,
          status: "unknown",
          reason: "current_state_does_not_match_expected",
          treatAsSuccess: true, // Conservative: apply it
        };
      }
    } catch (error) {
      // Error getting gateway - default to pass (conservative)
      return {
        verified: false,
        status: "unknown",
        reason: `error_getting_gateway_state: ${error.message}`,
        treatAsSuccess: true,
      };
    }
  }

  applyAction(gatewayAddress, action) {
    // Get or create gateway state
    let state = this.gatewayState.get(gatewayAddress);
    if (!state) {
      state = {
        autoStake: true, // Default
        label: null,
        fqdn: null,
        port: null,
        protocol: null,
        minDelegatedStake: null,
        delegateRewardShareRatio: null,
        note: null,
        allowDelegatedStaking: false,
        properties: null,
        lastActionTxId: null,
        lastActionTimestamp: null,
        lastActionType: null,
      };
    }

    // Extract settings from action tags
    const tags = action.tags || [];
    const getTagValue = (name) =>
      tags.find((t) => t.name === name)?.value || null;
    const getBooleanValue = (name) => {
      const value = getTagValue(name);
      return value === "true" ? true : value === "false" ? false : null;
    };

    // Update state based on action
    if (
      action.action === "Join-Network" ||
      action.action === "Update-Gateway-Settings"
    ) {
      // Update autoStake if provided
      if (action.autoStake !== null) {
        state.autoStake = action.autoStake;
      }

      // Update other settings if provided
      const label = getTagValue("Label");
      if (label !== null) state.label = label;

      const fqdn = getTagValue("FQDN");
      if (fqdn !== null) state.fqdn = fqdn;

      const port = getTagValue("Port");
      if (port !== null) state.port = port;

      const protocol = getTagValue("Protocol");
      if (protocol !== null) state.protocol = protocol;

      const minDelegatedStake = getTagValue("Min-Delegated-Stake");
      if (minDelegatedStake !== null)
        state.minDelegatedStake = minDelegatedStake;

      const delegateRewardShareRatio = getTagValue(
        "Delegate-Reward-Share-Ratio"
      );
      if (delegateRewardShareRatio !== null)
        state.delegateRewardShareRatio = delegateRewardShareRatio;

      const note = getTagValue("Note");
      if (note !== null) state.note = note;

      const allowDelegatedStaking = getBooleanValue("Allow-Delegated-Staking");
      if (allowDelegatedStaking !== null)
        state.allowDelegatedStaking = allowDelegatedStaking;

      const properties = getTagValue("Properties");
      if (properties !== null) state.properties = properties;

      // Update last action info
      state.lastActionTxId = action.txId;
      state.lastActionTimestamp = String(action.timestamp);
      state.lastActionType = action.action;
    }

    this.gatewayState.set(gatewayAddress, state);
  }

  async buildEpochStates(startEpoch = 0, endEpoch = null) {
    console.log("=".repeat(80));
    console.log("📊 Step 4: Building gateway state for each epoch");
    console.log("=".repeat(80));
    console.log("");

    // Get current epoch
    const currentEpochData = await ario.getCurrentEpoch();
    const latestEpochIndex = currentEpochData.epochIndex;

    if (endEpoch === null) {
      endEpoch = latestEpochIndex;
    }

    if (startEpoch > endEpoch) {
      startEpoch =
        this.lastIndexedEpoch !== null ? this.lastIndexedEpoch + 1 : 0;
    }

    console.log(`   Building states for epochs ${startEpoch} to ${endEpoch}`);
    console.log(`   Current epoch: ${latestEpochIndex}\n`);

    if (startEpoch > endEpoch) {
      console.log("   ✅ All epochs already indexed - nothing to do!");
      return;
    }

    let successfulActions = 0;
    let failedActions = 0;
    let unknownActions = 0;
    const allUnverifiedActions = []; // Track all unverified for final report

    let lastValidEpochIndex = null;
    let skippedEpochs = [];

    for (let epochIndex = startEpoch; epochIndex <= endEpoch; epochIndex++) {
      try {
        console.log(`\n📅 Processing Epoch ${epochIndex}...`);

        // Try to get epoch data with retry logic
        let currentEpoch;
        try {
          currentEpoch = await this.retryWithBackoff(
            () => ario.getEpoch({ epochIndex }),
            3, // maxRetries
            1000, // baseDelayMs (1 second)
            `getEpoch(${epochIndex})`
          );
        } catch (error) {
          // Epoch data missing (network issue, corrupted, etc.)
          console.log(
            `   ⚠️  Epoch ${epochIndex} data not available after retries: ${error.message}`
          );
          console.log(
            `   Skipping epoch ${epochIndex} - no distribution data exists`
          );
          skippedEpochs.push(epochIndex);
          continue; // Skip this epoch entirely
        }

        // Get next epoch for boundary with retry logic
        let nextEpoch = null;
        if (epochIndex < latestEpochIndex) {
          try {
            nextEpoch = await this.retryWithBackoff(
              () => ario.getEpoch({ epochIndex: epochIndex + 1 }),
              3, // maxRetries
              1000, // baseDelayMs
              `getEpoch(${epochIndex + 1})`
            );
          } catch (error) {
            // If next epoch fetch fails, we'll use current time as boundary
            console.log(
              `   ⚠️  Could not fetch next epoch ${
                epochIndex + 1
              }, using current time as boundary`
            );
            nextEpoch = null;
          }
        }

        const epochStartMs = currentEpoch.startTimestamp;
        const epochEndMs = nextEpoch ? nextEpoch.startTimestamp : Date.now();

        console.log(`   Start: ${new Date(epochStartMs).toISOString()}`);
        if (nextEpoch) {
          console.log(`   End: ${new Date(epochEndMs).toISOString()}`);
        }

        // If we're resuming after skipped epochs, use actions from last valid epoch start
        let actionStartMs = epochStartMs;

        if (skippedEpochs.length > 0 && lastValidEpochIndex !== null) {
          try {
            const lastValidEpoch = await this.retryWithBackoff(
              () => ario.getEpoch({ epochIndex: lastValidEpochIndex }),
              3, // maxRetries
              1000, // baseDelayMs
              `getEpoch(${lastValidEpochIndex}) for skipped epoch recovery`
            );
            actionStartMs = lastValidEpoch.startTimestamp;
          } catch (error) {
            // If we can't fetch the last valid epoch, use current epoch start
            console.log(
              `   ⚠️  Could not fetch last valid epoch ${lastValidEpochIndex}, using current epoch start`
            );
            actionStartMs = epochStartMs;
          }

          console.log(
            `   📝 Applying actions from epoch ${lastValidEpochIndex} start (${new Date(
              actionStartMs
            ).toISOString()})`
          );
          console.log(
            `   (Skipped epochs ${skippedEpochs.join(
              ", "
            )} had no distribution data)`
          );

          skippedEpochs = []; // Reset for next gap
        }

        // Find actions in this time range
        const actionsInEpoch = this.allActions.filter(
          (a) => a.timestamp >= actionStartMs && a.timestamp < epochEndMs
        );

        console.log(
          `   Found ${actionsInEpoch.length} action(s) in time range`
        );

        // Fetch notices for these specific actions
        const actionTxIds = actionsInEpoch.map((a) => a.txId);
        console.log(`   Fetching notices for verification...`);
        const epochNotices = await this.fetchNoticesForActions(actionTxIds);
        console.log(
          `   ✅ Found ${epochNotices.size}/${actionTxIds.length} notices`
        );

        // Create snapshot of previous epoch state for fallback verification
        const previousEpochState = new Map(this.gatewayState);

        // Track unverified actions for detailed logging
        const unverifiedDetails = [];

        // Apply each action
        for (const action of actionsInEpoch) {
          const verification = await this.verifyAction(
            action,
            epochNotices,
            epochIndex,
            previousEpochState
          );

          if (verification.status === "success") {
            this.applyAction(action.gatewayAddress, action);
            successfulActions++;
            const reason = verification.verified
              ? ""
              : ` (fallback: ${verification.reason})`;
            console.log(
              `     ✅ Applied: ${
                action.action
              } for ${action.gatewayAddress.substring(0, 8)}...${reason}`
            );
          } else if (verification.status === "failed") {
            failedActions++;
            const reason = verification.verified
              ? ""
              : ` (fallback: ${verification.reason})`;
            console.log(
              `     ❌ Skipped (failed): ${
                action.action
              } for ${action.gatewayAddress.substring(0, 8)}...${reason}`
            );
          } else if (verification.treatAsSuccess) {
            // Unknown status but treating as success (conservative approach)
            this.applyAction(action.gatewayAddress, action);
            unknownActions++;

            // Store details for later analysis
            const detail = {
              epochIndex,
              txId: action.txId,
              action: action.action,
              gateway: action.gatewayAddress,
              blockHeight: action.blockHeight,
              timestamp: new Date(action.timestamp).toISOString(),
              reason: verification.reason,
            };
            unverifiedDetails.push(detail);
            allUnverifiedActions.push(detail);

            // Only log if verbose mode or first few
            if (unknownActions <= 5) {
              console.log(
                `     ⚠️  Applied (unverified): ${
                  action.action
                } for ${action.gatewayAddress.substring(0, 8)}... (${
                  verification.reason
                })`
              );
            }
          } else {
            unknownActions++;
            console.log(
              `     ⚠️  Skipped (unknown): ${
                action.action
              } for ${action.gatewayAddress.substring(0, 8)}... (${
                verification.reason
              })`
            );
          }
        }

        // Log unverified action details for this epoch
        if (unverifiedDetails.length > 0) {
          console.log(
            `\n   ⚠️  ${unverifiedDetails.length} unverified action(s) in epoch ${epochIndex}:`
          );
          unverifiedDetails.forEach((detail, idx) => {
            if (idx < 3) {
              // Show first 3 in detail
              console.log(`      ${idx + 1}. ${detail.action}`);
              console.log(`         TxID: ${detail.txId}`);
              console.log(`         Gateway: ${detail.gateway}`);
              console.log(`         Block: ${detail.blockHeight}`);
              console.log(`         Time: ${detail.timestamp}`);
              if (detail.reason) {
                console.log(`         Reason: ${detail.reason}`);
              }
            }
          });
          if (unverifiedDetails.length > 3) {
            console.log(`      ... and ${unverifiedDetails.length - 3} more`);
          }
        }

        // Store state for this epoch
        await this.storeEpochState(epochIndex);
        console.log(`   ✅ Stored state for epoch ${epochIndex}`);

        // Track this as last valid epoch for gap handling
        lastValidEpochIndex = epochIndex;

        // Rate limiting
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        console.error(
          `   ❌ Error processing epoch ${epochIndex}: ${error.message}`
        );
      }
    }

    // Print summary
    console.log("\n" + "=".repeat(80));
    console.log("📊 State Building Summary");
    console.log("=".repeat(80));
    console.log(`   Total actions: ${this.allActions.length}`);
    console.log(`   Successful actions applied: ${successfulActions}`);
    console.log(`   Failed actions skipped: ${failedActions}`);
    console.log(`   Unknown status actions: ${unknownActions}`);
    console.log(`   Total gateways in final state: ${this.gatewayState.size}`);

    // Calculate verification rate
    const totalActionsTaken =
      successfulActions + failedActions + unknownActions;
    const verifiedActions = successfulActions + failedActions;
    const verificationRate =
      totalActionsTaken > 0
        ? ((verifiedActions / totalActionsTaken) * 100).toFixed(1)
        : 0;

    console.log(`\n   Verification rate: ${verificationRate}%`);
    console.log(
      `   (${verifiedActions}/${totalActionsTaken} actions verified)`
    );

    // Warn if verification rate is low
    if (verificationRate < 50) {
      console.log("\n" + "=".repeat(80));
      console.log("⚠️  WARNING: LOW VERIFICATION RATE DETECTED!");
      console.log("=".repeat(80));
      console.log(
        "   More than 50% of actions could not be verified with notices."
      );
      console.log("   This may indicate:");
      console.log("   - GraphQL query limitations (pagination, rate limits)");
      console.log("   - Missing notice messages for older actions");
      console.log("   - Internal AO messages not stored on Arweave");
      console.log(
        "\n   State accuracy may be compromised. Consider manual verification."
      );
      console.log("=".repeat(80));
    } else if (verificationRate < 90) {
      console.log(
        `\n💡 INFO: ~${(100 - verificationRate).toFixed(
          1
        )}% of actions could not be verified`
      );
      console.log(
        "   These were treated as successful (conservative approach)."
      );
    } else {
      console.log(
        "\n✅ Excellent verification rate! State should be highly accurate."
      );
    }
  }

  async storeEpochState(epochIndex) {
    const insertQuery = `
      INSERT INTO gateway_state_by_epoch (
        epoch_index, gateway_address, auto_stake, label, fqdn, port, protocol,
        min_delegated_stake, delegate_reward_share_ratio, note,
        allow_delegated_staking, properties, last_action_txid,
        last_action_timestamp, last_action_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    for (const [gatewayAddress, state] of this.gatewayState) {
      await client.execute(
        insertQuery,
        [
          epochIndex,
          gatewayAddress,
          Boolean(state.autoStake),
          state.label,
          state.fqdn,
          state.port,
          state.protocol,
          state.minDelegatedStake,
          state.delegateRewardShareRatio,
          state.note,
          Boolean(state.allowDelegatedStaking),
          state.properties,
          state.lastActionTxId,
          state.lastActionTimestamp,
          state.lastActionType,
        ],
        { prepare: true }
      );
    }
  }

  async shutdown() {
    await client.shutdown();
  }
}

// Main execution
async function indexGatewayActions() {
  try {
    console.log("🚀 Starting ARIO gateway mainnet indexing...");
    console.log(`   Contract: ${ARIO_MAINNET_CONTRACT}`);
    console.log("   Actions: Join-Network, Update-Gateway-Settings\n");

    const indexer = new GatewayStateIndexer();
    await indexer.initialize();

    // Import snapshot if needed (first run only)
    await indexer.importSnapshotIfNeeded();

    // Load snapshot from database
    await indexer.loadSnapshot();

    // Fetch all actions (notices will be fetched per-epoch for accuracy)
    await indexer.fetchAllActions();

    // Build epoch states (will auto-detect range if needed)
    await indexer.buildEpochStates();

    console.log("\n" + "=".repeat(80));
    console.log("✅ INDEXING COMPLETE!");
    console.log("=".repeat(80));
  } catch (error) {
    console.error("\n❌ Fatal error:", error);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await client.shutdown();
    console.log("\n🔌 Database connection closed");
  }
}

// Run the indexer
indexGatewayActions().catch(console.error);
