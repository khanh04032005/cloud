#!/usr/bin/env bash
# Install pinned Terraform + AWS CLI v2 locally into .tools/; no sudo and no system-wide changes.
# Usage: scripts/setup-tools.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TERRAFORM_VERSION=1.17.2

case "$(uname -s)/$(uname -m)" in
  Linux/x86_64)                     tf_arch=amd64; aws_arch=x86_64 ;;
  Linux/aarch64|Linux/arm64)        tf_arch=arm64; aws_arch=aarch64 ;;
  *) echo 'This installer supports Linux amd64/arm64. Install manually from https://developer.hashicorp.com/terraform/install and https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html' >&2; exit 1 ;;
esac

for tool in curl unzip sha256sum install; do
  command -v "$tool" >/dev/null || { echo "Missing tool: $tool" >&2; exit 127; }
done

bin_dir="$ROOT/.tools/bin"
mkdir -p "$bin_dir"

download_dir="$(mktemp -d)"
trap 'rm -rf "$download_dir"' EXIT

# ---------- Terraform ----------
current_tf=""
if [[ -x "$bin_dir/terraform" ]]; then
  current_tf="$("$bin_dir/terraform" version | sed -n 's/^Terraform v//p' | head -1)"
fi
if [[ "$current_tf" == "$TERRAFORM_VERSION" ]]; then
  echo "Terraform v$TERRAFORM_VERSION already present"
else
  tf_base="https://releases.hashicorp.com/terraform/$TERRAFORM_VERSION"
  tf_zip="terraform_${TERRAFORM_VERSION}_linux_${tf_arch}.zip"
  curl -L --fail --silent --show-error --retry 2 "$tf_base/$tf_zip" -o "$download_dir/$tf_zip"
  curl -L --fail --silent --show-error --retry 2 \
    "$tf_base/terraform_${TERRAFORM_VERSION}_SHA256SUMS" -o "$download_dir/terraform_SHA256SUMS"
  (
    cd "$download_dir"
    grep " $tf_zip\$" terraform_SHA256SUMS | sha256sum --check --status -
  )
  unzip -q -o "$download_dir/$tf_zip" -d "$download_dir/tf"
  install -D -m 0755 "$download_dir/tf/terraform" "$bin_dir/terraform"
  echo "Installed Terraform v$TERRAFORM_VERSION at $bin_dir/terraform"
fi

# ---------- AWS CLI v2 ----------
# AWS only publishes an unversioned "latest" URL; the sha256 published next to it is verified.
if [[ -x "$bin_dir/aws" ]] && "$bin_dir/aws" --version 2>/dev/null | grep -q '^aws-cli/2\.'; then
  echo "AWS CLI $("$bin_dir/aws" --version | awk '{print $1}' | cut -d/ -f2) already present"
else
  aws_zip="awscli-exe-linux-${aws_arch}.zip"
  curl -L --fail --silent --show-error --retry 2 \
    "https://awscli.amazonaws.com/$aws_zip" -o "$download_dir/$aws_zip"
  # AWS publishes a PGP signature (.sig) but no .sha256 for the bundled installer.
  if expected="$(curl -L --fail --silent --show-error --retry 2 "https://awscli.amazonaws.com/$aws_zip.sha256" 2>/dev/null)"; then
    actual="$(sha256sum "$download_dir/$aws_zip" | awk '{print $1}')"
    [[ "$expected" == "$actual" ]] || { echo "Checksum mismatch for $aws_zip" >&2; exit 1; }
  else
    echo "No .sha256 published for $aws_zip; relying on HTTPS from awscli.amazonaws.com" >&2
  fi
  unzip -q -o "$download_dir/$aws_zip" -d "$download_dir/aws"
  rm -rf "$ROOT/.tools/aws-cli"
  "$download_dir/aws/aws/install" --install-dir "$ROOT/.tools/aws-cli" --bin-dir "$bin_dir" >/dev/null
  echo "Installed AWS CLI at $bin_dir/aws"
fi

# Helm lives in .tools/helm (installed by scripts/setup-helm.sh); expose it on the same PATH.
[[ -x "$ROOT/.tools/helm/helm" ]] && ln -sfn ../helm/helm "$bin_dir/helm"

echo
echo "Add this to ~/.zshrc (once):"
echo "  export PATH=\"$bin_dir:\$PATH\""
echo
"$bin_dir/terraform" version | head -1
"$bin_dir/aws" --version
