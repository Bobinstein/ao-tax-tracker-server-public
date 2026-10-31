/**
 * DEX Swap Fetcher
 *
 * Fetches swap transactions from all DEX platforms:
 * - Permaswap (AMM)
 * - Botega/Dexi (AMM - maintenance mode)
 * - Botega Agents (limit/stop/dca orders)
 * - Bazar UCM (orderbook)
 *
 * @module fetchers/DEXSwapFetcher
 */

const axios = require("axios");
const CONSTANTS = require("../../../config/ar-tracker-constants");
const { AOMessageTracer } = require("../../services/ar-tracker/AOMessageTracer");

class DEXSwapFetcher {
  constructor(options = {}) {
    // Use Goldsky as primary (better for AO/DEX), arweave.net as fallback
    this.gqlEndpoint = options.gqlEndpoint || CONSTANTS.GQL_ENDPOINTS.GOLDSKY;
    this.fallbackEndpoint = CONSTANTS.GQL_ENDPOINTS.ARWEAVE;
    this.batchSize = options.batchSize || CONSTANTS.QUERY.BATCH_SIZE;
    this.maxRetries = options.maxRetries || CONSTANTS.QUERY.MAX_RETRIES;
    this.retryDelay = options.retryDelay || CONSTANTS.QUERY.RETRY_DELAY;
    this.rateLimitDelay =
      options.rateLimitDelay || CONSTANTS.QUERY.RATE_LIMIT_DELAY;
    this.ownedWallets = options.ownedWallets || [];
    this.verbose = options.verbose || false;

    // Initialize AO message tracer for finding swap outputs
    this.messageTracer = new AOMessageTracer({
      verbose: this.verbose,
      gqlEndpoint: this.gqlEndpoint,
    });

    // Option to enable output tracing (can be slow for many swaps)
    this.traceOutputs = options.traceOutputs !== false;
  }

  /**
   * Sleep for rate limiting
   */
  async sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Execute GQL query with retries and smart rate limit handling
   */
  async executeQuery(query, variables = {}) {
    let lastError;
    let rateLimitRetries = 0;
    const rateLimitDelays = [5000, 30000, 60000, 300000]; // 5s, 30s, 1min, 5min

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        if (this.verbose) {
          console.log(
            `   🔍 GQL query attempt ${attempt}/${this.maxRetries}...`
          );
        }
        const startTime = Date.now();

        const response = await axios.post(
          this.gqlEndpoint,
          { query, variables },
          {
            headers: { "Content-Type": "application/json" },
            timeout: CONSTANTS.QUERY.TIMEOUT,
          }
        );

        const elapsed = Date.now() - startTime;
        if (this.verbose) {
          console.log(`   ✓ Response in ${elapsed}ms`);
        }

        if (response.data.errors) {
          throw new Error(response.data.errors[0].message);
        }

        // Success - reset rate limit counter
        rateLimitRetries = 0;
        return response.data.data;
      } catch (error) {
        lastError = error;

        // Check if this is a rate limit error (429)
        const isRateLimit =
          error.response?.status === 429 ||
          error.message?.includes("429") ||
          error.message?.includes("Too Many Requests");

        if (isRateLimit) {
          const delay =
            rateLimitDelays[
              Math.min(rateLimitRetries, rateLimitDelays.length - 1)
            ];
          const delayStr =
            delay >= 60000
              ? `${delay / 60000} minute(s)`
              : `${delay / 1000} seconds`;
          console.warn(
            `   ⏱️  Rate limited (429). Waiting ${delayStr} before retry...`
          );
          await this.sleep(delay);
          rateLimitRetries++;
          attempt--; // Don't count rate limit as a failed attempt
          continue;
        }

        console.warn(`   ⚠️ Query attempt ${attempt} failed: ${error.message}`);
        if (attempt < this.maxRetries) {
          console.log(`   ⏳ Retrying in ${this.retryDelay * attempt}ms...`);
          await this.sleep(this.retryDelay * attempt);
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
   * Get token info
   */
  getTokenInfo(processId) {
    return (
      CONSTANTS.TOKENS[processId] || {
        symbol: "UNKNOWN",
        decimals: 12,
      }
    );
  }

  /**
   * Check if internal transfer
   */
  isInternalTransfer(addr1, addr2) {
    if (this.ownedWallets.length < 2) return false;
    return (
      this.ownedWallets.includes(addr1) && this.ownedWallets.includes(addr2)
    );
  }

  // ============================================================
  // PERMASWAP
  // ============================================================

  /**
   * Fetch Permaswap swaps for a wallet
   */
  async fetchPermaswapSwaps(walletAddress, options = {}) {
    const limit = options.limit ?? this.batchSize;
    console.log(
      `📊 Fetching Permaswap swaps for ${walletAddress.substring(0, 12)}...`
    );

    const query = `
      query GetPermaswapSwaps($tags: [TagFilter!]!, $first: Int!, $after: String) {
        transactions(
          tags: $tags
          first: $first
          after: $after
          sort: HEIGHT_DESC
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

    const allSwaps = [];
    let cursor = null;
    let hasMore = true;

    while (hasMore) {
      const variables = {
        tags: [
          { name: "Action", values: [CONSTANTS.PERMASWAP.SWAP_TAGS.ACTION] },
          { name: "User", values: [walletAddress] },
          {
            name: "OrderStatus",
            values: [CONSTANTS.PERMASWAP.SWAP_TAGS.ORDER_STATUS],
          },
        ],
        first: limit,
        after: cursor,
      };

      try {
        const data = await this.executeQuery(query, variables);
        const edges = data?.transactions?.edges || [];

        for (const edge of edges) {
          const swap = this.parsePermaswapSwap(edge.node, walletAddress);
          if (swap) allSwaps.push(swap);
        }

        hasMore = data?.transactions?.pageInfo?.hasNextPage || false;
        if (edges.length > 0) {
          cursor = edges[edges.length - 1].cursor;
        } else {
          hasMore = false;
        }

        if (hasMore) await this.sleep(this.rateLimitDelay);
      } catch (error) {
        console.log(`   ⚠️  Permaswap query failed: ${error.message}`);
        hasMore = false;
      }
    }

    console.log(`   ✅ Found ${allSwaps.length} Permaswap swaps`);
    return allSwaps;
  }

  /**
   * Parse Permaswap swap
   */
  parsePermaswapSwap(node, walletAddress) {
    const tags = this.parseTags(node.tags);

    const inputToken = this.getTokenInfo(tags["TokenIn"]);
    const outputToken = this.getTokenInfo(tags["TokenOut"]);

    return {
      txId: node.id,
      source: CONSTANTS.TRANSACTION_SOURCES.PERMASWAP,
      type: CONSTANTS.UNIFIED_TX_TYPES.DEX_SWAP,
      platform: "permaswap",

      blockHeight: node.block?.height,
      blockTimestamp: node.block?.timestamp,

      walletAddress: walletAddress,
      user: tags["User"],

      orderId: tags["OrderId"],
      poolId: tags["PoolId"],
      poolName: tags["Pool"],

      // Input (what user gave up)
      tokenIn: tags["TokenIn"],
      tokenInSymbol: inputToken.symbol,
      tokenInDecimals: inputToken.decimals,
      amountIn: tags["AmountIn"] || "0",

      // Output (what user received)
      tokenOut: tags["TokenOut"],
      tokenOutSymbol: outputToken.symbol,
      tokenOutDecimals: outputToken.decimals,
      amountOut: tags["AmountOut"] || "0",

      // Transaction references
      txIn: tags["TxIn"],
      txOut: tags["TxOut"],

      isTaxableEvent: true,
      isSwap: true,

      rawTags: tags,
    };
  }

  // ============================================================
  // BOTEGA/DEXI
  // ============================================================

  /**
   * Fetch Botega swaps for a wallet
   */
  async fetchBotegaSwaps(walletAddress, options = {}) {
    const limit = options.limit ?? this.batchSize;
    console.log(
      `📊 Fetching Botega swaps for ${walletAddress.substring(0, 12)}...`
    );

    const query = `
      query GetBotegaSwaps($tags: [TagFilter!]!, $first: Int!) {
        transactions(
          tags: $tags
          first: $first
          sort: HEIGHT_DESC
        ) {
          edges {
            node {
              id
              block { height timestamp }
              tags { name value }
            }
          }
        }
      }
    `;

    const variables = {
      tags: [
        {
          name: "Data-Protocol",
          values: [CONSTANTS.BOTEGA.SWAP_TAGS.DATA_PROTOCOL],
        },
        { name: "Type", values: [CONSTANTS.BOTEGA.SWAP_TAGS.TYPE] },
        { name: "Action", values: [CONSTANTS.BOTEGA.SWAP_TAGS.ACTION] },
        { name: CONSTANTS.BOTEGA.SWAP_TAGS.USER_TAG, values: [walletAddress] },
      ],
      first: limit,
    };

    try {
      const data = await this.executeQuery(query, variables);
      const edges = data?.transactions?.edges || [];

      const swaps = edges.map((edge) =>
        this.parseBotegaSwap(edge.node, walletAddress)
      );
      console.log(`   ✅ Found ${swaps.length} Botega swaps`);
      return swaps.filter(Boolean);
    } catch (error) {
      console.log(`   ⚠️  Botega query failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Parse Botega swap
   */
  parseBotegaSwap(node, walletAddress) {
    const tags = this.parseTags(node.tags);

    const inputToken = this.getTokenInfo(tags["From-Token"]);
    const outputToken = this.getTokenInfo(tags["To-Token"]);

    return {
      txId: node.id,
      source: CONSTANTS.TRANSACTION_SOURCES.BOTEGA,
      type: CONSTANTS.UNIFIED_TX_TYPES.DEX_SWAP,
      platform: "botega",

      blockHeight: node.block?.height,
      blockTimestamp: node.block?.timestamp,

      walletAddress: walletAddress,
      user: tags["User"],

      orderId: tags["Order-Id"],

      // Input
      tokenIn: tags["From-Token"],
      tokenInSymbol: inputToken.symbol,
      tokenInDecimals: inputToken.decimals,
      amountIn: tags["From-Quantity"] || "0",

      // Output
      tokenOut: tags["To-Token"],
      tokenOutSymbol: outputToken.symbol,
      tokenOutDecimals: outputToken.decimals,
      amountOut: tags["To-Quantity"] || "0",

      // Fees
      feePercentage: tags["Fee-Percentage"],
      totalFee: tags["Total-Fee"],
      lpFee: tags["LP-Fee"],
      protocolFee: tags["Protocol-Fee"],

      isTaxableEvent: true,
      isSwap: true,

      rawTags: tags,
    };
  }

  // ============================================================
  // BOTEGA AGENTS
  // ============================================================

  /**
   * Fetch Botega agent order confirmations
   */
  async fetchAgentOrders(walletAddress, options = {}) {
    const limit = options.limit ?? this.batchSize;
    console.log(
      `📊 Fetching Botega agent orders for ${walletAddress.substring(0, 12)}...`
    );

    const query = `
      query GetAgentOrders($tags: [TagFilter!]!, $first: Int!) {
        transactions(
          tags: $tags
          first: $first
          sort: HEIGHT_DESC
        ) {
          edges {
            node {
              id
              block { height timestamp }
              tags { name value }
            }
          }
        }
      }
    `;

    const variables = {
      tags: [
        { name: "Data-Protocol", values: ["ao"] },
        { name: "Type", values: ["Message"] },
        { name: "Action", values: [CONSTANTS.BOTEGA.AGENT_TAGS.ACTION] },
        {
          name: CONSTANTS.BOTEGA.AGENT_TAGS.ORDER_OWNER,
          values: [walletAddress],
        },
      ],
      first: limit,
    };

    try {
      const data = await this.executeQuery(query, variables);
      const edges = data?.transactions?.edges || [];

      const orders = edges.map((edge) =>
        this.parseAgentOrder(edge.node, walletAddress)
      );
      console.log(`   ✅ Found ${orders.length} agent orders`);
      return orders.filter(Boolean);
    } catch (error) {
      console.log(`   ⚠️  Agent orders query failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Parse agent order
   */
  parseAgentOrder(node, walletAddress) {
    const tags = this.parseTags(node.tags);

    const inputToken = this.getTokenInfo(tags["Token-From"]);
    const outputToken = this.getTokenInfo(tags["Token-To"]);

    return {
      txId: node.id,
      source: CONSTANTS.TRANSACTION_SOURCES.AGENTS,
      type: CONSTANTS.UNIFIED_TX_TYPES.DEX_SWAP,
      platform: "botega_agent",

      blockHeight: node.block?.height,
      blockTimestamp: node.block?.timestamp,

      walletAddress: walletAddress,
      orderOwner: tags["Order-Owner"],

      agentType: tags["Agent-Type"],
      status: tags["Status"],

      // Input
      tokenIn: tags["Token-From"],
      tokenInSymbol: inputToken.symbol,
      tokenInDecimals: inputToken.decimals,
      amountIn: tags["Input"] || "0",

      // Output
      tokenOut: tags["Token-To"],
      tokenOutSymbol: outputToken.symbol,
      tokenOutDecimals: outputToken.decimals,
      minOutput: tags["Min-Output"],

      filledPrice: tags["Filled-Price"],
      filledPercentage: tags["Filled-Percentage"],

      isTaxableEvent: tags["Status"] === "Complete",
      isSwap: true,

      rawTags: tags,
    };
  }

  // ============================================================
  // BAZAR UCM
  // ============================================================

  /**
   * Fetch Bazar UCM trades
   */
  async fetchBazarTrades(walletAddress, options = {}) {
    const limit = options.limit ?? this.batchSize;
    console.log(
      `📊 Fetching Bazar UCM trades for ${walletAddress.substring(0, 12)}...`
    );

    const query = `
      query GetBazarTrades($wallet: [String!]!, $tags: [TagFilter!]!, $first: Int!) {
        transactions(
          recipients: $wallet
          tags: $tags
          first: $first
          sort: HEIGHT_DESC
        ) {
          edges {
            node {
              id
              block { height timestamp }
              tags { name value }
              recipient
            }
          }
        }
      }
    `;

    const variables = {
      wallet: [walletAddress],
      tags: [
        { name: "Action", values: [CONSTANTS.BAZAR.UCM_TAGS.ACTION] },
        { name: "Status", values: [CONSTANTS.BAZAR.UCM_TAGS.STATUS] },
        { name: "Handler", values: [CONSTANTS.BAZAR.UCM_TAGS.HANDLER] },
        {
          name: "Data-Protocol",
          values: [CONSTANTS.BAZAR.UCM_TAGS.DATA_PROTOCOL],
        },
      ],
      first: limit,
    };

    try {
      const data = await this.executeQuery(query, variables);
      const edges = data?.transactions?.edges || [];

      const trades = edges.map((edge) =>
        this.parseBazarTrade(edge.node, walletAddress)
      );
      console.log(`   ✅ Found ${trades.length} Bazar trades`);
      return trades.filter(Boolean);
    } catch (error) {
      console.log(`   ⚠️  Bazar query failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Parse Bazar trade
   */
  parseBazarTrade(node, walletAddress) {
    const tags = this.parseTags(node.tags);

    const side = tags["Side"]; // "Ask" or "Bid"
    const incomingSide = tags["IncomingSide"]; // Present if order was matched

    // Determine event type
    let type = "listing";
    let isTaxable = false;

    if (incomingSide) {
      // Order was matched/executed
      if (side === "Ask") {
        type = CONSTANTS.UNIFIED_TX_TYPES.ORDERBOOK_SALE;
        isTaxable = true;
      } else if (side === "Bid") {
        type = CONSTANTS.UNIFIED_TX_TYPES.ORDERBOOK_PURCHASE;
        isTaxable = true;
      }
    } else {
      // Just listing or bid creation - not taxable
      type = side === "Ask" ? "listing" : "bid";
    }

    const dominantToken = this.getTokenInfo(tags["DominantToken"]);
    const swapToken = this.getTokenInfo(tags["SwapToken"]);

    const sender = tags["Sender"] || tags["From-Process"];
    const recipient = node.recipient;
    const isInternal = this.isInternalTransfer(sender, recipient);

    return {
      txId: node.id,
      source: CONSTANTS.TRANSACTION_SOURCES.BAZAR,
      type: type,
      platform: "bazar",

      blockHeight: node.block?.height,
      blockTimestamp: node.block?.timestamp,

      walletAddress: walletAddress,
      sender: sender,
      recipient: recipient,

      side: side,
      incomingSide: incomingSide,

      dominantToken: tags["DominantToken"],
      dominantTokenSymbol: dominantToken.symbol,
      dominantTokenDecimals: dominantToken.decimals,

      swapToken: tags["SwapToken"],
      swapTokenSymbol: swapToken.symbol,
      swapTokenDecimals: swapToken.decimals,

      quantity: tags["Quantity"],
      price: tags["Price"],

      isTaxableEvent: isTaxable,
      isInternalTransfer: isInternal,
      isSwap: isTaxable, // Executed trades are swaps

      rawTags: tags,
    };
  }

  // ============================================================
  // ORDER CONFIRMATIONS (EXECUTED TRADES)
  // ============================================================

  /**
   * Fetch Order-Confirmation messages for a wallet
   * These are the actual executed trades on Bazar/AMM platforms
   */
  async fetchOrderConfirmations(walletAddress, options = {}) {
    const limit = options.limit ?? this.batchSize;
    console.log(
      `📊 Fetching executed trades for ${walletAddress.substring(0, 12)}...`
    );

    const query = `
      query GetOrderConfirmations($user: [String!]!, $first: Int!) {
        transactions(
          first: $first
          tags: [
            { name: "Action", values: ["Order-Confirmation"] },
            { name: "User", values: $user }
          ]
          sort: HEIGHT_DESC
        ) {
          edges {
            node {
              id
              block { height timestamp }
              tags { name value }
            }
          }
        }
      }
    `;

    const variables = {
      user: [walletAddress],
      first: limit,
    };

    try {
      console.log(`   🔍 GQL query attempt...`);
      const startTime = Date.now();

      const response = await axios.post(
        this.gqlEndpoint,
        { query, variables },
        {
          headers: { "Content-Type": "application/json" },
          timeout: CONSTANTS.QUERY.TIMEOUT,
        }
      );

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`   ✓ Response in ${elapsed}s`);

      const data = response.data?.data;
      const edges = data?.transactions?.edges || [];

      const trades = [];
      for (const edge of edges) {
        const trade = this.parseOrderConfirmation(edge.node, walletAddress);
        if (trade) trades.push(trade);
      }

      console.log(`   ✅ Found ${trades.length} executed trades`);
      return trades;
    } catch (error) {
      console.error(
        `   ❌ Error fetching order confirmations: ${error.message}`
      );
      return [];
    }
  }

  /**
   * Parse Order-Confirmation message into trade format
   */
  parseOrderConfirmation(node, walletAddress) {
    const tags = this.parseTags(node.tags);

    const inputToken = this.getTokenInfo(tags["From-Token"]);
    const outputToken = this.getTokenInfo(tags["To-Token"]);

    return {
      txId: node.id,
      source: CONSTANTS.TRANSACTION_SOURCES.BAZAR,
      type: CONSTANTS.UNIFIED_TX_TYPES.DEX_SWAP,
      platform: "bazar_amm",

      blockHeight: node.block?.height,
      blockTimestamp: node.block?.timestamp,

      walletAddress: walletAddress,
      orderId: tags["Order-Id"],

      // Input (what user sent)
      tokenIn: tags["From-Token"],
      tokenInSymbol: inputToken.symbol,
      tokenInDecimals: inputToken.decimals,
      amountIn: tags["From-Quantity"] || "0",

      // Output (what user received)
      tokenOut: tags["To-Token"],
      tokenOutSymbol: outputToken.symbol,
      tokenOutDecimals: outputToken.decimals,
      amountOut: tags["To-Quantity"] || "0",

      // Fees
      lpFee: tags["LP-Fee"],
      protocolFee: tags["Protocol-Fee"],
      totalFee: tags["Total-Fee"],
      feePercentage: tags["Fee-Percentage"],

      // References
      pushedFor: tags["Pushed-For"],
      xArbId: tags["X-Arb-Id"],
      triggerTimestamp: tags["Trigger-Timestamp"],

      isTaxableEvent: true, // Order confirmations are always executed trades
      isSwap: true,
      isOrderConfirmation: true,

      rawTags: tags,
    };
  }

  // ============================================================
  // VENTO BRIDGE
  // ============================================================

  /**
   * Fetch VentoSwap bridge operations
   */
  async fetchVentoBridgeOps(walletAddress, options = {}) {
    const limit = options.limit ?? this.batchSize;
    console.log(
      `📊 Fetching Vento bridge operations for ${walletAddress.substring(
        0,
        12
      )}...`
    );

    const deposits = await this.fetchVentoBridgeDeposits(
      walletAddress,
      options
    );
    await this.sleep(this.rateLimitDelay);
    const withdrawals = await this.fetchVentoBridgeWithdrawals(
      walletAddress,
      options
    );

    const allOps = [...deposits, ...withdrawals];
    console.log(
      `   ✅ Found ${allOps.length} bridge operations (${deposits.length} deposits, ${withdrawals.length} withdrawals)`
    );

    return allOps;
  }

  /**
   * Fetch bridge deposits (AR → vAR)
   */
  async fetchVentoBridgeDeposits(walletAddress, options = {}) {
    const limit = options.limit ?? this.batchSize;

    const query = `
      query GetBridgeDeposits($wallet: [String!]!, $bridge: [String!]!, $tags: [TagFilter!]!, $first: Int!) {
        transactions(
          owners: $wallet
          recipients: $bridge
          tags: $tags
          first: $first
          sort: HEIGHT_DESC
        ) {
          edges {
            node {
              id
              block { height timestamp }
              tags { name value }
              quantity { ar winston }
            }
          }
        }
      }
    `;

    const variables = {
      wallet: [walletAddress],
      bridge: [CONSTANTS.VENTO.BRIDGE_ADDRESS],
      tags: [
        { name: "App-Name", values: [CONSTANTS.VENTO.BRIDGE_TAGS.APP_NAME] },
        {
          name: "Action",
          values: [CONSTANTS.VENTO.BRIDGE_TAGS.ACTION_DEPOSIT],
        },
      ],
      first: limit,
    };

    try {
      const data = await this.executeQuery(query, variables);
      const edges = data?.transactions?.edges || [];

      return edges.map((edge) =>
        this.parseBridgeDeposit(edge.node, walletAddress)
      );
    } catch (error) {
      console.log(`   ⚠️  Bridge deposits query failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Fetch bridge withdrawals (vAR → AR)
   */
  async fetchVentoBridgeWithdrawals(walletAddress, options = {}) {
    const limit = options.limit ?? this.batchSize;

    const query = `
      query GetVARBurns($tags: [TagFilter!]!, $first: Int!) {
        transactions(
          tags: $tags
          first: $first
          sort: HEIGHT_DESC
        ) {
          edges {
            node {
              id
              block { height timestamp }
              tags { name value }
            }
          }
        }
      }
    `;

    const variables = {
      tags: [
        { name: "From-Process", values: [CONSTANTS.VENTO.VAR_TOKEN] },
        { name: "Action", values: [CONSTANTS.VENTO.BRIDGE_TAGS.ACTION_BURN] },
        { name: "Sender", values: [walletAddress] },
      ],
      first: limit,
    };

    try {
      const data = await this.executeQuery(query, variables);
      const edges = data?.transactions?.edges || [];

      return edges.map((edge) =>
        this.parseBridgeWithdrawal(edge.node, walletAddress)
      );
    } catch (error) {
      console.log(`   ⚠️  Bridge withdrawals query failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Parse bridge deposit
   */
  parseBridgeDeposit(node, walletAddress) {
    const tags = this.parseTags(node.tags);

    return {
      txId: node.id,
      source: CONSTANTS.TRANSACTION_SOURCES.VENTO_BRIDGE,
      type: CONSTANTS.UNIFIED_TX_TYPES.BRIDGE_DEPOSIT,
      platform: "vento",

      blockHeight: node.block?.height,
      blockTimestamp: node.block?.timestamp,

      walletAddress: walletAddress,
      forwardWallet: tags[CONSTANTS.VENTO.BRIDGE_TAGS.FORWARD_WALLET],

      tokenIn: "AR",
      tokenOut: "vAR",
      amountAR: node.quantity?.ar || "0",
      amountWinston: node.quantity?.winston || "0",

      isTaxableEvent: false, // Bridge ops generally non-taxable
      isSwap: false,

      rawTags: tags,
    };
  }

  /**
   * Parse bridge withdrawal
   */
  parseBridgeWithdrawal(node, walletAddress) {
    const tags = this.parseTags(node.tags);

    return {
      txId: node.id,
      source: CONSTANTS.TRANSACTION_SOURCES.VENTO_BRIDGE,
      type: CONSTANTS.UNIFIED_TX_TYPES.BRIDGE_WITHDRAWAL,
      platform: "vento",

      blockHeight: node.block?.height,
      blockTimestamp: node.block?.timestamp,

      walletAddress: walletAddress,
      forwardWallet: tags[CONSTANTS.VENTO.BRIDGE_TAGS.FORWARD_WALLET],

      tokenIn: "vAR",
      tokenOut: "AR",
      quantity: tags["Quantity"],

      isTaxableEvent: false,
      isSwap: false,

      rawTags: tags,
    };
  }

  // ============================================================
  // MAIN FETCH METHOD
  // ============================================================

  /**
   * Fetch all DEX activity for a wallet
   */
  async fetchAllDEXActivity(walletAddress, options = {}) {
    const {
      ownedWallets = [],
      platforms = ["permaswap", "botega", "agents", "bazar", "vento"],
    } = options;

    this.ownedWallets =
      ownedWallets.length > 0 ? ownedWallets : [walletAddress];

    console.log("=".repeat(60));
    console.log("DEX SWAP FETCHER");
    console.log("=".repeat(60));
    console.log(`Wallet: ${walletAddress}`);
    console.log(`Platforms: ${platforms.join(", ")}`);
    console.log();

    const results = {
      wallet: walletAddress,
      fetchedAt: new Date().toISOString(),
      permaswap: [],
      botega: [],
      agents: [],
      bazar: [],
      orderConfirmations: [],
      vento: [],
    };

    // Fetch from each platform
    if (platforms.includes("permaswap")) {
      results.permaswap = await this.fetchPermaswapSwaps(
        walletAddress,
        options
      );
      await this.sleep(this.rateLimitDelay);
    }

    if (platforms.includes("botega")) {
      results.botega = await this.fetchBotegaSwaps(walletAddress, options);
      await this.sleep(this.rateLimitDelay);
    }

    if (platforms.includes("agents")) {
      results.agents = await this.fetchAgentOrders(walletAddress, options);
      await this.sleep(this.rateLimitDelay);
    }

    if (platforms.includes("bazar")) {
      results.bazar = await this.fetchBazarTrades(walletAddress, options);
      await this.sleep(this.rateLimitDelay);

      // Also fetch Order-Confirmations (executed AMM trades)
      results.orderConfirmations = await this.fetchOrderConfirmations(
        walletAddress,
        options
      );
      await this.sleep(this.rateLimitDelay);
    }

    if (platforms.includes("vento")) {
      results.vento = await this.fetchVentoBridgeOps(walletAddress, options);
    }

    // Trace output amounts for swaps that don't have them
    if (this.traceOutputs) {
      await this.traceSwapOutputs(results);
    }

    // Calculate totals
    const totalSwaps =
      results.permaswap.length + results.botega.length + results.agents.length;
    const totalOrderConfirmations = results.orderConfirmations.length;
    const totalTrades = results.bazar.filter((t) => t.isTaxableEvent).length;
    const totalBridgeOps = results.vento.length;

    console.log();
    console.log("=".repeat(60));
    console.log("SUMMARY");
    console.log("=".repeat(60));
    console.log(`Total DEX swaps: ${totalSwaps}`);
    console.log(`  - Permaswap: ${results.permaswap.length}`);
    console.log(`  - Botega: ${results.botega.length}`);
    console.log(`  - Agents: ${results.agents.length}`);
    console.log(`Executed AMM trades: ${totalOrderConfirmations}`);
    console.log(
      `Bazar orderbook: ${totalTrades} trades (of ${results.bazar.length} orders)`
    );
    console.log(`Total bridge ops: ${totalBridgeOps}`);
    console.log();

    return results;
  }

  /**
   * Trace output amounts for swaps that don't have them in tags
   */
  async traceSwapOutputs(results) {
    // Collect swaps that need output tracing
    const needsTracing = [];

    // Agent orders typically only have Min-Output
    for (const order of results.agents || []) {
      if (!order.amountOut || order.amountOut === "0") {
        needsTracing.push(order);
      }
    }

    // Bazar trades may need output verification
    for (const trade of results.bazar || []) {
      if (trade.isTaxableEvent && (!trade.quantity || trade.quantity === "0")) {
        needsTracing.push(trade);
      }
    }

    if (needsTracing.length === 0) {
      return;
    }

    console.log(
      `\n📡 Tracing output amounts for ${needsTracing.length} swaps...`
    );

    let traced = 0;
    let successful = 0;

    for (const swap of needsTracing) {
      try {
        const result = await this.messageTracer.traceSwapOutput(swap);
        traced++;

        if (result && result.hasOutput) {
          swap.amountOut = result.outputAmount;
          swap.outputSource = result.source;
          swap.outputTraced = true;
          successful++;
        }

        if (traced % 5 === 0) {
          console.log(
            `   Traced ${traced}/${needsTracing.length} swaps (${successful} successful)`
          );
        }
      } catch (error) {
        console.log(`   ⚠️ Failed to trace ${swap.txId}: ${error.message}`);
      }

      // Rate limiting
      await this.sleep(100);
    }

    console.log(
      `   ✅ Traced ${traced} swaps, found outputs for ${successful}`
    );
  }
}

module.exports = { DEXSwapFetcher };

module.exports = { DEXSwapFetcher };
