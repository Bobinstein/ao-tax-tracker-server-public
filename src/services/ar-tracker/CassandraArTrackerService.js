/**
 * Cassandra AR Tracker Service
 *
 * Handles all database operations for AR wallet history and tax tracking.
 * Adapted from ar-wallet-history-tracker for integration into ao-tax-tracker-server.
 *
 * Uses the server's config/database.js for configuration.
 *
 * @module services/ar-tracker/CassandraArTrackerService
 */

const cassandra = require("cassandra-driver");
const CONFIG = require("../../../config/database");

class CassandraArTrackerService {
  constructor(options = {}) {
    this.config = options.config || CONFIG.AR_TAX_TRACKER_DB;
    this.client = null;
    this.isConnected = false;
    this.batchSize = options.batchSize || 50;
    this.verbose = options.verbose || false;
  }

  // ============================================================
  // CONNECTION MANAGEMENT
  // ============================================================

  /**
   * Connect to Cassandra cluster
   */
  async connect() {
    if (this.isConnected) return;

    try {
      // Create client with keyspace
      this.client = new cassandra.Client({
        contactPoints: this.config.contactPoints,
        localDataCenter: this.config.localDataCenter,
        keyspace: this.config.keyspace,
        pooling: this.config.pooling,
        socketOptions: this.config.socketOptions,
      });

      await this.client.connect();
      this.isConnected = true;

      if (this.verbose) {
        console.log(
          `✅ Connected to Cassandra keyspace: ${this.config.keyspace}`,
        );
      }
    } catch (error) {
      console.error("❌ Failed to connect to Cassandra:", error.message);
      throw error;
    }
  }

  /**
   * Disconnect from Cassandra
   */
  async disconnect() {
    if (this.client) {
      try {
        await this.client.shutdown();
        if (this.verbose) {
          console.log("✅ Cassandra client shutdown complete");
        }
      } catch (error) {
        console.error("Error during shutdown:", error.message);
      }
      this.isConnected = false;
    }
  }

  /**
   * Ensure connection is established with retry logic
   */
  async ensureConnection() {
    let retries = 3;
    while (retries > 0) {
      try {
        if (!this.client || !this.isConnected) {
          await this.connect();
        }
        // Test connection
        await this.client.execute("SELECT now() FROM system.local");
        return;
      } catch (error) {
        retries--;
        if (retries === 0) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  /**
   * Execute query with retry logic
   */
  async executeWithRetry(query, params = [], options = { prepare: true }) {
    let retries = 3;
    while (retries > 0) {
      try {
        await this.ensureConnection();
        return await this.client.execute(query, params, options);
      } catch (error) {
        retries--;
        if (error.message.includes("BusyConnectionError") && retries > 0) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } else if (retries > 0) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        } else {
          throw error;
        }
      }
    }
  }

  // ============================================================
  // UNIFIED TRANSACTIONS OPERATIONS
  // ============================================================

  /**
   * Save a unified transaction to the originals table (immutable)
   * @param {Object} tx - Transaction data
   */
  async saveUnifiedTransactionOriginal(tx) {
    await this.ensureConnection();

    const blockTimestamp = this._normalizeTimestamp(tx.blockTimestamp);
    const metadata = this._buildMetadata(tx);

    // Debug: Log internal transfer values being inserted
    if (tx.isInternalTransfer || tx.type === "INTERNAL_TRANSFER") {
      console.log(`   💾 INSERT INTERNAL_TRANSFER:`, {
        wallet: tx.walletAddress?.substring(0, 12),
        type: tx.type,
        isInternalTransfer: tx.isInternalTransfer,
        txId: tx.txId?.substring(0, 12),
      });
    }

    // Debug: Log AR RECEIVE values being inserted
    if (tx.type === "RECEIVE" && tx.source === "ar_l1") {
      console.log(`   💾 INSERT AR RECEIVE:`, {
        wallet: tx.walletAddress?.substring(0, 12),
        timestamp: blockTimestamp,
        txId: tx.txId?.substring(0, 12),
        tokenSymbol: tx.tokenSymbol,
        amountHuman: tx.amountHuman,
        source: tx.source,
      });
    }

    await this.executeWithRetry(
      `INSERT INTO ${CONFIG.AR_TRACKER_TABLES.UNIFIED_TRANSACTIONS_ORIGINALS}
       (wallet_address, block_timestamp, tx_id, type, token_symbol,
        amount_units, amount_human, price_usd, value_usd, fee_ar, fee_usd,
        counterparty, source, input_token, output_token, input_amount,
        output_amount, proceeds_per_unit, proceeds_usd, is_staked,
        tax_category, block_height, metadata, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tx.walletAddress,
        blockTimestamp,
        tx.txId,
        tx.type,
        tx.tokenSymbol || null,
        tx.amountUnits?.toString() || null,
        tx.amountHuman || null,
        tx.priceUSD || null,
        tx.valueUSD || null,
        tx.feeAR || null,
        tx.feeUSD || null,
        tx.counterparty || null,
        tx.source || null,
        tx.inputTokenSymbol || null,
        tx.outputTokenSymbol || null,
        tx.inputAmountHuman || null,
        tx.outputAmountHuman || null,
        tx.proceedsPerUnit || null,
        tx.proceedsUSD || null,
        tx.isStaked || false,
        tx.taxCategory || null,
        tx.blockHeight || null,
        metadata ? JSON.stringify(metadata) : null,
        new Date(),
      ],
    );

    // Verify internal transfer was saved
    if (tx.isInternalTransfer || tx.type === "INTERNAL_TRANSFER") {
      try {
        const verifyResult = await this.client.execute(
          `SELECT tx_id, type FROM ${CONFIG.AR_TRACKER_TABLES.UNIFIED_TRANSACTIONS_ORIGINALS}
           WHERE wallet_address = ? AND block_timestamp = ? AND tx_id = ?`,
          [tx.walletAddress, blockTimestamp, tx.txId],
          { prepare: true },
        );
        if (verifyResult.rows.length > 0) {
          console.log(
            `   ✅ VERIFIED INTERNAL_TRANSFER saved: txId=${tx.txId?.substring(0, 12)}, type=${verifyResult.rows[0].type}`,
          );
        } else {
          console.log(
            `   ❌ INTERNAL_TRANSFER NOT FOUND after insert: wallet=${tx.walletAddress?.substring(0, 12)}, txId=${tx.txId?.substring(0, 12)}`,
          );
        }
      } catch (verifyError) {
        console.log(`   ⚠️ Verify query failed: ${verifyError.message}`);
      }
    }
  }

  /**
   * Save multiple unified transactions to originals table (batch)
   * Skips duplicates based on primary key
   * @param {Object[]} transactions
   * @returns {number} Number of transactions saved
   */
  async saveUnifiedTransactionsOriginalsBatch(transactions) {
    if (!transactions || transactions.length === 0) return 0;

    await this.ensureConnection();

    let saved = 0;
    let skipped = 0;
    let debugLogged = 0;

    for (let i = 0; i < transactions.length; i += this.batchSize) {
      const batch = transactions.slice(i, i + this.batchSize);

      for (const tx of batch) {
        try {
          // Debug: Log internal transfers before save
          if (tx.isInternalTransfer || tx.type === "INTERNAL_TRANSFER") {
            console.log(`   🔍 DEBUG INTERNAL before batch save:`, {
              txId: tx.txId?.substring(0, 12),
              type: tx.type,
              isInternalTransfer: tx.isInternalTransfer,
              walletAddress: tx.walletAddress?.substring(0, 12),
            });
          }

          // Debug: Log first 3 AR RECEIVE transactions to verify data
          if (
            tx.type === "RECEIVE" &&
            tx.source === "ar_l1" &&
            debugLogged < 3
          ) {
            console.log(`   🔍 DEBUG AR RECEIVE before save:`, {
              txId: tx.txId?.substring(0, 12),
              type: tx.type,
              source: tx.source,
              tokenSymbol: tx.tokenSymbol,
              amountHuman: tx.amountHuman,
              blockTimestamp: tx.blockTimestamp,
              walletAddress: tx.walletAddress?.substring(0, 12),
            });
            debugLogged++;
          }

          // Check if transaction already exists
          const checkResult = await this.client.execute(
            `SELECT tx_id FROM ${CONFIG.AR_TRACKER_TABLES.UNIFIED_TRANSACTIONS_ORIGINALS}
             WHERE wallet_address = ? AND block_timestamp = ? AND tx_id = ?`,
            [
              tx.walletAddress,
              this._normalizeTimestamp(tx.blockTimestamp),
              tx.txId,
            ],
            { prepare: true },
          );

          if (checkResult.rows.length === 0) {
            await this.saveUnifiedTransactionOriginal(tx);
            saved++;
          } else {
            skipped++;
          }
        } catch (error) {
          if (this.verbose) {
            console.log(
              `   ⚠️ Error saving transaction ${tx.txId?.substring(0, 20)}...: ${error.message}`,
            );
          }
        }
      }
    }

    if (this.verbose) {
      console.log(
        `   ✅ Saved ${saved} new transactions (${skipped} duplicates skipped)`,
      );
    }

    return saved;
  }

  /**
   * Save a unified transaction to the processed table (mutable)
   * @param {Object} tx - Transaction data
   */
  async saveUnifiedTransaction(tx) {
    await this.ensureConnection();

    const blockTimestamp = this._normalizeTimestamp(tx.blockTimestamp);
    const metadata = this._buildMetadata(tx);

    await this.executeWithRetry(
      `INSERT INTO ${CONFIG.AR_TRACKER_TABLES.UNIFIED_TRANSACTIONS}
       (wallet_address, block_timestamp, tx_id, type, token_symbol,
        token_process_id, amount_units, amount_human, price_usd, value_usd, fee_ar, fee_usd,
        counterparty, source, input_token, output_token, input_amount,
        output_amount, input_price_usd, input_value_usd, output_price_usd,
        output_value_usd, proceeds_per_unit, proceeds_usd, cost_basis_usd, gain_loss_usd,
        is_staked, tax_category, block_height, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tx.walletAddress,
        blockTimestamp,
        tx.txId,
        tx.type,
        tx.tokenSymbol || null,
        tx.tokenProcessId || null,
        tx.amountUnits?.toString() || null,
        tx.amountHuman || null,
        tx.priceUSD || null,
        tx.valueUSD || null,
        tx.feeAR || null,
        tx.feeUSD || null,
        tx.counterparty || null,
        tx.source || null,
        tx.inputTokenSymbol || null,
        tx.outputTokenSymbol || null,
        tx.inputAmountHuman || null,
        tx.outputAmountHuman || null,
        tx.inputPriceUSD || null,
        tx.inputValueUSD || null,
        tx.outputPriceUSD || null,
        tx.outputValueUSD || null,
        tx.proceedsPerUnit || null,
        tx.proceedsUSD || null,
        tx.costBasisUSD || null,
        tx.gainLossUSD || null,
        tx.isStaked || false,
        tx.taxCategory || null,
        tx.blockHeight || null,
        metadata ? JSON.stringify(metadata) : null,
      ],
    );
  }

  /**
   * Save multiple unified transactions in batch (to processed table)
   * @param {Object[]} transactions
   * @returns {number} Number saved
   */
  async saveUnifiedTransactionsBatch(transactions) {
    if (!transactions || transactions.length === 0) return 0;

    await this.ensureConnection();

    let saved = 0;

    for (let i = 0; i < transactions.length; i += this.batchSize) {
      const batch = transactions.slice(i, i + this.batchSize);

      const queries = batch.map((tx) => ({
        query: `INSERT INTO ${CONFIG.AR_TRACKER_TABLES.UNIFIED_TRANSACTIONS}
                (wallet_address, block_timestamp, tx_id, type, token_symbol,
                 token_process_id, amount_units, amount_human, price_usd, value_usd, fee_ar, fee_usd,
                 counterparty, source, input_token, output_token, input_amount,
                 output_amount, input_price_usd, input_value_usd, output_price_usd,
                 output_value_usd, proceeds_per_unit, proceeds_usd, cost_basis_usd, gain_loss_usd,
                 is_staked, tax_category, block_height, metadata)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          tx.walletAddress,
          this._normalizeTimestamp(tx.blockTimestamp),
          tx.txId,
          tx.type,
          tx.tokenSymbol || null,
          tx.tokenProcessId || null,
          tx.amountUnits?.toString() || null,
          tx.amountHuman || null,
          tx.priceUSD || null,
          tx.valueUSD || null,
          tx.feeAR || null,
          tx.feeUSD || null,
          tx.counterparty || null,
          tx.source || null,
          tx.inputTokenSymbol || null,
          tx.outputTokenSymbol || null,
          tx.inputAmountHuman || null,
          tx.outputAmountHuman || null,
          tx.inputPriceUSD || null,
          tx.inputValueUSD || null,
          tx.outputPriceUSD || null,
          tx.outputValueUSD || null,
          tx.proceedsPerUnit || null,
          tx.proceedsUSD || null,
          tx.costBasisUSD || null,
          tx.gainLossUSD || null,
          tx.isStaked || false,
          tx.taxCategory || null,
          tx.blockHeight || null,
          this._buildMetadata(tx)
            ? JSON.stringify(this._buildMetadata(tx))
            : null,
        ],
      }));

      try {
        await this.client.batch(queries, { prepare: true });
        saved += batch.length;
      } catch (batchError) {
        // Fallback to individual saves
        for (const tx of batch) {
          try {
            await this.saveUnifiedTransaction(tx);
            saved++;
          } catch (error) {
            if (this.verbose) {
              console.log(
                `   ⚠️ Failed to save transaction ${tx.txId?.substring(0, 20)}...: ${error.message}`,
              );
            }
          }
        }
      }
    }

    return saved;
  }

  /**
   * Get unified transactions for a wallet
   * First checks processed table, falls back to originals table if empty
   * @param {string} walletAddress
   * @param {Object} options - { startDate, endDate, type, limit, useOriginals }
   * @returns {Object[]}
   */
  async getUnifiedTransactions(walletAddress, options = {}) {
    await this.ensureConnection();

    // Try processed table first (unless useOriginals is explicitly set)
    if (!options.useOriginals) {
      const processedResults = await this._getTransactionsFromTable(
        CONFIG.AR_TRACKER_TABLES.UNIFIED_TRANSACTIONS,
        walletAddress,
        options,
      );

      if (processedResults.length > 0) {
        return processedResults;
      }
    }

    // Fall back to originals table (where indexed data is stored)
    const originalsResults = await this._getTransactionsFromTable(
      CONFIG.AR_TRACKER_TABLES.UNIFIED_TRANSACTIONS_ORIGINALS,
      walletAddress,
      options,
    );

    if (originalsResults.length > 0 && !options.useOriginals) {
      console.log(
        `📂 Using originals table for ${walletAddress.substring(0, 12)}... (${originalsResults.length} transactions)`,
      );
    }

    return originalsResults;
  }

  /**
   * Helper to get transactions from a specific table
   * @private
   */
  async _getTransactionsFromTable(tableName, walletAddress, options = {}) {
    let query = `SELECT * FROM ${tableName} WHERE wallet_address = ?`;
    const params = [walletAddress];

    if (options.startDate && options.endDate) {
      query += ` AND block_timestamp >= ? AND block_timestamp <= ?`;
      params.push(options.startDate, options.endDate);
    }

    // Use pagination for large result sets
    const allRows = [];
    let pageState = null;
    let pageCount = 0;
    const maxPages = 100;

    do {
      try {
        const result = await this.client.execute(query, params, {
          prepare: true,
          fetchSize: 2000,
          pageState: pageState,
          readTimeout: 30000,
        });

        allRows.push(...result.rows);
        pageState = result.pageState;
        pageCount++;

        if (pageCount >= maxPages) break;
      } catch (error) {
        console.log(
          `❌ Query failed for ${walletAddress.substring(0, 12)}...: ${error.message}`,
        );
        break;
      }
    } while (pageState);

    return allRows.map((row) => this._rowToTransaction(row));
  }

  /**
   * Get unified transactions for multiple wallets
   * Fetches from all wallets, deduplicates, and marks internal transfers
   * @param {string[]} walletAddresses - Array of wallet addresses
   * @param {Object} options - { startDate, endDate, markInternalTransfers }
   * @returns {Object[]} Combined transactions sorted by timestamp
   */
  async getUnifiedTransactionsMultiWallet(walletAddresses, options = {}) {
    if (!Array.isArray(walletAddresses) || walletAddresses.length === 0) {
      throw new Error("walletAddresses must be a non-empty array");
    }

    // Single wallet - just use existing method
    if (walletAddresses.length === 1) {
      return this.getUnifiedTransactions(walletAddresses[0], options);
    }

    console.log(
      `📊 Fetching transactions for ${walletAddresses.length} wallets...`,
    );

    // Create a Set for quick lookup
    const ownedWallets = new Set(walletAddresses.map((w) => w.toLowerCase()));

    // Fetch transactions for all wallets in parallel
    const fetchPromises = walletAddresses.map((wallet) =>
      this.getUnifiedTransactions(wallet, options),
    );

    const results = await Promise.all(fetchPromises);

    // Combine all transactions
    const allTransactions = results.flat();

    // Deduplicate by tx_id (same transaction may appear in multiple wallet queries)
    const txMap = new Map();
    for (const tx of allTransactions) {
      const key = tx.tx_id || tx.txId;
      if (!txMap.has(key)) {
        txMap.set(key, tx);
      }
    }

    let transactions = Array.from(txMap.values());

    // Mark internal transfers if requested (default: true)
    if (options.markInternalTransfers !== false) {
      transactions = transactions.map((tx) => {
        const from = (tx.from_address || tx.fromAddress || "").toLowerCase();
        const to = (tx.to_address || tx.toAddress || "").toLowerCase();
        const counterparty = (tx.counterparty || "").toLowerCase();

        // Check if this is a transfer between owned wallets
        const isInternal =
          (ownedWallets.has(from) && ownedWallets.has(to)) ||
          (ownedWallets.has(from) && ownedWallets.has(counterparty)) ||
          (ownedWallets.has(counterparty) && ownedWallets.has(to));

        if (
          isInternal &&
          (tx.type === "SEND" ||
            tx.type === "RECEIVE" ||
            tx.type === "TRANSFER")
        ) {
          return {
            ...tx,
            is_internal_transfer: true,
            isInternalTransfer: true,
            is_taxable_event: false,
            isTaxableEvent: false,
          };
        }
        return tx;
      });
    }

    // Sort by timestamp (oldest first for correct cost basis processing)
    transactions.sort((a, b) => {
      const timeA = new Date(a.block_timestamp || a.blockTimestamp).getTime();
      const timeB = new Date(b.block_timestamp || b.blockTimestamp).getTime();
      return timeA - timeB;
    });

    console.log(
      `✅ Found ${transactions.length} unique transactions across ${walletAddresses.length} wallets`,
    );

    // Count internal transfers
    const internalCount = transactions.filter(
      (tx) => tx.is_internal_transfer || tx.isInternalTransfer,
    ).length;
    if (internalCount > 0) {
      console.log(
        `🔄 Marked ${internalCount} internal transfers between wallets`,
      );
    }

    return transactions;
  }

  /**
   * Get unified transactions from originals table
   * @param {string} walletAddress
   * @param {Object} options
   * @returns {Object[]}
   */
  async getUnifiedTransactionsOriginals(walletAddress, options = {}) {
    await this.ensureConnection();

    let query = `SELECT * FROM ${CONFIG.AR_TRACKER_TABLES.UNIFIED_TRANSACTIONS_ORIGINALS} WHERE wallet_address = ?`;
    const params = [walletAddress];

    if (options.startDate && options.endDate) {
      query += ` AND block_timestamp >= ? AND block_timestamp <= ?`;
      params.push(options.startDate, options.endDate);
    }

    const result = await this.executeWithRetry(query, params);
    return result.rows.map((row) => this._rowToTransaction(row));
  }

  /**
   * Check if wallet has any transactions
   * @param {string} walletAddress
   * @returns {boolean}
   */
  async hasTransactions(walletAddress) {
    await this.ensureConnection();

    const result = await this.executeWithRetry(
      `SELECT tx_id FROM ${CONFIG.AR_TRACKER_TABLES.UNIFIED_TRANSACTIONS} WHERE wallet_address = ? LIMIT 1`,
      [walletAddress],
    );

    return result.rows.length > 0;
  }

  /**
   * Check if wallet has been indexed (has any rows in originals from sync).
   * Used for single-wallet Full Tax index_status (no group).
   * @param {string} walletAddress
   * @returns {Promise<boolean>}
   */
  async walletHasIndexedData(walletAddress) {
    await this.ensureConnection();
    const result = await this.executeWithRetry(
      `SELECT wallet_address FROM ${CONFIG.AR_TRACKER_TABLES.UNIFIED_TRANSACTIONS_ORIGINALS} WHERE wallet_address = ? LIMIT 1`,
      [walletAddress],
    );
    return result.rows.length > 0;
  }

  /**
   * Delete all transactions for a wallet (for re-indexing)
   * @param {string} walletAddress
   */
  async deleteWalletTransactions(walletAddress) {
    await this.ensureConnection();

    // Delete from both tables
    await this.executeWithRetry(
      `DELETE FROM ${CONFIG.AR_TRACKER_TABLES.UNIFIED_TRANSACTIONS} WHERE wallet_address = ?`,
      [walletAddress],
    );

    await this.executeWithRetry(
      `DELETE FROM ${CONFIG.AR_TRACKER_TABLES.UNIFIED_TRANSACTIONS_ORIGINALS} WHERE wallet_address = ?`,
      [walletAddress],
    );

    if (this.verbose) {
      console.log(
        `✅ Deleted all transactions for ${walletAddress.substring(0, 12)}...`,
      );
    }
  }

  // ============================================================
  // TAX LOTS OPERATIONS
  // ============================================================

  /**
   * Save a tax lot
   * @param {Object} lot - Tax lot data
   */
  async saveTaxLot(lot) {
    await this.ensureConnection();

    await this.executeWithRetry(
      `INSERT INTO ${CONFIG.AR_TRACKER_TABLES.TAX_LOTS}
       (wallet_address, token_symbol, lot_id, acquisition_date, acquisition_tx_id,
        acquisition_type, original_quantity, remaining_quantity, cost_basis_per_unit,
        cost_basis_total, token_process_id, status, holding_period_start, notes,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        lot.walletAddress,
        lot.tokenSymbol,
        lot.lotId,
        lot.acquisitionDate instanceof Date
          ? lot.acquisitionDate
          : new Date(lot.acquisitionDate),
        lot.acquisitionTxId,
        lot.acquisitionType,
        lot.originalQuantity,
        lot.remainingQuantity,
        lot.costBasisPerUnit,
        lot.costBasisTotal,
        lot.tokenProcessId || null,
        lot.status || "OPEN",
        lot.holdingPeriodStart instanceof Date
          ? lot.holdingPeriodStart
          : new Date(lot.holdingPeriodStart || lot.acquisitionDate),
        lot.notes || null,
        new Date(),
        new Date(),
      ],
    );
  }

  /**
   * Save tax lot original (immutable snapshot)
   * @param {Object} lot
   */
  async saveTaxLotOriginal(lot) {
    await this.ensureConnection();

    await this.executeWithRetry(
      `INSERT INTO ${CONFIG.AR_TRACKER_TABLES.TAX_LOT_ORIGINALS}
       (wallet_address, token_symbol, lot_id, acquisition_date, acquisition_tx_id,
        acquisition_type, original_quantity, cost_basis_per_unit, cost_basis_total,
        token_process_id, holding_period_start, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        lot.walletAddress,
        lot.tokenSymbol,
        lot.lotId,
        lot.acquisitionDate instanceof Date
          ? lot.acquisitionDate
          : new Date(lot.acquisitionDate),
        lot.acquisitionTxId,
        lot.acquisitionType,
        lot.originalQuantity,
        lot.costBasisPerUnit,
        lot.costBasisTotal,
        lot.tokenProcessId || null,
        lot.holdingPeriodStart instanceof Date
          ? lot.holdingPeriodStart
          : new Date(lot.holdingPeriodStart || lot.acquisitionDate),
        lot.notes || null,
        new Date(),
      ],
    );
  }

  /**
   * Get tax lots for a wallet and token
   * @param {string} walletAddress
   * @param {string} tokenSymbol
   * @returns {Object[]}
   */
  async getTaxLots(walletAddress, tokenSymbol) {
    await this.ensureConnection();

    const result = await this.executeWithRetry(
      `SELECT * FROM ${CONFIG.AR_TRACKER_TABLES.TAX_LOTS}
       WHERE wallet_address = ? AND token_symbol = ?`,
      [walletAddress, tokenSymbol],
    );

    return result.rows.map((row) => ({
      walletAddress: row.wallet_address,
      tokenSymbol: row.token_symbol,
      lotId: row.lot_id,
      acquisitionDate: row.acquisition_date,
      acquisitionTxId: row.acquisition_tx_id,
      acquisitionType: row.acquisition_type,
      originalQuantity: row.original_quantity
        ? parseFloat(row.original_quantity)
        : 0,
      remainingQuantity: row.remaining_quantity
        ? parseFloat(row.remaining_quantity)
        : 0,
      costBasisPerUnit: row.cost_basis_per_unit
        ? parseFloat(row.cost_basis_per_unit)
        : 0,
      costBasisTotal: row.cost_basis_total
        ? parseFloat(row.cost_basis_total)
        : 0,
      tokenProcessId: row.token_process_id,
      status: row.status,
      holdingPeriodStart: row.holding_period_start,
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Get all tax lots for a wallet (all tokens)
   * @param {string} walletAddress
   * @returns {Object[]}
   */
  async getAllTaxLotsForWallet(walletAddress) {
    await this.ensureConnection();

    // Get all unique token symbols for this wallet
    const tokensResult = await this.executeWithRetry(
      `SELECT DISTINCT token_symbol FROM ${CONFIG.AR_TRACKER_TABLES.TAX_LOTS}
       WHERE wallet_address = ? ALLOW FILTERING`,
      [walletAddress],
    );

    const allLots = [];
    for (const row of tokensResult.rows) {
      const lots = await this.getTaxLots(walletAddress, row.token_symbol);
      allLots.push(...lots);
    }

    return allLots;
  }

  /**
   * Update tax lot (after disposal)
   * @param {Object} lot
   */
  async updateTaxLot(lot) {
    await this.ensureConnection();

    await this.executeWithRetry(
      `UPDATE ${CONFIG.AR_TRACKER_TABLES.TAX_LOTS}
       SET remaining_quantity = ?, status = ?, updated_at = ?
       WHERE wallet_address = ? AND token_symbol = ? AND acquisition_date = ? AND lot_id = ?`,
      [
        lot.remainingQuantity,
        lot.status,
        new Date(),
        lot.walletAddress,
        lot.tokenSymbol,
        lot.acquisitionDate instanceof Date
          ? lot.acquisitionDate
          : new Date(lot.acquisitionDate),
        lot.lotId,
      ],
    );
  }

  /**
   * Delete all tax lots for a wallet (for recalculation)
   * @param {string} walletAddress
   */
  async deleteTaxLots(walletAddress) {
    await this.ensureConnection();

    // Get all token symbols first
    const tokensResult = await this.executeWithRetry(
      `SELECT DISTINCT token_symbol FROM ${CONFIG.AR_TRACKER_TABLES.TAX_LOTS}
       WHERE wallet_address = ? ALLOW FILTERING`,
      [walletAddress],
    );

    for (const row of tokensResult.rows) {
      await this.executeWithRetry(
        `DELETE FROM ${CONFIG.AR_TRACKER_TABLES.TAX_LOTS}
         WHERE wallet_address = ? AND token_symbol = ?`,
        [walletAddress, row.token_symbol],
      );
    }

    if (this.verbose) {
      console.log(
        `✅ Deleted all tax lots for ${walletAddress.substring(0, 12)}...`,
      );
    }
  }

  // ============================================================
  // DISPOSALS OPERATIONS
  // ============================================================

  /**
   * Save a disposal record
   * @param {Object} disposal
   */
  async saveDisposal(disposal) {
    await this.ensureConnection();

    await this.executeWithRetry(
      `INSERT INTO ${CONFIG.AR_TRACKER_TABLES.DISPOSALS}
       (wallet_address, token_symbol, disposal_id, disposal_date, disposal_tx_id,
        disposal_type, quantity, proceeds_per_unit, proceeds_total, lots_used,
        cost_basis, gain_loss, is_long_term, accounting_method, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        disposal.walletAddress,
        disposal.tokenSymbol,
        disposal.disposalId,
        disposal.disposalDate instanceof Date
          ? disposal.disposalDate
          : new Date(disposal.disposalDate),
        disposal.disposalTxId,
        disposal.disposalType,
        disposal.quantity,
        disposal.proceedsPerUnit,
        disposal.proceedsTotal,
        disposal.lotsUsed ? JSON.stringify(disposal.lotsUsed) : null,
        disposal.costBasis,
        disposal.gainLoss,
        disposal.isLongTerm || false,
        disposal.accountingMethod || "FIFO",
        disposal.notes || null,
        new Date(),
      ],
    );
  }

  /**
   * Get disposals for a wallet and token
   * @param {string} walletAddress
   * @param {string} tokenSymbol
   * @returns {Object[]}
   */
  async getDisposals(walletAddress, tokenSymbol) {
    await this.ensureConnection();

    const result = await this.executeWithRetry(
      `SELECT * FROM ${CONFIG.AR_TRACKER_TABLES.DISPOSALS}
       WHERE wallet_address = ? AND token_symbol = ?`,
      [walletAddress, tokenSymbol],
    );

    return result.rows.map((row) => ({
      walletAddress: row.wallet_address,
      tokenSymbol: row.token_symbol,
      disposalId: row.disposal_id,
      disposalDate: row.disposal_date,
      disposalTxId: row.disposal_tx_id,
      disposalType: row.disposal_type,
      quantity: row.quantity ? parseFloat(row.quantity) : 0,
      proceedsPerUnit: row.proceeds_per_unit
        ? parseFloat(row.proceeds_per_unit)
        : 0,
      proceedsTotal: row.proceeds_total ? parseFloat(row.proceeds_total) : 0,
      lotsUsed: row.lots_used ? JSON.parse(row.lots_used) : [],
      costBasis: row.cost_basis ? parseFloat(row.cost_basis) : 0,
      gainLoss: row.gain_loss ? parseFloat(row.gain_loss) : 0,
      isLongTerm: row.is_long_term,
      accountingMethod: row.accounting_method,
      notes: row.notes,
      createdAt: row.created_at,
    }));
  }

  /**
   * Delete all disposals for a wallet (for recalculation)
   * @param {string} walletAddress
   */
  async deleteDisposals(walletAddress) {
    await this.ensureConnection();

    // Get all token symbols first
    const tokensResult = await this.executeWithRetry(
      `SELECT DISTINCT token_symbol FROM ${CONFIG.AR_TRACKER_TABLES.DISPOSALS}
       WHERE wallet_address = ? ALLOW FILTERING`,
      [walletAddress],
    );

    for (const row of tokensResult.rows) {
      await this.executeWithRetry(
        `DELETE FROM ${CONFIG.AR_TRACKER_TABLES.DISPOSALS}
         WHERE wallet_address = ? AND token_symbol = ?`,
        [walletAddress, row.token_symbol],
      );
    }
  }

  // ============================================================
  // BAZAR PROFILES OPERATIONS
  // ============================================================

  /**
   * Save a Bazar profile
   * @param {Object} profile
   */
  async saveProfile(profile) {
    await this.ensureConnection();

    // Save to main profiles table
    await this.executeWithRetry(
      `INSERT INTO ${CONFIG.AR_TRACKER_TABLES.BAZAR_PROFILES}
       (profile_id, wallet_address, username, display_name, description,
        thumbnail, banner, version, asset_count, is_active,
        discovered_at, last_synced_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        profile.id || profile.profileId,
        profile.walletAddress || profile.parentWallet,
        profile.username,
        profile.displayName,
        profile.description,
        profile.thumbnail,
        profile.banner,
        profile.version,
        profile.assetCount || profile.assets?.length || 0,
        profile.isActive !== false,
        profile.discoveredAt || new Date(),
        new Date(),
        profile.metadata ? JSON.stringify(profile.metadata) : null,
      ],
    );

    // Save to reverse lookup table
    await this.executeWithRetry(
      `INSERT INTO ${CONFIG.AR_TRACKER_TABLES.BAZAR_PROFILES_BY_WALLET}
       (wallet_address, profile_id, username, is_active, discovered_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        profile.walletAddress || profile.parentWallet,
        profile.id || profile.profileId,
        profile.username,
        profile.isActive !== false,
        profile.discoveredAt || new Date(),
      ],
    );
  }

  /**
   * Get profile by wallet address (returns first profile only - use getProfilesByWallet for all)
   * @param {string} walletAddress
   * @returns {Object|null}
   */
  async getProfileByWallet(walletAddress) {
    await this.ensureConnection();

    const result = await this.executeWithRetry(
      `SELECT * FROM ${CONFIG.AR_TRACKER_TABLES.BAZAR_PROFILES_BY_WALLET} WHERE wallet_address = ?`,
      [walletAddress],
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return this.getProfileById(row.profile_id);
  }

  /**
   * Get ALL profiles for a wallet address (supports multiple profiles per wallet)
   * @param {string} walletAddress
   * @returns {Object[]} Array of profile objects
   */
  async getProfilesByWallet(walletAddress) {
    await this.ensureConnection();

    const result = await this.executeWithRetry(
      `SELECT * FROM ${CONFIG.AR_TRACKER_TABLES.BAZAR_PROFILES_BY_WALLET} WHERE wallet_address = ?`,
      [walletAddress],
    );

    if (result.rows.length === 0) return [];

    const profiles = [];
    for (const row of result.rows) {
      const profile = await this.getProfileById(row.profile_id);
      if (profile) {
        profiles.push(profile);
      }
    }
    return profiles;
  }

  /**
   * Get profile by profile ID
   * @param {string} profileId
   * @returns {Object|null}
   */
  async getProfileById(profileId) {
    await this.ensureConnection();

    const result = await this.executeWithRetry(
      `SELECT * FROM ${CONFIG.AR_TRACKER_TABLES.BAZAR_PROFILES} WHERE profile_id = ?`,
      [profileId],
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.profile_id,
      walletAddress: row.wallet_address,
      username: row.username,
      displayName: row.display_name,
      description: row.description,
      thumbnail: row.thumbnail,
      banner: row.banner,
      version: row.version,
      assetCount: row.asset_count,
      isActive: row.is_active,
      discoveredAt: row.discovered_at,
      lastSyncedAt: row.last_synced_at,
      lastTransactionAt: row.last_transaction_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
    };
  }

  /**
   * Get ALL profiles for multiple wallets (supports multiple profiles per wallet)
   * @param {string[]} walletAddresses - Array of wallet addresses
   * @returns {Object[]} Array of profile objects
   */
  async getProfilesForWallets(walletAddresses) {
    await this.ensureConnection();

    if (!walletAddresses || walletAddresses.length === 0) {
      return [];
    }

    const profiles = [];
    for (const wallet of walletAddresses) {
      // Use getProfilesByWallet to get ALL profiles for this wallet
      const walletProfiles = await this.getProfilesByWallet(wallet);
      profiles.push(...walletProfiles);
    }

    return profiles;
  }

  /**
   * Get all active profiles
   * @returns {Object[]} Array of active profile objects
   */
  async getAllActiveProfiles() {
    await this.ensureConnection();

    const result = await this.executeWithRetry(
      `SELECT * FROM ${CONFIG.AR_TRACKER_TABLES.BAZAR_PROFILES} WHERE is_active = ? ALLOW FILTERING`,
      [true],
    );

    return result.rows.map((row) => ({
      id: row.profile_id,
      walletAddress: row.wallet_address,
      username: row.username,
      displayName: row.display_name,
      description: row.description,
      thumbnail: row.thumbnail,
      banner: row.banner,
      version: row.version,
      assetCount: row.asset_count,
      isActive: row.is_active,
      discoveredAt: row.discovered_at,
      lastSyncedAt: row.last_synced_at,
      lastTransactionAt: row.last_transaction_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
    }));
  }

  /**
   * Update profile's last transaction timestamp
   * @param {string} profileId
   * @param {Date} timestamp
   */
  async updateProfileLastTransaction(profileId, timestamp) {
    await this.ensureConnection();

    await this.executeWithRetry(
      `UPDATE ${CONFIG.AR_TRACKER_TABLES.BAZAR_PROFILES}
       SET last_transaction_at = ?, last_synced_at = ?
       WHERE profile_id = ?`,
      [timestamp, new Date(), profileId],
    );
  }

  /**
   * Save a profile transaction
   * @param {Object} transaction - Transaction data
   */
  async saveProfileTransaction(transaction) {
    await this.ensureConnection();

    const blockTimestamp =
      transaction.blockTimestamp instanceof Date
        ? transaction.blockTimestamp
        : new Date(
            typeof transaction.blockTimestamp === "number"
              ? transaction.blockTimestamp * 1000
              : transaction.blockTimestamp,
          );

    await this.executeWithRetry(
      `INSERT INTO ${CONFIG.AR_TRACKER_TABLES.PROFILE_TRANSACTIONS}
       (profile_id, block_timestamp, tx_id, parent_wallet, type, token_symbol,
        amount_units, amount_human, price_usd, value_usd, counterparty, is_internal, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        transaction.profileId,
        blockTimestamp,
        transaction.txId,
        transaction.parentWallet,
        transaction.type,
        transaction.tokenSymbol,
        transaction.amountUnits?.toString() || null,
        transaction.amountHuman || null,
        transaction.priceUSD || null,
        transaction.valueUSD || null,
        transaction.counterparty || null,
        transaction.isInternal || false,
        transaction.source || "ao",
      ],
    );
  }

  /**
   * Get profile transactions
   * @param {string} profileId - Profile's AO process ID
   * @param {Object} options - Query options
   * @param {Date} options.startDate - Start date filter
   * @param {Date} options.endDate - End date filter
   * @returns {Object[]} Array of transactions
   */
  async getProfileTransactions(profileId, options = {}) {
    await this.ensureConnection();

    let query = `SELECT * FROM ${CONFIG.AR_TRACKER_TABLES.PROFILE_TRANSACTIONS} WHERE profile_id = ?`;
    const params = [profileId];

    if (options.startDate) {
      query += " AND block_timestamp >= ?";
      params.push(options.startDate);
    }

    if (options.endDate) {
      query += " AND block_timestamp <= ?";
      params.push(options.endDate);
    }

    const result = await this.executeWithRetry(query, params);

    return result.rows.map((row) => ({
      profileId: row.profile_id,
      blockTimestamp: row.block_timestamp
        ? Math.floor(row.block_timestamp.getTime() / 1000)
        : null,
      txId: row.tx_id,
      parentWallet: row.parent_wallet,
      type: row.type,
      tokenSymbol: row.token_symbol,
      amountUnits: row.amount_units,
      amountHuman: row.amount_human ? parseFloat(row.amount_human) : 0,
      priceUSD: row.price_usd ? parseFloat(row.price_usd) : 0,
      valueUSD: row.value_usd ? parseFloat(row.value_usd) : 0,
      counterparty: row.counterparty,
      isInternal: row.is_internal,
      source: row.source,
    }));
  }

  /**
   * Get profile transactions for multiple profiles
   * @param {string[]} profileIds - Array of profile IDs
   * @param {Object} options - Query options
   * @returns {Object[]} Array of transactions with profile context
   */
  async getProfileTransactionsForProfiles(profileIds, options = {}) {
    if (!profileIds || profileIds.length === 0) {
      return [];
    }

    const allTransactions = [];
    for (const profileId of profileIds) {
      const transactions = await this.getProfileTransactions(
        profileId,
        options,
      );
      allTransactions.push(...transactions);
    }

    // Sort by timestamp descending
    allTransactions.sort(
      (a, b) => (b.blockTimestamp || 0) - (a.blockTimestamp || 0),
    );

    return allTransactions;
  }

  /**
   * Clear profile transactions for a profile
   * @param {string} profileId
   */
  async clearProfileTransactions(profileId) {
    await this.ensureConnection();

    await this.executeWithRetry(
      `DELETE FROM ${CONFIG.AR_TRACKER_TABLES.PROFILE_TRANSACTIONS} WHERE profile_id = ?`,
      [profileId],
    );
  }

  /**
   * Clear all cached profiles for a set of wallets
   * This removes stale/incorrect profile data so profiles can be re-discovered
   * @param {string[]} walletAddresses - Array of wallet addresses
   * @returns {number} Number of profiles cleared
   */
  async clearProfilesForWallets(walletAddresses) {
    await this.ensureConnection();

    let cleared = 0;

    for (const walletAddress of walletAddresses) {
      // First get all profiles for this wallet
      const result = await this.executeWithRetry(
        `SELECT profile_id FROM ${CONFIG.AR_TRACKER_TABLES.BAZAR_PROFILES_BY_WALLET} WHERE wallet_address = ?`,
        [walletAddress],
      );

      for (const row of result.rows) {
        const profileId = row.profile_id;

        // Delete from main profiles table
        await this.executeWithRetry(
          `DELETE FROM ${CONFIG.AR_TRACKER_TABLES.BAZAR_PROFILES} WHERE profile_id = ?`,
          [profileId],
        );

        // Delete profile transactions
        await this.executeWithRetry(
          `DELETE FROM ${CONFIG.AR_TRACKER_TABLES.PROFILE_TRANSACTIONS} WHERE profile_id = ?`,
          [profileId],
        );

        cleared++;
      }

      // Delete from profiles_by_wallet table
      await this.executeWithRetry(
        `DELETE FROM ${CONFIG.AR_TRACKER_TABLES.BAZAR_PROFILES_BY_WALLET} WHERE wallet_address = ?`,
        [walletAddress],
      );
    }

    return cleared;
  }

  // ============================================================
  // REPORT SUMMARY CACHE OPERATIONS
  // ============================================================

  /**
   * Save report summary to cache
   * @param {Object} summary
   */
  async saveReportSummary(summary) {
    await this.ensureConnection();

    const now = new Date();
    const currentYear = new Date().getFullYear();
    const expiryHours = summary.taxYear === currentYear ? 24 : 720; // 30 days for past years
    const expiresAt = new Date(now.getTime() + expiryHours * 60 * 60 * 1000);

    await this.executeWithRetry(
      `INSERT INTO ${CONFIG.AR_TRACKER_TABLES.REPORT_SUMMARY_CACHE}
       (user_id, tax_year, report_type, summary_json, transaction_count,
        total_income_usd, total_capital_gains_usd, total_capital_losses_usd,
        distribution_count, swap_count, wallets_included, profiles_included,
        last_transaction_at, generated_at, expires_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        summary.userId,
        summary.taxYear,
        summary.reportType || "comprehensive",
        JSON.stringify(summary.data),
        summary.transactionCount || 0,
        summary.totalIncomeUSD || 0,
        summary.totalCapitalGainsUSD || 0,
        summary.totalCapitalLossesUSD || 0,
        summary.distributionCount || 0,
        summary.swapCount || 0,
        summary.walletsIncluded || [],
        summary.profilesIncluded || [],
        summary.lastTransactionAt || now,
        now,
        expiresAt,
        summary.version || 1,
      ],
    );
  }

  /**
   * Get cached report summary
   * @param {string} userId
   * @param {number} taxYear
   * @param {string} reportType
   * @returns {Object|null}
   */
  async getReportSummary(userId, taxYear, reportType = "comprehensive") {
    await this.ensureConnection();

    const result = await this.executeWithRetry(
      `SELECT * FROM ${CONFIG.AR_TRACKER_TABLES.REPORT_SUMMARY_CACHE}
       WHERE user_id = ? AND tax_year = ? AND report_type = ?`,
      [userId, taxYear, reportType],
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    const now = new Date();

    // Check if expired
    if (row.expires_at && row.expires_at < now) {
      return null;
    }

    return {
      userId: row.user_id,
      taxYear: row.tax_year,
      reportType: row.report_type,
      data: JSON.parse(row.summary_json || "{}"),
      transactionCount: row.transaction_count,
      totalIncomeUSD: row.total_income_usd
        ? parseFloat(row.total_income_usd)
        : 0,
      totalCapitalGainsUSD: row.total_capital_gains_usd
        ? parseFloat(row.total_capital_gains_usd)
        : 0,
      totalCapitalLossesUSD: row.total_capital_losses_usd
        ? parseFloat(row.total_capital_losses_usd)
        : 0,
      distributionCount: row.distribution_count,
      swapCount: row.swap_count,
      walletsIncluded: row.wallets_included || [],
      profilesIncluded: row.profiles_included || [],
      lastTransactionAt: row.last_transaction_at,
      generatedAt: row.generated_at,
      expiresAt: row.expires_at,
      version: row.version,
    };
  }

  /**
   * Invalidate report cache
   * @param {string} userId
   * @param {number} taxYear
   */
  async invalidateReportCache(userId, taxYear) {
    await this.ensureConnection();

    await this.executeWithRetry(
      `DELETE FROM ${CONFIG.AR_TRACKER_TABLES.REPORT_SUMMARY_CACHE}
       WHERE user_id = ? AND tax_year = ?`,
      [userId, taxYear],
    );
  }

  // ============================================================
  // INDEXER STATE OPERATIONS
  // ============================================================

  /**
   * Get indexer state for a wallet and source
   * @param {string} walletAddress
   * @param {string} sourceType
   * @returns {Object|null}
   */
  async getIndexerState(walletAddress, sourceType) {
    await this.ensureConnection();

    const result = await this.executeWithRetry(
      `SELECT * FROM ${CONFIG.AR_TRACKER_TABLES.INDEXER_STATE}
       WHERE wallet_address = ? AND source_type = ?`,
      [walletAddress, sourceType],
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      walletAddress: row.wallet_address,
      sourceType: row.source_type,
      lastIndexedBlock: row.last_indexed_block,
      lastIndexedTimestamp: row.last_indexed_timestamp,
      transactionCount: row.transaction_count,
      lastRunAt: row.last_run_at,
      createdAt: row.created_at,
    };
  }

  /**
   * Save indexer state
   * @param {string} walletAddress
   * @param {string} sourceType
   * @param {Object} state
   */
  async saveIndexerState(walletAddress, sourceType, state) {
    await this.ensureConnection();

    const now = new Date();
    const existingState = await this.getIndexerState(walletAddress, sourceType);

    await this.executeWithRetry(
      `INSERT INTO ${CONFIG.AR_TRACKER_TABLES.INDEXER_STATE}
       (wallet_address, source_type, last_indexed_block, last_indexed_timestamp,
        transaction_count, last_run_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        walletAddress,
        sourceType,
        state.lastIndexedBlock,
        state.lastIndexedTimestamp || now,
        state.transactionCount || 0,
        now,
        existingState?.createdAt || now,
      ],
    );
  }

  /**
   * Clear indexer state for a wallet
   * @param {string} walletAddress
   */
  async clearIndexerState(walletAddress) {
    await this.ensureConnection();

    await this.executeWithRetry(
      `DELETE FROM ${CONFIG.AR_TRACKER_TABLES.INDEXER_STATE} WHERE wallet_address = ?`,
      [walletAddress],
    );
  }

  // ============================================================
  // TOKEN INFO OPERATIONS
  // ============================================================

  /**
   * Get token info
   * @param {string} processId
   * @returns {Object|null}
   */
  async getTokenInfo(processId) {
    await this.ensureConnection();

    const result = await this.executeWithRetry(
      `SELECT * FROM ${CONFIG.AR_TRACKER_TABLES.TOKEN_INFO} WHERE process_id = ?`,
      [processId],
    );

    return result.rows[0] || null;
  }

  /**
   * Save token info
   * @param {Object} tokenInfo
   */
  async saveTokenInfo(tokenInfo) {
    await this.ensureConnection();

    await this.executeWithRetry(
      `INSERT INTO ${CONFIG.AR_TRACKER_TABLES.TOKEN_INFO}
       (process_id, ticker, name, denomination, logo, total_supply, source,
        has_market, last_known_price_usd, market_checked_at, fetched_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tokenInfo.processId,
        tokenInfo.ticker || null,
        tokenInfo.name || null,
        tokenInfo.denomination || 12,
        tokenInfo.logo || null,
        tokenInfo.totalSupply || null,
        tokenInfo.source || "unknown",
        tokenInfo.hasMarket || false,
        tokenInfo.lastKnownPriceUSD || null,
        tokenInfo.marketCheckedAt || null,
        tokenInfo.fetchedAt || new Date(),
        tokenInfo.error || null,
      ],
    );
  }

  // ============================================================
  // BLOCK TIMESTAMP CACHE OPERATIONS
  // ============================================================

  /**
   * Get cached block timestamp
   * @param {number} blockHeight
   * @returns {number|null}
   */
  async getBlockTimestamp(blockHeight) {
    await this.ensureConnection();

    const result = await this.executeWithRetry(
      `SELECT timestamp FROM ${CONFIG.AR_TRACKER_TABLES.BLOCK_TIMESTAMPS} WHERE block_height = ?`,
      [blockHeight],
    );

    return result.rows.length > 0
      ? parseInt(result.rows[0].timestamp.toString())
      : null;
  }

  /**
   * Save block timestamp
   * @param {number} blockHeight
   * @param {number} timestamp
   */
  async saveBlockTimestamp(blockHeight, timestamp) {
    await this.ensureConnection();

    await this.executeWithRetry(
      `INSERT INTO ${CONFIG.AR_TRACKER_TABLES.BLOCK_TIMESTAMPS} (block_height, timestamp, cached_at)
       VALUES (?, ?, ?)`,
      [blockHeight, timestamp, new Date()],
    );
  }

  // ============================================================
  // UTILITY METHODS
  // ============================================================

  /**
   * Normalize timestamp to Date object
   * @param {number|Date} timestamp
   * @returns {Date}
   */
  _normalizeTimestamp(timestamp) {
    if (timestamp instanceof Date) {
      return timestamp;
    }
    if (timestamp && timestamp > 0) {
      // AO timestamps are in Unix seconds - convert to milliseconds for Date
      return new Date(timestamp * 1000);
    }
    return new Date();
  }

  /**
   * Build metadata object from transaction
   * @param {Object} tx
   * @returns {Object|null}
   */
  _buildMetadata(tx) {
    const metadata = {
      ...(tx.metadata || {}),
      isTaxableEvent: tx.isTaxableEvent,
      isInternalTransfer: tx.isInternalTransfer || false,
      distributionType: tx.distributionType,
      rewardType: tx.rewardType,
      epochIndex: tx.epochIndex,
      gatewayAddress: tx.gatewayAddress,
      platform: tx.platform || tx.source,
      isSwap: tx.isSwap,
      dexPlatform: tx.dexPlatform,
    };

    // Remove undefined values
    Object.keys(metadata).forEach((key) => {
      if (metadata[key] === undefined || metadata[key] === null) {
        delete metadata[key];
      }
    });

    return Object.keys(metadata).length > 0 ? metadata : null;
  }

  /**
   * Convert database row to transaction object
   * @param {Object} row
   * @returns {Object}
   */
  _rowToTransaction(row) {
    const type = row.type;
    const taxCategory = row.tax_category;
    const metadata = row.metadata ? JSON.parse(row.metadata) : {};

    const isSwap = type === "DEX_SWAP" || metadata.isSwap || false;

    const isTaxableEvent =
      metadata.isTaxableEvent !== undefined
        ? metadata.isTaxableEvent
        : type === "DISTRIBUTION" ||
          type === "RECEIVE" ||
          type === "DEX_SWAP" ||
          taxCategory === "INCOME" ||
          taxCategory === "DEFERRED_INCOME" ||
          taxCategory === "DISPOSAL" ||
          taxCategory === "ACQUISITION";

    const blockTimestamp =
      row.block_timestamp instanceof Date
        ? row.block_timestamp.getTime() / 1000
        : row.block_timestamp;

    return {
      walletAddress: row.wallet_address,
      blockTimestamp: blockTimestamp,
      txId: row.tx_id,
      type: type,
      tokenSymbol: row.token_symbol,
      tokenProcessId: row.token_process_id || null,
      amountUnits: row.amount_units,
      amountHuman: row.amount_human ? parseFloat(row.amount_human) : null,
      priceUSD: row.price_usd ? parseFloat(row.price_usd) : null,
      valueUSD: row.value_usd ? parseFloat(row.value_usd) : null,
      feeAR: row.fee_ar ? parseFloat(row.fee_ar) : null,
      feeUSD: row.fee_usd ? parseFloat(row.fee_usd) : null,
      counterparty: row.counterparty,
      source: row.source,
      inputTokenSymbol: row.input_token,
      outputTokenSymbol: row.output_token,
      inputAmountHuman: row.input_amount ? parseFloat(row.input_amount) : null,
      outputAmountHuman: row.output_amount
        ? parseFloat(row.output_amount)
        : null,
      inputPriceUSD: row.input_price_usd
        ? parseFloat(row.input_price_usd)
        : null,
      inputValueUSD: row.input_value_usd
        ? parseFloat(row.input_value_usd)
        : null,
      outputPriceUSD: row.output_price_usd
        ? parseFloat(row.output_price_usd)
        : null,
      outputValueUSD: row.output_value_usd
        ? parseFloat(row.output_value_usd)
        : null,
      proceedsPerUnit: row.proceeds_per_unit
        ? parseFloat(row.proceeds_per_unit)
        : null,
      proceedsUSD: row.proceeds_usd ? parseFloat(row.proceeds_usd) : null,
      costBasisUSD: row.cost_basis_usd ? parseFloat(row.cost_basis_usd) : null,
      gainLossUSD: row.gain_loss_usd ? parseFloat(row.gain_loss_usd) : null,
      isStaked: row.is_staked || false,
      taxCategory: taxCategory,
      blockHeight: row.block_height,
      metadata: metadata,
      isTaxableEvent: isTaxableEvent,
      isSwap: isSwap,
      // Set isInternalTransfer from metadata or from type
      isInternalTransfer:
        metadata.isInternalTransfer || type === "INTERNAL_TRANSFER",
    };
  }

  // ============================================================
  // REGISTERED WALLET GROUPS OPERATIONS
  // ============================================================

  /**
   * Create a new wallet group
   * @param {Object} group - Group data
   * @returns {Object} Created group
   */
  async createWalletGroup(group) {
    await this.ensureConnection();

    const now = new Date();
    const groupId =
      group.groupId ||
      `wg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    await this.executeWithRetry(
      `INSERT INTO ${CONFIG.AR_TRACKER_TABLES.REGISTERED_WALLET_GROUPS}
       (group_id, group_name, wallets, primary_wallet, status, auto_index, 
        index_interval_hours, last_indexed_at, last_index_status, last_index_error,
        transaction_count, created_at, updated_at, created_by, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        groupId,
        group.groupName || `Group ${groupId.substring(0, 8)}`,
        group.wallets,
        group.primaryWallet || group.wallets[0],
        group.status || "pending",
        group.autoIndex !== false, // default true
        group.indexIntervalHours || 24,
        null, // last_indexed_at
        null, // last_index_status
        null, // last_index_error
        0, // transaction_count
        now,
        now,
        group.createdBy || "admin",
        group.notes || null,
      ],
    );

    // Add wallet-to-group mappings
    for (const wallet of group.wallets) {
      await this.executeWithRetry(
        `INSERT INTO ${CONFIG.AR_TRACKER_TABLES.WALLET_TO_GROUPS}
         (wallet_address, group_id, group_name, is_primary, added_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          wallet,
          groupId,
          group.groupName || `Group ${groupId.substring(0, 8)}`,
          wallet === (group.primaryWallet || group.wallets[0]),
          now,
        ],
      );
    }

    return {
      groupId,
      groupName: group.groupName || `Group ${groupId.substring(0, 8)}`,
      wallets: group.wallets,
      primaryWallet: group.primaryWallet || group.wallets[0],
      status: group.status || "pending",
      autoIndex: group.autoIndex !== false,
      indexIntervalHours: group.indexIntervalHours || 24,
      createdAt: now,
    };
  }

  /**
   * Get a wallet group by ID
   * @param {string} groupId
   * @returns {Object|null}
   */
  async getWalletGroup(groupId) {
    await this.ensureConnection();

    const result = await this.executeWithRetry(
      `SELECT * FROM ${CONFIG.AR_TRACKER_TABLES.REGISTERED_WALLET_GROUPS} WHERE group_id = ?`,
      [groupId],
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return this._rowToWalletGroup(row);
  }

  /**
   * Get all wallet groups
   * @param {Object} options - { status, autoIndex }
   * @returns {Object[]}
   */
  async getAllWalletGroups(options = {}) {
    await this.ensureConnection();

    let query = `SELECT * FROM ${CONFIG.AR_TRACKER_TABLES.REGISTERED_WALLET_GROUPS}`;
    const params = [];

    // Note: Cassandra doesn't support WHERE without partition key efficiently
    // For production, consider a secondary table or ALLOW FILTERING
    if (options.status) {
      query += ` WHERE status = ? ALLOW FILTERING`;
      params.push(options.status);
    } else if (options.autoIndex !== undefined) {
      query += ` WHERE auto_index = ? ALLOW FILTERING`;
      params.push(options.autoIndex);
    }

    const result = await this.executeWithRetry(query, params);
    return result.rows.map((row) => this._rowToWalletGroup(row));
  }

  /**
   * Get wallet groups that need indexing (for cron job)
   * @returns {Object[]}
   */
  async getGroupsDueForIndexing() {
    await this.ensureConnection();

    const result = await this.executeWithRetry(
      `SELECT * FROM ${CONFIG.AR_TRACKER_TABLES.REGISTERED_WALLET_GROUPS}
       WHERE auto_index = true AND status = 'active' ALLOW FILTERING`,
      [],
    );

    const now = Date.now();
    return result.rows
      .map((row) => this._rowToWalletGroup(row))
      .filter((group) => {
        if (!group.lastIndexedAt) return true; // Never indexed
        const hoursSinceLastIndex =
          (now - new Date(group.lastIndexedAt).getTime()) / (1000 * 60 * 60);
        return hoursSinceLastIndex >= group.indexIntervalHours;
      });
  }

  /**
   * Update wallet group
   * @param {string} groupId
   * @param {Object} updates
   */
  async updateWalletGroup(groupId, updates) {
    await this.ensureConnection();

    const setClauses = [];
    const params = [];

    if (updates.groupName !== undefined) {
      setClauses.push("group_name = ?");
      params.push(updates.groupName);
    }
    if (updates.status !== undefined) {
      setClauses.push("status = ?");
      params.push(updates.status);
    }
    if (updates.autoIndex !== undefined) {
      setClauses.push("auto_index = ?");
      params.push(updates.autoIndex);
    }
    if (updates.indexIntervalHours !== undefined) {
      setClauses.push("index_interval_hours = ?");
      params.push(updates.indexIntervalHours);
    }
    if (updates.lastIndexedAt !== undefined) {
      setClauses.push("last_indexed_at = ?");
      params.push(updates.lastIndexedAt);
    }
    if (updates.lastIndexStatus !== undefined) {
      setClauses.push("last_index_status = ?");
      params.push(updates.lastIndexStatus);
    }
    if (updates.lastIndexError !== undefined) {
      setClauses.push("last_index_error = ?");
      params.push(updates.lastIndexError);
    }
    if (updates.transactionCount !== undefined) {
      setClauses.push("transaction_count = ?");
      params.push(updates.transactionCount);
    }
    if (updates.notes !== undefined) {
      setClauses.push("notes = ?");
      params.push(updates.notes);
    }

    setClauses.push("updated_at = ?");
    params.push(new Date());
    params.push(groupId);

    if (setClauses.length > 1) {
      await this.executeWithRetry(
        `UPDATE ${CONFIG.AR_TRACKER_TABLES.REGISTERED_WALLET_GROUPS}
         SET ${setClauses.join(", ")}
         WHERE group_id = ?`,
        params,
      );
    }
  }

  /**
   * Delete wallet group
   * @param {string} groupId
   */
  async deleteWalletGroup(groupId) {
    await this.ensureConnection();

    // Get the group first to remove wallet mappings
    const group = await this.getWalletGroup(groupId);
    if (!group) return;

    // Delete wallet-to-group mappings
    for (const wallet of group.wallets) {
      await this.executeWithRetry(
        `DELETE FROM ${CONFIG.AR_TRACKER_TABLES.WALLET_TO_GROUPS}
         WHERE wallet_address = ? AND group_id = ?`,
        [wallet, groupId],
      );
    }

    // Delete the group
    await this.executeWithRetry(
      `DELETE FROM ${CONFIG.AR_TRACKER_TABLES.REGISTERED_WALLET_GROUPS} WHERE group_id = ?`,
      [groupId],
    );
  }

  /**
   * Get groups for a wallet address
   * @param {string} walletAddress
   * @returns {Object[]}
   */
  async getGroupsForWallet(walletAddress) {
    await this.ensureConnection();

    const result = await this.executeWithRetry(
      `SELECT * FROM ${CONFIG.AR_TRACKER_TABLES.WALLET_TO_GROUPS} WHERE wallet_address = ?`,
      [walletAddress],
    );

    return result.rows.map((row) => ({
      groupId: row.group_id,
      groupName: row.group_name,
      isPrimary: row.is_primary,
      addedAt: row.added_at,
    }));
  }

  /**
   * Convert database row to wallet group object
   * @param {Object} row
   * @returns {Object}
   */
  _rowToWalletGroup(row) {
    return {
      groupId: row.group_id,
      groupName: row.group_name,
      wallets: row.wallets || [],
      primaryWallet: row.primary_wallet,
      status: row.status,
      autoIndex: row.auto_index,
      indexIntervalHours: row.index_interval_hours,
      lastIndexedAt: row.last_indexed_at,
      lastIndexStatus: row.last_index_status,
      lastIndexError: row.last_index_error,
      transactionCount: row.transaction_count || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: row.created_by,
      notes: row.notes,
    };
  }
}

module.exports = { CassandraArTrackerService };
