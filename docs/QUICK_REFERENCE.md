# AO Tax Tracker Server - Quick Reference

## 🚀 Quick Start Commands

### Server Management

```bash
# Check status
pm2 status
pm2 logs ao-tax-tracker-server

# Restart application
pm2 restart ao-tax-tracker-server

# Stop/Start
pm2 stop ao-tax-tracker-server
pm2 start ao-tax-tracker-server
```

### Database Management

```bash
# Connect to Cassandra
cqlsh

# Check keyspaces
cqlsh -e "DESCRIBE KEYSPACES;"

# Check table counts
cqlsh -e "SELECT COUNT(*) FROM ao_distributions.distributions;"
cqlsh -e "SELECT COUNT(*) FROM pi_distributions.distributions;"
cqlsh -e "SELECT COUNT(*) FROM ao_price_data.daily_prices;"
```

### Monitoring

```bash
# System status
./scripts/monitor.sh

# Health check
./scripts/health-check.sh

# Check logs
tail -f /var/log/ao-tax-tracker-server.log
```

### Backup & Restore

```bash
# Manual backup
./scripts/backup-cassandra.sh

# Export to Parquet
python3 scripts/export-to-parquet.py

# List backups
ls -la /home/aotaxteam/backups/
```

## 📊 API Endpoints

### Health & Info

- `GET /health` - Health check
- `GET /` - API information

### Distributions

- `POST /api/distributions/pdf` - Generate PDF report
- `GET /api/distributions/:wallet` - Get distribution data

### Prices

- `GET /api/prices/:token` - Get price data
- `GET /api/prices/:token/:date` - Get specific date price

### Jobs

- `POST /api/jobs/update-distributions` - Update distributions
- `POST /api/jobs/update-prices` - Update prices
- `POST /api/jobs/update-all` - Update everything

## 🔧 Common Tasks

### Update Application

```bash
cd /home/aotaxteam/ao-tax-tracker-server
git pull origin master
yarn install
pm2 restart ao-tax-tracker-server
```

### Install Python Dependencies (if needed)

```bash
# Install Python packages for Parquet export
pip3 install pyspark pyarrow pandas

# Verify installation
python3 -c "import pyspark, pyarrow, pandas; print('✅ All packages installed')"
```

### Add Team Member

```bash
# Add SSH key
echo "ssh-rsa AAAAB3NzaC1yc2E... new-member@example.com" >> ~/.ssh/authorized_keys

# Test connection
ssh aotaxteam@YOUR_SERVER_IP
```

### Check Disk Usage

```bash
df -h
du -sh /var/lib/cassandra/data/*
du -sh /home/aotaxteam/backups/*
```

### View Recent Logs

```bash
# Application logs
tail -f /var/log/ao-tax-tracker-server.log

# System logs
sudo journalctl -u cassandra -f
sudo journalctl -u nginx -f
```

## 🚨 Troubleshooting

### Application Won't Start

```bash
# Check logs
pm2 logs ao-tax-tracker-server

# Run directly to see errors
node server.js

# Check dependencies
yarn install
```

### Cassandra Issues

```bash
# Check status
sudo systemctl status cassandra

# Check logs
sudo journalctl -u cassandra -f

# Restart
sudo systemctl restart cassandra
```

### Memory Issues

```bash
# Check memory
free -h

# Check processes
ps aux --sort=-%mem | head -10

# Restart services
pm2 restart ao-tax-tracker-server
sudo systemctl restart cassandra
```

### Database Connection Issues

```bash
# Test connection
cqlsh -e "DESCRIBE KEYSPACES;"

# Check if Cassandra is listening
netstat -tlnp | grep 9042
```

## 📁 Important Directories

- **Application**: `/home/aotaxteam/ao-tax-tracker-server/`
- **Logs**: `/var/log/ao-tax-tracker-server.log`
- **Backups**: `/home/aotaxteam/backups/`
- **Cassandra Data**: `/var/lib/cassandra/data/`
- **Scripts**: `/home/aotaxteam/ao-tax-tracker-server/scripts/`

## 🔄 Automated Tasks

### Cron Jobs

- **Daily Backup**: 2:00 AM UTC (`backup-cassandra.sh`)
- **Health Check**: Every 5 minutes (`health-check.sh`)
- **Data Updates**: 1:00 AM UTC (built into application)

### PM2 Configuration

- **Auto-restart**: On crash
- **Memory limit**: 1GB
- **Log rotation**: Enabled
- **Startup**: On boot

## 💰 Cost Breakdown

- **Hetzner CX32**: $9.00/month
- **500GB Storage**: $24.00/month
- **Backup Storage**: $5.40/month
- **Total**: $38.40/month

**Savings vs Linode**: $69.20/month (64% cheaper)
