/**
 * UnifiedTransaction Model
 *
 * Standardized transaction format that normalizes all transaction types
 * (AR L1, AO tokens, DEX swaps, orderbook trades, bridge ops) into a
 * consistent structure for tax reporting and cost basis calculation.
 *
 * This is the output format that report generators consume.
 *
 * @module models/UnifiedTransaction
 */

const CONSTANTS = require("../../../config/ar-tracker-constants");

/**
 * UnifiedTransaction class
 *
 * Provides a consistent interface for all transaction types across
 * different platforms and protocols.
 */
class UnifiedTransaction {
  constructor(config = {}) {
    // ============================================================
    // Core Identification
    // ============================================================
    this.txId = config.txId || null;
    this.source = config.source || CONSTANTS.TRANSACTION_SOURCES.AR_L1;
    this.type = config.type || CONSTANTS.UNIFIED_TX_TYPES.UNKNOWN;
    this.taxCategory =
      config.taxCategory || CONSTANTS.TAX_CATEGORIES.NON_TAXABLE;

    // ============================================================
    // Timing
    // ============================================================
    this.blockHeight = config.blockHeight || null;
    this.blockTimestamp = config.blockTimestamp || null; // Unix timestamp (seconds)
    this.processedAt = config.processedAt || new Date();

    // ============================================================
    // Parties
    // ============================================================
    this.walletAddress = config.walletAddress || null; // The user's wallet
    this.fromAddress = config.fromAddress || null; // Sender
    this.toAddress = config.toAddress || null; // Recipient

    // ============================================================
    // Token Information (for token-specific transactions)
    // ============================================================
    this.tokenProcessId = config.tokenProcessId || null;
    this.tokenSymbol = config.tokenSymbol || null;
    this.tokenDecimals = config.tokenDecimals || 12;

    // ============================================================
    // Amounts (in atomic units - smallest denomination)
    // ============================================================
    this.amountAtomic = config.amountAtomic || "0";
    this.feeAtomic = config.feeAtomic || "0";

    // ============================================================
    // Calculated Values (in human-readable format)
    // ============================================================
    this.amountHuman = config.amountHuman || 0;
    this.feeHuman = config.feeHuman || 0;

    // ============================================================
    // USD Values (for tax calculation)
    // ============================================================
    this.priceUSD = config.priceUSD || null; // Price per token at time of tx
    this.valueUSD = config.valueUSD || null; // Total USD value
    this.feeUSD = config.feeUSD || null;

    // ============================================================
    // For Swaps/Trades (has both input and output)
    // ============================================================
    this.isSwap = config.isSwap || false;

    // Input side (what was given up)
    this.inputTokenProcessId = config.inputTokenProcessId || null;
    this.inputTokenSymbol = config.inputTokenSymbol || null;
    this.inputTokenDecimals = config.inputTokenDecimals || 12;
    this.inputAmountAtomic = config.inputAmountAtomic || "0";
    this.inputAmountHuman = config.inputAmountHuman || 0;
    this.inputValueUSD = config.inputValueUSD || null;

    // Output side (what was received)
    this.outputTokenProcessId = config.outputTokenProcessId || null;
    this.outputTokenSymbol = config.outputTokenSymbol || null;
    this.outputTokenDecimals = config.outputTokenDecimals || 12;
    this.outputAmountAtomic = config.outputAmountAtomic || "0";
    this.outputAmountHuman = config.outputAmountHuman || 0;
    this.outputValueUSD = config.outputValueUSD || null;

    // ============================================================
    // DEX/Platform Specific
    // ============================================================
    this.platform = config.platform || null; // permaswap, botega, bazar, etc.
    this.poolId = config.poolId || null;
    this.poolName = config.poolName || null;
    this.orderId = config.orderId || null;

    // ============================================================
    // Tax Classification
    // ============================================================
    this.isTaxableEvent =
      config.isTaxableEvent !== undefined ? config.isTaxableEvent : true;
    this.isInternalTransfer = config.isInternalTransfer || false;
    this.taxClassification = config.taxClassification || null; // User can override
    this.originalTaxClassification = config.originalTaxClassification || null;
    this.isUserOverridden = config.isUserOverridden || false;
    this.overrideReason = config.overrideReason || null;

    // ============================================================
    // For Linked Transactions (e.g., swap creates disposal + acquisition)
    // ============================================================
    this.linkedTxId = config.linkedTxId || null;
    this.linkedTxType = config.linkedTxType || null;

    // ============================================================
    // Transfer Result Tracking (Pushed-For pattern)
    // ============================================================
    this.originatingTxId = config.originatingTxId || null; // The transfer that triggered this
    this.resultMessages = config.resultMessages || []; // Credit/Debit notices, errors, etc.

    // ============================================================
    // Raw Data (for debugging/auditing)
    // ============================================================
    this.rawTags = config.rawTags || {};
    this.rawData = config.rawData || null;

    // ============================================================
    // Validation and Error Tracking
    // ============================================================
    this.isValid = config.isValid !== undefined ? config.isValid : true;
    this.validationErrors = config.validationErrors || [];
  }

  // ============================================================
  // Factory Methods
  // ============================================================

  /**
   * Create from AR L1 transaction (ARTransaction model)
   */
  static fromARTransaction(arTx, walletAddress) {
    const tokenInfo = CONSTANTS.TOKENS["native_ar"] || {
      symbol: "AR",
      decimals: 12,
    };

    let type = CONSTANTS.UNIFIED_TX_TYPES.UNKNOWN;
    let taxCategory = CONSTANTS.TAX_CATEGORIES.NON_TAXABLE;
    let isTaxable = false;

    // Determine type based on AR transaction type
    // Internal transfers are marked with isInternalTransfer=true but keep original type (SEND/RECEIVE)
    // Debug: Log internal transfer detection
    if (
      arTx.isInternalTransfer &&
      (arTx.type === "SEND" || arTx.type === "RECEIVE")
    ) {
      console.log(
        `   🔄 Converting ${arTx.type} to INTERNAL_TRANSFER: txId=${arTx.txId?.substring(0, 12)}, isInternalTransfer=${arTx.isInternalTransfer}`,
      );
    }
    if (arTx.isInternalTransfer) {
      // Internal transfer - not taxable, use INTERNAL_TRANSFER type
      type = CONSTANTS.UNIFIED_TX_TYPES.INTERNAL_TRANSFER;
      taxCategory = CONSTANTS.TAX_CATEGORIES.NON_TAXABLE;
      isTaxable = false;
    } else if (arTx.type === "RECEIVE") {
      type = CONSTANTS.UNIFIED_TX_TYPES.RECEIVE;
      taxCategory = CONSTANTS.TAX_CATEGORIES.ACQUISITION;
      isTaxable = true;
    } else if (arTx.type === "SEND") {
      type = CONSTANTS.UNIFIED_TX_TYPES.SEND;
      taxCategory = CONSTANTS.TAX_CATEGORIES.DISPOSAL;
      isTaxable = true;
    } else if (arTx.type === "INTERNAL_TRANSFER") {
      // Legacy type - should not happen with new code but keep for backwards compatibility
      type = CONSTANTS.UNIFIED_TX_TYPES.INTERNAL_TRANSFER;
      taxCategory = CONSTANTS.TAX_CATEGORIES.NON_TAXABLE;
      isTaxable = false;
    } else if (arTx.type === "DATA_UPLOAD") {
      type = CONSTANTS.UNIFIED_TX_TYPES.DATA_UPLOAD;
      // Data upload fees are expenses that can be tracked for cost basis purposes,
      // but are NOT taxable dispositions - you're paying for a service, not disposing of an asset
      taxCategory = CONSTANTS.TAX_CATEGORIES.FEE_EXPENSE;
      isTaxable = false;
    }

    return new UnifiedTransaction({
      txId: arTx.txId,
      source: CONSTANTS.TRANSACTION_SOURCES.AR_L1,
      type: type,
      taxCategory: taxCategory,

      blockHeight: arTx.blockHeight,
      blockTimestamp: arTx.blockTimestamp,

      walletAddress: walletAddress,
      fromAddress: arTx.ownerAddress,
      toAddress: arTx.targetAddress,

      tokenSymbol: "AR",
      tokenDecimals: 12,

      amountAtomic: String(Math.round(arTx.quantityAR * 1e12)),
      amountHuman: arTx.quantityAR,
      feeAtomic: String(Math.round(arTx.rewardAR * 1e12)),
      feeHuman: arTx.rewardAR,

      isTaxableEvent: isTaxable,
      isInternalTransfer: arTx.isInternalTransfer,
      taxClassification: arTx.taxClassification || type,

      rawTags: arTx.tags || {},
    });
  }

  /**
   * Create from AO token transfer
   */
  static fromAOTokenTransfer(transfer, walletAddress, direction = "received") {
    // Use resolved token info from transfer if available, fallback to constants
    const constantsToken = CONSTANTS.TOKENS[transfer.tokenProcessId];
    const tokenSymbol =
      transfer.tokenSymbol || constantsToken?.symbol || "UNKNOWN";
    const tokenDecimals =
      transfer.tokenDecimals || constantsToken?.decimals || 12;

    const isReceived = direction === "received";
    const isInternal = transfer.isInternalTransfer || false;

    // Determine type - internal transfers are always INTERNAL_TRANSFER
    let type;
    let taxCategory;
    if (isInternal) {
      type = CONSTANTS.UNIFIED_TX_TYPES.INTERNAL_TRANSFER;
      taxCategory = CONSTANTS.TAX_CATEGORIES.NON_TAXABLE;
    } else if (isReceived) {
      type = CONSTANTS.UNIFIED_TX_TYPES.RECEIVE;
      taxCategory = CONSTANTS.TAX_CATEGORIES.ACQUISITION;
    } else {
      type = CONSTANTS.UNIFIED_TX_TYPES.SEND;
      taxCategory = CONSTANTS.TAX_CATEGORIES.DISPOSAL;
    }

    const amountAtomic = transfer.quantity || "0";
    const amountHuman = Number(amountAtomic) / Math.pow(10, tokenDecimals);

    // Preserve unwrapping metadata if present
    const metadata = {};
    if (transfer.isUnwrapping) {
      metadata.isUnwrapping = true;
    }
    if (transfer.txHash) {
      metadata.txHash = transfer.txHash;
    }

    return new UnifiedTransaction({
      txId: transfer.txId,
      source: CONSTANTS.TRANSACTION_SOURCES.AO_TOKEN,
      type: type,
      taxCategory: taxCategory,

      blockHeight: transfer.blockHeight,
      blockTimestamp: transfer.blockTimestamp,

      walletAddress: walletAddress,
      fromAddress: transfer.sender,
      toAddress: transfer.recipient,

      tokenProcessId: transfer.tokenProcessId,
      tokenSymbol: tokenSymbol,
      tokenDecimals: tokenDecimals,

      amountAtomic: amountAtomic,
      amountHuman: amountHuman,

      isTaxableEvent: !isInternal,
      isInternalTransfer: isInternal,
      taxClassification: type,

      originatingTxId: transfer.originatingTxId,
      resultMessages: transfer.resultMessages || [],

      rawTags: transfer.rawTags || {},
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }

  /**
   * Create from DEX swap (Permaswap, Botega)
   * Note: Each swap creates TWO UnifiedTransactions (disposal + acquisition)
   */
  static fromDEXSwap(swap, walletAddress) {
    const inputToken = CONSTANTS.TOKENS[swap.tokenIn || swap.fromToken] || {
      symbol: "UNKNOWN",
      decimals: 12,
    };
    const outputToken = CONSTANTS.TOKENS[swap.tokenOut || swap.toToken] || {
      symbol: "UNKNOWN",
      decimals: 12,
    };

    const inputAmountAtomic = swap.amountIn || swap.fromQuantity || "0";
    const outputAmountAtomic = swap.amountOut || swap.toQuantity || "0";

    // Create the parent swap transaction
    const swapTx = new UnifiedTransaction({
      txId: swap.txId,
      source: swap.source || CONSTANTS.TRANSACTION_SOURCES.PERMASWAP,
      type: CONSTANTS.UNIFIED_TX_TYPES.DEX_SWAP,
      taxCategory: CONSTANTS.TAX_CATEGORIES.DISPOSAL, // Disposal takes precedence

      blockHeight: swap.blockHeight,
      blockTimestamp: swap.blockTimestamp,

      walletAddress: walletAddress,

      isSwap: true,

      // Input (disposal)
      inputTokenProcessId: swap.tokenIn || swap.fromToken,
      inputTokenSymbol: inputToken.symbol,
      inputTokenDecimals: inputToken.decimals,
      inputAmountAtomic: inputAmountAtomic,
      inputAmountHuman:
        Number(inputAmountAtomic) / Math.pow(10, inputToken.decimals),

      // Output (acquisition)
      outputTokenProcessId: swap.tokenOut || swap.toToken,
      outputTokenSymbol: outputToken.symbol,
      outputTokenDecimals: outputToken.decimals,
      outputAmountAtomic: outputAmountAtomic,
      outputAmountHuman:
        Number(outputAmountAtomic) / Math.pow(10, outputToken.decimals),

      // Platform info
      platform: swap.source || "permaswap",
      poolId: swap.poolId,
      poolName: swap.poolName,
      orderId: swap.orderId,

      isTaxableEvent: true,
      taxClassification: CONSTANTS.UNIFIED_TX_TYPES.DEX_SWAP,

      rawTags: swap.rawTags || {},
    });

    return swapTx;
  }

  /**
   * Split a DEX swap into disposal and acquisition transactions
   * (IRS requires reporting both sides)
   */
  static splitSwapForTaxReporting(swapTx) {
    if (!swapTx.isSwap) {
      return [swapTx];
    }

    // Create disposal transaction (giving up input token)
    const disposal = new UnifiedTransaction({
      txId: `${swapTx.txId}_disposal`,
      source: swapTx.source,
      type: CONSTANTS.UNIFIED_TX_TYPES.TRADE_DISPOSAL,
      taxCategory: CONSTANTS.TAX_CATEGORIES.DISPOSAL,

      blockHeight: swapTx.blockHeight,
      blockTimestamp: swapTx.blockTimestamp,

      walletAddress: swapTx.walletAddress,

      tokenProcessId: swapTx.inputTokenProcessId,
      tokenSymbol: swapTx.inputTokenSymbol,
      tokenDecimals: swapTx.inputTokenDecimals,
      amountAtomic: swapTx.inputAmountAtomic,
      amountHuman: swapTx.inputAmountHuman,
      valueUSD: swapTx.inputValueUSD,

      platform: swapTx.platform,
      poolId: swapTx.poolId,
      orderId: swapTx.orderId,

      isTaxableEvent: true,
      taxClassification: CONSTANTS.UNIFIED_TX_TYPES.TRADE_DISPOSAL,

      linkedTxId: `${swapTx.txId}_acquisition`,
      linkedTxType: CONSTANTS.UNIFIED_TX_TYPES.TRADE_ACQUISITION,
    });

    // Create acquisition transaction (receiving output token)
    const acquisition = new UnifiedTransaction({
      txId: `${swapTx.txId}_acquisition`,
      source: swapTx.source,
      type: CONSTANTS.UNIFIED_TX_TYPES.TRADE_ACQUISITION,
      taxCategory: CONSTANTS.TAX_CATEGORIES.ACQUISITION,

      blockHeight: swapTx.blockHeight,
      blockTimestamp: swapTx.blockTimestamp,

      walletAddress: swapTx.walletAddress,

      tokenProcessId: swapTx.outputTokenProcessId,
      tokenSymbol: swapTx.outputTokenSymbol,
      tokenDecimals: swapTx.outputTokenDecimals,
      amountAtomic: swapTx.outputAmountAtomic,
      amountHuman: swapTx.outputAmountHuman,
      valueUSD: swapTx.outputValueUSD,

      platform: swapTx.platform,
      poolId: swapTx.poolId,
      orderId: swapTx.orderId,

      isTaxableEvent: true,
      taxClassification: CONSTANTS.UNIFIED_TX_TYPES.TRADE_ACQUISITION,

      linkedTxId: `${swapTx.txId}_disposal`,
      linkedTxType: CONSTANTS.UNIFIED_TX_TYPES.TRADE_DISPOSAL,
    });

    return [disposal, acquisition];
  }

  /**
   * Create from Bazar UCM trade
   */
  static fromBazarTrade(trade, walletAddress) {
    const dominantToken = CONSTANTS.TOKENS[trade.dominantToken] || {
      symbol: "UNKNOWN",
      decimals: 12,
    };
    const swapToken = CONSTANTS.TOKENS[trade.swapToken] || {
      symbol: "UNKNOWN",
      decimals: 12,
    };

    // Determine if this is a sale or purchase based on side
    const isSale = trade.side === "Ask" && trade.incomingSide;
    const isPurchase = trade.side === "Bid" && trade.incomingSide;

    let type = CONSTANTS.UNIFIED_TX_TYPES.UNKNOWN;
    let taxCategory = CONSTANTS.TAX_CATEGORIES.NON_TAXABLE;

    if (isSale) {
      type = CONSTANTS.UNIFIED_TX_TYPES.ORDERBOOK_SALE;
      taxCategory = CONSTANTS.TAX_CATEGORIES.DISPOSAL;
    } else if (isPurchase) {
      type = CONSTANTS.UNIFIED_TX_TYPES.ORDERBOOK_PURCHASE;
      taxCategory = CONSTANTS.TAX_CATEGORIES.ACQUISITION;
    }

    return new UnifiedTransaction({
      txId: trade.txId,
      source: CONSTANTS.TRANSACTION_SOURCES.BAZAR,
      type: type,
      taxCategory: taxCategory,

      blockHeight: trade.blockHeight,
      blockTimestamp: trade.blockTimestamp,

      walletAddress: walletAddress,
      fromAddress: trade.sender,
      toAddress: trade.recipient,

      tokenProcessId: trade.dominantToken,
      tokenSymbol: dominantToken.symbol,
      tokenDecimals: dominantToken.decimals,
      amountAtomic: trade.quantity || "0",
      amountHuman:
        Number(trade.quantity || 0) / Math.pow(10, dominantToken.decimals),

      platform: "bazar",
      orderId: trade.txId,

      isTaxableEvent: isSale || isPurchase,
      isInternalTransfer: trade.isInternalTransfer || false,
      taxClassification: type,

      rawTags: trade.rawTags || {},
    });
  }

  /**
   * Create from bridge operation
   */
  static fromBridgeOp(bridgeOp, walletAddress) {
    const isDeposit = bridgeOp.type === "bridge_deposit";
    const type = isDeposit
      ? CONSTANTS.UNIFIED_TX_TYPES.BRIDGE_DEPOSIT
      : CONSTANTS.UNIFIED_TX_TYPES.BRIDGE_WITHDRAWAL;

    return new UnifiedTransaction({
      txId: bridgeOp.txId,
      source: CONSTANTS.TRANSACTION_SOURCES.VENTO_BRIDGE,
      type: type,
      taxCategory: CONSTANTS.TAX_CATEGORIES.NON_TAXABLE,

      blockHeight: bridgeOp.blockHeight,
      blockTimestamp: bridgeOp.blockTimestamp,

      walletAddress: walletAddress,

      tokenSymbol: isDeposit ? "AR" : "vAR",
      tokenDecimals: 12,
      amountAtomic: bridgeOp.amountWinston || bridgeOp.quantity || "0",
      amountHuman: Number(bridgeOp.amountAR || 0),

      platform: "vento",

      isTaxableEvent: false, // Bridge ops generally non-taxable
      taxClassification: type,

      rawTags: bridgeOp.rawTags || {},
    });
  }

  /**
   * Create from ARIO contract interaction (ArNS purchase, staking, etc.)
   */
  static fromARIOInteraction(interaction, walletAddress) {
    const ARIO_DECIMALS = 6;
    const ARIO_PROCESS_ID = "qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE";

    // Determine transaction type and tax category based on action
    let type = CONSTANTS.UNIFIED_TX_TYPES.UNKNOWN;
    let taxCategory = CONSTANTS.TAX_CATEGORIES.NON_TAXABLE;
    let isTaxable = false;

    switch (interaction.action) {
      case "Buy-Name":
      case "Extend-Lease":
      case "Increase-Undername-Limit":
      case "Upgrade-Name":
      case "Request-Primary-Name":
        type = "ARNS_PURCHASE";
        taxCategory = CONSTANTS.TAX_CATEGORIES.FEE_EXPENSE;
        isTaxable = false; // Expense, not disposal
        break;
      case "Delegate-Stake":
      case "Join-Network":
      case "Increase-Operator-Stake":
        type = "STAKE";
        taxCategory = CONSTANTS.TAX_CATEGORIES.NON_TAXABLE;
        isTaxable = false;
        break;
      case "Decrease-Delegate-Stake":
      case "Leave-Network":
      case "Decrease-Operator-Stake":
        type = "UNSTAKE";
        taxCategory = CONSTANTS.TAX_CATEGORIES.NON_TAXABLE;
        isTaxable = false;
        break;
      case "Instant-Withdrawal":
        type = "UNSTAKE_PENALTY";
        taxCategory = CONSTANTS.TAX_CATEGORIES.DISPOSAL; // Penalty is a loss
        isTaxable = true;
        break;
      case "Redelegate-Stake":
        type = "STAKE_TRANSFER";
        taxCategory = CONSTANTS.TAX_CATEGORIES.NON_TAXABLE;
        isTaxable = false;
        break;
    }

    // Get the actual amount from cost details or input tags
    const amount =
      interaction.actualCost?.purchasePriceARIO ||
      (interaction.quantity || interaction.operatorStake || 0) /
        Math.pow(10, ARIO_DECIMALS);

    return new UnifiedTransaction({
      txId: interaction.txId,
      source: "ARIO_CONTRACT",
      type: type,
      taxCategory: taxCategory,

      blockHeight: interaction.blockHeight,
      blockTimestamp: interaction.timestamp
        ? Math.floor(interaction.timestamp / 1000)
        : null,

      walletAddress: walletAddress,
      fromAddress: interaction.owner,
      toAddress: ARIO_PROCESS_ID,

      tokenProcessId: ARIO_PROCESS_ID,
      tokenSymbol: "ARIO",
      tokenDecimals: ARIO_DECIMALS,
      amountAtomic: String(Math.round(amount * Math.pow(10, ARIO_DECIMALS))),
      amountHuman: amount,

      platform: "ar.io",

      isTaxableEvent: isTaxable,
      isInternalTransfer: false,
      taxClassification: type,

      // Metadata for ArNS/staking details
      metadata: {
        action: interaction.action,
        name: interaction.name || interaction.arnsDetails?.name,
        years: interaction.years,
        purchaseType: interaction.purchaseType || interaction.arnsDetails?.type,
        target: interaction.target,
        fundFrom: interaction.fundFrom,
        usesStakedTokens: interaction.usesStakedTokens,
        fundingDetails: interaction.fundingDetails,
        actualCost: interaction.actualCost,
      },

      rawTags: interaction.rawTags || {},
    });
  }

  /**
   * Create a staked token disposal event from ARIO interaction
   * This is generated when staked tokens are used to pay for ArNS purchases
   */
  static fromARIOStakedDisposal(interaction, walletAddress) {
    const ARIO_DECIMALS = 6;
    const ARIO_PROCESS_ID = "qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE";

    if (
      !interaction.fundingDetails ||
      interaction.fundingDetails.totalFromStakes <= 0
    ) {
      return null;
    }

    const stakedAmount = interaction.fundingDetails.totalFromStakesARIO;

    return new UnifiedTransaction({
      // Use a unique ID for the disposal event
      txId: `${interaction.txId}_staked_disposal`,
      source: "ARIO_CONTRACT",
      type: "STAKED_TOKEN_DISPOSAL",
      taxCategory: CONSTANTS.TAX_CATEGORIES.DISPOSAL,

      blockHeight: interaction.blockHeight,
      blockTimestamp: interaction.timestamp
        ? Math.floor(interaction.timestamp / 1000)
        : null,

      walletAddress: walletAddress,
      fromAddress: walletAddress,
      toAddress: ARIO_PROCESS_ID,

      tokenProcessId: ARIO_PROCESS_ID,
      tokenSymbol: "ARIO",
      tokenDecimals: ARIO_DECIMALS,
      amountAtomic: String(
        Math.round(stakedAmount * Math.pow(10, ARIO_DECIMALS)),
      ),
      amountHuman: stakedAmount,

      platform: "ar.io",

      isTaxableEvent: true,
      isInternalTransfer: false,
      taxClassification: "STAKED_TOKEN_DISPOSAL",

      // Link to the original transaction
      linkedTxId: interaction.txId,
      linkedTxType: "ARNS_PURCHASE",

      // Metadata about the stake sources
      metadata: {
        action: interaction.action,
        name: interaction.name || interaction.arnsDetails?.name,
        disposalReason: "USED_FOR_ARNS_PURCHASE",
        stakeSources: interaction.fundingDetails.fromStakes,
        // Cost basis needs to be determined from when tokens were originally staked
        needsCostBasis: true,
      },

      rawTags: interaction.rawTags || {},
    });
  }

  // ============================================================
  // Instance Methods
  // ============================================================

  /**
   * Get the date of this transaction
   */
  getDate() {
    if (!this.blockTimestamp) return null;
    return new Date(this.blockTimestamp * 1000);
  }

  /**
   * Get formatted date string (YYYY-MM-DD)
   */
  getDateString() {
    const date = this.getDate();
    if (!date) return null;
    return date.toISOString().split("T")[0];
  }

  /**
   * Check if this is a taxable event
   */
  isTaxable() {
    if (this.isInternalTransfer) return false;
    return [
      CONSTANTS.TAX_CATEGORIES.DISPOSAL,
      CONSTANTS.TAX_CATEGORIES.INCOME,
    ].includes(this.taxCategory);
  }

  /**
   * Set user override for tax classification
   */
  setUserOverride(newClassification, reason = null) {
    if (!this.originalTaxClassification) {
      this.originalTaxClassification = this.taxClassification;
    }
    this.taxClassification = newClassification;
    this.isUserOverridden = true;
    this.overrideReason = reason;
  }

  /**
   * Revert user override
   */
  revertUserOverride() {
    if (this.originalTaxClassification) {
      this.taxClassification = this.originalTaxClassification;
      this.originalTaxClassification = null;
      this.isUserOverridden = false;
      this.overrideReason = null;
    }
  }

  /**
   * Validate the transaction
   */
  validate() {
    const errors = [];

    if (!this.txId) errors.push("Missing transaction ID");
    if (!this.source) errors.push("Missing source");
    if (!this.type) errors.push("Missing type");

    this.validationErrors = errors;
    this.isValid = errors.length === 0;

    return this.isValid;
  }

  /**
   * Convert to JSON for storage/transmission
   */
  toJSON() {
    return {
      txId: this.txId,
      source: this.source,
      type: this.type,
      taxCategory: this.taxCategory,

      blockHeight: this.blockHeight,
      blockTimestamp: this.blockTimestamp,
      processedAt: this.processedAt?.toISOString(),

      walletAddress: this.walletAddress,
      fromAddress: this.fromAddress,
      toAddress: this.toAddress,

      tokenProcessId: this.tokenProcessId,
      tokenSymbol: this.tokenSymbol,
      tokenDecimals: this.tokenDecimals,

      amountAtomic: this.amountAtomic,
      amountHuman: this.amountHuman,
      feeAtomic: this.feeAtomic,
      feeHuman: this.feeHuman,

      priceUSD: this.priceUSD,
      valueUSD: this.valueUSD,
      feeUSD: this.feeUSD,

      isSwap: this.isSwap,
      inputTokenProcessId: this.inputTokenProcessId,
      inputTokenSymbol: this.inputTokenSymbol,
      inputAmountAtomic: this.inputAmountAtomic,
      inputAmountHuman: this.inputAmountHuman,
      inputValueUSD: this.inputValueUSD,
      outputTokenProcessId: this.outputTokenProcessId,
      outputTokenSymbol: this.outputTokenSymbol,
      outputAmountAtomic: this.outputAmountAtomic,
      outputAmountHuman: this.outputAmountHuman,
      outputValueUSD: this.outputValueUSD,

      platform: this.platform,
      poolId: this.poolId,
      poolName: this.poolName,
      orderId: this.orderId,

      isTaxableEvent: this.isTaxableEvent,
      isInternalTransfer: this.isInternalTransfer,
      taxClassification: this.taxClassification,
      originalTaxClassification: this.originalTaxClassification,
      isUserOverridden: this.isUserOverridden,
      overrideReason: this.overrideReason,

      linkedTxId: this.linkedTxId,
      linkedTxType: this.linkedTxType,

      originatingTxId: this.originatingTxId,

      isValid: this.isValid,
      validationErrors: this.validationErrors,
    };
  }

  /**
   * Create from JSON
   */
  static fromJSON(json) {
    const tx = new UnifiedTransaction(json);
    if (json.processedAt) {
      tx.processedAt = new Date(json.processedAt);
    }
    return tx;
  }
}

module.exports = { UnifiedTransaction };
