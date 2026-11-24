# Dùng chung cho up.sh / down.sh / leftovers.sh. Không chạy trực tiếp.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TF_DIR="$ROOT/infra/envs/dev"
RUN_FILE="$ROOT/infra/.current-run"
RUNS_CSV="$ROOT/infra/runs.csv"

export AWS_REGION="${AWS_REGION:-ap-southeast-1}"
CLUSTER="${CLUSTER:-razzia}"
APP_RELEASE="${APP_RELEASE:-razzia}"
APP_NS="${APP_NS:-default}"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }

need() {
  local missing=()
  for bin in "$@"; do command -v "$bin" >/dev/null || missing+=("$bin"); done
  if ((${#missing[@]})); then
    warn "Thiếu công cụ: ${missing[*]}"
    exit 1
  fi
}

tf() { terraform -chdir="$TF_DIR" "$@"; }

tf_init() {
  if [[ ! -f "$TF_DIR/backend.hcl" ]]; then
    warn "Chưa có $TF_DIR/backend.hcl. Chạy infra/bootstrap trước rồi: cp backend.hcl.example backend.hcl"
    exit 1
  fi
  tf init -input=false -backend-config=backend.hcl >/dev/null
}

tf_out() { tf output -raw "$1"; }

cluster_reachable() {
  aws eks describe-cluster --name "$CLUSTER" >/dev/null 2>&1 &&
    aws eks update-kubeconfig --name "$CLUSTER" >/dev/null 2>&1 &&
    kubectl get ns >/dev/null 2>&1
}
