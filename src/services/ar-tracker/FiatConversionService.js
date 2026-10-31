/**
 * Fiat Conversion Service
 *
 * Fetches and stores historical USD to other fiat currency conversion rates.
 * Enables converting individual transaction values from USD to any supported currency.
 *
 * Features:
 * - Historical data back to Arweave mainnet launch (June 2018)
 * - Daily exchange rates (close/average)
 * - Incremental updates for efficiency
 * - Quick lookups for transaction-level conversion
 *
 * Data Source: Frankfurter API (European Central Bank rates)
 * - Free, no API key required
 * - Daily rates updated around 16:00 CET
 * - Covers 30+ currencies
 *
 * @module services/ar-tracker/FiatConversionService
 * 
 * Adapted for ao-tax-tracker-server integration.
 * Uses ao_price_data keyspace for storage.
 */

const cassandra = require("cassandra-driver");
const axios = require("axios");

// Schema for daily exchange rates
const EXCHANGE_RATES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS fiat_exchange_rates (
    rate_date TEXT,
    base_currency TEXT,
    target_currency TEXT,
    rate DECIMAL,
    created_at TIMESTAMP,
    PRIMARY KEY ((base_currency, target_currency), rate_date)
  ) WITH CLUSTERING ORDER BY (rate_date DESC);
`;

// Schema for indexer state
const FIAT_INDEXER_STATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS fiat_indexer_state (
    indexer_name TEXT PRIMARY KEY,
    last_indexed_date TEXT,
    last_run_at TIMESTAMP,
    total_rates_indexed BIGINT,
    status TEXT
  );
`;

// Supported currencies (ECB rates via Frankfurter)
const SUPPORTED_CURRENCIES = [
  "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "CNY", "HKD", "NZD", "SEK",
  "KRW", "SGD", "NOK", "MXN", "INR", "RUB", "ZAR", "TRY", "BRL", "TWD",
  "DKK", "PLN", "THB", "IDR", "HUF", "CZK", "ILS", "CLP", "PHP", "AED",
  "MYR", "RON", "BGN", "ISK", "HRK"
];

// Common currencies most users will need
const PRIORITY_CURRENCIES = [
  "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "CNY", "INR", "KRW", "BRL"
];

// Arweave mainnet launch date
const ARWEAVE_GENESIS_DATE = "2018-06-08";

class FiatConversionService {
  constructor(options = {}) {
    this.client = null;
    this.isConnected = false;
    this.keyspace = options.keyspace || "ao_price_data";
    this.contactPoints = options.contactPoints || ["localhost"];
    this.localDataCenter = options.localDataCenter || "datacenter1";
    this.verbose = options.verbose || false;

    // API endpoint
    this.apiBaseUrl = "https://api.frankfurter.app";

    // Rate limiting
    this.rateLimitDelay = options.rateLimitDelay || 500;

    // Cache for quick lookups
    this.rateCache = new Map(); // "USD:EUR:2024-01-15" -> rate

    // Statistics
    this.stats = {
      ratesIndexed: 0,
      apiCalls: 0,
      cacheHits: 0,
      errors: 0,
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
        console.log(`✅ FiatConversionService connected to ${this.keyspace}`);
      }
    } catch (error) {
      console.error(`❌ FiatConversionService connection failed: ${error.message}`);
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
      await this.client.execute(EXCHANGE_RATES_SCHEMA);
      await this.client.execute(FIAT_INDEXER_STATE_SCHEMA);

      if (this.verbose) {
        console.log("   ✅ Fiat conversion schema initialized");
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

  // ============================================================
  // EXCHANGE RATE FETCHING
  // ============================================================

  /**
   * Fetch exchange rates for a specific date
   * @param {string} date - Date in YYYY-MM-DD format
   * @returns {Object} - { EUR: 0.92, GBP: 0.79, ... }
   */
  async fetchRatesForDate(date) {
    try {
      const url = `${this.apiBaseUrl}/${date}?from=USD`;
      const response = await axios.get(url, { timeout: 15000 });

      this.stats.apiCalls++;

      if (response.data && response.data.rates) {
        return {
          date: response.data.date,
          base: response.data.base || "USD",
          rates: response.data.rates,
        };
      }

      return null;
    } catch (error) {
      // Weekend/holiday - no rate available
      if (error.response?.status === 404) {
        return null;
      }
      
      this.stats.errors++;
      if (this.verbose) {
        console.warn(`   ⚠️ Error fetching rates for ${date}: ${error.message}`);
      }
      return null;
    }
  }

  /**
   * Fetch exchange rates for a date range
   * Uses the time series endpoint for efficiency
   * @param {string} startDate - Start date YYYY-MM-DD
   * @param {string} endDate - End date YYYY-MM-DD
   * @returns {Object} - { "2024-01-15": { EUR: 0.92, ... }, ... }
   */
  async fetchRatesForRange(startDate, endDate) {
    try {
      const url = `${this.apiBaseUrl}/${startDate}..${endDate}?from=USD`;
      const response = await axios.get(url, { timeout: 60000 });

      this.stats.apiCalls++;

      if (response.data && response.data.rates) {
        return response.data.rates;
      }

      return {};
    } catch (error) {
      this.stats.errors++;
      if (this.verbose) {
        console.warn(`   ⚠️ Error fetching range ${startDate} to ${endDate}: ${error.message}`);
      }
      return {};
    }
  }

  /**
   * Get the latest available rates
   */
  async fetchLatestRates() {
    try {
      const url = `${this.apiBaseUrl}/latest?from=USD`;
      const response = await axios.get(url, { timeout: 15000 });

      this.stats.apiCalls++;

      if (response.data && response.data.rates) {
        return {
          date: response.data.date,
          rates: response.data.rates,
        };
      }

      return null;
    } catch (error) {
      this.stats.errors++;
      return null;
    }
  }

  // ============================================================
  // RATE STORAGE
  // ============================================================

  /**
   * Save exchange rates for a date
   * @param {string} date - Date YYYY-MM-DD
   * @param {Object} rates - { EUR: 0.92, GBP: 0.79, ... }
   */
  async saveRatesForDate(date, rates) {
    if (!this.isConnected) await this.connect();

    const query = `
      INSERT INTO fiat_exchange_rates (
        rate_date, base_currency, target_currency, rate, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `;

    for (const [currency, rate] of Object.entries(rates)) {
      try {
        await this.client.execute(
          query,
          [date, "USD", currency, rate, new Date()],
          { prepare: true }
        );
        this.stats.ratesIndexed++;
      } catch (error) {
        this.stats.errors++;
        if (this.verbose) {
          console.warn(`   ⚠️ Error saving rate USD/${currency} for ${date}: ${error.message}`);
        }
      }
    }
  }

  /**
   * Save rates in batch (more efficient)
   * @param {Object} ratesByDate - { "2024-01-15": { EUR: 0.92, ... }, ... }
   */
  async saveRatesBatch(ratesByDate) {
    if (!this.isConnected) await this.connect();

    const query = `
      INSERT INTO fiat_exchange_rates (
        rate_date, base_currency, target_currency, rate, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `;

    const now = new Date();

    for (const [date, rates] of Object.entries(ratesByDate)) {
      for (const [currency, rate] of Object.entries(rates)) {
        try {
          await this.client.execute(
            query,
            [date, "USD", currency, rate, now],
            { prepare: true }
          );
          this.stats.ratesIndexed++;
        } catch (error) {
          this.stats.errors++;
        }
      }
    }
  }

  // ============================================================
  // RATE LOOKUP & CONVERSION
  // ============================================================

  /**
   * Get exchange rate for a specific date and currency
   * Uses cache for efficiency
   * @param {string} targetCurrency - e.g., "EUR", "GBP"
   * @param {string} date - Date YYYY-MM-DD
   * @returns {number|null} - Exchange rate or null
   */
  async getRate(targetCurrency, date) {
    if (!this.isConnected) await this.connect();

    const dateStr = typeof date === "string" 
      ? date.split("T")[0] 
      : date.toISOString().split("T")[0];

    // Check cache
    const cacheKey = `USD:${targetCurrency}:${dateStr}`;
    if (this.rateCache.has(cacheKey)) {
      this.stats.cacheHits++;
      return this.rateCache.get(cacheKey);
    }

    try {
      // Try exact date
      const query = `
        SELECT rate FROM fiat_exchange_rates
        WHERE base_currency = ? AND target_currency = ? AND rate_date = ?
      `;

      const result = await this.client.execute(
        query,
        ["USD", targetCurrency, dateStr],
        { prepare: true }
      );

      if (result.rows.length > 0) {
        const rate = parseFloat(result.rows[0].rate.toString());
        this.rateCache.set(cacheKey, rate);
        return rate;
      }

      // Forward-fill: get most recent rate before this date
      const ffQuery = `
        SELECT rate, rate_date FROM fiat_exchange_rates
        WHERE base_currency = ? AND target_currency = ? AND rate_date < ?
        ORDER BY rate_date DESC
        LIMIT 1
        ALLOW FILTERING
      `;

      const ffResult = await this.client.execute(
        ffQuery,
        ["USD", targetCurrency, dateStr],
        { prepare: true }
      );

      if (ffResult.rows.length > 0) {
        const rate = parseFloat(ffResult.rows[0].rate.toString());
        this.rateCache.set(cacheKey, rate);
        return rate;
      }

      return null;
    } catch (error) {
      if (this.verbose) {
        console.warn(`   ⚠️ Error getting rate for ${targetCurrency} on ${dateStr}: ${error.message}`);
      }
      return null;
    }
  }

  /**
   * Convert USD amount to target currency for a specific date
   * @param {number} usdAmount - Amount in USD
   * @param {string} targetCurrency - e.g., "EUR", "GBP"
   * @param {string|Date} date - Transaction date
   * @returns {Object} - { amount, currency, rate, originalUSD }
   */
  async convertFromUSD(usdAmount, targetCurrency, date) {
    if (targetCurrency === "USD") {
      return {
        amount: usdAmount,
        currency: "USD",
        rate: 1.0,
        originalUSD: usdAmount,
      };
    }

    const rate = await this.getRate(targetCurrency, date);

    if (rate === null) {
      return null;
    }

    return {
      amount: usdAmount * rate,
      currency: targetCurrency,
      rate: rate,
      originalUSD: usdAmount,
    };
  }

  /**
   * Convert amount from target currency back to USD
   * @param {number} amount - Amount in target currency
   * @param {string} fromCurrency - e.g., "EUR", "GBP"
   * @param {string|Date} date - Transaction date
   * @returns {number|null} - USD amount or null
   */
  async convertToUSD(amount, fromCurrency, date) {
    if (fromCurrency === "USD") {
      return amount;
    }

    const rate = await this.getRate(fromCurrency, date);

    if (rate === null || rate === 0) {
      return null;
    }

    return amount / rate;
  }

  /**
   * Batch convert multiple transactions
   * @param {Array} transactions - Array of { usdAmount, date }
   * @param {string} targetCurrency - Target currency
   * @returns {Array} - Array of converted amounts
   */
  async batchConvert(transactions, targetCurrency) {
    const results = [];

    for (const tx of transactions) {
      const converted = await this.convertFromUSD(
        tx.usdAmount,
        targetCurrency,
        tx.date
      );
      results.push({
        ...tx,
        converted,
      });
    }

    return results;
  }

  // ============================================================
  // INDEXER STATE MANAGEMENT
  // ============================================================

  /**
   * Get indexer state
   */
  async getIndexerState() {
    if (!this.isConnected) await this.connect();

    try {
      const query = `SELECT * FROM fiat_indexer_state WHERE indexer_name = ?`;
      const result = await this.client.execute(query, ["fiat_rates"], {
        prepare: true,
      });

      if (result.rows.length > 0) {
        return {
          lastIndexedDate: result.rows[0].last_indexed_date || ARWEAVE_GENESIS_DATE,
          totalRatesIndexed: result.rows[0].total_rates_indexed || 0,
          status: result.rows[0].status || "idle",
        };
      }

      return {
        lastIndexedDate: ARWEAVE_GENESIS_DATE,
        totalRatesIndexed: 0,
        status: "new",
      };
    } catch (error) {
      return {
        lastIndexedDate: ARWEAVE_GENESIS_DATE,
        totalRatesIndexed: 0,
        status: "error",
      };
    }
  }

  /**
   * Update indexer state
   */
  async updateIndexerState(state) {
    if (!this.isConnected) return;

    try {
      const query = `
        INSERT INTO fiat_indexer_state (
          indexer_name, last_indexed_date, last_run_at, total_rates_indexed, status
        ) VALUES (?, ?, ?, ?, ?)
      `;

      await this.client.execute(
        query,
        [
          "fiat_rates",
          state.lastIndexedDate,
          new Date(),
          state.totalRatesIndexed,
          state.status,
        ],
        { prepare: true }
      );
    } catch (error) {
      console.warn(`   ⚠️ Error updating indexer state: ${error.message}`);
    }
  }

  // ============================================================
  // FULL INDEXING
  // ============================================================

  /**
   * Run full historical index from Arweave genesis
   * @param {Object} options - { forceReindex, endDate }
   */
  async runFullIndex(options = {}) {
    const { forceReindex = false } = options;

    console.log("🚀 Starting Fiat Exchange Rate Indexing...\n");

    await this.connect();

    const state = await this.getIndexerState();
    const startDate = forceReindex ? ARWEAVE_GENESIS_DATE : state.lastIndexedDate;

    // Get today's date
    const today = new Date().toISOString().split("T")[0];

    console.log(`📊 Indexing rates from ${startDate} to ${today}`);
    console.log(`   Previously indexed: ${state.totalRatesIndexed} rates\n`);

    await this.updateIndexerState({
      ...state,
      status: "running",
    });

    let lastDate = startDate;
    let totalNewRates = 0;

    try {
      // Frankfurter API supports max ~10 years per request
      // Break into yearly chunks for reliability
      let currentStart = startDate;
      const endDate = today;

      while (currentStart < endDate) {
        // Calculate chunk end (1 year or end date, whichever is sooner)
        const chunkEndDate = new Date(currentStart);
        chunkEndDate.setFullYear(chunkEndDate.getFullYear() + 1);
        const chunkEnd = chunkEndDate.toISOString().split("T")[0];
        const actualEnd = chunkEnd < endDate ? chunkEnd : endDate;

        if (this.verbose) {
          console.log(`   📅 Fetching ${currentStart} to ${actualEnd}...`);
        }

        const rates = await this.fetchRatesForRange(currentStart, actualEnd);
        const dateCount = Object.keys(rates).length;

        if (dateCount > 0) {
          await this.saveRatesBatch(rates);
          totalNewRates += dateCount * Object.keys(rates[Object.keys(rates)[0]] || {}).length;

          // Track last date
          const dates = Object.keys(rates).sort();
          lastDate = dates[dates.length - 1];

          if (this.verbose) {
            console.log(`   ✅ Saved rates for ${dateCount} days`);
          }
        }

        // Move to next chunk
        currentStart = actualEnd;

        // Rate limit
        await this.sleep(this.rateLimitDelay);
      }

      // Update state
      await this.updateIndexerState({
        lastIndexedDate: lastDate,
        totalRatesIndexed: state.totalRatesIndexed + totalNewRates,
        status: "completed",
      });

      // Summary
      console.log("\n" + "=".repeat(60));
      console.log("FIAT EXCHANGE RATE INDEXING SUMMARY");
      console.log("=".repeat(60));
      console.log(`Date range: ${startDate} to ${lastDate}`);
      console.log(`API calls: ${this.stats.apiCalls}`);
      console.log(`Rates indexed: ${this.stats.ratesIndexed}`);
      console.log(`Cache hits: ${this.stats.cacheHits}`);
      console.log(`Errors: ${this.stats.errors}`);
      console.log();

      return {
        success: true,
        ratesIndexed: this.stats.ratesIndexed,
        lastDate,
      };
    } catch (error) {
      console.error(`\n❌ Indexing failed: ${error.message}`);

      await this.updateIndexerState({
        lastIndexedDate: lastDate,
        totalRatesIndexed: state.totalRatesIndexed + totalNewRates,
        status: "error",
      });

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Run incremental update (for daily cron)
   */
  async runIncrementalUpdate() {
    return this.runFullIndex({ forceReindex: false });
  }

  // ============================================================
  // UTILITY METHODS
  // ============================================================

  /**
   * Get list of supported currencies
   */
  getSupportedCurrencies() {
    return [...SUPPORTED_CURRENCIES];
  }

  /**
   * Get priority currencies (most commonly used)
   */
  getPriorityCurrencies() {
    return [...PRIORITY_CURRENCIES];
  }

  /**
   * Check if a currency is supported
   */
  isCurrencySupported(currency) {
    return SUPPORTED_CURRENCIES.includes(currency.toUpperCase());
  }

  /**
   * Get date range of available rates
   */
  async getAvailableDateRange() {
    if (!this.isConnected) await this.connect();

    try {
      // Get min/max dates for EUR (always present)
      const query = `
        SELECT MIN(rate_date) as min_date, MAX(rate_date) as max_date
        FROM fiat_exchange_rates
        WHERE base_currency = 'USD' AND target_currency = 'EUR'
        ALLOW FILTERING
      `;

      const result = await this.client.execute(query);

      if (result.rows.length > 0) {
        return {
          firstDate: result.rows[0].min_date,
          lastDate: result.rows[0].max_date,
        };
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.rateCache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return {
      size: this.rateCache.size,
      hits: this.stats.cacheHits,
    };
  }
}

module.exports = {
  FiatConversionService,
  SUPPORTED_CURRENCIES,
  PRIORITY_CURRENCIES,
  ARWEAVE_GENESIS_DATE,
};

