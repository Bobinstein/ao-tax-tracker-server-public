/**
 * Price Service
 *
 * Fetches historical token prices from multiple sources:
 * 1. CoinGecko (AR, AO, ARIO) - most reliable external source
 * 2. Server daily_prices table - pre-indexed prices
 * 3. DEX swap index (dex_token_prices) - comprehensive on-chain prices
 * 4. Forward-fill - most recent prior price (until next trade)
 *
 * Price Priority Order:
 * 1. CoinGecko - most reliable for major tokens (AR, AO, ARIO)
 * 2. Permaswap-AO - direct from pool reserves
 * 3. Permaswap-GQL - from historical swap transactions
 * 4. DEX Index - all ecosystem swaps (forward-filled)
 * 5. Forward-fill from daily_prices
 *
 * For tokens without market prices, returns null (valued at $0 for tax purposes).
 *
 * @module src/services/ar-tracker/PriceService
 */

const cassandra = require("cassandra-driver");

// Token to CoinGecko ID mapping (tokens with CEX listings)
const TOKEN_COINGECKO_MAP = {
  AR: "arweave",
  wAR: "arweave", // wAR uses AR price
  AO: "ao-computer",
  ARIO: "ar-io",
  PI: null, // No CoinGecko, uses DEX price
  PIXL: null,
  USDA: null, // Stablecoin, assume $1
};

// Stablecoins always $1
const STABLECOINS = ["USDA", "wUSDC", "USDC", "vUSDC"];

// Token symbol to process ID mapping for DEX lookups
const TOKEN_PROCESS_IDS = {
  wAR: "xU9zFkq3X2ZQ6olwNVvr1vUWIjc3kXTWr7xKQD6dh10",
  wUSDC: "7zH9dlMNoxprab9loshv3Y7WG45DOny_Vrq9KrXObdQ",
  AO: "0syT13r0s0tgPmIed95bJnuSqaD29HQNN8D3ElLSrsc",
  USDA: "FBt9A5GA_KXMMSxA2DJ0xZbAq8sLLU2ak-YJe9zDvg8",
  ARIO: "qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE",
  PI: "4hXj_E-5fAKmo4E8KjgQvuDJKAFk9P2grhycVmISDLs",
  PIXL: "DM3FoZUq_yebASPhgd8pEIRIzDW6muXEhxz5-JwbZwo",
  TRUNK: "OT9qTE2467gcozb2g8R6D6N3nQS94ENcaAIJfUzHCww",
  TRUNK2: "wOrb8b_V8QixWyXZub48Ki5B6OIDyf_p1ngoonsaRpQ",
  EXP: "aYrCboXVSl1AXL9gPFe3tfRxRf0ZmkOXH65mKT0HHZw",
  KARD: "1PIaQp_wij0H8Ykx-LuQEUqXQndryycWRjCRvV3R8lI",
  LLAMA: "pazXumQI-HPH7iFGfTC-4_7biSnqz_U67oFAGry5zUY",
  vAR: "y-p7CPhs6JMUStAuE4KeTnMXN7qYBvEi2hiBFk8ZhjM",
  qAR: "NG-0lVX882MG5nhARrSzyprEK6ejonHpdUmaaMPsHE8",
};

// Reverse mapping: process ID -> symbol
const PROCESS_ID_TO_SYMBOL = Object.fromEntries(
  Object.entries(TOKEN_PROCESS_IDS).map(([k, v]) => [v, k]),
);

// Price source priority order (matching server)
const PRICE_SOURCES = [
  "coingecko",
  "yahoo", // Historical AR prices beyond CoinGecko's 365-day limit
  "permaswap-AO",
  "permaswap-GQL",
  "permaswap",
];

// Anchor tokens for USD conversion
const ANCHOR_TOKENS = {
  wAR: "xU9zFkq3X2ZQ6olwNVvr1vUWIjc3kXTWr7xKQD6dh10",
  wUSDC: "7zH9dlMNoxprab9loshv3Y7WG45DOny_Vrq9KrXObdQ",
  USDA: "FBt9A5GA_KXMMSxA2DJ0xZbAq8sLLU2ak-YJe9zDvg8",
};

class PriceService {
  constructor(options = {}) {
    this.client = null;
    this.isConnected = false;
    this.keyspace = options.keyspace || "ao_price_data";
    this.contactPoints = options.contactPoints || ["localhost"];
    this.localDataCenter = options.localDataCenter || "datacenter1";
    this.cache = new Map(); // date:symbol -> price
    this.dexPriceCache = new Map(); // date:processId -> price
    this.verbose = options.verbose || false;

    // Cassandra service for block timestamp lookups
    this.cassandraService = options.cassandraService || null;

    // DEX market indexer for price path finding
    this.dexMarketIndexer = options.dexMarketIndexer || null;

    // Cache for DEX pool rates
    this.poolRateCache = new Map(); // poolId:date -> rate

    // Enable DEX price lookups (from dex_token_prices table)
    this.useDexPrices = options.useDexPrices !== false;
  }

  /**
   * Connect to Cassandra
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

      if (this.verbose) {
        console.log(`✅ PriceService connected to ${this.keyspace}`);
      }
    } catch (error) {
      console.warn(`⚠️ PriceService failed to connect: ${error.message}`);
      this.isConnected = false;
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
   * Parse a BigDecimal or numeric value from Cassandra
   * Handles corrupted BigDecimal values with proper fallbacks
   * @param {any} priceUsd - Price value from Cassandra
   * @returns {number|null} Parsed price or null if unparseable
   */
  parsePriceValue(priceUsd) {
    if (priceUsd === null || priceUsd === undefined) {
      return null;
    }

    try {
      // Handle BigDecimal values directly
      if (priceUsd.constructor && priceUsd.constructor.name === "BigDecimal") {
        try {
          return parseFloat(priceUsd.toString());
        } catch (e) {
          // If toString fails, try to reconstruct from internal representation
          const intVal = priceUsd._intVal;
          let scale = priceUsd._scale;

          // If scale is corrupted (too large), use a reasonable default
          if (scale > 1000 || scale < -1000) {
            if (this.verbose) {
              console.log(
                `⚠️  Corrupted scale detected: ${scale}, using default scale of 6`,
              );
            }
            scale = 6;

            // Try to extract a reasonable price from corrupted data
            if (intVal && typeof intVal.toString === "function") {
              const intStr = intVal.toString();
              if (intStr.length > 0) {
                const rawPrice = parseInt(intStr) / Math.pow(10, 6);
                if (rawPrice > 0 && rawPrice < 10000) {
                  // Reasonable price range
                  return rawPrice;
                }
              }
            }
          }

          if (intVal && typeof intVal.toString === "function") {
            const intStr = intVal.toString();
            // Handle negative scale (which indicates the number is very large)
            if (scale < 0) {
              const zeros = "0".repeat(Math.abs(scale));
              const decimalStr = intStr + zeros;
              return parseFloat(decimalStr);
            } else {
              // For positive scale, insert decimal point
              if (intStr.length <= scale) {
                const paddedStr =
                  "0".repeat(scale - intStr.length + 1) + intStr;
                const decimalStr =
                  paddedStr.slice(0, -scale) + "." + paddedStr.slice(-scale);
                return parseFloat(decimalStr);
              } else {
                const decimalStr =
                  intStr.slice(0, -scale) + "." + intStr.slice(-scale);
                return parseFloat(decimalStr);
              }
            }
          }
          return null;
        }
      } else {
        // Handle string or number values
        return parseFloat(priceUsd.toString());
      }
    } catch (error) {
      if (this.verbose) {
        console.warn(`⚠️  Error parsing price value: ${error.message}`);
      }
      return null;
    }
  }

  /**
   * Get price for a token on a specific date with full priority ordering
   * Matches server implementation for consistency
   * @param {string} symbol - Token symbol (AR, AO, ARIO, etc.)
   * @param {string|Date} date - Date string (YYYY-MM-DD) or Date object
   * @returns {number|null} - Price in USD or null if not available
   */
  async getPrice(symbol, date) {
    // Normalize date to YYYY-MM-DD string
    const dateStr =
      typeof date === "string"
        ? date.split("T")[0]
        : date.toISOString().split("T")[0];

    // Check stablecoins first
    if (STABLECOINS.includes(symbol)) {
      return 1.0;
    }

    // Check cache
    const cacheKey = `${dateStr}:${symbol}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    // Map token to lookup symbol (wAR -> AR)
    const lookupSymbol = symbol === "wAR" ? "AR" : symbol;

    // Try to fetch from Cassandra
    if (!this.isConnected) {
      await this.connect();
    }

    if (!this.isConnected) {
      return null;
    }

    try {
      // Try each price source in priority order (matching server)
      for (const source of PRICE_SOURCES) {
        const query = `
          SELECT price_usd, data_source
          FROM daily_prices
          WHERE date = ? AND token_symbol = ? AND data_source = ?
          ALLOW FILTERING
        `;

        const result = await this.client.execute(
          query,
          [dateStr, lookupSymbol, source],
          { prepare: true },
        );

        if (result.rows.length > 0) {
          const price = this.parsePriceValue(result.rows[0].price_usd);
          if (price !== null && !isNaN(price) && price > 0) {
            this.cache.set(cacheKey, price);

            if (this.verbose) {
              console.log(
                `   💰 ${symbol} on ${dateStr}: $${price.toFixed(
                  4,
                )} (${source})`,
              );
            }

            return price;
          }
        }
      }

      // No exact date price found - try DEX index (with forward-fill)
      if (this.useDexPrices) {
        const dexPrice = await this.getDexPrice(symbol, dateStr);
        if (dexPrice !== null) {
          this.cache.set(cacheKey, dexPrice.priceUSD);

          if (this.verbose) {
            const ffNote = dexPrice.isForwardFilled
              ? ` (forward-filled from ${dexPrice.forwardFilledFrom})`
              : "";
            console.log(
              `   💰 ${symbol} on ${dateStr}: $${dexPrice.priceUSD.toFixed(
                4,
              )} (DEX${ffNote})`,
            );
          }

          return dexPrice.priceUSD;
        }
      }

      // Try forward-fill from daily_prices (legacy)
      const forwardFillPrice = await this.getForwardFillPrice(
        lookupSymbol,
        dateStr,
      );
      if (forwardFillPrice !== null) {
        this.cache.set(cacheKey, forwardFillPrice.price);

        if (this.verbose) {
          console.log(
            `   💰 ${symbol} on ${dateStr}: $${forwardFillPrice.price.toFixed(
              4,
            )} (${forwardFillPrice.source})`,
          );
        }

        return forwardFillPrice.price;
      }

      // No price found - cache null
      this.cache.set(cacheKey, null);
      return null;
    } catch (error) {
      if (this.verbose) {
        console.warn(
          `   ⚠️ Error fetching price for ${symbol} on ${dateStr}: ${error.message}`,
        );
      }
      return null;
    }
  }

  /**
   * Get the most recent prior price for forward-filling
   * @param {string} tokenSymbol - Token symbol
   * @param {string} date - Date string YYYY-MM-DD
   * @returns {Object|null} - { price, source } or null
   */
  async getForwardFillPrice(tokenSymbol, date) {
    try {
      const query = `
        SELECT date, price_usd, data_source
        FROM daily_prices
        WHERE token_symbol = ? AND date < ?
        ALLOW FILTERING
      `;

      const result = await this.client.execute(query, [tokenSymbol, date], {
        prepare: true,
      });

      if (result.rows.length > 0) {
        // Sort by date descending to get most recent
        const sortedRows = result.rows.sort((a, b) => {
          return b.date.localeCompare(a.date);
        });

        const mostRecent = sortedRows[0];
        const price = this.parsePriceValue(mostRecent.price_usd);

        if (price !== null && !isNaN(price) && price > 0) {
          return {
            price,
            source: `${mostRecent.data_source} (forward-filled from ${mostRecent.date})`,
          };
        }
      }

      return null;
    } catch (error) {
      if (this.verbose) {
        console.warn(
          `   ⚠️ Error in forward-fill for ${tokenSymbol}: ${error.message}`,
        );
      }
      return null;
    }
  }

  // ============================================================
  // DEX PRICE INDEX METHODS (from dex_token_prices table)
  // ============================================================

  /**
   * Get token process ID from symbol
   * @param {string} symbol - Token symbol
   * @returns {string|null} - Process ID or null
   */
  getProcessIdFromSymbol(symbol) {
    return TOKEN_PROCESS_IDS[symbol] || null;
  }

  /**
   * Get token symbol from process ID
   * @param {string} processId - Token process ID
   * @returns {string|null} - Symbol or null
   */
  getSymbolFromProcessId(processId) {
    return PROCESS_ID_TO_SYMBOL[processId] || null;
  }

  /**
   * Get price from DEX index with forward-fill support
   * Queries the dex_token_prices table populated by DEXPriceIndexer
   * @param {string} symbol - Token symbol (e.g., "TRUNK2", "EXP")
   * @param {string} date - Date string YYYY-MM-DD
   * @returns {Object|null} - { priceUSD, priceInWar, source, isForwardFilled, forwardFilledFrom }
   */
  async getDexPrice(symbol, date) {
    const processId = this.getProcessIdFromSymbol(symbol);
    if (!processId) {
      // Try using symbol as process ID directly
      if (symbol && symbol.length === 43) {
        return this.getDexPriceByProcessId(symbol, date);
      }
      return null;
    }

    return this.getDexPriceByProcessId(processId, date);
  }

  /**
   * Get DEX price by process ID with forward-fill
   * @param {string} processId - Token process ID
   * @param {string} date - Date string YYYY-MM-DD
   * @returns {Object|null}
   */
  async getDexPriceByProcessId(processId, date) {
    if (!this.isConnected) await this.connect();
    if (!this.isConnected) return null;

    // Check cache
    const cacheKey = `dex:${date}:${processId}`;
    if (this.dexPriceCache.has(cacheKey)) {
      return this.dexPriceCache.get(cacheKey);
    }

    try {
      // First, try to get exact date price
      const exactQuery = `
        SELECT * FROM dex_token_prices
        WHERE token_process_id = ? AND price_date = ?
        ORDER BY block_timestamp DESC
        LIMIT 1
      `;

      const exactResult = await this.client.execute(
        exactQuery,
        [processId, date],
        { prepare: true },
      );

      if (exactResult.rows.length > 0) {
        const price = await this.convertDexPriceToUSD(
          exactResult.rows[0],
          date,
        );
        if (price) {
          this.dexPriceCache.set(cacheKey, price);
          return price;
        }
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
        [processId, date],
        { prepare: true },
      );

      if (ffResult.rows.length > 0) {
        const price = await this.convertDexPriceToUSD(ffResult.rows[0], date);
        if (price) {
          price.isForwardFilled = true;
          price.forwardFilledFrom = ffResult.rows[0].price_date;
          this.dexPriceCache.set(cacheKey, price);
          return price;
        }
      }

      // No price found
      this.dexPriceCache.set(cacheKey, null);
      return null;
    } catch (error) {
      if (this.verbose) {
        console.warn(
          `   ⚠️ Error getting DEX price for ${processId}: ${error.message}`,
        );
      }
      return null;
    }
  }

  /**
   * Convert DEX price row to USD
   * Handles wAR-denominated prices by looking up AR price
   * @param {Object} row - Database row from dex_token_prices
   * @param {string} targetDate - Date for AR price lookup
   * @returns {Object|null} - Price object with priceUSD
   */
  async convertDexPriceToUSD(row, targetDate) {
    let priceUSD = null;
    let priceInWar = null;

    // If already has USD price, use it
    if (row.price_usd) {
      priceUSD = this.parsePriceValue(row.price_usd);
    }

    // If has USDC price, use that (1 USDC = $1)
    if (!priceUSD && row.price_in_usdc) {
      priceUSD = this.parsePriceValue(row.price_in_usdc);
    }

    // If has wAR price, convert via AR price
    if (!priceUSD && row.price_in_war) {
      const rawPriceInWar = this.parsePriceValue(row.price_in_war);
      if (rawPriceInWar) {
        // price_in_war is stored in base units (12 decimals for wAR)
        // Convert to actual wAR amount
        priceInWar = rawPriceInWar / 1e12;

        // Get AR price for conversion
        const arPrice = await this.getPrice("AR", targetDate);
        if (arPrice) {
          priceUSD = priceInWar * arPrice;
        }
      }
    }

    if (!priceUSD || priceUSD <= 0) {
      return null;
    }

    return {
      priceUSD,
      priceInWar,
      source: row.source_platform || "dex-index",
      sourceTxId: row.source_tx_id,
      pairedToken: row.paired_token,
      isForwardFilled: row.is_forward_filled || false,
      blockTimestamp: row.block_timestamp,
    };
  }

  /**
   * Get price for a token by process ID
   * Combines all price sources (server + DEX index)
   * @param {string} processId - Token process ID
   * @param {string|Date} date - Date
   * @returns {number|null}
   */
  async getPriceByProcessId(processId, date) {
    // Check if we have a symbol mapping
    const symbol = this.getSymbolFromProcessId(processId);
    if (symbol) {
      return this.getPrice(symbol, date);
    }

    // No symbol mapping - try DEX index directly
    const dateStr =
      typeof date === "string"
        ? date.split("T")[0]
        : date.toISOString().split("T")[0];

    const dexPrice = await this.getDexPriceByProcessId(processId, dateStr);
    return dexPrice ? dexPrice.priceUSD : null;
  }

  /**
   * Check if a token has any DEX price data
   * @param {string} processId - Token process ID
   * @returns {boolean}
   */
  async hasDexPriceData(processId) {
    if (!this.isConnected) await this.connect();
    if (!this.isConnected) return false;

    try {
      const query = `
        SELECT COUNT(*) as count FROM dex_token_prices
        WHERE token_process_id = ?
        LIMIT 1
        ALLOW FILTERING
      `;

      const result = await this.client.execute(query, [processId], {
        prepare: true,
      });

      return result.rows.length > 0 && result.rows[0].count > 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get DEX price date range for a token
   * @param {string} processId - Token process ID
   * @returns {{firstDate: string, lastDate: string}|null}
   */
  async getDexPriceDateRange(processId) {
    if (!this.isConnected) await this.connect();
    if (!this.isConnected) return null;

    try {
      const query = `
        SELECT MIN(price_date) as first_date, MAX(price_date) as last_date
        FROM dex_token_prices
        WHERE token_process_id = ?
        ALLOW FILTERING
      `;

      const result = await this.client.execute(query, [processId], {
        prepare: true,
      });

      if (result.rows.length > 0 && result.rows[0].first_date) {
        return {
          firstDate: result.rows[0].first_date,
          lastDate: result.rows[0].last_date,
        };
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  // ============================================================
  // ORIGINAL METHODS (continued)
  // ============================================================

  /**
   * Get price with detailed source information
   * @param {string} symbol - Token symbol
   * @param {string|Date} date - Date
   * @returns {Object|null} - { price, source } or null
   */
  async getPriceWithSource(symbol, date) {
    const dateStr =
      typeof date === "string"
        ? date.split("T")[0]
        : date.toISOString().split("T")[0];

    if (STABLECOINS.includes(symbol)) {
      return { price: 1.0, source: "stablecoin" };
    }

    const lookupSymbol = symbol === "wAR" ? "AR" : symbol;

    if (!this.isConnected) {
      await this.connect();
    }

    if (!this.isConnected) {
      return null;
    }

    try {
      // Try each price source in priority order
      for (const source of PRICE_SOURCES) {
        const query = `
          SELECT price_usd, data_source
          FROM daily_prices
          WHERE date = ? AND token_symbol = ? AND data_source = ?
          ALLOW FILTERING
        `;

        const result = await this.client.execute(
          query,
          [dateStr, lookupSymbol, source],
          { prepare: true },
        );

        if (result.rows.length > 0) {
          const price = this.parsePriceValue(result.rows[0].price_usd);
          if (price !== null && !isNaN(price) && price > 0) {
            return { price, source };
          }
        }
      }

      // Try forward-fill
      return this.getForwardFillPrice(lookupSymbol, dateStr);
    } catch (error) {
      return null;
    }
  }

  /**
   * Get price from Unix timestamp
   * @param {string} symbol - Token symbol
   * @param {number} timestamp - Unix timestamp (seconds)
   * @returns {number|null}
   */
  async getPriceAtTimestamp(symbol, timestamp) {
    if (!timestamp) return null;
    const date = new Date(timestamp * 1000);
    return this.getPrice(symbol, date);
  }

  /**
   * Batch get prices for multiple date/symbol combinations
   * @param {Array<{symbol: string, date: string|Date}>} requests
   * @returns {Map<string, number|null>} - Map of "date:symbol" -> price
   */
  async getPricesBatch(requests) {
    const results = new Map();

    // Dedupe and prepare queries
    const toFetch = [];
    for (const req of requests) {
      const dateStr =
        typeof req.date === "string"
          ? req.date.split("T")[0]
          : req.date.toISOString().split("T")[0];
      const key = `${dateStr}:${req.symbol}`;

      if (this.cache.has(key)) {
        results.set(key, this.cache.get(key));
      } else if (STABLECOINS.includes(req.symbol)) {
        results.set(key, 1.0);
        this.cache.set(key, 1.0);
      } else {
        toFetch.push({ symbol: req.symbol, date: dateStr, key });
      }
    }

    // Fetch uncached prices
    for (const req of toFetch) {
      const price = await this.getPrice(req.symbol, req.date);
      results.set(req.key, price);
    }

    return results;
  }

  /**
   * Check if a token has any historical prices (has market)
   * @param {string} symbol - Token symbol
   * @returns {boolean}
   */
  async hasMarketPrices(symbol) {
    if (STABLECOINS.includes(symbol)) return true;
    if (!TOKEN_COINGECKO_MAP[symbol] && !["PI", "PIXL"].includes(symbol)) {
      return false; // Unknown token, no market
    }

    if (!this.isConnected) {
      await this.connect();
    }

    if (!this.isConnected) return false;

    try {
      const query = `
        SELECT COUNT(*) as count FROM daily_prices
        WHERE token_symbol = ?
        ALLOW FILTERING
      `;

      const result = await this.client.execute(query, [symbol], {
        prepare: true,
      });

      return result.rows[0].count > 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get available date range for a token
   * @param {string} symbol
   * @returns {{minDate: string, maxDate: string}|null}
   */
  async getDateRange(symbol) {
    if (!this.isConnected) {
      await this.connect();
    }

    if (!this.isConnected) return null;

    try {
      const query = `
        SELECT MIN(date) as min_date, MAX(date) as max_date
        FROM daily_prices
        WHERE token_symbol = ?
        ALLOW FILTERING
      `;

      const result = await this.client.execute(query, [symbol], {
        prepare: true,
      });

      if (result.rows.length > 0 && result.rows[0].min_date) {
        return {
          minDate: result.rows[0].min_date,
          maxDate: result.rows[0].max_date,
        };
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Calculate USD value for a transaction
   * @param {Object} tx - Transaction with tokenSymbol, amountHuman, blockTimestamp
   * @returns {number|null}
   */
  async calculateValueUSD(tx) {
    if (!tx.tokenSymbol || tx.amountHuman === 0) {
      return null;
    }

    const date = tx.blockTimestamp
      ? new Date(tx.blockTimestamp * 1000)
      : tx.processedAt;

    const price = await this.getPrice(tx.tokenSymbol, date);

    if (price === null) {
      return null;
    }

    return tx.amountHuman * price;
  }

  /**
   * Get date from transaction, using block height as fallback
   * @param {Object} tx - Transaction object
   * @returns {Date}
   */
  async getTransactionDate(tx) {
    // Primary: use blockTimestamp if available
    if (tx.blockTimestamp) {
      return new Date(tx.blockTimestamp * 1000);
    }

    // Fallback: estimate from block height
    if (tx.blockHeight && this.cassandraService) {
      try {
        const estimatedTimestamp =
          await this.cassandraService.estimateTimestampFromBlock(
            tx.blockHeight,
          );
        if (estimatedTimestamp) {
          if (this.verbose) {
            console.log(
              `   📅 Estimated date from block ${tx.blockHeight}: ${
                new Date(estimatedTimestamp * 1000).toISOString().split("T")[0]
              }`,
            );
          }
          return new Date(estimatedTimestamp * 1000);
        }
      } catch (error) {
        if (this.verbose) {
          console.warn(
            `   ⚠️ Failed to estimate timestamp from block ${tx.blockHeight}: ${error.message}`,
          );
        }
      }
    }

    // Last resort: use processedAt or current date
    return tx.processedAt || new Date();
  }

  /**
   * Enrich transactions with price data
   * @param {Array} transactions - Array of UnifiedTransaction objects
   * @returns {Array} - Transactions with priceUSD and valueUSD populated
   */
  async enrichWithPrices(transactions) {
    if (this.verbose) {
      console.log(
        `   📈 Enriching ${transactions.length} transactions with prices...`,
      );
    }

    let enrichedCount = 0;
    let blockFallbackCount = 0;

    for (const tx of transactions) {
      const date = await this.getTransactionDate(tx);

      // Track if we used block height fallback
      if (!tx.blockTimestamp && tx.blockHeight) {
        blockFallbackCount++;
      }

      if (tx.isSwap) {
        // For swaps, get prices for both input and output tokens
        const inputPrice = await this.getPrice(tx.inputTokenSymbol, date);
        const outputPrice = await this.getPrice(tx.outputTokenSymbol, date);

        if (inputPrice !== null) {
          tx.inputPriceUSD = inputPrice;
          tx.inputValueUSD = tx.inputAmountHuman * inputPrice;
        }
        if (outputPrice !== null) {
          tx.outputPriceUSD = outputPrice;
          tx.outputValueUSD = tx.outputAmountHuman * outputPrice;
        }

        // Use input value as the disposal value (what was given up)
        tx.priceUSD = inputPrice;
        tx.valueUSD = tx.inputValueUSD;

        if (inputPrice !== null || outputPrice !== null) {
          enrichedCount++;
        }
      } else {
        // Regular transfer
        const price = await this.getPrice(tx.tokenSymbol, date);
        if (price !== null) {
          tx.priceUSD = price;
          tx.valueUSD = tx.amountHuman * price;
          enrichedCount++;
        }
      }
    }

    if (this.verbose) {
      console.log(
        `   ✅ Enriched ${enrichedCount}/${transactions.length} with prices`,
      );
      if (blockFallbackCount > 0) {
        console.log(
          `   📅 Used block height fallback for ${blockFallbackCount} transactions`,
        );
      }
    }

    return transactions;
  }

  // ============================================================
  // DEX PRICE PATH FINDING
  // ============================================================

  /**
   * Get price by finding a path through DEX trading pairs
   * Example: SMONEY -> wAR -> wUSDC -> USD
   * @param {string} symbol - Token symbol
   * @param {string|Date} date - Date for price lookup
   * @returns {number|null}
   */
  async getPriceViaDEXPath(symbol, date) {
    if (!this.dexMarketIndexer) {
      return null;
    }

    const dateStr =
      typeof date === "string"
        ? date.split("T")[0]
        : date.toISOString().split("T")[0];

    // Check cache first
    const cacheKey = `dex:${dateStr}:${symbol}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    try {
      // Get the token's process ID
      const tokenProcessId = TOKEN_PROCESS_IDS[symbol] || null;
      if (!tokenProcessId) {
        return null;
      }

      // Get markets for this token
      const markets =
        await this.dexMarketIndexer.getMarketsForToken(tokenProcessId);
      if (!markets || markets.length === 0) {
        return null;
      }

      // Try to find a price path
      for (const market of markets) {
        const pairedToken = this.getSymbolFromProcessId(market.pairedTokenId);
        if (!pairedToken) continue;

        // If paired token has direct price, calculate via pool rate
        const pairedPrice = await this.getPrice(pairedToken, date);
        if (pairedPrice !== null) {
          // Get pool rate (how many of target token per paired token)
          const poolRate = await this.getPoolRate(
            market.marketId,
            tokenProcessId,
            market.pairedTokenId,
            dateStr,
          );

          if (poolRate !== null) {
            const price = pairedPrice / poolRate;
            this.cache.set(cacheKey, price);

            if (this.verbose) {
              console.log(
                `   🔗 DEX path: ${symbol} -> ${pairedToken} -> $${price.toFixed(
                  6,
                )}`,
              );
            }

            return price;
          }
        }
      }

      // No path found
      this.cache.set(cacheKey, null);
      return null;
    } catch (error) {
      if (this.verbose) {
        console.warn(
          `   ⚠️ DEX price path error for ${symbol}: ${error.message}`,
        );
      }
      return null;
    }
  }

  /**
   * Get pool exchange rate from reserves or historical data
   * @param {string} poolId - Pool process ID
   * @param {string} tokenA - Token A process ID
   * @param {string} tokenB - Token B process ID
   * @param {string} date - Date string YYYY-MM-DD
   * @returns {number|null} - Rate of tokenA per tokenB
   */
  async getPoolRate(poolId, tokenA, tokenB, date) {
    const cacheKey = `rate:${poolId}:${date}`;
    if (this.poolRateCache.has(cacheKey)) {
      return this.poolRateCache.get(cacheKey);
    }

    // For now, return null - this would need to query pool state or historical swaps
    // In a full implementation, we would:
    // 1. Query the pool process for current reserves via dry-run
    // 2. Or query historical swap transactions near the date to calculate rate
    // 3. Rate = reserveB / reserveA (how many of A you get per B)

    // TODO: Implement pool rate fetching via AO dry-run or historical data
    return null;
  }

  /**
   * Enhanced getPrice that tries DEX path if direct price not available
   * @param {string} symbol - Token symbol
   * @param {string|Date} date - Date
   * @returns {number|null}
   */
  async getPriceWithFallback(symbol, date) {
    // Try direct price first
    const directPrice = await this.getPrice(symbol, date);
    if (directPrice !== null) {
      return directPrice;
    }

    // Try DEX path
    const dexPrice = await this.getPriceViaDEXPath(symbol, date);
    if (dexPrice !== null) {
      return dexPrice;
    }

    // No price available - token has no market
    return null;
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    const entries = Array.from(this.cache.entries());
    const withPrice = entries.filter(([, v]) => v !== null).length;
    const withoutPrice = entries.filter(([, v]) => v === null).length;

    return {
      total: entries.length,
      withPrice,
      withoutPrice,
    };
  }
}

module.exports = {
  PriceService,
  TOKEN_COINGECKO_MAP,
  STABLECOINS,
  TOKEN_PROCESS_IDS,
  PROCESS_ID_TO_SYMBOL,
  PRICE_SOURCES,
  ANCHOR_TOKENS,
};
