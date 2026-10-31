# Distribution CSV Data

This directory contains CSV files for AO and PI token distributions, used for faster bootstrapping during deployment.

## Directory Structure

```
data/
├── AO_csvs/          # AO distribution CSV files (~23MB)
│   └── YYYY-MM-DD/   # Date-based subdirectories
│       └── *.csv     # Distribution CSV files by transaction ID
└── PI_csvs/          # PI distribution CSV files (~508MB)
    └── YYYY-MM-DD/   # Date-based subdirectories
        └── *.csv     # Distribution CSV files by transaction ID
```

## Purpose

These CSV files are automatically downloaded from Arweave when running the distribution indexers. By including them in the repository, we can:

1. **Faster Deployment**: Skip the initial CSV download phase
2. **Offline Testing**: Test indexing without network access
3. **Reproducibility**: Ensure consistent data across environments

## File Organization

### Date-Based Structure

CSV files are organized by date (YYYY-MM-DD format), matching the Arweave transaction timestamp when each distribution CSV was published.

### File Naming

Each CSV file is named after its Arweave transaction ID:

- Format: `{transactionId}.csv`
- Example: `abc123def456...xyz789.csv`

## Data Size

- **AO_csvs**: ~23MB (contains all AO distribution records)
- **PI_csvs**: ~508MB (contains all PI distribution records)
- **Total**: ~531MB

## Usage

The indexers (`ao_distribution_indexer_cassandra.js` and `pi_distribution_indexer_cassandra.js`) automatically use these directories:

```javascript
// AO Indexer
CSV_DIR: path.join(__dirname, "../../data/AO_csvs");

// PI Indexer
CSV_DIR: path.join(__dirname, "../../data/PI_csvs");
```

## Updating CSV Files

The indexers will automatically:

1. Check for new CSV transactions on Arweave
2. Download any missing CSV files
3. Save them to the appropriate date-based subdirectory
4. Process the distributions into Cassandra

To manually refresh all CSV files:

```bash
# Run the indexers (they will fetch any new CSVs)
yarn update-distributions
```

## Git Tracking

These CSV files **are tracked in Git** (exception to typical .gitignore rules for data files) to enable faster deployment bootstrapping.

The `.gitignore` file explicitly includes them:

```
!data/AO_csvs/**/*.csv
!data/PI_csvs/**/*.csv
```

## Bootstrapping on New Deployment

When deploying to a new environment:

1. **Clone the repository** (includes all CSV files)
2. **Run the indexers**:
   ```bash
   yarn update-distributions
   ```
3. The indexers will:
   - Read existing CSV files from `data/`
   - Parse and insert distributions into Cassandra
   - Check for any new CSVs since the last update
   - Download and process any new distributions

This approach is much faster than downloading all CSVs from Arweave on first run.

## CSV File Format

### AO Distribution CSVs

Columns vary by distribution type, but typically include:

- Wallet addresses
- Token amounts
- Timestamps
- Transaction metadata

### PI Distribution CSVs

Similar structure to AO, with PI-specific fields:

- PI token amounts
- Distribution events
- Wallet balances
- Metadata

## Maintenance

### Adding New CSVs

New CSV files are automatically added when running:

```bash
yarn update-distributions
```

The indexers will:

- Query Arweave for new distribution transactions
- Download new CSV files
- Save them to the appropriate date directory
- Process them into Cassandra

### Cleaning Up

To remove all CSV files and re-download from scratch:

```bash
# Remove all CSV files
rm -rf data/AO_csvs/* data/PI_csvs/*

# Re-run indexers (will download everything)
yarn update-distributions
```

**Note**: This is rarely needed and will take significantly longer than using the existing CSV files.

## Storage Considerations

The total data size (~531MB) is reasonable for Git repositories, especially when:

- Using Git LFS (Large File Storage) if needed
- Repository is primarily for deployment, not active development
- Faster bootstrapping outweighs repository size

If size becomes an issue, consider:

1. Using Git LFS for CSV files
2. Hosting CSV files separately (S3, etc.)
3. Downloading on first deployment instead of tracking in Git

## Related Files

- `src/indexers/ao_distribution_indexer_cassandra.js` - AO CSV processor
- `src/indexers/pi_distribution_indexer_cassandra.js` - PI CSV processor
- `jobs/update-distributions.js` - Job to update all distributions
