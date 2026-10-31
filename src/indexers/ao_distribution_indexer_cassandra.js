#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const https = require("https");
const cassandra = require("cassandra-driver");
const { dryrun, result } = require("@permaweb/aoconnect");
const GraphQLClient = require("../utils/graphql-client");
// Use dynamic import for node-fetch (ES Module)
let fetch;

// Configuration
const CONFIG = {
  // Test wallet addresses (no AO transactions - perfect for testing)
  TEST_WALLETS: [
    "wHP6OPG5GMF5dedo_CD8AAy6x8La-gfI5b5pk65Tx_0",
    "bkjJGw3NLxs8OAyRxgTL-QFpiB3lBJqZ76kDhWdB-Rs",
  ],

  // AO Process IDs
  AO_TOKEN_PROCESS: "0syT13r0s0tgPmIed95bJnuSqaD29HQNN8D3ElLSrsc",
  CURRENT_MINT_PROCESS: "NTE-RcHEeO15MYMUbXwWytRxn_IUJmXPKPOFVc5qZcg",

  // Directories
  CSV_DIR: path.join(__dirname, "../../data/AO_csvs"),
  DB_PATH: "./ao_distributions.db",

  // GraphQL endpoint
  GQL_ENDPOINT: "https://arweave.net/graphql",

  // CSV transaction query parameters
  CSV_QUERY_LIMIT: 100,

  // User agent for requests
  USER_AGENT: "AO-Distribution-Indexer/1.0",

  // Retry configuration
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000, // 1 second base delay
  MAX_RETRY_DELAY: 10000, // 10 seconds max delay

  // Cassandra configuration
  CASSANDRA: {
    contactPoints: ["127.0.0.1"],
    localDataCenter: "datacenter1",
    keyspace: "ao_distributions",
    // Batch configuration for performance - reduced for stability
    batchSize: 5000,
    // Connection pool settings - optimized for high-volume data
    pooling: {
      coreConnectionsPerHost: {
        [cassandra.types.distance.local]: 4,
        [cassandra.types.distance.remote]: 2,
      },
      maxConnectionsPerHost: {
        [cassandra.types.distance.local]: 8,
        [cassandra.types.distance.remote]: 4,
      },
      maxRequestsPerConnection: {
        [cassandra.types.distance.local]: 4096, // Increased from 512
        [cassandra.types.distance.remote]: 2048, // Increased from 128
      },
      heartBeatInterval: 30000,
    },
    // Socket options for stability
    socketOptions: {
      connectTimeout: 30000,
      readTimeout: 60000, // Increased timeout for large batches
      keepAlive: true,
      keepAliveDelay: 0,
    },
    // Query options
    queryOptions: {
      consistency: cassandra.types.consistencies.localOne,
      fetchSize: 1000,
      prepare: true,
    },
  },
};

// Cassandra schema definitions
const CASSANDRA_SCHEMA = {
  // Keyspace creation
  keyspace: `
    CREATE KEYSPACE IF NOT EXISTS ao_distributions
    WITH REPLICATION = {
      'class': 'SimpleStrategy',
      'replication_factor': 1
    };
  `,

  // Distributions table - optimized for queries by address and time
  distributions: `
    CREATE TABLE IF NOT EXISTS distributions (
      address TEXT,
      txid TEXT,
      source_txid TEXT,
      from_process TEXT,
      target_process TEXT,
      amount_units TEXT,
      ao_amount_units TEXT,
      date TEXT,
      full_date TIMESTAMP,
      block_height TEXT,
      data_size TEXT,
      csv_format TEXT,
      created_at TIMESTAMP,
      PRIMARY KEY (address, txid, source_txid)
    ) WITH CLUSTERING ORDER BY (txid ASC, source_txid ASC);
  `,

  // Transactions table - for metadata about CSV transactions
  transactions: `
    CREATE TABLE IF NOT EXISTS transactions (
      txid TEXT PRIMARY KEY,
      from_process TEXT,
      target_process TEXT,
      block_height TEXT,
      timestamp BIGINT,
      data_size TEXT,
      recipient_count TEXT,
      total_amount_units TEXT,
      csv_format TEXT,
      all_gql_tags TEXT,
      verification_status TEXT,
      verification_error TEXT,
      is_authorized BOOLEAN,
      processed_at TIMESTAMP,
      csv_content TEXT
    );
  `,

  // Processed files tracking
  processed_files: `
    CREATE TABLE IF NOT EXISTS processed_files (
      txid TEXT PRIMARY KEY,
      filename TEXT,
      processed_at TIMESTAMP
    );
  `,

  // Test wallet balances for validation
  test_wallet_balances: `
    CREATE TABLE IF NOT EXISTS test_wallet_balances (
      address TEXT PRIMARY KEY,
      csv_total_units TEXT,
      dryrun_balance TEXT,
      match_status TEXT,
      last_updated TIMESTAMP
    );
  `,

  // Indexes for common queries
  indexes: [
    "CREATE INDEX IF NOT EXISTS ON distributions (block_height);",
    "CREATE INDEX IF NOT EXISTS ON distributions (date);",
    "CREATE INDEX IF NOT EXISTS ON distributions (from_process);",
    "CREATE INDEX IF NOT EXISTS ON transactions (block_height);",
    "CREATE INDEX IF NOT EXISTS ON transactions (from_process);",
  ],
};

class AODistributionIndexerCassandra {
  constructor(forceReprocess = false) {
    this.client = null;
    this.batchQueue = [];
    this.batchSize = CONFIG.CASSANDRA.batchSize;
    this.batchCount = 0;
    this.totalDistributions = 0;
    this.failedTransactions = []; // Track transactions that failed verification
    this.maxRetries = 5;
    this.retryDelay = 1000; // 1 second base delay
    this.forceReprocess = forceReprocess; // Flag to bypass CSV processing checks
    this.graphqlClient = new GraphQLClient({
      endpoints: [
        "https://arweave-search.goldsky.com/graphql",
        "https://arweave.net/graphql",
      ],
      maxRetries: 3,
      retryDelay: 2000,
      timeout: 45000,
    });
    this.init();
  }

  async init() {
    try {
      // Create directories
      if (!fs.existsSync(CONFIG.CSV_DIR)) {
        fs.mkdirSync(CONFIG.CSV_DIR, { recursive: true });
      }

      // Shutdown existing client if it exists
      if (this.client) {
        try {
          await this.client.shutdown();
        } catch (error) {
          // Ignore shutdown errors
        }
      }

      // Initialize Cassandra client without keyspace first
      const clientConfig = { ...CONFIG.CASSANDRA };
      delete clientConfig.keyspace;
      this.client = new cassandra.Client(clientConfig);
      await this.client.connect();
      console.log("✅ Connected to Cassandra cluster");

      // Create schema (this will create the keyspace and switch to it)
      await this.createSchema();

      console.log("✅ AO Distribution Indexer (Cassandra) initialized");
      console.log(`📁 CSV directory: ${CONFIG.CSV_DIR}`);
      console.log(`🗄️  Cassandra keyspace: ${CONFIG.CASSANDRA.keyspace}`);
      console.log(
        `📦 Batch size: ${CONFIG.CASSANDRA.batchSize} distributions per batch`
      );
    } catch (error) {
      console.error("❌ Initialization failed:", error);
      process.exit(1);
    }
  }

  async createSchema() {
    try {
      // Create keyspace
      await this.client.execute(CASSANDRA_SCHEMA.keyspace);
      console.log("✅ Keyspace created/verified");

      // Use the keyspace
      await this.client.execute(`USE ${CONFIG.CASSANDRA.keyspace};`);

      // Create tables
      await this.client.execute(CASSANDRA_SCHEMA.distributions);
      await this.client.execute(CASSANDRA_SCHEMA.transactions);
      await this.client.execute(CASSANDRA_SCHEMA.processed_files);
      await this.client.execute(CASSANDRA_SCHEMA.test_wallet_balances);

      // Create indexes
      for (const indexQuery of CASSANDRA_SCHEMA.indexes) {
        await this.client.execute(indexQuery);
      }

      console.log("✅ Cassandra schema created");
    } catch (error) {
      console.error("❌ Schema creation failed:", error);
      throw error;
    }
  }

  // Retry failed transaction verifications
  async retryFailedVerifications() {
    if (this.failedTransactions.length === 0) {
      console.log("✅ No failed transactions to retry");
      return;
    }

    console.log(
      `🔄 Retrying ${this.failedTransactions.length} failed transaction verifications...`
    );

    const stillFailed = [];

    for (const tx of this.failedTransactions) {
      console.log(`🔄 Retrying verification for ${tx.id.substring(0, 8)}...`);

      try {
        const verification = await this.verifyCSVSubmission(
          tx.id,
          CONFIG.AO_TOKEN_PROCESS
        );

        if (verification.isAuthorized) {
          console.log(`✅ Retry successful for ${tx.id.substring(0, 8)}`);
          // Process the transaction now that verification succeeded
          await this.processTransaction(tx);
        } else {
          console.log(
            `❌ Retry still shows unauthorized: ${tx.id.substring(0, 8)}`
          );
        }
      } catch (error) {
        console.log(
          `⚠️  Retry failed for ${tx.id.substring(0, 8)}: ${error.message}`
        );
        stillFailed.push(tx);
      }
    }

    this.failedTransactions = stillFailed;
    console.log(
      `📊 Retry complete. ${stillFailed.length} transactions still failed`
    );
  }

  // Verify CSV submission was accepted by checking AO process result
  async verifyCSVSubmission(txid, targetProcess = CONFIG.AO_TOKEN_PROCESS) {
    try {
      console.log(`🔍 Verifying CSV submission: ${txid.substring(0, 8)}...`);

      const { Messages, Spawns, Output, Error } = await result({
        message: txid,
        process: targetProcess,
      });

      // Check for error messages that indicate unauthorized submission
      const hasError =
        Error && (Array.isArray(Error) ? Error.length > 0 : Error);
      const hasUnauthorizedError =
        hasError &&
        (Array.isArray(Error)
          ? Error.some(
              (err) =>
                err.toLowerCase().includes("unauthorized") ||
                err.toLowerCase().includes("not authorized") ||
                err.toLowerCase().includes("rejected") ||
                err.toLowerCase().includes("invalid")
            )
          : Error.toLowerCase().includes("unauthorized") ||
            Error.toLowerCase().includes("not authorized") ||
            Error.toLowerCase().includes("rejected") ||
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
        console.log(
          `❌ CSV submission has errors and will be rejected: ${txid.substring(
            0,
            8
          )}`
        );
        const errorMsg = Array.isArray(Error) ? Error.join(", ") : Error;
        console.log(`   Error details: ${errorMsg}`);
        return {
          isAuthorized: false,
          status: "rejected_with_errors",
          error: errorMsg,
        };
      }

      // Check for valid mint batch output patterns (strict validation)
      const hasOutput = Output && Output.data;

      if (hasOutput) {
        const output = Output.data;

        // Look for valid mint batch patterns
        const hasValidMintPattern =
          output.includes("Got Mint Batch:") ||
          output.includes("Applied balances") ||
          output.includes("Mint Report");

        if (hasValidMintPattern) {
          console.log(`✅ CSV submission accepted: ${txid.substring(0, 8)}`);
          return {
            isAuthorized: true,
            status: "accepted",
            error: null,
          };
        } else {
          console.log(
            `❌ CSV submission invalid output pattern: ${txid.substring(0, 8)}`
          );
          console.log(`   Output: ${output.substring(0, 200)}...`);
          return {
            isAuthorized: false,
            status: "rejected_invalid_output",
            error: "Invalid output pattern",
          };
        }
      }

      // No output or other indicators - check if it's a completely rejected mint
      if (!Messages || Messages.length === 0) {
        console.log(
          `❌ CSV submission completely rejected (no messages): ${txid.substring(
            0,
            8
          )}`
        );
        return {
          isAuthorized: false,
          status: "rejected_no_messages",
          error: "No messages found - mint completely rejected",
        };
      }

      // No output but has messages - reject
      console.log(`❌ CSV submission no valid output: ${txid.substring(0, 8)}`);
      return {
        isAuthorized: false,
        status: "rejected_no_output",
        error: "No valid output found",
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
    // Check if this is a patch file with a local path
    if (transaction && transaction.localPath) {
      console.log(`📁 Reading patch file: ${transaction.localPath}`);
      if (fs.existsSync(transaction.localPath)) {
        return fs.readFileSync(transaction.localPath, "utf8");
      } else {
        console.error(`❌ Patch file not found: ${transaction.localPath}`);
        return null;
      }
    }

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

    // Check if transaction was already processed in database (unless force reprocessing)
    if (!this.forceReprocess) {
      try {
        const processed = await this.client.execute(
          "SELECT txid FROM processed_files WHERE txid = ?",
          [txid]
        );

        if (processed.rows.length > 0) {
          console.log(
            `⏭️  Transaction already processed: ${txid.substring(0, 8)}...`
          );
          return null;
        }
      } catch (error) {
        // If database check fails, continue with download
        console.log(`⚠️  Could not check processing status: ${error.message}`);
      }
    } else {
      console.log(`🔄 Force reprocessing: ${txid.substring(0, 8)}...`);
    }

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

  // Parse CSV content and extract ALL distributions (not just test wallets)
  parseCSV(content, txid) {
    const lines = content.trim().split("\n");
    const distributions = [];

    if (lines.length === 0) {
      console.log(`⚠️  Empty CSV content in ${txid}`);
      return distributions;
    }

    console.log(`📄 CSV has ${lines.length} total lines`);

    // Check for rejected mint pattern (AR token with duplicate addresses)
    const sampleLines = lines.slice(0, Math.min(5, lines.length));
    const hasRejectedMintPattern = sampleLines.some((line) => {
      const parts = line.split(",");
      return (
        parts.length === 4 &&
        parts[0] === parts[2] && // duplicate addresses
        parts[3].trim() === "AR"
      ); // AR token
    });

    if (hasRejectedMintPattern) {
      console.log(
        `🚨 Detected rejected mint pattern (AR token with duplicate addresses): ${txid.substring(
          0,
          8
        )}`
      );
      console.log(`   Sample: ${sampleLines[0]}`);
      console.log(`   ⏭️  Skipping processing of rejected mint CSV`);
      return distributions; // Return empty array
    }

    // Detect CSV format by analyzing first few lines
    const formatInfo = this.detectCSVFormat(sampleLines);

    console.log(
      `🔍 CSV format detected: ${formatInfo.format} (${formatInfo.columns} columns)`
    );
    console.log(`📋 Sample lines:`, sampleLines);

    // Skip header if present
    const dataLines = formatInfo.hasHeader ? lines.slice(1) : lines;
    console.log(
      `📊 Processing ${dataLines.length} data lines (header: ${formatInfo.hasHeader})`
    );

    let validCount = 0;
    let invalidCount = 0;

    for (let i = 0; i < dataLines.length; i++) {
      const line = dataLines[i];
      if (!line.trim()) continue;

      try {
        const parts = line.split(",").map((p) => p.trim());

        if (parts.length < formatInfo.minColumns) {
          invalidCount++;
          if (invalidCount <= 5) {
            // Show first 5 invalid lines
            console.log(
              `⚠️  Invalid line ${i + 1}: ${line} (${
                parts.length
              } parts, need ${formatInfo.minColumns})`
            );
          }
          continue;
        }

        const distribution = this.parseDistributionLine(
          parts,
          formatInfo,
          i + 1
        );
        if (distribution) {
          validCount++;
          distributions.push(distribution);
        } else {
          invalidCount++;
          if (invalidCount <= 5) {
            // Show first 5 failed parsing
            console.log(`⚠️  Failed to parse line ${i + 1}: ${line}`);
          }
        }
      } catch (error) {
        invalidCount++;
        if (invalidCount <= 5) {
          // Show first 5 errors
          console.log(
            `❌ Error parsing line ${i + 1}: ${error.message} - ${line}`
          );
        }
      }
    }

    console.log(
      `📊 Parsed ${distributions.length} valid distributions from ${lines.length} lines (${validCount} valid, ${invalidCount} invalid)`
    );
    return distributions;
  }

  // Detect CSV format by analyzing sample lines
  detectCSVFormat(sampleLines) {
    if (sampleLines.length === 0) {
      return { format: "unknown", columns: 0, minColumns: 0, hasHeader: false };
    }

    const firstLine = sampleLines[0];
    const parts = firstLine.split(",");
    const columnCount = parts.length;

    // Check if first line looks like a header
    const hasHeader = this.looksLikeHeader(firstLine);

    // Determine format based on column count and content analysis
    let format = "unknown";
    let minColumns = columnCount;

    if (columnCount === 4) {
      // Analyze the content to determine the actual format
      const [col1, col2, col3, col4] = parts.map((p) => p.trim());

      // Check if this is the actual 4-column-ao format: address, amount, ao_amount, date
      const isNumericCol2 = /^\d+$/.test(col2);
      const isNumericCol3 = /^\d+$/.test(col3);
      const isAddressCol1 = col1 && col1.length > 20;
      const isAddressCol3 = col3 && col3.length > 20;

      if (isNumericCol2 && isNumericCol3 && isAddressCol1) {
        // This is the expected format: address, amount, ao_amount, date
        format = "4-column-ao";
        minColumns = 4;
      } else if (
        isNumericCol2 &&
        isAddressCol3 &&
        (col4 === "AO" || col4 === "AR")
      ) {
        // This is the actual format: address, amount, address, AO/AR
        format = "4-column-address-ao";
        minColumns = 4;
      } else {
        format = "unknown";
        minColumns = columnCount;
      }
    } else {
      format = "unknown";
      minColumns = columnCount;
    }

    return { format, columns: columnCount, minColumns, hasHeader };
  }

  // Check if a line looks like a header
  looksLikeHeader(line) {
    const headerKeywords = [
      "address",
      "amount",
      "units",
      "balance",
      "wallet",
      "recipient",
      "quantity",
      "value",
      "token",
      "ao",
      "arweave",
      "process",
      "from",
      "to",
    ];

    const lowerLine = line.toLowerCase();
    const headerScore = headerKeywords.filter((keyword) =>
      lowerLine.includes(keyword)
    ).length;

    return headerScore >= 2; // At least 2 header keywords
  }

  // Parse a single distribution line
  parseDistributionLine(parts, formatInfo, lineNumber) {
    try {
      let address, amount_units, ao_amount_units, target_process;

      // Debug logging for first few lines
      if (lineNumber <= 3) {
        console.log(
          `🔍 Parsing line ${lineNumber}: [${parts.join(", ")}] (format: ${
            formatInfo.format
          })`
        );
      }

      switch (formatInfo.format) {
        case "4-column-ao":
          // Format: address, amount_units, ao_amount_units, date
          address = parts[0];
          const rawAmountStr = parts[1].trim();
          const aoAmountStr = parts[2].trim();

          // Debug logging for first few lines
          if (lineNumber <= 3) {
            console.log(
              `  Address: "${address}", Raw: "${rawAmountStr}", AO: "${aoAmountStr}"`
            );
          }

          // Validate that both amounts are valid number strings
          if (!/^\d+$/.test(rawAmountStr) || !/^\d+$/.test(aoAmountStr)) {
            if (lineNumber <= 3) {
              console.log(
                `  ❌ Invalid amounts: raw="${rawAmountStr}" (${!/^\d+$/.test(
                  rawAmountStr
                )}), ao="${aoAmountStr}" (${!/^\d+$/.test(aoAmountStr)})`
              );
            }
            return null;
          }

          // Store as text for precision - already in units
          amount_units = rawAmountStr;
          ao_amount_units = aoAmountStr;
          target_process = "AO";
          break;

        case "4-column-address-ao":
          // Format: address, amount_units, address, AO
          address = parts[0];
          const amountStr = parts[1].trim();
          const targetAddress = parts[2].trim();
          const processType = parts[3].trim();

          // Debug logging for first few lines
          if (lineNumber <= 3) {
            console.log(
              `  Address: "${address}", Amount: "${amountStr}", Target: "${targetAddress}", Process: "${processType}"`
            );
          }

          // Validate that amount is a valid number string
          if (!/^\d+$/.test(amountStr)) {
            if (lineNumber <= 3) {
              console.log(
                `  ❌ Invalid amount: "${amountStr}" (${!/^\d+$/.test(
                  amountStr
                )})`
              );
            }
            return null;
          }

          // For this format, the amount is the same for both raw and ao
          amount_units = amountStr;
          ao_amount_units = amountStr; // Same value for both
          target_process = processType; // "AO" or "AR"
          break;

        default:
          // Only process supported formats
          if (lineNumber <= 3) {
            console.log(`  ❌ Unsupported format: ${formatInfo.format}`);
          }
          return null;
      }

      // Validate address format (basic check)
      if (!address || address.length < 20) {
        if (lineNumber <= 3) {
          console.log(
            `  ❌ Invalid address: "${address}" (length: ${
              address ? address.length : 0
            })`
          );
        }
        return null;
      }

      // Validate amount
      if (!amount_units || !ao_amount_units || ao_amount_units === "0") {
        if (lineNumber <= 3) {
          console.log(
            `  ❌ Invalid amounts: amount="${amount_units}", ao="${ao_amount_units}"`
          );
        }
        return null;
      }

      return {
        address,
        amount_units,
        ao_amount_units,
        target_process,
        csv_format: formatInfo.format,
      };
    } catch (error) {
      return null;
    }
  }

  // Execute GraphQL query with retry logic
  async executeGraphQLQuery(query, variables = {}) {
    try {
      const result = await this.graphqlClient.execute(query, variables);
      return result.data;
    } catch (error) {
      console.error(`❌ GraphQL query failed: ${error.message}`);
      throw error;
    }
  }

  // Query for CSV transactions with pagination
  async queryCSVTransactions(cursor = null) {
    const query = `
      query GetCSVTransactions($first: Int!, $after: String) {
        transactions(
          first: $first
          after: $after
          tags: [
            { name: "Content-Type", values: ["text/csv"] }
            { name: "Action", values: ["Mint"] }
          ]
          sort: HEIGHT_DESC
        ) {
          pageInfo {
            hasNextPage
            endCursor
          }
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
          }
        }
      }
    `;

    const variables = {
      first: CONFIG.CSV_QUERY_LIMIT,
      ...(cursor && { after: cursor }),
    };

    return await this.executeGraphQLQuery(query, variables);
  }

  // Query all CSV transactions with pagination
  async queryAllCSVTransactions() {
    const allTransactions = [];
    let cursor = null;
    let hasNextPage = true;
    let pageCount = 0;

    console.log("🔍 Querying Arweave for CSV transactions...");

    while (hasNextPage) {
      pageCount++;
      console.log(`📄 Fetching page ${pageCount}...`);

      try {
        const result = await this.queryCSVTransactions(cursor);
        const transactions = result.transactions.edges.map((edge) => edge.node);

        allTransactions.push(...transactions);

        hasNextPage = result.transactions.pageInfo.hasNextPage;
        cursor = result.transactions.pageInfo.endCursor;

        console.log(
          `✅ Page ${pageCount}: ${transactions.length} transactions`
        );

        // Small delay between requests to be respectful
        if (hasNextPage) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } catch (error) {
        console.error(`❌ Error fetching page ${pageCount}:`, error.message);
        throw error;
      }
    }

    console.log(`📊 Total CSV transactions found: ${allTransactions.length}`);
    return allTransactions;
  }

  // Add distribution to batch queue
  async addToBatch(
    distribution,
    txid,
    sourceTxid,
    fromProcess,
    targetProcess,
    blockHeight,
    timestamp,
    dataSize
  ) {
    const date = new Date(timestamp * 1000);
    const dateStr = date.toISOString().split("T")[0];
    const fullDate = new Date(timestamp * 1000);

    this.batchQueue.push({
      params: [
        distribution.address,
        txid,
        sourceTxid,
        fromProcess,
        targetProcess,
        String(distribution.amount_units),
        String(distribution.ao_amount_units),
        dateStr,
        fullDate,
        String(blockHeight), // Convert to string
        String(dataSize), // Convert to string
        distribution.csv_format,
        new Date(),
      ],
    });

    // Process batch if it reaches the batch size
    if (this.batchQueue.length >= this.batchSize) {
      console.log(
        `🔄 Batch size reached (${this.batchQueue.length}), flushing to Cassandra...`
      );
      return await this.flushBatch();
    }

    return Promise.resolve();
  }

  // Flush the current batch to Cassandra
  async flushBatch() {
    if (this.batchQueue.length === 0) {
      return;
    }

    const batch = this.batchQueue.splice(0, this.batchSize);
    this.batchCount++;
    this.totalDistributions += batch.length;

    // Show progress every 50 batches
    if (this.batchCount % 50 === 0) {
      console.log(
        `📊 Progress: ${
          this.batchCount
        } batches completed, ${this.totalDistributions.toLocaleString()} total distributions processed`
      );
    } else {
      console.log(
        `📦 Flushing batch #${this.batchCount} of ${batch.length} distributions to Cassandra`
      );
    }

    // Check if client is connected (but don't recreate schema)
    if (!this.client || !this.client.isConnected) {
      console.log("⚠️  Client not connected, reconnecting...");
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

    // Retry logic for connection pool errors
    let retries = 3;
    while (retries > 0) {
      try {
        // Prepare the statement with type hints for BIGINT
        const query = `INSERT INTO distributions (address, txid, source_txid, from_process, target_process, amount_units, ao_amount_units, date, full_date, block_height, data_size, csv_format, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        // Execute all queries in parallel using the prepared statement
        await Promise.all(
          batch.map((item) =>
            this.client.execute(query, item.params, { prepare: true })
          )
        );

        this.totalDistributions += batch.length;

        // Progress update every 100 batches
        if (this.batchCount % 100 === 0) {
          console.log(
            `📊 Progress: ${this.batchCount} batches processed, ${this.totalDistributions} total distributions`
          );
        }

        // Small delay to prevent overwhelming the connection pool
        await new Promise((resolve) => setTimeout(resolve, 10));
        break; // Success, exit retry loop
      } catch (error) {
        retries--;
        if (error.message.includes("BusyConnectionError") && retries > 0) {
          console.log(
            `⚠️  Connection pool busy, retrying in 1 second... (${retries} retries left)`
          );
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } else {
          console.error("❌ Batch insert failed:", error.message);
          console.error(`❌ Full error details:`, error);
          throw error;
        }
      }
    }
  }

  // Query GraphQL for new distribution CSVs using proper Mint action queries
  async queryCSVTransactions() {
    console.log("🔍 Querying GraphQL for new AO distribution CSVs...");

    try {
      let allTransactions = [];

      console.log(
        "📊 Querying all mint transactions (will filter authorities locally)..."
      );

      const query = `
        query($limit: Int!, $cursor: String) {
          transactions(
            recipients: ["${CONFIG.AO_TOKEN_PROCESS}"]
            tags: [
              { name: "Action", values: ["Mint"] }
              { name: "Data-Protocol", values: ["ao"] }
            ]
            first: $limit
            after: $cursor
            sort: HEIGHT_DESC
          ) {
            pageInfo {
              hasNextPage
            }
            edges {
              cursor
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
            }
          }
        }
      `;

      // Paginate through all results
      let cursor = null;
      let hasNextPage = true;
      let totalTransactions = 0;
      let pageCount = 0;

      while (hasNextPage) {
        pageCount++;
        const result = await this.executeGraphQLQueryWithPagination(
          query,
          CONFIG.CSV_QUERY_LIMIT,
          cursor
        );

        if (!result || !result.data || !result.data.transactions) {
          console.log("⚠️  No data returned from GraphQL query");
          if (result && result.errors) {
            console.log(`❌ GraphQL errors:`, result.errors);
          }
          break;
        }

        const { pageInfo, edges } = result.data.transactions;
        const transactions = edges.map((edge) => edge.node);

        if (transactions.length > 0) {
          console.log(
            `✅ Found ${transactions.length} transactions (page ${pageCount})`
          );

          // Process all mint transactions (authorization will be verified via result method)
          if (transactions.length > 0) {
            console.log(
              `📋 Processing ${transactions.length} mint transactions for authorization verification`
            );
            if (totalTransactions === 0) {
              console.log(
                `📋 First few transaction IDs: ${transactions
                  .slice(0, 3)
                  .map((tx) => tx.id.substring(0, 8) + "...")
                  .join(", ")}`
              );
            }
            allTransactions.push(...transactions);
          }

          totalTransactions += transactions.length;

          // Use the cursor from the last edge for pagination
          cursor = edges[edges.length - 1].cursor;
        }

        hasNextPage = pageInfo.hasNextPage;
        console.log(
          `🔍 Page info: hasNextPage=${hasNextPage}, validTransactions=${totalTransactions}`
        );

        // Safety limit to prevent infinite loops - more pages since we're filtering locally
        if (pageCount >= 100) {
          console.log("⚠️  Reached safety limit of 100 pages");
          break;
        }
      }

      console.log(`📊 Total valid transactions found: ${totalTransactions}`);

      // Add known patch files (they might not show up in GraphQL queries)
      const patchTransactions = await this.addKnownPatchFiles();
      allTransactions.push(...patchTransactions);

      // Deduplicate by transaction ID
      const uniqueTransactions = allTransactions.filter(
        (tx, index, arr) => arr.findIndex((t) => t.id === tx.id) === index
      );

      console.log(
        `📊 Total unique CSV transactions found: ${uniqueTransactions.length}`
      );
      return uniqueTransactions;
    } catch (error) {
      console.error("❌ Error querying GraphQL:", error.message);
      return [];
    }
  }

  // Legacy patch file method - no longer needed since we only process 4-column distributions
  async addKnownPatchFiles() {
    console.log("📋 Skipping legacy patch files (no longer needed)...");
    return [];
  }

  // Execute GraphQL query with pagination support
  async executeGraphQLQueryWithPagination(query, limit, cursor = null) {
    return new Promise((resolve, reject) => {
      const variables = { limit };
      if (cursor) {
        variables.cursor = cursor;
      }

      const postData = JSON.stringify({
        query,
        variables,
      });

      const options = {
        hostname: "arweave.net",
        port: 443,
        path: "/graphql",
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
            const result = JSON.parse(data);
            // Return the full result to access pageInfo
            resolve(result);
          } catch (error) {
            console.warn("⚠️  GraphQL response parsing failed:", error.message);
            resolve({ data: null });
          }
        });
      });

      req.on("error", (error) => {
        console.warn("⚠️  GraphQL request failed:", error.message);
        resolve({ data: null });
      });

      req.write(postData);
      req.end();
    });
  }

  // Process a single transaction
  async processTransaction(tx) {
    const txid = tx.id;

    // Check if already processed (unless force reprocessing)
    if (!this.forceReprocess) {
      const processed = await this.client.execute(
        "SELECT txid FROM processed_files WHERE txid = ?",
        [txid]
      );

      if (processed.rows.length > 0) {
        console.log(`⏭️  Already processed: ${txid.substring(0, 8)}...`);
        return;
      }
    } else {
      console.log(`🔄 Force reprocessing: ${txid.substring(0, 8)}...`);
    }

    console.log(`📥 Processing: ${txid.substring(0, 8)}...`);

    try {
      // Verify CSV submission was accepted by AO process
      const verification = await this.verifyCSVSubmission(
        txid,
        CONFIG.AO_TOKEN_PROCESS
      );

      if (!verification.isAuthorized) {
        console.log(
          `⏭️  Downloading rejected CSV for record: ${txid.substring(0, 8)}...`
        );
        // Download with rejected prefix but don't process
        await this.downloadCSV(txid, tx, true); // true = rejected
        return;
      }

      // Download CSV (pass transaction for patch file handling)
      const csvContent = await this.downloadCSV(txid, tx, false); // false = not rejected

      if (!csvContent) {
        console.log(`⚠️  Could not download CSV for ${txid}`);
        return;
      }

      // Parse CSV
      const distributions = this.parseCSV(csvContent, txid);

      if (distributions.length === 0) {
        console.log(`⚠️  No valid distributions found in ${txid}`);
        return;
      }

      // Extract metadata from tags
      const tags = tx.tags.reduce((acc, tag) => {
        acc[tag.name] = tag.value;
        return acc;
      }, {});

      const fromProcess = tags["From-Process"] || "unknown";
      const targetProcess = tags["Target"] || CONFIG.AO_TOKEN_PROCESS;

      // Calculate totals
      const totalAmount = distributions
        .reduce((sum, dist) => {
          return BigInt(sum) + BigInt(dist.amount_units);
        }, BigInt(0))
        .toString();

      // Store CSV transaction metadata
      await this.client.execute(
        `INSERT INTO transactions 
         (txid, from_process, target_process, block_height, timestamp, data_size, 
          recipient_count, total_amount_units, csv_format, all_gql_tags, verification_status, 
          verification_error, is_authorized, processed_at, csv_content)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          txid,
          fromProcess,
          targetProcess,
          String(tx.block.height),
          tx.block.timestamp,
          String(tx.data.size),
          String(distributions.length),
          totalAmount,
          distributions[0].csv_format,
          JSON.stringify(tags),
          verification.status,
          verification.error,
          verification.isAuthorized,
          new Date(),
          csvContent,
        ]
      );

      // Add distributions to batch
      for (const dist of distributions) {
        const date = new Date(tx.block.timestamp * 1000);
        const dateStr = date.toISOString().split("T")[0];
        const fullDate = date.toISOString();

        await this.addToBatch(
          dist,
          txid,
          txid,
          fromProcess,
          dist.target_process,
          tx.block.height,
          tx.block.timestamp,
          tx.data.size
        );
      }

      // Mark as processed
      await this.client.execute(
        "INSERT INTO processed_files (txid, filename) VALUES (?, ?)",
        [txid, `${txid.substring(0, 8)}.csv`]
      );

      console.log(
        `✅ Processed ${
          distributions.length
        } distributions from ${txid.substring(0, 8)}...`
      );
    } catch (error) {
      console.error(`❌ Error processing ${txid}:`, error.message);
      throw error; // Re-throw to be caught by retry logic
    }
  }

  // Process CSV transactions
  async processCSVTransactions() {
    try {
      console.log("🔍 Querying Arweave for CSV transactions...");
      const transactions = await this.queryCSVTransactions();

      console.log(`📊 Found ${transactions.length} CSV transactions`);

      // Check if our target transaction is in the results
      const targetTx = "DPV8pMOCxOqe0Y4XV04-w0ypvIwm8xSQQFAEbENXoyQ";
      const hasTarget = transactions.some((tx) => tx.id === targetTx);
      console.log(
        `🎯 Target transaction ${targetTx.substring(
          0,
          8
        )}... found: ${hasTarget}`
      );

      // Process all transactions with retry logic
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

          // Log progress every 50 CSVs
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
          this.failedTransactions.push(tx);
        }
      }

      console.log(`✅ Completed processing ${processedCount} CSV files`);

      // Retry failed transactions
      if (this.failedTransactions.length > 0) {
        console.log(
          `\n🔄 Retrying ${this.failedTransactions.length} failed transactions...`
        );
        await this.retryFailedVerifications();
      }

      // Flush any remaining distributions in the batch queue
      await this.flushBatch();

      // Final progress summary
      console.log(`\n📊 Final Processing Summary:`);
      console.log(`   Total batches processed: ${this.batchCount}`);
      console.log(
        `   Total distributions processed: ${this.totalDistributions.toLocaleString()}`
      );
      console.log(
        `   Average distributions per batch: ${Math.round(
          this.totalDistributions / this.batchCount
        )}`
      );
    } catch (error) {
      console.error("❌ Error querying CSV transactions:", error);
    }
  }

  // Get dryrun balance for a wallet
  async getDryrunBalance(address) {
    try {
      const result = await dryrun({
        process: CONFIG.AO_TOKEN_PROCESS,
        data: "",
        tags: [
          { name: "Action", value: "Balance" },
          { name: "Recipient", value: address },
        ],
      });

      // Handle different response structures and ensure we return a string
      let balance = "0";
      if (
        result &&
        result.Messages &&
        result.Messages.length > 0 &&
        result.Messages[0].Data
      ) {
        // Extract balance from Messages[0].Data
        balance = String(result.Messages[0].Data);
      } else if (result && result.Output && result.Output.data) {
        balance = String(result.Output.data);
      } else if (result && result.Output) {
        balance = String(result.Output);
      } else if (result && result.data) {
        balance = String(result.data);
      } else {
        console.log(
          `⚠️  Unexpected dryrun response structure for ${address}:`,
          JSON.stringify(result, null, 2)
        );
        balance = "0";
      }

      return balance;
    } catch (error) {
      console.error(`❌ Dryrun failed for ${address}:`, error.message);
      return "0";
    }
  }

  // Calculate CSV total for a wallet
  async getCSVTotal(address) {
    const result = await this.executeWithRetry(
      `SELECT ao_amount_units FROM distributions WHERE address = ?`,
      [address]
    );

    // Sum all values locally using BigInt for precision
    let total = BigInt(0);
    for (const row of result.rows) {
      const amount = row.ao_amount_units;
      if (amount && amount !== "0") {
        total += BigInt(amount.toString());
      }
    }

    return total.toString();
  }

  // Validate test wallet balances
  async validateTestWallets() {
    console.log("\n🧪 Validating test wallet balances...");

    for (const address of CONFIG.TEST_WALLETS) {
      console.log(`\n📊 Wallet: ${address.substring(0, 8)}...`);

      // Get CSV total
      const csvTotal = await this.getCSVTotal(address);

      // Convert to whole tokens (1 whole token = 1000000000000 units)
      const wholeTokens = (parseFloat(csvTotal) / 1000000000000).toFixed(6);

      console.log(
        `📈 CSV Total: ${csvTotal} units (${wholeTokens} whole tokens)`
      );

      // Store in database (simplified - no dryrun comparison)
      await this.executeWithRetry(
        `INSERT INTO test_wallet_balances (address, csv_total_units, dryrun_balance, match_status, last_updated) VALUES (?, ?, ?, ?, ?)`,
        [
          address,
          csvTotal,
          "0", // No longer using dryrun
          "N/A", // No longer comparing
          new Date(),
        ]
      );
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

          const clientConfig = { ...CONFIG.CASSANDRA };
          delete clientConfig.keyspace;
          const cassandra = require("cassandra-driver");
          this.client = new cassandra.Client(clientConfig);
          await this.client.connect();
          await this.client.execute(`USE ${CONFIG.CASSANDRA.keyspace}`);
        }

        // Test connection
        await this.client.execute("SELECT now() FROM system.local");
        return; // Success
      } catch (error) {
        retries--;
        console.log(`⚠️  Connection failed, retries left: ${retries}`);
        if (retries === 0) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds
      }
    }
  }

  // Execute query with retry logic
  async executeWithRetry(query, params = [], options = { prepare: true }) {
    let retries = 3;
    while (retries > 0) {
      try {
        await this.ensureConnection();
        return await this.client.execute(query, params, options);
      } catch (error) {
        retries--;
        console.log(
          `⚠️  Query failed, retries left: ${retries}. Error: ${error.message}`
        );
        if (retries === 0) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds
      }
    }
  }

  // Generate summary report with retry logic
  async generateReport() {
    console.log("\n📊 Database Summary Report");
    console.log("========================");

    // Use tracked counts instead of expensive COUNT(*) queries
    console.log(
      `Total Distributions: ${this.totalDistributions.toLocaleString()}`
    );

    console.log(`Total Batches Processed: ${this.batchCount.toLocaleString()}`);

    console.log(
      `Total CSV Files Processed: ${
        this.processedTransactions ? this.processedTransactions.size : "Unknown"
      }`
    );

    // Skip expensive total amount calculation for large datasets
    console.log(
      `⚠️  Skipping total amount calculation (would require reading ${this.totalDistributions.toLocaleString()} records)`
    );
    console.log(
      `💡 To get total amount, run: SELECT SUM(CAST(ao_amount_units AS bigint)) FROM distributions;`
    );

    // Skip expensive unique recipients calculation for large datasets
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
  }

  // Main execution method
  // Check if transaction is already processed (fast database lookup)
  async isTransactionProcessed(txid) {
    // If force reprocessing, always return false to reprocess everything
    if (this.forceReprocess) {
      return false;
    }

    try {
      const result = await this.client.execute(
        "SELECT txid FROM processed_files WHERE txid = ?",
        [txid],
        { prepare: true }
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

  async run() {
    const startTime = Date.now();
    try {
      console.log("🚀 Starting AO Distribution Indexing (Cassandra)...\n");

      // Process CSV transactions
      await this.processCSVTransactions();

      const endTime = Date.now();
      const totalTime = (endTime - startTime) / 1000;
      console.log(`\n✅ Indexing completed successfully!`);
      console.log(`⏱️  Total indexing time: ${totalTime.toFixed(2)} seconds`);

      // Validate test wallets
      await this.validateTestWallets();

      // Generate report
      await this.generateReport();
    } catch (error) {
      console.error("❌ Indexing failed:", error);
    } finally {
      if (this.client) {
        await this.client.shutdown();
      }
    }
  }
}

// Run the indexer
if (require.main === module) {
  // Import node-fetch dynamically (ES Module)
  (async () => {
    fetch = (await import("node-fetch")).default;

    // Parse command line arguments
    const forceReprocess =
      process.argv.includes("--force-reprocess") || process.argv.includes("-f");

    if (forceReprocess) {
      console.log("🔄 Force reprocess mode enabled - will reprocess all CSVs");
    }

    const indexer = new AODistributionIndexerCassandra(forceReprocess);

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

    indexer
      .run()
      .then(async () => {
        console.log("✅ Indexing completed successfully!");
        try {
          if (indexer.client) {
            await indexer.client.shutdown();
            console.log("✅ Cassandra client shutdown complete");
          }
        } catch (error) {
          console.error("Error during final shutdown:", error.message);
        }
        process.exit(0);
      })
      .catch(async (error) => {
        console.error("❌ Fatal error:", error);
        try {
          if (indexer.client) {
            await indexer.client.shutdown();
            console.log("✅ Cassandra client shutdown complete (after error)");
          }
        } catch (shutdownError) {
          console.error("Error during error shutdown:", shutdownError.message);
        }
        process.exit(1);
      });
  })();
}

module.exports = AODistributionIndexerCassandra;
