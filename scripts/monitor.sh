#!/bin/bash

# AO Tax Tracker Server - System Monitoring Script
# Provides comprehensive system status overview

echo "🖥️  AO Tax Tracker Server - System Status"
echo "=========================================="
echo "⏰ $(date)"
echo ""

echo "📊 Memory Usage:"
echo "----------------"
free -h
echo ""

echo "💾 Disk Usage:"
echo "-------------"
df -h
echo ""

echo "🔄 Cassandra Status:"
echo "-------------------"
if systemctl is-active --quiet cassandra; then
    echo "✅ Cassandra is running"
    echo "📊 Uptime: $(systemctl show cassandra --property=ActiveEnterTimestamp --value | xargs -I {} date -d {} '+%Y-%m-%d %H:%M:%S')"
else
    echo "❌ Cassandra is not running"
fi
echo ""

echo "🚀 Application Status:"
echo "---------------------"
if command -v pm2 &> /dev/null; then
    pm2 status
else
    echo "⚠️  PM2 not found - application may not be running"
fi
echo ""

echo "📈 Cassandra Node Status:"
echo "------------------------"
if command -v nodetool &> /dev/null; then
    nodetool status 2>/dev/null || echo "⚠️  Could not get node status"
else
    echo "⚠️  nodetool not found"
fi
echo ""

echo "💽 Cassandra Disk Usage:"
echo "-----------------------"
if [ -d "/var/lib/cassandra/data" ]; then
    sudo du -sh /var/lib/cassandra/data/* 2>/dev/null | sort -hr || echo "⚠️  Could not access Cassandra data directory"
else
    echo "⚠️  Cassandra data directory not found"
fi
echo ""

echo "📋 Recent Application Logs:"
echo "--------------------------"
if [ -f "/var/log/ao-tax-tracker-server.log" ]; then
    echo "Last 10 lines from application log:"
    tail -n 10 /var/log/ao-tax-tracker-server.log 2>/dev/null || echo "⚠️  Could not read application log"
else
    echo "⚠️  Application log file not found"
fi
echo ""

echo "🌐 Network Connections:"
echo "----------------------"
echo "Active connections on port 3000:"
ss -tuln | grep :3000 || echo "No connections on port 3000"
echo ""

echo "📊 System Load:"
echo "---------------"
uptime
echo ""

echo "🔍 Process Information:"
echo "----------------------"
echo "Top processes by CPU usage:"
ps aux --sort=-%cpu | head -5
echo ""

echo "Top processes by memory usage:"
ps aux --sort=-%mem | head -5
echo ""

echo "✅ System monitoring completed"
echo "⏰ $(date)"
