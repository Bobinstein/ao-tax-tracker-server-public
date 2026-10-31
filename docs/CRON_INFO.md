# Built-in Cron Scheduler

## Overview

The API server now includes **built-in automatic updates** using `node-cron`. No external cron setup is required!

## How It Works

### Automatic Scheduling

When you start the server with `yarn start`, it automatically:

1. **Schedules a daily job** at 1:00 AM UTC
2. **Runs in the background** without interrupting API requests
3. **Updates all data** (distributions + prices)
4. **Logs progress** to console with timestamps

### What Gets Updated

The scheduled job runs these tasks sequentially:

1. ✅ **AO Distribution Indexer** - Checks for new AO CSVs on Arweave
2. ✅ **PI Distribution Indexer** - Checks for new PI CSVs on Arweave
3. ✅ **ARIO Gateway Mainnet Indexer** - Indexes gateway actions for yesterday + today
4. ✅ **CoinGecko Price Fetcher** - Fetches latest prices for AO and ARIO
5. ✅ **Permaswap Price Scraper** - Fetches latest pool prices for AO, PI, and ARIO

## Schedule

- **Frequency**: Daily
- **Time**: 1:00 AM UTC
- **Cron Expression**: `0 1 * * *`
- **Timezone**: UTC (explicitly set)

### Why 1:00 AM UTC?

- Off-peak hours for most users
- Allows time for Arweave transactions to settle
- Before typical business hours in most timezones

## Server Startup

When the server starts, you'll see:

```
⏰ Cron job scheduled: Daily update at 1:00 AM UTC

🚀 AO Tax Tracker Server Server
📡 Listening on http://localhost:3000
🏥 Health check: http://localhost:3000/health
📚 API info: http://localhost:3000/

⏰ Automated Updates:
   • Daily at 1:00 AM UTC: Distributions + Prices (node-cron)
   • Manual triggers available via POST /api/jobs/* endpoints

✨ Ready to serve requests!
```

## During Scheduled Updates

When the cron job runs, you'll see:

```
⏰ [2025-10-09T01:00:00.000Z] Starting scheduled daily update (distributions + prices)...
📊 Running AO distribution indexer...
✅ AO distributions updated
📊 Running PI distribution indexer...
✅ PI distributions updated
💰 Running CoinGecko price fetcher...
✅ CoinGecko prices updated
💰 Running Permaswap price scraper...
✅ Permaswap prices updated
✅ [2025-10-09T01:05:23.456Z] Scheduled daily update completed successfully!
```

## Manual Triggers (Still Available)

The built-in cron doesn't replace manual triggers - both work together!

### Trigger via API

```bash
# Trigger full update
curl -X POST http://localhost:3000/api/jobs/update-all

# Trigger distributions only
curl -X POST http://localhost:3000/api/jobs/update-distributions

# Trigger prices only
curl -X POST http://localhost:3000/api/jobs/update-prices
```

### Trigger via Command Line

```bash
# Run full update manually
yarn update-all

# Run specific updates
yarn update-distributions
yarn update-prices
```

## Advantages

### ✅ Built-in Cron (Default)

- **No external setup**: Works immediately when server starts
- **Integrated logging**: See cron job output in server logs
- **Automatic restart**: Cron jobs resume when server restarts
- **Simple deployment**: One less thing to configure on VPS

### ✅ System Cron (Optional Backup)

- **Runs independently**: Works even if server crashes
- **System-level**: Managed by OS cron daemon
- **Redundancy**: Backup if server goes down
- **Flexible scheduling**: Can run at different times

## Configuration

### Change Schedule Time

Edit `server.js` line 509-510:

```javascript
const dailyUpdateJob = cron.schedule(
  "0 1 * * *", // Change this cron expression
  async () => {
    // ...
  }
);
```

### Common Cron Expressions

```
0 1 * * *     - Daily at 1:00 AM UTC
0 */6 * * *   - Every 6 hours
0 0 * * *     - Midnight UTC
30 2 * * *    - 2:30 AM UTC
0 1 * * 0     - Sundays at 1:00 AM UTC
```

### Disable Built-in Cron

If you want to use external cron only, comment out the cron job in `server.js`:

```javascript
// const dailyUpdateJob = cron.schedule(
//   "0 1 * * *",
//   async () => { ... }
// );
```

## Monitoring

### Check if Cron is Running

Look for this message when server starts:

```
⏰ Cron job scheduled: Daily update at 1:00 AM UTC
```

### View Cron Job Output

The cron job logs to the same output as the server:

```bash
# If running with yarn start
# Output appears in terminal

# If running with PM2
pm2 logs ao-tax-tracker-server

# If running as systemd service
sudo journalctl -u ao-tax-tracker-server -f
```

## Production Considerations

### Using PM2

```bash
# Start server with PM2
pm2 start server.js --name ao-tax-tracker-server

# View logs (includes cron output)
pm2 logs ao-tax-tracker-server

# Server restarts automatically maintain cron schedule
pm2 restart ao-tax-tracker-server
```

### Redundancy Strategy (Recommended)

For maximum reliability, use **both** built-in cron AND system cron:

1. **Built-in cron**: Primary automatic updates (runs with server)
2. **System cron**: Backup updates (runs independently)

System cron as backup:

```bash
crontab -e
# Add as backup (runs 30 minutes after built-in cron)
30 1 * * * cd /opt/ao-tax-tracker-server && /usr/bin/yarn update-all >> /var/log/ao-api-backup.log 2>&1
```

This way:

- If server is running → Built-in cron handles it
- If server is down → System cron catches it 30 minutes later

## Error Handling

The cron job includes error handling:

```javascript
try {
  // Run updates
} catch (error) {
  console.error(`❌ Scheduled daily update failed:`, error.message);
}
```

**Failed updates:**

- Are logged to console/logs
- Don't crash the server
- Will retry next scheduled time
- Can be triggered manually if needed

## Comparison with External Cron

| Feature              | Built-in Cron  | System Cron      |
| -------------------- | -------------- | ---------------- |
| **Setup Required**   | ❌ None        | ✅ `crontab -e`  |
| **Runs When**        | Server running | Always           |
| **Logs Location**    | Server logs    | Separate file    |
| **Restart Behavior** | Auto-resumes   | Independent      |
| **Server Crash**     | ⚠️ Stops       | ✅ Continues     |
| **Resource Usage**   | Same process   | Separate process |
| **Recommended For**  | Primary        | Backup           |

## Troubleshooting

### Issue: Cron job not running

**Check 1:** Verify server is running

```bash
curl http://localhost:3000/health
```

**Check 2:** Check server logs for cron message

```bash
# Look for: "⏰ Cron job scheduled: Daily update at 1:00 AM UTC"
```

**Check 3:** Wait for scheduled time (1:00 AM UTC)

```bash
# Check current UTC time
date -u
```

### Issue: Updates failing

**Check logs:**

```bash
# Look for error messages starting with "❌"
pm2 logs ao-tax-tracker-server
```

**Trigger manually to debug:**

```bash
curl -X POST http://localhost:3000/api/jobs/update-all
```

### Issue: Wrong timezone

The cron is explicitly set to UTC. If you need a different timezone:

```javascript
{
  scheduled: true,
  timezone: "America/New_York", // Change this
}
```

## Data Integrity Features

The cron system also maintains data integrity by:

### Corrupted Epoch Detection

- **ARIO Epochs 13, 14, 15**: Automatically detected as corrupted during testnet-to-mainnet migration
- **Smart Gap Detection**: Uses presence of epochs 12 and 16 to infer missing epochs
- **PDF Reporting**: Generates footnotes explaining data loss to users
- **Database Metadata**: Stores corruption information in `ario_distributions.epoch_metadata`

### Gateway State Tracking

- **Testnet Indexing**: One-time historical data collection (June 2024 - Feb 2025)
- **Mainnet Indexing**: Daily updates for current gateway actions
- **AutoStake Detection**: Tracks gateway `autoStake` settings for accurate ARIO distribution calculations

## Summary

**Default Behavior (Built-in Cron):**

- ✅ Automatic daily updates at 1:00 AM UTC
- ✅ Zero configuration required
- ✅ Integrated with server lifecycle
- ✅ Manual triggers still available

**Best Practice:**

- Use built-in cron as primary
- Add system cron as backup
- Monitor logs for failures
- Keep manual triggers for testing

**Result:**

- Set it and forget it! 🎉
- Data stays fresh automatically
- API always serves up-to-date information
