const cassandra = require("cassandra-driver");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { result } = require("@permaweb/aoconnect");

// Configuration
const CONFIG = {
  // PI Token Configuration
  PI_TOKEN_PROCESS: "4hXj_E-5fAKmo4E8KjgQvuDJKAFk9P2grhycVmISDLs",

  // Final Pi Scaling event - baseline for all distributions
  FINAL_PI_SCALING: {
    blockHeight: 1723673,
    timestamp: 1722513151, // Aug 1, 2025 11:52:31 UTC
    txId: "rPQodBh6hEbZ4RTtZbOhu3EK4LrkWlKv1jvK9ZwrvhU",
    // Scaling constants from Lua handler
    FACTOR: 10000000000000000000n, // 10^19
    SCALE: 1000000000000000000n, // 10^18
    // Net effect: FACTOR/SCALE = 10x multiplier
  },

  // Test wallet addresses for validation
  TEST_WALLETS: [
    "wHP6OPG5GMF5dedo_CD8AAy6x8La-gfI5b5pk65Tx_0",
    "bkjJGw3NLxs8OAyRxgTL-QFpiB3lBJqZ76kDhWdB-Rs",
  ],

  // Directories
  CSV_DIR: path.join(__dirname, "../../data/PI_csvs"),

  // Cassandra configuration
  CASSANDRA: {
    contactPoints: ["localhost"],
    localDataCenter: "datacenter1",
    keyspace: "pi_distributions",
    // Batch configuration for performance - smaller size for PI high-volume data
    batchSize: 1000,
    // Connection pool settings - optimized for high-volume PI data
    pooling: {
      coreConnectionsPerHost: {
        [cassandra.types.distance.local]: 4,
        [cassandra.types.distance.remote]: 2,
      },
      maxConnectionsPerHost: {
        [cassandra.types.distance.local]: 8,
        [cassandra.types.distance.remote]: 4,
      },
      maxRequestsPerConnection: 4096, // Increased from default 2048
    },
    socketOptions: {
      connectTimeout: 30000,
      readTimeout: 60000, // Increased timeout for large batches
      keepAlive: true,
      tcpNoDelay: true,
    },
  },

  // GraphQL endpoint configuration
  GRAPHQL: {
    endpoint: "https://arweave-search.goldsky.com/graphql",
    fallbackEndpoint: "https://arweave.net/graphql",
  },

  // User agent for HTTP requests
  USER_AGENT: "PI-Distribution-Indexer/1.0",
};

class PIDistributionIndexerCassandra {
  constructor(forceReprocess = false) {
    this.client = null;
    this.batch = [];
    this.batchCount = 0;
    this.totalDistributions = 0;
    this.processedTransactions = new Set();
    this.retryQueue = [];
    this.startTime = Date.now();
    this.forceReprocess = forceReprocess; // Flag to bypass CSV processing checks
  }

  // Initialize Cassandra connection and schema
  async init() {
    try {
      console.log("🚀 Starting PI Distribution Indexing (Cassandra)...");
      console.log(`🪙 PI Token Process: ${CONFIG.PI_TOKEN_PROCESS}`);

      // Initialize Cassandra client without keyspace first
      const clientConfig = { ...CONFIG.CASSANDRA };
      delete clientConfig.keyspace;
      this.client = new cassandra.Client(clientConfig);
      await this.client.connect();
      console.log("✅ Connected to Cassandra cluster");

      // Create keyspace if it doesn't exist
      await this.createKeyspace();

      // Switch to the keyspace
      await this.client.execute(`USE ${CONFIG.CASSANDRA.keyspace}`);

      // Create schema
      await this.createSchema();

      console.log("✅ PI Distribution Indexer (Cassandra) initialized");
      console.log(`📁 CSV directory: ${CONFIG.CSV_DIR}`);
      console.log(`🗄️  Cassandra keyspace: ${CONFIG.CASSANDRA.keyspace}`);
      console.log(
        `📦 Batch size: ${CONFIG.CASSANDRA.batchSize} distributions per batch`
      );
    } catch (error) {
      console.error("❌ Initialization failed:", error.message);
      throw error;
    }
  }

  // Create keyspace for PI distributions
  async createKeyspace() {
    const keyspaceQuery = `
      CREATE KEYSPACE IF NOT EXISTS ${CONFIG.CASSANDRA.keyspace}
      WITH REPLICATION = {
        'class': 'SimpleStrategy',
        'replication_factor': 1
      }
    `;

    await this.client.execute(keyspaceQuery);
    console.log(`✅ Keyspace created/verified: ${CONFIG.CASSANDRA.keyspace}`);
  }

  // Create database schema for PI distributions
  async createSchema() {
    // Main distributions table - using TEXT for all problematic integer fields
    const createDistributionsTable = `
      CREATE TABLE IF NOT EXISTS distributions (
        address TEXT,
        txid TEXT,
        source_txid TEXT,
        from_process TEXT,
        target_process TEXT,
        amount_units TEXT,
        pi_amount_units TEXT,
        original_balance TEXT,
        date TEXT,
        full_date TEXT,
        block_height TEXT,
        data_size TEXT,
        csv_format TEXT,
        created_at TIMESTAMP,
        PRIMARY KEY (address, txid, source_txid)
      )
    `;

    // Transactions table for tracking processed CSV files
    const createTransactionsTable = `
      CREATE TABLE IF NOT EXISTS transactions (
        txid TEXT PRIMARY KEY,
        source_txid TEXT,
        from_process TEXT,
        target_process TEXT,
        block_height TEXT,
        timestamp BIGINT,
        data_size TEXT,
        recipient_count TEXT,
        csv_format TEXT,
        status TEXT,
        processed_at TIMESTAMP
      )
    `;

    // Processed files table for deduplication
    const createProcessedFilesTable = `
      CREATE TABLE IF NOT EXISTS processed_files (
        txid TEXT PRIMARY KEY,
        processed_at TIMESTAMP,
        distribution_count BIGINT
      )
    `;

    // Test wallet balances table
    const createTestWalletBalancesTable = `
      CREATE TABLE IF NOT EXISTS test_wallet_balances (
        address TEXT PRIMARY KEY,
        csv_total_units TEXT,
        dryrun_balance TEXT,
        match_status TEXT,
        last_updated TIMESTAMP
      )
    `;

    await this.client.execute(createDistributionsTable);
    await this.client.execute(createTransactionsTable);
    await this.client.execute(createProcessedFilesTable);
    await this.client.execute(createTestWalletBalancesTable);

    console.log("✅ Cassandra schema created");
  }

  // Check for Final Pi Scaling CSV and fetch if missing
  async ensureFinalPiScalingCSV() {
    console.log("🔍 Checking for Final Pi Scaling CSV...");

    // Check if Final Pi Scaling CSV was already processed
    const isAlreadyProcessed = await this.isTransactionProcessed(
      CONFIG.FINAL_PI_SCALING.txId
    );
    if (isAlreadyProcessed) {
      console.log(
        `✅ Final Pi Scaling CSV already processed: ${CONFIG.FINAL_PI_SCALING.txId.substring(
          0,
          8
        )}...`
      );
      return;
    }

    // Check if Final Pi Scaling CSV exists locally (keep CSVs for faster testing)
    const dateDir = new Date(CONFIG.FINAL_PI_SCALING.timestamp * 1000)
      .toISOString()
      .split("T")[0];
    const csvPath = path.join(
      CONFIG.CSV_DIR,
      dateDir,
      `${CONFIG.FINAL_PI_SCALING.txId}.csv`
    );

    if (fs.existsSync(csvPath)) {
      console.log(
        `✅ Final Pi Scaling CSV already exists locally: ${dateDir}/${CONFIG.FINAL_PI_SCALING.txId.substring(
          0,
          8
        )}.csv (using cached version for faster processing)`
      );
      return;
    }

    console.log(
      "🔍 Final Pi Scaling CSV not found locally, downloading directly from Arweave..."
    );

    try {
      // Create a mock transaction object with the known txId
      const transaction = {
        id: CONFIG.FINAL_PI_SCALING.txId,
        block: {
          height: CONFIG.FINAL_PI_SCALING.blockHeight,
          timestamp: CONFIG.FINAL_PI_SCALING.timestamp,
        },
      };

      console.log(
        `✅ Using Final Pi Scaling transaction: ${transaction.id.substring(
          0,
          8
        )}... (Block ${transaction.block.height})`
      );

      // Verify with aoConnect
      console.log(
        "🔍 Verifying Final Pi Scaling transaction with aoConnect..."
      );
      const verification = await this.verifyCSVSubmission(
        CONFIG.FINAL_PI_SCALING.txId
      );

      if (!verification.isAuthorized) {
        console.log(
          `⚠️  Final Pi Scaling verification failed: ${verification.error}`
        );
        console.log(
          "⚠️  Continuing anyway as this is the known baseline transaction"
        );
      }

      // Download the CSV
      console.log("📥 Downloading Final Pi Scaling CSV...");
      const csvContent = await this.downloadCSV(
        CONFIG.FINAL_PI_SCALING.txId,
        transaction,
        false
      );

      if (!csvContent) {
        throw new Error("Failed to download Final Pi Scaling CSV");
      }

      console.log(
        `✅ Final Pi Scaling CSV downloaded and saved to ${dateDir}/`
      );

      // Parse CSV data (Note: Final Pi Scaling CSV contains ALREADY SCALED values from Lua handler)
      const distributions = this.parseCSV(
        csvContent,
        CONFIG.FINAL_PI_SCALING.txId
      );
      console.log(
        `📊 Final Pi Scaling CSV contains ${distributions.length} wallet entries (already scaled by Lua handler)`
      );

      // Mark as baseline data (no additional scaling needed - values are already scaled)
      const baselineDistributions = distributions.map((dist) => ({
        ...dist,
        csv_format: `${dist.csv_format}-baseline`, // Mark as baseline
        original_balance: dist.pi_amount_units, // Same as pi_amount_units since already scaled
      }));
      console.log(
        `🎯 Final Pi Scaling baseline ready with ${baselineDistributions.length} wallet entries`
      );

      // Process the scaled distributions into the database (this is the baseline state)
      console.log("💾 Processing Final Pi Scaling baseline into database...");
      for (const distribution of baselineDistributions) {
        await this.addToBatch(
          distribution,
          CONFIG.FINAL_PI_SCALING.txId,
          transaction
        );
      }

      // Flush the batch to ensure baseline is saved
      if (this.batch.length > 0) {
        console.log("🔄 Flushing Final Pi Scaling baseline batch...");
        await this.flushBatch();
      }

      // Mark as processed
      await this.markAsProcessed(
        CONFIG.FINAL_PI_SCALING.txId,
        baselineDistributions.length
      );
      console.log(
        `✅ Final Pi Scaling baseline processed: ${baselineDistributions.length} baseline balances stored`
      );
    } catch (error) {
      console.error(
        `❌ Failed to ensure Final Pi Scaling CSV: ${error.message}`
      );
      throw error;
    }
  }

  // Query GraphQL for PI mint transactions with pagination
  async queryGraphQL() {
    console.log("🔍 Querying GraphQL for new PI distribution CSVs...");

    try {
      let allTransactions = [];

      console.log(
        `📊 Querying mint transactions from block ${CONFIG.FINAL_PI_SCALING.blockHeight} onwards (post Final Pi Scaling)...`
      );

      const query = `
        query($limit: Int!, $cursor: String) {
          transactions(
            recipients: ["${CONFIG.PI_TOKEN_PROCESS}"]
            tags: [
              { name: "Action", values: ["Mint"] }
              { name: "Data-Protocol", values: ["ao"] }
            ]
            block: {
              min: ${CONFIG.FINAL_PI_SCALING.blockHeight}
            }
            first: $limit
            after: $cursor
            sort: HEIGHT_DESC
          ) {
            edges {
              node {
                id
                block {
                  height
                  timestamp
                }
                data {
                  size
                }
                tags {
                  name
                  value
                }
              }
              cursor
            }
            pageInfo {
              hasNextPage
            }
          }
        }
      `;

      let cursor = null;
      let hasNextPage = true;
      let pageCount = 0;

      while (hasNextPage) {
        pageCount++;
        const variables = { limit: 100 };
        if (cursor) {
          variables.cursor = cursor;
        }

        const response = await this.executeGraphQLQueryWithVariables(
          query,
          variables
        );
        const { edges, pageInfo } = response.transactions;

        console.log(
          `✅ Found ${edges.length} transactions (page ${pageCount})`
        );

        if (edges.length > 0) {
          const transactions = edges.map((edge) => edge.node);
          allTransactions.push(...transactions);
          cursor = edges[edges.length - 1].cursor;
        }

        hasNextPage = pageInfo.hasNextPage;
        console.log(
          `🔍 Page info: hasNextPage=${hasNextPage}, validTransactions=${allTransactions.length}`
        );

        if (!hasNextPage) {
          break;
        }
      }

      console.log(
        `📊 Total valid transactions found: ${allTransactions.length}`
      );
      return {
        transactions: { edges: allTransactions.map((node) => ({ node })) },
      };
    } catch (error) {
      console.error("❌ Error querying GraphQL:", error.message);
      return { transactions: { edges: [] } };
    }
  }

  // Execute GraphQL query with variables and fallback
  async executeGraphQLQueryWithVariables(query, variables) {
    const endpoints = [
      CONFIG.GRAPHQL.endpoint,
      CONFIG.GRAPHQL.fallbackEndpoint,
    ];

    for (const endpoint of endpoints) {
      try {
        const response = await this.makeGraphQLRequestWithVariables(
          endpoint,
          query,
          variables
        );
        return response;
      } catch (error) {
        console.log(
          `⚠️  GraphQL endpoint ${endpoint} failed: ${error.message}`
        );
        if (endpoint === endpoints[endpoints.length - 1]) {
          throw error;
        }
      }
    }
  }

  // Execute GraphQL query with fallback (legacy method)
  async executeGraphQLQuery(query) {
    const endpoints = [
      CONFIG.GRAPHQL.endpoint,
      CONFIG.GRAPHQL.fallbackEndpoint,
    ];

    for (const endpoint of endpoints) {
      try {
        console.log(`🔍 Querying GraphQL for new PI distribution CSVs...`);
        const response = await this.makeGraphQLRequest(endpoint, query);
        return response;
      } catch (error) {
        console.log(
          `⚠️  GraphQL endpoint ${endpoint} failed: ${error.message}`
        );
        if (endpoint === endpoints[endpoints.length - 1]) {
          throw error;
        }
      }
    }
  }

  // Make GraphQL HTTP request with variables
  async makeGraphQLRequestWithVariables(endpoint, query, variables) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({ query, variables });
      const url = new URL(endpoint);

      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
          "User-Agent": CONFIG.USER_AGENT,
        },
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const jsonResponse = JSON.parse(data);
            if (jsonResponse.errors) {
              reject(
                new Error(
                  `GraphQL errors: ${JSON.stringify(jsonResponse.errors)}`
                )
              );
            } else {
              resolve(jsonResponse.data);
            }
          } catch (error) {
            reject(
              new Error(`Failed to parse GraphQL response: ${error.message}`)
            );
          }
        });
      });

      req.on("error", reject);
      req.write(postData);
      req.end();
    });
  }

  // Make GraphQL HTTP request (legacy method)
  async makeGraphQLRequest(endpoint, query) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({ query });
      const url = new URL(endpoint);

      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
          "User-Agent": CONFIG.USER_AGENT,
        },
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const jsonResponse = JSON.parse(data);
            if (jsonResponse.errors) {
              reject(
                new Error(
                  `GraphQL errors: ${JSON.stringify(jsonResponse.errors)}`
                )
              );
            } else {
              resolve(jsonResponse.data);
            }
          } catch (error) {
            reject(
              new Error(`Failed to parse GraphQL response: ${error.message}`)
            );
          }
        });
      });

      req.on("error", reject);
      req.write(postData);
      req.end();
    });
  }

  // Verify CSV submission was accepted by PI process
  async verifyCSVSubmission(txid, targetProcess = CONFIG.PI_TOKEN_PROCESS) {
    try {
      console.log(`🔍 Verifying CSV submission: ${txid.substring(0, 8)}...`);

      const { Messages, Spawns, Output, Error } = await result({
        message: txid,
        process: targetProcess,
      });

      // Check for explicit unauthorized/invalid errors
      const hasError = Error && Error.length > 0;
      const hasUnauthorizedError =
        hasError &&
        (Error.includes("unauthorized") ||
          Error.includes("Unauthorized") ||
          Error.toLowerCase().includes("not authorized") ||
          Error.toLowerCase().includes("invalid"));

      if (hasUnauthorizedError) {
        console.log(`❌ CSV submission rejected: ${txid.substring(0, 8)}`);
        const errorMsg = Array.isArray(Error) ? Error.join(", ") : Error;
        console.log(`   Error details: ${errorMsg}`);
        return {
          isAuthorized: false,
          status: "rejected",
          error: errorMsg,
        };
      }

      if (hasError) {
        const errorMsg = Array.isArray(Error) ? Error.join(", ") : Error;

        // Check for administrative nonce errors - these should be treated as valid
        const isNonceError =
          errorMsg.toLowerCase().includes("nonce") &&
          (errorMsg.includes("not found cached") ||
            errorMsg.includes("earlier than latest known nonce"));

        if (isNonceError) {
          console.log(
            `✅ CSV submission accepted (administrative nonce error): ${txid.substring(
              0,
              8
            )}`
          );
          console.log(`   Nonce error details: ${errorMsg}`);
          return {
            isAuthorized: true,
            status: "accepted_with_admin_error",
            error: errorMsg,
          };
        }

        console.log(
          `❌ CSV submission has errors and will be rejected: ${txid.substring(
            0,
            8
          )}`
        );
        console.log(`   Error details: ${errorMsg}`);
        return {
          isAuthorized: false,
          status: "rejected_with_errors",
          error: errorMsg,
        };
      }

      // For PI, use lenient validation - accept all CSVs unless explicit errors
      // PI has different output patterns than AO
      console.log(
        `✅ CSV submission accepted (PI lenient validation): ${txid.substring(
          0,
          8
        )}`
      );
      return {
        isAuthorized: true,
        status: "accepted_pi_lenient",
        error: null,
      };
    } catch (error) {
      console.log(
        `⚠️  Could not verify CSV submission: ${txid.substring(0, 8)}`
      );
      console.log(`   Error: ${error.message}`);
      // If verification fails, still process the CSV (conservative approach)
      return {
        isAuthorized: true,
        status: "verification_failed",
        error: error.message,
      };
    }
  }

  // Download CSV file with redirect handling
  async downloadCSV(txid, transaction = null, isRejected = false) {
    // Determine date-based directory from transaction timestamp
    let dateDir = "unknown";
    if (transaction && transaction.block && transaction.block.timestamp) {
      const date = new Date(transaction.block.timestamp * 1000);
      dateDir = date.toISOString().split("T")[0]; // YYYY-MM-DD format
    }

    // Create date-based directory structure
    const dateDirPath = path.join(CONFIG.CSV_DIR, dateDir);
    if (!fs.existsSync(dateDirPath)) {
      fs.mkdirSync(dateDirPath, { recursive: true });
    }

    // Check if CSV is already saved locally in date-based directory
    const prefix = isRejected ? "rejected-" : "";
    const csvFilePath = path.join(dateDirPath, `${prefix}${txid}.csv`);

    if (fs.existsSync(csvFilePath)) {
      console.log(
        `📁 Using cached CSV: ${dateDir}/${prefix}${txid.substring(0, 8)}...`
      );
      return fs.readFileSync(csvFilePath, "utf8");
    }

    // Note: Duplicate check now happens earlier in the processing pipeline for efficiency

    console.log(`🌐 Downloading CSV: ${txid.substring(0, 8)}...`);
    return new Promise((resolve, reject) => {
      const url = `https://arweave.net/${txid}`;

      const options = {
        headers: {
          "User-Agent": CONFIG.USER_AGENT,
        },
        followRedirect: true,
      };

      https
        .get(url, options, (response) => {
          // Handle redirects
          if (response.statusCode >= 300 && response.statusCode < 400) {
            const location = response.headers.location;
            console.log(
              `🔄 Redirect: ${url} → ${location.substring(0, 80)}...`
            );

            // Follow redirect
            https
              .get(location, options, (redirectResponse) => {
                this.handleCSVResponse(
                  redirectResponse,
                  resolve,
                  reject,
                  txid,
                  dateDirPath,
                  csvFilePath,
                  prefix
                );
              })
              .on("error", reject);
          } else {
            this.handleCSVResponse(
              response,
              resolve,
              reject,
              txid,
              dateDirPath,
              csvFilePath,
              prefix
            );
          }
        })
        .on("error", reject);
    });
  }

  handleCSVResponse(
    response,
    resolve,
    reject,
    txid,
    dateDirPath,
    csvFilePath,
    prefix
  ) {
    if (response.statusCode !== 200) {
      reject(
        new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`)
      );
      return;
    }

    let data = "";
    response.on("data", (chunk) => (data += chunk));
    response.on("end", () => {
      // Save CSV locally for persistent storage in date-based directory
      if (txid && dateDirPath) {
        fs.writeFileSync(csvFilePath, data, "utf8");
        const dateDir = path.basename(dateDirPath);
        console.log(
          `💾 Saved CSV locally: ${dateDir}/${prefix}${txid.substring(
            0,
            8
          )}.csv`
        );
      }
      resolve(data);
    });
    response.on("error", reject);
  }

  // Apply Final Pi Scaling transformation to CSV data
  applyFinalPiScaling(distributions, txid) {
    console.log(
      `🔧 Applying Final Pi Scaling transformation to ${distributions.length} entries...`
    );

    const scaledDistributions = [];
    let scaledCount = 0;

    for (const dist of distributions) {
      try {
        // Extract the original balance from CSV
        const originalBalance = BigInt(dist.pi_amount_units);

        // Apply the same scaling transformation as the Lua handler:
        // scaledBalance = bint.udiv(bint(balance) * FACTOR, SCALE)
        const scaledBalance =
          (originalBalance * CONFIG.FINAL_PI_SCALING.FACTOR) /
          CONFIG.FINAL_PI_SCALING.SCALE;

        scaledDistributions.push({
          ...dist,
          amount_units: scaledBalance.toString(),
          pi_amount_units: scaledBalance.toString(),
          original_balance: originalBalance.toString(), // Keep original for reference
          csv_format: `${dist.csv_format}-scaled`, // Mark as scaled
        });

        scaledCount++;
      } catch (error) {
        console.log(
          `⚠️  Error scaling balance for ${dist.address}: ${error.message}`
        );
        // Keep original if scaling fails
        scaledDistributions.push(dist);
      }
    }

    console.log(
      `✅ Successfully scaled ${scaledCount}/${distributions.length} balances (10x multiplier applied)`
    );
    return scaledDistributions;
  }

  // Parse CSV content and return array of distributions
  parseCSV(csvContent, txid, transaction = null) {
    const lines = csvContent.split("\n").filter((line) => line.trim());
    const distributions = [];

    if (lines.length === 0) {
      console.log(`⚠️  Empty CSV file: ${txid}`);
      return distributions;
    }

    // Detect CSV format based on number of columns in first line
    const firstLine = lines[0].split(",");
    const columnCount = firstLine.length;

    let csvFormat;
    if (columnCount === 2) {
      csvFormat = "2-column-pi";
    } else if (columnCount === 4) {
      csvFormat = "4-column-raw";
    } else if (columnCount === 7) {
      csvFormat = "7-column-patch";
    } else {
      console.log(
        `⚠️  Unknown CSV format with ${columnCount} columns: ${txid}`
      );
      csvFormat = `${columnCount}-column-unknown`;
    }

    console.log(
      `🔍 CSV format detected: ${csvFormat} (${columnCount} columns)`
    );

    let validCount = 0;
    let invalidCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      try {
        const columns = line.split(",");

        if (columnCount === 4) {
          // Format: address,amount_units,pi_amount_units,date
          const [address, amount_units, pi_amount_units, date] = columns;

          if (address && amount_units && pi_amount_units && date) {
            distributions.push({
              address: address.trim(),
              amount_units: amount_units.trim(),
              pi_amount_units: pi_amount_units.trim(),
              date: date.trim(),
              full_date: date.trim(), // Use same value for both
            });
            validCount++;
          } else {
            invalidCount++;
          }
        } else if (columnCount === 7) {
          // Format: address,amount_units,pi_amount_units,date,full_date,extra1,extra2
          const [address, amount_units, pi_amount_units, date, full_date] =
            columns;

          if (address && amount_units && pi_amount_units && date) {
            distributions.push({
              address: address.trim(),
              amount_units: amount_units.trim(),
              pi_amount_units: pi_amount_units.trim(),
              date: date.trim(),
              full_date: (full_date || date).trim(),
            });
            validCount++;
          } else {
            invalidCount++;
          }
        } else if (columnCount === 2) {
          // PI Format: address,pi_amount_units
          const [address, pi_amount_units] = columns;

          if (address && pi_amount_units) {
            // Get date from transaction timestamp if available, otherwise use current date
            let distributionDate, fullDate;
            if (
              transaction &&
              transaction.block &&
              transaction.block.timestamp
            ) {
              const date = new Date(transaction.block.timestamp * 1000);
              distributionDate = date.toISOString().split("T")[0]; // YYYY-MM-DD
              fullDate = date.toISOString();
            } else {
              // Fallback to current date if no transaction timestamp
              distributionDate = new Date().toISOString().split("T")[0];
              fullDate = new Date().toISOString();
            }

            distributions.push({
              address: address.trim(),
              amount_units: pi_amount_units.trim(), // Same as pi_amount_units for PI
              pi_amount_units: pi_amount_units.trim(),
              date: distributionDate,
              full_date: fullDate,
            });
            validCount++;
          } else {
            invalidCount++;
          }
        } else {
          // Unknown format - skip
          invalidCount++;
        }
      } catch (error) {
        console.log(`⚠️  Error parsing line ${i + 1}: ${error.message}`);
        invalidCount++;
      }
    }

    console.log(
      `📊 Parsed ${validCount} valid distributions from ${lines.length} lines`
    );
    if (invalidCount > 0) {
      console.log(`⚠️  Skipped ${invalidCount} invalid lines`);
    }

    return distributions.map((dist) => ({
      ...dist,
      csv_format: csvFormat,
    }));
  }

  // Add distribution to batch
  async addToBatch(distribution, txid, transaction) {
    this.batch.push({
      query: `INSERT INTO distributions (address, txid, source_txid, from_process, target_process, amount_units, pi_amount_units, original_balance, date, full_date, block_height, data_size, csv_format, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        distribution.address,
        txid,
        txid, // source_txid same as txid for PI
        "PI_MINTER", // Generic from_process for PI
        CONFIG.PI_TOKEN_PROCESS,
        distribution.amount_units,
        distribution.pi_amount_units,
        distribution.original_balance || distribution.pi_amount_units, // Use original_balance if available, otherwise same as pi_amount_units
        distribution.date,
        distribution.full_date,
        transaction?.block?.height?.toString() || "0",
        transaction?.data?.size?.toString() || "0",
        distribution.csv_format,
        new Date(),
      ],
    });

    if (this.batch.length >= CONFIG.CASSANDRA.batchSize) {
      console.log("🔄 Batch size reached, flushing to Cassandra...");
      await this.flushBatch();
    }
  }

  // Flush batch to Cassandra
  // Add delay between batch operations to prevent overwhelming Cassandra
  async throttleBatch(delayMs = 100) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  async flushBatch() {
    if (this.batch.length === 0) return;

    // Ensure connection is established
    await this.ensureConnection();

    // Retry logic for connection pool errors
    let retries = 3;
    while (retries > 0) {
      try {
        // Prepare the statement with type hints for BIGINT
        const query = `INSERT INTO distributions (address, txid, source_txid, from_process, target_process, amount_units, pi_amount_units, original_balance, date, full_date, block_height, data_size, csv_format, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        // Execute all queries in parallel using the prepared statement
        await Promise.all(
          this.batch.map((item) =>
            this.client.execute(query, item.params, { prepare: true })
          )
        );

        this.batchCount++;
        this.totalDistributions += this.batch.length;

        // Progress update every 100 batches
        if (this.batchCount % 100 === 0) {
          console.log(
            `📊 Progress: ${this.batchCount} batches processed, ${this.totalDistributions} total distributions`
          );
        }

        this.batch = [];

        // Add throttling to prevent overwhelming Cassandra
        await this.throttleBatch(150); // 150ms delay between batches
        return;
      } catch (error) {
        retries--;
        if (retries === 0) {
          console.error("❌ Batch insert failed:", error.message);
          console.error(`❌ Full error details:`, error);
          throw error;
        } else {
          console.log(
            `⚠️  Batch insert failed, retrying... (${retries} attempts left)`
          );
          // Exponential backoff: 1s, 2s, 4s
          const backoffDelay = Math.pow(2, 4 - retries) * 1000;
          await new Promise((resolve) => setTimeout(resolve, backoffDelay));
        }
      }
    }
  }

  // Ensure connection is established
  async ensureConnection() {
    let retries = 3;
    while (retries > 0) {
      try {
        if (!this.client || !this.client.isConnected) {
          console.log("⚠️  Reconnecting to Cassandra...");
          if (this.client) {
            try {
              await this.client.shutdown();
            } catch (error) {
              // Ignore shutdown errors
            }
          }

          // Just reconnect without recreating schema
          const clientConfig = { ...CONFIG.CASSANDRA };
          delete clientConfig.keyspace;
          const cassandra = require("cassandra-driver");
          this.client = new cassandra.Client(clientConfig);
          await this.client.connect();

          // Switch to existing keyspace
          await this.client.execute(`USE ${CONFIG.CASSANDRA.keyspace}`);
        }

        // Test connection
        await this.client.execute("SELECT now() FROM system.local");
        return;
      } catch (error) {
        retries--;
        if (retries === 0) {
          throw new Error(`Failed to establish connection: ${error.message}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  // Execute with retry logic
  async executeWithRetry(query, params) {
    await this.ensureConnection();

    let retries = 3;
    while (retries > 0) {
      try {
        return await this.client.execute(query, params, { prepare: true });
      } catch (error) {
        retries--;
        if (retries === 0) {
          throw error;
        }
        console.log(`⚠️  Query failed, retrying... (${retries} attempts left)`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  // Process a single transaction
  async processTransaction(tx) {
    const txid = tx.id;
    console.log(`📥 Processing: ${txid.substring(0, 8)}...`);

    try {
      // Verify CSV submission was accepted by PI process
      const verification = await this.verifyCSVSubmission(
        txid,
        CONFIG.PI_TOKEN_PROCESS
      );

      if (!verification.isAuthorized) {
        console.log(
          `⏭️  Downloading rejected CSV for record: ${txid.substring(0, 8)}...`
        );
        // Download with rejected prefix but don't process
        await this.downloadCSV(txid, tx, true); // true = rejected
        return;
      }

      // Download CSV (pass transaction for metadata)
      const csvContent = await this.downloadCSV(txid, tx, false); // false = not rejected

      if (!csvContent) {
        console.log(`⚠️  Could not download CSV for ${txid}`);
        return;
      }

      // Parse CSV (pass transaction for date extraction)
      const distributions = this.parseCSV(csvContent, txid, tx);

      if (distributions.length === 0) {
        console.log(`⚠️  No valid distributions found in ${txid}`);
        return;
      }

      // Add to batch
      for (const distribution of distributions) {
        await this.addToBatch(distribution, txid, tx);
      }

      // Mark as processed
      await this.markAsProcessed(txid, distributions.length);

      console.log(
        `✅ Processed ${
          distributions.length
        } distributions from ${txid.substring(0, 8)}...`
      );
    } catch (error) {
      console.log(
        `⚠️  Failed to process ${txid.substring(0, 8)}: ${error.message}`
      );
      throw error;
    }
  }

  // Check if transaction is already processed (fast database lookup)
  async isTransactionProcessed(txid) {
    // If force reprocessing, always return false to reprocess everything
    if (this.forceReprocess) {
      return false;
    }

    try {
      const result = await this.executeWithRetry(
        "SELECT txid FROM processed_files WHERE txid = ?",
        [txid]
      );
      return result.rows.length > 0;
    } catch (error) {
      console.log(
        `⚠️  Could not check processing status for ${txid.substring(0, 8)}: ${
          error.message
        }`
      );
      return false; // If check fails, assume not processed to be safe
    }
  }

  // Mark transaction as processed
  async markAsProcessed(txid, distributionCount) {
    const query = `INSERT INTO processed_files (txid, processed_at, distribution_count) VALUES (?, ?, ?)`;
    await this.executeWithRetry(query, [txid, new Date(), distributionCount]);
  }

  // Main run method
  async run() {
    try {
      await this.init();

      // Ensure Final Pi Scaling CSV exists before processing any other transactions
      await this.ensureFinalPiScalingCSV();

      // Query for transactions
      console.log("🔍 Querying Arweave for CSV transactions...");
      const response = await this.queryGraphQL();

      const transactions = response.transactions.edges.map((edge) => edge.node);
      console.log(`📊 Found ${transactions.length} CSV transactions`);

      if (transactions.length === 0) {
        console.log("ℹ️  No transactions found");
        return;
      }

      // Process all transactions
      console.log(`📁 Processing ${transactions.length} CSV transactions...`);
      let processedCount = 0;

      for (const tx of transactions) {
        const txid = tx.id;

        try {
          // Check if already processed FIRST (before any expensive operations)
          const isAlreadyProcessed = await this.isTransactionProcessed(txid);
          if (isAlreadyProcessed) {
            console.log(`✅ Already processed: ${txid.substring(0, 8)}...`);
            processedCount++;
            continue; // Skip all processing for this transaction
          }

          await this.processTransaction(tx);
          processedCount++;

          if (processedCount % 50 === 0) {
            console.log(
              `📊 Processed ${processedCount}/${transactions.length} CSV files`
            );
          }
        } catch (error) {
          console.log(
            `⚠️  Failed to process ${txid.substring(0, 8)}: ${error.message}`
          );
          console.log(`📝 Adding to retry list for later processing`);
          this.retryQueue.push(tx);
        }
      }

      console.log(`✅ Completed processing ${processedCount} CSV files`);

      // Flush any remaining batch
      if (this.batch.length > 0) {
        console.log("🔄 Flushing final batch...");
        await this.flushBatch();
      }

      // Final summary
      const elapsed = (Date.now() - this.startTime) / 1000;
      console.log(`\n📊 Final Processing Summary:`);
      console.log(`   Total batches processed: ${this.batchCount}`);
      console.log(
        `   Total distributions processed: ${this.totalDistributions}`
      );
      console.log(
        `   Average distributions per batch: ${
          this.totalDistributions / this.batchCount || 0
        }`
      );

      console.log("\n✅ Indexing completed successfully!");
      console.log(`⏱️  Total indexing time: ${elapsed.toFixed(2)} seconds`);

      // Validate test wallets
      console.log("\n🧪 Validating test wallet balances...");
      await this.validateTestWallets();

      // Generate final report
      await this.generateReport();
    } catch (error) {
      console.error("❌ Indexing failed:", error.message);
      throw error;
    } finally {
      if (this.client) {
        await this.client.shutdown();
        console.log("✅ Cassandra client shutdown complete");
      }

      // Exit the process after successful completion
      process.exit(0);
    }
  }

  // Validate test wallet balances with dryrun comparison
  async validateTestWallets() {
    for (const address of CONFIG.TEST_WALLETS) {
      console.log(`\n📊 Wallet: ${address.substring(0, 8)}...`);

      // Get CSV total
      const csvTotal = await this.getCSVTotal(address);
      const wholeTokens = (parseFloat(csvTotal) / 1000000000000).toFixed(6);
      console.log(
        `📈 CSV Total: ${csvTotal} units (${wholeTokens} whole tokens)`
      );

      // Get dryrun balance from PI process
      const dryrunBalance = await this.getDryrunBalance(address);
      const dryrunWholeTokens = (
        parseFloat(dryrunBalance) / 1000000000000
      ).toFixed(6);
      console.log(
        `🔍 Dryrun Balance: ${dryrunBalance} units (${dryrunWholeTokens} whole tokens)`
      );

      // Compare balances
      const match = csvTotal === dryrunBalance;
      const matchStatus = match ? "✅ MATCH" : "❌ MISMATCH";
      console.log(`🔍 Balance Check: ${matchStatus}`);

      if (!match) {
        const diff = parseFloat(csvTotal) - parseFloat(dryrunBalance);
        const diffWholeTokens = (diff / 1000000000000).toFixed(6);
        console.log(
          `📊 Difference: ${diff} units (${diffWholeTokens} whole tokens)`
        );
      }

      // Store in database with dryrun comparison
      await this.executeWithRetry(
        `INSERT INTO test_wallet_balances (address, csv_total_units, dryrun_balance, match_status, last_updated) VALUES (?, ?, ?, ?, ?)`,
        [address, csvTotal, dryrunBalance, matchStatus, new Date()]
      );
    }
  }

  // Get CSV total for wallet (baseline + distributions, excluding Final Pi Scaling baseline)
  async getCSVTotal(address) {
    // Get Final Pi Scaling baseline (this is the starting balance)
    const baselineResult = await this.executeWithRetry(
      `SELECT pi_amount_units FROM distributions WHERE address = ? AND txid = ?`,
      [address, CONFIG.FINAL_PI_SCALING.txId]
    );

    let baseline = BigInt(0);
    if (baselineResult.rows.length > 0) {
      baseline = BigInt(baselineResult.rows[0].pi_amount_units);
    }

    // Get all mint distributions for this address
    const distributionsResult = await this.executeWithRetry(
      `SELECT pi_amount_units, csv_format, txid FROM distributions WHERE address = ?`,
      [address]
    );

    let distributions = BigInt(0);
    for (const row of distributionsResult.rows) {
      if (row.pi_amount_units && row.pi_amount_units !== "0") {
        // Skip Final Pi Scaling baseline records (they're already included in baseline calculation)
        if (row.txid !== CONFIG.FINAL_PI_SCALING.txId) {
          distributions += BigInt(row.pi_amount_units);
        }
      }
    }

    const total = baseline + distributions;
    console.log(
      `   📊 Baseline: ${baseline.toString()}, Distributions: ${distributions.toString()}, Total: ${total.toString()}`
    );
    return total.toString();
  }

  // Get dryrun balance from PI process
  async getDryrunBalance(address) {
    try {
      console.log(
        `🔍 Querying PI process for balance: ${address.substring(0, 8)}...`
      );

      const dryrunResult = await this.sendBalanceMessage(address);

      if (
        dryrunResult &&
        dryrunResult.Messages &&
        dryrunResult.Messages.length > 0
      ) {
        const response = dryrunResult.Messages[0];

        // First, try to get balance from tags (more reliable for PI)
        if (response.Tags) {
          const balanceTag = response.Tags.find(
            (tag) => tag.name === "Balance"
          );
          if (balanceTag && balanceTag.value) {
            console.log(`   Found Balance in tags: ${balanceTag.value}`);
            return balanceTag.value;
          }
        }

        // Fallback to parsing Data field
        if (response.Data) {
          const balance = this.parseBalanceResponse(response.Data);
          return balance;
        }
      }

      console.log(
        `⚠️  No balance response from PI process for ${address.substring(0, 8)}`
      );
      return "0";
    } catch (error) {
      console.log(
        `⚠️  Error getting dryrun balance for ${address.substring(0, 8)}: ${
          error.message
        }`
      );
      return "0";
    }
  }

  // Send balance query using dryrun to PI process
  async sendBalanceMessage(address) {
    const { dryrun } = require("@permaweb/aoconnect");

    try {
      const dryrunResult = await dryrun({
        process: CONFIG.PI_TOKEN_PROCESS,
        data: "",
        tags: [
          { name: "Action", value: "Balance" },
          { name: "Recipient", value: address },
        ],
      });

      return dryrunResult;
    } catch (error) {
      console.log(`⚠️  Error sending dryrun balance query: ${error.message}`);
      throw error;
    }
  }

  // Parse balance response from PI process
  parseBalanceResponse(data) {
    try {
      // PI balance responses are typically just the number as a string
      const cleanData = data.trim();

      // Handle JSON response format
      if (cleanData.startsWith("{")) {
        const parsed = JSON.parse(cleanData);
        return parsed.balance || parsed.Balance || parsed.amount || "0";
      }

      // Handle direct number response - fix the regex (was double-escaped in some versions)
      if (/^\d+$/.test(cleanData)) {
        return cleanData;
      }

      console.log(
        `⚠️  Unexpected balance response format: ${cleanData.substring(
          0,
          100
        )}...`
      );
      return "0";
    } catch (error) {
      console.log(`⚠️  Error parsing balance response: ${error.message}`);
      return "0";
    }
  }

  // Generate summary report
  async generateReport() {
    console.log("\n📊 Database Summary Report");
    console.log("========================");

    // Ensure we're connected before running reports
    await this.ensureConnection();

    // Use tracked totals instead of expensive COUNT operations
    console.log(
      `Total Distributions: ${this.totalDistributions.toLocaleString()}`
    );
    console.log(`Total Batches Processed: ${this.batchCount.toLocaleString()}`);
    console.log(
      `Total CSV Files Processed: ${
        this.processedTransactions ? this.processedTransactions.size : "Unknown"
      }`
    );

    // Skip expensive operations for large datasets
    console.log(
      `⚠️  Skipping total amount calculation (would require reading ${this.totalDistributions.toLocaleString()} records)`
    );
    console.log(
      `💡 To get total amount, run: SELECT SUM(CAST(pi_amount_units AS bigint)) FROM distributions;`
    );
    console.log(
      `⚠️  Skipping unique recipients calculation (would require reading ${this.totalDistributions.toLocaleString()} addresses)`
    );
    console.log(
      `💡 To get unique recipients, run: SELECT COUNT(DISTINCT address) FROM distributions;`
    );

    // Test wallet status
    console.log("\n🧪 Test Wallet Balances:");
    const testWallets = await this.executeWithRetry(
      "SELECT * FROM test_wallet_balances",
      []
    );
    for (const wallet of testWallets.rows) {
      const csvTotal = wallet.csv_total_units;
      const wholeTokens = (parseFloat(csvTotal) / 1000000000000).toFixed(6);
      console.log(
        `📊 ${wallet.address.substring(
          0,
          8
        )}...: ${csvTotal} units (${wholeTokens} whole tokens)`
      );
    }

    console.log("\n✅ Indexing completed successfully!");
  }
}

// Run the indexer
if (require.main === module) {
  // Parse command line arguments
  const forceReprocess =
    process.argv.includes("--force-reprocess") || process.argv.includes("-f");

  if (forceReprocess) {
    console.log("🔄 Force reprocess mode enabled - will reprocess all CSVs");
  }

  const indexer = new PIDistributionIndexerCassandra(forceReprocess);

  // Graceful shutdown handling
  process.on("SIGINT", async () => {
    console.log("\n⚠️  Received SIGINT, shutting down gracefully...");
    try {
      if (indexer.client) {
        await indexer.client.shutdown();
        console.log("✅ Cassandra client shutdown complete");
      }
    } catch (error) {
      console.error("Error during shutdown:", error.message);
    }
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    console.log("\n⚠️  Received SIGTERM, shutting down gracefully...");
    try {
      if (indexer.client) {
        await indexer.client.shutdown();
        console.log("✅ Cassandra client shutdown complete");
      }
    } catch (error) {
      console.error("Error during shutdown:", error.message);
    }
    process.exit(0);
  });

  indexer.run().catch((error) => {
    console.error("❌ Fatal error:", error);
    process.exit(1);
  });
}

module.exports = { PIDistributionIndexerCassandra, CONFIG };
