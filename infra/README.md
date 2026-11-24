# Hạ tầng AWS (vai C)

```
infra/
  bootstrap/   # chạy 1 lần, luôn giữ: bucket state, ECR (web/socket/worker/migrate), Budget + cảnh báo bất thường
  envs/dev/    # dựng/hủy mỗi buổi: VPC, NAT instance, EKS (Spot), RDS, Redis, Kafka EC2, IRSA
scripts/aws/
  up.sh        # terraform apply + addon (ALB controller, metrics-server, CA) + secret + deploy app
  down.sh      # xóa Ingress → chờ ALB biến mất → terraform destroy → kiểm tra đồ sót
  leftovers.sh # chỉ đọc: liệt kê thứ còn tính tiền
```

Cần: `aws` (đã `aws configure`), `terraform >= 1.10`, `kubectl`, `helm`, `jq`, `openssl`.

## Lần đầu

```bash
terraform -chdir=infra/bootstrap init
terraform -chdir=infra/bootstrap apply \
  -var bucket_name=razzia-tfstate-<ten-nhom> \
  -var budget_email=<email-nhom> -var budget_limit_usd=20
cp infra/envs/dev/backend.hcl.example infra/envs/dev/backend.hcl   # sửa tên bucket
```

Sau đó vào Billing → Cost allocation tags, bật hai tag `RunId` và `Project`. Việc này chỉ làm một lần. Từ đó D có thể lọc chi phí theo từng lần chạy.

## Mỗi buổi test

```bash
scripts/aws/up.sh                    # ~15-20 phút
TAG=<git-sha> scripts/aws/up.sh      # deploy 4 image cùng tag từ ECR qua Helm
TAG=<git-sha> AUTOSCALING=true scripts/aws/up.sh  # bật HPA socket
MONITORING=1 scripts/aws/up.sh       # thêm Prometheus/Grafana
scripts/aws/down.sh                  # LUÔN chạy khi xong
```

Mỗi lần `down` sẽ ghi một dòng vào `infra/runs.csv` (RunId, giờ bật, giờ tắt, số giờ).

Helm chart và chiến lược test: [deploy/helm/razzia](../deploy/helm/razzia/README.md).
`up.sh` lấy registry từ bootstrap state (hoặc `ECR_PREFIX`), tạo namespace trước
Secret và giữ JWT/password qua các lần deploy. Bootstrap cần apply lại để tạo
repository `migrate` nếu trước đó chỉ có ba repository; cần push đủ bốn image
`web`, `socket`, `worker`, `migrate` trước khi deploy app.

## Chi phí (ap-southeast-1, ước tính, kiểm lại bằng Pricing Calculator)

| Thành phần           | Mặc định ở đây                        | USD/giờ   | Nếu không tối ưu                  |
| -------------------- | ------------------------------------- | --------- | --------------------------------- |
| EKS control plane    | standard support                      | 0,10      | 0,60 nếu rơi vào extended support |
| NAT                  | fck-nat t4g.nano                      | ~0,005    | NAT Gateway 0,059 + 0,059/GB      |
| 2 node               | Spot t3a/t3.medium                    | ~0,03     | on-demand 0,106                   |
| Kafka                | t4g.small                             | ~0,021    | t3.small 0,026                    |
| RDS                  | db.t4g.micro, single-AZ, không backup | ~0,03     |                                   |
| Redis                | cache.t4g.micro                       | ~0,025    |                                   |
| ALB + IPv4 công khai |                                       | ~0,045    |                                   |
| **Tổng**             |                                       | **~0,25** | ~0,40                             |

Phần luôn bật (state, ECR khoảng 5 image mỗi repo, budget) tốn gần 0 USD/tháng.

## Công tắc

| Biến                                  | Khi nào đổi                                                |
| ------------------------------------- | ---------------------------------------------------------- |
| `TF_VAR_node_capacity_type=ON_DEMAND` | Lần đo chính thức, tránh bị thu hồi Spot giữa bài đo       |
| `TF_VAR_node_arch=arm64`              | Khi CI đã build image multi-arch, rẻ hơn thêm khoảng 20%   |
| `TF_VAR_nat_mode=gateway`             | Khi NAT instance gặp vấn đề, hoặc để so sánh trong báo cáo |
| `TF_VAR_node_max=6`                   | Thí nghiệm elasticity lớn                                  |

## Chưa làm (bước tiếp theo)

- Nghiệm thu Helm trên EKS (đã chạy trên kind local; người dùng xác nhận test tốt ngày 20/11, chưa có số đo tải)
- GitHub Actions OIDC role + workflow push ECR (§7)
- Module Lambda của D (đổi `nodejs20.x` sang `nodejs22.x`, gắn vào `private_subnets`, mở 5432 từ SG của Lambda)
