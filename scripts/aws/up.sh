#!/usr/bin/env bash
# Dựng toàn bộ môi trường dev trên AWS. Chạy lại nhiều lần vẫn an toàn (idempotent).
#
#   scripts/aws/up.sh                     # chỉ hạ tầng + addon
#   TAG=<git-sha> scripts/aws/up.sh       # thêm deploy app nếu đã có deploy/helm/razzia
#   MONITORING=1 scripts/aws/up.sh        # thêm kube-prometheus-stack (tốn thêm ~1 GiB RAM trên node)
#
# Biến Terraform truyền qua TF_VAR_*, ví dụ:
#   TF_VAR_node_capacity_type=ON_DEMAND   # lần đo chính thức
#   TF_VAR_nat_mode=gateway               # nếu NAT instance có vấn đề
#
# Chi phí khi đang bật: ~0,25 USD/giờ. NHỚ chạy scripts/aws/down.sh khi xong.
source "$(dirname "$0")/common.sh"
need aws terraform kubectl helm jq openssl

# Resolve image configuration before starting infrastructure work.
if [[ -n "${TAG:-}" ]]; then
  ecr_prefix="${ECR_PREFIX:-}"
  if [[ -z "$ecr_prefix" ]]; then
    ecr_prefix="$(terraform -chdir="$ROOT/infra/bootstrap" output -raw ecr_registry)/razzia"
  fi
  helm lint "$ROOT/deploy/helm/razzia" --strict \
    --set-string image.registry="$ecr_prefix" --set-string image.tag="$TAG"
fi

# ---------- RunId: mỗi lần bật là một lần chạy, để tách chi phí trong Cost Explorer ----------
if [[ -f "$RUN_FILE" ]]; then
  RUN_ID="$(cut -d, -f1 "$RUN_FILE")"
  log "Đang có lần chạy $RUN_ID chưa down, dùng lại RunId này"
else
  RUN_ID="run-$(date -u +%Y%m%d-%H%M)"
  echo "$RUN_ID,$(date -u +%FT%TZ)" >"$RUN_FILE"
fi
export TF_VAR_run_id="$RUN_ID"

# ---------- 1. Hạ tầng ----------
log "Terraform apply (lần đầu mất ~15-20 phút, phần lâu nhất là EKS và RDS)"
tf_init
tf apply -input=false -auto-approve

aws eks update-kubeconfig --name "$CLUSTER" >/dev/null
kubectl get nodes -o wide

# ---------- 2. Addon nền ----------
log "Cài AWS Load Balancer Controller, metrics-server, Cluster Autoscaler"
helm repo add eks https://aws.github.io/eks-charts >/dev/null 2>&1 || true
helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/ >/dev/null 2>&1 || true
helm repo add autoscaler https://kubernetes.github.io/autoscaler >/dev/null 2>&1 || true
helm repo update >/dev/null

helm upgrade --install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system --wait \
  --set clusterName="$CLUSTER" \
  --set region="$AWS_REGION" \
  --set vpcId="$(tf_out vpc_id)" \
  --set replicaCount=1 \
  --set serviceAccount.create=true \
  --set serviceAccount.name=aws-load-balancer-controller \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"="$(tf_out alb_controller_role_arn)"

helm upgrade --install metrics-server metrics-server/metrics-server -n kube-system --wait

# scale-down-unneeded-time ngắn: node thừa bị trả lại sau 2 phút thay vì 10 phút (rẻ hơn, đo nhanh hơn).
helm upgrade --install cluster-autoscaler autoscaler/cluster-autoscaler \
  -n kube-system --wait \
  --set autoDiscovery.clusterName="$CLUSTER" \
  --set awsRegion="$AWS_REGION" \
  --set rbac.serviceAccount.create=true \
  --set rbac.serviceAccount.name=cluster-autoscaler \
  --set rbac.serviceAccount.annotations."eks\.amazonaws\.com/role-arn"="$(tf_out cluster_autoscaler_role_arn)" \
  --set extraArgs.balance-similar-node-groups=true \
  --set extraArgs.scale-down-unneeded-time=2m \
  --set extraArgs.scale-down-delay-after-add=2m

if [[ "${MONITORING:-0}" == "1" ]]; then
  log "Cài kube-prometheus-stack (Prometheus + Grafana trong cụm, thay cho Container Insights tính tiền theo GB)"
  helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
  helm repo update >/dev/null
  helm upgrade --install kps prometheus-community/kube-prometheus-stack \
    -n monitoring --create-namespace --wait \
    --set grafana.adminPassword="${GRAFANA_PASSWORD:-admin}" \
    --set alertmanager.enabled=false \
    --set prometheus.prometheusSpec.retention=2d
fi

# ---------- 3. Secret cấu hình app ----------
log "Tạo secret razzia-env từ output Terraform và Secrets Manager"
kubectl create namespace "$APP_NS" --dry-run=client -o yaml | kubectl apply -f -
# Preserve credentials across deployments; env is read only at pod startup.
existing_env="$(kubectl -n "$APP_NS" get secret razzia-env -o json --ignore-not-found)"
[[ -n "$existing_env" ]] || existing_env='{}'
jwt_secret="$(jq -r '.data.JWT_SECRET // "" | @base64d' <<<"$existing_env")"
manager_password="${MANAGER_PASSWORD:-$(jq -r '.data.MANAGER_PASSWORD // "" | @base64d' <<<"$existing_env")}"
[[ -n "$jwt_secret" ]] || jwt_secret="$(openssl rand -hex 32)"
[[ -n "$manager_password" ]] || manager_password="$(openssl rand -hex 8)"
pg_pass="$(aws secretsmanager get-secret-value --secret-id "$(tf_out rds_secret_arn)" \
  --query SecretString --output text | jq -r '.password | @uri')"
# RDS Postgres 16 bắt buộc TLS. no-verify: có mã hóa, bỏ kiểm tra CA (chấp nhận được trong VPC riêng).
database_url="postgres://razzia:${pg_pass}@$(tf_out rds_address):5432/razzia?sslmode=no-verify"

kubectl -n "$APP_NS" create secret generic razzia-env \
  --from-literal=DATABASE_URL="$database_url" \
  --from-literal=REDIS_URL="$(tf_out redis_url)" \
  --from-literal=KAFKA_BROKERS="$(tf_out kafka_brokers)" \
  --from-literal=JWT_SECRET="$jwt_secret" \
  --from-literal=MANAGER_PASSWORD="$manager_password" \
  --dry-run=client -o yaml | kubectl apply -f -

# ---------- 4. App ----------
CHART="$ROOT/deploy/helm/razzia"
if [[ -d "$CHART" && -n "${TAG:-}" ]]; then
  # Opaque resourceVersion changes when the external Secret changes; no secret
  # content or digest is stored in Helm release values.
  config_revision="$(kubectl -n "$APP_NS" get secret razzia-env -o jsonpath='{.metadata.resourceVersion}')"
  monitoring_enabled=false
  [[ "${MONITORING:-0}" != "1" ]] || monitoring_enabled=true
  log "Deploy app tag $TAG"
  helm upgrade --install "$APP_RELEASE" "$CHART" -n "$APP_NS" --wait --timeout 10m \
    --set-string image.registry="$ecr_prefix" \
    --set-string image.tag="$TAG" \
    --set-string configRevision="$config_revision" \
    --set monitoring.enabled="$monitoring_enabled" \
    --set apps.socket.hpa.enabled="${AUTOSCALING:-false}"
  kubectl -n "$APP_NS" get ingress
else
  warn "Bỏ qua deploy app (cần deploy/helm/razzia và biến TAG=<git-sha>)"
fi

cat <<EOF

RunId:            $RUN_ID
MANAGER_PASSWORD: $manager_password
Kafka (SSM):      aws ssm start-session --target $(tf_out kafka_instance_id)

Đang tính tiền ~0,25 USD/giờ. Xong việc: scripts/aws/down.sh
EOF
