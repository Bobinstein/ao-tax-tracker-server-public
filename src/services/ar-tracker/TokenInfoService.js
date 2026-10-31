/**
 * Token Info Service
 *
 * Fetches token metadata from AO processes using dry-run messages.
 * Caches results in memory and persists to Cassandra to avoid redundant queries.
 *
 * Lookup order:
 * 1. In-memory cache (fastest)
 * 2. Cassandra database (persisted)
 * 3. AO dry-run (network call, then save to DB)
 *
 * Uses aoconnect to send Action="Info" messages to token processes
 * to retrieve name, ticker, denomination, logo, etc.
 *
 * @module services/TokenInfoService
 */

const { dryrun } = require("@permaweb/aoconnect");
const CONSTANTS = require("../../../config/ar-tracker-constants");

class TokenInfoService {
  constructor(options = {}) {
    this.cache = new Map();
    this.pendingRequests = new Map(); // Dedupe concurrent requests
    this.verbose = options.verbose || false;
    this.cassandraService = options.cassandraService || null;
    this.useCassandra = !!this.cassandraService;
    this.dexMarketIndexer = options.dexMarketIndexer || null;

    // Pre-populate cache with known tokens from constants
    this.initializeFromConstants();
  }

  /**
   * Set Cassandra service for persistence
   */
  setCassandraService(cassandraService) {
    this.cassandraService = cassandraService;
    this.useCassandra = !!cassandraService;
  }

  /**
   * Set DEX Market Indexer for market status checking
   */
  setDEXMarketIndexer(indexer) {
    this.dexMarketIndexer = indexer;
  }

  /**
   * Check if a token has market value
   * @param {string} processId - Token process ID
   * @param {string} asOfDate - Optional date (YYYY-MM-DD) to check if market existed
   * @returns {{hasMarket: boolean, platforms: string[], firstSeen: string|null}}
   */
  async checkMarketStatus(processId, asOfDate = null) {
    // Check cache first
    if (this.cache.has(processId)) {
      const cached = this.cache.get(processId);
      if (cached.hasMarket !== undefined) {
        return {
          hasMarket: cached.hasMarket,
          platforms: cached.marketPlatforms || [],
          firstSeen: cached.marketFirstSeen || null,
        };
      }
    }

    // Known tokens have markets
    if (CONSTANTS.TOKENS[processId]) {
      return { hasMarket: true, platforms: ["known"], firstSeen: null };
    }

    // Check DEX market indexer
    if (this.dexMarketIndexer) {
      const marketInfo = await this.dexMarketIndexer.hasMarket(
        processId,
        asOfDate
      );

      // Update cache with market info
      if (this.cache.has(processId)) {
        const cached = this.cache.get(processId);
        cached.hasMarket = marketInfo.hasMarket;
        cached.marketPlatforms = marketInfo.platforms;
        cached.marketFirstSeen = marketInfo.firstSeen;
      }

      return marketInfo;
    }

    // No market indexer, assume no market for unknown tokens
    return { hasMarket: false, platforms: [], firstSeen: null };
  }

  /**
   * Initialize cache with tokens from constants
   */
  initializeFromConstants() {
    for (const [processId, tokenInfo] of Object.entries(CONSTANTS.TOKENS)) {
      this.cache.set(processId, {
        processId,
        name: tokenInfo.name,
        ticker: tokenInfo.symbol,
        denomination: tokenInfo.decimals,
        logo: tokenInfo.logo || null,
        source: "constants",
        hasMarket: true, // Assume tokens in constants have markets
        fetchedAt: new Date(),
      });
    }

    if (this.verbose) {
      console.log(
        `   📚 Loaded ${this.cache.size} tokens from constants registry`
      );
    }
  }

  /**
   * Preload all tokens from Cassandra database into memory cache
   * Call this on startup to avoid individual DB lookups
   */
  async preloadFromCassandra() {
    if (!this.useCassandra) {
      console.log("   ⚠️ Cassandra not configured, skipping preload");
      return;
    }

    try {
      const dbTokens = await this.cassandraService.getAllTokenInfos();
      let loadedCount = 0;

      for (const row of dbTokens) {
        // Don't overwrite constants (they're authoritative)
        if (
          !this.cache.has(row.process_id) ||
          this.cache.get(row.process_id).source !== "constants"
        ) {
          this.cache.set(row.process_id, {
            processId: row.process_id,
            name: row.name,
            ticker: row.ticker,
            denomination: row.denomination,
            logo: row.logo,
            totalSupply: row.total_supply,
            source: "cassandra",
            hasMarket: row.has_market,
            lastKnownPriceUSD: row.last_known_price_usd,
            marketCheckedAt: row.market_checked_at,
            fetchedAt: row.fetched_at,
            error: row.error,
          });
          loadedCount++;
        }
      }

      if (this.verbose) {
        console.log(
          `   📀 Preloaded ${loadedCount} tokens from Cassandra database`
        );
      }
    } catch (error) {
      console.warn(
        `   ⚠️ Failed to preload tokens from Cassandra: ${error.message}`
      );
    }
  }

  /**
   * Sync constants tokens to Cassandra (for persistence)
   */
  async syncConstantsToCassandra() {
    if (!this.useCassandra) return;

    const constantsTokens = [];
    for (const [processId, tokenInfo] of Object.entries(CONSTANTS.TOKENS)) {
      constantsTokens.push({
        processId,
        name: tokenInfo.name,
        ticker: tokenInfo.symbol,
        denomination: tokenInfo.decimals,
        logo: tokenInfo.logo || null,
        source: "constants",
        hasMarket: true,
        fetchedAt: new Date(),
      });
    }

    try {
      await this.cassandraService.saveTokenInfoBatch(constantsTokens);
      if (this.verbose) {
        console.log(
          `   💾 Synced ${constantsTokens.length} constants tokens to Cassandra`
        );
      }
    } catch (error) {
      console.warn(
        `   ⚠️ Failed to sync constants to Cassandra: ${error.message}`
      );
    }
  }

  /**
   * Get token info from cache, Cassandra, or fetch from process
   * Lookup order: memory cache -> Cassandra -> AO dry-run
   */
  async getTokenInfo(processId) {
    // 1. Check in-memory cache first (fastest)
    if (this.cache.has(processId)) {
      return this.cache.get(processId);
    }

    // Check if request is already pending (dedupe)
    if (this.pendingRequests.has(processId)) {
      return this.pendingRequests.get(processId);
    }

    // Create a promise that handles the full lookup chain
    const fetchPromise = (async () => {
      // 2. Check Cassandra database
      if (this.useCassandra) {
        try {
          const dbResult = await this.cassandraService.getTokenInfo(processId);
          if (dbResult) {
            if (this.verbose) {
              console.log(
                `   📀 Token ${processId.substring(0, 12)}... found in database`
              );
            }
            // Convert DB row to standard format
            const info = {
              processId: dbResult.process_id,
              name: dbResult.name,
              ticker: dbResult.ticker,
              denomination: dbResult.denomination,
              logo: dbResult.logo,
              totalSupply: dbResult.total_supply,
              source: "cassandra",
              hasMarket: dbResult.has_market,
              lastKnownPriceUSD: dbResult.last_known_price_usd,
              marketCheckedAt: dbResult.market_checked_at,
              fetchedAt: dbResult.fetched_at,
              error: dbResult.error,
            };
            this.cache.set(processId, info);
            return info;
          }
        } catch (error) {
          if (this.verbose) {
            console.warn(
              `   ⚠️ Cassandra lookup failed for ${processId.substring(
                0,
                12
              )}: ${error.message}`
            );
          }
        }
      }

      // 3. Fetch from AO process via dry-run
      const result = await this.fetchTokenInfo(processId);

      // Save to Cassandra for future lookups
      if (this.useCassandra && result) {
        try {
          await this.cassandraService.saveTokenInfo(result);
          if (this.verbose) {
            console.log(
              `   💾 Saved token ${
                result.ticker || processId.substring(0, 12)
              } to database`
            );
          }
        } catch (error) {
          if (this.verbose) {
            console.warn(
              `   ⚠️ Failed to save token to database: ${error.message}`
            );
          }
        }
      }

      return result;
    })();

    this.pendingRequests.set(processId, fetchPromise);

    try {
      const result = await fetchPromise;
      this.cache.set(processId, result);
      return result;
    } finally {
      this.pendingRequests.delete(processId);
    }
  }

  /**
   * Fetch token info from AO process via dry-run
   */
  async fetchTokenInfo(processId) {
    if (this.verbose) {
      console.log(
        `   🔍 Fetching token info for ${processId.substring(0, 12)}...`
      );
    }

    try {
      // Add timeout to prevent hanging on unresponsive processes
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout after 10s")), 10000)
      );

      const dryrunPromise = dryrun({
        process: processId,
        tags: [{ name: "Action", value: "Info" }],
        data: "",
      });

      const result = await Promise.race([dryrunPromise, timeoutPromise]);

      // Parse the response tags
      const info = this.parseInfoResponse(result, processId);

      if (this.verbose) {
        console.log(
          `   ✅ Token: ${info.ticker || "UNKNOWN"} (${info.name || "Unknown"})`
        );
      }

      return info;
    } catch (error) {
      if (this.verbose) {
        console.warn(
          `   ⚠️ Failed to fetch info for ${processId.substring(0, 12)}: ${
            error.message
          }`
        );
      }

      // Return minimal info on failure
      return {
        processId,
        name: null,
        ticker: null,
        denomination: 12, // Default AO denomination
        logo: null,
        source: "failed",
        hasMarket: false,
        error: error.message,
        fetchedAt: new Date(),
      };
    }
  }

  /**
   * Parse Info response from AO process
   */
  parseInfoResponse(result, processId) {
    const tags = {};

    // Parse tags from Messages
    if (result.Messages && result.Messages.length > 0) {
      const msg = result.Messages[0];
      if (msg.Tags) {
        for (const tag of msg.Tags) {
          tags[tag.name] = tag.value;
        }
      }
    }

    // Also check Output for any data
    let data = null;
    if (result.Output && result.Output.data) {
      try {
        data = JSON.parse(result.Output.data);
      } catch {
        data = result.Output.data;
      }
    }

    return {
      processId,
      name: tags.Name || data?.Name || null,
      ticker: tags.Ticker || data?.Ticker || null,
      denomination: parseInt(tags.Denomination || data?.Denomination || "12"),
      logo: tags.Logo || data?.Logo || null,
      totalSupply: tags.TotalSupply || data?.TotalSupply || null,
      source: "ao-dryrun",
      hasMarket: false, // Will be updated by market check
      fetchedAt: new Date(),
    };
  }

  /**
   * Batch fetch token info for multiple process IDs
   */
  async getTokenInfoBatch(processIds) {
    const uniqueIds = [...new Set(processIds)];
    const results = new Map();

    // Separate cached vs uncached
    const uncached = [];
    for (const id of uniqueIds) {
      if (this.cache.has(id)) {
        results.set(id, this.cache.get(id));
      } else {
        uncached.push(id);
      }
    }

    if (this.verbose && uncached.length > 0) {
      console.log(
        `   📡 Fetching info for ${uncached.length} unknown tokens...`
      );
    }

    // Fetch uncached tokens with rate limiting
    for (const id of uncached) {
      const info = await this.getTokenInfo(id);
      results.set(id, info);
      // Small delay to avoid overwhelming the network
      await new Promise((r) => setTimeout(r, 100));
    }

    return results;
  }

  /**
   * Update token with market info
   */
  updateMarketStatus(processId, hasMarket, priceUSD = null) {
    const info = this.cache.get(processId);
    if (info) {
      info.hasMarket = hasMarket;
      info.lastKnownPriceUSD = priceUSD;
      info.marketCheckedAt = new Date();
      this.cache.set(processId, info);
    }
  }

  /**
   * Get all cached tokens
   */
  getAllCached() {
    return Array.from(this.cache.values());
  }

  /**
   * Get tokens without market (likely worthless)
   */
  getTokensWithoutMarket() {
    return this.getAllCached().filter((t) => !t.hasMarket);
  }

  /**
   * Get unknown/failed tokens
   */
  getUnknownTokens() {
    return this.getAllCached().filter(
      (t) => t.source === "failed" || (!t.ticker && !t.name)
    );
  }

  /**
   * Export cache for persistence
   */
  exportCache() {
    const entries = [];
    for (const [processId, info] of this.cache.entries()) {
      entries.push({ processId, ...info });
    }
    return entries;
  }

  /**
   * Import cached data
   */
  importCache(entries) {
    for (const entry of entries) {
      if (entry.processId) {
        this.cache.set(entry.processId, entry);
      }
    }
  }
}

module.exports = { TokenInfoService };
