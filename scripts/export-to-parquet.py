#!/usr/bin/env python3

"""
AO Tax Tracker Server - Cassandra to Parquet Export Script
Exports all Cassandra data to Parquet format for efficient backup and analysis
"""

import os
import sys
import subprocess
from datetime import datetime

def check_dependencies():
    """Check if required dependencies are installed"""
    try:
        import pyspark
        import pyarrow
        import pandas
        print("✅ All dependencies are available")
        return True
    except ImportError as e:
        print(f"❌ Missing dependency: {e}")
        print("Please install with: pip3 install pyspark pyarrow pandas")
        return False

def export_cassandra_to_parquet():
    """Export all Cassandra keyspaces to Parquet format"""
    
    if not check_dependencies():
        sys.exit(1)
    
    from pyspark.sql import SparkSession
    
    print("🚀 Starting Cassandra to Parquet export...")
    print(f"⏰ Started at: {datetime.now()}")
    
    # Initialize Spark
    spark = SparkSession.builder \
        .appName("Cassandra to Parquet Export") \
        .config("spark.jars.packages", "com.datastax.spark:spark-cassandra-connector_2.12:3.3.0") \
        .config("spark.cassandra.connection.host", "localhost") \
        .config("spark.cassandra.connection.port", "9042") \
        .config("spark.sql.adaptive.enabled", "true") \
        .config("spark.sql.adaptive.coalescePartitions.enabled", "true") \
        .getOrCreate()
    
    # Keyspaces to export
    keyspaces = ["ao_distributions", "pi_distributions", "ao_price_data", "ario_distributions", "ario_gateway_history"]
    
    total_tables = 0
    successful_exports = 0
    
    for keyspace in keyspaces:
        print(f"\n📊 Exporting {keyspace}...")
        
        try:
            # Get all tables in keyspace
            tables_df = spark.sql(f"SHOW TABLES FROM {keyspace}")
            tables = [row.tableName for row in tables_df.collect()]
            
            if not tables:
                print(f"  ⚠️  No tables found in {keyspace}")
                continue
                
            print(f"  📋 Found {len(tables)} tables: {', '.join(tables)}")
            
            for table in tables:
                try:
                    print(f"    📄 Exporting {keyspace}.{table}...")
                    
                    # Read from Cassandra
                    df = spark.read \
                        .format("org.apache.spark.sql.cassandra") \
                        .options(table=table, keyspace=keyspace) \
                        .load()
                    
                    # Get row count
                    row_count = df.count()
                    print(f"      📊 Rows: {row_count:,}")
                    
                    if row_count == 0:
                        print(f"      ⚠️  Table is empty, skipping...")
                        continue
                    
                    # Write to Parquet
                    output_path = f"/home/aotaxteam/backups/parquet/{keyspace}/{table}.parquet"
                    os.makedirs(os.path.dirname(output_path), exist_ok=True)
                    
                    df.write.mode("overwrite").parquet(output_path)
                    
                    # Get file size
                    file_size = subprocess.check_output(['du', '-sh', output_path]).decode().split()[0]
                    print(f"      ✅ Exported to {output_path} ({file_size})")
                    
                    successful_exports += 1
                    total_tables += 1
                    
                except Exception as e:
                    print(f"      ❌ Error exporting {keyspace}.{table}: {str(e)}")
                    total_tables += 1
                    
        except Exception as e:
            print(f"  ❌ Error accessing keyspace {keyspace}: {str(e)}")
    
    # Create summary
    summary_path = "/home/aotaxteam/backups/parquet/export_summary.txt"
    with open(summary_path, 'w') as f:
        f.write(f"AO Tax Tracker Server - Parquet Export Summary\n")
        f.write(f"==============================================\n")
        f.write(f"Export Date: {datetime.now()}\n")
        f.write(f"Server: {os.uname().nodename}\n")
        f.write(f"Total Tables Processed: {total_tables}\n")
        f.write(f"Successful Exports: {successful_exports}\n")
        f.write(f"Failed Exports: {total_tables - successful_exports}\n")
        f.write(f"Success Rate: {(successful_exports/total_tables*100):.1f}%\n\n")
        f.write(f"Keyspaces Exported:\n")
        for keyspace in keyspaces:
            f.write(f"  - {keyspace}\n")
    
    spark.stop()
    
    print(f"\n🎉 Parquet export completed!")
    print(f"📊 Total tables: {total_tables}")
    print(f"✅ Successful: {successful_exports}")
    print(f"❌ Failed: {total_tables - successful_exports}")
    print(f"📁 Export location: /home/aotaxteam/backups/parquet/")
    print(f"📄 Summary: {summary_path}")
    print(f"⏰ Completed at: {datetime.now()}")

if __name__ == "__main__":
    export_cassandra_to_parquet()
