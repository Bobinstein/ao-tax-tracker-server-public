/**
 * CostBasisReportGenerator
 *
 * Generates comprehensive cost basis reports in CSV format.
 * Includes ALL transactions including data uploads (fees) for complete
 * cost basis analysis.
 *
 * This report is designed for accountants and detailed tax preparation.
 */

const fs = require("fs");
const path = require("path");

class CostBasisReportGenerator {
  /**
   * @param {Object} options
   * @param {Object} options.costBasisService - CostBasisService instance
   * @param {Object} options.priceService - PriceService instance (optional)
   * @param {string} options.outputDir - Output directory for reports
   * @param {boolean} options.verbose - Enable verbose logging
   */
  constructor(options = {}) {
    this.costBasisService = options.costBasisService;
    this.priceService = options.priceService;
    this.outputDir = options.outputDir || "./reports";
    this.verbose = options.verbose || false;
  }

  /**
   * Generate comprehensive cost basis CSV report
   *
   * @param {Object[]} allTransactions - ALL transactions including data uploads
   * @param {Object[]} taxLots - Tax lots from CostBasisService
   * @param {Object[]} disposals - Disposals from CostBasisService
   * @param {Object} options - Report options
   * @returns {Object} Report file paths
   */
  async generateComprehensiveReport(
    allTransactions,
    taxLots,
    disposals,
    options = {}
  ) {
    const { taxYear, wallets, userId } = options;
    const timestamp = Date.now();

    if (this.verbose) {
      console.log("\n📊 Generating comprehensive cost basis report...");
      console.log(`   Total transactions: ${allTransactions.length}`);
      console.log(`   Tax lots: ${taxLots.length}`);
      console.log(`   Disposals: ${disposals.length}`);
    }

    // Ensure output directory exists
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }

    // Generate essential CSV files only:
    // 1. Fees (only non-zero) - for AR cost basis adjustments
    // 2. Disposals - for capital gains reporting
    // 3. Income - for income reporting
    //
    // Removed: all-transactions (too large), Form 8949 (not needed), holdings (redundant)
    const files = {};

    // 1. Fee Summary CSV - ONLY transactions with actual fees paid
    // Zero-fee transactions (bundled uploads, AO messages) have no tax impact
    files.fees = await this.generateFeesSummaryCSV(allTransactions, {
      taxYear,
      timestamp,
      excludeZeroFees: true, // Only include transactions with fees > 0
    });

    // 2. Disposals CSV (capital gains/losses)
    files.disposals = await this.generateDisposalsCSV(disposals, {
      taxYear,
      timestamp,
    });

    // 3. Income Summary CSV (distributions - liquid and staked)
    const incomeTransactions = allTransactions.filter(
      (tx) =>
        tx.taxCategory === "INCOME" ||
        tx.taxCategory === "DEFERRED_INCOME" ||
        tx.type === "DISTRIBUTION" ||
        tx.type === "MINING_REWARD" ||
        tx.type === "STAKING_REWARD" ||
        tx.type === "STAKED_STAKING_REWARD" ||
        tx.type === "STAKED_AIRDROP"
    );
    files.income = await this.generateIncomeCSV(incomeTransactions, {
      taxYear,
      timestamp,
    });

    if (this.verbose) {
      console.log("\n✅ Cost basis reports generated:");
      for (const [name, filepath] of Object.entries(files)) {
        const stats = fs.statSync(filepath);
        console.log(
          `   ${name}: ${filepath} (${(stats.size / 1024).toFixed(1)} KB)`
        );
      }
    }

    return files;
  }

  /**
   * Generate ALL transactions CSV (including data uploads)
   */
  async generateAllTransactionsCSV(transactions, options = {}) {
    const { taxYear, timestamp } = options;
    const filename = `cost-basis-all-transactions-${taxYear}-${timestamp}.csv`;
    const filepath = path.join(this.outputDir, filename);

    const headers = [
      "Date",
      "Time",
      "Transaction ID",
      "Wallet Address",
      "Type",
      "Tax Category",
      "Token",
      "Amount",
      "Price USD",
      "Value USD",
      "Fee AR",
      "Fee USD",
      "Cost Basis USD",
      "Proceeds USD",
      "Gain/Loss USD",
      "Holding Period",
      "Is Taxable",
      "Is User Override",
      "Override Reason",
      "Counterparty",
      "Notes",
    ];

    const rows = [headers.join(",")];

    // Sort by date
    const sorted = [...transactions].sort(
      (a, b) => (a.blockTimestamp || 0) - (b.blockTimestamp || 0)
    );

    for (const tx of sorted) {
      const date = tx.blockTimestamp
        ? new Date(tx.blockTimestamp * 1000).toISOString().split("T")[0]
        : tx.date || "";
      const time = tx.blockTimestamp
        ? new Date(tx.blockTimestamp * 1000)
            .toISOString()
            .split("T")[1]
            .split(".")[0]
        : "";

      // Handle DEX swaps - show input token as primary (the disposal)
      let tokenSymbol, amountHuman, priceUSD, valueUSD;
      if (tx.type === "DEX_SWAP" && tx.isSwap) {
        tokenSymbol = tx.inputTokenSymbol || tx.tokenSymbol || "";
        amountHuman = tx.inputAmountHuman || tx.amountHuman || 0;
        priceUSD = tx.inputPriceUSD || tx.priceUSD || 0;
        valueUSD = tx.inputValueUSD || tx.valueUSD || 0;
      } else {
        tokenSymbol = tx.tokenSymbol || tx.token || "";
        amountHuman = tx.amountHuman || tx.amount || 0;
        priceUSD = tx.priceUSD || 0;
        valueUSD = tx.valueUSD || 0;
      }

      // Build notes for swaps
      let notes = tx.notes || "";
      if (tx.type === "DEX_SWAP" && tx.outputTokenSymbol) {
        notes = `Swap ${amountHuman.toFixed(4)} ${tokenSymbol} -> ${(
          tx.outputAmountHuman || 0
        ).toFixed(4)} ${tx.outputTokenSymbol}`;
      }

      const row = [
        date,
        time,
        tx.txId || "",
        tx.walletAddress || "",
        tx.type || "",
        tx.taxCategory || "",
        tokenSymbol,
        amountHuman,
        priceUSD,
        valueUSD,
        tx.feeAR || tx.rewardAR || 0,
        tx.feeUSD || tx.feeValueUSD || 0,
        tx.costBasisUSD || 0,
        tx.proceedsUSD || 0,
        tx.gainLossUSD || 0,
        tx.holdingPeriod || "",
        tx.isTaxableEvent ? "Yes" : "No",
        tx.isUserOverridden ? "Yes" : "No",
        this.escapeCSV(tx.overrideReason || ""),
        tx.targetAddress || tx.ownerAddress || "",
        this.escapeCSV(notes),
      ];

      rows.push(row.join(","));
    }

    fs.writeFileSync(filepath, rows.join("\n"));
    return filepath;
  }

  /**
   * Generate fees summary CSV (data uploads and transaction fees)
   */
  async generateFeesSummaryCSV(transactions, options = {}) {
    const { taxYear, timestamp, excludeZeroFees = true } = options;
    const filename = `cost-basis-fees-${taxYear}-${timestamp}.csv`;
    const filepath = path.join(this.outputDir, filename);

    // Filter to transactions with ACTUAL fees paid
    // Zero-fee transactions (bundled uploads via Turbo, AO messages) have no tax impact
    // and don't need to be reported to the IRS
    let feeTransactions = transactions.filter((tx) => {
      const feeAR = tx.feeAR || tx.rewardAR || 0;
      const feeUSD = tx.feeUSD || tx.feeValueUSD || 0;

      if (excludeZeroFees) {
        // Only include if there's an actual fee
        return feeAR > 0 || feeUSD > 0;
      }
      // Legacy behavior: include all fee-related transaction types
      return feeAR > 0 || feeUSD > 0 || tx.type === "DATA_UPLOAD";
    });

    if (this.verbose) {
      console.log(
        `   Fee transactions: ${feeTransactions.length} (excludeZeroFees: ${excludeZeroFees})`
      );
    }

    const headers = [
      "Date",
      "Transaction ID",
      "Wallet Address",
      "Type",
      "Fee AR",
      "AR Price USD",
      "Fee USD",
      "Data Size Bytes",
      "Cumulative Fees AR",
      "Cumulative Fees USD",
      "Notes",
    ];

    const rows = [headers.join(",")];

    let cumulativeAR = 0;
    let cumulativeUSD = 0;

    // Sort by date
    const sorted = [...feeTransactions].sort(
      (a, b) => (a.blockTimestamp || 0) - (b.blockTimestamp || 0)
    );

    for (const tx of sorted) {
      const date = tx.blockTimestamp
        ? new Date(tx.blockTimestamp * 1000).toISOString().split("T")[0]
        : tx.date || "";

      const feeAR = tx.feeAR || tx.rewardAR || 0;
      const feeUSD = tx.feeUSD || tx.feeValueUSD || 0;

      cumulativeAR += feeAR;
      cumulativeUSD += feeUSD;

      const row = [
        date,
        tx.txId || "",
        tx.walletAddress || "",
        tx.type || "",
        feeAR,
        tx.priceUSD || 0,
        feeUSD,
        tx.dataSize || 0,
        cumulativeAR.toFixed(8),
        cumulativeUSD.toFixed(2),
        this.escapeCSV(tx.appName || tx.notes || ""),
      ];

      rows.push(row.join(","));
    }

    // Add summary row
    rows.push("");
    rows.push(
      `TOTAL,,,,,${cumulativeAR.toFixed(8)},,${cumulativeUSD.toFixed(2)},,,`
    );

    fs.writeFileSync(filepath, rows.join("\n"));
    return filepath;
  }

  /**
   * Generate tax lots CSV
   */
  async generateTaxLotsCSV(taxLots, options = {}) {
    const { taxYear, timestamp } = options;
    const filename = `cost-basis-tax-lots-${taxYear}-${timestamp}.csv`;
    const filepath = path.join(this.outputDir, filename);

    const headers = [
      "Lot ID",
      "Wallet Address",
      "Token",
      "Acquisition Date",
      "Acquisition Type",
      "Acquisition TX ID",
      "Original Quantity",
      "Remaining Quantity",
      "Cost Per Unit USD",
      "Original Cost Basis USD",
      "Remaining Cost Basis USD",
      "Status",
      "Holding Period (Days)",
      "Long-Term Eligible Date",
    ];

    const rows = [headers.join(",")];

    // Sort by acquisition date
    const sorted = [...taxLots].sort(
      (a, b) =>
        new Date(a.acquisitionDate || 0) - new Date(b.acquisitionDate || 0)
    );

    for (const lot of sorted) {
      const acquDate = lot.acquisitionDate
        ? new Date(lot.acquisitionDate).toISOString().split("T")[0]
        : "";

      const holdingDays = lot.acquisitionDate
        ? Math.floor(
            (Date.now() - new Date(lot.acquisitionDate).getTime()) /
              (1000 * 60 * 60 * 24)
          )
        : 0;

      const longTermDate = lot.acquisitionDate
        ? new Date(
            new Date(lot.acquisitionDate).getTime() + 365 * 24 * 60 * 60 * 1000
          )
            .toISOString()
            .split("T")[0]
        : "";

      const remainingQuantity =
        lot.remainingQuantity !== undefined
          ? lot.remainingQuantity
          : lot.originalQuantity;

      const status =
        remainingQuantity === 0
          ? "CLOSED"
          : remainingQuantity < lot.originalQuantity
          ? "PARTIAL"
          : "OPEN";

      const remainingCostBasis =
        lot.costPerUnit * remainingQuantity || lot.adjustedCostBasisUSD || 0;

      const row = [
        lot.lotId || "",
        lot.walletAddress || "",
        lot.tokenSymbol || "",
        acquDate,
        lot.acquisitionType || "",
        lot.acquisitionTxId || "",
        lot.originalQuantity || 0,
        remainingQuantity,
        lot.costPerUnit || 0,
        lot.originalCostBasisUSD || lot.costBasisUSD || 0,
        remainingCostBasis.toFixed(2),
        status,
        holdingDays,
        longTermDate,
      ];

      rows.push(row.join(","));
    }

    // Add summary
    const openLots = taxLots.filter(
      (l) => (l.remainingQuantity || l.originalQuantity) > 0
    );
    const totalCostBasis = openLots.reduce(
      (sum, l) =>
        sum +
        (l.remainingQuantity || l.originalQuantity) * (l.costPerUnit || 0),
      0
    );

    rows.push("");
    rows.push(
      `SUMMARY: ${
        openLots.length
      } open lots, Total Cost Basis: $${totalCostBasis.toFixed(2)}`
    );

    fs.writeFileSync(filepath, rows.join("\n"));
    return filepath;
  }

  /**
   * Generate disposals CSV with matched acquisitions
   */
  async generateDisposalsCSV(disposals, options = {}) {
    const { taxYear, timestamp } = options;
    const filename = `cost-basis-disposals-${taxYear}-${timestamp}.csv`;
    const filepath = path.join(this.outputDir, filename);

    const headers = [
      "Disposal Date",
      "Disposal TX ID",
      "Wallet Address",
      "Token",
      "Disposal Type",
      "Quantity Disposed",
      "Proceeds Per Unit USD",
      "Total Proceeds USD",
      "Cost Basis USD",
      "Gain/Loss USD",
      "Is Long-Term",
      "Holding Period",
      "Acquisition Date(s)",
      "Acquisition TX ID(s)",
      "Lots Used",
      "Accounting Method",
      "Notes",
    ];

    const rows = [headers.join(",")];

    // Sort by disposal date
    const sorted = [...disposals].sort(
      (a, b) => new Date(a.disposalDate || 0) - new Date(b.disposalDate || 0)
    );

    let totalProceeds = 0;
    let totalCostBasis = 0;
    let totalGainLoss = 0;
    let shortTermGains = 0;
    let shortTermLosses = 0;
    let longTermGains = 0;
    let longTermLosses = 0;

    for (const disposal of sorted) {
      const dispDate = disposal.disposalDate
        ? new Date(disposal.disposalDate).toISOString().split("T")[0]
        : "";

      const lotsUsed = disposal.lotsUsed || [];
      const acquisitionDates = lotsUsed
        .map((l) =>
          l.acquisitionDate
            ? new Date(l.acquisitionDate).toISOString().split("T")[0]
            : ""
        )
        .join("; ");
      const acquisitionTxIds = lotsUsed
        .map((l) => (l.lotId || "").substring(0, 12))
        .join("; ");

      const costBasis = lotsUsed.reduce(
        (sum, l) => sum + (l.costBasis || 0),
        0
      );

      totalProceeds += disposal.proceedsTotal || 0;
      totalCostBasis += costBasis;
      totalGainLoss += disposal.gainLoss || 0;

      if (disposal.isLongTerm) {
        if (disposal.gainLoss >= 0) longTermGains += disposal.gainLoss;
        else longTermLosses += Math.abs(disposal.gainLoss);
      } else {
        if (disposal.gainLoss >= 0) shortTermGains += disposal.gainLoss;
        else shortTermLosses += Math.abs(disposal.gainLoss);
      }

      const row = [
        dispDate,
        disposal.disposalTxId || "",
        disposal.walletAddress || "",
        disposal.tokenSymbol || "",
        disposal.disposalType || "",
        disposal.quantity || 0,
        disposal.proceedsPerUnit || 0,
        disposal.proceedsTotal || 0,
        costBasis.toFixed(2),
        (disposal.gainLoss || 0).toFixed(2),
        disposal.isLongTerm ? "Yes" : "No",
        disposal.isLongTerm ? "Long-Term" : "Short-Term",
        this.escapeCSV(acquisitionDates),
        this.escapeCSV(acquisitionTxIds),
        lotsUsed.length,
        disposal.accountingMethod || "FIFO",
        this.escapeCSV(disposal.notes || ""),
      ];

      rows.push(row.join(","));
    }

    // Add summary section
    rows.push("");
    rows.push("SUMMARY");
    rows.push(`Total Disposals,${disposals.length}`);
    rows.push(`Total Proceeds,$${totalProceeds.toFixed(2)}`);
    rows.push(`Total Cost Basis,$${totalCostBasis.toFixed(2)}`);
    rows.push(`Net Gain/Loss,$${totalGainLoss.toFixed(2)}`);
    rows.push("");
    rows.push("BY HOLDING PERIOD");
    rows.push(`Short-Term Gains,$${shortTermGains.toFixed(2)}`);
    rows.push(`Short-Term Losses,$${shortTermLosses.toFixed(2)}`);
    rows.push(
      `Net Short-Term,$${(shortTermGains - shortTermLosses).toFixed(2)}`
    );
    rows.push(`Long-Term Gains,$${longTermGains.toFixed(2)}`);
    rows.push(`Long-Term Losses,$${longTermLosses.toFixed(2)}`);
    rows.push(`Net Long-Term,$${(longTermGains - longTermLosses).toFixed(2)}`);

    fs.writeFileSync(filepath, rows.join("\n"));
    return filepath;
  }

  /**
   * Generate IRS Form 8949 compatible CSV
   */
  async generateForm8949CSV(disposals, options = {}) {
    const { taxYear, timestamp } = options;
    const filename = `form-8949-${taxYear}-${timestamp}.csv`;
    const filepath = path.join(this.outputDir, filename);

    // Form 8949 columns
    const headers = [
      "(a) Description of property",
      "(b) Date acquired",
      "(c) Date sold or disposed of",
      "(d) Proceeds",
      "(e) Cost or other basis",
      "(f) Adjustment code",
      "(g) Adjustment amount",
      "(h) Gain or loss",
      "Box (A/B/C)",
    ];

    const rows = [headers.join(",")];

    // Separate short-term and long-term
    const shortTerm = disposals.filter((d) => !d.isLongTerm);
    const longTerm = disposals.filter((d) => d.isLongTerm);

    // Add short-term header
    if (shortTerm.length > 0) {
      rows.push("");
      rows.push("SHORT-TERM (Box A - Basis reported to IRS)");

      for (const disposal of shortTerm) {
        const lotsUsed = disposal.lotsUsed || [];
        const acquisitionDate =
          lotsUsed.length > 0 && lotsUsed[0].acquisitionDate
            ? new Date(lotsUsed[0].acquisitionDate).toISOString().split("T")[0]
            : "VARIOUS";

        const disposalDate = disposal.disposalDate
          ? new Date(disposal.disposalDate).toISOString().split("T")[0]
          : "";

        const costBasis = lotsUsed.reduce(
          (sum, l) => sum + (l.costBasis || 0),
          0
        );

        const row = [
          `${disposal.quantity} ${disposal.tokenSymbol}`,
          acquisitionDate,
          disposalDate,
          (disposal.proceedsTotal || 0).toFixed(2),
          costBasis.toFixed(2),
          "", // Adjustment code
          "", // Adjustment amount
          (disposal.gainLoss || 0).toFixed(2),
          "A",
        ];

        rows.push(row.join(","));
      }

      // Short-term totals
      const stProceeds = shortTerm.reduce(
        (sum, d) => sum + (d.proceedsTotal || 0),
        0
      );
      const stCostBasis = shortTerm.reduce(
        (sum, d) =>
          sum + (d.lotsUsed || []).reduce((s, l) => s + (l.costBasis || 0), 0),
        0
      );
      const stGainLoss = shortTerm.reduce(
        (sum, d) => sum + (d.gainLoss || 0),
        0
      );
      rows.push(
        `SHORT-TERM TOTALS,,,${stProceeds.toFixed(2)},${stCostBasis.toFixed(
          2
        )},,,${stGainLoss.toFixed(2)},`
      );
    }

    // Add long-term header
    if (longTerm.length > 0) {
      rows.push("");
      rows.push("LONG-TERM (Box D - Basis reported to IRS)");

      for (const disposal of longTerm) {
        const lotsUsed = disposal.lotsUsed || [];
        const acquisitionDate =
          lotsUsed.length > 0 && lotsUsed[0].acquisitionDate
            ? new Date(lotsUsed[0].acquisitionDate).toISOString().split("T")[0]
            : "VARIOUS";

        const disposalDate = disposal.disposalDate
          ? new Date(disposal.disposalDate).toISOString().split("T")[0]
          : "";

        const costBasis = lotsUsed.reduce(
          (sum, l) => sum + (l.costBasis || 0),
          0
        );

        const row = [
          `${disposal.quantity} ${disposal.tokenSymbol}`,
          acquisitionDate,
          disposalDate,
          (disposal.proceedsTotal || 0).toFixed(2),
          costBasis.toFixed(2),
          "",
          "",
          (disposal.gainLoss || 0).toFixed(2),
          "D",
        ];

        rows.push(row.join(","));
      }

      // Long-term totals
      const ltProceeds = longTerm.reduce(
        (sum, d) => sum + (d.proceedsTotal || 0),
        0
      );
      const ltCostBasis = longTerm.reduce(
        (sum, d) =>
          sum + (d.lotsUsed || []).reduce((s, l) => s + (l.costBasis || 0), 0),
        0
      );
      const ltGainLoss = longTerm.reduce(
        (sum, d) => sum + (d.gainLoss || 0),
        0
      );
      rows.push(
        `LONG-TERM TOTALS,,,${ltProceeds.toFixed(2)},${ltCostBasis.toFixed(
          2
        )},,,${ltGainLoss.toFixed(2)},`
      );
    }

    fs.writeFileSync(filepath, rows.join("\n"));
    return filepath;
  }

  /**
   * Generate income CSV
   */
  async generateIncomeCSV(incomeTransactions, options = {}) {
    const { taxYear, timestamp } = options;
    const filename = `cost-basis-income-${taxYear}-${timestamp}.csv`;
    const filepath = path.join(this.outputDir, filename);

    const headers = [
      "Date",
      "Transaction ID",
      "Wallet Address",
      "Income Type",
      "Token",
      "Amount",
      "Price USD",
      "Value USD",
      "Is Staked (Deferred)",
      "Source",
      "Notes",
    ];

    const rows = [headers.join(",")];

    // Sort by date
    const sorted = [...incomeTransactions].sort(
      (a, b) => (a.blockTimestamp || 0) - (b.blockTimestamp || 0)
    );

    let totalIncome = 0;
    let totalStaked = 0;
    const byToken = {};

    for (const tx of sorted) {
      const date = tx.blockTimestamp
        ? new Date(tx.blockTimestamp * 1000).toISOString().split("T")[0]
        : tx.date || "";

      const isStaked = tx.isStaked || tx.taxCategory === "DEFERRED_INCOME";
      const value = tx.valueUSD || 0;

      if (isStaked) {
        totalStaked += value;
      } else {
        totalIncome += value;
      }

      // Track by token
      const token = tx.tokenSymbol || tx.token || "UNKNOWN";
      if (!byToken[token]) {
        byToken[token] = { count: 0, amount: 0, value: 0 };
      }
      byToken[token].count++;
      byToken[token].amount += tx.amountHuman || 0;
      byToken[token].value += value;

      const row = [
        date,
        tx.txId || "",
        tx.walletAddress || "",
        tx.type || "",
        token,
        tx.amountHuman || 0,
        tx.priceUSD || 0,
        value.toFixed(2),
        isStaked ? "Yes" : "No",
        tx.source || "",
        this.escapeCSV(tx.notes || ""),
      ];

      rows.push(row.join(","));
    }

    // Add summary
    rows.push("");
    rows.push("INCOME SUMMARY");
    rows.push(`Total Income Events,${incomeTransactions.length}`);
    rows.push(`Total Taxable Income,$${totalIncome.toFixed(2)}`);
    rows.push(`Total Staked (Deferred),$${totalStaked.toFixed(2)}`);
    rows.push("");
    rows.push("BY TOKEN");

    for (const [token, data] of Object.entries(byToken)) {
      rows.push(
        `${token},${data.count} events,${data.amount.toFixed(
          6
        )} tokens,$${data.value.toFixed(2)}`
      );
    }

    fs.writeFileSync(filepath, rows.join("\n"));
    return filepath;
  }

  /**
   * Generate current holdings CSV
   */
  async generateHoldingsCSV(taxLots, options = {}) {
    const { taxYear, timestamp } = options;
    const filename = `cost-basis-holdings-${taxYear}-${timestamp}.csv`;
    const filepath = path.join(this.outputDir, filename);

    // Group by token
    const byToken = {};

    for (const lot of taxLots) {
      const remaining = lot.remainingQuantity ?? lot.originalQuantity ?? 0;
      if (remaining <= 0) continue;

      const token = lot.tokenSymbol || "UNKNOWN";
      if (!byToken[token]) {
        byToken[token] = {
          totalQuantity: 0,
          totalCostBasis: 0,
          lots: [],
          shortTermQuantity: 0,
          longTermQuantity: 0,
        };
      }

      const costBasis = remaining * (lot.costPerUnit || 0);
      byToken[token].totalQuantity += remaining;
      byToken[token].totalCostBasis += costBasis;
      byToken[token].lots.push(lot);

      // Check holding period
      const holdingDays = lot.acquisitionDate
        ? Math.floor(
            (Date.now() - new Date(lot.acquisitionDate).getTime()) /
              (1000 * 60 * 60 * 24)
          )
        : 0;

      if (holdingDays >= 365) {
        byToken[token].longTermQuantity += remaining;
      } else {
        byToken[token].shortTermQuantity += remaining;
      }
    }

    const headers = [
      "Token",
      "Total Quantity",
      "Total Cost Basis USD",
      "Average Cost Per Unit USD",
      "Short-Term Holdings",
      "Long-Term Holdings",
      "Number of Lots",
    ];

    const rows = [headers.join(",")];

    let grandTotalCostBasis = 0;

    for (const [token, data] of Object.entries(byToken)) {
      const avgCost =
        data.totalQuantity > 0 ? data.totalCostBasis / data.totalQuantity : 0;

      grandTotalCostBasis += data.totalCostBasis;

      const row = [
        token,
        data.totalQuantity.toFixed(8),
        data.totalCostBasis.toFixed(2),
        avgCost.toFixed(4),
        data.shortTermQuantity.toFixed(8),
        data.longTermQuantity.toFixed(8),
        data.lots.length,
      ];

      rows.push(row.join(","));
    }

    // Add summary
    rows.push("");
    rows.push(`TOTAL COST BASIS,$${grandTotalCostBasis.toFixed(2)}`);

    fs.writeFileSync(filepath, rows.join("\n"));
    return filepath;
  }

  /**
   * Escape CSV value
   */
  escapeCSV(value) {
    if (value === null || value === undefined) return "";
    const str = String(value);
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }
}

module.exports = { CostBasisReportGenerator };
