/**
 * DEX Price Indexer
 *
 * Indexes ALL swap transactions across ALL DEX platforms in the AO ecosystem.
 * Stores individual swaps for precise historical price lookups.
 * Uses forward-fill pricing: a trade sets the price until the next trade.
 *
 * Supported Platforms:
 * - Permaswap AMM (Transfer + X-PS-Status: Swapped)
 * - Botega/Bazar AMM (Order-Confirmation)
 * - Bazar UCM Orderbook (Order-Success)
 * - PI Orderbook (OrderMade-Notice)
 *
 * @module src/indexers/dex_price_indexer
 */

const cassandra = require("cassandra-driver");
const axios = require("axios");
const CONSTANTS = require("../../config/ar-tracker-constants");

// Schema for individual DEX swaps
const DEX_SWAPS_SCHEMA = `
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
`;

// Schema for token prices derived from swaps (forward-filled)
const DEX_TOKEN_PRICES_SCHEMA = `
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
`;

// Schema for indexer state (incremental updates)
const INDEXER_STATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS dex_indexer_state (
    indexer_name TEXT PRIMARY KEY,
    last_indexed_block INT,
    last_indexed_timestamp BIGINT,
    last_run_at TIMESTAMP,
    total_swaps_indexed BIGINT,
    status TEXT
  );
`;

// Index for querying swaps by token
const DEX_SWAPS_TOKEN_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_dex_swaps_token_in
  ON dex_swaps (token_in);
`;

const DEX_SWAPS_TOKEN_OUT_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_dex_swaps_token_out
  ON dex_swaps (token_out);
`;

// Known anchor tokens for USD conversion
const ANCHOR_TOKENS = {
  wAR: "xU9zFkq3X2ZQ6olwNVvr1vUWIjc3kXTWr7xKQD6dh10",
  wUSDC: "7zH9dlMNoxprab9loshv3Y7WG45DOny_Vrq9KrXObdQ",
  USDA: "FBt9A5GA_KXMMSxA2DJ0xZbAq8sLLU2ak-YJe9zDvg8",
  AO: "0syT13r0s0tgPmIed95bJnuSqaD29HQNN8D3ElLSrsc",
};

// Stablecoins (always $1)
const STABLECOINS = ["wUSDC", "USDA", "vUSDC"];

class DEXPriceIndexer {
  constructor(options = {}) {
    this.client = null;
    this.isConnected = false;
    this.keyspace = options.keyspace || "ao_price_data";
    this.contactPoints = options.contactPoints || ["localhost"];
    this.localDataCenter = options.localDataCenter || "datacenter1";
    this.verbose = options.verbose || false;

    // GQL endpoints
    this.gqlEndpoints = [
      "https://arweave-search.goldsky.com/graphql",
      "https://arweave.net/graphql",
    ];
    this.currentEndpoint = 0;

    // Rate limiting
    this.rateLimitDelay = options.rateLimitDelay || 200;
    this.batchSize = options.batchSize || 100;

    // Genesis block for AO DEX activity
    // Order-Confirmation: 1,367,853 (Feb 20, 2024)
    // Bazar UCM: 1,388,815 (Mar 22, 2024)
    // Permaswap: 1,411,279 (Apr 25, 2024)
    this.genesisBlock = options.genesisBlock || 1360000;

    // Statistics
    this.stats = {
      swapsIndexed: 0,
      pricesCalculated: 0,
      errors: 0,
      maxBlockSeen: 0,
      maxTimestampSeen: 0,
    };
  }

  /**
   * Connect to Cassandra and initialize schema
   */
  async connect() {
    if (this.isConnected) return;

    try {
      this.client = new cassandra.Client({
        contactPoints: this.contactPoints,
        localDataCenter: this.localDataCenter,
        keyspace: this.keyspace,
      });
      await this.client.connect();
      this.isConnected = true;

      await this.initializeSchema();

      if (this.verbose) {
        console.log(`✅ DEXPriceIndexer connected to ${this.keyspace}`);
      }
    } catch (error) {
      console.error(`❌ DEXPriceIndexer connection failed: ${error.message}`);
      this.isConnected = false;
      throw error;
    }
  }

  /**
   * Initialize database schema
   */
  async initializeSchema() {
    if (!this.isConnected) return;

    try {
      await this.client.execute(DEX_SWAPS_SCHEMA);
      await this.client.execute(DEX_TOKEN_PRICES_SCHEMA);
      await this.client.execute(INDEXER_STATE_SCHEMA);
      await this.client.execute(DEX_SWAPS_TOKEN_INDEX);
      await this.client.execute(DEX_SWAPS_TOKEN_OUT_INDEX);

      if (this.verbose) {
        console.log("   ✅ DEX price indexer schema initialized");
      }
    } catch (error) {
      console.warn(`   ⚠️ Schema init warning: ${error.message}`);
    }
  }

  /**
   * Disconnect from Cassandra
   */
  async disconnect() {
    if (this.client) {
      await this.client.shutdown();
      this.isConnected = false;
    }
  }

  /**
   * Sleep for rate limiting
   */
  async sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Execute GraphQL query with retries and endpoint rotation
   */
  async executeGqlQuery(query, variables = {}) {
    const maxRetries = 3;
    let lastError;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const endpoint = this.gqlEndpoints[this.currentEndpoint];

      try {
        const response = await axios.post(
          endpoint,
          { query, variables },
          {
            headers: { "Content-Type": "application/json" },
            timeout: 45000,
          }
        );

        if (response.data.errors) {
          throw new Error(response.data.errors[0].message);
        }

        return response.data.data;
      } catch (error) {
        lastError = error;

        // Check for rate limit
        if (error.response?.status === 429 || error.message?.includes("429")) {
          console.warn(`   ⏱️ Rate limited, waiting 30s...`);
          await this.sleep(30000);
          continue;
        }

        // Rotate endpoint on failure
        this.currentEndpoint =
          (this.currentEndpoint + 1) % this.gqlEndpoints.length;

        if (attempt < maxRetries - 1) {
          await this.sleep(2000 * (attempt + 1));
        }
      }
    }

    throw lastError;
  }

  /**
   * Parse tags from GQL node
   */
  parseTags(tags) {
    const parsed = {};
    if (Array.isArray(tags)) {
      tags.forEach((tag) => {
        parsed[tag.name] = tag.value;
      });
    }
    return parsed;
  }

  /**
   * Get token info from constants or return basic info
   */
  getTokenInfo(processId) {
    if (!processId) return { symbol: "UNKNOWN", decimals: 12 };
    return (
      CONSTANTS.TOKENS[processId] || {
        symbol: processId.substring(0, 8),
        decimals: 12,
      }
    );
  }

  /**
   * Get indexer state (for incremental updates)
   */
  async getIndexerState(indexerName = "dex_price_indexer") {
    if (!this.isConnected) await this.connect();

    try {
      const query = `SELECT * FROM dex_indexer_state WHERE indexer_name = ?`;
      const result = await this.client.execute(query, [indexerName], {
        prepare: true,
      });

      if (result.rows.length > 0) {
        return {
          lastIndexedBlock:
            result.rows[0].last_indexed_block || this.genesisBlock,
          lastIndexedTimestamp: result.rows[0].last_indexed_timestamp || 0,
          totalSwapsIndexed: result.rows[0].total_swaps_indexed || 0,
          status: result.rows[0].status || "idle",
        };
      }

      return {
        lastIndexedBlock: this.genesisBlock,
        lastIndexedTimestamp: 0,
        totalSwapsIndexed: 0,
        status: "new",
      };
    } catch (error) {
      console.warn(`   ⚠️ Error getting indexer state: ${error.message}`);
      return {
        lastIndexedBlock: this.genesisBlock,
        lastIndexedTimestamp: 0,
        totalSwapsIndexed: 0,
        status: "error",
      };
    }
  }

  /**
   * Update indexer state
   */
  async updateIndexerState(indexerName, state) {
    if (!this.isConnected) return;

    try {
      const query = `
        INSERT INTO dex_indexer_state (
          indexer_name, last_indexed_block, last_indexed_timestamp,
          last_run_at, total_swaps_indexed, status
        ) VALUES (?, ?, ?, ?, ?, ?)
      `;

      await this.client.execute(
        query,
        [
          indexerName,
          state.lastIndexedBlock,
          state.lastIndexedTimestamp,
          new Date(),
          state.totalSwapsIndexed,
          state.status,
        ],
        { prepare: true }
      );
    } catch (error) {
      console.warn(`   ⚠️ Error updating indexer state: ${error.message}`);
    }
  }

  // ============================================================
  // SWAP FETCHING - PERMASWAP AMM
  // ============================================================

  /**
   * Fetch Permaswap swaps (Transfer with X-PS-Status: Swapped)
   * @param {number} minBlock - Minimum block height
   * @param {number} maxBlock - Maximum block height (optional)
   * @param {object} options - { maxPages: limit pages fetched (0=unlimited) }
   */
  async fetchPermaswapSwaps(minBlock, maxBlock = null, options = {}) {
    const { maxPages = 0 } = options;

    if (this.verbose) {
      console.log(
        `\n📊 Fetching Permaswap swaps from block ${minBlock}${
          maxBlock ? ` to ${maxBlock}` : ""
        }...`
      );
    }

    const swaps = [];
    let totalSaved = 0;
    let hasNextPage = true;
    let cursor = null;
    let pageCount = 0;

    // Batch save size - save to DB every N swaps to avoid memory issues
    const SAVE_BATCH_SIZE = 50000;

    // Build query with optional maxBlock
    const blockFilter = maxBlock
      ? `block: { min: $minBlock, max: $maxBlock }`
      : `block: { min: $minBlock }`;

    const queryVars = maxBlock
      ? "$first: Int!, $after: String, $minBlock: Int!, $maxBlock: Int!"
      : "$first: Int!, $after: String, $minBlock: Int!";

    // Permaswap uses Action: Order-Notice + OrderStatus: Swapped
    const query = `
      query GetPermaswapSwaps(${queryVars}) {
        transactions(
          first: $first
          after: $after
          ${blockFilter}
          tags: [
            { name: "Action", values: ["Order-Notice"] }
            { name: "OrderStatus", values: ["Swapped"] }
          ]
          sort: HEIGHT_ASC
        ) {
          pageInfo { hasNextPage }
          edges {
            cursor
            node {
              id
              block { height timestamp }
              tags { name value }
            }
          }
        }
      }
    `;

    while (hasNextPage) {
      try {
        const variables = {
          first: this.batchSize,
          after: cursor,
          minBlock,
        };
        if (maxBlock) variables.maxBlock = maxBlock;

        const result = await this.executeGqlQuery(query, variables);
        const edges = result?.transactions?.edges || [];

        for (const edge of edges) {
          const swap = this.parsePermaswapSwap(edge.node);
          if (swap) {
            swaps.push(swap);
            // Track max block seen during fetching
            if (swap.blockHeight > this.stats.maxBlockSeen) {
              this.stats.maxBlockSeen = swap.blockHeight;
            }
            if (swap.blockTimestamp > this.stats.maxTimestampSeen) {
              this.stats.maxTimestampSeen = swap.blockTimestamp;
            }
          }
        }

        hasNextPage = result?.transactions?.pageInfo?.hasNextPage || false;
        if (edges.length > 0) {
          cursor = edges[edges.length - 1].cursor;
        } else {
          hasNextPage = false;
        }

        pageCount++;
        if (pageCount % 10 === 0 && this.verbose) {
          console.log(
            `   ... ${pageCount} pages, ${
              swaps.length + totalSaved
            } swaps (${totalSaved} saved)`
          );
        }

        // Save batch to DB periodically to avoid memory issues
        if (swaps.length >= SAVE_BATCH_SIZE) {
          if (this.verbose) {
            console.log(`   💾 Saving batch of ${swaps.length} swaps to DB...`);
          }
          await this.saveSwapsBatch(swaps);
          totalSaved += swaps.length;
          swaps.length = 0; // Clear array while keeping reference
        }

        // Respect page limit
        if (maxPages > 0 && pageCount >= maxPages) {
          if (this.verbose) {
            console.log(`   ⏹️ Page limit reached (${maxPages})`);
          }
          break;
        }

        await this.sleep(this.rateLimitDelay);
      } catch (error) {
        console.warn(`   ⚠️ Permaswap fetch error: ${error.message}`);
        break;
      }
    }

    // Save any remaining swaps
    if (swaps.length > 0) {
      if (this.verbose && totalSaved > 0) {
        console.log(
          `   💾 Saving final batch of ${swaps.length} swaps to DB...`
        );
      }
      await this.saveSwapsBatch(swaps);
      totalSaved += swaps.length;
    }

    if (this.verbose) {
      console.log(`   ✅ Found and saved ${totalSaved} Permaswap swaps`);
    }

    return []; // Return empty - swaps already saved to DB
  }

  /**
   * Parse Permaswap swap from GQL node
   * Permaswap uses tags: TokenIn, TokenOut, AmountIn, AmountOut
   */
  parsePermaswapSwap(node) {
    const tags = this.parseTags(node.tags);

    // Permaswap tag names
    let tokenIn = tags["TokenIn"];
    let tokenOut = tags["TokenOut"];
    let amountIn = tags["AmountIn"];
    let amountOut = tags["AmountOut"];

    if (!tokenIn || !tokenOut || !amountIn || !amountOut) {
      return null;
    }

    const tokenInInfo = this.getTokenInfo(tokenIn);
    const tokenOutInfo = this.getTokenInfo(tokenOut);

    // Calculate price ratio (how much tokenOut per tokenIn)
    const amountInNum = parseFloat(amountIn);
    const amountOutNum = parseFloat(amountOut);
    const priceRatio = amountInNum > 0 ? amountOutNum / amountInNum : 0;

    return {
      txId: node.id,
      platform: "permaswap",
      poolId: tags["PoolId"] || tags["From-Process"] || null,
      blockHeight: node.block?.height,
      blockTimestamp: node.block?.timestamp,
      tokenIn,
      tokenInSymbol: tokenInInfo.symbol,
      tokenOut,
      tokenOutSymbol: tokenOutInfo.symbol,
      amountIn,
      amountOut,
      priceRatio,
      userAddress: tags["User"] || tags["Recipient"] || null,
    };
  }

  // ============================================================
  // SWAP FETCHING - BOTEGA/BAZAR AMM (Order-Confirmation)
  // ============================================================

  /**
   * Fetch Order-Confirmation swaps (Botega/Bazar AMM)
   * @param {number} minBlock - Minimum block height
   * @param {number} maxBlock - Maximum block height (optional)
   * @param {object} options - { maxPages: limit pages fetched (0=unlimited) }
   */
  async fetchOrderConfirmations(minBlock, maxBlock = null, options = {}) {
    const { maxPages = 0 } = options;

    if (this.verbose) {
      console.log(
        `\n📊 Fetching Order-Confirmations from block ${minBlock}${
          maxBlock ? ` to ${maxBlock}` : ""
        }...`
      );
    }

    const swaps = [];
    let totalSaved = 0;
    let hasNextPage = true;
    let cursor = null;
    let pageCount = 0;

    // Batch save size - save to DB every N swaps to avoid memory issues
    const SAVE_BATCH_SIZE = 50000;

    // Build query with optional maxBlock
    const blockFilter = maxBlock
      ? `block: { min: $minBlock, max: $maxBlock }`
      : `block: { min: $minBlock }`;

    const queryVars = maxBlock
      ? "$first: Int!, $after: String, $minBlock: Int!, $maxBlock: Int!"
      : "$first: Int!, $after: String, $minBlock: Int!";

    const query = `
      query GetOrderConfirmations(${queryVars}) {
        transactions(
          first: $first
          after: $after
          ${blockFilter}
          tags: [
            { name: "Action", values: ["Order-Confirmation"] }
          ]
          sort: HEIGHT_ASC
        ) {
          pageInfo { hasNextPage }
          edges {
            cursor
            node {
              id
              block { height timestamp }
              tags { name value }
            }
          }
        }
      }
    `;

    while (hasNextPage) {
      try {
        const variables = {
          first: this.batchSize,
          after: cursor,
          minBlock,
        };
        if (maxBlock) variables.maxBlock = maxBlock;

        const result = await this.executeGqlQuery(query, variables);
        const edges = result?.transactions?.edges || [];

        for (const edge of edges) {
          // Double-check block height filter
          if (maxBlock && edge.node.block?.height > maxBlock) {
            continue;
          }
          const swap = this.parseOrderConfirmation(edge.node);
          if (swap) {
            swaps.push(swap);
            // Track max block seen during fetching
            if (swap.blockHeight > this.stats.maxBlockSeen) {
              this.stats.maxBlockSeen = swap.blockHeight;
            }
            if (swap.blockTimestamp > this.stats.maxTimestampSeen) {
              this.stats.maxTimestampSeen = swap.blockTimestamp;
            }
          }
        }

        hasNextPage = result?.transactions?.pageInfo?.hasNextPage || false;
        if (edges.length > 0) {
          cursor = edges[edges.length - 1].cursor;
        } else {
          hasNextPage = false;
        }

        pageCount++;
        if (pageCount % 10 === 0 && this.verbose) {
          console.log(
            `   ... ${pageCount} pages, ${
              swaps.length + totalSaved
            } swaps (${totalSaved} saved)`
          );
        }

        // Save batch to DB periodically to avoid memory issues
        if (swaps.length >= SAVE_BATCH_SIZE) {
          if (this.verbose) {
            console.log(`   💾 Saving batch of ${swaps.length} swaps to DB...`);
          }
          await this.saveSwapsBatch(swaps);
          totalSaved += swaps.length;
          swaps.length = 0; // Clear array while keeping reference
        }

        // Respect page limit
        if (maxPages > 0 && pageCount >= maxPages) {
          if (this.verbose) {
            console.log(`   ⏹️ Page limit reached (${maxPages})`);
          }
          break;
        }

        await this.sleep(this.rateLimitDelay);
      } catch (error) {
        console.warn(`   ⚠️ Order-Confirmation fetch error: ${error.message}`);
        break;
      }
    }

    // Save any remaining swaps
    if (swaps.length > 0) {
      if (this.verbose && totalSaved > 0) {
        console.log(
          `   💾 Saving final batch of ${swaps.length} swaps to DB...`
        );
      }
      await this.saveSwapsBatch(swaps);
      totalSaved += swaps.length;
    }

    if (this.verbose) {
      console.log(
        `   ✅ Found and saved ${totalSaved} Order-Confirmation swaps`
      );
    }

    return []; // Return empty - swaps already saved to DB
  }

  /**
   * Parse Order-Confirmation swap
   */
  parseOrderConfirmation(node) {
    const tags = this.parseTags(node.tags);

    const tokenIn = tags["From-Token"];
    const tokenOut = tags["To-Token"];
    const amountIn = tags["From-Quantity"];
    const amountOut = tags["To-Quantity"];

    if (!tokenIn || !tokenOut || !amountIn || !amountOut) {
      return null;
    }

    const tokenInInfo = this.getTokenInfo(tokenIn);
    const tokenOutInfo = this.getTokenInfo(tokenOut);

    const amountInNum = parseFloat(amountIn);
    const amountOutNum = parseFloat(amountOut);
    const priceRatio = amountInNum > 0 ? amountOutNum / amountInNum : 0;

    return {
      txId: node.id,
      platform: "botega",
      poolId: tags["From-Process"] || tags["Pool-Id"] || null,
      blockHeight: node.block?.height,
      blockTimestamp: node.block?.timestamp,
      tokenIn,
      tokenInSymbol: tokenInInfo.symbol,
      tokenOut,
      tokenOutSymbol: tokenOutInfo.symbol,
      amountIn,
      amountOut,
      priceRatio,
      userAddress: tags["User"] || tags["Order-Owner"] || null,
    };
  }

  // ============================================================
  // SWAP FETCHING - BAZAR UCM ORDERBOOK
  // ============================================================

  /**
   * Fetch Bazar UCM executed trades
   * @param {number} minBlock - Minimum block height
   * @param {number} maxBlock - Maximum block height (optional)
   * @param {object} options - { maxPages: limit pages fetched (0=unlimited) }
   */
  async fetchBazarTrades(minBlock, maxBlock = null, options = {}) {
    const { maxPages = 0 } = options;

    if (this.verbose) {
      console.log(
        `\n📊 Fetching Bazar UCM trades from block ${minBlock}${
          maxBlock ? ` to ${maxBlock}` : ""
        }...`
      );
    }

    const swaps = [];
    let totalSaved = 0;
    let hasNextPage = true;
    let cursor = null;
    let pageCount = 0;

    // Batch save size - save to DB every N swaps to avoid memory issues
    const SAVE_BATCH_SIZE = 50000;

    // Build query with optional maxBlock
    const blockFilter = maxBlock
      ? `block: { min: $minBlock, max: $maxBlock }`
      : `block: { min: $minBlock }`;

    const queryVars = maxBlock
      ? "$first: Int!, $after: String, $minBlock: Int!, $maxBlock: Int!"
      : "$first: Int!, $after: String, $minBlock: Int!";

    const query = `
      query GetBazarTrades(${queryVars}) {
        transactions(
          first: $first
          after: $after
          ${blockFilter}
          tags: [
            { name: "Action", values: ["Order-Success"] }
            { name: "Status", values: ["Success"] }
          ]
          sort: HEIGHT_ASC
        ) {
          pageInfo { hasNextPage }
          edges {
            cursor
            node {
              id
              block { height timestamp }
              tags { name value }
            }
          }
        }
      }
    `;

    while (hasNextPage) {
      try {
        const variables = {
          first: this.batchSize,
          after: cursor,
          minBlock,
        };
        if (maxBlock) variables.maxBlock = maxBlock;

        const result = await this.executeGqlQuery(query, variables);
        const edges = result?.transactions?.edges || [];

        for (const edge of edges) {
          const swap = this.parseBazarTrade(edge.node);
          if (swap) {
            swaps.push(swap);
            // Track max block seen during fetching
            if (swap.blockHeight > this.stats.maxBlockSeen) {
              this.stats.maxBlockSeen = swap.blockHeight;
            }
            if (swap.blockTimestamp > this.stats.maxTimestampSeen) {
              this.stats.maxTimestampSeen = swap.blockTimestamp;
            }
          }
        }

        hasNextPage = result?.transactions?.pageInfo?.hasNextPage || false;
        if (edges.length > 0) {
          cursor = edges[edges.length - 1].cursor;
        } else {
          hasNextPage = false;
        }

        pageCount++;
        if (pageCount % 10 === 0 && this.verbose) {
          console.log(
            `   ... ${pageCount} pages, ${
              swaps.length + totalSaved
            } swaps (${totalSaved} saved)`
          );
        }

        // Save batch to DB periodically to avoid memory issues
        if (swaps.length >= SAVE_BATCH_SIZE) {
          if (this.verbose) {
            console.log(`   💾 Saving batch of ${swaps.length} swaps to DB...`);
          }
          await this.saveSwapsBatch(swaps);
          totalSaved += swaps.length;
          swaps.length = 0; // Clear array while keeping reference
        }

        // Respect page limit
        if (maxPages > 0 && pageCount >= maxPages) {
          if (this.verbose) {
            console.log(`   ⏹️ Page limit reached (${maxPages})`);
          }
          break;
        }

        await this.sleep(this.rateLimitDelay);
      } catch (error) {
        console.warn(`   ⚠️ Bazar fetch error: ${error.message}`);
        break;
      }
    }

    // Save any remaining swaps
    if (swaps.length > 0) {
      if (this.verbose && totalSaved > 0) {
        console.log(
          `   💾 Saving final batch of ${swaps.length} swaps to DB...`
        );
      }
      await this.saveSwapsBatch(swaps);
      totalSaved += swaps.length;
    }

    if (this.verbose) {
      console.log(`   ✅ Found and saved ${totalSaved} Bazar UCM trades`);
    }

    return []; // Return empty - swaps already saved to DB
  }

  /**
   * Parse Bazar UCM trade
   */
  parseBazarTrade(node) {
    const tags = this.parseTags(node.tags);

    // Bazar uses DominantToken/SwapToken or similar
    const dominantToken = tags["DominantToken"];
    const swapToken = tags["SwapToken"];
    const quantity = tags["Quantity"];
    const price = tags["Price"];

    if (!dominantToken || !quantity) {
      return null;
    }

    const dominantInfo = this.getTokenInfo(dominantToken);
    const swapInfo = this.getTokenInfo(swapToken || ANCHOR_TOKENS.wAR);

    // In Bazar, Price is typically in wAR per unit
    const priceNum = parseFloat(price || "0");
    const quantityNum = parseFloat(quantity);

    return {
      txId: node.id,
      platform: "bazar",
      poolId: tags["From-Process"] || null,
      blockHeight: node.block?.height,
      blockTimestamp: node.block?.timestamp,
      tokenIn: dominantToken,
      tokenInSymbol: dominantInfo.symbol,
      tokenOut: swapToken || ANCHOR_TOKENS.wAR,
      tokenOutSymbol: swapInfo.symbol,
      amountIn: quantity,
      amountOut: (quantityNum * priceNum).toString(),
      priceRatio: priceNum,
      userAddress: tags["Sender"] || null,
    };
  }

  // ============================================================
  // SWAP STORAGE
  // ============================================================

  /**
   * Save a swap to the database
   */
  async saveSwap(swap) {
    if (!this.isConnected) await this.connect();
    if (!swap.blockTimestamp) return;

    const swapDate = new Date(swap.blockTimestamp * 1000)
      .toISOString()
      .split("T")[0];

    const query = `
      INSERT INTO dex_swaps (
        swap_date, block_timestamp, tx_id, platform, pool_id,
        token_in, token_in_symbol, token_out, token_out_symbol,
        amount_in, amount_out, price_ratio, block_height, user_address, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    try {
      await this.client.execute(
        query,
        [
          swapDate,
          swap.blockTimestamp,
          swap.txId,
          swap.platform,
          swap.poolId,
          swap.tokenIn,
          swap.tokenInSymbol,
          swap.tokenOut,
          swap.tokenOutSymbol,
          swap.amountIn,
          swap.amountOut,
          swap.priceRatio,
          swap.blockHeight,
          swap.userAddress,
          new Date(),
        ],
        { prepare: true }
      );

      this.stats.swapsIndexed++;
    } catch (error) {
      this.stats.errors++;
      if (this.verbose) {
        console.warn(`   ⚠️ Error saving swap ${swap.txId}: ${error.message}`);
      }
    }
  }

  /**
   * Save multiple swaps in batch
   */
  async saveSwapsBatch(swaps) {
    for (const swap of swaps) {
      await this.saveSwap(swap);
    }
  }

  // ============================================================
  // PRICE CALCULATION AND STORAGE
  // ============================================================

  /**
   * Calculate and store token prices from swaps
   * Uses forward-fill: each swap sets the price until the next swap
   */
  async calculateTokenPrices(tokenProcessId, startDate = null) {
    if (!this.isConnected) await this.connect();

    if (this.verbose) {
      console.log(
        `\n💰 Calculating prices for ${tokenProcessId.substring(0, 12)}...`
      );
    }

    // Get all swaps involving this token
    const swaps = await this.getSwapsForToken(tokenProcessId, startDate);

    if (swaps.length === 0) {
      if (this.verbose) {
        console.log(`   ⚠️ No swaps found for token`);
      }
      return;
    }

    // Sort by timestamp ascending
    swaps.sort((a, b) => a.block_timestamp - b.block_timestamp);

    let pricesCalculated = 0;

    for (const swap of swaps) {
      // Determine if this token was input or output
      const isInput = swap.token_in === tokenProcessId;
      const pairedToken = isInput ? swap.token_out : swap.token_in;

      // Calculate price based on swap direction
      let priceInPaired;
      if (isInput) {
        // Token was sold: price = amountOut / amountIn (how much paired token per unit)
        const amountIn = parseFloat(swap.amount_in);
        const amountOut = parseFloat(swap.amount_out);
        priceInPaired = amountIn > 0 ? amountOut / amountIn : 0;
      } else {
        // Token was bought: price = amountIn / amountOut (how much paired token per unit)
        const amountIn = parseFloat(swap.amount_in);
        const amountOut = parseFloat(swap.amount_out);
        priceInPaired = amountOut > 0 ? amountIn / amountOut : 0;
      }

      if (priceInPaired <= 0) continue;

      // Convert to USD based on paired token
      let priceUSD = null;
      let priceInWar = null;
      let priceInUsdc = null;

      if (pairedToken === ANCHOR_TOKENS.wAR) {
        priceInWar = priceInPaired;
        // USD conversion happens later via AR price
      } else if (
        pairedToken === ANCHOR_TOKENS.wUSDC ||
        pairedToken === ANCHOR_TOKENS.USDA
      ) {
        priceInUsdc = priceInPaired;
        priceUSD = priceInPaired; // 1 USDC = $1
      } else if (pairedToken === ANCHOR_TOKENS.AO) {
        // AO price needs to be looked up separately
        // For now, store the ratio
      }

      // Store the price point
      await this.saveTokenPrice({
        tokenProcessId,
        priceDate: new Date(swap.block_timestamp * 1000)
          .toISOString()
          .split("T")[0],
        blockTimestamp: swap.block_timestamp,
        priceInWar,
        priceInUsdc,
        priceUSD,
        sourceTxId: swap.tx_id,
        sourcePlatform: swap.platform,
        pairedToken,
        isForwardFilled: false,
      });

      pricesCalculated++;
    }

    if (this.verbose) {
      console.log(`   ✅ Calculated ${pricesCalculated} price points`);
    }

    this.stats.pricesCalculated += pricesCalculated;
  }

  /**
   * Get swaps involving a specific token
   */
  async getSwapsForToken(tokenProcessId, startDate = null) {
    const swaps = [];

    // Query for token as input
    let queryIn = `
      SELECT * FROM dex_swaps
      WHERE token_in = ?
      ALLOW FILTERING
    `;

    // Query for token as output
    let queryOut = `
      SELECT * FROM dex_swaps
      WHERE token_out = ?
      ALLOW FILTERING
    `;

    try {
      const [resultIn, resultOut] = await Promise.all([
        this.client.execute(queryIn, [tokenProcessId], { prepare: true }),
        this.client.execute(queryOut, [tokenProcessId], { prepare: true }),
      ]);

      swaps.push(...resultIn.rows);
      swaps.push(...resultOut.rows);

      // Filter by date if provided
      if (startDate) {
        const startTs = new Date(startDate).getTime() / 1000;
        return swaps.filter((s) => s.block_timestamp >= startTs);
      }

      return swaps;
    } catch (error) {
      console.warn(`   ⚠️ Error getting swaps: ${error.message}`);
      return [];
    }
  }

  /**
   * Save a token price point
   */
  async saveTokenPrice(price) {
    if (!this.isConnected) return;

    const query = `
      INSERT INTO dex_token_prices (
        token_process_id, price_date, block_timestamp,
        price_in_war, price_in_usdc, price_usd,
        source_tx_id, source_platform, paired_token,
        is_forward_filled, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    try {
      await this.client.execute(
        query,
        [
          price.tokenProcessId,
          price.priceDate,
          price.blockTimestamp,
          price.priceInWar,
          price.priceInUsdc,
          price.priceUSD,
          price.sourceTxId,
          price.sourcePlatform,
          price.pairedToken,
          price.isForwardFilled,
          new Date(),
        ],
        { prepare: true }
      );
    } catch (error) {
      if (this.verbose) {
        console.warn(`   ⚠️ Error saving price: ${error.message}`);
      }
    }
  }

  /**
   * Get price for a token at a specific date (with forward-fill)
   */
  async getPrice(tokenProcessId, date) {
    if (!this.isConnected) await this.connect();

    const dateStr =
      typeof date === "string"
        ? date.split("T")[0]
        : date.toISOString().split("T")[0];

    // First, try to get exact date price
    const exactQuery = `
      SELECT * FROM dex_token_prices
      WHERE token_process_id = ? AND price_date = ?
      ORDER BY block_timestamp DESC
      LIMIT 1
    `;

    try {
      const exactResult = await this.client.execute(
        exactQuery,
        [tokenProcessId, dateStr],
        { prepare: true }
      );

      if (exactResult.rows.length > 0) {
        return this.parsePriceRow(exactResult.rows[0]);
      }

      // Forward-fill: get most recent price before this date
      const forwardFillQuery = `
        SELECT * FROM dex_token_prices
        WHERE token_process_id = ? AND price_date < ?
        ORDER BY price_date DESC, block_timestamp DESC
        LIMIT 1
        ALLOW FILTERING
      `;

      const ffResult = await this.client.execute(
        forwardFillQuery,
        [tokenProcessId, dateStr],
        { prepare: true }
      );

      if (ffResult.rows.length > 0) {
        const price = this.parsePriceRow(ffResult.rows[0]);
        price.isForwardFilled = true;
        price.forwardFilledFrom = ffResult.rows[0].price_date;
        return price;
      }

      return null;
    } catch (error) {
      console.warn(`   ⚠️ Error getting price: ${error.message}`);
      return null;
    }
  }

  /**
   * Parse price row from database
   */
  parsePriceRow(row) {
    return {
      tokenProcessId: row.token_process_id,
      priceDate: row.price_date,
      blockTimestamp: row.block_timestamp,
      priceInWar: row.price_in_war
        ? parseFloat(row.price_in_war.toString())
        : null,
      priceInUsdc: row.price_in_usdc
        ? parseFloat(row.price_in_usdc.toString())
        : null,
      priceUSD: row.price_usd ? parseFloat(row.price_usd.toString()) : null,
      sourceTxId: row.source_tx_id,
      sourcePlatform: row.source_platform,
      pairedToken: row.paired_token,
      isForwardFilled: row.is_forward_filled,
    };
  }

  // ============================================================
  // FULL INDEXING RUN
  // ============================================================

  /**
   * Run full DEX price indexing (with incremental support)
   */
  async runFullIndex(options = {}) {
    const { forceReindex = false } = options;

    console.log("🚀 Starting DEX Price Indexing...\n");

    await this.connect();

    // Get current indexer state
    const state = await this.getIndexerState("dex_price_indexer");
    let minBlock = forceReindex ? this.genesisBlock : state.lastIndexedBlock;

    console.log(`📊 Starting from block ${minBlock}`);
    console.log(`   Previously indexed: ${state.totalSwapsIndexed} swaps\n`);

    // Update state to running
    await this.updateIndexerState("dex_price_indexer", {
      ...state,
      status: "running",
    });

    // Initialize with existing state values (used if no new swaps found)
    let maxBlockSeen = state.lastIndexedBlock || minBlock;
    let maxTimestampSeen = state.lastIndexedTimestamp || 0;

    // Reset stats for this run (maxBlockSeen/maxTimestampSeen tracked during fetching)
    this.stats.maxBlockSeen = 0;
    this.stats.maxTimestampSeen = 0;

    try {
      // Fetch and save Permaswap swaps (saves directly to DB in batches)
      await this.fetchPermaswapSwaps(minBlock);
      await this.sleep(1000);

      // Fetch and save Order-Confirmations (saves directly to DB in batches)
      await this.fetchOrderConfirmations(minBlock);
      await this.sleep(1000);

      // Fetch and save Bazar trades (saves directly to DB in batches)
      await this.fetchBazarTrades(minBlock);

      // Use the tracked values from fetching (more reliable than DB queries)
      if (this.stats.maxBlockSeen > maxBlockSeen) {
        maxBlockSeen = this.stats.maxBlockSeen;
      }
      if (this.stats.maxTimestampSeen > maxTimestampSeen) {
        maxTimestampSeen = this.stats.maxTimestampSeen;
      }

      console.log(
        `\n📊 Stats from fetching: max block ${maxBlockSeen}, ${this.stats.swapsIndexed} swaps indexed`
      );

      // These stats queries may timeout on large datasets - wrap in try/catch
      // The important work (saving swaps) is already done
      let totalSwaps =
        Number(state.totalSwapsIndexed || 0) + this.stats.swapsIndexed;
      const allTokens = new Set();

      // Optionally try to get total count from DB (may timeout)
      try {
        const countResult = await this.client.execute(
          "SELECT COUNT(*) as total FROM dex_swaps",
          [],
          { readTimeout: 120000 }
        );
        if (countResult.rows[0]?.total) {
          totalSwaps = countResult.rows[0].total.toString();
        }
      } catch (err) {
        console.warn(`   ⚠️ Could not get total count from DB: ${err.message}`);
        console.log(`   Using calculated total: ${totalSwaps}`);
      }

      try {
        // Get unique tokens for price calculation
        const tokenInResult = await this.client.execute(
          "SELECT DISTINCT token_in FROM dex_swaps",
          [],
          { readTimeout: 120000 }
        );
        const tokenOutResult = await this.client.execute(
          "SELECT DISTINCT token_out FROM dex_swaps",
          [],
          { readTimeout: 120000 }
        );

        tokenInResult.rows.forEach((row) => {
          if (row.token_in) allTokens.add(row.token_in);
        });
        tokenOutResult.rows.forEach((row) => {
          if (row.token_out) allTokens.add(row.token_out);
        });
      } catch (err) {
        console.warn(`   ⚠️ Could not get unique tokens: ${err.message}`);
        console.warn("   Price calculation will be skipped this run.");
      }

      // Only calculate prices if we found tokens
      if (allTokens.size > 0) {
        console.log(`\n💰 Calculating prices for ${allTokens.size} tokens...`);
        for (const tokenId of allTokens) {
          await this.calculateTokenPrices(tokenId);
        }
      } else {
        console.log(
          "\n⚠️ Skipping price calculation (no tokens found or query timeout)"
        );
        console.log(
          "   Run with --prices-only to calculate prices separately."
        );
      }

      // Update state
      await this.updateIndexerState("dex_price_indexer", {
        lastIndexedBlock: maxBlockSeen,
        lastIndexedTimestamp: maxTimestampSeen,
        totalSwapsIndexed: state.totalSwapsIndexed + this.stats.swapsIndexed,
        status: "completed",
      });

      // Summary
      console.log("\n" + "=".repeat(60));
      console.log("DEX PRICE INDEXING SUMMARY");
      console.log("=".repeat(60));
      console.log(`Total swaps in DB: ${totalSwaps}`);
      console.log(`Swaps indexed this run: ${this.stats.swapsIndexed}`);
      console.log(`Prices calculated: ${this.stats.pricesCalculated}`);
      console.log(`Errors: ${this.stats.errors}`);
      console.log(`Unique tokens: ${allTokens.size}`);
      console.log(`Last block: ${maxBlockSeen}`);
      console.log();

      return {
        success: true,
        swapsIndexed: this.stats.swapsIndexed,
        pricesCalculated: this.stats.pricesCalculated,
        uniqueTokens: allTokens.size,
        lastBlock: maxBlockSeen,
      };
    } catch (error) {
      console.error(`\n❌ Indexing failed: ${error.message}`);

      await this.updateIndexerState("dex_price_indexer", {
        lastIndexedBlock: maxBlockSeen,
        lastIndexedTimestamp: maxTimestampSeen,
        totalSwapsIndexed: state.totalSwapsIndexed + this.stats.swapsIndexed,
        status: "error",
      });

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Run incremental update (for cron jobs)
   */
  async runIncrementalUpdate() {
    return this.runFullIndex({ forceReindex: false });
  }

  /**
   * Get all unique tokens by scanning the dex_swaps table
   * Uses pagination to avoid memory issues with large datasets
   * @returns {Set<string>} - Set of unique token process IDs
   */
  async getUniqueTokens() {
    if (!this.isConnected) await this.connect();

    const uniqueTokens = new Set();
    let pageState = null;
    let totalRows = 0;

    console.log("\n🔍 Scanning for unique tokens (this may take a while)...");

    try {
      // Paginate through all swaps and collect unique tokens
      do {
        const query = "SELECT token_in, token_out FROM dex_swaps";
        const options = {
          prepare: true,
          fetchSize: 10000,
          pageState,
        };

        const result = await this.client.execute(query, [], options);

        for (const row of result.rows) {
          if (row.token_in) uniqueTokens.add(row.token_in);
          if (row.token_out) uniqueTokens.add(row.token_out);
        }

        totalRows += result.rows.length;
        pageState = result.pageState;

        if (totalRows % 100000 === 0 && this.verbose) {
          console.log(
            `   Scanned ${totalRows.toLocaleString()} rows, found ${
              uniqueTokens.size
            } unique tokens...`
          );
        }
      } while (pageState);

      console.log(
        `   ✅ Found ${
          uniqueTokens.size
        } unique tokens from ${totalRows.toLocaleString()} swap records`
      );

      return uniqueTokens;
    } catch (error) {
      console.error(`   ❌ Error scanning tokens: ${error.message}`);
      return uniqueTokens;
    }
  }

  /**
   * Calculate prices for all tokens (without re-indexing swaps)
   * Use --prices-only flag to run this
   * @returns {Object} - Result with success status and stats
   */
  async calculateAllPrices() {
    if (!this.isConnected) await this.connect();

    console.log("\n🚀 Starting price calculation for all tokens...");

    this.stats.pricesCalculated = 0;
    this.stats.errors = 0;

    try {
      // Get all unique tokens from swaps
      const allTokens = await this.getUniqueTokens();

      if (allTokens.size === 0) {
        console.log("⚠️ No tokens found in dex_swaps table");
        return {
          success: true,
          pricesCalculated: 0,
          uniqueTokens: 0,
        };
      }

      console.log(`\n💰 Calculating prices for ${allTokens.size} tokens...`);

      let processed = 0;
      for (const tokenId of allTokens) {
        await this.calculateTokenPrices(tokenId);
        processed++;

        if (processed % 100 === 0 && this.verbose) {
          console.log(
            `   Progress: ${processed}/${allTokens.size} tokens (${this.stats.pricesCalculated} prices calculated)`
          );
        }
      }

      // Summary
      console.log("\n" + "=".repeat(60));
      console.log("PRICE CALCULATION SUMMARY");
      console.log("=".repeat(60));
      console.log(`Unique tokens: ${allTokens.size}`);
      console.log(`Prices calculated: ${this.stats.pricesCalculated}`);
      console.log(`Errors: ${this.stats.errors}`);
      console.log();

      return {
        success: true,
        pricesCalculated: this.stats.pricesCalculated,
        uniqueTokens: allTokens.size,
      };
    } catch (error) {
      console.error(`\n❌ Price calculation failed: ${error.message}`);
      return {
        success: false,
        error: error.message,
        pricesCalculated: this.stats.pricesCalculated,
      };
    }
  }
}

module.exports = { DEXPriceIndexer, ANCHOR_TOKENS, STABLECOINS };
