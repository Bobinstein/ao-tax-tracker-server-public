#!/bin/bash

# Cassandra Docker Management Script
# This script manages Cassandra running in a Docker container

set -e

CONTAINER_NAME="cassandra"
IMAGE_NAME="cassandra:4.1"
DATA_DIR="/opt/cassandra-data"
CASSANDRA_PORT="9042"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if Docker is running
check_docker() {
    if ! docker info >/dev/null 2>&1; then
        log_error "Docker is not running or not accessible"
        exit 1
    fi
}

# Create data directory if it doesn't exist
create_data_dir() {
    if [ ! -d "$DATA_DIR" ]; then
        log_info "Creating Cassandra data directory: $DATA_DIR"
        sudo mkdir -p "$DATA_DIR"
        # Prefer team group from the deployment guide; fall back to current user
        if getent group aotaxes >/dev/null 2>&1; then
            sudo chown -R "$(whoami):aotaxes" "$DATA_DIR"
        else
            sudo chown -R "$(whoami):$(whoami)" "$DATA_DIR"
        fi
    fi
}

# Start Cassandra container
start_cassandra() {
    log_info "Starting Cassandra Docker container..."
    
    # Check if container already exists
    if docker ps -a | grep -q "$CONTAINER_NAME"; then
        if docker ps | grep -q "$CONTAINER_NAME"; then
            log_info "Cassandra container is already running"
            return 0
        else
            log_info "Starting existing Cassandra container..."
            docker start "$CONTAINER_NAME"
        fi
    else
        log_info "Creating new Cassandra container..."
        docker run --name "$CONTAINER_NAME" \
            -d \
            -p "$CASSANDRA_PORT:$CASSANDRA_PORT" \
            -v "$DATA_DIR:/var/lib/cassandra" \
            "$IMAGE_NAME"
    fi
}

# Wait for Cassandra to be ready
wait_for_cassandra() {
    log_info "Waiting for Cassandra to start up..."
    
    local max_attempts=24  # 2 minutes with 5-second intervals
    local attempt=1
    
    while [ $attempt -le $max_attempts ]; do
        if docker exec "$CONTAINER_NAME" cqlsh -e "DESCRIBE KEYSPACES;" >/dev/null 2>&1; then
            log_info "Cassandra is ready!"
            return 0
        fi
        
        echo -n "."
        sleep 5
        attempt=$((attempt + 1))
    done
    
    log_error "Cassandra failed to start within 2 minutes"
    return 1
}

# Check Cassandra status
check_status() {
    log_info "Checking Cassandra status..."
    
    if docker ps | grep -q "$CONTAINER_NAME"; then
        log_info "✅ Cassandra container is running"
        docker ps | grep "$CONTAINER_NAME"
        
        # Test connection
        if docker exec "$CONTAINER_NAME" cqlsh -e "DESCRIBE KEYSPACES;" >/dev/null 2>&1; then
            log_info "✅ Cassandra is accepting connections on localhost:$CASSANDRA_PORT"
        else
            log_warn "⚠️  Cassandra container is running but not accepting connections yet"
        fi
    else
        log_error "❌ Cassandra container is not running"
        return 1
    fi
}

# Stop Cassandra
stop_cassandra() {
    log_info "Stopping Cassandra container..."
    
    if docker ps | grep -q "$CONTAINER_NAME"; then
        docker stop "$CONTAINER_NAME"
        log_info "Cassandra stopped"
    else
        log_warn "Cassandra container is not running"
    fi
}

# Remove Cassandra container
remove_cassandra() {
    log_info "Removing Cassandra container..."
    
    if docker ps -a | grep -q "$CONTAINER_NAME"; then
        docker stop "$CONTAINER_NAME" 2>/dev/null || true
        docker rm "$CONTAINER_NAME"
        log_info "Cassandra container removed"
    else
        log_warn "Cassandra container does not exist"
    fi
}

# Show logs
show_logs() {
    log_info "Showing Cassandra logs (Ctrl+C to exit)..."
    docker logs -f "$CONTAINER_NAME"
}

# Connect to cqlsh
connect_cqlsh() {
    log_info "Connecting to cqlsh..."
    docker exec -it "$CONTAINER_NAME" cqlsh
}

# Main script logic
main() {
    case "${1:-start}" in
        "start")
            check_docker
            create_data_dir
            start_cassandra
            wait_for_cassandra
            check_status
            ;;
        "stop")
            stop_cassandra
            ;;
        "restart")
            stop_cassandra
            sleep 2
            check_docker
            create_data_dir
            start_cassandra
            wait_for_cassandra
            check_status
            ;;
        "status")
            check_status
            ;;
        "logs")
            show_logs
            ;;
        "cqlsh")
            connect_cqlsh
            ;;
        "remove")
            remove_cassandra
            ;;
        "help"|"-h"|"--help")
            echo "Usage: $0 [command]"
            echo ""
            echo "Commands:"
            echo "  start    - Start Cassandra container (default)"
            echo "  stop     - Stop Cassandra container"
            echo "  restart  - Restart Cassandra container"
            echo "  status   - Check Cassandra status"
            echo "  logs     - Show Cassandra logs"
            echo "  cqlsh    - Connect to cqlsh"
            echo "  remove   - Remove Cassandra container"
            echo "  help     - Show this help message"
            ;;
        *)
            log_error "Unknown command: $1"
            echo "Use '$0 help' for usage information"
            exit 1
            ;;
    esac
}

# Run main function with all arguments
main "$@"
