/**
 * BazarProfileService
 *
 * Discovers and integrates Bazar Profiles for wallet tax reporting.
 * Bazar Profiles are AO smart contracts that hold assets and can perform
 * DEX swaps, NFT transactions, and UCM (order book) interactions.
 *
 * For tax purposes, a user's Bazar profile should be treated as an additional
 * wallet with AO-only transactions (no L1 Arweave transactions).
 *
 * Based on: https://github.com/permaweb/ao-profile
 *
 * @module services/BazarProfileService
 */

const { connect, createDataItemSigner } = require("@permaweb/aoconnect");
const GraphQLClient = require("../../utils/graphql-client");

/**
 * AO Configuration for Bazar Profiles
 * From: https://github.com/permaweb/ao-profile/blob/main/sdk/src/config.ts
 */
const AO_CONFIG = {
  profileRegistry: "SNy4m-DrqxWl01YqGM4sxI8qCni-58re8uuJLvZPypY",
  profileSrc: "_R2XYWDPUXVvQrQKFaQRvDTDcDwnQNbqlTd_qvCRSpQ",
  module: "Pq2Zftrqut0hdisH_MC2pDOT6S4eQFoxGsFUzR6r350",
  scheduler: "_GQ33BkPtZrqxA84vM8Zk-N2aO0toNNu_C-l-rawrBA",
};

/**
 * GraphQL query for OLDER profiles (pre-Zone era).
 * These profiles have `Action: Create-Profile` tag at creation.
 * This is a DEFINITIVE identifier - only Bazar profiles have this tag.
 */
const LEGACY_PROFILE_QUERY = `
query GetLegacyProfiles($owner: String!, $cursor: String) {
  transactions(
    owners: [$owner]
    tags: [
      { name: "Data-Protocol", values: ["ao"] }
      { name: "Action", values: ["Create-Profile"] }
    ]
    first: 100
    after: $cursor
    sort: HEIGHT_DESC
  ) {
    pageInfo {
      hasNextPage
    }
    edges {
      cursor
      node {
        id
        owner {
          address
        }
        tags {
          name
          value
        }
        block {
          timestamp
          height
        }
      }
    }
  }
}`;

/**
 * GraphQL query for NEWER profiles (Zone era).
 * These profiles have `Zone-Type: User` tag at creation.
 * This is a DEFINITIVE identifier for Zone-based profiles.
 */
const ZONE_PROFILE_QUERY = `
query GetZoneProfiles($owner: String!, $cursor: String) {
  transactions(
    owners: [$owner]
    tags: [
      { name: "Data-Protocol", values: ["ao"] }
      { name: "Zone-Type", values: ["User"] }
    ]
    first: 100
    after: $cursor
    sort: HEIGHT_DESC
  ) {
    pageInfo {
      hasNextPage
    }
    edges {
      cursor
      node {
        id
        owner {
          address
        }
        tags {
          name
          value
        }
        block {
          timestamp
          height
        }
      }
    }
  }
}`;

/**
 * Profile version tags used across different Bazar iterations
 */
const PROFILE_VERSIONS = {
  legacy: "Action: Create-Profile (pre-Zone era)",
  zone: "Zone-Type: User (current era)",
};

/**
 * BazarProfileService class
 *
 * Discovers Bazar Profiles associated with wallet addresses and
 * provides methods to fetch their transaction history.
 * Persists profile data to Cassandra for caching and historical tracking.
 */
class BazarProfileService {
  /**
   * Create a new BazarProfileService instance
   *
   * @param {Object} options - Configuration options
   * @param {Object} options.cassandraService - CassandraService instance for persistence
   * @param {boolean} options.verbose - Enable verbose logging
   * @param {string} options.profileRegistry - Override profile registry process ID
   * @param {number} options.timeout - Timeout for AO calls in milliseconds
   * @param {boolean} options.forceRefresh - Force refresh from AO even if cached
   */
  constructor(options = {}) {
    this.cassandraService = options.cassandraService || null;
    this.verbose = options.verbose || false;
    this.profileRegistry = options.profileRegistry || AO_CONFIG.profileRegistry;
    this.timeout = options.timeout || 30000; // 30 seconds default
    this.forceRefresh = options.forceRefresh || false;

    // AO connection
    this.ao = connect();

    // GraphQL client for fallback queries
    this.gqlClient = new GraphQLClient({
      timeout: 15000, // 15 second timeout for GQL
      maxRetries: 2,
    });

    // In-memory cache for session (in addition to Cassandra)
    this.profileCache = new Map();
    this.cacheExpiry = new Map();
    this.cacheTTL = 10 * 60 * 1000; // 10 minutes for in-memory
  }

  /**
   * Execute a dry-run read handler on an AO process
   *
   * @param {Object} args - Handler arguments
   * @param {string} args.processId - Process ID to query
   * @param {string} args.action - Action tag value
   * @param {Object} args.data - Data to send
   * @param {Array} args.tags - Additional tags
   * @returns {Object|null} Response data
   */
  async readHandler(args) {
    const tags = [{ name: "Action", value: args.action }];
    if (args.tags) tags.push(...args.tags);

    const data = JSON.stringify(args.data || {});

    try {
      const response = await Promise.race([
        this.ao.dryrun({
          process: args.processId,
          tags: tags,
          data: data,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), this.timeout),
        ),
      ]);

      if (response.Messages && response.Messages.length) {
        if (response.Messages[0].Data) {
          return JSON.parse(response.Messages[0].Data);
        } else if (response.Messages[0].Tags) {
          return response.Messages[0].Tags.reduce((acc, item) => {
            acc[item.name] = item.value;
            return acc;
          }, {});
        }
      }
      return null;
    } catch (error) {
      if (this.verbose) {
        console.log(
          `⚠️  AO read error for ${args.processId.substring(0, 12)}...: ${
            error.message
          }`,
        );
      }
      return null;
    }
  }

  /**
   * Execute a paginated GraphQL query and collect all profile IDs.
   * @param {string} query - The GraphQL query to execute
   * @param {string} walletAddress - Wallet address
   * @param {string} queryName - Name for logging
   * @returns {string[]} Array of profile IDs
   */
  async executeProfileQuery(query, walletAddress, queryName) {
    const profileIds = [];
    let cursor = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const result = await this.gqlClient.execute(query, {
        owner: walletAddress,
        cursor: cursor,
      });

      const edges = result?.data?.transactions?.edges || [];
      const pageInfo = result?.data?.transactions?.pageInfo || {};

      for (const edge of edges) {
        const profileId = edge.node.id;
        if (!profileIds.includes(profileId)) {
          profileIds.push(profileId);
          if (this.verbose) {
            console.log(`      ✅ Found ${queryName}: ${profileId}`);
          }
        }
      }

      hasNextPage = pageInfo.hasNextPage;
      if (hasNextPage && edges.length > 0) {
        cursor = edges[edges.length - 1].cursor;
      } else {
        hasNextPage = false;
      }
    }

    return profileIds;
  }

  /**
   * Find ALL profile processes for a wallet using PRECISE GraphQL queries.
   *
   * Uses two definitive queries for different profile versions:
   * 1. Legacy profiles: Action: Create-Profile (pre-Zone era)
   * 2. Zone profiles: Zone-Type: User (current era)
   *
   * NO broad search or verification needed - these tags are UNIQUE to profiles.
   *
   * @param {string} walletAddress - Wallet address to search for
   * @returns {string[]} Array of profile process IDs (may be empty)
   */
  async findAllProfilesViaGraphQL(walletAddress) {
    if (this.verbose) {
      console.log(
        `   🔍 GraphQL: searching for profiles for ${walletAddress}...`,
      );
    }

    const allProfileIds = [];

    try {
      // Query 1: Legacy profiles (Action: Create-Profile)
      if (this.verbose) {
        console.log(
          `      📋 Query 1: Legacy profiles (Action: Create-Profile)...`,
        );
      }
      const legacyProfiles = await this.executeProfileQuery(
        LEGACY_PROFILE_QUERY,
        walletAddress,
        "legacy profile",
      );
      allProfileIds.push(...legacyProfiles);

      // Query 2: Zone-based profiles (Zone-Type: User)
      if (this.verbose) {
        console.log(`      📋 Query 2: Zone profiles (Zone-Type: User)...`);
      }
      const zoneProfiles = await this.executeProfileQuery(
        ZONE_PROFILE_QUERY,
        walletAddress,
        "Zone profile",
      );

      // Add only unique profiles (avoid duplicates if a profile has both tags)
      for (const profileId of zoneProfiles) {
        if (!allProfileIds.includes(profileId)) {
          allProfileIds.push(profileId);
        }
      }

      if (this.verbose) {
        if (allProfileIds.length === 0) {
          console.log(`      ℹ️ No profiles found for this wallet`);
        } else {
          console.log(
            `      📊 Found ${allProfileIds.length} profile(s) total (${legacyProfiles.length} legacy, ${zoneProfiles.length} Zone)`,
          );
        }
      }

      return allProfileIds;
    } catch (error) {
      if (this.verbose) {
        console.log(`      ⚠️ GraphQL error: ${error.message}`);
      }
      return allProfileIds; // Return any profiles found before error
    }
  }

  /**
   * Find a single profile via GraphQL (for backwards compatibility)
   * Returns the most recent profile if multiple exist
   *
   * @param {string} walletAddress - Wallet address to search for
   * @returns {string|null} Profile process ID or null
   */
  async findProfileViaGraphQL(walletAddress) {
    const profiles = await this.findAllProfilesViaGraphQL(walletAddress);
    return profiles.length > 0 ? profiles[0] : null;
  }

  /**
   * Get profile by wallet address
   * First checks Cassandra cache, then falls back to AO registry.
   *
   * @param {string} walletAddress - The wallet address to look up
   * @returns {Object|null} Profile object or null if not found
   */
  async getProfileByWalletAddress(walletAddress) {
    // Check in-memory cache first
    const cacheKey = `wallet:${walletAddress}`;
    if (!this.forceRefresh && this.isCacheValid(cacheKey)) {
      return this.profileCache.get(cacheKey);
    }

    // Check Cassandra cache (if available and not forcing refresh)
    if (this.cassandraService && !this.forceRefresh) {
      try {
        const cachedProfile =
          await this.cassandraService.getProfileByWallet(walletAddress);
        if (cachedProfile) {
          // Check if cache is fresh (within 24 hours)
          const cacheAge = Date.now() - cachedProfile.lastSyncedAt?.getTime();
          const maxAge = 24 * 60 * 60 * 1000; // 24 hours

          if (cacheAge < maxAge) {
            this.setCache(cacheKey, cachedProfile);
            if (this.verbose) {
              console.log(
                `   📦 Using cached profile for ${walletAddress.substring(
                  0,
                  12,
                )}...`,
              );
            }
            return cachedProfile;
          }
        }
      } catch (error) {
        // Continue to AO lookup on cache error
        if (this.verbose) {
          console.log(`   ⚠️ Cache lookup failed: ${error.message}`);
        }
      }
    }

    if (this.verbose) {
      console.log(
        `   🔍 Looking up profile for ${walletAddress.substring(
          0,
          12,
        )}... (from AO)`,
      );
    }

    try {
      // Query the profile registry for profiles associated with this wallet
      let profileId = null;

      // Try AO registry first
      const profileLookup = await this.readHandler({
        processId: this.profileRegistry,
        action: "Get-Profiles-By-Delegate",
        data: { Address: walletAddress },
      });

      if (
        profileLookup &&
        profileLookup.length > 0 &&
        profileLookup[0].ProfileId
      ) {
        profileId = profileLookup[0].ProfileId;
        if (this.verbose) {
          console.log(
            `      ✓ Found via AO registry: ${profileId.substring(0, 12)}...`,
          );
        }
      } else {
        // AO registry failed or returned no results - try GraphQL fallback
        if (this.verbose) {
          console.log(
            `      ℹ️ AO registry returned no results, trying GraphQL fallback...`,
          );
        }
        profileId = await this.findProfileViaGraphQL(walletAddress);
      }

      if (!profileId) {
        // No profile found via either method
        this.setCache(cacheKey, null);
        return null;
      }

      // Fetch full profile details from the profile process
      const profile = await this.getProfileById(profileId);

      if (profile) {
        // Ensure wallet address is set
        profile.walletAddress = walletAddress;
        profile.discoveredAt = new Date();

        // Persist to Cassandra
        if (this.cassandraService) {
          try {
            await this.cassandraService.saveProfile(profile);
            if (this.verbose) {
              console.log(`      💾 Saved profile to database`);
            }
          } catch (saveError) {
            if (this.verbose) {
              console.log(
                `      ⚠️ Failed to save profile: ${saveError.message}`,
              );
            }
          }
        }

        this.setCache(cacheKey, profile);

        if (this.verbose) {
          console.log(
            `      ✅ Found profile: ${
              profile.username ||
              profile.displayName ||
              profileId.substring(0, 12)
            }`,
          );
        }
      }

      return profile;
    } catch (error) {
      if (this.verbose) {
        console.log(`      ❌ Error looking up profile: ${error.message}`);
      }
      return null;
    }
  }

  /**
   * Get profile by profile ID (AO process ID)
   * First checks Cassandra cache, then falls back to AO.
   *
   * @param {string} profileId - The profile's AO process ID
   * @returns {Object|null} Profile object or null if not found
   */
  async getProfileById(profileId) {
    // Check in-memory cache first
    const cacheKey = `profile:${profileId}`;
    if (!this.forceRefresh && this.isCacheValid(cacheKey)) {
      return this.profileCache.get(cacheKey);
    }

    // Check Cassandra cache (if available and not forcing refresh)
    if (this.cassandraService && !this.forceRefresh) {
      try {
        const cachedProfile =
          await this.cassandraService.getProfileById(profileId);
        if (cachedProfile) {
          const cacheAge = Date.now() - cachedProfile.lastSyncedAt?.getTime();
          const maxAge = 24 * 60 * 60 * 1000; // 24 hours

          if (cacheAge < maxAge) {
            this.setCache(cacheKey, cachedProfile);
            return cachedProfile;
          }
        }
      } catch (error) {
        // Continue to AO lookup on cache error
      }
    }

    try {
      // Query the profile process for its info
      const fetchedProfile = await this.readHandler({
        processId: profileId,
        action: "Info",
        data: null,
      });

      if (!fetchedProfile) {
        this.setCache(cacheKey, null);
        return null;
      }

      const profile = {
        id: profileId,
        walletAddress: fetchedProfile.Owner || null,
        displayName: fetchedProfile.Profile?.DisplayName || null,
        username: fetchedProfile.Profile?.UserName || null,
        description: fetchedProfile.Profile?.Description || null,
        thumbnail: fetchedProfile.Profile?.ProfileImage || null,
        banner: fetchedProfile.Profile?.CoverImage || null,
        version: fetchedProfile.Profile?.Version || null,
        assets:
          fetchedProfile.Assets?.map((asset) => ({
            id: asset.Id,
            quantity: asset.Quantity,
          })) || [],
        assetCount: fetchedProfile.Assets?.length || 0,
        // For tax tracking
        isProfile: true,
        profileType: "BAZAR_PROFILE",
      };

      this.setCache(cacheKey, profile);
      return profile;
    } catch (error) {
      if (this.verbose) {
        console.log(
          `      ❌ Error fetching profile ${profileId.substring(0, 12)}...: ${
            error.message
          }`,
        );
      }
      return null;
    }
  }

  /**
   * Discover all Bazar profiles for a list of wallet addresses
   *
   * @param {Array<string>} walletAddresses - Array of wallet addresses
   * @returns {Array<Object>} Array of discovered profiles with metadata
   */
  async discoverProfiles(walletAddresses) {
    if (this.verbose) {
      console.log(
        `\n🔍 Discovering Bazar profiles for ${walletAddresses.length} wallet(s)...`,
      );
    }

    const profiles = [];
    let totalFound = 0;
    let walletsWithProfiles = 0;
    let walletsWithoutProfiles = 0;

    for (const wallet of walletAddresses) {
      try {
        // Get ALL profiles for this wallet (may have multiple)
        const walletProfiles = await this.getAllProfilesForWallet(wallet);

        if (walletProfiles.length > 0) {
          walletsWithProfiles++;
          for (const profile of walletProfiles) {
            profiles.push({
              parentWallet: wallet,
              profileId: profile.id,
              username: profile.username,
              displayName: profile.displayName,
              version: profile.version,
              assetCount: profile.assets?.length || 0,
              // For transaction fetching
              isAOOnly: true, // Profiles have no L1 transactions
              profileType: "BAZAR_PROFILE",
            });
            totalFound++;
          }
        } else {
          walletsWithoutProfiles++;
        }
      } catch (error) {
        if (this.verbose) {
          console.log(`   ❌ Error checking ${wallet}: ${error.message}`);
        }
        walletsWithoutProfiles++;
      }
    }

    if (this.verbose) {
      console.log(`\n📊 Profile discovery complete:`);
      console.log(
        `   Found: ${totalFound} profile(s) across ${walletsWithProfiles} wallet(s)`,
      );
      console.log(
        `   Not found: ${walletsWithoutProfiles} wallets without profiles`,
      );
      if (profiles.length > 0) {
        console.log(`   Profiles:`);
        for (const p of profiles) {
          console.log(
            `     - ${p.profileId} (${
              p.username || p.displayName || "unnamed"
            }) → ${p.parentWallet}`,
          );
        }
      }
    }

    return profiles;
  }

  /**
   * Get ALL profiles associated with a wallet address
   * A wallet may have multiple profiles due to version iterations or manual creation
   *
   * @param {string} walletAddress - The wallet address to look up
   * @returns {Array<Object>} Array of profile objects (may be empty)
   */
  async getAllProfilesForWallet(walletAddress) {
    const profiles = [];
    const seenProfileIds = new Set();

    if (this.verbose) {
      console.log(`   🔍 Looking up profiles for ${walletAddress}...`);
    }

    try {
      // Method 1: Try AO registry first (may return multiple profiles)
      const profileLookup = await this.readHandler({
        processId: this.profileRegistry,
        action: "Get-Profiles-By-Delegate",
        data: { Address: walletAddress },
      });

      if (
        profileLookup &&
        Array.isArray(profileLookup) &&
        profileLookup.length > 0
      ) {
        if (this.verbose) {
          console.log(
            `      ✓ AO registry returned ${profileLookup.length} profile(s)`,
          );
        }
        for (const entry of profileLookup) {
          if (entry.ProfileId && !seenProfileIds.has(entry.ProfileId)) {
            seenProfileIds.add(entry.ProfileId);
            let profile = await this.getProfileById(entry.ProfileId);

            // Even if we can't fetch profile details, create a stub profile
            // The profile process exists and can hold assets, so include it
            if (!profile) {
              if (this.verbose) {
                console.log(
                  `      ⚠️ Could not fetch details for ${entry.ProfileId}, creating stub profile`,
                );
              }
              profile = {
                id: entry.ProfileId,
                profileId: entry.ProfileId,
                walletAddress: walletAddress,
                username: null,
                displayName: null,
                description: null,
                thumbnail: null,
                banner: null,
                assets: [],
                isStub: true, // Mark as stub for reference
              };
            }

            profile.walletAddress = walletAddress;
            profile.discoveredAt = new Date();
            profiles.push(profile);

            // Persist to Cassandra
            if (this.cassandraService) {
              try {
                await this.cassandraService.saveProfile(profile);
              } catch (saveError) {
                // Continue even if save fails
              }
            }
          }
        }
      }
    } catch (aoError) {
      if (this.verbose) {
        console.log(`      ⚠️ AO registry error: ${aoError.message}`);
      }
    }

    // Method 2: GraphQL fallback - find profiles via Create-Profile transactions
    try {
      if (this.verbose && profiles.length === 0) {
        console.log(`      ℹ️ Trying GraphQL fallback...`);
      }

      const gqlProfileIds = await this.findAllProfilesViaGraphQL(walletAddress);

      for (const profileId of gqlProfileIds) {
        if (!seenProfileIds.has(profileId)) {
          seenProfileIds.add(profileId);
          let profile = await this.getProfileById(profileId);

          // Even if we can't fetch profile details, create a stub profile
          // The profile process exists and can hold assets, so include it
          if (!profile) {
            if (this.verbose) {
              console.log(
                `      ⚠️ Could not fetch details for ${profileId}, creating stub profile`,
              );
            }
            profile = {
              id: profileId,
              profileId: profileId,
              walletAddress: walletAddress,
              username: null,
              displayName: null,
              description: null,
              thumbnail: null,
              banner: null,
              assets: [],
              isStub: true, // Mark as stub for reference
            };
          }

          profile.walletAddress = walletAddress;
          profile.discoveredAt = new Date();
          profiles.push(profile);

          // Persist to Cassandra
          if (this.cassandraService) {
            try {
              await this.cassandraService.saveProfile(profile);
            } catch (saveError) {
              // Continue even if save fails
            }
          }
        }
      }
    } catch (gqlError) {
      if (this.verbose) {
        console.log(`      ⚠️ GraphQL fallback error: ${gqlError.message}`);
      }
    }

    if (this.verbose) {
      console.log(`      📊 Total profiles found: ${profiles.length}`);
    }

    return profiles;
  }

  /**
   * Get batch profile metadata from the registry
   *
   * @param {Array<string>} profileIds - Array of profile IDs
   * @returns {Array<Object>} Array of profile metadata
   */
  async getRegistryProfiles(profileIds) {
    try {
      const metadataLookup = await this.readHandler({
        processId: this.profileRegistry,
        action: "Get-Metadata-By-ProfileIds",
        data: { ProfileIds: profileIds },
      });

      if (!metadataLookup || !metadataLookup.length) {
        return [];
      }

      return profileIds.map((profileId) => {
        const profile = metadataLookup.find((p) => p.ProfileId === profileId);
        return {
          id: profile?.ProfileId || profileId,
          username: profile?.Username || null,
          thumbnail: profile?.ProfileImage || null,
          description: profile?.Description || null,
        };
      });
    } catch (error) {
      if (this.verbose) {
        console.log(`❌ Error fetching registry profiles: ${error.message}`);
      }
      return [];
    }
  }

  /**
   * Get all wallet addresses that should be checked for transactions,
   * including discovered profile IDs.
   *
   * @param {Array<string>} baseWallets - Original wallet addresses
   * @returns {Object} Object containing all addresses and profile mapping
   */
  async getExpandedWalletSet(baseWallets) {
    const profiles = await this.discoverProfiles(baseWallets);

    // Create a comprehensive wallet set
    const result = {
      // All addresses to check (wallets + profile IDs)
      allAddresses: [...baseWallets],
      // Original wallets
      baseWallets: baseWallets,
      // Profile IDs only
      profileIds: [],
      // Mapping of profile ID to parent wallet
      profileToWallet: {},
      // Mapping of wallet to profile ID
      walletToProfile: {},
      // Full profile objects
      profiles: profiles,
    };

    for (const profile of profiles) {
      result.allAddresses.push(profile.profileId);
      result.profileIds.push(profile.profileId);
      result.profileToWallet[profile.profileId] = profile.parentWallet;
      result.walletToProfile[profile.parentWallet] = profile.profileId;
    }

    if (this.verbose && profiles.length > 0) {
      console.log(
        `\n📦 Expanded wallet set: ${baseWallets.length} wallets + ${profiles.length} profiles = ${result.allAddresses.length} total addresses`,
      );
    }

    return result;
  }

  /**
   * Determine if a transfer between two addresses is internal
   * (between a wallet and its own profile, or between profiles of the same wallet)
   *
   * @param {string} fromAddress - Sender address
   * @param {string} toAddress - Receiver address
   * @param {Object} walletSet - Result from getExpandedWalletSet
   * @returns {boolean} True if transfer is internal
   */
  isInternalTransfer(fromAddress, toAddress, walletSet) {
    // Check if both are controlled by the same base wallet

    // Get the base wallet for each address
    const fromBase =
      walletSet.profileToWallet[fromAddress] ||
      (walletSet.baseWallets.includes(fromAddress) ? fromAddress : null);
    const toBase =
      walletSet.profileToWallet[toAddress] ||
      (walletSet.baseWallets.includes(toAddress) ? toAddress : null);

    // If both belong to the same base wallet, it's internal
    if (fromBase && toBase && fromBase === toBase) {
      return true;
    }

    // If from is a profile and to is its parent wallet (or vice versa)
    if (walletSet.profileToWallet[fromAddress] === toAddress) return true;
    if (walletSet.profileToWallet[toAddress] === fromAddress) return true;

    return false;
  }

  /**
   * Save a profile transaction to Cassandra
   *
   * @param {string} profileId - Profile's AO process ID
   * @param {Object} transaction - Transaction data
   * @param {string} parentWallet - Parent wallet address
   */
  async saveProfileTransaction(profileId, transaction, parentWallet) {
    if (!this.cassandraService) {
      throw new Error("CassandraService required to save profile transactions");
    }

    await this.cassandraService.saveProfileTransaction({
      profileId,
      blockTimestamp: transaction.blockTimestamp || transaction.timestamp,
      txId: transaction.txId,
      parentWallet,
      type: transaction.type,
      tokenSymbol: transaction.tokenSymbol,
      amountUnits: transaction.amountUnits,
      amountHuman: transaction.amountHuman,
      priceUSD: transaction.priceUSD,
      valueUSD: transaction.valueUSD,
      counterparty:
        transaction.counterparty ||
        transaction.targetAddress ||
        transaction.ownerAddress,
      isInternal: transaction.isInternalTransfer || false,
      source: transaction.source || "ao",
    });
  }

  /**
   * Get profile transactions from Cassandra
   *
   * @param {string} profileId - Profile's AO process ID
   * @param {Object} options - Query options (startDate, endDate)
   * @returns {Object[]} Array of transactions
   */
  async getProfileTransactions(profileId, options = {}) {
    if (!this.cassandraService) {
      return [];
    }

    return await this.cassandraService.getProfileTransactions(
      profileId,
      options,
    );
  }

  /**
   * Load all known profiles from Cassandra
   * Useful for startup to avoid re-querying AO
   *
   * @returns {Object[]} Array of cached profiles
   */
  async loadCachedProfiles() {
    if (!this.cassandraService) {
      return [];
    }

    try {
      return await this.cassandraService.getAllActiveProfiles();
    } catch (error) {
      if (this.verbose) {
        console.log(`⚠️ Failed to load cached profiles: ${error.message}`);
      }
      return [];
    }
  }

  /**
   * Get profiles for wallets, using cache when possible
   * This is the recommended method for report generation
   *
   * @param {string[]} walletAddresses - Wallet addresses to check
   * @param {Object} options - Options
   * @param {boolean} options.cacheOnly - Only use cached data, no network calls
   * @returns {Object} Wallet set with profiles
   */
  async getExpandedWalletSetCached(walletAddresses, options = {}) {
    const cacheOnly = options.cacheOnly || false;

    if (this.verbose) {
      console.log(
        `\n🔍 Loading profiles for ${walletAddresses.length} wallet(s)${
          cacheOnly ? " (cache only)" : ""
        }...`,
      );
    }

    // First, try to load from Cassandra
    let cachedProfiles = [];
    if (this.cassandraService) {
      cachedProfiles =
        await this.cassandraService.getProfilesForWallets(walletAddresses);
      if (this.verbose && cachedProfiles.length > 0) {
        console.log(`   📦 Found ${cachedProfiles.length} cached profile(s)`);
      }
    }

    // Find wallets without cached profiles
    const cachedWallets = new Set(cachedProfiles.map((p) => p.walletAddress));
    const uncachedWallets = walletAddresses.filter(
      (w) => !cachedWallets.has(w),
    );

    // Discover profiles for uncached wallets (from AO) - SKIP if cacheOnly
    let newProfiles = [];
    if (uncachedWallets.length > 0 && !this.forceRefresh && !cacheOnly) {
      if (this.verbose) {
        console.log(
          `   🔍 Checking ${uncachedWallets.length} wallet(s) in AO...`,
        );
      }
      const discovered = await this.discoverProfiles(uncachedWallets);
      newProfiles = discovered;
    } else if (cacheOnly && uncachedWallets.length > 0 && this.verbose) {
      console.log(
        `   ⏭️  Skipping AO discovery for ${uncachedWallets.length} uncached wallet(s) (cache only mode)`,
      );
    }

    // Combine all profiles
    const allProfiles = [...cachedProfiles, ...newProfiles];

    // Build the wallet set
    const result = {
      allAddresses: [...walletAddresses],
      baseWallets: walletAddresses,
      profileIds: [],
      profileToWallet: {},
      walletToProfile: {},
      profiles: allProfiles.map((p) => ({
        parentWallet: p.walletAddress,
        profileId: p.id,
        username: p.username,
        displayName: p.displayName,
        version: p.version,
        assetCount: p.assetCount || 0,
        isAOOnly: true,
        profileType: "BAZAR_PROFILE",
      })),
    };

    for (const profile of result.profiles) {
      result.allAddresses.push(profile.profileId);
      result.profileIds.push(profile.profileId);
      result.profileToWallet[profile.profileId] = profile.parentWallet;
      result.walletToProfile[profile.parentWallet] = profile.profileId;
    }

    if (this.verbose) {
      console.log(
        `   📊 Total: ${walletAddresses.length} wallets + ${result.profiles.length} profiles = ${result.allAddresses.length} addresses`,
      );
    }

    return result;
  }

  /**
   * Index all AO token transactions for discovered profiles
   * This should be called after profile discovery to ensure
   * all profile transactions are captured for tax reporting.
   *
   * @param {Object[]} profiles - Array of profile objects with profileId and parentWallet
   * @param {Object} fetcher - AOTokenTransferFetcher instance
   * @param {Object} options - Fetch options (minBlock, fullHistory, etc.)
   * @returns {Object} Results with transaction counts per profile
   */
  async indexProfileTransactions(profiles, fetcher, options = {}) {
    if (!profiles || profiles.length === 0) {
      return { totalTransactions: 0, byProfile: {} };
    }

    if (this.verbose) {
      console.log(
        `\n📋 Indexing transactions for ${profiles.length} profile(s)...`,
      );
    }

    const results = {
      totalTransactions: 0,
      byProfile: {},
    };

    for (const profile of profiles) {
      const profileId = profile.profileId || profile.id;
      const parentWallet = profile.parentWallet || profile.walletAddress;

      if (!profileId) continue;

      if (this.verbose) {
        console.log(
          `   → ${profile.username || profileId.substring(0, 12)}...`,
        );
      }

      try {
        // Get minBlock from Cassandra state (incremental indexing)
        let minBlock = null;
        if (!options.fullHistory && this.cassandraService) {
          const state = await this.cassandraService.getIndexerState(
            profileId,
            "ao_token",
          );
          if (state && state.lastIndexedBlock) {
            minBlock = state.lastIndexedBlock + 1;
            if (this.verbose) {
              console.log(
                `     📍 Incremental: starting from block ${minBlock}`,
              );
            }
          }
        }

        // Fetch AO token transfers for the profile process ID
        const fetchOptions = {
          ...options,
          minBlock: minBlock,
          ownedWallets: [profileId, parentWallet],
        };

        const result = await fetcher.fetchCompleteHistory(
          profileId,
          fetchOptions,
        );
        const transfers = result.transfers || [];

        if (transfers.length > 0) {
          // Track highest block for state update
          let highestBlockFetched = 0;

          // Save transactions to profile_transactions table
          for (const transfer of transfers) {
            if (
              transfer.blockHeight &&
              transfer.blockHeight > highestBlockFetched
            ) {
              highestBlockFetched = transfer.blockHeight;
            }

            await this.saveProfileTransaction(profileId, parentWallet, {
              txId: transfer.txId,
              blockTimestamp: transfer.blockTimestamp,
              type: transfer.direction || transfer.type,
              tokenSymbol: transfer.tokenSymbol,
              amountUnits: transfer.amountUnits,
              amountHuman: transfer.amountHuman,
              priceUSD: transfer.priceUSD,
              valueUSD: transfer.valueUSD,
              counterparty:
                transfer.counterparty ||
                transfer.targetAddress ||
                transfer.ownerAddress,
              isInternal: transfer.isInternalTransfer || false,
              source: "ao",
            });
          }

          // Save indexer state
          if (this.cassandraService && highestBlockFetched > 0) {
            await this.cassandraService.saveIndexerState(
              profileId,
              "ao_token",
              {
                lastIndexedBlock: highestBlockFetched,
                lastIndexedTimestamp: new Date(),
                transactionCount: transfers.length,
              },
            );
          }

          // Update profile last transaction timestamp
          const latestTimestamp = Math.max(
            ...transfers.map((t) => t.blockTimestamp || 0),
          );
          if (this.cassandraService && latestTimestamp > 0) {
            await this.cassandraService.updateProfileLastTransaction(
              profileId,
              new Date(latestTimestamp * 1000),
            );
          }

          if (this.verbose) {
            console.log(`     ✓ Indexed ${transfers.length} transactions`);
          }
        } else {
          if (this.verbose) {
            console.log(`     ○ No new transactions`);
          }
        }

        results.byProfile[profileId] = {
          username: profile.username,
          transactionCount: transfers.length,
          parentWallet: parentWallet,
        };
        results.totalTransactions += transfers.length;
      } catch (error) {
        if (this.verbose) {
          console.log(`     ⚠️ Error: ${error.message}`);
        }
        results.byProfile[profileId] = {
          username: profile.username,
          error: error.message,
          transactionCount: 0,
          parentWallet: parentWallet,
        };
      }
    }

    if (this.verbose) {
      console.log(
        `\n   📊 Total profile transactions indexed: ${results.totalTransactions}`,
      );
    }

    return results;
  }

  /**
   * Get all transactions for profiles (from Cassandra cache)
   * These should be merged with the main transaction list for reports
   *
   * @param {Object[]} profiles - Array of profile objects
   * @param {Object} options - Query options (startDate, endDate)
   * @returns {Object[]} Array of transactions in unified format
   */
  async getAllProfileTransactionsUnified(profiles, options = {}) {
    if (!this.cassandraService || !profiles || profiles.length === 0) {
      return [];
    }

    const allTransactions = [];

    for (const profile of profiles) {
      const profileId = profile.profileId || profile.id;
      const parentWallet = profile.parentWallet || profile.walletAddress;

      if (!profileId) continue;

      const transactions = await this.cassandraService.getProfileTransactions(
        profileId,
        options,
      );

      // Transform to unified format with profile context
      for (const tx of transactions) {
        allTransactions.push({
          ...tx,
          walletAddress: profileId, // Use profile ID as wallet for matching
          parentWalletAddress: parentWallet, // Track parent for grouping
          isProfileTransaction: true,
          profileUsername: profile.username,
          profileDisplayName: profile.displayName,
          source: "bazar_profile",
        });
      }
    }

    // Sort by timestamp descending
    allTransactions.sort(
      (a, b) => (b.blockTimestamp || 0) - (a.blockTimestamp || 0),
    );

    return allTransactions;
  }

  // Cache management
  isCacheValid(key) {
    const expiry = this.cacheExpiry.get(key);
    return expiry && Date.now() < expiry;
  }

  setCache(key, value) {
    this.profileCache.set(key, value);
    this.cacheExpiry.set(key, Date.now() + this.cacheTTL);
  }

  clearCache() {
    this.profileCache.clear();
    this.cacheExpiry.clear();
  }
}

module.exports = {
  BazarProfileService,
  AO_CONFIG,
  PROFILE_VERSIONS,
};
