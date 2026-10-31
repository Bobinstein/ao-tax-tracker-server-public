#!/bin/bash

# AO Tax Tracker Server - Health Check Script
# Used for automated monitoring and alerting

# Configuration
LOG_FILE="/var/log/ao-tax-tracker-health.log"
ALERT_EMAIL="admin@example.com"  # Change this to your alert email

# Function to log with timestamp
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# Function to send alert (customize based on your notification system)
send_alert() {
    local message="$1"
    log "🚨 ALERT: $message"
    # Add your notification method here (email, Slack, etc.)
    # Example: echo "$message" | mail -s "AO Tax Tracker Alert" "$ALERT_EMAIL"
}

# Initialize log
log "🔍 Starting health check..."

# Check if Cassandra is running
if ! systemctl is-active --quiet cassandra; then
    send_alert "Cassandra is not running"
    exit 1
fi
log "✅ Cassandra is running"

# Check if application is running
if ! command -v pm2 &> /dev/null; then
    send_alert "PM2 not found - application may not be running"
    exit 1
fi

if ! pm2 list | grep -q "ao-tax-tracker-server.*online"; then
    send_alert "Application is not running"
    exit 1
fi
log "✅ Application is running"

# Check if application responds to health endpoint
if ! curl -f http://localhost:3000/health > /dev/null 2>&1; then
    send_alert "Application health check failed - service not responding"
    exit 1
fi
log "✅ Application health endpoint responding"

# Check Cassandra connectivity
if ! cqlsh -e "SELECT now() FROM system.local;" > /dev/null 2>&1; then
    send_alert "Cassandra connectivity check failed"
    exit 1
fi
log "✅ Cassandra connectivity OK"

# Check disk space (alert if less than 10% free)
DISK_USAGE=$(df / | awk 'NR==2 {print $5}' | sed 's/%//')
if [ "$DISK_USAGE" -gt 90 ]; then
    send_alert "Disk usage is ${DISK_USAGE}% - running low on space"
    exit 1
fi
log "✅ Disk usage OK (${DISK_USAGE}%)"

# Check memory usage (alert if less than 1GB free)
MEMORY_FREE=$(free -m | awk 'NR==2{printf "%.0f", $7}')
if [ "$MEMORY_FREE" -lt 1024 ]; then
    send_alert "Low memory warning - only ${MEMORY_FREE}MB free"
    exit 1
fi
log "✅ Memory usage OK (${MEMORY_FREE}MB free)"

# Check if backup directory exists and is writable
if [ ! -d "/home/aotaxteam/backups" ]; then
    send_alert "Backup directory not found"
    exit 1
fi

if [ ! -w "/home/aotaxteam/backups" ]; then
    send_alert "Backup directory not writable"
    exit 1
fi
log "✅ Backup directory OK"

# Check recent error logs
if [ -f "/var/log/ao-tax-tracker-server-error.log" ]; then
    ERROR_COUNT=$(tail -n 100 /var/log/ao-tax-tracker-server-error.log | grep -c "ERROR" || echo "0")
    if [ "$ERROR_COUNT" -gt 10 ]; then
        send_alert "High error count in recent logs: $ERROR_COUNT errors"
        exit 1
    fi
fi
log "✅ Error log check OK"

# Check if cron jobs are running
if ! crontab -l | grep -q "backup-cassandra.sh"; then
    send_alert "Backup cron job not found"
    exit 1
fi
log "✅ Backup cron job configured"

# All checks passed
log "✅ All health checks passed - system is healthy"
exit 0
