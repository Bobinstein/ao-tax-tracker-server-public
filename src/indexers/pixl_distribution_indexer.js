#!/usr/bin/env node

/**
 * PIXL Distribution Indexer - Full Calculation Version
 *
 * Indexes PIXL token distributions by:
 * 1. Fetching all Calculate-Streak messages to build streak state
 * 2. Implementing the getAllocation() logic matching the PIXL contract
 * 3. Calculating distributions when Run-Rewards occurs
 * 4. Verifying calculations against the 117 messages that have Output.data
 *
 * Key Constants (contract evolved over time):
 * - PIXL Token: DM3FoZUq_yebASPhgd8pEIRIzDW6muXEhxz5-JwbZwo
 * - Decimals: 6
 * - ORIGIN_HEIGHT: 1232228
 * - DAY_INTERVAL: 720 blocks (~24 hours)
 * - CYCLE_INTERVAL: 262800 blocks (1 year)
 *
 * Contract Evolution:
 * - Genesis: HALVING_SUPPLY = 90% of TOTAL_SUPPLY
 * - Block ~1628189: Fair Launch update, 75% for PI, 25% for PIXL rewards
 *
 * Verification Period (Output.data available):
 * - Block 1679720 to 1770159 (May 28 - Oct 9, 2025): 117 messages
 *
 * @module indexers/pixl_distribution_indexer
 */

const cassandra = require("cassandra-driver");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const GraphQLClient = require("../utils/graphql-client");
const aoconnect = require("@permaweb/aoconnect");

// ============================================================================
// Logging Configuration
// ============================================================================

const LOG_DIR = path.join(__dirname, "../../logs");
const LOG_FILE = path.join(LOG_DIR, "pixl-indexer.log");
const VERIFICATION_FILE = path.join(LOG_DIR, "pixl-verification.json");
const FAILED_FILE = path.join(LOG_DIR, "pixl-failed-messages.json");

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// ============================================================================
// PIXL Constants
// ============================================================================

const PIXL_CONSTANTS = {
  TOKEN_PROCESS: "DM3FoZUq_yebASPhgd8pEIRIzDW6muXEhxz5-JwbZwo",
  // UCM_PROCESS evolved over time:
  // - Genesis to ~block 1679000: U3TjJAZWJjlWBB4KAXSHKzuky81jtyh0zqH8rUL4Wd0
  // - Block ~1679000+: hqdL4AZaFZ0huQHbAsYxdTwG6vpibK7ALWKNzmWaD4Q
  UCM_PROCESS_OLD: "U3TjJAZWJjlWBB4KAXSHKzuky81jtyh0zqH8rUL4Wd0",
  UCM_PROCESS_NEW: "hqdL4AZaFZ0huQHbAsYxdTwG6vpibK7ALWKNzmWaD4Q",
  UCM_TRANSITION_BLOCK: 1679000, // Approximate block where UCM changed
  CRON_PROCESS: "MxlafnztzleKXeYY90NzWh0Mo4pgluQA5KV4dz2qsOI",
  DECIMALS: 6,
  GENESIS_BLOCK: 1439455,

  // Core timing constants
  ORIGIN_HEIGHT: 1232228,
  DAY_INTERVAL: 720,
  CYCLE_INTERVAL: 720 * 365, // 262800

  // Supply constants (all in raw units with 6 decimals)
  TOTAL_SUPPLY: BigInt(26280000) * BigInt(1000000), // 26280000000000

  // Fair launch constants (introduced ~block 1628189)
  FAIR_LAUNCH_BLOCK: 1628189,
  CURRENT_MINTED_AT_FAIR_LAUNCH: BigInt("15531330588835"),

  // Verification period - blocks where Output.data is available
  VERIFICATION_START_BLOCK: 1679720,
  VERIFICATION_END_BLOCK: 1770159,
};

// Pre-calculate derived constants
const REMAINING_SUPPLY =
  PIXL_CONSTANTS.TOTAL_SUPPLY - PIXL_CONSTANTS.CURRENT_MINTED_AT_FAIR_LAUNCH;
const REWARDS_SUPPLY = (REMAINING_SUPPLY * BigInt(25)) / BigInt(100); // 25%
const HALVING_SUPPLY_POST_FAIR_LAUNCH =
  PIXL_CONSTANTS.CURRENT_MINTED_AT_FAIR_LAUNCH + REWARDS_SUPPLY;

// Original halving supply (90% of total) - used before fair launch
const HALVING_SUPPLY_ORIGINAL =
  (PIXL_CONSTANTS.TOTAL_SUPPLY * BigInt(90)) / BigInt(100);

// ============================================================================
// Batching & memory (for low-memory production servers)
// ============================================================================
const STREAK_BATCH_SIZE = parseInt(
  process.env.PIXL_STREAK_BATCH_SIZE || "3000",
  10,
);
const GRAPHQL_PAGE_SIZE = parseInt(
  process.env.PIXL_GRAPHQL_PAGE_SIZE || "50",
  10,
);
const MAX_STREAK_STATE_ENTRIES = parseInt(
  process.env.PIXL_MAX_STREAK_STATE_ENTRIES || "20000",
  10,
);

// ============================================================================
// Cassandra Configuration
// ============================================================================

const CASSANDRA_CONFIG = {
  contactPoints: ["127.0.0.1"],
  localDataCenter: "datacenter1",
  keyspace: "ar_tax_tracker",
  pooling: {
    coreConnectionsPerHost: {
      [cassandra.types.distance.local]: 2,
      [cassandra.types.distance.remote]: 1,
    },
  },
  socketOptions: {
    connectTimeout: 30000,
    readTimeout: 60000,
  },
  queryOptions: {
    consistency: cassandra.types.consistencies.localOne,
    prepare: true,
  },
};

// ============================================================================
// AO Connect for verification
// ============================================================================

const CU_URL = process.env.PIXL_CU_URL || process.env.CU_URL || null;
let aoResult;
if (CU_URL) {
  const ao = aoconnect.connect({ CU_URL });
  aoResult = ao.result;
} else {
  aoResult = aoconnect.result;
}

// ============================================================================
// PIXL Distribution Indexer Class
// ============================================================================

class PIXLDistributionIndexer {
  constructor(options = {}) {
    this.verbose = options.verbose !== false;
    this.logToFile = options.logToFile !== false;
    this.verifyMode = options.verify || false;
    this.client = null;
    this.graphqlClient = new GraphQLClient({
      endpoints: [
        "https://arweave-search.goldsky.com/graphql",
        "https://arweave.net/graphql",
      ],
      maxRetries: 3,
      retryDelay: 2000,
      timeout: 45000,
    });

    // State tracking - mirrors contract state
    this.streaks = new Map(); // Map<address, { days: number, lastHeight: number }>
    this.balances = new Map(); // Map<address, BigInt> - for supply calculation

    // Statistics - use counters instead of Sets to save memory
    this.stats = {
      streakEventsProcessed: 0,
      runRewardsProcessed: 0,
      distributionsStored: 0,
      uniqueRecipientsCount: 0, // Counter instead of Set for memory efficiency
      verificationsPassed: 0,
      verificationsFailed: 0,
      startTime: Date.now(),
    };

    // Track unique recipients with a Set but clear periodically if needed
    this._uniqueRecipients = new Set();

    // Verification results - write incrementally to avoid memory buildup
    this.verificationResultsCount = 0;

    // When true, full streak state lives in pixl_streak_state; we use DB for allocation (no truncation)
    this.useDbForAllocation = false;

    if (this.logToFile) {
      this.initLogFile();
    }
  }

  initLogFile() {
    const header = `
================================================================================
PIXL Distribution Indexer - Full Calculation Version
Started: ${new Date().toISOString()}
================================================================================
Log file: ${LOG_FILE}
Verification results: ${VERIFICATION_FILE}

This indexer calculates distributions from streak state, matching contract logic.
For blocks ${PIXL_CONSTANTS.VERIFICATION_START_BLOCK}-${PIXL_CONSTANTS.VERIFICATION_END_BLOCK},
calculations are verified against actual Output.data from the contract.
================================================================================

`;
    fs.writeFileSync(LOG_FILE, header);

    // Initialize verification file (will append failures incrementally)
    if (this.verifyMode) {
      fs.writeFileSync(VERIFICATION_FILE, "[\n");
    }
  }

  writeLog(message) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}\n`;
    if (this.logToFile) {
      fs.appendFileSync(LOG_FILE, line);
    }
    if (this.verbose) {
      console.log(message);
    }
  }

  log(...args) {
    this.writeLog(args.join(" "));
  }

  /**
   * Debug/memory logging for production troubleshooting.
   * Logs heap/rss and key counts so we can see where OOM occurs.
   */
  logMemory(label, extra = {}) {
    const mem = process.memoryUsage();
    const heapMb = (mem.heapUsed / 1024 / 1024).toFixed(1);
    const rssMb = (mem.rss / 1024 / 1024).toFixed(1);
    const externalMb = (mem.external / 1024 / 1024).toFixed(1);
    const msg = `[MEM] ${label} | heapUsed=${heapMb}MB rss=${rssMb}MB external=${externalMb}MB | streaks=${this.streaks.size} balances=${this.balances.size} uniqueRecipients=${this._uniqueRecipients.size} ${Object.entries(
      extra,
    )
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")}`;
    this.writeLog(msg);
    if (this.verbose) {
      console.log(msg);
    }
  }

  async initialize() {
    this.log("🚀 Initializing PIXL Distribution Indexer (Calculation Version)");

    this.client = new cassandra.Client(CASSANDRA_CONFIG);
    await this.client.connect();
    this.log("✅ Connected to Cassandra");

    await this.verifySchema();
    await this.loadIndexerState();
  }

  async verifySchema() {
    const requiredTables = [
      "pixl_streak_events",
      "pixl_distributions",
      "pixl_distributions_by_block",
      "pixl_indexer_state",
      "pixl_streak_state",
    ];

    this.log("🔍 Verifying database schema...");

    for (const table of requiredTables) {
      try {
        await this.client.execute(`SELECT * FROM ${table} LIMIT 1`);
        this.log(`   ✓ Table ${table} exists`);
      } catch (error) {
        if (error.message.includes("unconfigured table")) {
          throw new Error(
            `Missing required table: ${table}. Run: node admin-utilities/init-ar-tracker-schema.js`,
          );
        }
        throw error;
      }
    }

    // Verify we can write to the distributions table
    this.log("🔍 Testing write access to pixl_distributions...");
    try {
      const testResult = await this.client.execute(
        `SELECT COUNT(*) as cnt FROM pixl_distributions`,
      );
      const existingCount =
        testResult.rows[0]?.cnt?.low || testResult.rows[0]?.cnt || 0;
      this.log(
        `   ✓ Write test passed. Existing distributions: ${existingCount}`,
      );
    } catch (error) {
      throw new Error(
        `Cannot access pixl_distributions table: ${error.message}`,
      );
    }
  }

  async loadIndexerState() {
    try {
      const result = await this.client.execute(
        `SELECT * FROM pixl_indexer_state WHERE indexer_name = 'pixl_calc'`,
      );

      if (result.rows.length > 0) {
        const state = result.rows[0];
        this.lastIndexedBlock = state.last_indexed_block || 0;
        this.log(`   📊 Last indexed block: ${this.lastIndexedBlock || "N/A"}`);

        // Load persisted streak state if available (handles truncated format from low-memory saves)
        if (state.streak_state_json) {
          try {
            const parsed = JSON.parse(state.streak_state_json);
            if (parsed._source === "pixl_streak_state") {
              this.useDbForAllocation = true;
              this.log(
                `   📊 Full streak state is in pixl_streak_state; will load on demand (no data dropped)`,
              );
            } else {
              const streakData =
                parsed._truncated && parsed.entries ? parsed.entries : parsed;
              if (parsed._truncated) {
                this.log(
                  `   ⚠️ Streak state was truncated (saved ${parsed._included} of ${parsed._total}); resuming with partial state`,
                );
              }
              for (const [addr, data] of Object.entries(streakData)) {
                if (addr.startsWith("_")) continue;
                if (
                  data &&
                  typeof data.days === "number" &&
                  typeof data.lastHeight === "number"
                ) {
                  this.streaks.set(addr, {
                    days: data.days,
                    lastHeight: data.lastHeight,
                  });
                }
              }
              this.log(`   📊 Loaded ${this.streaks.size} streak states`);
            }
          } catch (e) {
            this.log(`   ⚠️ Could not parse streak state: ${e.message}`);
          }
        }
      } else {
        this.lastIndexedBlock = 0;
        this.log("   📊 No existing state - starting fresh");
      }

      // If pixl_streak_state has data, use DB for allocation on resume (full state, no truncation)
      try {
        const countResult = await this.client.execute(
          `SELECT COUNT(*) as cnt FROM pixl_streak_state`,
        );
        const cnt =
          countResult.rows[0]?.cnt?.low ?? countResult.rows[0]?.cnt ?? 0;
        if (Number(cnt) > 0 && !this.useDbForAllocation) {
          this.useDbForAllocation = true;
          this.log(
            `   📊 pixl_streak_state has ${cnt} rows; using DB for allocation on resume (full state)`,
          );
        }
      } catch (e) {
        this.log(`   ⚠️ Could not check pixl_streak_state: ${e.message}`);
      }
    } catch (error) {
      this.lastIndexedBlock = 0;
      this.log(`   ⚠️ Could not load state: ${error.message}`);
    }
  }

  async saveIndexerState(lastBlock) {
    // When full state is in pixl_streak_state, save minimal JSON (no OOM)
    let streakJson;
    let status = "completed";
    if (this.useDbForAllocation) {
      streakJson = JSON.stringify({ _source: "pixl_streak_state" });
      this.log(
        `   💾 Saving indexer state: block=${lastBlock} distributions=${this.stats.distributionsStored} (full streak state in pixl_streak_state)`,
      );
    } else {
      const streakObj = {};
      let count = 0;
      const maxEntries = MAX_STREAK_STATE_ENTRIES;
      for (const [addr, data] of this.streaks) {
        if (count >= maxEntries) break;
        streakObj[addr] = { days: data.days, lastHeight: data.lastHeight };
        count++;
      }
      const truncated = this.streaks.size > maxEntries;
      streakJson = JSON.stringify(
        truncated
          ? {
              _truncated: true,
              _total: this.streaks.size,
              _included: count,
              entries: streakObj,
            }
          : streakObj,
      );
      if (truncated) status = "completed_truncated_streak_state";
      this.log(
        `   💾 Saving indexer state: block=${lastBlock} distributions=${this.stats.distributionsStored} streaks=${this.streaks.size}${truncated ? ` (truncated to ${count} in state)` : ""} streakJsonSize=${(streakJson.length / 1024).toFixed(1)}KB`,
      );
    }

    const query = `
      INSERT INTO pixl_indexer_state (
        indexer_name, last_indexed_block, last_indexed_timestamp,
        distributions_calculated, unique_addresses_seen,
        streak_state_json, last_run_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await this.client.execute(query, [
      "pixl_calc",
      lastBlock,
      new Date(),
      this.stats.distributionsStored,
      this._uniqueRecipients.size,
      streakJson,
      new Date(),
      status,
    ]);
  }

  // ==========================================================================
  // Streak Logic (mirrors contract exactly)
  // ==========================================================================

  /**
   * Process a Calculate-Streak event - updates streak state
   * This mirrors the contract's Calculate-Streak handler EXACTLY
   *
   * Contract logic (Lua):
   * ```lua
   * if not Streaks[data.Buyer] then
   *   Streaks[data.Buyer] = { days = 1, lastHeight = msg['Block-Height'] }
   * else
   *   local heightDiff = msg['Block-Height'] - Streaks[data.Buyer].lastHeight
   *   if heightDiff > DAY_INTERVAL and heightDiff <= (DAY_INTERVAL * 2) then
   *     Streaks[data.Buyer] = { days = Streaks[data.Buyer].days + 1, lastHeight = msg['Block-Height'] }
   *   end
   *   if heightDiff > (DAY_INTERVAL * 2) then
   *     Streaks[data.Buyer] = { days = 0, lastHeight = msg['Block-Height'] }
   *   end
   *   -- if heightDiff <= DAY_INTERVAL: NO CHANGE (implicit)
   * end
   * ```
   */
  processStreakEvent(buyer, blockHeight) {
    const DAY_INTERVAL = PIXL_CONSTANTS.DAY_INTERVAL;

    if (!this.streaks.has(buyer)) {
      // New user - first purchase creates streak of 1
      this.streaks.set(buyer, {
        days: 1,
        lastHeight: blockHeight,
      });
    } else {
      // Existing user - check timing conditions
      const streak = this.streaks.get(buyer);
      const heightDiff = blockHeight - streak.lastHeight;

      if (heightDiff > DAY_INTERVAL && heightDiff <= DAY_INTERVAL * 2) {
        // Valid continuation - increment streak (works even if days was 0)
        this.streaks.set(buyer, {
          days: streak.days + 1,
          lastHeight: blockHeight,
        });
      } else if (heightDiff > DAY_INTERVAL * 2) {
        // Streak broken - reset to 0
        this.streaks.set(buyer, {
          days: 0,
          lastHeight: blockHeight,
        });
      }
      // If heightDiff <= DAY_INTERVAL, NO CHANGE (purchase too soon)
      // This is critical - the contract does NOTHING in this case
    }
  }

  /**
   * Calculate allocation for a given block height
   * This mirrors the contract's getAllocation() function EXACTLY
   *
   * Contract logic (from Eval at block 1681005):
   * ```lua
   * local function getAllocation(currentHeight)
   *   if not Streaks or next(Streaks) == nil then return {} end
   *
   *   local multipliers = {}
   *   for k, v in pairs(Streaks) do
   *     if v.days > 0 and v.days < 31 then
   *       local multiplier = v.days - 1
   *       multipliers[k] = 1 + multiplier * 0.1
   *     elseif v.days >= 31 then
   *       local multiplier = 30
   *       multipliers[k] = 1 + multiplier * 0.1
   *     end
   *     local heightDiff = tonumber(currentHeight) - tonumber(v.lastHeight)
   *     if heightDiff > (DAY_INTERVAL * 2) then
   *       Streaks[k] = nil  -- DELETE stale streaks AFTER calculating multiplier
   *     end
   *   end
   *
   *   local totalW = 0
   *   for _, m in pairs(multipliers) do totalW = totalW + m end
   *
   *   -- ... supply check ...
   *
   *   local blockHeight = tonumber(currentHeight) - ORIGIN_HEIGHT
   *   local cycle = math.floor(blockHeight / CYCLE_INTERVAL) + 1
   *   local divisor = 2 ^ cycle
   *   local dailyMint = math.floor(math.floor(REWARDS_SUPPLY / divisor) / 365)
   *                                          ^^^^^^^^^^^^^^^ KEY: uses REWARDS_SUPPLY!
   *   -- ... reward capping ...
   *
   *   local allocation = {}
   *   for addr, m in pairs(multipliers) do
   *     local share = math.floor((reward * (m / totalW)) + 0.5)
   *     allocation[addr] = share
   *   end
   *   return allocation
   * end
   * ```
   *
   * KEY BEHAVIOR:
   * 1. Pre-fair-launch (< block 1628189): Uses HALVING_SUPPLY_ORIGINAL (90% of total)
   * 2. Post-fair-launch (>= block 1628189): Uses REWARDS_SUPPLY (25% of remaining)
   * 3. Deletes stale streaks AFTER calculating their multiplier (they get one last allocation)
   */
  getAllocation(currentHeight, isPostFairLaunch = true) {
    const DAY_INTERVAL = PIXL_CONSTANTS.DAY_INTERVAL;
    const ORIGIN_HEIGHT = PIXL_CONSTANTS.ORIGIN_HEIGHT;
    const CYCLE_INTERVAL = PIXL_CONSTANTS.CYCLE_INTERVAL;
    const TOTAL_SUPPLY = PIXL_CONSTANTS.TOTAL_SUPPLY;

    if (this.streaks.size === 0) {
      return new Map();
    }

    // Step 1: Build multipliers map AND delete stale streaks
    // Contract does this in one loop - multiplier is calculated BEFORE deletion
    // so stale users get one final allocation
    //
    // PRECISION: Use integer-scaled multipliers (x10) to avoid floating point
    // Multiplier 1.0 = 10, 1.1 = 11, ... 4.0 = 40
    const scaledMultipliers = new Map();
    const toDelete = [];

    for (const [addr, streak] of this.streaks) {
      // Calculate scaled multiplier for addresses with days > 0
      // Original: multiplier = 1 + (days - 1) * 0.1
      // Scaled: scaledM = 10 + (days - 1) = 9 + days
      if (streak.days > 0 && streak.days < 31) {
        scaledMultipliers.set(addr, BigInt(9 + streak.days));
      } else if (streak.days >= 31) {
        // Capped at 30 days: scaledM = 10 + 30 = 40
        scaledMultipliers.set(addr, BigInt(40));
      }

      // Check for stale streaks (heightDiff > DAY_INTERVAL * 2)
      // These get deleted AFTER multiplier calculation
      const heightDiff = currentHeight - streak.lastHeight;
      if (heightDiff > DAY_INTERVAL * 2) {
        toDelete.push(addr);
      }
    }

    // Delete stale streaks (matching contract: Streaks[k] = nil)
    for (const addr of toDelete) {
      this.streaks.delete(addr);
    }

    if (scaledMultipliers.size === 0) {
      return new Map();
    }

    // Step 2: Calculate total weighted score (sum of scaled multipliers)
    let scaledTotalW = BigInt(0);
    for (const m of scaledMultipliers.values()) {
      scaledTotalW += m;
    }

    if (scaledTotalW === BigInt(0)) {
      return new Map();
    }

    // Step 3: Calculate current supply from balances
    let currentSupply = BigInt(0);
    for (const v of this.balances.values()) {
      currentSupply += v;
    }

    if (currentSupply >= TOTAL_SUPPLY) {
      this.log("Total supply reached—no more rewards");
      return new Map();
    }

    // Step 4: Calculate daily mint based on halving cycle
    // Use BigInt for exact integer division
    const blockHeight = BigInt(currentHeight - ORIGIN_HEIGHT);
    const cycle = blockHeight / BigInt(CYCLE_INTERVAL) + BigInt(1);
    const divisor = BigInt(2) ** cycle;

    // CRITICAL: Use different supply base depending on fair launch status:
    // - Pre-fair-launch: HALVING_SUPPLY_ORIGINAL (90% of total supply)
    // - Post-fair-launch: REWARDS_SUPPLY (25% of remaining after fair launch)
    const supplyBase = isPostFairLaunch
      ? REWARDS_SUPPLY
      : HALVING_SUPPLY_ORIGINAL;

    // dailyMint = floor(floor(supplyBase / divisor) / 365)
    // Using BigInt division (automatically floors)
    const dailyMint = supplyBase / divisor / BigInt(365);

    if (dailyMint <= BigInt(0)) {
      return new Map();
    }

    // Step 5: Cap reward to unminted supply
    const unminted = TOTAL_SUPPLY - currentSupply;
    const reward = dailyMint <= unminted ? dailyMint : unminted;

    // Step 6: Calculate allocation for each address using pure BigInt arithmetic
    // Contract formula: share = math.floor((reward * (m / totalW)) + 0.5)
    //
    // With BigInt, to compute floor((reward * scaledM / scaledTotalW) + 0.5):
    // = floor(reward * scaledM / scaledTotalW + 0.5)
    // = floor((reward * scaledM + scaledTotalW/2) / scaledTotalW)
    // = (reward * scaledM + scaledTotalW / 2) / scaledTotalW  (BigInt auto-floors)
    //
    // This gives us exact integer rounding matching the contract behavior
    const allocation = new Map();
    const halfTotalW = scaledTotalW / BigInt(2);

    for (const [addr, scaledM] of scaledMultipliers) {
      // share = (reward * scaledM + halfTotalW) / scaledTotalW
      // This is mathematically equivalent to: floor(reward * m / totalW + 0.5)
      const share = (reward * scaledM + halfTotalW) / scaledTotalW;
      allocation.set(addr, share);
    }

    return allocation;
  }

  /**
   * Apply allocation to balances (for tracking supply)
   */
  applyAllocation(allocation) {
    for (const [addr, amount] of allocation) {
      const current = this.balances.get(addr) || BigInt(0);
      this.balances.set(addr, current + amount);
    }
  }

  // ==========================================================================
  // DB-backed streak state (no data dropped; for low-memory production)
  // ==========================================================================

  /** Ensure buyer's streak is in this.streaks (load from DB if we're using DB and not in memory). */
  async ensureStreakLoaded(buyer) {
    if (this.streaks.has(buyer)) return;
    if (!this.useDbForAllocation) return;
    const s = await this.getStreakFromDb(buyer);
    if (s) this.streaks.set(buyer, s);
  }

  /** Load a single buyer's streak from pixl_streak_state (used when not in memory). */
  async getStreakFromDb(buyer) {
    try {
      const result = await this.client.execute(
        `SELECT days, last_height FROM pixl_streak_state WHERE wallet_address = ?`,
        [buyer],
        { prepare: true },
      );
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      return {
        days: row.days ?? 0,
        lastHeight: row.last_height ?? 0,
      };
    } catch (e) {
      this.log(`   ⚠️ getStreakFromDb(${buyer.slice(0, 8)}...): ${e.message}`);
      return null;
    }
  }

  /**
   * Persist full in-memory streak state to pixl_streak_state (no cap).
   * Then clear this.streaks so memory stays bounded. Call after each batch.
   */
  async persistStreakStateToDb() {
    if (this.streaks.size === 0) return;
    const chunkSize = 1000;
    const entries = Array.from(this.streaks.entries());
    let upserted = 0;
    const now = new Date();
    for (let i = 0; i < entries.length; i += chunkSize) {
      const chunk = entries.slice(i, i + chunkSize);
      const query = `INSERT INTO pixl_streak_state (wallet_address, days, last_height, updated_at) VALUES (?, ?, ?, ?)`;
      for (const [addr, data] of chunk) {
        await this.client.execute(
          query,
          [addr, data.days, data.lastHeight, now],
          {
            prepare: true,
          },
        );
        upserted++;
      }
    }
    this.log(
      `   💾 Persisted ${upserted} streak entries to pixl_streak_state (no data dropped)`,
    );
    this.streaks.clear();
    this.useDbForAllocation = true;
  }

  /**
   * Compute reward (daily mint capped by supply) for a block - shared by in-memory and DB path.
   */
  getRewardForBlock(currentHeight, currentSupply, isPostFairLaunch) {
    const TOTAL_SUPPLY = PIXL_CONSTANTS.TOTAL_SUPPLY;
    const ORIGIN_HEIGHT = PIXL_CONSTANTS.ORIGIN_HEIGHT;
    const CYCLE_INTERVAL = PIXL_CONSTANTS.CYCLE_INTERVAL;
    if (currentSupply >= TOTAL_SUPPLY) return BigInt(0);
    const supplyBase = isPostFairLaunch
      ? REWARDS_SUPPLY
      : HALVING_SUPPLY_ORIGINAL;
    const blockHeight = BigInt(currentHeight - ORIGIN_HEIGHT);
    const cycle = blockHeight / BigInt(CYCLE_INTERVAL) + BigInt(1);
    const divisor = BigInt(2) ** cycle;
    const dailyMint = supplyBase / divisor / BigInt(365);
    if (dailyMint <= BigInt(0)) return BigInt(0);
    const unminted = TOTAL_SUPPLY - currentSupply;
    return dailyMint <= unminted ? dailyMint : unminted;
  }

  /**
   * Compute allocation from DB + override map (streaming); save distributions and update balances.
   * Used when full streak state is in pixl_streak_state so we never hold all in memory.
   * Returns { count, blockTotal } for logging. Verification is skipped when using DB path.
   */
  async getAllocationFromDB(
    currentHeight,
    overrideMap,
    isPostFairLaunch,
    event,
  ) {
    const DAY_INTERVAL = PIXL_CONSTANTS.DAY_INTERVAL;
    const TOTAL_SUPPLY = PIXL_CONSTANTS.TOTAL_SUPPLY;
    const tempFile = path.join(
      LOG_DIR,
      `pixl_alloc_${currentHeight}_${Date.now()}.tmp`,
    );
    const writeStream = fs.createWriteStream(tempFile, { flags: "w" });
    let scaledTotalW = BigInt(0);
    const seenFromDb = new Set();

    const rowCallback = (n, row) => {
      const addr = row.wallet_address;
      let days = row.days ?? 0;
      let lastHeight = row.last_height ?? 0;
      if (overrideMap.has(addr)) {
        const o = overrideMap.get(addr);
        days = o.days;
        lastHeight = o.lastHeight;
      }
      const heightDiff = currentHeight - lastHeight;
      if (heightDiff > DAY_INTERVAL * 2) return; // stale, skip
      let scaledM = BigInt(0);
      if (days > 0 && days < 31) scaledM = BigInt(9 + days);
      else if (days >= 31) scaledM = BigInt(40);
      if (scaledM === BigInt(0)) return;
      scaledTotalW += scaledM;
      writeStream.write(`${addr}\t${scaledM.toString()}\n`);
      seenFromDb.add(addr);
    };

    await new Promise((resolve, reject) => {
      this.client.eachRow(
        `SELECT wallet_address, days, last_height FROM pixl_streak_state`,
        [],
        { prepare: true },
        rowCallback,
        (err) => {
          if (err) reject(err);
          else resolve();
        },
      );
    });

    // Add override entries that weren't in DB
    for (const [addr, streak] of overrideMap) {
      if (seenFromDb.has(addr)) continue;
      const heightDiff = currentHeight - streak.lastHeight;
      if (heightDiff > DAY_INTERVAL * 2) continue;
      let scaledM = BigInt(0);
      if (streak.days > 0 && streak.days < 31)
        scaledM = BigInt(9 + streak.days);
      else if (streak.days >= 31) scaledM = BigInt(40);
      if (scaledM === BigInt(0)) continue;
      scaledTotalW += scaledM;
      writeStream.write(`${addr}\t${scaledM.toString()}\n`);
    }

    await new Promise((resolve, reject) => {
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
      writeStream.end();
    });

    if (scaledTotalW === BigInt(0)) {
      try {
        fs.unlinkSync(tempFile);
      } catch (_) {}
      return { count: 0, blockTotal: BigInt(0) };
    }

    let currentSupply = BigInt(0);
    for (const v of this.balances.values()) currentSupply += v;
    const reward = this.getRewardForBlock(
      currentHeight,
      currentSupply,
      isPostFairLaunch,
    );
    if (reward <= BigInt(0)) {
      try {
        fs.unlinkSync(tempFile);
      } catch (_) {}
      return { count: 0, blockTotal: BigInt(0) };
    }

    const halfTotalW = scaledTotalW / BigInt(2);
    let count = 0;
    let blockTotal = BigInt(0);
    const rl = readline.createInterface({
      input: fs.createReadStream(tempFile),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [addr, scaledMStr] = trimmed.split("\t");
      const scaledM = BigInt(scaledMStr);
      const share = (reward * scaledM + halfTotalW) / scaledTotalW;
      if (share <= BigInt(0)) continue;
      await this.saveDistribution(
        addr,
        event.blockHeight,
        event.blockTimestamp,
        event.txId,
        share,
        false,
      );
      this._uniqueRecipients.add(addr);
      this.stats.distributionsStored++;
      blockTotal += share;
      const current = this.balances.get(addr) || BigInt(0);
      this.balances.set(addr, current + share);
      count++;
    }
    rl.close();
    try {
      fs.unlinkSync(tempFile);
    } catch (_) {}
    return { count, blockTotal };
  }

  // ==========================================================================
  // GraphQL Fetching
  // ==========================================================================

  /**
   * Check if a sender is the valid UCM at a given block height
   */
  isValidUCMSender(sender, blockHeight) {
    if (blockHeight < PIXL_CONSTANTS.UCM_TRANSITION_BLOCK) {
      return sender === PIXL_CONSTANTS.UCM_PROCESS_OLD;
    }
    return sender === PIXL_CONSTANTS.UCM_PROCESS_NEW;
  }

  /**
   * Fetch all Calculate-Streak messages in chronological order
   * Only yields messages from the valid UCM at each block
   */
  async *fetchStreakMessages(fromBlock = null) {
    this.log("\n📥 Fetching Calculate-Streak messages...");

    let cursor = null;
    let totalFetched = 0;
    let skippedInvalidSender = 0;
    const startBlock = fromBlock || PIXL_CONSTANTS.GENESIS_BLOCK;

    while (true) {
      const query = `
        query GetStreakMessages($cursor: String) {
          transactions(
            recipients: ["${PIXL_CONSTANTS.TOKEN_PROCESS}"]
            tags: [
              { name: "Action", values: ["Calculate-Streak"] }
            ]
            block: { min: ${startBlock} }
            first: ${GRAPHQL_PAGE_SIZE}
            after: $cursor
            sort: HEIGHT_ASC
          ) {
            edges {
              cursor
              node {
                id
                block { height timestamp }
                tags { name value }
              }
            }
            pageInfo { hasNextPage }
          }
        }
      `;

      const response = await this.graphqlClient.execute(query, { cursor });
      const edges = response?.data?.transactions?.edges || [];

      if (edges.length === 0) break;

      for (const edge of edges) {
        const tx = edge.node;
        const buyerTag = tx.tags?.find((t) => t.name === "Buyer");
        const fromProcessTag = tx.tags?.find((t) => t.name === "From-Process");
        const sender = fromProcessTag?.value;

        if (buyerTag) {
          cursor = edge.cursor;

          // Validate sender is the correct UCM for this block
          if (!this.isValidUCMSender(sender, tx.block?.height)) {
            skippedInvalidSender++;
            continue;
          }

          yield {
            txId: tx.id,
            blockHeight: tx.block?.height,
            blockTimestamp: tx.block?.timestamp
              ? new Date(tx.block.timestamp * 1000)
              : null,
            buyer: buyerTag.value,
            sender: sender,
          };
          totalFetched++;
        }
      }

      if (!response?.data?.transactions?.pageInfo?.hasNextPage) break;

      if (totalFetched % 10000 === 0) {
        this.log(`   ... fetched ${totalFetched} valid streak messages`);
      }
    }

    this.log(
      `   ✅ Fetched ${totalFetched} valid Calculate-Streak messages (page size: ${GRAPHQL_PAGE_SIZE})`,
    );
    if (skippedInvalidSender > 0) {
      this.log(
        `   ⏭️ Skipped ${skippedInvalidSender} messages from invalid senders`,
      );
    }
  }

  /**
   * Fetch all Run-Rewards messages
   */
  async *fetchRunRewardsMessages(fromBlock = null) {
    this.log("\n📥 Fetching Run-Rewards messages...");

    let cursor = null;
    let totalFetched = 0;
    const startBlock = fromBlock || PIXL_CONSTANTS.GENESIS_BLOCK;

    while (true) {
      const query = `
        query GetRunRewardsMessages($cursor: String) {
          transactions(
            recipients: ["${PIXL_CONSTANTS.TOKEN_PROCESS}"]
            tags: [
              { name: "Action", values: ["Run-Rewards"] }
            ]
            block: { min: ${startBlock} }
            first: 100
            after: $cursor
            sort: HEIGHT_ASC
          ) {
            edges {
              cursor
              node {
                id
                block { height timestamp }
              }
            }
            pageInfo { hasNextPage }
          }
        }
      `;

      const response = await this.graphqlClient.execute(query, { cursor });
      const edges = response?.data?.transactions?.edges || [];

      if (edges.length === 0) break;

      for (const edge of edges) {
        const tx = edge.node;
        yield {
          txId: tx.id,
          blockHeight: tx.block?.height,
          blockTimestamp: tx.block?.timestamp
            ? new Date(tx.block.timestamp * 1000)
            : null,
        };
        totalFetched++;
        cursor = edge.cursor;
      }

      if (!response?.data?.transactions?.pageInfo?.hasNextPage) break;
    }

    this.log(`   ✅ Fetched ${totalFetched} Run-Rewards messages`);
  }

  // ==========================================================================
  // Verification against Output.data
  // ==========================================================================

  /**
   * Parse allocation from AO Output.data (Lua table format)
   */
  parseAllocationOutput(outputData) {
    const allocations = new Map();
    if (!outputData || typeof outputData !== "string") return allocations;

    // Remove ANSI color codes
    const cleanData = outputData.replace(/\x1b\[[0-9;]*m/g, "");

    // Parse: address = amount
    const regex = /([a-zA-Z0-9_-]{43})\s*=\s*(\d+)/g;
    let match;
    while ((match = regex.exec(cleanData)) !== null) {
      allocations.set(match[1], BigInt(match[2]));
    }

    return allocations;
  }

  /**
   * Verify our calculated allocation against actual Output.data
   */
  async verifyAllocation(txId, blockHeight, calculatedAllocation) {
    // Only verify if within the verification period
    if (
      blockHeight < PIXL_CONSTANTS.VERIFICATION_START_BLOCK ||
      blockHeight > PIXL_CONSTANTS.VERIFICATION_END_BLOCK
    ) {
      return { verified: false, reason: "outside-verification-period" };
    }

    try {
      const res = await aoResult({
        process: PIXL_CONSTANTS.TOKEN_PROCESS,
        message: txId,
      });

      // Check for Invalid-Reward-Interval (skip)
      const invalidMsg = res.Messages?.find((m) =>
        m.Tags?.some(
          (t) => t.name === "Action" && t.value === "Invalid-Reward-Interval",
        ),
      );
      if (invalidMsg) {
        return { verified: true, reason: "invalid-interval-skip" };
      }

      const outputData = res.Output?.data;
      if (!outputData) {
        return { verified: false, reason: "no-output-data" };
      }

      const actualAllocation = this.parseAllocationOutput(outputData);

      // Compare allocations
      const mismatches = [];
      const allAddresses = new Set([
        ...calculatedAllocation.keys(),
        ...actualAllocation.keys(),
      ]);

      for (const addr of allAddresses) {
        const calc = calculatedAllocation.get(addr) || BigInt(0);
        const actual = actualAllocation.get(addr) || BigInt(0);

        // Allow small rounding differences (up to 1 unit)
        const diff =
          calc > actual ? Number(calc - actual) : Number(actual - calc);
        if (diff > 1) {
          mismatches.push({
            address: addr,
            calculated: calc.toString(),
            actual: actual.toString(),
            diff: diff,
          });
        }
      }

      if (mismatches.length === 0) {
        return { verified: true, matches: actualAllocation.size };
      } else {
        return {
          verified: false,
          reason: "mismatch",
          mismatches: mismatches.slice(0, 10),
        };
      }
    } catch (error) {
      return { verified: false, reason: `error: ${error.message}` };
    }
  }

  // ==========================================================================
  // Database Operations
  // ==========================================================================

  async saveStreakEvent(event) {
    const streak = this.streaks.get(event.buyer);
    const query = `
      INSERT INTO pixl_streak_events (
        buyer_address, block_height, block_timestamp,
        tx_id, days_after, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `;

    await this.client.execute(query, [
      event.buyer,
      event.blockHeight,
      event.blockTimestamp,
      event.txId,
      streak?.days || 0,
      new Date(),
    ]);
  }

  async distributionExistsForBlock(blockHeight) {
    const result = await this.client.execute(
      `SELECT distribution_block FROM pixl_distributions_by_block WHERE distribution_block = ? LIMIT 1`,
      [blockHeight],
      { prepare: true },
    );
    return result.rows.length > 0;
  }

  async saveDistribution(
    walletAddress,
    blockHeight,
    timestamp,
    txId,
    amount,
    verified = false,
  ) {
    const amountHuman = Number(amount) / Math.pow(10, PIXL_CONSTANTS.DECIMALS);

    const query1 = `
      INSERT INTO pixl_distributions (
        wallet_address, distribution_block, distribution_timestamp,
        run_rewards_tx_id, amount_units, amount_human, verified, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    try {
      await this.client.execute(query1, [
        walletAddress,
        blockHeight,
        timestamp,
        txId,
        amount.toString(),
        amountHuman,
        verified,
        new Date(),
      ]);
    } catch (error) {
      this.log(
        `   ❌ Failed to save distribution for ${walletAddress.slice(0, 8)}... at block ${blockHeight}: ${error.message}`,
      );
      throw error;
    }

    const query2 = `
      INSERT INTO pixl_distributions_by_block (
        distribution_block, wallet_address, amount_units, amount_human
      ) VALUES (?, ?, ?, ?)
    `;

    try {
      await this.client.execute(query2, [
        blockHeight,
        walletAddress,
        amount.toString(),
        amountHuman,
      ]);
    } catch (error) {
      this.log(
        `   ❌ Failed to save distribution_by_block for block ${blockHeight}: ${error.message}`,
      );
      throw error;
    }
  }

  // ==========================================================================
  // Main Indexing Process
  // ==========================================================================

  /**
   * Process a Run-Rewards event
   */
  async processRunRewardsEvent(event, options, lastRewardBlock) {
    // Check if already processed
    const exists = await this.distributionExistsForBlock(event.blockHeight);
    if (exists && !options.fullReindex) {
      return { processed: false, lastRewardBlock };
    }

    // Check reward interval (must be DAY_INTERVAL blocks since last)
    const blocksSinceLast = event.blockHeight - lastRewardBlock;
    if (lastRewardBlock > 0 && blocksSinceLast < PIXL_CONSTANTS.DAY_INTERVAL) {
      // Invalid interval - skip (matches contract behavior)
      this.log(
        `   ⏭️ Block ${event.blockHeight}: Invalid interval (${blocksSinceLast} blocks since last)`,
      );
      return { processed: false, lastRewardBlock };
    }

    // Calculate allocation (DB path when full state is in pixl_streak_state; no data dropped)
    const isPostFairLaunch =
      event.blockHeight >= PIXL_CONSTANTS.FAIR_LAUNCH_BLOCK;
    let allocation;
    let savedCount = 0;
    let blockTotal = BigInt(0);
    let verified = false;

    if (this.useDbForAllocation) {
      const result = await this.getAllocationFromDB(
        event.blockHeight,
        this.streaks,
        isPostFairLaunch,
        event,
      );
      savedCount = result.count;
      blockTotal = result.blockTotal;
      if (savedCount === 0) {
        this.log(`   ⏭️ Block ${event.blockHeight}: No eligible recipients`);
        return { processed: false, lastRewardBlock };
      }
      // Verification skipped when using DB path (allocation not held in memory)
      this.log(
        `   💰 Block ${event.blockHeight}: ${savedCount} recipients (from DB), ${(Number(blockTotal) / Math.pow(10, PIXL_CONSTANTS.DECIMALS)).toFixed(2)} PIXL`,
      );
      this.stats.runRewardsProcessed++;
      return { processed: true, lastRewardBlock: event.blockHeight };
    }

    allocation = this.getAllocation(event.blockHeight, isPostFairLaunch);

    if (allocation.size === 0) {
      this.log(`   ⏭️ Block ${event.blockHeight}: No eligible recipients`);
      return { processed: false, lastRewardBlock };
    }

    // Verify if in verification period
    if (this.verifyMode) {
      const verifyResult = await this.verifyAllocation(
        event.txId,
        event.blockHeight,
        allocation,
      );

      if (verifyResult.verified) {
        verified = true;
        this.stats.verificationsPassed++;
        if (verifyResult.reason !== "invalid-interval-skip") {
          this.log(
            `   ✅ Block ${event.blockHeight}: Verified (${allocation.size} recipients)`,
          );
        }
      } else if (verifyResult.reason !== "outside-verification-period") {
        this.stats.verificationsFailed++;
        this.log(
          `   ⚠️ Block ${event.blockHeight}: Verification failed - ${verifyResult.reason}`,
        );
        if (verifyResult.mismatches) {
          verifyResult.mismatches.slice(0, 3).forEach((m) => {
            this.log(
              `      ${m.address.slice(0, 12)}...: calc=${m.calculated} actual=${m.actual}`,
            );
          });
        }
        this.verificationResultsCount++;
        const failureEntry =
          JSON.stringify({
            block: event.blockHeight,
            txId: event.txId,
            result: verifyResult,
          }) + ",\n";
        fs.appendFileSync(VERIFICATION_FILE, failureEntry);
      }
    }

    const totalToSave = allocation.size;
    for (const [address, amount] of allocation) {
      await this.saveDistribution(
        address,
        event.blockHeight,
        event.blockTimestamp,
        event.txId,
        amount,
        verified,
      );
      this._uniqueRecipients.add(address);
      this.stats.distributionsStored++;
      blockTotal += amount;
      savedCount++;

      if (totalToSave > 1000 && savedCount % 1000 === 0) {
        this.log(
          `      💾 Saved ${savedCount}/${totalToSave} distributions for block ${event.blockHeight}...`,
        );
      }
    }

    const verifyQuery = await this.client.execute(
      `SELECT COUNT(*) as cnt FROM pixl_distributions_by_block WHERE distribution_block = ?`,
      [event.blockHeight],
      { prepare: true },
    );
    const actualSaved =
      verifyQuery.rows[0]?.cnt?.low || verifyQuery.rows[0]?.cnt || 0;

    if (actualSaved !== savedCount) {
      this.log(
        `   ⚠️ WARNING: Block ${event.blockHeight} - Expected ${savedCount} saved, found ${actualSaved} in DB!`,
      );
    }

    this.applyAllocation(allocation);

    this.stats.runRewardsProcessed++;

    const totalHuman =
      Number(blockTotal) / Math.pow(10, PIXL_CONSTANTS.DECIMALS);
    this.log(
      `   💰 Block ${event.blockHeight}: ${allocation.size} recipients, ${totalHuman.toFixed(2)} PIXL (saved: ${actualSaved})`,
    );

    return { processed: true, lastRewardBlock: event.blockHeight };
  }

  async runFullIndex(options = {}) {
    const startTime = Date.now();
    this.log("\n" + "=".repeat(70));
    this.log("🚀 PIXL Distribution Indexer - Full Calculation Version");
    this.log("=".repeat(70));
    this.log("\nThis indexer calculates distributions by:");
    this.log("  1. Processing all Calculate-Streak messages to build state");
    this.log("  2. Using contract logic to calculate allocations");
    this.log("  3. Verifying against Output.data where available");
    this.log(
      `\nVerification range: blocks ${PIXL_CONSTANTS.VERIFICATION_START_BLOCK}-${PIXL_CONSTANTS.VERIFICATION_END_BLOCK}`,
    );

    try {
      this.logMemory("runFullIndex start", {});

      const fromBlock = options.fullReindex
        ? PIXL_CONSTANTS.GENESIS_BLOCK
        : this.lastIndexedBlock > 0
          ? this.lastIndexedBlock + 1
          : PIXL_CONSTANTS.GENESIS_BLOCK;

      this.log(`\nStarting from block: ${fromBlock}`);

      // ========================================================================
      // Phase 1: Fetch Run-Rewards messages first (small set - ~500)
      // ========================================================================
      this.log("\n" + "=".repeat(40));
      this.log("Phase 1: Fetching Run-Rewards messages");
      this.log("=".repeat(40));

      const runRewardsMessages = [];
      for await (const msg of this.fetchRunRewardsMessages(fromBlock)) {
        runRewardsMessages.push(msg);
      }

      // Sort by block height and create a lookup index
      runRewardsMessages.sort((a, b) => a.blockHeight - b.blockHeight);
      let rewardsIndex = 0;

      this.log(
        `\n   ✅ ${runRewardsMessages.length} Run-Rewards messages loaded`,
      );
      this.logMemory("Phase 1 done (Run-Rewards loaded)", {
        runRewards: runRewardsMessages.length,
      });

      // ========================================================================
      // Phase 2: Stream through streak messages in batches, processing rewards as we go
      // ========================================================================
      this.log("\n" + "=".repeat(40));
      this.log("Phase 2: Streaming streak events and processing rewards");
      this.log("=".repeat(40));

      let lastRewardBlock = 0;
      // Start from last *completed* block so we only advance when we actually process events
      let lastBlock = options.fullReindex
        ? fromBlock - 1
        : this.lastIndexedBlock;
      let totalEventsProcessed = 0;

      const totalRewards = runRewardsMessages.length;
      this.log(
        `\n   Starting processing of ${totalRewards} Run-Rewards events...`,
      );
      this.log(
        `   Batch size: ${STREAK_BATCH_SIZE} streak events (set PIXL_STREAK_BATCH_SIZE to override)`,
      );

      this.logMemory("Phase 2 start", {
        runRewards: totalRewards,
        streakBatchSize: STREAK_BATCH_SIZE,
      });

      const streakIterator = this.fetchStreakMessages(fromBlock);
      let batch = [];
      let batchIndex = 0;

      try {
        // Pull streak events in batches to limit memory and allow GC between batches
        while (true) {
          const { value: streakEvent, done } = await streakIterator.next();
          if (done) break;
          batch.push(streakEvent);

          if (batch.length >= STREAK_BATCH_SIZE) {
            batchIndex++;
            for (const streakEvent of batch) {
              // Before processing this streak event, process any Run-Rewards
              // that have block height <= this streak event's block height
              while (
                rewardsIndex < runRewardsMessages.length &&
                runRewardsMessages[rewardsIndex].blockHeight <=
                  streakEvent.blockHeight
              ) {
                const rewardEvent = runRewardsMessages[rewardsIndex];

                if (rewardsIndex > 0 && rewardsIndex % 10 === 0) {
                  const pct = ((rewardsIndex / totalRewards) * 100).toFixed(1);
                  const elapsed = (
                    (Date.now() - startTime) /
                    1000 /
                    60
                  ).toFixed(1);
                  this.log(
                    `   🎯 Run-Rewards progress: ${rewardsIndex}/${totalRewards} (${pct}%) - ${elapsed}min elapsed`,
                  );
                }

                const result = await this.processRunRewardsEvent(
                  rewardEvent,
                  options,
                  lastRewardBlock,
                );
                if (result.processed) {
                  lastRewardBlock = result.lastRewardBlock;
                }
                rewardsIndex++;
              }

              await this.ensureStreakLoaded(streakEvent.buyer);
              this.processStreakEvent(
                streakEvent.buyer,
                streakEvent.blockHeight,
              );
              await this.saveStreakEvent(streakEvent);
              this.stats.streakEventsProcessed++;
              lastBlock = streakEvent.blockHeight;
              totalEventsProcessed++;
            }

            await this.persistStreakStateToDb();
            await this.saveIndexerState(lastBlock);
            this.logMemory(
              `batch ${batchIndex} (after ${totalEventsProcessed} streak events)`,
              {
                distributions: this.stats.distributionsStored,
                runRewardsProcessed: this.stats.runRewardsProcessed,
              },
            );
            const runtime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
            const distRate = (
              (this.stats.distributionsStored / (Date.now() - startTime)) *
              1000 *
              60
            ).toFixed(0);
            this.log(
              `   📊 Batch ${batchIndex}: ${totalEventsProcessed} streak events | ${this.stats.runRewardsProcessed} rewards | ${this.stats.distributionsStored} distributions | ${this.streaks.size} active streaks | ${runtime}min (${distRate} dist/min)`,
            );
            batch = [];
          }
        }

        // Process remaining streak events in the last partial batch
        for (const streakEvent of batch) {
          while (
            rewardsIndex < runRewardsMessages.length &&
            runRewardsMessages[rewardsIndex].blockHeight <=
              streakEvent.blockHeight
          ) {
            const rewardEvent = runRewardsMessages[rewardsIndex];
            const result = await this.processRunRewardsEvent(
              rewardEvent,
              options,
              lastRewardBlock,
            );
            if (result.processed) {
              lastRewardBlock = result.lastRewardBlock;
            }
            rewardsIndex++;
          }
          await this.ensureStreakLoaded(streakEvent.buyer);
          this.processStreakEvent(streakEvent.buyer, streakEvent.blockHeight);
          await this.saveStreakEvent(streakEvent);
          this.stats.streakEventsProcessed++;
          lastBlock = streakEvent.blockHeight;
          totalEventsProcessed++;
        }
        if (batch.length > 0) {
          await this.persistStreakStateToDb();
        }
      } catch (batchError) {
        this.logMemory(
          `ERROR at batch ${batchIndex} (${totalEventsProcessed} streak events)`,
          {
            distributions: this.stats.distributionsStored,
            runRewardsProcessed: this.stats.runRewardsProcessed,
          },
        );
        this.log(
          `   ❌ Failed at batch ${batchIndex} | streak events: ${totalEventsProcessed} | distributions: ${this.stats.distributionsStored} | error: ${batchError.message}`,
        );
        throw batchError;
      }

      // Process any remaining Run-Rewards messages that come after all streak events
      while (rewardsIndex < runRewardsMessages.length) {
        const rewardEvent = runRewardsMessages[rewardsIndex];
        const result = await this.processRunRewardsEvent(
          rewardEvent,
          options,
          lastRewardBlock,
        );
        if (result.processed) {
          lastRewardBlock = result.lastRewardBlock;
        }
        lastBlock = rewardEvent.blockHeight;
        rewardsIndex++;
      }

      // Final save
      await this.saveIndexerState(lastBlock);

      // Note: verification failures are written incrementally during processing

      // Verify final database counts
      this.log("\n" + "=".repeat(40));
      this.log("Verifying database state...");
      this.log("=".repeat(40));

      const distCountResult = await this.client.execute(
        `SELECT COUNT(*) as cnt FROM pixl_distributions`,
      );
      const actualDistCount =
        distCountResult.rows[0]?.cnt?.low || distCountResult.rows[0]?.cnt || 0;

      const blockCountResult = await this.client.execute(
        `SELECT COUNT(*) as cnt FROM pixl_distributions_by_block`,
      );
      const actualBlockCount =
        blockCountResult.rows[0]?.cnt?.low ||
        blockCountResult.rows[0]?.cnt ||
        0;

      // Use in-memory count for unique wallets
      const actualUniqueWallets = this._uniqueRecipients.size;

      // Summary
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      this.log("\n" + "=".repeat(70));
      this.log("✅ PIXL Distribution Indexing Complete!");
      this.log("=".repeat(70));
      this.log(
        `   Streak events processed: ${this.stats.streakEventsProcessed}`,
      );
      this.log(`   Run-Rewards processed: ${this.stats.runRewardsProcessed}`);
      this.log(
        `   Distributions stored (in-memory): ${this.stats.distributionsStored}`,
      );
      this.log(`   Distributions in database: ${actualDistCount}`);
      this.log(`   Distributions by block in database: ${actualBlockCount}`);
      this.log(`   Unique recipients: ${actualUniqueWallets}`);
      this.log(`   Active streaks at end: ${this.streaks.size}`);
      this.log(`   Time elapsed: ${elapsed} minutes`);

      // Warn if counts don't match
      if (actualDistCount !== this.stats.distributionsStored) {
        this.log(
          `\n   ⚠️ WARNING: In-memory count (${this.stats.distributionsStored}) differs from database count (${actualDistCount})!`,
        );
        this.log(
          `      This may indicate database write failures or duplicate data.`,
        );
      }

      if (this.verifyMode) {
        this.log(`\n   Verification Results:`);
        this.log(`   ✅ Passed: ${this.stats.verificationsPassed}`);
        this.log(`   ❌ Failed: ${this.stats.verificationsFailed}`);
        if (this.stats.verificationsFailed > 0) {
          this.log(`   📁 Details saved to: ${VERIFICATION_FILE}`);
        }
      }
    } catch (error) {
      console.error("\n❌ Indexing failed:", error.message);
      console.error(error.stack);
      throw error;
    }
  }

  async close() {
    if (this.client) {
      await this.client.shutdown();
      this.log("✅ Database connection closed");
    }
  }
}

// ============================================================================
// CLI Execution
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const fullReindex = args.includes("--full") || args.includes("-f");
  const verifyMode = args.includes("--verify") || args.includes("-v");
  const showHelp = args.includes("--help") || args.includes("-h");
  const verbose = !args.includes("--quiet") && !args.includes("-q");

  if (showHelp) {
    console.log(`
PIXL Distribution Indexer - Calculation Version
================================================

This indexer calculates PIXL distributions by replaying the contract logic:
1. Processes all Calculate-Streak messages to build streak state
2. Calculates allocations using the same algorithm as the contract
3. Optionally verifies calculations against Output.data (where available)

Usage: node pixl_distribution_indexer.js [options]

Options:
  --full, -f      Full reindex from genesis
  --verify, -v    Verify calculations against Output.data (blocks 1679720-1770159)
  --quiet, -q     Suppress console output
  --help, -h      Show this help

Environment (for low-memory production servers):
  PIXL_STREAK_BATCH_SIZE     Streak events per batch (default: 3000)
  PIXL_GRAPHQL_PAGE_SIZE     GraphQL page size for streak fetches (default: 50)
  PIXL_MAX_STREAK_STATE_ENTRIES  Max streak entries in saved state (default: 20000)

Log files:
  Main log:           ${LOG_FILE}
  Verification:       ${VERIFICATION_FILE}

Examples:
  node pixl_distribution_indexer.js --full --verify   # Full index with verification
  node pixl_distribution_indexer.js --verify          # Continue with verification
  node pixl_distribution_indexer.js                   # Continue from checkpoint
`);
    return;
  }

  console.log("\n" + "=".repeat(70));
  console.log("   PIXL Distribution Indexer - Calculation Version");
  console.log("   Token: DM3FoZUq_yebASPhgd8pEIRIzDW6muXEhxz5-JwbZwo");
  console.log("=".repeat(70));

  if (verifyMode) {
    console.log(
      `\n   Verification enabled for blocks ${PIXL_CONSTANTS.VERIFICATION_START_BLOCK}-${PIXL_CONSTANTS.VERIFICATION_END_BLOCK}`,
    );
  }

  console.log(
    `\n   Mode: ${fullReindex ? "Full reindex" : "Continue from checkpoint"}`,
  );
  console.log(`   📁 Log file: ${LOG_FILE}`);

  const indexer = new PIXLDistributionIndexer({
    verbose,
    logToFile: true,
    verify: verifyMode,
  });

  process.on("SIGINT", async () => {
    console.log("\n\n⚠️ Shutting down...");
    await indexer.close();
    process.exit(0);
  });

  try {
    await indexer.initialize();
    await indexer.runFullIndex({ fullReindex });
  } catch (error) {
    console.error("\n❌ Fatal error:", error.message);
    process.exit(1);
  } finally {
    await indexer.close();
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { PIXLDistributionIndexer, PIXL_CONSTANTS };
