#!/usr/bin/env bash
# E01 follow-up: find the original Razzia limit without the 1024 nginx worker_connections cap.
#   way 1 (nginx8k): image nginx with worker_connections 8192, through the proxy
#   way 2 (direct):  k6 and host talk to node on port 3001, no nginx
set -uo pipefail
cd "$(dirname "$0")/../.."
LEVELS=${LEVELS:-"200 300 400 500 1000"}
for mode in random end; do
  for n in $LEVELS; do
    docker stop razzia-direct >/dev/null 2>&1
    CONTAINER=razzia-nginx8k NGINX_CONF=scripts/bench/nginx-8k.conf PORT=3000 OUT=$HOME/e01-nginx8k \
      scripts/bench/e01.sh "$n" "$mode"
    docker stop razzia-nginx8k >/dev/null 2>&1
    CONTAINER=razzia-direct DIRECT=1 PORT=3002 OUT=$HOME/e01-direct \
      scripts/bench/e01.sh "$n" "$mode"
  done
done
docker stop razzia-direct razzia-nginx8k >/dev/null 2>&1
echo ALL DONE
