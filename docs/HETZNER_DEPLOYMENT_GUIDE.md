# Hetzner Deployment Guide: AO Tax Tracker Server

Complete setup guide for deploying the AO Tax Tracker Server on Hetzner Cloud with Ubuntu 24.04 LTS.

## 📋 Prerequisites

- Hetzner Cloud account
- SSH key pair generated
- Domain name (optional, for production)

## 🖥️ Step 1: Create Hetzner Server

### 1.1 Create New Project

1. Log into [Hetzner Cloud Console](https://console.hetzner.cloud/)
2. Create new project: "AO Tax Tracker"
3. Select region: **Nuremberg** (recommended for performance)

### 1.2 Create Server

1. Click "Add Server"
2. **Image**: Ubuntu 24.04 LTS
3. **Type**: CX32 (4 vCPU, 8GB RAM, 80GB SSD) - $9/month
4. **SSH Key**: Upload your public key
5. **Name**: `ao-tax-tracker-prod`
6. **Location**: Nuremberg (Germany)
7. Click "Create & Buy Now"

### 1.3 Initial Server Access

```bash
# Connect to your server
ssh root@YOUR_SERVER_IP

# Update system
apt update && apt upgrade -y
```

## 👥 Step 2: Create Team Group and User Accounts

> **Why Group-Based Access?** This approach creates individual user accounts (`deploy`, `teammate`) that belong to a shared group (`aotaxes`). This provides better security, audit trails, and allows each team member to have their own SSH access while sharing project files.

### 2.1 Create Team Group

```bash
# Create team group
groupadd aotaxes

# Create individual user accounts
adduser deploy
adduser teammate

# Add users to team group
usermod -aG aotaxes deploy
usermod -aG aotaxes teammate

# Add users to sudo group
usermod -aG sudo deploy
usermod -aG sudo teammate
```

### 2.2 Setup SSH Access for Each User

```bash
# For deploy
su - deploy
mkdir -p ~/.ssh
chmod 700 ~/.ssh
nano ~/.ssh/authorized_keys
# Paste deploy's public key here
chmod 600 ~/.ssh/authorized_keys
chown -R deploy:deploy ~/.ssh
exit

# For teammate
su - teammate
mkdir -p ~/.ssh
chmod 700 ~/.ssh
nano ~/.ssh/authorized_keys
# Paste teammate's public key here
chmod 600 ~/.ssh/authorized_keys
chown -R teammate:teammate ~/.ssh
exit
```

### 2.3 Configure Sudo Access

```bash
# Configure sudo for team members
echo "deploy ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/deploy
echo "teammate ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/teammate
```

## 🗄️ Step 3: Install Cassandra 4.1 with Docker

### 3.1 Install Docker

```bash
# Switch to deploy user
su - deploy

# Update package list
sudo apt update

# Install Docker
sudo apt install docker.io -y

# Add deploy to docker group
sudo usermod -aG docker deploy

# Start and enable Docker service
sudo systemctl start docker
sudo systemctl enable docker

# Log out and back in for group changes to take effect
exit
```

Then SSH back in:

```bash
ssh deploy@YOUR_SERVER_HOSTNAME
```

### 3.2 Setup Cassandra with Docker

```bash
# Create Cassandra data directory
sudo mkdir -p /opt/cassandra-data
sudo chown -R deploy:aotaxes /opt/cassandra-data

# Pull Cassandra 4.1 image
docker pull cassandra:4.1

# Use the provided script to start Cassandra
cd /opt/ao-tax-tracker-server
./scripts/start-cassandra-docker.sh start

# Check status
./scripts/start-cassandra-docker.sh status
```

### 3.3 Verify Cassandra Installation

```bash
# Test connection
./scripts/start-cassandra-docker.sh cqlsh

# Or test from command line
docker exec cassandra cqlsh -e "DESCRIBE KEYSPACES;"
```

## 🐍 Step 4: Install Node.js 20.x

### 4.1 Install Node.js

```bash
# Install Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify installation
node --version
npm --version
```

### 4.2 Install Yarn

```bash
# Install Yarn
npm install -g yarn

# Verify installation
yarn --version
```

### 4.3 Install Python and Dependencies

```bash
# Install Python 3 and pip
sudo apt install python3 python3-pip python3-venv -y

# Verify installation
python3 --version
pip3 --version

# Install required Python packages for Parquet export
pip3 install pyspark pyarrow pandas

# Verify packages
python3 -c "import pyspark, pyarrow, pandas; print('✅ All Python packages installed successfully')"
```

## 📦 Step 5: Deploy Application

### 5.1 Clone Repository

```bash
# Clone the repository to /opt for system-wide access
sudo git clone https://github.com/Bobinstein/ao-tax-tracker-server.git /opt/ao-tax-tracker-server
cd /opt/ao-tax-tracker-server

# Set proper ownership and permissions
sudo chown -R deploy:aotaxes /opt/ao-tax-tracker-server
sudo chmod -R 775 /opt/ao-tax-tracker-server
sudo chmod g+s /opt/ao-tax-tracker-server

# Install dependencies
yarn install
```

### 5.2 Configure Environment

```bash
# Create environment file
cp env.example .env

# Edit environment variables
nano .env

# Add these settings:
# PORT=3000
# CASSANDRA_HOST=localhost
# CASSANDRA_DATACENTER=datacenter1
# CASSANDRA_KEYSPACE_PRICE=ao_price_data
# CASSANDRA_KEYSPACE_AO=ao_distributions
# CASSANDRA_KEYSPACE_PI=pi_distributions
# CASSANDRA_KEYSPACE_ARIO=ario_distributions
# CASSANDRA_KEYSPACE_ARIO_GATEWAY=ario_gateway_history
```

### 5.3 Test Database Connection

```bash
# Test Cassandra connection
node -e "
const cassandra = require('cassandra-driver');
const client = new cassandra.Client({
  contactPoints: ['localhost'],
  localDataCenter: 'datacenter1'
});
client.connect().then(() => {
  console.log('✅ Cassandra connection successful');
  client.shutdown();
}).catch(err => {
  console.error('❌ Cassandra connection failed:', err.message);
  process.exit(1);
});
"
```

## 🚀 Step 6: Initial Data Bootstrap

### 6.1 Create Database Schema

```bash
# Run the database setup
node -e "
const cassandra = require('cassandra-driver');
const CONFIG = require('./config/database');

async function setupDatabase() {
  const client = new cassandra.Client({
    contactPoints: ['localhost'],
    localDataCenter: 'datacenter1',
  });

  await client.connect();
  console.log('✅ Connected to Cassandra');

  // Create keyspaces
  const keyspaces = [
    'ao_price_data',
    'ao_distributions',
    'pi_distributions',
    'ario_distributions',
    'ario_gateway_history'
  ];

  for (const keyspace of keyspaces) {
    await client.execute(\`CREATE KEYSPACE IF NOT EXISTS \${keyspace} WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}\`);
    console.log(\`✅ Created keyspace: \${keyspace}\`);
  }

  await client.shutdown();
  console.log('✅ Database setup complete');
}

setupDatabase().catch(console.error);
"
```

### 6.2 Bootstrap All Data

```bash
# Run initial data bootstrap (this will take 30-60 minutes)
echo "🚀 Starting initial data bootstrap..."
echo "This will download and index all distribution data"
echo "Estimated time: 30-60 minutes"

# Run all indexers
yarn update-all

# Monitor progress
tail -f /var/log/syslog | grep -i cassandra
```

### 6.3 Verify Data

```bash
# Check data counts
cqlsh -e "SELECT COUNT(*) FROM ao_distributions.distributions;"
cqlsh -e "SELECT COUNT(*) FROM pi_distributions.distributions;"
cqlsh -e "SELECT COUNT(*) FROM ao_price_data.daily_prices;"
cqlsh -e "SELECT COUNT(*) FROM ario_distributions.distributions;"
cqlsh -e "SELECT COUNT(*) FROM ario_gateway_history.gateway_actions;"
```

## 🔧 Step 7: Setup Production Services

### 7.1 Install PM2

```bash
# Install PM2 globally
sudo npm install -g pm2

# Create PM2 ecosystem file
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'ao-tax-tracker-server',
    script: 'server.js',
    cwd: '/opt/ao-tax-tracker-server',
    user: 'deploy',
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    log_file: '/var/log/ao-tax-tracker-server.log',
    out_file: '/var/log/ao-tax-tracker-server-out.log',
    error_file: '/var/log/ao-tax-tracker-server-error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    max_memory_restart: '1G',
    restart_delay: 4000,
    max_restarts: 10,
    min_uptime: '10s'
  }]
};
EOF
```

### 7.2 Start Application

```bash
# Start with PM2
pm2 start ecosystem.config.js

# Save PM2 configuration
pm2 save

# Setup PM2 to start on boot
pm2 startup
# Follow the instructions shown

# Check status
pm2 status
pm2 logs ao-tax-tracker-server
```

### 7.3 Setup Nginx (Optional)

```bash
# Install Nginx
sudo apt install nginx -y

# Create Nginx configuration
sudo nano /etc/nginx/sites-available/ao-tax-tracker

# Add this configuration:
server {
    listen 80;
    server_name YOUR_DOMAIN_OR_IP;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}

# Enable site
sudo ln -s /etc/nginx/sites-available/ao-tax-tracker /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

## 💾 Step 8: Setup Backup System

### 8.1 Create Backup Scripts

```bash
# Create backup directory
sudo mkdir -p /opt/backups
sudo chown -R deploy:aotaxes /opt/backups
cd /opt/ao-tax-tracker-server

# Create backup script
cat > scripts/backup-cassandra.sh << 'EOF'
#!/bin/bash

# Configuration
BACKUP_DIR="/opt/backups"
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_PATH="$BACKUP_DIR/cassandra_backup_$DATE"

# Create backup directory
mkdir -p "$BACKUP_PATH"

echo "🔄 Starting Cassandra backup at $(date)"

# Export each keyspace
keyspaces=("ao_distributions" "pi_distributions" "ao_price_data" "ario_distributions" "ario_gateway_history")

for keyspace in "${keyspaces[@]}"; do
    echo "📊 Exporting $keyspace..."

    # Get all tables in keyspace
    tables=$(cqlsh -e "DESCRIBE TABLES;" "$keyspace" | grep -v "system" | grep -v "^$" | tr -d ' ')

    for table in $tables; do
        if [ ! -z "$table" ]; then
            echo "  📋 Exporting $keyspace.$table"
            cqlsh -e "COPY $keyspace.$table TO '$BACKUP_PATH/${keyspace}_${table}.csv' WITH HEADER=true;"
        fi
    done
done

# Create metadata file
cat > "$BACKUP_PATH/metadata.txt" << EOL
Backup Date: $(date)
Server: $(hostname)
Cassandra Version: $(cassandra --version)
Total Keyspaces: ${#keyspaces[@]}
Backup Path: $BACKUP_PATH
EOL

# Compress backup
cd "$BACKUP_DIR"
tar -czf "cassandra_backup_$DATE.tar.gz" "cassandra_backup_$DATE"
rm -rf "cassandra_backup_$DATE"

echo "✅ Backup completed: cassandra_backup_$DATE.tar.gz"
echo "📁 Backup size: $(du -h cassandra_backup_$DATE.tar.gz | cut -f1)"

# Keep only last 7 days of backups
find "$BACKUP_DIR" -name "cassandra_backup_*.tar.gz" -mtime +7 -delete

echo "🧹 Cleaned up old backups (kept last 7 days)"
EOF

# Make executable
chmod +x scripts/backup-cassandra.sh
```

### 8.2 Setup Automated Backups

```bash
# Add to crontab
crontab -e

# Add this line for daily backups at 2 AM
0 2 * * * /opt/ao-tax-tracker-server/scripts/backup-cassandra.sh >> /var/log/cassandra-backup.log 2>&1

# Test backup script
./scripts/backup-cassandra.sh
```

### 8.3 Setup Parquet Export (Advanced)

```bash
# Note: Python and packages should already be installed from Step 4.3
# If not, run: sudo apt install python3 python3-pip -y && pip3 install pyspark pyarrow pandas

# Create Parquet export script
cat > scripts/export-to-parquet.py << 'EOF'
#!/usr/bin/env python3

import os
import sys
from pyspark.sql import SparkSession
from pyspark.sql.types import *
import pyarrow as pa
import pyarrow.parquet as pq

def export_cassandra_to_parquet():
    # Initialize Spark
    spark = SparkSession.builder \
        .appName("Cassandra to Parquet Export") \
        .config("spark.jars.packages", "com.datastax.spark:spark-cassandra-connector_2.12:3.3.0") \
        .config("spark.cassandra.connection.host", "localhost") \
        .config("spark.cassandra.connection.port", "9042") \
        .getOrCreate()

    # Keyspaces to export
    keyspaces = ["ao_distributions", "pi_distributions", "ao_price_data", "ario_distributions", "ario_gateway_history"]

    for keyspace in keyspaces:
        print(f"📊 Exporting {keyspace}...")

        try:
            # Get all tables in keyspace
            tables_df = spark.sql(f"SHOW TABLES FROM {keyspace}")
            tables = [row.tableName for row in tables_df.collect()]

            for table in tables:
                print(f"  📋 Exporting {keyspace}.{table}")

                # Read from Cassandra
                df = spark.read \
                    .format("org.apache.spark.sql.cassandra") \
                    .options(table=table, keyspace=keyspace) \
                    .load()

                # Write to Parquet
                output_path = f"/opt/backups/parquet/{keyspace}/{table}.parquet"
                os.makedirs(os.path.dirname(output_path), exist_ok=True)

                df.write.mode("overwrite").parquet(output_path)
                print(f"    ✅ Exported to {output_path}")

        except Exception as e:
            print(f"    ❌ Error exporting {keyspace}: {str(e)}")

    spark.stop()
    print("✅ Parquet export completed")

if __name__ == "__main__":
    export_cassandra_to_parquet()
EOF

# Make executable
chmod +x scripts/export-to-parquet.py

# Create directory for Parquet exports
sudo mkdir -p /opt/backups/parquet
sudo chown -R deploy:aotaxes /opt/backups/parquet
```

## 🔍 Step 9: Monitoring & Maintenance

### 9.1 Setup Log Monitoring

```bash
# Install log monitoring tools
sudo apt install htop iotop nethogs -y

# Create monitoring script
cat > scripts/monitor.sh << 'EOF'
#!/bin/bash

echo "🖥️  System Status - $(date)"
echo "================================"

echo "📊 Memory Usage:"
free -h

echo -e "\n💾 Disk Usage:"
df -h

echo -e "\n🔄 Cassandra Status:"
sudo systemctl status cassandra --no-pager

echo -e "\n🚀 Application Status:"
pm2 status

echo -e "\n📈 Cassandra Node Status:"
nodetool status

echo -e "\n💽 Cassandra Disk Usage:"
sudo du -sh /var/lib/cassandra/data/*

echo -e "\n📋 Recent Logs:"
tail -n 10 /var/log/ao-tax-tracker-server.log
EOF

chmod +x scripts/monitor.sh
```

### 9.2 Setup Health Checks

```bash
# Create health check script
cat > scripts/health-check.sh << 'EOF'
#!/bin/bash

# Check if services are running
if ! systemctl is-active --quiet cassandra; then
    echo "❌ Cassandra is not running"
    exit 1
fi

if ! pm2 list | grep -q "ao-tax-tracker-server.*online"; then
    echo "❌ Application is not running"
    exit 1
fi

# Check if application responds
if ! curl -f http://localhost:3000/health > /dev/null 2>&1; then
    echo "❌ Application health check failed"
    exit 1
fi

echo "✅ All services are healthy"
EOF

chmod +x scripts/health-check.sh

# Add to crontab for every 5 minutes
crontab -e
# Add: */5 * * * * /opt/ao-tax-tracker-server/scripts/health-check.sh
```

## 🎯 Step 10: Final Verification

### 10.1 Test All Endpoints

```bash
# Test health endpoint
curl http://localhost:3000/health

# Test API info
curl http://localhost:3000/

# Test PDF generation (replace with actual wallet)
curl -X POST http://localhost:3000/api/distributions/pdf \
  -H "Content-Type: application/json" \
  -d '{
    "wallet": "uzESID1JQp8m4RO7YjfVZ8eWtRsSrxLp1SilTj7psB8",
    "startDate": "2025-01-01",
    "endDate": "2025-12-31"
  }' \
  --output test-report.pdf
```

### 10.2 Verify Data Integrity

```bash
# Check data counts
echo "📊 Data Verification:"
echo "AO Distributions: $(cqlsh -e "SELECT COUNT(*) FROM ao_distributions.distributions;" | grep -o '[0-9]*')"
echo "PI Distributions: $(cqlsh -e "SELECT COUNT(*) FROM pi_distributions.distributions;" | grep -o '[0-9]*')"
echo "Price Records: $(cqlsh -e "SELECT COUNT(*) FROM ao_price_data.daily_prices;" | grep -o '[0-9]*')"
echo "ARIO Distributions: $(cqlsh -e "SELECT COUNT(*) FROM ario_distributions.distributions;" | grep -o '[0-9]*')"
echo "Gateway Actions: $(cqlsh -e "SELECT COUNT(*) FROM ario_gateway_history.gateway_actions;" | grep -o '[0-9]*')"
```

## 📚 Step 11: Team Access & Maintenance

### 11.1 Team Member Onboarding

```bash
# For each new team member:
# 1. Create their user account and add to aotaxes group
sudo adduser newmember
sudo usermod -aG aotaxes newmember
sudo usermod -aG sudo newmember

# 2. Setup their SSH access
sudo su - newmember
mkdir -p ~/.ssh
chmod 700 ~/.ssh
nano ~/.ssh/authorized_keys
# Paste their public key here
chmod 600 ~/.ssh/authorized_keys
chown -R newmember:newmember ~/.ssh
exit

# 3. Configure sudo access
echo "newmember ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/newmember

# 4. Give them the server IP and connection command:
ssh newmember@YOUR_SERVER_IP

# 5. They can then:
cd /opt/ao-tax-tracker-server
pm2 status
pm2 logs ao-tax-tracker-server
./scripts/monitor.sh
```

### 11.2 Common Maintenance Commands

```bash
# Restart application
pm2 restart ao-tax-tracker-server

# View logs
pm2 logs ao-tax-tracker-server

# Check system status
./scripts/monitor.sh

# Run manual backup
./scripts/backup-cassandra.sh

# Export to Parquet
python3 scripts/export-to-parquet.py

# Update application
git pull origin master
yarn install
pm2 restart ao-tax-tracker-server
```

## 🚨 Troubleshooting

### Common Issues:

1. **Cassandra won't start:**

   ```bash
   # Check Docker container status
   docker ps -a | grep cassandra

   # Check Cassandra logs
   ./scripts/start-cassandra-docker.sh logs

   # Restart Cassandra
   ./scripts/start-cassandra-docker.sh restart
   ```

2. **Application won't start:**

   ```bash
   pm2 logs ao-tax-tracker-server
   node server.js  # Run directly to see errors
   ```

3. **Database connection issues:**

   ```bash
   # Test Cassandra connection
   ./scripts/start-cassandra-docker.sh cqlsh

   # Or test from command line
   docker exec cassandra cqlsh -e "DESCRIBE KEYSPACES;"
   ```

4. **Memory issues:**

   ```bash
   free -h
   docker stats cassandra
   ```

5. **Docker issues:**

   ```bash
   # Check Docker service
   sudo systemctl status docker

   # Restart Docker
   sudo systemctl restart docker

   # Check if user is in docker group
   groups deploy
   ```

## 📞 Support

- **Server IP**: `YOUR_SERVER_IP`
- **Application URL**: `http://YOUR_SERVER_IP:3000`
- **Logs**: `/var/log/ao-tax-tracker-server.log`
- **Backups**: `/opt/backups/`

## 🎉 Success!

Your AO Tax Tracker Server is now fully deployed and ready for production use! The server will automatically:

- ✅ Update distributions daily at 1 AM UTC
- ✅ Backup data daily at 2 AM UTC
- ✅ Monitor health every 5 minutes
- ✅ Handle 1,000-5,000 concurrent users
- ✅ Provide full PDF generation capabilities

**Total monthly cost**: ~$38.40 (vs $107.60 on Linode) - **64% savings!**
