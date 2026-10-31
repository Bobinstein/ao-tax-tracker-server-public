/**
 * Unified Wallet History Service
 *
 * Integrates all fetchers to provide complete wallet history:
 * - AR L1 transactions (ARHistoryFetcher)
 * - AO Token transfers (AOTokenTransferFetcher)
 * - DEX swaps (DEXSwapFetcher)
 *
 * Normalizes all transactions into UnifiedTransaction format for
 * consistent tax reporting and cost basis calculation.
 *
 * @module services/UnifiedWalletHistoryService
 */

const { WalletIdentity } = require("../../models/ar-tracker/WalletIdentity");
const {
  UnifiedTransaction,
} = require("../../models/ar-tracker/UnifiedTransaction");
const { ARHistoryFetcher } = require("./ARHistoryFetcher");
const {
  AOTokenTransferFetcher,
} = require("../../fetchers/ar-tracker/AOTokenTransferFetcher");
const { DEXSwapFetcher } = require("../../fetchers/ar-tracker/DEXSwapFetcher");
const { ARIOInteractionFetcher } = require("./ARIOInteractionFetcher");
const CONSTANTS = require("../../../config/ar-tracker-constants");

class UnifiedWalletHistoryService {
  constructor(options = {}) {
    this.walletIdentity = null;

    // Initialize fetchers
    this.arFetcher = new ARHistoryFetcher(options);
    this.aoFetcher = new AOTokenTransferFetcher(options);
    this.dexFetcher = new DEXSwapFetcher(options);
    this.arioFetcher = new ARIOInteractionFetcher(options);

    // Cassandra service for state management
    this.cassandraService = options.cassandraService || null;

    // Options
    this.options = {
      fetchARTransactions: options.fetchARTransactions !== false,
      fetchAOTokens: options.fetchAOTokens !== false,
      fetchDEXSwaps: options.fetchDEXSwaps !== false,
      fetchARIOInteractions: options.fetchARIOInteractions !== false,
      fetchTransferResults: options.fetchTransferResults !== false,
      normalizeTransactions: options.normalizeTransactions !== false,
      fullHistory: options.fullHistory || false,
      ...options,
    };
  }

  /**
   * Set wallet identity for multi-wallet support
   */
  setWalletIdentity(identityOrWallets) {
    if (identityOrWallets instanceof WalletIdentity) {
      this.walletIdentity = identityOrWallets;
    } else if (Array.isArray(identityOrWallets)) {
      this.walletIdentity = new WalletIdentity({
        wallets: identityOrWallets,
        primaryWallet: identityOrWallets[0],
      });
    } else {
      this.walletIdentity = new WalletIdentity({
        wallets: [identityOrWallets],
        primaryWallet: identityOrWallets,
      });
    }

    // Pass to fetchers
    this.aoFetcher.ownedWallets = this.walletIdentity.wallets;
    this.dexFetcher.ownedWallets = this.walletIdentity.wallets;
  }

  /**
   * Fetch complete wallet history from all sources
   */
  async fetchCompleteHistory(walletAddressOrAddresses, options = {}) {
    // Handle input
    const walletAddresses = Array.isArray(walletAddressOrAddresses)
      ? walletAddressOrAddresses
      : [walletAddressOrAddresses];

    const primaryWallet = walletAddresses[0];

    // Set up wallet identity
    this.setWalletIdentity(walletAddresses);

    console.log("╔" + "═".repeat(68) + "╗");
    console.log(
      "║" + " ".repeat(20) + "UNIFIED WALLET HISTORY" + " ".repeat(26) + "║",
    );
    console.log("╠" + "═".repeat(68) + "╣");
    console.log(`║ Primary Wallet: ${primaryWallet.substring(0, 43)}...║`);
    if (walletAddresses.length > 1) {
      console.log(
        `║ Additional Wallets: ${walletAddresses.length - 1}` +
          " ".repeat(43 - String(walletAddresses.length - 1).length) +
          "║",
      );
    }
    console.log("╚" + "═".repeat(68) + "╝");
    console.log();

    const results = {
      wallet: primaryWallet,
      wallets: walletAddresses,
      walletIdentity: this.walletIdentity
        ? {
            userId: this.walletIdentity.userId,
            wallets: this.walletIdentity.wallets,
          }
        : null,
      fetchedAt: new Date().toISOString(),
      raw: {
        arL1: { transactions: [] },
        aoTokens: { transfers: [] },
        dex: {
          permaswap: [],
          botega: [],
          agents: [],
          bazar: [],
          vento: [],
        },
        ario: { interactions: [] },
      },
      unified: [],
      summary: {},
    };

    // ============================================================
    // Fetch AR L1 Transactions (with incremental support)
    // ============================================================
    if (this.options.fetchARTransactions) {
      console.log("┌" + "─".repeat(58) + "┐");
      console.log("│ PHASE 1: AR L1 TRANSACTIONS" + " ".repeat(30) + "│");
      console.log("└" + "─".repeat(58) + "┘");

      try {
        const allL1Transactions = [];
        let highestBlockFetched = 0;

        for (const wallet of walletAddresses) {
          // Get minBlock from Cassandra state (incremental indexing)
          let minBlock = null;
          if (!this.options.fullHistory && this.cassandraService) {
            const state = await this.cassandraService.getIndexerState(
              wallet,
              "ar_l1",
            );
            if (state && state.lastIndexedBlock) {
              minBlock = state.lastIndexedBlock + 1; // Start from next block
              console.log(
                `   📍 Incremental mode for ${wallet.substring(
                  0,
                  12,
                )}...: starting from block ${minBlock}`,
              );
            }
          }

          const fetchOptions = {
            ownedWallets: walletAddresses,
            minBlock: minBlock,
            ...options,
          };

          const walletTxs = await this.arFetcher.fetchCompleteHistory(
            wallet,
            fetchOptions,
          );

          allL1Transactions.push(...(walletTxs || []));

          // Track highest block for state update
          for (const tx of walletTxs || []) {
            if (tx.blockHeight && tx.blockHeight > highestBlockFetched) {
              highestBlockFetched = tx.blockHeight;
            }
          }

          // Save indexer state for this wallet
          if (this.cassandraService && highestBlockFetched > 0) {
            await this.cassandraService.saveIndexerState(wallet, "ar_l1", {
              lastIndexedBlock: highestBlockFetched,
              lastIndexedTimestamp: new Date(),
              transactionCount: walletTxs?.length || 0,
            });
          }
        }

        // Deduplicate by txId
        const seenTxIds = new Set();
        results.raw.arL1.transactions = allL1Transactions.filter((tx) => {
          if (seenTxIds.has(tx.txId)) return false;
          seenTxIds.add(tx.txId);
          return true;
        });
      } catch (error) {
        console.error(`❌ AR L1 fetch failed: ${error.message}`);
        results.raw.arL1.error = error.message;
      }
      console.log();
    }

    // ============================================================
    // Fetch AO Token Transfers (for ALL wallets)
    // ============================================================
    if (this.options.fetchAOTokens) {
      console.log("┌" + "─".repeat(58) + "┐");
      console.log("│ PHASE 2: AO TOKEN TRANSFERS" + " ".repeat(30) + "│");
      console.log("└" + "─".repeat(58) + "┘");

      try {
        // Fetch for ALL wallets
        const allAOTransfers = [];
        const seenTxIds = new Set();

        for (const wallet of walletAddresses) {
          console.log(
            `\n--- Wallet ${walletAddresses.indexOf(wallet) + 1}/${
              walletAddresses.length
            }: ${wallet.substring(0, 12)}... ---`,
          );

          // Get minBlock from Cassandra state (incremental indexing)
          let minBlock = null;
          if (!this.options.fullHistory && this.cassandraService) {
            const state = await this.cassandraService.getIndexerState(
              wallet,
              "ao_token",
            );
            if (state && state.lastIndexedBlock) {
              minBlock = state.lastIndexedBlock + 1; // Start from next block
              console.log(
                `   📍 Incremental mode: starting from block ${minBlock}`,
              );
            }
          }

          const aoResult = await this.aoFetcher.fetchCompleteHistory(wallet, {
            ownedWallets: walletAddresses,
            fetchResults: this.options.fetchTransferResults,
            minBlock: minBlock,
            ...options,
          });

          // Track highest block for state update
          let highestBlockFetched = 0;
          for (const transfer of aoResult.transfers || []) {
            if (
              transfer.blockHeight &&
              transfer.blockHeight > highestBlockFetched
            ) {
              highestBlockFetched = transfer.blockHeight;
            }
          }

          // Save indexer state for this wallet
          if (this.cassandraService && highestBlockFetched > 0) {
            await this.cassandraService.saveIndexerState(wallet, "ao_token", {
              lastIndexedBlock: highestBlockFetched,
              lastIndexedTimestamp: new Date(),
              transactionCount: aoResult.transfers?.length || 0,
            });
          }

          // Deduplicate (same tx may appear in both wallets for internal transfers)
          for (const transfer of aoResult.transfers || []) {
            if (!seenTxIds.has(transfer.txId)) {
              seenTxIds.add(transfer.txId);
              allAOTransfers.push(transfer);
            }
          }
        }

        results.raw.aoTokens = {
          wallet: primaryWallet,
          wallets: walletAddresses,
          transfers: allAOTransfers,
          summary: { total: allAOTransfers.length },
        };

        console.log(
          `\n   📊 Total AO transfers across all wallets: ${allAOTransfers.length}`,
        );
      } catch (error) {
        console.error(`❌ AO Token fetch failed: ${error.message}`);
        results.raw.aoTokens.error = error.message;
      }
      console.log();
    }

    // ============================================================
    // Fetch DEX Activity (for ALL wallets)
    // ============================================================
    if (this.options.fetchDEXSwaps) {
      console.log("┌" + "─".repeat(58) + "┐");
      console.log("│ PHASE 3: DEX ACTIVITY" + " ".repeat(36) + "│");
      console.log("└" + "─".repeat(58) + "┘");

      try {
        // Aggregate DEX activity from ALL wallets
        const aggregatedDex = {
          permaswap: [],
          botega: [],
          agents: [],
          bazar: [],
          vento: [],
        };
        const seenTxIds = new Set();

        for (const wallet of walletAddresses) {
          console.log(
            `\n--- Wallet ${walletAddresses.indexOf(wallet) + 1}/${
              walletAddresses.length
            }: ${wallet.substring(0, 12)}... ---`,
          );

          // Get minBlock from Cassandra state (incremental indexing)
          let minBlock = null;
          if (!this.options.fullHistory && this.cassandraService) {
            const state = await this.cassandraService.getIndexerState(
              wallet,
              "dex",
            );
            if (state && state.lastIndexedBlock) {
              minBlock = state.lastIndexedBlock + 1;
              console.log(
                `   📍 Incremental mode: starting from block ${minBlock}`,
              );
            }
          }

          const dexResult = await this.dexFetcher.fetchAllDEXActivity(wallet, {
            ownedWallets: walletAddresses,
            minBlock: minBlock,
            ...options,
          });

          // Track highest block for state update
          let highestBlockFetched = 0;

          // Merge results with deduplication
          for (const platform of [
            "permaswap",
            "botega",
            "agents",
            "bazar",
            "vento",
          ]) {
            for (const tx of dexResult[platform] || []) {
              if (!seenTxIds.has(tx.txId)) {
                seenTxIds.add(tx.txId);
                aggregatedDex[platform].push(tx);

                if (tx.blockHeight && tx.blockHeight > highestBlockFetched) {
                  highestBlockFetched = tx.blockHeight;
                }
              }
            }
          }

          // Save indexer state for this wallet
          if (this.cassandraService && highestBlockFetched > 0) {
            const totalDexTxs = Object.values(dexResult).flat().length;
            await this.cassandraService.saveIndexerState(wallet, "dex", {
              lastIndexedBlock: highestBlockFetched,
              lastIndexedTimestamp: new Date(),
              transactionCount: totalDexTxs,
            });
          }
        }

        results.raw.dex = {
          wallet: primaryWallet,
          wallets: walletAddresses,
          ...aggregatedDex,
        };

        const totalDex =
          aggregatedDex.permaswap.length +
          aggregatedDex.botega.length +
          aggregatedDex.agents.length +
          aggregatedDex.bazar.length +
          aggregatedDex.vento.length;
        console.log(
          `\n   📊 Total DEX activity across all wallets: ${totalDex}`,
        );
      } catch (error) {
        console.error(`❌ DEX fetch failed: ${error.message}`);
        results.raw.dex.error = error.message;
      }
      console.log();
    }

    // ============================================================
    // Fetch ARIO Contract Interactions (ArNS, Staking)
    // ============================================================
    if (this.options.fetchARIOInteractions) {
      console.log("┌" + "─".repeat(58) + "┐");
      console.log(
        "│ PHASE 4: ARIO CONTRACT INTERACTIONS" + " ".repeat(20) + "│",
      );
      console.log("└" + "─".repeat(58) + "┘");

      try {
        const allARIOInteractions = [];
        const seenTxIds = new Set();

        for (const wallet of walletAddresses) {
          console.log(
            `\n--- Wallet ${walletAddresses.indexOf(wallet) + 1}/${
              walletAddresses.length
            }: ${wallet.substring(0, 12)}... ---`,
          );

          // Get minBlock from Cassandra state (incremental indexing)
          let minBlock = null;
          if (!this.options.fullHistory && this.cassandraService) {
            const state = await this.cassandraService.getIndexerState(
              wallet,
              "ario",
            );
            if (state && state.lastIndexedBlock) {
              minBlock = state.lastIndexedBlock + 1;
              console.log(
                `   📍 Incremental mode: starting from block ${minBlock}`,
              );
            }
          }

          const arioInteractions = await this.arioFetcher.fetchInteractions(
            wallet,
            {
              minBlock: minBlock,
              fetchCosts: true,
              ...options,
            },
          );

          // Track highest block for state update
          let highestBlockFetched = 0;
          for (const int of arioInteractions) {
            if (!seenTxIds.has(int.txId)) {
              seenTxIds.add(int.txId);
              allARIOInteractions.push(int);

              if (int.blockHeight && int.blockHeight > highestBlockFetched) {
                highestBlockFetched = int.blockHeight;
              }
            }
          }

          // Save indexer state for this wallet
          if (this.cassandraService && highestBlockFetched > 0) {
            await this.cassandraService.saveIndexerState(wallet, "ario", {
              lastIndexedBlock: highestBlockFetched,
              lastIndexedTimestamp: new Date(),
              transactionCount: arioInteractions.length,
            });
          }
        }

        results.raw.ario.interactions = allARIOInteractions;

        // Log summary
        const arnsCount = allARIOInteractions.filter(
          (i) => i.isTokenSpending,
        ).length;
        const stakingCount = allARIOInteractions.filter(
          (i) => i.isStakingAction,
        ).length;
        console.log(
          `\n   📊 Total ARIO interactions: ${allARIOInteractions.length}`,
        );
        console.log(`      - ArNS actions: ${arnsCount}`);
        console.log(`      - Staking actions: ${stakingCount}`);
      } catch (error) {
        console.error(`❌ ARIO fetch failed: ${error.message}`);
        results.raw.ario.error = error.message;
      }
      console.log();
    }

    // ============================================================
    // Normalize to Unified Transactions
    // ============================================================
    if (this.options.normalizeTransactions) {
      console.log("┌" + "─".repeat(58) + "┐");
      console.log("│ PHASE 5: NORMALIZING TRANSACTIONS" + " ".repeat(23) + "│");
      console.log("└" + "─".repeat(58) + "┘");

      results.unified = this.normalizeAllTransactions(
        results.raw,
        primaryWallet,
      );
      console.log(`   ✅ Normalized ${results.unified.length} transactions`);

      // Persist unified transactions to originals table (immutable, append-only)
      // Only save if autoSaveToOriginals is enabled (disabled when called from fetchTransactions.js)
      // fetchTransactions.js handles saving after adding distributions and profiles
      if (
        this.options.autoSaveToOriginals !== false &&
        this.cassandraService &&
        results.unified.length > 0
      ) {
        console.log("   💾 Persisting transactions to originals table...");
        try {
          const saved =
            await this.cassandraService.saveUnifiedTransactionsOriginalsBatch(
              results.unified,
            );
          console.log(
            `   ✅ Saved ${saved} new transactions to originals table`,
          );
          if (saved < results.unified.length) {
            console.log(
              `   ℹ️  ${results.unified.length - saved} transactions were duplicates and skipped`,
            );
          }
        } catch (error) {
          console.log(
            `   ⚠️ Could not save transactions to originals: ${error.message}`,
          );
        }
      }
      console.log();
    }

    // ============================================================
    // Generate Summary
    // ============================================================
    results.summary = this.generateSummary(results);

    // Print summary
    this.printSummary(results.summary);

    return results;
  }

  /**
   * Normalize all raw transactions to UnifiedTransaction format
   */
  normalizeAllTransactions(raw, walletAddress) {
    const unified = [];
    const seenTxIds = new Set();

    // Normalize AR L1 transactions
    if (raw.arL1.transactions && raw.arL1.transactions.length > 0) {
      // Debug: Count by type before normalization
      const typeCount = {};
      for (const tx of raw.arL1.transactions) {
        typeCount[tx.type] = (typeCount[tx.type] || 0) + 1;
      }
      console.log(`   🔍 AR L1 raw transactions by type:`, typeCount);

      for (const arTx of raw.arL1.transactions) {
        // Determine the actual wallet for this transaction based on type
        // RECEIVE: wallet is the recipient (targetAddress)
        // SEND/DATA_UPLOAD: wallet is the sender (ownerAddress)
        // Internal transfers keep their original type (SEND/RECEIVE) but have isInternalTransfer=true
        let txWallet = walletAddress;
        if (arTx.type === "RECEIVE") {
          txWallet = arTx.targetAddress || walletAddress;
          // Debug: Log RECEIVE transactions
          const internalTag = arTx.isInternalTransfer ? " [INTERNAL]" : "";
          console.log(
            `   📥 AR RECEIVE${internalTag}: txId=${arTx.txId?.substring(0, 12)}, from=${arTx.ownerAddress?.substring(0, 12)}, to=${arTx.targetAddress?.substring(0, 12)}, amount=${arTx.quantityAR}`,
          );
        } else if (arTx.type === "SEND" || arTx.type === "DATA_UPLOAD") {
          txWallet = arTx.ownerAddress || walletAddress;
          if (arTx.type === "SEND" && arTx.isInternalTransfer) {
            console.log(
              `   📤 AR SEND [INTERNAL]: txId=${arTx.txId?.substring(0, 12)}, from=${arTx.ownerAddress?.substring(0, 12)}, to=${arTx.targetAddress?.substring(0, 12)}, amount=${arTx.quantityAR}`,
            );
          }
        } else if (arTx.type === "INTERNAL_TRANSFER") {
          // Legacy handling for any transactions that still have INTERNAL_TRANSFER type
          // Default to targetAddress (recipient perspective) for backwards compatibility
          txWallet = arTx.targetAddress || walletAddress;
        }

        // ARTransaction objects need to be converted
        const unifiedTx = UnifiedTransaction.fromARTransaction(arTx, txWallet);
        if (!seenTxIds.has(unifiedTx.txId)) {
          unified.push(unifiedTx);
          seenTxIds.add(unifiedTx.txId);
        }
      }
    }

    // Normalize AO Token transfers (including mint notices and qAR unwrapping)
    // Track unwrapping pairs: txHash -> { wARSend, arReceive }
    const unwrappingPairs = new Map(); // txHash -> { wARSend: unifiedTx, arReceives: [unifiedTx] }
    const unwrappingMintNotices = []; // Store unwrapping mint notices for processing after all transfers
    const qarUnwraps = []; // Store qAR Unwrap actions
    const qarConfirmUnwraps = []; // Store qAR Confirm-Unwrap actions

    // Track seen wrapping fingerprints to prevent duplicate Mint-Notices
    // Format: "txHash|tokenSymbol|amount|date" for wrapping events
    const seenWrappingFingerprints = new Set();

    if (raw.aoTokens.transfers && raw.aoTokens.transfers.length > 0) {
      for (const transfer of raw.aoTokens.transfers) {
        // Mint notices are always incoming
        const direction =
          transfer.type === "mint_notice"
            ? "received"
            : transfer.direction === "outgoing"
              ? "sent"
              : "received";
        // Use the actual wallet for this transfer (sender for outgoing, recipient for incoming/mint)
        const transferWallet =
          transfer.direction === "outgoing"
            ? transfer.sender
            : transfer.recipient || walletAddress;
        const unifiedTx = UnifiedTransaction.fromAOTokenTransfer(
          transfer,
          transferWallet || walletAddress,
          direction,
        );

        // Check if this is an unwrapping mint notice
        if (
          transfer.type === "mint_notice" &&
          transfer.isUnwrapping &&
          transfer.txHash
        ) {
          // Store for later processing (after we've normalized all wAR SENDs)
          unwrappingMintNotices.push({ transfer, unifiedTx });
          continue; // Skip adding it now, we'll process it after linking
        }

        // Check if this is a qAR unwrapping action
        if (
          transfer.type === "qar_unwrap" ||
          transfer.type === "qar_confirm_unwrap"
        ) {
          if (transfer.type === "qar_unwrap") {
            qarUnwraps.push({ transfer, unifiedTx });
          } else {
            qarConfirmUnwraps.push({ transfer, unifiedTx });
          }
          continue; // Skip adding it now, we'll process it after linking
        }

        // For wrapping Mint-Notices (not unwrapping), add economic fingerprint deduplication
        // Use Pushed-For tag to differentiate distinct transactions with same txHash
        if (
          transfer.type === "mint_notice" &&
          transfer.txHash &&
          !transfer.isUnwrapping
        ) {
          // Create economic fingerprint for wrapping events
          // Include Pushed-For to differentiate distinct Mint-Notice messages
          // Multiple Mint-Notices can be generated for the same wrapping event (same txHash)
          // but they may have different Pushed-For values if they're from different message chains
          const wrapDate = unifiedTx.blockTimestamp
            ? new Date(unifiedTx.blockTimestamp * 1000)
                .toISOString()
                .split("T")[0]
            : "unknown";
          const amount = parseFloat(unifiedTx.amountHuman || 0).toFixed(8);
          const pushedFor =
            transfer.originatingTxId || unifiedTx.metadata?.pushedFor || "none";
          // Include Pushed-For in fingerprint to avoid incorrectly deduplicating distinct transactions
          const fingerprint = `${transfer.txHash}|${unifiedTx.tokenSymbol}|${amount}|${wrapDate}|${pushedFor}`;

          // Skip if we've already seen this exact wrapping event (same txHash, amount, date, AND Pushed-For)
          if (seenWrappingFingerprints.has(fingerprint)) {
            if (this.verbose) {
              console.log(
                `   ⚠️ Skipping duplicate wrapping Mint-Notice: ${fingerprint}`,
              );
            }
            continue;
          }

          seenWrappingFingerprints.add(fingerprint);
        }

        if (!seenTxIds.has(unifiedTx.txId)) {
          unified.push(unifiedTx);
          seenTxIds.add(unifiedTx.txId);
        }
      }
    }

    // Process unwrapping: Link wrapped token SEND to underlying asset RECEIVE (Mint-Notice)
    // For wAR: Link wAR SEND (AR L1) to AR RECEIVE
    // For wUSDC: May be cross-chain (Ethereum TxHash), so linking may not be possible

    // Find all wrapped token SEND transactions that could be unwrapping requests
    const wARSends = unified.filter(
      (tx) =>
        tx.type === "SEND" && tx.tokenSymbol === "wAR" && tx.source === "ar_l1", // wAR unwrapping is via AR L1 transaction
    );

    const wUSDCSends = unified.filter(
      (tx) =>
        tx.type === "SEND" &&
        tx.tokenSymbol === "wUSDC" &&
        tx.source === "ao_token", // wUSDC unwrapping is via AO token transfer
    );

    // Now process unwrapping mint notices and link them to wrapped token SENDs
    for (const { transfer, unifiedTx } of unwrappingMintNotices) {
      const txHash = transfer.txHash;
      if (!txHash) continue;

      const isCrossChain = transfer.isCrossChain === true; // wUSDC with Ethereum TxHash

      // For cross-chain (wUSDC), we can't link to Arweave transactions
      // But we can still mark it as unwrapping and handle cost basis
      if (isCrossChain) {
        // Cross-chain unwrapping (wUSDC → USDC via Ethereum bridge)
        // Mark as unwrapping but don't try to link to Arweave transaction
        unifiedTx.metadata = unifiedTx.metadata || {};
        unifiedTx.metadata.isUnwrapping = true;
        unifiedTx.metadata.isCrossChain = true;
        unifiedTx.metadata.unwrappingTxHash = txHash; // Ethereum transaction hash
        unifiedTx.isTaxableEvent = false; // Cost basis transfer, not a sale

        if (!seenTxIds.has(unifiedTx.txId)) {
          unified.push(unifiedTx);
          seenTxIds.add(unifiedTx.txId);
        }
        continue;
      }

      // For wAR unwrapping, find the corresponding wAR SEND transaction
      const matchingWARSend = wARSends.find((send) => send.txId === txHash);

      if (matchingWARSend) {
        // Found a matching pair - link them
        if (!unwrappingPairs.has(txHash)) {
          unwrappingPairs.set(txHash, {
            wARSend: matchingWARSend,
            arReceives: [],
          });
        }

        const pair = unwrappingPairs.get(txHash);

        // Deduplicate: Check if we already have an AR RECEIVE with same amount and date
        const existingReceive = pair.arReceives.find(
          (r) =>
            r.amountHuman === unifiedTx.amountHuman &&
            r.date === unifiedTx.date,
        );

        if (!existingReceive) {
          // Link the transactions
          unifiedTx.metadata = unifiedTx.metadata || {};
          unifiedTx.metadata.isUnwrapping = true;
          unifiedTx.metadata.linkedWARSendTxId = matchingWARSend.txId;
          unifiedTx.metadata.unwrappingTxHash = txHash;

          matchingWARSend.metadata = matchingWARSend.metadata || {};
          matchingWARSend.metadata.isUnwrapping = true;
          matchingWARSend.metadata.linkedARReceiveTxId = unifiedTx.txId;
          matchingWARSend.metadata.unwrappingTxHash = txHash;

          // Mark as non-taxable (cost basis transfer, not a sale)
          unifiedTx.isTaxableEvent = false;
          matchingWARSend.isTaxableEvent = false; // wAR disposal in unwrapping is not a taxable sale

          pair.arReceives.push(unifiedTx);

          if (!seenTxIds.has(unifiedTx.txId)) {
            unified.push(unifiedTx);
            seenTxIds.add(unifiedTx.txId);
          }
        } else {
          // Duplicate Mint-Notice for same unwrapping - skip it
          if (this.verbose) {
            console.log(
              `   ⚠️ Skipping duplicate unwrapping Mint-Notice: ${unifiedTx.txId} (TxHash: ${txHash})`,
            );
          }
        }
      } else {
        // No matching wAR SEND found - this might be a different type of transaction
        // Still add it but don't mark as unwrapping
        if (!seenTxIds.has(unifiedTx.txId)) {
          unified.push(unifiedTx);
          seenTxIds.add(unifiedTx.txId);
        }
      }
    }

    // Process qAR unwrapping: Link Unwrap to Confirm-Unwrap and bridge transaction
    // qAR uses a two-step bridge-based process:
    // 1. Unwrap action - Burns qAR (disposal)
    // 2. Confirm-Unwrap action - Confirms unwrap, provides bridge TX ID
    // 3. Bridge transaction - Sends AR back (acquisition)
    for (const {
      transfer: unwrapTransfer,
      unifiedTx: unwrapTx,
    } of qarUnwraps) {
      // Find matching Confirm-Unwrap
      const confirmUnwrap = qarConfirmUnwraps.find(
        (cu) => cu.transfer.unwrapRequestId === unwrapTransfer.txId,
      );

      if (confirmUnwrap) {
        const { transfer: confirmTransfer, unifiedTx: confirmTx } =
          confirmUnwrap;
        const bridgeTxId = confirmTransfer.transferId; // X-Transfer-Id from Confirm-Unwrap

        // Link Unwrap to Confirm-Unwrap
        unwrapTx.metadata = unwrapTx.metadata || {};
        unwrapTx.metadata.isUnwrapping = true;
        unwrapTx.metadata.isQARUnwrapping = true;
        unwrapTx.metadata.linkedConfirmUnwrapTxId = confirmTx.txId;
        unwrapTx.metadata.bridgeTxId = bridgeTxId;
        unwrapTx.isTaxableEvent = false; // qAR disposal in unwrapping is not a taxable sale

        confirmTx.metadata = confirmTx.metadata || {};
        confirmTx.metadata.isUnwrapping = true;
        confirmTx.metadata.isQARUnwrapping = true;
        confirmTx.metadata.linkedUnwrapTxId = unwrapTx.txId;
        confirmTx.metadata.bridgeTxId = bridgeTxId;
        confirmTx.isTaxableEvent = false;

        // Try to find the bridge transaction (AR RECEIVE)
        if (bridgeTxId) {
          const bridgeTx = unified.find((tx) => tx.txId === bridgeTxId);
          if (bridgeTx) {
            // Link bridge transaction to unwrapping
            bridgeTx.metadata = bridgeTx.metadata || {};
            bridgeTx.metadata.isUnwrapping = true;
            bridgeTx.metadata.isQARUnwrapping = true;
            bridgeTx.metadata.linkedUnwrapTxId = unwrapTx.txId;
            bridgeTx.metadata.linkedConfirmUnwrapTxId = confirmTx.txId;
            bridgeTx.isTaxableEvent = false; // AR acquisition in unwrapping is cost basis transfer
          }
        }

        // Add both transactions
        if (!seenTxIds.has(unwrapTx.txId)) {
          unified.push(unwrapTx);
          seenTxIds.add(unwrapTx.txId);
        }
        if (!seenTxIds.has(confirmTx.txId)) {
          unified.push(confirmTx);
          seenTxIds.add(confirmTx.txId);
        }
      } else {
        // No Confirm-Unwrap found - still add Unwrap but mark as incomplete
        unwrapTx.metadata = unwrapTx.metadata || {};
        unwrapTx.metadata.isUnwrapping = true;
        unwrapTx.metadata.isQARUnwrapping = true;
        unwrapTx.metadata.unwrappingIncomplete = true;
        unwrapTx.isTaxableEvent = false;

        if (!seenTxIds.has(unwrapTx.txId)) {
          unified.push(unwrapTx);
          seenTxIds.add(unwrapTx.txId);
        }
      }
    }

    // Add any Confirm-Unwrap that wasn't linked (shouldn't happen, but handle gracefully)
    for (const {
      transfer: confirmTransfer,
      unifiedTx: confirmTx,
    } of qarConfirmUnwraps) {
      if (!seenTxIds.has(confirmTx.txId)) {
        confirmTx.metadata = confirmTx.metadata || {};
        confirmTx.metadata.isUnwrapping = true;
        confirmTx.metadata.isQARUnwrapping = true;
        confirmTx.metadata.unwrappingIncomplete = true;
        confirmTx.isTaxableEvent = false;
        unified.push(confirmTx);
        seenTxIds.add(confirmTx.txId);
      }
    }

    // Normalize DEX swaps with economic deduplication
    // (same swap may appear as both request and confirmation with different txIds)
    const dexSwaps = [
      ...(raw.dex.permaswap || []),
      ...(raw.dex.botega || []),
      ...(raw.dex.agents || []),
      ...(raw.dex.orderConfirmations || []), // Include order confirmations in same pool
    ];

    // Track seen economic fingerprints to prevent duplicate swap events
    // Format: "date|inputToken|outputToken|inputAmount|outputAmount"
    const seenSwapFingerprints = new Set();

    for (const swap of dexSwaps) {
      const unifiedTx = UnifiedTransaction.fromDEXSwap(swap, walletAddress);

      // Create economic fingerprint for deduplication
      const swapDate = unifiedTx.blockTimestamp
        ? new Date(unifiedTx.blockTimestamp * 1000).toISOString().split("T")[0]
        : "unknown";
      const inAmount = parseFloat(unifiedTx.inputAmountHuman || 0).toFixed(8);
      const outAmount = parseFloat(unifiedTx.outputAmountHuman || 0).toFixed(8);
      const fingerprint = `${swapDate}|${unifiedTx.inputTokenSymbol}|${unifiedTx.outputTokenSymbol}|${inAmount}|${outAmount}`;

      // Skip if we've already seen this exact swap (by txId OR economic fingerprint)
      if (seenTxIds.has(unifiedTx.txId)) {
        continue;
      }
      if (seenSwapFingerprints.has(fingerprint)) {
        if (this.verbose) {
          console.log(`   ⚠️ Skipping duplicate swap: ${fingerprint}`);
        }
        continue;
      }

      unified.push(unifiedTx);
      seenTxIds.add(unifiedTx.txId);
      seenSwapFingerprints.add(fingerprint);
    }

    // Normalize Bazar trades (only taxable ones)
    if (raw.dex.bazar && raw.dex.bazar.length > 0) {
      for (const trade of raw.dex.bazar) {
        if (trade.isTaxableEvent) {
          const unifiedTx = UnifiedTransaction.fromBazarTrade(
            trade,
            walletAddress,
          );
          if (!seenTxIds.has(unifiedTx.txId)) {
            unified.push(unifiedTx);
            seenTxIds.add(unifiedTx.txId);
          }
        }
      }
    }

    // Normalize bridge operations
    if (raw.dex.vento && raw.dex.vento.length > 0) {
      for (const bridgeOp of raw.dex.vento) {
        const unifiedTx = UnifiedTransaction.fromBridgeOp(
          bridgeOp,
          walletAddress,
        );
        if (!seenTxIds.has(unifiedTx.txId)) {
          unified.push(unifiedTx);
          seenTxIds.add(unifiedTx.txId);
        }
      }
    }

    // Normalize ARIO contract interactions (ArNS purchases, staking)
    if (raw.ario && raw.ario.interactions && raw.ario.interactions.length > 0) {
      for (const interaction of raw.ario.interactions) {
        const unifiedTx = UnifiedTransaction.fromARIOInteraction(
          interaction,
          walletAddress,
        );
        if (!seenTxIds.has(unifiedTx.txId)) {
          unified.push(unifiedTx);
          seenTxIds.add(unifiedTx.txId);
        }

        // If staked tokens were used, also generate a disposal event
        if (
          interaction.usesStakedTokens &&
          interaction.fundingDetails?.totalFromStakes > 0
        ) {
          const disposalTx = UnifiedTransaction.fromARIOStakedDisposal(
            interaction,
            walletAddress,
          );
          if (!seenTxIds.has(disposalTx.txId)) {
            unified.push(disposalTx);
            seenTxIds.add(disposalTx.txId);
          }
        }
      }
    }

    // Sort by timestamp (newest first)
    unified.sort((a, b) => {
      const timeA = a.blockTimestamp || 0;
      const timeB = b.blockTimestamp || 0;
      return timeB - timeA;
    });

    return unified;
  }

  /**
   * Generate summary statistics
   */
  generateSummary(results) {
    const summary = {
      totalTransactions: 0,
      bySource: {},
      byType: {},
      byTaxCategory: {},
      taxableEvents: 0,
      internalTransfers: 0,
      uniqueTokens: new Set(),
      dateRange: {
        earliest: null,
        latest: null,
      },
    };

    // Count raw transactions by source
    summary.bySource[CONSTANTS.TRANSACTION_SOURCES.AR_L1] =
      results.raw.arL1.transactions?.length || 0;
    summary.bySource[CONSTANTS.TRANSACTION_SOURCES.AO_TOKEN] =
      results.raw.aoTokens.transfers?.length || 0;
    summary.bySource[CONSTANTS.TRANSACTION_SOURCES.PERMASWAP] =
      results.raw.dex.permaswap?.length || 0;
    summary.bySource[CONSTANTS.TRANSACTION_SOURCES.BOTEGA] =
      results.raw.dex.botega?.length || 0;
    summary.bySource[CONSTANTS.TRANSACTION_SOURCES.AGENTS] =
      results.raw.dex.agents?.length || 0;
    summary.bySource[CONSTANTS.TRANSACTION_SOURCES.BAZAR] =
      (results.raw.dex.bazar?.length || 0) +
      (results.raw.dex.orderConfirmations?.length || 0);
    summary.bySource[CONSTANTS.TRANSACTION_SOURCES.VENTO_BRIDGE] =
      results.raw.dex.vento?.length || 0;
    summary.bySource["ARIO_CONTRACT"] =
      results.raw.ario?.interactions?.length || 0;

    // Process unified transactions
    for (const tx of results.unified) {
      summary.totalTransactions++;

      // By type
      summary.byType[tx.type] = (summary.byType[tx.type] || 0) + 1;

      // By tax category
      summary.byTaxCategory[tx.taxCategory] =
        (summary.byTaxCategory[tx.taxCategory] || 0) + 1;

      // Taxable events
      if (tx.isTaxableEvent && !tx.isInternalTransfer) {
        summary.taxableEvents++;
      }

      // Internal transfers
      if (tx.isInternalTransfer) {
        summary.internalTransfers++;
      }

      // Unique tokens
      if (tx.tokenSymbol) {
        summary.uniqueTokens.add(tx.tokenSymbol);
      }
      if (tx.inputTokenSymbol) {
        summary.uniqueTokens.add(tx.inputTokenSymbol);
      }
      if (tx.outputTokenSymbol) {
        summary.uniqueTokens.add(tx.outputTokenSymbol);
      }

      // Date range
      if (tx.blockTimestamp) {
        const txDate = new Date(tx.blockTimestamp * 1000);
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

    // Convert Set to Array
    summary.uniqueTokens = Array.from(summary.uniqueTokens);

    return summary;
  }

  /**
   * Print formatted summary
   */
  printSummary(summary) {
    console.log("╔" + "═".repeat(68) + "╗");
    console.log("║" + " ".repeat(28) + "SUMMARY" + " ".repeat(33) + "║");
    console.log("╠" + "═".repeat(68) + "╣");
    console.log(
      `║ Total Transactions: ${summary.totalTransactions}` +
        " ".repeat(47 - String(summary.totalTransactions).length) +
        "║",
    );
    console.log(
      `║ Taxable Events: ${summary.taxableEvents}` +
        " ".repeat(51 - String(summary.taxableEvents).length) +
        "║",
    );
    console.log(
      `║ Internal Transfers: ${summary.internalTransfers}` +
        " ".repeat(47 - String(summary.internalTransfers).length) +
        "║",
    );
    console.log("╠" + "═".repeat(68) + "╣");
    console.log("║ BY SOURCE:" + " ".repeat(57) + "║");

    for (const [source, count] of Object.entries(summary.bySource)) {
      if (count > 0) {
        const label = `   ${source}: ${count}`;
        console.log("║" + label + " ".repeat(68 - label.length) + "║");
      }
    }

    console.log("╠" + "═".repeat(68) + "╣");
    console.log("║ UNIQUE TOKENS:" + " ".repeat(53) + "║");
    const tokenStr =
      summary.uniqueTokens.length > 0
        ? summary.uniqueTokens.join(", ")
        : "None";
    const truncatedTokens =
      tokenStr.length > 60 ? tokenStr.substring(0, 57) + "..." : tokenStr;
    console.log(
      "║   " + truncatedTokens + " ".repeat(65 - truncatedTokens.length) + "║",
    );

    if (summary.dateRange.earliest && summary.dateRange.latest) {
      console.log("╠" + "═".repeat(68) + "╣");
      console.log("║ DATE RANGE:" + " ".repeat(56) + "║");
      const earliest = summary.dateRange.earliest.toISOString().split("T")[0];
      const latest = summary.dateRange.latest.toISOString().split("T")[0];
      console.log(`║   ${earliest} to ${latest}` + " ".repeat(43) + "║");
    }

    console.log("╚" + "═".repeat(68) + "╝");
    console.log();
  }

  /**
   * Split all swaps into separate disposal and acquisition transactions
   * (Required for IRS tax reporting)
   */
  splitSwapsForTaxReporting(unifiedTransactions) {
    const splitTransactions = [];

    for (const tx of unifiedTransactions) {
      if (tx.isSwap) {
        // Split into two transactions
        const [disposal, acquisition] =
          UnifiedTransaction.splitSwapForTaxReporting(tx);
        splitTransactions.push(disposal);
        splitTransactions.push(acquisition);
      } else {
        splitTransactions.push(tx);
      }
    }

    // Re-sort by timestamp
    splitTransactions.sort((a, b) => {
      const timeA = a.blockTimestamp || 0;
      const timeB = b.blockTimestamp || 0;
      return timeB - timeA;
    });

    return splitTransactions;
  }

  /**
   * Export results to JSON (for storage or transmission)
   */
  exportToJSON(results) {
    return {
      wallet: results.wallet,
      wallets: results.wallets,
      walletIdentity: results.walletIdentity,
      fetchedAt: results.fetchedAt,
      summary: {
        ...results.summary,
        dateRange: {
          earliest: results.summary.dateRange.earliest?.toISOString(),
          latest: results.summary.dateRange.latest?.toISOString(),
        },
      },
      transactions: results.unified.map((tx) => tx.toJSON()),
    };
  }

  /**
   * Get transactions ready for tax report generation
   */
  getTransactionsForTaxReport(unifiedTransactions, taxYear) {
    // Filter to taxable events in the specified year
    const taxableInYear = unifiedTransactions.filter((tx) => {
      if (!tx.isTaxableEvent || tx.isInternalTransfer) return false;

      const txDate = tx.getDate();
      if (!txDate) return false;

      return txDate.getFullYear() === taxYear;
    });

    // Split swaps into disposal + acquisition
    const split = this.splitSwapsForTaxReporting(taxableInYear);

    // Separate by tax category
    const disposals = split.filter(
      (tx) => tx.taxCategory === CONSTANTS.TAX_CATEGORIES.DISPOSAL,
    );
    const acquisitions = split.filter(
      (tx) => tx.taxCategory === CONSTANTS.TAX_CATEGORIES.ACQUISITION,
    );
    const income = split.filter(
      (tx) => tx.taxCategory === CONSTANTS.TAX_CATEGORIES.INCOME,
    );

    return {
      taxYear,
      disposals,
      acquisitions,
      income,
      totalTaxable: split.length,
    };
  }
}

module.exports = { UnifiedWalletHistoryService };
