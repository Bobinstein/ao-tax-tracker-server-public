/**
 * TaxReportGenerator
 *
 * Generates tax reports in PDF and CSV formats for cryptocurrency transactions.
 * Supports filtering by tax year and multiple output formats suitable for
 * tax filing and record keeping.
 *
 * Report Types:
 * 1. Transaction Report - All transactions for a period
 * 2. Capital Gains Report - Disposals with gain/loss calculations
 * 3. Income Report - Taxable income (airdrops, staking rewards, etc.)
 * 4. Summary Report - High-level overview for tax filing
 *
 * Output Formats:
 * - CSV: Compatible with TurboTax, H&R Block, and other tax software
 * - PDF: Human-readable report with formatting (requires puppeteer)
 * - JSON: Machine-readable for further processing
 *
 * @module reporters/TaxReportGenerator
 */

const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

/**
 * Report types available
 */
const REPORT_TYPES = {
  TRANSACTIONS: "transactions",
  CAPITAL_GAINS: "capital_gains",
  INCOME: "income",
  SUMMARY: "summary",
  FORM_8949: "form_8949",
};

/**
 * CSV field mappings for different report types
 */
const CSV_FIELDS = {
  transactions: [
    { header: "Date", field: "blockTimestamp", format: "unix_date" },
    { header: "Type", field: "type" },
    { header: "Wallet", field: "walletAddress" },
    { header: "Token/Input", field: "displayToken" },
    { header: "Amount", field: "displayAmount", format: "number" },
    { header: "Output Token", field: "outputTokenSymbol" },
    { header: "Output Amount", field: "outputAmountHuman", format: "number" },
    { header: "Price USD", field: "priceUSD", format: "currency" },
    { header: "Value USD", field: "valueUSD", format: "currency" },
    { header: "From", field: "fromAddress" },
    { header: "To", field: "toAddress" },
    { header: "Platform", field: "source" },
    { header: "Transaction ID", field: "txId" },
    { header: "Tax Category", field: "taxCategory" },
  ],
  capital_gains: [
    { header: "Date Sold", field: "disposalDate", format: "date" },
    { header: "Date Acquired", field: "acquisitionDate", format: "date" },
    { header: "Asset", field: "tokenSymbol" },
    { header: "Quantity", field: "quantity", format: "number" },
    { header: "Proceeds", field: "proceedsTotal", format: "currency" },
    { header: "Cost Basis", field: "costBasis", format: "currency" },
    { header: "Gain/Loss", field: "gainLoss", format: "currency" },
    { header: "Term", field: "term" },
    { header: "Transaction ID", field: "disposalTxId" },
    { header: "Accounting Method", field: "accountingMethod" },
  ],
  income: [
    { header: "Date", field: "timestamp", format: "date" },
    { header: "Income Type", field: "incomeType" },
    { header: "Token", field: "tokenSymbol" },
    { header: "Amount", field: "amount", format: "number" },
    { header: "Fair Market Value", field: "fmvUSD", format: "currency" },
    { header: "Source", field: "source" },
    { header: "Transaction ID", field: "txId" },
    { header: "Notes", field: "notes" },
  ],
  // Form 8949 format for US tax filing
  form_8949: [
    { header: "(a) Description", field: "description" },
    { header: "(b) Date acquired", field: "acquisitionDate", format: "date" },
    { header: "(c) Date sold", field: "disposalDate", format: "date" },
    { header: "(d) Proceeds", field: "proceedsTotal", format: "currency" },
    {
      header: "(e) Cost or other basis",
      field: "costBasis",
      format: "currency",
    },
    { header: "(f) Code", field: "adjustmentCode" },
    { header: "(g) Adjustment", field: "adjustment", format: "currency" },
    { header: "(h) Gain or (loss)", field: "gainLoss", format: "currency" },
  ],
};

/**
 * TaxReportGenerator class
 *
 * Generates formatted tax reports from transaction and cost basis data.
 */
// Currency symbols for display
const CURRENCY_SYMBOLS = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  AUD: "A$",
  CAD: "C$",
  CHF: "Fr.",
  CNY: "¥",
  INR: "₹",
  KRW: "₩",
  BRL: "R$",
  MXN: "MX$",
  SGD: "S$",
  HKD: "HK$",
  NZD: "NZ$",
  SEK: "kr.",
  NOK: "kr.",
  DKK: "kr.",
};

class TaxReportGenerator {
  /**
   * Create a new TaxReportGenerator instance
   *
   * @param {Object} options - Configuration options
   * @param {Object} options.costBasisService - Cost basis service for gain/loss data
   * @param {Object} options.priceService - Price service for historical prices
   * @param {Object} options.fiatConversionService - Fiat conversion service for non-USD reports
   * @param {string} options.outputDir - Directory for output files
   * @param {boolean} options.verbose - Enable verbose logging
   */
  constructor(options = {}) {
    this.costBasisService = options.costBasisService;
    this.priceService = options.priceService;
    this.fiatConversionService = options.fiatConversionService;
    this.outputDir = options.outputDir || "./reports";
    this.verbose = options.verbose || false;

    // Ensure output directory exists
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Get a string safe for filenames/subtitles from walletAddress (string or array).
   * @param {string|string[]|undefined} walletAddress - Single address or array (e.g. wallet group)
   * @param {number} maxLen - Max length (default 8 for filenames)
   * @returns {string} Short label, e.g. first maxLen chars or "multi"
   */
  _walletDisplayString(walletAddress, maxLen = 8) {
    if (!walletAddress) return "";
    const str = Array.isArray(walletAddress)
      ? walletAddress.length
        ? String(walletAddress[0])
        : "multi"
      : String(walletAddress);
    return str === "multi" ? str : str.substring(0, maxLen);
  }

  /**
   * Get currency symbol for display
   * @param {string} currency - Currency code
   * @returns {string} Currency symbol
   */
  getCurrencySymbol(currency) {
    return CURRENCY_SYMBOLS[currency] || currency + " ";
  }

  /**
   * Convert USD amount to target currency for a specific date
   * @param {number} usdAmount - Amount in USD
   * @param {string} currency - Target currency code
   * @param {number|Date} timestamp - Transaction timestamp (Unix seconds or Date)
   * @returns {Promise<number>} Converted amount
   */
  async convertAmount(usdAmount, currency, timestamp) {
    if (!usdAmount || currency === "USD" || !this.fiatConversionService) {
      return usdAmount;
    }

    // Convert timestamp to date string
    let dateStr;
    if (typeof timestamp === "number") {
      dateStr = new Date(timestamp * 1000).toISOString().split("T")[0];
    } else if (timestamp instanceof Date) {
      dateStr = timestamp.toISOString().split("T")[0];
    } else {
      dateStr = new Date().toISOString().split("T")[0];
    }

    const result = await this.fiatConversionService.convertFromUSD(
      usdAmount,
      currency,
      dateStr,
    );

    return result ? result.amount : usdAmount;
  }

  /**
   * Format a value according to its field type
   *
   * @param {any} value - Value to format
   * @param {string} format - Format type (date, number, currency)
   * @returns {string} Formatted value
   */
  formatValue(value, format) {
    // Use 0 for missing currency so CSV imports work (e.g. no price on first trading day)
    if (value === null || value === undefined) {
      if (format === "currency") return "0.00";
      if (format === "currency_5") return "0.00000";
      return "";
    }

    switch (format) {
      case "date":
        if (value instanceof Date) {
          return value.toISOString().split("T")[0];
        }
        return new Date(value).toISOString().split("T")[0];

      case "unix_date":
        // Convert Unix timestamp (seconds) to date string
        if (typeof value === "number") {
          return new Date(value * 1000).toISOString().split("T")[0];
        }
        return String(value);

      case "number":
        if (typeof value === "number") {
          return value.toFixed(8).replace(/\.?0+$/, "");
        }
        return String(value);

      case "currency":
        if (typeof value === "number") {
          return value.toFixed(2);
        }
        return String(value);

      case "currency_5":
        if (typeof value === "number") {
          return value.toFixed(5);
        }
        return String(value);

      default:
        return String(value);
    }
  }

  /**
   * Transform transactions for display in reports.
   * Handles DEX swaps by mapping input/output tokens to display fields.
   *
   * @param {Array} transactions - Array of transactions
   * @returns {Array} Transformed transactions with display fields
   */
  transformForDisplay(transactions) {
    return transactions.map((tx) => {
      const transformed = { ...tx };

      // For DEX swaps, use input token as the primary display token
      if (tx.type === "DEX_SWAP" || tx.isSwap) {
        transformed.displayToken = tx.inputTokenSymbol || tx.tokenSymbol || "";
        transformed.displayAmount = tx.inputAmountHuman || tx.amountHuman || 0;
        // Output fields are already set
      } else {
        transformed.displayToken = tx.tokenSymbol || "";
        transformed.displayAmount = tx.amountHuman || 0;
        transformed.outputTokenSymbol = "";
        transformed.outputAmountHuman = 0;
      }

      return transformed;
    });
  }

  /**
   * Get transaction date from various possible timestamp fields
   * Handles both Unix timestamps (seconds) and ISO date strings
   *
   * @param {Object} tx - Transaction object
   * @returns {Date|null} Date object or null if no valid timestamp
   */
  getTransactionDate(tx) {
    // Try blockTimestamp first (Unix seconds)
    if (tx.blockTimestamp && typeof tx.blockTimestamp === "number") {
      return new Date(tx.blockTimestamp * 1000);
    }
    // Try timestamp field
    if (tx.timestamp) {
      return new Date(tx.timestamp);
    }
    // Try processedAt
    if (tx.processedAt) {
      return new Date(tx.processedAt);
    }
    return null;
  }

  /**
   * Filter transactions by tax year
   *
   * @param {Array} transactions - Array of transactions
   * @param {number} taxYear - Tax year to filter by
   * @returns {Array} Filtered transactions
   */
  filterByTaxYear(transactions, taxYear) {
    if (!taxYear) return transactions;

    const startTimestamp =
      new Date(`${taxYear}-01-01T00:00:00Z`).getTime() / 1000;
    const endTimestamp =
      new Date(`${taxYear}-12-31T23:59:59Z`).getTime() / 1000;

    return transactions.filter((tx) => {
      const timestamp =
        tx.blockTimestamp ||
        (tx.timestamp ? new Date(tx.timestamp).getTime() / 1000 : null);
      if (!timestamp) return false;
      return timestamp >= startTimestamp && timestamp <= endTimestamp;
    });
  }

  /**
   * Generate a CSV file from data
   *
   * @param {Array} data - Array of data objects
   * @param {Array} fields - Field definitions from CSV_FIELDS
   * @param {string} filename - Output filename
   * @returns {string} Path to generated file
   */
  generateCSV(data, fields, filename) {
    const lines = [];

    // Header row
    lines.push(fields.map((f) => `"${f.header}"`).join(","));

    // Data rows
    for (const row of data) {
      const values = fields.map((f) => {
        const value = this.getNestedValue(row, f.field);
        const formatted = this.formatValue(value, f.format);
        // Escape quotes and wrap in quotes
        return `"${String(formatted).replace(/"/g, '""')}"`;
      });
      lines.push(values.join(","));
    }

    const filepath = path.join(this.outputDir, filename);
    fs.writeFileSync(filepath, lines.join("\n"));

    if (this.verbose) {
      console.log(`Generated CSV: ${filepath} (${data.length} rows)`);
    }

    return filepath;
  }

  /**
   * Get a nested value from an object using dot notation
   *
   * @param {Object} obj - Source object
   * @param {string} path - Dot-notation path
   * @returns {any} Value at path
   */
  getNestedValue(obj, path) {
    return path.split(".").reduce((o, p) => (o ? o[p] : undefined), obj);
  }

  /**
   * Generate a PDF report from data
   *
   * @param {Array} data - Array of data objects
   * @param {Array} fields - Field definitions from CSV_FIELDS
   * @param {string} filename - Output filename
   * @param {Object} options - PDF options
   * @param {string} options.title - Report title
   * @param {string} options.subtitle - Report subtitle
   * @returns {Promise<string>} Path to generated file
   */
  async generatePDF(data, fields, filename, options = {}) {
    const filepath = path.join(this.outputDir, filename);
    const doc = new PDFDocument({ margin: 50, size: "LETTER" });

    // Pipe to file
    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);

    // Use Unicode-capable font so currency symbols render correctly
    let reportFont = {
      normal: "Helvetica",
      bold: "Helvetica-Bold",
      oblique: "Helvetica-Oblique",
    };
    try {
      const pkgPath = require.resolve("dejavu-fonts-ttf/package.json");
      const fontDir = path.join(path.dirname(pkgPath), "ttf");
      const sansPath = path.join(fontDir, "DejaVuSans.ttf");
      if (fs.existsSync(sansPath)) {
        doc.registerFont("DejaVuSans", sansPath);
        doc.registerFont(
          "DejaVuSans-Bold",
          path.join(fontDir, "DejaVuSans-Bold.ttf"),
        );
        doc.registerFont(
          "DejaVuSans-Oblique",
          path.join(fontDir, "DejaVuSans-Oblique.ttf"),
        );
        reportFont = {
          normal: "DejaVuSans",
          bold: "DejaVuSans-Bold",
          oblique: "DejaVuSans-Oblique",
        };
      }
    } catch (_) {}

    // Header
    doc.fontSize(20).text(options.title || "Tax Report", { align: "center" });
    if (options.subtitle) {
      doc.fontSize(12).text(options.subtitle, { align: "center" });
    }
    doc.moveDown(2);

    // Report metadata
    doc
      .fontSize(10)
      .text(`Generated: ${new Date().toLocaleString()}`, { align: "right" });
    doc.text(`Total Records: ${data.length}`, { align: "right" });
    doc.moveDown();

    // Table header
    doc.fontSize(10).font(reportFont.bold);
    const tableTop = doc.y;
    const colWidths = this.calculateColumnWidths(fields, doc);
    let x = 50;

    // Draw header row
    fields.forEach((field, i) => {
      doc.text(field.header, x, tableTop, {
        width: colWidths[i],
        align: "left",
      });
      x += colWidths[i] + 10;
    });

    // Draw header underline
    doc
      .moveTo(50, doc.y + 5)
      .lineTo(550, doc.y + 5)
      .stroke();
    doc.moveDown();

    // Data rows
    doc.font(reportFont.normal);
    let rowCount = 0;
    const maxRowsPerPage = 30;

    for (const row of data) {
      // Check if we need a new page
      if (rowCount >= maxRowsPerPage) {
        doc.addPage();
        // Redraw header on new page
        doc.font(reportFont.bold);
        x = 50;
        const newTableTop = doc.y;
        fields.forEach((field, i) => {
          doc.text(field.header, x, newTableTop, {
            width: colWidths[i],
            align: "left",
          });
          x += colWidths[i] + 10;
        });
        doc
          .moveTo(50, doc.y + 5)
          .lineTo(550, doc.y + 5)
          .stroke();
        doc.moveDown();
        doc.font(reportFont.normal);
        rowCount = 0;
      }

      x = 50;
      const rowY = doc.y;
      const rowHeight = doc.currentLineHeight(true);
      fields.forEach((field, i) => {
        const value = this.getNestedValue(row, field.field);
        const formatted = this.formatValue(value, field.format);
        const cellText = String(formatted || "").substring(0, 30); // Truncate long values
        doc.x = x;
        doc.y = rowY;
        doc.text(cellText, x, rowY, {
          lineBreak: false,
          width: null,
          baseline: "top",
        });
        x += colWidths[i] + 10;
      });
      doc.y = rowY + rowHeight;
      doc.moveDown(0.7);
      rowCount++;
    }

    // Footer
    doc
      .fontSize(8)
      .font(reportFont.normal)
      .text(
        "This report is not an official government form. The information presented must be entered on the correct tax forms and schedules when filing. Consult a tax professional as needed.",
        { align: "center" },
      );
    doc.moveDown(0.5);
    doc
      .font(reportFont.oblique)
      .text("Price aggregations may include data from CoinGecko", {
        align: "center",
      });
    doc.moveDown(0.3);
    doc
      .font(reportFont.normal)
      .text(
        "Please report any suspected inaccuracies to admin@gigautility.com",
        { align: "center" },
      );

    // Finalize PDF
    doc.end();

    // Wait for stream to finish
    await new Promise((resolve, reject) => {
      stream.on("finish", resolve);
      stream.on("error", reject);
    });

    if (this.verbose) {
      console.log(`Generated PDF: ${filepath} (${data.length} rows)`);
    }

    return filepath;
  }

  /**
   * Calculate column widths for PDF table
   *
   * @param {Array} fields - Field definitions
   * @param {Object} doc - PDFDocument instance
   * @returns {Array} Array of column widths
   */
  calculateColumnWidths(fields, doc) {
    const contentWidth = 500; // Table area: 50 to 550
    const gap = 5;
    const numCols = fields.length;
    const maxTotalColWidth = contentWidth - (numCols - 1) * gap; // leave room for gaps
    const baseWidth = maxTotalColWidth / numCols;
    const minWidth = 50;
    const maxWidth = 120; // lower so total fits; headers may wrap if needed
    const padding = 6;

    let widths = fields.map((field) => {
      // Use actual header width so headers (e.g. "Output Amount") don't wrap
      let minColWidth = field.header.length * 6;
      if (doc && typeof doc.widthOfString === "function") {
        const measured = doc.widthOfString(field.header);
        minColWidth = Math.max(minColWidth, measured + padding);
      }
      let width = Math.max(minColWidth, baseWidth);
      width = Math.max(minWidth, Math.min(maxWidth, width));
      return width;
    });

    // Constrain total so table does not extend past right margin
    const sum = widths.reduce((a, b) => a + b, 0);
    if (sum > maxTotalColWidth) {
      const scale = maxTotalColWidth / sum;
      widths = widths.map((w) => Math.max(minWidth, w * scale));
    }
    return widths;
  }

  /**
   * Generate transaction report for a tax year
   *
   * @param {Array} transactions - Array of unified transactions
   * @param {Object} options - Report options
   * @param {number} options.taxYear - Tax year to filter by
   * @param {string} options.walletAddress - Filter by wallet
   * @param {string} options.format - Output format (csv, json)
   * @returns {Object} Report result with filepath and summary
   */
  async generateTransactionReport(transactions, options = {}) {
    const {
      taxYear,
      walletAddress,
      format = "csv",
      includeNonTaxable = false,
    } = options;

    // Filter transactions by tax year using helper method
    let filtered = this.filterByTaxYear(transactions, taxYear);

    // Filter by wallet if specified (support single address or array e.g. wallet group)
    if (walletAddress) {
      const walletSet = Array.isArray(walletAddress)
        ? new Set(walletAddress)
        : new Set([walletAddress]);
      filtered = filtered.filter(
        (tx) =>
          walletSet.has(tx.walletAddress) ||
          walletSet.has(tx.fromAddress) ||
          walletSet.has(tx.toAddress),
      );
    }

    // Filter to taxable events only (unless includeNonTaxable is true)
    if (!includeNonTaxable) {
      filtered = filtered.filter((tx) => {
        // Always exclude internal transfers - these are never taxable
        if (tx.isInternalTransfer) return false;
        // Include taxable events
        return tx.isTaxableEvent;
      });
    }

    // Sort by blockTimestamp (ascending)
    filtered.sort((a, b) => (a.blockTimestamp || 0) - (b.blockTimestamp || 0));

    // Transform for display (handles DEX swaps)
    const displayData = this.transformForDisplay(filtered);

    // Generate output
    const timestamp = Date.now();
    const walletLabel = this._walletDisplayString(walletAddress);
    const walletSuffix = walletLabel ? `-${walletLabel}` : "";
    const yearSuffix = taxYear ? `-${taxYear}` : "";
    const filename = `transactions${walletSuffix}${yearSuffix}-${timestamp}.${format}`;

    let filepath;
    if (format === "csv") {
      filepath = this.generateCSV(
        displayData,
        CSV_FIELDS.transactions,
        filename,
      );
    } else if (format === "pdf") {
      filepath = await this.generatePDF(
        filtered,
        CSV_FIELDS.transactions,
        filename,
        {
          title: `Transaction Report${taxYear ? ` - ${taxYear}` : ""}`,
          subtitle: walletLabel
            ? `Wallet: ${this._walletDisplayString(walletAddress, 12)}...`
            : "All Wallets",
        },
      );
    } else {
      filepath = path.join(this.outputDir, filename);
      fs.writeFileSync(filepath, JSON.stringify(filtered, null, 2));
    }

    // Generate summary
    const summary = {
      totalTransactions: filtered.length,
      taxableEvents: filtered.filter((tx) => tx.isTaxableEvent).length,
      byType: {},
      byToken: {},
      dateRange: {
        start:
          filtered.length > 0 ? this.getTransactionDate(filtered[0]) : null,
        end:
          filtered.length > 0
            ? this.getTransactionDate(filtered[filtered.length - 1])
            : null,
      },
    };

    for (const tx of filtered) {
      summary.byType[tx.type] = (summary.byType[tx.type] || 0) + 1;
      const token = tx.tokenSymbol || "UNKNOWN";
      summary.byToken[token] = (summary.byToken[token] || 0) + 1;
    }

    return { filepath, summary, reportType: REPORT_TYPES.TRANSACTIONS };
  }

  /**
   * Generate capital gains report for a tax year
   *
   * @param {string} walletAddress - Wallet address
   * @param {Object} options - Report options
   * @param {number} options.taxYear - Tax year
   * @param {string} options.format - Output format (csv, json)
   * @returns {Object} Report result with filepath and summary
   */
  async generateCapitalGainsReport(walletAddress, options = {}) {
    const { taxYear, format = "csv" } = options;

    if (!this.costBasisService) {
      throw new Error("CostBasisService is required for capital gains reports");
    }

    // Get disposals for the year (support single wallet or array for wallet group)
    const startDate = taxYear ? new Date(`${taxYear}-01-01T00:00:00Z`) : null;
    const endDate = taxYear ? new Date(`${taxYear}-12-31T23:59:59Z`) : null;

    const wallets = Array.isArray(walletAddress)
      ? walletAddress
      : [walletAddress];
    let disposals = [];
    for (const w of wallets) {
      const d = await this.costBasisService.getDisposals(w, {
        startDate,
        endDate,
      });
      disposals = disposals.concat(d);
    }

    // Transform disposals for report
    const reportData = disposals.map((d) => {
      // Get earliest acquisition date from lots used
      const earliestAcquisition =
        d.lotsUsed.length > 0
          ? d.lotsUsed.reduce(
              (min, lot) =>
                lot.acquisitionDate < min ? lot.acquisitionDate : min,
              d.lotsUsed[0].acquisitionDate,
            )
          : null;

      return {
        ...d,
        acquisitionDate: earliestAcquisition,
        term: d.isLongTerm ? "Long-term" : "Short-term",
        costBasis: d.lotsUsed.reduce((sum, l) => sum + l.costBasis, 0),
      };
    });

    // Sort by disposal date
    reportData.sort(
      (a, b) => new Date(a.disposalDate) - new Date(b.disposalDate),
    );

    // Generate output
    const timestamp = Date.now();
    const walletLabel = this._walletDisplayString(walletAddress);
    const filename = `capital-gains-${walletLabel}-${
      taxYear || "all"
    }-${timestamp}.${format}`;

    let filepath;
    if (format === "csv") {
      filepath = this.generateCSV(
        reportData,
        CSV_FIELDS.capital_gains,
        filename,
      );
    } else if (format === "pdf") {
      filepath = await this.generatePDF(
        reportData,
        CSV_FIELDS.capital_gains,
        filename,
        {
          title: `Capital Gains Report${taxYear ? ` - ${taxYear}` : ""}`,
          subtitle: `Wallet: ${this._walletDisplayString(walletAddress, 12)}...`,
        },
      );
    } else {
      filepath = path.join(this.outputDir, filename);
      fs.writeFileSync(filepath, JSON.stringify(reportData, null, 2));
    }

    // Calculate summary
    const summary = {
      totalDisposals: reportData.length,
      shortTermGains: 0,
      shortTermLosses: 0,
      longTermGains: 0,
      longTermLosses: 0,
      netShortTerm: 0,
      netLongTerm: 0,
      netTotal: 0,
    };

    for (const d of reportData) {
      if (d.isLongTerm) {
        if (d.gainLoss >= 0) summary.longTermGains += d.gainLoss;
        else summary.longTermLosses += Math.abs(d.gainLoss);
      } else {
        if (d.gainLoss >= 0) summary.shortTermGains += d.gainLoss;
        else summary.shortTermLosses += Math.abs(d.gainLoss);
      }
    }

    summary.netShortTerm = summary.shortTermGains - summary.shortTermLosses;
    summary.netLongTerm = summary.longTermGains - summary.longTermLosses;
    summary.netTotal = summary.netShortTerm + summary.netLongTerm;

    return { filepath, summary, reportType: REPORT_TYPES.CAPITAL_GAINS };
  }

  /**
   * Generate IRS Form 8949 formatted report
   *
   * @param {string} walletAddress - Wallet address
   * @param {Object} options - Report options
   * @param {number} options.taxYear - Tax year
   * @returns {Object} Report result with separate short-term and long-term files
   */
  async generateForm8949Report(walletAddress, options = {}) {
    const { taxYear } = options;

    if (!this.costBasisService) {
      throw new Error("CostBasisService is required for Form 8949 reports");
    }

    const startDate = taxYear ? new Date(`${taxYear}-01-01T00:00:00Z`) : null;
    const endDate = taxYear ? new Date(`${taxYear}-12-31T23:59:59Z`) : null;

    const wallets = Array.isArray(walletAddress)
      ? walletAddress
      : [walletAddress];
    let disposals = [];
    for (const w of wallets) {
      const d = await this.costBasisService.getDisposals(w, {
        startDate,
        endDate,
      });
      disposals = disposals.concat(d);
    }

    // Transform to Form 8949 format
    const transformForForm8949 = (d) => {
      const earliestAcquisition =
        d.lotsUsed.length > 0
          ? d.lotsUsed.reduce(
              (min, lot) =>
                lot.acquisitionDate < min ? lot.acquisitionDate : min,
              d.lotsUsed[0].acquisitionDate,
            )
          : null;

      const costBasis = d.lotsUsed.reduce((sum, l) => sum + l.costBasis, 0);

      return {
        description: `${d.quantity} ${d.tokenSymbol}`,
        acquisitionDate: earliestAcquisition,
        disposalDate: d.disposalDate,
        proceedsTotal: d.proceedsTotal,
        costBasis: costBasis,
        adjustmentCode: "", // No adjustment unless wash sale, etc.
        adjustment: 0,
        gainLoss: d.gainLoss,
      };
    };

    const shortTerm = disposals
      .filter((d) => !d.isLongTerm)
      .map(transformForForm8949);
    const longTerm = disposals
      .filter((d) => d.isLongTerm)
      .map(transformForForm8949);

    const timestamp = Date.now();
    const walletPrefix = this._walletDisplayString(walletAddress);

    // Generate short-term report (Part I)
    const shortTermFile = this.generateCSV(
      shortTerm,
      CSV_FIELDS.form_8949,
      `form8949-partI-${walletPrefix}-${taxYear || "all"}-${timestamp}.csv`,
    );

    // Generate long-term report (Part II)
    const longTermFile = this.generateCSV(
      longTerm,
      CSV_FIELDS.form_8949,
      `form8949-partII-${walletPrefix}-${taxYear || "all"}-${timestamp}.csv`,
    );

    const summary = {
      shortTermTransactions: shortTerm.length,
      longTermTransactions: longTerm.length,
      shortTermTotal: shortTerm.reduce((sum, t) => sum + t.gainLoss, 0),
      longTermTotal: longTerm.reduce((sum, t) => sum + t.gainLoss, 0),
    };

    return {
      shortTermFile,
      longTermFile,
      summary,
      reportType: REPORT_TYPES.FORM_8949,
    };
  }

  /**
   * Generate income report for tax year
   *
   * @param {Array} transactions - Array of unified transactions
   * @param {Object} options - Report options
   * @param {number} options.taxYear - Tax year
   * @param {string} options.walletAddress - Filter by wallet
   * @returns {Object} Report result
   */
  async generateIncomeReport(transactions, options = {}) {
    const { taxYear, walletAddress, format = "csv" } = options;

    // Filter for income events (airdrops, staking rewards, mining rewards)
    const incomeTypes = [
      "AIRDROP",
      "STAKING_REWARD",
      "MINING_REWARD",
      "INCOME",
      "GATEWAY_REWARD",
    ];

    let income = transactions.filter(
      (tx) =>
        incomeTypes.includes(tx.type) || tx.taxClassification === "INCOME",
    );

    // Filter by tax year using helper method
    income = this.filterByTaxYear(income, taxYear);

    // Filter by wallet (support single address or array)
    if (walletAddress) {
      const walletSet = Array.isArray(walletAddress)
        ? new Set(walletAddress)
        : new Set([walletAddress]);
      income = income.filter((tx) => walletSet.has(tx.walletAddress));
    }

    // Transform for report
    const reportData = income.map((tx) => ({
      timestamp: tx.blockTimestamp
        ? new Date(tx.blockTimestamp * 1000).toISOString()
        : tx.processedAt,
      incomeType: tx.type,
      tokenSymbol: tx.tokenSymbol || "UNKNOWN",
      amount: tx.amountHuman || 0,
      fmvUSD: tx.priceUSD ? (tx.amountHuman || 0) * tx.priceUSD : 0,
      source: tx.fromAddress || tx.source || "Unknown",
      txId: tx.txId,
      notes: tx.taxCategory || "",
    }));

    // Sort by date
    reportData.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    // Generate output
    const timestamp = Date.now();
    const walletLabel = this._walletDisplayString(walletAddress);
    const walletSuffix = walletLabel ? `-${walletLabel}` : "";
    const filename = `income${walletSuffix}-${
      taxYear || "all"
    }-${timestamp}.${format}`;

    let filepath;
    if (format === "pdf") {
      filepath = await this.generatePDF(
        reportData,
        CSV_FIELDS.income,
        filename,
        {
          title: `Income Report${taxYear ? ` - ${taxYear}` : ""}`,
          subtitle: walletLabel
            ? `Wallet: ${this._walletDisplayString(walletAddress, 12)}...`
            : "All Wallets",
        },
      );
    } else if (format === "csv") {
      filepath = this.generateCSV(reportData, CSV_FIELDS.income, filename);
    } else {
      filepath = path.join(this.outputDir, filename);
      fs.writeFileSync(filepath, JSON.stringify(reportData, null, 2));
    }

    // Calculate summary
    const summary = {
      totalIncomeEvents: reportData.length,
      totalFMV: reportData.reduce((sum, r) => sum + r.fmvUSD, 0),
      byType: {},
      byToken: {},
    };

    for (const r of reportData) {
      summary.byType[r.incomeType] =
        (summary.byType[r.incomeType] || 0) + r.fmvUSD;
      summary.byToken[r.tokenSymbol] =
        (summary.byToken[r.tokenSymbol] || 0) + r.fmvUSD;
    }

    return { filepath, summary, reportType: REPORT_TYPES.INCOME };
  }

  /**
   * Generate comprehensive summary report
   *
   * @param {string} walletAddress - Wallet address (or array of addresses)
   * @param {Array} transactions - All transactions
   * @param {Object} options - Report options
   * @param {number} options.taxYear - Tax year
   * @returns {Object} Summary report
   */
  async generateSummaryReport(walletAddress, transactions, options = {}) {
    const { taxYear, format = "json" } = options;
    const wallets = Array.isArray(walletAddress)
      ? walletAddress
      : [walletAddress];

    // Get capital gains summary if available
    let capitalGainsSummary = null;
    if (this.costBasisService) {
      capitalGainsSummary = {};
      for (const wallet of wallets) {
        try {
          capitalGainsSummary[wallet] =
            await this.costBasisService.getTaxYearSummary(wallet, taxYear);
        } catch (error) {
          capitalGainsSummary[wallet] = { error: error.message };
        }
      }
    }

    // Filter transactions for the year using helper method
    const yearTransactions = this.filterByTaxYear(transactions, taxYear);

    // Build comprehensive summary
    const summary = {
      reportDate: new Date().toISOString(),
      taxYear: taxYear || "All Years",
      wallets,
      transactionSummary: {
        total: yearTransactions.length,
        taxable: yearTransactions.filter((tx) => tx.isTaxableEvent).length,
        nonTaxable: yearTransactions.filter((tx) => !tx.isTaxableEvent).length,
        byType: {},
        byPlatform: {},
      },
      capitalGains: capitalGainsSummary,
      tokensTraded: new Set(),
      platforms: new Set(),
    };

    // Aggregate transaction data
    for (const tx of yearTransactions) {
      // Count by type
      summary.transactionSummary.byType[tx.type] =
        (summary.transactionSummary.byType[tx.type] || 0) + 1;

      // Count by platform
      if (tx.platform) {
        summary.transactionSummary.byPlatform[tx.platform] =
          (summary.transactionSummary.byPlatform[tx.platform] || 0) + 1;
        summary.platforms.add(tx.platform);
      }

      // Track tokens
      if (tx.tokenSymbol) {
        summary.tokensTraded.add(tx.tokenSymbol);
      }
    }

    // Convert sets to arrays
    summary.tokensTraded = Array.from(summary.tokensTraded).sort();
    summary.platforms = Array.from(summary.platforms).sort();

    // Calculate totals from capital gains
    if (capitalGainsSummary) {
      let totalNetGain = 0;
      let totalShortTerm = 0;
      let totalLongTerm = 0;

      for (const [, data] of Object.entries(capitalGainsSummary)) {
        if (!data.error) {
          totalNetGain += data.netTotal || 0;
          totalShortTerm += data.netShortTerm || 0;
          totalLongTerm += data.netLongTerm || 0;
        }
      }

      summary.totals = {
        netCapitalGain: totalNetGain,
        netShortTermGain: totalShortTerm,
        netLongTermGain: totalLongTerm,
      };
    }

    // Write summary file
    const timestamp = Date.now();
    const filename = `tax-summary-${taxYear || "all"}-${timestamp}.${format}`;
    const filepath = path.join(this.outputDir, filename);

    fs.writeFileSync(filepath, JSON.stringify(summary, null, 2));

    if (this.verbose) {
      console.log(`Generated summary report: ${filepath}`);
    }

    return { filepath, summary, reportType: REPORT_TYPES.SUMMARY };
  }

  /**
   * Generate all reports for a tax year
   *
   * @param {string|Array} walletAddress - Wallet address(es)
   * @param {Array} transactions - All transactions
   * @param {Object} options - Report options
   * @param {number} options.taxYear - Tax year
   * @returns {Object} Object containing all generated reports
   */
  async generateAllReports(walletAddress, transactions, options = {}) {
    const results = {};

    console.log(
      `Generating tax reports for ${options.taxYear || "all years"}...`,
    );

    // Transaction report
    console.log("  Generating transaction report...");
    results.transactions = await this.generateTransactionReport(
      transactions,
      options,
    );

    // Capital gains report (if cost basis service available)
    if (this.costBasisService) {
      console.log("  Generating capital gains report...");
      const wallets = Array.isArray(walletAddress)
        ? walletAddress
        : [walletAddress];
      results.capitalGains = {};
      for (const wallet of wallets) {
        results.capitalGains[wallet] = await this.generateCapitalGainsReport(
          wallet,
          options,
        );
      }

      // Form 8949 report
      console.log("  Generating Form 8949 report...");
      results.form8949 = {};
      for (const wallet of wallets) {
        results.form8949[wallet] = await this.generateForm8949Report(
          wallet,
          options,
        );
      }
    }

    // Income report
    console.log("  Generating income report...");
    results.income = await this.generateIncomeReport(transactions, options);

    // Summary report
    console.log("  Generating summary report...");
    results.summary = await this.generateSummaryReport(
      walletAddress,
      transactions,
      options,
    );

    console.log("Tax report generation complete!");

    return results;
  }

  /**
   * Generate a comprehensive PDF report combining all sections
   *
   * @param {string|Array} walletAddress - Wallet address(es)
   * @param {Array} transactions - All transactions
   * @param {Object} options - Report options
   * @param {number} options.taxYear - Tax year
   * @returns {Promise<string>} Path to generated PDF file
   */
  async generateComprehensivePDF(walletAddress, transactions, options = {}) {
    const { taxYear, includeNonTaxable = false, currency = "USD" } = options;
    const wallets = Array.isArray(walletAddress)
      ? walletAddress
      : [walletAddress];
    const timestamp = Date.now();

    // Include currency in filename if not USD
    const currencySuffix = currency !== "USD" ? `-${currency}` : "";
    const filename = `tax-report-comprehensive-${
      taxYear || "all"
    }${currencySuffix}-${timestamp}.pdf`;
    const filepath = path.join(this.outputDir, filename);

    const doc = new PDFDocument({
      margin: { top: 72, left: 50, right: 50, bottom: 50 },
      size: "LETTER",
    });
    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);

    // Use Unicode-capable font so currency symbols (€, £, ¥, ₹, etc.) render correctly
    let reportFont = {
      normal: "Helvetica",
      bold: "Helvetica-Bold",
      oblique: "Helvetica-Oblique",
    };
    try {
      const pkgPath = require.resolve("dejavu-fonts-ttf/package.json");
      const fontDir = path.join(path.dirname(pkgPath), "ttf");
      const sansPath = path.join(fontDir, "DejaVuSans.ttf");
      if (fs.existsSync(sansPath)) {
        doc.registerFont("DejaVuSans", sansPath);
        doc.registerFont(
          "DejaVuSans-Bold",
          path.join(fontDir, "DejaVuSans-Bold.ttf"),
        );
        doc.registerFont(
          "DejaVuSans-Oblique",
          path.join(fontDir, "DejaVuSans-Oblique.ttf"),
        );
        reportFont = {
          normal: "DejaVuSans",
          bold: "DejaVuSans-Bold",
          oblique: "DejaVuSans-Oblique",
        };
      }
    } catch (_) {
      // fallback to Helvetica if DejaVu not available
    }

    // Full content width for paragraph/note text (avoids narrow column when x was advanced)
    const contentWidth = 512; // LETTER 612 - 50 left - 50 right margin

    const FOOTNOTE_HEIGHT = 22;
    const footnoteText =
      currency === "USD"
        ? "USD values are rounded to the nearest 1/1000th of a cent."
        : `${currency} values are rounded to the nearest 1/1000th of a cent (or equivalent smallest unit).`;

    const drawTablePageFootnote = () => {
      doc.fontSize(7).font(reportFont.oblique);
      const footnoteY =
        doc.page.height - doc.page.margins.bottom - FOOTNOTE_HEIGHT;
      doc.x = 50;
      doc.text(footnoteText, 50, footnoteY, {
        width: contentWidth,
        align: "left",
      });
      doc.font(reportFont.normal);
    };

    // Currency symbol for this report
    const currencySymbol = this.getCurrencySymbol(currency);

    // Helper to format currency value with symbol
    const formatCurrency = (value) => {
      if (value === null || value === undefined) return `${currencySymbol}0.00`;
      return `${currencySymbol}${value.toFixed(2)}`;
    };

    // Title page
    doc.fontSize(24).text("Cryptocurrency Tax Report", { align: "center" });
    doc.moveDown();
    if (taxYear) {
      doc.fontSize(18).text(`Tax Year ${taxYear}`, { align: "center" });
      // Add date range (use UTC to avoid timezone issues)
      const startDate = new Date(`${taxYear}-01-01T00:00:00Z`);
      const endDate = new Date(`${taxYear}-12-31T23:59:59Z`);
      const startDateStr = `${startDate.getUTCFullYear()}-${String(startDate.getUTCMonth() + 1).padStart(2, "0")}-${String(startDate.getUTCDate()).padStart(2, "0")}`;
      const endDateStr = `${endDate.getUTCFullYear()}-${String(endDate.getUTCMonth() + 1).padStart(2, "0")}-${String(endDate.getUTCDate()).padStart(2, "0")}`;
      doc.fontSize(12).text(`Report Period: ${startDateStr} to ${endDateStr}`, {
        align: "center",
      });
    }
    doc.moveDown(0.5);

    // Show currency if not USD
    if (currency !== "USD") {
      doc.fontSize(12).text(`Currency: ${currency}`, { align: "center" });
      doc
        .fontSize(9)
        .text(
          `(Each transaction converted at its actual date's exchange rate)`,
          { align: "center" },
        );
    }
    doc.moveDown(2);

    doc.fontSize(12);
    doc.text(`Generated: ${new Date().toLocaleString()}`, { align: "center" });
    doc.text(`Wallets: ${wallets.length}`, { align: "center" });
    doc.moveDown(3);

    // Wallet addresses
    doc.fontSize(10).font(reportFont.bold).text("Wallet Addresses:", 50, doc.y);
    doc.font(reportFont.normal);
    wallets.forEach((wallet, i) => {
      doc.text(`${i + 1}. ${wallet}`, 70, doc.y + 5);
      doc.moveDown(0.5);
    });

    // Bazar Profiles (if any were discovered)
    const profiles = options.profiles || [];
    if (profiles.length > 0) {
      doc.moveDown();
      doc
        .fontSize(10)
        .font(reportFont.bold)
        .text("Bazar Profiles Included:", 50, doc.y);
      doc.font(reportFont.normal);
      profiles.forEach((profile, i) => {
        const profileName =
          profile.username || profile.displayName || "(unnamed)";
        const profileId = profile.profileId || profile.id || "unknown";
        const parentWallet =
          profile.parentWallet || profile.walletAddress || "";
        doc.text(`${i + 1}. ${profileName}`, 70, doc.y + 5);
        doc.fontSize(8).text(`   Profile: ${profileId}`, 70);
        if (parentWallet) {
          doc.text(`   Owner: ${parentWallet}`, 70);
        }
        doc.fontSize(10);
        doc.moveDown(0.5);
      });
      doc.moveDown(0.5);
      doc.fontSize(9).font(reportFont.oblique);
      doc.text(
        "Note: Bazar profiles are AO smart contracts that can hold assets. " +
          "Transactions between your wallets and their profiles are treated as internal transfers (non-taxable).",
        50,
        doc.y,
        { width: contentWidth },
      );
      doc.font(reportFont.normal);
    }

    doc.addPage();

    // Filter transactions for tax year using helper method
    let yearTransactions = this.filterByTaxYear(transactions, taxYear);

    // Filter to taxable events only (unless includeNonTaxable is true)
    const allYearTransactions = yearTransactions;
    if (!includeNonTaxable) {
      yearTransactions = yearTransactions.filter((tx) => {
        // Always exclude internal transfers - these are never taxable
        if (tx.isInternalTransfer) return false;
        // Include taxable events
        return tx.isTaxableEvent;
      });
    }

    // Sort by date (ascending), with secondary sort for same-timestamp transactions
    yearTransactions.sort((a, b) => {
      const tsA = a.blockTimestamp || 0;
      const tsB = b.blockTimestamp || 0;
      if (tsA !== tsB) {
        return tsA - tsB;
      }
      // Same timestamp: use txId as tiebreaker for stable sort
      return (a.txId || "").localeCompare(b.txId || "");
    });

    // Transform for display (handles DEX swaps)
    const displayTransactions = this.transformForDisplay(yearTransactions);

    // Summary section
    doc.fontSize(16).font(reportFont.bold).text("Executive Summary", 50, doc.y);
    doc.moveDown();
    doc.fontSize(10).font(reportFont.normal);

    const taxableEvents = allYearTransactions.filter(
      (tx) => tx.isTaxableEvent && !tx.isInternalTransfer,
    );
    const internalTransfers = allYearTransactions.filter(
      (tx) => tx.isInternalTransfer,
    );
    const dataUploads = allYearTransactions.filter(
      (tx) => tx.type === "DATA_UPLOAD",
    );
    // Collect all unique tokens (including swap input/output tokens)
    const uniqueTokens = new Set();
    yearTransactions.forEach((tx) => {
      if (tx.tokenSymbol) uniqueTokens.add(tx.tokenSymbol);
      if (tx.inputTokenSymbol) uniqueTokens.add(tx.inputTokenSymbol);
      if (tx.outputTokenSymbol) uniqueTokens.add(tx.outputTokenSymbol);
    });

    // Calculate financial summary
    const acquisitions = yearTransactions.filter(
      (tx) => tx.taxCategory === "ACQUISITION" || tx.type === "RECEIVE",
    );
    const disposals = yearTransactions.filter(
      (tx) =>
        tx.taxCategory === "DISPOSAL" ||
        tx.type === "SEND" ||
        tx.type === "DEX_SWAP",
    );
    // Separate liquid and staked distributions
    const allDistributions = yearTransactions.filter(
      (tx) =>
        tx.type === "DISTRIBUTION" ||
        tx.taxCategory === "INCOME" ||
        tx.taxCategory === "DEFERRED_INCOME",
    );
    const liquidDistributions = allDistributions.filter((tx) => !tx.isStaked);
    const stakedDistributions = allDistributions.filter((tx) => tx.isStaked);

    // DEX Swaps analysis
    const dexSwaps = yearTransactions.filter(
      (tx) => tx.type === "DEX_SWAP" && tx.isSwap,
    );

    // Helper to convert a single USD value at transaction date
    const convertAtTxDate = async (usdValue, timestamp) => {
      if (currency === "USD" || !this.fiatConversionService || !usdValue) {
        return usdValue || 0;
      }
      return await this.convertAmount(usdValue, currency, timestamp);
    };

    // Convert each transaction's values at its actual date (for tax accuracy)
    // This is critical: exchange rates change daily, so we must convert at transaction time

    // Calculate gross income from acquisitions (converted per-transaction)
    let acquisitionIncome = 0;
    for (const tx of acquisitions) {
      const usdValue =
        tx.valueUSD || (tx.amountHuman || 0) * (tx.priceUSD || 0);
      acquisitionIncome += await convertAtTxDate(usdValue, tx.blockTimestamp);
    }

    // Calculate liquid distribution income (taxable) - converted per-transaction
    let liquidDistributionIncome = 0;
    for (const tx of liquidDistributions) {
      const usdValue =
        tx.valueUSD || (tx.amountHuman || 0) * (tx.priceUSD || 0);
      liquidDistributionIncome += await convertAtTxDate(
        usdValue,
        tx.blockTimestamp,
      );
    }

    // Calculate staked distribution income (deferred) - converted per-transaction
    let stakedDistributionIncome = 0;
    for (const tx of stakedDistributions) {
      const usdValue =
        tx.valueUSD || (tx.amountHuman || 0) * (tx.priceUSD || 0);
      stakedDistributionIncome += await convertAtTxDate(
        usdValue,
        tx.blockTimestamp,
      );
    }

    // Total gross taxable income (only liquid distributions)
    const grossIncome = acquisitionIncome + liquidDistributionIncome;

    // Separate disposals into DEX swaps and non-swap disposals
    // Note: DEX_SWAP transactions are already in disposals array, but we want to separate them
    const nonSwapDisposals = disposals.filter((tx) => tx.type !== "DEX_SWAP");
    // Use dexSwaps array for swap disposals (already filtered)
    const swapDisposals = dexSwaps;

    // Calculate non-swap disposal metrics - converted per-transaction
    let nonSwapDisposalCostBasis = 0;
    let nonSwapDisposalProceeds = 0;
    for (const tx of nonSwapDisposals) {
      // Cost basis converted at disposal date (when the tax event occurs)
      nonSwapDisposalCostBasis += await convertAtTxDate(
        tx.costBasisUSD || 0,
        tx.blockTimestamp,
      );
      const usdProceeds =
        tx.proceedsUSD ||
        tx.valueUSD ||
        (tx.amountHuman || 0) * (tx.priceUSD || 0);
      nonSwapDisposalProceeds += await convertAtTxDate(
        usdProceeds,
        tx.blockTimestamp,
      );
    }
    // Calculate gain/loss from converted values
    const nonSwapDisposalGainLoss =
      nonSwapDisposalProceeds - nonSwapDisposalCostBasis;

    // DEX Swap analysis - converted per-transaction
    let swapCostBasis = 0;
    let swapProceeds = 0;
    for (const tx of swapDisposals) {
      swapCostBasis += await convertAtTxDate(
        tx.costBasisUSD || 0,
        tx.blockTimestamp,
      );
      const usdProceeds = tx.proceedsUSD || tx.outputValueUSD || 0;
      swapProceeds += await convertAtTxDate(usdProceeds, tx.blockTimestamp);
    }
    // Calculate gain/loss from converted values
    const swapGainLoss = swapProceeds - swapCostBasis;

    // Total disposal metrics (non-swap + swap)
    const totalDisposalCostBasis = nonSwapDisposalCostBasis + swapCostBasis;
    const totalDisposalProceeds = nonSwapDisposalProceeds + swapProceeds;
    // Calculate total gain/loss as total proceeds - total cost basis
    const totalDisposalGainLoss =
      totalDisposalProceeds - totalDisposalCostBasis;

    // Calculate staked token amounts by type (converted per-transaction)
    const stakedByToken = {};
    for (const tx of stakedDistributions) {
      const token = tx.tokenSymbol || tx.token || "UNKNOWN";
      if (!stakedByToken[token]) {
        stakedByToken[token] = { count: 0, amount: 0, value: 0 };
      }
      stakedByToken[token].count++;
      stakedByToken[token].amount += tx.amountHuman || 0;
      const usdValue =
        tx.valueUSD || (tx.amountHuman || 0) * (tx.priceUSD || 0);
      stakedByToken[token].value += await convertAtTxDate(
        usdValue,
        tx.blockTimestamp,
      );
    }

    // Accounting Method
    const accountingMethod = "FIFO"; // First In, First Out

    // Note: All values above are already converted to target currency at transaction date
    // This is the tax-correct approach: convert at the rate on the day of each transaction

    doc.font(reportFont.bold).text("Accounting Method: ", { continued: true });
    doc.font(reportFont.normal).text(accountingMethod);
    doc.moveDown(0.5);

    doc.text(`Total Year Transactions: ${allYearTransactions.length}`);
    doc.text(`Taxable Events (shown in report): ${taxableEvents.length}`);
    doc.text(`Data Uploads (not shown): ${dataUploads.length}`);
    doc.text(`Internal Transfers (not shown): ${internalTransfers.length}`);
    doc.text(`Unique Tokens: ${uniqueTokens.size}`);
    doc.moveDown();

    // Income Summary (values already converted per-transaction)
    doc.font(reportFont.bold).text("Income Summary:");
    doc.font(reportFont.normal);
    doc.text(
      `  Acquisitions: ${
        acquisitions.length
      } events - ${formatCurrency(acquisitionIncome)}`,
      70,
    );
    doc.text(
      `  Liquid Distributions (taxable): ${
        liquidDistributions.length
      } events - ${formatCurrency(liquidDistributionIncome)}`,
      70,
    );
    doc.text(`  Gross Taxable Income: ${formatCurrency(grossIncome)}`, 70);
    doc.moveDown(0.3);

    // Staked Distributions (deferred income)
    if (stakedDistributions.length > 0) {
      doc.font(reportFont.bold).text("Staked Distributions (Deferred Income):");
      doc.font(reportFont.normal);
      doc.text(
        `  Total Staked: ${
          stakedDistributions.length
        } events - ${formatCurrency(stakedDistributionIncome)}`,
        70,
      );
      for (const [token, data] of Object.entries(stakedByToken)) {
        doc.text(
          `    ${token}: ${data.count} events, ${data.amount.toFixed(
            4,
          )} tokens - ${formatCurrency(data.value)}`,
          90,
        );
      }
      doc.moveDown(0.3);
    }

    // Disposals Summary (values already converted per-transaction)
    doc.font(reportFont.bold).text("Disposal Summary:");
    doc.font(reportFont.normal);
    doc.text(`  Total Disposals: ${nonSwapDisposals.length} events`, 70);
    doc.text(
      `  Total Cost Basis: ${formatCurrency(nonSwapDisposalCostBasis)}`,
      70,
    );
    doc.text(
      `  Total Proceeds: ${formatCurrency(nonSwapDisposalProceeds)}`,
      70,
    );
    doc.text(
      `  Net Gain/Loss: ${formatCurrency(nonSwapDisposalGainLoss)} (${
        nonSwapDisposalGainLoss >= 0 ? "gain" : "loss"
      })`,
      70,
    );
    doc.moveDown(0.3);

    // DEX Swaps Summary (values already converted per-transaction)
    if (dexSwaps.length > 0) {
      doc.font(reportFont.bold).text("DEX Swap Summary:");
      doc.font(reportFont.normal);
      doc.text(`  Total Swaps: ${dexSwaps.length}`, 70);
      doc.text(`  Total Cost Basis: ${formatCurrency(swapCostBasis)}`, 70);
      doc.text(`  Total Proceeds: ${formatCurrency(swapProceeds)}`, 70);
      doc.text(
        `  Net Gain/Loss: ${formatCurrency(swapGainLoss)} (${
          swapGainLoss >= 0 ? "gain" : "loss"
        })`,
        70,
      );
      doc.moveDown(0.3);
    }
    doc.moveDown();

    // Overall Summary (values already converted per-transaction)
    doc.font(reportFont.bold).fontSize(12).text("Overall Summary:");
    doc.font(reportFont.normal).fontSize(10);
    doc.text(`  Total Income: ${formatCurrency(grossIncome)}`, 70);
    doc.text(
      `  Total Disposal Proceeds: ${formatCurrency(totalDisposalProceeds)}`,
      70,
    );
    doc.text(
      `  Total Disposal Cost Basis: ${formatCurrency(totalDisposalCostBasis)}`,
      70,
    );
    doc.text(
      `  Total Disposal Gain/Loss: ${formatCurrency(totalDisposalGainLoss)} (${
        totalDisposalGainLoss >= 0 ? "gain" : "loss"
      })`,
      70,
    );
    const totalTaxableIncome =
      grossIncome + (totalDisposalGainLoss > 0 ? totalDisposalGainLoss : 0);
    doc.text(
      `  Total Taxable Income/Gains: ${formatCurrency(totalTaxableIncome)}`,
      70,
    );
    doc.moveDown(0.3);

    // Note about staked distributions (explicit width so text is readable after summary lines)
    doc
      .fontSize(9)
      .font(reportFont.oblique)
      .text(
        "Staked distributions are deferred income - not taxable until tokens are unlocked/withdrawn.",
        50,
        doc.y,
        { width: contentWidth, indent: 20 },
      );
    doc.font(reportFont.normal).fontSize(10);
    doc.moveDown();

    // Transaction breakdown by type (taxable only)
    doc.font(reportFont.bold).text("Taxable Transactions by Type:");
    doc.font(reportFont.normal);
    const byType = {};
    yearTransactions.forEach((tx) => {
      byType[tx.type] = (byType[tx.type] || 0) + 1;
    });
    Object.entries(byType)
      .sort((a, b) => b[1] - a[1])
      .forEach(([type, count]) => {
        doc.text(`  ${type}: ${count}`, 70);
      });

    doc.addPage();

    // Transaction details table
    doc
      .fontSize(16)
      .font(reportFont.bold)
      .text(
        `Taxable Transaction Details (${displayTransactions.length} events)`,
        50,
        doc.y,
      );
    doc.moveDown();

    const tableFields = CSV_FIELDS.transactions
      .slice(0, 8)
      .filter((f) => f.field !== "walletAddress")
      .map((f) => {
        if (f.field === "valueUSD")
          return { ...f, format: "currency_5", header: `Value ${currency}` };
        if (f.field === "priceUSD")
          return { ...f, header: `Price ${currency}` };
        if (f.field === "outputAmountHuman")
          return { ...f, header: "Out. Amount" };
        return f;
      });
    // Measure header width with same font/size used for table header so column fits (e.g. "Output Amount")
    doc.fontSize(9).font(reportFont.bold);
    const colWidths = this.calculateColumnWidths(tableFields, doc);

    // Table header (same baseline so header and data align)
    let x = 50;
    const tableTop = doc.y;
    tableFields.forEach((field, i) => {
      doc.x = x;
      doc.y = tableTop;
      doc.text(field.header, x, tableTop, {
        width: colWidths[i],
        baseline: "top",
      });
      x += colWidths[i] + 5;
    });
    doc
      .moveTo(50, doc.y + 5)
      .lineTo(550, doc.y + 5)
      .stroke();
    doc.moveDown(1.5);

    // Transaction rows - ALL taxable transactions (no limit)
    doc.font(reportFont.normal).fontSize(8);
    let rowCount = 0;
    const maxRowsPerPage = 32; // leave room for footnote at bottom

    for (const tx of displayTransactions) {
      if (rowCount >= maxRowsPerPage) {
        drawTablePageFootnote();
        doc.addPage();
        // Redraw header
        doc.font(reportFont.bold).fontSize(9);
        x = 50;
        const newTableTop = doc.y;
        tableFields.forEach((field, i) => {
          doc.x = x;
          doc.y = newTableTop;
          doc.text(field.header, x, newTableTop, {
            width: colWidths[i],
            baseline: "top",
          });
          x += colWidths[i] + 5;
        });
        doc
          .moveTo(50, doc.y + 5)
          .lineTo(550, doc.y + 5)
          .stroke();
        doc.moveDown(1.5);
        doc.font(reportFont.normal).fontSize(8);
        rowCount = 0;
      }

      x = 50;
      const rowY = doc.y;
      const rowHeight = doc.currentLineHeight(true);
      tableFields.forEach((field, i) => {
        const value = this.getNestedValue(tx, field.field);
        const formatted = this.formatValue(value, field.format);
        const cellText = String(formatted || "").substring(0, 20);
        // Force single-line, no wrapper: width null + lineBreak false. baseline 'top' = same y for all cells.
        doc.x = x;
        doc.y = rowY;
        doc.text(cellText, x, rowY, {
          lineBreak: false,
          width: null,
          baseline: "top",
        });
        x += colWidths[i] + 5;
      });
      doc.y = rowY + rowHeight;
      doc.moveDown(0.7);
      rowCount++;
    }

    if (displayTransactions.length > 0) {
      drawTablePageFootnote();
      doc.addPage();
    }

    // Note about complete data: start at left margin, full width, left-aligned
    doc.moveDown();
    doc.x = 50;
    doc
      .fontSize(9)
      .text(
        `Total taxable events shown: ${displayTransactions.length}. CSV-format reports are also available for import into tax preparation software.`,
        50,
        doc.y,
        { width: contentWidth, align: "left" },
      );

    // Footer: start at left margin, full width, left-aligned
    doc.x = 50;
    doc
      .fontSize(8)
      .text(
        "This report is not an official government form. The information presented must be entered on the correct tax forms and schedules when filing. Consult a tax professional as needed.",
        50,
        doc.y,
        { width: contentWidth, align: "left" },
      );

    doc.moveDown(0.5);
    doc.x = 50;
    doc
      .fontSize(8)
      .font(reportFont.oblique)
      .text("Price aggregations may include data from CoinGecko", 50, doc.y, {
        width: contentWidth,
        align: "left",
      });
    doc.moveDown(0.3);
    doc.x = 50;
    doc
      .fontSize(8)
      .text(
        "Please report any suspected inaccuracies to admin@gigautility.com",
        50,
        doc.y,
        { width: contentWidth, align: "left" },
      );
    doc.font(reportFont.normal);

    doc.end();

    // Wait for stream to finish
    await new Promise((resolve, reject) => {
      stream.on("finish", resolve);
      stream.on("error", reject);
    });

    if (this.verbose) {
      console.log(`Generated comprehensive PDF: ${filepath}`);
    }

    return filepath;
  }
}

module.exports = {
  TaxReportGenerator,
  REPORT_TYPES,
  CSV_FIELDS,
};
