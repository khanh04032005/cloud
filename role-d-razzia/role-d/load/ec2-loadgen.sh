#!/bin/bash
# Máy phát tải, tách khỏi node EKS. Amazon Linux 2023, kiến trúc x86_64.
# CPU của chính máy này phải được theo dõi riêng để không lẫn với giới hạn của quiz.
set -euo pipefail

if ! command -v k6 >/dev/null 2>&1; then
  sudo dnf install -y "https://dl.k6.io/rpm/repo.rpm" || true
  sudo dnf install -y k6
fi

TOKEN="$(curl -sS -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60" || true)"
INSTANCE_ID="$(curl -sS -H "X-aws-ec2-metadata-token: ${TOKEN}" http://169.254.169.254/latest/meta-data/instance-id || hostname)"

echo "Load generator instance: ${INSTANCE_ID}"
echo "Trong CloudWatch, xem CPUUtilization của instance này, không xem CPU của node EKS."
echo "Bật detailed monitoring (chu kỳ 1 phút) trước buổi đo 1000 người."
echo "k6 version: $(k6 version)"
