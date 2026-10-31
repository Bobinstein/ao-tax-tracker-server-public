#!/bin/bash

# Test script for the rejected CSVs API endpoint
# This script tests the API endpoint locally

echo "🧪 Testing Rejected CSVs API Endpoint"
echo "====================================="
echo ""

# Check if server is running
echo "1. Checking if server is running..."
if curl -s http://localhost:3000/health > /dev/null; then
    echo "   ✅ Server is running"
else
    echo "   ❌ Server is not running. Please start it with: npm start"
    exit 1
fi
echo ""

# Test simple format
echo "2. Testing simple format..."
echo "   curl -s http://localhost:3000/api/rejected-csvs"
curl -s http://localhost:3000/api/rejected-csvs | jq '.' 2>/dev/null || curl -s http://localhost:3000/api/rejected-csvs
echo ""
echo ""

# Test detailed format
echo "3. Testing detailed format..."
echo "   curl -s 'http://localhost:3000/api/rejected-csvs?format=detailed'"
curl -s 'http://localhost:3000/api/rejected-csvs?format=detailed' | jq '.' 2>/dev/null || curl -s 'http://localhost:3000/api/rejected-csvs?format=detailed'
echo ""
echo ""

# Test stats format
echo "4. Testing stats format..."
echo "   curl -s 'http://localhost:3000/api/rejected-csvs?format=stats'"
curl -s 'http://localhost:3000/api/rejected-csvs?format=stats' | jq '.' 2>/dev/null || curl -s 'http://localhost:3000/api/rejected-csvs?format=stats'
echo ""
echo ""

# Save to file
echo "5. Saving results to file..."
echo "   Saving simple format to rejected-csvs-simple.json"
curl -s http://localhost:3000/api/rejected-csvs > rejected-csvs-simple.json
echo "   Saving detailed format to rejected-csvs-detailed.json"
curl -s 'http://localhost:3000/api/rejected-csvs?format=detailed' > rejected-csvs-detailed.json
echo "   Saving stats format to rejected-csvs-stats.json"
curl -s 'http://localhost:3000/api/rejected-csvs?format=stats' > rejected-csvs-stats.json
echo ""

echo "✅ API testing completed!"
echo ""
echo "📁 Files created:"
echo "   - rejected-csvs-simple.json"
echo "   - rejected-csvs-detailed.json" 
echo "   - rejected-csvs-stats.json"
echo ""
echo "🔍 To view the results:"
echo "   cat rejected-csvs-simple.json | jq '.txIds'"
echo "   cat rejected-csvs-detailed.json | jq '.data[0]'"
echo "   cat rejected-csvs-stats.json | jq '.stats'"
