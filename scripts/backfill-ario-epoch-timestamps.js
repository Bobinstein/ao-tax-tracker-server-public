#!/usr/bin/env node
/**
 * Backfill distribution_timestamp in ario_epochs_processed by fetching epoch
 * distribution data from the ARIO SDK. Epochs that did not crank (or that
 * the SDK cannot return) are skipped with a log message; no process exit.
 *
 * Usage:
 *   node scripts/backfill-ario-epoch-timestamps.js [options]
 *
 * Options:
 *   --only-missing    Only process rows where distribution_timestamp is null (default: process all)
 *   --epoch-min N     Only process epochs >= N
 *   --epoch-max N     Only process epochs <= N
 *   --timeout-ms N    SDK call timeout in ms (default: 20000)
 *   --dry-run         Log what would be updated, do not write to DB
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { Client } = require("cassandra-driver");
const { ARIO } = require("@ar.io/sdk");

const CONFIG = require("../config/database");

const ario = ARIO.mainnet();

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    onlyMissing: false,
    epochMin: null,
    epochMax: null,
    timeoutMs: 20000,
    dryRun: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--only-missing") options.onlyMissing = true;
    else if (args[i] === "--epoch-min" && args[i + 1] != null) {
      options.epochMin = parseInt(args[++i], 10);
    } else if (args[i] === "--epoch-max" && args[i + 1] != null) {
      options.epochMax = parseInt(args[++i], 10);
    } else if (args[i] === "--timeout-ms" && args[i + 1] != null) {
      options.timeoutMs = parseInt(args[++i], 10);
    } else if (args[i] === "--dry-run") options.dryRun = true;
  }
  return options;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms,
      ),
    ),
  ]);
}

async function main() {
  const options = parseArgs();

  console.log("Backfill ARIO epoch distribution_timestamp");
  console.log("Options:", {
    onlyMissing: options.onlyMissing,
    epochMin: options.epochMin,
    epochMax: options.epochMax,
    timeoutMs: options.timeoutMs,
    dryRun: options.dryRun,
  });
  console.log("");

  const client = new Client({
    ...CONFIG.ARIO_DISTRIBUTION_DB,
    keyspace: "ario_distributions",
  });
  await client.connect();
  console.log("Connected to Cassandra (ario_distributions)\n");

  // Ensure column exists (production may have been created before we added it)
  try {
    await client.execute(
      "ALTER TABLE ario_epochs_processed ADD distribution_timestamp bigint",
    );
    console.log(
      "Added distribution_timestamp column to ario_epochs_processed\n",
    );
  } catch (e) {
    const msg = (e.message || "").toLowerCase();
    if (msg.includes("already exists") || msg.includes("duplicate")) {
      // Column already present (e.g. from indexer schema)
    } else {
      throw e;
    }
  }

  const result = await client.execute(
    "SELECT epoch_index, distribution_timestamp FROM ario_epochs_processed",
    [],
    { prepare: false },
  );
  let epochs = result.rows.map((row) => ({
    epochIndex: parseInt(row.epoch_index.toString(), 10),
    existingTs: row.distribution_timestamp,
  }));

  if (options.onlyMissing) {
    epochs = epochs.filter(
      (e) => e.existingTs == null || e.existingTs === undefined,
    );
  }
  if (options.epochMin != null) {
    epochs = epochs.filter((e) => e.epochIndex >= options.epochMin);
  }
  if (options.epochMax != null) {
    epochs = epochs.filter((e) => e.epochIndex <= options.epochMax);
  }

  epochs.sort((a, b) => a.epochIndex - b.epochIndex);
  console.log(`Epochs to process: ${epochs.length}\n`);

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  const updateQuery =
    "UPDATE ario_epochs_processed SET distribution_timestamp = ? WHERE epoch_index = ?";

  for (const { epochIndex, existingTs } of epochs) {
    try {
      const distributions = await withTimeout(
        ario.getDistributions({ epochIndex }),
        options.timeoutMs,
        `getDistributions(${epochIndex})`,
      );

      const ts = distributions && distributions.distributedTimestamp;
      if (ts == null || ts === undefined) {
        console.log(
          `  Epoch ${epochIndex}: no distributedTimestamp (not cranked or empty) — skip`,
        );
        skipped++;
        continue;
      }

      const ms = typeof ts === "number" ? ts : parseInt(String(ts), 10);
      if (Number.isNaN(ms)) {
        console.log(`  Epoch ${epochIndex}: invalid timestamp — skip`);
        skipped++;
        continue;
      }

      const date = new Date(ms).toISOString().split("T")[0];
      if (options.dryRun) {
        console.log(
          `  [dry-run] Epoch ${epochIndex}: would set distribution_timestamp = ${ms} (${date})`,
        );
        updated++;
        continue;
      }

      await client.execute(updateQuery, [ms, epochIndex], { prepare: true });
      console.log(
        `  Epoch ${epochIndex}: set distribution_timestamp = ${date}`,
      );
      updated++;
    } catch (err) {
      const msg = err.message || String(err);
      const isCrankRelated =
        msg.includes("not valid JSON") ||
        msg.includes("undefined") ||
        msg.includes("timed out") ||
        msg.includes("timeout") ||
        msg.includes("ECONNREFUSED") ||
        msg.includes("ENOTFOUND");
      console.log(
        `  Epoch ${epochIndex}: ${isCrankRelated ? "unavailable (did not crank?)" : "error"} — ${msg.slice(0, 80)}`,
      );
      errors++;
    }
  }

  await client.shutdown();
  console.log("");
  console.log(
    "Done. Updated:",
    updated,
    "Skipped:",
    skipped,
    "Errors:",
    errors,
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
