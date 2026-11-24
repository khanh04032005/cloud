cd ~/Codes/cloud/role-d
N=50; CODE=XXXX          # mã vừa in ra
BASE_URL=http://localhost:3000 INVITE_CODES=$CODE \
ANSWER_MODE=random SOCKET_MS=300000 \
taskset -c 1-5 k6 run --vus $N --iterations $N \
  --summary-export ~/e01/k6-$N-random.json \
  load/k6/player.js 2>&1 | tee ~/e01/k6-$N-random.log

BASE_URL=http://localhost:3000 INVITE_CODES=$CODE \
ANSWER_MODE=random SOCKET_MS=300000 BCAST_LOG=1 \
taskset -c 1-5 k6 run --vus $N --iterations $N \
  --console-output=$HOME/e01/bcast-$N.log \
  --summary-export ~/e01/k6-$N-random.json \
  load/k6/player.js 2>&1 | tee ~/e01/k6-$N-random.log

node load/bcast-spread.mjs ~/e01/bcast-$N.log
jq '.metrics.cooldown_jitter_ms' ~/e01/k6-$N-random.json