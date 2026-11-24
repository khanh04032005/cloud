#!/usr/bin/env bash
# Build/run the actual app and workers against a disposable database and Kafka.
set -euo pipefail
cd "$(dirname "$0")/.."
export PG_PORT=${INTEGRATION_PG_PORT:-25432}
export REDIS_PORT=${INTEGRATION_REDIS_PORT:-26379}
export APP_PORT=${INTEGRATION_APP_PORT:-18080}
project="razzia-test-$(date +%s)-$$"
compose=(docker compose -p "$project" -f compose.full.yml -f deploy/integration.compose.yml)
cleanup() {
  code=$?
  if ((code != 0)); then "${compose[@]}" logs --tail 40 socket-1 socket-2 publisher score stats; fi
  "${compose[@]}" down --volumes --remove-orphans
  exit "$code"
}
trap cleanup EXIT
"${compose[@]}" up -d --build --wait --wait-timeout 180
export INTEGRATION_BASE_URL="http://localhost:$APP_PORT"
export INTEGRATION_SOCKET_A="http://localhost:${INTEGRATION_SOCKET_A_PORT:-13001}"
export INTEGRATION_SOCKET_B="http://localhost:${INTEGRATION_SOCKET_B_PORT:-13002}"
export INTEGRATION_DATABASE_URL="postgres://razzia:razzia@localhost:$PG_PORT/razzia"
export INTEGRATION_KAFKA_BROKERS="localhost:${INTEGRATION_KAFKA_PORT:-29092}"
export INTEGRATION_MANAGER_PASSWORD=${MANAGER_PASSWORD:-admin}
pnpm --filter @razzia/streaming test:integration
