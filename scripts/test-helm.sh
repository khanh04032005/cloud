#!/usr/bin/env bash
# Static chart + deploy-script contracts. No AWS credentials or cluster needed.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${HELM:-}" ]]; then
  if command -v helm >/dev/null 2>&1; then
    HELM=helm
  else
    HELM="$ROOT/.tools/helm/helm"
  fi
fi
PYTHON="${PYTHON:-python3}"
export HELM
export PYTHONDONTWRITEBYTECODE=1

if ! command -v "$HELM" >/dev/null 2>&1; then
  printf 'Helm executable not found: %s\n' "$HELM" >&2
  printf 'Run: bash scripts/setup-helm.sh\nThen rerun tests without the old HELM=/tmp/... override.\n' >&2
  exit 127
fi

"$HELM" lint "$ROOT/deploy/helm/razzia" --strict \
  --set-string image.registry=example.invalid/razzia --set-string image.tag=test
bash -n "$ROOT/scripts/aws/up.sh" "$ROOT/scripts/setup-helm.sh"
"$PYTHON" -m unittest discover -s "$ROOT/deploy/helm/tests" -v

# Optional full Kubernetes/ServiceMonitor schema validation; needs network on the
# first run to retrieve schemas (or use a previously populated cache directory).
if [[ -n "${KUBECONFORM:-}" ]]; then
  rendered="$(mktemp -d)"
  trap 'rm -rf "$rendered"' EXIT
  "$HELM" template razzia "$ROOT/deploy/helm/razzia" \
    --set-string image.registry=example.invalid/razzia --set-string image.tag=test \
    --set apps.socket.hpa.enabled=true --set monitoring.enabled=true >"$rendered/all.yaml"
  "$KUBECONFORM" -strict -summary -kubernetes-version 1.35.0 \
    -schema-location default \
    -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
    "$rendered/all.yaml"
fi
