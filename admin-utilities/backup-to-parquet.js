#!/usr/bin/env node

/**
 * Cassandra to Parquet Backup Script
 *
 * Exports Cassandra tables to Parquet format for backup purposes.
 * Supports full backup or limited row export for testing.
 *
 * Usage:
 *   node admin-utilities/backup-to-parquet.js                    # Full backup
 *   node admin-utilities/backup-to-parquet.js --limit 1000       # Test with 1000 rows per table
 *   node admin-utilities/backup-to-parquet.js --keyspace ao_price_data --limit 100
 *   node admin-utilities/backup-to-parquet.js --table daily_prices --limit 500
 *
 * Output:
 *   backups/YYYY-MM-DD_HH-mm-ss/
 *     ├── keyspace_table.parquet
 *     ├── keyspace_table.parquet
 *     └── backup_manifest.json
 */

const cassandra = require("cassandra-driver");
const parquet = require("parquetjs-lite");
const fs = require("fs");
const path = require("path");

// Parse command line arguments
const args = process.argv.slice(2);
const getArg = (name) => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
};

const rowLimit = getArg("limit") ? parseInt(getArg("limit")) : null;
const targetKeyspace = getArg("keyspace");
const targetTable = getArg("table");
const verbose = args.includes("--verbose") || args.includes("-v");

// Keyspaces to backup (in order of importance)
const KEYSPACES_TO_BACKUP = [
  "ao_price_data",
  "ao_distributions",
  "pi_distributions",
  "ario_distributions",
  "ar_tax_tracker",
];

// Map Cassandra types to Parquet types
function cassandraTypeToParquet(cassandraType) {
  const typeStr = cassandraType.toString().toLowerCase();

  if (typeStr.includes("text") || typeStr.includes("varchar") || typeStr.includes("ascii")) {
    return { type: "UTF8" };
  }
  if (typeStr.includes("int") && !typeStr.includes("bigint")) {
    return { type: "INT32" };
  }
  if (typeStr.includes("bigint") || typeStr.includes("counter")) {
    return { type: "INT64" };
  }
  if (typeStr.includes("float")) {
    return { type: "FLOAT" };
  }
  if (typeStr.includes("double") || typeStr.includes("decimal")) {
    return { type: "DOUBLE" };
  }
  if (typeStr.includes("boolean")) {
    return { type: "BOOLEAN" };
  }
  if (typeStr.includes("timestamp")) {
    return { type: "INT64" }; // Store as epoch millis
  }
  if (typeStr.includes("uuid") || typeStr.includes("timeuuid")) {
    return { type: "UTF8" };
  }
  if (typeStr.includes("blob")) {
    return { type: "BYTE_ARRAY" };
  }
  if (typeStr.includes("list") || typeStr.includes("set") || typeStr.includes("map")) {
    return { type: "UTF8" }; // Serialize as JSON
  }

  // Default to string for unknown types
  return { type: "UTF8" };
}

// Convert Cassandra value to Parquet-compatible value
function convertValue(value, cassandraType) {
  if (value === null || value === undefined) {
    return null;
  }

  const typeStr = cassandraType.toString().toLowerCase();

  // Handle timestamps
  if (typeStr.includes("timestamp")) {
    if (value instanceof Date) {
      return value.getTime();
    }
    return value;
  }

  // Handle decimals
  if (typeStr.includes("decimal")) {
    if (typeof value === "object" && value.toString) {
      return parseFloat(value.toString());
    }
    return parseFloat(value);
  }

  // Handle bigints
  if (typeStr.includes("bigint")) {
    if (typeof value === "object" && value.toString) {
      return parseInt(value.toString());
    }
    return parseInt(value);
  }

  // Handle collections (list, set, map)
  if (typeStr.includes("list") || typeStr.includes("set") || typeStr.includes("map")) {
    return JSON.stringify(value);
  }

  // Handle UUIDs
  if (typeStr.includes("uuid") || typeStr.includes("timeuuid")) {
    return value.toString();
  }

  // Handle blobs
  if (typeStr.includes("blob") && Buffer.isBuffer(value)) {
    return value.toString("base64");
  }

  return value;
}

// Get table schema from Cassandra
async function getTableSchema(client, keyspace, table) {
  const query = `
    SELECT column_name, type 
    FROM system_schema.columns 
    WHERE keyspace_name = ? AND table_name = ?
  `;

  const result = await client.execute(query, [keyspace, table], { prepare: true });
  return result.rows;
}

// Create Parquet schema from Cassandra schema
function createParquetSchema(columns) {
  const schema = {};

  for (const col of columns) {
    const parquetType = cassandraTypeToParquet(col.type);
    schema[col.column_name] = {
      ...parquetType,
      optional: true, // Allow nulls
    };
  }

  return new parquet.ParquetSchema(schema);
}

// Export a single table to Parquet
async function exportTable(client, keyspace, table, outputDir, limit) {
  const startTime = Date.now();
  const outputFile = path.join(outputDir, `${keyspace}_${table}.parquet`);

  console.log(`\n📤 Exporting ${keyspace}.${table}...`);

  try {
    // Get table schema
    const columns = await getTableSchema(client, keyspace, table);
    if (columns.length === 0) {
      console.log(`   ⚠️  No columns found for ${keyspace}.${table}`);
      return { table: `${keyspace}.${table}`, status: "skipped", reason: "no columns" };
    }

    // Create Parquet schema
    const parquetSchema = createParquetSchema(columns);

    // Create Parquet writer
    const writer = await parquet.ParquetWriter.openFile(parquetSchema, outputFile);

    // Build query
    let query = `SELECT * FROM ${keyspace}.${table}`;
    if (limit) {
      query += ` LIMIT ${limit}`;
    }

    // Stream rows from Cassandra
    let rowCount = 0;
    const stream = client.stream(query, [], { prepare: true, fetchSize: 1000 });

    for await (const row of stream) {
      const record = {};

      for (const col of columns) {
        const value = row[col.column_name];
        record[col.column_name] = convertValue(value, col.type);
      }

      await writer.appendRow(record);
      rowCount++;

      if (verbose && rowCount % 10000 === 0) {
        console.log(`   ... ${rowCount.toLocaleString()} rows exported`);
      }
    }

    await writer.close();

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    const fileSize = fs.statSync(outputFile).size;
    const fileSizeMB = (fileSize / 1024 / 1024).toFixed(2);

    console.log(`   ✅ ${rowCount.toLocaleString()} rows → ${fileSizeMB} MB (${duration}s)`);

    return {
      table: `${keyspace}.${table}`,
      status: "success",
      rows: rowCount,
      fileSize: fileSize,
      fileSizeMB: parseFloat(fileSizeMB),
      duration: parseFloat(duration),
      outputFile: outputFile,
    };
  } catch (error) {
    console.log(`   ❌ Error: ${error.message}`);
    return {
      table: `${keyspace}.${table}`,
      status: "error",
      error: error.message,
    };
  }
}

// Get list of tables in a keyspace
async function getTablesInKeyspace(client, keyspace) {
  const query = `
    SELECT table_name 
    FROM system_schema.tables 
    WHERE keyspace_name = ?
  `;

  const result = await client.execute(query, [keyspace], { prepare: true });
  return result.rows.map((row) => row.table_name);
}

// Main backup function
async function runBackup() {
  console.log("🗄️  Cassandra to Parquet Backup");
  console.log("================================\n");

  if (rowLimit) {
    console.log(`📊 Mode: TEST (limited to ${rowLimit} rows per table)`);
  } else {
    console.log("📊 Mode: FULL BACKUP");
  }

  if (targetKeyspace) {
    console.log(`🎯 Target keyspace: ${targetKeyspace}`);
  }
  if (targetTable) {
    console.log(`🎯 Target table: ${targetTable}`);
  }

  // Create output directory
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outputDir = path.join(
    __dirname,
    "..",
    "backups",
    `${timestamp}${rowLimit ? `_test_${rowLimit}` : ""}`
  );

  fs.mkdirSync(outputDir, { recursive: true });
  console.log(`\n📁 Output directory: ${outputDir}`);

  // Connect to Cassandra
  const client = new cassandra.Client({
    contactPoints: ["localhost"],
    localDataCenter: "datacenter1",
    socketOptions: {
      readTimeout: 120000,
    },
  });

  const manifest = {
    timestamp: new Date().toISOString(),
    mode: rowLimit ? "test" : "full",
    rowLimit: rowLimit,
    tables: [],
    totalRows: 0,
    totalSizeMB: 0,
    duration: 0,
  };

  try {
    await client.connect();
    console.log("✅ Connected to Cassandra\n");

    const startTime = Date.now();

    // Determine which keyspaces to backup
    let keyspacesToProcess = KEYSPACES_TO_BACKUP;
    if (targetKeyspace) {
      keyspacesToProcess = [targetKeyspace];
    }

    for (const keyspace of keyspacesToProcess) {
      console.log(`\n📦 Keyspace: ${keyspace}`);
      console.log("─".repeat(40));

      // Check if keyspace exists
      try {
        const tables = await getTablesInKeyspace(client, keyspace);

        if (tables.length === 0) {
          console.log("   (no tables found)");
          continue;
        }

        // Filter to specific table if requested
        let tablesToProcess = tables;
        if (targetTable) {
          tablesToProcess = tables.filter((t) => t === targetTable);
          if (tablesToProcess.length === 0) {
            console.log(`   Table '${targetTable}' not found in this keyspace`);
            continue;
          }
        }

        console.log(`   Tables: ${tablesToProcess.join(", ")}`);

        for (const table of tablesToProcess) {
          const result = await exportTable(client, keyspace, table, outputDir, rowLimit);
          manifest.tables.push(result);

          if (result.status === "success") {
            manifest.totalRows += result.rows;
            manifest.totalSizeMB += result.fileSizeMB;
          }
        }
      } catch (error) {
        if (error.message.includes("does not exist")) {
          console.log("   (keyspace does not exist)");
        } else {
          console.log(`   ❌ Error: ${error.message}`);
        }
      }
    }

    manifest.duration = ((Date.now() - startTime) / 1000).toFixed(2);

    // Write manifest
    const manifestPath = path.join(outputDir, "backup_manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // Summary
    console.log("\n" + "=".repeat(50));
    console.log("BACKUP COMPLETE");
    console.log("=".repeat(50));
    console.log(`\n📊 Summary:`);
    console.log(`   Tables backed up: ${manifest.tables.filter((t) => t.status === "success").length}`);
    console.log(`   Total rows: ${manifest.totalRows.toLocaleString()}`);
    console.log(`   Total size: ${manifest.totalSizeMB.toFixed(2)} MB`);
    console.log(`   Duration: ${manifest.duration}s`);
    console.log(`\n📁 Output: ${outputDir}`);
    console.log(`📋 Manifest: ${manifestPath}`);

    // List created files
    console.log(`\n📄 Files created:`);
    const files = fs.readdirSync(outputDir);
    for (const file of files) {
      const filePath = path.join(outputDir, file);
      const stat = fs.statSync(filePath);
      const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
      console.log(`   ${file} (${sizeMB} MB)`);
    }
  } catch (error) {
    console.error("\n❌ Backup failed:", error.message);
    if (verbose) {
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    await client.shutdown();
    console.log("\n🔌 Connection closed");
  }
}

// Run backup
runBackup();

