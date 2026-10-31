/**
 * AO Token Transfer Fetcher
 *
 * Fetches all AO token transfers (Credit-Notice, Debit-Notice, Transfer actions)
 * for a wallet, including the result messages using the Pushed-For pattern.
 *
 * The Pushed-For pattern:
 * When a Transfer message is sent, resulting messages (Credit-Notice, Debit-Notice,
 * errors, contract responses) have a "Pushed-For" tag set to the original Transfer
 * message's transaction ID. This allows us to trace the complete flow.
 *
 * @module fetchers/AOTokenTransferFetcher
 */

const axios = require("axios");
const CONSTANTS = require("../../../config/ar-tracker-constants");
const { TokenInfoService } = require("../../services/ar-tracker/TokenInfoService");

class AOTokenTransferFetcher {
  constructor(options = {}) {
    // Use Goldsky as primary (better AO indexing), arweave.net as fallback
    this.gqlEndpoint = options.gqlEndpoint || CONSTANTS.GQL_ENDPOINTS.GOLDSKY;
    this.fallbackEndpoint = CONSTANTS.GQL_ENDPOINTS.ARWEAVE;
    this.batchSize = options.batchSize || CONSTANTS.QUERY.BATCH_SIZE;
    this.maxRetries = options.maxRetries || CONSTANTS.QUERY.MAX_RETRIES;
    this.retryDelay = options.retryDelay || CONSTANTS.QUERY.RETRY_DELAY;
    this.rateLimitDelay =
      options.rateLimitDelay || CONSTANTS.QUERY.RATE_LIMIT_DELAY;
    this.ownedWallets = options.ownedWallets || []; // For internal transfer detection
    this.verbose = options.verbose || false;

    // TokenInfoService for resolving unknown tokens
    this.tokenInfoService =
      options.tokenInfoService ||
      new TokenInfoService({
        verbose: this.verbose,
        cassandraService: options.cassandraService,
      });
    this.resolveUnknownTokens = options.resolveUnknownTokens !== false;
  }

  /**
   * Set TokenInfoService (for dependency injection)
   */
  setTokenInfoService(tokenInfoService) {
    this.tokenInfoService = tokenInfoService;
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
            `   🔍 GQL query attempt ${attempt}/${this.maxRetries} to ${this.gqlEndpoint}...`
          );
          console.log(`   📝 Query:\n${query.substring(0, 500)}...`);
          console.log(`   📦 Variables: ${JSON.stringify(variables)}`);
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

        // Log detailed error info on first attempt
        if (attempt === 1) {
          console.error(`   📍 Endpoint: ${this.gqlEndpoint}`);
          console.error(`   📝 Query preview:\n${query.substring(0, 300)}...`);
          console.error(`   📦 Variables sent: ${JSON.stringify(variables)}`);
          if (error.response) {
            console.error(`   📥 Response status: ${error.response.status}`);
            console.error(
              `   📥 Response data: ${JSON.stringify(
                error.response.data,
                null,
                2
              ).substring(0, 500)}`
            );
          }
        }

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
   * Parse tags from GQL node into object
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
   * Get token info from process ID
   */
  /**
   * Get token info from constants (sync version for parsing)
   */
  getTokenInfo(processId) {
    return (
      CONSTANTS.TOKENS[processId] || {
        symbol: "UNKNOWN",
        name: "Unknown Token",
        decimals: 12,
      }
    );
  }

  /**
   * Resolve unknown tokens using TokenInfoService
   * Call this after fetching transfers to populate token metadata
   */
  async resolveTokens(transfers) {
    if (!this.resolveUnknownTokens || !this.tokenInfoService) {
      return transfers;
    }

    // Collect unique unknown token process IDs
    const unknownProcessIds = new Set();
    for (const transfer of transfers) {
      if (transfer.tokenSymbol === "UNKNOWN" && transfer.tokenProcessId) {
        unknownProcessIds.add(transfer.tokenProcessId);
      }
    }

    if (unknownProcessIds.size === 0) {
      return transfers;
    }

    if (this.verbose) {
      console.log(
        `   🔍 Resolving ${unknownProcessIds.size} unknown token(s)...`
      );
    }

    // Fetch token info for all unknown tokens
    const tokenInfoMap = await this.tokenInfoService.getTokenInfoBatch([
      ...unknownProcessIds,
    ]);

    // Update transfers with resolved token info
    let resolvedCount = 0;
    for (const transfer of transfers) {
      if (transfer.tokenSymbol === "UNKNOWN" && transfer.tokenProcessId) {
        const info = tokenInfoMap.get(transfer.tokenProcessId);
        if (info && info.ticker) {
          transfer.tokenSymbol = info.ticker;
          transfer.tokenName = info.name;
          transfer.tokenDecimals = info.denomination;
          resolvedCount++;
        }
      }
    }

    if (this.verbose) {
      console.log(
        `   ✅ Resolved ${resolvedCount}/${unknownProcessIds.size} tokens`
      );
    }

    return transfers;
  }

  /**
   * Check if transfer is between owned wallets
   */
  isInternalTransfer(sender, recipient) {
    if (this.ownedWallets.length < 2) return false;
    return (
      this.ownedWallets.includes(sender) &&
      this.ownedWallets.includes(recipient)
    );
  }

  // ============================================================
  // OUTGOING TRANSFERS (wallet initiated Transfer action)
  // ============================================================

  /**
   * Fetch outgoing transfers (Action: Transfer) sent by wallet
   */
  async fetchOutgoingTransfers(walletAddress, options = {}) {
    // Handle null explicitly - destructuring defaults only work for undefined
    const limit = options.limit ?? this.batchSize;
    const after = options.after ?? null;
    const minBlock = options.minBlock ?? null;

    const blockFilter = minBlock ? ` min: ${minBlock},` : "";

    console.log(
      `📤 Fetching outgoing AO token transfers for ${walletAddress.substring(
        0,
        12
      )}...${minBlock ? ` (from block ${minBlock})` : ""}`
    );

    const allTransfers = [];
    let cursor = after;
    let hasMore = true;
    let totalFetched = 0;

    while (hasMore) {
      // Use inline template strings like the working pi_distribution_indexer
      const query = `
        query($first: Int!, $after: String) {
          transactions(
            owners: ["${walletAddress}"]
            tags: [
              { name: "Data-Protocol", values: ["ao"] }
              { name: "Action", values: ["Transfer"] }
            ]
            ${minBlock ? `block: {${blockFilter} }` : ""}
            first: $first
            after: $after
            sort: HEIGHT_DESC
          ) {
            pageInfo {
              hasNextPage
            }
            edges {
              cursor
              node {
                id
                owner { address }
                recipient
                block { height timestamp }
                tags { name value }
              }
            }
          }
        }
      `;

      const variables = {
        first: limit,
        after: cursor,
      };

      try {
        const data = await this.executeQuery(query, variables);
        const edges = data?.transactions?.edges || [];

        for (const edge of edges) {
          const transfer = this.parseOutgoingTransfer(edge.node, walletAddress);
          if (transfer) {
            allTransfers.push(transfer);
            totalFetched++;
          }
        }

        hasMore = data?.transactions?.pageInfo?.hasNextPage || false;
        if (edges.length > 0) {
          cursor = edges[edges.length - 1].cursor;
        } else {
          hasMore = false;
        }

        if (hasMore) {
          await this.sleep(this.rateLimitDelay);
        }
      } catch (error) {
        console.error(
          `   ❌ Error fetching outgoing transfers: ${error.message}`
        );
        hasMore = false;
      }
    }

    console.log(`   ✅ Found ${totalFetched} outgoing transfers`);
    return allTransfers;
  }

  /**
   * Parse outgoing transfer node
   */
  parseOutgoingTransfer(node, walletAddress) {
    const tags = this.parseTags(node.tags);

    // This is a Transfer action - get the target token process from recipient
    const tokenProcessId = node.recipient;
    const recipientWallet = tags[CONSTANTS.AO_TOKEN.TRANSFER_TAGS.RECIPIENT];
    const quantity = tags[CONSTANTS.AO_TOKEN.TRANSFER_TAGS.QUANTITY] || "0";

    if (!recipientWallet) {
      return null; // Invalid transfer
    }

    const tokenInfo = this.getTokenInfo(tokenProcessId);
    const isInternal = this.isInternalTransfer(walletAddress, recipientWallet);

    return {
      txId: node.id,
      source: CONSTANTS.TRANSACTION_SOURCES.AO_TOKEN,
      type: "transfer_out",
      direction: "outgoing",

      blockHeight: node.block?.height,
      blockTimestamp: node.block?.timestamp,

      sender: walletAddress,
      recipient: recipientWallet,

      tokenProcessId: tokenProcessId,
      tokenSymbol: tokenInfo.symbol,
      tokenDecimals: tokenInfo.decimals,
      quantity: quantity,

      isInternalTransfer: isInternal,
      isTaxableEvent: !isInternal,

      // We'll fetch result messages separately
      resultMessages: [],

      rawTags: tags,
    };
  }

  // ============================================================
  // INCOMING TRANSFERS (wallet receives Credit-Notice)
  // ============================================================

  /**
   * Fetch incoming transfers (Credit-Notice received by wallet)
   */
  async fetchIncomingTransfers(walletAddress, options = {}) {
    // Handle null explicitly - destructuring defaults only work for undefined
    const limit = options.limit ?? this.batchSize;
    const after = options.after ?? null;
    const minBlock = options.minBlock ?? null;

    const blockFilter = minBlock ? ` min: ${minBlock},` : "";

    console.log(
      `📥 Fetching incoming AO token transfers for ${walletAddress.substring(
        0,
        12
      )}...${minBlock ? ` (from block ${minBlock})` : ""}`
    );

    const allTransfers = [];
    let cursor = after;
    let hasMore = true;
    let totalFetched = 0;

    while (hasMore) {
      // Use inline template strings like the working pi_distribution_indexer
      const query = `
        query($first: Int!, $after: String) {
          transactions(
            tags: [
              { name: "Data-Protocol", values: ["ao"] }
              { name: "Action", values: ["Credit-Notice"] }
              { name: "Recipient", values: ["${walletAddress}"] }
            ]
            ${minBlock ? `block: {${blockFilter} }` : ""}
            first: $first
            after: $after
            sort: HEIGHT_DESC
          ) {
            pageInfo {
              hasNextPage
            }
            edges {
              cursor
              node {
                id
                owner { address }
                recipient
                block { height timestamp }
                tags { name value }
              }
            }
          }
        }
      `;

      const variables = {
        first: limit,
        after: cursor,
      };

      try {
        const data = await this.executeQuery(query, variables);
        const edges = data?.transactions?.edges || [];

        for (const edge of edges) {
          const transfer = this.parseIncomingTransfer(edge.node, walletAddress);
          if (transfer) {
            allTransfers.push(transfer);
            totalFetched++;
          }
        }

        hasMore = data?.transactions?.pageInfo?.hasNextPage || false;
        if (edges.length > 0) {
          cursor = edges[edges.length - 1].cursor;
        } else {
          hasMore = false;
        }

        if (hasMore) {
          await this.sleep(this.rateLimitDelay);
        }
      } catch (error) {
        console.error(
          `   ❌ Error fetching incoming transfers: ${error.message}`
        );
        hasMore = false;
      }
    }

    console.log(`   ✅ Found ${totalFetched} incoming transfers`);
    return allTransfers;
  }

  /**
   * Parse incoming transfer (Credit-Notice)
   */
  parseIncomingTransfer(node, walletAddress) {
    const tags = this.parseTags(node.tags);

    // Get the token process from From-Process tag
    const tokenProcessId = tags["From-Process"];
    const sender =
      tags[CONSTANTS.AO_TOKEN.NOTICE_TAGS.SENDER] || node.owner?.address;
    const quantity = tags[CONSTANTS.AO_TOKEN.NOTICE_TAGS.QUANTITY] || "0";

    if (!tokenProcessId) {
      return null; // Invalid credit notice
    }

    // IMPORTANT: Validate recipient matches - Goldsky indexer sometimes returns false positives
    const recipient = tags[CONSTANTS.AO_TOKEN.NOTICE_TAGS.RECIPIENT];
    if (recipient && recipient !== walletAddress) {
      // This is a false positive from the indexer - skip it
      return null;
    }

    const tokenInfo = this.getTokenInfo(tokenProcessId);
    const isInternal = this.isInternalTransfer(sender, walletAddress);

    // Get the originating transfer ID if available
    const originatingTxId = tags[CONSTANTS.AO_TOKEN.PUSHED_FOR] || null;

    return {
      txId: node.id,
      source: CONSTANTS.TRANSACTION_SOURCES.AO_TOKEN,
      type: "credit_notice",
      direction: "incoming",

      blockHeight: node.block?.height,
      blockTimestamp: node.block?.timestamp,

      sender: sender,
      recipient: walletAddress,

      tokenProcessId: tokenProcessId,
      tokenSymbol: tokenInfo.symbol,
      tokenDecimals: tokenInfo.decimals,
      quantity: quantity,

      isInternalTransfer: isInternal,
      isTaxableEvent: !isInternal,

      originatingTxId: originatingTxId,

      rawTags: tags,
    };
  }

  // ============================================================
  // MINT NOTICES (for token minting, e.g., wAR wrapping)
  // ============================================================

  /**
   * Fetch mint notices (Mint-Notice received by wallet)
   * These occur when tokens are minted (e.g., wrapping AR to wAR)
   */
  async fetchMintNotices(walletAddress, options = {}) {
    const limit = options.limit ?? this.batchSize;
    const after = options.after ?? null;
    const minBlock = options.minBlock ?? null;

    const blockFilter = minBlock ? ` min: ${minBlock},` : "";

    console.log(
      `🏭 Fetching mint notices for ${walletAddress.substring(0, 12)}...${
        minBlock ? ` (from block ${minBlock})` : ""
      }`
    );

    const allMints = [];
    let cursor = after;
    let hasMore = true;
    let totalFetched = 0;

    while (hasMore) {
      const query = `
        query($first: Int!, $after: String) {
          transactions(
            tags: [
              { name: "Data-Protocol", values: ["ao"] }
              { name: "Action", values: ["Mint-Notice"] }
              { name: "Recipient", values: ["${walletAddress}"] }
            ]
            ${minBlock ? `block: {${blockFilter} }` : ""}
            first: $first
            after: $after
            sort: HEIGHT_DESC
          ) {
            pageInfo {
              hasNextPage
            }
            edges {
              cursor
              node {
                id
                owner { address }
                recipient
                block { height timestamp }
                tags { name value }
              }
            }
          }
        }
      `;

      const variables = {
        first: limit,
        after: cursor,
      };

      try {
        const data = await this.executeQuery(query, variables);
        const edges = data?.transactions?.edges || [];

        for (const edge of edges) {
          const mint = this.parseMintNotice(edge.node, walletAddress);
          if (mint) {
            allMints.push(mint);
            totalFetched++;
          }
        }

        hasMore = data?.transactions?.pageInfo?.hasNextPage || false;
        if (edges.length > 0) {
          cursor = edges[edges.length - 1].cursor;
        } else {
          hasMore = false;
        }

        if (hasMore) {
          await this.sleep(this.rateLimitDelay);
        }
      } catch (error) {
        console.error(`   ❌ Error fetching mint notices: ${error.message}`);
        hasMore = false;
      }
    }

    console.log(`   ✅ Found ${totalFetched} mint notices`);
    return allMints;
  }

  /**
   * Parse mint notice (Mint-Notice)
   * Handles both wrapping (AR → wAR) and unwrapping (wAR → AR)
   */
  parseMintNotice(node, walletAddress) {
    const tags = this.parseTags(node.tags);

    // Get the token process from From-Process tag
    const tokenProcessId = tags["From-Process"];
    const quantity = tags[CONSTANTS.AO_TOKEN.NOTICE_TAGS.QUANTITY] || "0";
    const ticker = tags["Ticker"] || tags["Token"]; // Ticker tag indicates actual token received

    if (!tokenProcessId) {
      return null; // Invalid mint notice
    }

    // IMPORTANT: Validate recipient matches - Goldsky indexer sometimes returns false positives
    // Some tokens use "Recipient" tag (wAR, wUSDC), others use "To" tag (USDA)
    const recipient = tags["Recipient"] || tags["To"];
    if (recipient && recipient !== walletAddress) {
      // This is a false positive from the indexer - skip it
      return null;
    }

    const tokenInfo = this.getTokenInfo(tokenProcessId);
    
    // Detect unwrapping patterns:
    // 1. wAR unwrapping: Ticker: AR, From-Process: wAR process
    // 2. wUSDC unwrapping: Ticker: USDC, From-Process: wUSDC process
    const WAR_PROCESS_ID = "xU9zFkq3X2ZQ6olwNVvr1vUWIjc3kXTWr7xKQD6dh10";
    const WUSDC_PROCESS_ID = "7zH9dlMNoxprab9loshv3Y7WG45DOny_Vrq9KrXObdQ";
    
    const isWARUnwrapping = 
      ticker === "AR" && 
      tokenProcessId === WAR_PROCESS_ID;
    
    const isWUSDCUnwrapping = 
      ticker === "USDC" && 
      tokenProcessId === WUSDC_PROCESS_ID;
    
    const isUnwrapping = isWARUnwrapping || isWUSDCUnwrapping;
    
    // For unwrapping, the actual token received is the underlying asset, not the wrapped token
    // The tokenSymbol should reflect what was actually received
    let actualTokenSymbol = tokenInfo.symbol;
    let actualTokenProcessId = tokenProcessId;
    
    if (isWARUnwrapping) {
      // Unwrapping: wAR → AR, so we received AR (native)
      actualTokenSymbol = "AR";
      actualTokenProcessId = null; // AR is native, no process ID
    } else if (isWUSDCUnwrapping) {
      // Unwrapping: wUSDC → USDC, so we received USDC (bridged, but treated as native on Arweave)
      actualTokenSymbol = "USDC";
      actualTokenProcessId = null; // USDC is treated as native on Arweave side
    }

    // Get the originating transaction if available
    const originatingTxId = tags[CONSTANTS.AO_TOKEN.PUSHED_FOR] || null;
    
    // Get TxHash tag (used for linking unwrapping pairs)
    const txHash = tags["TxHash"] || null;

    return {
      txId: node.id,
      source: CONSTANTS.TRANSACTION_SOURCES.AO_TOKEN,
      type: "mint_notice",
      direction: "incoming",

      blockHeight: node.block?.height,
      blockTimestamp: node.block?.timestamp,

      sender: "MINT", // Tokens minted from thin air
      recipient: walletAddress,

      tokenProcessId: actualTokenProcessId, // Use actual token (AR for unwrapping, wAR for wrapping)
      tokenSymbol: actualTokenSymbol, // Use actual token symbol
      tokenDecimals: tokenInfo.decimals,
      quantity: quantity,

      isInternalTransfer: false,
      isTaxableEvent: !isUnwrapping, // Unwrapping is not taxable (just cost basis transfer), wrapping might be

      originatingTxId: originatingTxId,
      txHash: txHash, // For linking unwrapping pairs (may be Arweave tx or Ethereum tx for cross-chain)
      isUnwrapping: isUnwrapping, // Flag to identify unwrapping events
      isCrossChain: isWUSDCUnwrapping && txHash && txHash.startsWith("0x"), // wUSDC unwrapping uses Ethereum txHash

      rawTags: tags,
    };
  }

  // ============================================================
  // RESULT MESSAGES (Pushed-For pattern)
  // ============================================================

  /**
   * Fetch all result messages for a given transfer transaction
   * Uses the Pushed-For tag to find all messages that resulted from the transfer
   */
  async fetchTransferResults(transferTxId, options = {}) {
    // Handle null explicitly - destructuring defaults only work for undefined
    const limit = options.limit ?? this.batchSize;

    // Use inline template strings like the working pi_distribution_indexer
    const query = `
      query($first: Int!) {
        transactions(
          tags: [
            { name: "Data-Protocol", values: ["ao"] }
            { name: "Pushed-For", values: ["${transferTxId}"] }
          ]
          first: $first
          sort: HEIGHT_ASC
        ) {
          edges {
            node {
              id
              owner { address }
              recipient
              block { height timestamp }
              tags { name value }
            }
          }
        }
      }
    `;

    const variables = {
      first: limit,
    };

    try {
      const data = await this.executeQuery(query, variables);
      const edges = data?.transactions?.edges || [];

      return edges.map((edge) => this.parseResultMessage(edge.node));
    } catch (error) {
      console.error(
        `   ❌ Error fetching results for ${transferTxId}: ${error.message}`
      );
      return [];
    }
  }

  /**
   * Parse a result message
   */
  parseResultMessage(node) {
    const tags = this.parseTags(node.tags);
    const action = tags["Action"] || "Unknown";

    return {
      txId: node.id,
      action: action,
      type: this.classifyResultAction(action),
      blockHeight: node.block?.height,
      blockTimestamp: node.block?.timestamp,
      fromProcess: tags["From-Process"],
      sender: tags["Sender"],
      recipient: tags["Recipient"],
      quantity: tags["Quantity"],
      error: tags["Error"],
      rawTags: tags,
    };
  }

  /**
   * Classify result message type
   */
  classifyResultAction(action) {
    switch (action) {
      case "Credit-Notice":
        return "credit";
      case "Debit-Notice":
        return "debit";
      case "Transfer-Error":
      case "Error":
        return "error";
      default:
        return "other";
    }
  }

  // ============================================================
  // BATCH RESULT FETCHING
  // ============================================================

  /**
   * Fetch origin info for Credit-Notices that came from external sources
   * This follows the Pushed-For chain to find the original triggering transaction
   */
  async fetchOriginInfoForCreditNotices(creditNotices, options = {}) {
    for (const notice of creditNotices) {
      if (!notice.originatingTxId) continue;

      try {
        // Query the originating transaction to get more context
        const query = `
          query($id: ID!) {
            transaction(id: $id) {
              id
              owner { address }
              recipient
              block { height timestamp }
              tags { name value }
            }
          }
        `;

        const result = await this.executeQuery(query, {
          id: notice.originatingTxId,
        });

        if (result.transaction) {
          const tags = this.parseTags(result.transaction.tags);

          // Store origin info on the notice
          notice.originInfo = {
            txId: result.transaction.id,
            owner: result.transaction.owner?.address,
            action: tags["Action"],
            fromProcess: tags["From-Process"],
            blockHeight: result.transaction.block?.height,
            blockTimestamp: result.transaction.block?.timestamp,
          };
        }

        await this.sleep(50); // Small delay between queries
      } catch (error) {
        if (this.verbose) {
          console.log(
            `   ⚠️ Failed to fetch origin for ${notice.txId.substring(
              0,
              12
            )}: ${error.message}`
          );
        }
      }
    }
  }

  /**
   * Fetch results for multiple transfers in batch
   * More efficient than fetching one at a time
   */
  async fetchResultsForTransfers(transfers, options = {}) {
    const { progressCallback } = options;
    const total = transfers.length;
    let processed = 0;

    console.log(`📊 Fetching results for ${total} transfers...`);

    for (const transfer of transfers) {
      if (transfer.direction === "outgoing" && transfer.txId) {
        const results = await this.fetchTransferResults(transfer.txId);
        transfer.resultMessages = results;

        // Analyze results to determine outcome
        const hasError = results.some((r) => r.type === "error");
        const hasCredit = results.some((r) => r.type === "credit");
        const hasDebit = results.some((r) => r.type === "debit");

        transfer.transferSucceeded = hasCredit && hasDebit && !hasError;
        transfer.transferFailed = hasError;

        // Check if this was a contract interaction that produced output
        const otherResults = results.filter((r) => r.type === "other");
        if (otherResults.length > 0) {
          transfer.hasContractResponse = true;
          transfer.contractResponses = otherResults;
        }
      }

      processed++;
      if (progressCallback && processed % 10 === 0) {
        progressCallback({ processed, total });
      }

      // Rate limiting
      if (processed < total) {
        await this.sleep(this.rateLimitDelay);
      }
    }

    console.log(`   ✅ Processed results for ${processed} transfers`);
    return transfers;
  }

  // ============================================================
  // MAIN FETCH METHOD
  // ============================================================

  /**
   * Fetch complete token transfer history for a wallet
   */
  async fetchCompleteHistory(walletAddress, options = {}) {
    const { fetchResults = true, ownedWallets = [] } = options;

    // Set owned wallets for internal transfer detection
    this.ownedWallets =
      ownedWallets.length > 0 ? ownedWallets : [walletAddress];

    console.log("=".repeat(60));
    console.log(`AO TOKEN TRANSFER FETCHER`);
    console.log("=".repeat(60));
    console.log(`Wallet: ${walletAddress}`);
    console.log();

    // Fetch outgoing transfers
    const outgoing = await this.fetchOutgoingTransfers(walletAddress, options);
    await this.sleep(this.rateLimitDelay);

    // Fetch incoming transfers (Credit-Notice)
    const incoming = await this.fetchIncomingTransfers(walletAddress, options);
    await this.sleep(this.rateLimitDelay);

    // Fetch mint notices (Mint-Notice) - for token minting like wAR wrapping
    const mints = await this.fetchMintNotices(walletAddress, options);
    await this.sleep(this.rateLimitDelay);

    // Fetch qAR unwrapping actions (Unwrap and Confirm-Unwrap)
    const qarUnwraps = await this.fetchQARUnwrapping(walletAddress, options);

    // Optionally fetch result messages for outgoing transfers
    if (fetchResults && outgoing.length > 0) {
      console.log();
      await this.fetchResultsForTransfers(outgoing, options);
    }

    // For incoming Credit-Notices not from our wallets, fetch their origin
    if (fetchResults && incoming.length > 0) {
      const externalIncoming = incoming.filter(
        (tx) => tx.originatingTxId && !this.ownedWallets.includes(tx.sender)
      );
      if (externalIncoming.length > 0) {
        console.log(
          `\n📨 Fetching origin info for ${externalIncoming.length} external Credit-Notices...`
        );
        await this.fetchOriginInfoForCreditNotices(externalIncoming, options);
      }
    }

    // Combine and sort by timestamp
    const allTransfers = [...outgoing, ...incoming, ...mints, ...(qarUnwraps || [])].sort((a, b) => {
      const timeA = a.blockTimestamp || 0;
      const timeB = b.blockTimestamp || 0;
      return timeB - timeA; // Descending (newest first)
    });

    // Deduplicate (Credit-Notice may already be in results of outgoing)
    const seen = new Set();
    const deduplicated = allTransfers.filter((tx) => {
      if (seen.has(tx.txId)) return false;
      seen.add(tx.txId);
      return true;
    });

    // Resolve unknown tokens using TokenInfoService
    if (this.resolveUnknownTokens) {
      await this.resolveTokens(deduplicated);
    }

    // Generate summary
    const summary = this.generateSummary(deduplicated);

    console.log();
    console.log("=".repeat(60));
    console.log("SUMMARY");
    console.log("=".repeat(60));
    console.log(`Total transfers: ${deduplicated.length}`);
    console.log(`  - Outgoing: ${summary.outgoing}`);
    console.log(`  - Incoming: ${summary.incoming}`);
    console.log(`  - Mints: ${summary.mints || 0}`);
    console.log(`  - Internal: ${summary.internal}`);
    console.log(`  - Failed: ${summary.failed}`);
    console.log(`Unique tokens: ${summary.uniqueTokens.join(", ") || "None"}`);
    console.log();

    // Track max block height for incremental indexing
    const maxBlockHeight = deduplicated.reduce((max, tx) => {
      return Math.max(max, tx.blockHeight || 0);
    }, 0);

    return {
      wallet: walletAddress,
      transfers: deduplicated,
      summary: summary,
      maxBlockHeight: maxBlockHeight,
      fetchedAt: new Date().toISOString(),
    };
  }

  /**
   * Generate summary statistics
   */
  generateSummary(transfers) {
    const summary = {
      total: transfers.length,
      outgoing: 0,
      incoming: 0,
      mints: 0,
      internal: 0,
      failed: 0,
      byToken: {},
      uniqueTokens: [],
    };

    for (const tx of transfers) {
      // Direction counts
      if (tx.type === "mint_notice") {
        summary.mints++;
      } else if (tx.direction === "outgoing") {
        summary.outgoing++;
      } else if (tx.direction === "incoming") {
        summary.incoming++;
      }

      // Internal transfers
      if (tx.isInternalTransfer) {
        summary.internal++;
      }

      // Failed transfers
      if (tx.transferFailed) {
        summary.failed++;
      }

      // Token breakdown
      const symbol = tx.tokenSymbol || "UNKNOWN";
      if (!summary.byToken[symbol]) {
        summary.byToken[symbol] = { incoming: 0, outgoing: 0, mints: 0, total: "0" };
        summary.uniqueTokens.push(symbol);
      }

      if (tx.type === "mint_notice") {
        summary.byToken[symbol].mints++;
      } else if (tx.direction === "outgoing") {
        summary.byToken[symbol].outgoing++;
      } else {
        summary.byToken[symbol].incoming++;
      }
    }

    return summary;
  }

  // ============================================================
  // QAR UNWRAPPING (Bridge-based two-step process)
  // ============================================================

  /**
   * Fetch qAR unwrapping actions (Unwrap and Confirm-Unwrap)
   * qAR uses a two-step bridge-based unwrapping process:
   * 1. Unwrap action - Burns qAR, creates UnwrapRequest
   * 2. Confirm-Unwrap action - Confirms unwrap, provides bridge TX ID
   */
  async fetchQARUnwrapping(walletAddress, options = {}) {
    const limit = options.limit ?? this.batchSize;
    const minBlock = options.minBlock ?? null;
    const QAR_PROCESS_ID = "NG-0lVX882MG5nhARrSzyprEK6ejonHpdUmaaMPsHE8";

    const blockFilter = minBlock ? ` min: ${minBlock},` : "";

    console.log(
      `🔄 Fetching qAR unwrapping actions for ${walletAddress.substring(
        0,
        12
      )}...${minBlock ? ` (from block ${minBlock})` : ""}`
    );

    const allUnwraps = [];
    let cursor = null;
    let hasMore = true;
    let totalFetched = 0;

    while (hasMore) {
      const query = `
        query($first: Int!, $after: String) {
          transactions(
            tags: [
              { name: "Data-Protocol", values: ["ao"] }
              { name: "Target", values: ["${QAR_PROCESS_ID}"] }
              { name: "Action", values: ["Unwrap", "Confirm-Unwrap"] }
            ]
            owners: ["${walletAddress}"]
            ${minBlock ? `block: {${blockFilter} }` : ""}
            first: $first
            after: $after
            sort: HEIGHT_DESC
          ) {
            pageInfo {
              hasNextPage
            }
            edges {
              cursor
              node {
                id
                owner { address }
                recipient
                block { height timestamp }
                tags { name value }
              }
            }
          }
        }
      `;

      const variables = {
        first: limit,
        after: cursor,
      };

      try {
        const data = await this.executeQuery(query, variables);
        const edges = data?.transactions?.edges || [];

        for (const edge of edges) {
          const unwrap = this.parseQARUnwrapAction(edge.node, walletAddress);
          if (unwrap) {
            allUnwraps.push(unwrap);
            totalFetched++;
          }
        }

        hasMore = data?.transactions?.pageInfo?.hasNextPage || false;
        if (edges.length > 0) {
          cursor = edges[edges.length - 1].cursor;
        } else {
          hasMore = false;
        }

        if (hasMore) {
          await this.sleep(this.rateLimitDelay);
        }
      } catch (error) {
        console.error(`   ❌ Error fetching qAR unwrapping: ${error.message}`);
        hasMore = false;
      }
    }

    console.log(`   ✅ Found ${totalFetched} qAR unwrapping actions`);
    return allUnwraps;
  }

  /**
   * Parse qAR unwrapping action (Unwrap or Confirm-Unwrap)
   */
  parseQARUnwrapAction(node, walletAddress) {
    const tags = this.parseTags(node.tags);
    const action = tags["Action"];

    if (action !== "Unwrap" && action !== "Confirm-Unwrap") {
      return null;
    }

    const QAR_PROCESS_ID = "NG-0lVX882MG5nhARrSzyprEK6ejonHpdUmaaMPsHE8";
    const quantity = tags["Quantity"] || "0";

    return {
      txId: node.id,
      source: CONSTANTS.TRANSACTION_SOURCES.AO_TOKEN,
      type: action === "Unwrap" ? "qar_unwrap" : "qar_confirm_unwrap",
      direction: "outgoing", // User initiates unwrapping

      blockHeight: node.block?.height,
      blockTimestamp: node.block?.timestamp,

      sender: walletAddress,
      recipient: QAR_PROCESS_ID,

      tokenProcessId: QAR_PROCESS_ID,
      tokenSymbol: "qAR",
      tokenDecimals: 12,
      quantity: quantity,

      isInternalTransfer: false,
      isTaxableEvent: false, // Unwrapping is cost basis transfer, not a sale

      // Unwrap-specific fields
      unwrapRequestId: action === "Unwrap" ? node.id : tags["X-Unwrap-Request-Id"],
      transferId: tags["X-Transfer-Id"] || null, // Bridge transaction ID (in Confirm-Unwrap)

      rawTags: tags,
    };
  }
}

module.exports = { AOTokenTransferFetcher };
