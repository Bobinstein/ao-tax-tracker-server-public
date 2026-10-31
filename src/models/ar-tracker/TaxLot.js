/**
 * TaxLot Model
 *
 * Represents a "lot" of AR acquired at a specific time and price.
 * Used for cost basis calculation methods (FIFO, LIFO, HIFO, Specific ID).
 *
 * Tax lots track:
 * - When AR was acquired
 * - How much AR was acquired
 * - What was paid for it (cost basis)
 * - How much remains (after partial disposals)
 * - Fee adjustments (fees can be added to cost basis)
 */

class TaxLot {
  /**
   * Create a new tax lot
   * @param {Object} config
   */
  constructor(config) {
    // Identification
    this.lotId = config.lotId || this.generateLotId();
    this.acquisitionTxId = config.acquisitionTxId;
    this.walletAddress = config.walletAddress;

    // Acquisition details
    this.acquisitionDate = new Date(config.acquisitionDate);
    this.acquisitionType = config.acquisitionType; // 'purchase', 'mining', 'airdrop', 'transfer_in', etc.

    // Amounts (in AR)
    this.originalQuantityAR = config.originalQuantityAR;
    this.remainingQuantityAR =
      config.remainingQuantityAR ?? config.originalQuantityAR;

    // Cost basis
    this.originalCostBasisUSD = config.originalCostBasisUSD;
    this.costPerUnitUSD =
      config.originalCostBasisUSD / config.originalQuantityAR;

    // Fee adjustments (fees can be added to cost basis)
    this.feeAdjustmentsUSD = config.feeAdjustmentsUSD || 0;
    this.adjustedCostBasisUSD =
      this.originalCostBasisUSD + this.feeAdjustmentsUSD;
    this.adjustedCostPerUnitUSD =
      this.adjustedCostBasisUSD / this.originalQuantityAR;

    // Price at acquisition
    this.priceAtAcquisitionUSD = config.priceAtAcquisitionUSD;

    // Disposal tracking
    this.disposals = config.disposals || [];
    this.isFullyDisposed = this.remainingQuantityAR <= 0;

    // Metadata
    this.notes = config.notes || null;
    this.createdAt = new Date();
    this.updatedAt = new Date();
  }

  /**
   * Generate unique lot ID
   * @returns {string}
   */
  generateLotId() {
    return `lot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get the remaining cost basis for this lot
   * @returns {number}
   */
  getRemainingCostBasisUSD() {
    return this.remainingQuantityAR * this.adjustedCostPerUnitUSD;
  }

  /**
   * Check if this lot qualifies for long-term capital gains
   * @param {Date} disposalDate
   * @returns {boolean}
   */
  isLongTerm(disposalDate) {
    const oneYearMs = 365 * 24 * 60 * 60 * 1000;
    return disposalDate.getTime() - this.acquisitionDate.getTime() > oneYearMs;
  }

  /**
   * Get holding period in days
   * @param {Date} [asOfDate] - Date to calculate holding period as of (default: now)
   * @returns {number}
   */
  getHoldingPeriodDays(asOfDate = new Date()) {
    const ms = asOfDate.getTime() - this.acquisitionDate.getTime();
    return Math.floor(ms / (24 * 60 * 60 * 1000));
  }

  /**
   * Dispose of AR from this lot
   * @param {Object} disposal
   * @param {string} disposal.disposalTxId
   * @param {Date} disposal.disposalDate
   * @param {number} disposal.quantityAR
   * @param {number} disposal.proceedsUSD
   * @returns {Object} Disposal result with gain/loss
   */
  dispose(disposal) {
    if (disposal.quantityAR > this.remainingQuantityAR) {
      throw new Error(
        `Cannot dispose ${disposal.quantityAR} AR from lot ${this.lotId}, only ${this.remainingQuantityAR} remaining`
      );
    }

    // Calculate cost basis for disposed portion
    const disposedCostBasisUSD =
      disposal.quantityAR * this.adjustedCostPerUnitUSD;

    // Calculate gain/loss
    const gainLossUSD = disposal.proceedsUSD - disposedCostBasisUSD;

    // Determine holding period
    const holdingPeriod = this.isLongTerm(disposal.disposalDate)
      ? "long"
      : "short";

    // Record disposal
    const disposalRecord = {
      disposalTxId: disposal.disposalTxId,
      disposalDate: disposal.disposalDate,
      quantityAR: disposal.quantityAR,
      costBasisUSD: disposedCostBasisUSD,
      proceedsUSD: disposal.proceedsUSD,
      gainLossUSD: gainLossUSD,
      holdingPeriod: holdingPeriod,
      holdingPeriodDays: this.getHoldingPeriodDays(disposal.disposalDate),
    };

    this.disposals.push(disposalRecord);
    this.remainingQuantityAR -= disposal.quantityAR;
    this.isFullyDisposed = this.remainingQuantityAR <= 0;
    this.updatedAt = new Date();

    return disposalRecord;
  }

  /**
   * Add fee to cost basis (e.g., transfer fees, data upload fees)
   * @param {number} feeUSD
   * @param {string} [description]
   */
  addFeeToCostBasis(feeUSD, description = null) {
    this.feeAdjustmentsUSD += feeUSD;
    this.adjustedCostBasisUSD =
      this.originalCostBasisUSD + this.feeAdjustmentsUSD;
    this.adjustedCostPerUnitUSD =
      this.adjustedCostBasisUSD / this.originalQuantityAR;
    this.updatedAt = new Date();

    if (description && !this.notes) {
      this.notes = `Fee adjustments: ${description}`;
    } else if (description) {
      this.notes += `; ${description}`;
    }
  }

  /**
   * Serialize for storage
   * @returns {Object}
   */
  toJSON() {
    return {
      lotId: this.lotId,
      acquisitionTxId: this.acquisitionTxId,
      walletAddress: this.walletAddress,
      acquisitionDate: this.acquisitionDate.toISOString(),
      acquisitionType: this.acquisitionType,
      originalQuantityAR: this.originalQuantityAR,
      remainingQuantityAR: this.remainingQuantityAR,
      originalCostBasisUSD: this.originalCostBasisUSD,
      costPerUnitUSD: this.costPerUnitUSD,
      feeAdjustmentsUSD: this.feeAdjustmentsUSD,
      adjustedCostBasisUSD: this.adjustedCostBasisUSD,
      adjustedCostPerUnitUSD: this.adjustedCostPerUnitUSD,
      priceAtAcquisitionUSD: this.priceAtAcquisitionUSD,
      disposals: this.disposals,
      isFullyDisposed: this.isFullyDisposed,
      notes: this.notes,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }

  /**
   * Create from stored data
   * @param {Object} data
   * @returns {TaxLot}
   */
  static fromJSON(data) {
    const lot = new TaxLot({
      lotId: data.lotId,
      acquisitionTxId: data.acquisitionTxId,
      walletAddress: data.walletAddress,
      acquisitionDate: data.acquisitionDate,
      acquisitionType: data.acquisitionType,
      originalQuantityAR: data.originalQuantityAR,
      remainingQuantityAR: data.remainingQuantityAR,
      originalCostBasisUSD: data.originalCostBasisUSD,
      feeAdjustmentsUSD: data.feeAdjustmentsUSD,
      priceAtAcquisitionUSD: data.priceAtAcquisitionUSD,
      disposals: data.disposals,
      notes: data.notes,
    });
    lot.createdAt = new Date(data.createdAt);
    lot.updatedAt = new Date(data.updatedAt);
    return lot;
  }
}

/**
 * Cost basis calculation methods
 */
const CostBasisMethod = {
  FIFO: "FIFO", // First In, First Out
  LIFO: "LIFO", // Last In, First Out
  HIFO: "HIFO", // Highest In, First Out (minimize gains)
  SPECIFIC_ID: "SPECIFIC_ID", // User specifies which lot to use
};

module.exports = {
  TaxLot,
  CostBasisMethod,
};
