/**
 * CostBasisService
 *
 * Manages cost basis tracking and tax lot storage for cryptocurrency tax reporting.
 * Implements FIFO (First-In-First-Out), LIFO (Last-In-First-Out), and HIFO (Highest-In-First-Out)
 * accounting methods for capital gains calculations.
 *
 * Storage Strategy:
 * This implementation uses a hybrid compute/storage approach optimized for:
 * - Hetzner CX32 node: 4 vCPU, 8GB RAM, 80GB disk
 * - 500-3000 users with up to 5 wallets each
 *
 * Design Decisions:
 * 1. Tax lots stored in Cassandra with efficient querying by wallet and token
 * 2. Cost basis computed on-demand from tax lots (not pre-computed) to save storage
 * 3. Batched writes to minimize database round trips
 * 4. In-memory caching for active sessions to reduce database load
 * 5. Lazy loading - only fetch lots when needed for calculations
 *
 * Storage Estimate:
 * - Avg 500 tax lots per wallet * 5 wallets * 3000 users = 7.5M rows
 * - ~200 bytes per row = ~1.5GB total (well within 80GB disk)
 * - With compression, expect ~500MB actual storage
 *
 * Cassandra Schema:
 * - Primary key: (wallet_address, token_symbol, acquisition_date, lot_id)
 * - Allows efficient queries by wallet, token, and date range
 * - Supports all accounting methods through sorting
 *
 * @module services/ar-tracker/CostBasisService
 *
 * Adapted for ao-tax-tracker-server integration.
 * Uses CassandraArTrackerService for database operations.
 */

const crypto = require("crypto");
const uuidv4 = () => crypto.randomUUID();

/**
 * Supported accounting methods for cost basis calculations
 */
const ACCOUNTING_METHODS = {
  FIFO: "FIFO", // First-In-First-Out
  LIFO: "LIFO", // Last-In-First-Out
  HIFO: "HIFO", // Highest-In-First-Out (minimizes gains)
  SPEC_ID: "SPEC_ID", // Specific Identification (manual selection)
};

/**
 * Tax lot status values
 */
const LOT_STATUS = {
  OPEN: "OPEN", // Lot has remaining quantity
  CLOSED: "CLOSED", // Lot fully disposed
  PARTIAL: "PARTIAL", // Lot partially disposed
};

/**
 * Cassandra schema for cost basis tables
 */
const COST_BASIS_SCHEMA = {
  tax_lots: `
    CREATE TABLE IF NOT EXISTS tax_lots (
      wallet_address TEXT,
      token_symbol TEXT,
      lot_id TEXT,
      acquisition_date TIMESTAMP,
      acquisition_tx_id TEXT,
      acquisition_type TEXT,
      original_quantity DECIMAL,
      remaining_quantity DECIMAL,
      cost_basis_per_unit DECIMAL,
      cost_basis_total DECIMAL,
      token_process_id TEXT,
      status TEXT,
      holding_period_start TIMESTAMP,
      notes TEXT,
      created_at TIMESTAMP,
      updated_at TIMESTAMP,
      PRIMARY KEY ((wallet_address, token_symbol), acquisition_date, lot_id)
    ) WITH CLUSTERING ORDER BY (acquisition_date ASC, lot_id ASC);
  `,

  disposals: `
    CREATE TABLE IF NOT EXISTS disposals (
      wallet_address TEXT,
      token_symbol TEXT,
      disposal_id TEXT,
      disposal_date TIMESTAMP,
      disposal_tx_id TEXT,
      disposal_type TEXT,
      quantity DECIMAL,
      proceeds_per_unit DECIMAL,
      proceeds_total DECIMAL,
      lots_used TEXT,
      cost_basis DECIMAL,
      gain_loss DECIMAL,
      is_long_term BOOLEAN,
      accounting_method TEXT,
      notes TEXT,
      created_at TIMESTAMP,
      PRIMARY KEY ((wallet_address, token_symbol), disposal_date, disposal_id)
    ) WITH CLUSTERING ORDER BY (disposal_date ASC, disposal_id ASC);
  `,

  // Original tax lots - immutable snapshot of lot state when first created
  // Used to restore lots to original state without needing to reverse disposals
  tax_lot_originals: `
    CREATE TABLE IF NOT EXISTS tax_lot_originals (
      wallet_address TEXT,
      token_symbol TEXT,
      lot_id TEXT,
      acquisition_date TIMESTAMP,
      acquisition_tx_id TEXT,
      acquisition_type TEXT,
      original_quantity DECIMAL,
      cost_basis_per_unit DECIMAL,
      cost_basis_total DECIMAL,
      token_process_id TEXT,
      holding_period_start TIMESTAMP,
      notes TEXT,
      created_at TIMESTAMP,
      PRIMARY KEY ((wallet_address, token_symbol), lot_id)
    );
  `,

  // Summary table for quick lookups
  holdings_summary: `
    CREATE TABLE IF NOT EXISTS holdings_summary (
      wallet_address TEXT,
      token_symbol TEXT,
      total_quantity DECIMAL,
      average_cost_basis DECIMAL,
      total_cost_basis DECIMAL,
      last_acquisition_date TIMESTAMP,
      last_disposal_date TIMESTAMP,
      open_lots_count INT,
      updated_at TIMESTAMP,
      PRIMARY KEY (wallet_address, token_symbol)
    );
  `,
};

/**
 * CostBasisService class
 *
 * Manages tax lot creation, disposal matching, and cost basis calculations.
 * Uses Cassandra for persistence with in-memory caching for performance.
 */
class CostBasisService {
  /**
   * Create a new CostBasisService instance
   *
   * @param {Object} options - Configuration options
   * @param {Object} options.cassandraService - Cassandra service instance
   * @param {string} options.accountingMethod - Default accounting method (FIFO, LIFO, HIFO)
   * @param {boolean} options.verbose - Enable verbose logging
   */
  constructor(options = {}) {
    this.cassandraService = options.cassandraService;
    this.accountingMethod = options.accountingMethod || ACCOUNTING_METHODS.FIFO;
    this.verbose = options.verbose || false;

    // In-memory cache for active tax lot operations
    // Key: `${walletAddress}:${tokenSymbol}` -> Array of lots
    this.lotCache = new Map();
    this.cacheExpiry = new Map();
    this.cacheTTL = 5 * 60 * 1000; // 5 minutes

    // Batch write buffer
    this.pendingWrites = [];
    this.batchSize = 50;
  }

  /**
   * Initialize the cost basis schema in Cassandra
   */
  async initializeSchema() {
    if (!this.cassandraService) {
      throw new Error("CassandraService is required for cost basis tracking");
    }

    if (this.verbose) {
      console.log("Initializing cost basis schema...");
    }

    const client = this.cassandraService.client;

    await client.execute(COST_BASIS_SCHEMA.tax_lots);
    await client.execute(COST_BASIS_SCHEMA.disposals);
    await client.execute(COST_BASIS_SCHEMA.holdings_summary);
    await client.execute(COST_BASIS_SCHEMA.tax_lot_originals);

    // Migration: Add cost_basis column to disposals table if it doesn't exist
    try {
      await client.execute(`ALTER TABLE disposals ADD cost_basis DECIMAL`);
      if (this.verbose) {
        console.log("Added cost_basis column to disposals table");
      }
    } catch (error) {
      // Column may already exist, ignore error
      if (this.verbose && !error.message.includes("already exists")) {
        console.log(`Note: cost_basis column: ${error.message}`);
      }
    }

    if (this.verbose) {
      console.log("Cost basis schema initialized");
    }
  }

  /**
   * Generate a cache key for a wallet/token combination
   *
   * @param {string} walletAddress - Wallet address
   * @param {string} tokenSymbol - Token symbol
   * @returns {string} Cache key
   */
  getCacheKey(walletAddress, tokenSymbol) {
    return `${walletAddress}:${tokenSymbol}`;
  }

  /**
   * Check if cache entry is still valid
   *
   * @param {string} cacheKey - Cache key
   * @returns {boolean} True if cache is valid
   */
  isCacheValid(cacheKey) {
    const expiry = this.cacheExpiry.get(cacheKey);
    return expiry && Date.now() < expiry;
  }

  /**
   * Set cache with expiry
   *
   * @param {string} cacheKey - Cache key
   * @param {Array} lots - Tax lots to cache
   */
  setCache(cacheKey, lots) {
    this.lotCache.set(cacheKey, lots);
    this.cacheExpiry.set(cacheKey, Date.now() + this.cacheTTL);
  }

  /**
   * Clear cache for a wallet/token
   *
   * @param {string} walletAddress - Wallet address
   * @param {string} tokenSymbol - Token symbol (optional, clears all if not provided)
   */
  clearCache(walletAddress, tokenSymbol = null) {
    if (tokenSymbol) {
      const key = this.getCacheKey(walletAddress, tokenSymbol);
      this.lotCache.delete(key);
      this.cacheExpiry.delete(key);
    } else {
      // Clear all cache entries for this wallet
      for (const key of this.lotCache.keys()) {
        if (key.startsWith(`${walletAddress}:`)) {
          this.lotCache.delete(key);
          this.cacheExpiry.delete(key);
        }
      }
    }
  }

  /**
   * Create a new tax lot from an acquisition transaction
   *
   * @param {Object} acquisition - Acquisition details
   * @param {string} acquisition.walletAddress - Wallet that acquired the tokens
   * @param {string} acquisition.tokenSymbol - Token symbol
   * @param {string} acquisition.tokenProcessId - Token process ID (for AO tokens)
   * @param {Date} acquisition.date - Acquisition date
   * @param {string} acquisition.txId - Transaction ID
   * @param {string} acquisition.type - Acquisition type (PURCHASE, TRADE, INCOME, AIRDROP, etc.)
   * @param {number} acquisition.quantity - Amount acquired
   * @param {number} acquisition.costBasisPerUnit - Cost per unit in USD
   * @param {string} acquisition.notes - Optional notes
   * @param {boolean} acquisition.skipDuplicateCheck - Skip duplicate checking
   * @returns {Object|null} Created tax lot, or null if duplicate
   */
  async createTaxLot(acquisition) {
    // Check for existing lot with same tx_id (prevents duplicates)
    if (!acquisition.skipDuplicateCheck) {
      const exists = await this.lotExists(
        acquisition.walletAddress,
        acquisition.txId,
        acquisition.tokenSymbol,
      );
      if (exists) {
        if (this.verbose) {
          console.log(
            `⚠️  Skipping duplicate tax lot for tx ${acquisition.txId.substring(
              0,
              12,
            )}...`,
          );
        }
        return null;
      }
    }

    const lot = {
      walletAddress: acquisition.walletAddress,
      tokenSymbol: acquisition.tokenSymbol,
      lotId: uuidv4(),
      acquisitionDate: acquisition.date,
      acquisitionTxId: acquisition.txId,
      acquisitionType: acquisition.type,
      originalQuantity: acquisition.quantity,
      remainingQuantity: acquisition.quantity,
      costBasisPerUnit: acquisition.costBasisPerUnit || 0,
      costBasisTotal:
        (acquisition.costBasisPerUnit || 0) * acquisition.quantity,
      tokenProcessId: acquisition.tokenProcessId,
      status: LOT_STATUS.OPEN,
      holdingPeriodStart: acquisition.date,
      notes: acquisition.notes || null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Save to database
    await this.saveTaxLot(lot);

    // CRITICAL: Also save to tax_lot_originals table (immutable snapshot)
    // This allows us to restore lots to original state without reversing disposals
    await this.saveTaxLotOriginal(lot);

    // Invalidate cache
    this.clearCache(lot.walletAddress, lot.tokenSymbol);

    if (this.verbose) {
      console.log(
        `Created tax lot ${lot.lotId.substring(0, 8)}... for ${
          lot.originalQuantity
        } ${lot.tokenSymbol}`,
      );
    }

    return lot;
  }

  /**
   * Save a tax lot to Cassandra
   *
   * @param {Object} lot - Tax lot to save
   */
  async saveTaxLot(lot) {
    if (!this.cassandraService) {
      throw new Error("CassandraService is required");
    }

    const query = `
      INSERT INTO tax_lots (
        wallet_address, token_symbol, lot_id, acquisition_date,
        acquisition_tx_id, acquisition_type, original_quantity, remaining_quantity,
        cost_basis_per_unit, cost_basis_total, token_process_id, status,
        holding_period_start, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      lot.walletAddress,
      lot.tokenSymbol,
      lot.lotId,
      lot.acquisitionDate,
      lot.acquisitionTxId,
      lot.acquisitionType,
      lot.originalQuantity,
      lot.remainingQuantity,
      lot.costBasisPerUnit,
      lot.costBasisTotal,
      lot.tokenProcessId,
      lot.status,
      lot.holdingPeriodStart,
      lot.notes,
      lot.createdAt,
      lot.updatedAt,
    ];

    await this.cassandraService.client.execute(query, params, {
      prepare: true,
    });
  }

  /**
   * Save original tax lot to immutable originals table
   * This is called once when the lot is first created and never modified
   *
   * @param {Object} lot - Tax lot to save as original
   */
  async saveTaxLotOriginal(lot) {
    if (!this.cassandraService) {
      throw new Error("CassandraService is required");
    }

    // Check if original already exists (idempotent - don't overwrite)
    const checkQuery = `
      SELECT lot_id FROM tax_lot_originals
      WHERE wallet_address = ? AND token_symbol = ? AND lot_id = ?
    `;
    const checkResult = await this.cassandraService.client.execute(
      checkQuery,
      [lot.walletAddress, lot.tokenSymbol, lot.lotId],
      { prepare: true },
    );

    // If original already exists, skip (idempotent)
    if (checkResult.rows.length > 0) {
      return;
    }

    const query = `
      INSERT INTO tax_lot_originals (
        wallet_address, token_symbol, lot_id, acquisition_date,
        acquisition_tx_id, acquisition_type, original_quantity,
        cost_basis_per_unit, cost_basis_total, token_process_id,
        holding_period_start, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      lot.walletAddress,
      lot.tokenSymbol,
      lot.lotId,
      lot.acquisitionDate,
      lot.acquisitionTxId,
      lot.acquisitionType,
      lot.originalQuantity, // Store original quantity (never changes)
      lot.costBasisPerUnit,
      lot.costBasisTotal,
      lot.tokenProcessId,
      lot.holdingPeriodStart,
      lot.notes,
      lot.createdAt,
    ];

    await this.cassandraService.client.execute(query, params, {
      prepare: true,
    });
  }

  /**
   * Get original tax lot from immutable originals table
   *
   * @param {string} walletAddress - Wallet address
   * @param {string} tokenSymbol - Token symbol
   * @param {string} lotId - Lot ID
   * @returns {Object|null} Original tax lot or null if not found
   */
  async getTaxLotOriginal(walletAddress, tokenSymbol, lotId) {
    if (!this.cassandraService) {
      throw new Error("CassandraService is required");
    }

    const query = `
      SELECT * FROM tax_lot_originals
      WHERE wallet_address = ? AND token_symbol = ? AND lot_id = ?
    `;

    const result = await this.cassandraService.client.execute(
      query,
      [walletAddress, tokenSymbol, lotId],
      { prepare: true },
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      walletAddress: row.wallet_address,
      tokenSymbol: row.token_symbol,
      lotId: row.lot_id,
      acquisitionDate: row.acquisition_date,
      acquisitionTxId: row.acquisition_tx_id,
      acquisitionType: row.acquisition_type,
      originalQuantity: parseFloat(row.original_quantity),
      costBasisPerUnit: parseFloat(row.cost_basis_per_unit),
      costBasisTotal: parseFloat(row.cost_basis_total),
      tokenProcessId: row.token_process_id,
      holdingPeriodStart: row.holding_period_start,
      notes: row.notes,
      createdAt: row.created_at,
    };
  }

  /**
   * Restore all tax lots to their original state from the originals table
   * This is much more reliable than reversing disposals, as it doesn't depend on processing order
   *
   * @param {string} walletAddress - Wallet address
   * @param {string} tokenSymbol - Token symbol (optional, restores all tokens if not provided)
   * @returns {Object} Restoration results
   */
  async restoreAllLotsFromOriginals(walletAddress, tokenSymbol = null) {
    if (!this.cassandraService) {
      throw new Error("CassandraService is required");
    }

    await this.cassandraService.useKeyspace();

    let query;
    let params;

    if (tokenSymbol) {
      query = `
        SELECT * FROM tax_lot_originals
        WHERE wallet_address = ? AND token_symbol = ?
      `;
      params = [walletAddress, tokenSymbol];
    } else {
      // Query all token symbols for this wallet
      // Since partition key is (wallet_address, token_symbol), we need ALLOW FILTERING
      // This is acceptable for restoration operations (done once per report generation)
      query = `
        SELECT * FROM tax_lot_originals
        WHERE wallet_address = ? ALLOW FILTERING
      `;
      params = [walletAddress];
    }

    let result;
    try {
      result = await this.cassandraService.client.execute(query, params, {
        prepare: true,
      });
    } catch (error) {
      // If ALLOW FILTERING still fails, try querying by common token symbols
      if (this.verbose) {
        console.log(
          `   ⚠️  Error querying tax_lot_originals: ${error.message}`,
        );
        console.log(`   📋 Falling back to per-token queries...`);
      }

      const commonTokens = [
        "AR",
        "wAR",
        "AO",
        "ARIO",
        "PI",
        "qAR",
        "wUSDC",
        "USDA",
        "TRUNK",
        "TRUNK2",
        "EXP",
        "KARD",
      ];
      const allRows = [];

      for (const token of commonTokens) {
        try {
          const tokenQuery = `SELECT * FROM tax_lot_originals WHERE wallet_address = ? AND token_symbol = ?`;
          const tokenResult = await this.cassandraService.client.execute(
            tokenQuery,
            [walletAddress, token],
            { prepare: true },
          );
          allRows.push(...tokenResult.rows);
        } catch (tokenError) {
          // Ignore errors for individual tokens
        }
      }

      result = { rows: allRows };
    }

    let restoredCount = 0;
    let createdCount = 0;

    for (const row of result.rows) {
      try {
        // Check if lot exists in main table
        const existingLots = await this.getTaxLots(
          walletAddress,
          row.token_symbol,
          { includePartial: true },
        );
        const existingLot = existingLots.find((l) => l.lotId === row.lot_id);

        if (existingLot) {
          // Restore to original state
          existingLot.remainingQuantity = parseFloat(row.original_quantity);
          existingLot.originalQuantity = parseFloat(row.original_quantity);
          existingLot.status =
            parseFloat(row.original_quantity) > 0.000001
              ? LOT_STATUS.OPEN
              : LOT_STATUS.CLOSED;
          existingLot.updatedAt = new Date();

          await this.saveTaxLot(existingLot);
          restoredCount++;
        } else {
          // Create lot from original (doesn't exist in main table)
          const restoredLot = {
            walletAddress: row.wallet_address,
            tokenSymbol: row.token_symbol,
            lotId: row.lot_id,
            acquisitionDate: row.acquisition_date,
            acquisitionTxId: row.acquisition_tx_id,
            acquisitionType: row.acquisition_type,
            originalQuantity: parseFloat(row.original_quantity),
            remainingQuantity: parseFloat(row.original_quantity),
            costBasisPerUnit: parseFloat(row.cost_basis_per_unit),
            costBasisTotal: parseFloat(row.cost_basis_total),
            tokenProcessId: row.token_process_id,
            status:
              parseFloat(row.original_quantity) > 0.000001
                ? LOT_STATUS.OPEN
                : LOT_STATUS.CLOSED,
            holdingPeriodStart: row.holding_period_start,
            notes: row.notes,
            createdAt: row.created_at,
            updatedAt: new Date(),
          };

          await this.saveTaxLot(restoredLot);
          createdCount++;
        }
      } catch (error) {
        if (this.verbose) {
          console.log(
            `⚠️  Error restoring lot ${row.lot_id.substring(0, 8)}...: ${
              error.message
            }`,
          );
        }
      }
    }

    // Clear cache after restoring all lots
    if (tokenSymbol) {
      this.clearCache(walletAddress, tokenSymbol);
    } else {
      // Clear cache for all tokens
      const allTokens = new Set();
      for (const row of result.rows) {
        allTokens.add(row.token_symbol);
      }
      for (const token of allTokens) {
        this.clearCache(walletAddress, token);
      }
    }

    if (this.verbose) {
      console.log(
        `   ✅ Restored ${restoredCount} lots, created ${createdCount} lots from originals for ${walletAddress.substring(
          0,
          12,
        )}...`,
      );
    }

    return {
      restoredCount,
      createdCount,
      totalLots: restoredCount + createdCount,
    };
  }

  /**
   * Get all open tax lots for a wallet/token combination
   *
   * @param {string} walletAddress - Wallet address
   * @param {string} tokenSymbol - Token symbol
   * @param {Object} options - Query options
   * @param {boolean} options.includePartial - Include partially disposed lots
   * @param {Date} options.asOfDate - Get lots as of a specific date
   * @returns {Array} Array of tax lots
   */
  async getTaxLots(walletAddress, tokenSymbol = null, options = {}) {
    // If tokenSymbol is an object, it's actually options (backwards compat)
    if (tokenSymbol && typeof tokenSymbol === "object") {
      options = tokenSymbol;
      tokenSymbol = null;
    }

    // Special case: TRUNK2 can use TRUNK lots (TRUNK was forked into TRUNK2)
    // This is a special case and should not be the default for other tokens
    let queryTokenSymbols = tokenSymbol ? [tokenSymbol] : null;
    if (tokenSymbol === "TRUNK2") {
      queryTokenSymbols = ["TRUNK2", "TRUNK"];
      if (this.verbose) {
        console.log(
          `   🔄 Including TRUNK lots for TRUNK2 disposal (fork compatibility)`,
        );
      }
    }

    const cacheKey = this.getCacheKey(walletAddress, tokenSymbol || "ALL");

    // Check cache first (if not querying as-of date and have specific token)
    // Note: Cache won't work for TRUNK2 -> TRUNK mapping, so skip cache in that case
    if (
      tokenSymbol &&
      !options.asOfDate &&
      tokenSymbol !== "TRUNK2" &&
      this.isCacheValid(cacheKey)
    ) {
      const cached = this.lotCache.get(cacheKey);
      return options.includePartial
        ? cached.filter((l) => l.remainingQuantity > 0)
        : cached.filter((l) => l.status === LOT_STATUS.OPEN);
    }

    // Query from database - with or without token filter
    let query;
    let params;

    if (queryTokenSymbols && queryTokenSymbols.length > 0) {
      // Handle multiple token symbols (e.g., TRUNK2 + TRUNK)
      if (queryTokenSymbols.length === 1) {
        query = `
          SELECT * FROM tax_lots
          WHERE wallet_address = ? AND token_symbol = ?
        `;
        params = [walletAddress, queryTokenSymbols[0]];
      } else {
        // Use IN clause for multiple symbols
        const placeholders = queryTokenSymbols.map(() => "?").join(",");
        query = `
          SELECT * FROM tax_lots
          WHERE wallet_address = ? AND token_symbol IN (${placeholders})
          ALLOW FILTERING
        `;
        params = [walletAddress, ...queryTokenSymbols];
      }
    } else if (tokenSymbol) {
      query = `
        SELECT * FROM tax_lots
        WHERE wallet_address = ? AND token_symbol = ?
      `;
      params = [walletAddress, tokenSymbol];
    } else {
      // Get all tokens for this wallet
      query = `
        SELECT * FROM tax_lots
        WHERE wallet_address = ?
        ALLOW FILTERING
      `;
      params = [walletAddress];
    }

    const result = await this.cassandraService.client.execute(query, params, {
      prepare: true,
    });

    // Transform rows to lot objects
    let lots = result.rows.map((row) => ({
      walletAddress: row.wallet_address,
      tokenSymbol: row.token_symbol,
      lotId: row.lot_id,
      acquisitionDate: row.acquisition_date,
      acquisitionTxId: row.acquisition_tx_id,
      acquisitionType: row.acquisition_type,
      originalQuantity: parseFloat(row.original_quantity),
      remainingQuantity: parseFloat(row.remaining_quantity),
      costBasisPerUnit: parseFloat(row.cost_basis_per_unit),
      costBasisTotal: parseFloat(row.cost_basis_total),
      tokenProcessId: row.token_process_id,
      status: row.status,
      holdingPeriodStart: row.holding_period_start,
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    // Filter by as-of date if specified
    if (options.asOfDate) {
      lots = lots.filter((l) => l.acquisitionDate <= options.asOfDate);
    }

    // Cache the results (if not as-of date query)
    if (!options.asOfDate) {
      this.setCache(cacheKey, lots);
    }

    // Filter by status
    if (options.includePartial) {
      return lots.filter((l) => l.remainingQuantity > 0);
    }

    return lots.filter(
      (l) => l.status === LOT_STATUS.OPEN || l.remainingQuantity > 0,
    );
  }

  /**
   * Sort tax lots according to the specified accounting method
   *
   * @param {Array} lots - Array of tax lots
   * @param {string} method - Accounting method (FIFO, LIFO, HIFO)
   * @returns {Array} Sorted lots
   */
  sortLotsByMethod(lots, method = this.accountingMethod) {
    const sortedLots = [...lots];

    switch (method) {
      case ACCOUNTING_METHODS.FIFO:
        // First-in-first-out: oldest lots first
        sortedLots.sort((a, b) => a.acquisitionDate - b.acquisitionDate);
        break;

      case ACCOUNTING_METHODS.LIFO:
        // Last-in-first-out: newest lots first
        sortedLots.sort((a, b) => b.acquisitionDate - a.acquisitionDate);
        break;

      case ACCOUNTING_METHODS.HIFO:
        // Highest-in-first-out: highest cost basis first (minimizes gains)
        sortedLots.sort((a, b) => b.costBasisPerUnit - a.costBasisPerUnit);
        break;

      default:
        // Default to FIFO
        sortedLots.sort((a, b) => a.acquisitionDate - b.acquisitionDate);
    }

    return sortedLots;
  }

  /**
   * Calculate gain/loss for a disposal using specified accounting method
   *
   * @param {Object} disposal - Disposal details
   * @param {string} disposal.walletAddress - Wallet address
   * @param {string} disposal.tokenSymbol - Token symbol
   * @param {Date} disposal.date - Disposal date
   * @param {string} disposal.txId - Transaction ID
   * @param {string} disposal.type - Disposal type (SALE, TRADE, GIFT, etc.)
   * @param {number} disposal.quantity - Amount disposed
   * @param {number} disposal.proceedsPerUnit - Proceeds per unit in USD
   * @param {string} disposal.accountingMethod - Override accounting method
   * @param {string} disposal.notes - Optional notes
   * @returns {Object} Disposal result with gain/loss calculation
   */
  async calculateDisposal(disposal) {
    const method = disposal.accountingMethod || this.accountingMethod;

    // Get available lots
    const lots = await this.getTaxLots(
      disposal.walletAddress,
      disposal.tokenSymbol,
      {
        includePartial: true,
      },
    );

    if (this.verbose) {
      const totalAvailable = lots.reduce(
        (sum, lot) => sum + (lot.remainingQuantity || 0),
        0,
      );
      console.log(
        `   🔍 calculateDisposal: Found ${
          lots.length
        } lots with ${totalAvailable.toFixed(6)} ${
          disposal.tokenSymbol
        } available (need ${disposal.quantity})`,
      );
      if (lots.length > 0 && lots.length <= 5) {
        lots.forEach((lot, idx) => {
          console.log(
            `      Lot ${idx + 1}: ${lot.lotId.substring(0, 8)}... - ${(
              lot.remainingQuantity || 0
            ).toFixed(6)} ${disposal.tokenSymbol} @ $${(
              lot.costBasisPerUnit || 0
            ).toFixed(2)}/unit`,
          );
        });
      }
    }

    // Sort by accounting method
    const sortedLots = this.sortLotsByMethod(lots, method);

    // Calculate how much we need to dispose
    let remainingToDispose = disposal.quantity;
    const lotsUsed = [];
    let totalCostBasis = 0;
    let hasLongTerm = false;
    let hasShortTerm = false;

    // Match lots to disposal
    for (const lot of sortedLots) {
      if (remainingToDispose <= 0) break;
      if (lot.remainingQuantity <= 0) continue;

      const quantityFromLot = Math.min(
        lot.remainingQuantity,
        remainingToDispose,
      );
      const costBasisFromLot = quantityFromLot * lot.costBasisPerUnit;

      // Calculate holding period (long-term is > 1 year)
      const holdingDays = Math.floor(
        (disposal.date - lot.holdingPeriodStart) / (1000 * 60 * 60 * 24),
      );
      const isLongTerm = holdingDays > 365;

      if (isLongTerm) hasLongTerm = true;
      else hasShortTerm = true;

      lotsUsed.push({
        lotId: lot.lotId,
        quantity: quantityFromLot,
        costBasis: costBasisFromLot,
        costBasisPerUnit: lot.costBasisPerUnit,
        holdingDays,
        isLongTerm,
        acquisitionDate: lot.acquisitionDate,
      });

      totalCostBasis += costBasisFromLot;
      remainingToDispose -= quantityFromLot;
    }

    // Check if we have enough lots to cover the disposal
    if (remainingToDispose > 0.000001) {
      // Allow small rounding errors
      // If no lots were found at all, throw a specific error for airdrop handling
      if (lots.length === 0 || lotsUsed.length === 0) {
        throw new Error(
          `Insufficient lots to cover disposal of ${disposal.quantity} ${disposal.tokenSymbol}. ` +
            `Missing ${remainingToDispose} units. No tax lots available. This may indicate missing acquisition data or an airdrop.`,
        );
      }
      throw new Error(
        `Insufficient lots to cover disposal of ${disposal.quantity} ${disposal.tokenSymbol}. ` +
          `Missing ${remainingToDispose} units. This may indicate missing acquisition data.`,
      );
    }

    // Ensure we have lots used (should never be empty at this point, but check for safety)
    if (lotsUsed.length === 0) {
      throw new Error(
        `Disposal must have lots used calculated first. No lots available for ${disposal.tokenSymbol}.`,
      );
    }

    // Calculate total proceeds and gain/loss
    const totalProceeds = disposal.quantity * (disposal.proceedsPerUnit || 0);
    const gainLoss = totalProceeds - totalCostBasis;

    // Determine if primarily long-term or short-term
    const isLongTerm = hasLongTerm && !hasShortTerm;

    const result = {
      walletAddress: disposal.walletAddress,
      tokenSymbol: disposal.tokenSymbol,
      disposalId: uuidv4(),
      disposalDate: disposal.date,
      disposalTxId: disposal.txId,
      disposalType: disposal.type,
      quantity: disposal.quantity,
      proceedsPerUnit: disposal.proceedsPerUnit || 0,
      proceedsTotal: totalProceeds,
      lotsUsed,
      costBasis: totalCostBasis,
      gainLoss,
      isLongTerm,
      isMixed: hasLongTerm && hasShortTerm,
      accountingMethod: method,
      notes: disposal.notes || null,
      createdAt: new Date(),
    };

    return result;
  }

  /**
   * Execute a disposal - update lots and record the disposal
   *
   * @param {Object} disposal - Disposal object from calculateDisposal
   * @param {boolean} skipDuplicateCheck - Skip duplicate checking
   * @returns {Object|null} Completed disposal record, or null if duplicate
   */
  async executeDisposal(disposal, skipDuplicateCheck = false) {
    if (!disposal.lotsUsed || disposal.lotsUsed.length === 0) {
      throw new Error("Disposal must have lots used calculated first");
    }

    // Check for duplicate first (before modifying lots)
    if (!skipDuplicateCheck) {
      const exists = await this.disposalExists(
        disposal.walletAddress,
        disposal.disposalTxId,
        disposal.tokenSymbol,
      );
      if (exists) {
        if (this.verbose) {
          console.log(
            `⚠️  Skipping duplicate disposal for tx ${disposal.disposalTxId.substring(
              0,
              12,
            )}...`,
          );
        }
        return null;
      }
    } else {
      // When recalculating with skipDuplicateCheck=true, lots should already be restored
      // by restoreAllLotsFromDisposals() which is called before processing transactions.
      // We skip on-demand restoration here to avoid duplicate work and ensure consistency.
      // The bulk restoration ensures all lots are available regardless of processing order.

      // Note: We still check if the disposal exists to verify it was processed before,
      // but we don't restore lots here since they should already be restored.
      const existingQuery = `
        SELECT disposal_id, disposal_date, lots_used FROM disposals
        WHERE wallet_address = ? AND token_symbol = ? AND disposal_tx_id = ?
        ALLOW FILTERING
      `;
      const existingResult = await this.cassandraService.client.execute(
        existingQuery,
        [disposal.walletAddress, disposal.tokenSymbol, disposal.disposalTxId],
        { prepare: true },
      );

      // Skip lot restoration - should already be done by bulk restoration
      // Just verify the disposal exists and proceed with recalculation
      if (existingResult.rows.length > 0 && this.verbose) {
        console.log(
          `   ℹ️  Recalculating existing disposal ${disposal.disposalTxId.substring(
            0,
            12,
          )}... (lots should already be restored)`,
        );
      }

      // Clear cache to ensure we get fresh lot data
      // Lots should already be restored from originals table by restoreAllLotsFromOriginals()
      this.clearCache(disposal.walletAddress, disposal.tokenSymbol);

      if (this.verbose) {
        console.log(
          `   ℹ️  Recalculating disposal ${disposal.disposalTxId.substring(
            0,
            12,
          )}... (lots restored from originals table)`,
        );
      }
    }

    // Update each lot used
    // Clear cache first to ensure we get fresh lot data (if not already cleared)
    if (!skipDuplicateCheck) {
      this.clearCache(disposal.walletAddress, disposal.tokenSymbol);
    }

    for (const lotUsage of disposal.lotsUsed) {
      const lots = await this.getTaxLots(
        disposal.walletAddress,
        disposal.tokenSymbol,
        { includePartial: true },
      );
      const lot = lots.find((l) => l.lotId === lotUsage.lotId);

      if (!lot) {
        // Provide more context in error message
        const availableLotIds = lots
          .map((l) => l.lotId.substring(0, 8) + "...")
          .join(", ");
        throw new Error(
          `Lot ${lotUsage.lotId.substring(0, 8)}... not found for ${
            disposal.tokenSymbol
          }. ` +
            `Available lots: ${availableLotIds || "none"}. ` +
            `This may indicate the lot was already consumed or the cache is stale.`,
        );
      }

      // Update remaining quantity
      lot.remainingQuantity -= lotUsage.quantity;

      // Update status
      if (lot.remainingQuantity <= 0.000001) {
        lot.remainingQuantity = 0;
        lot.status = LOT_STATUS.CLOSED;
      } else {
        lot.status = LOT_STATUS.PARTIAL;
      }

      lot.updatedAt = new Date();

      // Save updated lot
      await this.saveTaxLot(lot);
    }

    // Save disposal record (skip check since we already checked)
    await this.saveDisposal(disposal, true);

    // Clear cache
    this.clearCache(disposal.walletAddress, disposal.tokenSymbol);

    if (this.verbose) {
      console.log(
        `Executed disposal of ${disposal.quantity} ${disposal.tokenSymbol}: ` +
          `${disposal.gainLoss >= 0 ? "gain" : "loss"} of $${Math.abs(
            disposal.gainLoss,
          ).toFixed(2)}`,
      );
    }

    return disposal;
  }

  /**
   * Check if a disposal already exists for a given transaction
   *
   * @param {string} walletAddress - Wallet address
   * @param {string} txId - Transaction ID
   * @param {string} tokenSymbol - Token symbol
   * @returns {boolean} True if disposal exists
   */
  async disposalExists(walletAddress, txId, tokenSymbol) {
    const query = `
      SELECT disposal_id FROM disposals
      WHERE wallet_address = ? AND token_symbol = ? AND disposal_tx_id = ?
      ALLOW FILTERING
    `;

    const result = await this.cassandraService.client.execute(
      query,
      [walletAddress, tokenSymbol, txId],
      { prepare: true },
    );

    return result.rows.length > 0;
  }

  /**
   * Check if a tax lot already exists for a given transaction
   *
   * @param {string} walletAddress - Wallet address
   * @param {string} txId - Transaction ID
   * @param {string} tokenSymbol - Token symbol
   * @returns {boolean} True if lot exists
   */
  async lotExists(walletAddress, txId, tokenSymbol) {
    const query = `
      SELECT lot_id FROM tax_lots
      WHERE wallet_address = ? AND token_symbol = ? AND acquisition_tx_id = ?
      ALLOW FILTERING
    `;

    const result = await this.cassandraService.client.execute(
      query,
      [walletAddress, tokenSymbol, txId],
      { prepare: true },
    );

    return result.rows.length > 0;
  }

  /**
   * Save a disposal record to Cassandra (with duplicate check)
   *
   * @param {Object} disposal - Disposal to save
   * @param {boolean} skipDuplicateCheck - Skip the duplicate check (for internal use)
   * @returns {boolean} True if saved, false if duplicate
   */
  async saveDisposal(disposal, skipDuplicateCheck = false) {
    // Check for existing disposal with same tx_id (prevents duplicates)
    if (!skipDuplicateCheck) {
      const exists = await this.disposalExists(
        disposal.walletAddress,
        disposal.disposalTxId,
        disposal.tokenSymbol,
      );
      if (exists) {
        if (this.verbose) {
          console.log(
            `⚠️  Skipping duplicate disposal for tx ${disposal.disposalTxId.substring(
              0,
              12,
            )}...`,
          );
        }
        return false;
      }
    } else {
      // When recalculating, delete existing disposal(s) first
      // Note: Tax lots are restored in executeDisposal BEFORE this is called
      // Query for existing disposal by tx_id to get its disposal_id
      const existingQuery = `
        SELECT disposal_id, disposal_date FROM disposals
        WHERE wallet_address = ? AND token_symbol = ? AND disposal_tx_id = ?
        ALLOW FILTERING
      `;
      const existingResult = await this.cassandraService.client.execute(
        existingQuery,
        [disposal.walletAddress, disposal.tokenSymbol, disposal.disposalTxId],
        { prepare: true },
      );

      // Delete existing disposal(s) - lots were already restored in executeDisposal
      for (const row of existingResult.rows) {
        const deleteQuery = `
          DELETE FROM disposals
          WHERE wallet_address = ? AND token_symbol = ? AND disposal_date = ? AND disposal_id = ?
        `;
        await this.cassandraService.client.execute(
          deleteQuery,
          [
            disposal.walletAddress,
            disposal.tokenSymbol,
            row.disposal_date,
            row.disposal_id,
          ],
          { prepare: true },
        );
      }
    }

    // Insert new disposal (or re-insert after deletion)
    const query = `
      INSERT INTO disposals (
        wallet_address, token_symbol, disposal_id, disposal_date,
        disposal_tx_id, disposal_type, quantity, proceeds_per_unit,
        proceeds_total, lots_used, cost_basis, gain_loss, is_long_term,
        accounting_method, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      disposal.walletAddress,
      disposal.tokenSymbol,
      disposal.disposalId,
      disposal.disposalDate,
      disposal.disposalTxId,
      disposal.disposalType,
      disposal.quantity,
      disposal.proceedsPerUnit,
      disposal.proceedsTotal,
      JSON.stringify(disposal.lotsUsed),
      disposal.costBasis || null,
      disposal.gainLoss,
      disposal.isLongTerm,
      disposal.accountingMethod,
      disposal.notes,
      disposal.createdAt,
    ];

    await this.cassandraService.client.execute(query, params, {
      prepare: true,
    });

    return true;
  }

  /**
   * Get all disposals for a wallet within a date range
   *
   * @param {string} walletAddress - Wallet address
   * @param {Object} options - Query options
   * @param {Date} options.startDate - Start of date range
   * @param {Date} options.endDate - End of date range
   * @param {string} options.tokenSymbol - Filter by token
   * @returns {Array} Array of disposals
   */
  async getDisposals(walletAddress, options = {}) {
    let query;
    let params;

    if (options.tokenSymbol) {
      query = `SELECT * FROM disposals WHERE wallet_address = ? AND token_symbol = ?`;
      params = [walletAddress, options.tokenSymbol];
    } else {
      // Query all tokens for this wallet (requires allowing filtering or separate queries)
      query = `SELECT * FROM disposals WHERE wallet_address = ? ALLOW FILTERING`;
      params = [walletAddress];
    }

    const result = await this.cassandraService.client.execute(query, params, {
      prepare: true,
    });

    let disposals = result.rows.map((row) => ({
      walletAddress: row.wallet_address,
      tokenSymbol: row.token_symbol,
      disposalId: row.disposal_id,
      disposalDate: row.disposal_date,
      disposalTxId: row.disposal_tx_id,
      disposalType: row.disposal_type,
      quantity: parseFloat(row.quantity),
      proceedsPerUnit: parseFloat(row.proceeds_per_unit),
      proceedsTotal: parseFloat(row.proceeds_total),
      lotsUsed: JSON.parse(row.lots_used || "[]"),
      costBasis:
        row.cost_basis !== null && row.cost_basis !== undefined
          ? parseFloat(row.cost_basis)
          : (() => {
              // Calculate from lotsUsed if cost_basis is null
              const lots = JSON.parse(row.lots_used || "[]");
              return lots.reduce((sum, lot) => sum + (lot.costBasis || 0), 0);
            })(),
      gainLoss: parseFloat(row.gain_loss),
      isLongTerm: row.is_long_term,
      accountingMethod: row.accounting_method,
      notes: row.notes,
      createdAt: row.created_at,
    }));

    // Filter by date range
    if (options.startDate) {
      disposals = disposals.filter((d) => d.disposalDate >= options.startDate);
    }
    if (options.endDate) {
      disposals = disposals.filter((d) => d.disposalDate <= options.endDate);
    }

    return disposals;
  }

  /**
   * Get a disposal by transaction ID
   *
   * @param {string} txId - Transaction ID
   * @returns {Object|null} Disposal record or null if not found
   */
  async getDisposalByTxId(txId) {
    if (!txId) return null;

    const query = `SELECT * FROM disposals WHERE disposal_tx_id = ? ALLOW FILTERING`;
    const result = await this.cassandraService.client.execute(query, [txId], {
      prepare: true,
    });

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      walletAddress: row.wallet_address,
      tokenSymbol: row.token_symbol,
      disposalId: row.disposal_id,
      disposalDate: row.disposal_date,
      disposalTxId: row.disposal_tx_id,
      disposalType: row.disposal_type,
      quantity: parseFloat(row.quantity),
      proceedsPerUnit: parseFloat(row.proceeds_per_unit),
      proceedsTotal: parseFloat(row.proceeds_total),
      lotsUsed: JSON.parse(row.lots_used || "[]"),
      costBasis:
        row.cost_basis !== null && row.cost_basis !== undefined
          ? parseFloat(row.cost_basis)
          : (() => {
              // Calculate from lotsUsed if cost_basis is null
              const lots = JSON.parse(row.lots_used || "[]");
              return lots.reduce((sum, lot) => sum + (lot.costBasis || 0), 0);
            })(),
      gainLoss: parseFloat(row.gain_loss),
      isLongTerm: row.is_long_term,
      accountingMethod: row.accounting_method,
    };
  }

  /**
   * Calculate current holdings summary for a wallet
   *
   * @param {string} walletAddress - Wallet address
   * @param {string} tokenSymbol - Optional token filter
   * @returns {Object|Array} Holdings summary
   */
  async getHoldingsSummary(walletAddress, tokenSymbol = null) {
    const lots = tokenSymbol
      ? await this.getTaxLots(walletAddress, tokenSymbol, {
          includePartial: true,
        })
      : [];

    if (tokenSymbol) {
      const openLots = lots.filter((l) => l.remainingQuantity > 0);
      const totalQuantity = openLots.reduce(
        (sum, l) => sum + l.remainingQuantity,
        0,
      );
      const totalCostBasis = openLots.reduce(
        (sum, l) => sum + l.remainingQuantity * l.costBasisPerUnit,
        0,
      );

      return {
        tokenSymbol,
        totalQuantity,
        totalCostBasis,
        averageCostBasis:
          totalQuantity > 0 ? totalCostBasis / totalQuantity : 0,
        openLotsCount: openLots.length,
        oldestLotDate: openLots.length > 0 ? openLots[0].acquisitionDate : null,
      };
    }

    // Return all holdings (query summary table)
    const query = `SELECT * FROM holdings_summary WHERE wallet_address = ?`;
    const result = await this.cassandraService.client.execute(
      query,
      [walletAddress],
      {
        prepare: true,
      },
    );

    return result.rows.map((row) => ({
      tokenSymbol: row.token_symbol,
      totalQuantity: parseFloat(row.total_quantity),
      totalCostBasis: parseFloat(row.total_cost_basis),
      averageCostBasis: parseFloat(row.average_cost_basis),
      openLotsCount: row.open_lots_count,
      lastAcquisitionDate: row.last_acquisition_date,
      lastDisposalDate: row.last_disposal_date,
    }));
  }

  /**
   * Process a batch of transactions into tax lots and disposals
   * Handles ALL wallets in the transaction set, not just a single wallet.
   *
   * @param {Array} transactions - Array of unified transactions
   * @param {string|Array} walletAddresses - Wallet address(es) to process (for filtering)
   * @param {Object} priceService - Price service for cost basis lookup
   * @returns {Object} Processing results
   */
  async processTransactions(
    transactions,
    walletAddresses,
    priceService = null,
  ) {
    // Normalize walletAddresses to an array
    const wallets = Array.isArray(walletAddresses)
      ? walletAddresses
      : [walletAddresses];
    const walletSet = new Set(wallets.map((w) => w.toLowerCase()));

    const results = {
      lotsCreated: 0,
      disposalsProcessed: 0,
      duplicatesSkipped: 0,
      errors: [],
      skipped: 0,
      byWallet: {},
    };

    // Initialize per-wallet tracking
    for (const wallet of wallets) {
      results.byWallet[wallet] = {
        lotsCreated: 0,
        disposalsProcessed: 0,
        duplicatesSkipped: 0,
      };
    }

    // Sort transactions by date
    const sorted = [...transactions].sort(
      (a, b) => new Date(a.timestamp) - new Date(b.timestamp),
    );

    if (this.verbose) {
      console.log(
        `\n📊 Processing ${sorted.length} transactions for ${wallets.length} wallet(s)...`,
      );
    }

    for (const tx of sorted) {
      try {
        // Get the wallet address for this transaction
        const txWallet = tx.walletAddress || tx.ownerAddress;
        if (!txWallet || !walletSet.has(txWallet.toLowerCase())) {
          results.skipped++;
          continue;
        }

        // Skip internal transfers and non-taxable events
        if (tx.isInternalTransfer || !tx.isTaxableEvent) {
          results.skipped++;
          continue;
        }

        // Get timestamp (handle both timestamp and blockTimestamp fields)
        const txTimestamp = tx.timestamp || tx.blockTimestamp;

        // Handle DEX_SWAP specially - it's both a disposal AND acquisition
        if (tx.type === "DEX_SWAP" && tx.isSwap) {
          // DEX swaps have inputTokenSymbol (disposal) and outputTokenSymbol (acquisition)
          const inputToken = tx.inputTokenSymbol;
          const outputToken = tx.outputTokenSymbol;
          const inputAmount = tx.inputAmountHuman || 0;
          const outputAmount = tx.outputAmountHuman || 0;

          if (!inputToken || !outputToken || inputAmount <= 0) {
            if (this.verbose) {
              console.log(
                `   ⚠️ Skipping invalid DEX_SWAP: missing token info or amount`,
              );
            }
            results.skipped++;
            continue;
          }

          // Get prices for both tokens
          let inputPriceUSD = tx.inputPriceUSD || 0;
          let outputPriceUSD = tx.outputPriceUSD || 0;

          if (priceService && txTimestamp) {
            const date = new Date(txTimestamp * 1000);
            const dateStr = date.toISOString().split("T")[0];

            if (!inputPriceUSD) {
              const priceData = await priceService.getPriceWithSource(
                inputToken,
                dateStr,
              );
              inputPriceUSD = priceData?.price || 0;
            }
            if (!outputPriceUSD) {
              const priceData = await priceService.getPriceWithSource(
                outputToken,
                dateStr,
              );
              outputPriceUSD = priceData?.price || 0;
            }
          }

          // Calculate values
          const inputValueUSD = tx.inputValueUSD || inputAmount * inputPriceUSD;
          const outputValueUSD =
            tx.outputValueUSD || outputAmount * outputPriceUSD;

          // Use the higher of input or output value as fair market value
          // This is the standard tax treatment for swaps
          const fairMarketValue = Math.max(inputValueUSD, outputValueUSD);

          if (this.verbose) {
            console.log(
              `   🔄 DEX_SWAP: ${inputAmount.toFixed(4)} ${inputToken} -> ${outputAmount.toFixed(4)} ${outputToken}`,
            );
            console.log(
              `      Input value: $${inputValueUSD.toFixed(2)}, Output value: $${outputValueUSD.toFixed(2)}`,
            );
          }

          // 1. DISPOSAL of input token (use cost basis from existing lots)
          try {
            const disposalCalc = await this.calculateDisposal({
              walletAddress: txWallet,
              tokenSymbol: inputToken,
              date: txTimestamp ? new Date(txTimestamp * 1000) : new Date(),
              txId: tx.txId,
              type: "DEX_SWAP",
              quantity: inputAmount,
              proceedsPerUnit: outputValueUSD / inputAmount, // Proceeds = value of what was received
              notes: `Swap to ${outputAmount.toFixed(4)} ${outputToken}`,
            });

            const executed = await this.executeDisposal(disposalCalc);
            if (executed) {
              results.disposalsProcessed++;
              results.byWallet[txWallet].disposalsProcessed++;
              if (this.verbose) {
                console.log(
                  `      ✅ Disposal: ${inputAmount.toFixed(4)} ${inputToken}, cost basis: $${disposalCalc.totalCostBasis?.toFixed(2) || 0}`,
                );
              }
            } else {
              results.duplicatesSkipped++;
              results.byWallet[txWallet].duplicatesSkipped++;
            }
          } catch (disposalError) {
            results.errors.push({
              txId: tx.txId,
              wallet: txWallet,
              error: `Disposal: ${disposalError.message}`,
            });
          }

          // 2. ACQUISITION of output token (create new tax lot)
          // Cost basis = fair market value at time of swap (typically the output value)
          const acquisitionCostBasis = fairMarketValue / outputAmount;
          const lot = await this.createTaxLot({
            walletAddress: txWallet,
            tokenSymbol: outputToken,
            tokenProcessId: tx.outputTokenProcessId,
            date: txTimestamp ? new Date(txTimestamp * 1000) : new Date(),
            txId: `${tx.txId}_acq`, // Suffix to distinguish from disposal
            type: "DEX_SWAP_ACQUISITION",
            quantity: outputAmount,
            costBasisPerUnit: acquisitionCostBasis,
            notes: `Swap from ${inputAmount.toFixed(4)} ${inputToken}`,
          });

          if (lot) {
            results.lotsCreated++;
            results.byWallet[txWallet].lotsCreated++;
            if (this.verbose) {
              console.log(
                `      ✅ Acquisition: ${outputAmount.toFixed(4)} ${outputToken} @ $${acquisitionCostBasis.toFixed(4)}/unit`,
              );
            }
          } else {
            results.duplicatesSkipped++;
            results.byWallet[txWallet].duplicatesSkipped++;
          }

          continue; // Done with DEX_SWAP, move to next transaction
        }

        // Skip if no token symbol (for non-swap transactions)
        if (!tx.tokenSymbol) {
          results.skipped++;
          continue;
        }

        // Get price for cost basis
        let priceUSD = tx.priceUSD || 0;

        if (!priceUSD && priceService && txTimestamp) {
          const date = new Date(txTimestamp * 1000);
          const dateStr = date.toISOString().split("T")[0];
          const priceData = await priceService.getPriceWithSource(
            tx.tokenSymbol,
            dateStr,
          );
          priceUSD = priceData?.price || 0;
        }

        // Determine if acquisition or disposal based on transaction type
        const isAcquisition =
          tx.type === "RECEIVE" ||
          tx.type === "SWAP_IN" ||
          tx.type === "BRIDGE_IN" ||
          tx.type === "DISTRIBUTION" ||
          tx.type === "AIRDROP" ||
          tx.taxCategory === "INCOME";

        const isDisposal =
          tx.type === "SEND" ||
          tx.type === "SWAP_OUT" ||
          tx.type === "BRIDGE_OUT";
        // Note: DEX_SWAP is handled above

        if (isAcquisition) {
          // Acquisition - create tax lot
          const lot = await this.createTaxLot({
            walletAddress: txWallet,
            tokenSymbol: tx.tokenSymbol,
            tokenProcessId: tx.tokenId || tx.fromProcess,
            date: txTimestamp ? new Date(txTimestamp * 1000) : new Date(),
            txId: tx.txId,
            type: tx.type,
            quantity: tx.amountHuman || tx.amount || 0,
            costBasisPerUnit: priceUSD,
            notes: `From: ${tx.fromAddress || tx.fromProcess || "unknown"}`,
          });

          if (lot) {
            results.lotsCreated++;
            results.byWallet[txWallet].lotsCreated++;
          } else {
            results.duplicatesSkipped++;
            results.byWallet[txWallet].duplicatesSkipped++;
          }
        } else if (isDisposal) {
          // Disposal - calculate and execute
          try {
            const disposalCalc = await this.calculateDisposal({
              walletAddress: txWallet,
              tokenSymbol: tx.tokenSymbol,
              date: txTimestamp ? new Date(txTimestamp * 1000) : new Date(),
              txId: tx.txId,
              type: tx.type,
              quantity: tx.amountHuman || tx.amount || 0,
              proceedsPerUnit: tx.proceedsPerUnit || priceUSD,
              notes: `To: ${tx.toAddress || tx.targetProcess || "unknown"}`,
            });

            const executed = await this.executeDisposal(disposalCalc);
            if (executed) {
              results.disposalsProcessed++;
              results.byWallet[txWallet].disposalsProcessed++;
            } else {
              results.duplicatesSkipped++;
              results.byWallet[txWallet].duplicatesSkipped++;
            }
          } catch (disposalError) {
            // Log but don't fail - might be missing acquisition data
            results.errors.push({
              txId: tx.txId,
              wallet: txWallet,
              error: disposalError.message,
            });
          }
        } else {
          results.skipped++;
        }
      } catch (error) {
        results.errors.push({
          txId: tx.txId,
          error: error.message,
        });
      }
    }

    if (this.verbose) {
      console.log(`\n✅ Cost basis processing complete:`);
      console.log(`   Lots created: ${results.lotsCreated}`);
      console.log(`   Disposals processed: ${results.disposalsProcessed}`);
      console.log(`   Duplicates skipped: ${results.duplicatesSkipped}`);
      console.log(`   Skipped: ${results.skipped}`);
      console.log(`   Errors: ${results.errors.length}`);
    }

    return results;
  }

  /**
   * Calculate total gains/losses for a tax year
   * Supports single wallet or array of wallets.
   *
   * @param {string|Array} walletAddresses - Wallet address(es)
   * @param {number} taxYear - Tax year (e.g., 2025)
   * @returns {Object} Tax year summary
   */
  async getTaxYearSummary(walletAddresses, taxYear) {
    // Normalize to array
    const wallets = Array.isArray(walletAddresses)
      ? walletAddresses
      : [walletAddresses];

    const startDate = new Date(`${taxYear}-01-01T00:00:00Z`);
    const endDate = new Date(`${taxYear}-12-31T23:59:59Z`);

    // Gather disposals from all wallets
    let allDisposals = [];
    for (const wallet of wallets) {
      const disposals = await this.getDisposals(wallet, {
        startDate,
        endDate,
      });
      allDisposals.push(...disposals);
    }

    // Deduplicate by disposal_id (in case same tx appears for multiple wallets)
    const uniqueDisposals = [];
    const seenIds = new Set();
    for (const d of allDisposals) {
      if (!seenIds.has(d.disposalId)) {
        seenIds.add(d.disposalId);
        uniqueDisposals.push(d);
      }
    }

    const summary = {
      taxYear,
      walletAddresses: wallets,
      totalDisposals: uniqueDisposals.length,
      shortTermGains: 0,
      shortTermLosses: 0,
      longTermGains: 0,
      longTermLosses: 0,
      totalProceeds: 0,
      totalCostBasis: 0,
      byToken: {},
      byWallet: {},
    };

    // Initialize per-wallet tracking
    for (const wallet of wallets) {
      summary.byWallet[wallet] = {
        disposals: 0,
        gainLoss: 0,
        proceeds: 0,
      };
    }

    for (const disposal of uniqueDisposals) {
      const isGain = disposal.gainLoss >= 0;

      if (disposal.isLongTerm) {
        if (isGain) summary.longTermGains += disposal.gainLoss;
        else summary.longTermLosses += Math.abs(disposal.gainLoss);
      } else {
        if (isGain) summary.shortTermGains += disposal.gainLoss;
        else summary.shortTermLosses += Math.abs(disposal.gainLoss);
      }

      summary.totalProceeds += disposal.proceedsTotal;
      summary.totalCostBasis += disposal.lotsUsed.reduce(
        (sum, l) => sum + l.costBasis,
        0,
      );

      // Aggregate by token
      if (!summary.byToken[disposal.tokenSymbol]) {
        summary.byToken[disposal.tokenSymbol] = {
          disposals: 0,
          quantity: 0,
          proceeds: 0,
          costBasis: 0,
          gainLoss: 0,
        };
      }
      summary.byToken[disposal.tokenSymbol].disposals++;
      summary.byToken[disposal.tokenSymbol].quantity += disposal.quantity;
      summary.byToken[disposal.tokenSymbol].proceeds += disposal.proceedsTotal;
      summary.byToken[disposal.tokenSymbol].costBasis +=
        disposal.lotsUsed.reduce((sum, l) => sum + l.costBasis, 0);
      summary.byToken[disposal.tokenSymbol].gainLoss += disposal.gainLoss;

      // Aggregate by wallet
      if (summary.byWallet[disposal.walletAddress]) {
        summary.byWallet[disposal.walletAddress].disposals++;
        summary.byWallet[disposal.walletAddress].gainLoss += disposal.gainLoss;
        summary.byWallet[disposal.walletAddress].proceeds +=
          disposal.proceedsTotal;
      }
    }

    // Calculate net values
    summary.netShortTerm = summary.shortTermGains - summary.shortTermLosses;
    summary.netLongTerm = summary.longTermGains - summary.longTermLosses;
    summary.netTotal = summary.netShortTerm + summary.netLongTerm;

    return summary;
  }

  /**
   * Restore all tax lots from all existing disposals for a wallet/token
   * This is called BEFORE processing disposals to ensure all lots are available
   *
   * @param {string} walletAddress - Wallet address
   * @param {string} tokenSymbol - Token symbol (optional, restores all tokens if not provided)
   * @returns {Object} Restoration results
   */
  async restoreAllLotsFromDisposals(walletAddress, tokenSymbol = null) {
    if (!this.cassandraService) {
      throw new Error("CassandraService is required");
    }

    await this.cassandraService.useKeyspace();

    let query;
    let params;

    if (tokenSymbol) {
      // Restore lots for specific token
      query = `
        SELECT disposal_id, disposal_date, lots_used, disposal_tx_id, quantity
        FROM disposals
        WHERE wallet_address = ? AND token_symbol = ?
        ALLOW FILTERING
      `;
      params = [walletAddress, tokenSymbol];
    } else {
      // Restore lots for all tokens
      query = `
        SELECT disposal_id, disposal_date, lots_used, disposal_tx_id, quantity, token_symbol
        FROM disposals
        WHERE wallet_address = ?
        ALLOW FILTERING
      `;
      params = [walletAddress];
    }

    const result = await this.cassandraService.client.execute(query, params, {
      prepare: true,
    });

    let restoredCount = 0;
    let recreatedCount = 0;
    const restoredLots = new Set();

    for (const row of result.rows) {
      try {
        const lotsUsed = JSON.parse(row.lots_used || "[]");
        const rowTokenSymbol = tokenSymbol || row.token_symbol;

        for (const lotUsage of lotsUsed) {
          const lots = await this.getTaxLots(walletAddress, rowTokenSymbol, {
            includePartial: true,
          });
          const lot = lots.find((l) => l.lotId === lotUsage.lotId);

          if (lot) {
            // Restore the quantity that was consumed
            const quantityBefore = lot.remainingQuantity;
            lot.remainingQuantity += lotUsage.quantity;

            // Ensure remainingQuantity doesn't exceed originalQuantity
            if (lot.remainingQuantity > lot.originalQuantity) {
              lot.remainingQuantity = lot.originalQuantity;
            }

            // Update status
            if (lot.remainingQuantity > 0.000001) {
              if (lot.remainingQuantity >= lot.originalQuantity - 0.000001) {
                lot.status = LOT_STATUS.OPEN;
              } else {
                lot.status = LOT_STATUS.PARTIAL;
              }
            } else {
              lot.status = LOT_STATUS.CLOSED;
            }

            lot.updatedAt = new Date();
            await this.saveTaxLot(lot);
            restoredCount++;
            restoredLots.add(lotUsage.lotId);
          } else {
            // Lot not found - recreate it
            let acquisitionDate = lotUsage.acquisitionDate;
            if (acquisitionDate instanceof Date) {
              // Already a Date object
            } else if (typeof acquisitionDate === "number") {
              acquisitionDate = new Date(
                acquisitionDate > 1e12
                  ? acquisitionDate
                  : acquisitionDate * 1000,
              );
            } else if (typeof acquisitionDate === "string") {
              acquisitionDate = new Date(acquisitionDate);
            } else {
              acquisitionDate =
                row.disposal_date instanceof Date
                  ? row.disposal_date
                  : new Date(row.disposal_date);
            }

            const recreatedLot = {
              walletAddress,
              tokenSymbol: rowTokenSymbol,
              lotId: lotUsage.lotId,
              acquisitionDate,
              acquisitionTxId: `${row.disposal_tx_id}-airdrop-recreated`,
              acquisitionType: "AIRDROP",
              originalQuantity: lotUsage.quantity,
              remainingQuantity: lotUsage.quantity,
              costBasisPerUnit: lotUsage.costBasisPerUnit || 0,
              costBasisTotal: lotUsage.costBasis || 0,
              tokenProcessId: null,
              status: LOT_STATUS.OPEN,
              holdingPeriodStart: acquisitionDate,
              notes: `Recreated from disposal ${row.disposal_id.substring(
                0,
                8,
              )}... (was created via airdrop backfill)`,
              createdAt: acquisitionDate,
              updatedAt: new Date(),
            };

            // Check if lot already exists (might have been recreated already)
            const existingLots = await this.getTaxLots(
              walletAddress,
              rowTokenSymbol,
              { includePartial: true },
            );
            const lotExists = existingLots.some(
              (l) => l.lotId === lotUsage.lotId,
            );

            if (!lotExists) {
              await this.saveTaxLot(recreatedLot);
              // Also save to originals table for future restorations
              await this.saveTaxLotOriginal(recreatedLot);
              recreatedCount++;
              restoredLots.add(lotUsage.lotId);
            }
          }
        }
      } catch (error) {
        if (this.verbose) {
          console.log(
            `⚠️  Error restoring lots for disposal ${row.disposal_id.substring(
              0,
              8,
            )}...: ${error.message}`,
          );
        }
      }
    }

    // Clear cache after restoring all lots
    if (tokenSymbol) {
      this.clearCache(walletAddress, tokenSymbol);
    } else {
      // Clear cache for all tokens
      const allTokens = new Set();
      for (const row of result.rows) {
        allTokens.add(row.token_symbol);
      }
      for (const token of allTokens) {
        this.clearCache(walletAddress, token);
      }
    }

    if (this.verbose) {
      console.log(
        `   ✅ Restored ${restoredCount} lots, recreated ${recreatedCount} lots for ${walletAddress.substring(
          0,
          12,
        )}...`,
      );
    }

    return {
      restoredCount,
      recreatedCount,
      totalLots: restoredCount + recreatedCount,
    };
  }

  /**
   * Clear all duplicate disposals from the database
   * Keeps only the first disposal per (wallet, token, tx_id) combination.
   *
   * @param {string} walletAddress - Wallet to clean (optional, cleans all if not provided)
   * @returns {Object} Cleanup results
   */
  async cleanupDuplicateDisposals(walletAddress = null) {
    const results = {
      totalScanned: 0,
      duplicatesRemoved: 0,
      uniqueKept: 0,
    };

    let query;
    let params;

    if (walletAddress) {
      query = `SELECT * FROM disposals WHERE wallet_address = ? ALLOW FILTERING`;
      params = [walletAddress];
    } else {
      // This is expensive but necessary for cleanup
      query = `SELECT * FROM disposals`;
      params = [];
    }

    const result = await this.cassandraService.client.execute(query, params, {
      prepare: true,
    });

    // Group by (wallet, token, tx_id)
    const groups = new Map();
    for (const row of result.rows) {
      const key = `${row.wallet_address}:${row.token_symbol}:${row.disposal_tx_id}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(row);
      results.totalScanned++;
    }

    // For each group, keep only the first (by created_at) and delete the rest
    for (const [key, disposals] of groups) {
      if (disposals.length > 1) {
        // Sort by created_at to keep the earliest
        disposals.sort((a, b) => a.created_at - b.created_at);

        // Delete all but the first
        for (let i = 1; i < disposals.length; i++) {
          const d = disposals[i];
          const deleteQuery = `
            DELETE FROM disposals
            WHERE wallet_address = ? AND token_symbol = ? AND disposal_date = ? AND disposal_id = ?
          `;
          await this.cassandraService.client.execute(
            deleteQuery,
            [d.wallet_address, d.token_symbol, d.disposal_date, d.disposal_id],
            { prepare: true },
          );
          results.duplicatesRemoved++;
        }
        results.uniqueKept++;
      } else {
        results.uniqueKept++;
      }
    }

    if (this.verbose) {
      console.log(`\n🧹 Cleanup complete:`);
      console.log(`   Scanned: ${results.totalScanned}`);
      console.log(`   Duplicates removed: ${results.duplicatesRemoved}`);
      console.log(`   Unique kept: ${results.uniqueKept}`);
    }

    return results;
  }
}

module.exports = {
  CostBasisService,
  ACCOUNTING_METHODS,
  LOT_STATUS,
  COST_BASIS_SCHEMA,
};
