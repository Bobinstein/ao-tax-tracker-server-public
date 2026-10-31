const { Client } = require("cassandra-driver");

// Database configuration
const client = new Client({
  contactPoints: ["127.0.0.1"],
  localDataCenter: "datacenter1",
  keyspace: "ario_distributions",
});

async function buildGatewayState() {
  try {
    console.log("🏗️ Building gateway state for specific epoch...");

    // Connect to database
    await client.connect();
    console.log("✅ Connected to Cassandra database");

    // Get target block height from command line argument
    const targetBlockHeight = parseInt(process.argv[2]);
    if (!targetBlockHeight || isNaN(targetBlockHeight)) {
      console.log("❌ Please provide a target block height as argument");
      console.log("Usage: node build-gateway-state.js <block_height>");
      process.exit(1);
    }

    console.log(`🎯 Building state for block height: ${targetBlockHeight}`);

    // Step 1: Load the initial snapshot state
    console.log("📸 Loading initial gateway snapshot...");
    const snapshotResult = await client.execute("SELECT * FROM gateway_states");
    console.log(`📊 Found ${snapshotResult.rows.length} gateways in snapshot`);

    // Initialize gateway states from snapshot
    const gatewayStates = {};
    snapshotResult.rows.forEach((gateway) => {
      gatewayStates[gateway.gateway_address] = {
        gatewayAddress: gateway.gateway_address,
        autoStake: gateway.auto_stake,
        label: gateway.label,
        fqdn: gateway.fqdn,
        port: gateway.port,
        protocol: gateway.protocol,
        minDelegatedStake: gateway.min_delegated_stake,
        delegateRewardShareRatio: gateway.delegate_reward_share_ratio,
        note: gateway.note,
        allowDelegatedStaking: gateway.allow_delegated_staking,
        properties: gateway.properties,
        lastActionBlock: 0,
        lastActionType: "snapshot",
        source: "snapshot",
      };
    });

    // Step 2: Get all gateway actions up to the target block height
    console.log("🔄 Loading gateway actions...");
    const actionsResult = await client.execute(
      "SELECT * FROM gateway_actions WHERE block_height <= ? ALLOW FILTERING",
      [targetBlockHeight]
    );

    console.log(
      `📊 Found ${actionsResult.rows.length} actions up to block ${targetBlockHeight}`
    );

    // Sort actions by gateway address and block height
    const sortedActions = actionsResult.rows.sort((a, b) => {
      if (a.gateway_address !== b.gateway_address) {
        return a.gateway_address.localeCompare(b.gateway_address);
      }
      return a.block_height - b.block_height;
    });

    // Step 3: Apply actions chronologically to build state
    console.log("🔨 Applying actions to build state...");
    sortedActions.forEach((action) => {
      const gatewayAddress = action.gateway_address;

      // If gateway not in snapshot, initialize it (new gateway that joined after mainnet)
      if (!gatewayStates[gatewayAddress]) {
        gatewayStates[gatewayAddress] = {
          gatewayAddress,
          autoStake: null,
          label: null,
          fqdn: null,
          port: null,
          protocol: null,
          minDelegatedStake: null,
          delegateRewardShareRatio: null,
          note: null,
          allowDelegatedStaking: null,
          properties: null,
          lastActionBlock: 0,
          lastActionType: null,
          source: "actions",
        };
      }

      // Update state based on action
      if (
        action.action === "Join-Network" ||
        action.action === "Update-Gateway-Settings"
      ) {
        // Update all provided settings
        if (action.auto_stake !== null) {
          gatewayStates[gatewayAddress].autoStake = action.auto_stake;
        }
        if (action.label !== null) {
          gatewayStates[gatewayAddress].label = action.label;
        }
        if (action.fqdn !== null) {
          gatewayStates[gatewayAddress].fqdn = action.fqdn;
        }
        if (action.port !== null) {
          gatewayStates[gatewayAddress].port = action.port;
        }
        if (action.protocol !== null) {
          gatewayStates[gatewayAddress].protocol = action.protocol;
        }
        if (action.min_delegated_stake !== null) {
          gatewayStates[gatewayAddress].minDelegatedStake =
            action.min_delegated_stake;
        }
        if (action.delegate_reward_share_ratio !== null) {
          gatewayStates[gatewayAddress].delegateRewardShareRatio =
            action.delegate_reward_share_ratio;
        }
        if (action.note !== null) {
          gatewayStates[gatewayAddress].note = action.note;
        }
        if (action.allow_delegated_staking !== null) {
          gatewayStates[gatewayAddress].allowDelegatedStaking =
            action.allow_delegated_staking;
        }
        if (action.properties !== null) {
          gatewayStates[gatewayAddress].properties = action.properties;
        }

        gatewayStates[gatewayAddress].lastActionBlock = action.block_height;
        gatewayStates[gatewayAddress].lastActionType = action.action;
      }
    });

    // Display results
    const gatewayCount = Object.keys(gatewayStates).length;
    console.log(`\n📊 Gateway States at Block ${targetBlockHeight}:`);
    console.log(`   Total gateways: ${gatewayCount}`);

    // Count auto-stake statistics
    let autoStakeTrue = 0;
    let autoStakeFalse = 0;
    let autoStakeUnknown = 0;
    let fromSnapshot = 0;
    let fromActions = 0;

    Object.values(gatewayStates).forEach((gateway) => {
      if (gateway.autoStake === true) autoStakeTrue++;
      else if (gateway.autoStake === false) autoStakeFalse++;
      else autoStakeUnknown++;

      if (gateway.source === "snapshot") fromSnapshot++;
      else if (gateway.source === "actions") fromActions++;
    });

    console.log(`\n📈 Auto-Stake Statistics:`);
    console.log(`   Auto-Stake: true: ${autoStakeTrue} gateways`);
    console.log(`   Auto-Stake: false: ${autoStakeFalse} gateways`);
    console.log(`   Auto-Stake: unknown: ${autoStakeUnknown} gateways`);

    console.log(`\n📊 Data Sources:`);
    console.log(`   From snapshot: ${fromSnapshot} gateways`);
    console.log(`   From actions: ${fromActions} gateways`);

    // Show sample gateways
    console.log(`\n📋 Sample Gateway States:`);
    const sampleGateways = Object.values(gatewayStates).slice(0, 10);
    sampleGateways.forEach((gateway, index) => {
      console.log(`   ${index + 1}. ${gateway.gatewayAddress}`);
      console.log(`      Label: ${gateway.label || "Unknown"}`);
      console.log(
        `      Auto-Stake: ${
          gateway.autoStake !== null ? gateway.autoStake : "Unknown"
        }`
      );
      console.log(`      FQDN: ${gateway.fqdn || "Unknown"}`);
      console.log(`      Source: ${gateway.source}`);
      console.log(
        `      Last Action: ${gateway.lastActionType} (Block ${gateway.lastActionBlock})`
      );
      console.log("");
    });

    // Query specific gateway if provided
    const targetGateway = process.argv[3];
    if (targetGateway) {
      console.log(`\n🎯 Specific Gateway State: ${targetGateway}`);
      const gateway = gatewayStates[targetGateway];

      if (gateway) {
        console.log(`   Gateway Address: ${gateway.gatewayAddress}`);
        console.log(`   Label: ${gateway.label || "Unknown"}`);
        console.log(`   FQDN: ${gateway.fqdn || "Unknown"}`);
        console.log(
          `   Auto-Stake: ${
            gateway.autoStake !== null ? gateway.autoStake : "Unknown"
          }`
        );
        console.log(`   Port: ${gateway.port || "Unknown"}`);
        console.log(`   Protocol: ${gateway.protocol || "Unknown"}`);
        console.log(
          `   Min Delegated Stake: ${gateway.minDelegatedStake || "Unknown"}`
        );
        console.log(
          `   Delegate Reward Share: ${
            gateway.delegateRewardShareRatio || "Unknown"
          }%`
        );
        console.log(
          `   Allow Delegated Staking: ${
            gateway.allowDelegatedStaking !== null
              ? gateway.allowDelegatedStaking
              : "Unknown"
          }`
        );
        console.log(`   Note: ${gateway.note || "None"}`);
        console.log(
          `   Last Action: ${gateway.lastActionType} (Block ${gateway.lastActionBlock})`
        );
      } else {
        console.log(`   ❌ Gateway not found: ${targetGateway}`);
      }
    }
  } catch (error) {
    console.error("❌ Error building gateway state:", error);
  } finally {
    await client.shutdown();
    console.log("🔌 Database connection closed");
  }
}

// Run the state builder
buildGatewayState().catch(console.error);
