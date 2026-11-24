#!/usr/bin/env bash
# Tìm tài nguyên còn tính tiền sau khi down. Chạy bất cứ lúc nào, chỉ đọc, không xóa gì.
# Trả về mã lỗi 1 nếu còn thứ gì đó.
source "$(dirname "$0")/common.sh"
need aws

found=0
check() {
  local label="$1"; shift
  local out
  out="$("$@" 2>/dev/null || true)"
  if [[ -n "$out" && "$out" != "None" ]]; then
    warn "$label:"
    echo "$out" | sed 's/^/     /'
    found=1
  fi
}

log "Kiểm tra tài nguyên còn sót ở $AWS_REGION"
check "EKS cluster" aws eks list-clusters --query 'clusters[]' --output text
check "EC2 đang chạy" aws ec2 describe-instances \
  --filters Name=instance-state-name,Values=pending,running,stopping,stopped \
  --query 'Reservations[].Instances[].[InstanceId,InstanceType,Tags[?Key==`Name`]|[0].Value]' --output text
check "Load balancer" aws elbv2 describe-load-balancers --query 'LoadBalancers[].[LoadBalancerName,Type]' --output text
check "NAT Gateway" aws ec2 describe-nat-gateways --filter Name=state,Values=available,pending \
  --query 'NatGateways[].NatGatewayId' --output text
check "EBS chưa gắn" aws ec2 describe-volumes --filters Name=status,Values=available \
  --query 'Volumes[].[VolumeId,Size]' --output text
check "Elastic IP chưa gắn (0,005 USD/giờ)" aws ec2 describe-addresses \
  --query 'Addresses[?AssociationId==null].PublicIp' --output text
check "RDS" aws rds describe-db-instances --query 'DBInstances[].[DBInstanceIdentifier,DBInstanceStatus]' --output text
check "RDS snapshot thủ công" aws rds describe-db-snapshots --snapshot-type manual \
  --query 'DBSnapshots[].DBSnapshotIdentifier' --output text
check "ElastiCache" aws elasticache describe-cache-clusters --query 'CacheClusters[].CacheClusterId' --output text

if ((found)); then
  warn "Còn tài nguyên ở trên. Nếu không phải của nhóm mình dùng thì xóa đi."
  exit 1
fi
log "Sạch. Chỉ còn bucket state, ECR và budget (gần như 0 USD)."
