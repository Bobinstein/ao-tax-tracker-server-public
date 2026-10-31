# Distribution CSV Data

AO and PI distribution CSVs are downloaded from Arweave at runtime by the distribution indexers. They are **not** committed to this repository.

## Directory Structure

```
data/
├── AO_csvs/          # AO distribution CSV files (downloaded locally)
│   └── YYYY-MM-DD/   # Date-based subdirectories
│       └── *.csv
├── PI_csvs/          # PI distribution CSV files (downloaded locally)
│   └── YYYY-MM-DD/
│       └── *.csv
├── .gitkeep files    # Keep empty dirs in git
└── gateway-snapshot_*.json  # Optional AR.IO gateway snapshot (tracked)
```

## Purpose

On first run (or whenever files are missing), the indexers:

1. Discover distribution CSV transactions on Arweave
2. Download CSVs into `data/AO_csvs/` and `data/PI_csvs/`
3. Parse and insert distribution rows into Cassandra
4. Skip already-processed files on later runs

## Git Tracking

CSV contents under `data/AO_csvs/` and `data/PI_csvs/` are gitignored. Only `.gitkeep` placeholders are tracked so the directories exist after clone.

See `.gitignore` for the exact rules.

## Bootstrapping a New Deployment

```bash
yarn install
cp env.example .env   # configure as needed
yarn start            # schema auto-creates on boot

# In another terminal (or via job endpoints once auth is set up):
yarn update-distributions
```

First distribution indexing will take longer because CSVs must be fetched from Arweave.

## Updating CSV Files

```bash
yarn update-distributions
```

The indexers download any missing CSVs and process new distributions.

## Cleaning Up / Re-download

```bash
rm -rf data/AO_csvs/* data/PI_csvs/*
# restore gitkeeps if removed
touch data/AO_csvs/.gitkeep data/PI_csvs/.gitkeep
yarn update-distributions
```

## Related Files

- `src/indexers/ao_distribution_indexer_cassandra.js`
- `src/indexers/pi_distribution_indexer_cassandra.js`
- `jobs/update-distributions.js`
