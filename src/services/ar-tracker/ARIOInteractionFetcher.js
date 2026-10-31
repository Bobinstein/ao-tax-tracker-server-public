/**
 * ARIOInteractionFetcher
 * 
 * Fetches and parses ARIO contract interactions for tax tracking purposes.
 * Tracks ArNS purchases, staking actions, and token spending via staked tokens.
 * 
 * Key Features:
 * - Fetches ARIO contract interactions (ArNS, staking)
 * - Retrieves actual purchase costs from response messages
 * - Detects staked token usage and generates disposal events
 * - Differentiates between liquid and staked token spending
 */

const axios = require('axios');

// ARIO mainnet process ID
const ARIO_PROCESS_ID = 'qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE';

// ARIO token decimals
const ARIO_DECIMALS = 6;
const MARIO_DIVISOR = Math.pow(10, ARIO_DECIMALS);

// Action types that spend tokens
const TOKEN_SPENDING_ACTIONS = [
  'Buy-Name',
  'Extend-Lease',
  'Increase-Undername-Limit',
  'Upgrade-Name',
  'Request-Primary-Name'
];

// Response action types (for fetching actual costs)
const RESPONSE_ACTIONS = TOKEN_SPENDING_ACTIONS.map(a => `${a}-Notice`);

// Staking-related actions
const STAKING_ACTIONS = [
  'Join-Network',
  'Leave-Network',
  'Delegate-Stake',
  'Decrease-Delegate-Stake',
  'Increase-Operator-Stake',
  'Decrease-Operator-Stake',
  'Instant-Withdrawal',
  'Cancel-Withdrawal',
  'Redelegate-Stake'
];

// All trackable actions
const ALL_ARIO_ACTIONS = [...TOKEN_SPENDING_ACTIONS, ...STAKING_ACTIONS];

class ARIOInteractionFetcher {
  constructor(options = {}) {
    this.graphqlEndpoint = options.graphqlEndpoint || 'https://arweave.net/graphql';
    this.verbose = options.verbose || false;
    this.arioProcessId = options.arioProcessId || ARIO_PROCESS_ID;
    
    // Cache for response data to avoid duplicate fetches
    this.responseCache = new Map();
  }

  log(...args) {
    if (this.verbose) {
      console.log('[ARIOInteractionFetcher]', ...args);
    }
  }

  /**
   * Fetch all ARIO interactions for a wallet with full cost details
   * @param {string} walletAddress - The wallet address to query
   * @param {Object} options - Query options
   * @param {number} options.minBlock - Minimum block height
   * @param {number} options.maxBlock - Maximum block height
   * @param {boolean} options.fetchCosts - Whether to fetch actual costs from responses (default: true)
   * @returns {Array} Array of ARIO interactions with full details
   */
  async fetchInteractions(walletAddress, options = {}) {
    const { minBlock, maxBlock, fetchCosts = true } = options;
    const allInteractions = [];
    let cursor = null;
    let hasMore = true;
    let pageCount = 0;

    this.log(`Fetching ARIO interactions for ${walletAddress}...`);

    while (hasMore) {
      pageCount++;
      const query = this.buildQuery(walletAddress, cursor, minBlock, maxBlock);
      
      try {
        const response = await axios.post(this.graphqlEndpoint, { query }, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000
        });

        const edges = response.data?.data?.transactions?.edges || [];
        
        if (edges.length === 0) {
          hasMore = false;
          break;
        }

        for (const edge of edges) {
          const interaction = this.parseInteraction(edge.node);
          if (interaction) {
            allInteractions.push(interaction);
          }
          cursor = edge.cursor;
        }

        hasMore = edges.length === 100;
        
        if (pageCount % 5 === 0) {
          this.log(`  Page ${pageCount}: ${allInteractions.length} interactions so far...`);
        }
      } catch (error) {
        console.error('Error fetching ARIO interactions:', error.message);
        hasMore = false;
      }
    }

    this.log(`Found ${allInteractions.length} ARIO interactions for ${walletAddress}`);

    // Fetch actual costs from response messages for token-spending actions
    if (fetchCosts) {
      await this.enrichWithCostDetails(allInteractions);
    }

    return allInteractions;
  }

  /**
   * Enrich interactions with actual cost details from response messages
   */
  async enrichWithCostDetails(interactions) {
    const spendingInteractions = interactions.filter(i => i.isTokenSpending);
    
    if (spendingInteractions.length === 0) return;
    
    this.log(`Fetching cost details for ${spendingInteractions.length} spending transactions...`);
    
    // Batch fetch responses
    let processed = 0;
    for (const interaction of spendingInteractions) {
      try {
        const response = await this.fetchResponseData(interaction.txId);
        if (response) {
          this.enrichInteractionWithResponse(interaction, response);
        }
        processed++;
        
        if (processed % 10 === 0) {
          this.log(`  Fetched ${processed}/${spendingInteractions.length} response details...`);
        }
      } catch (error) {
        this.log(`  Failed to fetch response for ${interaction.txId}: ${error.message}`);
      }
      
      // Small delay to avoid rate limiting
      if (processed % 5 === 0) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    
    this.log(`Enriched ${processed} interactions with cost details`);
  }

  /**
   * Fetch response data for a transaction
   */
  async fetchResponseData(originalTxId) {
    // Check cache first
    if (this.responseCache.has(originalTxId)) {
      return this.responseCache.get(originalTxId);
    }

    const query = `
      query FindResponse {
        transactions(
          first: 1
          tags: [
            { name: "Pushed-For", values: ["${originalTxId}"] },
            { name: "Action", values: ${JSON.stringify(RESPONSE_ACTIONS)} }
          ]
        ) {
          edges {
            node {
              id
              tags { name value }
            }
          }
        }
      }
    `;

    try {
      const response = await axios.post(this.graphqlEndpoint, { query }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000
      });

      const edges = response.data?.data?.transactions?.edges || [];
      if (edges.length === 0) {
        this.responseCache.set(originalTxId, null);
        return null;
      }

      const responseTxId = edges[0].node.id;
      
      // Fetch the actual data content
      const dataResponse = await axios.get(`https://arweave.net/${responseTxId}`, {
        timeout: 10000
      });
      
      const data = dataResponse.data;
      this.responseCache.set(originalTxId, data);
      return data;
    } catch (error) {
      this.log(`Error fetching response for ${originalTxId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Enrich interaction with response data
   */
  enrichInteractionWithResponse(interaction, response) {
    if (!response) return;

    // Extract cost information
    interaction.actualCost = {
      purchasePrice: response.purchasePrice || 0,
      purchasePriceARIO: (response.purchasePrice || 0) / MARIO_DIVISOR,
      baseRegistrationFee: response.baseRegistrationFee || 0,
      remainingBalance: response.remainingBalance || 0
    };

    // Extract funding plan
    if (response.fundingPlan) {
      const fp = response.fundingPlan;
      interaction.fundingDetails = {
        fromBalance: fp.balance || 0,
        fromBalanceARIO: (fp.balance || 0) / MARIO_DIVISOR,
        fromStakes: this.parseStakesFunding(fp.stakes),
        totalFromStakes: this.calculateTotalFromStakes(fp.stakes),
        totalFromStakesARIO: this.calculateTotalFromStakes(fp.stakes) / MARIO_DIVISOR,
        shortfall: fp.shortfall || 0
      };
      
      // Update usesStakedTokens based on actual funding, not just Fund-From tag
      interaction.usesStakedTokens = interaction.fundingDetails.totalFromStakes > 0;
    }

    // Extract result info
    if (response.fundingResult) {
      interaction.fundingResult = {
        totalFunded: response.fundingResult.totalFunded || 0,
        totalFundedARIO: (response.fundingResult.totalFunded || 0) / MARIO_DIVISOR,
        newWithdrawVaults: response.fundingResult.newWithdrawVaults || []
      };
    }

    // ArNS-specific details
    if (response.name) {
      interaction.arnsDetails = {
        name: response.name,
        type: response.type,
        processId: response.processId,
        startTimestamp: response.startTimestamp,
        endTimestamp: response.endTimestamp,
        undernameLimit: response.undernameLimit
      };
    }
  }

  /**
   * Parse stakes funding details
   */
  parseStakesFunding(stakes) {
    if (!stakes || typeof stakes !== 'object') return [];
    
    const stakeDetails = [];
    for (const [gatewayAddress, stakeInfo] of Object.entries(stakes)) {
      if (!stakeInfo || typeof stakeInfo !== 'object') continue;
      
      const detail = {
        gatewayAddress,
        delegatedStake: stakeInfo.delegatedStake || 0,
        delegatedStakeARIO: (stakeInfo.delegatedStake || 0) / MARIO_DIVISOR,
        vaults: {}
      };
      
      // Parse vault contributions
      if (stakeInfo.vaults && typeof stakeInfo.vaults === 'object') {
        for (const [vaultId, amount] of Object.entries(stakeInfo.vaults)) {
          detail.vaults[vaultId] = {
            amount,
            amountARIO: amount / MARIO_DIVISOR
          };
        }
      }
      
      stakeDetails.push(detail);
    }
    
    return stakeDetails;
  }

  /**
   * Calculate total mARIO from stakes
   */
  calculateTotalFromStakes(stakes) {
    if (!stakes || typeof stakes !== 'object') return 0;
    
    let total = 0;
    for (const stakeInfo of Object.values(stakes)) {
      if (!stakeInfo || typeof stakeInfo !== 'object') continue;
      
      // Active delegated stake
      total += stakeInfo.delegatedStake || 0;
      
      // Vault contributions
      if (stakeInfo.vaults && typeof stakeInfo.vaults === 'object') {
        for (const amount of Object.values(stakeInfo.vaults)) {
          total += amount || 0;
        }
      }
    }
    
    return total;
  }

  /**
   * Build GraphQL query for ARIO interactions
   */
  buildQuery(walletAddress, cursor, minBlock, maxBlock) {
    const blockFilter = [];
    if (minBlock) blockFilter.push(`min: ${minBlock}`);
    if (maxBlock) blockFilter.push(`max: ${maxBlock}`);
    const blockClause = blockFilter.length > 0 ? `block: { ${blockFilter.join(', ')} }` : '';

    return `
      query ARIOInteractions {
        transactions(
          first: 100
          ${cursor ? `after: "${cursor}"` : ''}
          owners: ["${walletAddress}"]
          recipients: ["${this.arioProcessId}"]
          tags: [
            { name: "Action", values: ${JSON.stringify(ALL_ARIO_ACTIONS)} }
          ]
          ${blockClause}
          sort: HEIGHT_DESC
        ) {
          edges {
            cursor
            node {
              id
              owner { address }
              recipient
              block { height timestamp }
              tags { name value }
            }
          }
        }
      }
    `;
  }

  /**
   * Parse a GraphQL transaction node into an ARIO interaction
   */
  parseInteraction(node) {
    if (!node || !node.id) return null;

    const tags = this.parseTags(node.tags);
    const action = tags['Action'];

    if (!action) return null;

    const interaction = {
      txId: node.id,
      owner: node.owner?.address,
      action: action,
      timestamp: node.block?.timestamp ? node.block.timestamp * 1000 : null,
      blockHeight: node.block?.height,
      
      // Common fields
      name: tags['Name'],
      fundFrom: tags['Fund-From'] || 'balance',
      
      // Token amounts (from input tags)
      quantity: tags['Quantity'] ? parseInt(tags['Quantity']) : null,
      operatorStake: tags['Operator-Stake'] ? parseInt(tags['Operator-Stake']) : null,
      years: tags['Years'] ? parseInt(tags['Years']) : null,
      
      // ArNS specific
      purchaseType: tags['Purchase-Type'],
      processId: tags['Process-Id'],
      
      // Staking specific
      target: tags['Target'] || tags['Address'],
      gatewayAddress: tags['Gateway-Address'],
      vaultId: tags['Vault-Id'],
      
      // Tax categorization flags
      isTokenSpending: TOKEN_SPENDING_ACTIONS.includes(action),
      isStakingAction: STAKING_ACTIONS.includes(action),
      usesStakedTokens: ['stakes', 'any'].includes(tags['Fund-From']),
      
      // Will be populated by enrichWithCostDetails
      actualCost: null,
      fundingDetails: null,
      fundingResult: null,
      arnsDetails: null,
      
      // Raw tags for reference
      rawTags: tags
    };

    interaction.transactionType = this.categorizeInteraction(interaction);

    return interaction;
  }

  /**
   * Parse tags array into object
   */
  parseTags(tags) {
    const result = {};
    if (!tags) return result;
    for (const tag of tags) {
      result[tag.name] = tag.value;
    }
    return result;
  }

  /**
   * Categorize interaction for tax purposes
   */
  categorizeInteraction(interaction) {
    const { action, usesStakedTokens } = interaction;

    switch (action) {
      case 'Buy-Name':
        return usesStakedTokens ? 'ARNS_PURCHASE_FROM_STAKE' : 'ARNS_PURCHASE';
      case 'Extend-Lease':
        return usesStakedTokens ? 'ARNS_EXTEND_FROM_STAKE' : 'ARNS_EXTEND';
      case 'Increase-Undername-Limit':
        return usesStakedTokens ? 'ARNS_UNDERNAME_FROM_STAKE' : 'ARNS_UNDERNAME';
      case 'Upgrade-Name':
        return usesStakedTokens ? 'ARNS_UPGRADE_FROM_STAKE' : 'ARNS_UPGRADE';
      case 'Request-Primary-Name':
        return usesStakedTokens ? 'PRIMARY_NAME_FROM_STAKE' : 'PRIMARY_NAME_REQUEST';
      case 'Join-Network':
        return 'GATEWAY_JOIN';
      case 'Leave-Network':
        return 'GATEWAY_LEAVE';
      case 'Delegate-Stake':
        return 'STAKE_DELEGATE';
      case 'Decrease-Delegate-Stake':
        return 'STAKE_DECREASE';
      case 'Increase-Operator-Stake':
        return 'STAKE_INCREASE';
      case 'Decrease-Operator-Stake':
        return 'OPERATOR_STAKE_DECREASE';
      case 'Instant-Withdrawal':
        return 'STAKE_INSTANT_WITHDRAWAL';
      case 'Cancel-Withdrawal':
        return 'STAKE_CANCEL_WITHDRAWAL';
      case 'Redelegate-Stake':
        return 'STAKE_REDELEGATE';
      default:
        return 'ARIO_OTHER';
    }
  }

  /**
   * Generate tax events from an ARIO interaction
   * Returns array of events: purchases, disposals (if staked tokens used), etc.
   */
  generateTaxEvents(interaction, priceUSD = null) {
    const events = [];
    
    if (!interaction.isTokenSpending) {
      // Handle staking actions
      if (interaction.action === 'Delegate-Stake') {
        events.push({
          type: 'STAKE',
          txId: interaction.txId,
          timestamp: interaction.timestamp,
          tokenSymbol: 'ARIO',
          amount: interaction.quantity / MARIO_DIVISOR,
          description: `Delegated ARIO to gateway ${interaction.target}`,
          taxable: false
        });
      } else if (interaction.action === 'Join-Network') {
        events.push({
          type: 'STAKE',
          txId: interaction.txId,
          timestamp: interaction.timestamp,
          tokenSymbol: 'ARIO',
          amount: interaction.operatorStake / MARIO_DIVISOR,
          description: 'Staked ARIO to join as gateway operator',
          taxable: false
        });
      }
      // Other staking actions...
      return events;
    }

    // Token spending action
    const actualCost = interaction.actualCost?.purchasePriceARIO || 0;
    const fundingDetails = interaction.fundingDetails;
    
    // Event 1: ArNS Purchase/Extension (expense)
    const purchaseEvent = {
      type: 'ARNS_EXPENSE',
      subType: interaction.action,
      txId: interaction.txId,
      timestamp: interaction.timestamp,
      tokenSymbol: 'ARIO',
      amount: actualCost,
      name: interaction.name || interaction.arnsDetails?.name,
      years: interaction.years,
      purchaseType: interaction.purchaseType || interaction.arnsDetails?.type,
      valueUSD: priceUSD ? actualCost * priceUSD : null,
      description: `ArNS ${interaction.action}: ${interaction.name}`,
      taxable: true, // May be deductible as business expense
      expenseType: 'DIGITAL_ASSET_PURCHASE'
    };
    events.push(purchaseEvent);

    // Event 2: Staked token disposal (if any)
    if (fundingDetails && fundingDetails.totalFromStakes > 0) {
      const stakedAmount = fundingDetails.totalFromStakesARIO;
      
      const disposalEvent = {
        type: 'STAKED_TOKEN_DISPOSAL',
        txId: interaction.txId,
        timestamp: interaction.timestamp,
        tokenSymbol: 'ARIO',
        amount: stakedAmount,
        valueUSD: priceUSD ? stakedAmount * priceUSD : null,
        description: `Disposed staked ARIO for ArNS purchase: ${interaction.name}`,
        taxable: true,
        disposalReason: 'USED_FOR_PURCHASE',
        // Cost basis will need to be determined from when tokens were staked
        needsCostBasis: true,
        stakeSources: fundingDetails.fromStakes // Details of which gateways/vaults
      };
      events.push(disposalEvent);
    }

    // Event 3: Track liquid token expense (if any)
    if (fundingDetails && fundingDetails.fromBalance > 0) {
      const liquidAmount = fundingDetails.fromBalanceARIO;
      
      events.push({
        type: 'LIQUID_TOKEN_EXPENSE',
        txId: interaction.txId,
        timestamp: interaction.timestamp,
        tokenSymbol: 'ARIO',
        amount: liquidAmount,
        valueUSD: priceUSD ? liquidAmount * priceUSD : null,
        description: `Used liquid ARIO for ArNS purchase: ${interaction.name}`,
        taxable: false, // Not a disposal, just spending
        expenseTracking: true
      });
    }

    return events;
  }

  /**
   * Convert ARIO interaction to unified transaction format
   */
  toUnifiedTransaction(interaction) {
    const actualCost = interaction.actualCost?.purchasePriceARIO || 
                       (interaction.quantity || interaction.operatorStake || 0) / MARIO_DIVISOR;

    const unified = {
      txId: interaction.txId,
      source: 'ARIO_CONTRACT',
      type: interaction.transactionType,
      timestamp: interaction.timestamp,
      blockHeight: interaction.blockHeight,
      
      tokenSymbol: 'ARIO',
      tokenProcessId: this.arioProcessId,
      
      amount: actualCost,
      amountHuman: actualCost,
      
      from: interaction.owner,
      to: this.arioProcessId,
      
      metadata: {
        action: interaction.action,
        name: interaction.name || interaction.arnsDetails?.name,
        fundFrom: interaction.fundFrom,
        years: interaction.years,
        purchaseType: interaction.purchaseType || interaction.arnsDetails?.type,
        target: interaction.target,
        gatewayAddress: interaction.gatewayAddress,
        usesStakedTokens: interaction.usesStakedTokens,
        actualCost: interaction.actualCost,
        fundingDetails: interaction.fundingDetails
      }
    };

    // Tax categorization
    if (interaction.isTokenSpending) {
      if (interaction.usesStakedTokens) {
        unified.taxCategory = 'DISPOSAL_AND_EXPENSE';
      } else {
        unified.taxCategory = 'EXPENSE';
      }
    } else if (interaction.action === 'Delegate-Stake' || interaction.action === 'Join-Network' || 
               interaction.action === 'Increase-Operator-Stake') {
      unified.taxCategory = 'STAKE';
    } else if (interaction.action === 'Decrease-Delegate-Stake' || interaction.action === 'Leave-Network' ||
               interaction.action === 'Decrease-Operator-Stake') {
      unified.taxCategory = 'UNSTAKE';
    } else if (interaction.action === 'Instant-Withdrawal') {
      unified.taxCategory = 'UNSTAKE_WITH_PENALTY';
    } else if (interaction.action === 'Redelegate-Stake') {
      unified.taxCategory = 'STAKE_TRANSFER';
    } else {
      unified.taxCategory = 'OTHER';
    }

    return unified;
  }

  /**
   * Fetch interactions for multiple wallets
   */
  async fetchInteractionsForWallets(walletAddresses, options = {}) {
    const allInteractions = [];
    
    for (const wallet of walletAddresses) {
      const interactions = await this.fetchInteractions(wallet, options);
      allInteractions.push(...interactions);
    }

    allInteractions.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    
    return allInteractions;
  }

  /**
   * Get summary of ARIO activity for a wallet
   */
  async getActivitySummary(walletAddress, options = {}) {
    const interactions = await this.fetchInteractions(walletAddress, options);
    
    const summary = {
      totalInteractions: interactions.length,
      byAction: {},
      arnsNames: new Set(),
      arnsActivity: {
        namesPurchased: 0,
        totalSpentARIO: 0,
        totalFromLiquid: 0,
        totalFromStaked: 0
      },
      stakingActivity: {
        totalDelegated: 0,
        totalUndelegated: 0,
        gatewayStake: 0
      },
      usedStakedTokensForPurchases: false
    };

    for (const interaction of interactions) {
      summary.byAction[interaction.action] = (summary.byAction[interaction.action] || 0) + 1;
      
      if (interaction.name || interaction.arnsDetails?.name) {
        summary.arnsNames.add(interaction.name || interaction.arnsDetails?.name);
      }

      // ArNS spending
      if (interaction.isTokenSpending && interaction.actualCost) {
        summary.arnsActivity.namesPurchased++;
        summary.arnsActivity.totalSpentARIO += interaction.actualCost.purchasePriceARIO;
        
        if (interaction.fundingDetails) {
          summary.arnsActivity.totalFromLiquid += interaction.fundingDetails.fromBalanceARIO;
          summary.arnsActivity.totalFromStaked += interaction.fundingDetails.totalFromStakesARIO;
        }
      }

      // Staking
      if (interaction.action === 'Delegate-Stake' && interaction.quantity) {
        summary.stakingActivity.totalDelegated += interaction.quantity / MARIO_DIVISOR;
      }
      if (interaction.action === 'Decrease-Delegate-Stake' && interaction.quantity) {
        summary.stakingActivity.totalUndelegated += interaction.quantity / MARIO_DIVISOR;
      }
      if (interaction.action === 'Join-Network' && interaction.operatorStake) {
        summary.stakingActivity.gatewayStake += interaction.operatorStake / MARIO_DIVISOR;
      }

      if (interaction.usesStakedTokens) {
        summary.usedStakedTokensForPurchases = true;
      }
    }

    summary.arnsNames = Array.from(summary.arnsNames);
    return summary;
  }

  /**
   * Get full tax report for ARIO interactions
   */
  async getTaxReport(walletAddresses, options = {}) {
    const { taxYear, priceService } = options;
    
    const interactions = await this.fetchInteractionsForWallets(walletAddresses, options);
    
    const report = {
      wallets: walletAddresses,
      taxYear,
      generatedAt: new Date().toISOString(),
      summary: {
        totalInteractions: interactions.length,
        arnsExpenses: 0,
        stakedTokenDisposals: 0,
        stakingActions: 0
      },
      taxEvents: [],
      interactions
    };

    for (const interaction of interactions) {
      // Filter by tax year if specified
      if (taxYear && interaction.timestamp) {
        const year = new Date(interaction.timestamp).getFullYear();
        if (year !== taxYear) continue;
      }

      // Get price at time of transaction
      let priceUSD = null;
      if (priceService && interaction.timestamp) {
        try {
          priceUSD = await priceService.getPrice('ARIO', interaction.timestamp);
        } catch (e) {
          // Use null if price not available
        }
      }

      const events = this.generateTaxEvents(interaction, priceUSD);
      report.taxEvents.push(...events);

      // Update summary
      for (const event of events) {
        if (event.type === 'ARNS_EXPENSE') {
          report.summary.arnsExpenses += event.valueUSD || 0;
        } else if (event.type === 'STAKED_TOKEN_DISPOSAL') {
          report.summary.stakedTokenDisposals++;
        } else if (event.type === 'STAKE') {
          report.summary.stakingActions++;
        }
      }
    }

    return report;
  }
}

// Export constants for external use
module.exports = {
  ARIOInteractionFetcher,
  ARIO_PROCESS_ID,
  ARIO_DECIMALS,
  MARIO_DIVISOR,
  TOKEN_SPENDING_ACTIONS,
  RESPONSE_ACTIONS,
  STAKING_ACTIONS,
  ALL_ARIO_ACTIONS
};
