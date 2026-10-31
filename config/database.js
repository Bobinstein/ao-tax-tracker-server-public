const cassandra = require("cassandra-driver");

const CONFIG = {
  // Cassandra configuration for price data
  PRICE_DB: {
    contactPoints: ["localhost"],
    localDataCenter: "datacenter1",
    keyspace: "ao_price_data",
    pooling: {
      coreConnectionsPerHost: {
        [cassandra.types.distance.local]: 2,
        [cassandra.types.distance.remote]: 1,
      },
      maxConnectionsPerHost: {
        [cassandra.types.distance.local]: 4,
        [cassandra.types.distance.remote]: 2,
      },
    },
    socketOptions: {
      connectTimeout: 20000,
      readTimeout: 30000,
    },
  },

  // Cassandra configuration for AO distributions
  AO_DISTRIBUTION_DB: {
    contactPoints: ["localhost"],
    localDataCenter: "datacenter1",
    keyspace: "ao_distributions",
    pooling: {
      coreConnectionsPerHost: {
        [cassandra.types.distance.local]: 2,
        [cassandra.types.distance.remote]: 1,
      },
      maxConnectionsPerHost: {
        [cassandra.types.distance.local]: 4,
        [cassandra.types.distance.remote]: 2,
      },
    },
    socketOptions: {
      connectTimeout: 20000,
      readTimeout: 30000,
    },
  },

  // Cassandra configuration for PI distributions
  PI_DISTRIBUTION_DB: {
    contactPoints: ["localhost"],
    localDataCenter: "datacenter1",
    keyspace: "pi_distributions",
    pooling: {
      coreConnectionsPerHost: {
        [cassandra.types.distance.local]: 2,
        [cassandra.types.distance.remote]: 1,
      },
      maxConnectionsPerHost: {
        [cassandra.types.distance.local]: 4,
        [cassandra.types.distance.remote]: 2,
      },
    },
    socketOptions: {
      connectTimeout: 20000,
      readTimeout: 30000,
    },
  },

  // Cassandra configuration for ARIO distributions
  ARIO_DISTRIBUTION_DB: {
    contactPoints: ["localhost"],
    localDataCenter: "datacenter1",
    keyspace: "ario_distributions",
    pooling: {
      coreConnectionsPerHost: {
        [cassandra.types.distance.local]: 2,
        [cassandra.types.distance.remote]: 1,
      },
      maxConnectionsPerHost: {
        [cassandra.types.distance.local]: 4,
        [cassandra.types.distance.remote]: 2,
      },
    },
    socketOptions: {
      connectTimeout: 20000,
      readTimeout: 30000,
    },
  },

  // ============================================================================
  // AR WALLET TAX TRACKER DATABASE
  // Unified transactions, tax lots, disposals, and report caching
  // ============================================================================
  AR_TAX_TRACKER_DB: {
    contactPoints: process.env.CASSANDRA_HOSTS?.split(",") || ["localhost"],
    localDataCenter: process.env.CASSANDRA_DATACENTER || "datacenter1",
    keyspace: process.env.AR_TAX_TRACKER_KEYSPACE || "ar_tax_tracker",
    // Higher connection pool for tax report generation (can be CPU-intensive)
    pooling: {
      coreConnectionsPerHost: {
        [cassandra.types.distance.local]: 4,
        [cassandra.types.distance.remote]: 2,
      },
      maxConnectionsPerHost: {
        [cassandra.types.distance.local]: 8,
        [cassandra.types.distance.remote]: 4,
      },
      maxRequestsPerConnection: {
        [cassandra.types.distance.local]: 4096,
        [cassandra.types.distance.remote]: 2048,
      },
      heartBeatInterval: 30000,
    },
    socketOptions: {
      connectTimeout: 30000,
      readTimeout: 60000, // Longer timeout for complex queries
      keepAlive: true,
      keepAliveDelay: 0,
    },
    queryOptions: {
      consistency: cassandra.types.consistencies.localOne,
      fetchSize: 1000,
      prepare: true,
    },
  },

  // Token configurations
  TOKENS: {
    AR: {
      symbol: "AR",
      name: "Arweave",
      decimals: 12,
      coingeckoId: "arweave",
    },
    AO: {
      symbol: "AO",
      name: "AO",
      decimals: 12,
      coingeckoId: "ao-computer",
    },
    PI: {
      symbol: "PI",
      name: "Permaweb Index Token",
      decimals: 12,
      coingeckoId: null,
    },
    ARIO: {
      symbol: "ARIO",
      name: "AR.IO",
      decimals: 6,
      coingeckoId: "ar-io",
    },
    wAR: {
      symbol: "wAR",
      name: "Wrapped AR",
      decimals: 12,
      coingeckoId: null, // Uses AR price
    },
    PIXL: {
      symbol: "PIXL",
      name: "Pixel Token",
      decimals: 6,
      coingeckoId: null, // No CoinGecko listing, uses Permaswap price
    },
  },

  // ============================================================================
  // AR TAX TRACKER TABLE NAMES
  // ============================================================================
  AR_TRACKER_TABLES: {
    UNIFIED_TRANSACTIONS: "unified_transactions",
    UNIFIED_TRANSACTIONS_ORIGINALS: "unified_transactions_originals",
    TAX_LOTS: "tax_lots",
    TAX_LOT_ORIGINALS: "tax_lot_originals",
    DISPOSALS: "disposals",
    HOLDINGS_SUMMARY: "holdings_summary",
    BAZAR_PROFILES: "bazar_profiles",
    BAZAR_PROFILES_BY_WALLET: "bazar_profiles_by_wallet",
    PROFILE_TRANSACTIONS: "profile_transactions",
    REPORT_SUMMARY_CACHE: "report_summary_cache",
    INDEXER_STATE: "indexer_state",
    REGISTERED_WALLET_GROUPS: "registered_wallet_groups",
    WALLET_TO_GROUPS: "wallet_to_groups",
    TOKEN_INFO: "token_info",
    BLOCK_TIMESTAMPS: "block_timestamps",
  },

  // ============================================================================
  // DEX PRICE INDEXER TABLES (in ao_price_data keyspace)
  // ============================================================================
  DEX_TABLES: {
    DEX_SWAPS: "dex_swaps",
    DEX_TOKEN_PRICES: "dex_token_prices",
    DEX_INDEXER_STATE: "dex_indexer_state",
  },

  // ============================================================================
  // FIAT CONVERSION TABLES (in ao_price_data keyspace)
  // ============================================================================
  FIAT_TABLES: {
    FIAT_EXCHANGE_RATES: "fiat_exchange_rates",
    FIAT_INDEXER_STATE: "fiat_indexer_state",
  },
};

module.exports = CONFIG;
