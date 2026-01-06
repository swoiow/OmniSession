#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="usk-backend"
CONTAINER_NAME="usk-backend"

ENV_FILE="$ROOT_DIR/server/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  ENV_FILE="$ROOT_DIR/server/.env.example"
fi

load_env() {
  if [[ -f "$ENV_FILE" ]]; then
    set -a
    # shellcheck source=/dev/null
    source "$ENV_FILE"
    set +a
  fi
}

print_db_env() {
  load_env
  echo "USK_DB_HOST=${USK_DB_HOST:-}"
  echo "USK_DB_PORT=${USK_DB_PORT:-}"
  echo "USK_DB_NAME=${USK_DB_NAME:-}"
  echo "USK_DB_USER=${USK_DB_USER:-}"
  echo "USK_DB_PASSWORD=${USK_DB_PASSWORD:-}"
  echo "USK_DB_DEFAULT=${USK_DB_DEFAULT:-}"
  echo "USK_SQLITE_PATH=${USK_SQLITE_PATH:-}"
}

build_image() {
  cd "$ROOT_DIR/server"
  docker build -t "$IMAGE_NAME" .
}

stop_container() {
  if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    docker stop "$CONTAINER_NAME" >/dev/null
    docker rm "$CONTAINER_NAME" >/dev/null
  fi
}

start_container() {
  stop_container
  print_db_env

  if [[ -f "$ENV_FILE" ]]; then
    docker run -d --name "$CONTAINER_NAME" -p 8000:8000 --env-file "$ENV_FILE" "$IMAGE_NAME"
  else
    docker run -d --name "$CONTAINER_NAME" -p 8000:8000 "$IMAGE_NAME"
  fi
}

show_logs() {
  docker logs -f "$CONTAINER_NAME"
}

usage() {
  cat <<EOF
Usage: $(basename "$0") <command>

Commands:
  build    Build the backend Docker image
  start    Start the backend container (prints DB env vars)
  stop     Stop and remove the backend container
  restart  Restart the backend container
  logs     Follow container logs
  env      Print database-related environment variables
EOF
}

COMMAND="${1:-}"
case "$COMMAND" in
  build)
    build_image
    ;;
  start)
    start_container
    ;;
  stop)
    stop_container
    ;;
  restart)
    stop_container
    start_container
    ;;
  logs)
    show_logs
    ;;
  env)
    print_db_env
    ;;
  *)
    usage
    exit 1
    ;;
esac
