/**
 * Wallet group indexer - runs full indexing (genesis) for a wallet group.
 * Used by POST /api/admin/wallet-groups/:groupId/index and by Stripe webhook
 * when a new Full Tax Report subscription creates a wallet group.
 *
 * Exports: runWalletGroupIndexing(groupId, { fullHistory })
 */

const CONFIG = require("../../config/database");
const {
  CassandraArTrackerService,
} = require("./ar-tracker/CassandraArTrackerService");
const { BazarProfileService } = require("./ar-tracker/BazarProfileService");
const {
  UnifiedWalletHistoryService,
} = require("./ar-tracker/UnifiedWalletHistoryService");
const { DistributionService } = require("./ar-tracker/DistributionService");
const { PriceService } = require("./ar-tracker/PriceService");
const { CostBasisService } = require("./ar-tracker/CostBasisService");

/**
 * Run full indexing for a wallet group (transactions from genesis, distributions, cost basis).
 * Updates group status to "indexing" then "active" or "error".
 * Call without await to run in background (e.g. from webhook).
 *
 * @param {string} groupId - Wallet group ID
 * @param {{ fullHistory?: boolean }} options - fullHistory: true to index from genesis (default false)
 * @returns {Promise<void>}
 */
async function runWalletGroupIndexing(groupId, options = {}) {
  const { fullHistory = false } = options;
  const cassandraService = new CassandraArTrackerService();
  const indexStartTime = Date.now();

  try {
    await cassandraService.connect();
    const group = await cassandraService.getWalletGroup(groupId);
    if (!group) {
      console.warn(`[walletGroupIndexer] Group not found: ${groupId}`);
      return;
    }

    await cassandraService.updateWalletGroup(groupId, {
      status: "indexing",
      lastIndexStatus: "running",
      lastIndexError: null,
    });

    console.log(
      `📊 Starting index for group ${groupId} (${group.wallets.length} wallets), fullHistory=${fullHistory}`,
    );

    // Phase 0: Profile discovery
    console.log(`👤 Phase 0: Discovering Bazar profiles...`);
    const bazarProfileService = new BazarProfileService({
      cassandraService,
      verbose: true,
      forceRefresh: fullHistory,
    });
    let discoveredProfiles = [];
    try {
      const walletSet = await bazarProfileService.getExpandedWalletSet(
        group.wallets,
      );
      discoveredProfiles = walletSet.profiles || [];
      if (discoveredProfiles.length > 0) {
        console.log(
          `   ✅ Found ${discoveredProfiles.length} Bazar profile(s)`,
        );
      } else {
        console.log(`   ℹ️ No Bazar profiles found for these wallets`);
      }
    } catch (profileDiscoveryError) {
      console.log(
        `   ⚠️ Profile discovery error (continuing): ${profileDiscoveryError.message}`,
      );
    }

    const profileIds = discoveredProfiles.map((p) => p.profileId);
    const expandedWallets = [...group.wallets, ...profileIds];
    console.log(
      `📦 Expanded wallet set: ${group.wallets.length} wallets + ${profileIds.length} profiles = ${expandedWallets.length} total addresses`,
    );

    // Phase 1: Fetch transaction history
    console.log(
      `📦 Phase 1: Fetching transaction history for all addresses...`,
    );
    const historyService = new UnifiedWalletHistoryService({
      cassandraService,
      fullHistory,
    });
    const results = await historyService.fetchCompleteHistory(expandedWallets, {
      fullHistory,
    });
    console.log(
      `📦 Phase 1 complete: ${results.unified?.length || 0} base transactions`,
    );

    // Phase 2: Fetch distributions
    console.log(`📦 Phase 2: Fetching distributions...`);
    const distributionService = new DistributionService({ verbose: true });
    await distributionService.connect();
    const distributions =
      await distributionService.fetchDistributionsForWallets(group.wallets, {});
    await distributionService.disconnect();
    console.log(`📦 Phase 2 complete: ${distributions.length} distributions`);

    if (distributions.length > 0) {
      console.log(
        `💾 Saving ${distributions.length} distributions to database...`,
      );
      let savedCount = 0;
      let skipCount = 0;
      for (const dist of distributions) {
        const txId =
          dist.txId ||
          `dist_${dist.walletAddress?.substring(0, 8)}_${dist.timestamp}_${dist.token}_${Math.random().toString(36).substring(2, 8)}`;
        const normalizedDist = {
          ...dist,
          txId,
          blockTimestamp: dist.timestamp,
          tokenSymbol: dist.token,
          source: dist.source || "distribution",
        };
        const saved =
          await cassandraService.saveUnifiedTransactionOriginal(normalizedDist);
        if (saved) savedCount++;
        else skipCount++;
      }
      console.log(
        `💾 Saved ${savedCount} new distributions (${skipCount} duplicates skipped)`,
      );
    }

    const txMap = new Map();
    const profileLookup = new Map();
    for (const profile of discoveredProfiles) {
      profileLookup.set(profile.profileId, profile);
    }
    for (const tx of results.unified || []) {
      const key =
        tx.txId ||
        `${tx.walletAddress}-${tx.blockTimestamp}-${tx.token}-${tx.amount}`;
      const profile = profileLookup.get(tx.walletAddress);
      if (profile) {
        tx.isProfileTransaction = true;
        tx.profileId = profile.profileId;
        tx.profileUsername = profile.username;
        tx.profileDisplayName = profile.displayName;
        tx.parentWallet = profile.parentWallet;
      }
      txMap.set(key, tx);
    }
    for (const dist of distributions) {
      const key =
        dist.txId ||
        `${dist.walletAddress}-${dist.timestamp}-${dist.token}-${dist.amount}`;
      if (!txMap.has(key)) {
        txMap.set(key, {
          ...dist,
          blockTimestamp: dist.timestamp,
          tokenSymbol: dist.token,
        });
      }
    }

    const allTransactions = Array.from(txMap.values()).sort(
      (a, b) =>
        (a.blockTimestamp || a.timestamp || 0) -
        (b.blockTimestamp || b.timestamp || 0),
    );
    const profileTxCount = allTransactions.filter(
      (tx) => tx.isProfileTransaction,
    ).length;
    console.log(
      `📊 Merged: ${allTransactions.length} total transactions (${profileTxCount} from ${discoveredProfiles.length} profiles)`,
    );

    // Phase 3: Enrich with prices
    console.log(`💰 Phase 3: Enriching with prices...`);
    const priceService = new PriceService({
      keyspace: CONFIG.PRICE_DB.keyspace,
      contactPoints: CONFIG.PRICE_DB.contactPoints,
      localDataCenter: CONFIG.PRICE_DB.localDataCenter,
    });
    await priceService.connect();
    await priceService.enrichWithPrices(allTransactions);
    console.log(`💰 Phase 3 complete: Prices enriched`);

    // Phase 4: Process cost basis
    console.log(`📈 Phase 4: Processing cost basis...`);
    const costBasisService = new CostBasisService({
      cassandraService,
      verbose: true,
    });
    const costBasisResults = await costBasisService.processTransactions(
      allTransactions,
      expandedWallets,
      priceService,
    );
    await priceService.disconnect();
    console.log(`📈 Phase 4 complete:`);
    console.log(`   Lots created: ${costBasisResults.lotsCreated || 0}`);
    console.log(
      `   Disposals recorded: ${costBasisResults.disposalsRecorded || 0}`,
    );

    const indexDuration = Math.round((Date.now() - indexStartTime) / 1000);
    await cassandraService.updateWalletGroup(groupId, {
      status: "active",
      lastIndexedAt: new Date(),
      lastIndexStatus: "completed",
      lastIndexError: null,
      transactionCount: allTransactions.length,
    });

    const profileInfo =
      discoveredProfiles.length > 0
        ? `, ${discoveredProfiles.length} profiles (${profileTxCount} profile txs)`
        : "";
    console.log(
      `✅ Index completed for group ${groupId}: ${allTransactions.length} transactions, ${costBasisResults.lotsCreated || 0} tax lots${profileInfo} (${indexDuration}s)`,
    );
  } catch (error) {
    console.error(`❌ Index failed for group ${groupId}:`, error);
    try {
      await cassandraService.updateWalletGroup(groupId, {
        status: "error",
        lastIndexStatus: "error",
        lastIndexError: error.message,
      });
    } catch (updateErr) {
      console.error("Failed to update group error status:", updateErr.message);
    }
  } finally {
    try {
      await cassandraService.disconnect();
    } catch (_) {}
  }
}

module.exports = { runWalletGroupIndexing };
