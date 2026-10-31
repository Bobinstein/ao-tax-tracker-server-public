/**
 * AR History Fetcher Service
 *
 * Fetches complete transaction history for Arweave wallets.
 * Handles pagination to retrieve ALL transactions (important for tax compliance).
 *
 * Fetches:
 * - Sent transactions (wallet as owner)
 * - Received transactions (wallet as recipient)
 * - Data uploads
 * - SmartWeave interactions
 */

const axios = require("axios");
const {
  ARTransaction,
  TransactionType,
} = require("../../models/ar-tracker/ARTransaction");

const ARWEAVE_GQL = "https://arweave.net/graphql";
const GOLDSKY_GQL = "https://arweave-search.goldsky.com/graphql";

// Rate limiting
const RATE_LIMIT_DELAY = 200; // ms between requests

class ARHistoryFetcher {
  constructor(options = {}) {
    this.gqlEndpoint = options.gqlEndpoint || ARWEAVE_GQL;
    this.batchSize = options.batchSize || 100;
    this.maxRetries = options.maxRetries || 3;
    this.retryDelay = options.retryDelay || 1000;
    this.verbose = options.verbose || false;
  }

  /**
   * Sleep for rate limiting
   * @param {number} ms
   */
  async sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Execute GQL query with retries
   * @param {string} query
   * @param {Object} variables
   * @returns {Object}
   */
  async executeQuery(query, variables = {}) {
    let lastError;
    let rateLimitRetries = 0;
    const rateLimitDelays = [5000, 30000, 60000, 300000]; // 5s, 30s, 1min, 5min

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        if (this.verbose) {
          console.log(
            `   🔍 GQL query attempt ${attempt}/${this.maxRetries}...`,
          );
        }
        const startTime = Date.now();

        const response = await axios.post(
          this.gqlEndpoint,
          { query, variables },
          {
            headers: { "Content-Type": "application/json" },
            timeout: 30000,
          },
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
            `   ⏱️  Rate limited (429). Waiting ${delayStr} before retry...`,
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
   * Fetch all transactions where wallet is the owner (sender)
   * @param {string} walletAddress
   * @param {Object} options
   * @returns {AsyncGenerator}
   */
  async *fetchSentTransactions(walletAddress, options = {}) {
    const { minBlock, maxBlock, onProgress, limit } = options;
    let cursor = null;
    let totalFetched = 0;
    const startTime = Date.now();

    console.log(
      `📤 Fetching SENT transactions for ${walletAddress.substring(0, 12)}...${
        limit ? ` (limit: ${limit})` : ""
      }`,
    );

    while (true) {
      // Check if we've reached the limit
      if (limit && totalFetched >= limit) {
        console.log(`   ⏹️ Reached limit of ${limit} sent transactions`);
        break;
      }
      // Build query conditionally - only include block filter if specified
      const hasBlockFilter = minBlock != null || maxBlock != null;

      const query = hasBlockFilter
        ? `
        query GetSentTransactions(
          $owner: [String!]!
          $first: Int!
          $after: String
          $minBlock: Int
          $maxBlock: Int
        ) {
          transactions(
            owners: $owner
            first: $first
            after: $after
            block: { min: $minBlock, max: $maxBlock }
            sort: HEIGHT_ASC
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
                quantity { winston ar }
                fee { winston ar }
                data { size type }
                block { height timestamp }
                tags { name value }
              }
            }
          }
        }
      `
        : `
        query GetSentTransactions(
          $owner: [String!]!
          $first: Int!
          $after: String
        ) {
          transactions(
            owners: $owner
            first: $first
            after: $after
            sort: HEIGHT_ASC
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
                quantity { winston ar }
                fee { winston ar }
                data { size type }
                block { height timestamp }
                tags { name value }
              }
            }
          }
        }
      `;

      const variables = hasBlockFilter
        ? {
            owner: [walletAddress],
            first: this.batchSize,
            after: cursor,
            minBlock: minBlock || null,
            maxBlock: maxBlock || null,
          }
        : {
            owner: [walletAddress],
            first: this.batchSize,
            after: cursor,
          };

      const data = await this.executeQuery(query, variables);
      const edges = data?.transactions?.edges || [];

      if (edges.length === 0) break;

      for (const edge of edges) {
        // Check limit inside loop
        if (limit && totalFetched >= limit) break;

        const tx = ARTransaction.fromGQLNode(edge.node, {
          perspective: "sender",
        });
        yield tx;
        totalFetched++;
      }

      // Check if we've reached the limit
      if (limit && totalFetched >= limit) {
        console.log(`   ⏹️ Reached limit of ${limit} sent transactions`);
        break;
      }

      // Progress reporting every batch
      if (
        totalFetched % this.batchSize === 0 ||
        totalFetched < this.batchSize
      ) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = ((totalFetched / (Date.now() - startTime)) * 1000).toFixed(
          1,
        );
        console.log(
          `   📊 Sent: ${totalFetched} fetched (${elapsed}s, ${rate}/sec)`,
        );
      }

      if (onProgress) {
        onProgress({ type: "sent", count: totalFetched });
      }

      if (!data.transactions.pageInfo.hasNextPage) break;

      cursor = edges[edges.length - 1].cursor;
      await this.sleep(RATE_LIMIT_DELAY);
    }

    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `   ✅ Found ${totalFetched} sent transactions (${totalElapsed}s total)`,
    );
  }

  /**
   * Fetch all transactions where wallet is the recipient
   * @param {string} walletAddress
   * @param {Object} options
   * @returns {AsyncGenerator}
   */
  async *fetchReceivedTransactions(walletAddress, options = {}) {
    const { minBlock, maxBlock, onProgress, limit } = options;
    let cursor = null;
    let totalFetched = 0;
    const startTime = Date.now();

    console.log(
      `📥 Fetching RECEIVED transactions for ${walletAddress.substring(
        0,
        12,
      )}...${limit ? ` (limit: ${limit})` : ""}`,
    );

    while (true) {
      // Check if we've reached the limit
      if (limit && totalFetched >= limit) {
        console.log(`   ⏹️ Reached limit of ${limit} received transactions`);
        break;
      }
      // Build query conditionally - only include block filter if specified
      const hasBlockFilter = minBlock != null || maxBlock != null;

      const query = hasBlockFilter
        ? `
        query GetReceivedTransactions(
          $recipient: [String!]!
          $first: Int!
          $after: String
          $minBlock: Int
          $maxBlock: Int
        ) {
          transactions(
            recipients: $recipient
            first: $first
            after: $after
            block: { min: $minBlock, max: $maxBlock }
            sort: HEIGHT_ASC
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
                quantity { winston ar }
                fee { winston ar }
                data { size type }
                block { height timestamp }
                tags { name value }
              }
            }
          }
        }
      `
        : `
        query GetReceivedTransactions(
          $recipient: [String!]!
          $first: Int!
          $after: String
        ) {
          transactions(
            recipients: $recipient
            first: $first
            after: $after
            sort: HEIGHT_ASC
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
                quantity { winston ar }
                fee { winston ar }
                data { size type }
                block { height timestamp }
                tags { name value }
              }
            }
          }
        }
      `;

      const variables = hasBlockFilter
        ? {
            recipient: [walletAddress],
            first: this.batchSize,
            after: cursor,
            minBlock: minBlock || null,
            maxBlock: maxBlock || null,
          }
        : {
            recipient: [walletAddress],
            first: this.batchSize,
            after: cursor,
          };

      const data = await this.executeQuery(query, variables);
      const edges = data?.transactions?.edges || [];

      if (edges.length === 0) break;

      for (const edge of edges) {
        // Check limit inside loop
        if (limit && totalFetched >= limit) break;

        // Only include if there's actual AR being received
        if (
          edge.node.quantity?.winston &&
          Number(edge.node.quantity.winston) > 0
        ) {
          const tx = ARTransaction.fromGQLNode(edge.node, {
            perspective: "recipient",
          });
          // Debug: Log each received transaction with AR value
          console.log(
            `   💰 RECEIVED AR TX: ${tx.txId?.substring(0, 12)}... amount=${tx.quantityAR} AR, from=${tx.ownerAddress?.substring(0, 12)}, type=${tx.type}`,
          );
          yield tx;
          totalFetched++;
        }
      }

      // Check if we've reached the limit
      if (limit && totalFetched >= limit) {
        console.log(`   ⏹️ Reached limit of ${limit} received transactions`);
        break;
      }

      // Progress reporting every batch
      if (
        totalFetched % this.batchSize === 0 ||
        totalFetched < this.batchSize
      ) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = ((totalFetched / (Date.now() - startTime)) * 1000).toFixed(
          1,
        );
        console.log(
          `   📊 Received: ${totalFetched} fetched (${elapsed}s, ${rate}/sec)`,
        );
      }

      if (onProgress) {
        onProgress({ type: "received", count: totalFetched });
      }

      if (!data.transactions.pageInfo.hasNextPage) break;

      cursor = edges[edges.length - 1].cursor;
      await this.sleep(RATE_LIMIT_DELAY);
    }

    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `   ✅ Found ${totalFetched} received transactions (${totalElapsed}s total)`,
    );
  }

  /**
   * Fetch complete transaction history for a wallet
   * @param {string} walletAddress
   * @param {Object} options
   * @returns {Promise<ARTransaction[]>}
   */
  async fetchCompleteHistory(walletAddress, options = {}) {
    const { onProgress, ownedWallets = [] } = options;

    const allTransactions = [];
    const txMap = new Map(); // Deduplicate by txId

    // Fetch sent transactions
    console.log(
      `   📤 Fetching SENT for ${walletAddress.substring(0, 12)}, ownedWallets: [${ownedWallets.map((w) => w.substring(0, 8)).join(", ")}]`,
    );
    for await (const tx of this.fetchSentTransactions(walletAddress, options)) {
      if (!txMap.has(tx.txId)) {
        // Check if this is an internal transfer - mark it but KEEP original type
        // so we know this is from sender's perspective
        if (ownedWallets.includes(tx.targetAddress)) {
          tx.isInternalTransfer = true;
          tx.isTaxableEvent = false;
          console.log(
            `   🔗 Marked INTERNAL: ${tx.txId.substring(0, 12)} (${tx.type}) to=${tx.targetAddress?.substring(0, 12)}`,
          );
        }
        txMap.set(tx.txId, tx);
        allTransactions.push(tx);
      }
    }

    // Fetch received transactions
    for await (const tx of this.fetchReceivedTransactions(
      walletAddress,
      options,
    )) {
      if (!txMap.has(tx.txId)) {
        // Check if this is an internal transfer - mark it but KEEP original type
        // so we know this is from recipient's perspective
        if (ownedWallets.includes(tx.ownerAddress)) {
          tx.isInternalTransfer = true;
          tx.isTaxableEvent = false;
          console.log(
            `   🔗 Marked INTERNAL: ${tx.txId.substring(0, 12)} (${tx.type}) from=${tx.ownerAddress?.substring(0, 12)}`,
          );
        }
        txMap.set(tx.txId, tx);
        allTransactions.push(tx);
      }
    }

    // Sort by block height (chronological order)
    allTransactions.sort((a, b) => {
      if (a.blockHeight !== b.blockHeight) {
        return a.blockHeight - b.blockHeight;
      }
      return a.blockTimestamp - b.blockTimestamp;
    });

    console.log(`\n📊 Total unique transactions: ${allTransactions.length}`);

    return allTransactions;
  }

  /**
   * Fetch complete history for multiple wallets (identity)
   * @param {string[]} walletAddresses
   * @param {Object} options
   * @returns {Promise<ARTransaction[]>}
   */
  async fetchIdentityHistory(walletAddresses, options = {}) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`FETCHING HISTORY FOR ${walletAddresses.length} WALLET(S)`);
    console.log("=".repeat(60));

    const allTransactions = [];
    const txMap = new Map(); // Deduplicate across wallets

    for (const wallet of walletAddresses) {
      console.log(`\n--- Wallet: ${wallet} ---`);

      const walletTxs = await this.fetchCompleteHistory(wallet, {
        ...options,
        ownedWallets: walletAddresses,
      });

      for (const tx of walletTxs) {
        if (!txMap.has(tx.txId)) {
          txMap.set(tx.txId, tx);
          allTransactions.push(tx);
        }
      }
    }

    // Sort chronologically
    allTransactions.sort((a, b) => {
      if (a.blockHeight !== b.blockHeight) {
        return a.blockHeight - b.blockHeight;
      }
      return a.blockTimestamp - b.blockTimestamp;
    });

    console.log(`\n${"=".repeat(60)}`);
    console.log(`TOTAL UNIQUE TRANSACTIONS: ${allTransactions.length}`);
    console.log("=".repeat(60));

    return allTransactions;
  }

  /**
   * Get transaction summary statistics
   * @param {ARTransaction[]} transactions
   * @returns {Object}
   */
  getSummary(transactions) {
    const summary = {
      total: transactions.length,
      byType: {},
      totalReceived: { AR: 0, count: 0 },
      totalSent: { AR: 0, count: 0 },
      totalFees: { AR: 0, count: 0 },
      dataUploads: { count: 0, totalBytes: 0 },
      smartWeaveInteractions: 0,
      internalTransfers: { AR: 0, count: 0 },
      taxableEvents: 0,
      dateRange: {
        earliest: null,
        latest: null,
      },
    };

    for (const tx of transactions) {
      // Count by type
      summary.byType[tx.type] = (summary.byType[tx.type] || 0) + 1;

      // Sum amounts
      if (tx.type === TransactionType.RECEIVE) {
        summary.totalReceived.AR += tx.quantityAR;
        summary.totalReceived.count++;
      } else if (tx.type === TransactionType.SEND) {
        summary.totalSent.AR += tx.quantityAR;
        summary.totalSent.count++;
      }

      // Track internal transfers
      if (tx.isInternalTransfer) {
        summary.internalTransfers.AR += tx.quantityAR;
        summary.internalTransfers.count++;
      }

      // Sum fees
      if (tx.rewardAR > 0) {
        summary.totalFees.AR += tx.rewardAR;
        summary.totalFees.count++;
      }

      // Data uploads
      if (tx.type === TransactionType.DATA_UPLOAD) {
        summary.dataUploads.count++;
        summary.dataUploads.totalBytes += tx.dataSize || 0;
      }

      // SmartWeave
      if (tx.type === TransactionType.SMARTWEAVE_INTERACTION) {
        summary.smartWeaveInteractions++;
      }

      // Taxable events
      if (tx.isTaxableEvent) {
        summary.taxableEvents++;
      }

      // Date range (only if we have a valid timestamp)
      if (tx.blockTimestamp) {
        const txDate = tx.getDate();
        if (!isNaN(txDate.getTime())) {
          if (
            !summary.dateRange.earliest ||
            txDate < summary.dateRange.earliest
          ) {
            summary.dateRange.earliest = txDate;
          }
          if (!summary.dateRange.latest || txDate > summary.dateRange.latest) {
            summary.dateRange.latest = txDate;
          }
        }
      }
    }

    return summary;
  }
}

module.exports = { ARHistoryFetcher };
