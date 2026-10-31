#!/bin/bash

# AO Tax Tracker Server - Cassandra Backup Script
# Exports all keyspaces to CSV format for backup and restore

# Configuration
BACKUP_DIR="/home/aotaxteam/backups"
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_PATH="$BACKUP_DIR/cassandra_backup_$DATE"

# Create backup directory
mkdir -p "$BACKUP_PATH"

echo "🔄 Starting Cassandra backup at $(date)"
echo "📁 Backup directory: $BACKUP_PATH"

# Export each keyspace
keyspaces=("ao_distributions" "pi_distributions" "ao_price_data" "ario_distributions" "ario_gateway_history")

for keyspace in "${keyspaces[@]}"; do
    echo "📊 Exporting $keyspace..."
    
    # Get all tables in keyspace
    tables=$(cqlsh -e "DESCRIBE TABLES;" "$keyspace" 2>/dev/null | grep -v "system" | grep -v "^$" | tr -d ' ')
    
    if [ -z "$tables" ]; then
        echo "  ⚠️  No tables found in $keyspace"
        continue
    fi
    
    for table in $tables; do
        if [ ! -z "$table" ]; then
            echo "  📋 Exporting $keyspace.$table"
            cqlsh -e "COPY $keyspace.$table TO '$BACKUP_PATH/${keyspace}_${table}.csv' WITH HEADER=true;" 2>/dev/null
            
            if [ $? -eq 0 ]; then
                echo "    ✅ Success"
            else
                echo "    ❌ Failed to export $keyspace.$table"
            fi
        fi
    done
done

# Create metadata file
cat > "$BACKUP_PATH/metadata.txt" << EOL
AO Tax Tracker Server - Cassandra Backup
========================================
Backup Date: $(date)
Server: $(hostname)
Cassandra Version: $(cassandra --version 2>/dev/null || echo "Unknown")
Total Keyspaces: ${#keyspaces[@]}
Backup Path: $BACKUP_PATH

Keyspaces Exported:
$(printf '%s\n' "${keyspaces[@]}")

File Count: $(find "$BACKUP_PATH" -name "*.csv" | wc -l)
Total Size: $(du -sh "$BACKUP_PATH" | cut -f1)

Restore Instructions:
1. Create keyspaces: cqlsh -e "CREATE KEYSPACE keyspace_name WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};"
2. Import data: cqlsh -e "COPY keyspace_name.table_name FROM 'file.csv' WITH HEADER=true;"
EOL

# Compress backup
cd "$BACKUP_DIR"
echo "🗜️  Compressing backup..."
tar -czf "cassandra_backup_$DATE.tar.gz" "cassandra_backup_$DATE"
rm -rf "cassandra_backup_$DATE"

echo "✅ Backup completed: cassandra_backup_$DATE.tar.gz"
echo "📁 Backup size: $(du -h cassandra_backup_$DATE.tar.gz | cut -f1)"

# Keep only last 7 days of backups
echo "🧹 Cleaning up old backups..."
find "$BACKUP_DIR" -name "cassandra_backup_*.tar.gz" -mtime +7 -delete
echo "✅ Cleaned up old backups (kept last 7 days)"

echo "🎉 Backup process completed successfully!"
