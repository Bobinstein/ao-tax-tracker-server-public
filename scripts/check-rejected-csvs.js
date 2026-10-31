#!/usr/bin/env node

/**
 * Script to scan AO CSV directories for rejected CSV files
 *
 * This script will:
 * 1. Scan all date-based directories in data/AO_csvs/
 * 2. Find files with "rejected-" prefix
 * 3. Extract the transaction IDs from filenames
 * 4. Return a list of full transaction IDs that were marked as rejected
 *
 * Usage:
 *   node scripts/check-rejected-csvs.js
 *   curl http://localhost:3000/api/rejected-csvs
 */

const fs = require("fs");
const path = require("path");

class RejectedCSVChecker {
  constructor() {
    this.csvDir = path.join(__dirname, "../data/AO_csvs");
    this.rejectedTxIds = [];
  }

  /**
   * Scan all date directories for rejected CSV files
   */
  async scanRejectedCSVs() {
    console.log("🔍 Scanning for rejected AO CSV files...");
    console.log(`📁 CSV Directory: ${this.csvDir}`);

    if (!fs.existsSync(this.csvDir)) {
      console.log("❌ CSV directory does not exist:", this.csvDir);
      return [];
    }

    // Get all date directories
    const dateDirs = fs
      .readdirSync(this.csvDir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name)
      .sort();

    console.log(`📅 Found ${dateDirs.length} date directories`);

    for (const dateDir of dateDirs) {
      const dateDirPath = path.join(this.csvDir, dateDir);
      const files = fs.readdirSync(dateDirPath);

      // Find files with "rejected-" prefix
      const rejectedFiles = files.filter((file) =>
        file.startsWith("rejected-")
      );

      if (rejectedFiles.length > 0) {
        console.log(
          `📂 ${dateDir}: Found ${rejectedFiles.length} rejected CSV(s)`
        );

        for (const file of rejectedFiles) {
          // Extract transaction ID from filename (remove "rejected-" prefix and ".csv" suffix)
          const txId = file.replace("rejected-", "").replace(".csv", "");
          this.rejectedTxIds.push({
            txId,
            date: dateDir,
            filename: file,
            fullPath: path.join(dateDirPath, file),
          });
        }
      }
    }

    console.log(`\n📊 Summary:`);
    console.log(`   Total rejected CSVs found: ${this.rejectedTxIds.length}`);
    console.log(
      `   Date range: ${dateDirs[0]} to ${dateDirs[dateDirs.length - 1]}`
    );

    return this.rejectedTxIds;
  }

  /**
   * Get just the transaction IDs (for API response)
   */
  getRejectedTxIds() {
    return this.rejectedTxIds.map((item) => item.txId);
  }

  /**
   * Get detailed information about rejected CSVs
   */
  getDetailedInfo() {
    return this.rejectedTxIds;
  }

  /**
   * Group rejected CSVs by date
   */
  getRejectedByDate() {
    const grouped = {};
    for (const item of this.rejectedTxIds) {
      if (!grouped[item.date]) {
        grouped[item.date] = [];
      }
      grouped[item.date].push(item.txId);
    }
    return grouped;
  }

  /**
   * Get statistics about rejected CSVs
   */
  getStats() {
    const byDate = this.getRejectedByDate();
    const dates = Object.keys(byDate).sort();

    return {
      total: this.rejectedTxIds.length,
      dateRange: {
        earliest: dates[0] || null,
        latest: dates[dates.length - 1] || null,
      },
      byDate: byDate,
      dates: dates,
    };
  }
}

// If run directly (not imported), execute the scan
if (require.main === module) {
  const checker = new RejectedCSVChecker();

  checker
    .scanRejectedCSVs()
    .then(() => {
      const txIds = checker.getRejectedTxIds();
      const stats = checker.getStats();

      console.log("\n📋 Rejected Transaction IDs:");
      console.log("================================");

      if (txIds.length === 0) {
        console.log("✅ No rejected CSVs found!");
      } else {
        txIds.forEach((txId, index) => {
          console.log(`${index + 1}. ${txId}`);
        });
      }

      console.log("\n📊 Statistics:");
      console.log("===============");
      console.log(JSON.stringify(stats, null, 2));
    })
    .catch((error) => {
      console.error("❌ Error scanning rejected CSVs:", error);
      process.exit(1);
    });
}

module.exports = RejectedCSVChecker;
