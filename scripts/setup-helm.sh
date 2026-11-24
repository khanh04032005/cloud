#!/usr/bin/env bash
# Install the chart's pinned Helm locally; no sudo and no persistent /tmp paths.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION=3.19.0
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) platform=linux-amd64 ;;
  Linux/aarch64|Linux/arm64) platform=linux-arm64 ;;
  *) echo 'This installer supports Linux amd64/arm64. Install Helm from https://helm.sh/docs/intro/install/.' >&2; exit 1 ;;
esac

for tool in curl tar sha256sum install; do
  command -v "$tool" >/dev/null || { echo "Missing tool: $tool" >&2; exit 127; }
done

destination="$ROOT/.tools/helm"
if [[ -x "$destination/helm" ]] && [[ "$("$destination/helm" version --template '{{.Version}}')" == "v$VERSION" ]]; then
  "$destination/helm" version --short
  exit 0
fi

download_dir="$(mktemp -d)"
trap 'rm -rf "$download_dir"' EXIT
archive="helm-v$VERSION-$platform.tar.gz"
curl -L --fail --silent --show-error --retry 2 \
  "https://get.helm.sh/$archive" -o "$download_dir/$archive"
curl -L --fail --silent --show-error --retry 2 \
  "https://get.helm.sh/$archive.sha256sum" -o "$download_dir/$archive.sha256sum"
(
  cd "$download_dir"
  sha256sum --check "$archive.sha256sum"
)
tar -xzf "$download_dir/$archive" -C "$download_dir"
install -D -m 0755 "$download_dir/$platform/helm" "$destination/helm"
"$destination/helm" version --short
echo "Installed Helm at $destination/helm"
