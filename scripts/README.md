# Rejected CSV Checker

This directory contains scripts for checking and analyzing rejected AO CSV files.

## Overview

When the AO distribution indexer processes CSV files, it verifies each submission with the AO token process. If a CSV submission is rejected (due to unauthorized access, errors, or invalid patterns), it's saved with a `rejected-` prefix in the filename.

## Scripts

### `check-rejected-csvs.js`

Main script that scans the AO CSV directories for rejected files and extracts transaction IDs.

**Features:**

- Scans all date-based directories in `data/AO_csvs/`
- Finds files with `rejected-` prefix
- Extracts transaction IDs from filenames
- Provides multiple output formats (simple, detailed, stats)
- Groups results by date

**Usage:**

```bash
# Run directly
node scripts/check-rejected-csvs.js

# Or as a module
const RejectedCSVChecker = require('./scripts/check-rejected-csvs');
const checker = new RejectedCSVChecker();
await checker.scanRejectedCSVs();
```

### `test-rejected-csvs.js`

Test script to verify the RejectedCSVChecker functionality locally.

**Usage:**

```bash
node scripts/test-rejected-csvs.js
```

### `test-api.sh`

Bash script to test the API endpoint and save results to files.

**Usage:**

```bash
# Make executable first
chmod +x scripts/test-api.sh

# Run the test
./scripts/test-api.sh
```

## API Endpoint

The rejected CSV functionality is exposed via a REST API endpoint:

### `GET /api/rejected-csvs`

Retrieve rejected CSV transaction IDs with different output formats.

**Query Parameters:**

- `format` (optional): Output format
  - `simple` (default): Just transaction IDs
  - `detailed`: Full file information
  - `stats`: Statistics and grouping

**Examples:**

```bash
# Simple format (just transaction IDs)
curl http://localhost:3000/api/rejected-csvs

# Detailed format (full file info)
curl 'http://localhost:3000/api/rejected-csvs?format=detailed'

# Statistics format
curl 'http://localhost:3000/api/rejected-csvs?format=stats'

# Save to file
curl http://localhost:3000/api/rejected-csvs > rejected-csvs.json
```

**Response Formats:**

**Simple:**

```json
{
  "message": "Rejected CSV transaction IDs",
  "count": 5,
  "txIds": ["abc123...def456", "ghi789...jkl012"]
}
```

**Detailed:**

```json
{
  "message": "Rejected CSV files found",
  "count": 5,
  "data": [
    {
      "txId": "abc123...def456",
      "date": "2024-01-15",
      "filename": "rejected-abc123...def456.csv",
      "fullPath": "/path/to/data/AO_csvs/2024-01-15/rejected-abc123...def456.csv"
    }
  ]
}
```

**Stats:**

```json
{
  "message": "Rejected CSV statistics",
  "stats": {
    "total": 5,
    "dateRange": {
      "earliest": "2024-01-15",
      "latest": "2024-01-20"
    },
    "byDate": {
      "2024-01-15": ["abc123...def456"],
      "2024-01-20": ["ghi789...jkl012", "mno345...pqr678"]
    },
    "dates": ["2024-01-15", "2024-01-20"]
  }
}
```

## File Structure

The rejected CSV files are stored in the following structure:

```
data/AO_csvs/
├── 2024-01-15/
│   ├── abc123...def456.csv          # Normal CSV
│   ├── rejected-ghi789...jkl012.csv # Rejected CSV
│   └── rejected-mno345...pqr678.csv # Rejected CSV
├── 2024-01-16/
│   ├── stu901...vwx234.csv
│   └── rejected-yza567...bcd890.csv
└── ...
```

## Use Cases

1. **Audit Rejected CSVs**: Identify which CSV submissions were rejected and why
2. **Data Recovery**: Find rejected CSVs that might need manual review
3. **Quality Assurance**: Monitor the rejection rate over time
4. **Debugging**: Investigate why certain CSVs were marked as rejected

## Integration

The rejected CSV checker is integrated into the main server and can be used alongside other API endpoints. It requires authentication (same as other endpoints) and follows the same error handling patterns.

## Error Handling

- If the CSV directory doesn't exist, returns empty results
- If there are permission issues, returns appropriate error messages
- All errors are logged to the console for debugging
