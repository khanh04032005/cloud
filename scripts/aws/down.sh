#!/usr/bin/env bash
# Hủy toàn bộ môi trường dev. Giữ lại: bucket state, ECR, budget (infra/bootstrap).
#
# THỨ TỰ QUAN TRỌNG: xóa Ingress trước, để AWS Load Balancer Controller (còn sống) xóa ALB.
# Nếu terraform destroy trước, ALB do controller tạo sẽ bị bỏ lại: vẫn tính tiền và giữ ENI
# trong subnet khiến VPC không xóa được.
source "$(dirname "$0")/common.sh"
need aws terraform kubectl helm jq

alb_count() {
  aws resourcegroupstaggingapi get-resources \
    --resource-type-filters elasticloadbalancing:loadbalancer \
    --tag-filters "Key=elbv2.k8s.aws/cluster,Values=$CLUSTER" \
    --query 'length(ResourceTagMappingList)' --output text
}

if cluster_reachable; then
  log "Gỡ app và mọi Ingress / Service LoadBalancer"
  helm uninstall "$APP_RELEASE" -n "$APP_NS" --wait 2>/dev/null || true
  helm uninstall kps -n monitoring --wait 2>/dev/null || true
  kubectl delete ingress --all -A --wait=true --timeout=5m || true
  kubectl get svc -A -o json |
    jq -r '.items[] | select(.spec.type=="LoadBalancer") | "\(.metadata.namespace) \(.metadata.name)"' |
    while read -r ns name; do kubectl -n "$ns" delete svc "$name" --wait=true; done || true
  kubectl delete pvc --all -A --wait=true --timeout=5m || true

  log "Chờ controller xóa hết ALB"
  for _ in $(seq 1 30); do
    n="$(alb_count)"
    [[ "$n" == "0" ]] && break
    echo "   còn $n load balancer..."
    sleep 10
  done
else
  warn "Không vào được cụm (có thể đã bị xóa một phần), bỏ qua bước Kubernetes"
fi

n="$(alb_count)"
if [[ "$n" != "0" ]]; then
  warn "Vẫn còn $n ALB của cụm. Xóa tay rồi chạy lại:"
  aws resourcegroupstaggingapi get-resources \
    --resource-type-filters elasticloadbalancing:loadbalancer \
    --tag-filters "Key=elbv2.k8s.aws/cluster,Values=$CLUSTER" \
    --query 'ResourceTagMappingList[].ResourceARN' --output text
  echo "   aws elbv2 delete-load-balancer --load-balancer-arn <arn>"
  exit 1
fi

log "Terraform destroy (~10-15 phút)"
tf_init
TF_VAR_run_id="$(cut -d, -f1 "$RUN_FILE" 2>/dev/null || echo manual)" \
  tf destroy -input=false -auto-approve

# Ghi lại thời gian chạy để đối chiếu với Cost Explorer.
if [[ -f "$RUN_FILE" ]]; then
  IFS=, read -r run_id started <"$RUN_FILE"
  ended="$(date -u +%FT%TZ)"
  hours="$(awk -v s="$(date -d "$started" +%s)" -v e="$(date -d "$ended" +%s)" 'BEGIN{printf "%.2f",(e-s)/3600}')"
  [[ -f "$RUNS_CSV" ]] || echo "run_id,started_utc,ended_utc,hours" >"$RUNS_CSV"
  echo "$run_id,$started,$ended,$hours" >>"$RUNS_CSV"
  rm -f "$RUN_FILE"
  log "Lần chạy $run_id: $hours giờ (đã ghi vào infra/runs.csv)"
fi

"$(dirname "$0")/leftovers.sh"
